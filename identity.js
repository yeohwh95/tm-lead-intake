// Who is this sender? — answered from their PHONE NUMBER, never from their WhatsApp display name.
//
// WHY THIS FILE EXISTS (incident 2026-07-30):
// `matchStaff()` in index.js is deliberately FUZZY (prefix match + Levenshtein ≤2) because staff type
// roster names loosely in file captions — "nabeel" must reach Nabil. That helper was then reused to
// answer a completely different question: "is this inbound message from one of our reps?" A WhatsApp
// pushname is chosen by the SENDER, so fuzzy-matching it let customers impersonate reps:
//
//   pushname "Joel"  → Jue    (edit distance 2)   ← customer +60129717912, enquiry never answered
//   pushname "amer"  → Amir   (edit distance 1)
//   pushname "fa"    → Fazwan (prefix match)
//
// Each match was treated as that rep acknowledging their leads: the customer got no reply at all
// (the handler short-circuited), and the rep was credited with a response they never made.
// 3 of 16 acknowledgements in 28 hours were really customers.
//
// Rule: identity comes from the phone number. These helpers are pure so they can be unit-tested
// (index.js boots a server on require, so logic living there is effectively untestable).

const digitsOf = (v) => String(v == null ? '' : v).replace(/\D/g, '');

// STAFF phone → name, keyed on the last 9 digits (numbers appear as +60…, 60…, 0… across sources).
function byLast9(STAFF) {
  const out = {};
  for (const [name, v] of Object.entries(STAFF || {})) {
    const d = digitsOf(v && v.phone);
    if (d.length >= 9) out[d.slice(-9)] = name;
  }
  return out;
}

// The ONLY sanctioned way to turn an inbound sender into a rep name. Returns '' for anyone unknown —
// and '' must never be treated as a match by the caller.
function nameByPhone(map, phone) {
  const d = digitsOf(phone);
  return d.length >= 9 ? ((map || {})[d.slice(-9)] || '') : '';
}

// Lark openId → { name, phone }. MUST skip blank openIds: a rep awaiting their real Lark id carries
// `openId: ''` (Ikhwan, added 07-29), and every reverse lookup reads `Salesman[0]?.id || ''`. With a
// literal "" key present, ANY Lark row with no Salesman resolved to that rep — which is how Fitri's
// 3 trade-in rows (deliberately Salesman-less, but SLA-stamped) were restored onto Ikhwan's SLA clock
// and reported to the client as his 3 missed follow-ups. Never key a map on a falsy id.
function byOpenId(STAFF) {
  const out = {};
  for (const [name, v] of Object.entries(STAFF || {})) {
    if (!v || !v.openId) continue;
    out[v.openId] = { name, phone: v.phone };
  }
  return out;
}

// Roster drift must be LOUD. Both of these were real, silent failures:
//   • blank openId  → the collision above
//   • last-9 clash  → two reps indistinguishable by phone (checked BY HAND for Ikhwan vs Jue on 07-29;
//                     automated here so the next roster edit can't quietly reintroduce it)
function rosterWarnings(STAFF) {
  const warns = [];
  const blank = Object.entries(STAFF || {}).filter(([, v]) => !v || !v.openId).map(([n]) => n);
  if (blank.length) warns.push(`no Lark openId for ${blank.join(', ')} — excluded from openId lookups (by design); read the real id off one row they assign`);
  const seen = {};
  for (const [name, v] of Object.entries(STAFF || {})) {
    const d = digitsOf(v && v.phone);
    if (d.length < 9) { warns.push(`${name} has no usable phone (${v && v.phone}) — cannot be identified on reply`); continue; }
    const k = d.slice(-9);
    if (seen[k]) warns.push(`PHONE COLLISION: ${seen[k]} and ${name} share the last 9 digits ${k} — replies cannot be told apart`);
    else seen[k] = name;
  }
  return warns;
}

module.exports = { byLast9, nameByPhone, byOpenId, rosterWarnings, digitsOf };
