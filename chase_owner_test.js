/**
 * Chasing alert names the salesperson who holds the customer (Benjamin, 2026-09-29:
 * "can add assigned sales person is who"). Drives firstresponse.onMessage end-to-end.
 */
process.env.FIRSTRESPONSE_ON = '1';
process.env.FR_DEBOUNCE_MS = '5';
const os = require('os'), path = require('path');
process.env.FR_STATE_FILE = path.join(os.tmpdir(), `fr_chase_test_${process.pid}.json`);
process.env.FR_EVENTS_FILE = path.join(os.tmpdir(), `fr_chase_events_${process.pid}.jsonl`);
process.env.GATE_LOG_FILE = path.join(os.tmpdir(), `fr_chase_gate_${process.pid}.jsonl`);
const fr = require('./firstresponse.js');

let sent = [], reviewed = [], logs = [];
const BASE = {
  waSend: async (to, text) => { sent.push({ to, text }); },
  assignLeads: (l) => l, larkWriteLead: async () => 'rec', notifyStaff: async () => 'dm',
  sla: { register: () => {}, inHours: () => true }, getUnavailable: async () => [],
  log: (...a) => logs.push(a.join(' ')), isStaffPhone: () => false, wooCheckStock: async () => null,
  aiClassify: async () => 'chasing', fetchUsername: async () => '',
  alertReview: async (t) => { reviewed.push(t); return true; },
  inDistHours: () => true, inOpenHours: () => true, deferStaffNotify: () => {},
  hoursLabel: () => ({ en: 'x', bm: 'x' }),
};
let pass = 0, fail = 0;
const ok = (l, c) => { c ? pass++ : fail++; console.log((c ? '  ✅ ' : '  ❌ ') + l); };
const wait = ms => new Promise(r => setTimeout(r, ms));
let n = 0;
async function chase(deps){
  sent = []; reviewed = []; logs = [];
  fr.init({ ...BASE, ...deps });
  const ph = '6011310784' + (n++);                 // fresh customer each case (module state persists)
  fr.onMessage({ jid: ph + '@s.whatsapp.net', phone: ph, kind: 'text', text: "I've contacted him, please remind him to check ok" });
  await wait(300);
  return reviewed.join('\n');
}
(async () => {
  console.log('\nchasing alert — assigned salesperson');
  let a = await chase({ leadOwner: async () => ({ name: 'Fazwan', phone: '+60128174828', at: Date.parse('2026-09-29T03:56:00Z'), status: 'Escalated' }) });
  ok('alert still goes out', /Customer is chasing us/.test(a));
  ok('names the salesperson', /Assigned to: \*Fazwan\*/.test(a));
  ok('shows his number in local format', /\(0128174828\)/.test(a));
  ok('shows since when (MYT)', /since 11:56/.test(a));
  ok('closing line names him', /Fazwan needs to contact them today/.test(a));
  ok('customer still got the ack', sent.length >= 1);

  a = await chase({ leadOwner: async () => null });
  ok('no owner in Lark → says so, alert still sent', /not found in Lark/.test(a) && /Customer is chasing us/.test(a));

  a = await chase({ leadOwner: async () => { throw new Error('lark 1254607'); } });
  ok('lookup THROWS → alert still sent, error logged', /Customer is chasing us/.test(a) && logs.some(l => /owner lookup err/.test(l)));

  const t0 = Date.now();
  sent = []; reviewed = []; logs = [];
  fr.init({ ...BASE, leadOwner: () => new Promise(() => {}) });   // never resolves
  fr.onMessage({ jid: '601131078499@s.whatsapp.net', phone: '601131078499', kind: 'text', text: 'belum dapat ws dari SA' });
  await wait(5600);
  ok('lookup HANGS → alert still sent within ~5s', reviewed.some(t => /Customer is chasing us/.test(t)) && Date.now() - t0 < 7000);

  a = await chase({ leadOwner: undefined });
  ok('no dep wired → old alert unchanged (no owner line)', /Customer is chasing us/.test(a) && !/Assigned to/.test(a));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
