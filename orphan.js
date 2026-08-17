// orphan.js — recover leads that reached Lark with a PHONE but NO SALESPERSON.
//
// 🚨 WHY THIS EXISTS. `slaSweep` rescues rows that have a salesperson but no SLA clock. Nothing
// rescued the opposite shape: a row with a real phone number and NO salesperson at all. That row is
// invisible to every mechanism we have — `slaSweep` filters `Salesman isNotEmpty`, the SLA engine
// only knows leads it registered, and the drain only knows entries still in its own queue. So it
// sits in the CRM forever looking like a lead and behaving like nothing.
//
// That is the exact signature of the 14 leads lost 31 Jul - 1 Aug, and of the single unassigned
// lead found on 17 Aug (+60186682249, "Hello! Can I get more info on this?"). All of them had a
// phone number. Every one was recoverable in one round-robin call, and nothing ever looked.
//
// 🚨 THE REPORTING RULE THIS SERVES (Benjamin, 2026-08-17), the same one the self-heal alerts use:
//     发现 → 自己 fix → 3 次不行 → 才通知群组
// A lead the bot can rescue by itself must NEVER reach a report. Only after MAX_TRIES failed
// attempts does it become a human's problem, and only then does it earn a line on the sales card.
// A report that lists work the system could have done itself is how a report becomes wallpaper.
//
// Pure functions only — index.js boots a server on require and therefore cannot host tested logic
// (same reason as identity.js / roster.js / hours.js / catalog.js / leadsummary.js).

const MAX_TRIES = 3;
// A lead is not an orphan the moment it lands. The normal path writes the Lark row first and
// assigns immediately after, and the off-hours path deliberately parks it for the 9am drain. Both
// would look like an orphan mid-flight. The grace has to clear the slowest legitimate path.
const MIN_AGE_MS = 20 * 60 * 1000;

const txt = (v) => {
  if (Array.isArray(v)) return v.map(txt).join(' ');
  if (v && typeof v === 'object') return v.text || v.name || '';
  return v == null ? '' : String(v);
};
const digitsOf = (v) => txt(v).replace(/\D/g, '');
// Mirrors slaRecCreated in index.js: Lark exposes the timestamp under whichever of these it feels
// like, and reading only one of them silently ages every row to 1970.
function createdMs(f){
  for (const k of ['date created', 'Created on', 'Last modified on']){
    const n = parseInt(txt(f[k]), 10);
    if (n) return n;
  }
  return 0;
}

// A junk phone is NOT a recoverable lead. These are the same guards firstresponse.js applies at
// intake; without them the sweep would hand a rep a number that cannot be dialled, which is worse
// than leaving the row alone (2026-08-02: a fake phone on a Lark row nobody could call).
function usablePhone(raw){
  const d = digitsOf(raw);
  if (d.length < 9 || d.length > 13) return '';
  if (d.startsWith('447')) return '';
  return d;
}

// ---------------------------------------------------------------------------------------------
// WHICH ROWS ARE ORPHANS
// ---------------------------------------------------------------------------------------------
// `items` are raw Lark records. Caller has already filtered server-side on Salesman isEmpty +
// SLA Assigned At isEmpty; everything here is the safety net that must hold even if that filter
// changes or Lark returns something unexpected.
function pickCandidates(items, opts){
  const o = opts || {};
  const now = o.now == null ? Date.now() : o.now;
  const cutoff = o.cutoffMs || 0;          // 🚨 0 = recover NOTHING. Same shape as SLA_SWEEP_FROM.
  const minAge = o.minAgeMs == null ? MIN_AGE_MS : o.minAgeMs;
  const maxTries = o.maxTries == null ? MAX_TRIES : o.maxTries;
  const state = o.state || {};
  // 🚨 OFF BY DEFAULT, and it must fail CLOSED. Testing `created < cutoff` alone does not disable
  // anything when cutoff is 0 — nothing is less than zero, so every row including the 11-17 day old
  // stuck ones would sweep. An unarmed feature that quietly recovers everything is the opposite of
  // a safety cutoff. Same "0 = disabled" contract as SLA_SWEEP_FROM, but actually enforced.
  if (!cutoff) return [];
  const out = [];
  for (const it of items || []){
    const f = it.fields || {};
    // Salesman present in ANY form means someone owns it. Never touch an owned row.
    const sm = f['Salesman'];
    if (Array.isArray(sm) ? sm.length : !!sm) continue;
    if (txt(f['SLA Assigned At']).trim()) continue;
    // Scope: the bot's own WhatsApp leads. TikTok rows are assigned by sync.py on a different
    // path and a second assigner on the same rows is how one customer gets two salespeople.
    if (txt(f['Origin']).trim() !== 'WhatsApp Direct') continue;
    const phone = usablePhone(f['Phone number']);
    if (!phone) continue;                  // no number ⇒ nothing a rep could do with it anyway
    const created = createdMs(f);
    if (!created || created < cutoff) continue;    // 🚨 SAFETY: never touch historical rows
    if (now - created < minAge) continue;          // still legitimately in flight
    const st = state[it.record_id];
    if (st && st.tries >= maxTries) continue;      // exhausted: it belongs to a human now
    out.push({ recordId: it.record_id, phone,
      want: txt(f['Customer want']) || 'WhatsApp direct inquiry',
      brand: txt(f['Brand']), createdMs: created, tries: st ? st.tries : 0 });
  }
  // Oldest first: the lead that has been waiting longest is the one to rescue first.
  out.sort((a, b) => a.createdMs - b.createdMs);
  return out;
}

// ---------------------------------------------------------------------------------------------
// ATTEMPT BOOKKEEPING
// ---------------------------------------------------------------------------------------------
// 🚨 A SUCCESS DELETES THE ROW FROM STATE, it does not record a win. Once assigned, the record no
// longer matches the Lark filter, so a lingering entry would only rot — and a state file that grows
// forever is its own outage. Deleting also means a lead that somehow orphans AGAIN later starts
// from a clean count rather than inheriting an old one and going straight to "needs a human".
function recordAttempt(state, recordId, ok, err, now){
  const s = Object.assign({}, state);
  if (ok){ delete s[recordId]; return s; }
  const prev = s[recordId] || { tries: 0 };
  s[recordId] = { tries: prev.tries + 1, lastTry: now,
    lastError: String(err || 'unknown').slice(0, 120),
    firstSeen: prev.firstSeen || now };
  return s;
}

// The report's ONLY input. Anything not in here was either fixed silently or is still being retried,
// and in both cases the client must not see it.
function needsHuman(state, maxTries){
  const m = maxTries == null ? MAX_TRIES : maxTries;
  return Object.entries(state || {})
    .filter(([, v]) => v && v.tries >= m)
    .map(([recordId, v]) => ({ recordId, tries: v.tries, lastError: v.lastError,
      firstSeen: v.firstSeen, lastTry: v.lastTry }))
    .sort((a, b) => (a.firstSeen || 0) - (b.firstSeen || 0));
}

// Entries whose Lark row no longer matches (assigned by a human in the meantime, or deleted) must
// not sit in the state file claiming to need attention forever. Called with the live candidate ids
// PLUS the ids we just attempted, so a row that vanished from Lark drops out on the next sweep.
function pruneState(state, liveIds){
  const live = new Set(liveIds || []);
  const s = {};
  for (const [k, v] of Object.entries(state || {})) if (live.has(k)) s[k] = v;
  return s;
}

module.exports = { pickCandidates, recordAttempt, needsHuman, pruneState,
  usablePhone, createdMs, MAX_TRIES, MIN_AGE_MS };
