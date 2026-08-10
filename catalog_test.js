// catalog_test.js — regression guard for the R1/R15 incident (2026-08-10).
// Run: node catalog_test.js
const c = require('./catalog');
const RE_BIKE = require('./firstresponse').RE_BIKE;

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond){ pass++; console.log('✅ ' + msg); } else { fail++; console.log('❌ ' + msg); } };

// Real titles pulled live from tmmotoworld.com on 2026-08-10.
const CAT = [
  { name: '2018 Yamaha R15 | Kuning' },
  { name: 'YAMAHA YZF-R15 V3 2020' },
  { name: 'NEW YAMAHA R15M' },
  { name: '2015 Yamaha MT-09 V1 | Grey' },
  { name: '2022 Honda Forza 250 | Black' },
  { name: 'Honda Forza 300' },
  { name: '2018 Yamaha Avantiz 125' },
  { name: '2024 Yamaha XMAX 250 | Blue | RCB Rear Suspension' },
  { name: '2022 Honda ADV 150 | Black' },
  { name: '2021 Honda CBR250RR' },
  { name: '2012 Kawasaki ER6N | Red | Windshield' },
  { name: 'Kawasaki ER-6F' },
  { name: '2021 KTM ADV 250' },
  { name: 'NEW KTM DUKE 250 LIMITED TIME PROMO' },
  { name: 'ZONTES 368G V1' },
  { name: '2022 Suzuki Vstrom 650 | CBU Import Japan Bike' },
];
const hit = q => c.matches(CAT, q, RE_BIKE).hits.map(p => p.name);
const toks = q => c.matches(CAT, q, RE_BIKE).toks;

// ---- THE INCIDENT: the customer asked for an R1 and was offered three R15s ----
ok(hit('Yamaha R1 ada ke cik').length === 0, 'R1 matches NOTHING — TM has never stocked one');
ok(hit('BOS ITU R1 ADA LAGI?').length === 0, 'R1, second real phrasing, also matches nothing');
ok(hit('r15 ada?').length === 3, 'R15 still finds all three R15 listings (no over-correction)');
ok(hit('yzf-r15 v3 ada').some(n => /YZF-R15 V3/.test(n)), 'the exact R15 V3 still resolves');

// ---- the same substring class, elsewhere in the real catalog ----
ok(!hit('Z1 ada').some(n => /Avantiz/.test(n)), 'z1 no longer matches "avanti-z1-25"');
ok(!hit('CBR 25 ada').some(n => /XMAX/.test(n)), 'cbr no longer matches the "RCB Rear" accessory note');
ok(!hit('CB 150 ada?').some(n => /ADV 150/.test(n)), 'CB 150 no longer answers with a Honda ADV 150');
ok(hit('CB 150 ada?').length === 0, 'CB 150 matches nothing — TM has no CB150');

// ---- brands must NOT glue to a following number, models must ----
ok(toks('CB 150 ada?').includes('cb150'), 'model letters + number join: cb150');
ok(toks('mt 09 ada').includes('mt09'), 'model letters + number join: mt09');
ok(toks('KTM 250 ada').includes('ktm') && toks('KTM 250 ada').includes('250'), 'a BRAND never glues to its number');
ok(hit('KTM 250 ada').some(n => /KTM ADV 250/.test(n)), 'so "KTM 250" still finds the KTM 250s');

// ---- hyphens, spacing and title noise must not break real matches ----
ok(hit('Hi. Nak tanya mt09').length === 1 && /MT-09/.test(hit('Hi. Nak tanya mt09')[0]), 'mt09 finds "MT-09" across the hyphen');
ok(hit('er6n ada').some(n => /ER6N/.test(n)), 'er6n finds ER6N');
ok(hit('er6f ada').some(n => /ER-6F/.test(n)), 'er6f finds "ER-6F" across the hyphen');
ok(hit('368g ada').some(n => /368G/.test(n)), 'a model code with a trailing letter resolves');
ok(hit('vstrom 650 ada').some(n => /Vstrom 650/.test(n)), 'vstrom 650 resolves despite the long title suffix');
ok(hit('cbr250 ada').some(n => /CBR250RR/.test(n)), 'cbr250 IS allowed to prefix cbr250rr — the cut is not mid-number');

// ---- filler words must never reach the matcher (the 2026-07-24 ER6N poisoning) ----
ok(!toks('vulcan ada stok tak').includes('ada'), '"ada" is never a model token');
ok(!toks('nak tanya harga').length, 'a message naming no model yields no tokens at all');

// ---- forza: the exact pair behind the RM 20,800 / RM 28,800 incident ----
ok(hit('forza 250 baru ada?').length === 1 && /Forza 250/.test(hit('forza 250 baru ada?')[0]), 'forza 250 resolves to the 250 only, never the 300');
ok(!hit('forza 250 baru ada?').some(n => /Forza 300/.test(n)), 'forza 250 does not drag in the Forza 300');

// ---- the "wants a NEW one" reader (firstresponse.js) ----
const RE_NEW = /\bbrand[\s-]*new\b|\bnew\s+(?:unit|bike|motor|stock|one)\b|\bbaru\b(?!\s+(?:nak|nk|je|sahaja|saja|beli|dapat|dpt|tanya|tny|lepas|balik|masuk|sampai))/i;
ok(RE_NEW.test('Hai nak tanya forza 250 baru ada?'), 'the real "forza 250 baru" reads as wanting a NEW unit');
ok(RE_NEW.test('ada xmax baru?'), 'adjective "baru" after the model reads as new');
ok(!RE_NEW.test('baru nak tanya harga mt09'), '"baru nak tanya" (just wanted to ask) is NOT a new-bike request');
ok(!RE_NEW.test('saya baru beli ax200 bulan 2'), '"baru beli" (just bought) is NOT a new-bike request');
ok(RE_NEW.test('any brand new unit?'), 'english brand-new reads as new');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
