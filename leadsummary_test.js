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
  ok(/🔁 1 earlier lead\(s\) resolved today/.test(S.summaryText(monday, null)), 'carryover: and says so on the card');
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
