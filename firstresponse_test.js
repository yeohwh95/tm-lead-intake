// Classifier + flow tests for the first-response bot. Run: node firstresponse_test.js
process.env.FIRSTRESPONSE_ON = '1';
process.env.FR_DEBOUNCE_MS = '30';
const fs = require('fs');
try { fs.unlinkSync(__dirname + '/fr_state.json'); } catch {}
const fr = require('./firstresponse');

let pass = 0, fail = 0;
const ok = (cond, name) => { cond ? pass++ : (fail++, console.log('❌', name)); cond && console.log('✅', name); };

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
ok(fr._tpl('product', 'bm', null, '✅ Ada, stok tersedia — dari RM 12,800.').includes('✅ Ada, stok tersedia'), 'tpl product carries stock line when provided');

// ---- flow: greeting → model answer assigns; sell assigns to Fitri; staff ignored ----
const sent = [], assigned = [], dms = [];
fr.init({
  waSend: async (to, text) => { sent.push({ to, text }); return 'msg1'; },
  assignLeads: (leads, ov) => leads.map(l => ({ ...l, want: l.interest, brand: l.brand || 'HQ', origin: 'WhatsApp Direct',
    assignee: (ov && ov.noAssign) ? '' : 'Adib', staff: (ov && ov.noAssign) ? null : { phone: '+60178869542', openId: 'x' } })),
  larkWriteLead: async l => { assigned.push(l); return 'rec1'; },
  notifyStaff: async ls => { dms.push(ls); return 'dm1'; },
  sla: { register: (...a) => assigned.push({ sla: a[0] }) },
  getUnavailable: async () => new Set(),
  log: () => {},
  isStaffPhone: p => String(p).endsWith('123773259'),
  wooCheckStock: async (q) => /aveta 250/i.test(q)
    ? { matches: [{ name: 'NEW AVETA NOVA 250', price: 14388 }, { name: 'NEW AVETA VANGUARD 250', price: 16300 }, { name: 'NEW AVETA VTM 250 LX', price: 12688 }] }
    : /vulcan/i.test(q) ? { matches: [{ name: 'Kawasaki Vulcan S', price: 12800 }] } : { matches: [] },
});
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

  // one-touch: same customer again within 7d → silence
  const n = sent.length;
  fr.onMessage({ jid: 'cust2@s.whatsapp.net', phone: '60122222222', kind: 'text', text: 'hello?' });
  await wait(120);
  ok(sent.length === n, 'flow: one-touch — no second reply to cust2');

  // stock check (Harith feedback 07-20): product question w/ real WooCommerce match → reply states stock
  fr.onMessage({ jid: 'cust4@s.whatsapp.net', phone: '60144444444', kind: 'text', text: 'vulcan ada stok tak' });
  await wait(120);
  ok(/Ada, stok tersedia.*RM 12,800/.test(sent[sent.length - 1].text), 'flow: stock check reports real WooCommerce stock');

  // stock check: product question w/ NO WooCommerce match → reply says out of stock, still assigns lead
  const nAssigned2 = assigned.length;
  fr.onMessage({ jid: 'cust5@s.whatsapp.net', phone: '60155555555', kind: 'text', text: 'ninja 250 ada ke' });
  await wait(120);
  ok(/takde stok untuk model tu/.test(sent[sent.length - 1].text), 'flow: stock check reports out-of-stock');
  ok(assigned.length > nAssigned2, 'flow: out-of-stock model still assigns the lead');

  // multi-match stock (2026-07-22 Aveta 250 incident): several distinct models match → list the
  // options and ask which one, NEVER quote one cheapest price across different bikes
  fr.onMessage({ jid: 'cust6@s.whatsapp.net', phone: '60166666666', kind: 'text', text: 'aveta 250 ada stock?' });
  await wait(120);
  const multi = sent[sent.length - 1].text;
  ok(/beberapa pilihan/.test(multi) && /NOVA 250/.test(multi) && /VANGUARD 250/.test(multi), 'flow: ambiguous model lists the in-stock options');
  ok(/Yang mana satu/.test(multi), 'flow: ambiguous model asks the customer to clarify');
  ok(!/dari RM/.test(multi), 'flow: ambiguous model never quotes a single lowest price');

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
    deferStaffNotify: e => deferred.push(e),
  });
  const nDm = dms.length, nSent2 = sent.length;
  fr.onMessage({ jid: 'cust7@s.whatsapp.net', phone: '60177777777', kind: 'text', text: 'nak tanya cbr250 masih ada?' });
  await wait(120);
  const nightReply = sent[sent.length - 1];
  ok(sent.length === nSent2 + 1 && nightReply.to === 'cust7@s.whatsapp.net', 'flow: off-hours customer still gets an instant reply');
  ok(/Waktu operasi kami/.test(nightReply.text), 'flow: off-hours reply says SA will contact during office hours');
  ok(!/ADIB : /.test(nightReply.text), 'flow: off-hours reply has NO salesman card');
  ok(assigned.some(a => a.want && /cbr250/i.test(a.want) && !a.assignee), 'flow: off-hours lead written to Lark UNASSIGNED');
  ok(dms.length === nDm, 'flow: off-hours — no salesman DM sent');
  ok(deferred.length === 1 && deferred[0].kind === 'pool' && deferred[0].recordId === 'recN', 'flow: off-hours staff notify queued for the 9am drain');

  // off-hours trade-in → Fitri DM deferred the same way
  fr.onMessage({ jid: 'cust8@s.whatsapp.net', phone: '60188888888', kind: 'text', text: 'nak jual motor y16' });
  await wait(120);
  ok(/Waktu operasi kami/.test(sent[sent.length - 1].text) && !/FITRI : /.test(sent[sent.length - 1].text), 'flow: off-hours sell reply — office-hours line, no Fitri card');
  ok(deferred.some(e => e.kind === 'dm' && /Trade-in Lead/.test(e.text)), 'flow: off-hours Fitri DM queued for the drain');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
