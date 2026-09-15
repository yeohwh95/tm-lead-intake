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

// ---------------------------------------------------------------------------------------------
// RECONNECT / BACKLOG GUARD (Benjamin, 2026-09-07)
// ---------------------------------------------------------------------------------------------
// `SLA_SWEEP_FROM` is an ABSOLUTE timestamp, so it rots. Set 2 Jul and never touched again, by
// 7 Sep it meant "enrol 67 days of leads" — and during a 6-minute accidental reconnect that day
// the sweep DM'd 9 reps before the session dropped on its own. The absolute cutoff is not wrong,
// but it only holds if a human remembers to bump it before every go-live, and a guard that
// depends on someone remembering is not a guard.
//
// A RELATIVE age cap needs no maintenance and cannot rot. Same reasoning as BACKLOG_MAX_DAYS in
// index.js, which already caps the backlog report for exactly this reason: "the age cap is what
// keeps the number meaningful".
//
// 🔑 The decision this encodes: after a reconnect, the pre-gap leads were already worked by hand.
// Notifying a rep about a lead they closed five days ago is noise, and noise trains people to
// ignore the alert that matters. Those rows stay in Lark, assigned and visible — they are skipped,
// not deleted.
// 9 OPEN hours, not 24 wall-clock hours (2026-09-16). These are the same strictness on a weekday:
// under the old cap a Monday-09:00 lead died at Tuesday 09:00, which is 9 open hours later. Keeping
// the number at 24 while switching the unit would have QUIETLY TRIPLED the window to ~2.7 working
// days, and the whole point of the cap is to bound an outage blast to about one day of leads.
// What changes is only the closed time in between: a Sunday lead now has the whole of Monday to be
// picked up instead of being dead before anyone opened the shop.
const SWEEP_MAX_AGE_H = Number(process.env.SLA_SWEEP_MAX_AGE_H || 9);
const SWEEP_MAX_AGE_MS = SWEEP_MAX_AGE_H * 3600e3;
// Unknown age is NEVER fresh: `slaRecCreated` returns 0 when Lark hands back a shape it cannot
// read, and a row that silently aged to 1970 must not read as a brand-new lead.
// ⚠️ AGE IS MEASURED IN WORKING HOURS, NOT WALL CLOCK (2026-09-16). The wall-clock version shipped
// on 7 Sep to stop a reconnect blast, and it did — but it also silently orphaned every Sunday.
// MEASURED: Sun 6 Sep, 4 TikTok ad leads, all 4 reached a rep on Monday morning. Sun 13 Sep, the
// first Sunday AFTER the cap, 46 leads, ZERO reached anybody — by Monday 09:00 they were 24h+ old
// and every sweep skipped them for good. Nothing failed and nothing logged an error; the leads just
// sat in Lark with a salesperson's name on them and that salesperson was never told.
// 🔑 A lead that arrives while the shop is CLOSED has not gone stale — nobody could have worked it.
// Counting only open hours says exactly that: Sunday→Monday is 0 hours elapsed (fresh), while a
// 6-day outage or the 67-day backlog is hundreds of open hours (stale), so the guard the cap was
// written for is untouched. Wall clock could not tell those two apart, and that is why it was wrong.
function workingMsBetween(fromMs, toMs) {
  if (toMs <= fromMs) return 0;
  let total = 0;
  // Walk hour by hour from the START of the hour containing `fromMs`. Hours are the resolution the
  // window itself is defined in (startH/endH), so anything finer would be inventing precision.
  const HOUR = 3600e3;
  for (let t = Math.floor(fromMs / HOUR) * HOUR; t < toMs; t += HOUR) {
    if (!inHours(t)) continue;
    const from = Math.max(t, fromMs), to = Math.min(t + HOUR, toMs);
    if (to > from) total += to - from;
  }
  return total;
}
function sweepFresh(createdMs, nowMs) {
  if (!createdMs) return false;
  if (nowMs <= createdMs) return true;
  return workingMsBetween(createdMs, nowMs) <= SWEEP_MAX_AGE_MS;
}

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
// Match by PHONE (real-phone JID), by a previously LEARNED @lid, or by NAME.
// ⚠️ `repHint` MUST be derived from the sender's PHONE (index.js `staffNameByPhone`) — never from their
// WhatsApp pushname. A pushname is sender-controlled, so fuzzy-matching it to the roster let customers
// impersonate reps ("Joel"→Jue) and swallow their own enquiry as that rep's ack (2026-07-30).
// Returns null, or { repKey, action:'ack'|'pass'|'noop', via:'lid'|'phone'|'name' }.
async function onReply(fromPhone, text, repHint, fromJid) {
  const digits = String(fromPhone).replace(/\D/g, '');
  for (const [repKey, r] of Object.entries(state.reps)) {
    const lidMatch = fromJid && (r.lids || []).includes(fromJid);          // exact — learned from a past VERIFIED reply
    const phoneMatch = digits.length >= 6 && String(r.phone).replace(/\D/g, '').slice(-9) === digits.slice(-9);
    const nameMatch = repHint && String(repHint).toLowerCase() === repKey.toLowerCase();
    if (!lidMatch && !phoneMatch && !nameMatch) continue;
    const via = phoneMatch ? 'phone' : (lidMatch ? 'lid' : 'name');
    // LEARN this rep's @lid → instant match next time. ONLY when it arrived with a verified staff
    // PHONE: learning on a name match let a customer whose pushname resembled a rep permanently bind
    // their own @lid to that rep, making every later message from them an ack (2026-07-30).
    if (fromJid && phoneMatch) { r.lids = r.lids || []; if (!r.lids.includes(fromJid)) r.lids.push(fromJid); }
    // A reply acknowledges leads that are still open OR were flagged No-Response / skipped-offhours
    // while unattended (LATE ACK). Bug fixed 2026-07-03: a reply arriving after the 75-min flag (or in
    // the split-second before a lead registered) was dropped as "noop", mis-scoring the rep as silent.
    // flagged_noreassign & skipped_offhours leads stay in r.leads (only deleted on a real reassign,
    // which is paused), so they can be recovered here.
    const ackable = Object.values(r.leads).filter(l => RECOVERABLE.has(l.status));
    if (!ackable.length) return { repKey, action: 'noop', via };   // matched a rep, but genuinely nothing to ack
    if (/\bpass\b/i.test(text || '')) {
      for (const l of ackable) {
        await slaWrite(l.recordId, { 'SLA First Response At': now(), 'SLA Response Action': 'Pass', 'SLA Response Time (min)': mins(now() - l.assignedAt) });
        await reassignLead(repKey, r, l, 'passed');
      }
      persist(); return { repKey, action: 'pass', count: ackable.length, via };
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
    persist(); return { repKey, action: 'ack', count: ackable.length, late: lateCount, via };
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
  // Dash rule (2026-08-14): same card family as notify.js, so it must read the same way — a colon
  // header, and NO `👤 —` placeholder line when there is no customer name.
  const dm = [`🔔 *${verb} Lead: ${l.brand || 'TM Motoworld'}*`,
    l.custName ? `👤 ${l.custName}` : ``,
    `🎯 ${l.summary}`,
    l.custPhone ? '👉 https://wa.me/' + l.custPhone.replace(/\D/g, '') : ``,
    ``, `✅ Reply anything once you've contacted them (or *PASS* to hand it over).`].filter(Boolean).join('\n');
  const newMsgId = await safe(deps.waSend(next.phone, dm));
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
      // Dash rule (2026-08-14): drop the `—` placeholder rather than print it. A lead with neither
      // a name nor a number renders as "3. Honda · zontes 368G", which is honest; "3. — · Honda"
      // reads as a rendering failure.
      const list = stillPending.map((l, i) => `${i + 1}. ` +
        [l.custName || l.custPhone, l.brand, l.summary].filter(Boolean).join(' · ')).join('\n');
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
module.exports = { init, register, onReply, tick, scoreboard, stats, inHours, sweepFresh, workingMsBetween, _state: () => state, NUDGE_MS, REASSIGN_MS, SWEEP_MAX_AGE_H };
