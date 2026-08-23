// repname.js — ONE name per salesperson, everywhere (2026-08-23).
//
// 🚨 WHY THIS EXISTS. The 22 Aug sales card listed the SAME PERSON TWICE, in one message:
//     🔴 waited over 75 min:        ⏱️ Response speed:
//        Shahrin            1          Shahrinjamaluddin  4 leads
//        Shahrinjamaluddin  1
// The late list was built from Lark's `SLA Reassigned From` (which stores a roster KEY) and the
// scoreboard from `Salesman` (which stores whatever a human typed into Lark). Two vocabularies for
// one person, on one card, so a reader could not match them up — and one rep's misses were split
// across two rows, understating both.
//
// 🚨 AND THE OPPOSITE FAILURE, WHICH IS WORSE. The card shortened every name to its first word:
//     'MUHAMAD AMIRUL BIN KAMARULZAMAN' → Muhamad
//     'Muhammad Fazwan Bin Zabidi'      → Muhammad
//     'Mohamad Amir'                    → Mohamad
// THREE DIFFERENT PEOPLE (Amirul, Fazwan, Amir) rendered as three near-identical labels. Benjamin
// read that as one person spelled three ways and approved merging them; merging would have erased
// three real salespeople from the scoreboard. Malay names begin with a shared honorific far more
// often than they end with one — **the first token is the LEAST identifying part of the name.**
//
// So: resolve to the roster, never to a substring of convenience. `STAFF` in index.js is the one
// list of real people; every name on every card must come back as one of its keys or be honestly
// marked unresolved.
//
// Pure functions — index.js boots an HTTP server on require and cannot host tested logic (same
// reason as identity.js / roster.js / hours.js / leadsummary.js / cardsched.js).

// Spellings that no rule can derive, only a human can confirm.
// 🚨 Benjamin confirmed 2026-08-23: `shahrinjamaluddin` (Lark) IS `Syahrin` (roster). The roster
// spells it Sy-, Lark spells it Sh-, so no prefix or token rule can ever bridge them. Anything
// added here is a HUMAN DECISION about who two names refer to — never a guess, because a wrong
// entry silently merges two people's numbers and nothing downstream can detect it.
const ALIASES = {
  shahrin: 'Syahrin',
  shahrinjamaluddin: 'Syahrin',
  syahrinjamaluddin: 'Syahrin',
};

// Letters only, lowercased — Lark carries 'TMM - Zeera', 'Adib Tm Motoworld', trailing spaces and
// mixed case for the same person.
const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z]/g, '');
const tokens = (s) => String(s == null ? '' : s).toLowerCase().split(/[^a-z]+/).filter(Boolean);
const title = (s) => String(s || '').replace(/^(\w)(\w*)$/, (m, a, b) => a.toUpperCase() + b.toLowerCase());

// Company words that are never a person. Without this, 'Adib Tm Motoworld' can match a roster key
// through a company token if one ever collides.
const NOISE = new Set(['tm', 'tmm', 'motoworld', 'moto', 'sales', 'executive', 'executiv', 'bin', 'binti', 'bt']);

// Resolve `raw` (a Lark `Salesman` display name, or an `SLA Reassigned From` roster key) to exactly
// one roster key. `keys` = Object.keys(STAFF).
//
// Order matters, and every tier is narrower than the one below it:
//   1. exact match on the whole normalised string      'adib'                    → Adib
//   2. explicit human-confirmed alias                  'shahrinjamaluddin'       → Syahrin
//   3. a WHOLE TOKEN equals a roster key               'MUHAMAD AMIRUL BIN ...'  → Amirul
//   4. a token STARTS WITH a roster key (≥5 chars)     'SyafaShrom'              → Syafa
//   5. unresolved — returned title-cased, never merged
//
// 🚨 TIER 3 BEFORE TIER 4 IS THE WHOLE POINT. 'Amir' is a roster key AND a prefix of the token
// 'AMIRUL'. Prefix-first would fold Amirul into Amir and delete a person. Whole-token equality wins
// first, and tier 4 requires ≥5 characters so a short key can never swallow a longer name.
// Within a tier the LONGEST key wins, for the same reason.
function canonical(raw, keys){
  const all = (keys || []).slice();
  const n = norm(raw);
  if (!n) return { name: '?', resolved: false };

  const byNorm = new Map(all.map(k => [norm(k), k]));
  if (byNorm.has(n)) return { name: byNorm.get(n), resolved: true };
  if (ALIASES[n] && byNorm.has(norm(ALIASES[n]))) return { name: byNorm.get(norm(ALIASES[n])), resolved: true };

  const toks = tokens(raw).filter(t => !NOISE.has(t));
  const longest = (cands) => cands.sort((a, b) => b.length - a.length)[0];

  const exact = longest(all.filter(k => toks.includes(norm(k))));
  if (exact) return { name: exact, resolved: true };

  const pre = longest(all.filter(k => norm(k).length >= 5 && toks.some(t => t.startsWith(norm(k)))));
  if (pre) return { name: pre, resolved: true };

  // 🚨 Unresolved is NOT merged into an "(other)" bucket. A salesperson the roster does not know
  // must appear by name the first day they appear, or a whole person's misses go unreported behind
  // a label nobody investigates. `resolved:false` lets the caller flag it.
  return { name: title(tokens(raw)[0] || n), resolved: false };
}

// Convenience for callers that only want the string.
const nameOf = (raw, keys) => canonical(raw, keys).name;

module.exports = { canonical, nameOf, ALIASES };
