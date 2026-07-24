// Lead SLA engine — nudge (T+60) → reassign (T+75) → escalate, working-hours gated, persistent.
// Decoupled from index.js via injected deps (so it's unit-testable with simulated time).
// Spec: SLA-SPEC.md
const fs = require('fs');
const path = require('path');
const STORE = process.env.SLA_STORE || path.join(__dirname, 'sla_store.json');

const NUDGE_MS = 60 * 60 * 1000;       // T+60min summary nudge
const REASSIGN_MS = 75 * 60 * 1000;    // T+75min reassign
// TM operates SATURDAYS too (proven 2026-07-18: 13 TikTok leads + staff active while SLA slept).
// Days env-configurable: SLA_DAYS="1,2,3,4,5,6" default Mon–Sat; add 0 for Sunday if the team confirms.
const HOURS = { startH: 9, endH: 18, days: (process.env.SLA_DAYS || '1,2,3,4,5,6').split(',').map(Number) };
const MYT = 8 * 3600 * 1000;
// Lead states a rep's reply can still acknowledge — includes leads flagged No-Response / skipped
// off-hours (late ack recovery). Excludes contacted (already acked) and reassigned/escalated (moved on).
const RECOVERABLE = new Set(['pending', 'flagged_noreassign', 'skipped_offhours']);

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
    // assignedAt may be supplied by the boot rehydrator (original Lark timestamp) so restored
    // timers resume where they were instead of restarting the 75-min clock (2026-07-24).
    r.leads[l.recordId] = { recordId: l.recordId, summary: l.summary, brand: l.brand || '', custName: l.custName || '', custPhone: l.custPhone || '', assignedAt: l.assignedAt || now(), firstAssignedAt: l.firstAssignedAt || l.assignedAt || now(), dmMsgId, status: 'pending', reassignCount: 0, contactedAt: 0, override: !!l.override };
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
    // A reply acknowledges leads that are still open OR were flagged No-Response / skipped-offhours
    // while unattended (LATE ACK). Bug fixed 2026-07-03: a reply arriving after the 75-min flag (or in
    // the split-second before a lead registered) was dropped as "noop", mis-scoring the rep as silent.
    // flagged_noreassign & skipped_offhours leads stay in r.leads (only deleted on a real reassign,
    // which is paused), so they can be recovered here.
    const ackable = Object.values(r.leads).filter(l => RECOVERABLE.has(l.status));
    if (!ackable.length) return { repKey, action: 'noop' };   // matched a rep, but genuinely nothing to ack
    if (/\bpass\b/i.test(text || '')) {
      for (const l of ackable) {
        await slaWrite(l.recordId, { 'SLA First Response At': now(), 'SLA Response Action': 'Pass', 'SLA Response Time (min)': mins(now() - l.assignedAt) });
        await reassignLead(repKey, r, l, 'passed');
      }
      persist(); return { repKey, action: 'pass', count: ackable.length };
    }
    let lateCount = 0;
    for (const l of ackable) {   // any other message = acknowledged ("Keep")
      const late = l.status !== 'pending';   // was flagged No-Response / skipped before this reply
      if (late) lateCount++;
      l.status = 'contacted'; l.contactedAt = now();
      const rt = mins(now() - l.assignedAt), cw = mins(now() - (l.firstAssignedAt || l.assignedAt));
      await slaWrite(l.recordId, { 'SLA First Response At': now(), 'SLA Response Action': 'Keep', 'SLA Status': 'Acknowledged', 'SLA Response Time (min)': rt, 'SLA Customer Wait (min)': cw, 'SLA Within SLA?': rt <= 60 });
      if (late) (deps.log || console.log)('SLA late-ack recovered:', l.recordId, repKey, `(${rt}min after assign)`);
    }
    persist(); return { repKey, action: 'ack', count: ackable.length, late: lateCount };
  }
  return null;   // no tracked rep matched this reply
}

// Move a lead to the next rep (used by T+75 timeout AND by an explicit "pass").
async function reassignLead(repKey, r, l, reason) {
  l.heldBy = l.heldBy || [];
  if (!l.heldBy.includes(repKey)) l.heldBy.push(repKey);
  // Do NOT auto-move a no-response lead when ANY of these hold (nudge + group-escalate only, never move):
  //   • globally paused (SLA_REASSIGN !== '1'), OR
  //   • DELIBERATE (named) assignment — l.override — protect human intent (Benjamin's Option B, 2026-07-03), OR
  //   • lead predates the go-live cutoff SLA_REASSIGN_FROM — protects old in-flight leads ("new leads only").
  const REASSIGN_FROM = Number(process.env.SLA_REASSIGN_FROM || 0);
  const dontMove = process.env.SLA_REASSIGN !== '1' || l.override || (REASSIGN_FROM && l.assignedAt < REASSIGN_FROM);
  if (reason === 'no_response' && dontMove) {
    l.status = 'flagged_noreassign';
    await slaWrite(l.recordId, { 'SLA Status': 'No-Response' });
    const why = l.override ? `named to ${repKey}` : (process.env.SLA_REASSIGN !== '1' ? 'auto-reassign PAUSED' : 'pre-go-live lead');
    // batched into the 12PM/6PM group summary (no more 1-by-1 spam) — rep still got their personal DM
    if (deps.digestPush) deps.digestPush({ type: 'flag', rep: repKey, who: l.custName || l.custPhone, brand: l.brand || 'TM', why });
    (deps.log || console.log)('SLA no-response (no move):', l.recordId, repKey, l.override ? '[named]' : '');
    return;
  }
  // no-response: escalate after the first reassign (never bounce a customer endlessly)
  if (reason === 'no_response' && l.reassignCount >= 1) {
    l.status = 'escalated';
    await slaWrite(l.recordId, { 'SLA Status': 'Escalated', 'SLA Escalated At': now() });
    if (deps.digestPush) deps.digestPush({ type: 'escalate', who: l.custName || l.custPhone, brand: l.brand || 'TM', why: 'no response after reassign' });
    return;
  }
  await safe(deps.waDelete(l.dmMsgId));
  if (r.summaryMsgId) { await safe(deps.waDelete(r.summaryMsgId)); r.summaryMsgId = null; }
  const exclude = reason === 'passed' ? l.heldBy : [repKey];   // a passed lead skips everyone who already had it
  const next = await deps.pickNextRep(l.brand, repKey, exclude);
  if (!next) { l.status = 'escalated'; await slaWrite(l.recordId, { 'SLA Status': 'Escalated', 'SLA Escalated At': now() }); if (deps.digestPush) deps.digestPush({ type: 'escalate', who: l.custName || l.custPhone, brand: l.brand || 'TM', why: reason === 'passed' ? 'everyone passed' : 'no available rep' }); return; }
  const verb = reason === 'passed' ? 'Passed' : 'Reassigned';
  const newMsgId = await safe(deps.waSend(next.phone, `🔔 *${verb} Lead — ${l.brand || 'TM Motoworld'}*\n👤 ${l.custName || '—'}\n🎯 ${l.summary}\n${l.custPhone ? '👉 https://wa.me/' + l.custPhone.replace(/\D/g, '') : ''}\n\n✅ Reply anything once you've contacted them (or *PASS* to hand it over).`));
  await safe(deps.larkUpdateSalesman(l.recordId, next.openId));
  await slaWrite(l.recordId, { 'SLA Status': 'Reassigned', 'SLA Reassigned At': now(), 'SLA Reassigned From': repKey, 'SLA Reassign Count': l.reassignCount + 1 });
  // batched into the 12PM/6PM group summary (no more 1-by-1 spam) — both reps still got their personal DMs
  if (deps.digestPush) deps.digestPush({ type: 'reassign', from: repKey, to: next.name, who: l.custName || l.custPhone, reason });
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
