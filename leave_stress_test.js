'use strict';
// Planned Leave, end to end, trying to BREAK it (2026-09-25, after ede3816 + 5edbcd8).
// Drives settings.parseLeave + leavesync.plan exactly the way index.js leaveTick does: the plan's
// writes and statuses are fed back into a fake sheet and the next tick reads that sheet again, so
// a status the bot overwrote, or an alert it repeats, shows up here the way it would live.
const s = require('./settings');
const ls = require('./leavesync');
let fail = 0, n = 0;
function ok(name, cond) { n++; if (!cond) { fail++; console.log('  ❌ ' + name); } else console.log('  ✅ ' + name); }

// Mirror of index.js flat(): index.js boots a server on require, so it cannot be imported here.
// Keep in step with index.js if that one changes.
function flat(c){
  if (c == null) return '';
  if (Array.isArray(c)) return c.map(x => (x && (x.text != null ? x.text : x.link != null ? x.link : '')) || '').join('');
  if (typeof c === 'object') return String(c.text != null ? c.text : '');
  return String(c);
}
const leaveOf = cells => s.parseLeave([cells].map(r => r.map(flat)));

console.log('\n-- cell shapes Lark can hand over --');
const one = (a, b) => { const r = leaveOf(['AMIRUL', a, b]); return r.leave[0] ? `${r.leave[0].from}|${r.leave[0].to}` : (r.warnings.length ? 'WARN' : 'SILENT'); };
ok('integer serial (what Lark returns for a date cell, measured live)', one(46287, 46295) === '2026-09-22|2026-09-30');
ok('serial as a string', one('46287', '46295') === '2026-09-22|2026-09-30');
ok('🚨 float serial = date WITH a time (46287.5) is read as that day', one(46287.5, 46295.999) === '2026-09-22|2026-09-30');
ok('rich-text run [{text:"2026-09-22"}]', one([{ text: '2026-09-22' }], [{ text: '2026-09-30', type: 'text' }]) === '2026-09-22|2026-09-30');
ok('ISO with surrounding spaces', one(' 2026-09-22 ', '2026-09-30  ') === '2026-09-22|2026-09-30');
ok('typed text 22/9/2026 → refused + WARNED (ambiguous)', one('22/9/2026', '30/9/2026') === 'WARN');
ok('typed text 9/22/2026 → refused + WARNED', one('9/22/2026', '9/30/2026') === 'WARN');
ok('2026/09/22 → WARNED, never silent', one('2026/09/22', '2026/09/30') === 'WARN');
ok('trailing dot 2026-09-22. → WARNED', one('2026-09-22.', '2026-09-30') === 'WARN');
ok('both blank → not a leave row, no noise', one('', '') === 'SILENT');
ok('null cells → not a leave row, no noise', one(null, null) === 'SILENT');
ok('one side blank → WARNED', one('2026-09-22', '') === 'WARN');
ok('from > to → WARNED', one('2026-09-30', '2026-09-22') === 'WARN');
ok('single-day leave', one('2026-10-05', '2026-10-05') === '2026-10-05|2026-10-05');
ok('leave years ahead (2030)', one('2030-01-02', '2030-01-05') === '2030-01-02|2030-01-05');
ok('serial out of range (12345) → WARNED, never read as a date', one(12345, 12350) === 'WARN');
ok('serial out of range (99999) → WARNED', one(99999, 99999) === 'WARN');
ok('negative / garbage number → WARNED', one(-46287, 46295) === 'WARN');
ok('invalid ISO 2026-02-30 → WARNED', one('2026-02-30', '2026-03-01') === 'WARN');

// ------------------------------------------------------------------ the simulator
// sheet.avail = Availability tab rows; sheet.panel = control-panel rows (row index + 1 = sheet row)
function makeSheet(availRows, leaveRows){
  const panel = [['Salesman', 'Leave from', 'Leave until', 'Reason', 'Status']];
  for (const l of leaveRows) panel.push([l.name, l.from, l.to, l.reason || '', l.status || '']);
  return { avail: availRows.map(a => ({ ...a })), panel };
}
// one 5-minute tick, exactly as leaveTick: nothing planned ⇒ nothing sent
function tick(sheet, today, o = {}){
  const L = s.parseLeave(sheet.panel.map(r => r.map(flat)));
  const avail = o.availReadFails ? [] : sheet.avail.map(a => ({ ...a }));
  const plan = ls.plan(L.leave, avail, today);
  if (!plan.writes.length && !plan.statuses.length) return { plan, sent: [] };
  for (const w of plan.writes){ const a = sheet.avail.find(x => x.row === w.row); if (a) a.value = w.value; }
  for (const st of plan.statuses){ const r = sheet.panel[st.row - 1]; if (r) r[4] = st.value; }
  return { plan, sent: plan.alerts };
}
const val = (sheet, name) => sheet.avail.find(a => a.name === name).value;
// run N ticks per day across a date range, collecting every alert actually sent
function days(from, to){ const out = []; let d = new Date(from + 'T00:00:00Z'); const e = new Date(to + 'T00:00:00Z'); while (d <= e){ out.push(d.toISOString().slice(0, 10)); d = new Date(d.getTime() + 86400000); } return out; }
function run(sheet, from, to, perDay = 3, hook){
  const log = [];
  for (const day of days(from, to)) for (let k = 0; k < perDay; k++){
    if (hook) hook(sheet, day, k);
    const r = tick(sheet, day);
    for (const a of r.sent) log.push({ day, a });
    log.push({ day, state: sheet.avail.map(x => x.name + '=' + x.value).join(',') });
  }
  return log;
}
const alerts = log => log.filter(x => x.a);
const stateOn = (log, day) => (log.filter(x => x.state && x.day === day).pop() || {}).state || '';

console.log('\n-- full lifecycle, YES before the leave (normal case) --');
{
  const sh = makeSheet([{ name: 'ADIB', value: 'YES', row: 19 }], [{ name: 'ADIB', from: '2026-10-05', to: '2026-10-07' }]);
  const lg = run(sh, '2026-10-03', '2026-10-10');
  ok('day before: still ON', /ADIB=YES/.test(stateOn(lg, '2026-10-04')));
  ok('day 1: OFF', /ADIB=NO/.test(stateOn(lg, '2026-10-05')));
  ok('middle + last day: OFF', /ADIB=NO/.test(stateOn(lg, '2026-10-06')) && /ADIB=NO/.test(stateOn(lg, '2026-10-07')));
  ok('return day: ON', /ADIB=YES/.test(stateOn(lg, '2026-10-08')));
  ok('day after: still ON, nothing flips back', /ADIB=YES/.test(stateOn(lg, '2026-10-10')));
  const a = alerts(lg);
  ok('exactly TWO messages across 8 days × 3 ticks (off, back) — no spam', a.length === 2 && /switched OFF/.test(a[0].a) && /switched back ON/.test(a[1].a));
  ok('the OFF message goes out on day 1, the ON message on the return day', a[0].day === '2026-10-05' && a[1].day === '2026-10-08');
}

console.log('\n-- AMIRUL shape: already NO, old "(was NO)" stamp from the first deploy --');
{
  const sh = makeSheet([{ name: 'AMIRUL', value: 'NO', row: 10 }], [{ name: 'AMIRUL', from: 46287, to: 46295, reason: 'CUTI KAHWIN', status: 'on leave until 2026-09-30 (was NO)' }]);
  const lg = run(sh, '2026-09-25', '2026-10-02');
  ok('stays OFF through 30 Sep', /AMIRUL=NO/.test(stateOn(lg, '2026-09-30')));
  ok('🚨 back ON on 1 Oct, exactly', /AMIRUL=YES/.test(stateOn(lg, '2026-10-01')));
  const a = alerts(lg);
  ok('only ONE message the whole time (the 1 Oct "back" line), none today', a.length === 1 && a[0].day === '2026-10-01' && /back from leave/.test(a[0].a));
}

console.log('\n-- a human flips them YES mid-leave --');
{
  const sh = makeSheet([{ name: 'ADIB', value: 'YES', row: 19 }], [{ name: 'ADIB', from: '2026-10-05', to: '2026-10-09' }]);
  const lg = run(sh, '2026-10-05', '2026-10-11', 3, (sh2, day, k) => { if (day === '2026-10-07' && k === 0) sh2.avail[0].value = 'YES'; });
  ok('page wins: back to NO the same day', /ADIB=NO/.test(stateOn(lg, '2026-10-07')));
  const flips = alerts(lg).filter(x => /was set to YES/.test(x.a));
  ok('the "set back to NO" message goes out ONCE, not every tick', flips.length === 1);
  ok('still ON on the return day', /ADIB=YES/.test(stateOn(lg, '2026-10-10')));
}

console.log('\n-- two overlapping bookings, one person --');
{
  const sh = makeSheet([{ name: 'JUE', value: 'YES', row: 7 }], [{ name: 'JUE', from: '2026-10-05', to: '2026-10-07' }, { name: 'JUE', from: '2026-10-06', to: '2026-10-09' }]);
  const lg = run(sh, '2026-10-04', '2026-10-11');
  ok('OFF from the first booking', /JUE=NO/.test(stateOn(lg, '2026-10-05')));
  ok('stays OFF on 08 Oct (second booking still running)', /JUE=NO/.test(stateOn(lg, '2026-10-08')));
  ok('ON only when the LATER booking ends (10 Oct)', /JUE=NO/.test(stateOn(lg, '2026-10-09')) && /JUE=YES/.test(stateOn(lg, '2026-10-10')));
  ok('one OFF + one ON message', alerts(lg).filter(x => /switched OFF/.test(x.a)).length === 1 && alerts(lg).filter(x => /back ON/.test(x.a)).length === 1);
}

console.log('\n-- booking edited to end early --');
{
  const sh = makeSheet([{ name: 'ROY', value: 'YES', row: 30 }], [{ name: 'ROY', from: '2026-10-05', to: '2026-10-10' }]);
  const lg = run(sh, '2026-10-05', '2026-10-09', 3, (sh2, day, k) => { if (day === '2026-10-07' && k === 0) sh2.panel[1][2] = '2026-10-06'; });
  ok('shortened leave → ON on 07 Oct', /ROY=YES/.test(stateOn(lg, '2026-10-07')));
}

console.log('\n-- names: case, extra spaces, not on the tab --');
{
  const sh = makeSheet([{ name: 'NABIL', value: 'YES', row: 5 }], [{ name: '  nabil  ', from: '2026-10-05', to: '2026-10-05' }]);
  const lg = run(sh, '2026-10-05', '2026-10-06');
  ok('"  nabil  " matches NABIL, OFF then ON', /NABIL=NO/.test(stateOn(lg, '2026-10-05')) && /NABIL=YES/.test(stateOn(lg, '2026-10-06')));
  const sh2 = makeSheet([{ name: 'NABIL', value: 'YES', row: 5 }], [{ name: 'NABEEL', from: '2026-10-05', to: '2026-10-06' }]);
  const lg2 = run(sh2, '2026-10-05', '2026-10-07');
  ok('typo NABEEL: nobody is switched (no fuzzy guess)', /NABIL=YES/.test(stateOn(lg2, '2026-10-06')));
  ok('typo NABEEL: warned ONCE, not every tick', alerts(lg2).filter(x => /not on the Salesman Availability tab/.test(x.a)).length === 1);
}

console.log('\n-- two people on leave the same day --');
{
  const sh = makeSheet([{ name: 'ASO', value: 'YES', row: 3 }, { name: 'NAZRIN', value: 'YES', row: 4 }],
    [{ name: 'ASO', from: '2026-10-05', to: '2026-10-06' }, { name: 'NAZRIN', from: '2026-10-05', to: '2026-10-08' }]);
  const lg = run(sh, '2026-10-05', '2026-10-09');
  ok('both OFF on day 1', /ASO=NO,NAZRIN=NO/.test(stateOn(lg, '2026-10-05')));
  ok('ASO back 07 Oct while NAZRIN still OFF', /ASO=YES,NAZRIN=NO/.test(stateOn(lg, '2026-10-07')));
  ok('both back by 09 Oct', /ASO=YES,NAZRIN=YES/.test(stateOn(lg, '2026-10-09')));
}

console.log('\n-- the leave row is DELETED mid-leave --');
{
  const sh = makeSheet([{ name: 'ALLYSA', value: 'YES', row: 6 }], [{ name: 'ALLYSA', from: '2026-10-05', to: '2026-10-09' }]);
  const lg = run(sh, '2026-10-05', '2026-10-12', 3, (sh2, day, k) => { if (day === '2026-10-06' && k === 0) sh2.panel.splice(1, 1); });
  // Documented behaviour, not a pass/fail on design: nothing is left telling the bot she is away.
  const stuck = /ALLYSA=NO/.test(stateOn(lg, '2026-10-12'));
  ok(`row deleted mid-leave → she ${stuck ? 'STAYS OFF (nobody told)' : 'comes back'} — see report`, true);
  global.__deletedRowStuck = stuck;
}

console.log('\n-- the Availability read FAILS (Lark error ⇒ readAvailRows returns []) --');
{
  // mid-leave failure
  const sh = makeSheet([{ name: 'ADIB', value: 'YES', row: 19 }], [{ name: 'ADIB', from: '2026-10-05', to: '2026-10-09' }]);
  run(sh, '2026-10-05', '2026-10-05');
  const bad = tick(sh, '2026-10-07', { availReadFails: true });
  ok('🚨 a failed read must NOT rewrite the Status stamp', !bad.plan.statuses.length);
  ok('🚨 a failed read must NOT tell the group the name is missing', !bad.sent.length);
  const lg = run(sh, '2026-10-07', '2026-10-11');
  ok('still comes back ON after the blip', /ADIB=YES/.test(stateOn(lg, '2026-10-10')));
  // failure ON the return day, then recovery
  const sh2 = makeSheet([{ name: 'ADIB', value: 'YES', row: 19 }], [{ name: 'ADIB', from: '2026-10-05', to: '2026-10-09' }]);
  run(sh2, '2026-10-05', '2026-10-09');
  tick(sh2, '2026-10-10', { availReadFails: true });
  const lg2 = run(sh2, '2026-10-10', '2026-10-11');
  ok('🚨 read fails on the RETURN day → still switched back ON on the next good read', /ADIB=YES/.test(stateOn(lg2, '2026-10-10')));
  // partial read: only some rows came back
  const sh3 = makeSheet([{ name: 'ADIB', value: 'YES', row: 19 }, { name: 'JUE', value: 'YES', row: 7 }], [{ name: 'ADIB', from: '2026-10-05', to: '2026-10-09' }]);
  run(sh3, '2026-10-05', '2026-10-05');
  const L = s.parseLeave(sh3.panel.map(r => r.map(flat)));
  const partial = ls.plan(L.leave, [{ name: 'JUE', value: 'YES', row: 7 }], '2026-10-06');
  ok('partial read never switches a DIFFERENT person', !partial.writes.some(w => w.name === 'JUE'));
  // partial read where the person on leave is the one missing, across the return day
  const sh4 = makeSheet([{ name: 'ADIB', value: 'YES', row: 19 }, { name: 'JUE', value: 'YES', row: 7 }], [{ name: 'ADIB', from: '2026-10-05', to: '2026-10-09' }]);
  run(sh4, '2026-10-05', '2026-10-09');
  const full = sh4.avail; sh4.avail = full.filter(a => a.name !== 'ADIB');
  const miss = tick(sh4, '2026-10-10');
  ok('name missing from a partial read: stamp KEPT inside the warning', /\(was YES\)/.test(sh4.panel[1][4]));
  const again = tick(sh4, '2026-10-10');
  ok('...and the warning is sent ONCE, not every tick', miss.sent.length === 1 && again.sent.length === 0);
  sh4.avail = full;
  tick(sh4, '2026-10-10');
  ok('🚨 name back on the next read → switched ON, not "never activated"', val(sh4, 'ADIB') === 'YES');
}

console.log('\n-- MYT day boundary --');
{
  const d = (iso) => ls.todayMYT(Date.parse(iso));
  ok('30 Sep 23:59 MYT (15:59Z) is still 30 Sep', d('2026-09-30T15:59:00Z') === '2026-09-30');
  ok('01 Oct 00:00 MYT (16:00Z) is 1 Oct → Amirul ON at the 00:00–00:05 tick', d('2026-09-30T16:00:00Z') === '2026-10-01');
  ok('08:00 MYT on 1 Oct is still 1 Oct (UTC is 30 Sep 00:00Z)', d('2026-10-01T00:00:00Z') === '2026-10-01');
  const sh = makeSheet([{ name: 'AMIRUL', value: 'NO', row: 10 }], [{ name: 'AMIRUL', from: 46287, to: 46295, status: 'on leave until 2026-09-30 (was YES)' }]);
  tick(sh, d('2026-09-30T15:59:00Z'));
  ok('23:59 on the last day: still OFF', val(sh, 'AMIRUL') === 'NO');
  tick(sh, d('2026-09-30T16:01:00Z'));
  ok('00:01 the next day: ON', val(sh, 'AMIRUL') === 'YES');
  const sh2 = makeSheet([{ name: 'JUE', value: 'YES', row: 7 }], [{ name: 'JUE', from: '2026-10-05', to: '2026-10-05' }]);
  tick(sh2, d('2026-10-04T16:02:00Z'));
  ok('leave starting today: OFF at 00:02 MYT', val(sh2, 'JUE') === 'NO');
}

console.log(`\n${n - fail}/${n} passed`);
if (global.__deletedRowStuck) console.log('ℹ️  documented: deleting a leave row mid-leave leaves that person OFF (nothing left to restore from).');
process.exit(fail ? 1 : 0);
