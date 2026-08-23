// Tests for repname.js — one name per salesperson. Run: node repname_test.js
//
// Fixtures are REAL values pulled from Lark on 2026-08-22/23, not invented ones. The two failures
// this module exists to prevent are both represented and both asserted directly:
//   • one person rendered as two   (Shahrin / shahrinjamaluddin)
//   • three people rendered as one (Muhamad / Muhammad / Mohamad)
const R = require('./repname');

let pass = 0, fail = 0;
const ok = (c, n) => { c ? (pass++, console.log('✅', n)) : (fail++, console.log('❌', n)); };

// The real roster keys from index.js STAFF.
const KEYS = ['Nabil', 'Jebat', 'Allysa', 'Azwin', 'Amirul', 'Nazrin', 'Aso', 'Adib', 'Syahrin',
  'Jue', 'Fazwan', 'Azrul', 'Amir', 'Bella', 'Anis', 'Syafa', 'Syaza', 'Roy', 'Zeera', 'Ikhwan'];
const n = (s) => R.nameOf(s, KEYS);

// ── 🚨 THE BUG THAT SHIPPED: three different people, three near-identical labels ──────────
{
  ok(n('MUHAMAD AMIRUL BIN KAMARULZAMAN') === 'Amirul', 'Amirul resolves from a full Malay name');
  ok(n('Muhammad Fazwan Bin Zabidi') === 'Fazwan', 'Fazwan resolves from a full Malay name');
  ok(n('Mohamad Amir') === 'Amir', 'Amir resolves from a full Malay name');
  const three = new Set([n('MUHAMAD AMIRUL BIN KAMARULZAMAN'), n('Muhammad Fazwan Bin Zabidi'), n('Mohamad Amir')]);
  ok(three.size === 3,
     '🚨 the three stay THREE PEOPLE — the shipped card showed Muhamad/Muhammad/Mohamad and they read as one');
  // 🚨 The specific collision that makes prefix-matching dangerous.
  ok(n('MUHAMAD AMIRUL BIN KAMARULZAMAN') !== 'Amir',
     '🚨 Amirul is NEVER folded into Amir — whole-token equality outranks prefix, or a person disappears');
  ok(n('Amirul') === 'Amirul' && n('Amir') === 'Amir', 'and both keys still resolve to themselves');
}

// ── 🚨 THE OTHER BUG: one person rendered as two ──────────────────────────────────────────
{
  ok(n('shahrinjamaluddin') === 'Syahrin', 'Lark display name → roster key (Benjamin-confirmed alias)');
  ok(n('Shahrin') === 'Syahrin', 'the roster-key spelling in SLA Reassigned From → the same person');
  ok(n('Shahrin') === n('shahrinjamaluddin'),
     '🚨 the late list and the scoreboard now name this person IDENTICALLY — the 22 Aug card split them into two rows');
  ok(n('Syahrin') === 'Syahrin', 'and the canonical spelling is unchanged');
}

// ── Real Lark values seen on 21-22 Aug ────────────────────────────────────────────────────
{
  const cases = [
    ['Raja Azrul Hisham ', 'Azrul'], ['Nabil Syahmi', 'Nabil'], ['Syaza Rahman', 'Syaza'],
    ['Roy Abdullah', 'Roy'], ['SyafaShrom', 'Syafa'], ['adib', 'Adib'], ['anis', 'Anis'],
    ['jebat', 'Jebat'], ['jue', 'Jue'], ['Aso', 'Aso'], ['Allysa', 'Allysa'],
    ['Nazrin', 'Nazrin'], ['Fazwan', 'Fazwan'],
    ['Adib Tm Motoworld', 'Adib'], ['TMM - Zeera', 'Zeera'], ['Anis TM MOTOWORLD', 'Anis'],
    ['Jebat Tmm Klang', 'Jebat'], ['AZRUL Sales Executiv', 'Azrul'],
  ];
  for (const [raw, want] of cases) ok(n(raw) === want, `'${raw}' → ${want} (got ${n(raw)})`);
  ok(n('SyafaShrom') === 'Syafa', 'a key glued to another word resolves by ≥5-char prefix');
}

// ── Honesty: an unknown person appears BY NAME, never in an "(other)" bucket ──────────────
{
  const u = R.canonical('Farhan Bin Ismail', KEYS);
  ok(u.resolved === false, 'a name the roster does not know is marked unresolved');
  ok(u.name === 'Farhan', '🚨 and still appears BY NAME — a whole person must not vanish into a bucket');
  ok(R.canonical('adib', KEYS).resolved === true, 'a known name is marked resolved');
  const blank = R.canonical('', KEYS);
  ok(blank.name === '?' && blank.resolved === false, 'blank is "?", never silently attached to someone');
  ok(R.canonical(null, KEYS).name === '?', 'null is handled');
  ok(n('Tm Motoworld') === 'Tm' || R.canonical('Tm Motoworld', KEYS).resolved === false,
     'a company-only string never resolves to a person');
}

// ── Never invent a merge ──────────────────────────────────────────────────────────────────
{
  // 🚨 Every alias is a human decision. If someone adds one carelessly, this test is the tripwire:
  // it asserts the alias table only ever points AT a real roster key.
  for (const [from, to] of Object.entries(R.ALIASES))
    ok(KEYS.includes(to), `alias '${from}' points at a real roster key ('${to}')`);
  ok(Object.keys(R.ALIASES).length <= 5,
     'the alias table stays small — it is a list of human decisions, not a dumping ground');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
