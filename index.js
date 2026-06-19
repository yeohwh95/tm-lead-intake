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

const recent = [];                 // in-memory debug log (wiped on restart)
const SEEN = new Set();             // processed message ids (webhook-retry dedup)
function log(...a){ console.log(new Date().toISOString(), ...a); }
function remember(o){ recent.unshift({ at: new Date().toISOString(), ...o }); if (recent.length > 50) recent.pop(); }

// ---- Rotation pools (updated roster 2026-06-17) ----
const POOLS = {
  KS:       ['Jebat','Nabil','Allysa','Azwin','Jue','Amirul','Nazrin','Aso','Roy'],  // Lambretta/Thunder (Klang + Shah Alam)
  HQ:       ['Adib','Syahrin','Fazwan','Azrul','Amir'],            // HQ / Suzuki
  Honda:    ['Bella','Syaza','Anis','Syafa','Zeera'],              // Honda Kapar
  ShahAlam: ['Amirul','Nazrin','Aso','Roy'],                      // KTM / Zontes
};
function poolForBrand(brand){
  const b = (brand || '').toLowerCase();
  if (b === 'honda') return ['Honda', POOLS.Honda];
  if (b === 'hq' || b === 'suzuki') return ['HQ', POOLS.HQ];
  if (b === 'lambretta' || b === 'thunder') return ['Klang/Shah Alam', POOLS.KS];
  if (b === 'ktm' || b === 'zontes') return ['Shah Alam', POOLS.ShahAlam];
  return [null, []];
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
      if (!r.ok) log('waSend HTTP', r.status, (await r.text()).slice(0, 150));
      return;
    }
    log('waSend gave up after 3 attempts to', to);
  }).catch(e => log('send chain err', String(e.message || e)));
  return _sendChain;
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
  return null;
}

function excelToText(buf){
  if (!XLSX) return '[xlsx parser unavailable]';
  const wb = XLSX.read(buf, { type: 'buffer' });
  return wb.SheetNames.map(n => '# Sheet: ' + n + '\n' + XLSX.utils.sheet_to_csv(wb.Sheets[n])).join('\n\n');
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
- brand: exactly one of HQ, Honda, Lambretta, Thunder, Suzuki, KTM, Zontes. **HQ is a real brand (TM's house brand) — if the tag/data says HQ, use "HQ", NEVER substitute "Suzuki".** If unclear -> "".
- origin: identify the lead's SOURCE. MUST be EXACTLY one of: "Tiktok DM", "Tiktok Get Leads", "TIKTOK LIVE (Get leads)", "Ads Tiktok", "Whatsapp", "FB Ads", "FB/IG comments", "Mudah", "On Site Event", "Bike Continent META". Map: a tag starting "TIKTOK DM" OR a TikTok DM/chat-conversation screenshot (@handle, "Message request accepted") -> "Tiktok DM"; the word "Organic" in the data -> "Tiktok Get Leads"; paid TikTok ad OR TikTok lead-form export -> "Ads Tiktok"; WhatsApp chat screenshot -> "Whatsapp"; Facebook lead ad -> "FB Ads"; FB/IG comment -> "FB/IG comments"; Mudah -> "Mudah"; walk-in / showroom / roadshow / event -> "On Site Event".
- name: the customer's name. For a chat/DM screenshot, use the contact's display name or @handle shown at the top (e.g. "mas.saifuddin"). Else "".
Return JSON only.`;

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
function fileOverrides(name){
  const f = (name || '');
  const am = f.match(/\(([^)]+)\)/);
  const m = am ? matchStaff(am[1]) : { name: '', requested: '' };
  const assignee = m.name;
  const requestedName = m.requested && !m.name ? m.requested : '';   // named someone we couldn't match → flag it
  const origin = /(^|\+|\s)live\b/i.test(f) ? 'TIKTOK LIVE (Get leads)' : '';
  return { assignee, origin, requestedName };
}

// ---- Assignment (persistent take-turns across drops; resets only on deploy) ----
const ROT = {};
function assignLeads(leads, ov){
  ov = ov || {};
  return leads.map(l => {
    let assignee = ov.assignee || '';
    if (!assignee) { const [team, pool] = poolForBrand(l.brand); if (pool.length) { const idx = ROT[team] || 0; assignee = pool[idx % pool.length]; ROT[team] = idx + 1; } }
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
async function larkWriteLead(l){
  const tok = await larkToken();
  const fields = { 'Phone number': l.phone || '', 'Customer want': l.want || 'No question', 'Stage': 'Passed lead' };
  if (l.brand) fields['Brand'] = l.brand;
  if (l.origin) fields['Origin'] = l.origin;
  if (l.staff?.openId) fields['Salesman'] = [{ id: l.staff.openId }];
  const r = await fetch(`${LARK_BASE}/bitable/v1/apps/${LARK_APP_TOKEN}/tables/${LARK_TABLE_ID}/records`, { method: 'POST', headers: { 'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: JSON.stringify({ fields }) });
  const j = await r.json();
  if (j.code !== 0) throw new Error('lark code ' + j.code + ' ' + (j.msg || ''));
  return j.data?.record?.record_id;
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
  if (!phone) return false;
  // For a single image lead, send the actual screenshot + details so the salesperson sees the full convo.
  if (screenshotUrl && leads.length === 1) await waSend(phone, notifyText(leads), screenshotUrl);
  else await waSend(phone, notifyText(leads));
  return true;
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
  return head + '\n\n' + blocks.join('\n\n');
}

async function handle(payload){
  // messages.upsert is for INBOX CAPTURE ONLY (manual hand-typed replies → already forwarded to
  // the console). NEVER process it here: it REPLAYS on session reconnect → duplicate Lark writes +
  // repeat salesperson notifies (the cbr-600 spam, 2026-06-17). Lead processing happens ONLY on the
  // original messages-group.received / messages-personal.received delivery.
  if (payload.event === 'messages.upsert') return;
  const info = extract(payload);
  if (!info) {
    try { const mm = pickMessages(payload.data || {}); log('NO-EXTRACT event=' + payload.event + ' fromMe=' + (mm.key && mm.key.fromMe) + ' jid=' + (mm.key && mm.key.remoteJid) + ' msgKeys=' + JSON.stringify(Object.keys(unwrap(mm.message || {})))); } catch (e) {}
    return;
  }
  const isGroup = info.chatId.endsWith('@g.us');
  log('inbound', info.kind, 'from', info.sender, 'chat', info.chatId, isGroup ? '(group)' : '(personal)');
  remember({ event: 'inbound', src: info.kind, summary: `chat=${info.chatId} ${isGroup ? 'GROUP' : 'personal'} from=${info.sender}` });
  // SAFETY GATE: only ever act/reply inside the designated intake group.
  if (!INTAKE_GROUP_JID || info.chatId !== INTAKE_GROUP_JID) {
    log('SKIP — not intake group (chat=' + info.chatId + ', intake=' + (INTAKE_GROUP_JID || 'UNSET') + ') — captured only, no reply');
    return;
  }
  // DEDUP: a retried webhook must not double-parse / double-write to Lark.
  const mid = (pickMessages(payload.data || {}).key || {}).id || '';
  if (mid) { if (SEEN.has(mid)) { log('dup skip', mid); return; } SEEN.add(mid); if (SEEN.size > 3000) SEEN.clear(); }
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
        { type: 'image_url', image_url: { url: `data:${info.mime || 'image/jpeg'};base64,${buf.toString('base64')}`, detail: 'high' } },
      ];
    } else if (info.kind === 'document') {
      const buf = await decryptMedia(info.fullMessage);
      const tag = (info.mime + ' ' + (info.fileName || '')).toLowerCase();
      if (/pdf/.test(tag)) {
        src = 'PDF';
        blocks = [{ type: 'file', file: { filename: info.fileName || 'lead.pdf', file_data: `data:application/pdf;base64,${buf.toString('base64')}` } }];
      } else if (/sheet|excel|xlsx|xls|csv|spreadsheet/.test(tag)) {
        src = 'Excel';
        blocks = [{ type: 'text', text: 'Spreadsheet (CSV export):\n' + excelToText(buf).slice(0, 24000) }];
      } else {
        src = 'Document';
        blocks = [{ type: 'text', text: 'Document caption: ' + (info.caption || '(none)') + '\n(unsupported type ' + info.mime + ')' }];
      }
    }
    if (info.fileName || info.caption) {
      log('document name="' + (info.fileName||'') + '" caption="' + (info.caption||'') + '"');   // debug: confirm name is captured
      blocks.push({ type: 'text', text: `Source file name: "${info.fileName||''}". Caption: "${info.caption||''}". If EITHER names a brand (Lambretta / Honda / Thunder / HQ / Suzuki / KTM / Zontes), use that as the brand for ALL leads.` });
    }
    blocks.push({ type: 'text', text: EXTRACT_INSTRUCTION });
    let leads = parseLeads(await aiExtract(blocks));
    // Bug-1 fix: an IMAGE with a lead caption (e.g. "tiktok dm lambretta") but no lead found = likely a
    // vision miss (phone in a small bubble). Retry ONCE with an insistent prompt before giving up.
    if (!leads.length && info.kind === 'image' && info.caption) {
      log('image vision miss — retrying with insistent prompt');
      const retry = [...blocks, { type: 'text', text: 'You returned no lead, but a lead IS present (the caption confirms it). Re-examine the image carefully — find the Malaysian phone number (often in a small grey chat bubble) and the bike model. Return the lead JSON now.' }];
      leads = parseLeads(await aiExtract(retry));
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
    const enriched = assignLeads(leads, fileOverrides(info.fileName || info.caption));
    if (LIVE_LARK) {
      for (const l of enriched) { try { await larkWriteLead(l); } catch (e) { l.larkErr = String(e.message || e).slice(0, 60); log('lark write err', l.larkErr); } }
      // one consolidated notify per salesperson (the send queue handles 5s spacing + 429 retry)
      const byStaff = {};
      for (const l of enriched) { const ph = l.staff?.phone; if (ph) (byStaff[ph] = byStaff[ph] || []).push(l); }
      for (const ph in byStaff) { try { await notifyStaff(byStaff[ph], info.screenshotUrl); } catch (e) { log('notify err', String(e.message || e).slice(0, 60)); } }
    }
    await waSend(info.chatId, renderCard(src, enriched, LIVE_LARK));
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

// ---- HTTP ----
http.createServer((req, res) => {
  if (req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      forwardToInbox(body, req.headers);   // fan-out to console inbox (fire-and-forget)
      let p; try { p = JSON.parse(body); } catch { p = { raw: body.slice(0, 1500) }; }
      remember({ event: p.event, summary: JSON.stringify(p).slice(0, 800) });
      log('CAPTURE', p.event || '(no event)');
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}');
      handle(p).catch(e => log('async handle error', String(e.message || e)));
    });
  } else if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok');
  } else {
    const items = recent.map(r => `<b>${r.at}</b> <i>${r.src || r.event || ''}</i><pre>${(r.leads ? JSON.stringify(r.leads, null, 1) : r.summary || '').replace(/</g,'&lt;')}</pre>`).join('<hr>');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<h2>TM Motor Lead Intake — parser (TEST MODE)</h2>
<p>Lark write: <b>${LIVE_LARK ? 'LIVE ⚠️' : 'OFF (test)'}</b> · AI key: <b>${OPENAI_KEY ? 'set' : 'NOT set'}</b> · WaSender: <b>${WASENDER_TOKEN ? 'set' : 'NOT set'}</b> · model: ${MODEL}</p>
<p>Reply lock — intake group: <b>${INTAKE_GROUP_JID || 'UNSET (replies to NOBODY — safe)'}</b></p>
<p>Captures: ${recent.length}</p><hr>${items}`);
  }
}).listen(process.env.PORT || 3000, () => log('TM lead-intake parser (test mode) listening'));
