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
// 72h, raised from 48h (2026-08-16): the same weekend arithmetic as REHYDRATE_DEFER_H. A customer
// asked "berminat motor apa?" on a Friday evening who answers Monday morning is 62h later, and at
// 48h their answer would have been treated as a brand-new conversation.
const PENDING_MODEL_MS = 72 * 3600 * 1000;
// Kill switch. OFF restores the pre-qualification flow EXCEPT the closed-hours sentence, which the
// client banned outright — the fallback is the plain handoff line plus the computed closing day.
const QUALIFY_ON = () => process.env.FR_QUALIFY !== '0';
// 1, not 2 (2026-08-21). The second ask was a BYTE-IDENTICAL repeat of the first, which is exactly
// what the client reported twice ("auto bot keep tanya soalan sama"). With qualifyVague now
// recognising real answers, what remains at ask #2 is a genuine non-answer ("ok", "."), and the
// right move there is to stop asking: the lead is already in Lark and already queued, so the rep
// still gets it at the next window with whatever we have. A repeated question buys nothing and
// costs the conversation — three of the six repeat victims stopped replying.
const QUALIFY_MAX_ASKS = 1;
// Env-configurable so it can live on a Render disk. Without one this file is wiped on every
// deploy — which is why rehydrateGreeted() exists, and why a phone-gate hold would otherwise
// be lost mid-flight (the customer would then never be assigned to anyone).
const STATE_FILE = process.env.FR_STATE_FILE || path.join(__dirname, 'fr_state.json');

let D = {};                                       // injected deps from index.js
// jid -> ts · jid -> { ts, asks, cat, want, lang, recordId, phase }
let state = { greeted: {}, qualify: {} };
try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch {}
// MIGRATION (2026-08-16): `state.pending` (the old greeting flow, jid -> {ts}) becomes
// `state.qualify` with phase 'model'. There is one live file on the persistent disk and a customer
// mid-greeting at deploy time must not be stranded — their next message has to still be recognised
// as the answer we asked for, not treated as a fresh conversation.
state.greeted = state.greeted || {};
state.qualify = state.qualify || {};
if (state.pending && typeof state.pending === 'object'){
  for (const jid of Object.keys(state.pending)){
    if (state.qualify[jid]) continue;
    const p = state.pending[jid] || {};
    state.qualify[jid] = { ts: p.ts || Date.now(), asks: 1, phase: 'model', cat: '', want: '', lang: 'bm', recordId: null };
  }
  delete state.pending;
}
const persist = () => { try { fs.writeFileSync(STATE_FILE, JSON.stringify(state)); } catch {} };

const humanTouched = new Set();                   // jids where a HUMAN (fromMe) has spoken since boot
const buffers = {};                               // jid -> { texts:[], hasImage, phone, timer }

// Fitri = TM purchaser (trade-ins go to her — confirmed from staff behavior 2026-07-17).
// openId added 2026-07-30 (Benjamin approved): trade-in rows used to be written with the Lark
// `Salesman` cell EMPTY, and that emptiness is exactly what let the blank-openId bug attribute her 3
// leads to Ikhwan and report them to the client as his misses. Filling it in is safe: `slaSweep` only
// looks at rows with NO `SLA Assigned At` (trade-ins always have one), and `rehydrateFromLark` maps
// openId→STAFF, where she is deliberately absent, so she is skipped — she is a purchaser, not a rep
// on the round-robin, and must never get SLA timers. Verified present in Lark with 122 existing rows.
const FITRI = { name: 'Fitri', phone: '+60108093259', openId: 'ou_9dbd12586dfb70716c3ee77aefe010ed' };

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
// "Is there a NEW one?" — the question Woo cannot answer (see stockLineFor).
// ⚠️ TRAP: Malay `baru` is also the adverb "just/recently" — "baru nak tanya" (just wanted to ask),
// "saya baru beli" (I just bought). As an ADJECTIVE it follows its noun ("forza 250 baru"), so the
// lookahead drops the adverbial uses. A false positive here is cheap (the customer still gets
// assigned, just via the qualify line); a false miss re-creates the RM 20,800 quote we just killed.
const RE_WANTS_NEW = /\bbrand[\s-]*new\b|\bnew\s+(?:unit|bike|motor|stock|one)\b|\bbaru\b(?!\s+(?:nak|nk|je|sahaja|saja|beli|dapat|dpt|tanya|tny|lepas|balik|masuk|sampai))/i;
// ---------- answering OUR question (2026-08-21) ----------
// 🚨 The bot asks "Nak cash atau loan?" and then scored the reply with the generic VAGUE() test,
// which runs classify(). classify() has a `loan` rule and NO `cash` rule, so "Cash" / "Cash.." /
// "saya nak cash" all resolved to `greeting` = "said nothing", and the IDENTICAL question fired
// again. Measured on live traffic 18–21 Aug: 6 of the 36 qualified customers were asked the same
// thing twice; three stopped replying, and Harith reported it twice in the client group.
// This is the ONE thing the qualify ask is for, so it gets its own explicit rule — never inferred
// from a category classifier that was written for a different question.
const RE_PAYMODE = /\b(cash|tunai|loan|lon|ansuran|instal?lment|epp|kredit|credit\s?card|kad\s+kredit|aeon|chailease|jcl|parkson|bsnc|full\s+payment|bayar\s+penuh|depo|deposit|downpayment|dp)\b/i;
// A model name the RE_BIKE list has never heard of still LOOKS like a model: letters glued to
// digits (trk502, x250gp, zx1000r, r15) or a bare digit-code (703f, 552). RE_BIKE is a catalogue
// of models TM sells today and will always lag the ones customers ask about — treating everything
// missing from it as "the customer said nothing" is what re-asked "which model?" to a customer who
// had just typed TRK502. Deliberately NOT added to RE_BIKE: routing must stay conservative, only
// the did-they-answer-us test gets the benefit of the doubt.
const RE_MODELISH = /\b(?=[a-z0-9-]*[a-z])(?=[a-z0-9-]*\d)[a-z0-9-]{3,10}\b/i;
const RE_VENDOR_AUTO = /thank you for contacting|welcome to .* (service|customer)|terima kasih kerana menghubungi|saya akan reply|confirmation code|verification code/i;
// A price / monthly-instalment question asked INSIDE a product enquiry. Deliberately NOT a category:
// it only flavours the closing sentence of the stock line, because the salesperson owns price
// (2026-08-10 — the bot quoted one used unit's price as if it were a model's, three times in a
// morning). `brp\b` guards against a bare `brp` swallowed by a longer word; `ansuran|bulanan`
// overlap RE_LOAN, which is harmless — RE_PRICE is only consulted once the category already
// resolved to `product`, so a loan-classified message never gets both treatments.
const RE_PRICE = /harga|berapa|brp\b|price|how much|ansuran|bulanan/i;
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

// "I'm only customer service" — Benjamin approved 2026-08-14 (DRAFT-2). Used INSTEAD OF, never in
// addition to, the existing "salesman will confirm the price" tail: two salesman-will-confirm
// sentences in one message is the double-say this replaces. See stockLineFor().
const CS_PRICE_BM = `Untuk harga & plan bulanan saya customer service je, tak berani bagi angka salah 🙏 Salesman kami akan confirm dengan tuan ya.`;
const CS_PRICE_EN = `For the price & monthly plan I'm customer service only, I don't want to give you a wrong number 🙏 Our salesperson will confirm with you ya.`;

// ---------- off-hours qualification copy (Benjamin approved 2026-08-16) ----------
// ONE message that asks the two things a salesperson always needs before they can help: which
// model, and cash or loan. Replaces the old bare "berminat motor apa?" outside the window, so the
// rep opens a qualified lead on Monday instead of "Hi".
// Two forms, because asking "which model?" straight after the bot has just NAMED the exact unit
// reads like it wasn't listening (client, 2026-08-17). `modelKnown` drops the model half and asks
// only the thing we still genuinely need.
//   modelKnown = false → the full ask (unchanged, byte for byte)
//   modelKnown = true  → cash-or-loan only
//   payAsked   = the stock line ALREADY ended with "Bos nak cash atau loan?" — appending the ask
//                below then put the same question in the same bubble twice (live, 20 Aug 22:08:
//                "…Bos nak cash atau loan? | Nak cash atau loan ya bos?"). Detected from the text
//                we are about to send, not from a flag, so it cannot drift from the stock copy.
// modelKnown && payAsked ⇒ nothing left to ask: the ask is empty and the stock line stands alone.
const qualifyAsk = (lang, modelKnown, payAsked) => lang === 'en'
  ? (modelKnown
      ? (payAsked ? '' : `Cash or loan ya? 😊 I'll pass all the details to our salesman so he can help you straight away.`)
      : (payAsked
          ? `Can I get a bit more detail, which model are you interested in? 😊 I'll pass all the details to our salesman so he can help you straight away.`
          : `Can I get a bit more detail, which model are you interested in? Cash or loan? 😊 I'll pass all the details to our salesman so he can help you straight away.`))
  : (modelKnown
      ? (payAsked ? '' : `Nak cash atau loan ya bos? 😊 Saya pass semua detail kat salesman supaya dia terus boleh bantu tuan.`)
      : (payAsked
          ? `Boleh saya tahu sikit, tuan minat model yang mana ya? 😊 Saya pass semua detail kat salesman supaya dia terus boleh bantu tuan.`
          : `Boleh saya tahu sikit, tuan minat model yang mana ya? Nak cash atau loan? 😊 Saya pass semua detail kat salesman supaya dia terus boleh bantu tuan.`));
// Does a line we are about to send already put the cash-or-loan question to the customer?
const RE_ASKS_PAY = /cash\s+atau\s+loan|cash\s+or\s+loan/i;
// 🚨 THE DAY IS COMPUTED (D.nextWindowLabel), NEVER HARDCODED. Writing "Isnin" into this string is
// exactly the 2026-07-30 hours-drift incident: a customer-facing fact that also exists as config
// will drift from it. `label` comes from the real FR_DIST_* window.
const closingLine = (lang, label) => lang === 'en'
  ? `Our sales advisor will contact you ${label.en} ya 🙏 Thank you!`
  : `Sales advisor kami akan contact tuan ${label.bm} ya 🙏 Terima kasih tuan.`;

// 🚨 THE CLOSED-HOURS SENTENCE IS GONE (client, 2026-08-16): "Outside operating hours, don't say we
// are closed now. Say something like I will get the sales person to contact you in the next working
// day ya." The 5th parameter changed MEANING with it — it was `closed` (a boolean), it is now
// `nextLabel` ({bm,en} or null). When there is no salesperson card but we DO know when the next
// assignment window opens, the reply commits to that day by name instead of announcing a closure.
function tpl(cat, lang, card, stockLine, nextLabel){
  const g = saMYT();
  // ⚠️ The OPERATING-hours sentence used to be built here from `D.hoursLabel`. It is gone with the
  // closed-hours branch, so that dep is now unused by this module (index.js still injects it and
  // still logs both windows at boot — hours.js itself stays, it now also owns nextWindowLabel).
  // The 2026-07-30 lesson survives the deletion and is why the DAY below is computed, not written:
  // never hardcode a customer-facing fact that also exists as config.
  const c = card ? `\n\n${card.name.toUpperCase()} : ${card.disp}\nhttps://wa.me/${card.digits}`
    : nextLabel ? `\n\n${closingLine(lang, nextLabel)}`
    : '';
  const s = stockLine ? `\n\n${stockLine}` : '';
  if (cat === 'sell') return (lang === 'en'
    ? `Hi! Sure, we do buy & trade-in 👍 Which bike (model, year)? Photos help too. Our purchaser will contact you shortly ya`
    : `${g} 😊 Boleh tuan. Nak jual/trade-in motor apa ya? Boleh share model, tahun & gambar motor. Purchaser kami akan contact awak ya`) + c;
  // LOAN — Benjamin approved 2026-08-14 (DRAFT-1). Two deliberate changes from the 07-20 wording:
  // (a) the bot now says outright that it is customer service, so a customer never reads a
  // financier list as an approval decision; (b) the "👇" pointer is only appended when a
  // salesperson card actually follows — parked / held / no-rep leads get no card, and an arrow
  // pointing at nothing reads as a broken message.
  if (cat === 'loan') return (lang === 'en'
    ? `Hi! Yes we can 👍 We offer shop loan (${LOAN_SHOP}) & 0% credit card EPP (${LOAN_EPP}. CIMB EPP not available).\n\n`
      + `I'm customer service only ya, so for loan details & approval our salesperson knows best. `
      + `I've passed your info to them and they'll contact you shortly.`
      + (card ? ` Or you can reach them directly 👇` : ``)
    : `${g} 😊 Boleh tuan. Kami ada loan kedai (${LOAN_SHOP}) & EPP kad kredit 0% (${LOAN_EPP}. EPP CIMB tiada).\n\n`
      + `Saya customer service je ya, jadi untuk detail loan & kelulusan salesman kami lagi arif. `
      + `Info tuan dah saya pass kat dia, dia akan contact tuan sebentar lagi.`
      + (card ? ` Kalau nak terus pun boleh 👇` : ``)) + c;
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
  // Did they actually ask a price? Only then does the CS-price line REPLACE the stock line's
  // "salesman will confirm" tail. Never both — that would be two salesman-will-confirm sentences.
  const priceAsked = RE_PRICE.test(String(text || ''));
  // Booking/pre-release listing matched (2026-07-24, Zontes 175X: bot claimed "we have stock —
  // from RM 8,888.889" off the placeholder price of "OPEN FOR BOOKING NEW ZONTES 175X") →
  // booking pitch, never a stock/price claim. Zontes gets Steven's dealer + mystery-gift lines.
  if (!(r.matches && r.matches.length) && r.booking && r.booking.length){
    const raw = r.booking[0].name;
    const model = raw.replace(/open\s+for\s+booking|pre-?order|coming\s+soon/gi, '').replace(/^\W+|\W+$/g, '').replace(/^new\s+/i, '').trim() || raw;
    const zontes = /zontes/i.test(raw);
    if (lang === 'en') return `🏍️ The ${model} isn't released yet, but we're OPEN FOR BOOKING now!` + (zontes
      ? ` We're a Zontes dealer, so book early with us to get your unit faster + a mystery gift 🎁 Beli Zontes, beli dengan TM Motoworld 😁`
      : ` Book early with us to get your unit faster ya 👍`);
    return `🏍️ ${model} belum release lagi, sekarang OPEN FOR BOOKING!` + (zontes
      ? ` Kami Zontes dealer, sesiapa book awal dengan kami akan dapat stock cepat & mystery gift 🎁 Beli Zontes, beli dengan TM Motoworld 😁`
      : ` Book awal dengan kami untuk dapat unit cepat ya 👍`);
  }
  // A customer asking for a NEW bike is asking a question this catalog cannot answer. Woo holds
  // TM's USED inventory — one row per physical secondhand unit — plus 87 hand-typed "NEW …" rows
  // that nobody maintains (one is priced RM 888,888.8888, one has no price, and there is no new
  // Forza 250 row at all, which is exactly how "forza 250 baru" got quoted a 42,000km 2022 unit).
  // So: no stock claim, no price. Take the one qualifier the salesperson always needs, and assign.
  // (Benjamin, 2026-08-10: "get whatever you are supposed to get, help sales person to qualify
  // then assign, no need answer so many question.")
  const usedM = (r.matches || []).filter(m => !m.isNew);
  if (RE_WANTS_NEW.test(String(text || '')) || (!usedM.length && (r.matches || []).some(m => m.isNew))){
    // The qualifier stays either way (Benjamin 2026-08-10: "help sales person to qualify then
    // assign") — only the reason for not naming a number changes when they asked one outright.
    if (priceAsked) return lang === 'en'
      ? `👍 For a brand-new unit, stock & the OTR price I'm customer service only, I don't want to give you a wrong number 🙏 Our salesperson will confirm with you ya. Cash or loan?`
      : `👍 Untuk unit baru, stok & harga OTR saya customer service je, tak berani bagi angka salah 🙏 Salesman kami akan confirm dengan tuan ya. Bos nak cash atau loan?`;
    return lang === 'en'
      ? `👍 For a brand-new unit our salesperson will confirm stock & the OTR price with you. Cash or loan?`
      : `👍 Untuk unit baru, salesman kami akan confirm stok & harga OTR dengan bos ya. Bos nak cash atau loan?`;
  }
  if (usedM.length){
    // Name the actual unit — year is in the title, mileage beside it. The old line said only
    // "dari RM 22,800", which reads as the price of an MT-09 rather than of ONE 2015 bike with
    // 79,000 km on it. Same source of truth, no price, and the salesperson gets a warm opening.
    const km = m => m.mileage > 0 ? ` (${m.mileage.toLocaleString()} km)` : '';
    if (usedM.length === 1) return lang === 'en'
      ? `✅ Yes, ${usedM[0].name}${km(usedM[0])} is available. `
        + (priceAsked ? CS_PRICE_EN : `Our salesperson will confirm the price & monthly plan with you.`)
      : `✅ Ada ya bos, ${usedM[0].name}${km(usedM[0])}. `
        + (priceAsked ? CS_PRICE_BM : `Salesman kami akan confirm harga & plan bulanan dengan bos ya.`);
    // SEVERAL distinct matches → the customer's model is ambiguous ("Aveta 250" = Nova 250 /
    // Vanguard 250 / VTM 250...) — list them and ask which one (Harith 2026-07-22).
    const lines = usedM.slice(0, 4).map(m => `• ${m.name}${km(m)}`).join('\n');
    return lang === 'en'
      ? `✅ We have a few units in stock:\n${lines}\nWhich one are you interested in? `
        + (priceAsked ? CS_PRICE_EN : `Our salesperson will give you the price & plan.`)
      : `✅ Ada beberapa unit dalam stok:\n${lines}\nYang mana satu bos berminat ya? `
        + (priceAsked ? CS_PRICE_BM : `Salesman kami akan bagi harga & plan.`);
  }
  // NO match ≠ NO stock (2026-07-24: ER6N had 2 units instock + MT-07 was flagged outofstock in
  // Woo while physically available, yet both customers were told "takde stok"). A search miss or a
  // stale Woo flag must never become a confident negative claim — a wrong "no stock" loses the
  // sale. Positive claims only when a live instock match exists; everything else defers to the
  // salesman, neutrally.
  // When they asked a price, the CS line stands ALONE — it already carries the
  // salesman-will-confirm promise, and the neutral stock sentence would be a second one.
  if (priceAsked) return lang === 'en' ? CS_PRICE_EN : CS_PRICE_BM;
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
// `ctx` is an optional in/out bag, NOT part of the return contract — callers that don't care pass
// nothing and `tpl()` keeps receiving the same card-or-null it always has. In: `ctx.gated` marks a
// lead coming out of the phone gate. Out: `ctx.outcome` says WHY there is no card, which the caller
// cannot otherwise tell apart. A null card has two opposite meanings — "parked until 9am" (normal)
// and "no salesperson took it" (broken) — and the gate log recorded both as an empty name, so a
// real failure was indistinguishable from a routine overnight park (2026-08-06).
async function assign(cat, jid, phone, wantText, ctx){
  const want = String(wantText || '').replace(/\s+/g, ' ').trim().slice(0, 60) || 'WhatsApp direct inquiry';
  const defer = !!(D.inDistHours && !D.inDistHours() && D.deferStaffNotify);
  const mark = (outcome, assignee) => { if (ctx){ ctx.outcome = outcome; ctx.assignee = assignee || ''; } };
  const gated = !!(ctx && ctx.gated);
  if (cat === 'sell'){
    // Trade-in → Fitri (purchaser). Lark record + instant DM to Fitri. (No SLA pool — she's not a rep.)
    let recordId = null;
    try { recordId = await D.larkWriteLead({ phone, name: '', want: 'TRADE-IN: ' + want, brand: '', origin: 'WhatsApp Direct', assignee: 'Fitri', staff: FITRI }); }
    catch(e){ D.log('FR lark err (sell):', String(e.message||e).slice(0,60)); }
    if (ctx) ctx.recordId = recordId || null;   // null here = the Lark write FAILED; the report counts those
    const fitriMsg = `🔁 *Trade-in Lead (auto)*\n\n🎯 ${want}\n👉 https://wa.me/${phone.replace(/\D/g,'')}\n\nCustomer dah dapat reply pertama, follow up ya.`;
    if (defer){
      // jid + gated ride along so the drain can close this lead's story in the gate log tomorrow
      // morning; without the jid it has no idea which chat the parked lead belongs to.
      D.deferStaffNotify({ kind: 'dm', to: FITRI.phone, text: fitriMsg, jid, gated, cat, assignee: 'Fitri' });
      D.log(`FR 🌙 SELL lead deferred to office hours → Fitri (${phone}) "${want}"`);
      mark('parked', 'Fitri');
      return null;   // no card at night — tpl() shows the office-hours line instead
    }
    try { await D.waSend(FITRI.phone, fitriMsg); }
    catch(e){ D.log('FR fitri DM err:', String(e.message||e).slice(0,60)); }
    D.log(`FR ✅ SELL lead assigned → Fitri (${phone}) "${want}"`);
    mark('assigned', 'Fitri');
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
  // 🚨 The handle is contact info, NOT a phone. It rides on the lead as its own field so the DM
  // can offer a tappable link; it must never reach `phone` — larkWriteLead would happily store it
  // and a rep dialling a handle is the exact failure the gate exists to stop (2026-08-02).
  if (ctx && ctx.username) l.username = ctx.username;
  try { l.recordId = await D.larkWriteLead(l); } catch(e){ D.log('FR lark err:', String(e.message||e).slice(0,60)); }
  if (ctx) ctx.recordId = l.recordId || null;   // null here = the Lark write FAILED; the report counts those
  if (defer){
    D.deferStaffNotify({ kind: 'pool', phone, want: l.want, brand: l.brand, recordId: l.recordId || null, jid, gated, cat });
    D.log(`FR 🌙 ${cat.toUpperCase()} lead deferred to office hours (${phone}) "${want}"`);
    mark('parked', '');
    return null;
  }
  try {
    const dmMsgId = await D.notifyStaff([l]);
    if (D.sla && l.staff?.phone) D.sla.register(l.assignee, l.staff.phone, [{ recordId: l.recordId, summary: l.want, brand: l.brand, custName: '', custPhone: phone, override: false }], dmMsgId);
  } catch(e){ D.log('FR notify err:', String(e.message||e).slice(0,60)); }
  D.log(`FR ✅ ${cat.toUpperCase()} lead assigned → ${l.assignee || '(pool empty?)'} (${phone}) "${want}"`);
  if (l.assignee && l.staff?.phone){
    const digits = String(l.staff.phone).replace(/\D/g, '');
    mark('assigned', l.assignee);
    return { name: l.assignee, digits, disp: '0' + digits.slice(2, 4) + '-' + digits.slice(4) };
  }
  // Nobody took it. `assignLeads` falls back to the full pool when everyone is marked unavailable,
  // so reaching here means the pool is structurally empty (e.g. a whole branch blanked in the
  // roster sheet) or the chosen rep has no phone — the lead is in Lark owned by NOBODY, and the SLA
  // sweep skips rows with an empty Salesman, so nothing will ever chase it. Say so, loudly.
  mark('no_rep', '');
  return null;
}

// A (2026-07-24): LLM intent classification — regex keyword lists kept missing real Malay sell
// phrasings ("mau tolak moto masih ada loan" got the buying-loan template). gpt-4o (injected
// D.aiClassify) decides the category; regex classify() is the instant fallback on API
// error/timeout/garbage output, and still fully handles image-only messages (nothing for the LLM
// to read) + vendor auto-replies (cheap and certain). An image WITH a short caption keeps the
// regex verdict when the LLM says greeting/skip — the image carries intent the LLM can't see.
const AI_CATS = new Set(['sell', 'loan', 'testride', 'product', 'admin', 'greeting', 'skip']);
async function classifySmart(text, hasImage){
  const rx = classify(text, hasImage);
  const t = String(text || '').trim();
  if (!D.aiClassify || !t || RE_VENDOR_AUTO.test(t)) return rx;
  try {
    const cat = await D.aiClassify(t);
    if (cat && AI_CATS.has(cat)){
      if (hasImage && (cat === 'greeting' || cat === 'skip')) return rx;
      // The LLM may UPGRADE something to `sell` (it reads Malay phrasings RE_SELL will never
      // cover) but it may not DOWNGRADE a regex `sell`. RE_SELL only fires on an explicit
      // "I want to sell/trade-in MY bike", and it already strips the "kedai ada jual X?"
      // shop-sells trap before testing — when it says sell, it is sure. The LLM is not:
      // 16 Aug "Cbr650r / Mt25 / Trade in mt25" → it chose `product` (the model names won)
      // 17 Aug "hi boss nk tnye ... boleh trade in" → it chose `greeting` (the hello won)
      // Both would have gone to a salesperson instead of Fitri the purchaser, so TM simply
      // does not buy the bike. Asymmetric cost: a wrong `sell` costs one redirect; a missed
      // one costs the trade-in.
      if (rx.cat === 'sell' && cat !== 'sell'){
        D.log(`FR 🛡 kept regex sell over ai ${cat}: "${t.slice(0, 60)}"`);
        return rx;
      }
      if (cat !== rx.cat) D.log(`FR 🧠 ai overrides regex ${rx.cat}→${cat}: "${t.slice(0, 60)}"`);
      return { cat, imageOnly: false };
    }
    if (cat != null) D.log('FR aiClassify unusable → regex fallback:', String(cat).slice(0, 20));
  } catch (e) { D.log('FR aiClassify err → regex fallback:', String(e.message || e).slice(0, 60)); }
  return rx;
}

// ---------- flow ----------
// 🐛→✅ 2026-07-28: customers arriving via a "click to chat" link get a @lid privacy JID as
// remoteJid (WhatsApp's newer addressing mode) instead of the normal <phone>@s.whatsapp.net.
// State (buffers/pending/greeted/humanTouched) still keys off the raw jid — markHuman() sees the
// same @lid for a human's outbound reply in that chat, so that matching stays consistent. But
// WaSenderAPI's /send-message can't deliver to a @lid address — it silently no-ops, so the bot
// classified + assigned the lead correctly but the customer never got a reply. Resolve the actual
// SEND target to the real phone (captured in b.phone from cleanedSenderPn/senderPn) whenever the
// jid is a @lid — never touches normal contacts.
// ---------- Phone gate (2026-08-03) ----------
// WhatsApp's username / hide-my-number rollout means a growing share of TM's leads arrive with
// NO phone at all — 14% of chats as of 2026-08-04, by far the highest of any client. Those leads
// were still assigned, handing the salesperson a lead they cannot ring (the Lark row now honestly
// says so, but they still cannot call).
// So: when there is no number, answer the customer's question as normal, ask for a number, and
// HOLD the assignment. Assign the moment it arrives, or after GATE_MS regardless — nobody is left
// waiting on a privacy setting. Ported from the Python bots (metalage/koonken/founder-solar).
// Durable gate event log. D.log() alone was not enough: Render rotates logs every few hours, so a
// resolved gated lead became unreviewable almost immediately — and TM produces more of them than
// any other client (14% of chats). Written as JSONL to the persistent disk so the outcome of every
// held lead can be read back days later. Best-effort: monitoring must never break a lead.
const GATE_LOG_FILE = process.env.GATE_LOG_FILE
  || (process.env.FR_STATE_FILE ? path.join(path.dirname(process.env.FR_STATE_FILE), 'gate_events.jsonl')
                                : path.join(__dirname, 'gate_events.jsonl'));

function gateLogEvent(kind, jid, fields){
  const rec = Object.assign({ ts: Math.floor(Date.now() / 1000), kind, chat_id: jid }, fields || {});
  try { fs.appendFileSync(GATE_LOG_FILE, JSON.stringify(rec) + '\n'); }
  catch(e){ D.log && D.log('FR gate log write failed:', String(e.message||e).slice(0,50)); }
}

function gateReadEvents(limit){
  try {
    const lines = fs.readFileSync(GATE_LOG_FILE, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-(limit || 200)).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

// ---------- Decision log (2026-08-14) ----------
// The client's question is "how many leads today, how many assigned, and WHY not the rest".
// Nothing could answer it: Render rotates logs in hours, and Lark only records the leads that
// SUCCEEDED — a chat the bot decided to skip, hold, or hand to a human leaves no row at all, so
// "why not" was unanswerable by construction. One durable JSONL line per DECISION fixes that.
// Same derivation as the gate log, so it lands on /data in prod with no extra env var.
const FR_EVENTS_FILE = process.env.FR_EVENTS_FILE
  || (process.env.FR_STATE_FILE ? path.join(path.dirname(process.env.FR_STATE_FILE), 'fr_events.jsonl')
                                : path.join(__dirname, 'fr_events.jsonl'));

// 🚨 BEST-EFFORT, ALWAYS. Monitoring must never break a lead — a full disk or a bad permission
// costs a log line, never a customer. Mirrors gateLogEvent byte-for-byte on purpose.
function frLogEvent(outcome, jid, fields){
  const rec = Object.assign({ ts: Math.floor(Date.now() / 1000), jid, outcome }, fields || {});
  try { fs.appendFileSync(FR_EVENTS_FILE, JSON.stringify(rec) + '\n'); }
  catch(e){ D.log && D.log('FR event log write failed:', String(e.message||e).slice(0,50)); }
}

function readFrEvents(limit){
  try {
    const lines = fs.readFileSync(FR_EVENTS_FILE, 'utf8').trim().split('\n').filter(Boolean);
    return { ok: true, text: (limit ? lines.slice(-limit) : lines).join('\n') };
  } catch(e){
    // 🚨 ENOENT means two OPPOSITE things and they must not be conflated (caught 2026-08-14 by
    // running the endpoint against a bad path — it answered "0 leads" with total confidence):
    //   • the FILE is missing but its directory is fine → a fresh disk, no lead decided yet.
    //     Legitimately empty. Report 0.
    //   • the DIRECTORY is missing/unreadable → the Render disk is not mounted, or FR_EVENTS_FILE
    //     has a typo. Reporting "0 leads today" then is the exact lie this module exists to stop.
    if (e && e.code === 'ENOENT'){
      const dir = path.dirname(FR_EVENTS_FILE);
      try { fs.accessSync(dir); return { ok: true, text: '' }; }
      catch { return { ok: false, error: `decision-log directory is unreadable (${dir})`, text: '' }; }
    }
    return { ok: false, error: String(e.message || e).slice(0, 120), text: '' };
  }
}

const GATE_MS = Number(process.env.FR_GATE_MS || 60 * 60 * 1000);
const GATE_MAX_ASKS = 2;

// A WhatsApp privacy id is 13-15 digits; a dialable number here is 10-12. Keeping the ranges
// disjoint is what stops a LID being stored as a phone, and stops a phone-length guard dropping
// a privacy customer. Both failures happened in the same week (2026-08-02).
function gateParsePhone(text, knownLid){
  const t = String(text || '');
  // 🚨 MALAY REDUPLICATION: a trailing `2` is a SUFFIX, not a digit. `ok2` = okok, `dekat2` =
  // dekat-dekat, `jalan2` = jalan-jalan, `ada2` = ada-ada. The old pattern could START a candidate
  // at ANY digit, so the reduplication marker welded itself onto the number that followed it:
  //   "V1 ada dekat kedai? Nk dtg tgk dekat2 \n 0137939637"  ->  20137939637
  // A number that does not exist. The rep DM failed HTTP 422, was given up after one attempt, and
  // the customer chased us 32h later: "Hi. Xde org contact sy pon" (166013404463117@lid, 20 Aug).
  // A digit welded to a word is never the start of a phone number — hence the lookbehind. This is
  // NOT TM-specific: every Malay-language bot buffers messages and joins them, so every one of
  // them can weld a reduplication marker onto the next number.
  // ⚠️ The lookbehind bars a LETTER **and a DIGIT** before the candidate, so a match can only begin
  // at a real token boundary. Letter-only was not enough: `Z900 0123456789` skipped the `9` (letter
  // before it) but then happily started at the `0` of `900`, swallowed `00 0123456789`, failed
  // every length rule — and because `match` had already consumed those characters the REAL number
  // was never even looked at. The customer had given their number and the bot kept asking for it.
  const cands = t.match(/(?<![A-Za-z0-9])\+?\d[\d\s\-().]{7,20}\d/g) || [];
  for (const raw0 of cands){
    // No real number opens with a LONE digit followed by a separator ("nak 2 0137939637"). The
    // shortest legitimate opening group is two digits (`60 12-345 6789`) or three (`012 345 6789`),
    // so a single digit standing by itself is somebody's quantity, not part of the number.
    const raw = raw0.replace(/^\+?\d(?=[\s\-().]+\d)/, '');
    const d = raw.replace(/\D/g, '');
    if (!d) continue;
    if (knownLid && (d === knownLid || knownLid.includes(d) || d.includes(knownLid))) continue;
    let n = '';
    if (d.startsWith('60'))      n = (d.length >= 11 && d.length <= 12) ? d : '';
    else if (d.startsWith('0'))  { const r = d.slice(1); n = (r.length >= 9 && r.length <= 10) ? '60' + r : ''; }
    else if (d.startsWith('1') && d.length >= 9 && d.length <= 10) n = '60' + d;
    else if (d.length >= 10 && d.length <= 12) n = d;
    if (n) return n;
  }
  return '';
}

// Being asked for a number cold reads as a scam, and Malaysians say so bluntly. Answering with the
// real cause converts better than repeating the request — so this REPLACES the re-ask.
const RE_GATE_WHY = /(why|what.{0,6}for|privacy|private|scam|spam|penipu|tipu|kenapa|knp|napa|mengapa|untuk\s+apa|utk\s+apa|buat\s+apa|tak\s+nak|xnak|tak\s+mahu|为什么|為什麼|为何|干嘛|不方便)/i;
// Real customer reply seen 2026-08-04 (Natalie Wong, KoonKen): "U can find my username to contact
// me". They ARE cooperating — just with the new WhatsApp handle instead of a number. The webhook
// carries no username field (verified: senderPn/cleanedSenderPn empty, addressingMode=lid), so we
// have to ask them to type it, then hand THAT to the salesperson.
const RE_GATE_USERNAME = /\busername\b|\bhandle\b|\bnama\s+pengguna\b|@[a-z0-9_.]{3,}/i;

// Benjamin, 2026-08-04: a username COUNTS as contact info — either identifier releases the hold.
// Precision beats recall, because a junk handle on a Lark row is worse than a blank one: the rep
// acts on it. So an '@' or an explicit "username is …" is required, and a BARE one-word reply is
// only trusted after we asked them to type one (gateAskedUsername) — otherwise "zontes" would be
// filed as somebody's handle. Mirrors phone_gate.parse_username in the Python bots.
const RE_AT_HANDLE = /(?<![A-Za-z0-9._%+-])@([A-Za-z0-9._]{3,30})/;
const RE_USERNAME_KV = /(?:user\s?name|handle|nama\s+pengguna|用户名|用戶名)\s*(?:is|ialah|adalah|=|:|：|是|-|—)\s*@?([A-Za-z0-9._]{3,30})/i;
const RE_BARE_HANDLE = /^[A-Za-z0-9._]{3,30}$/;
const RE_DOMAINISH = /\.(com|net|org|my|co|io|me|gov|edu)$/i;
const NOT_A_USERNAME = new Set([
  'yes','yeah','yep','no','nope','ok','okay','okey','sure','thanks','thank','tq','tqvm',
  'hi','hello','hey','ya','yaa','lah','please','pls','sorry','username','user','handle',
  'phone','number','contact','call','whatsapp','wasap','boleh','saya','nak','tak','takde',
  'ada','apa','kenapa','later','nanti','wait','sekejap','none','moto','motor','harga','loan',
]);

function cleanUsername(raw){
  const u = String(raw || '').trim().replace(/^[.,!?;:]+|[.,!?;:]+$/g, '').toLowerCase();
  if (u.length < 3 || u.length > 30) return '';
  if (NOT_A_USERNAME.has(u) || RE_DOMAINISH.test(u)) return '';
  if (!/[a-z]/.test(u)) return '';                    // all digits = a phone, not a handle
  if (!/^[a-z0-9._]+$/.test(u)) return '';
  return u;
}

function gateParseUsername(text, expectUsername){
  const t = String(text || '').trim();
  if (!t) return '';
  for (const rx of [RE_AT_HANDLE, RE_USERNAME_KV]){
    const m = t.match(rx);
    if (m){ const u = cleanUsername(m[1]); if (u) return u; }
  }
  if (expectUsername){
    const bare = t.replace(/^[.,!?;:]+|[.,!?;:]+$/g, '');
    if (RE_BARE_HANDLE.test(bare)) return cleanUsername(bare);
  }
  return '';
}

// ONE ask, either identifier accepted (Benjamin, 2026-08-04). Offering both lets the customer
// pick what they're comfortable with instead of refusing outright. Naming the '@' is deliberate:
// it is what makes a handle safe to parse back out of a free-text reply.
const gateAsk = lang => lang === 'en'
  ? `One thing ya, WhatsApp hasn't shared your contact details with us, so our sales advisor has no way to reach you back. 🙏 Could you reply with your phone number, or your WhatsApp username (the one starting with @)?`
  : `Satu je bos, WhatsApp tak share contact tuan dengan kami, jadi sales advisor kami tak boleh contact balik. 🙏 Boleh reply nombor telefon tuan, atau username WhatsApp tuan (yang start dengan @)?`;
const gateWhy = lang => lang === 'en'
  ? `Good question 🙂 WhatsApp recently added a username / hide-my-number setting. When it's on, your number isn't shared with the business you message, so our advisor can see your message but can't call you back.\n\nWe'd only use it to follow up on this enquiry. If you'd rather not share it, no problem at all, just reply here and we'll continue in this chat 👍`
  : `Soalan bagus 🙂 WhatsApp baru tambah setting username / sorok nombor. Bila on, nombor tuan tak dishare dengan bisnes yang tuan mesej, jadi advisor kami nampak mesej tuan tapi tak boleh call balik.\n\nNombor tu untuk follow up ni je. Kalau tuan tak selesa nak bagi pun takpe, reply je kat sini, kami sambung dalam chat ni 👍`;
const gateUsername = lang => lang === 'en'
  ? `Ah, WhatsApp doesn't show us your username either, so could you type it here? Our advisor will use it to reach you 🙏`
  : `Ah, WhatsApp tak tunjuk username tuan kat kami juga, jadi boleh taip kat sini? Advisor kami guna untuk contact tuan ya 🙏`;
const gateGot = lang => lang === 'en'
  ? `Got it, thank you! 🙏 Passing this to our sales advisor now.`
  : `Ok, terima kasih bos! 🙏 Saya pass kat sales advisor kami sekarang.`;
// Deliberately promises a follow-up IN THIS CHAT, never a call back — a handle is not dialable in
// Malaysia until WhatsApp's rollout lands (~Sept 2026), and not at all if they set a username key.
const gateGotUser = lang => lang === 'en'
  ? `Got it, thank you! 🙏 Passing your username to our sales advisor, they'll follow up with you right here in this chat.`
  : `Ok, terima kasih bos! 🙏 Saya pass username tuan kat sales advisor, dia akan follow up terus dalam chat ni.`;

// `opts.recordId` = this lead ALREADY has a Lark row (it was parked by the off-hours qualify flow).
// `opts.fromQualify` clamps the re-ask budget so the evening total stays within the 3-message cap.
function gateHold(jid, cat, want, lang, opts){
  const o = opts || {};
  state.awaitingPhone = state.awaitingPhone || {};
  state.awaitingPhone[jid] = { ts: Date.now(), asks: 1, cat, want, lang,
    recordId: o.recordId || null, fromQualify: !!o.fromQualify };
  persist();
  D.log(`FR ⏳ HELD for phone — ${cat} (${jid.slice(0, 22)}) "${String(want).slice(0, 40)}"`);
  gateLogEvent('held', jid, { cat, first_message: String(want).slice(0, 120) });
  // Held is a real, reportable state: the customer asked, we answered, and nobody can act on it
  // yet. Superseded by the release's assigned/parked/no_rep (the summary keeps the LATEST event
  // per jid), so a lead that resolves is never double-counted.
  frLogEvent('gate_held', jid, { has_phone: false, cat, phone: '', want: String(want).slice(0, 120), recordId: null });
}

// Release a held lead: assign for real, then tell the customer who has them.
async function gateRelease(jid, h, phone, reason){
  delete (state.awaitingPhone || {})[jid]; persist();
  const ctx = { gated: true };
  // A handle the customer TYPED comes in on h.username. If they gave us nothing at all, ask
  // WhatsApp for theirs — measured 2026-08-29 across the fleet, 68 of 69 leads released with no
  // contact detail have one. Done HERE and not at hold time so it costs nothing on the message
  // path and only ever fires for a lead that is genuinely about to go out uncontactable.
  //
  // 🚨 The lookup is the SAME WhatsApp call that resolves a number, so it can find no phone we
  // have not already tried. It is not a second chance at a number; it is a different field.
  ctx.username = h.username || '';
  if (!phone && !ctx.username && D.fetchUsername){
    try { ctx.username = (await D.fetchUsername(jid)) || ''; }
    catch(e){ D.log('FR username lookup err:', String(e.message||e).slice(0,60)); }
    if (ctx.username) D.log(`FR 👤 no phone — WhatsApp handle @${ctx.username} found by lookup (${jid.slice(0,22)})`);
  }
  // 🚨 TWO SALESPEOPLE, ONE ENQUIRY — the defect this branch exists to prevent. The off-hours
  // qualify flow ALREADY wrote a Lark row and queued the staff half on the customer's first
  // message. Calling assign() again here would create a SECOND row for the same person, put it in
  // the round-robin a second time, and have two reps ring them about the same bike. So when the
  // hold carries a recordId, patch the number onto the row that exists and assign NOTHING.
  let card = null;
  if (h.recordId){
    try { if (D.larkPatchPhone && phone) await D.larkPatchPhone(h.recordId, phone); }
    catch(e){ D.log('FR lark patch-phone err:', String(e.message||e).slice(0,60)); }
    ctx.outcome = 'parked'; ctx.assignee = ''; ctx.recordId = h.recordId;
    D.log(`FR 🔗 gate released onto the EXISTING parked row (${jid.slice(0,22)}) rec=${h.recordId}${phone ? ' +' + phone : ''}`);
  } else {
    card = await assign(h.cat, jid, phone || '', h.want, ctx);
  }
  const nextLabel = (D.inDistHours && !D.inDistHours() && D.nextWindowLabel) ? (D.nextWindowLabel() || null) : null;
  try { await D.waSend(sendTarget(jid, phone), tpl(h.cat, h.lang, card, '', nextLabel)); }
  catch(e){ D.log('FR gate release send err:', String(e.message||e).slice(0,60)); }
  D.log(`FR ✅ gate released (${reason}) — ${h.cat} ${phone ? '+' + phone : 'NO PHONE'} (${jid.slice(0,22)})`
    + (ctx.outcome && ctx.outcome !== 'assigned' ? ` [${ctx.outcome}]` : ''));
  if (ctx.outcome === 'no_rep') D.log(`FR 🚨 NO SALESPERSON took the released lead (${jid.slice(0,22)}) — Lark row has no owner`);
  // The lead's real outcome. Logged HERE and not inside assign(), so a gate release produces
  // exactly one decision event rather than one from each layer.
  frLogEvent(ctx.outcome || 'assigned', jid, {
    has_phone: !!phone, cat: h.cat, assignee: ctx.assignee || (card && card.name) || '',
    phone: phone || '', want: String(h.want || '').slice(0, 120), recordId: ctx.recordId || null,
    asks: h.asks || 0, note: 'gate_' + reason });
  gateLogEvent(reason === 'timeout' ? 'timeout' : 'assigned', jid, {
    cat: h.cat, phone: phone || '', reason,
    salesperson: (card && card.name) || ctx.assignee || '',
    // 'assigned' = a rep holds it now · 'parked' = queued for the next assignment window, a rep gets
    // it at 9am · 'no_rep' = nobody took it, needs a human. An empty salesperson used to cover all
    // three, so a routine park and a total failure read identically in /gate-status.
    assign_state: ctx.outcome || 'assigned',
    username: ctx.username || '',
    held_seconds: Math.round((Date.now() - (h.ts || Date.now())) / 1000) });
}

// Called by the morning drain in index.js when a lead that was parked overnight finally reaches a
// rep. Without it the gate log's story for that customer stops at the park with no name, and the
// only way to learn who ended up with them is to open Lark by hand (2026-08-06, Ariff/@mat.arip).
function gateLogParked(jid, fields){
  if (!jid) return;
  gateLogEvent('assigned_after_park', jid, fields || {});
}

// Handle a reply from a held chat. Returns true if the gate consumed the message.
async function gateOnReply(jid, h, text, bphone){
  const lid = jid.includes('@lid') ? jid.split('@')[0] : '';
  const phone = gateParsePhone(text, lid);
  if (phone){
    gateLogEvent('phone_received', jid, { phone,
      waited_seconds: Math.round((Date.now() - (h.ts || Date.now())) / 1000) });
    try { await D.waSend(sendTarget(jid, phone), gateGot(h.lang)); } catch {}
    await gateRelease(jid, h, phone, 'customer gave it');
    return true;
  }
  // A typed username releases the hold too — either identifier is enough (Benjamin, 2026-08-04).
  // It goes onto the lead as a labelled handle, NEVER into the phone field: `larkWriteLead` would
  // happily store it, and a rep dialling a handle is the exact failure this gate exists to stop.
  const username = gateParseUsername(text, !!h.askedUsername);
  if (username){
    try { await D.waSend(sendTarget(jid, bphone), gateGotUser(h.lang)); } catch {}
    await gateRelease(jid, { ...h, username,
                             want: `@${username} (username, not dialable) · ${h.want}` },
                      '', 'customer gave username');
    return true;
  }
  // ⚠️ TOUCH CAP. A qualify-born hold has already used ① the answer+qualifyAsk and ② the gate ask,
  // so it gets NO re-ask — otherwise an evening customer could receive four ask-type messages.
  const maxAsks = h.fromQualify ? 1 : GATE_MAX_ASKS;
  if (h.asks < maxAsks){
    // A username offer and a "why" both deserve a real answer, not the same request again.
    const offered = RE_GATE_USERNAME.test(text);
    const body = offered                   ? gateUsername(h.lang)
               : RE_GATE_WHY.test(text)    ? gateWhy(h.lang)
               : gateAsk(h.lang);
    h.asks += 1;
    h.note = offered ? 'offered username' : undefined;
    // Set only when we actually asked them to type one — this is what makes a bare one-word
    // reply ("Nataliewpe") safe to read as a handle on the next message, and nothing else.
    h.askedUsername = offered;
    state.awaitingPhone[jid] = h; persist();
    try { await D.waSend(sendTarget(jid, bphone), body); } catch {}
    D.log(`FR gate re-ask ${h.asks} (${jid.slice(0,22)}) — "${String(text).slice(0,40)}"`);
    gateLogEvent(RE_GATE_USERNAME.test(text) ? 'asked_username'
               : RE_GATE_WHY.test(text) ? 'explained_why' : 're_asked', jid,
      { ask_number: h.asks, customer_said: String(text).slice(0, 120) });
  } else {
    D.log(`FR gate quiet — already asked ${h.asks}× (${jid.slice(0,22)})`);
    gateLogEvent('no_reply_usable', jid, { customer_said: String(text).slice(0, 120) });
  }
  return true;
}

// Called on the 60s tick from index.js. Nobody is abandoned over a privacy setting.
async function gateSweep(){
  const held = state.awaitingPhone || {};
  const now = Date.now();
  for (const jid of Object.keys(held)){
    const h = held[jid];
    // A missing timestamp means an older/partial write — treat as expired rather than skipping,
    // so a lead can never be stranded in a hold nobody releases.
    if (h && h.ts && now - h.ts < GATE_MS) continue;
    if (humanTouched.has(jid)){          // a human already owns this chat — don't double-handle
      delete held[jid]; delete state.qualify[jid]; persist();
      D.log(`FR gate dropped — human took over (${jid.slice(0,22)})`);
      // This is a REAL ending, so it must be logged as one. Without the event the hold simply
      // vanishes: /gate-status shows nothing held and no outcome, so the lead reads as stuck
      // forever and gets flagged for a human who has, in fact, already handled it. Observed
      // 2026-08-05 — 2 of TM's first 4 gated leads ended this way (TM staff watch that inbox),
      // so it is normal operation, not an edge case, and it was silently breaking the count.
      gateLogEvent('human_takeover', jid, {
        cat: h && h.cat, reason: 'human replied during the hold',
        held_seconds: Math.round((now - ((h && h.ts) || now)) / 1000) });
      frLogEvent('human_owned', jid, { has_phone: false, cat: (h && h.cat) || '', phone: '',
        want: String((h && h.want) || '').slice(0, 120), recordId: null, note: 'gate_human_takeover' });
      continue;
    }
    try { await gateRelease(jid, h || { cat: 'product', want: 'WhatsApp direct inquiry', lang: 'bm' }, '', 'timeout'); }
    catch(e){ D.log('FR gate sweep err:', String(e.message||e).slice(0,60)); }
  }
}

// ---------- ADMIN hand-off (2026-08-28) ----------------------------------------------------------
// Agreed with TM in the project group on 27 Aug, in their words:
//   "kalau insurance tukar nama all admin" · "if parts and labour costs workshop"
//   "Takut if the bot answer it will be wrong"
// So the bot NEVER answers these — it hands over and says so. Benjamin 2026-08-28: no Lark row and
// no SLA clock for admin (it is not a sales lead), and the customer is told BOTH that admin will
// contact them AND the number they can use themselves.
//
// 🚨 `workshop` is deliberately NOT a category yet. TM named it but never sent a contact, and routing
// to a destination that does not exist is worse than leaving those enquiries where they are. Add the
// category and the number in the SAME change, never one without the other.
//
// WHY THIS EXISTS AT ALL (2026-08-21, +601127171062): "Nk tnye berapa kos nk tukar nama motor sikal
// ye tuan" — a plain, readable question. The regex had no rule for it and the LLM had no category to
// put it in, so it landed in `skip`, which is the one branch that returns without a reply, without a
// Lark row and without telling anybody. Measured before the fix: 7/12 skip, 5/12 product on the exact
// same text at temperature 0 — a coin flip. After: admin 12/12. The customer waited 7 days.
const ADMIN_PHONE   = (process.env.TM_ADMIN_PHONE   || '601116661324').replace(/\D/g, '');
const ADMIN_DISPLAY = process.env.TM_ADMIN_DISPLAY  || '+60 11-1666 1324';
// One hand-off per chat per day: the 10s debounce already merges a burst, this stops a customer who
// comes back tomorrow from being answered twice while still letting a genuinely new question through
// (the 7-day re-greet guard would otherwise swallow it — that guard is for SALES touches).
const ADMIN_COOLDOWN_MS = Number(process.env.TM_ADMIN_COOLDOWN_MS || 24 * 3600 * 1000);

const adminAck = (lang) => (lang === 'en'
  ? `Thank you! \u{1F64F} Ownership transfer / insurance / roadtax is handled by our admin team. `
    + `Admin will contact you.\n\nOr you can WhatsApp our admin directly:\n`
    + `\u{1F4F1} ${ADMIN_DISPLAY}\n\u{1F517} https://wa.me/${ADMIN_PHONE}`
  : `Terima kasih tuan! \u{1F64F} Untuk tukar nama / insurance / roadtax, admin kami yang uruskan ya. `
    + `Admin akan contact tuan.\n\nAtau tuan boleh terus WhatsApp admin kami:\n`
    + `\u{1F4F1} ${ADMIN_DISPLAY}\n\u{1F517} https://wa.me/${ADMIN_PHONE}`);

// What admin receives. Verbatim question + an openable link, because a summary is not something a
// human can act on. ⚠️ Obeys the same no-dash rule as every other bot send (see firstresponse_test).
function adminNote(phone, text){
  const who  = phone ? '+' + phone : '\u26a0\ufe0f number hidden by WhatsApp';
  const link = phone ? `\n\u{1F517} https://wa.me/${phone}`
                     : '\n_No number. Please reply inside the TM WhatsApp inbox._';
  const myt  = new Date(Date.now() + 8 * 3600e3).toISOString().slice(11, 16);
  return `\u{1F4CB} *Admin enquiry · TM Motoworld*\n\n`
       + `\u{1F464} ${who}\n`
       + `\u{1F4AC} "${String(text || '').replace(/\n/g, ' ').slice(0, 200)}"\n`
       + `\u{1F550} ${myt} MYT${link}\n\n`
       + `_The bot did NOT answer this. It only told the customer that admin will contact them, and gave them this number._`;
}

const sendTarget = (jid, phone) => (jid && jid.includes('@lid') && phone) ? (phone + '@s.whatsapp.net') : jid;
const VAGUE = t => !t || t.trim().length < 4 || classify(t, false).cat === 'greeting';
// ⚠️ VAGUE() answers "is this a lead we can route?" — a DIFFERENT question from "did they answer
// the thing we just asked?". Using it for the second is the 2026-08-21 defect: it has no `cash`
// rule and no model outside RE_BIKE, so "Cash" and "Trk502" both read as silence and the identical
// question went out again. Inside the qualify flow the customer is replying TO US, so a payment
// mode, a model-shaped token, or a photo all count as a real answer.
const qualifyVague = (t, hasImage) =>
  !hasImage && !RE_PAYMODE.test(String(t || '')) && !RE_BIKE.test(String(t || ''))
  && !RE_MODELISH.test(String(t || '')) && VAGUE(t);
async function flush(jid){
  const b = buffers[jid]; delete buffers[jid];
  if (!b) return;
  const text = b.texts.join(' \n ').trim();
  const now = Date.now();

  // Phone gate: this chat is already held waiting for a number. Must run BEFORE the 7-day
  // re-greet guard below, which would otherwise return early and swallow their answer.
  const heldEntry = (state.awaitingPhone || {})[jid];
  if (heldEntry){ await gateOnReply(jid, heldEntry, text, b.phone); return; }

  const q = state.qualify[jid];
  let { cat, imageOnly } = await classifySmart(text, b.hasImage);
  const lang = isEnglish(text) ? 'en' : 'bm';
  // Outside the DISTRIBUTION window nobody is assigned right now, so the reply must commit to a
  // day instead of announcing a closure. null while the window is open (a rep gets it immediately).
  const nextLabel = (D.inDistHours && !D.inDistHours() && D.nextWindowLabel) ? (D.nextWindowLabel() || null) : null;

  if (q && now - q.ts < PENDING_MODEL_MS){
    // ── They answered something we asked for ──────────────────────────────────────────────────
    // phase 'detail' = the off-hours qualification (model + cash/loan), lead ALREADY parked.
    // phase 'model'  = the in-window greeting flow, nothing written yet.
    const vague = VAGUE(text) && !b.hasImage;

    if (q.phase === 'detail'){
      // 🚨 The lead is already in Lark and already queued for the drain. NOTHING here may create a
      // second row or a second queue entry — the answer only ENRICHES what exists.
      // The customer is answering OUR question here, so the reply is scored by qualifyVague, not
      // by the routing-grade VAGUE. See the comment on qualifyVague.
      const qVague = qualifyVague(text, b.hasImage);
      if (qVague && (q.asks || 1) < QUALIFY_MAX_ASKS){
        q.asks = (q.asks || 1) + 1; q.ts = now; state.qualify[jid] = q; persist();
        await D.waSend(sendTarget(jid, b.phone), qualifyAsk(q.lang || lang, !!q.modelKnown, false));
        return;
      }
      if (qVague){ delete state.qualify[jid]; persist(); return; }   // asked twice, go quiet. Queue untouched.
      const qualified = `${q.want || ''} | qualified: ${text}`.slice(0, 200);
      try { if (D.larkPatchWant && q.recordId) await D.larkPatchWant(q.recordId, qualified); }
      catch(e){ D.log('FR lark patch-want err:', String(e.message||e).slice(0,60)); }
      frLogEvent('qualified', jid, { has_phone: !!b.phone, cat: q.cat || cat, phone: b.phone || '',
        want: qualified.slice(0, 120), recordId: q.recordId || null, note: 'off_hours_qualify' });
      delete state.qualify[jid]; persist();
      if (b.phone){
        await D.waSend(sendTarget(jid, b.phone), nextLabel ? closingLine(lang, nextLabel)
          : tpl(q.cat || cat, lang, null, '', null));
        return;
      }
      // ⚠️ ORDERING: the phone gate is LAST, and only AFTER a real answer. Never model + phone +
      // username stacked into one evening. This is ask #3, the cap.
      gateHold(jid, q.cat || cat, qualified, lang, { recordId: q.recordId || null, fromQualify: true });
      await D.waSend(sendTarget(jid, b.phone), gateAsk(lang));
      return;
    }

    // ── phase 'model': the original greeting flow, unchanged in-window ────────────────────────
    delete state.qualify[jid]; persist();
    const finalCat = (cat === 'sell' || cat === 'loan' || cat === 'testride') ? cat : 'product';
    const want = vague ? '[ad click, model belum stated, sila probe]' : (text || '[gambar/screenshot iklan]');
    const stockLine = await stockLineFor(finalCat, text, lang);
    if (!b.phone){
      // No number at all — answer them, then ask, and hold the assignment. tpl() with card=null
      // reads naturally ("our sales advisor will contact you shortly") without naming anyone.
      gateHold(jid, finalCat, want, lang);
      await D.waSend(sendTarget(jid, b.phone), tpl(finalCat, lang, null, stockLine, null));
      await D.waSend(sendTarget(jid, b.phone), gateAsk(lang));
      return;
    }
    const ctx = {};
    const card = await assign(finalCat, jid, b.phone, want, ctx);
    frLogEvent(ctx.outcome || 'assigned', jid, { has_phone: !!b.phone, cat: finalCat,
      assignee: ctx.assignee || '', phone: b.phone || '', want: String(want).slice(0, 120),
      recordId: ctx.recordId || null });
    await D.waSend(sendTarget(jid, b.phone), tpl(finalCat, lang, card, stockLine, nextLabel));
    return;
  }
  // ── ADMIN hand-off — paperwork, not a sale. Sits BEFORE the skip branch (this is exactly what
  // used to fall into skip) and BEFORE the 7-day re-greet guard, because a customer who was greeted
  // about a bike last week and now asks about tukar nama is a NEW question that must still reach a
  // human. Its own 24h cooldown replaces that guard rather than bypassing it.
  if (cat === 'admin'){
    state.adminNotified = state.adminNotified || {};
    const last = state.adminNotified[jid] || 0;
    if (now - last < ADMIN_COOLDOWN_MS){
      frLogEvent('admin_handoff', jid, { has_phone: !!b.phone, cat: 'admin', phone: b.phone || '',
        want: String(text).slice(0, 120), recordId: null, note: 'duplicate_within_24h' });
      return;
    }
    state.adminNotified[jid] = now;
    persist();

    // 1) The customer. A hand-off line only — never an answer (TM: "takut if the bot answer it will be wrong").
    try { await D.waSend(sendTarget(jid, b.phone), adminAck(lang)); }
    catch(e){ D.log('FR admin ack send err:', String(e.message||e).slice(0, 60)); }

    // 2) Admin. If THIS fails the customer has been promised a call nobody knows about, so it must be
    //    loud — waSend already pages the review group after its retries, and we log the phone so the
    //    hand-off can be redone by hand from the log alone.
    let delivered = false;
    if (ADMIN_PHONE){
      try {
        const mid = await D.waSend(ADMIN_PHONE + '@s.whatsapp.net', adminNote(b.phone, text));
        delivered = !!mid;
      } catch(e){ D.log('FR admin notify err:', String(e.message||e).slice(0, 60)); }
    }
    if (!delivered){
      D.log(`FR 🚨 ADMIN HAND-OFF UNDELIVERED — customer ${b.phone ? '+' + b.phone : jid.slice(0,22)} `
          + `was told admin will contact them and admin was NOT told: "${String(text).slice(0, 80)}"`);
    }
    D.log(`FR 📋 admin hand-off ${b.phone ? '+' + b.phone : jid.slice(0,22)} -> ${ADMIN_PHONE}`
        + (delivered ? '' : ' (NOTIFY FAILED)'));
    frLogEvent('admin_handoff', jid, { has_phone: !!b.phone, cat: 'admin', phone: b.phone || '',
      want: String(text).slice(0, 120), recordId: null,
      note: delivered ? 'admin_notified' : 'admin_notify_FAILED' });
    return;
  }
  if (cat === 'skip'){
    D.log('FR skip (unclassified/vendor):', jid.slice(0, 20));
    // Not a sales lead — vendor auto-reply / OTP / unrelated long text. Reported on its own line
    // ("not sales leads"), never folded into the lead total, but logged so the inbox cross-check
    // can account for the chat instead of flagging it as a webhook we never received.
    // 🚨 Split (2026-08-15, client): `classifier_skip` covered two OPPOSITE cases. A vendor
    // auto-reply/OTP is noise nobody ever needs to see again. A message the classifier simply
    // could not read is a POSSIBLE BUYER who got no answer, and the admin must eyeball it. Same
    // bucket for counting, different note, and only the second reaches "needs a look".
    frLogEvent('ai_skip', jid, { has_phone: !!b.phone, cat: 'skip', phone: b.phone || '',
      want: String(text).slice(0, 120), recordId: null,
      note: RE_VENDOR_AUTO.test(String(text || '')) ? 'vendor_auto' : 'unclassified' });
    return;
  }
  if (state.greeted[jid] && now - state.greeted[jid] < REGREET_MS){
    // Already greeted within 7 days and this is not an answer we were waiting for, so the bot stays
    // quiet by design. Logged as `repeat` (Benjamin, 2026-08-14): excluded from every lead count,
    // and used ONLY so the inbox cross-check does not read a returning chatter as a missed webhook.
    frLogEvent('repeat', jid, { has_phone: !!b.phone, cat, phone: b.phone || '',
      want: String(text).slice(0, 120), recordId: null, note: 'already_greeted_7d' });
    return;   // one touch per 7d
  }
  state.greeted[jid] = now;

  if (cat === 'greeting'){
    // Off-window a bare "Hi" gets the FULL qualifying ask (model AND cash/loan) instead of just
    // "berminat motor apa?", because there is no rep coming until the next window and this is the
    // one chance to hand them a useful lead. In-window the original wording is unchanged.
    const offWindow = !!(nextLabel && QUALIFY_ON());
    state.qualify[jid] = { ts: now, asks: 1, phase: 'model', cat: '', want: String(text).slice(0, 120), lang, recordId: null };
    persist();
    // We asked which bike; until they answer, nobody can be assigned. Superseded by the answer's
    // own event, so this only ever shows up for customers who never replied.
    frLogEvent('awaiting_model', jid, { has_phone: !!b.phone, cat: 'greeting', phone: b.phone || '',
      want: String(text).slice(0, 120), recordId: null });
    // `false` by definition: a bare "Hi" or an ad click has named no model, so the full ask stands.
    await D.waSend(sendTarget(jid, b.phone), offWindow ? qualifyAsk(lang, false, false) : tpl('greeting', lang));
    return;
  }
  persist();
  const stockLine = await stockLineFor(cat, imageOnly ? '' : text, lang);
  const want = imageOnly ? '[gambar/screenshot iklan]' : text;

  // ── OFF-WINDOW QUALIFICATION (2026-08-16) ─────────────────────────────────────────────────────
  // 🚨 The lead is written to Lark and PARKED on this FIRST message, exactly as before — the
  // qualification is layered on top and can never delay or replace it. A customer who answers
  // nothing at all is still queued and still assigned at the next drain. Never lose a lead.
  // `sell` is excluded: its template already asks model/year/photos and routes to Fitri.
  if (nextLabel && QUALIFY_ON() && cat !== 'sell'){
    let recordId = null;
    if (b.phone){
      const ctx = {};
      await assign(cat, jid, b.phone, want, ctx);         // writes Lark + queues the staff half
      recordId = ctx.recordId || null;
      frLogEvent(ctx.outcome || 'parked', jid, { has_phone: true, cat, assignee: ctx.assignee || '',
        phone: b.phone, want: String(want).slice(0, 120), recordId });
    } else {
      // ⚠️ NO PHONE, so NO Lark row yet — the phone gate's standing rule. A row with neither a
      // number nor a salesman is a lead nobody can act on, and `larkWriteLead` with `staff:null`
      // is the shape that charged Fitri's trade-ins to Ikhwan (2026-07-30). We still qualify
      // FIRST though: the gate ask comes only after they answer, never stacked with it.
      frLogEvent('gate_held', jid, { has_phone: false, cat, phone: '',
        want: String(want).slice(0, 120), recordId: null, note: 'qualify_before_gate' });
    }
    // 🚨 The signal the code ALREADY trusts for "a bike was named": `RE_BIKE` is what routes a
    // message to `product` in classify() and what gates stockLineFor(). Deliberately not a second
    // signal invented for this — two sources of truth for one fact always drift.
    // ⚠️ Its known imprecision: RE_BIKE also matches BARE BRAND words ("ada yamaha apa2"), which
    // name a brand, not a model. See the note in CLAUDE.md — bounded, and reported rather than
    // worked around.
    const modelKnown = RE_BIKE.test(String(text || ''));
    state.qualify[jid] = { ts: now, asks: 1, phase: 'detail', cat, want: String(want).slice(0, 160),
      lang, recordId, modelKnown };
    persist();
    // ONE message: the stock answer (if any) plus the qualifying ask. No closing line yet, no
    // salesman card, and NO phone ask — that comes last, and only after they answer.
    const ask = qualifyAsk(lang, modelKnown, RE_ASKS_PAY.test(stockLine || ''));
    await D.waSend(sendTarget(jid, b.phone),
      (stockLine ? stockLine + (ask ? '\n\n' : '') : '') + ask);
    return;
  }

  if (!b.phone){
    gateHold(jid, cat, want, lang);
    await D.waSend(sendTarget(jid, b.phone), tpl(cat, lang, null, stockLine, null));
    await D.waSend(sendTarget(jid, b.phone), gateAsk(lang));
    return;
  }
  const ctx = {};
  const card = await assign(cat, jid, b.phone, want, ctx);
  frLogEvent(ctx.outcome || 'assigned', jid, { has_phone: !!b.phone, cat,
    assignee: ctx.assignee || '', phone: b.phone || '', want: String(want).slice(0, 120),
    recordId: ctx.recordId || null });
  await D.waSend(sendTarget(jid, b.phone), tpl(cat, lang, card, stockLine, nextLabel));
}

function onMessage(info){
  // info: { jid, phone, kind ('text'|'image'), text, caption }
  try {
    if (!ON()) return;
    if (!info.jid || info.jid.endsWith('@g.us')) return;
    if (D.isStaffPhone && D.isStaffPhone(info.phone)){
      // Logged, not silent — and deliberately so. The box-66 inbox cross-check has to apply the
      // SAME staff exclusion the bot applies, and the only drift-free way to do that is for the
      // bot to say which chats were staff. The alternative is a 5th copy of the roster on the VPS,
      // and roster drift has already cost TM leads four separate times. Non-lead bucket, so it
      // never touches the totals.
      frLogEvent('ai_skip', info.jid, { has_phone: !!info.phone, cat: '', phone: String(info.phone || ''),
        want: '', recordId: null, note: 'staff_or_internal' });
      return;
    }
    // A human already owns this chat — EXCEPT while we are mid-flow and waiting on the customer
    // for something we asked for. `markHuman` fires on ANY fromMe message, and the bot's OWN sends
    // echo back as fromMe, so this chat is flagged the instant the bot replies. Without the
    // exemptions below, the customer's answer is discarded before it is even buffered.
    // 🐛 2026-08-05: `state.pending` (the greeting flow) was exempt but the phone gate was not, so
    // EVERY held customer who sent their number had it thrown away and was released at timeout as
    // "never answered". Four TM customers gave a real number within ONE MINUTE of being asked
    // (014-8369971 · 01160727568 · 0169559643 · 0102360706) and two also gave a username
    // (@Keekzy77 · @hkm.hkmi) — all silently dropped. The gate reported 0/8 conversion when the
    // truth was 4/4. Any future "waiting on the customer" state MUST be added here too.
    // 🚨 EVERY "waiting on the customer" state belongs here. `state.qualify` is one (2026-08-16):
    // without it, the bot's own qualifyAsk echoes back as fromMe, flags the chat human-owned, and
    // the customer's model/cash-or-loan answer is dropped before it is even buffered — precisely
    // the 2026-08-05 failure that binned 4 of 4 real phone numbers and reported 0% conversion.
    const midFlow = state.qualify[info.jid] || (state.awaitingPhone || {})[info.jid];
    if (humanTouched.has(info.jid) && !midFlow){
      // A human owns this chat. That is a legitimate ending (TM staff watch this inbox), but it
      // used to leave no trace at all, so the day's story had a hole exactly where the bot chose
      // to do nothing. Logged every time; the summary keeps one per jid.
      frLogEvent('human_owned', info.jid, { has_phone: !!info.phone, cat: '', phone: String(info.phone || ''),
        want: String(info.text || info.caption || '').slice(0, 120), recordId: null });
      return;
    }
    // 🐛→✅ 2026-08-02 — a @lid customer with NO phone at all.
    // WhatsApp sometimes discloses no phone whatsoever for a privacy-addressed chat: the raw webhook
    // carries only `key.remoteJid` + `key.senderLid`, both the @lid, and WaSender's /api/contacts has
    // no mapping for them (4,193 of 8,491 contacts resolve, these did not). Pretending otherwise
    // caused TWO separate silent failures over the weekend, 5 real customers:
    //   1. `info.jid.split('@')[0]` used the LID DIGITS as a phone → sent to <lid>@s.whatsapp.net →
    //      HTTP 422 "JID does not exist" → customer got no reply, AND the Lark row carried a fake
    //      13-digit "phone" no salesperson could ever call.
    //   2. LIDs are 13–15 digits, so `num.length > 13` — a guard written for junk PHONE numbers —
    //      silently dropped every 14/15-digit @lid customer: no reply, no lead, no log line at all.
    // Sending to the raw @lid DOES work (proven 2026-08-02: two @lid threads where the customer
    // replied immediately after our outbound). The July "@lid silently no-ops" note is obsolete —
    // note that a send to a FABRICATED @lid still returns success:true and still gets a fromMe echo,
    // so neither of those proves delivery; only a customer replying afterwards does.
    // Rule: never invent a phone. Leave it blank and address the @lid.
    const isLid = String(info.jid).includes('@lid');
    const num = String(info.phone || '').replace(/\D/g, '')
             || (isLid ? '' : String(info.jid).split('@')[0].replace(/\D/g, ''));
    // The junk-number guards below only make sense for a REAL phone. An @lid chat with no phone is a
    // genuine customer and must never be filtered out by rules written for phone numbers.
    if (num) { if (num.startsWith('447') || num.length > 13){
      frLogEvent('ai_skip', info.jid, { has_phone: true, cat: '', phone: num, want: '', recordId: null, note: 'junk_number' });
      return;
    } }
    else if (!isLid){                              // no phone and not a @lid → nothing to work with
      // Should not happen. If it ever does we want to SEE it rather than lose the chat silently.
      frLogEvent('ai_skip', info.jid, { has_phone: false, cat: '', phone: '', want: '', recordId: null, note: 'no_identity' });
      return;
    }
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

// Boot rehydrate (2026-07-24): a Render deploy wipes fr_state.json, so the bot would re-greet
// chats it already touched. index.js rebuilds the greeted map from Lark (WhatsApp Direct leads,
// last 7d) and hands it here. Existing entries win — never overwrite live state.
function rehydrateGreeted(entries){
  let n = 0;
  for (const e of entries || []){ if (e.jid && !state.greeted[e.jid]) { state.greeted[e.jid] = e.ts || Date.now(); n++; } }
  if (n) persist();
  return n;
}

// Called by the morning drain when a parked lead finally reaches a rep. The rep owns the chat from
// that moment, so the bot must stop asking qualifying questions into it.
function clearQualify(jid){
  if (!jid) return;
  let n = 0;
  if (state.qualify[jid]){ delete state.qualify[jid]; n++; }
  if ((state.awaitingPhone || {})[jid]){ delete state.awaitingPhone[jid]; n++; }
  if (n) persist();
  return n;
}

function init(deps){ D = deps; D.log('firstresponse init — ON:', ON(), 'debounce:', DEBOUNCE_MS + 'ms'); }
module.exports = { init, onMessage, markHuman, rehydrateGreeted, gateSweep, gateReadEvents, gateLogParked, readFrEvents, clearQualify,
  gateStatus: () => Object.entries(state.awaitingPhone || {}).map(([jid, h]) => ({
    jid, cat: h.cat, asks: h.asks, note: h.note || '',
    waitingMin: Math.round((Date.now() - (h.ts || Date.now())) / 60000),
    minutesLeft: Math.max(0, Math.round((GATE_MS - (Date.now() - (h.ts || Date.now()))) / 60000)) })),
  _gateParsePhone: gateParsePhone, _classify: classify, _classifySmart: classifySmart,
  _tpl: tpl, _isEnglish: isEnglish, _state: () => state,
  _qualifyAsk: qualifyAsk, _closingLine: closingLine,
  _frLogEvent: frLogEvent, _eventsFile: () => FR_EVENTS_FILE, RE_BIKE };
