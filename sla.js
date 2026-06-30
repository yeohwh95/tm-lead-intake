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
  r.phone = repPhone;
  for (const l of leads) {
    if (r.leads[l.recordId]) continue;
    r.leads[l.recordId] = { recordId: l.recordId, summary: l.summary, brand: l.brand || '', custName: l.custName || '', custPhone: l.custPhone || '', assignedAt: now(), dmMsgId, status: 'pending', reassignCount: 0, contactedAt: 0 };
  }
  persist();
}

// Rep replied YES (to the TM number) → confirm ALL their pending leads.
function onReply(fromPhone, text) {
  if (!/\byes\b/i.test(text || '')) return false;
  const digits = String(fromPhone).replace(/\D/g, '');
  for (const [repKey, r] of Object.entries(state.reps)) {
    if (String(r.phone).replace(/\D/g, '').slice(-9) !== digits.slice(-9)) continue;
    let any = false;
    for (const l of Object.values(r.leads)) if (l.status === 'pending') { l.status = 'contacted'; l.contactedAt = now(); any = true; }
    if (any) { persist(); return repKey; }
  }
  return false;
}

// The 1-minute checker. Pure of side effects except via deps (all async).
async function tick() {
  const t = now();
  if (!inHours(t)) return;   // only act during working hours
  for (const [repKey, r] of Object.entries(state.reps)) {
    const pending = Object.values(r.leads).filter(l => l.status === 'pending');
    if (!pending.length) continue;

    // T+75 reassign / escalate — act per lead whose reassign-due timestamp is in hours
    for (const l of pending) {
      const dueAt = l.assignedAt + REASSIGN_MS;
      if (t < dueAt) continue;
      if (!inHours(dueAt)) { l.status = 'skipped_offhours'; continue; }   // 75-mark fell outside hours → skip
      if (l.reassignCount >= 1) {
        l.status = 'escalated';
        await safe(deps.groupNotify(`🚨 *Lead not picked up* — ${l.custName || l.custPhone} (${l.brand || 'TM'}) had no response after reassign. Needs a manager.`));
        continue;
      }
      // delete the old rep's DM + summary (dedupe deletes)
      await safe(deps.waDelete(l.dmMsgId));
      if (r.summaryMsgId) { await safe(deps.waDelete(r.summaryMsgId)); r.summaryMsgId = null; }
      // pick next rep in the region pool (skip current + unavailable)
      const next = await deps.pickNextRep(l.brand, repKey);
      if (!next) { l.status = 'escalated'; await safe(deps.groupNotify(`🚨 No available rep to reassign ${l.custName || l.custPhone} (${l.brand || 'TM'}). Needs a manager.`)); continue; }
      // DM the new rep + restart their timer
      const newMsgId = await safe(deps.waSend(next.phone, `🔔 *Reassigned Lead — ${l.brand || 'TM Motoworld'}*\n👤 ${l.custName || '—'}\n🎯 ${l.summary}\n${l.custPhone ? '👉 https://wa.me/' + l.custPhone.replace(/\D/g, '') : ''}\n\n✅ Reply *YES* once you've contacted them.`));
      await safe(deps.larkUpdateSalesman(l.recordId, next.openId));
      await safe(deps.groupNotify(`🔄 *Reassigned* — ${l.custName || l.custPhone}: ${repKey} → ${next.name} (no response in 75 min)`));
      // move the lead under the new rep
      delete r.leads[l.recordId];
      const nr = state.reps[next.key] || (state.reps[next.key] = { phone: next.phone, leads: {}, summaryMsgId: null, remindedAt: 0 });
      nr.phone = next.phone;
      nr.leads[l.recordId] = { ...l, assignedAt: t, dmMsgId: newMsgId, reassignCount: l.reassignCount + 1, status: 'pending' };
    }

    // T+60 nudge — one summary per rep listing their still-pending leads (once)
    const stillPending = Object.values(r.leads).filter(l => l.status === 'pending');
    const ripe = stillPending.filter(l => (t - l.assignedAt) >= NUDGE_MS && inHours(l.assignedAt + NUDGE_MS));
    if (ripe.length && !r.summaryMsgId) {
      const list = stillPending.map((l, i) => `${i + 1}. ${l.custName || l.custPhone || '—'} · ${l.brand || ''} · ${l.summary}`).join('\n');
      const mid = await safe(deps.waSend(r.phone, `⏰ *Uncontacted leads (${stillPending.length})*\n${list}\n\n✅ Reply *YES* once you've contacted them. Uncontacted leads will be reassigned in 15 min.`));
      r.summaryMsgId = mid; r.remindedAt = t;
    }
  }
  persist();
}

async function safe(p) { try { return await p; } catch (e) { (deps.log || console.error)('sla dep err', String(e && e.message || e)); return null; } }

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

module.exports = { init, register, onReply, tick, scoreboard, inHours, _state: () => state, NUDGE_MS, REASSIGN_MS };
