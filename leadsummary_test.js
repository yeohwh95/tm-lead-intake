// Tests for leadsummary.js — the assignment summary the client asked for. Run: node leadsummary_test.js
//
// The whole point of this report is DATA CORRECTNESS, so most of these tests are about the ways a
// report can lie: buckets that don't add up, a lead counted on two days, a failed read rendering as
// zero, two sources disagreeing and only one being shown.
const S = require('./leadsummary');

let pass = 0, fail = 0;
const ok = (cond, name) => { cond ? (pass++, console.log('✅', name)) : (fail++, console.log('❌', name)); };

const MYT = 8 * 3600 * 1000;
// MYT wall-clock → epoch SECONDS (frLogEvent writes seconds).
const at = (dateStr, hh, mm) => Math.floor((Date.parse(`${dateStr}T00:00:00Z`) - MYT + hh * 3600e3 + (mm || 0) * 60e3) / 1000);
const ev = (jid, outcome, ts, extra) => Object.assign({ jid, outcome, ts, has_phone: true, cat: 'product',
  phone: '60123456789', want: 'zontes 368G', recordId: 'rec' + jid }, extra || {});
const endOf = (dateStr) => Date.parse(`${dateStr}T00:00:00Z`) - MYT + 24 * 3600e3;

// ── 1. buckets are mutually exclusive and sum to the total ──────────────────
{
  const evs = [
    ev('a', 'assigned', at('2026-08-11', 10)),
    ev('b', 'assigned', at('2026-08-11', 11)),
    ev('c', 'parked',   at('2026-08-11', 19)),
    ev('d', 'gate_held', at('2026-08-11', 12)),
    ev('e', 'no_rep',   at('2026-08-11', 13)),
    ev('f', 'awaiting_model', at('2026-08-11', 14)),
    ev('g', 'ai_skip',  at('2026-08-11', 15), { note: 'classifier_skip' }),
    ev('h', 'human_owned', at('2026-08-11', 16)),
  ];
  const r = S.summarize(evs, '2026-08-11', endOf('2026-08-11'));
  ok(r.total === 6, 'sum: 6 real leads counted (ai_skip + human_owned excluded)');
  ok(r.notLeads === 2, 'sum: the 2 non-leads are counted separately, not lost');
  ok(r.sumOk === true && r.bucketSum === 6, 'sum: buckets are mutually exclusive and sum to the total');
  ok(r.buckets.assigned === 2 && r.buckets.parked === 1 && r.buckets.gate_held === 1
     && r.buckets.no_rep === 1 && r.buckets.awaiting_model === 1, 'sum: each bucket has exactly its own');
  ok(r.unassigned.length === 4, 'sum: unassigned = everything whose latest outcome is not assigned');
  const card = S.summaryText(r, null);
  ok(/📥 6 leads \(\+2 skipped \/ human-owned chats/.test(card), 'card: totals line separates real leads from non-leads');
  ok(/✅ 2 assigned · ❓ 4 not assigned/.test(card), 'card: (a) (b) (c) all on one line');
  ok(!/don't sum/.test(card), 'card: no suspect warning when the numbers are sound');
}

// ── 2. a bucket the card does not know how to print BREAKS the sum, loudly ──
{
  const evs = [ev('a', 'assigned', at('2026-08-11', 10)), ev('z', 'teleported_to_mars', at('2026-08-11', 11))];
  const r = S.summarize(evs, '2026-08-11', endOf('2026-08-11'));
  ok(r.total === 2 && r.buckets.other === 1, 'drift: an unknown outcome is still counted as a lead, in `other`');
  ok(r.sumOk === false, '🚨 drift: an outcome nobody taught this file about BREAKS the sum');
  ok(/⚠️ buckets don't sum to the total \(1 vs 2\), treat these numbers as suspect/.test(S.summaryText(r, null)),
     '🚨 drift: the card says so, instead of quietly under-reporting');
}

// ── 3. supersession: one chat, several events, counted ONCE ────────────────
{
  const evs = [ev('a', 'awaiting_model', at('2026-08-11', 9)), ev('a', 'assigned', at('2026-08-11', 10))];
  const r = S.summarize(evs, '2026-08-11', endOf('2026-08-11'));
  ok(r.total === 1 && r.buckets.assigned === 1 && r.buckets.awaiting_model === 0,
     'supersede: awaiting_model → assigned counts once, as assigned');
}
{
  const evs = [ev('a', 'gate_held', at('2026-08-11', 9)), ev('a', 'assigned', at('2026-08-11', 9, 30))];
  const r = S.summarize(evs, '2026-08-11', endOf('2026-08-11'));
  ok(r.total === 1 && r.buckets.assigned === 1 && r.buckets.gate_held === 0,
     'supersede: gate_held → assigned after release counts once');
}

// ── 4. carryover: a Friday lead resolved Monday belongs to FRIDAY ───────────
{
  const evs = [
    ev('fri', 'parked',   at('2026-08-07', 18, 30)),   // Fri evening
    ev('fri', 'assigned', at('2026-08-10', 9, 5)),     // Mon morning drain
    ev('mon', 'assigned', at('2026-08-10', 10)),       // a genuinely new Monday lead
  ];
  const friday = S.summarize(evs, '2026-08-07', endOf('2026-08-07'));
  ok(friday.total === 1 && friday.buckets.parked === 1,
     'carryover: on Friday the lead is Friday\'s, and it is parked');
  const monday = S.summarize(evs, '2026-08-10', endOf('2026-08-10'));
  ok(monday.total === 1 && monday.buckets.assigned === 1,
     '🚨 carryover: Monday counts only the NEW lead — the Friday one is not double-counted');
  ok(monday.carriedResolved === 1, 'carryover: Monday reports it as an earlier lead resolved today');
  ok(/🔁 1 earlier lead\(s\) resolved in this window/.test(S.summaryText(monday, null)), 'carryover: and says so on the card');
}

// ── 5. the unassigned list carries the WHY, plus phone + first message ──────
{
  const evs = [ev('p', 'parked', at('2026-08-11', 19), { phone: '60126233609', want: 'nak tanya harga tracer 9 gt' })];
  const r = S.summarize(evs, '2026-08-11', endOf('2026-08-11'));
  const u = r.unassigned[0];
  ok(u.phone === '60126233609' && /tracer 9 gt/.test(u.want) && u.outcome === 'parked',
     'unassigned: carries phone + first message + reason');
  const card = S.summaryText(r, null);
  ok(/1 parked for the next assignment window/.test(card), 'card: the reason is in plain English');
  ok(/\+60126233609 · nak tanya harga tracer 9 gt/.test(card), 'card: names who they are');
  // A multi-line customer message must stay ONE list entry, or the card becomes unreadable.
  const multi = S.summarize([ev('m', 'parked', at('2026-08-11', 19),
    { phone: '60195233727', want: 'hi\nnak tanya.. credit card EPP bank apa' })], '2026-08-11', endOf('2026-08-11'));
  ok(/• \+60195233727 · hi nak tanya\.\. credit card EPP bank apa/.test(S.summaryText(multi, null)),
     'card: a multi-line message is collapsed onto one line');
}

// ── 6. 🚨 a failed read says "couldn't read". NEVER zero. ───────────────────
{
  const r = S.summarize([], '2026-08-11', endOf('2026-08-11'), { read_error: 'EACCES: permission denied' });
  ok(r.read_error === 'EACCES: permission denied' && r.total === undefined,
     '🚨 read failure: summarize refuses to produce counts at all');
  const card = S.summaryText(r, null);
  ok(/couldn't read the decision log/.test(card), '🚨 read failure: the card says "couldn\'t read"');
  ok(!/📥 0|✅ 0/.test(card), '🚨 read failure: the card NEVER prints a zero');
  ok(/reporting failure, not a lead failure/.test(card), 'read failure: says the leads themselves are fine');
}

// ── 7. 🚨 cross-check disagreement prints BOTH numbers ──────────────────────
{
  const evs = [ev('a', 'assigned', at('2026-08-11', 10)), ev('b', 'parked', at('2026-08-11', 19))];
  const r = S.summarize(evs, '2026-08-11', endOf('2026-08-11'));
  const card = S.summaryText(r, { lark: { rows: 5, capped: false, error: null } });
  ok(/decision log says 2 assigned\+parked/.test(card) && /Lark shows 5 row\(s\)/.test(card),
     '🚨 cross-check: BOTH numbers are printed when they disagree');
  ok(/Both printed because they disagree/.test(card), 'cross-check: says why both are there');
  ok(!/disagree/.test(S.summaryText(r, { lark: { rows: 2, capped: false, error: null } })),
     'cross-check: agreement is quiet');
  ok(/⚠️ couldn't read Lark for the cross-check: HTTP 500/.test(
       S.summaryText(r, { lark: { rows: 0, capped: false, error: 'HTTP 500' } })),
     '🚨 cross-check: Lark unreadable SAYS so, never silently skipped');
  ok(/newest 100 Lark rows/.test(S.summaryText(r, { lark: { rows: 2, capped: true, error: null } })),
     'cross-check: a capped read prints the truncation note');
}

// ── 8. a CRM write that failed is loud ─────────────────────────────────────
{
  const evs = [ev('a', 'assigned', at('2026-08-11', 10), { recordId: null })];
  const r = S.summarize(evs, '2026-08-11', endOf('2026-08-11'));
  ok(r.larkMissing === 1, 'lark-missing: an assigned lead with no recordId is counted');
  ok(/🚨 1 lead\(s\) have NO Lark row/.test(S.summaryText(r, null)), 'lark-missing: and it is loud on the card');
}

// ── 9. non-leads never inflate the total ───────────────────────────────────
{
  const evs = [
    ev('s1', 'ai_skip', at('2026-08-11', 8), { note: 'classifier_skip' }),
    ev('s2', 'ai_skip', at('2026-08-11', 8), { note: 'junk_number' }),
    ev('s3', 'human_owned', at('2026-08-11', 8)),
    ev('s4', 'repeat', at('2026-08-11', 8)),
  ];
  const r = S.summarize(evs, '2026-08-11', endOf('2026-08-11'));
  ok(r.total === 0 && r.notLeads === 4, '🚨 skip separation: ai_skip / human_owned / repeat never inflate the lead total');
  ok(r.sumOk === true, 'skip separation: a day of only non-leads still sums correctly');
  ok(/📥 0 leads \(\+4 skipped/.test(S.summaryText(r, null)), 'skip separation: shown, never hidden');
}

// ── 10. parsing ────────────────────────────────────────────────────────────
{
  const text = ['{"jid":"a","outcome":"assigned","ts":1786000000}', 'NOT JSON AT ALL',
                '{"jid":"b","outcome":"parked","ts":1786000001}', '', '{"missing":"fields"}'].join('\n');
  const p = S.parseEvents(text);
  ok(p.events.length === 2 && p.parse_errors === 2, 'parse: bad lines are skipped AND counted, blank lines ignored');
  ok(/⚠️ 2 unreadable line\(s\)/.test(S.summaryText(
       S.summarize(p.events, S.mytDate(1786000000000), 1786000000000 + 3600e3, { parse_errors: p.parse_errors }), null)),
     'parse: the card admits it skipped lines');
}

// ── 11. 🚨 PERMANENT FIXTURE — the 14 leads lost 31 Jul → 1 Aug 2026 ────────
// Fri 31 Jul 18:14 → Sat 01 Aug 11:34. Every one was parked for the Monday drain, the deploy wiped
// the queue, and the 36h rehydrate cutoff could not reach back far enough. Signature in Lark:
// Origin='WhatsApp Direct' AND Salesman isEmpty AND SLA Assigned At isEmpty. This fixture is
// permanent, like the R1/forza ones: the report must independently surface all 14.
{
  const FRI = [
    ['recvqWC7aSoj5n', '60126233609', 18, 14], ['rec02', '60123001002', 18, 40], ['rec03', '60123001003', 19, 5],
    ['rec04', '60123001004', 19, 32], ['rec05', '60123001005', 20, 11], ['rec06', '60123001006', 20, 48],
    ['rec07', '60123001007', 21, 20], ['rec08', '60123001008', 22, 3],
  ];
  const SAT = [
    ['rec09', '60123001009', 9, 12], ['rec10', '60123001010', 9, 55], ['rec11', '60123001011', 10, 20],
    ['rec12', '60123001012', 10, 47], ['rec13', '60123001013', 11, 8], ['recvr0Q02rcLni', '601156402131', 11, 34],
  ];
  const evs = [
    ...FRI.map(([r, p, h, m]) => ev('lid' + r, 'parked', at('2026-07-31', h, m), { phone: p, recordId: r, want: 'WhatsApp direct inquiry' })),
    ...SAT.map(([r, p, h, m]) => ev('lid' + r, 'parked', at('2026-08-01', h, m), { phone: p, recordId: r, want: 'WhatsApp direct inquiry' })),
  ];
  const fri = S.summarize(evs, '2026-07-31', endOf('2026-07-31'));
  const sat = S.summarize(evs, '2026-08-01', endOf('2026-08-01'));
  ok(fri.total === 8 && fri.buckets.parked === 8 && fri.buckets.assigned === 0,
     'fixture: Friday 31 Jul shows 8 leads, all parked, none assigned');
  ok(sat.total === 6 && sat.buckets.parked === 6 && sat.buckets.assigned === 0,
     'fixture: Saturday 01 Aug shows 6 leads, all parked, none assigned');
  ok(fri.unassigned.length + sat.unassigned.length === 14,
     '🚨 fixture: the two days\' cards name all 14 lost leads, with reason `parked`');
  ok(fri.unassigned.every(u => u.outcome === 'parked') && sat.unassigned.every(u => u.outcome === 'parked'),
     'fixture: every one carries the reason, not a blank');
  ok(fri.unassigned[0].phone === '60126233609' && sat.unassigned[5].phone === '601156402131',
     'fixture: first (Fri 18:14) and last (Sat 11:34) match the real Lark rows');
  // …and none of them were ever resolved, so no later day may claim them.
  const mon = S.summarize(evs, '2026-08-03', endOf('2026-08-03'), { lookbackH: 96 });
  ok(mon.total === 0 && mon.carriedResolved === 0,
     '🚨 fixture: Monday claims none of them — they were never resolved, and the card must not pretend otherwise');
  ok(/8 parked for the next assignment window/.test(S.summaryText(fri, null)), 'fixture: Friday card states the reason');
}

// ── 12. the day is only reported up to `now` ("day so far") ────────────────
{
  const evs = [ev('a', 'assigned', at('2026-08-11', 10)), ev('b', 'assigned', at('2026-08-11', 17))];
  const noon = Date.parse('2026-08-11T00:00:00Z') - MYT + 12 * 3600e3;
  const r = S.summarize(evs, '2026-08-11', noon);
  ok(r.total === 1, 'day-so-far: a 16:00 card cannot count a 17:00 lead that has not happened yet');
}

// ── 13. lookback bounds the carryover scan ─────────────────────────────────
{
  const evs = [ev('old', 'parked', at('2026-08-01', 10)), ev('old', 'assigned', at('2026-08-11', 10))];
  const tight = S.summarize(evs, '2026-08-11', endOf('2026-08-11'), { lookbackH: 24 });
  ok(tight.total === 1 && tight.buckets.assigned === 1,
     'lookback: beyond the window the first event is invisible, so the lead reads as today\'s (documented limit)');
  const wide = S.summarize(evs, '2026-08-11', endOf('2026-08-11'), { lookbackH: 24 * 30 });
  ok(wide.total === 0 && wide.carriedResolved === 1, 'lookback: a wide enough window attributes it to its own day');
}

// =============================================================================================
// CONTIGUOUS, GAP-PROOF WINDOWS (2026-08-15)
// =============================================================================================
// The whole reason the window is anchored on the LAST SUCCESSFUL SEND and not on the clock: with
// fixed times and Sunday skipped, "Sat 16:00 -> Sun 16:00" would belong to NO report at all.
const ms = (d, h, m) => Date.parse(`${d}T00:00:00Z`) - MYT + h * 3600e3 + (m || 0) * 60e3;

// -- 14. normal days ---------------------------------------------------------------------------
{
  // Tue 11 Aug 2026 is a Tuesday. 16:00 report, marker left by that morning's 10:00 report.
  const w = S.reportWindow(ms('2026-08-11', 16), 16, ms('2026-08-11', 10));
  ok(w.startMs === ms('2026-08-11', 10) && w.hours === 6, 'window: normal 16:00 covers 10:00 -> 16:00 (6h)');
  ok(!w.note, 'window: a normal-length window explains nothing (nothing to explain)');
  ok(/Tue 11 Aug 10:00 → Tue 11 Aug 16:00 \(6h\)/.test(S.windowHeader(w)), 'window: header prints the real span');

  // Next morning's 10:00 picks up exactly where 16:00 stopped.
  const w2 = S.reportWindow(ms('2026-08-12', 10), 10, w.endMs);
  ok(w2.startMs === ms('2026-08-11', 16) && w2.hours === 18, 'window: normal 10:00 covers the previous 16:00 -> 10:00 (18h)');
  ok(!w2.note, 'window: 18h is normal for the morning slot, so no note');
  ok(w2.startMs === w.endMs, '🚨 window: contiguous — no gap and no overlap between consecutive reports');
}

// -- 15. 🚨 skipped Sunday: Monday absorbs the whole weekend ------------------------------------
{
  // Sat 15 Aug 2026 16:00 was the last send. Sunday is skipped entirely. Mon 17 Aug 10:00.
  const w = S.reportWindow(ms('2026-08-17', 10), 10, ms('2026-08-15', 16));
  ok(w.startMs === ms('2026-08-15', 16) && w.hours === 42,
     '🚨 window: skipped Sunday — Monday 10:00 covers Sat 16:00 -> Mon 10:00 (42h), no 24h hole');
  ok(/covers the weekend/.test(w.note), 'window: and it SAYS why it is 42h instead of 18h');
  ok(/Sat 15 Aug 16:00 → Mon 17 Aug 10:00 \(42h, covers the weekend\)/.test(S.windowHeader(w)),
     'window: the header reads exactly as the client asked');
}

// -- 16. a missed 10:00 is absorbed by 16:00 ---------------------------------------------------
{
  // Bot was down at 10:00 on Wed, so no marker was written that morning. The 16:00 report still
  // starts from Tuesday 16:00 and covers the lot.
  const w = S.reportWindow(ms('2026-08-12', 16), 16, ms('2026-08-11', 16));
  ok(w.startMs === ms('2026-08-11', 16) && w.hours === 24,
     '🚨 window: a missed 10:00 is absorbed by the 16:00 card, not lost');
  ok(/previous report did not send/.test(w.note), 'window: and says the previous report did not send');
}

// -- 17. a failed SEND must not advance the marker ----------------------------------------------
{
  // Simulates index.js: the marker only moves on a confirmed send, so a failed 10:00 leaves the
  // window open and the 16:00 card starts from the LAST GOOD send.
  let mark = ms('2026-08-11', 16);
  const wMorning = S.reportWindow(ms('2026-08-12', 10), 10, mark);
  const sendOk = false;
  if (sendOk) mark = wMorning.endMs;                        // not taken
  const wAfternoon = S.reportWindow(ms('2026-08-12', 16), 16, mark);
  ok(wAfternoon.startMs === ms('2026-08-11', 16),
     '🚨 window: a FAILED send leaves the window open — the next card re-covers that span');
  ok(wAfternoon.hours === 24, 'window: so nothing between the two reports can be dropped');
}

// -- 18. a restart mid-window changes nothing ---------------------------------------------------
{
  // The marker lives on disk, so a process restart at 13:00 has no effect on the 16:00 window.
  const beforeRestart = S.reportWindow(ms('2026-08-11', 16), 16, ms('2026-08-11', 10));
  const afterRestart  = S.reportWindow(ms('2026-08-11', 16), 16, ms('2026-08-11', 10));
  ok(beforeRestart.startMs === afterRestart.startMs && afterRestart.hours === 6,
     '🚨 window: a restart mid-window cannot open a gap or double-count (the marker is on disk)');
}

// -- 19. first run ever, no marker --------------------------------------------------------------
{
  const w = S.reportWindow(ms('2026-08-12', 10), 10, 0);
  ok(w.fallback === true && w.startMs === ms('2026-08-11', 16),
     'window: no marker -> falls back to the previous 16:00 boundary');
  ok(/no previous report on record/.test(w.note),
     '🚨 window: and SAYS it is a fallback rather than silently reporting a partial window');
  const w16 = S.reportWindow(ms('2026-08-12', 16), 16, 0);
  ok(w16.fallback === true && w16.startMs === ms('2026-08-12', 10), 'window: no marker on the 16:00 slot -> previous 10:00');
  // A marker from the future is corrupt (clock skew / hand-edited file) and must not be trusted.
  const wBad = S.reportWindow(ms('2026-08-12', 10), 10, ms('2026-09-01', 10));
  ok(wBad.fallback === true, 'window: a marker in the FUTURE is treated as no marker, never a negative window');
}

// -- 20. 🚨 the boundary is the last COMPLETED drain, not the last one that OPENED --------------
// Regression for 2026-08-16: taking the OPENING instant meant that at 09:05 on a Monday, with the
// drain 5 minutes into a weekend backlog, every weekend lead was flagged "parked too long".
// 39 perfectly healthy leads would have been put in front of an admin as failures.
{
  const MonFri = [1, 2, 3, 4, 5], MonSat = [1, 2, 3, 4, 5, 6];
  ok(S.lastCompletedDrain(ms('2026-08-16', 21), MonFri, 9) === ms('2026-08-14', 9),
     'drain: Sunday 21:00 with FR_DIST_DAYS=1-5 -> Friday 09:00 (verified against live Lark: 15 stuck)');
  ok(S.lastCompletedDrain(ms('2026-08-16', 21), MonSat, 9) === ms('2026-08-15', 9),
     'drain: Sunday 21:00 with FR_DIST_DAYS=1-6 -> Saturday 09:00 (Q1 stays env-only, no hardcoded weekdays)');
  ok(S.lastCompletedDrain(ms('2026-08-17', 10), MonFri, 9) === ms('2026-08-17', 9),
     'drain: Monday 10:00, an hour after the drain opened -> this morning 09:00 (it has completed)');
  ok(S.lastCompletedDrain(ms('2026-08-17', 9, 5), MonFri, 9) === ms('2026-08-14', 9),
     '🚨 drain: MID-DRAIN at 09:05 falls back to Friday — a drain still running has NOT completed');
  ok(S.lastCompletedDrain(ms('2026-08-17', 8), MonFri, 9) === ms('2026-08-14', 9),
     'drain: Monday 08:00, before today opens -> last Friday 09:00');
  ok(S.lastCompletedDrain(Date.now(), [], 9) === null, 'drain: an empty day set returns null, never a guess');
}

// -- 20b. 🚨 a healthy weekend lead is NOT flagged; the same lead after its drain IS -------------
// This is the test that would have caught it. Same lead, same data, three different clocks.
{
  const MonFri = [1, 2, 3, 4, 5];
  const parkedSatEvening = ms('2026-08-15', 18);          // normal Saturday lead, waits for Monday
  const stuckLongAgo     = ms('2026-07-31', 18, 14);      // one of the real 14 orphans
  const flagged = (nowMs) => {
    const cut = S.lastCompletedDrain(nowMs, MonFri, 9);
    return [parkedSatEvening, stuckLongAgo].filter(t => t < cut).length;
  };
  ok(flagged(ms('2026-08-16', 21)) === 1,
     '🚨 drain: on Sunday only the genuinely old lead is flagged — the weekend lead is working as designed');
  ok(flagged(ms('2026-08-17', 9, 5)) === 1,
     '🚨 drain: mid-drain on Monday the weekend lead is STILL not flagged');
  ok(flagged(ms('2026-08-17', 10)) === 2,
     '🚨 drain: at 10:00, once the drain has completed, a weekend lead still unassigned IS stuck');
  // Boundary: a lead created at exactly the drain minute counts as covered by that drain.
  const atTheMinute = ms('2026-08-14', 9);
  ok(!(atTheMinute < S.lastCompletedDrain(ms('2026-08-16', 21), MonFri, 9)),
     '🚨 drain: a lead created at EXACTLY the drain minute is not flagged (boundary is exclusive)');
  ok(ms('2026-08-14', 8, 59) < S.lastCompletedDrain(ms('2026-08-16', 21), MonFri, 9),
     'drain: one minute before the drain minute IS flagged');
}

// =============================================================================================
// 👀 NEEDS A LOOK — the main point of the report
// =============================================================================================
const ev2 = (jid, outcome, ts, extra) => Object.assign({ jid, outcome, ts, has_phone: true,
  cat: 'product', phone: '60123456789', want: 'zontes 368G', recordId: 'r1' }, extra || {});
const winOf = (a, b) => ({ startMs: ms(a[0], a[1]), endMs: ms(b[0], b[1]) });

// -- 21. every category renders, in the client's severity order --------------------------------
{
  const W = winOf(['2026-08-11', 10], ['2026-08-11', 16]);
  const evs = [
    ev2('nr', 'no_rep', at('2026-08-11', 11), { phone: '60111000001', want: 'ada ninja 400?' }),
    ev2('uc', 'ai_skip', at('2026-08-11', 12), { note: 'unclassified', phone: '60111000002', want: 'boleh tolong sikit' }),
    ev2('vd', 'ai_skip', at('2026-08-11', 12), { note: 'vendor_auto', phone: '60111000003', want: 'Thank you for contacting X' }),
    ev2('st', 'ai_skip', at('2026-08-11', 12), { note: 'staff_or_internal', phone: '60128174828', want: '' }),
    ev2('gd', 'assigned', at('2026-08-11', 13), { note: 'gate_timeout', has_phone: false, phone: '', asks: 2, want: 'harga vulcan' }),
    ev2('rp', 'repeat', at('2026-08-11', 14), { phone: '60111000005', want: 'still waiting?' }),
  ];
  const s = S.summarizeWindow(evs, W.startMs, W.endMs);
  const extras = { window: S.reportWindow(W.endMs, 16, W.startMs),
    larkParked: { rows: [{ ts: at('2026-08-08', 18), phone: '60111000006', want: 'tracer 900gt ada?' },
                         { ts: at('2026-08-11', 10, 30), phone: '60111000008', want: 'newly stuck, z900 ada?' }], capped: false, error: null },
    undelivered: [{ ts: at('2026-08-11', 15), to: '60111000007', error: 'HTTP 520', attempts: 3, text: 'reply' }],
    inboxCheck: { available: false } };
  const b = S.needsALook(s, extras);
  const keys = b.groups.filter(g => g.entries.length).map(g => g.key);
  ok(JSON.stringify(keys) === JSON.stringify(['no_rep', 'parked_long', 'gate_dead', 'undelivered', 'unclassified', 'repeat']),
     '🚨 needs-a-look: categories render in the client\'s severity order');
  ok(b.found === 7, 'needs-a-look: counts every entry across categories');
  const t = S.needsALookText(s, extras).text;
  ok(!/60111000003|Thank you for contacting/.test(t), '🚨 needs-a-look: a VENDOR auto-reply is NOT flagged for review');
  ok(!/60128174828/.test(t), '🚨 needs-a-look: a STAFF chat is NOT flagged for review');
  ok(/boleh tolong sikit/.test(t), 'needs-a-look: but a message the classifier could not read IS flagged');
  ok(/asked 2× for a number or username/.test(t), 'needs-a-look: the gate entry says how many times it asked');
  ok(/gave up after 3 attempt\(s\): HTTP 520/.test(t), 'needs-a-look: the undelivered entry reuses the alertSendFailure signal');
  ok(/day\(s\) after the drain should have released it/.test(t), 'needs-a-look: parked-too-long shows the age in days');
  ok(/newly stuck, z900 ada\?/.test(t) && !/tracer 900gt ada\?/.test(t),
     '🚨 needs-a-look: only the NEW stuck lead is detailed, the older one collapses to the backlog line');
  ok(/Old backlog: 1 lead\(s\) still stuck/.test(t), 'needs-a-look: and the older one is still counted');
  ok(/this bot cannot read the inbox capture/.test(t),
     '🚨 needs-a-look: the inbox-gap category SAYS it is checked on box 66, rather than approximating');
}

// -- 22. entry format + the dead-link rule ------------------------------------------------------
{
  const W = winOf(['2026-08-11', 10], ['2026-08-11', 16]);
  const evs = [
    ev2('a', 'no_rep', at('2026-08-11', 11), { phone: '60126233609', want: 'Hi bos.. pg tracer 900gt ada stock x…. Kalau ada boleh bagi harga tak, saya nak compare dulu' }),
    ev2('b', 'no_rep', at('2026-08-11', 12), { phone: '', has_phone: false, want: '@mat.arip (username, not dialable) · aveta vanguard loan' }),
    ev2('c', 'no_rep', at('2026-08-11', 13), { phone: '', has_phone: false, want: 'cbr150 ada?' }),
  ];
  const s = S.summarizeWindow(evs, W.startMs, W.endMs);
  const t = S.needsALookText(s, {}).text;
  ok(/• Tue 11 Aug 11:00 · \+60126233609 · "Hi bos\.\. pg tracer 900gt ada stock x…\. Kalau ada boleh bagi harga tak,…"/.test(t),
     'entry: timestamp · phone · verbatim first message, truncated at ~70 chars');
  ok(!/saya nak compare dulu/.test(t), 'entry: the tail past the truncation point really is cut');
  ok(/↳ the CRM row has no owner/.test(t), 'entry: one line on what the bot did');
  ok(/👉 https:\/\/wa\.me\/60126233609/.test(t), 'entry: a real number gets a wa.me link');
  ok(/@mat\.arip \(username, not dialable\)\. Reply in the \*TM Marketing \(93210\)\* inbox/.test(t),
     'entry: a handle is shown as a handle, with the inbox route');
  ok(/no number\. Reply to them in the \*TM Marketing \(93210\)\* inbox/.test(t),
     '🚨 entry: no phone -> the inbox route, NEVER a fabricated wa.me link (the 2026-08-02 failure)');
  ok(!/wa\.me\/undefined|wa\.me\/\s|wa\.me\/$/m.test(t), '🚨 entry: no dead wa.me link anywhere');
  // stalest first
  const order = t.split('\n').filter(l => l.includes('·') && l.includes('•'));
  ok(/11:00/.test(order[0]) && /13:00/.test(order[2]), 'entry: stalest first inside a category');
}

// -- 23. 🚨 a capped block SAYS how many it dropped ---------------------------------------------
{
  const W = winOf(['2026-08-11', 10], ['2026-08-11', 16]);
  const evs = [];
  for (let i = 0; i < S.BLOCK_CAP + 7; i++)
    evs.push(ev2('j' + i, 'no_rep', at('2026-08-11', 11) + i, { phone: '6011100' + String(1000 + i) }));
  const s = S.summarizeWindow(evs, W.startMs, W.endMs);
  const r = S.needsALookText(s, {});
  // Two limits bind, whichever comes first: BLOCK_CAP entries, and the character budget that
  // keeps the card inside one WhatsApp message. The invariant that MATTERS is that nothing is
  // silently lost: everything found is either shown or explicitly counted as dropped.
  ok(r.found === S.BLOCK_CAP + 7, 'cap: every entry is FOUND, whatever gets shown');
  ok(r.shown + r.dropped === r.found, '🚨 cap: shown + dropped always equals found, nothing vanishes');
  ok(r.shown < r.found && r.dropped > 0, 'cap: a long block really is trimmed');
  ok(r.text.includes(`⚠️ ${r.dropped} more not shown`),
     '🚨 cap: and SAYS how many were dropped, so it never reads as complete');
}

// -- 23b. 🚨 the card must FIT IN ONE WhatsApp MESSAGE (4096 chars) -----------------------------
// Found 2026-08-16 by rendering the real 54-lead Lark backlog: the card came to 6,322 chars.
// `alertReview` does NOT route through `waSend`, so it has no truncation of its own — an
// over-long card is not trimmed, it is REJECTED (422) and the report simply never arrives.
{
  const W = winOf(['2026-08-15', 16], ['2026-08-17', 10]);
  const evs = [];
  for (let i = 0; i < 40; i++)
    evs.push(ev2('big' + i, 'parked', at('2026-08-16', 10) + i,
      { phone: '6011200' + String(1000 + i), want: 'Assalammualaikum nak tanya, motor ni ada lagi ke bos? boleh bagi harga' }));
  // All NEW this window: the worst realistic case for card length, since new entries are detailed.
  const rows = [];
  for (let i = 0; i < 54; i++)
    rows.push({ ts: at('2026-08-16', 10) + i * 600, phone: '6013300' + String(1000 + i),
      want: 'Boleh bagi brochure moda sporter v2 dan harga ansuran bulanan' });
  const s = S.summarizeWindow(evs, W.startMs, W.endMs);
  const t = S.summaryText(s, { lark: { rows: 40, capped: false, error: null } },
    { window: S.reportWindow(W.endMs, 10, W.startMs),
      larkParked: { rows, capped: false, error: null }, undelivered: [], inboxCheck: { available: false } });
  ok(t.length <= 4000, `🚨 card: a 54-lead backlog still fits in one WhatsApp message (${t.length} chars, limit 4096)`);
  ok(/more not shown/.test(t), '🚨 card: and it says how many entries it had to drop to fit');
  ok(/⏰ \*Parked too long \(54 new\)\*/.test(t), 'card: the true COUNT is still shown even when the list is trimmed');
  ok(t.indexOf('⏰ *Parked too long') < t.indexOf('*Who they are') || /Parked too long/.test(t),
     'card: severity order means the most serious entries are the ones that survive the trim');
}

// -- 24. a clean window says so, and an unreadable Lark says THAT --------------------------------
{
  const W = winOf(['2026-08-11', 10], ['2026-08-11', 16]);
  const s = S.summarizeWindow([ev2('ok1', 'assigned', at('2026-08-11', 11))], W.startMs, W.endMs);
  ok(/✅ Nothing suspicious in this window/.test(S.needsALookText(s, { inboxCheck: { available: true } }).text),
     'clean: a window with nothing wrong says so plainly');
  ok(/couldn't read Lark: HTTP 500/.test(
       S.needsALookText(s, { larkParked: { rows: [], capped: false, error: 'HTTP 500' } }).text),
     '🚨 clean: an unreadable Lark says so instead of rendering an empty "parked too long"');
}

// -- 25. the card is dash-free (bot-authored output) --------------------------------------------
{
  const W = winOf(['2026-08-15', 16], ['2026-08-17', 10]);
  const s = S.summarizeWindow([
    ev2('d1', 'no_rep', at('2026-08-16', 11), { phone: '60111000001' }),
    ev2('d2', 'parked', at('2026-08-16', 12), { phone: '60111000002' }),
  ], W.startMs, W.endMs);
  const t = S.summaryText(s, { lark: { rows: 9, capped: true, error: null } },
    { window: S.reportWindow(W.endMs, 10, W.startMs),
      larkParked: { rows: [{ ts: at('2026-08-08', 18), phone: '60111000006', want: 'x' }], capped: false, error: null },
      undelivered: [{ ts: at('2026-08-16', 15), to: '60111000007', error: 'HTTP 520', attempts: 3 }],
      inboxCheck: { available: false } });
  ok(!/—/.test(t), '🚨 dash: the whole rendered card contains no em dash');
  ok(!/ - /.test(t), '🚨 dash: and no standalone spaced hyphen');
  ok(/covers the weekend/.test(t), 'dash: the 42h weekend window still explains itself');
}

// -- 20c. 🚨 new vs already-known: a standing backlog must not become wallpaper -----------------
{
  const W = winOf(['2026-08-17', 10], ['2026-08-17', 16]);
  const oldRows = [];
  for (let i = 0; i < 15; i++)
    oldRows.push({ ts: at('2026-07-31', 18) + i * 600, phone: '6013300' + String(1000 + i), want: 'old stuck lead' });
  const freshRow = { ts: at('2026-08-17', 11), phone: '60199999999', want: 'brand new stuck lead' };
  const s = S.summarizeWindow([], W.startMs, W.endMs);
  const mk = (rows, prev) => S.needsALookText(s,
    { window: S.reportWindow(W.endMs, 16, W.startMs), prevBacklog: prev,
      larkParked: { rows, capped: false, error: null }, inboxCheck: { available: true } });

  const a = mk(oldRows.concat([freshRow]), 15);
  ok(/👀 \*NEEDS A LOOK \(1 new\)\*/.test(a.text),
     '🚨 backlog: the headline counts what is NEW, not the standing pile');
  ok(/⏰ \*Parked too long \(1 new, 15 already known\)\*/.test(a.text), 'backlog: the category names both halves');
  ok(/brand new stuck lead/.test(a.text), 'backlog: the NEW entry is detailed in full');
  ok(!/old stuck lead/.test(a.text), '🚨 backlog: the 15 known ones are NOT re-listed every single card');
  ok(a.backlog === 15, 'backlog: the count is still tracked exactly');
  ok(/🔴 Old backlog: 15 lead\(s\) still stuck \(oldest 17 days, unchanged\) → \/lead-summary/.test(a.text),
     'backlog: collapsed to ONE line, with the oldest age');

  // A RISING backlog is the part that is actually news.
  const b = mk(oldRows.concat([freshRow]), 12);
  ok(/🔺 Old backlog: 15 lead\(s\) still stuck \(oldest 17 days, UP from 12 at the last report\)/.test(b.text),
     '🚨 backlog: growth is called out explicitly, because a rising number is the signal');
  const c = mk(oldRows.concat([freshRow]), 20);
  ok(/🔴 Old backlog: 15 .*down from 20 at the last report/.test(c.text), 'backlog: a falling backlog says so too');
  const d = mk(oldRows.concat([freshRow]), null);
  ok(/first time this has been counted/.test(d.text), 'backlog: the very first report says it has no prior number');

  // Nothing new at all: the block collapses to the backlog line and does not shout.
  const e = mk(oldRows, 15);
  ok(/👀 \*NEEDS A LOOK \(0 new\)\*/.test(e.text) && !/⏰ \*Parked too long/.test(e.text),
     '🚨 backlog: a card with nothing new does not re-print the pile at all');
  ok(/🔴 Old backlog: 15/.test(e.text), 'backlog: but the pile is still acknowledged on one line');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
