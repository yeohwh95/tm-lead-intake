'use strict';
// "Bot Decisions" tab — every message the bot handled and what it decided, so TM can SEE the
// mistakes instead of stumbling on one.
//
// Benjamin, 2026-09-18: the sheet is the input half; without this nobody knows whether accuracy is
// improving. Today's admin misfire was found because Harith happened to look at one chat.
//
// 🚨 APPEND-ONLY, and that is the whole design. The team ticks ❌ against a row; if the bot ever
// rewrote or re-sorted rows, a tick would silently end up against a different customer's message —
// worse than having no log, because it would be believed. So: new rows go after the last one, old
// rows are never touched, and trimming is a human decision, not the bot's.
//
// Pure: index.js does the fetching and appending.

// 🚨 The header must be CONTIGUOUS - no blank row above the data. Lark's values_append writes into
// the FIRST EMPTY ROW it finds, not after the last used one: with a blank row 4 sitting in the
// header, the first real decision was written INTO the header, above the column titles. Proven
// against the live sheet 18 Sep (landed row 4, wanted row 5). Rows 1-3 help, row 4 column titles.
const HEADER_ROWS = 4;
const MAX_APPEND = 40;                     // per run — a burst must not become a 500-row write

// what each outcome means in the customer's terms, for the "Sent to" column
const SENT_TO = {
  assigned:        r => `${r.assignee || 'a salesperson'}`,
  parked:          () => 'waiting for the next working morning',
  qualified:       () => 'answered our question, waiting for the window',
  gate_held:       () => 'still asking for their phone number',
  intent_held:     () => 'asked buy-or-sell, waiting',
  no_rep:          () => '🚨 NOBODY — the CRM row has no owner',
  awaiting_model:  () => 'waiting for them to say which bike',
  admin_handoff:   () => 'Admin',
  chasing:         () => 'the salesperson who already has them',
  hiring:          () => 'flagged to the group (no HR number yet)',
  workshop:        () => 'flagged to the group (no workshop number yet)',
  enriched:        () => 'added to their existing lead',
  repeat:          () => 'nobody — already handled recently',
  human_owned:     () => 'a human replied first',
  ai_skip:         () => 'nobody — not a customer message',
};

const fmtTime = ts => new Date((Number(ts) || 0) * 1000 + 8 * 3600 * 1000)
  .toISOString().replace('T', ' ').slice(5, 16);

// events = parsed fr_events.jsonl objects. sinceTs = last one already written.
// Returns the rows to append, oldest first, and the new watermark.
function rowsToAppend(events, sinceTs){
  const fresh = (events || [])
    .filter(e => e && Number(e.ts) > Number(sinceTs || 0) && e.outcome)
    // `repeat` and `ai_skip` are the bot deliberately staying quiet. Logging them would bury the
    // decisions a human should actually check under noise nobody reads.
    .filter(e => e.outcome !== 'repeat' && e.outcome !== 'ai_skip')
    .sort((a, b) => Number(a.ts) - Number(b.ts));

  const take = fresh.slice(0, MAX_APPEND);
  const rows = take.map(e => {
    const who = e.phone ? '+' + String(e.phone).replace(/\D/g, '') : String(e.jid || '').split('@')[0].slice(0, 16);
    const said = String(e.want || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    const sent = (SENT_TO[e.outcome] || (() => e.outcome))(e);
    return [fmtTime(e.ts), who, said, e.cat || e.outcome, sent, '', ''];
  });
  // Watermark advances over EVERYTHING examined, not just what was written — otherwise a run that
  // filtered out 50 `repeat` events would re-examine them forever.
  const examined = (events || []).filter(e => e && Number(e.ts) > Number(sinceTs || 0));
  const watermark = take.length && take.length < fresh.length
    ? Number(take[take.length - 1].ts)                       // capped: resume from the last written
    : examined.reduce((m, e) => Math.max(m, Number(e.ts) || 0), Number(sinceTs || 0));
  return { rows, watermark, pending: Math.max(0, fresh.length - take.length) };
}

// Rows the team has ticked ❌ — the whole point of the tab.
function readTicks(values){
  const out = [];
  (values || []).forEach((row, i) => {
    if (i < HEADER_ROWS) return;
    const tick = String((row && row[5]) == null ? '' : row[5]).trim();
    if (!tick) return;
    out.push({ row: i + 1, time: String(row[0] || ''), who: String(row[1] || ''), said: String(row[2] || ''),
               decided: String(row[3] || ''), shouldBe: String(row[6] || '').trim() });
  });
  return out;
}

module.exports = { HEADER_ROWS, MAX_APPEND, SENT_TO, fmtTime, rowsToAppend, readTicks };
