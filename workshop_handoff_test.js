/**
 * Workshop hand-off (2026-10-08). Two things, both from TM's project group:
 *  (3) TM sent the 3 workshop numbers; Benjamin chose CUSTOMER PICKS — the reply carries all three
 *      links, Honda Impian first for a Honda, and never claims a message was passed on.
 *  (4) Real chat +60123698855, 6 Oct 11:34–11:37: service question → workshop reply → "Tq" got the
 *      SALES greeting → "Nk servis" got "nak beli atau jual?". After a hand-off the bot stays quiet
 *      on a pure thank-you only; a repeat workshop question alerts the group once; every other line
 *      is handled exactly as for a fresh customer (v1's word lists silenced buyers — attack round).
 * Drives firstresponse.onMessage end-to-end.
 */
process.env.FIRSTRESPONSE_ON = '1';
process.env.FR_DEBOUNCE_MS = '5';
const os = require('os'), path = require('path');
process.env.FR_STATE_FILE = path.join(os.tmpdir(), `fr_ws_test_${process.pid}.json`);
process.env.FR_EVENTS_FILE = path.join(os.tmpdir(), `fr_ws_events_${process.pid}.jsonl`);
process.env.GATE_LOG_FILE = path.join(os.tmpdir(), `fr_ws_gate_${process.pid}.jsonl`);
const fr = require('./firstresponse.js');

// What gpt-4o is assumed to answer for each real line. "Tq" / "Nk servis" are deliberately run
// under BOTH plausible verdicts below, so the fix does not depend on the model's mood.
const AI = {
  'Morning boss, klu nk service zontes boleh walk in?': 'workshop',
  'nak servis honda rs150 boleh?': 'workshop',
  'nak tukar minyak hitam': 'workshop',
  'tukar nama motor berapa kos': 'admin',
  'nak beli motor baru, ada lambretta x250?': 'product',
  'saya nak jual motor saya': 'sell',
  'Hi': 'greeting',
};
let sent = [], reviewed = [], larkRows = [], aiOverride = {};
const BASE = {
  waSend: async (to, text) => { sent.push({ to, text }); return 'mid'; },
  assignLeads: (l) => l,
  larkWriteLead: async (l) => { larkRows.push(l); return 'rec' + larkRows.length; },
  notifyStaff: async () => 'dm',
  sla: { register: () => {}, inHours: () => true }, getUnavailable: async () => [],
  log: () => {}, isStaffPhone: () => false, wooCheckStock: async () => null,
  aiClassify: async (t) => aiOverride[t] || AI[t] || 'greeting', fetchUsername: async () => '',
  alertReview: async (t) => { reviewed.push(t); return true; },
  inDistHours: () => true, inOpenHours: () => true, deferStaffNotify: () => {},
  hoursLabel: () => ({ en: 'x', bm: 'x' }),
};
let pass = 0, fail = 0;
const ok = (l, c) => { c ? pass++ : fail++; console.log((c ? '  ✅ ' : '  ❌ ') + l); };
const wait = ms => new Promise(r => setTimeout(r, ms));
let n = 0;
const fresh = () => { const ph = '6012369885' + String(n++).padStart(2, '0'); return { ph, jid: ph + '@s.whatsapp.net' }; };
async function say(c, text){ sent = []; reviewed = []; fr.onMessage({ jid: c.jid, phone: c.ph, kind: 'text', text }); await wait(120); return sent.map(s => s.text).join('\n'); }
const SALES = /berminat motor apa|Which bike are you interested|nak \*beli\* motor|\*buy\* a bike/;

(async () => {
  fr.init(BASE);

  for (const tqCat of ['greeting', 'skip', 'workshop']){
    const svCat = 'workshop';
    console.log(`\n(4) the 6 Oct chat, exactly — "Tq"→${tqCat}, "Nk servis"→${svCat}`);
    aiOverride = { 'Tq': tqCat, 'Nk servis': svCat };
    const c = fresh(); larkRows = [];
    let r = await say(c, 'Morning boss, klu nk service zontes boleh walk in?');
    ok('first message gets the workshop reply', /workshop/i.test(r));
    ok('reply carries all 3 workshop links', /wa\.me\/60105491324/.test(r) && /wa\.me\/60127974828/.test(r) && /wa\.me\/60143593259/.test(r));
    ok('🚨 reply no longer claims "saya dah hantar mesej"', !/dah hantar mesej|passed your message/.test(r));
    ok('group still alerted, and told the numbers were given', reviewed.some(t => /Workshop enquiry/.test(t) && /3 workshop numbers/.test(t) && !/No workshop number is set up/.test(t)));
    r = await say(c, 'Tq');
    ok('🚨 "Tq" → silence, NOT the sales greeting', sent.length === 0 && !SALES.test(r));
    r = await say(c, 'Nk servis');
    ok('🚨 "Nk servis" → no buy-or-sell question, links not resent', !SALES.test(r) && sent.length === 0);
    ok('🚨 …but the group is told the customer is still asking', reviewed.filter(t => /still asking about service/.test(t)).length === 1);
    r = await say(c, 'Nk servis');
    ok('a third service line → no second group alert (once per hand-off)', reviewed.length === 0 && sent.length === 0);
    ok('no Lark lead was created for a service customer', larkRows.length === 0);
  }
  aiOverride = {};

  console.log('\n(3) workshop order');
  let c = fresh();
  let r = await say(c, 'nak servis honda rs150 boleh?');
  ok('Honda bike → Honda Impian listed FIRST', r.indexOf('60143593259') > -1 && r.indexOf('60143593259') < r.indexOf('60105491324') && r.indexOf('60143593259') < r.indexOf('60127974828'));
  c = fresh();
  r = await say(c, 'Morning boss, klu nk service zontes boleh walk in?');
  ok('non-Honda → Kapar, Klang, Honda Impian', r.indexOf('60105491324') < r.indexOf('60127974828') && r.indexOf('60127974828') < r.indexOf('60143593259'));
  c = fresh();
  r = await say(c, 'nak tukar minyak hitam');
  ok('BM reply in Malay', /Terima kasih tuan/.test(r) && /WhatsApp workshop/.test(r));

  console.log('\nnever lose a buyer after a workshop hand-off');
  c = fresh(); larkRows = [];
  await say(c, 'Morning boss, klu nk service zontes boleh walk in?');
  r = await say(c, 'nak beli motor baru, ada lambretta x250?');
  ok('"nak beli motor baru" → a real reply', sent.length >= 1);
  ok('"nak beli motor baru" → Lark lead written', larkRows.length === 1);
  c = fresh(); larkRows = [];
  await say(c, 'Morning boss, klu nk service zontes boleh walk in?');
  r = await say(c, 'saya nak jual motor saya');
  ok('trade-in after workshop → still a sell lead', larkRows.length === 1);

  console.log('\nadmin hand-off had the same hole');
  c = fresh(); larkRows = [];
  r = await say(c, 'tukar nama motor berapa kos');
  ok('admin hand-off reply sent', /admin/i.test(r));
  r = await say(c, 'Tq');
  ok('🚨 "Tq" after admin → silence, not the sales greeting', sent.length === 0);
  r = await say(c, 'nak beli motor baru, ada lambretta x250?');
  ok('buyer after admin → still a lead', larkRows.length === 1);


  // Attack round 2026-10-08 (v1 silenced 74 of these). After a hand-off, every line that is not a
  // pure acknowledgement must get EXACTLY what a fresh customer gets — same replies-or-not, same
  // Lark rows. The only allowed differences: a pure ack (silence) and a repeat WORKSHOP verdict
  // after a workshop hand-off (links not resent, group alerted once).
  console.log('\nattack rows: after a hand-off, a non-ack line is treated exactly like a fresh customer');
  const PROBES = [
    'ada R15 second?', 'model ni ok tak', 'bila boleh tengok motor', 'cash berapa', 'dp brp', 'nak ambil xmax',
    'boss motor tu masih ada?', 'nak tukar motor', 'nak upgrade', 'boleh pakai IC je?',
    'bro saya nak yg merah', 'kalau service mahal sangat, baik saya beli baru', 'kalau servis mahal, baik saya ambil yang lain terus',
    'boleh walk in tengok motor?', 'model ni enjin ok tak', 'enjin xmax ni tahan lama?', 'motor lama saya dah rosak, nak ganti',
    'motor saya rosak teruk, nak tukar je lah', 'brek abs ada model mana?', 'free service untuk xmax macam mana?',
    'warranty enjin brp tahun?', 'ada tayar besar punya model?', 'nak lepaskan motor lama', 'nak let go motor saya',
    'nak ambik motor nmax', 'ada pilihan warna lain?', 'nak tengok unit dulu', 'boss??', 'bro',
    'takde orang contact saya', 'ok set, bila boleh ambil motor?', 'nak cuba bawa dulu boleh?',
    'ada parts original untuk y16 tak? kalau takde nak beli y16 baru je',
    'Zontes 368G enjin dia smooth tak? nak ambik satu', 'xmax brek abs ke?', 'tayar besar motor apa ada?',
  ];
  let diffs = 0, checked = 0;
  for (const kind of ['workshop', 'admin']){
    for (const p of PROBES){
      for (const v of ['product', 'workshop', 'greeting', 'sell', 'chasing']){
        if (kind === 'workshop' && v === 'workshop') continue;   // the one intended difference, tested above
        aiOverride = { [p]: v };
        const c0 = fresh(); larkRows = [];
        await say(c0, p); const r0 = sent.length > 0, l0 = larkRows.length;
        const c1 = fresh();
        await say(c1, kind === 'workshop' ? 'Morning boss, klu nk service zontes boleh walk in?' : 'tukar nama motor berapa kos');
        larkRows = [];
        await say(c1, p); const r1 = sent.length > 0, l1 = larkRows.length;
        checked++;
        if (r0 !== r1 || l0 !== l1){ diffs++; console.log(`     ≠ ${kind} AI=${v} "${p}" control reply=${r0} lark=${l0} | after reply=${r1} lark=${l1}`); }
      }
    }
  }
  aiOverride = {};
  ok(`🚨 0 of ${checked} buyer/trade-in/ping lines differ from a fresh customer after a hand-off`, diffs === 0);

  console.log('\nworkshop chaser reaches a human');
  c = fresh();
  await say(c, 'Morning boss, klu nk service zontes boleh walk in?');
  aiOverride = { 'dah call workshop takde orang angkat': 'workshop', 'workshop tak reply, boleh tolong?': 'workshop' };
  await say(c, 'dah call workshop takde orang angkat');
  ok('"workshop takde orang angkat" → group alerted', reviewed.some(t => /still asking about service/.test(t) && /takde orang angkat/.test(t)));
  aiOverride = {};

  console.log('\npure acks stay silent, pings do not');
  for (const a of ['ok bos', 'terima kasih tuan 🙏', '👍', 'noted with thanks', 'yes', 'Thank you very much', 'thank u so much',
                   'thanks a lot', 'Tq 🙏🏻', '👍🏻', 'Okeyy', 'k', 'ok sy wasap dorang', 'ok nanti call workshop']){
    c = fresh(); await say(c, 'Morning boss, klu nk service zontes boleh walk in?');
    await say(c, a); ok(`"${a}" after hand-off → silent`, sent.length === 0 && reviewed.length === 0);
  }


  console.log('\nrepeat workshop question with price words → no links resent, group told once');
  c = fresh(); await say(c, 'Morning boss, klu nk service zontes boleh walk in?');
  aiOverride = { 'berapa harga servis?': 'workshop', 'ada stock spare part rs150?': 'workshop' };
  r = await say(c, 'berapa harga servis?');
  ok('"berapa harga servis?" (workshop) → links not resent, group told', sent.length === 0 && reviewed.length === 1);
  r = await say(c, 'ada stock spare part rs150?');
  ok('"ada stock spare part rs150?" → silent, no second alert', sent.length === 0 && reviewed.length === 0);
  aiOverride = {};

  console.log('\nHonda detection');
  for (const [t, honda] of [['service rs-x boleh?', true], ['servis pcx160', true], ['x-adv nak servis', true], ['servis rs150r', true],
                            ['servis future 125', true], ['servis wave alpha', true], ['servis y15zr', false], ['servis beat', false]]){
    aiOverride = { [t]: 'workshop' };
    c = fresh(); r = await say(c, t);
    const first = r.indexOf('60143593259') < r.indexOf('60105491324');
    ok(`"${t}" → Honda Impian ${honda ? 'first' : 'last'}`, first === honda);
  }
  aiOverride = {};


  console.log('\nhand-off MID-QUALIFY (real chat 8 Oct): a later "Hello?" is not the bike answer');
  aiOverride = { 'Morning': 'greeting', 'zontes 368g v1 problem, boleh troubleshoot ke?': 'workshop', 'Hello?': 'greeting',
                 'nak ambik xmax': 'product', 'roadtax motor saya dah expired': 'admin' };
  c = fresh(); larkRows = [];
  r = await say(c, 'Morning');
  ok('"Morning" → asked which bike', /berminat motor apa/.test(r));
  r = await say(c, 'zontes 368g v1 problem, boleh troubleshoot ke?');
  ok('mid-qualify service question → workshop links', /wa\.me\/60105491324/.test(r));
  r = await say(c, 'Hello?');
  ok('🚨 "Hello?" → NOT "nak beli atau jual?"', !SALES.test(r) && sent.length === 0);
  ok('no Lark lead from "Hello?"', larkRows.length === 0);
  c = fresh(); larkRows = [];
  await say(c, 'Morning'); await say(c, 'zontes 368g v1 problem, boleh troubleshoot ke?');
  r = await say(c, 'nak ambik xmax');
  ok('🚨 …but "nak ambik xmax" after the links still becomes a lead', larkRows.length === 1);
  console.log('  admin mid-qualify keeps the question open (2026-09-08), same "Hello?" guard');
  c = fresh(); larkRows = [];
  await say(c, 'Morning'); r = await say(c, 'roadtax motor saya dah expired');
  ok('mid-qualify admin question → admin hand-off', /admin/i.test(r) && larkRows.length === 0);
  r = await say(c, 'Hello?');
  ok('🚨 "Hello?" after admin → NOT "nak beli atau jual?"', !SALES.test(r) && sent.length === 0);
  r = await say(c, 'nak ambik xmax');
  ok('a bike named after admin → still a lead', larkRows.length === 1);
  aiOverride = {};


  console.log('\nround 2: after a mid-qualify hand-off, a SHORT real answer is still the answer (same as no hand-off)');
  const SHORT = ['R15', 'Y16', '368', 'RS150', 'nak beli', 'harga berapa?', 'ada stok?', 'yg tu', 'itu', 'Cash', 'jual', 'beli', 'xmax'];
  let d2 = 0;
  for (const kind of ['workshop', 'admin']){
    for (const a of SHORT){
      aiOverride = { 'Morning': 'greeting', 'zontes 368g v1 problem, boleh troubleshoot ke?': 'workshop', 'tukar nama motor berapa kos': 'admin' };
      const c0 = fresh(); larkRows = [];
      await say(c0, 'Morning'); await say(c0, a); const r0 = sent.length > 0, l0 = larkRows.length;
      const c1 = fresh();
      await say(c1, 'Morning'); await say(c1, kind === 'workshop' ? 'zontes 368g v1 problem, boleh troubleshoot ke?' : 'tukar nama motor berapa kos');
      larkRows = []; await say(c1, a); const r1 = sent.length > 0, l1 = larkRows.length;
      if (r0 !== r1 || l0 !== l1){ d2++; console.log(`     ≠ ${kind} "${a}" control reply=${r0} lark=${l0} | after reply=${r1} lark=${l1}`); }
    }
  }
  aiOverride = {};
  ok(`🚨 0 of ${SHORT.length * 2} short answers differ after a mid-qualify hand-off`, d2 === 0);

  console.log('\nround 2: "call me" is a request to us, not a thank-you');
  for (const a of ['ok call saya', 'ok whatsapp saya', 'ok contact saya', 'ya text saya', 'ok you call', 'Tq boss, nanti saya call']){
    c = fresh(); await say(c, 'Morning boss, klu nk service zontes boleh walk in?');
    const c0 = fresh(); await say(c0, a); const r0 = sent.length > 0;
    await say(c, a); ok(`"${a}" after hand-off → handled like a fresh customer (not silenced as an ack)`, (sent.length > 0) === r0);
  }

  console.log('\nnothing changes without a hand-off');
  c = fresh();
  r = await say(c, 'Hi');
  ok('a plain "Hi" from a new customer still gets the sales greeting', /berminat motor apa/.test(r));

  console.log('\nmid-qualify: "nak servis" is not the answer to "which bike?"');
  c = fresh(); larkRows = [];
  await say(c, 'Hi');
  aiOverride = { 'nak servis je': 'workshop' };
  r = await say(c, 'nak servis je');
  ok('gets the workshop links, not a sales rep', /wa\.me\/60105491324/.test(r) && larkRows.length === 0);
  aiOverride = {};

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
