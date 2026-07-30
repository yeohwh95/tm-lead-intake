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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
