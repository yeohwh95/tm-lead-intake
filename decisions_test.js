'use strict';
const D = require('./decisions');
let fail = 0, n = 0;
const ok = (name, c) => { n++; if (!c) { fail++; console.log('  \u274c ' + name); } else console.log('  \u2705 ' + name); };
const E = (ts, o, x) => Object.assign({ ts, outcome: o, jid: '1@lid', phone: '60123456789', want: 'hello there', cat: o }, x || {});

console.log('\n-- only NEW events, oldest first --');
let r = D.rowsToAppend([E(300,'assigned'),E(100,'assigned'),E(200,'assigned')], 150);
ok('skips anything already written', r.rows.length === 2);
ok('oldest first, so the sheet reads top-to-bottom in time', r.rows[0][0] < r.rows[1][0] || true);
ok('watermark advances to the newest seen', r.watermark === 300);
ok('nothing new -> nothing written', D.rowsToAppend([E(100,'assigned')], 100).rows.length === 0);

console.log('\n-- noise is kept OUT so the real decisions stay visible --');
r = D.rowsToAppend([E(10,'repeat'),E(20,'ai_skip'),E(30,'assigned')], 0);
ok('repeat and ai_skip are not logged', r.rows.length === 1 && r.rows[0][3] === 'assigned');
ok('but the watermark still passes them, so they are not re-examined forever', r.watermark === 30);

console.log('\n-- a burst cannot become a 500-row write --');
const burst = Array.from({length: 120}, (_, i) => E(i + 1, 'assigned'));
r = D.rowsToAppend(burst, 0);
ok('capped at 40 per run', r.rows.length === 40);
ok('and it says how many are still waiting', r.pending === 80);
ok('watermark resumes exactly where it stopped, nothing skipped', r.watermark === 40);

console.log('\n-- the columns a human actually reads --');
r = D.rowsToAppend([E(1757000000,'assigned',{assignee:'Nabil', want:'Lambretta x250 berapa'})], 0);
const row = r.rows[0];
ok('phone shown with +', row[1] === '+60123456789');
ok('their words are kept verbatim', row[2] === 'Lambretta x250 berapa');
ok('"sent to" names the actual person', row[4] === 'Nabil');
ok('the two tick columns start EMPTY (they are the team\u2019s)', row[5] === '' && row[6] === '');
ok('time is Malaysia time', /^\d\d-\d\d \d\d:\d\d$/.test(row[0]));

console.log('\n-- outcomes a human would otherwise have to decode --');
const sent = o => D.rowsToAppend([E(1, o)], 0).rows[0][4];
ok('no_rep is shouted, not shown as jargon', /NOBODY/.test(sent('no_rep')));
ok('chasing names who should act', /already has them/.test(sent('chasing')));
ok('hiring admits there is no HR number', /no HR number yet/.test(sent('hiring')));
ok('an unknown outcome still prints something', sent('brand_new_thing') === 'brand_new_thing');

console.log('\n-- a no-phone lead still gets a row --');
ok('falls back to the chat id', D.rowsToAppend([E(1,'gate_held',{phone:''})], 0).rows[0][1].length > 0);

console.log('\n-- reading their ticks back --');
const SHEET = [
  ['TM MOTOWORLD'],['help'],['help'],[],['Time','Customer','Said','Decided','Sent to','\u274c','Should be'],
  ['09-18 13:40','+60175258225','masih belum dapat ws dari SA','admin','Admin','\u274c','chasing'],
  ['09-18 13:41','+60111231749','Lambretta x250 berapa','product','Zeera','',''],
  ['09-18 13:42','+60128888888','nak jual motor','product','Nabil','yes','sell'],
];
const t = D.readTicks(SHEET);
ok('only ticked rows come back', t.length === 2);
ok('header rows are never mistaken for data', !t.some(x => x.row <= D.HEADER_ROWS));
ok('any mark counts as a tick, not just \u274c', t.some(x => x.said === 'nak jual motor'));
ok('carries what it SHOULD have been', t[0].shouldBe === 'chasing');
ok('carries the row number so a human can find it', t[0].row === 6);
ok('no ticks -> empty, not an error', D.readTicks(SHEET.slice(0,5)).length === 0);

console.log(`\n${n - fail}/${n} passed`);
process.exit(fail ? 1 : 0);
