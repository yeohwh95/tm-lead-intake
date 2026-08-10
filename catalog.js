// catalog.js — matching a customer's words against WooCommerce product NAMES.
//
// Extracted from index.js 2026-08-10 so it can be unit-tested (index.js boots a server on require).
// Pure functions only: no network, no state.
//
// 🚨 WHY THIS EXISTS — the R1/R15 incident (2026-08-10).
// The matcher used to be `alnum(name).includes(token)` — a bare substring test over the whole
// concatenated title. `"r1"` is inside `"r15"`, so a customer asking for a Yamaha R1 (a bike TM has
// never stocked) was offered three R15s at RM 4,880–14,598, and Adib had to type "R1 tak ada stock
// tuan" four minutes later. The same shape bit elsewhere: `"z1"` ⊂ "avanti**z1**25", and `"cbr"` ⊂
// "R**CB R**ear" — an accessory note in a title.
//
// The rule now: a token must land on a CLEAN EDGE. Equal to a name token, or a prefix of one that
// does not cut a number in half.  ⚠️ Do not "simplify" this back to includes().

const alnum = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// A brand is NEVER glued to a following number: "KTM 250" is a brand + a displacement, whereas
// "CB 150" / "MT 09" are one model split by a space. Get this backwards and you either lose real
// matches (ktm250 matches nothing) or keep the bug where "CB 150" answered with a Honda ADV 150.
const BRANDS = new Set(['yamaha','honda','suzuki','kawasaki','ktm','bmw','ducati','aprilia','triumph',
  'benelli','cfmoto','harley','agusta','enfield','modenas','lambretta','vespa','zontes','sym','wmoto',
  'gpx','keeway','aveta','moda','qjmoto','qj','royal','morini','afaz','ktns','thunder']);

// Model tokens = RE_BIKE brand/model words + digit-bearing tokens ("368D", "mt07"), nothing else —
// filler ("ada", "stok", "lg") is what poisoned the old WP-search queries.
function modelTokens(text, reBike){
  const words = String(text || '').replace(/[^\w\s-]/g, ' ').split(/\s+/).filter(Boolean).map(w => w.toLowerCase());
  const cand = [], skip = new Set();
  for (let i = 0; i < words.length; i++){
    const a = words[i], b = words[i + 1];
    if (b && /^[a-z]+$/.test(a) && !BRANDS.has(a) && a.length <= 4 && /^\d+$/.test(b)){ cand.push(a + b); skip.add(i + 1); continue; }
    if (!skip.has(i)) cand.push(a);
  }
  return [...new Set(cand.filter(w => reBike.test(w) || /\d/.test(w)).map(alnum).filter(t => t.length >= 2))];
}

// A product name split into whole tokens, PLUS every adjacent pair joined, so a model the team typed
// as "MT-09" is reachable as `mt09` without the whole title collapsing into one string.
function nameTokens(name){
  const raw = String(name || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const out = new Set(raw);
  for (let i = 0; i < raw.length - 1; i++) out.add(raw[i] + raw[i + 1]);
  return [...out];
}

// `r1` vs `r15` → next char is `5` → refused.  `cbr250` vs `cbr250rr` → next char is `r` → allowed.
function tokenHit(tok, nameToks){
  return nameToks.some(n => n === tok || (n.startsWith(tok) && !/\d/.test(n.charAt(tok.length))));
}

function matches(items, text, reBike){
  const toks = modelTokens(text, reBike);
  if (!toks.length) return { toks, hits: [] };
  const hits = (items || []).filter(p => { const nt = nameTokens(p.name); return toks.every(t => tokenHit(t, nt)); });
  return { toks, hits };
}

module.exports = { alnum, BRANDS, modelTokens, nameTokens, tokenHit, matches };
