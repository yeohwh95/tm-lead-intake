// The client's questions, answered from a durable record.
//
// 🚨 THE MAIN POINT IS THE "NEEDS A LOOK" BLOCK, NOT THE COUNTS (client, 2026-08-15):
// "need more info for leads that is unsure or suspicious, so the admin can cross check, that is
// the main point." The totals are context. The block is the product.
//
// Pure functions only. index.js boots an HTTP server on require and therefore cannot host tested
// logic (same reason as catalog.js / hours.js / identity.js / roster.js / notify.js).
//
// 🚨 THE FOUR RULES THIS FILE ENFORCES:
//  1. Buckets are MUTUALLY EXCLUSIVE and MUST sum to the total, or the card says so out loud.
//     `total` is counted independently (one per lead chat) and compared against the sum of the
//     buckets the card knows how to print. A future outcome enum nobody taught this file about
//     lands in `other`, breaks the sum, and prints a ⚠️ instead of quietly under-reporting.
//  2. TWO INDEPENDENT SOURCES, and when they disagree BOTH numbers are printed. Never silently
//     prefer one.
//  3. A FAILED READ SAYS "couldn't read". Never 0.
//  4. A TRUNCATED LIST SAYS HOW MANY IT DROPPED. A capped list that reads as complete is the
//     failure mode the cap was supposed to prevent.
//
// WINDOWS ARE CONTIGUOUS AND GAP-PROOF (2026-08-15). Reports are NOT day-to-date any more, and
// the window is NOT derived from clock times. It starts at the END OF THE LAST REPORT THAT
// ACTUALLY SENT. Clock arithmetic would have opened a 24h hole every weekend: with Sunday
// skipped, "Sat 16:00 → Sun 16:00" belongs to no report at all. Anchoring on the last successful
// send means a skipped Sunday, a bot that was down at 10:00, and a mid-window restart all
// self-heal into the next card instead of losing leads.

const MYT_OFF_DEFAULT = 8 * 3600 * 1000;
const HOUR = 3600 * 1000;

// Outcomes that describe a real sales lead. Order is the order they print.
const LEAD_BUCKETS = ['assigned', 'parked', 'gate_held', 'no_rep', 'awaiting_model'];
// Chats that are NOT sales leads. Reported on their own line so (a)(b)(c) reads on real leads —
// never folded into the total, never hidden either.
const NON_LEAD_BUCKETS = ['ai_skip', 'human_owned', 'repeat'];

// Plain English for the "why wasn't it assigned" list. A reason a salesperson can act on.
const WHY = {
  parked:         'parked for the next assignment window',
  gate_held:      'no phone number yet, still asking',
  no_rep:         '🚨 NOBODY took it (the CRM row has no owner)',
  awaiting_model: 'greeted, waiting for them to say which bike',
  other:          'unrecognised outcome (see ⚠️ above)',
};

// The two report slots and how long each is SUPPOSED to cover, so a longer window can explain
// itself. 10:00 covers the previous 16:00 onwards (18h); 16:00 covers 10:00 onwards (6h).
const SLOTS = { 10: { prevHr: 16, expectedH: 18, label: 'Morning report' },
                16: { prevHr: 10, expectedH: 6,  label: 'Afternoon report' } };

const DAY_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const mytDate = (ms, off) => new Date(ms + (off == null ? MYT_OFF_DEFAULT : off)).toISOString().slice(0, 10);
const dayStartMs = (dateStr, off) => Date.parse(dateStr + 'T00:00:00Z') - (off == null ? MYT_OFF_DEFAULT : off);

function fmtMyt(ms, off){
  const d = new Date(ms + (off == null ? MYT_OFF_DEFAULT : off));
  return `${DAY_EN[d.getUTCDay()]} ${d.getUTCDate()} ${MON_EN[d.getUTCMonth()]} `
    + `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------------------------
// WINDOW
// ---------------------------------------------------------------------------------------------
// The most recent drain that has actually COMPLETED. A lead written to Lark before this and still
// unassigned should have been released by it, so it is genuinely stuck.
//
// 🚨 "COMPLETED", not "opened" (fixed 2026-08-16). Taking the opening instant as the boundary
// flagged EVERY weekend lead as "parked too long" while the drain was still mid-flight — 39
// perfectly healthy leads presented to an admin as failures.
//
// ⚠️ HOW LONG THE DRAIN ACTUALLY TAKES — measured from the code, not assumed (corrected
// 2026-08-16). `drainFRDeferred` is NOT one lead per 60s tick: it holds a
// `while (frDeferred.length && inFRDistHours())` loop that empties the WHOLE queue in a single
// invocation, and the 60s interval merely re-triggers it. The real pacing is the serialized send
// chain, `SEND_GAP = 5200`ms. So a 46-lead weekend backlog drains in about 4 minutes, finishing
// ~09:04 — not ~09:46.
//
// 15 minutes is therefore ~3.5× the real drain time: long enough that a normal drain is never
// flagged mid-flight, short enough that a drain which FAILED at 09:00 is unambiguously stuck by
// 09:15, well clear of the 10:00 report. 🚨 A 60-minute grace would have raced the report itself:
// "completed" would land at exactly 10:00, so a totally dead drain could render "0 new stuck"
// while 46 leads sat there. The grace must never approach the gap between the drain and the card.
const DRAIN_GRACE_MS = Number(process.env.DRAIN_GRACE_MIN || 15) * 60 * 1000;
function lastCompletedDrain(nowMs, days, startH, off, graceMs){
  off = off == null ? MYT_OFF_DEFAULT : off;
  const grace = graceMs == null ? DRAIN_GRACE_MS : graceMs;
  const list = (days || []).filter(n => Number.isInteger(n) && n >= 0 && n <= 6);
  if (!list.length) return null;
  const cutoff = nowMs - grace;
  for (let back = 0; back < 14; back++){
    const probe = new Date(nowMs + off - back * 24 * HOUR);
    if (!list.includes(probe.getUTCDay())) continue;
    const start = Date.UTC(probe.getUTCFullYear(), probe.getUTCMonth(), probe.getUTCDate(), startH) - off;
    if (start <= cutoff) return start;
  }
  return null;
}

// The boundary a slot would normally start at, used ONLY when there is no marker on disk.
function previousBoundary(nowMs, hr, off){
  off = off == null ? MYT_OFF_DEFAULT : off;
  const prevHr = (SLOTS[hr] || {}).prevHr;
  if (prevHr == null) return nowMs - 24 * HOUR;
  for (let back = 0; back < 8; back++){
    const probe = new Date(nowMs + off - back * 24 * HOUR);
    const b = Date.UTC(probe.getUTCFullYear(), probe.getUTCMonth(), probe.getUTCDate(), prevHr) - off;
    if (b < nowMs) return b;
  }
  return nowMs - 24 * HOUR;
}

/**
 * @param nowMs    when this report is being built
 * @param hr       10 or 16 (the slot)
 * @param markEnd  end timestamp of the last report that ACTUALLY SENT, or null/0 if none
 * Returns { startMs, endMs, hours, expectedH, fallback, note }
 */
function reportWindow(nowMs, hr, markEnd, off){
  off = off == null ? MYT_OFF_DEFAULT : off;
  const slot = SLOTS[hr] || { expectedH: 24, label: 'Report' };
  const fallback = !markEnd || markEnd >= nowMs;   // a marker from the future is corrupt; ignore it
  const startMs = fallback ? previousBoundary(nowMs, hr, off) : markEnd;
  const hours = Math.max(0, Math.round((nowMs - startMs) / HOUR));
  const reasons = [];
  if (fallback) reasons.push('no previous report on record, so this window starts at the usual boundary');
  // Longer than it should be? Say WHY, rather than leaving a 42h window looking like a bug.
  if (hours > slot.expectedH + 1){
    let sawSunday = false;
    for (let t = startMs; t < nowMs; t += 6 * HOUR)
      if (new Date(t + off).getUTCDay() === 0) sawSunday = true;
    reasons.push(sawSunday ? 'covers the weekend' : 'the previous report did not send, so this one absorbs that span');
  }
  return { startMs, endMs: nowMs, hours, expectedH: slot.expectedH, label: slot.label, fallback,
    note: reasons.join('; ') };
}

const windowHeader = (w, off) =>
  `🪟 Window: ${fmtMyt(w.startMs, off)} → ${fmtMyt(w.endMs, off)} (${w.hours}h${w.note ? ', ' + w.note : ''})`;

// ---------------------------------------------------------------------------------------------
// PARSING
// ---------------------------------------------------------------------------------------------
// One bad line must not cost the whole report — but it must be COUNTED, so a silently corrupt
// log can't pass as a quiet day.
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

// ---------------------------------------------------------------------------------------------
// SUMMARISE
// ---------------------------------------------------------------------------------------------
// A lead belongs to the window its FIRST event falls in, and is counted by its LATEST event on or
// before the window end. That is what stops a Friday lead being counted again on Monday, and it
// is what makes the buckets mutually exclusive by construction.
function summarizeWindow(events, startMs, endMs, opts){
  const o = opts || {};
  const off = o.tzOffsetMs == null ? MYT_OFF_DEFAULT : o.tzOffsetMs;
  const lookbackH = o.lookbackH == null ? 96 : o.lookbackH;

  // 🚨 Rule 3. A read failure short-circuits BEFORE any counting, so there is no code path where
  // an unreadable log can produce a number.
  if (o.read_error) return { windowStart: startMs, windowEnd: endMs, date: o.date || mytDate(endMs, off),
    read_error: String(o.read_error), parse_errors: o.parse_errors || 0 };

  // 🚨 Rule 3, the case it MISSED. A date before the log begins is not a quiet day, it is a day we
  // cannot see — and the two must never render the same. Rule 3 guarded an unreadable file and an
  // unmounted disk; it did not guard the dominant real case, a perfectly healthy file that simply
  // does not reach back that far. Measured 2026-08-17: `/lead-summary?date=` answered
  // `total:0, sumOk:true` for every date 03–16 Aug, including Sat 15 Aug — a day this repo's own
  // notes record as 29 inbound chats and 25 Lark rows. A confident zero about a day we have no
  // record of is precisely the lie this module exists to prevent.
  // `logFirstMs` is derived from the events themselves, so it moves correctly if the file is ever
  // pruned. Reduce, not Math.min(...spread) — the log is unbounded and a spread would blow the stack.
  const logFirstMs = o.logFirstMs != null ? o.logFirstMs
    : (events && events.length
        ? events.reduce((m, e) => (m == null || e.ts < m ? e.ts : m), null) * 1000
        : null);
  if (logFirstMs == null || endMs <= logFirstMs)
    return { windowStart: startMs, windowEnd: endMs, date: o.date || mytDate(endMs, off),
      no_data: true, logStartsAt: logFirstMs, parse_errors: o.parse_errors || 0, read_error: null };
  // The window OPENS before the log does: countable, but the early part is invisible and the card
  // has to say from when the numbers actually start.
  const partialFrom = logFirstMs > startMs ? logFirstMs : null;

  const lookbackStart = startMs - lookbackH * HOUR;
  const byJid = new Map();
  for (const e of events || []){
    const ms = e.ts * 1000;
    if (ms < lookbackStart || ms >= endMs) continue;
    const g = byJid.get(e.jid) || (byJid.set(e.jid, []), byJid.get(e.jid));
    g.push(e);
  }

  const buckets = {};
  for (const k of LEAD_BUCKETS.concat(NON_LEAD_BUCKETS)) buckets[k] = 0;
  buckets.other = 0;
  const unassigned = [];
  // "Needs a look" is scoped to EVENTS IN THIS WINDOW, not to lead-day attribution: an admin needs
  // to see a Friday lead that failed on Monday on MONDAY'S card, when they can still act on it.
  // Windows are contiguous and non-overlapping, so an event still surfaces exactly once.
  const attention = { no_rep: [], unclassified: [], gate_dead: [], repeat: [] };
  let total = 0, notLeads = 0, carriedResolved = 0, carried = 0, larkMissing = 0;

  for (const [jid, evs] of byJid){
    evs.sort((a, b) => a.ts - b.ts);
    const firstTs = evs[0].ts * 1000;
    const inWindow = evs.filter(e => e.ts * 1000 >= startMs);
    const latest = evs[evs.length - 1];

    // ---- attention: judged on the latest event INSIDE the window ----
    if (inWindow.length){
      const lw = inWindow[inWindow.length - 1];
      const ent = () => ({ ts: lw.ts, jid, phone: lw.phone || '', want: lw.want || '',
        cat: lw.cat || '', asks: lw.asks || 0, note: lw.note || '' });
      if (lw.outcome === 'no_rep') attention.no_rep.push(ent());
      else if (lw.outcome === 'ai_skip' && lw.note === 'unclassified') attention.unclassified.push(ent());
      else if (lw.outcome === 'repeat') attention.repeat.push(ent());
      // Released at the gate timeout with no number and no handle: we asked, we got nothing
      // usable, and a rep now holds a lead they cannot ring.
      else if (lw.note === 'gate_timeout' && !lw.has_phone && !/^@[\w.]+ \(username/.test(String(lw.want || '')))
        attention.gate_dead.push(ent());
    }

    if (firstTs < startMs){
      // Belongs to an EARLIER window's total. Do not count it again, just say it moved.
      if (inWindow.length){
        carried++;
        if (inWindow[inWindow.length - 1].outcome === 'assigned') carriedResolved++;
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
  for (const k of Object.keys(attention)) attention[k].sort((a, b) => a.ts - b.ts);

  return { date: o.date || mytDate(endMs, off), windowStart: startMs, windowEnd: endMs,
    total, notLeads, buckets, sumOk: bucketSum === total, bucketSum, unassigned, attention,
    carried, carriedResolved, larkMissing, parse_errors: o.parse_errors || 0, read_error: null,
    logStartsAt: logFirstMs, partialFrom };
}

// Day-scoped wrapper. Kept because the endpoint still answers `?date=YYYY-MM-DD` for ad-hoc
// lookups and replays, and because the 14-lost-leads fixture is expressed in days.
function summarize(events, dateStr, nowMs, opts){
  const o = opts || {};
  const off = o.tzOffsetMs == null ? MYT_OFF_DEFAULT : o.tzOffsetMs;
  const start = dayStartMs(dateStr, off);
  return summarizeWindow(events, start, Math.min(start + 24 * HOUR, nowMs),
    Object.assign({}, o, { date: dateStr }));
}

// ---------------------------------------------------------------------------------------------
// NEEDS A LOOK  🚨 the point of the whole report
// ---------------------------------------------------------------------------------------------
// Most severe first, and stalest first inside each category (client's ordering, 2026-08-15).
const CATS = [
  { key: 'no_rep',       icon: '🚨', title: 'Nobody took it' },
  { key: 'parked_long',  icon: '⏰', title: 'Parked too long' },
  { key: 'inbox_gap',    icon: '⚠️', title: 'In the inbox but not in our log' },
  { key: 'gate_dead',    icon: '📵', title: 'Cannot be contacted' },
  { key: 'undelivered',  icon: '📤', title: 'Message not delivered' },
  { key: 'unclassified', icon: '❓', title: 'AI could not classify' },
  { key: 'repeat',       icon: '🔁', title: 'Came back, got silence' },
];
const BLOCK_CAP = 25;
// 🚨 WhatsApp rejects a message over 4096 chars outright (422), and `alertReview` does NOT route
// through `waSend`, so it has no truncation of its own — an over-long card does not get trimmed,
// it simply never arrives. Found 2026-08-16 by rendering the real 54-lead backlog: 6,322 chars.
// The entry budget is therefore in CHARACTERS as well as entries, and whatever is dropped is
// still counted and reported (rule 4).
const BLOCK_CHAR_BUDGET = 2600;

// 🚨 Never emit a wa.me link for a customer whose number we do not have. A link built from an
// @lid is a dead link that LOOKS actionable, which is the 2026-08-02 failure wearing a new hat.
function contactLine(e){
  const d = String(e.phone || '').replace(/\D/g, '');
  if (d) return `     👉 https://wa.me/${d}`;
  const h = String(e.want || '').match(/^@([\w.]+) \(username/);
  if (h) return `     👉 @${h[1]} (username, not dialable). Reply in the *TM Marketing (93210)* inbox`;
  return `     👉 no number. Reply to them in the *TM Marketing (93210)* inbox`;
}
const who = e => {
  const d = String(e.phone || '').replace(/\D/g, '');
  if (d) return '+' + d;
  const h = String(e.want || '').match(/^@([\w.]+) \(username/);
  return h ? '@' + h[1] : 'no number';
};
const said = e => {
  const raw = String(e.want || '').replace(/^@[\w.]+ \(username, not dialable\) · /, '').replace(/\s+/g, ' ').trim();
  if (!raw) return '(no message)';
  return raw.length > 70 ? raw.slice(0, 70) + '…' : raw;
};

// `extras` carries what only index.js can fetch:
//   larkParked  { rows:[{ts,phone,want,recordId}], capped, error }  — the 14-lead signature
//   undelivered [{ts, to, error, attempts}]                          — from alertSendFailure
//   inboxCheck  { available:false, note }                            — box-66, not readable here
function needsALook(s, extras, off){
  const x = extras || {};
  const a = s.attention || { no_rep: [], unclassified: [], gate_dead: [], repeat: [] };
  const nowMs = s.windowEnd || Date.now();
  const groups = [];
  const push = (key, entries, unavailable) => {
    const meta = CATS.find(c => c.key === key);
    groups.push({ key, icon: meta.icon, title: meta.title, entries: entries || [], unavailable: unavailable || null });
  };

  push('no_rep', a.no_rep.map(e => ({ ...e,
    did: 'the CRM row has no owner, so nothing will ever chase it' })));

  const lp = x.larkParked || {};
  if (lp.error) push('parked_long', [], `couldn't read Lark: ${lp.error}`);
  else push('parked_long', (lp.rows || []).map(r => ({ ...r,
    did: `written to Lark but still unassigned ${Math.max(1, Math.round((nowMs - r.ts * 1000) / (24 * HOUR)))} day(s) after the drain should have released it` })));

  const ic = x.inboxCheck || {};
  // 🚨 Say so plainly rather than approximate (client, 2026-08-15). The Render bot genuinely
  // cannot read box 66's capture file, so this category is checked by audit_fr.py at 09:57 and
  // is NOT reproduced here. Pretending otherwise would be inventing a number.
  push('inbox_gap', ic.rows || [], ic.available ? null
    : (ic.note || 'checked on box 66 by the 09:57 audit, not from here (this bot cannot read the inbox capture)'));

  push('gate_dead', a.gate_dead.map(e => ({ ...e,
    did: `asked ${e.asks || 'the maximum'}× for a number or username, never got one, released with no way to contact them` })));

  push('undelivered', (x.undelivered || []).map(u => ({ ts: u.ts, phone: u.to, want: u.text || '',
    did: `WhatsApp send gave up after ${u.attempts || '?'} attempt(s): ${String(u.error || '').slice(0, 60)}` })));

  push('unclassified', a.unclassified.map(e => ({ ...e,
    did: 'the classifier could not tell what they wanted, so the bot sent nothing' })));

  push('repeat', a.repeat.map(e => ({ ...e,
    did: 'already greeted within 7 days, so the bot stayed silent by design' })));

  // 🚨 NEW vs ALREADY-KNOWN (2026-08-16). The stuck backlog reappears on every card forever, and a
  // list that never changes stops being read — by Wednesday the admin scrolls past the whole block
  // and a genuinely new stuck lead hides inside it. Same failure as an alert nobody acts on.
  // So: DETAIL only what is new since the last report, and collapse the rest to one line.
  // The split is the report window itself, which is already anchored on the last successful send.
  const since = s.windowStart || 0;
  for (const g of groups){
    g.entries.sort((p, q) => p.ts - q.ts);                       // stalest first
    g.fresh = g.entries.filter(e => e.ts * 1000 >= since);
    g.known = g.entries.filter(e => e.ts * 1000 < since);
  }
  const found = groups.reduce((n, g) => n + g.entries.length, 0);
  const backlog = groups.reduce((n, g) => n + g.known.length, 0);
  return { groups, found, backlog };
}

// `charBudget` lets the caller size this block against the header it has ALREADY built. The header
// used to be near-constant, so a fixed BLOCK_CHAR_BUDGET was safe; it no longer is (the blind-window
// warnings vary its length), and a fixed budget plus a grown header is how the 4,096 limit gets
// breached again — silently, because alertReview does not truncate.
function needsALookText(s, extras, off, charBudget){
  const x = extras || {};
  const CB = charBudget == null ? BLOCK_CHAR_BUDGET : Math.max(600, charBudget);
  const b = needsALook(s, extras, off);
  const fresh = b.groups.reduce((n, g) => n + g.fresh.length, 0);
  // The headline counts what is NEW. The standing backlog gets its own line below, because a
  // number that never moves is not news and must not dilute one that does.
  const L = ['', '━━━━━━━━━━━━━━━━━━━━', `👀 *NEEDS A LOOK (${fresh} new)*`];
  if (!b.found && !b.groups.some(g => g.unavailable)){
    L.push('✅ Nothing suspicious in this window.');
    return { text: L.join('\n'), found: 0, shown: 0, dropped: 0, backlog: 0 };
  }
  let budget = BLOCK_CAP, chars = 0, shown = 0, dropped = 0;
  for (const g of b.groups){
    if (!g.entries.length && !g.unavailable) continue;
    if (!g.fresh.length && !g.unavailable) continue;   // known-only: it rolls into the backlog line
    L.push('', `${g.icon} *${g.title} (${g.fresh.length} new`
      + (g.known.length ? `, ${g.known.length} already known` : '') + ')*');
    if (g.unavailable){ L.push(`   ℹ️ ${g.unavailable}`); if (!g.fresh.length) continue; }
    for (const e of g.fresh){
      const block = [`   • ${fmtMyt(e.ts * 1000, off)} · ${who(e)} · "${said(e)}"`,
        `     ↳ ${e.did}`, contactLine(e)];
      const cost = block.join('\n').length + 1;
      // Severity order means the entries that survive the budget are the ones that matter most.
      if (budget <= 0 || chars + cost > CB){ dropped++; continue; }
      budget--; chars += cost; shown++;
      L.push(...block);
    }
  }
  // 🚨 ONE line for everything already reported, and the DIRECTION of travel, because a rising
  // backlog is the only part of it that is news. `prevBacklog` comes from the window marker.
  if (b.backlog){
    const oldest = Math.max(...b.groups.flatMap(g => g.known.map(e =>
      Math.round((( s.windowEnd || Date.now()) - e.ts * 1000) / (24 * HOUR)))));
    const prev = x.prevBacklog;
    const trend = prev == null ? 'first time this has been counted'
      : b.backlog > prev ? `UP from ${prev} at the last report`
      : b.backlog < prev ? `down from ${prev} at the last report`
      : 'unchanged';
    L.push('', `${b.backlog > (prev == null ? -1 : prev) ? '🔺' : '🔴'} Old backlog: ${b.backlog} lead(s) still stuck `
      + `(oldest ${oldest} days, ${trend}) → /lead-summary`);
  }
  // 🚨 Rule 4. A capped list that reads as complete is the failure the cap was meant to prevent.
  if (dropped) L.push('', `⚠️ ${dropped} more not shown (this card has to fit in one WhatsApp message). Full list: /lead-summary`);
  return { text: L.join('\n'), found: b.found, shown, dropped, backlog: b.backlog };
}

// ---------------------------------------------------------------------------------------------
// RENDER
// ---------------------------------------------------------------------------------------------
// The WhatsApp card. Written dash-free: it is bot-authored output, even though it goes to the
// internal review group rather than a customer.
function summaryText(s, cross, extras){
  const L = [];
  const c = cross || {};
  const x = extras || {};
  const off = x.tzOffsetMs;
  const w = x.window;
  L.push(`📋 *${(w && w.label) || 'Leads'}* (${s.date})`);
  if (w) L.push(windowHeader(w, off));

  // 🚨 Rule 3, again, at the render layer: an unreadable log prints ONE line and nothing else.
  if (s.read_error){
    L.push(`⚠️ couldn't read the decision log, so there are no counts: ${s.read_error}`);
    L.push(`👉 The leads themselves are unaffected. This is a reporting failure, not a lead failure.`);
    return L.join('\n');
  }

  // 🚨 The same one-line treatment for a date the log does not reach. Deliberately worded so it can
  // never be skim read as a quiet day, because that is exactly how it used to read.
  if (s.no_data){
    L.push(`ℹ️ We have no lead records for this date, so there are no counts to show.`);
    L.push(s.logStartsAt
      ? `👉 Lead logging only began ${fmtMyt(s.logStartsAt, off)}. Anything before that was never recorded. This is NOT a quiet day.`
      : `👉 The lead log is empty, so nothing has been recorded yet. This is NOT a quiet day.`);
    return L.join('\n');
  }

  const assigned = s.buckets.assigned;
  L.push(`📥 ${s.total} lead${s.total === 1 ? '' : 's'}`
    + (s.notLeads ? ` (+${s.notLeads} skipped / human-owned chats, not sales leads)` : ''));
  L.push(`✅ ${assigned} assigned · ❓ ${s.total - assigned} not assigned`);

  // The window opened before the log did, so the count is real but incomplete, and saying so is the
  // difference between an undercount and a lie.
  if (s.partialFrom)
    L.push(`⚠️ These counts only cover ${fmtMyt(s.partialFrom, off)} onward, because lead logging began then. Anything earlier in this window was never recorded.`);

  // 🚨 Rule 1. If the numbers do not add up, SAY SO rather than printing a tidy lie.
  if (!s.sumOk) L.push(`⚠️ buckets don't sum to the total (${s.bucketSum} vs ${s.total}), treat these numbers as suspect`);

  const why = LEAD_BUCKETS.concat(['other']).filter(k => k !== 'assigned' && s.buckets[k]);
  if (why.length){
    L.push('', `*Why the other ${s.total - assigned} are not assigned:*`);
    for (const k of why) L.push(`   • ${s.buckets[k]} ${WHY[k] || k}`);
  }
  // Who the unassigned actually ARE. Distinct from "needs a look": a lead parked at 18:00 on a
  // weekday is normal and will drain at 09:00, so it belongs here, not in the suspicious block.
  if (s.unassigned.length){
    L.push('', `*Who they are:*`);
    // Collapse newlines: a customer's message often spans several lines, and pasting it raw
    // turns one list entry into three and makes the card unreadable.
    for (const u of s.unassigned.slice(0, 10))
      L.push(`   • ${u.phone ? '+' + u.phone : 'no number'} · ${String(u.want || '(no message)').replace(/\s+/g, ' ').trim().slice(0, 60)}`);
    if (s.unassigned.length > 10) L.push(`   …and ${s.unassigned.length - 10} more (see /lead-summary)`);
  }
  if (s.carriedResolved) L.push('', `🔁 ${s.carriedResolved} earlier lead(s) resolved in this window (counted in their own window, not this one)`);

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

  // 🚨 Size the block against the header we actually built, not against a constant. 3,900 leaves
  // headroom under WhatsApp's hard 4,096, and the block keeps its own severity ordering, so what
  // survives a tighter budget is still the worst of it.
  const headLen = L.join('\n').length;
  let blockBudget = Math.min(BLOCK_CHAR_BUDGET, 3900 - headLen);
  let block = needsALookText(s, x, off, blockBudget);
  // 🚨 The budget governs ENTRY text only: category headers, the backlog line and the "not shown"
  // line all ride on top of it, so a budget alone has never actually bounded the card. Rather than
  // hand-tune an allowance that rots the next time a line is added, MEASURE the assembled card and
  // tighten until it fits. Severity ordering means what gets dropped is always the least severe.
  for (let i = 0; i < 6 && headLen + block.text.length > 3900; i++){
    blockBudget = Math.max(600, blockBudget - (headLen + block.text.length - 3900) - 120);
    block = needsALookText(s, x, off, blockBudget);
  }
  L.push(block.text);
  return L.join('\n');
}
// Same render, but also hands back the backlog count so the caller can persist it on the window
// marker and the NEXT card can say whether the backlog grew.
function summaryCard(s, cross, extras){
  const text = summaryText(s, cross, extras);
  const b = (s.read_error || s.no_data) ? { backlog: 0 }
    : needsALookText(s, extras || {}, (extras || {}).tzOffsetMs);
  return { text, backlog: b.backlog || 0 };
}

module.exports = { parseEvents, summarize, summarizeWindow, summaryText, summaryCard, needsALook, needsALookText,
  reportWindow, previousBoundary, lastCompletedDrain, DRAIN_GRACE_MS, windowHeader, fmtMyt,
  LEAD_BUCKETS, NON_LEAD_BUCKETS, SLOTS, BLOCK_CAP, mytDate };
