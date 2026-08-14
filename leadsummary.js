// The client's three questions, answered from a durable record: (a) how many leads today,
// (b) how many were assigned, (c) how many were NOT and WHY.
//
// Pure functions only. index.js boots an HTTP server on require and therefore cannot host tested
// logic (same reason as catalog.js / hours.js / identity.js / roster.js / notify.js).
//
// 🚨 THE THREE RULES THIS FILE EXISTS TO ENFORCE (client asked for them explicitly):
//  1. Buckets are MUTUALLY EXCLUSIVE and MUST sum to the total, or the card says so out loud.
//     `sumOk` is not decoration: `total` is counted independently (one per lead chat) and compared
//     against the sum of the buckets the card knows how to print. A future outcome enum nobody
//     taught this file about lands in `other`, breaks the sum, and prints a ⚠️ instead of quietly
//     under-reporting. This is the `slaWindowStats` discipline of 2026-07-30.
//  2. TWO INDEPENDENT SOURCES, and when they disagree BOTH numbers are printed. Never silently
//     prefer one. (The second source, the box-66 inbox capture, is compared on the VPS by
//     audit_fr.py — this file handles the Lark side.)
//  3. A FAILED READ SAYS "couldn't read". Never 0. A zero that means "the log is unreadable" is
//     the exact shape of the 2026-07-30 report that told the client a quiet day when three reps
//     had been busy.
//
// LEAD-DAY ATTRIBUTION. A chat can legitimately emit several events across several days
// (`gate_held` Friday → `assigned` Monday; `awaiting_model` → `assigned`). A lead belongs to the
// MYT date of its FIRST event inside the lookback, and is counted by its LATEST event on or before
// the day being reported. That is what stops a Friday lead being counted again on Monday, and it
// is also what makes the buckets mutually exclusive by construction.

const MYT_OFF_DEFAULT = 8 * 3600 * 1000;

// Outcomes that describe a real sales lead. Order is the order they print.
const LEAD_BUCKETS = ['assigned', 'parked', 'gate_held', 'no_rep', 'awaiting_model'];
// Chats that are NOT sales leads. Reported on their own line so (a)(b)(c) reads on real leads
// (Benjamin, 2026-08-14) — never folded into the total, never hidden either.
const NON_LEAD_BUCKETS = ['ai_skip', 'human_owned', 'repeat'];

// Plain English for the "why wasn't it assigned" list. A reason a salesperson can act on.
const WHY = {
  parked:         'parked for the next assignment window',
  gate_held:      'no phone number yet, still asking',
  no_rep:         '🚨 NOBODY took it (the CRM row has no owner)',
  awaiting_model: 'greeted, waiting for them to say which bike',
  other:          'unrecognised outcome (see ⚠️ above)',
};

const mytDate = (ms, off) => new Date(ms + (off == null ? MYT_OFF_DEFAULT : off)).toISOString().slice(0, 10);
const dayStartMs = (dateStr, off) => Date.parse(dateStr + 'T00:00:00Z') - (off == null ? MYT_OFF_DEFAULT : off);

// One bad line must not cost the whole day's report — but it must be COUNTED, so a silently
// corrupt log can't pass as a quiet day.
function parseEvents(jsonlText){
  const events = [];
  let parse_errors = 0;
  for (const line of String(jsonlText || '').split('\n')){
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t);
      if (o && o.jid && o.outcome && Number.isFinite(Number(o.ts))) { o.ts = Number(o.ts); events.push(o); }
      else parse_errors++;
    } catch { parse_errors++; }
  }
  events.sort((a, b) => a.ts - b.ts);
  return { events, parse_errors };
}

/**
 * @param events    parseEvents(...).events  (ts in SECONDS, as written by frLogEvent)
 * @param dateStr   'YYYY-MM-DD' in MYT — the day being reported
 * @param nowMs     epoch ms; the day is reported only up to this instant ("day so far")
 * @param opts      { lookbackH = 96, tzOffsetMs = 8h, parse_errors = 0, read_error = null }
 */
function summarize(events, dateStr, nowMs, opts){
  const o = opts || {};
  const off = o.tzOffsetMs == null ? MYT_OFF_DEFAULT : o.tzOffsetMs;
  const lookbackH = o.lookbackH == null ? 96 : o.lookbackH;

  // 🚨 Rule 3. A read failure short-circuits BEFORE any counting, so there is no code path where
  // an unreadable log can produce a number.
  if (o.read_error) return { date: dateStr, read_error: String(o.read_error), parse_errors: o.parse_errors || 0 };

  const start = dayStartMs(dateStr, off);
  const end = Math.min(start + 24 * 3600 * 1000, nowMs);
  const lookbackStart = start - lookbackH * 3600 * 1000;

  const byJid = new Map();
  for (const e of events || []){
    const ms = e.ts * 1000;
    if (ms < lookbackStart || ms >= end) continue;
    const g = byJid.get(e.jid) || (byJid.set(e.jid, []), byJid.get(e.jid));
    g.push(e);
  }

  const buckets = {};
  for (const k of LEAD_BUCKETS.concat(NON_LEAD_BUCKETS)) buckets[k] = 0;
  buckets.other = 0;
  const unassigned = [];
  let total = 0, notLeads = 0, carriedResolved = 0, carried = 0, larkMissing = 0;

  for (const [jid, evs] of byJid){
    evs.sort((a, b) => a.ts - b.ts);
    const leadDay = mytDate(evs[0].ts * 1000, off);
    const latest = evs[evs.length - 1];

    if (leadDay !== dateStr){
      // Belongs to an EARLIER day's total. Do not count it again — just say it moved today.
      const today = evs.filter(e => mytDate(e.ts * 1000, off) === dateStr);
      if (today.length){
        carried++;
        if (today[today.length - 1].outcome === 'assigned') carriedResolved++;
      }
      continue;
    }

    if (NON_LEAD_BUCKETS.includes(latest.outcome)){ buckets[latest.outcome]++; notLeads++; continue; }

    total++;   // counted independently of the buckets — that is what makes sumOk meaningful
    if (LEAD_BUCKETS.includes(latest.outcome)) buckets[latest.outcome]++;
    else buckets.other++;
    // A lead we believe we assigned or parked but that carries NO Lark record id means the CRM
    // write FAILED. It is in nobody's pipeline and nothing downstream will ever find it.
    if ((latest.outcome === 'assigned' || latest.outcome === 'parked') && !latest.recordId) larkMissing++;
    if (latest.outcome !== 'assigned') unassigned.push({
      jid, phone: latest.phone || '', want: latest.want || '', cat: latest.cat || '',
      outcome: latest.outcome, ts: latest.ts });
  }

  const bucketSum = LEAD_BUCKETS.reduce((n, k) => n + buckets[k], 0);
  unassigned.sort((a, b) => a.ts - b.ts);

  return { date: dateStr, total, notLeads, buckets, sumOk: bucketSum === total, bucketSum,
    unassigned, carried, carriedResolved, larkMissing, parse_errors: o.parse_errors || 0,
    read_error: null };
}

// The WhatsApp card section. `cross` = { lark: { rows, capped, error }, inbox: {...} } — optional.
// Written dash-free even though this goes to the internal review group, not a customer.
function summaryText(s, cross, lang){
  const L = [];
  const c = cross || {};
  L.push(`📋 *Leads today (${s.date})*`);

  // 🚨 Rule 3, again, at the render layer: an unreadable log prints ONE line and nothing else.
  // No zeros, no empty buckets that could be mistaken for a quiet day.
  if (s.read_error){
    L.push(`⚠️ couldn't read the decision log, so there are no counts: ${s.read_error}`);
    L.push(`👉 The leads themselves are unaffected. This is a reporting failure, not a lead failure.`);
    return L.join('\n');
  }

  const assigned = s.buckets.assigned;
  L.push(`📥 ${s.total} lead${s.total === 1 ? '' : 's'}`
    + (s.notLeads ? ` (+${s.notLeads} skipped / human-owned chats, not sales leads)` : ''));
  L.push(`✅ ${assigned} assigned · ❓ ${s.total - assigned} not assigned`);

  // 🚨 Rule 1. If the numbers do not add up, SAY SO on the card rather than printing a tidy lie.
  if (!s.sumOk) L.push(`⚠️ buckets don't sum to the total (${s.bucketSum} vs ${s.total}), treat these numbers as suspect`);

  const why = LEAD_BUCKETS.concat(['other']).filter(k => k !== 'assigned' && s.buckets[k]);
  if (why.length){
    L.push('', `*Why the other ${s.total - assigned} are not assigned:*`);
    for (const k of why) L.push(`   • ${s.buckets[k]} ${WHY[k] || k}`);
  }
  if (s.unassigned.length){
    L.push('', `*Who they are:*`);
    for (const u of s.unassigned.slice(0, 10))
      L.push(`   • ${u.phone ? '+' + u.phone : 'no number'} · ${String(u.want || '(no message)').slice(0, 60)}`);
    if (s.unassigned.length > 10) L.push(`   …and ${s.unassigned.length - 10} more (see /lead-summary)`);
  }
  if (s.carriedResolved) L.push('', `🔁 ${s.carriedResolved} earlier lead(s) resolved today (counted in their own day's total, not this one)`);

  // 🚨 Rule 2. Two sources. When they disagree, BOTH numbers go on the card.
  if (c.lark){
    if (c.lark.error) L.push('', `⚠️ couldn't read Lark for the cross-check: ${c.lark.error}`);
    else {
      const expect = s.buckets.assigned + s.buckets.parked;
      if (c.lark.rows !== expect)
        L.push('', `⚠️ decision log says ${expect} assigned+parked · Lark shows ${c.lark.rows} row(s). Both printed because they disagree.`);
      if (c.lark.capped) L.push(`⚠️ read from the newest 100 Lark rows, older rows in this window may be uncounted`);
    }
  }
  if (s.larkMissing) L.push('', `🚨 ${s.larkMissing} lead(s) have NO Lark row (the CRM write failed). Nothing downstream will find them.`);
  if (s.parse_errors) L.push('', `⚠️ ${s.parse_errors} unreadable line(s) in the decision log were skipped`);
  return L.join('\n');
}

module.exports = { parseEvents, summarize, summaryText, LEAD_BUCKETS, NON_LEAD_BUCKETS, mytDate };
