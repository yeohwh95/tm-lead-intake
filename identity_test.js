// Regression tests for identity.js — every fixture below is a REAL incident from the live logs.
// Run: node identity_test.js
const id = require('./identity');

let pass = 0, fail = 0;
function ok(name, cond){ if (cond) { pass++; console.log('✅ ' + name); } else { fail++; console.log('❌ ' + name); } }
function eq(name, got, want){ ok(name + ` (got ${JSON.stringify(got)})`, got === want); }

// The live roster as of 2026-07-30. Ikhwan's blank openId is deliberate (awaiting his real Lark id).
const STAFF = {
  Nabil:   { phone: '+60124164828', openId: 'ou_nabil' },
  Jebat:   { phone: '+60128674828', openId: 'ou_jebat' },
  Allysa:  { phone: '+60123343259', openId: 'ou_allysa' },
  Azwin:   { phone: '+60124828409', openId: 'ou_azwin' },
  Amirul:  { phone: '+60108997920', openId: 'ou_amirul' },
  Nazrin:  { phone: '+60123984828', openId: 'ou_nazrin' },
  Aso:     { phone: '+60127674828', openId: 'ou_aso' },
  Adib:    { phone: '+60178869542', openId: 'ou_adib' },
  Syahrin: { phone: '+60163488335', openId: 'ou_syahrin' },
  Jue:     { phone: '+60129653259', openId: 'ou_jue' },
  Fazwan:  { phone: '+60128174828', openId: 'ou_fazwan' },
  Azrul:   { phone: '+60102323259', openId: 'ou_azrul' },
  Amir:    { phone: '+60103793259', openId: 'ou_amir' },
  Bella:   { phone: '+60109693259', openId: 'ou_bella' },
  Anis:    { phone: '+60129323259', openId: 'ou_anis' },
  Syafa:   { phone: '+60122623259', openId: 'ou_syafa' },
  Syaza:   { phone: '+60123773259', openId: 'ou_syaza' },
  Roy:     { phone: '+60122653259', openId: 'ou_roy' },
  Zeera:   { phone: '+601118583259', openId: 'ou_zeera' },
  Ikhwan:  { phone: '+60129593259', openId: '' },          // openId PENDING — must not become a map key
};
const LAST9 = id.byLast9(STAFF);
const OPENID = id.byOpenId(STAFF);

console.log('\n--- real customers must NOT resolve to a rep (2026-07-29/30 incidents) ---');
// Each of these customers was mis-identified as a rep by the OLD pushname fuzzy match, swallowing
// their enquiry as that rep's acknowledgement. Identity now comes from the phone, so all three miss.
eq('customer +60129717912 ("Joel", was matched to Jue)',    id.nameByPhone(LAST9, '60129717912'), '');
eq('customer +601128207391 ("amer", was matched to Amir)',   id.nameByPhone(LAST9, '601128207391'), '');
eq('customer +60172384151 ("fa", was matched to Fazwan)',    id.nameByPhone(LAST9, '60172384151'), '');
eq('customer +60186528335 (@lid click-to-chat)',             id.nameByPhone(LAST9, '60186528335'), '');
eq('customer +60145297013 (Fuad, zontes 368e)',              id.nameByPhone(LAST9, '60145297013'), '');

console.log('\n--- real reps still resolve, in every phone format the webhook emits ---');
eq('Jue via bare 60…',        id.nameByPhone(LAST9, '60129653259'), 'Jue');
eq('Roy via +60…',            id.nameByPhone(LAST9, '+60122653259'), 'Roy');
eq('Amir via local 0…',       id.nameByPhone(LAST9, '0103793259'), 'Amir');
eq('Zeera via 11-digit 601…', id.nameByPhone(LAST9, '601118583259'), 'Zeera');
eq('Ikhwan (blank openId still identifies by phone)', id.nameByPhone(LAST9, '60129593259'), 'Ikhwan');

console.log('\n--- a name is never an identity ---');
eq('empty phone',            id.nameByPhone(LAST9, ''), '');
eq('null phone',             id.nameByPhone(LAST9, null), '');
eq('too-short phone',        id.nameByPhone(LAST9, '653259'), '');
eq('a pushname, not a phone', id.nameByPhone(LAST9, 'Joel'), '');

console.log('\n--- blank openId must never be a lookup key (Ikhwan / Fitri trade-in incident) ---');
ok('no "" key in the openId map',            !Object.prototype.hasOwnProperty.call(OPENID, ''));
eq('lookup of "" (row with no Salesman)',    OPENID[''], undefined);
eq('lookup of undefined Salesman id',        OPENID[undefined], undefined);
eq('Ikhwan absent from openId map',          Object.values(OPENID).some(v => v.name === 'Ikhwan'), false);
eq('a real rep still resolves by openId',    (OPENID['ou_jue'] || {}).name, 'Jue');
eq('openId map size = reps with a real id',  Object.keys(OPENID).length, 19);

console.log('\n--- roster drift is reported, not silent ---');
const warns = id.rosterWarnings(STAFF);
ok('flags Ikhwan\'s missing openId', warns.some(w => /openId/.test(w) && /Ikhwan/.test(w)));
ok('live roster has NO phone collision', !warns.some(w => /COLLISION/.test(w)));
ok('detects a last-9 collision if one is introduced',
  id.rosterWarnings({ A: { phone: '+60129653259', openId: 'ou_a' }, B: { phone: '0129653259', openId: 'ou_b' } })
    .some(w => /COLLISION/.test(w) && /129653259/.test(w)));
ok('detects an unusable phone',
  id.rosterWarnings({ A: { phone: '', openId: 'ou_a' } }).some(w => /no usable phone/.test(w)));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
