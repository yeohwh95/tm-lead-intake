// Tests for hours.js — the customer-facing office-hours sentence. Run: node hours_test.js
const { hoursLabel } = require('./hours');

let pass = 0, fail = 0;
function eq(name, got, want){
  const good = got === want;
  console.log((good ? '✅ ' : '❌ ') + name + (good ? ` → "${got}"` : `\n     got  "${got}"\n     want "${want}"`));
  good ? pass++ : fail++;
}
const MON_SAT = [1,2,3,4,5,6];

console.log('\n--- the live window: TM operates Mon–Sat 9am–6pm (Harith 2026-07-30) ---');
eq('EN', hoursLabel(MON_SAT, 9, 18).en, 'Mon–Sat, 9am–6pm');
eq('BM', hoursLabel(MON_SAT, 9, 18).bm, 'Isnin–Sabtu, 9 pagi–6 petang');

console.log('\n--- the OLD wrong wording is reproducible from the OLD config (proves it was config drift, not a typo) ---');
eq('EN Mon–Fri 9–5', hoursLabel([1,2,3,4,5], 9, 17).en, 'Mon–Fri, 9am–5pm');
eq('BM Mon–Fri 9–5', hoursLabel([1,2,3,4,5], 9, 17).bm, 'Isnin–Jumaat, 9 pagi–5 petang');

console.log('\n--- day spans ---');
eq('all week',        hoursLabel([0,1,2,3,4,5,6], 9, 18).en, 'Sun–Sat, 9am–6pm');
eq('single day EN',   hoursLabel([6], 10, 14).en, 'Sat, 10am–2pm');
eq('single day BM',   hoursLabel([6], 10, 14).bm, 'Sabtu, 10 pagi–2 tengah hari');
eq('non-contiguous',  hoursLabel([1,3,5], 9, 18).en, 'Mon, Wed, Fri, 9am–6pm');
eq('unsorted input',  hoursLabel([6,1,3,2,5,4], 9, 18).en, 'Mon–Sat, 9am–6pm');
eq('duplicate days',  hoursLabel([1,1,2,3,4,5,6], 9, 18).en, 'Mon–Sat, 9am–6pm');
eq('junk days dropped', hoursLabel([1,2,3,4,5,6,99,-1,NaN], 9, 18).en, 'Mon–Sat, 9am–6pm');
eq('no days at all',  hoursLabel([], 9, 18).en, '—, 9am–6pm');

console.log('\n--- clock edges ---');
eq('noon close EN',   hoursLabel(MON_SAT, 9, 12).en, 'Mon–Sat, 9am–12pm');
eq('midnight close',  hoursLabel(MON_SAT, 9, 24).en, 'Mon–Sat, 9am–12pm');
eq('BM 3pm = petang', hoursLabel(MON_SAT, 9, 15).bm, 'Isnin–Sabtu, 9 pagi–3 petang');
eq('BM 2pm = tengah hari', hoursLabel(MON_SAT, 9, 14).bm, 'Isnin–Sabtu, 9 pagi–2 tengah hari');

// ---- nextWindowLabel: WHEN will a salesperson actually pick this lead up? ----
// Derived from the DISTRIBUTION window, never the operating hours (those are two different facts;
// merging them is the 2026-07-30 incident).
const { nextWindowLabel } = require('./hours');
const MYT = 8 * 3600 * 1000;
const at = (d, h, mi) => Date.parse(`${d}T00:00:00Z`) - MYT + h * 3600e3 + (mi || 0) * 60e3;
const MON_FRI = [1, 2, 3, 4, 5];
const nw = (nowMs, days) => nextWindowLabel(nowMs, days, 9, 17);
const both = (label, nowMs, days, bm, en) => {
  const l = nw(nowMs, days);
  eq(label + ' (bm)', l && l.bm, bm);
  eq(label + ' (en)', l && l.en, en);
};

// 🚨 THE OPEN SATURDAY QUESTION IS STILL UNRESOLVED BY THE CLIENT. The same Friday evening must
// produce the right sentence under BOTH settings, so the answer stays a pure env change.
both('next: Fri 17:16 dist=1-5', at('2026-08-14', 17, 16), MON_FRI, 'Isnin pagi', 'Monday morning');
both('next: Fri 17:16 dist=1-6', at('2026-08-14', 17, 16), [1, 2, 3, 4, 5, 6], 'esok pagi', 'tomorrow morning');
both('next: Sat 11:00 dist=1-5', at('2026-08-15', 11), MON_FRI, 'Isnin pagi', 'Monday morning');
// ⚠️ With Saturday IS an assignment day, an 11:00 Saturday lead assigns normally and never enters
// this flow at all — so the label must agree and promise no day.
eq('next: Sat 11:00 dist=1-6 → null (window OPEN, a rep gets it now)', nw(at('2026-08-15', 11), [1, 2, 3, 4, 5, 6]), null);

both('next: Sun 23:00 dist=1-5', at('2026-08-16', 23), MON_FRI, 'Isnin pagi', 'Monday morning');
both('next: Sun 23:00 dist=1-6', at('2026-08-16', 23), [1, 2, 3, 4, 5, 6], 'Isnin pagi', 'Monday morning');
both('next: Mon 07:00 (before opening)', at('2026-08-17', 7), MON_FRI, 'pagi ini sebentar lagi', 'later this morning');
both('next: Mon 17:30 (after closing)', at('2026-08-17', 17, 30), MON_FRI, 'esok pagi', 'tomorrow morning');
eq('next: Wed 11:00 mid-window → null', nw(at('2026-08-19', 11), MON_FRI), null);

// 🚨 Late at night "esok" is technically right and practically confusing — the customer reads it
// minutes from midnight. Naming the day is unambiguous at any hour.
both('next: Thu 20:00 → esok (still early enough)', at('2026-08-20', 20), MON_FRI, 'esok pagi', 'tomorrow morning');
both('next: Thu 22:00 → names the day instead', at('2026-08-20', 22), MON_FRI, 'Jumaat pagi', 'Friday morning');

// Defensive: never guess when there is nothing to derive from.
eq('next: empty day set → null', nextWindowLabel(at('2026-08-14', 17), [], 9, 17), null);
eq('next: junk day set → null', nextWindowLabel(at('2026-08-14', 17), [9, -2], 9, 17), null);
eq('next: invalid start hour → null', nextWindowLabel(at('2026-08-14', 17), MON_FRI, 99, 17), null);
// Future-proof: an afternoon distribution start renders the right part of day in both languages.
{
  const l = nextWindowLabel(at('2026-08-14', 18), MON_FRI, 14, 18);   // dist window 2pm–6pm
  eq('next: afternoon start renders tengah hari (bm)', l && l.bm, 'Isnin tengah hari');
  eq('next: afternoon start renders afternoon (en)', l && l.en, 'Monday afternoon');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
