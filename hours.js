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

module.exports = { hoursLabel, DAY_BM, DAY_EN };
