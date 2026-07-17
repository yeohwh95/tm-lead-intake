// First-response bot for the TM Marketing number (93210) — Benjamin approved 2026-07-17.
// Instant first touch on Product / Loan / Trade-in DMs, then silent — humans own the conversation.
// PRIME DIRECTIVE (Benjamin): the moment a category is confirmed, the lead IS ASSIGNED —
// no sales opportunity is ever left sitting. Spec: FIRSTRESPONSE-SPEC.md.
const fs = require('fs');
const path = require('path');

const ON = () => process.env.FIRSTRESPONSE_ON === '1';
const DEBOUNCE_MS = Number(process.env.FR_DEBOUNCE_MS || 10 * 1000);
const REGREET_MS = 7 * 24 * 3600 * 1000;         // one bot greeting per chat per 7 days
const PENDING_MODEL_MS = 48 * 3600 * 1000;       // greeting flow: wait up to 48h for the model answer
const STATE_FILE = path.join(__dirname, 'fr_state.json');

let D = {};                                       // injected deps from index.js
let state = { greeted: {}, pending: {} };         // jid -> ts ; jid -> {ts}
try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch {}
const persist = () => { try { fs.writeFileSync(STATE_FILE, JSON.stringify(state)); } catch {} };

const humanTouched = new Set();                   // jids where a HUMAN (fromMe) has spoken since boot
const buffers = {};                               // jid -> { texts:[], hasImage, phone, timer }

// Fitri = TM purchaser (trade-ins go to her — confirmed from staff behavior 2026-07-17)
const FITRI = { name: 'Fitri', phone: '+60108093259' };

// ---------- classification ----------
const RE_SELL = /jual\s+motor|nak\s+jual|mahu\s+jual|trade\s?-?in|tukar\s+motor/i;
const RE_LOAN = /\bloan\b|ansuran|\bepp\b|kad\s+kredit|credit\s+card|pinjaman|bulanan\s+(berapa|brp)|0\s?depo|blacklist|ctos|ccris/i;
const RE_BIKE = /vstrom|v-?strom|tracer|\bz\s?\d{3}|\bmt-?\s?\d{2}\b|cbr|ninja|\bzx\s?\d|gsx|t-?max|x-?max|n-?max|forza|vulcan|er-?6|rsv4|\btrk\b|tiger|duke|\br\s?2[35]\b|\br15\b|y1[56]|sv\s?650|nk\s?\d|450mt|368g|hunter|dominar|lambretta|vespa|zontes|\bnova\b|aveta|avantiz|\bego\b|lc\s?135|enduro|\bsym\b|versys|brutale|xj6|scrambler|monster|\bcb\s?\d{3}|crf|klx|pcx|vario|\bbeat\b|y15zr|8tt|thunder|moda\b|wmoto|gpx|keeway|scooter|superbike|motor\s+(second|2nd|baru|used)/i;
const RE_VENDOR_AUTO = /thank you for contacting|welcome to .* (service|customer)|terima kasih kerana menghubungi|saya akan reply|confirmation code|verification code/i;
const RE_MALAY = /\b(nak|boleh|ada|berapa|brp|tuan|bang|bos|ke|tak|x\s?mau|macam|mcm|saya|kami|harga|jual|beli|lagi|stok|pagi|petang|malam|salam)\b/i;

function classify(text, hasImage){
  const t = String(text || '').trim();
  if (RE_VENDOR_AUTO.test(t)) return { cat: 'skip' };
  if (RE_SELL.test(t)) return { cat: 'sell' };
  if (RE_LOAN.test(t)) return { cat: 'loan' };
  if (RE_BIKE.test(t)) return { cat: 'product' };
  if (/^hello!?\s*can i get more info/i.test(t)) return { cat: 'greeting' };   // Mudah's ad-click prefill
  if (hasImage) return { cat: 'product', imageOnly: !t };          // ad screenshot / bike photo = product intent
  if (t && t.length <= 30) return { cat: 'greeting' };             // "Hi" / "salam" / "pagi" — ad click
  return { cat: 'skip' };                                          // long unrelated text → humans handle
}
// bare "Hi"/"Hello" stays BM (Malaysian default — staff do the same); EN only on a real English sentence
const isEnglish = t => { const s = String(t || '').trim(); return !RE_MALAY.test(s) && s.split(/\s+/).length >= 3 && /\b(hi|hello|can|info|price|available|what|how|is|the|this|more)\b/i.test(s); };

// ---------- reply templates (lifted from the team's own replies; human-feel rules) ----------
function saMYT(){ const h = new Date(Date.now() + 8 * 3600e3).getUTCHours(); return h < 12 ? 'Selamat pagi' : h < 15 ? 'Selamat tengah hari' : h < 19 ? 'Selamat petang' : 'Selamat malam'; }
function tpl(cat, lang, want){
  const g = saMYT();
  if (cat === 'sell') return lang === 'en'
    ? `Hi! Sure, we do buy & trade-in 👍 Which bike (model, year)? Photos help too. Our purchaser will contact you shortly — or WhatsApp directly: FITRI 010-809 3259 / https://wa.me/60108093259`
    : `${g} 😊 Boleh tuan. Nak jual/trade-in motor apa ya? Boleh share model, tahun & gambar motor. Purchaser kami akan contact awak sebentar lagi — atau boleh direct WhatsApp: FITRI 010-809 3259 / https://wa.me/60108093259`;
  if (cat === 'loan') return lang === 'en'
    ? `Hi! Yes — we offer shop loan, Aeon & 0% credit-card EPP (3/5 years) 👍 Which bike are you looking at? Our salesperson will contact you shortly with the loan details.`
    : `${g} 😊 Boleh tuan — kami ada loan kedai, Aeon & EPP kad kredit 0% (3/5 tahun). Motor mana tuan berminat ya? Salesman kami akan contact awak sebentar lagi untuk bantu dengan detail loan.`;
  if (cat === 'greeting') return lang === 'en'
    ? `Hi! 😊 Which bike are you interested in? Feel free to share the model or a screenshot of the ad you saw 👍`
    : `${g} 😊 Ya bos, berminat motor apa ya? Boleh share model atau screenshot iklan yang bos tengok tadi 👍`;
  // product
  const w = want ? ` untuk ${want}` : '';
  return lang === 'en'
    ? `Hi! Yes — our salesperson will contact you shortly with the details 👍`
    : `${g} 😊 Ya tuan, boleh — salesman kami akan contact awak sebentar lagi${want ? ` untuk detail ${want}` : ''} ya 👍`;
}

// ---------- assignment (the point of it all: category confirmed = lead assigned NOW) ----------
async function assign(cat, jid, phone, wantText){
  const want = String(wantText || '').replace(/\s+/g, ' ').trim().slice(0, 60) || 'WhatsApp direct inquiry';
  if (cat === 'sell'){
    // Trade-in → Fitri (purchaser). Lark record + instant DM to Fitri. (No SLA pool — she's not a rep.)
    let recordId = null;
    try { recordId = await D.larkWriteLead({ phone, name: '', want: 'TRADE-IN: ' + want, brand: '', origin: 'WhatsApp Direct', assignee: 'Fitri', staff: null }); }
    catch(e){ D.log('FR lark err (sell):', String(e.message||e).slice(0,60)); }
    try { await D.waSend(FITRI.phone, `🔁 *Trade-in Lead (auto)*\n\n🎯 ${want}\n👉 https://wa.me/${phone.replace(/\D/g,'')}\n\nCustomer dah dapat reply pertama — follow up ya.`); }
    catch(e){ D.log('FR fitri DM err:', String(e.message||e).slice(0,60)); }
    D.log(`FR ✅ SELL lead assigned → Fitri (${phone}) "${want}"`);
    return;
  }
  // product / loan → the normal machine: round-robin pool → Lark → salesperson DM → SLA timers
  const unavail = await D.getUnavailable();
  const enriched = D.assignLeads([{ phone, name: '', interest: (cat === 'loan' ? 'LOAN: ' : '') + want, brand: '' }], { origin: 'WhatsApp Direct' }, unavail);
  const l = enriched[0];
  try { l.recordId = await D.larkWriteLead(l); } catch(e){ D.log('FR lark err:', String(e.message||e).slice(0,60)); }
  try {
    const dmMsgId = await D.notifyStaff([l]);
    if (D.sla && l.staff?.phone) D.sla.register(l.assignee, l.staff.phone, [{ recordId: l.recordId, summary: l.want, brand: l.brand, custName: '', custPhone: phone, override: false }], dmMsgId);
  } catch(e){ D.log('FR notify err:', String(e.message||e).slice(0,60)); }
  D.log(`FR ✅ ${cat.toUpperCase()} lead assigned → ${l.assignee || '(pool empty?)'} (${phone}) "${want}"`);
}

// ---------- flow ----------
async function flush(jid){
  const b = buffers[jid]; delete buffers[jid];
  if (!b) return;
  const text = b.texts.join(' \n ').trim();
  const now = Date.now();
  const pend = state.pending[jid];
  let { cat, imageOnly } = classify(text, b.hasImage);
  const lang = isEnglish(text) ? 'en' : 'bm';

  if (pend && now - pend.ts < PENDING_MODEL_MS){
    // they answered our "berminat motor apa?" — WHATEVER it is, the category is confirmed → assign.
    delete state.pending[jid]; persist();
    const finalCat = (cat === 'sell' || cat === 'loan') ? cat : 'product';
    await D.waSend(jid, tpl(finalCat === 'product' ? 'product' : finalCat, lang, cat === 'product' ? text.slice(0, 30) : ''));
    await assign(finalCat, jid, b.phone, text || '[gambar]');
    return;
  }
  if (cat === 'skip') { D.log('FR skip (unclassified/vendor):', jid.slice(0, 20)); return; }
  if (state.greeted[jid] && now - state.greeted[jid] < REGREET_MS) return;   // one touch per 7d
  state.greeted[jid] = now;

  if (cat === 'greeting'){ state.pending[jid] = { ts: now }; persist(); await D.waSend(jid, tpl('greeting', lang)); return; }
  persist();
  await D.waSend(jid, tpl(cat, lang, cat === 'product' && !imageOnly ? text.slice(0, 30) : ''));
  await assign(cat, jid, b.phone, imageOnly ? '[gambar/screenshot iklan]' : text);
}

function onMessage(info){
  // info: { jid, phone, kind ('text'|'image'), text, caption }
  try {
    if (!ON()) return;
    if (!info.jid || info.jid.endsWith('@g.us')) return;
    if (D.isStaffPhone && D.isStaffPhone(info.phone)) return;
    if (humanTouched.has(info.jid) && !state.pending[info.jid]) return;   // a human already owns this chat
    const num = (info.phone || info.jid.split('@')[0] || '').replace(/\D/g, '');
    if (!num || num.startsWith('447') || num.length > 13) return;
    const b = buffers[info.jid] = buffers[info.jid] || { texts: [], hasImage: false, phone: num, timer: null };
    if (info.kind === 'image') b.hasImage = true;
    const t = info.text || info.caption || '';
    if (t) b.texts.push(t);
    if (b.timer) clearTimeout(b.timer);
    b.timer = setTimeout(() => flush(info.jid).catch(e => D.log('FR flush err', String(e.message||e))), DEBOUNCE_MS);
  } catch(e){ D.log && D.log('FR onMessage err', String(e.message||e)); }
}

// called for every fromMe personal message (via messages.upsert capture) — humans own that chat.
function markHuman(jid){
  if (!jid || jid.endsWith('@g.us')) return;
  humanTouched.add(jid);
  if (humanTouched.size > 5000) humanTouched.clear();
}

function init(deps){ D = deps; D.log('firstresponse init — ON:', ON(), 'debounce:', DEBOUNCE_MS + 'ms'); }
module.exports = { init, onMessage, markHuman, _classify: classify, _tpl: tpl, _isEnglish: isEnglish, _state: () => state };
