'use strict';
const ls = require('./leavesync');
let fail = 0, n = 0;
function ok(name, cond) { n++; if (!cond) { fail++; console.log('  ❌ ' + name); } else console.log('  ✅ ' + name); }

// the availability tab: ADIB working, BELLA off for her own unrelated reason
const AVAIL = [
  { name: 'FAZWAN', value: 'YES', row: 2 },
  { name: 'ADIB',   value: 'YES', row: 19 },
  { name: 'BELLA',  value: 'NO',  row: 14 },
];
const L = (o) => Object.assign({ name: 'ADIB', from: '2026-09-18', to: '2026-09-21', reason: 'Cuti', status: '', row: 47 }, o);

console.log('\n-- THE LIFECYCLE Benjamin asked about --');
// day before
let p = ls.plan([L()], AVAIL, '2026-09-17');
ok('day BEFORE leave: nobody is switched off', p.writes.length === 0);
ok('day BEFORE leave: row is marked "scheduled"', p.statuses.some(s => /scheduled/.test(s.value)));

// first day
p = ls.plan([L()], AVAIL, '2026-09-18');
ok('FIRST day: writes NO to ADIB’s Available? cell (row 19)', p.writes.length === 1 && p.writes[0].row === 19 && p.writes[0].value === 'NO');
ok('FIRST day: remembers he was YES before', p.statuses.some(s => s.value === 'on leave until 2026-09-21 (was YES)'));
ok('FIRST day: announces it in the group', p.alerts.some(a => /off 2026-09-18/.test(a) && /switched OFF/.test(a)));

// mid-leave, availability already NO and stamped — must be idempotent, no repeat writes/alerts
const stamped = L({ status: 'on leave until 2026-09-21 (was YES)' });
const availOff = AVAIL.map(a => a.name === 'ADIB' ? { ...a, value: 'NO' } : a);
p = ls.plan([stamped], availOff, '2026-09-19');
ok('MID leave: no repeat write', p.writes.length === 0);
ok('MID leave: no repeat alert (does not spam every 5 min)', p.alerts.length === 0);
ok('MID leave: status left alone', p.statuses.length === 0);

// last day is inclusive
p = ls.plan([stamped], availOff, '2026-09-21');
ok('LAST day is INCLUSIVE — still off', p.writes.length === 0 && p.alerts.length === 0);

// return day
p = ls.plan([stamped], availOff, '2026-09-22');
ok('RETURN day: writes YES back to row 19', p.writes.length === 1 && p.writes[0].row === 19 && p.writes[0].value === 'YES');
ok('RETURN day: announces he is back', p.alerts.some(a => /back from leave/.test(a)));
ok('RETURN day: marks the row returned', p.statuses.some(s => s.value === 'returned 2026-09-22'));

// after it has settled
p = ls.plan([L({ status: 'returned 2026-09-22' })], AVAIL, '2026-09-25');
ok('AFTER: nothing happens again, ever', p.writes.length === 0 && p.alerts.length === 0 && p.statuses.length === 0);

console.log('\n-- the trap: restore the PRIOR value, not YES --');
const bellaLeave = L({ name: 'BELLA', row: 48, from: '2026-10-01', to: '2026-10-03' });
p = ls.plan([bellaLeave], AVAIL, '2026-10-01');
ok('BELLA was already NO: no pointless write', p.writes.length === 0);
ok('BELLA: stamped to come back ON (Benjamin 25 Sep: back from leave = ON)', p.statuses.some(s => /\(was YES\)/.test(s.value)));
p = ls.plan([L({ name: 'BELLA', row: 48, from: '2026-10-01', to: '2026-10-03', status: 'on leave until 2026-10-03 (was NO)' })], AVAIL, '2026-10-04');
ok('BELLA back: switched ON even though an OLD stamp says (was NO)', p.writes.some(w => w.row === 14 && w.value === 'YES'));
ok('BELLA back: says she is back ON', p.alerts.some(a => /back from leave/.test(a) && /switched back ON/.test(a)));

console.log('\n-- ALREADY off on day one: still comes back ON (Benjamin, 25 Sep) --');
// Real case found by the dry run, 18 Sep: Harith had already set ADIB to NO by hand for this very
// leave, so "restore the prior value" would have left him off after 21 Sep.
const availAdibOff = AVAIL.map(a => a.name === 'ADIB' ? { ...a, value: 'NO' } : a);
p = ls.plan([L()], availAdibOff, '2026-09-18');
ok('no pointless write (already NO)', p.writes.length === 0);
ok('stamps YES as the value to restore', p.statuses.some(st => /\(was YES\)/.test(st.value)));
ok('🚨 NO "will stay OFF" message to the group any more', !p.alerts.some(a => /stay OFF|ALREADY NO/.test(a)));
// the real Amirul case: live stamp says (was NO), leave ends 30 Sep → ON on 1 Oct
p = ls.plan([L({ status: 'on leave until 2026-09-21 (was NO)' })], availAdibOff, '2026-09-22');
ok('🚨 AMIRUL shape: old "(was NO)" stamp, leave ended → switched back ON', p.writes.some(w => w.row === 19 && w.value === 'YES'));
p = ls.plan([L({ status: 'on leave until 2026-09-21 (was NO)' })], availAdibOff, '2026-09-19');
ok('it says it ONCE, not every 5 minutes', p.alerts.length === 0);

console.log('\n-- a human flips them ON mid-leave --');
p = ls.plan([stamped], AVAIL, '2026-09-19');   // AVAIL has ADIB = YES again
ok('page wins: re-asserts NO', p.writes.some(w => w.row === 19 && w.value === 'NO'));
ok('and says so instead of fighting silently', p.alerts.some(a => /was set to YES/.test(a) && /back early/.test(a)));

console.log('\n-- name not on the availability tab --');
p = ls.plan([L({ name: 'ADIBB', row: 50 })], AVAIL, '2026-09-18');
ok('NEVER fuzzy-matches onto a real person', p.writes.length === 0);
ok('flags the typo in the Status cell', p.statuses.some(s => /name not found/.test(s.value)));
ok('and alerts the group', p.alerts.some(a => /not on the Salesman Availability tab/.test(a)));

console.log('\n-- leave typed in after it already ended --');
p = ls.plan([L({ from: '2026-09-01', to: '2026-09-05' })], AVAIL, '2026-09-18');
ok('nothing was switched off, so nothing is restored', p.writes.length === 0);
ok('row marked so it is not reconsidered forever', p.statuses.some(s => /never activated/.test(s.value)));

console.log('\n-- two overlapping bookings for one person --');
p = ls.plan([L({ row: 47 }), L({ row: 48, from: '2026-09-20', to: '2026-09-25' })], AVAIL, '2026-09-20');
ok('switched off exactly once', p.writes.filter(w => w.row === 19).length === 1);
ok('the second row is marked as covered, not duplicated', p.statuses.some(s => /covered by row/.test(s.value)));

console.log('\n-- nothing on the page --');
p = ls.plan([], AVAIL, '2026-09-18');
ok('empty leave table touches nothing', p.writes.length === 0 && p.alerts.length === 0 && p.statuses.length === 0);

console.log('\n-- date helpers --');
ok('nextDay crosses a month end', ls.nextDay('2026-09-30') === '2026-10-01');
ok('nextDay crosses a year end', ls.nextDay('2026-12-31') === '2027-01-01');
ok('todayMYT uses Malaysia time, not UTC', ls.todayMYT(Date.UTC(2026, 8, 17, 17, 0, 0)) === '2026-09-18');

console.log(`\n${n - fail}/${n} passed`);
process.exit(fail ? 1 : 0);
