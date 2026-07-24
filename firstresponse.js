// First-response bot for the TM Marketing number (93210) — Benjamin approved 2026-07-17.
// Instant first touch on Product / Loan / Trade-in / Test-ride DMs, then silent — humans own the conversation.
// PRIME DIRECTIVE (Benjamin): the moment a category is confirmed, the lead IS ASSIGNED —
// no sales opportunity is ever left sitting. Spec: FIRSTRESPONSE-SPEC.md.
// Test-ride (2026-07-20, Harith): was info-only (17-18 Jul event only) — now assigns like product/loan,
// reusing the SAME brand→pool routing (it already matches TM's test-ride-by-branch line-up).
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
// 2026-07-23 additions from real overnight misses: "nk jual" short-form + "jual moto" (no r) had
// slipped to LOAN ("nk jual moto yg masih dalam loan" → Amir instead of Fitri), and ENGLISH sell
// intent had zero coverage ("Planning to sell my forza 750 scooter" → routed product to Azrul).
const RE_SELL = /jual\s+moto\w*|nak\s+jual|nk\s+jual|mahu\s+jual|mau\s+jual|boleh\s+jual|leh\s+jual|trade\s?-?in|tukar\s+moto\w*|sell(?:ing)?\s+my\b|(?:want|wan|plan(?:ning)?|nak|how)\s+to\s+sell\b|letting\s+go\s+my/i;
// Malay ambiguity (real misroute 2026-07-22, Keeway XDV180): "ADA jual motor X?" = "do YOU (the shop)
// sell X?" — a BUY question — while "NAK jual motor" = "I want to sell mine". The bare "jual motor"
// pattern above can't tell them apart, so strip shop-sells phrasing BEFORE testing sell intent.
// Stripping (not just vetoing) keeps mixed messages correct: "ada jual tak? sy pun nak jual motor
// lama" still classifies as sell from the surviving "nak jual".
const RE_SHOP_SELLS = /\b(ada|kedai|outlet|shop|korang|you\s*all|uols)\s+(ada\s+)?(jual|menjual)\b/gi;
const RE_TESTRIDE = /test\s?-?ride|test\s?rode/i;
const RE_LOAN = /\bloan\b|ansuran|\bepp\b|kad\s+kredit|credit\s+card|pinjaman|bulanan\s+(berapa|brp)|0\s?depo|blacklist|ctos|ccris/i;
// BRAND words (2026-07-22): the list below was all specific MODEL codes — a customer naming just
// the brand ("ada KTM apa2", "nak tengok Yamaha") never matched at all. Pulled the real 32-brand
// product_brand taxonomy from tmmotoworld.com's live WooCommerce catalog and added every brand
// with stock as a bare keyword (Yamaha=90 products, Suzuki=38, Honda=39, Kawasaki=30 were the
// biggest gaps). A real customer's detailed "KTM 390 Adv R... OTR price and waiting time?"
// purchase inquiry got zero reply because "ktm" wasn't recognized anywhere.
const RE_BIKE = /vstrom|v-?strom|tracer|\bz\s?\d{3}|\bmt-?\s?\d{2}\b|cbr|ninja|\bzx\s?\d|gsx|t-?max|x-?max|n-?max|forza|vulcan|er-?6|rsv4|\btrk\b|tiger|duke|\br\s?2[35]\b|\br15\b|y1[56]|sv\s?650|nk\s?\d|450mt|368g|hunter|dominar|lambretta|vespa|zontes|\bnova\b|aveta|avantiz|\bego\b|lc\s?135|enduro|\bsym\b|versys|brutale|xj6|scrambler|monster|\bcb\s?\d{3}|crf|klx|pcx|vario|\bbeat\b|y15zr|8tt|thunder|moda\b|wmoto|gpx|keeway|scooter|superbike|motor\s+(second|2nd|baru|used)|\bktm\b|yamaha|suzuki|honda|kawasaki|\bbmw\b|modenas|ducati|aprilia|triumph|benelli|cfmoto|harley|agusta|enfield|\bqj\b|morini|\bafaz\b|\bktns\b/i;
const RE_VENDOR_AUTO = /thank you for contacting|welcome to .* (service|customer)|terima kasih kerana menghubungi|saya akan reply|confirmation code|verification code/i;
const RE_MALAY = /\b(nak|nk|boleh|bleh|ada|berapa|brp|tuan|bang|bos|ke|tak|x\s?mau|macam|mcm|saya|sy|kami|harga|jual|beli|lagi|stok|pagi|petang|malam|salam|tnya|tanya|ape|khabar|kew|ye|dgn|utk|esok|arini)\b/i;

function classify(text, hasImage){
  const t = String(text || '').trim();
  if (RE_VENDOR_AUTO.test(t)) return { cat: 'skip' };
  if (RE_TESTRIDE.test(t)) return { cat: 'testride' };
  if (RE_SELL.test(t.replace(RE_SHOP_SELLS, ' '))) return { cat: 'sell' };
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

function tpl(cat, lang, card, stockLine, offHours){
  const g = saMYT();
  // Off-hours (team 2026-07-22: replies 24h, lead distribution Mon–Fri 9–5): no salesman card at
  // 2am — tell the customer when the office reopens instead. The card slot carries that line so
  // every category template picks it up without its own wording change.
  const c = card ? `\n\n${card.name.toUpperCase()} : ${card.disp}\nhttps://wa.me/${card.digits}`
    : offHours ? (lang === 'en'
        ? `\n\n⏰ Our office hours are Mon–Fri, 9am–5pm — our sales advisor will contact you once we're back in office 🙏`
        : `\n\n⏰ Waktu operasi kami: Isnin–Jumaat, 9 pagi–5 petang. Sales advisor kami akan menghubungi anda bila pejabat dibuka semula ya 🙏`)
    : '';
  const s = stockLine ? `\n\n${stockLine}` : '';
  if (cat === 'sell') return (lang === 'en'
    ? `Hi! Sure, we do buy & trade-in 👍 Which bike (model, year)? Photos help too. Our purchaser will contact you shortly ya`
    : `${g} 😊 Boleh tuan. Nak jual/trade-in motor apa ya? Boleh share model, tahun & gambar motor. Purchaser kami akan contact awak ya`) + c;
  if (cat === 'loan') return (lang === 'en'
    ? `Hi! Yes — we offer shop loan (${LOAN_SHOP}) & 0% credit-card EPP (${LOAN_EPP} — CIMB EPP not available) 👍 Our salesperson will contact you shortly with the loan details ya`
    : `${g} 😊 Boleh tuan — kami ada loan kedai (${LOAN_SHOP}) & EPP kad kredit 0% (${LOAN_EPP} — EPP CIMB tiada). Salesman kami akan contact awak sebentar lagi untuk detail loan ya`) + c;
  if (cat === 'testride') return (lang === 'en'
    ? `Thank you for your interest in a test ride with us! 😊 Our sales advisor will contact you as soon as possible to help check the model, date, time availability and the test ride process.`
    : `Terima kasih kerana berminat untuk membuat test ride bersama kami! 😊 Sales advisor kami akan menghubungi anda secepat mungkin untuk membantu semakan model, tarikh, masa yang available dan proses untuk test ride.`) + c;
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
  // Booking/pre-release listing matched (2026-07-24, Zontes 175X: bot claimed "we have stock —
  // from RM 8,888.889" off the placeholder price of "OPEN FOR BOOKING NEW ZONTES 175X") →
  // booking pitch, never a stock/price claim. Zontes gets Steven's dealer + mystery-gift lines.
  if (!(r.matches && r.matches.length) && r.booking && r.booking.length){
    const raw = r.booking[0].name;
    const model = raw.replace(/open\s+for\s+booking|pre-?order|coming\s+soon/gi, '').replace(/^\W+|\W+$/g, '').replace(/^new\s+/i, '').trim() || raw;
    const zontes = /zontes/i.test(raw);
    if (lang === 'en') return `🏍️ The ${model} isn't released yet — we're OPEN FOR BOOKING now!` + (zontes
      ? ` We're a Zontes dealer — book early with us to get your unit faster + a mystery gift 🎁 Beli Zontes, beli dengan TM Motoworld 😁`
      : ` Book early with us to get your unit faster ya 👍`);
    return `🏍️ ${model} belum release lagi — sekarang OPEN FOR BOOKING!` + (zontes
      ? ` Kami Zontes dealer — sesiapa book awal dengan kami akan dapat stock cepat & mystery gift 🎁 Beli Zontes, beli dengan TM Motoworld 😁`
      : ` Book awal dengan kami untuk dapat unit cepat ya 👍`);
  }
  if (r.matches && r.matches.length){
    // Dedupe by name (same bike can be listed used + NEW). ONE match → safe to quote its price.
    // SEVERAL distinct matches → the customer's model is ambiguous ("Aveta 250" = Nova 250 /
    // Vanguard 250 / VTM 250...) — list the options and ask which one, never quote a single
    // cheapest price across different bikes (Harith 2026-07-22: ask to clarify instead).
    const seen = new Set();
    const uniq = r.matches.filter(m => { const k = m.name.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
    if (uniq.length === 1){
      const price = uniq[0].price > 0 ? uniq[0].price : 0;
      return lang === 'en'
        ? (price ? `✅ Yes, we have stock — from RM ${price.toLocaleString()}.` : `✅ Yes, we have stock available.`)
        : (price ? `✅ Ada, stok tersedia — dari RM ${price.toLocaleString()}.` : `✅ Ada, stok tersedia.`);
    }
    const lines = uniq.slice(0, 4).map(m => `• ${m.name}${m.price > 0 ? ' — RM ' + m.price.toLocaleString() : ''}`).join('\n');
    return lang === 'en'
      ? `✅ We have a few options in stock:\n${lines}\nWhich one are you interested in?`
      : `✅ Ada beberapa pilihan dalam stok:\n${lines}\nYang mana satu bos berminat ya?`;
  }
  // NO match ≠ NO stock (2026-07-24: ER6N had 2 units instock + MT-07 was flagged outofstock in
  // Woo while physically available, yet both customers were told "takde stok"). A search miss or a
  // stale Woo flag must never become a confident negative claim — a wrong "no stock" loses the
  // sale. Positive claims only when a live instock match exists; everything else defers to the
  // salesman, neutrally.
  return lang === 'en'
    ? `👍 Our salesperson will confirm the latest stock for that model with you shortly.`
    : `👍 Untuk stok model tu, salesman kami akan confirm dengan awak sekejap lagi ya.`;
}

// ---------- assignment (the point of it all: category confirmed = lead assigned NOW) ----------
// Off-hours variant (team 2026-07-22): outside Mon–Fri 9–5 (D.inDistHours() false) the lead is
// STILL written to Lark immediately (never lost) but left UNASSIGNED — no salesman picked, no DM,
// no SLA timer. The whole staff-facing half is queued via D.deferStaffNotify() and released by
// index.js when the distribution window opens (rotation runs at drain time, so overnight leads
// spread fairly across the pool at 9am instead of hammering whoever was next at 2am). Leaving
// Salesman blank overnight also keeps slaSweep() from "helpfully" DMing the rep early — the sweep
// only enrols rows that HAVE a salesman.
async function assign(cat, jid, phone, wantText){
  const want = String(wantText || '').replace(/\s+/g, ' ').trim().slice(0, 60) || 'WhatsApp direct inquiry';
  const defer = !!(D.inDistHours && !D.inDistHours() && D.deferStaffNotify);
  if (cat === 'sell'){
    // Trade-in → Fitri (purchaser). Lark record + instant DM to Fitri. (No SLA pool — she's not a rep.)
    let recordId = null;
    try { recordId = await D.larkWriteLead({ phone, name: '', want: 'TRADE-IN: ' + want, brand: '', origin: 'WhatsApp Direct', assignee: 'Fitri', staff: null }); }
    catch(e){ D.log('FR lark err (sell):', String(e.message||e).slice(0,60)); }
    const fitriMsg = `🔁 *Trade-in Lead (auto)*\n\n🎯 ${want}\n👉 https://wa.me/${phone.replace(/\D/g,'')}\n\nCustomer dah dapat reply pertama — follow up ya.`;
    if (defer){
      D.deferStaffNotify({ kind: 'dm', to: FITRI.phone, text: fitriMsg });
      D.log(`FR 🌙 SELL lead deferred to office hours → Fitri (${phone}) "${want}"`);
      return null;   // no card at night — tpl() shows the office-hours line instead
    }
    try { await D.waSend(FITRI.phone, fitriMsg); }
    catch(e){ D.log('FR fitri DM err:', String(e.message||e).slice(0,60)); }
    D.log(`FR ✅ SELL lead assigned → Fitri (${phone}) "${want}"`);
    return { name: 'Fitri', digits: '60108093259', disp: '010-8093259' };
  }
  // product / loan / testride → the normal machine: round-robin pool → Lark → salesperson DM → SLA timers.
  // Testride reuses the SAME brand→pool routing as product (Zontes→Shah Alam, Lambretta/Thunder→Klang+Shah
  // Alam, Honda→Honda, anything else→HQ) — this already matches TM's test-ride-by-branch line-up
  // (Harith, 2026-07-20), so an unrecognised/used-bike model correctly falls through to the HQ catch-all
  // ("round robin as normal") with zero extra mapping needed.
  const prefix = cat === 'loan' ? 'LOAN: ' : cat === 'testride' ? 'TESTRIDE: ' : '';
  const unavail = await D.getUnavailable();
  const enriched = D.assignLeads([{ phone, name: '', interest: prefix + want, brand: '' }], { origin: 'WhatsApp Direct', noAssign: defer }, unavail);
  const l = enriched[0];
  try { l.recordId = await D.larkWriteLead(l); } catch(e){ D.log('FR lark err:', String(e.message||e).slice(0,60)); }
  if (defer){
    D.deferStaffNotify({ kind: 'pool', phone, want: l.want, brand: l.brand, recordId: l.recordId || null });
    D.log(`FR 🌙 ${cat.toUpperCase()} lead deferred to office hours (${phone}) "${want}"`);
    return null;
  }
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

// A (2026-07-24): LLM intent classification — regex keyword lists kept missing real Malay sell
// phrasings ("mau tolak moto masih ada loan" got the buying-loan template). gpt-4o (injected
// D.aiClassify) decides the category; regex classify() is the instant fallback on API
// error/timeout/garbage output, and still fully handles image-only messages (nothing for the LLM
// to read) + vendor auto-replies (cheap and certain). An image WITH a short caption keeps the
// regex verdict when the LLM says greeting/skip — the image carries intent the LLM can't see.
const AI_CATS = new Set(['sell', 'loan', 'testride', 'product', 'greeting', 'skip']);
async function classifySmart(text, hasImage){
  const rx = classify(text, hasImage);
  const t = String(text || '').trim();
  if (!D.aiClassify || !t || RE_VENDOR_AUTO.test(t)) return rx;
  try {
    const cat = await D.aiClassify(t);
    if (cat && AI_CATS.has(cat)){
      if (hasImage && (cat === 'greeting' || cat === 'skip')) return rx;
      if (cat !== rx.cat) D.log(`FR 🧠 ai overrides regex ${rx.cat}→${cat}: "${t.slice(0, 60)}"`);
      return { cat, imageOnly: false };
    }
    if (cat != null) D.log('FR aiClassify unusable → regex fallback:', String(cat).slice(0, 20));
  } catch (e) { D.log('FR aiClassify err → regex fallback:', String(e.message || e).slice(0, 60)); }
  return rx;
}

// ---------- flow ----------
const VAGUE = t => !t || t.trim().length < 4 || classify(t, false).cat === 'greeting';
async function flush(jid){
  const b = buffers[jid]; delete buffers[jid];
  if (!b) return;
  const text = b.texts.join(' \n ').trim();
  const now = Date.now();
  const pend = state.pending[jid];
  let { cat, imageOnly } = await classifySmart(text, b.hasImage);
  const lang = isEnglish(text) ? 'en' : 'bm';

  if (pend && now - pend.ts < PENDING_MODEL_MS){
    // they answered our "berminat motor apa?" — category confirmed → assign FIRST, reply with the card.
    delete state.pending[jid]; persist();
    const finalCat = (cat === 'sell' || cat === 'loan' || cat === 'testride') ? cat : 'product';
    const want = VAGUE(text) && !b.hasImage ? '[ad click — model belum stated, sila probe]' : (text || '[gambar/screenshot iklan]');
    const stockLine = await stockLineFor(finalCat, text, lang);
    const card = await assign(finalCat, jid, b.phone, want);
    const offHours = !!(D.inDistHours && !D.inDistHours());
    await D.waSend(jid, tpl(finalCat, lang, card, stockLine, offHours));
    return;
  }
  if (cat === 'skip') { D.log('FR skip (unclassified/vendor):', jid.slice(0, 20)); return; }
  if (state.greeted[jid] && now - state.greeted[jid] < REGREET_MS) return;   // one touch per 7d
  state.greeted[jid] = now;

  if (cat === 'greeting'){ state.pending[jid] = { ts: now }; persist(); await D.waSend(jid, tpl('greeting', lang)); return; }
  persist();
  const stockLine = await stockLineFor(cat, imageOnly ? '' : text, lang);
  const card = await assign(cat, jid, b.phone, imageOnly ? '[gambar/screenshot iklan]' : text);
  const offHours = !!(D.inDistHours && !D.inDistHours());
  await D.waSend(jid, tpl(cat, lang, card, stockLine, offHours));
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
module.exports = { init, onMessage, markHuman, _classify: classify, _tpl: tpl, _isEnglish: isEnglish, _state: () => state, RE_BIKE };
