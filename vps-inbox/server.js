// TM Motor Lead Intake — VPS inbox + group-only parser
// - Receives WaSender webhooks (via nginx /tm/ -> :8790), stores EVERY message per chat (persistent).
// - Web inbox UI at /tm/ (list chats) and /tm/?id=<jid> (view a chat) — like KoonKen/FSS.
// - Parses + replies ONLY inside the one designated intake group (INTAKE_GROUP_JID).
//   Personal chats + all other groups = captured read-only, NEVER replied to.
// - Lark write OFF until LIVE_LARK=1.

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
let XLSX = null; try { XLSX = require('xlsx'); } catch {}

const PORT             = process.env.PORT || 8790;
const WASENDER_BASE    = 'https://www.wasenderapi.com/api';
const UA               = 'Mozilla/5.0';
const WASENDER_TOKEN   = process.env.WASENDER_TOKEN || '';
const OPENAI_KEY       = process.env.OPENAI_API_KEY || '';
const MODEL            = process.env.MODEL || 'gpt-4o';
const INTAKE_GROUP_JID = process.env.INTAKE_GROUP_JID || '';
const LIVE_LARK        = process.env.LIVE_LARK === '1';

const DATA = path.join(__dirname, 'data');
fs.mkdirSync(DATA, { recursive: true });
function log(...a){ console.log(new Date().toISOString(), ...a); }

// ---------- group-name cache ----------
let groupNames = {};
async function refreshGroups(){
  try {
    const r = await fetch(WASENDER_BASE + '/groups', { headers: { Authorization: 'Bearer ' + WASENDER_TOKEN, 'User-Agent': UA } });
    const j = await r.json();
    if (j && j.data) { groupNames = {}; j.data.forEach(g => groupNames[g.id] = g.name); log('groups cache', Object.keys(groupNames).length); }
  } catch (e) { log('refreshGroups err', e.message); }
}

// ---------- storage ----------
function safe(id){ return String(id).replace(/[^a-zA-Z0-9@._-]/g, '_'); }
function chatFile(id){ return path.join(DATA, safe(id) + '.jsonl'); }
const index = {};
function rebuildIndex(){
  for (const f of fs.readdirSync(DATA)) {
    if (!f.endsWith('.jsonl')) continue;
    const lines = fs.readFileSync(path.join(DATA, f), 'utf8').trim().split('\n').filter(Boolean);
    if (!lines.length) continue;
    let last; try { last = JSON.parse(lines[lines.length - 1]); } catch { continue; }
    index[last.chatId] = { chatId: last.chatId, isGroup: last.isGroup, name: last.name, count: lines.length, last: last.at, lastText: last.text };
  }
  log('index rebuilt:', Object.keys(index).length, 'chats');
}
function store(rec){
  fs.appendFileSync(chatFile(rec.chatId), JSON.stringify(rec) + '\n');
  const e = index[rec.chatId] || { chatId: rec.chatId, count: 0 };
  e.isGroup = rec.isGroup; e.name = rec.name; e.count++; e.last = rec.at; e.lastText = rec.text;
  index[rec.chatId] = e;
}

// ---------- WaSender ----------
async function waSend(to, text){
  if (!WASENDER_TOKEN) return log('waSend skipped — no token');
  const r = await fetch(WASENDER_BASE + '/send-message', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + WASENDER_TOKEN, 'Content-Type': 'application/json', 'User-Agent': UA },
    body: JSON.stringify({ to, text }),
  });
  if (!r.ok) log('waSend HTTP', r.status, (await r.text()).slice(0, 150));
}
async function decryptMedia(mediaObj){
  const r = await fetch(WASENDER_BASE + '/decrypt-media', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + WASENDER_TOKEN, 'Content-Type': 'application/json', 'User-Agent': UA },
    body: JSON.stringify(mediaObj),
  });
  const txt = await r.text(); let j = {}; try { j = JSON.parse(txt); } catch {}
  const u = j.publicUrl || j.url || (j.data && (j.data.publicUrl || j.data.url)) || '';
  log('decrypt-media', r.status, 'url?', !!u, txt.slice(0, 150));
  if (!u) throw new Error('decrypt-media no url (HTTP ' + r.status + ')');
  const bin = await fetch(u, { headers: { 'User-Agent': UA } });
  if (!bin.ok) throw new Error('media download HTTP ' + bin.status);
  return Buffer.from(await bin.arrayBuffer());
}

// ---------- inbound extraction ----------
function pickMessages(d){ let m = d.messages; if (Array.isArray(m)) m = m[0]; return m || {}; }
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
  if (key.fromMe) return null;
  const chatId = key.remoteJid || '';
  if (!chatId) return null;
  const sender = m.pushName || key.participantPn || key.participant || '';
  const msg = unwrap(m.message || {});
  if (msg.imageMessage) { const im = msg.imageMessage; return { chatId, sender, kind: 'image', mediaObj: im, caption: im.caption || '', mime: (im.mimetype || 'image/jpeg').split(';')[0] }; }
  if (msg.documentMessage) { const dm = msg.documentMessage; return { chatId, sender, kind: 'document', mediaObj: dm, caption: dm.caption || '', mime: dm.mimetype || '', fileName: dm.fileName || '' }; }
  const text = msg.conversation || msg.extendedTextMessage?.text || '';
  if (text) return { chatId, sender, kind: 'text', text };
  return null;
}
function excelToText(buf){
  if (!XLSX) return '[xlsx unavailable]';
  const wb = XLSX.read(buf, { type: 'buffer' });
  return wb.SheetNames.map(n => '# Sheet: ' + n + '\n' + XLSX.utils.sheet_to_csv(wb.Sheets[n])).join('\n\n');
}

// ---------- OpenAI ----------
const EXTRACT_INSTRUCTION =
`From the content above, extract ALL motorcycle sales leads.
Return ONLY a JSON object (no prose):
{"leads":[{"name":"","phone":"+60...","interest":"","brand":"","origin":""}]}
Rules:
- phone: Malaysian +60 format, digits only after +60, no spaces. If none, "".
- interest: bike model or enquiry topic, short lowercase (e.g. "cbr250"). If none -> "No question".
- brand: exactly one of HQ, Honda, Lambretta, Thunder, Suzuki, KTM. Unclear -> "".
- origin: best guess FB Ads / Tiktok Get Leads / Tiktok DM / Mudah / FB/IG comments / Whatsapp. Default "Whatsapp".
- name: customer name if present, else "".
Return JSON only.`;
async function aiExtract(blocks){
  if (!OPENAI_KEY) throw new Error('NO_KEY');
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + OPENAI_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: 1500, response_format: { type: 'json_object' }, messages: [{ role: 'user', content: blocks }] }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error('OpenAI HTTP ' + r.status + ' ' + JSON.stringify(j.error || j).slice(0, 160));
  return j.choices?.[0]?.message?.content || '';
}
function parseLeads(raw){
  let s = (raw || '').trim().replace(/^```(json)?/i, '').replace(/```$/, '').trim();
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  const o = JSON.parse(s);
  return Array.isArray(o) ? o : (o.leads || [o]);
}
const POOLS = { KS:['Nabil','Jebat','Allysa','Azwin','Amirul','Nazrin'], HQ:['Adib','Syahrin','Fitri','Fazwan','Azrul','Amir'], Honda:['Bella','Syaza','Anis','Syafa'], ShahAlam:['Amirul','Nazrin','Aso'] };
function poolForBrand(brand){ const b=(brand||'').toLowerCase();
  if(b==='honda')return['Honda',POOLS.Honda]; if(b==='hq'||b==='suzuki')return['HQ',POOLS.HQ];
  if(b==='lambretta'||b==='thunder')return['Klang/Shah Alam',POOLS.KS]; if(b==='ktm'||b==='zontes')return['Shah Alam',POOLS.ShahAlam];
  return [null,[]]; }
function card(src, l){
  const [team,pool]=poolForBrand(l.brand);
  const assign = pool.length ? `${pool[0]} (${team} — rotation preview)` : '— (brand unknown, staff to pick)';
  return [`🧪 LEAD PARSED — test only (not saved to Lark)`,`Source: ${src}`,``,
    `👤 Name: ${l.name||'—'}   (display only)`,`📱 Phone: ${l.phone||'—  ⚠️ no phone found'}`,
    `🏍️ Want: ${l.interest||'No question'}`,`🏷️ Brand: ${l.brand||'—'}`,`📍 Origin: ${l.origin||'Whatsapp'}`,
    `➡️ Would assign: ${assign}`,`Stage: Pending customer reply`].join('\n');
}

// ---------- handle one inbound ----------
async function handle(payload){
  const info = extract(payload);
  if (!info) return;
  const isGroup = info.chatId.endsWith('@g.us');
  const name = isGroup ? (groupNames[info.chatId] || info.chatId) : (info.sender || info.chatId);
  let text = info.kind === 'text' ? info.text : `[${info.kind}${info.fileName ? ' ' + info.fileName : ''}${info.caption ? ' — ' + info.caption : ''}]`;
  const rec = { at: new Date().toISOString(), chatId: info.chatId, isGroup, name, sender: info.sender, kind: info.kind, text, bot: '' };

  const isIntake = INTAKE_GROUP_JID && info.chatId === INTAKE_GROUP_JID;
  if (INTAKE_GROUP_JID) {
    // CONFIGURED: ONLY the intake group. Every other group + all personal chats are ignored entirely.
    if (!isIntake) { log('ignored (not intake group):', isGroup ? 'GROUP' : 'personal', info.chatId); return; }
  } else {
    // BOOTSTRAP (no intake JID yet): capture GROUP messages only so we can identify YOUR group.
    // Personal chats are ignored. Once INTAKE_GROUP_JID is set, only that group is ever touched.
    if (!isGroup) { log('ignored personal (bootstrap)'); return; }
    rec.bot = 'captured (bootstrap — drop a msg in YOUR group so I can lock to it)';
    store(rec);
    log('bootstrap capture GROUP', info.chatId, '-', name);
    return;
  }
  // ---- INTAKE GROUP: parse + reply here ----
  let src = 'Text', blocks = [];
  try {
    if (info.kind === 'text') { src = 'Text'; blocks = [{ type:'text', text:'Lead message:\n' + info.text }]; }
    else if (info.kind === 'image') {
      src = 'Image'; const buf = await decryptMedia(info.mediaObj);
      blocks = [{ type:'text', text:'Lead shown in this image. Caption: ' + (info.caption||'(none)') },
                { type:'image_url', image_url:{ url:`data:${info.mime||'image/jpeg'};base64,${buf.toString('base64')}` } }];
    } else if (info.kind === 'document') {
      const buf = await decryptMedia(info.mediaObj); const tag = (info.mime + ' ' + (info.fileName||'')).toLowerCase();
      if (/pdf/.test(tag)) { src='PDF'; blocks=[{ type:'file', file:{ filename:info.fileName||'lead.pdf', file_data:`data:application/pdf;base64,${buf.toString('base64')}` } }]; }
      else if (/sheet|excel|xlsx|xls|csv|spreadsheet/.test(tag)) { src='Excel'; blocks=[{ type:'text', text:'Spreadsheet (CSV export):\n' + excelToText(buf).slice(0,24000) }]; }
      else { src='Document'; blocks=[{ type:'text', text:'Document caption: ' + (info.caption||'(none)') + ' (type ' + info.mime + ')' }]; }
    }
    blocks.push({ type:'text', text: EXTRACT_INSTRUCTION });
    const leads = parseLeads(await aiExtract(blocks));
    rec.src = src; rec.parsed = leads;
    if (!leads.length) { await waSend(info.chatId, `🧪 ${src}: read OK but found no lead in it.`); rec.bot = `${src}: no lead`; }
    else if (leads.length === 1) { await waSend(info.chatId, card(src, leads[0])); rec.bot = `${src}: 1 lead parsed`; }
    else {
      const head = `🧪 ${leads.length} LEADS PARSED from ${src} — test only (not saved)\n`;
      await waSend(info.chatId, head + leads.map((l,i)=>`${i+1}. ${l.phone||'—'} | ${l.interest||'No question'} | ${l.brand||'—'} | ${l.origin||'Whatsapp'}`).join('\n'));
      rec.bot = `${src}: ${leads.length} leads parsed`;
    }
  } catch (e) {
    const m = String(e.message || e); rec.bot = 'parse error: ' + m;
    if (m === 'NO_KEY') await waSend(info.chatId, '🧪 Got your ' + src + ' — AI key not set yet.');
    else await waSend(info.chatId, '⚠️ Couldn\'t read that ' + src + ': ' + m.slice(0, 160));
  }
  store(rec);
}

// ---------- UI ----------
const esc = s => String(s == null ? '' : s).replace(/[<>&]/g, c => ({ '<':'&lt;','>':'&gt;','&':'&amp;' }[c]));
function pageList(){
  const chats = Object.values(index).sort((a,b)=> (b.last||'').localeCompare(a.last||''));
  const rows = chats.map(c => `<tr>
    <td>${c.isGroup ? '👥' : '👤'}</td>
    <td><a href="?id=${encodeURIComponent(c.chatId)}">${esc(c.name||c.chatId)}</a>${c.chatId===INTAKE_GROUP_JID?' <span class=tag>INTAKE</span>':''}</td>
    <td>${c.count}</td><td>${esc((c.last||'').replace('T',' ').slice(0,19))}</td>
    <td class=snip>${esc((c.lastText||'').slice(0,60))}</td></tr>`).join('');
  return wrap(`<h2>TM Motor Inbox</h2>${statusBar()}
   <table><tr><th></th><th>Chat</th><th>#</th><th>Last</th><th>Latest message</th></tr>${rows||'<tr><td colspan=5>No messages captured yet.</td></tr>'}</table>`);
}
function pageChat(id){
  let lines = [];
  try { lines = fs.readFileSync(chatFile(id),'utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l)); } catch {}
  const meta = index[id] || {};
  const body = lines.map(r => `<div class="msg ${r.isGroup?'g':'p'}">
     <div class=meta>${esc((r.at||'').replace('T',' ').slice(0,19))} · ${esc(r.sender||'')} · ${esc(r.kind)}</div>
     <div class=txt>${esc(r.text)}</div>
     ${r.bot?`<div class=bot>🤖 ${esc(r.bot)}</div>`:''}
     ${r.parsed?`<pre class=parsed>${esc(JSON.stringify(r.parsed,null,1))}</pre>`:''}</div>`).join('');
  return wrap(`<a href="?">&larr; all chats</a><h2>${esc(meta.name||id)} ${meta.isGroup?'👥':'👤'}</h2>
    <div class=cid>${esc(id)}${id===INTAKE_GROUP_JID?' — INTAKE GROUP (parsing ON)':''}</div>${body||'<p>empty</p>'}`);
}
function statusBar(){
  return `<div class=status>Lark: <b>${LIVE_LARK?'LIVE ⚠️':'OFF'}</b> · AI: <b>${OPENAI_KEY?'set':'NOT set'}</b> · WaSender: <b>${WASENDER_TOKEN?'set':'NOT set'}</b>
   · Intake group: <b>${INTAKE_GROUP_JID?esc(groupNames[INTAKE_GROUP_JID]||INTAKE_GROUP_JID):'UNSET — replies to nobody (safe)'}</b></div>`;
}
function wrap(inner){ return `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<style>body{font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;margin:0;background:#f4f5f7;color:#222}
h2{margin:12px}a{color:#1769ff;text-decoration:none}table{width:100%;border-collapse:collapse;background:#fff}
th,td{padding:8px 10px;border-bottom:1px solid #eee;text-align:left;font-size:13px}.snip{color:#888}
.tag{background:#1769ff;color:#fff;font-size:10px;padding:1px 5px;border-radius:3px}
.status{margin:12px;padding:8px 10px;background:#fff;border-radius:6px;font-size:12px;color:#555}
.cid{margin:0 12px 10px;color:#888;font-size:12px}
.msg{margin:8px 12px;padding:8px 10px;background:#fff;border-radius:8px;border-left:3px solid #ccc}
.msg.g{border-left-color:#34b7f1}.msg.p{border-left-color:#9b9b9b}
.meta{color:#999;font-size:11px}.txt{margin:3px 0;white-space:pre-wrap}
.bot{color:#0a8a3a;font-size:12px;margin-top:3px}.parsed{background:#f0f7ff;padding:6px;border-radius:5px;font-size:11px;overflow:auto}
</style>${inner}`; }

// ---------- HTTP ----------
http.createServer((req, res) => {
  if (req.method === 'POST') {
    let body = ''; req.on('data', c => body += c);
    req.on('end', () => {
      let p; try { p = JSON.parse(body); } catch { p = {}; }
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}');
      handle(p).catch(e => log('handle err', String(e.message || e)));
    });
    return;
  }
  const q = url.parse(req.url, true);
  if (q.pathname.endsWith('/health')) { res.writeHead(200); res.end('ok'); return; }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(q.query.id ? pageChat(q.query.id) : pageList());
}).listen(PORT, () => log('tm-inbox listening on', PORT));

rebuildIndex(); refreshGroups(); setInterval(refreshGroups, 30 * 60 * 1000);
