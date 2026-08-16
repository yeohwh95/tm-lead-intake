// The customer-facing "our office hours are …" sentence, GENERATED from the same config that gates
// lead distribution (FR_DIST_DAYS / FR_DIST_START / FR_DIST_END in index.js).
//
// WHY THIS IS GENERATED AND NOT WRITTEN OUT (incident 2026-07-30):
// The sentence used to be hardcoded in firstresponse.js as "Isnin–Jumaat, 9 pagi–5 petang" while the
// window was config. TM actually operates Mon–Sat 9am–6pm, so the bot spent days quoting the wrong
// hours to real customers — Harith caught it with a screenshot (+60122607096, 6:44pm, told the office
// shuts at 5pm Fri). Two sources of truth for one fact will always drift. Now there is one: change
// the window and the sentence follows.
//
// Pure + exported so it can be unit-tested — index.js boots a server on require.

const DAY_BM = ['Ahad', 'Isnin', 'Selasa', 'Rabu', 'Khamis', 'Jumaat', 'Sabtu'];
const DAY_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
// Full names for a customer-facing SENTENCE. The short forms above are for the hours RANGE
// ("Mon–Sat"), where brevity reads well; "Mon morning" in a sentence does not.
const DAY_EN_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MYT_OFF = 8 * 3600 * 1000;

const h12   = (h) => (h % 12 === 0 ? 12 : h % 12);
const ampm  = (h) => (h < 12 ? 'am' : 'pm');
// Malay splits the afternoon: pagi (morning) / tengah hari (midday) / petang (late afternoon).
const bmPart = (h) => (h < 12 ? 'pagi' : h < 15 ? 'tengah hari' : 'petang');

// days = array of JS day numbers (0=Sun … 6=Sat), startH/endH = 24h MYT. endH is EXCLUSIVE in the
// gate (`hour < endH`), which reads correctly as the closing time: 18 → "6pm".
function hoursLabel(days, startH, endH){
  const ds = [...new Set(days || [])].filter(n => Number.isInteger(n) && n >= 0 && n <= 6).sort((a, b) => a - b);
  const contiguous = ds.length > 1 && ds.every((n, i) => i === 0 || n === ds[i - 1] + 1);
  const span = (names) => !ds.length ? '—'
    : ds.length === 1 ? names[ds[0]]
    : contiguous ? `${names[ds[0]]}–${names[ds[ds.length - 1]]}`
    : ds.map(n => names[n]).join(', ');
  return {
    en: `${span(DAY_EN)}, ${h12(startH)}${ampm(startH)}–${h12(endH)}${ampm(endH)}`,
    bm: `${span(DAY_BM)}, ${h12(startH)} ${bmPart(startH)}–${h12(endH)} ${bmPart(endH)}`,
  };
}

// English counterpart of bmPart, for "later this morning" / "tomorrow afternoon".
const enPart = (h) => (h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening');

// After this hour, NAME THE DAY instead of saying "tomorrow". At 23:00 on a Sunday "esok pagi" is
// technically correct and practically confusing — the customer is reading it minutes from midnight,
// and a lead they expect "tomorrow" is a lead they think was missed. Naming Monday is unambiguous
// at any hour. Below the threshold, "esok pagi" is warmer and reads more naturally.
const LATE_H = 21;

// WHEN will a salesperson actually pick this lead up?
//
// 🚨 Derived from the DISTRIBUTION window (FR_DIST_DAYS / FR_DIST_START) — NOT the operating hours.
// Those are two different facts and merging them is the 2026-07-30 incident. The shop being open
// (Mon–Sat 9–6) says nothing about when the bot hands a lead to a rep (Mon–Fri 9–5).
//
// Works for ANY day set, which is what keeps the still-unresolved Saturday-assignment question
// (FR_DIST_DAYS=1,2,3,4,5 vs 1,2,3,4,5,6) a pure env change: Friday evening renders "Isnin pagi"
// under the first and "esok pagi" under the second, with no code edit.
//
// Returns { bm, en }, or NULL when the window is open right now (the caller then promises no day
// at all, because a rep is about to get it anyway) or when the day set is empty/invalid.
function nextWindowLabel(nowMs, days, startH, endH, off){
  const o = off == null ? MYT_OFF : off;
  const list = [...new Set(days || [])].filter(n => Number.isInteger(n) && n >= 0 && n <= 6);
  if (!list.length) return null;                       // no configured window → promise nothing
  if (!Number.isInteger(startH) || startH < 0 || startH > 23) return null;
  const nowLocal = new Date(nowMs + o);
  const hNow = nowLocal.getUTCHours();
  // Open right now → say nothing about a day.
  if (list.includes(nowLocal.getUTCDay()) && hNow >= startH && hNow < endH) return null;
  for (let ahead = 0; ahead <= 8; ahead++){
    const probe = new Date(nowMs + o + ahead * 24 * 3600 * 1000);
    const dow = probe.getUTCDay();
    if (!list.includes(dow)) continue;
    if (ahead === 0 && hNow >= startH) continue;        // today's window has already closed
    if (ahead === 0) return { bm: `${bmPart(startH)} ini sebentar lagi`, en: `later this ${enPart(startH)}` };
    if (ahead === 1 && hNow < LATE_H) return { bm: `esok ${bmPart(startH)}`, en: `tomorrow ${enPart(startH)}` };
    return { bm: `${DAY_BM[dow]} ${bmPart(startH)}`, en: `${DAY_EN_FULL[dow]} ${enPart(startH)}` };
  }
  return null;
}

module.exports = { hoursLabel, nextWindowLabel, DAY_BM, DAY_EN, DAY_EN_FULL };
