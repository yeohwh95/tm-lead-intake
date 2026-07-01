// Lead SLA engine — nudge (T+60) → reassign (T+75) → escalate, working-hours gated, persistent.
// Decoupled from index.js via injected deps (so it's unit-testable with simulated time).
// Spec: SLA-SPEC.md
const fs = require('fs');
const path = require('path');
const STORE = process.env.SLA_STORE || path.join(__dirname, 'sla_store.json');

const NUDGE_MS = 60 * 60 * 1000;       // T+60min summary nudge
const REASSIGN_MS = 75 * 60 * 1000;    // T+75min reassign
const HOURS = { startH: 9, endH: 18, days: [1, 2, 3, 4, 5] }; // Mon–Fri 9am–6pm MYT
const MYT = 8 * 3600 * 1000;

let now = () => Date.now();            // overridable in tests
let deps = {};                          // { waSend, waDelete, larkUpdateSalesman, groupNotify, pickNextRep }
let state = { reps: {} };               // reps[repKey] = { phone, leads: { recordId: lead } , summaryMsgId, remindedAt }

function load() { try { state = JSON.parse(fs.readFileSync(STORE, 'utf8')); } catch { state = { reps: {} }; } }
function persist() { try { fs.writeFileSync(STORE, JSON.stringify(state)); } catch {} }

// working-hours gate: is this timestamp inside Mon–Fri 9–6 MYT?
function inHours(ms) { const d = new Date(ms + MYT); return HOURS.days.includes(d.getUTCDay()) && d.getUTCHours() >= HOURS.startH && d.getUTCHours() < HOURS.endH; }

function init(injected, opts = {}) {
  deps = injected;
  if (opts.now) now = opts.now;
  if (opts.store) { /* STORE is env/const; tests set SLA_STORE */ }
  load();
}

// Called at T+0 when a rep is DM'd their lead(s). `leads` = [{recordId, summary, brand, custName, custPhone}].
// dmMsgId = the WaSender msgId of that consolidated DM (for later deletion). Skips if assigned outside hours.
function register(repKey, repPhone, leads, dmMsgId) {
  if (!repKey || !leads || !leads.length) return;
  if (!inHours(now())) return;   // outside hours → no SLA (per spec: skip)
  const r = state.reps[repKey] || (state.reps[repKey] = { phone: repPhone, leads: {}, summaryMsgId: null, remindedAt: 0 });
  r.phone = repPhone; r.lids = r.lids || [];
  for (const l of leads) {
    if (r.leads[l.recordId]) continue;
    r.leads[l.recordId] = { recordId: l.recordId, summary: l.summary, brand: l.brand || '', custName: l.custName || '', custPhone: l.custPhone || '', assignedAt: now(), firstAssignedAt: now(), dmMsgId, status: 'pending', reassignCount: 0, contactedAt: 0 };
  }
  persist();
  (deps.log || console.log)('SLA register:', repKey, '←', leads.length, 'lead(s)');
}

// Rep sent a message to the TM number.
//   ANY message → acknowledged → confirm ALL their pending leads (no reassign).
//   contains "pass" → reassign each pending lead NOW.
// Match by PHONE (real-phone JID) OR by NAME (replies come from a @lid privacy JID, so repHint =
// their WhatsApp name matched to the roster). Returns null, or { repKey, action:'ack'|'pass' }.
async function onReply(fromPhone, text, repHint, fromJid) {
  const digits = String(fromPhone).replace(/\D/g, '');
  for (const [repKey, r] of Object.entries(state.reps)) {
    const lidMatch = fromJid && (r.lids || []).includes(fromJid);          // exact — learned from a past reply
    const phoneMatch = digits.length >= 6 && String(r.phone).replace(/\D/g, '').slice(-9) === digits.slice(-9);
    const nameMatch = repHint && String(repHint).toLowerCase() === repKey.toLowerCase();
    if (!lidMatch && !phoneMatch && !nameMatch) continue;
    if (fromJid) { r.lids = r.lids || []; if (!r.lids.includes(fromJid)) r.lids.push(fromJid); }   // LEARN this rep's JID → instant match next time
    const pending = Object.values(r.leads).filter(l => l.status === 'pending');
    if (!pending.length) return { repKey, action: 'noop' };   // matched a rep, but nothing waiting (already acked)
    if (/\bpass\b/i.test(text || '')) {
      for (const l of pending) {
        await slaWrite(l.recordId, { 'SLA First Response At': now(), 'SLA Response Action': 'Pass', 'SLA Response Time (min)': mins(now() - l.assignedAt) });
        await reassignLead(repKey, r, l, 'passed');
      }
      persist(); return { repKey, action: 'pass', count: pending.length };
    }
    for (const l of pending) {   // any other message = acknowledged ("Keep")
      l.status = 'contacted'; l.contactedAt = now();
      const rt = mins(now() - l.assignedAt), cw = mins(now() - (l.firstAssignedAt || l.assignedAt));
      await slaWrite(l.recordId, { 'SLA First Response At': now(), 'SLA Response Action': 'Keep', 'SLA Status': 'Acknowledged', 'SLA Response Time (min)': rt, 'SLA Customer Wait (min)': cw, 'SLA Within SLA?': rt <= 60 });
    }
    persist(); return { repKey, action: 'ack', count: pending.length };
  }
  return null;   // no tracked rep matched this reply
}

// Move a lead to the next rep (used by T+75 timeout AND by an explicit "pass").
async function reassignLead(repKey, r, l, reason) {
  l.heldBy = l.heldBy || [];
  if (!l.heldBy.includes(repKey)) l.heldBy.push(repKey);
  // SAFETY: auto-reassign on no-response is PAUSED unless SLA_REASSIGN=1. (Explicit "pass" always works.)
  if (reason === 'no_response' && process.env.SLA_REASSIGN !== '1') {
    l.status = 'flagged_noreassign';
    await slaWrite(l.recordId, { 'SLA Status': 'No-Response' });
    await safe(deps.groupNotify(`⏰ ${l.custName || l.custPhone} (${l.brand || 'TM'}) — no reply in 75 min. Auto-reassign is PAUSED; ${repKey}, please follow up.`));
    (deps.log || console.log)('SLA no-response (reassign paused):', l.recordId, repKey);
    return;
  }
  // no-response: escalate after the first reassign (never bounce a customer endlessly)
  if (reason === 'no_response' && l.reassignCount >= 1) {
    l.status = 'escalated';
    await slaWrite(l.recordId, { 'SLA Status': 'Escalated', 'SLA Escalated At': now() });
    await safe(deps.groupNotify(`🚨 *Lead not picked up* — ${l.custName || l.custPhone} (${l.brand || 'TM'}) — no response after reassign. Needs a manager.`));
    return;
  }
  await safe(deps.waDelete(l.dmMsgId));
  if (r.summaryMsgId) { await safe(deps.waDelete(r.summaryMsgId)); r.summaryMsgId = null; }
  const exclude = reason === 'passed' ? l.heldBy : [repKey];   // a passed lead skips everyone who already had it
  const next = await deps.pickNextRep(l.brand, repKey, exclude);
  if (!next) { l.status = 'escalated'; await slaWrite(l.recordId, { 'SLA Status': 'Escalated', 'SLA Escalated At': now() }); await safe(deps.groupNotify(`🚨 No available rep for ${l.custName || l.custPhone} (${l.brand || 'TM'})${reason === 'passed' ? ' (everyone passed)' : ''}. Needs a manager.`)); return; }
  const verb = reason === 'passed' ? 'Passed' : 'Reassigned';
  const newMsgId = await safe(deps.waSend(next.phone, `🔔 *${verb} Lead — ${l.brand || 'TM Motoworld'}*\n👤 ${l.custName || '—'}\n🎯 ${l.summary}\n${l.custPhone ? '👉 https://wa.me/' + l.custPhone.replace(/\D/g, '') : ''}\n\n✅ Reply anything once you've contacted them (or *PASS* to hand it over).`));
  await safe(deps.larkUpdateSalesman(l.recordId, next.openId));
  await slaWrite(l.recordId, { 'SLA Status': 'Reassigned', 'SLA Reassigned At': now(), 'SLA Reassigned From': repKey, 'SLA Reassign Count': l.reassignCount + 1 });
  await safe(deps.groupNotify(`🔄 *${verb}* — ${l.custName || l.custPhone}: ${repKey} → ${next.name}${reason === 'passed' ? ' (rep passed)' : ' (no response 75 min)'}`));
  delete r.leads[l.recordId];
  const nr = state.reps[next.key] || (state.reps[next.key] = { phone: next.phone, leads: {}, summaryMsgId: null, remindedAt: 0 });
  nr.phone = next.phone;
  nr.leads[l.recordId] = { ...l, assignedAt: now(), firstAssignedAt: l.firstAssignedAt || l.assignedAt, dmMsgId: newMsgId, reassignCount: l.reassignCount + 1, status: 'pending', heldBy: l.heldBy };
}

// The 1-minute checker. Pure of side effects except via deps (all async).
async function tick() {
  const t = now();
  if (!inHours(t)) return;   // only act during working hours
  for (const [repKey, r] of Object.entries(state.reps)) {
    const pending = Object.values(r.leads).filter(l => l.status === 'pending');
    if (!pending.length) continue;

    // T+75 reassign (no reply at all) — act per lead whose reassign-due timestamp is in hours
    for (const l of pending) {
      const dueAt = l.assignedAt + REASSIGN_MS;
      if (t < dueAt) continue;
      if (!inHours(dueAt)) { l.status = 'skipped_offhours'; continue; }   // 75-mark fell outside hours → skip
      await reassignLead(repKey, r, l, 'no_response');
    }

    // T+60 nudge — one summary per rep listing their still-pending leads (once)
    const stillPending = Object.values(r.leads).filter(l => l.status === 'pending');
    const ripe = stillPending.filter(l => (t - l.assignedAt) >= NUDGE_MS && inHours(l.assignedAt + NUDGE_MS));
    if (ripe.length && !r.summaryMsgId) {
      const list = stillPending.map((l, i) => `${i + 1}. ${l.custName || l.custPhone || '—'} · ${l.brand || ''} · ${l.summary}`).join('\n');
      const mid = await safe(deps.waSend(r.phone, `⏰ *Not acknowledged yet (${stillPending.length})*\n${list}\n\n✅ Reply anything to confirm you've got them (or *PASS* to hand over). Otherwise reassigned in 15 min.`));
      r.summaryMsgId = mid; r.remindedAt = t;
      for (const l of stillPending) await slaWrite(l.recordId, { 'SLA Nudged At': t });
    }
  }
  persist();
}

async function safe(p) { try { return await p; } catch (e) { (deps.log || console.error)('sla dep err', String(e && e.message || e)); return null; } }
const mins = (ms) => Math.max(0, Math.round(ms / 60000));
// Patch SLA columns on a lead's Lark row (no-op in tests where the dep isn't injected).
async function slaWrite(recordId, fields) { if (deps.larkUpdateSLA && recordId) await safe(deps.larkUpdateSLA(recordId, fields)); }

// Scoreboard for the daily report (yesterday's working day).
function scoreboard(dayStartMs, dayEndMs) {
  const rows = {};
  for (const r of Object.values(state.reps)) {
    for (const l of Object.values(r.leads)) {
      if (l.assignedAt < dayStartMs || l.assignedAt > dayEndMs) continue;
      // attribute by ORIGINAL rep is lost after move; approximate by current holder
    }
  }
  return rows; // (filled in when wired to a per-day persistent log)
}

// Live snapshot of what the bot is currently tracking.
function stats() {
  const byStatus = {}; const pendingLeads = []; let tracked = 0;
  for (const [repKey, r] of Object.entries(state.reps)) {
    for (const l of Object.values(r.leads)) {
      tracked++; byStatus[l.status] = (byStatus[l.status] || 0) + 1;
      if (l.status === 'pending') pendingLeads.push({ rep: repKey, who: l.custName || l.custPhone || '—', brand: l.brand || '', ageMin: Math.round((now() - l.assignedAt) / 60000) });
    }
  }
  return { reassign: process.env.SLA_REASSIGN === '1' ? 'ON' : 'PAUSED', reps: Object.keys(state.reps).length, tracked, byStatus, pending: pendingLeads };
}
module.exports = { init, register, onReply, tick, scoreboard, stats, inHours, _state: () => state, NUDGE_MS, REASSIGN_MS };
