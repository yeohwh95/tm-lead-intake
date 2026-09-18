'use strict';
const sw = require('./sheetwatch');
let fail = 0, n = 0;
const ok = (name, c) => { n++; if (!c) { fail++; console.log('  ❌ ' + name); } else console.log('  ✅ ' + name); };
const Q = 3 * 60 * 1000, M = 10 * 60 * 1000, T = 1_000_000;

console.log('\n-- when does it speak --');
ok('nothing pending -> silent', sw.shouldFlush(T, 0, 0, Q, M) === false);
ok('1 min after the last edit -> still waiting', sw.shouldFlush(T + 60e3, T, T, Q, M) === false);
ok('3 min of quiet -> speaks', sw.shouldFlush(T + Q, T, T, Q, M) === true);
// pure debounce can be starved forever by somebody who keeps typing
ok('edits every 2 min for 10 min -> the cap forces it out', sw.shouldFlush(T + M, T + M - 60e3, T, Q, M) === true);
ok('and before the cap it still waits', sw.shouldFlush(T + 5 * 60e3, T + 4 * 60e3, T, Q, M) === false);

console.log('\n-- net-zero suppression (the case a fixed 3-min delay gets wrong) --');
const before = { ADIB: 'YES', BELLA: 'NO', ZEERA: 'YES' };
ok('OFF then back ON inside the window -> SAY NOTHING',
   sw.diffAvail(before, { ADIB: 'YES', BELLA: 'NO', ZEERA: 'YES' }).length === 0);
ok('a real single change is announced',
   JSON.stringify(sw.diffAvail(before, { ...before, ADIB: 'NO' }).map(x => x.to)) === '["NO"]');

console.log('\n-- one message for a whole editing session --');
const d = sw.diffAvail(before, { ADIB: 'NO', BELLA: 'YES', ZEERA: 'YES' });
ok('two edits -> two lines, ONE message', d.length === 2);
ok('OFF wording', /🔴 ADIB → OFF/.test(d.find(x => x.name === 'ADIB').line));
ok('ON wording', /✅ BELLA → back ON/.test(d.find(x => x.name === 'BELLA').line));

console.log('\n-- the bot’s own writes are not double-announced --');
ok('Planned Leave already said it, so availability stays quiet',
   sw.diffAvail(before, { ...before, ADIB: 'NO' }, new Set(['adib'])).length === 0);
ok('but somebody ELSE changing in the same burst still speaks',
   sw.diffAvail(before, { ...before, ADIB: 'NO', ZEERA: 'NO' }, new Set(['adib'])).length === 1);

console.log('\n-- a row DELETED from the sheet is not the same as NO --');
const gone = sw.diffAvail(before, { ADIB: 'YES', ZEERA: 'YES' });
ok('removal is reported, it used to be invisible', gone.length === 1 && gone[0].to === '(removed)');
ok('and says they receive nothing', /receives nothing/.test(gone[0].line));

console.log('\n-- settings + campaigns --');
const fp = (o, c) => sw.settingsFingerprint(o, c);
const A = fp({ botOn: true, offToday: false, distDays: [1,2,3,4,5,6], distStart: 9, distEnd: 18, maySayStock: false, maySayPrice: false, intentHold: true, intentHoldMin: 10, sellGoesTo: 'FITRI', adminGoesTo: 'ADMIN', stickyOwner: true, replyOffHours: true, offDates: [], replyGeneral: 'x'.repeat(50) },
  [{ campaign: 'Moda Aero E', active: true, names: ['ZEERA'] }]);
const B = fp({ botOn: true, offToday: true,  distDays: [1,2,3,4,5,6], distStart: 9, distEnd: 18, maySayStock: false, maySayPrice: false, intentHold: true, intentHoldMin: 10, sellGoesTo: 'FITRI', adminGoesTo: 'ADMIN', stickyOwner: true, replyOffHours: true, offDates: [], replyGeneral: 'x'.repeat(50) },
  [{ campaign: 'Moda Aero E', active: true, names: ['ZEERA','BELLA'] }]);
const lines = sw.diffMap(A, B);
ok('an off-day switch is announced', lines.some(l => /offToday: OFF → ON/.test(l)));
ok('a campaign rotation change is announced', lines.some(l => /Moda Aero E.*ZEERA → .*ZEERA, BELLA/.test(l)));
ok('unchanged settings are silent', lines.length === 2);
ok('the FIRST read is a baseline, never a message', sw.diffMap(null, B).length === 0);
ok('reply wording shows a length, not the whole paragraph', /\(50 chars\)/.test(A.replyGeneral));

console.log('\n-- the message itself --');
const msg = sw.buildMessage(sw.diffAvail(before, { ...before, ADIB: 'NO' }), lines);
ok('both sections in ONE message', /Salesman availability changed/.test(msg) && /Bot settings changed/.test(msg));
ok('empty in -> empty out', sw.buildMessage([], []) === '');

console.log(`\n${n - fail}/${n} passed`);
process.exit(fail ? 1 : 0);
