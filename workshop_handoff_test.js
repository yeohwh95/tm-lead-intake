/**
 * Workshop hand-off (2026-10-08). Two things, both from TM's project group:
 *  (3) TM sent the 3 workshop numbers; Benjamin chose CUSTOMER PICKS — the reply carries all three
 *      links, Honda Impian first for a Honda, and never claims a message was passed on.
 *  (4) Real chat +60123698855, 6 Oct 11:34–11:37: service question → workshop reply → "Tq" got the
 *      SALES greeting → "Nk servis" got "nak beli atau jual?". After a hand-off the bot must stay
 *      quiet on thanks / more service talk, but a real buyer must still become a lead.
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

  for (const [tqCat, svCat] of [['greeting', 'workshop'], ['greeting', 'greeting'], ['skip', 'product']]){
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
    ok('🚨 "Nk servis" → no buy-or-sell question', !SALES.test(r));
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
