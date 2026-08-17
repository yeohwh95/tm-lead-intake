// Tests for orphan.js — the recovery of Lark rows with a phone but NO salesperson.
// Run: node orphan_test.js
//
// The fixtures are the REAL rows this was built for: the single unassigned lead of 17 Aug and the
// 31 Jul - 1 Aug orphans. If a change makes these stop being recovered, it has reintroduced the bug.
const O = require('./orphan');

let pass = 0, fail = 0;
const ok = (c, n) => { c ? (pass++, console.log('✅', n)) : (fail++, console.log('❌', n)); };

const NOW = Date.parse('2026-08-18T02:00:00Z');        // Tue 18 Aug 10:00 MYT
const HOUR = 3600e3, DAY = 24 * HOUR;
const row = (id, over) => ({ record_id: id, fields: Object.assign({
  'Origin': 'WhatsApp Direct', 'Phone number': '60186682249', 'Brand': 'HQ',
  'Customer want': 'Hello! Can I get more info on this?',
  'date created': NOW - 2 * HOUR,
}, (over || {})) });
// Cutoff = 10 Aug, so the 31 Jul / 1 Aug orphans are protected and anything recent is fair game.
const CUT = Date.parse('2026-08-10T00:00:00Z');
const pick = (items, o) => O.pickCandidates(items, Object.assign({ now: NOW, cutoffMs: CUT }, o || {}));

// ── 1. the real 17 Aug orphan is recovered ─────────────────────────────────
{
  const c = pick([row('recvsxMygfsDYU')]);
  ok(c.length === 1, '🚨 the real 17 Aug orphan (+60186682249) IS picked up');
  ok(c[0].phone === '60186682249', 'phone is carried through, digits only');
  ok(c[0].brand === 'HQ' && /more info/.test(c[0].want), 'brand and want carried for the rep DM');
  ok(c[0].tries === 0, 'a fresh orphan starts at zero attempts');
}

// ── 2. 🚨 rows we must NEVER touch ─────────────────────────────────────────
{
  ok(pick([row('a', { 'Salesman': [{ id: 'ou_x', name: 'Adib' }] })]).length === 0,
     '🚨 a row WITH a salesperson is never touched (no double assignment)');
  ok(pick([row('b', { 'SLA Assigned At': 1786958213000 })]).length === 0,
     '🚨 a row already on the SLA clock is never touched');
  ok(pick([row('c', { 'Origin': 'Ads Tiktok' })]).length === 0,
     '🚨 TikTok rows are out of scope — sync.py assigns those, two assigners = two salespeople');
  ok(pick([row('d', { 'Origin': 'Tiktok DM' })]).length === 0, 'Tiktok DM likewise out of scope');
  ok(pick([row('e', { 'Phone number': '' })]).length === 0,
     'no phone: nothing a rep could do, so it is not a recovery candidate');
  ok(pick([row('f', { 'Phone number': '447911123456' })]).length === 0,
     'junk 447* number is refused, same guard as intake');
  ok(pick([row('g', { 'Phone number': '12345678901234567' })]).length === 0,
     'over-long number is refused rather than handed to a rep');
}

// ── 3. 🚨 THE HISTORICAL ROWS STAY UNTOUCHED (Benjamin, 2026-08-17) ────────
// The 15 stuck leads are 11-17 days old. Auto-assigning them to a rep with no warning creates a
// worse problem than leaving them. The cutoff is what guarantees that, and it is the same shape as
// SLA_SWEEP_FROM, including "0 means recover nothing".
{
  const old31Jul = row('recvqWC7aSoj5n', { 'date created': Date.parse('2026-07-31T10:14:00Z'),
    'Phone number': '60126233609', 'Customer want': 'Hii Saya tengah cari motor' });
  ok(pick([old31Jul]).length === 0, '🚨 the 31 Jul orphans are NOT auto-assigned (pre-cutoff)');
  ok(O.pickCandidates([row('h')], { now: NOW, cutoffMs: 0 }).length === 0,
     '🚨 cutoff 0 recovers NOTHING — the feature is off until deliberately armed');
}

// ── 4. a lead still legitimately in flight is not an orphan ────────────────
{
  ok(pick([row('i', { 'date created': NOW - 60e3 })]).length === 0,
     'a lead 1 minute old is mid-flight, not orphaned');
  ok(pick([row('j', { 'date created': NOW - 21 * 60e3 })]).length === 1,
     'past the 20-minute grace it becomes a candidate');
}

// ── 5. attempts, and the 3-strike rule that governs the REPORT ─────────────
{
  let st = {};
  st = O.recordAttempt(st, 'r1', false, 'no rep available', NOW);
  ok(st.r1.tries === 1 && /no rep/.test(st.r1.lastError), 'a failure records the try and the reason');
  ok(O.needsHuman(st).length === 0, '🚨 after 1 failure it is NOT reported — the bot retries silently');
  st = O.recordAttempt(st, 'r1', false, 'send failed', NOW + 1000);
  ok(O.needsHuman(st).length === 0, 'after 2 failures still not reported');
  st = O.recordAttempt(st, 'r1', false, 'send failed', NOW + 2000);
  ok(O.needsHuman(st).length === 1, '🚨 only after the 3rd failure does a human hear about it');
  ok(O.needsHuman(st)[0].recordId === 'r1', 'and it names the record');
  // Exhausted rows stop being retried, or the sweep would spin on them forever.
  ok(pick([row('r1')], { state: st }).length === 0, 'an exhausted lead is no longer retried');

  // 🚨 A success must leave NO trace: the row stops matching the Lark filter, so a kept entry only rots.
  let st2 = O.recordAttempt({ r2: { tries: 2, firstSeen: NOW } }, 'r2', true, null, NOW);
  ok(st2.r2 === undefined, '🚨 a successful recovery deletes the entry, it is never reported');
  ok(O.needsHuman(st2).length === 0, 'and nothing reaches the report');
}

// ── 6. state hygiene ───────────────────────────────────────────────────────
{
  const st = { keep: { tries: 3 }, gone: { tries: 3 } };
  const pruned = O.pruneState(st, ['keep']);
  ok(pruned.keep && !pruned.gone,
     'a row a human assigned in the meantime drops out instead of nagging forever');
  ok(O.needsHuman({ a: { tries: 3, firstSeen: NOW }, b: { tries: 3, firstSeen: NOW - DAY } })[0].recordId === 'b',
     'the human list is oldest-first, like every other attention list');
}

// ── 7. Lark timestamp shapes ───────────────────────────────────────────────
{
  ok(O.createdMs({ 'Created on': 1786958213000 }) === 1786958213000, 'reads Created on');
  ok(O.createdMs({ 'date created': 1786958213000 }) === 1786958213000, 'reads date created');
  ok(O.createdMs({}) === 0, 'no timestamp reads as 0, which the cutoff then refuses');
  ok(pick([row('k', { 'date created': null, 'Created on': null, 'Last modified on': null })]).length === 0,
     '🚨 a row with no readable timestamp is refused, never aged to 1970 and swept');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
