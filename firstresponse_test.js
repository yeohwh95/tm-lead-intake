// Classifier + flow tests for the first-response bot. Run: node firstresponse_test.js
process.env.FIRSTRESPONSE_ON = '1';
process.env.FR_DEBOUNCE_MS = '30';
const fs = require('fs');
try { fs.unlinkSync(__dirname + '/fr_state.json'); } catch {}
// Keep the decision log out of the repo AND out of the previous run's results — every events
// assertion below counts, so a leftover file would make them pass for the wrong reason.
process.env.FR_EVENTS_FILE = require('path').join(require('os').tmpdir(), `fr_events_test_${process.pid}.jsonl`);
try { fs.unlinkSync(process.env.FR_EVENTS_FILE); } catch {}
const fr = require('./firstresponse');

let pass = 0, fail = 0;
const ok = (cond, name) => { cond ? pass++ : (fail++, console.log('❌', name)); cond && console.log('✅', name); };

// 🚨 THE DASH RULE (Benjamin approved 2026-08-14). No em dash `—` and no standalone ` - ` in
// anything the bot SENDS. Kept: hyphens inside words / model names / phones (`012-932 3259`,
// `MT-09`, `V-Strom`, `trade-in`), the en dash `–` in hour ranges from hours.js (`9 pagi–6 petang`
// is a RANGE, not punctuation), and `•` bullets. This helper is the durable guarantee — the
// hand-written inventory of dashed lines was wrong twice (the brief said 17, a grep found 16, and
// two more turned up in gateGotUser while sweeping).
const NO_DASH = t => !/—/.test(t) && !/ - /.test(t);

// ---- classifier (real messages from the 93210 inbox, 2026-07-11..17) ----
const C = (t, img) => fr._classify(t, !!img).cat;
ok(C('Vstrom 800 re') === 'product', 'product: Vstrom 800 re');
ok(C('Z 800 Kawasaki') === 'product', 'product: Z 800 Kawasaki');
ok(C('Assalammualaikum. Hi\nTracer merah ni ada lagi ke?') === 'product', 'product: tracer ada lagi');
ok(C('Salam hai nk tnya nova 200 ad stok dak') === 'product', 'product: nova 200 stok');
ok(C('hi bole tau harga cash utk xmax?') === 'product', 'product: harga xmax');
ok(C('Hai nak tanya still available ke Mt25') === 'product', 'product: Mt25 available');
ok(C('Hi, I am interested in purchasing the KTM 390 Adv R version with cash. Is quickshifter included? What is the OTR price and waiting time?') === 'product', 'product: KTM brand word (2026-07-22 — was skip, zero reply to a real purchase inquiry)');
ok(C('ada yamaha apa2 bos') === 'product', 'product: bare Yamaha brand (90 products in catalog, had zero keyword coverage)');
ok(C('nak tengok suzuki') === 'product', 'product: bare Suzuki brand');
ok(C('kawasaki ada apa') === 'product', 'product: bare Kawasaki brand');
ok(C('bmw gs ada tak') === 'product', 'product: bare BMW brand');
ok(C('modenas dominar') === 'product', 'product: bare Modenas brand');
ok(C('royal enfield ada') === 'product', 'product: bare Royal Enfield brand');
ok(C('untuk join test ride esok bole walk in atau perlu register dlu arini?') === 'testride', 'testride: walk-in question');
ok(C('Hai moto ni boleh buat EPP?') === 'loan', 'loan: EPP');
ok(C('hi ... moda Sporter s loan harga berapa ya?') === 'loan', 'loan: loan harga');
ok(C('Nak tanya ego avantiz 2026 0 depo berapa yer bulanan') === 'loan', 'loan: 0 depo bulanan');
ok(C('hi nak tanya pembelian motor menggunakan epp kad kredit') === 'loan', 'loan: kad kredit');
ok(C('Boleh trade in kalo utang belum habis') === 'sell', 'sell: trade in');
ok(C('hi nk tanya saya nak jual motor vespa sprint 150') === 'sell', 'sell: nak jual (beats product kw)');
ok(C('Hi, saya dari website TMM dan saya mahu jual motor.') === 'sell', 'sell: mahu jual');
ok(C('Boss SYM V3i kalau mau jual ambil?') === 'sell', 'sell: mau jual (2026-07-21 Amir chat — was misclassified product/no-stock)');
ok(C('boss nak tanya moto still under loan aeon boleh jual ke dekat kedai you?') === 'sell', 'sell: boleh jual (2026-07-21 Fazwan chat — was misclassified loan)');
ok(C('Hello TMM marketing nak tanya outlet tm motorworld dekat shah alam ada jual motor keeway xdv 180 ?') === 'product', 'product: "ada jual motor X" = shop-sells question, NOT sell (2026-07-22 Keeway chat — got trade-in reply)');
ok(C('kedai jual aveta nova 250 tak bos') === 'product', 'product: "kedai jual" = shop-sells question, not sell');
ok(C('ada jual tak? saya pun nak jual motor lama saya sekali') === 'sell', 'sell: mixed message — "nak jual" survives the shop-sells strip');
ok(C('Planning to sell my forza 750 scooter') === 'sell', 'sell: ENGLISH sell intent (2026-07-23 overnight miss — routed product to Azrul)');
ok(C('Nak tanya kalau saya nk jual moto yg masih dalam loan boleh ke') === 'sell', 'sell: "nk jual moto" short-form (2026-07-23 overnight miss — routed loan to Amir)');
ok(C('do you sell cbr250?') === 'product', 'product: "do you sell X" = shop-sells question, not sell intent');
ok(C('best selling scooter ada?') === 'product', 'product: "best selling" never triggers sell');
ok(C('Hi') === 'greeting', 'greeting: Hi');
ok(C('salam') === 'greeting', 'greeting: salam');
ok(C('Hello! Can I get more info on this?') === 'greeting', 'greeting: Mudah ad-click prefill');
ok(C('', true) === 'product', 'image-only = product intent');
ok(C('35935 is your Facebook confirmation code') === 'skip', 'skip: OTP');
ok(C('Thank you for contacting ARFA WORK & DESIGN') === 'skip', 'skip: vendor auto-reply');
ok(C('Assalamualaikum semua. Mari belajar fahami makna Al-Quran m bersama kami di kelas mingguan setiap khamis') === 'skip', 'skip: long unrelated broadcast');

// ---- language detection ----
ok(fr._isEnglish('Hello! Can I get more info on this?') === true, 'lang: EN prefill');
ok(fr._isEnglish('nak tanya z800 ada ke') === false, 'lang: BM');
ok(fr._isEnglish('Hi') === false, 'lang: bare Hi defaults BM (Malaysian audience)');
ok(fr._isEnglish('hi \n nk tnya') === false, 'lang: short-form Malay (nk tnya) = BM');

// ---- templates carry the handoff + no forbidden patterns ----
const t1 = fr._tpl('product', 'bm', { name: 'Azrul', digits: '60102323259', disp: '010-2323259' });
ok(/sales advisor kami akan menghubungi/i.test(t1) && /AZRUL : 010-2323259/.test(t1) && /wa\.me\/60102323259/.test(t1), 'tpl product BM has handoff + salesperson card (Harith wording, 07-20)');
ok(!/untuk detail/i.test(fr._tpl('product', 'bm', null)), 'tpl product no raw-text echo');
ok(/berminat untuk membuat test ride/i.test(fr._tpl('testride', 'bm', { name: 'Roy', digits: '60103793259', disp: '010-3793259' })), 'tpl testride uses the standing (non-dated) reply + salesperson card');
ok(/FITRI : 010-8093259/.test(fr._tpl('sell', 'bm', { name: 'Fitri', digits: '60108093259', disp: '010-8093259' })), 'tpl sell renders Fitri card');
ok(/EPP|loan/i.test(fr._tpl('loan', 'en')), 'tpl loan EN mentions financing');
ok(/Chailease|JCL|Parkson|BSNC/.test(fr._tpl('loan', 'bm')), 'tpl loan BM lists real shop-loan financiers');
ok(/EPP CIMB tiada/i.test(fr._tpl('loan', 'bm')) && /CIMB EPP not available/i.test(fr._tpl('loan', 'en')), 'tpl loan states CIMB EPP unavailable (Harith feedback 07-20)');
ok(/Alliance Bank|Standard Chartered/.test(fr._tpl('loan', 'bm')), 'tpl loan BM lists real EPP bank list');
ok(/berminat motor apa/.test(fr._tpl('greeting', 'bm')), 'tpl greeting asks model');
ok(fr._tpl('product', 'bm', null, '✅ Ada ya bos, stok tersedia.').includes('✅ Ada ya bos, stok tersedia'), 'tpl product carries stock line when provided');

// ---- 1c: the loan reply now says outright that the bot is customer service (DRAFT-1, 2026-08-14) ----
const CARD = { name: 'Adib', digits: '60178869542', disp: '017-8869542' };
const loanBmCard = fr._tpl('loan', 'bm', CARD);
const loanBmBare = fr._tpl('loan', 'bm', null);
const loanEnCard = fr._tpl('loan', 'en', CARD);
ok(/Kami ada loan kedai \(Aeon Credit, Chailease, JCL, Parkson, BSNC\)/.test(loanBmCard)
   && /EPP kad kredit 0%/.test(loanBmCard) && /EPP CIMB tiada\)/.test(loanBmCard),
   'loan BM merged: financier lists intact, CIMB EPP called out inside the parens (no dash)');
ok(/Saya customer service je ya/.test(loanBmCard) && /salesman kami lagi arif/.test(loanBmCard),
   'loan BM: the "I am only customer service" line is present');
ok(/Info tuan dah saya pass kat dia/.test(loanBmCard), 'loan BM: promises the handoff already happened');
ok(/Kalau nak terus pun boleh 👇/.test(loanBmCard), 'loan BM: 👇 appears when a card follows');
ok(!/👇/.test(loanBmBare), '🚨 loan BM: NO 👇 when there is no card to point at');
ok(/sales advisor|salesman kami|contact tuan/i.test(loanBmBare), 'loan BM cardless: still promises contact');
ok(/I'm customer service only ya/.test(loanEnCard) && /CIMB EPP not available\)/.test(loanEnCard),
   'loan EN mirror: same structure, same CS line');
ok(/Or you can reach them directly 👇/.test(loanEnCard) && !/👇/.test(fr._tpl('loan', 'en', null)),
   'loan EN: 👇 only when a card follows');
ok(NO_DASH(loanBmCard) && NO_DASH(loanBmBare) && NO_DASH(loanEnCard) && NO_DASH(fr._tpl('loan', 'en', null)),
   '🚨 loan: no dash in any of the four renders');

// ---- 1d: the tpl matrix can never emit a dash again ----
// cats × languages × card/no-card × closed/open. The card fixture uses a real DISPLAY phone
// (010-2323259) so this also proves in-word/phone hyphens survive the sweep.
{
  let renders = 0, dashy = [];
  const cardFix = { name: 'Azrul', digits: '60102323259', disp: '010-2323259' };
  for (const cat of ['product', 'loan', 'sell', 'testride', 'greeting', 'other'])
    for (const lang of ['bm', 'en'])
      for (const card of [cardFix, null])
        for (const closed of [true, false]) {
          const t = fr._tpl(cat, lang, card, '', closed);
          renders++;
          if (!NO_DASH(t)) dashy.push(`${cat}/${lang}/${card ? 'card' : 'nocard'}/${closed ? 'closed' : 'open'}`);
        }
  ok(dashy.length === 0, `🚨 dash: none of the ${renders} tpl renders emits a dash` + (dashy.length ? ' — ' + dashy.join(', ') : ''));
  ok(/010-2323259/.test(fr._tpl('product', 'bm', cardFix, '', false)), 'dash: the display phone keeps its hyphens (010-2323259)');
}

// ---- flow: greeting → model answer assigns; sell assigns to Fitri; staff ignored ----
const sent = [], assigned = [], dms = [];
const DEPS = {
  waSend: async (to, text) => { sent.push({ to, text }); return 'msg1'; },
  assignLeads: (leads, ov) => leads.map(l => ({ ...l, want: l.interest, brand: l.brand || 'HQ', origin: 'WhatsApp Direct',
    assignee: (ov && ov.noAssign) ? '' : 'Adib', staff: (ov && ov.noAssign) ? null : { phone: '+60178869542', openId: 'x' } })),
  larkWriteLead: async l => { assigned.push(l); return 'rec1'; },
  notifyStaff: async ls => { dms.push(ls); return 'dm1'; },
  sla: { register: (...a) => assigned.push({ sla: a[0] }) },
  getUnavailable: async () => new Set(),
  log: () => {},
  isStaffPhone: p => String(p).endsWith('123773259'),
  // Shape matches index.js `wooCheckStock` since 2026-08-10: NO price field (deliberately removed —
  // the salesperson owns price), plus `isNew` and `mileage`.
  wooCheckStock: async (q) => /aveta 250/i.test(q)
    ? { matches: [{ name: 'NEW AVETA NOVA 250', isNew: true, mileage: 0 }, { name: 'NEW AVETA VANGUARD 250', isNew: true, mileage: 0 }, { name: 'NEW AVETA VTM 250 LX', isNew: true, mileage: 0 }] }
    : /vulcan/i.test(q) ? { matches: [{ name: 'Kawasaki Vulcan S', isNew: false, mileage: 38000 }] }
    : /mt09|mt-09/i.test(q) ? { matches: [{ name: '2015 Yamaha MT-09 V1', isNew: false, mileage: 79000 }] }
    : /forza/i.test(q) ? { matches: [{ name: '2022 Honda Forza 250', isNew: false, mileage: 42000 }] }
    : /xmax/i.test(q) ? { matches: [{ name: '2024 Yamaha XMAX 250', isNew: false, mileage: 20000 }, { name: '2022 Yamaha XMAX 250', isNew: false, mileage: 143000 }] }
    : /175x/i.test(q) ? { matches: [], booking: [{ name: 'OPEN FOR BOOKING NEW ZONTES 175X' }] }
    : { matches: [] },
};
fr.init(DEPS);
const wait = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  fr.onMessage({ jid: 'cust1@s.whatsapp.net', phone: '60111111111', kind: 'text', text: 'Hi' });
  await wait(120);
  ok(sent.length === 1 && /berminat motor apa/.test(sent[0].text), 'flow: greeting reply sent');
  fr.onMessage({ jid: 'cust1@s.whatsapp.net', phone: '60111111111', kind: 'text', text: 'z900rs' });
  await wait(120);
  ok(assigned.some(a => a.want && /z900rs/i.test(a.want)), 'flow: model answer → Lark lead');
ok(/ADIB : 017-8869542/.test(sent[sent.length-1].text), 'flow: reply carries assigned salesperson card');
  ok(assigned.some(a => a.sla === 'Adib'), 'flow: SLA registered for Adib');
  ok(dms.length === 1, 'flow: salesperson DM sent');

  fr.onMessage({ jid: 'cust2@s.whatsapp.net', phone: '60122222222', kind: 'text', text: 'nak jual motor y15' });
  await wait(120);
  ok(sent.some(s => /FITRI/i.test(s.text) && s.to === 'cust2@s.whatsapp.net'), 'flow: sell reply w/ Fitri');
  ok(sent.some(s => s.to === '+60108093259' && /Trade-in Lead/.test(s.text)), 'flow: Fitri DM sent');
  ok(assigned.some(a => /TRADE-IN/.test(a.want || '')), 'flow: trade-in Lark record');

  const nAssigned = assigned.length, nSent = sent.length;
  fr.onMessage({ jid: 'cust3@s.whatsapp.net', phone: '60133333333', kind: 'text', text: 'nak join test ride esok boleh?' });
  await wait(120);
  ok(sent.length === nSent + 1 && /berminat untuk membuat test ride/i.test(sent[sent.length-1].text), 'flow: testride reply uses standing message');
  ok(assigned.length > nAssigned, 'flow: testride IS assigned (2026-07-20 — no longer info-only)');
  ok(assigned.some(a => a.want && /^TESTRIDE: /.test(a.want)), 'flow: testride Lark record prefixed so brandFromModel still sees the model + staff know it is a test-ride lead');

  fr.onMessage({ jid: 'staff@s.whatsapp.net', phone: '60123773259', kind: 'text', text: 'z800 ada' });
  await wait(120);
  ok(!sent.some(s => s.to === 'staff@s.whatsapp.net'), 'flow: staff number ignored');
  {
    // …but no longer SILENTLY ignored. The VPS inbox cross-check must apply the same staff
    // exclusion the bot does, and the only drift-free way is for the bot to record it (a 5th copy
    // of the roster on the VPS is how TM lost leads four times).
    const st = fr.readFrEvents().text.split('\n').filter(Boolean).map(JSON.parse)
      .filter(e => e.jid === 'staff@s.whatsapp.net');
    ok(st.length === 1 && st[0].outcome === 'ai_skip' && st[0].note === 'staff_or_internal',
       'flow: a staff chat is recorded as ai_skip(staff_or_internal), never counted as a lead');
  }

  // one-touch: same customer again within 7d → silence
  const n = sent.length;
  fr.onMessage({ jid: 'cust2@s.whatsapp.net', phone: '60122222222', kind: 'text', text: 'hello?' });
  await wait(120);
  ok(sent.length === n, 'flow: one-touch — no second reply to cust2');

  // stock check (Harith feedback 07-20): product question w/ real WooCommerce match → reply states stock
  fr.onMessage({ jid: 'cust4@s.whatsapp.net', phone: '60144444444', kind: 'text', text: 'vulcan ada stok tak' });
  await wait(120);
  const vul = sent[sent.length - 1].text;
  ok(/✅ Ada ya bos, Kawasaki Vulcan S \(38,000 km\)/.test(vul), 'flow: stock check NAMES the exact unit + mileage');
  ok(!/RM/.test(vul), 'flow: 🚨 no price ever reaches the customer (2026-08-10 — the salesperson owns price)');
  ok(/salesman kami akan confirm harga/i.test(vul), 'flow: price is explicitly handed to the salesperson');

  // stock check: NO WooCommerce match → NEUTRAL line, never "takde stok" (2026-07-24: ER6N was
  // instock + MT-07 physically available, both customers told "takde stok" — a search miss or a
  // stale Woo flag must never become a confident negative claim). Lead still assigns.
  const nAssigned2 = assigned.length;
  fr.onMessage({ jid: 'cust5@s.whatsapp.net', phone: '60155555555', kind: 'text', text: 'ninja 250 ada ke' });
  await wait(120);
  ok(/salesman kami akan confirm/.test(sent[sent.length - 1].text), 'flow: no stock match → neutral salesman-will-confirm line');
  ok(!/takde stok/.test(sent[sent.length - 1].text), 'flow: no stock match never claims out-of-stock');
  ok(assigned.length > nAssigned2, 'flow: unmatched model still assigns the lead');

  // real fixture 2026-07-24 (ER6N false negative): in-stock bike the search missed → neutral, not "takde stok"
  fr.onMessage({ jid: 'cust5b@s.whatsapp.net', phone: '60155555556', kind: 'text', text: 'slamat pagi sy mencari motor er6n ada stok lg?' });
  await wait(120);
  ok(/salesman kami akan confirm/.test(sent[sent.length - 1].text) && !/takde stok/.test(sent[sent.length - 1].text), 'flow: ER6N-class search miss → neutral BM line');

  // real fixture 2026-07-24 (Zontes 175X): booking-only listing → booking pitch + Steven's Zontes
  // dealer/mystery-gift lines, NO stock claim, NO placeholder price
  fr.onMessage({ jid: 'cust5c@s.whatsapp.net', phone: '60155555557', kind: 'text', text: 'Hi morning, zontes 175x expected release around what month ya, is there any info on this? Thanks' });
  await wait(120);
  const bk = sent[sent.length - 1].text;
  ok(/OPEN FOR BOOKING/.test(bk) && /ZONTES 175X/.test(bk), 'flow: booking listing → booking pitch with model name');
  ok(/mystery gift/i.test(bk) && /Zontes dealer/i.test(bk), 'flow: Zontes booking carries Steven dealer + mystery-gift lines');
  ok(!/we have stock/i.test(bk) && !/8,888/.test(bk), 'flow: booking listing never claims stock or quotes placeholder price');

  // multi-match stock (2026-07-22 Aveta 250 incident): several distinct models match → list the
  // options and ask which one, NEVER quote one cheapest price across different bikes
  fr.onMessage({ jid: 'cust6@s.whatsapp.net', phone: '60166666666', kind: 'text', text: 'aveta 250 ada stock?' });
  await wait(120);
  const multi = sent[sent.length - 1].text;
  // Aveta's whole line-up is NEW units, and the NEW half of the catalog is hand-typed and unmaintained
  // (one row priced RM 888,888.8888) — so naming those units would itself be an unfounded stock claim.
  // New → qualify and assign, never quote. Changed 2026-08-10; before this it listed them with prices.
  ok(/unit baru/.test(multi) && /cash atau loan/i.test(multi), 'flow: an all-NEW match qualifies instead of quoting');
  ok(!/RM/.test(multi) && !/14,388/.test(multi), 'flow: 🚨 no price on new units either');
  ok(!/dari RM/.test(multi), 'flow: ambiguous model never quotes a single lowest price');

  // ---- 1c / DRAFT-2 (2026-08-14): a PRICE question inside a product enquiry ----
  // The bot says it is customer service INSTEAD OF the old "salesman will confirm the price" tail,
  // never in addition to it. Two salesman-will-confirm sentences in one message is the double-say
  // this replaces, so every case below counts occurrences rather than just testing presence.
  const countOf = (hay, needle) => hay.split(needle).length - 1;

  fr.onMessage({ jid: 'custPr1@s.whatsapp.net', phone: '60105050501', kind: 'text', text: 'vulcan berapa harga' });
  await wait(120);
  const pr1 = sent[sent.length - 1].text;
  ok(/Kawasaki Vulcan S \(38,000 km\)/.test(pr1), 'price ask: the unit is still named');
  ok(countOf(pr1, 'customer service je') === 1, 'price ask → the CS price line, exactly ONCE');
  ok(countOf(pr1, 'akan confirm harga') === 0, '🚨 price ask: the old "akan confirm harga & plan bulanan" tail is GONE (no double-say)');
  ok(!/RM/.test(pr1), '🚨 price ask: still no price, ever');

  fr.onMessage({ jid: 'custPr2@s.whatsapp.net', phone: '60105050502', kind: 'text', text: 'vulcan ada lagi ke' });
  await wait(120);
  const pr2 = sent[sent.length - 1].text;
  ok(/Salesman kami akan confirm harga & plan bulanan/.test(pr2), 'no price ask → the original tail is untouched');
  ok(!/customer service je/.test(pr2), 'no price ask → no CS line bolted on');

  fr.onMessage({ jid: 'custPr3@s.whatsapp.net', phone: '60105050503', kind: 'text', text: 'ninja 400 harga berapa ya' });
  await wait(120);
  const pr3 = sent[sent.length - 1].text;
  ok(/customer service je/.test(pr3) && !/Untuk stok model tu/.test(pr3),
     'price ask on a NO-MATCH model → the CS line stands alone (it already promises the salesman)');
  ok(countOf(pr3, 'akan confirm') === 1, '🚨 no-match + price: exactly one salesman-will-confirm sentence');

  fr.onMessage({ jid: 'custPr4@s.whatsapp.net', phone: '60105050504', kind: 'text', text: 'xmax 250 harga berapa' });
  await wait(120);
  const pr4 = sent[sent.length - 1].text;
  ok(/Yang mana satu bos berminat ya\?/.test(pr4), 'multi-match + price: the clarify question still comes first');
  ok(/customer service je/.test(pr4) && !/akan bagi harga/.test(pr4), 'multi-match + price: CS line replaces the old "akan bagi harga & plan" tail');
  ok(!/RM/.test(pr4), '🚨 multi-match + price: no price');

  fr.onMessage({ jid: 'custPr5@s.whatsapp.net', phone: '60105050505', kind: 'text', text: 'how much is the vulcan' });
  await wait(120);
  const pr5 = sent[sent.length - 1].text;
  ok(/I'm customer service only/.test(pr5) && !/confirm the price & monthly plan/.test(pr5),
     'price ask EN mirror: same substitution, no double-say');

  // ---- A (2026-07-24): LLM intent classification, regex fallback ----
  fr.init({ ...DEPS, aiClassify: async t => {
    if (/api-down/i.test(t)) throw new Error('timeout');
    if (/tolak/i.test(t)) return 'sell';
    return 'not-a-category';
  } });
  // real fixture 2026-07-24: "mau tolak moto masih ada loan" (= trade-in, own bike under loan) had
  // matched the word "loan" and got the buying-loan financier template
  fr.onMessage({ jid: 'custA1@s.whatsapp.net', phone: '60101010101', kind: 'text', text: 'Kalau mau tolak moto masih ada loan lagi boleh kah ? Moto baru setahun' });
  await wait(120);
  const tolak = sent.filter(s => s.to === 'custA1@s.whatsapp.net');
  ok(tolak.length === 1 && /FITRI/i.test(tolak[0].text) && /jual\/trade-in/i.test(tolak[0].text), 'A: "tolak moto + loan" → sell reply w/ Fitri card (was loan template)');
  ok(!/loan kedai/i.test(tolak[0].text), 'A: "tolak moto + loan" no longer gets the financier list');
  ok(assigned.some(a => /^TRADE-IN: Kalau mau tolak/i.test(a.want || '')), 'A: tolak-moto lead recorded as TRADE-IN for Fitri');
  // LLM returns garbage → regex fallback still classifies correctly
  fr.onMessage({ jid: 'custA2@s.whatsapp.net', phone: '60102020202', kind: 'text', text: 'nak jual motor y15' });
  await wait(120);
  ok(sent.some(s => s.to === 'custA2@s.whatsapp.net' && /FITRI/i.test(s.text)), 'A: garbage LLM output → regex fallback (sell still routes to Fitri)');
  // LLM throws (down/timeout) → regex fallback, stock line untouched
  fr.onMessage({ jid: 'custA3@s.whatsapp.net', phone: '60103030303', kind: 'text', text: 'vulcan ada stok tak api-down' });
  await wait(120);
  ok(/✅ Ada ya bos, Kawasaki Vulcan S/.test(sent[sent.length - 1].text), 'A: LLM error → regex fallback (product + stock check still work)');

  // ---- 2026-08-10 incident fixtures: three real customers, all three answered wrongly ----
  // ① "Yamaha R1 ada ke cik" (08-10 10:10). Was offered three R15s; Adib corrected it 4 min later.
  fr.onMessage({ jid: 'custYr1@s.whatsapp.net', phone: '60104040401', kind: 'text', text: 'Yamaha R1 ada ke cik' });
  await wait(120);
  const r1 = sent[sent.length - 1].text;
  ok(!/R15/i.test(r1), '① R1: never offers an R15 again');
  ok(/salesman kami akan confirm/i.test(r1), '① R1: defers to the salesperson (a search miss is never a "takde")');
  ok(!/takde|tiada stok/i.test(r1), '① R1: still never makes a confident NEGATIVE claim either');
  // ② "forza 250 baru ada? Cash berapa?" (08-08 20:14). Was quoted RM 20,800 off a 42,000km used unit;
  //    staff apologised 08-10 12:41 and gave the real answer, OTR RM 28,800.
  fr.onMessage({ jid: 'custFz@s.whatsapp.net', phone: '60104040402', kind: 'text', text: 'Hai nak tanya forza 250 baru ada? Cash berapa?' });
  await wait(120);
  const fz = sent[sent.length - 1].text;
  ok(/unit baru/.test(fz) && /cash atau loan/i.test(fz), '② forza baru: asks the qualifier instead of answering');
  ok(!/RM/.test(fz) && !/20,800/.test(fz), '② forza baru: 🚨 the RM 20,800 quote can never come back');
  ok(!/2022 Honda Forza/.test(fz), '② forza baru: does not offer a USED unit to someone asking for new');
  // ③ "mt09" (08-08 01:53). Was quoted a bare "dari RM 22,800" — read as the price of an MT-09
  //    rather than of one 2015 bike with 79,000 km on it. Staff apologised 08-10 12:24.
  fr.onMessage({ jid: 'custMt@s.whatsapp.net', phone: '60104040403', kind: 'text', text: 'Hi. Nak tanya mt09' });
  await wait(120);
  const mt = sent[sent.length - 1].text;
  ok(/2015 Yamaha MT-09 V1 \(79,000 km\)/.test(mt), '③ mt09: names the actual unit — year AND mileage');
  ok(!/RM/.test(mt) && !/22,800/.test(mt), '③ mt09: 🚨 no price');
  // multi-unit used: list them, no prices
  fr.onMessage({ jid: 'custXm@s.whatsapp.net', phone: '60104040404', kind: 'text', text: 'xmax 250 ada lagi?' });
  await wait(120);
  const xm = sent[sent.length - 1].text;
  ok(/beberapa unit/.test(xm) && /143,000 km/.test(xm), 'multi used: lists each unit with its mileage');
  ok(/Yang mana satu/.test(xm), 'multi used: still asks the customer to clarify (Harith 2026-07-22)');
  ok(!/RM/.test(xm), 'multi used: 🚨 no price');
  // ---- rehydrateGreeted (2026-07-24): restored chats are NOT re-greeted after a deploy ----
  const nRe = fr.rehydrateGreeted([{ jid: 'custR1@s.whatsapp.net', ts: Date.now() - 3600e3 }, { jid: 'cust1@s.whatsapp.net', ts: 1 }]);
  ok(nRe === 1, 'rehydrate: only unknown chats added (live greeted state never overwritten)');
  const nSentR = sent.length;
  fr.onMessage({ jid: 'custR1@s.whatsapp.net', phone: '60104040404', kind: 'text', text: 'Hi' });
  await wait(120);
  ok(sent.length === nSentR, 'rehydrate: restored chat gets NO duplicate greeting');

  fr.init(DEPS);   // restore plain deps for the off-hours section below

  // off-hours deferral (team 2026-07-22: replies 24h, lead distribution Mon–Fri 9–5): outside the
  // window the customer still gets a reply + Lark record, but NO card, NO staff DM, NO SLA — the
  // staff-facing half is queued via deferStaffNotify for the drain to release at 9am.
  const deferred = [];
  fr.init({
    waSend: async (to, text) => { sent.push({ to, text }); return 'msg1'; },
    assignLeads: (leads, ov) => leads.map(l => ({ ...l, want: l.interest, brand: l.brand || 'HQ', origin: 'WhatsApp Direct',
      assignee: (ov && ov.noAssign) ? '' : 'Adib', staff: (ov && ov.noAssign) ? null : { phone: '+60178869542', openId: 'x' } })),
    larkWriteLead: async l => { assigned.push(l); return 'recN'; },
    notifyStaff: async ls => { dms.push(ls); return 'dmN'; },
    sla: { register: (...a) => assigned.push({ sla: a[0] }) },
    getUnavailable: async () => new Set(),
    log: () => {},
    isStaffPhone: () => false,
    wooCheckStock: async () => ({ matches: [] }),
    inDistHours: () => false,
    inOpenHours: () => false,          // 2am — the shop is genuinely SHUT
    // Wired to the REAL generator off the REAL OPERATING window, so the quoted hours can never drift
    // from when TM is actually open again (the 2026-07-30 "Isnin–Jumaat 9–5" incident).
    hoursLabel: () => require('./hours').hoursLabel([1,2,3,4,5,6], 9, 18),
    deferStaffNotify: e => deferred.push(e),
  });
  const nDm = dms.length, nSent2 = sent.length;
  fr.onMessage({ jid: 'cust7@s.whatsapp.net', phone: '60177777777', kind: 'text', text: 'nak tanya cbr250 masih ada?' });
  await wait(120);
  const nightReply = sent[sent.length - 1];
  ok(sent.length === nSent2 + 1 && nightReply.to === 'cust7@s.whatsapp.net', 'flow: off-hours customer still gets an instant reply');
  ok(/Waktu operasi kami/.test(nightReply.text), 'flow: off-hours reply says SA will contact during office hours');
  ok(/Isnin–Sabtu, 9 pagi–6 petang/.test(nightReply.text), 'flow: off-hours reply quotes the REAL window (Mon–Sat 9–6), generated not hardcoded');
  ok(!/Isnin–Jumaat|9 pagi–5 petang/.test(nightReply.text), 'flow: the old wrong hours (Mon–Fri 9–5) are gone');
  ok(!/ADIB : /.test(nightReply.text), 'flow: off-hours reply has NO salesman card');
  ok(assigned.some(a => a.want && /cbr250/i.test(a.want) && !a.assignee), 'flow: off-hours lead written to Lark UNASSIGNED');
  ok(dms.length === nDm, 'flow: off-hours — no salesman DM sent');
  ok(deferred.length === 1 && deferred[0].kind === 'pool' && deferred[0].recordId === 'recN', 'flow: off-hours staff notify queued for the 9am drain');

  // off-hours trade-in → Fitri DM deferred the same way
  fr.onMessage({ jid: 'cust8@s.whatsapp.net', phone: '60188888888', kind: 'text', text: 'nak jual motor y16' });
  await wait(120);
  ok(/Waktu operasi kami/.test(sent[sent.length - 1].text) && !/FITRI : /.test(sent[sent.length - 1].text), 'flow: off-hours sell reply — office-hours line, no Fitri card');
  ok(deferred.some(e => e.kind === 'dm' && /Trade-in Lead/.test(e.text)), 'flow: off-hours Fitri DM queued for the drain');

  // ---- @lid customer with NO phone at all (2026-08-02 incident, 5 real customers) ----
  // WhatsApp discloses no number for some privacy-addressed chats. Previously the LID digits were
  // used AS a phone (→ HTTP 422, no reply, fake number in Lark) and 14/15-digit LIDs were dropped
  // outright by a guard meant for junk phone numbers (→ no reply, no lead, no log line).
  const noPhoneSent = [], noPhoneLark = [], noPhoneDms = [];
  fr.init({ ...DEPS,
    waSend: async (to, text) => { noPhoneSent.push({ to, text }); return 'm1'; },
    larkWriteLead: async l => { noPhoneLark.push(l); return 'recLID'; },
    notifyStaff: async ls => { noPhoneDms.push(ls); return 'dmLID'; },
  });
  const n0 = noPhoneSent.length;
  fr.onMessage({ jid: '1924279574737@lid', phone: '', kind: 'text', text: 'Boleh saya tahu detail tentang CBR150' });
  await wait(120);
  // Phone gate (2026-08-03): a no-phone lead now gets TWO messages — the normal answer, then a
  // request for a number — and is HELD rather than assigned. Was 1 message + immediate assign.
  ok(noPhoneSent.length === n0 + 2, 'no-phone @lid (13 digits): customer still gets a reply');
  ok(/nombor telefon tuan|phone number/i.test(noPhoneSent[noPhoneSent.length - 1].text),
     'no-phone @lid: second message asks for the number');
  ok(noPhoneSent[noPhoneSent.length - 1].to === '1924279574737@lid',
     'no-phone @lid: reply addressed to the @lid, NOT a fabricated <lid>@s.whatsapp.net');
  // Deliberately NO Lark row while held: writing one with staff:null still stamps SLA fields and
  // that is exactly what charged Fitri's trade-ins to Ikhwan (2026-07-30). The row is written on
  // release, by assign(), with either a real phone or a blank one — never the LID digits.
  ok(noPhoneLark.length === 0, 'no-phone @lid: HELD — no Lark row, no SLA clock, until released');

  // 15-digit LID — the length guard used to drop these silently
  const n1 = noPhoneSent.length;
  fr.onMessage({ jid: '235450526621777@lid', phone: '', kind: 'text', text: 'slip gaji part time boleh guna untuk loan ?' });
  await wait(120);
  ok(noPhoneSent.length === n1 + 2, '15-digit @lid: no longer silently dropped — customer gets a reply');
  ok(noPhoneSent[noPhoneSent.length - 1].to === '235450526621777@lid', '15-digit @lid: addressed to the @lid');

  // a REAL phone on a @lid chat still resolves to the phone JID (the 2026-07-28 fix must not regress)
  const n2 = noPhoneSent.length;
  // NOTE: distinct jid — reusing the 07-28 fixture's jid marks it greeted and breaks that test later
  fr.onMessage({ jid: '900000000000001@lid', phone: '60186528999', kind: 'text', text: 'nak tanya pasal cbr250' });
  await wait(120);
  ok(noPhoneSent[noPhoneSent.length - 1].to === '60186528999@s.whatsapp.net',
     '@lid WITH a real phone still goes to the phone JID (07-28 fix intact)');

  // junk-number guards must still work on REAL phones
  const n3 = noPhoneSent.length;
  fr.onMessage({ jid: '447700900123@s.whatsapp.net', phone: '447700900123', kind: 'text', text: 'hello' });
  await wait(120);
  ok(noPhoneSent.length === n3, 'UK 447* number still ignored');
  fr.onMessage({ jid: '60123456789012345@s.whatsapp.net', phone: '60123456789012345', kind: 'text', text: 'hello' });
  await wait(120);
  ok(noPhoneSent.length === n3, 'over-long REAL phone still ignored');

  // ---- SATURDAY / 5–6pm weekday: shop OPEN, but the bot does not auto-assign (Benjamin 2026-07-30) ----
  // "they are working on Saturday but we don't assign lead on Sat". So this is a THIRD state, distinct
  // from both "in the assign window" and "closed": no salesman card, and crucially NO "we'll contact
  // you when we reopen" line — the office is open, saying otherwise is the same wrongness Harith
  // flagged. A human watches the inbox; the lead still drains to a rep on Monday 9am as a backstop.
  const satDeferred = [];
  fr.init({ ...DEPS,
    inDistHours: () => false,          // Saturday → bot does not hand the lead out
    inOpenHours: () => true,           // …but the shop IS open
    hoursLabel: () => require('./hours').hoursLabel([1,2,3,4,5,6], 9, 18),
    deferStaffNotify: e => satDeferred.push(e),
    larkWriteLead: async l => { assigned.push(l); return 'recSAT'; },
  });
  const nSentSat = sent.length;
  fr.onMessage({ jid: 'custsat@s.whatsapp.net', phone: '60199111222', kind: 'text', text: 'nak tanya ninja 250 ada stok?' });
  await wait(120);
  const satReply = sent[sent.length - 1];
  ok(sent.length === nSentSat + 1, 'saturday: customer still gets an instant reply');
  ok(!/Waktu operasi kami|bila pejabat dibuka semula/.test(satReply.text), 'saturday: NO "we are closed / when we reopen" line — the shop is open');
  ok(!/ADIB : |https:\/\/wa\.me\/60178869542/.test(satReply.text), 'saturday: NO salesman card — nobody is auto-assigned');
  ok(/menghubungi anda/.test(satReply.text), 'saturday: still promises an advisor will be in touch');
  ok(satDeferred.some(e => e.kind === 'pool'), 'saturday: staff-facing half queued for the Monday 9am drain (backstop)');

  // Trade-in on a Saturday → Fitri's DM defers, and her Lark Salesman cell IS now filled in
  // (2026-07-30: an EMPTY Salesman is what let the blank-openId bug charge her leads to Ikhwan).
  fr.onMessage({ jid: 'custsat2@s.whatsapp.net', phone: '60199333444', kind: 'text', text: 'nak jual motor vespa' });
  await wait(120);
  const tradeRow = assigned.filter(a => a.want && /^TRADE-IN:/.test(a.want)).pop();
  ok(!!tradeRow, 'trade-in: row written to Lark');
  ok(tradeRow && tradeRow.assignee === 'Fitri', 'trade-in: attributed to Fitri');
  ok(tradeRow && tradeRow.staff && tradeRow.staff.openId === 'ou_9dbd12586dfb70716c3ee77aefe010ed',
     'trade-in: Fitri\'s Lark openId now set, so the Salesman cell is never left empty');
  ok(!/Waktu operasi kami/.test(sent[sent.length - 1].text), 'trade-in on saturday: no "closed" line either');

  // 🐛→✅ 2026-07-28: click-to-chat customers arrive with a @lid privacy jid — WaSenderAPI can't
  // deliver to that address, so the reply must go to the real phone-based jid instead (real
  // incident: +60186528335 "Hi, nak tanya pasal moto" got classified + assigned but never replied to).
  fr.init(DEPS);
  const nSentLid = sent.length;
  fr.onMessage({ jid: '143499823448076@lid', phone: '60186528335', kind: 'text', text: 'Hi, nak tanya pasal moto' });
  await wait(120);
  ok(sent.length === nSentLid + 1 && sent[sent.length - 1].to === '60186528335@s.whatsapp.net', 'flow: @lid customer greeting sent to real phone jid, not the @lid address');
  fr.onMessage({ jid: '143499823448076@lid', phone: '60186528335', kind: 'text', text: 'z900rs' });
  await wait(120);
  ok(sent[sent.length - 1].to === '60186528335@s.whatsapp.net', 'flow: @lid customer model-answer reply also sent to real phone jid');
  ok(assigned.some(a => a.want && /z900rs/i.test(a.want)), 'flow: @lid customer lead still written to Lark');

  // ---- 2.1: the durable DECISION LOG (2026-08-14) ----
  // Lark only records the leads that SUCCEEDED. A chat the bot skipped, held or handed to a human
  // left no row anywhere, so "how many leads today and why weren't they assigned" was unanswerable
  // by construction. One JSONL line per decision is what makes the client's report possible.
  const evOf = jid => fr.readFrEvents().text.split('\n').filter(Boolean).map(JSON.parse).filter(e => e.jid === jid);
  ok(fr.readFrEvents().ok === true, 'events: the log reads back cleanly');
  {
    // ① one event per decision, and the assigned one carries who took it + the CRM row id
    const e1 = evOf('cust1@s.whatsapp.net');
    ok(e1.length === 2 && e1[0].outcome === 'awaiting_model' && e1[1].outcome === 'assigned',
       'events: greeting logs awaiting_model, the model answer supersedes it with assigned');
    ok(e1[1].assignee === 'Adib' && e1[1].recordId === 'rec1' && e1[1].has_phone === true,
       'events: an assigned lead carries assignee + recordId + has_phone');
    ok(/z900rs/.test(e1[1].want), 'events: the customer\'s own words ride along (no second read needed)');

    // ② off-hours → parked, not assigned
    const e7 = evOf('cust7@s.whatsapp.net');
    ok(e7.length === 1 && e7[0].outcome === 'parked' && e7[0].recordId === 'recN',
       'events: an off-hours lead logs parked, with its Lark row');

    // ③ nobody took it
    ok(evOf('cust5@s.whatsapp.net').length === 1, 'events: exactly one event per ordinary flush');

    // ④ a chat that was never decided on has no event at all — the log records DECISIONS, not traffic
    ok(evOf('custSkip1@s.whatsapp.net').length === 0, 'events: nothing is logged for a chat the bot has not decided on yet');
  }
  {
    // vendor / OTP: not a lead, but the chat must still be accounted for
    fr.onMessage({ jid: 'custSkip1@s.whatsapp.net', phone: '60107070701', kind: 'text', text: '35935 is your Facebook confirmation code' });
    await wait(120);
    const e = evOf('custSkip1@s.whatsapp.net');
    ok(e.length === 1 && e[0].outcome === 'ai_skip' && e[0].note === 'vendor_auto',
       'events: a vendor/OTP message logs ai_skip(vendor_auto), which the report ignores forever');

    // 🚨 The other half of the old `classifier_skip`. A long message the classifier could not read
    // is a POSSIBLE BUYER who got no answer, and it must reach the admin's "needs a look" block.
    // Lumping it in with vendor robots is how a real customer stays invisible.
    fr.onMessage({ jid: 'custSkip2@s.whatsapp.net', phone: '60107070704', kind: 'text',
      text: 'Assalamualaikum semua. Mari belajar fahami makna Al-Quran m bersama kami di kelas mingguan setiap khamis' });
    await wait(120);
    const u = evOf('custSkip2@s.whatsapp.net');
    ok(u.length === 1 && u[0].outcome === 'ai_skip' && u[0].note === 'unclassified',
       '🚨 events: a message the classifier could NOT read logs ai_skip(unclassified), not vendor_auto');

    // junk number: dropped at the door, but no longer silently
    fr.onMessage({ jid: '447700900999@s.whatsapp.net', phone: '447700900999', kind: 'text', text: 'hello' });
    await wait(60);
    const j = evOf('447700900999@s.whatsapp.net');
    ok(j.length === 1 && j[0].outcome === 'ai_skip' && j[0].note === 'junk_number',
       'events: a junk 447* number logs ai_skip(junk_number), no separate bucket');

    // a human owns the chat — a legitimate ending that used to leave no trace at all
    fr.markHuman('custHum1@s.whatsapp.net');
    fr.onMessage({ jid: 'custHum1@s.whatsapp.net', phone: '60107070702', kind: 'text', text: 'nak tanya cbr250' });
    await wait(60);
    const h = evOf('custHum1@s.whatsapp.net');
    ok(h.length === 1 && h[0].outcome === 'human_owned', 'events: a human-owned chat logs human_owned');

    // the 7-day re-greet guard: silent by design, but the cross-check must not read it as a
    // webhook we never received (Benjamin approved the `repeat` outcome, 2026-08-14)
    const nBefore = sent.length;
    fr.onMessage({ jid: 'cust5@s.whatsapp.net', phone: '60155555555', kind: 'text', text: 'ninja 250 lagi ada?' });
    await wait(120);
    const rp = evOf('cust5@s.whatsapp.net');
    ok(sent.length === nBefore, 'events: a repeat chatter still gets no second greeting (behaviour unchanged)');
    ok(rp.length === 2 && rp[1].outcome === 'repeat' && rp[1].note === 'already_greeted_7d',
       'events: …but it is now logged as `repeat`, excluded from lead totals, used only to reconcile');
  }
  {
    // 🚨 A MISSING LOG AND AN UNREADABLE LOG ARE OPPOSITE FACTS. Found 2026-08-14 by pointing the
    // live endpoint at a bad path: it answered "0 leads" with total confidence. On Render that is
    // one unmounted /data disk away from telling the client a quiet day when the bot was busy.
    const realRead = fs.readFileSync, realAccess = fs.accessSync;
    const enoent = () => { const e = new Error('ENOENT: no such file or directory'); e.code = 'ENOENT'; throw e; };
    fs.readFileSync = enoent;
    fs.accessSync = () => {};                       // directory IS there → a genuinely fresh disk
    const fresh = fr.readFrEvents();
    ok(fresh.ok === true && fresh.text === '', 'read: a missing file in a healthy directory is an EMPTY log, not a failure');
    fs.accessSync = enoent;                         // directory is NOT there → disk unmounted / bad path
    const broken = fr.readFrEvents();
    ok(broken.ok === false && /directory is unreadable/.test(broken.error),
       '🚨 read: a missing DIRECTORY is a READ FAILURE, so the card says "couldn\'t read" instead of 0');
    fs.readFileSync = realRead; fs.accessSync = realAccess;
    ok(fr.readFrEvents().ok === true, 'read: restored cleanly');
  }
  {
    // 🚨 BEST-EFFORT: monitoring must never break a lead. A full disk costs a log line, not a customer.
    const realAppend = fs.appendFileSync;
    fs.appendFileSync = () => { throw new Error('ENOSPC: no space left on device'); };
    const nBefore = sent.length, aBefore = assigned.length;
    fr.onMessage({ jid: 'custEnospc@s.whatsapp.net', phone: '60107070703', kind: 'text', text: 'nak tanya vulcan ada?' });
    await wait(150);
    fs.appendFileSync = realAppend;
    ok(sent.length === nBefore + 1, '🚨 events: a throwing appendFileSync NEVER costs the customer their reply');
    ok(assigned.length > aBefore, '🚨 events: …and the lead is still written to Lark and assigned');
  }

  // ---- 🚨 SUITE-WIDE DASH REGRESSION (2026-08-14) ----
  // Every message the bot actually SENT during this whole file, in both languages, across every
  // category, stock shape, off-hours state and @lid path. This is the assert that survives a future
  // edit reintroducing a dash — no hand-maintained inventory of lines can. Em dash only at this
  // level: an interpolated WooCommerce product name could legitimately contain " - ", so the
  // spaced-hyphen rule is asserted on the fixed-fixture tpl renders above and in notify_test.js.
  {
    const dashed = sent.filter(s => /—/.test(s.text));
    ok(dashed.length === 0, `🚨 dash: no em dash in ANY of the ${sent.length} bot sends`
      + (dashed.length ? ` — first offender: "${dashed[0].text.slice(0, 90)}"` : ''));
    // …and the kept hyphens really were kept, so the sweep did not just delete characters.
    ok(sent.some(s => /MT-09/.test(s.text)), 'dash: in-word model hyphens survived (MT-09)');
    ok(sent.some(s => /017-8869542|010-8093259/.test(s.text)), 'dash: display phone hyphens survived');
    ok(sent.some(s => /trade-in/i.test(s.text)), 'dash: "trade-in" survived');
    ok(sent.some(s => /9 pagi–6 petang/.test(s.text)), 'dash: the en-dash HOUR RANGE from hours.js is untouched (a range, not punctuation)');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  try { fs.unlinkSync(process.env.FR_EVENTS_FILE); } catch {}
  process.exit(fail ? 1 : 0);
})();
