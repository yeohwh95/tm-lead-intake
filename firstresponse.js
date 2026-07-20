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

const EVENT_INFO = process.env.FR_EVENT_INFO || 'test ride event kami 17 & 18 July (Jumaat & Sabtu) untuk motor Zontes dan KTM. Boleh walk-in terus, register masa walk-in ya';

// Fitri = TM purchaser (trade-ins go to her — confirmed from staff behavior 2026-07-17)
const FITRI = { name: 'Fitri', phone: '+60108093259' };

// ---------- classification ----------
const RE_SELL = /jual\s+motor|nak\s+jual|mahu\s+jual|trade\s?-?in|tukar\s+motor/i;
const RE_TESTRIDE = /test\s?-?ride|test\s?rode/i;
const RE_LOAN = /\bloan\b|ansuran|\bepp\b|kad\s+kredit|credit\s+card|pinjaman|bulanan\s+(berapa|brp)|0\s?depo|blacklist|ctos|ccris/i;
const RE_BIKE = /vstrom|v-?strom|tracer|\bz\s?\d{3}|\bmt-?\s?\d{2}\b|cbr|ninja|\bzx\s?\d|gsx|t-?max|x-?max|n-?max|forza|vulcan|er-?6|rsv4|\btrk\b|tiger|duke|\br\s?2[35]\b|\br15\b|y1[56]|sv\s?650|nk\s?\d|450mt|368g|hunter|dominar|lambretta|vespa|zontes|\bnova\b|aveta|avantiz|\bego\b|lc\s?135|enduro|\bsym\b|versys|brutale|xj6|scrambler|monster|\bcb\s?\d{3}|crf|klx|pcx|vario|\bbeat\b|y15zr|8tt|thunder|moda\b|wmoto|gpx|keeway|scooter|superbike|motor\s+(second|2nd|baru|used)/i;
const RE_VENDOR_AUTO = /thank you for contacting|welcome to .* (service|customer)|terima kasih kerana menghubungi|saya akan reply|confirmation code|verification code/i;
const RE_MALAY = /\b(nak|nk|boleh|bleh|ada|berapa|brp|tuan|bang|bos|ke|tak|x\s?mau|macam|mcm|saya|sy|kami|harga|jual|beli|lagi|stok|pagi|petang|malam|salam|tnya|tanya|ape|khabar|kew|ye|dgn|utk|esok|arini)\b/i;

function classify(text, hasImage){
  const t = String(text || '').trim();
  if (RE_VENDOR_AUTO.test(t)) return { cat: 'skip' };
  if (RE_TESTRIDE.test(t)) return { cat: 'testride' };
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
// financiers, kept in one place so the wording stays in sync across BM/EN (Harith feedback 2026-07-20:
// bot must state actual providers, not a vague "Aeon & EPP" — and CIMB EPP does NOT exist)
const LOAN_SHOP = 'Aeon Credit, Chailease, JCL, Parkson, BSNC';
const LOAN_EPP  = 'Maybank, Public Bank, UOB, RHB, OCBC, Affin, AmBank, HLB, Alliance Bank, HSBC, Standard Chartered, BSN & AEON Credit Card';

function tpl(cat, lang, card, stockLine){
  const g = saMYT();
  const c = card ? `\n\n${card.name.toUpperCase()} : ${card.disp}\nhttps://wa.me/${card.digits}` : '';
  const s = stockLine ? `\n\n${stockLine}` : '';
  if (cat === 'sell') return (lang === 'en'
    ? `Hi! Sure, we do buy & trade-in 👍 Which bike (model, year)? Photos help too. Our purchaser will contact you shortly ya`
    : `${g} 😊 Boleh tuan. Nak jual/trade-in motor apa ya? Boleh share model, tahun & gambar motor. Purchaser kami akan contact awak ya`) + c;
  if (cat === 'loan') return (lang === 'en'
    ? `Hi! Yes — we offer shop loan (${LOAN_SHOP}) & 0% credit-card EPP (${LOAN_EPP} — CIMB EPP not available) 👍 Our salesperson will contact you shortly with the loan details ya`
    : `${g} 😊 Boleh tuan — kami ada loan kedai (${LOAN_SHOP}) & EPP kad kredit 0% (${LOAN_EPP} — EPP CIMB tiada). Salesman kami akan contact awak sebentar lagi untuk detail loan ya`) + c;
  if (cat === 'testride') return lang === 'en'
    ? `Hi! 😊 Our ${EVENT_INFO}`
    : `${g} 😊 Boleh tuan — ${EVENT_INFO}`;
  if (cat === 'greeting') return lang === 'en'
    ? `Hi! 😊 Which bike are you interested in? Feel free to share the model or a screenshot of the ad you saw 👍`
    : `${g} 😊 Ya bos, berminat motor apa ya? Boleh share model atau screenshot iklan yang bos tengok tadi 👍`;
  return (lang === 'en'
    ? `Thank you for contacting us. 😊 Your message has been received. Our sales advisor will contact you shortly to help answer your questions.`
    : `Terima kasih kerana menghubungi kami. 😊 Mesej anda telah diterima. Sales advisor kami akan menghubungi anda dalam masa terdekat untuk membantu menjawab pertanyaan anda.`) + s + c;
}

// ---------- stock check (Harith feedback: check real WooCommerce stock before answering
// a product/stock question, instead of always assuming yes or staying silent on it) ----------
async function stockLineFor(cat, text, lang){
  if (cat !== 'product' || !text || !RE_BIKE.test(text) || !D.wooCheckStock) return '';
  let r = null;
  try { r = await D.wooCheckStock(text); } catch(e){ D.log && D.log('FR stock err:', String(e.message||e).slice(0,60)); }
  if (!r) return '';   // not configured / lookup failed → skip silently, never block the reply
  if (r.matches && r.matches.length){
    const prices = r.matches.map(m => m.price).filter(p => p > 0);
    const price = prices.length ? Math.min(...prices) : 0;
    return lang === 'en'
      ? (price ? `✅ Yes, we have stock — from RM ${price.toLocaleString()}.` : `✅ Yes, we have stock available.`)
      : (price ? `✅ Ada, stok tersedia — dari RM ${price.toLocaleString()}.` : `✅ Ada, stok tersedia.`);
  }
  return lang === 'en'
    ? `⚠️ That exact model isn't in stock right now, but we have other units — our salesperson can suggest alternatives.`
    : `⚠️ Buat masa ni takde stok untuk model tu, tapi kami ada unit lain — salesman boleh cadangkan pilihan lain ya.`;
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
    return { name: 'Fitri', digits: '60108093259', disp: '010-8093259' };
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
  if (l.assignee && l.staff?.phone){
    const digits = String(l.staff.phone).replace(/\D/g, '');
    return { name: l.assignee, digits, disp: '0' + digits.slice(2, 4) + '-' + digits.slice(4) };
  }
  return null;
}

// ---------- flow ----------
const VAGUE = t => !t || t.trim().length < 4 || classify(t, false).cat === 'greeting';
async function flush(jid){
  const b = buffers[jid]; delete buffers[jid];
  if (!b) return;
  const text = b.texts.join(' \n ').trim();
  const now = Date.now();
  const pend = state.pending[jid];
  let { cat, imageOnly } = classify(text, b.hasImage);
  const lang = isEnglish(text) ? 'en' : 'bm';

  if (pend && now - pend.ts < PENDING_MODEL_MS){
    // they answered our "berminat motor apa?" — category confirmed → assign FIRST, reply with the card.
    delete state.pending[jid]; persist();
    if (cat === 'testride'){ await D.waSend(jid, tpl('testride', lang)); return; }
    const finalCat = (cat === 'sell' || cat === 'loan') ? cat : 'product';
    const want = VAGUE(text) && !b.hasImage ? '[ad click — model belum stated, sila probe]' : (text || '[gambar/screenshot iklan]');
    const stockLine = await stockLineFor(finalCat, text, lang);
    const card = await assign(finalCat, jid, b.phone, want);
    await D.waSend(jid, tpl(finalCat, lang, card, stockLine));
    return;
  }
  if (cat === 'skip') { D.log('FR skip (unclassified/vendor):', jid.slice(0, 20)); return; }
  if (state.greeted[jid] && now - state.greeted[jid] < REGREET_MS) return;   // one touch per 7d
  state.greeted[jid] = now;

  if (cat === 'testride'){ persist(); await D.waSend(jid, tpl('testride', lang)); return; }   // info only — NO assignment (Benjamin)
  if (cat === 'greeting'){ state.pending[jid] = { ts: now }; persist(); await D.waSend(jid, tpl('greeting', lang)); return; }
  persist();
  const stockLine = await stockLineFor(cat, imageOnly ? '' : text, lang);
  const card = await assign(cat, jid, b.phone, imageOnly ? '[gambar/screenshot iklan]' : text);
  await D.waSend(jid, tpl(cat, lang, card, stockLine));
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
