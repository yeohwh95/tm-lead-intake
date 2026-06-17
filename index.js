// TM Motor Lead Intake — receiver + AI parser (TEST MODE)
// Reads text / PDF / Excel / image dropped in the WA group, asks GPT-4o to
// extract lead fields, and replies a parse-card BACK INTO THE SAME CHAT.
// Lark write is OFF until LIVE_LARK=1. Nothing is written to Lark in test mode.

const http = require('http');
let XLSX = null; try { XLSX = require('xlsx'); } catch { /* excel disabled if dep missing */ }

const WASENDER_BASE  = 'https://www.wasenderapi.com/api';
const UA             = 'Mozilla/5.0';
const WASENDER_TOKEN = process.env.WASENDER_TOKEN || '';
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
function log(...a){ console.log(new Date().toISOString(), ...a); }
function remember(o){ recent.unshift({ at: new Date().toISOString(), ...o }); if (recent.length > 50) recent.pop(); }

// ---- rotation preview (NON-persisting in test mode; just shows who'd be next) ----
const POOLS = {
  KS:       ['Nabil','Jebat','Allysa','Azwin','Amirul','Nazrin'],   // Lambretta/Thunder (Klang+Shah Alam)
  HQ:       ['Adib','Syahrin','Fitri','Fazwan','Azrul','Amir'],     // HQ / Suzuki
  Honda:    ['Bella','Syaza','Anis','Syafa'],                       // Honda Kapar
  ShahAlam: ['Amirul','Nazrin','Aso'],                             // KTM / Zontes
};
function poolForBrand(brand){
  const b = (brand || '').toLowerCase();
  if (b === 'honda') return ['Honda', POOLS.Honda];
  if (b === 'hq' || b === 'suzuki') return ['HQ', POOLS.HQ];
  if (b === 'lambretta' || b === 'thunder') return ['Klang/Shah Alam', POOLS.KS];
  if (b === 'ktm' || b === 'zontes') return ['Shah Alam', POOLS.ShahAlam];
  return [null, []];
}

// ---- WaSender helpers ----
async function waSend(to, text){
  if (!WASENDER_TOKEN) { log('waSend skipped — no WASENDER_TOKEN'); return; }
  const r = await fetch(WASENDER_BASE + '/send-message', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + WASENDER_TOKEN, 'Content-Type': 'application/json', 'User-Agent': UA },
    body: JSON.stringify({ to, text }),
  });
  if (!r.ok) log('waSend HTTP', r.status, (await r.text()).slice(0, 200));
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
  if (msg.ephemeralMessage?.message) return msg.ephemeralMessage.message;
  return msg;
}
function extract(payload){
  const data = payload.data || {};
  const m = pickMessages(data);
  const key = m.key || {};
  const chatId = key.remoteJid || '';
  if (!chatId) return null;
  const sender = m.pushName || key.participantPn || key.participant || '';
  const msg = unwrap(m.message || {});
  const text0 = msg.conversation || msg.extendedTextMessage?.text || '';
  // Staff also send leads FROM the Tmm Marketing number itself → process those too.
  // But NEVER react to our own bot cards/errors (they start with 🧪 / ⚠️) — prevents a loop.
  if (key.fromMe && /^\s*(🧪|⚠️)/.test(text0)) return null;
  if (msg.imageMessage) {
    const im = msg.imageMessage;
    return { chatId, sender, kind: 'image', mediaObj: im, fullMessage: m, caption: im.caption || '', mime: (im.mimetype || 'image/jpeg').split(';')[0] };
  }
  if (msg.documentMessage) {
    const dm = msg.documentMessage;
    return { chatId, sender, kind: 'document', mediaObj: dm, fullMessage: m, caption: dm.caption || '', mime: dm.mimetype || '', fileName: dm.fileName || '' };
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
- phone: normalize to Malaysian +60 format, digits only after +60, no spaces. If no phone, use "".
- interest: bike model or enquiry topic, short lowercase (e.g. "cbr250","africa twin","pricing"). If none -> "No question".
- brand: exactly one of HQ, Honda, Lambretta, Thunder, Suzuki, KTM. If unclear -> "".
- origin: identify the lead's SOURCE. MUST be EXACTLY one of: "Tiktok DM", "Tiktok Get Leads", "TIKTOK LIVE (Get leads)", "Ads Tiktok", "Whatsapp", "FB Ads", "FB/IG comments", "Mudah", "On Site Event", "Bike Continent META". Map: TikTok DM/chat-conversation screenshot (@handle, "Message request accepted") -> "Tiktok DM"; the word "Organic" in the data -> "Tiktok Get Leads"; paid TikTok ad OR TikTok lead-form export -> "Ads Tiktok"; WhatsApp chat screenshot -> "Whatsapp"; Facebook lead ad -> "FB Ads"; FB/IG comment -> "FB/IG comments"; Mudah -> "Mudah"; walk-in / showroom / roadshow / event -> "On Site Event".
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

function leadBlock(lead, num, assign){
  const digits = (lead.phone || '').replace(/\D/g, '');
  return [
    `${num ? '*' + num + '.* ' : ''}👤 ${lead.name || '—'}`,
    `📱 ${lead.phone || '— ⚠️ no phone found'}`,
    `🏍️ Wants: ${(lead.interest && !/^\s*no question\s*$/i.test(lead.interest)) ? lead.interest : (lead.name || 'No question')}`,
    `🏷️ Brand: ${lead.brand || '—'}`,
    `📍 From: ${lead.origin || 'Whatsapp'}`,
    `➡️ Assign: ${assign}`,
    digits ? `👉 https://wa.me/${digits}` : '',
  ].filter(Boolean).join('\n');
}
// Deterministic filename flags: `get lead honda +LIVE (BELLA).csv`
//   `(Name)`        → force-assign ALL leads to that salesperson
//   `LIVE`/`+LIVE`  → Origin = "TIKTOK LIVE (Get leads)" for ALL leads
const ALL_NAMES = [...new Set(Object.values(POOLS).flat())];
function fileOverrides(fileName){
  const f = (fileName || '');
  const am = f.match(/\(([^)]+)\)/);
  const assignee = am ? (ALL_NAMES.find(n => n.toLowerCase() === am[1].trim().toLowerCase()) || '') : '';
  const origin = /(^|\+|\s)live\b/i.test(f) ? 'TIKTOK LIVE (Get leads)' : '';
  return { assignee, origin };
}
function cardsMessage(src, leads, ov){
  ov = ov || {};
  const head = `🧪 ${leads.length} LEAD${leads.length > 1 ? 'S' : ''} PARSED — ${src} (test only, not saved to Lark)`;
  const turn = {};   // take-turns rotation WITHIN this batch (per team pool)
  const blocks = leads.map((l, i) => {
    let assign;
    if (ov.assignee) { assign = `${ov.assignee} (file override)`; }
    else {
      const [team, pool] = poolForBrand(l.brand);
      if (pool.length) { const idx = turn[team] || 0; assign = `${pool[idx % pool.length]} (${team})`; turn[team] = idx + 1; }
      else assign = '— (staff to pick)';
    }
    const lead = ov.origin ? { ...l, origin: ov.origin } : l;
    return leadBlock(lead, leads.length > 1 ? i + 1 : null, assign);
  });
  return head + '\n\n' + blocks.join('\n\n');
}

async function handle(payload){
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
  let src = 'Text', blocks = [];
  try {
    if (info.kind === 'text') {
      src = 'Text';
      blocks = [{ type: 'text', text: 'Lead message:\n' + info.text }];
    } else if (info.kind === 'image') {
      src = 'Image';
      const buf = await decryptMedia(info.fullMessage);
      blocks = [
        { type: 'text', text: 'Lead shown in this image. Caption: ' + (info.caption || '(none)') },
        { type: 'image_url', image_url: { url: `data:${info.mime || 'image/jpeg'};base64,${buf.toString('base64')}` } },
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
    if (info.fileName) blocks.push({ type: 'text', text: `Source file name: "${info.fileName}". If it names a brand (Lambretta / Honda / Thunder / HQ / Suzuki / KTM), use that as the brand for ALL leads.` });
    blocks.push({ type: 'text', text: EXTRACT_INSTRUCTION });
    const raw = await aiExtract(blocks);
    const leads = parseLeads(raw);
    remember({ src, sender: info.sender, leads });
    if (!leads.length) {
      // media drop with no lead → brief note (it was intentional); plain chatter text → STAY SILENT
      if (info.kind !== 'text') await waSend(info.chatId, `🧪 ${src}: read OK but no lead found.`);
      return;
    }
    await waSend(info.chatId, cardsMessage(src, leads, fileOverrides(info.fileName)));
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
