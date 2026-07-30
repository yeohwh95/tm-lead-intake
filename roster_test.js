// Tests for roster.js — parsing the Salesman Availability sheet into pools/staff.
// Run: node roster_test.js
const { parseRoster, diffRoster, normPhone, POOL_KEYS } = require('./roster');

let pass = 0, fail = 0;
const ok = (n, c) => { console.log((c ? '✅ ' : '❌ ') + n); c ? pass++ : fail++; };
const eq = (n, a, b) => ok(`${n} (got ${JSON.stringify(a)})`, JSON.stringify(a) === JSON.stringify(b));

const HDR = ['Salesman Name', 'Available?', 'Branch', 'Phone', 'Lark ID', 'Notes'];
// the exact live roster spelling used in index.js, so canonicalisation is exercised
const KNOWN = ['Nabil','Jebat','Allysa','Azwin','Amirul','Nazrin','Aso','Adib','Syahrin','Jue',
               'Fazwan','Azrul','Amir','Bella','Anis','Syafa','Syaza','Roy','Zeera','Ikhwan'];

console.log('\n--- phone normalisation (the formats actually in the sheet) ---');
eq('012-817 4828',   normPhone('012-817 4828'),   '+60128174828');
eq('011-1858 3259',  normPhone('011-1858 3259'),  '+601118583259');
eq('017-886 9542',   normPhone('017-886 9542'),   '+60178869542');
eq('already +60',    normPhone('+60128174828'),   '+60128174828');
eq('bare 60…',       normPhone('60128174828'),    '+60128174828');
eq('blank',          normPhone(''),               '');

console.log('\n--- branch → pools ---');
let r = parseRoster([HDR,
  ['NABIL','YES','Klang','012-416 4828','ou_nabil',''],
  ['ROY','YES','Shah Alam','012-265 3259','ou_roy',''],
  ['ADIB','YES','HQ','017-886 9542','ou_adib',''],
  ['BELLA','YES','Honda','010-969 3259','ou_bella',''],
], KNOWN);
eq('Klang → KS only',              r.pools.KS.includes('Nabil') && !r.pools.ShahAlam.includes('Nabil'), true);
eq('Shah Alam → KS AND ShahAlam',  r.pools.KS.includes('Roy') && r.pools.ShahAlam.includes('Roy'), true);
eq('HQ → HQ',                      r.pools.HQ, ['Adib']);
eq('Honda → Honda',                r.pools.Honda, ['Bella']);
ok('SHOUTED sheet names canonicalise to code spelling', !!r.staff.Nabil && !r.staff.NABIL);
eq('phone normalised into staff',  r.staff.Roy.phone, '+60122653259');

console.log('\n--- Available? ---');
r = parseRoster([HDR,
  ['NAZRIN','YES','Shah Alam','012-398 4828','ou_n',''],
  ['AMIRUL','NO','Shah Alam','010-899 7920','ou_a',''],
], KNOWN);
eq('NO → unavailable set',        [...r.unavailable], ['amirul']);
ok('NO still stays IN the pool (paused, not removed)', r.pools.ShahAlam.includes('Amirul'));
ok('available flag set correctly', r.staff.Nazrin.available === true && r.staff.Amirul.available === false);
r = parseRoster([HDR, ['ASO','maybe','HQ','012-767 4828','ou_x','']], KNOWN);
ok('garbage Available? warns', r.warnings.some(w => /expected YES or NO/.test(w)));
ok('garbage Available? treated as available', r.staff.Aso.available === true);

console.log('\n--- blank / bad Branch ---');
r = parseRoster([HDR, ['AZWIN','NO','','012-482 8409','ou_az','resigned']], KNOWN);
ok('blank Branch → in no pool at all', POOL_KEYS.every(k => !r.pools[k].includes('Azwin')));
ok('blank Branch is NOT a warning (deliberate for leavers)', !r.warnings.some(w => /Azwin/.test(w) && /Branch/.test(w)));
ok('but still listed in staff (kept for history)', !!r.staff.Azwin);
r = parseRoster([HDR, ['NABIL','YES','Kajang','012-416 4828','ou_n','']], KNOWN);
ok('unknown Branch warns', r.warnings.some(w => /unknown Branch "Kajang"/.test(w)));
ok('unknown Branch → no leads', POOL_KEYS.every(k => !r.pools[k].includes('Nabil')));

console.log('\n--- safety: never route a lead to someone uncontactable ---');
r = parseRoster([HDR, ['JUE','YES','Klang','','ou_jue','']], KNOWN);
ok('Branch set but NO phone → excluded from rotation', !r.pools.KS.includes('Jue'));
ok('…and warns why', r.warnings.some(w => /NO phone/.test(w) && /excluded/.test(w)));
r = parseRoster([HDR, ['IKHWAN','YES','HQ','012-959 3259','','']], KNOWN);
ok('no Lark ID → STILL gets leads (DMs work)', r.pools.HQ.includes('Ikhwan'));
ok('…but warns about the CRM cell', r.warnings.some(w => /no Lark ID/.test(w)));

console.log('\n--- malformed input must never silently produce an empty roster ---');
eq('empty rows → ok:false',   parseRoster([], KNOWN).ok, false);
eq('header only → ok:false',  parseRoster([HDR], KNOWN).ok, false);
ok('…and says so loudly', parseRoster([HDR], KNOWN).warnings.some(w => /ZERO rows/.test(w)));
ok('null input tolerated', parseRoster(null, KNOWN).ok === false);
r = parseRoster([HDR, ['NABIL','YES','Klang','012-416 4828','ou_n',''], [], ['','',''], ['ROY','YES','HQ','012-265 3259','ou_r','']], KNOWN);
eq('blank rows in the middle are skipped', Object.keys(r.staff).length, 2);
r = parseRoster([HDR, ['NABIL','YES','Klang','012-416 4828','ou_n',''], ['nabil','NO','HQ','019-999 9999','ou_dup','']], KNOWN);
ok('duplicate name warns', r.warnings.some(w => /duplicate row/.test(w)));
eq('duplicate ignored, first wins', r.staff.Nabil.branch, 'Klang');
ok('every empty pool is flagged', parseRoster([HDR, ['ADIB','YES','HQ','017-886 9542','ou_a','']], KNOWN).warnings.filter(w => /is EMPTY/.test(w)).length === 3);

console.log('\n--- diffRoster (guards the shadow rollout) ---');
const sheet = parseRoster([HDR,
  ['NABIL','YES','Klang','012-416 4828','ou_nabil',''],
  ['ADIB','YES','HQ','017-886 9542','ou_adib',''],
], KNOWN);
eq('identical → no diff',
   diffRoster(sheet, { Nabil:{phone:'+60124164828',openId:'ou_nabil'}, Adib:{phone:'+60178869542',openId:'ou_adib'} },
              { KS:['Nabil'], HQ:['Adib'], Honda:[], ShahAlam:[] }), []);
let d = diffRoster(sheet, { Nabil:{phone:'+60124164828',openId:'ou_nabil'} }, { KS:['Nabil'], HQ:[], Honda:[], ShahAlam:[] });
ok('spots someone on the sheet but not in code', d.some(x => /\+ Adib/.test(x)));
d = diffRoster(sheet, { Nabil:{phone:'+60124164828',openId:'ou_nabil'}, Adib:{phone:'+60178869542',openId:'ou_adib'}, Ghost:{phone:'+60111',openId:'ou_g'} },
               { KS:['Nabil'], HQ:['Adib'], Honda:[], ShahAlam:[] });
ok('spots someone in code but not on the sheet', d.some(x => /- Ghost/.test(x)));
d = diffRoster(sheet, { Nabil:{phone:'+60199999999',openId:'ou_nabil'}, Adib:{phone:'+60178869542',openId:'ou_WRONG'} },
               { KS:['Nabil'], HQ:['Adib'], Honda:[], ShahAlam:[] });
ok('spots a phone mismatch',   d.some(x => /~ Nabil: phone/.test(x)));
ok('spots a Lark ID mismatch', d.some(x => /~ Adib: Lark ID/.test(x)));
d = diffRoster(sheet, { Nabil:{phone:'+60124164828',openId:'ou_nabil'}, Adib:{phone:'+60178869542',openId:'ou_adib'} },
               { KS:['Nabil','Adib'], HQ:[], Honda:[], ShahAlam:[] });
ok('spots a pool membership mismatch', d.some(x => /~ pool KS/.test(x)));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
