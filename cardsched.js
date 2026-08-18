// cardsched.js — scheduling + delivery helpers for the audience-split cards (2026-08-18).
//
// Pure functions only — index.js boots a server on require and cannot host tested logic (same
// reason as identity.js / roster.js / hours.js / catalog.js / leadsummary.js / orphan.js).
//
// Two failure modes this file exists to remove from cardsTick:
//
// 1. 🚨 "Yesterday" was LITERAL yesterday. TM operates Mon–Sat, so the Monday morning card
//    reported SUNDAY — a closed day, near-always "0 leads, nothing to do" — and Saturday, a full
//    working day, was never covered by any morning card at all. A weekly permanent hole.
//    `workingDayBefore` returns the most recent WORKING day strictly before now: Monday → Saturday,
//    every other day → literal yesterday (Sunday itself never asks; cardsTick skips Sundays).
//
// 2. 🚨 One transient HTTP failure lost a card FOREVER. `cardsSend`'s return value was ignored and
//    the sent-marker was claimed BEFORE the await with no rollback — so a single 5xx and the slot
//    was burned with nothing delivered, silently. `sendWithRetry` is the fix's testable half:
//    3 attempts with a short backoff, and the caller marks the slot ONLY on a confirmed send
//    (Benjamin's standing rule: 发现 → 自己 fix → 3 次不行 → 才通知群组).

const MYT_OFF = 8 * 3600 * 1000;
const DAY = 24 * 3600 * 1000;

// Most recent working day strictly before `nowMs`, as a YYYY-MM-DD string in the given offset.
// `workDays` = JS day numbers (default Mon–Sat, TM's real week). Walks back at most 7 days; if the
// day set is somehow empty/invalid it falls back to literal yesterday rather than looping — a wrong
// date is recoverable, a report that never fires is not.
function workingDayBefore(nowMs, off, workDays){
  const o = off == null ? MYT_OFF : off;
  // null/undefined → TM's real week. A PROVIDED-but-invalid set (empty, junk values) is not
  // silently replaced with a guess — it degrades to literal yesterday via the fallback below.
  const days = (workDays == null ? [1, 2, 3, 4, 5, 6] : workDays)
    .filter(n => Number.isInteger(n) && n >= 0 && n <= 6);
  for (let back = 1; back <= 7 && days.length; back++){
    const d = new Date(nowMs + o - back * DAY);
    if (days.includes(d.getUTCDay())) return d.toISOString().slice(0, 10);
  }
  return new Date(nowMs + o - DAY).toISOString().slice(0, 10);
}

// Try `sendFn` up to `tries` times with a short backoff between attempts. `sendFn` returns a
// truthy value on a CONFIRMED send (cardsSend already returns `!!r.ok`); a throw counts as a
// failure, never escapes. Returns { ok, attempts } so the caller can (a) only mark the slot on
// ok:true and (b) tell the QA group how many times it tried before giving up.
// `sleep` is injectable so tests do not actually wait.
async function sendWithRetry(sendFn, opts){
  const o = opts || {};
  const tries = o.tries || 3;
  const delays = o.delays || [5000, 15000];   // 2 gaps for 3 attempts; last delay reused if more
  const sleep = o.sleep || (ms => new Promise(r => setTimeout(r, ms)));
  for (let i = 1; i <= tries; i++){
    let ok = false;
    try { ok = !!(await sendFn(i)); } catch { ok = false; }
    if (ok) return { ok: true, attempts: i };
    if (i < tries) await sleep(delays[Math.min(i - 1, delays.length - 1)]);
  }
  return { ok: false, attempts: tries };
}

module.exports = { workingDayBefore, sendWithRetry, MYT_OFF };
