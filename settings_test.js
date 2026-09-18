'use strict';
const s = require('./settings');
let fail = 0, n = 0;
function ok(name, cond) { n++; if (!cond) { fail++; console.log('  ❌ ' + name); } else console.log('  ✅ ' + name); }

// A faithful slice of the real page, including the double space and the em-dashes Lark produces.
const PAGE = [
  ['TM MOTOWORLD — BOT CONTROL PANEL'],
  ['Everything the bot does is controlled from this page.'],
  [],
  ['①  MASTER SWITCHES'],
  ['Setting', 'Value', 'What this does'],
  ['Bot ON / OFF', 'ON', 'blah'],
  ['Off today?  (holiday / off day)', 'NO', 'blah'],
  ['Extra off dates', '2026-12-25, 2027-01-01', 'blah'],
  ['②  WORKING HOURS'],
  ['Days leads are handed to a salesperson', 'Mon-Sat', ''],
  ['Start hour', '9', ''],
  ['End hour', '18', ''],
  ['Reply to customers outside these hours?', 'YES', ''],
  ['May the bot say whether a bike is in stock?', 'NO', ''],
  ['May the bot quote a price?', 'NO', ''],
  ['May the bot answer parts / service / workshop?', 'NO', ''],
  ['Ask buy-or-sell before assigning?', 'ON', ''],
  ['How long to hold for that answer (minutes)', '10', ''],
  ['Sell / trade-in leads go to', 'FITRI', ''],
  ['Insurance / roadtax / name-change go to', 'ADMIN', ''],
  ['If the same customer comes back, keep the same salesperson?', 'ON', ''],
  ['Reply — general enquiry', 'Terima kasih A', ''],
  ['Reply — test ride', 'Terima kasih B', ''],
  ['Reply — insurance / roadtax / name change', 'Terima kasih C', ''],
  ['Reply — outside working hours', 'contact tuan {NEXT WORKING DAY} ya', ''],
  ['⑤  TIKTOK AD CAMPAIGNS'],
  ['Campaign', 'Active?', 'Salesmen', 'TikTok form ID', 'TikTok account', 'Last changed', 'Notes'],
  ['Lambretta X250GP', 'YES', 'NABIL, JEBAT, ALLYSA, JUE', '7602092542863114504', 'Lambretta Selangor', '2026-07-30', 'note'],
  ['Moda Aero E', 'YES', 'ZEERA, SYAZA', '7681590400255066389', 'HQ', '2026-09-18', ''],
  ['KTM', 'NO', 'AMIRUL, ASO', '7680386887143457031', 'KTM Shah Alam', '2026-09-06', 'retired'],
  ['⑥  PLANNED LEAVE'],
  ['Salesman', 'Leave from', 'Leave until', 'Reason', 'Status'],
  ['ADIB', '2026-09-18', '2026-09-21', 'Cuti', ''],
  ['HOW THIS PAGE WORKS'],
  ['Every value here is read live.'],
];

console.log('\n-- settings --');
const r = s.parseSettings(PAGE);
ok('reads every label (19 found)', r.foundCount === 19);
ok('no warnings on a clean page', r.warnings.length === 0 || (console.log('     ' + r.warnings.join('\n     ')), false));
ok('botOn true from "ON"', r.settings.botOn === true);
ok('offToday false from "NO"', r.settings.offToday === false);
ok('double space in the label still matches', 'offToday' in r.settings && r.settings.offToday === false);
ok('offDates parsed', JSON.stringify(r.settings.offDates) === '["2026-12-25","2027-01-01"]');
ok('Mon-Sat -> [1..6]', JSON.stringify(r.settings.distDays) === '[1,2,3,4,5,6]');
ok('hours numeric', r.settings.distStart === 9 && r.settings.distEnd === 18);
ok('em-dash reply labels match', r.settings.replyGeneral === 'Terima kasih A' && r.settings.replyOffHoursMsg.includes('{NEXT WORKING DAY}'));
ok('sell goes to FITRI', r.settings.sellGoesTo === 'FITRI');

console.log('\n-- settings: bad input is never guessed at --');
const bad = s.parseSettings([['Bot ON / OFF', 'ya'], ['Start hour', '25'], ['End hour', ''], ['Days leads are handed to a salesperson', 'everyday'], ['Extra off dates', '25/12/2026'], ['How long to hold for that answer (minutes)', 'ten']]);
ok('"ya" is not treated as ON-by-luck; falls back to default', bad.settings.botOn === true && bad.warnings.some(w => /expected ON or OFF/.test(w)));
ok('hour 25 rejected, default kept', bad.settings.distStart === 9 && bad.warnings.some(w => /whole hour 0-23/.test(w)));
ok('blank end hour rejected, default kept', bad.settings.distEnd === 18);
ok('unparseable days keeps Mon-Sat', JSON.stringify(bad.settings.distDays) === '[1,2,3,4,5,6]');
ok('wrong date format ignored + warned', JSON.stringify(bad.settings.offDates) === '[]' && bad.warnings.some(w => /not a date/.test(w)));
ok('non-numeric minutes keeps 10', bad.settings.intentHoldMin === 10);
ok('missing labels are NAMED, not just counted', bad.warnings.some(w => /missing from column A/.test(w) && /Sell \/ trade-in leads go to/.test(w)));

console.log('\n-- settings: OFF actually reads as OFF (the dangerous direction) --');
const off = s.parseSettings([['Bot ON / OFF', 'OFF'], ['Off today?  (holiday / off day)', 'YES'], ['Ask buy-or-sell before assigning?', 'off'], ['May the bot quote a price?', 'yes']]);
ok('botOn OFF', off.settings.botOn === false);
ok('offToday YES', off.settings.offToday === true);
ok('lowercase "off" works', off.settings.intentHold === false);
ok('lowercase "yes" works', off.settings.maySayPrice === true);

console.log('\n-- settings: duplicates --');
const dup = s.parseSettings([['Bot ON / OFF', 'ON'], ['Bot ON / OFF', 'OFF']]);
ok('first row wins, duplicate warned', dup.settings.botOn === true && dup.warnings.some(w => /more than once/.test(w)));

console.log('\n-- campaigns --');
const c = s.parseCampaigns(PAGE);
ok('3 campaigns found by form id, prose rows ignored', c.campaigns.length === 3);
ok('rotation order preserved exactly', JSON.stringify(c.campaigns[0].names) === '["NABIL","JEBAT","ALLYSA","JUE"]');
ok('Active?=NO campaign is inactive but still listed', c.campaigns[2].active === false && c.campaigns[2].formId === '7680386887143457031');
ok('no warnings on clean campaigns', c.warnings.length === 0 || (console.log('     ' + c.warnings.join('\n     ')), false));

const cbad = s.parseCampaigns([
  ['A', 'YES', '', '7602092542863114504'],
  ['B', 'maybe', 'NABIL', '7673807149692207367'],
  ['C', 'YES', 'NABIL, nabil, JUE', '7683459299854713108'],
  ['D', 'YES', 'X', '7602092542863114504'],
]);
ok('active with no salesmen -> forced NO + warned', cbad.campaigns[0].active === false && cbad.warnings.some(w => /NOBODY to go to/.test(w)));
ok('bad Active? -> NO (captured, not assigned) + warned', cbad.campaigns[1].active === false && cbad.warnings.some(w => /expected YES or NO/.test(w)));
ok('duplicate name counted once', JSON.stringify(cbad.campaigns[2].names) === '["NABIL","JUE"]');
ok('duplicate form id rejected, first wins', cbad.campaigns.length === 3 && cbad.warnings.some(w => /appears twice/.test(w)));

console.log('\n-- planned leave --');
const l = s.parseLeave(PAGE);
ok('exactly 1 leave row; setting rows and prose ignored', l.leave.length === 1 && l.leave[0].name === 'ADIB');
ok('"Extra off dates" row is NOT mistaken for leave', !l.leave.some(x => /off dates/i.test(x.name)));
ok('dates captured', l.leave[0].from === '2026-09-18' && l.leave[0].to === '2026-09-21');

const lbad = s.parseLeave([['AMIR', '18/09/2026', '21/09/2026'], ['ASO', '2026-09-21', '2026-09-18'], ['ROY', '2026-09-30', '2026-09-30'], ['prose line with no dates', '', '']]);
ok('wrong date format ignored + warned', !lbad.leave.some(x => x.name === 'AMIR') && lbad.warnings.some(w => /not a valid date pair/.test(w)));
ok('reversed range ignored + warned', !lbad.leave.some(x => x.name === 'ASO') && lbad.warnings.some(w => /BEFORE/.test(w)));
ok('single-day leave accepted', lbad.leave.some(x => x.name === 'ROY'));
ok('prose row produces no warning noise', !lbad.warnings.some(w => /prose line/.test(w)));

console.log('\n-- row positions do not matter --');
const shuffled = [['zzz filler'], ['more filler'], ...PAGE];
const r2 = s.parseSettings(shuffled), c2 = s.parseCampaigns(shuffled), l2 = s.parseLeave(shuffled);
ok('settings survive 2 inserted rows at the top', r2.foundCount === 19 && r2.settings.distEnd === 18);
ok('campaigns survive it', c2.campaigns.length === 3);
ok('leave survives it, row numbers shift correctly', l2.leave.length === 1 && l2.leave[0].row === PAGE.findIndex(x => x[0] === 'ADIB') + 3);

console.log(`\n${n - fail}/${n} passed`);
process.exit(fail ? 1 : 0);
