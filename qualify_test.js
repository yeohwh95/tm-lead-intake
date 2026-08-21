/**
 * Off-hours QUALIFICATION tests for TM. Run: node qualify_test.js
 *
 * Client, 2026-08-16: "Outside operating hours, don't say we are closed now. Say something like I
 * will get the sales person to contact you in the next working day ya." Plus: qualify the customer
 * FIRST, so the salesperson opens a useful lead on Monday instead of "Hi".
 *
 * The two things that must never break, and which every test below circles:
 *   1. 🚨 A customer who answers NOTHING is still queued and still assigned at the next drain.
 *      Qualification is layered on top of the park; it can never delay or replace it.
 *   2. 🚨 ONE Lark row per customer. The qualify flow parks a row on message 1, so any later path
 *      (answer, gate release, timeout) must PATCH that row, never create a second one.
 */
process.env.FIRSTRESPONSE_ON = '1';
process.env.FR_DEBOUNCE_MS = '5';
process.env.FR_GATE_MS = '60000';
process.env.FR_STATE_FILE = require('path').join(require('os').tmpdir(), `fr_qual_state_${process.pid}.json`);
process.env.FR_EVENTS_FILE = require('path').join(require('os').tmpdir(), `fr_qual_events_${process.pid}.jsonl`);
for (const f of [process.env.FR_STATE_FILE, process.env.FR_EVENTS_FILE]) { try { require('fs').unlinkSync(f); } catch {} }

const fr = require('./firstresponse.js');
const { nextWindowLabel } = require('./hours');

let pass = 0, fail = 0;
const ok = (label, cond) => { cond ? (pass++, console.log('  ✅ ' + label)) : (fail++, console.log('  ❌ ' + label)); };
const wait = ms => new Promise(r => setTimeout(r, ms));

// Fixed clocks, so the promised day is deterministic.
const MYT = 8 * 3600e3;
const at = (d, h, mi) => Date.parse(`${d}T00:00:00Z`) - MYT + h * 3600e3 + (mi || 0) * 60e3;
const MON_FRI = [1, 2, 3, 4, 5], MON_SAT = [1, 2, 3, 4, 5, 6];
const FRI_1716 = at('2026-08-14', 17, 16), SAT_1100 = at('2026-08-15', 11), SUN_2300 = at('2026-08-16', 23);

let sent = [], larkRows = [], deferred = [], patchedWant = [], patchedPhone = [], logs = [];
const reset = () => { sent = []; larkRows = []; deferred = []; patchedWant = []; patchedPhone = []; logs = [];
  const st = fr._state(); st.awaitingPhone = {}; st.greeted = {}; st.qualify = {}; };
const texts = () => sent.map(s => s.text).join('\n---\n');

// ⚠️ init() REPLACES the dep bag, it does not merge — a partial re-init leaves the module without
// waSend/log and it dies on the next message.
const BASE = {
  waSend: async (to, text) => { sent.push({ to, text }); return 'm1'; },
  assignLeads: (leads, ov) => leads.map(l => ({ ...l, want: l.interest, brand: 'HQ', origin: 'WhatsApp Direct',
    assignee: (ov && ov.noAssign) ? '' : 'Nazrin', staff: (ov && ov.noAssign) ? null : { phone: '+60123456789', openId: 'ou_x' } })),
  larkWriteLead: async (l) => { larkRows.push(l); return 'rec' + larkRows.length; },
  notifyStaff: async () => 'dm1',
  sla: { register: () => {}, inHours: () => true },
  getUnavailable: async () => new Set(),
  log: (...a) => logs.push(a.join(' ')),
  isStaffPhone: () => false,
  wooCheckStock: async () => null,
  aiClassify: async () => null,          // force the regex classifier — deterministic, offline
  inDistHours: () => false,              // OFF-WINDOW unless a case says otherwise
  inOpenHours: () => false,
  deferStaffNotify: e => deferred.push(e),
  hoursLabel: () => require('./hours').hoursLabel(MON_SAT, 9, 18),
  nextWindowLabel: () => nextWindowLabel(FRI_1716, MON_FRI, 9, 17),
  larkPatchWant: async (rec, text) => { patchedWant.push({ rec, text }); },
  larkPatchPhone: async (rec, phone) => { patchedPhone.push({ rec, phone }); },
};
const initWith = (o) => fr.init({ ...BASE, ...(o || {}) });

(async () => {
  // ── 1. Friday 17:16, the exact replay the client asked for ────────────────────────────────
  console.log('\n1. Friday 17:16 — a model is named, outside the assignment window');
  initWith();
  reset();
  fr.onMessage({ jid: 'q1@s.whatsapp.net', phone: '60111000001', kind: 'text', text: 'nak tanya z900 ada stok?' });
  await wait(80);
  ok('exactly ONE message back (stock answer + qualifying ask merged)', sent.length === 1);
  ok('🚨 model already named → SHORT ask, cash-or-loan only', /Nak cash atau loan ya bos\?/.test(texts()));
  ok('🚨 and it does NOT ask which model, right after naming the exact unit', !/minat model yang mana/.test(texts()));
  ok('🚨 it NEVER says we are closed', !/Waktu operasi kami|pejabat dibuka semula|office hours/.test(texts()));
  ok('🚨 no salesman card is dangled while nobody owns it', !/NAZRIN/i.test(texts()));
  ok('🚨 no phone ask stacked on top — the gate comes LAST', !/nombor telefon tuan/.test(texts()));
  ok('🚨 the Lark row is written on the FIRST message, before any answer', larkRows.length === 1);
  ok('🚨 and the staff half is queued for the drain immediately', deferred.length === 1 && deferred[0].kind === 'pool');

  // ── 2. …they answer → the row is ENRICHED, never duplicated ───────────────────────────────
  console.log('\n2. The customer answers the qualifying question');
  sent = [];
  fr.onMessage({ jid: 'q1@s.whatsapp.net', phone: '60111000001', kind: 'text', text: 'z900 rs, nak loan' });
  await wait(80);
  ok('Customer want is PATCHED onto the existing row', patchedWant.length === 1 && patchedWant[0].rec === 'rec1');
  ok('the patch keeps the original AND the qualification', /nak tanya z900 ada stok\?/.test(patchedWant[0].text) && /qualified: z900 rs, nak loan/.test(patchedWant[0].text));
  ok('🚨 NO second Lark row was created', larkRows.length === 1);
  ok('🚨 NO second queue entry either', deferred.length === 1);
  ok('the reply commits to the computed day', /Sales advisor kami akan contact tuan Isnin pagi ya 🙏 Terima kasih tuan\./.test(texts()));
  ok('🚨 and still never mentions being closed', !/Waktu operasi kami|tutup/.test(texts()));

  // ── 3. 🚨🚨 THE SILENT CUSTOMER — the non-negotiable case ──────────────────────────────────
  console.log('\n3. 🚨 A customer who NEVER answers must still be assigned');
  reset();
  fr.onMessage({ jid: 'q2@s.whatsapp.net', phone: '60111000002', kind: 'text', text: 'cbr250 ada?' });
  await wait(80);
  ok('lead written to Lark on the first message', larkRows.length === 1);
  ok('🚨 exactly ONE queue entry exists, and it survives the silence', deferred.length === 1);
  ok('the queued entry carries their enquiry', /cbr250/.test(deferred[0].want || ''));
  // …time passes, they never reply. The drain releases the entry to a rep.
  const clearedN = fr.clearQualify('q2@s.whatsapp.net');
  ok('🚨 the drain clears the qualify state so the bot stops quizzing a chat a rep now owns', clearedN >= 1);
  ok('🚨 silence cost nothing — the lead is still in the queue for the rep', deferred.length === 1);

  // ── 4. 🚨🚨 THE 2026-08-05 REGRESSION — the most important test in this batch ──────────────
  // markHuman() fires on ANY fromMe message, and the bot's OWN sends echo back as fromMe. So the
  // chat is flagged human-owned the instant the bot asks its qualifying question. If `state.qualify`
  // is ever dropped from the `midFlow` exemption in onMessage(), the customer's answer is discarded
  // BEFORE it is buffered — exactly how 4 of 4 real phone numbers were binned and the gate reported
  // 0% conversion when the truth was 100%.
  console.log('\n4. 🚨 The bot\'s own send must not deafen it to the answer');
  reset();
  fr.onMessage({ jid: 'q3@s.whatsapp.net', phone: '60111000003', kind: 'text', text: 'vulcan s ada?' });
  await wait(80);
  fr.markHuman('q3@s.whatsapp.net');            // exactly what the bot's own outbound echo does
  ok('still mid-qualification after the bot replied', !!fr._state().qualify['q3@s.whatsapp.net']);
  sent = [];
  fr.onMessage({ jid: 'q3@s.whatsapp.net', phone: '60111000003', kind: 'text', text: 'vulcan s, cash' });
  await wait(80);
  ok('🚨🚨 THE ANSWER IS HEARD, not dropped', patchedWant.length === 1 && /qualified: vulcan s, cash/.test(patchedWant[0].text));
  ok('🚨🚨 and the customer gets their closing message', /Isnin pagi/.test(texts()));
  ok('🚨 the qualify entry is cleared once answered', !fr._state().qualify['q3@s.whatsapp.net']);

  // ── 5. Ordering: qualify FIRST, phone gate LAST ───────────────────────────────────────────
  console.log('\n5. A no-phone evening customer: qualify first, gate last, never both at once');
  reset();
  const LID = '999000111222333@lid';
  fr.onMessage({ jid: LID, phone: '', kind: 'text', text: 'nak tanya ninja 400' });
  await wait(80);
  ok('first reply asks the qualifying question', /minat model yang mana|Nak cash atau loan ya bos/.test(texts()));
  ok('🚨 and does NOT ask for a number in the same breath', !/nombor telefon tuan/.test(texts()));
  // ⚠️ No phone means the qualify flow cannot park a Lark row (writing one with staff:null stamps
  // SLA fields — the 2026-07-30 Fitri/Ikhwan defect), so this path holds at the gate as before.
  sent = [];
  fr.onMessage({ jid: LID, phone: '', kind: 'text', text: 'ninja 400, cash' });
  await wait(80);
  ok('only AFTER they answer does the number ask appear', /nombor telefon tuan|phone number/.test(texts()));
  ok('the hold is now in place', fr.gateStatus().length === 1);

  // ── 6. Touch cap: never more than 3 ask-type messages in one evening ───────────────────────
  console.log('\n6. Touch cap');
  reset();
  const LID2 = '888000111222333@lid';
  fr.onMessage({ jid: LID2, phone: '', kind: 'text', text: 'nak tanya rsv4' });
  await wait(80);
  fr.onMessage({ jid: LID2, phone: '', kind: 'text', text: 'rsv4, loan' });
  await wait(80);
  fr.onMessage({ jid: LID2, phone: '', kind: 'text', text: 'tak nak bagi nombor' });
  await wait(80);
  const asks = sent.filter(s => /minat model yang mana|Nak cash atau loan ya bos|nombor telefon tuan|username/.test(s.text)).length;
  ok(`🚨 at most 3 ask-type messages in the whole episode (got ${asks})`, asks <= 3);
  ok('and the lead is still not lost', fr.gateStatus().length === 1 || larkRows.length >= 1);

  // ── 7. A vague answer is NOT re-asked — the lead just drains ───────────────────────────────
  // 🚨 CHANGED 2026-08-21. This used to assert ONE re-ask, and that re-ask was a byte-identical
  // repeat of the first question. That is precisely what the client reported twice ("auto bot keep
  // tanya soalan sama"). Asking again buys nothing — the row is already in Lark and already queued.
  console.log('\n7. Vague answer');
  reset();
  fr.onMessage({ jid: 'q5@s.whatsapp.net', phone: '60111000005', kind: 'text', text: 'aveta nova ada?' });
  await wait(80);
  ok('parked on the first message', deferred.length === 1);
  sent = [];
  fr.onMessage({ jid: 'q5@s.whatsapp.net', phone: '60111000005', kind: 'text', text: 'ok' });
  await wait(80);
  ok('🚨 a vague reply is NEVER answered with the same question again', sent.length === 0);
  sent = [];
  fr.onMessage({ jid: 'q5@s.whatsapp.net', phone: '60111000005', kind: 'text', text: 'hmm' });
  await wait(80);
  ok('🚨 and it stays quiet rather than nagging', sent.length === 0);
  ok('🚨 and the queue entry is UNTOUCHED — they still get a rep', deferred.length === 1);

  // ── 7b. THE REGRESSION THIS RELEASE EXISTS FOR: "Cash" is an ANSWER, not silence ───────────
  // Live 21 Aug 07:46 (+60133664090): "Morning.. mt25 hitam 2nd" → bot asks "Nak cash atau loan?"
  // → customer says "Cash.." → bot asked the IDENTICAL question again → customer said "Cash" →
  // silence, and a human had to step in at 09:45. classify() has a `loan` rule and no `cash` rule,
  // so the reply scored as `greeting` = said nothing.
  console.log('\n7b. The answers that used to read as silence');
  for (const [answer, why] of [['Cash..', 'cash with punctuation'], ['Cash', 'bare cash'],
                               ['saya nak cash saja boss', 'cash in a sentence'],
                               ['Trk502', 'a model RE_BIKE has never heard of'],
                               ['X250gp', 'a Lambretta model code'],
                               ['703F', 'a bare digit model code']]){
    reset();
    const J = `q7b${answer.replace(/[^a-z0-9]/gi, '')}@s.whatsapp.net`;
    fr.onMessage({ jid: J, phone: '60111000007', kind: 'text', text: 'aveta nova ada?' });
    await wait(80);
    sent = [];
    fr.onMessage({ jid: J, phone: '60111000007', kind: 'text', text: answer });
    await wait(80);
    ok(`🚨 "${answer}" (${why}) is treated as a real answer, never re-asked`,
       !/minat model yang mana|Nak cash atau loan ya bos/.test(texts()));
    ok(`   …and "${answer}" is carried onto the lead for the rep`,
       JSON.stringify(patchedWant).includes(answer));
  }

  // ── 7c. The stock line ALREADY asks cash-or-loan — never ask it twice in one bubble ───────
  // Live 20 Aug 22:08 (+58420178767892@lid), one message, verbatim:
  //   "…Salesman kami akan confirm dengan tuan ya. Bos nak cash atau loan?
  //    Nak cash atau loan ya bos? 😊 Saya pass semua detail…"
  // A NEW-unit stock line ends with the same question the qualifying ask then appends.
  console.log('\n7c. The cash-or-loan question, asked twice in one bubble');
  initWith({ wooCheckStock: async () => ({ matches: [{ isNew: true, name: 'NEW MODA MOCA 110', mileage: 0 }], booking: [] }) });
  reset();
  fr.onMessage({ jid: 'q7c@s.whatsapp.net', phone: '60111000008', kind: 'text',
                 text: 'saya nak tanya ada jual motor moda moca tak?' });
  await wait(80);
  ok('still exactly ONE message back', sent.length === 1);
  const payAsks = (texts().match(/cash atau loan/gi) || []).length;
  ok(`🚨 the cash-or-loan question appears exactly ONCE (got ${payAsks})`, payAsks === 1);
  ok('   …and the stock line itself is still there', /Untuk unit baru/.test(texts()));
  ok('   …and the lead is still parked on message 1', larkRows.length === 1 && deferred.length === 1);
  initWith();

  // ── 8. Both settings of the still-open Saturday question, end to end ──────────────────────
  console.log('\n8. The unresolved Saturday question is env-only, end to end');
  for (const [days, label, expect] of [[MON_FRI, 'FR_DIST_DAYS=1-5', 'Isnin pagi'],
                                       [MON_SAT, 'FR_DIST_DAYS=1-6', 'esok pagi']]){
    initWith({ nextWindowLabel: () => nextWindowLabel(FRI_1716, days, 9, 17) });
    reset();
    fr.onMessage({ jid: `qsat${expect.length}@s.whatsapp.net`, phone: '60111000006', kind: 'text', text: 'z900 ada?' });
    await wait(80);
    sent = [];
    fr.onMessage({ jid: `qsat${expect.length}@s.whatsapp.net`, phone: '60111000006', kind: 'text', text: 'z900, cash' });
    await wait(80);
    ok(`Friday 17:16 under ${label} → "${expect}"`, new RegExp(`contact tuan ${expect} ya`).test(texts()));
  }

  // ── 9. Sunday 23:00 — genuinely shut, and STILL no closure sentence ───────────────────────
  console.log('\n9. Sunday 23:00 (genuinely shut) and Saturday 11:00 (open, not assigning)');
  initWith({ nextWindowLabel: () => nextWindowLabel(SUN_2300, MON_FRI, 9, 17) });
  reset();
  fr.onMessage({ jid: 'qsun@s.whatsapp.net', phone: '60111000007', kind: 'text', text: 'tracer 9 gt ada?' });
  await wait(80);
  fr.onMessage({ jid: 'qsun@s.whatsapp.net', phone: '60111000007', kind: 'text', text: 'tracer 9 gt, loan' });
  await wait(80);
  ok('🚨 Sunday 23:00 still never says "we are closed"', !/Waktu operasi kami|pejabat dibuka semula/.test(texts()));
  ok('Sunday 23:00 names Monday explicitly, not "esok"', /contact tuan Isnin pagi ya/.test(texts()));

  initWith({ nextWindowLabel: () => nextWindowLabel(SAT_1100, MON_FRI, 9, 17) });
  reset();
  fr.onMessage({ jid: 'qsat11@s.whatsapp.net', phone: '60111000008', kind: 'text', text: 'xmax ada?' });
  await wait(80);
  fr.onMessage({ jid: 'qsat11@s.whatsapp.net', phone: '60111000008', kind: 'text', text: 'xmax 250, cash' });
  await wait(80);
  ok('Saturday 11:00 (shop open, bot not assigning) → Isnin pagi', /contact tuan Isnin pagi ya/.test(texts()));
  ok('🚨 Saturday never claims the shop is shut', !/Waktu operasi kami|pejabat dibuka semula/.test(texts()));

  // ── 10. In-window behaviour is UNCHANGED ──────────────────────────────────────────────────
  console.log('\n10. Inside the assignment window nothing changes');
  initWith({ inDistHours: () => true, inOpenHours: () => true });
  reset();
  fr.onMessage({ jid: 'qin@s.whatsapp.net', phone: '60111000009', kind: 'text', text: 'z900 ada?' });
  await wait(80);
  ok('in-window: assigned immediately with the salesperson card', /NAZRIN/i.test(texts()));
  ok('in-window: NO qualifying question', !/minat model yang mana|Nak cash atau loan ya bos/.test(texts()));
  ok('in-window: no day promised — a rep has it now', !/Isnin pagi|esok pagi/.test(texts()));
  ok('in-window: one Lark row, no deferral', larkRows.length === 1 && deferred.length === 0);

  // ── 11. 🚨 ONE ROW PER CUSTOMER, across every path ────────────────────────────────────────
  // The defect this guards: the qualify flow parks a row on message 1, so a later gate release
  // calling assign() again would create a SECOND row — two salespeople ringing one customer.
  console.log('\n11. 🚨 Exactly one Lark row per customer, whatever path they take');
  initWith({ nextWindowLabel: () => nextWindowLabel(FRI_1716, MON_FRI, 9, 17) });
  reset();
  fr.onMessage({ jid: 'qrow@s.whatsapp.net', phone: '60111000010', kind: 'text', text: 'er6n ada?' });
  await wait(80);
  fr.onMessage({ jid: 'qrow@s.whatsapp.net', phone: '60111000010', kind: 'text', text: 'er6n, cash' });
  await wait(80);
  ok('with a phone: park → qualify → close = 1 row', larkRows.length === 1);

  // …and the no-phone path, where the gate genuinely does the assigning.
  reset();
  const LID3 = '777000111222333@lid';
  fr.onMessage({ jid: LID3, phone: '', kind: 'text', text: 'duke 390 ada?' });
  await wait(80);
  fr.onMessage({ jid: LID3, phone: '', kind: 'text', text: 'duke 390, cash' });
  await wait(80);
  fr.onMessage({ jid: LID3, phone: '', kind: 'text', text: '0148369971' });
  await wait(80);
  ok('🚨 no-phone: qualify → gate → release = exactly 1 row', larkRows.length === 1);
  ok('and the real number reached that row', JSON.stringify(larkRows).includes('60148369971'));

  // ── 12. A hold that ALREADY has a row patches it instead of assigning again ───────────────
  console.log('\n12. A gate release on an already-parked row patches, never re-assigns');
  reset();
  const st = fr._state();
  st.awaitingPhone['qpatch@s.whatsapp.net'] = { ts: Date.now() - 61000, asks: 1, cat: 'product',
    want: 'z900 | qualified: cash', lang: 'bm', recordId: 'recEXISTING', fromQualify: true };
  await fr.gateSweep();
  ok('🚨 no second Lark row on release', larkRows.length === 0);
  ok('the timeout release is logged against the existing row', logs.some(l => /EXISTING parked row/.test(l)));

  // ── 13. Migration: a customer mid-greeting at deploy time is not stranded ──────────────────
  console.log('\n13. state.pending migrates to state.qualify on load');
  {
    const fsx = require('fs');
    const p = require('path').join(require('os').tmpdir(), `fr_mig_${process.pid}.json`);
    fsx.writeFileSync(p, JSON.stringify({ greeted: { 'old@s.whatsapp.net': 1 },
      pending: { 'old@s.whatsapp.net': { ts: 1786000000000 } } }));
    const out = require('child_process').execSync(
      `FR_STATE_FILE='${p}' node -e "const f=require('./firstresponse');const s=f._state();` +
      `console.log(JSON.stringify({q:s.qualify,p:s.pending}))"`, { cwd: __dirname }).toString();
    const got = JSON.parse(out.trim().split('\n').pop());
    ok('🚨 a legacy pending entry becomes a qualify entry (customer not stranded)',
       !!got.q['old@s.whatsapp.net'] && got.q['old@s.whatsapp.net'].phase === 'model');
    ok('its original timestamp is preserved', got.q['old@s.whatsapp.net'].ts === 1786000000000);
    ok('and state.pending is removed', got.p === undefined);
    try { fsx.unlinkSync(p); } catch {}
  }

  // ── 14. Kill switch ───────────────────────────────────────────────────────────────────────
  console.log('\n14. FR_QUALIFY=0 turns qualification off WITHOUT resurrecting the closure line');
  process.env.FR_QUALIFY = '0';
  initWith({ nextWindowLabel: () => nextWindowLabel(FRI_1716, MON_FRI, 9, 17) });
  reset();
  fr.onMessage({ jid: 'qoff@s.whatsapp.net', phone: '60111000011', kind: 'text', text: 'z900 ada?' });
  await wait(80);
  ok('kill switch: no qualifying question', !/minat model yang mana|Nak cash atau loan ya bos/.test(texts()));
  ok('🚨 kill switch: the banned closure sentence STAYS banned', !/Waktu operasi kami|pejabat dibuka semula/.test(texts()));
  ok('kill switch: still commits to the next working day', /contact tuan Isnin pagi ya/.test(texts()));
  ok('kill switch: lead still parked, never lost', larkRows.length === 1 && deferred.length === 1);
  delete process.env.FR_QUALIFY;

  // ── 15. Guards that must survive ──────────────────────────────────────────────────────────
  console.log('\n15. The standing guards');
  initWith({ nextWindowLabel: () => nextWindowLabel(FRI_1716, MON_FRI, 9, 17) });
  reset();
  fr.onMessage({ jid: 'qguard@s.whatsapp.net', phone: '60111000012', kind: 'text', text: 'z900 ada?' });
  await wait(80);
  const nAfterFirst = sent.length;
  fr.onMessage({ jid: 'qguard@s.whatsapp.net', phone: '60111000012', kind: 'text', text: 'z900, cash' });
  await wait(80);
  fr.onMessage({ jid: 'qguard@s.whatsapp.net', phone: '60111000012', kind: 'text', text: 'hello again' });
  await wait(80);
  ok('one greeting per 7 days still holds after qualification ends', sent.length === nAfterFirst + 1);

  // A human replying mid-qualification wins instantly.
  reset();
  fr.onMessage({ jid: 'qhum@s.whatsapp.net', phone: '60111000013', kind: 'text', text: 'z900 ada?' });
  await wait(80);
  fr._state().qualify['qhum@s.whatsapp.net'].ts = Date.now() - (73 * 3600e3);   // expired
  sent = [];
  fr.onMessage({ jid: 'qhum@s.whatsapp.net', phone: '60111000013', kind: 'text', text: 'z900, cash' });
  await wait(80);
  ok('an expired qualify entry is not treated as a live answer', !patchedWant.some(p => /qualified/.test(p.text)));

  // ── 16. Dash rule on every new string ─────────────────────────────────────────────────────
  console.log('\n16. Dash rule');
  {
    const strings = [fr._qualifyAsk('bm'), fr._qualifyAsk('en'),
      fr._closingLine('bm', { bm: 'Isnin pagi', en: 'Monday morning' }),
      fr._closingLine('en', { bm: 'Isnin pagi', en: 'Monday morning' })];
    ok('🚨 no em dash in any new customer-facing string', strings.every(t => !/—/.test(t)));
    ok('🚨 no standalone spaced hyphen either', strings.every(t => !/ - /.test(t)));
  }

  // -- 17. 🚨 SHORT vs FULL qualifying ask (client, 2026-08-17) ------------------------------
  // Asking "which model?" straight after the bot has NAMED the exact unit reads like it wasn't
  // listening. The signal is RE_BIKE — the same one classify() and stockLineFor() already trust.
  console.log('\n17. The ask adapts to whether a model was already named');
  const FULL_BM = 'Boleh saya tahu sikit, tuan minat model yang mana ya? Nak cash atau loan? 😊 Saya pass semua detail kat salesman supaya dia terus boleh bantu tuan.';
  const SHORT_BM = 'Nak cash atau loan ya bos? 😊 Saya pass semua detail kat salesman supaya dia terus boleh bantu tuan.';
  ok('short BM form is exactly the approved copy', fr._qualifyAsk('bm', true) === SHORT_BM);
  ok('🚨 full BM form is BYTE-IDENTICAL to before (the regression risk)', fr._qualifyAsk('bm', false) === FULL_BM);
  ok('EN short mirrors the structure', fr._qualifyAsk('en', true) === `Cash or loan ya? 😊 I'll pass all the details to our salesman so he can help you straight away.`);
  ok('EN full unchanged', /Can I get a bit more detail, which model are you interested in\? Cash or loan\?/.test(fr._qualifyAsk('en', false)));
  ok('short form still asks the thing we actually need', /cash atau loan/i.test(fr._qualifyAsk('bm', true)));
  ok('short form still promises the handoff', /pass semua detail kat salesman/.test(fr._qualifyAsk('bm', true)));
  ok('🚨 dash rule holds on both new strings',
     [fr._qualifyAsk('bm', true), fr._qualifyAsk('en', true)].every(t => !/—/.test(t) && !/ - /.test(t)));

  // …end to end: a NAMED model gets the short ask, a bare greeting gets the full one.
  initWith({ nextWindowLabel: () => nextWindowLabel(FRI_1716, MON_FRI, 9, 17) });
  reset();
  fr.onMessage({ jid: 'qshort@s.whatsapp.net', phone: '60111000020', kind: 'text', text: 'cbr650r ada bos?' });
  await wait(80);
  ok('🚨 model named end-to-end → short ask', texts().includes(SHORT_BM) && !/minat model yang mana/.test(texts()));

  reset();
  fr.onMessage({ jid: 'qfull@s.whatsapp.net', phone: '60111000021', kind: 'text', text: 'Hi' });
  await wait(80);
  ok('🚨 nothing named end-to-end → FULL ask, unchanged behaviour', texts().includes(FULL_BM));
  ok('the greeting path never parks a Lark row (nothing to park yet)', larkRows.length === 0);

  // …and the machine still works identically in the short-ask case: it collects the answer and
  // patches Lark, which is the whole point of asking.
  reset();
  fr.onMessage({ jid: 'qshort2@s.whatsapp.net', phone: '60111000022', kind: 'text', text: 'z900 ada?' });
  await wait(80);
  ok('short-ask path still parks the lead on message 1', larkRows.length === 1 && deferred.length === 1);
  fr.onMessage({ jid: 'qshort2@s.whatsapp.net', phone: '60111000022', kind: 'text', text: 'loan' });
  await wait(80);
  ok('🚨 short-ask path still collects the answer and patches Customer want',
     patchedWant.length === 1 && /qualified: loan/.test(patchedWant[0].text));
  ok('short-ask path still closes with the computed day', /contact tuan Isnin pagi ya/.test(texts()));
  ok('🚨 still exactly ONE Lark row', larkRows.length === 1);

  // …and the FULL-ask path still collects its answer too (the greeting → model flow).
  reset();
  fr.onMessage({ jid: 'qfull2@s.whatsapp.net', phone: '60111000023', kind: 'text', text: 'Hello there' });
  await wait(80);
  const fullAsked = texts().includes(FULL_BM) || /which model are you interested in/i.test(texts());
  ok('full-ask path asked the full question', fullAsked);
  fr.onMessage({ jid: 'qfull2@s.whatsapp.net', phone: '60111000023', kind: 'text', text: 'z900, cash' });
  await wait(80);
  ok('🚨 full-ask path still assigns/parks the lead once answered', larkRows.length === 1);

  // 🚨 A customer who answers NEITHER variant is still queued and still drains to a rep.
  reset();
  fr.onMessage({ jid: 'qsilent2@s.whatsapp.net', phone: '60111000024', kind: 'text', text: 'ninja 400 ada?' });
  await wait(80);
  ok('🚨 silent after the SHORT ask → still exactly one queue entry for the drain', deferred.length === 1);
  ok('🚨 and the Lark row exists regardless of the ask variant', larkRows.length === 1);

  console.log(`\n${'='.repeat(54)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(54)}`);
  for (const f of [process.env.FR_STATE_FILE, process.env.FR_EVENTS_FILE]) { try { require('fs').unlinkSync(f); } catch {} }
  process.exit(fail ? 1 : 0);
})();
