// TM Motor Lead Intake — receiver + AI parser (TEST MODE)
// Reads text / PDF / Excel / image dropped in the WA group, asks GPT-4o to
// extract lead fields, and replies a parse-card BACK INTO THE SAME CHAT.
// Lark write is OFF until LIVE_LARK=1. Nothing is written to Lark in test mode.

const http = require('http');
let XLSX = null; try { XLSX = require('xlsx'); } catch { /* excel disabled if dep missing */ }

const WASENDER_BASE  = 'https://www.wasenderapi.com/api';
const UA             = 'Mozilla/5.0';
const WASENDER_TOKEN = process.env.WASENDER_TOKEN || '';
// "no lead found" alert → internal work group "AI Agent Project TM Motoworld" via the PA number (own token).
const REVIEW_GROUP_JID = process.env.REVIEW_GROUP_JID || '';     // 120363409140518905@g.us
const REVIEW_TOKEN     = process.env.REVIEW_TOKEN || '';         // PA WaSender token (different number)
async function alertReview(text){
  if (!REVIEW_GROUP_JID || !REVIEW_TOKEN) return;
  try {
    await fetch(WASENDER_BASE + '/send-message', { method:'POST',
      headers:{ 'Authorization':'Bearer '+REVIEW_TOKEN, 'Content-Type':'application/json', 'User-Agent':UA },
      body: JSON.stringify({ to: REVIEW_GROUP_JID, text }) });
  } catch (e) { log('alertReview failed', String(e.message||e)); }
}
// ---- SLA group digest: buffer routine notices → ONE summary at 12PM + 6PM MYT (no more 1-by-1 spam) ----
const _fs = require('fs'), _path = require('path');
const DIGEST_STORE = _path.join(__dirname, 'sla_digest.json');
let digest = { events: [], sent: {} };
try { digest = JSON.parse(_fs.readFileSync(DIGEST_STORE, 'utf8')); } catch { /* fresh */ }
function digestPersist(){ try { _fs.writeFileSync(DIGEST_STORE, JSON.stringify(digest)); } catch {} }
function digestPush(ev){ digest.events.push({ ...ev, t: Date.now() }); digestPersist(); }
const MYT_OFF = 8 * 3600 * 1000;

// ---- Bulk lead throttle (Benjamin 2026-07-21): a single group drop can carry a WHOLE
// event's worth of leads (e.g. a test-ride registration Excel, 100+ rows). Assigning +
// notifying + starting SLA timers for all of them in one shot dumps dozens of leads on a
// tiny brand pool at once (guaranteed SLA pile-up/reassign storm) and floods the sales
// team's phones. Leads are ALWAYS written to Lark immediately (never lost) — only the
// staff WhatsApp notify + SLA-timer-start is staggered into business-hours batches.
const BULK_THRESHOLD  = Number(process.env.BULK_THRESHOLD || 15);      // more than this in one drop = bulk mode
const BULK_BATCH_SIZE = Number(process.env.BULK_BATCH_SIZE || 15);     // leads notified per drain
const BULK_DRAIN_MS   = Number(process.env.BULK_DRAIN_MS || 6 * 3600 * 1000); // drain every 6h (in-hours only)
const BULK_QUEUE_FILE = _path.join(__dirname, 'bulk_queue.json');
// queue entries: { chatId, screenshotUrl, total, sent, batches: [[lead,...], ...] }
let bulkQueue = []; try { bulkQueue = JSON.parse(_fs.readFileSync(BULK_QUEUE_FILE, 'utf8')); } catch { /* fresh */ }
function bulkPersist(){ try { _fs.writeFileSync(BULK_QUEUE_FILE, JSON.stringify(bulkQueue)); } catch {} }
function chunk(arr, size){ const out = []; for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size)); return out; }
// Same Mon-Sat 9-6 MYT gate as the SLA engine (kept independent — bulk drain must respect business
// hours even if SLA_ON=0), so bulk notify DMs never fire in the middle of the night.
const BIZ_DAYS = (process.env.SLA_DAYS || '1,2,3,4,5,6').split(',').map(Number);
function inBusinessHours(){ const d = new Date(Date.now() + MYT_OFF); return BIZ_DAYS.includes(d.getUTCDay()) && d.getUTCHours() >= 9 && d.getUTCHours() < 18; }
function mytNow(){ const d = new Date(Date.now() + MYT_OFF); return { date: d.toISOString().slice(0,10), h: d.getUTCHours(), m: d.getUTCMinutes() }; }
function hhmmMYT(ms){ const d = new Date(ms + MYT_OFF); return String(d.getUTCHours()).padStart(2,'0') + ':' + String(d.getUTCMinutes()).padStart(2,'0'); }
const BOOT_AT = Date.now();

// ---- Window-scoped SLA counters, read from LARK (2026-07-30) ----
// The 12PM/6PM card claims "here's what happened in this window". It used to be built from
// `sla.stats()` — a LIVE snapshot of the in-memory store, which lives on Render's EPHEMERAL disk.
// Seen live 07-29: a 17:40 deploy wiped the store, so the 18:00 card reported the desk as it looked
// 20 minutes later ("5 assigned") and claimed "0 acknowledged" — while Amir, Fazwan ×2 and Roy had
// all genuinely acknowledged that afternoon. And because `rehydrateFromLark` restores only
// `SLA Status=Pending` rows, acknowledged leads are UNRESTORABLE by construction → "0 acknowledged"
// after ANY deploy, permanently. Lark is the durable record, so the counters now come from Lark and
// a restart cannot rewrite history.
async function slaWindowStats(sinceMs, untilMs){
  const items = await larkSearch({
    filter: { conjunction: 'and', conditions: [{ field_name: 'SLA Assigned At', operator: 'isNotEmpty', value: [] }] },
    sort: [{ field_name: 'date created', desc: true }],
  });
  const out = { assigned: 0, acked: 0, waiting: 0, missed: 0, moved: 0, within: 0, other: 0, capped: items.length >= 100 };
  for (const it of items){
    const f = it.fields || {};
    const at = parseInt(slaFieldText(f['SLA Assigned At']), 10) || 0;
    if (!at || at < sinceMs || at > untilMs) continue;
    const st = slaFieldText(f['SLA Status']);
    if (st === 'Queued') continue;                       // bulk lead, DM not sent yet → not this window's workload
    out.assigned++;
    const fr = parseInt(slaFieldText(f['SLA First Response At']), 10) || 0;
    const act = slaFieldText(f['SLA Response Action']);   // 'Keep' = acknowledged · 'Pass' = handed on
    // A PASS is a response but NOT an acknowledgement — the rep declined the lead, so it must land in
    // `moved`, never inflate `acked`. Buckets are mutually exclusive and MUST sum to `assigned`, so a
    // client-facing card can never print numbers that don't add up.
    if (st === 'Acknowledged' || (fr && act === 'Keep')){ out.acked++; if (f['SLA Within SLA?'] === true) out.within++; }
    else if (st === 'Pending') out.waiting++;
    else if (st === 'No-Response' || st === 'Escalated') out.missed++;
    else if (st === 'Reassigned' || act === 'Pass') out.moved++;
    else out.other++;                                    // unknown/blank status — surfaced, never hidden
  }
  return out;
}
async function buildDigest(label, sinceMs){
  const evs = digest.events.filter(e => e.t >= sinceMs);
  const flags = evs.filter(e => e.type === 'flag');
  const moves = evs.filter(e => e.type === 'reassign');
  const escs  = evs.filter(e => e.type === 'escalate');
  const reassign = (typeof sla !== 'undefined' && sla) ? sla.stats().reassign : '?';
  const L = [`📊 *TM SLA — ${label}*  (${mytNow().date})`];
  let w = null;
  try { w = await slaWindowStats(sinceMs, Date.now()); }
  catch (e){ log('digest lark stats err', String(e.message || e).slice(0, 80)); }
  if (w){
    L.push(`🔔 ${w.assigned} assigned · ✅ ${w.acked} acknowledged · ⏳ ${w.waiting} waiting${w.missed ? ` · ⏰ ${w.missed} no-response` : ''}${w.moved ? ` · 🔄 ${w.moved} passed/reassigned` : ''}${w.other ? ` · ❔ ${w.other} unclear` : ''}`);
    if (w.acked) L.push(`⏱️ ${w.within}/${w.acked} answered within 60 min · auto-reassign *${reassign}*`);
    else L.push(`auto-reassign *${reassign}*`);
    // NO SILENT CAPS: say so rather than letting a truncated read look like full coverage.
    if (w.capped) L.push(`⚠️ read from the newest 100 Lark rows — older rows in this window may be uncounted`);
  } else {
    // Lark unreachable → degrade HONESTLY. Printing a live in-memory snapshot as if it were the
    // window is exactly the failure this function was rewritten to remove.
    L.push(`⚠️ Couldn't read this window's totals from Lark — counts unavailable · auto-reassign *${reassign}*`);
  }
  if (escs.length){
    L.push('', `🚨 *Needs a manager (${escs.length})* — not picked up:`);
    escs.slice(0, 10).forEach(e => L.push(`   • ${e.who} (${e.brand}) — ${e.why}`));
  }
  if (flags.length){
    const byRep = {}; flags.forEach(f => { byRep[f.rep] = (byRep[f.rep] || 0) + 1; });
    L.push('', `⏰ *No reply >75min (${flags.length})* — please follow up:`);
    Object.entries(byRep).sort((a,b)=>b[1]-a[1]).forEach(([r,n]) => L.push(`   • ${r} — ${n}`));
  }
  if (moves.length){
    const byPair = {}; moves.forEach(m => { const k = `${m.from} → ${m.to}`; byPair[k] = (byPair[k] || 0) + 1; });
    L.push('', `🔄 *Reassigned / passed (${moves.length})*:`);
    Object.entries(byPair).sort((a,b)=>b[1]-a[1]).forEach(([k,n]) => L.push(`   • ${k} — ${n}`));
  }
  if (!flags.length && !moves.length && !(w && w.missed)) L.push('', '✅ No SLA misses this window — all assigned leads acknowledged.');
  // A mid-window restart can only cost us the flag/reassign LISTS (in-memory buffer). Say so, instead
  // of letting a short list read as a quiet window — the 07-29 report's whole failure mode.
  if (BOOT_AT > sinceMs) L.push('', `ℹ️ Bot restarted at ${hhmmMYT(BOOT_AT)} — the lists above may be incomplete. The totals are read from Lark and unaffected.`);
  return L.join('\n');
}
// checks every 5 min; fires once when it crosses 12:00 and 18:00 MYT (health poller keeps the bot awake)
async function digestTick(){
  const p = mytNow();
  const windows = [[12, 'Midday update (9AM–12PM)', 0], [18, 'End-of-day update (12PM–6PM)', 12]];
  for (const [hr, label, startHr] of windows){
    const key = `${p.date}:${hr}`;
    if (p.h === hr && p.m < 15 && !digest.sent[key]){
      const since = Date.parse(p.date + 'T00:00:00Z') - MYT_OFF + startHr * 3600 * 1000;
      digest.sent[key] = true;   // claim the slot BEFORE the awaited build/send so a slow Lark read can't double-fire
      try { await alertReview(await buildDigest(label, since)); }
      catch (e){ log('digest send err', String(e.message || e)); }
      const cut = Date.now() - 26 * 3600 * 1000;
      digest.events = digest.events.filter(e => e.t >= cut);
      for (const k of Object.keys(digest.sent)) if (k < p.date) delete digest.sent[k];
      digestPersist();
    }
  }
}
const OPENAI_KEY     = process.env.OPENAI_API_KEY || '';
const MODEL          = process.env.MODEL || 'gpt-4o';
const LIVE_LARK      = process.env.LIVE_LARK === '1';   // stays OFF for testing
// SAFETY: the bot ONLY replies inside this one intake group. The TM Motor number
// is a LIVE number (in real groups + receives real customer DMs) — replying anywhere
// else would spam customers. Empty = reply nowhere (still captures for the inbox).
const INTAKE_GROUP_JID = process.env.INTAKE_GROUP_JID || '';
// FAN-OUT (KoonKen/FSS pattern): this Render bot is the PRIMARY webhook. It forwards every
// raw payload + original headers to the VPS console inbox so TM shows in the WhatsApp QA console.
const INBOX_FORWARD_URL = process.env.INBOX_FORWARD_URL || '';
// WaSender signs with its own secret; the console channel expects a different one. Re-sign the
// forward with the console channel's secret so signature verification passes (no VPS restart needed).
const INBOX_FORWARD_SECRET = process.env.INBOX_FORWARD_SECRET || '';
// 2nd fan-out: forward raw payload to the website-upload service (Mudah bike posts → WooCommerce draft).
// Fire-and-forget; the woo service itself filters to the HQ Mudah group. Never blocks lead flow.
const WOO_FORWARD_URL = process.env.WOO_FORWARD_URL || '';

// Live stock lookup (Harith feedback 2026-07-20: FR bot must check real stock before answering
// a stock-availability question, instead of always assuming "yes" / staying silent on it).
const WOO_SITE    = process.env.WOO_SITE || '';       // e.g. https://tmmotoworld.com
const WOO_USER    = process.env.WOO_USER || '';
const WOO_APP_PW  = process.env.WOO_APP_PW || '';
// B (approved 2026-07-24): LOCAL CATALOG CACHE. WordPress's near-literal search was the root cause
// of the ER6N false "takde stok" (2026-07-24) — a stray "ada" in the query zeroed a bike with 2
// units instock, and the bot turned the search miss into a confident negative. (An earlier
// stopword-blacklist attempt 2026-07-21 and the token-extractor rewrite both still fed WP search.)
// Now the bot keeps its OWN copy of the whole catalog (~300 products, refreshed every 10 min) and
// matches model tokens locally, alphanumeric-normalized so er6n = ER-6N = Er 6n. Filler words
// never reach the matcher. Positive "✅ Ada" claims get a per-product LIVE re-check first (cache
// can be up to 10 min behind a sale — an MT-07 sold the same morning it was asked about; staff DO
// flip the Woo status promptly, so the live check catches it). Tune: CATALOG_REFRESH_MS env.
const RE_BIKE_KEYWORDS = require('./firstresponse').RE_BIKE;
const alnumTok = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
// Booking/pre-release listings (e.g. "OPEN FOR BOOKING NEW ZONTES 175X", 2026-07-24 incident:
// quoted its placeholder price RM 8,888.89 as real stock) carry stock_status=instock but the
// bike isn't released — split into their own bucket so the FR bot answers with the booking
// pitch instead of a stock/price claim.
const RE_BOOKING = /open\s+for\s+booking|\bbooking\b|pre-?order|coming\s+soon/i;
const wooAuth = () => 'Basic ' + Buffer.from(`${WOO_USER}:${WOO_APP_PW}`).toString('base64');
let CATALOG = { items: [], at: 0 };
async function catalogRefresh(){
  const items = [];
  try {
    for (let page = 1; page <= 8; page++){
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15000);
      const r = await fetch(`${WOO_SITE}/wp-json/wc/v3/products?status=publish&per_page=100&page=${page}&_fields=id,name,price,regular_price,stock_status`,
        { headers: { Authorization: wooAuth() }, signal: ctrl.signal }).finally(() => clearTimeout(timer));
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const batch = await r.json();
      if (!Array.isArray(batch)) throw new Error('non-array page');
      items.push(...batch);
      if (batch.length < 100) break;
    }
    CATALOG = { items, at: Date.now() };
    log(`catalog refresh: ${items.length} products`);
  } catch (e) { log('catalog refresh err (keeping previous copy):', String(e.message || e).slice(0, 80)); }
}
// Model tokens = RE_BIKE brand/model words + digit-bearing tokens ("368D", "mt07"), nothing else —
// filler ("ada", "stok", "lg") is what poisoned the old WP-search queries.
function catalogModelTokens(text){
  const words = String(text || '').replace(/[^\w\s-]/g, ' ').split(/\s+/).filter(Boolean);
  return [...new Set(words.filter(w => RE_BIKE_KEYWORDS.test(w) || /\d/.test(w)).map(alnumTok).filter(t => t.length >= 2))];
}
async function wooVerifyLive(id){
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3000);
  try {
    const r = await fetch(`${WOO_SITE}/wp-json/wc/v3/products/${id}?_fields=stock_status`, { headers: { Authorization: wooAuth() }, signal: ctrl.signal });
    if (!r.ok) return null;
    return (await r.json()).stock_status || null;
  } catch { return null; }
  finally { clearTimeout(timer); }
}
async function wooCheckStock(text){
  if (!WOO_SITE || !WOO_USER || !WOO_APP_PW) return null;   // not configured — caller must skip silently
  const toks = catalogModelTokens(text);
  if (!toks.length || !CATALOG.items.length) return null;   // no model named / cache not loaded yet (boot) → no claim either way
  const named = CATALOG.items
    .filter(p => { const nn = alnumTok(p.name); return toks.every(t => nn.includes(t)); })
    .map(p => ({ id: p.id, name: String(p.name || '').split('|')[0].trim().slice(0, 60), price: Number(p.price || p.regular_price || 0), stock: p.stock_status, booking: RE_BOOKING.test(String(p.name || '')) }));
  const booking = named.filter(p => p.booking).map(p => ({ name: p.name }));
  let instock = named.filter(p => !p.booking && p.stock !== 'outofstock');
  // Single distinct model = the case where stockLineFor will assert "✅ Ada — dari RM X", so
  // live-verify each unit first (a verify failure trusts the ≤10-min-old cache rather than block).
  const distinct = new Set(instock.map(p => p.name.toLowerCase()));
  if (distinct.size === 1 && instock.length <= 3){
    const checks = await Promise.all(instock.map(async p => ({ p, live: await wooVerifyLive(p.id) })));
    instock = checks.filter(c => c.live !== 'outofstock').map(c => c.p);
  }
  return { matches: instock.map(p => ({ name: p.name.slice(0, 48), price: p.price })), booking };
}
if (WOO_SITE && WOO_USER && WOO_APP_PW){
  catalogRefresh();
  setInterval(catalogRefresh, Number(process.env.CATALOG_REFRESH_MS || 10 * 60 * 1000));
}

const recent = [];                 // in-memory debug log (wiped on restart)
const SEEN = new Set();             // processed message ids (webhook-retry dedup)
function log(...a){ console.log(new Date().toISOString(), ...a); }
function remember(o){ recent.unshift({ at: new Date().toISOString(), ...o }); if (recent.length > 50) recent.pop(); }

// ---- Rotation pools (updated roster 2026-06-17) ----
const POOLS = {
  KS:       ['Jebat','Nabil','Allysa','Jue','Amirul','Nazrin','Aso','Roy'],  // Lambretta/Thunder (Klang + Shah Alam) — Azwin removed 2026-07-21 (resigned)
  HQ:       ['Adib','Syahrin','Fazwan','Azrul','Amir','Ikhwan'],   // HQ / Suzuki — Ikhwan added 2026-07-29
  Honda:    ['Bella','Syaza','Anis','Syafa','Zeera'],              // Honda Kapar
  ShahAlam: ['Amirul','Nazrin','Aso','Roy'],                      // KTM / Zontes
};
function poolForBrand(brand){
  const b = (brand || '').toLowerCase();
  if (b === 'honda') return ['Honda', POOLS.Honda];
  if (b === 'lambretta' || b === 'thunder') return ['Klang/Shah Alam', POOLS.KS];
  if (b === 'ktm' || b === 'zontes') return ['Shah Alam', POOLS.ShahAlam];
  // HQ is TM's catch-all desk — HQ / Suzuki / Kawasaki / any other or unknown brand → HQ pool.
  // (Never return an empty pool: a lead must always get a salesman, never sit blank waiting.)
  return ['HQ', POOLS.HQ];
}

// ---- WaSender send: SERIALIZED + 5s-spaced + retry-on-429 ----
// The session has account-protection (1 msg / 5 sec). All sends go through one chain
// so they never fire faster than the limit, and 429s are retried — nothing dropped.
const SEND_GAP = 5200;
let _sendChain = Promise.resolve();
let _lastSend = 0;
function waSend(to, text, imageUrl){
  _sendChain = _sendChain.then(async () => {
    if (!WASENDER_TOKEN) { log('waSend skipped — no token'); return; }
    const wait = SEND_GAP - (Date.now() - _lastSend);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    if (text && text.length > 4096) text = text.slice(0, 4080) + '\n…';   // WhatsApp hard 4096-char limit — never 422
    const payload = imageUrl ? { to, imageUrl, text } : { to, text };
    for (let attempt = 1; attempt <= 3; attempt++) {
      const r = await fetch(WASENDER_BASE + '/send-message', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + WASENDER_TOKEN, 'Content-Type': 'application/json', 'User-Agent': UA },
        body: JSON.stringify(payload),
      });
      _lastSend = Date.now();
      if (r.status === 429) {
        let ra = 5; try { ra = JSON.parse(await r.text()).retry_after || 5; } catch {}
        log('waSend 429 → retry after', ra, 's (attempt ' + attempt + ')');
        await new Promise(res => setTimeout(res, (ra + 0.6) * 1000));
        continue;
      }
      if (!r.ok) { log('waSend HTTP', r.status, (await r.text()).slice(0, 150)); return null; }
      try { const j = await r.json(); return j.data?.msgId || j.data?.id || null; } catch { return null; }   // msgId → SLA deletes it on reassign
    }
    log('waSend gave up after 3 attempts to', to);
    return null;
  }).catch(e => log('send chain err', String(e.message || e)));
  return _sendChain;
}
// delete a previously-sent WhatsApp message (used by SLA on reassign). Confirmed: DELETE /messages/{id}
async function waDelete(msgId){
  if (!msgId || !WASENDER_TOKEN) return;
  try { await fetch(WASENDER_BASE + '/messages/' + msgId, { method: 'DELETE', headers: { 'Authorization': 'Bearer ' + WASENDER_TOKEN, 'User-Agent': UA } }); }
  catch (e) { log('waDelete err', String(e.message || e)); }
}

// Server-side decrypt (Strategy 2): POST the media message object → publicUrl → download bytes
async function decryptMedia(fullMessage){
  // WaSender wants the FULL webhook envelope: { data: { messages: <the data.messages object> } }
  const r = await fetch(WASENDER_BASE + '/decrypt-media', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + WASENDER_TOKEN, 'Content-Type': 'application/json', 'User-Agent': UA },
    body: JSON.stringify({ data: { messages: fullMessage } }),
  });
  const txt = await r.text();
  let j = {}; try { j = JSON.parse(txt); } catch {}
  const url = j.publicUrl || j.url || j.fileUrl || j.tempUrl || (j.data && (j.data.publicUrl || j.data.url)) || '';
  log('decrypt-media status', r.status, 'url?', !!url, 'body', txt.slice(0, 200));
  if (!url) throw new Error('decrypt-media gave no url (HTTP ' + r.status + ')');
  decryptMedia.lastUrl = url;   // public URL (valid ~1h) — reused to forward the screenshot to the salesperson
  const bin = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!bin.ok) throw new Error('media download HTTP ' + bin.status);
  const buf = Buffer.from(await bin.arrayBuffer());
  log('media downloaded', buf.length, 'bytes', 'ct=' + (bin.headers.get('content-type') || '?'));
  return buf;
}

// ---- extract the inbound message into a normalized shape ----
function pickMessages(data){
  let m = data.messages;
  if (Array.isArray(m)) m = m[0];
  return m || {};
}
function unwrap(msg){
  if (msg.documentWithCaptionMessage?.message) return msg.documentWithCaptionMessage.message;
  if (msg.viewOnceMessage?.message) return msg.viewOnceMessage.message;
  if (msg.viewOnceMessageV2?.message) return msg.viewOnceMessageV2.message;
  if (msg.ephemeralMessage?.message) return msg.ephemeralMessage.message;
  if (msg.editedMessage?.message) return msg.editedMessage.message;
  return msg;
}
// Dig recursively through ANY wrapper to find media (self-sent images can be nested differently).
function findMedia(msg, depth){
  if (!msg || typeof msg !== 'object' || (depth || 0) > 6) return null;
  if (msg.imageMessage) return { kind: 'image', obj: msg.imageMessage };
  if (msg.documentMessage) return { kind: 'document', obj: msg.documentMessage };
  if (msg.documentWithCaptionMessage?.message?.documentMessage) return { kind: 'document', obj: msg.documentWithCaptionMessage.message.documentMessage };
  for (const k of ['documentWithCaptionMessage','viewOnceMessage','viewOnceMessageV2','ephemeralMessage','editedMessage']) {
    if (msg[k]?.message) { const r = findMedia(msg[k].message, (depth || 0) + 1); if (r) return r; }
  }
  return null;
}
function extract(payload){
  const data = payload.data || {};
  const m = pickMessages(data);
  const key = m.key || {};
  const chatId = key.remoteJid || '';
  if (!chatId) return null;
  const sender = m.pushName || key.participantPn || key.participant || '';
  const rawMsg = m.message || {};
  const msg = unwrap(rawMsg);
  const text0 = msg.conversation || msg.extendedTextMessage?.text || '';
  // Staff also send leads FROM the Tmm Marketing number itself → process those too.
  // But NEVER react to our own bot cards/errors (they start with 🧪 / ⚠️) — prevents a loop.
  if (key.fromMe && /^\s*(🧪|⚠️)/.test(text0)) return null;
  const media = findMedia(rawMsg);     // bulletproof: finds media no matter how it's wrapped
  if (media?.kind === 'image') {
    const im = media.obj;
    return { chatId, sender, kind: 'image', mediaObj: im, fullMessage: m, caption: im.caption || '', mime: (im.mimetype || 'image/jpeg').split(';')[0] };
  }
  if (media?.kind === 'document') {
    const dm = media.obj;
    // WhatsApp puts the name in fileName OR title depending on the client — read both.
    return { chatId, sender, kind: 'document', mediaObj: dm, fullMessage: m, caption: dm.caption || '', mime: dm.mimetype || '', fileName: dm.fileName || dm.title || '' };
  }
  if (text0) return { chatId, sender, kind: 'text', text: text0 };
  if (msg.reactionMessage || rawMsg.reactionMessage) return { chatId, sender, kind: 'reaction', text: '' };   // 👍 reaction = acknowledgement (SLA)
  if (msg.stickerMessage || rawMsg.stickerMessage) return { chatId, sender, kind: 'sticker', text: '' };      // sticker = acknowledgement too (Syaza "Ok NOTED" sticker, 2026-07-15)
  return null;
}

function excelToText(buf){
  if (!XLSX) return '[xlsx parser unavailable]';
  const wb = XLSX.read(buf, { type: 'buffer' });
  return wb.SheetNames.map(n => '# Sheet: ' + n + '\n' + XLSX.utils.sheet_to_csv(wb.Sheets[n])).join('\n\n');
}
// Split a spreadsheet into row-count-bounded chunks (header repeated in every chunk) so a
// large event export (100+ rows) never gets handed to the AI in one giant blob. A single-shot
// extraction on a big repetitive sheet was proven (2026-07-21, Zontes/KTM test-ride file,
// 139 real rows) to silently return a clean-looking PARTIAL result (finish_reason=stop, not
// even a token-limit truncation — the model just stopped early) — 21 leads out of 139, zero
// error, zero warning. Chunking keeps each AI call small enough that it has no room to "summarize".
const EXCEL_CHUNK_ROWS = 20;
function excelToChunks(buf){
  if (!XLSX) return ['[xlsx parser unavailable]'];
  const wb = XLSX.read(buf, { type: 'buffer' });
  const chunks = [];
  for (const name of wb.SheetNames) {
    const lines = XLSX.utils.sheet_to_csv(wb.Sheets[name]).split(/\r?\n/).filter((l, i) => i === 0 || l.trim());
    const header = lines[0] || '';
    const rows = lines.slice(1);
    if (!rows.length) { chunks.push(`# Sheet: ${name}\n${header}`); continue; }
    for (let i = 0; i < rows.length; i += EXCEL_CHUNK_ROWS) {
      const part = rows.slice(i, i + EXCEL_CHUNK_ROWS);
      chunks.push(`# Sheet: ${name} (rows ${i + 1}-${i + part.length} of ${rows.length})\n${header}\n${part.join('\n')}`);
    }
  }
  return chunks;
}

// ---- OpenAI extraction (GPT-4o: vision for images, native PDF, text for excel/plain) ----
const EXTRACT_INSTRUCTION =
`From the content above, extract ALL motorcycle sales leads.
Return ONLY a JSON object (no prose):
{"leads":[{"name":"","phone":"+60...","interest":"","brand":"","origin":""}]}
Rules:
- TAG FORMAT: staff often add a short tag (as a text message or an image caption) in the order "ORIGIN BRAND (Salesperson)" — e.g. "TIKTOK DM Lambretta (Nabil)" or "TIKTOK DM HQ". When present, the LEADING words are the Origin, the BRAND word is the Brand, and "(Name)" is the salesperson. Use the tag's Origin + Brand for the lead(s); the screenshot/content gives the customer's phone + name. "Tiktok DM HQ" = Origin "Tiktok DM" + Brand "HQ" (HQ is the BRAND, not part of the origin).
- phone: normalize to Malaysian +60 format, digits only after +60, no spaces. If no phone, use "".
- interest: ALWAYS capture the specific BIKE MODEL when one is mentioned (e.g. "cbr250","aveta nova 250","africa twin"). If the customer asks the PRICE of a model, set interest to the model + " (pricing)" e.g. "aveta nova 250 (pricing)" — NEVER just "pricing" when a model is named. Only use a bare topic like "pricing" / "loan" when NO model is mentioned at all. If nothing -> "No question". Keep short lowercase.
- brand: exactly one of HQ, Honda, Lambretta, Thunder, Suzuki, KTM, Zontes. **HQ is a real brand (TM's house brand) — if the tag/data says HQ, use "HQ", NEVER substitute "Suzuki".** **The Modenas / QJ "Moca" line is HQ — if the model is "moca" / "moda moca" / "mica" / "modenas" / "z15gt" (and no other brand is tagged), set brand to "HQ".** If unclear -> "".
- origin: identify the lead's SOURCE. MUST be EXACTLY one of: "Tiktok DM", "Tiktok Get Leads", "TIKTOK LIVE (Get leads)", "Ads Tiktok", "Whatsapp", "FB Ads", "FB/IG comments", "Mudah", "On Site Event", "Bike Continent META". Map: a tag starting "TIKTOK DM" OR a TikTok DM/chat-conversation screenshot (@handle, "Message request accepted") -> "Tiktok DM"; the word "Organic" in the data -> "Tiktok Get Leads"; paid TikTok ad OR TikTok lead-form export -> "Ads Tiktok"; WhatsApp chat screenshot -> "Whatsapp"; Facebook lead ad -> "FB Ads"; FB/IG comment -> "FB/IG comments"; Mudah -> "Mudah"; walk-in / showroom / roadshow / event -> "On Site Event".
- name: the customer's name. For a chat/DM screenshot, use the contact's display name or @handle shown at the top (e.g. "mas.saifuddin"). Else "".
Return JSON only.`;

// A (approved 2026-07-24, ~RM 7/mo at ~30 DMs/day): gpt-4o reads the customer's INTENT instead of
// regex keyword lists. Real incident same morning: "Kalau mau tolak moto masih ada loan lagi boleh
// kah?" (= trade-in with outstanding loan) matched the word "loan" and got the buying-loan
// template. Malay has endless sell phrasings (jual/tolak/lepas/let go/...) — a keyword list can
// never keep up. Regex classify() stays as the instant fallback (API error/timeout/garbage output
// → exactly the old behavior). Kill switch: FR_AI_CLASSIFY=0 (no redeploy of code needed, env only).
const CLASSIFY_PROMPT = `You classify the FIRST WhatsApp message a customer sends to TM Motoworld, a Malaysian motorcycle dealer. Messages are Malay (often short-forms: nk, sy, x, bleh, tnya), English, or mixed.
Answer with EXACTLY one word from: sell, loan, testride, product, greeting, skip
- sell = customer wants to SELL or TRADE-IN their OWN bike to the shop. Phrasings include jual, tolak, lepas, let go, trade in, tukar ("nak tolak moto", "moto nak let go"). If they mention their own bike still has a loan/hutang while selling ("mau tolak moto masih ada loan boleh kah?"), it is STILL sell.
- loan = asking about financing to BUY from the shop: loan, ansuran, EPP, kad kredit, bulanan berapa, deposit, blacklist/CTOS/CCRIS.
- testride = wants to test ride a bike.
- product = wants to BUY / asks about a model, price, stock, availability, colours. NOTE: "kedai ada jual motor X?" asks whether the SHOP sells X — that is product, NOT sell.
- greeting = only a greeting / vague ad click with no stated interest ("Hi", "salam", "pagi bos").
- skip = automated vendor/OTP/verification messages, or long text unrelated to motorcycles.
Priority for mixed messages: sell beats loan beats product.`;
async function aiClassify(text){
  if (!OPENAI_KEY || process.env.FR_AI_CLASSIFY === '0') return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + OPENAI_KEY, 'Content-Type': 'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify({ model: MODEL, max_tokens: 5, temperature: 0, messages: [
        { role: 'system', content: CLASSIFY_PROMPT },
        { role: 'user', content: String(text).slice(0, 1000) },
      ] }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error('OpenAI HTTP ' + r.status);
    return String(j.choices?.[0]?.message?.content || '').trim().toLowerCase().replace(/[^a-z]/g, '');
  } finally { clearTimeout(timer); }
}

async function aiExtract(blocks){
  if (!OPENAI_KEY) throw new Error('NO_KEY');
  for (let attempt = 1; attempt <= 2; attempt++) {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + OPENAI_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: 1500, response_format: { type: 'json_object' }, messages: [{ role: 'user', content: blocks }] }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error('OpenAI HTTP ' + r.status + ' ' + JSON.stringify(j.error || j).slice(0, 200));
    const content = j.choices?.[0]?.message?.content || '';
    log('openai finish=' + j.choices?.[0]?.finish_reason + ' len=' + content.length + (attempt > 1 ? ' (retry)' : ''));
    if (content.trim()) return content;     // got something
  }                                          // else retry once (transient empty)
  return '';
}
function parseLeads(raw){
  let s = (raw || '').trim().replace(/^```(json)?/i, '').replace(/```$/,'').trim();
  if (!s) { log('parseLeads: empty response'); return []; }
  const a = s.indexOf('{'); const b = s.lastIndexOf('}');
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  try { const obj = JSON.parse(s); return Array.isArray(obj) ? obj : (obj.leads || [obj]); }
  catch (e) { log('parseLeads failed:', s.slice(0, 150)); return []; }
}

// ---- Sales roster: name → { phone (+60), openId (Lark user) } ----
const STAFF = {
  Nabil:   { phone: '+60124164828', openId: 'ou_6c31983140832afd10f1be158a61aba5' },
  Jebat:   { phone: '+60128674828', openId: 'ou_3276531fa0510063706e4aa76e6d6fd9' },
  Allysa:  { phone: '+60123343259', openId: 'ou_abe4769c33d0d322724c5df2960591fe' },
  Azwin:   { phone: '+60124828409', openId: 'ou_c7a471f86ee48ad13b318522dce7c256' },
  Amirul:  { phone: '+60108997920', openId: 'ou_432a506d92bc820cdb833eb171dbbc48' },
  Nazrin:  { phone: '+60123984828', openId: 'ou_4616a5479a2e66eb916b03b2b80c9fab' },
  Aso:     { phone: '+60127674828', openId: 'ou_efa269adc38cbfd4cc6419a15255ee8c' },
  Adib:    { phone: '+60178869542', openId: 'ou_c3dc42b76aedbfbf5d406df4562a9fd7' },
  Syahrin: { phone: '+60163488335', openId: 'ou_1fffee0c651b479629d7c3af5b4d80dd' },
  Jue:     { phone: '+60129653259', openId: 'ou_eb6d76e226cf5297e4e973be34f28e78' },   // Klang
  Fazwan:  { phone: '+60128174828', openId: 'ou_b2e70278502e53975a69a9049cbabaf6' },
  Azrul:   { phone: '+60102323259', openId: 'ou_b500e95837ece7bac07399e839425548' },
  Amir:    { phone: '+60103793259', openId: 'ou_424396071c66958527e9cabd5c3ba902' },
  Bella:   { phone: '+60109693259', openId: 'ou_d15465dabf45e876b2bae7660d6ef7bd' },
  Anis:    { phone: '+60129323259', openId: 'ou_5cc5c7b01105cf5703dd6353cb612a1b' },
  Syafa:   { phone: '+60122623259', openId: 'ou_d072f303baf1800574bbae4f33f61aec' },
  Syaza:   { phone: '+60123773259', openId: 'ou_88cd7c9e006835a4300c5104f19185f5' },   // Honda (Syaza Rahman — PIC-confirmed 2026-06-18)
  Roy:     { phone: '+60122653259', openId: 'ou_6bf42b3e72ca59355e8278d71ae10123' },   // Shah Alam (Roy Abdullah)
  Zeera:   { phone: '+601118583259', openId: 'ou_47e1634c959f08b7bb43f2ba87cf400b' },  // Honda (Hazirah Zulaika Binti Mohd Asri — reactivated acct, NOT old ou_7cde)
  Ikhwan:  { phone: '+60129593259', openId: '' },   // HQ — added 2026-07-29. openId PENDING: have him assign ONE Lark row, then read the id back off that exact row (never name-harvest — duplicate/stale accounts exist). Until then WhatsApp DM + rotation work; the Lark Salesman cell stays blank (both write paths guard on empty openId).
};

// ---- Deterministic filename/caption flags ----
const ALL_NAMES = Object.keys(STAFF);
// Fuzzy roster match: staff spell names loosely (nabeel→Nabil, allysa/alisa, etc.)
function matchStaff(raw){
  const w = (raw || '').trim().toLowerCase();
  if (!w) return { name: '', requested: '' };
  let hit = ALL_NAMES.find(n => n.toLowerCase() === w);                 // exact
  if (!hit) hit = ALL_NAMES.find(n => n.toLowerCase().startsWith(w) || w.startsWith(n.toLowerCase())); // prefix either way
  if (!hit) {                                                          // edit-distance ≤2 (nabeel↔nabil)
    const lev = (a,b)=>{const m=[...Array(a.length+1)].map((_,i)=>[i,...Array(b.length).fill(0)]);for(let j=1;j<=b.length;j++)m[0][j]=j;for(let i=1;i<=a.length;i++)for(let j=1;j<=b.length;j++)m[i][j]=Math.min(m[i-1][j]+1,m[i][j-1]+1,m[i-1][j-1]+(a[i-1]===b[j-1]?0:1));return m[a.length][b.length];};
    let best='',bd=99; for(const n of ALL_NAMES){const dd=lev(w,n.toLowerCase()); if(dd<bd){bd=dd;best=n;}}
    if (bd<=2) hit = best;
  }
  return { name: hit || '', requested: raw.trim() };
}
// ---- Reply identity: PHONE ONLY (2026-07-30) — full rationale + tests in identity.js ----
// matchStaff() above stays fuzzy, but ONLY for caption/filename overrides, which STAFF write.
// Deciding "is this inbound sender a rep?" goes through the phone number, never the pushname.
const identity = require('./identity');
const STAFF_BY_LAST9 = identity.byLast9(STAFF);
function staffNameByPhone(phone){ return identity.nameByPhone(STAFF_BY_LAST9, phone); }
function fileOverrides(name){
  const f = (name || '');
  const am = f.match(/\(([^)]+)\)/);
  const m = am ? matchStaff(am[1]) : { name: '', requested: '' };
  const assignee = m.name;
  const requestedName = m.requested && !m.name ? m.requested : '';   // named someone we couldn't match → flag it
  const origin = /(^|\+|\s)live\b/i.test(f) ? 'TIKTOK LIVE (Get leads)' : '';
  const lf = f.toLowerCase();

  // TEAM override (Benjamin/Harith 2026-07-21): a caption/filename naming TWO OR MORE teams
  // (e.g. "hq + shah alam" on an event Excel) restricts EVERY lead in that drop to rotate
  // across ONLY those teams' pools combined — instead of each lead routing individually by
  // its own brand. Naming exactly ONE team/brand keyword keeps today's normal single-BRAND
  // override behavior unchanged (e.g. "tiktok dm honda" still just forces brand=Honda).
  const teamHits = new Set();
  if (/\bhq\b/.test(lf)) teamHits.add('HQ');
  if (/\bhonda\b/.test(lf)) teamHits.add('Honda');
  if (/\bklang\b|\bks\b/.test(lf)) teamHits.add('KS');
  if (/\bshah\s*alam\b/.test(lf)) teamHits.add('ShahAlam');
  const teamOverride = teamHits.size >= 2 ? [...teamHits] : null;

  // BRAND from filename/caption ("get lead lambretta", "ads tiktok thunder", "tiktok dm hq") → force on all leads in the file.
  // Skipped when a teamOverride is active — team routing wins, brand still comes from the AI/model per-lead for record-keeping.
  const BRAND_DISPLAY = { lambretta:'Lambretta', thunder:'Thunder', honda:'Honda', suzuki:'Suzuki', ktm:'KTM', zontes:'Zontes', hq:'HQ' };
  const bkey = (!teamOverride && Object.keys(BRAND_DISPLAY).find(b => new RegExp('\\b' + b + '\\b').test(lf))) || '';
  const brand = bkey ? BRAND_DISPLAY[bkey] : '';
  return { assignee, origin, requestedName, brand, teamOverride };
}

// Valid Brand single-select options in Lark (anything else is coerced away so the field never gets junk).
const VALID_BRANDS = new Set(['HQ','Honda','Lambretta','Thunder','KTM','Zontes','Aveta']);   // Suzuki/Kawasaki dropped → non-TM brands coerce to HQ (PIC); Aveta = own brand → HQ pool

// ---- Model / text → Brand inference ----
// Staff often drop just a bike MODEL (image caption / Excel cell) with no brand word.
// Detect the brand from the text so the lead auto-tags + routes without asking the group.
// Order matters: explicit brand word first, then model families, then the Modenas/QJ house line.
// Returns '' when nothing matches — the caller then defaults to HQ (TM's catch-all desk).
function brandFromModel(text){
  const t = (text || '').toLowerCase();
  // 1) an explicit TM brand name. Non-TM brands (Suzuki/Kawasaki/Yamaha/Ducati/BMW) are NOT matched
  //    here — per PIC they all go to the HQ catch-all desk, so they fall through to '' → HQ default.
  if (/\bhonda\b/.test(t))      return 'Honda';
  if (/\blambretta\b/.test(t))  return 'Lambretta';
  if (/\bthunder\b/.test(t))    return 'Thunder';
  if (/\bktm\b/.test(t))        return 'KTM';
  if (/\bzontes\b|\b368\s?[a-z]\b/.test(t)) return 'Zontes';   // Zontes incl. the 368 series (PIC: 368 = Zontes)
  if (/\baveta\b/.test(t))      return 'Aveta';                // Aveta = brand, Nova = model (PIC); routes to HQ pool
  // 2) Honda model families — CBR INCLUDED (PIC: CBR → Honda)
  if (/\bcbr\b|\bcbr\d|\bcb\d|\brs\s?150|\brs-?x\b|\bwave\s?\d*|\bpcx\s?\d*|\bvario\s?\d*|\badv\s?\d|\bafrica\s?twin\b|\bcrf\b|\brebel\b|\bdax\b|\bmonkey\b|\bex5\b|\bcub\b/.test(t)) return 'Honda';
  // 3) Lambretta model families (x-series, v-special, g350)
  if (/\bx1[2-5]0\b|\bx250\b|\bx300\b|\bv-?special\b|\bg350\b|\bxpa\b/.test(t)) return 'Lambretta';
  // 4) Modenas / QJ Motor / Benda house line → HQ
  if (/\b(moda\s*)?moca\b|\bmica\b|\bmodenas\b|\bz15\s*?gt\b|\bmoda\b|\bqj\b|\bbenda\b/.test(t)) return 'HQ';
  return '';
}

// ---- Assignment (persistent take-turns across drops; resets only on deploy) ----
const ROT = {};
function assignLeads(leads, ov, unavail){
  ov = ov || {}; unavail = unavail || new Set();
  return leads.map(l => {
    if (ov.brand) l.brand = ov.brand;   // filename/caption brand wins → fills the gap so the lead gets a pool + salesman
    // Normalize: keep a valid known brand as-is; otherwise infer from the model, then default to HQ.
    // Guarantees the Brand column is ALWAYS a valid option and never blank → bot keys it straight
    // into Lark instead of leaving it empty and asking the group to reply.
    if (!VALID_BRANDS.has(l.brand)) l.brand = brandFromModel(l.interest || l.name || '') || 'HQ';
    let assignee = ov.assignee || '';
    if (!assignee && !ov.noAssign) {
      let team, pool;
      if (ov.teamOverride && ov.teamOverride.length) {
        // Combined multi-team rotation (e.g. ["HQ","ShahAlam"]) — one shared round-robin
        // across every rep from every named team, ignoring this lead's own brand.
        team = [...ov.teamOverride].sort().join('+');
        pool = [...new Set(ov.teamOverride.flatMap(k => POOLS[k] || []))];
      } else {
        [team, pool] = poolForBrand(l.brand);
      }
      const avail = pool.filter(n => !unavail.has(n.toLowerCase()));   // skip anyone marked "NO" in the Lark availability sheet
      const usePool = avail.length ? avail : pool;                     // if the whole pool is OFF, fall back to all (never drop a lead)
      if (usePool.length) { const idx = ROT[team] || 0; assignee = usePool[idx % usePool.length]; ROT[team] = idx + 1; }
    }
    const staff = STAFF[assignee] || null;
    const want = (l.interest && !/^\s*no question\s*$/i.test(l.interest)) ? l.interest : (l.name || 'No question');
    const origin = ov.origin || l.origin || 'Whatsapp';
    return { phone: l.phone || '', name: l.name || '', want, brand: l.brand || '', origin, assignee, staff, override: !!ov.assignee, requestedName: ov.requestedName || '' };
  });
}

// ---- Lark write ----
const LARK_BASE = 'https://open.larksuite.com/open-apis';
const LARK_APP_ID = process.env.LARK_APP_ID || '';
const LARK_APP_SECRET = process.env.LARK_APP_SECRET || '';
const LARK_APP_TOKEN = process.env.LARK_APP_TOKEN || '';
const LARK_TABLE_ID = process.env.LARK_TABLE_ID || '';
let _lt = { t: '', exp: 0 };
async function larkToken(){
  if (_lt.t && Date.now() < _lt.exp) return _lt.t;
  const r = await fetch(LARK_BASE + '/auth/v3/tenant_access_token/internal/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ app_id: LARK_APP_ID, app_secret: LARK_APP_SECRET }) });
  const j = await r.json();
  if (!j.tenant_access_token) throw new Error('lark token: ' + JSON.stringify(j).slice(0, 120));
  _lt = { t: j.tenant_access_token, exp: Date.now() + ((j.expire || 7200) - 120) * 1000 };
  return _lt.t;
}

// ---- Salesman availability (Lark Sheet) → set of names marked "NO" (skip them in rotation). Cached 5 min. ----
const AVAIL_SHEET = process.env.AVAIL_SHEET || 'YjLTslshkhRGeXt9V5DlJi8cgdl';
let _unavail = new Set(), _unavailTs = 0;
async function getUnavailable(){
  if (Date.now() - _unavailTs < 5 * 60 * 1000) return _unavail;
  try {
    const tok = await larkToken();
    const meta = await (await fetch(`${LARK_BASE}/sheets/v3/spreadsheets/${AVAIL_SHEET}/sheets/query`, { headers: { 'Authorization': 'Bearer ' + tok } })).json();
    const sid = meta.data.sheets[0].sheet_id;
    const vals = await (await fetch(`${LARK_BASE}/sheets/v2/spreadsheets/${AVAIL_SHEET}/values/${sid}!A1:B60`, { headers: { 'Authorization': 'Bearer ' + tok } })).json();
    const rows = (vals.data && vals.data.valueRange && vals.data.valueRange.values) || [];
    const un = new Set();
    for (const row of rows) { const name = row[0], av = row[1]; if (name && /^\s*no\s*$/i.test(String(av || ''))) un.add(String(name).trim().toLowerCase()); }
    _unavail = un; _unavailTs = Date.now();
    log('availability refreshed — OFF:', [...un].join(', ') || '(none)');
  } catch (e) { log('getUnavailable err', String(e.message || e)); }
  return _unavail;
}

// ---- Availability toggle WATCHER → announce in the AI Agent internal group (polls every 2 min) ----
let _availSnap = null;   // name -> 'YES'/'NO' (last full state); null until baselined
async function readAvail(){
  const tok = await larkToken();
  const meta = await (await fetch(`${LARK_BASE}/sheets/v3/spreadsheets/${AVAIL_SHEET}/sheets/query`, { headers: { 'Authorization': 'Bearer ' + tok } })).json();
  const sid = meta.data.sheets[0].sheet_id;
  const vals = await (await fetch(`${LARK_BASE}/sheets/v2/spreadsheets/${AVAIL_SHEET}/values/${sid}!A1:B60`, { headers: { 'Authorization': 'Bearer ' + tok } })).json();
  const rows = (vals.data && vals.data.valueRange && vals.data.valueRange.values) || [];
  const m = {};
  for (const row of rows) { const name = row[0], av = String(row[1] || '').trim().toUpperCase(); if (name && (av === 'YES' || av === 'NO')) m[String(name).trim()] = av; }
  return m;
}
async function pollAvailability(){
  try {
    const cur = await readAvail();
    if (!Object.keys(cur).length) return;                       // read failed/empty → skip (don't reset baseline)
    if (_availSnap === null){ _availSnap = cur; log('availability baseline (' + Object.keys(cur).length + ' staff)'); return; }
    const lines = [];
    for (const name in cur){ if (_availSnap[name] && _availSnap[name] !== cur[name]) lines.push(cur[name] === 'NO' ? `🔴 ${name} → OFF (no new leads)` : `✅ ${name} → back ON`); }
    if (lines.length){
      const off = Object.keys(cur).filter(n => cur[n] === 'NO');
      await alertReview('🔔 *Salesman availability changed*\n' + lines.join('\n') + (off.length ? `\n\nCurrently OFF: ${off.join(', ')}` : '\n\nEveryone available ✅'));
      log('availability toggle:', lines.join(' | '));
    }
    _availSnap = cur;
  } catch (e){ log('pollAvailability err', String(e.message || e)); }
}
setInterval(pollAvailability, 2 * 60 * 1000);
setTimeout(pollAvailability, 8000);   // baseline shortly after startup

async function larkWriteLead(l){
  const tok = await larkToken();
  const fields = { 'Phone number': l.phone || '', 'Customer want': l.want || 'No question', 'Stage': 'Passed lead' };
  if (l.brand) fields['Brand'] = l.brand;
  if (l.origin) fields['Origin'] = l.origin;
  if (l.staff?.openId) fields['Salesman'] = [{ id: l.staff.openId }];
  // ---- SLA: stamp the assignment (T+0) so the lead is monitorable in Lark from creation ----
  if (l.assignee) {
    const nowMs = Date.now();
    const inH = sla ? sla.inHours(nowMs) : true;
    fields['SLA Assigned At'] = nowMs;
    fields['SLA Original Salesman'] = l.assignee;
    // 'Queued' = bulk lead whose salesperson DM is still drip-feed-pending (drainBulkQueue flips
    // it to Pending at real DM time). Keeps the sweep off it (Assigned At is set) AND the boot
    // rehydrator's timer restore off it (filters Status=Pending), while marking it recoverable.
    fields['SLA Status'] = l.queued ? 'Queued' : inH ? 'Pending' : 'Off-hours';
    fields['SLA Reassign Count'] = 0;
  }
  const r = await fetch(`${LARK_BASE}/bitable/v1/apps/${LARK_APP_TOKEN}/tables/${LARK_TABLE_ID}/records`, { method: 'POST', headers: { 'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: JSON.stringify({ fields }) });
  const j = await r.json();
  if (j.code !== 0) throw new Error('lark code ' + j.code + ' ' + (j.msg || ''));
  return j.data?.record?.record_id;
}

// ---- SLA: update a lead's Salesman field on reassign ----
async function larkUpdateSalesman(recordId, openId){
  if (!recordId || !openId) return;
  const tok = await larkToken();
  await fetch(`${LARK_BASE}/bitable/v1/apps/${LARK_APP_TOKEN}/tables/${LARK_TABLE_ID}/records/${recordId}`, { method: 'PUT', headers: { 'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: { Salesman: [{ id: openId }] } }) });
}

// ---- SLA: patch any set of SLA columns on a lead row (response/reassign/nudge/escalate) ----
async function larkUpdateSLA(recordId, fields){
  if (!recordId || !fields || !Object.keys(fields).length) return;
  const tok = await larkToken();
  await fetch(`${LARK_BASE}/bitable/v1/apps/${LARK_APP_TOKEN}/tables/${LARK_TABLE_ID}/records/${recordId}`, { method: 'PUT', headers: { 'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: JSON.stringify({ fields }) });
}

// ---- SLA SWEEP: enrol EVERY lead in Lark, whatever created it (TikTok engine, sync.py, manual). ----
// Any row that HAS a salesperson but NO SLA timer yet → DM the rep, start the 75-min clock, stamp SLA cols.
// Safety: gated by SLA_SWEEP=1, only touches leads created at/after SLA_SWEEP_FROM (epoch-ms), capped per run,
// working-hours only. This means it can never blast the 5,700 historical rows.
// Blank openIds are FILTERED OUT here — see identity.js for the incident this prevents (Fitri's
// Salesman-less trade-in rows resolving to Ikhwan, who carries `openId: ''`).
const STAFF_BY_OPENID = identity.byOpenId(STAFF);
// Roster drift must be LOUD, not silent (cf. the POOLS-vs-Lark-sheet drift that hid Ikhwan for weeks).
for (const w of identity.rosterWarnings(STAFF)) log('⚠️ ROSTER: ' + w);
const SLA_SWEEP_FROM = parseInt(process.env.SLA_SWEEP_FROM || '0', 10);   // 0 = disabled (no cutoff → never enrol)
const SLA_SWEEP_CAP  = parseInt(process.env.SLA_SWEEP_CAP  || '15', 10);
function slaFieldText(v){ if (Array.isArray(v)) return v.map(slaFieldText).join(' '); if (v && typeof v === 'object') return v.text || v.name || ''; return v == null ? '' : String(v); }
function slaRecCreated(f){ for (const k of ['date created','Created on','Last modified on']){ const n = parseInt(slaFieldText(f[k]), 10); if (n) return n; } return 0; }
async function larkSearch(body){
  const tok = await larkToken();
  const r = await fetch(`${LARK_BASE}/bitable/v1/apps/${LARK_APP_TOKEN}/tables/${LARK_TABLE_ID}/records/search?page_size=100`, { method: 'POST', headers: { 'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (j.code !== 0) throw new Error('lark search ' + j.code + ' ' + (j.msg || ''));
  return j.data?.items || [];
}
async function slaSweep(){
  if (!sla || !SLA_SWEEP_FROM) return;             // disabled unless a cutoff is set
  const now = Date.now();
  if (!sla.inHours(now)) return;                    // enrol only in working hours (matches the T+0 rule)
  const items = await larkSearch({
    filter: { conjunction: 'and', conditions: [
      { field_name: 'Salesman', operator: 'isNotEmpty', value: [] },
      { field_name: 'SLA Assigned At', operator: 'isEmpty', value: [] },
    ]},
    sort: [{ field_name: 'date created', desc: true }],
  });
  let done = 0, skipPre = 0, skipRep = 0;
  for (const it of items){
    if (done >= SLA_SWEEP_CAP) break;
    const f = it.fields || {};
    if (slaRecCreated(f) < SLA_SWEEP_FROM) { skipPre++; continue; }   // SAFETY: never enrol pre-cutoff (historical) leads
    const sm = f['Salesman'];
    const oid = Array.isArray(sm) ? (sm[0]?.id || '') : '';
    const rep = STAFF_BY_OPENID[oid];
    if (!rep) { skipRep++; continue; }                        // salesperson not in roster / no phone → can't DM, skip
    const model = slaFieldText(f['Customer want']) || 'No question';
    const brand = slaFieldText(f['Brand']);
    const cust  = slaFieldText(f['Phone number']);
    const digits = cust.replace(/\D/g, '');
    const dm = [`🔔 *New Lead — ${brand || 'TM Motoworld'}*`, ``, `🎯 Wants: ${model}`, digits ? `👉 https://wa.me/${digits}` : ``, ``, `✅ Reply YES once you have contacted this lead`].filter(Boolean).join('\n');
    const dmMsgId = await waSend(rep.phone, dm);
    sla.register(rep.name, rep.phone, [{ recordId: it.record_id, summary: model, brand, custName: '', custPhone: cust, override: true }], dmMsgId);  // sweep = Salesman already set in Lark (deliberate/manual) → protect from auto-move
    try { await larkUpdateSLA(it.record_id, { 'SLA Assigned At': now, 'SLA Original Salesman': rep.name, 'SLA Status': 'Pending', 'SLA Reassign Count': 0 }); }
    catch (e){ log('sweep SLA-write err', String(e.message || e)); }
    done++;
  }
  if (done) log(`SLA sweep: enrolled ${done} lead(s) (cap ${SLA_SWEEP_CAP})`);
  else if (skipRep) log(`SLA sweep: 0 enrolled — ${skipRep} candidate(s) have a salesperson not in the roster (check STAFF map)`);   // precutoff-only = steady state, stay quiet
}
// ---- Rehydrate-from-Lark on boot (2026-07-24, Benjamin approved): Render deploys wipe the
// ephemeral disk (sla_store.json / fr_state.json / fr_deferred.json). Lark is the durable record —
// rebuild what matters from it so a deploy stops costing in-flight SLA timers, stops re-greeting
// chats the bot already touched (2026-07-24 12:24 artifact), and stops losing queued off-hours
// leads. Kill switch: REHYDRATE=0. Runs once, ~20s after boot.
const REHYDRATE_ON = process.env.REHYDRATE !== '0';
async function rehydrateFromLark(){
  if (!REHYDRATE_ON || !LIVE_LARK) return;
  const now = Date.now();
  // 1) Pending SLA timers assigned in the last 4h — restored with their ORIGINAL assign time so
  // the 60/75-min clocks resume, not restart. No DM re-send (reps already have it). override=true:
  // after a restart we can't tell round-robin from deliberate, and wrongly auto-moving a
  // deliberate lead is the worse failure (nudge/escalate still fire).
  try {
    if (sla){
      const items = await larkSearch({
        filter: { conjunction: 'and', conditions: [
          { field_name: 'SLA Assigned At', operator: 'isNotEmpty', value: [] },
          { field_name: 'SLA Status', operator: 'is', value: ['Pending'] },
        ]},
        sort: [{ field_name: 'date created', desc: true }],
      });
      let n = 0;
      for (const it of items){
        const f = it.fields || {};
        const at = parseInt(slaFieldText(f['SLA Assigned At']), 10) || 0;
        if (!at || now - at > 4 * 3600e3) continue;
        const oid = Array.isArray(f['Salesman']) ? (f['Salesman'][0]?.id || '') : '';
        const orig = slaFieldText(f['SLA Original Salesman']);
        const rep = STAFF_BY_OPENID[oid] || (STAFF[orig] ? { name: orig, phone: STAFF[orig].phone } : null);
        if (!rep) continue;
        sla.register(rep.name, rep.phone, [{ recordId: it.record_id, summary: slaFieldText(f['Customer want']), brand: slaFieldText(f['Brand']), custName: '', custPhone: slaFieldText(f['Phone number']), override: true, assignedAt: at, firstAssignedAt: at }], null);
        n++;
      }
      if (n) log(`rehydrate: ${n} pending SLA timer(s) restored from Lark`);
    }
  } catch(e){ log('rehydrate SLA err:', String(e.message||e).slice(0,80)); }
  // 2) FR greeted map — WhatsApp Direct leads from the last 7 days → never re-greet those chats.
  try {
    const items = await larkSearch({
      filter: { conjunction: 'and', conditions: [{ field_name: 'Origin', operator: 'is', value: ['WhatsApp Direct'] }] },
      sort: [{ field_name: 'date created', desc: true }],
    });
    const entries = [];
    for (const it of items){
      const f = it.fields || {};
      const created = slaRecCreated(f);
      if (!created || now - created > 7 * 24 * 3600e3) continue;
      const digits = slaFieldText(f['Phone number']).replace(/\D/g, '');
      if (digits) entries.push({ jid: digits + '@s.whatsapp.net', ts: created });
    }
    const n = firstresponse.rehydrateGreeted(entries);
    if (n) log(`rehydrate: ${n} greeted chat(s) restored (no re-greets after deploy)`);
  } catch(e){ log('rehydrate greeted err:', String(e.message||e).slice(0,80)); }
  // 3) Off-hours FR leads still UNASSIGNED in Lark (<36h) whose deferred staff-notify queue died
  // with the disk → re-queue for the 9am drain. Trade-ins excluded (Fitri DM text isn't safely
  // reconstructable); dedup by recordId so a plain restart (queue intact) adds nothing.
  try {
    const items = await larkSearch({
      filter: { conjunction: 'and', conditions: [
        { field_name: 'Origin', operator: 'is', value: ['WhatsApp Direct'] },
        { field_name: 'Salesman', operator: 'isEmpty', value: [] },
      ]},
      sort: [{ field_name: 'date created', desc: true }],
    });
    const have = new Set(frDeferred.map(e => e.recordId).filter(Boolean));
    let n = 0;
    for (const it of items){
      const f = it.fields || {};
      const created = slaRecCreated(f);
      const want = slaFieldText(f['Customer want']);
      if (!created || now - created > 36 * 3600e3) continue;
      if (/^TRADE-IN:/i.test(want) || f['SLA Assigned At'] || have.has(it.record_id)) continue;
      const digits = slaFieldText(f['Phone number']).replace(/\D/g, '');
      if (!digits) continue;
      frDeferred.push({ kind: 'pool', phone: digits, want: want || 'WhatsApp direct inquiry', brand: slaFieldText(f['Brand']), recordId: it.record_id, queuedAt: created });
      n++;
    }
    if (n){ frDeferPersist(); log(`rehydrate: ${n} deferred off-hours lead(s) re-queued from Lark`); }
  } catch(e){ log('rehydrate deferred err:', String(e.message||e).slice(0,80)); }
  // 4) Bulk drip-feed queue (2026-07-24 evening) — rows stamped SLA Status='Queued' are bulk leads
  // whose salesperson DM never went out before the disk was wiped. Rebuild them into ONE job so
  // drainBulkQueue resumes the throttled trickle (batches of BULK_BATCH_SIZE, business hours).
  // override:false — Queued only ever comes from the bulk round-robin path.
  try {
    const items = await larkSearch({
      filter: { conjunction: 'and', conditions: [{ field_name: 'SLA Status', operator: 'is', value: ['Queued'] }] },
      sort: [{ field_name: 'date created', desc: false }],
    });
    const have = new Set(bulkQueue.flatMap(j => j.batches.flat()).map(l => l.recordId).filter(Boolean));
    const leads = [];
    for (const it of items){
      if (have.has(it.record_id)) continue;
      const f = it.fields || {};
      if (now - (slaRecCreated(f) || 0) > 7 * 24 * 3600e3) continue;
      const oid = Array.isArray(f['Salesman']) ? (f['Salesman'][0]?.id || '') : '';
      const rep = STAFF_BY_OPENID[oid];
      if (!rep) continue;
      leads.push({ recordId: it.record_id, phone: slaFieldText(f['Phone number']), name: '', want: slaFieldText(f['Customer want']), brand: slaFieldText(f['Brand']), assignee: rep.name, staff: { phone: rep.phone, openId: oid }, override: false });
    }
    if (leads.length){
      bulkQueue.push({ chatId: INTAKE_GROUP_JID, screenshotUrl: '', total: leads.length, sent: 0, batches: chunk(leads, BULK_BATCH_SIZE) });
      bulkPersist();
      log(`rehydrate: ${leads.length} bulk-queued lead(s) rebuilt from Lark (drip-feed resumes)`);
    }
  } catch(e){ log('rehydrate bulk err:', String(e.message||e).slice(0,80)); }
}

// ---- SLA: pick the next rep in the brand's region pool (skip current + unavailable) ----
async function pickNextRep(brand, currentKey, exclude){
  const ex = new Set(exclude && exclude.length ? exclude : [currentKey]);
  const [team, pool] = poolForBrand(brand);
  let unavail = new Set(); try { unavail = await getUnavailable(); } catch {}
  const cands = pool.filter(n => !ex.has(n) && !unavail.has(n.toLowerCase()) && STAFF[n]?.phone);
  if (!cands.length) return null;
  const idx = (ROT[team] || 0); ROT[team] = idx + 1;
  const name = cands[idx % cands.length];
  return { key: name, name, phone: STAFF[name].phone, openId: STAFF[name].openId };
}
// ---- SLA wiring (gated by SLA_ON=1 — dormant until activated) ----
const SLA_ON = process.env.SLA_ON === '1';
let sla = null;
if (SLA_ON){
  sla = require('./sla');
  sla.init({ waSend, waDelete, larkUpdateSalesman, larkUpdateSLA, groupNotify: alertReview, digestPush, pickNextRep, log });
  setInterval(() => { try { sla.tick(); } catch (e) { log('sla tick err', String(e.message||e)); } }, 60 * 1000);
}
setInterval(() => { drainBulkQueue().catch(e => log('bulk drain err', String(e.message||e))); }, BULK_DRAIN_MS);
// ---- First-response bot wiring (FIRSTRESPONSE_ON=1) — deps injected AFTER sla so it can register SLA timers ----
const firstresponse = require('./firstresponse');

// ---- FR lead-distribution window (team 2026-07-22): the bot replies to customers 24/7, but
// salesmen are only assigned/DM'd Mon–Fri 9am–5pm MYT. Outside the window, assign() writes the
// lead to Lark UNASSIGNED and queues the staff-facing half here; the drain below releases it when
// the window opens (round-robin runs at drain, SLA columns stamped so slaSweep doesn't double-DM).
// NOTE: deliberately narrower than SLA_DAYS (Mon–Sat) — the SAT SLA day covers staff-dropped group
// leads; the team explicitly wants FR auto-leads held to Mon–Fri. Envs: FR_DIST_DAYS/START/END.
const FR_DIST_DAYS  = (process.env.FR_DIST_DAYS || '1,2,3,4,5').split(',').map(Number);
const FR_DIST_START = Number(process.env.FR_DIST_START || 9);
const FR_DIST_END   = Number(process.env.FR_DIST_END || 17);
function inFRDistHours(){ const d = new Date(Date.now() + MYT_OFF); return FR_DIST_DAYS.includes(d.getUTCDay()) && d.getUTCHours() >= FR_DIST_START && d.getUTCHours() < FR_DIST_END; }
const FR_DEFER_FILE = _path.join(__dirname, 'fr_deferred.json');
let frDeferred = []; try { frDeferred = JSON.parse(_fs.readFileSync(FR_DEFER_FILE, 'utf8')); } catch { /* fresh */ }
function frDeferPersist(){ try { _fs.writeFileSync(FR_DEFER_FILE, JSON.stringify(frDeferred)); } catch {} }
function deferStaffNotify(entry){ frDeferred.push({ ...entry, queuedAt: Date.now() }); frDeferPersist(); }
let frDraining = false;
async function drainFRDeferred(){
  if (frDraining || !frDeferred.length || !inFRDistHours()) return;
  frDraining = true;
  try {
    log(`🌅 FR deferred drain: releasing ${frDeferred.length} overnight lead(s)`);
    while (frDeferred.length && inFRDistHours()){
      const e = frDeferred[0];
      try {
        if (e.kind === 'dm'){                       // trade-in → Fitri (plain DM, no pool/SLA)
          await waSend(e.to, e.text);
        } else {                                    // pool lead: rotate NOW, then Lark + DM + SLA
          const unavail = await getUnavailable();
          const l = assignLeads([{ phone: e.phone, name: '', interest: e.want, brand: e.brand }], { origin: 'WhatsApp Direct' }, unavail)[0];
          l.recordId = e.recordId;
          if (e.recordId && l.staff?.openId) { try { await larkUpdateSalesman(e.recordId, l.staff.openId); } catch(err){ log('FR drain lark err', String(err.message||err).slice(0,60)); } }
          // stamp SLA cols ourselves — a row with Salesman but no 'SLA Assigned At' would be
          // re-enrolled (double-DM'd) by slaSweep within 3 minutes
          if (e.recordId) { try { await larkUpdateSLA(e.recordId, { 'SLA Assigned At': Date.now(), 'SLA Original Salesman': l.assignee, 'SLA Status': 'Pending', 'SLA Reassign Count': 0 }); } catch(err){ log('FR drain SLA-write err', String(err.message||err).slice(0,60)); } }
          const dmMsgId = await notifyStaff([l]);
          if (sla && l.staff?.phone) sla.register(l.assignee, l.staff.phone, [{ recordId: e.recordId, summary: e.want, brand: l.brand, custName: '', custPhone: e.phone, override: false }], dmMsgId);
          log(`FR 🌅 deferred lead assigned → ${l.assignee || '(pool empty?)'} (${e.phone}) "${e.want}"`);
        }
      } catch(err){ log('FR drain err', String(err.message||err).slice(0,80)); }
      frDeferred.shift(); frDeferPersist();         // one entry = one attempt — never retry-loop a bad entry
    }
  } finally { frDraining = false; }
}
setInterval(() => { drainFRDeferred().catch(e => log('FR drain tick err', String(e.message||e))); }, 60 * 1000);

{
  const FR_EXTRA_INTERNAL = new Set(['60162393812','60108093259','60102304152','60123534271','60182907538','601143991899']);
  const staffLast9 = new Set(Object.values(STAFF).map(s => String(s.phone || '').replace(/\D/g, '').slice(-9)).filter(Boolean));
  const isStaffPhone = p => { const d = String(p || '').replace(/\D/g, ''); return !!d && (staffLast9.has(d.slice(-9)) || FR_EXTRA_INTERNAL.has(d)); };
  firstresponse.init({ waSend, assignLeads, larkWriteLead, notifyStaff, sla, getUnavailable, log, isStaffPhone, wooCheckStock, aiClassify, inDistHours: inFRDistHours, deferStaffNotify });
  setTimeout(() => rehydrateFromLark().catch(e => log('rehydrate err:', String(e.message||e).slice(0,80))), 20000);
  if (SLA_ON){   // these belong to the SLA engine — keep them gated exactly as before the FR wiring
    // SLA SWEEP — enrol every new Lark lead (any source) into SLA. OFF unless SLA_SWEEP=1 + SLA_SWEEP_FROM set.
    if (process.env.SLA_SWEEP === '1'){
      setInterval(() => { slaSweep().catch(e => log('sla sweep err', String(e.message||e))); }, 3 * 60 * 1000);
      log('🧹 SLA sweep ON — every ' + '3min, from ' + (SLA_SWEEP_FROM || 'DISABLED (no cutoff)') + ', cap ' + SLA_SWEEP_CAP);
    }
    // GROUP UPDATES: no more 1-by-1 spam — ONE batched summary at 12PM + 6PM MYT (routine flags/reassigns buffered via digestPush)
    setInterval(() => { digestTick().catch(e => log('digest tick err', String(e.message || e))); }, 5 * 60 * 1000);
    log('⏱️ SLA engine ON — reassign ' + (process.env.SLA_REASSIGN === '1' ? 'ON' : 'PAUSED') + ', group summary 12PM+6PM');
  }
}

// ---- Notify the assigned salesperson via TM Motor Marketing WaSender ----
// Consolidated: ONE message per salesperson (even if they got several leads in one drop).
function notifyText(leads){
  if (leads.length === 1) {
    const l = leads[0]; const d = (l.phone || '').replace(/\D/g, '');
    return [`🔔 *New Lead — ${l.brand || 'TM Motoworld'}*`, ``, `👤 ${l.name || '—'}`, `🎯 Wants: ${l.want}`, `📍 From: ${l.origin}`, d ? `👉 https://wa.me/${d}` : ''].filter(Boolean).join('\n');
  }
  const head = `🔔 *${leads.length} New Leads*`;
  const blocks = leads.map((l, i) => {
    const d = (l.phone || '').replace(/\D/g, '');
    return [`*${i + 1}.* 👤 ${l.name || '—'}`, `🎯 ${l.want} · ${l.brand || ''} · ${l.origin}`, d ? `👉 https://wa.me/${d}` : ''].filter(Boolean).join('\n');
  });
  return head + '\n\n' + blocks.join('\n\n');
}
async function notifyStaff(leads, screenshotUrl){
  const phone = (leads[0].staff?.phone || '').replace(/\D/g, '');
  if (!phone) return null;
  // For a single image lead, send the actual screenshot + details so the salesperson sees the full convo.
  const txt = notifyText(leads) + (SLA_ON ? '\n\n✅ Reply anything once you have contacted this lead (or *PASS* to hand it over).' : '');
  const mid = (screenshotUrl && leads.length === 1) ? await waSend(phone, txt, screenshotUrl) : await waSend(phone, txt);
  return mid;   // msgId for the SLA (delete on reassign)
}

// One consolidated notify per salesperson (the send queue handles 5s spacing + 429 retry) + SLA start.
// Shared by the normal (small-drop) flow and the bulk drain — same assign→notify→SLA contract either way.
async function notifyBatch(enriched, screenshotUrl){
  const byStaff = {};
  for (const l of enriched) { const ph = l.staff?.phone; if (ph) (byStaff[ph] = byStaff[ph] || []).push(l); }
  for (const ph in byStaff) {
    try {
      const dmMsgId = await notifyStaff(byStaff[ph], screenshotUrl);
      if (sla) {   // T+0: start the SLA timer for this rep's lead(s)
        const grp = byStaff[ph];
        sla.register(grp[0].assignee, ph, grp.map(l => ({ recordId: l.recordId, summary: l.want, brand: l.brand, custName: l.name, custPhone: l.phone, override: l.override })), dmMsgId);
      }
    } catch (e) { log('notify err', String(e.message || e).slice(0, 60)); }
  }
}

// Releases ONE batch from the bulk queue (business hours only) — leads are already in Lark from
// the moment they were dropped; this only staggers the WhatsApp notify + SLA-timer-start.
async function drainBulkQueue(){
  if (!bulkQueue.length || !inBusinessHours()) return;
  const job = bulkQueue[0];
  const batch = job.batches.shift();
  if (!batch) { bulkQueue.shift(); bulkPersist(); return; }
  try {
    await notifyBatch(batch, job.screenshotUrl);
    // DM actually sent now → flip Queued→Pending with a fresh Assigned At (rep-fair clock start;
    // also takes the row out of the rehydrator's queue-rebuild set).
    for (const l of batch){
      if (l.recordId) { try { await larkUpdateSLA(l.recordId, { 'SLA Assigned At': Date.now(), 'SLA Status': 'Pending' }); } catch(e){ log('bulk drain SLA-flip err', String(e.message||e).slice(0,60)); } }
    }
    job.sent += batch.length;
    const left = job.total - job.sent;
    if (job.batches.length === 0) {
      bulkQueue.shift();
      await waSend(job.chatId, `✅ Bulk batch complete — all ${job.total} leads have now been assigned & sales team notified.`);
    } else {
      await waSend(job.chatId, `📦 Batch sent — ${batch.length} more leads assigned. ${left} left in queue, next batch in ~${Math.round(BULK_DRAIN_MS / 3600000)}h.`);
    }
  } catch (e) { log('bulk drain err', String(e.message || e).slice(0, 60)); }
  bulkPersist();
}

// ---- Group card (live wording when Lark is on) ----
function renderCard(src, leads, live){
  const head = live
    ? `✅ ${leads.length} LEAD${leads.length > 1 ? 'S' : ''} — ${src} → saved to Lark + salesperson notified`
    : `🧪 ${leads.length} LEAD${leads.length > 1 ? 'S' : ''} PARSED — ${src} (test only, not saved to Lark)`;
  const blocks = leads.map((l, i) => {
    const digits = (l.phone || '').replace(/\D/g, '');
    const aTxt = l.staff
      ? `${l.assignee}${l.override ? ' (file override)' : ''}${l.requestedName ? ` ⚠️"${l.requestedName}" not in roster→rotation` : ''}`
      : (l.assignee ? `${l.assignee} (no phone on file)` : '— (staff to pick)');
    return [
      `${leads.length > 1 ? '*' + (i + 1) + '.* ' : ''}👤 ${l.name || '—'}`,
      `📱 ${l.phone || '— ⚠️ no phone found'}`,
      `🏍️ Wants: ${l.want}`,
      `🏷️ Brand: ${l.brand || '—'}`,
      `📍 From: ${l.origin}`,
      `➡️ Assign: ${aTxt}${live && l.larkErr ? ' ⚠️Lark:' + l.larkErr : ''}`,
      digits ? `👉 https://wa.me/${digits}` : '',
    ].filter(Boolean).join('\n');
  });
  const full = head + '\n\n' + blocks.join('\n\n');
  if (full.length <= 3900) return full;
  // BIG batch → compact summary (WhatsApp caps messages at 4096 chars; the full per-lead card would 422 → no reply)
  const byAssignee = {}; let unassigned = 0;
  for (const l of leads) { if (l.assignee) byAssignee[l.assignee] = (byAssignee[l.assignee] || 0) + 1; else unassigned++; }
  const lines = Object.entries(byAssignee).sort((a, b) => b[1] - a[1]).map(([n, c]) => `• ${n}: ${c}`);
  const compact = [head, '', '*Assigned:*', ...lines];
  if (unassigned) compact.push(`⚠️ ${unassigned} unassigned (no brand → staff to pick)`);
  compact.push('', '👉 Full details in Lark CRM.');
  return compact.join('\n');
}

// Missing-info ask (Option A — notify only): a small drop saved a lead with NO brand → ask the group to fill it.
async function askMissing(chatId, leads){
  const miss = leads.filter(l => !(l.brand || '').trim());
  if (!miss.length) return;
  const L = ['❓ *Missing info — please help fill it in*'];
  for (const l of miss){
    L.push('');
    L.push('👤 ' + (l.name || '—') + ' · ' + (l.phone || 'no phone'));
    L.push('🏍️ Wants: ' + l.want);
    L.push('📍 ' + l.origin + (l.assignee ? (' · ' + l.assignee) : ''));
    L.push('⚠️ *Brand unknown* — what bike / brand is this?');
  }
  L.push('');
  L.push('👉 Reply here, or update the Brand in Lark.');
  await waSend(chatId, L.join('\n'));
}

async function handle(payload){
  // messages.upsert is for INBOX CAPTURE ONLY (manual hand-typed replies → already forwarded to
  // the console). NEVER process it here: it REPLAYS on session reconnect → duplicate Lark writes +
  // repeat salesperson notifies (the cbr-600 spam, 2026-06-17). Lead processing happens ONLY on the
  // original messages-group.received / messages-personal.received delivery.
  if (payload.event === 'messages.upsert') {
    // first-response: a human (or bot) outbound marks the chat as owned — bot stays out of it
    try { const mm0 = pickMessages(payload.data || {}); if (mm0.key && mm0.key.fromMe) firstresponse.markHuman(mm0.key.remoteJid || ''); } catch {}
    return;
  }
  const info = extract(payload);
  if (!info) {
    try { const mm = pickMessages(payload.data || {}); log('NO-EXTRACT event=' + payload.event + ' fromMe=' + (mm.key && mm.key.fromMe) + ' jid=' + (mm.key && mm.key.remoteJid) + ' msgKeys=' + JSON.stringify(Object.keys(unwrap(mm.message || {})))); } catch (e) {}
    // SAFETY NET: a PERSONAL message the parser can't read must still count as a rep acknowledgement —
    // an unknown WhatsApp message type must never silently cost a rep her lead (Syaza sticker, 2026-07-15).
    if (sla && payload.event === 'messages-personal.received') {
      try {
        const k = (pickMessages(payload.data || {}).key) || {};
        if (!k.fromMe) {
          const realPhone = String(k.cleanedSenderPn || k.senderPn || k.participantPn || '').replace(/\D/g, '');
          const jid = k.remoteJid || '';
          const res = await sla.onReply(realPhone, '', '', jid);
          if (res && res.action === 'ack') {
            const to = (STAFF[res.repKey] && STAFF[res.repKey].phone) || jid;
            log('SLA ✅MATCH ack (UNPARSED msg type — safety net): ' + res.repKey + ' acknowledged ' + (res.count || 0) + ' lead(s) [phone=' + realPhone + ' jid=' + jid + ']');
            await waSend(to, '✅ Noted — thanks! Marked as acknowledged.');
          } else if (res && res.action === 'noop') {
            log('SLA ·safety-net noop: ' + res.repKey + ' sent unparsed msg, no pending leads [jid=' + jid + ']');
          }
        }
      } catch (e) { log('SLA safety-net error: ' + (e && e.message)); }
    }
    return;
  }
  const isGroup = info.chatId.endsWith('@g.us');
  log('inbound', info.kind, 'from', info.sender, 'chat', info.chatId, isGroup ? '(group)' : '(personal)');
  remember({ event: 'inbound', src: info.kind, summary: `chat=${info.chatId} ${isGroup ? 'GROUP' : 'personal'} from=${info.sender}` });
  // SLA: a rep replying YES (personal DM to the TM number) confirms their pending leads.
  if (sla && !isGroup && (info.kind === 'text' || info.kind === 'image' || info.kind === 'document' || info.kind === 'reaction' || info.kind === 'sticker')) {
    // The webhook key carries the rep's REAL phone in cleanedSenderPn/senderPn (remoteJid is a @lid privacy id).
    const k = (pickMessages(payload.data || {}).key) || {};
    const realPhone = String(k.cleanedSenderPn || k.senderPn || k.participantPn || '').replace(/\D/g, '')
      || (info.chatId.includes('@lid') ? '' : (info.chatId.split('@')[0] || '').replace(/\D/g, ''));
    // Identity comes from the PHONE, never from the pushname (see staffNameByPhone above).
    const repHint = staffNameByPhone(realPhone);
    const senderIsStaff = !!repHint;
    const text = info.kind === 'text' ? info.text : '';   // sticker/image reply = acknowledgement too (empty text)
    const res = await sla.onReply(realPhone, text, repHint, info.chatId);   // phone (real) → name → learned-lid
    // OBSERVABILITY: every potential rep reply logs a distinct line so we can SEE ack-tracking working.
    // BELT-AND-BRACES (2026-07-30): an ack/pass may only short-circuit the handler for a sender we
    // TRUST — a verified staff phone, or a @lid learned alongside one. Anything else falls through to
    // first-response, so a mis-identified sender costs us a log line, never a customer's enquiry.
    const trusted = senderIsStaff || res?.via === 'lid';
    if (res && (res.action === 'ack' || res.action === 'pass') && !trusted) {
      log('SLA ⚠️REFUSED ' + res.action + ': sender is not a known staff phone — treating as CUSTOMER [phone=' + realPhone + ' claimed=' + res.repKey + ' jid=' + info.chatId + ']');
    }
    else if (res && res.action === 'pass') { const to = (STAFF[res.repKey] && STAFF[res.repKey].phone) || info.chatId; log('SLA ✅MATCH pass: ' + res.repKey + ' passed ' + (res.count||0) + ' lead(s) [phone=' + realPhone + ' via=' + res.via + ' jid=' + info.chatId + ']'); await waSend(to, '🔄 Got it — passing this lead to another salesperson.'); return; }
    else if (res && res.action === 'ack')  { const to = (STAFF[res.repKey] && STAFF[res.repKey].phone) || info.chatId; log('SLA ✅MATCH ack: ' + res.repKey + ' acknowledged ' + (res.count||0) + ' lead(s) [phone=' + realPhone + ' via=' + res.via + ' jid=' + info.chatId + ']'); await waSend(to, '✅ Noted — thanks! Marked as acknowledged.'); return; }
    else if (res && res.action === 'noop') { log('SLA ·match noop: ' + res.repKey + ' replied but has no pending leads (already acked?) [phone=' + realPhone + ' via=' + res.via + ' jid=' + info.chatId + ']'); }
    else if (!res) { log('SLA ✖NO-MATCH: personal reply not tracked to any rep [phone=' + realPhone + ' name=' + repHint + ' jid=' + info.chatId + ' text="' + String(text).slice(0,40) + '"]'); }
  }
  // FIRST-RESPONSE BOT (Product/Loan/Trade-in, Benjamin 2026-07-17): instant first touch on
  // customer DMs — fire-and-forget, never blocks lead flow. Guards live inside the module.
  if (!isGroup && (info.kind === 'text' || info.kind === 'image')){
    try {
      const kfr = (pickMessages(payload.data || {}).key) || {};
      const phoneFr = String(kfr.cleanedSenderPn || kfr.senderPn || '').replace(/\D/g, '') || (info.chatId.includes('@lid') ? '' : (info.chatId.split('@')[0] || '').replace(/\D/g, ''));
      firstresponse.onMessage({ jid: info.chatId, phone: phoneFr, kind: info.kind, text: info.kind === 'text' ? info.text : '', caption: info.caption || '' });
    } catch (e) { log('FR hook err', String(e.message||e)); }
  }

  // SAFETY GATE: only ever act/reply inside the designated intake group.
  if (!INTAKE_GROUP_JID || info.chatId !== INTAKE_GROUP_JID) {
    log('SKIP — not intake group (chat=' + info.chatId + ', intake=' + (INTAKE_GROUP_JID || 'UNSET') + ') — captured only, no reply');
    return;
  }
  // DEDUP: a retried webhook must not double-parse / double-write to Lark.
  const mid = (pickMessages(payload.data || {}).key || {}).id || '';
  if (mid) { if (SEEN.has(mid)) { log('dup skip', mid); return; } SEEN.add(mid); if (SEEN.size > 3000) SEEN.clear(); }
  // 🐛→✅ FIXED 2026-07-22: a 👍 REACTION to the bot's own group message has no real content
  // (kind='reaction', text=''), but the code fell through to the generic extraction path with an
  // EMPTY blocks array — the AI was handed nothing but its OWN instruction prompt (which contains
  // worked EXAMPLES like "mas.saifuddin" / "John Doe" / "+60123456789") and hallucinated 4 fake
  // leads FROM those examples, which got written to Lark + WhatsApp-notified to real salespeople
  // (Syaza/Syahrin) as if real. Only text/image/document carry lead content — anything else
  // (reaction, sticker, unknown) must never reach the AI extractor.
  if (!['text', 'image', 'document'].includes(info.kind)) {
    log('SKIP — no lead content in kind=' + info.kind + ' (reaction/sticker/etc, already captured above)');
    return;
  }
  let src = 'Text', blocks = [];
  try {
    if (info.kind === 'text') {
      src = 'Text';
      blocks = [{ type: 'text', text: 'Lead message:\n' + info.text }];
    } else if (info.kind === 'image') {
      src = 'Image';
      const buf = await decryptMedia(info.fullMessage);
      info.screenshotUrl = decryptMedia.lastUrl || '';   // forward this screenshot to the salesperson
      const hint = info.caption ? `\nThe sender's caption is "${info.caption}" — this IS a real lead (a chat/DM screenshot). Look CAREFULLY for the customer's phone number (a Malaysian number, often in a small grey chat bubble) and the bike model. Extract them.` : '';
      blocks = [
        { type: 'text', text: 'A motorcycle sales lead is shown in this image (a chat/DM screenshot). Caption: ' + (info.caption || '(none)') + hint },
        // VISION FIX (2026-06-19): feed OpenAI the WaSender public URL (clean image it fetches itself).
        // The local decrypted buffer was occasionally malformed → GPT returned EMPTY on perfectly-readable
        // lead screenshots (e.g. Koj3y_ Lambretta 250). Base64 buffer kept only as a fallback.
        { type: 'image_url', image_url: { url: decryptMedia.lastUrl || `data:${info.mime || 'image/jpeg'};base64,${buf.toString('base64')}`, detail: 'high' } },
      ];
    } else if (info.kind === 'document') {
      const buf = await decryptMedia(info.fullMessage);
      const tag = (info.mime + ' ' + (info.fileName || '')).toLowerCase();
      if (/pdf/.test(tag)) {
        src = 'PDF';
        blocks = [{ type: 'file', file: { filename: info.fileName || 'lead.pdf', file_data: `data:application/pdf;base64,${buf.toString('base64')}` } }];
      } else if (/sheet|excel|xlsx|xls|csv|spreadsheet/.test(tag)) {
        src = 'Excel';
        info.excelChunks = excelToChunks(buf);   // handled specially below — one AI call PER CHUNK, never one giant blob
      } else {
        src = 'Document';
        blocks = [{ type: 'text', text: 'Document caption: ' + (info.caption || '(none)') + '\n(unsupported type ' + info.mime + ')' }];
      }
    }
    if (info.fileName || info.caption) {
      log('document name="' + (info.fileName||'') + '" caption="' + (info.caption||'') + '"');   // debug: confirm name is captured
      // The CAPTION is a deliberate instruction typed by a human at send-time; the FILENAME is
      // often auto-generated (Google Forms exports, camera names) and can contain misleading
      // words by accident — e.g. "ZONTES KTM TEST RIDE 2026 (Responses).xlsx" contains "ktm",
      // which is NOT an instruction. Caption wins when both are present (2026-07-21 fix).
      const hintSrc = info.caption ? `Caption: "${info.caption}"` : `Source file name: "${info.fileName||''}"`;
      blocks.push({ type: 'text', text: `${hintSrc}. If this explicitly names a brand (Lambretta / Honda / Thunder / HQ / Suzuki / KTM / Zontes), use that as the brand for ALL leads. Do not infer a brand from words that just happen to appear in an auto-generated file name.` });
    }
    let leads;
    if (info.excelChunks) {
      // One AI extraction call PER CHUNK (never the whole sheet in one shot) — a single-shot
      // extraction on a big repetitive sheet was proven (2026-07-21, 139-row real event file)
      // to return a clean-looking PARTIAL result (finish_reason=stop, not even a token-limit
      // cutoff — the model just stopped early): 21 of 139 leads, zero error, zero warning.
      leads = [];
      for (let i = 0; i < info.excelChunks.length; i++) {
        const chunkBlocks = [{ type: 'text', text: 'Spreadsheet (CSV export) — ' + info.excelChunks[i] }, ...blocks, { type: 'text', text: EXTRACT_INSTRUCTION }];
        const chunkLeads = parseLeads(await aiExtract(chunkBlocks));
        log(`excel chunk ${i + 1}/${info.excelChunks.length}: ${chunkLeads.length} leads`);
        leads.push(...chunkLeads);
      }
    } else {
      blocks.push({ type: 'text', text: EXTRACT_INSTRUCTION });
      leads = parseLeads(await aiExtract(blocks));
      // Bug-1 fix: an IMAGE with a lead caption (e.g. "tiktok dm lambretta") but no lead found = likely a
      // vision miss (phone in a small bubble). Retry ONCE with an insistent prompt before giving up.
      if (!leads.length && info.kind === 'image' && info.caption) {
        log('image vision miss — retrying with insistent prompt');
        const retry = [...blocks, { type: 'text', text: 'You returned no lead, but a lead IS present (the caption confirms it). Re-examine the image carefully — find the Malaysian phone number (often in a small grey chat bubble) and the bike model. Return the lead JSON now.' }];
        leads = parseLeads(await aiExtract(retry));
      }
    }
    remember({ src, sender: info.sender, leads });
    if (!leads.length) {
      // media drop with no lead → brief note (it was intentional); plain chatter text → STAY SILENT
      if (info.kind !== 'text') {
        await waSend(info.chatId, `🧪 ${src}: read OK but no lead found.`);
        // possible MISSED LEAD → instant alert to the internal work group
        const t = new Date().toLocaleString('en-MY', { timeZone: 'Asia/Kuala_Lumpur', hour12: false });
        await alertReview(`⚠️ *Possible missed lead* — ${src} couldn't auto-read\n👤 From: ${info.sender || '—'}\n🕘 ${t} MYT\n👉 Recheck / resend the image in the Lead Intake group.`);
      }
      return;
    }
    const unavail = await getUnavailable();   // salesmen marked "NO" in the Lark availability sheet → skipped in rotation
    // Caption wins over filename (2026-07-21 fix — see the hintSrc note above): the caption is
    // a deliberate human instruction, the filename is often auto-generated and can accidentally
    // contain a misleading brand/team word (e.g. the Zontes/KTM test-ride Excel's own filename
    // contains "ktm", which silently overrode Harith's actual "shah alam + hq" caption instruction).
    const enriched = assignLeads(leads, fileOverrides(info.caption || info.fileName), unavail);
    // Bulk-queue durability (2026-07-24): leads beyond the first batch are stamped SLA Status =
    // 'Queued' in Lark (instead of Pending) so (a) the boot rehydrator can rebuild the drip-feed
    // queue after a deploy wipes bulk_queue.json, and (b) the timer rehydrate never registers a
    // 60/75-min clock for a lead whose DM hasn't actually been sent. drainBulkQueue flips each
    // lead to Pending + a fresh Assigned At at real DM time (also makes the Lark timestamp
    // rep-fair — it used to say write-time while the rep only got the DM hours later).
    const isBulk = enriched.length > BULK_THRESHOLD;
    if (isBulk) enriched.forEach((l, i) => { if (i >= BULK_BATCH_SIZE) l.queued = true; });
    if (LIVE_LARK) {
      // Lark write happens for EVERY lead immediately, bulk or not — the CRM record is always
      // safe and fully assigned even though the WhatsApp notify below may be staggered.
      for (const l of enriched) { try { l.recordId = await larkWriteLead(l); } catch (e) { l.larkErr = String(e.message || e).slice(0, 60); log('lark write err', l.larkErr); } }
    }
    // GROUP confirmation: in BULK mode this is the bulk message ONLY (below) — the normal
    // renderCard() claims "salesperson notified" + tallies EVERY lead's assignee, which was
    // misleading (2026-07-21 incident: card said "21 leads notified, Nazrin/Aso/Roy 7 each"
    // when only the first 15 had actually been sent to WhatsApp — the other 6 were still
    // queued). One accurate message per event instead of two conflicting ones.
    if (!isBulk) {
      await waSend(info.chatId, renderCard(src, enriched, LIVE_LARK));
      if (enriched.length <= 3) await askMissing(info.chatId, enriched);   // ❓ small drop with blank Brand → ask the group (Option A)
    }
    if (LIVE_LARK) {
      if (isBulk) {
        // BULK MODE: notify + start SLA timers for only the first batch now; queue the rest to
        // trickle out automatically in later batches (drainBulkQueue, business-hours only).
        const batches = chunk(enriched, BULK_BATCH_SIZE);
        await notifyBatch(batches[0], info.screenshotUrl);
        const rest = batches.slice(1);
        const drainsPerDay = Math.max(1, Math.floor(9 / (BULK_DRAIN_MS / 3600000)));   // working day ≈ 9h (9am-6pm)
        const drainHrs = Math.round(BULK_DRAIN_MS / 3600000);
        if (rest.length) {
          bulkQueue.push({ chatId: info.chatId, screenshotUrl: info.screenshotUrl || '', total: enriched.length, sent: batches[0].length, batches: rest });
          bulkPersist();
          const days = Math.ceil(rest.length / drainsPerDay);
          await waSend(info.chatId, `📦 *Bulk batch detected* — ${enriched.length} leads, all saved to Lark now.\nFirst ${batches[0].length} assigned & sales team notified.\nRemaining ${enriched.length - batches[0].length} will go out in batches of ${BULK_BATCH_SIZE} every ~${drainHrs}h during working hours (~${days} working day${days > 1 ? 's' : ''}) — I'll post progress here as each batch goes.`);
        } else {
          await waSend(info.chatId, `📦 *Bulk batch detected* — ${enriched.length} leads, all saved to Lark + assigned & sales team notified now (fit in one batch).`);
        }
      } else {
        await notifyBatch(enriched, info.screenshotUrl);
      }
    }
  } catch (e) {
    const msg = String(e.message || e);
    log('handle error', msg);
    if (msg === 'NO_KEY') await waSend(info.chatId, '🧪 Got your ' + src + ' — but the AI key for this project isn\'t set yet. Ping Benjamin.');
    else await waSend(info.chatId, '⚠️ Test parser couldn\'t read that ' + src + ': ' + msg.slice(0, 180));
  }
}

// Fan-out: forward raw payload + ORIGINAL headers (incl. x-webhook-signature) to the VPS console inbox.
// Must keep original headers or the console rejects with 401 Invalid signature.
function forwardToInbox(rawBody, headers) {
  if (!INBOX_FORWARD_URL) return;
  const fwd = {};
  for (const k in headers) { const lk = k.toLowerCase(); if (lk !== 'host' && lk !== 'content-length') fwd[k] = headers[k]; }
  if (INBOX_FORWARD_SECRET) fwd['x-webhook-signature'] = INBOX_FORWARD_SECRET;  // re-sign for the console channel
  fetch(INBOX_FORWARD_URL, { method: 'POST', headers: fwd, body: rawBody })
    .then(r => log('[inbox-fwd]', r.status, '->', INBOX_FORWARD_URL))
    .catch(e => log('[inbox-fwd] failed:', String(e.message || e)));
}

// Fan-out #2: forward raw payload to the website-upload service (Mudah posts → WooCommerce draft).
function forwardToWoo(rawBody) {
  if (!WOO_FORWARD_URL) return;
  fetch(WOO_FORWARD_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: rawBody })
    .then(r => log('[woo-fwd]', r.status))
    .catch(e => log('[woo-fwd] failed:', String(e.message || e)));
}

// ---- HTTP ----
http.createServer((req, res) => {
  if (req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      forwardToInbox(body, req.headers);   // fan-out to console inbox (fire-and-forget)
      forwardToWoo(body);                  // fan-out #2 to website-upload service (fire-and-forget)
      let p; try { p = JSON.parse(body); } catch { p = { raw: body.slice(0, 1500) }; }
      remember({ event: p.event, summary: JSON.stringify(p).slice(0, 800) });
      log('CAPTURE', p.event || '(no event)');
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}');
      handle(p).catch(e => log('async handle error', String(e.message || e)));
    });
  } else if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok');
  } else if (req.url === '/sla') {
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(sla ? sla.stats() : { off: true }, null, 1));
  } else {
    const items = recent.map(r => `<b>${r.at}</b> <i>${r.src || r.event || ''}</i><pre>${(r.leads ? JSON.stringify(r.leads, null, 1) : r.summary || '').replace(/</g,'&lt;')}</pre>`).join('<hr>');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<h2>TM Motor Lead Intake — parser (TEST MODE)</h2>
<p>Lark write: <b>${LIVE_LARK ? 'LIVE ⚠️' : 'OFF (test)'}</b> · AI key: <b>${OPENAI_KEY ? 'set' : 'NOT set'}</b> · WaSender: <b>${WASENDER_TOKEN ? 'set' : 'NOT set'}</b> · model: ${MODEL}</p>
<p>Reply lock — intake group: <b>${INTAKE_GROUP_JID || 'UNSET (replies to NOBODY — safe)'}</b></p>
<p>Captures: ${recent.length}</p><hr>${items}`);
  }
}).listen(process.env.PORT || 3000, () => log('TM lead-intake parser (test mode) listening'));
