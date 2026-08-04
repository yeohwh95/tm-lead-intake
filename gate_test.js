/**
 * Phone-gate tests for TM — drives firstresponse.onMessage/flush through injected deps.
 *
 * TM is the worst-affected client (14% of chats have no phone as of 2026-08-04) and the most
 * dangerous to break: real SLA timers, Lark rows and salesperson DMs hang off assign().
 * So these care most about (a) a normal lead with a phone assigning exactly as before, and
 * (b) a no-phone lead never reaching assign() until we have a number or the hold expires.
 *
 * Run: node gate_test.js
 */
process.env.FIRSTRESPONSE_ON = '1';
process.env.FR_DEBOUNCE_MS = '5';        // flush almost immediately
process.env.FR_GATE_MS = '60000';        // 60s hold so the timeout path is testable
process.env.FR_STATE_FILE = require('path').join(require('os').tmpdir(), `fr_gate_test_${process.pid}.json`);

const fr = require('./firstresponse.js');

let sent = [], assigned = [], larkRows = [], logs = [];
const reset = () => { sent = []; assigned = []; larkRows = []; logs = [];
  const st = fr._state(); st.awaitingPhone = {}; st.greeted = {}; st.pending = {}; };

fr.init({
  waSend: async (to, text) => { sent.push({ to, text }); },
  assignLeads: (leads) => leads.map(l => ({ ...l, assignee: 'Nazrin',
    staff: { name: 'Nazrin', phone: '+60123456789', openId: 'ou_x' } })),
  larkWriteLead: async (l) => { larkRows.push(l); assigned.push(l); return 'rec1'; },
  notifyStaff: async () => 'dm1',
  sla: { register: () => {}, inHours: () => true },
  getUnavailable: async () => [],
  log: (...a) => logs.push(a.join(' ')),
  isStaffPhone: () => false,
  wooCheckStock: async () => null,
  aiClassify: async () => null,          // force the regex classifier — deterministic, offline
  inDistHours: () => true,
  inOpenHours: () => true,
  deferStaffNotify: () => {},
  hoursLabel: () => ({ en: 'Mon–Sat, 9am–6pm', bm: 'Isnin–Sabtu, 9 pagi–6 petang' }),
});

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { pass++; console.log('  ✅ ' + label); }
  else { fail++; console.log('  ❌ ' + label); } };
const wait = ms => new Promise(r => setTimeout(r, ms));
const texts = () => sent.map(s => s.text).join('\n---\n');

const LID = '206218996011144@lid';
const LIDD = '206218996011144';

(async () => {
  // ── 1. Normal lead with a phone — untouched ────────────────────────────────
  console.log('\n1. Normal lead WITH a phone — behaves exactly as before');
  reset();
  fr.onMessage({ jid: '60111222333@s.whatsapp.net', phone: '60111222333', kind: 'text',
                 text: 'nak tanya harga Zontes 368G' });
  await wait(120);
  ok('assigned immediately', assigned.length === 1);
  ok('salesperson named in the reply', /NAZRIN/i.test(texts()));
  ok('no phone ask sent', !/nombor telefon tuan|phone number/i.test(texts()));
  ok('nothing held', fr.gateStatus().length === 0);

  // ── 2. No phone at all — HELD ──────────────────────────────────────────────
  console.log('\n2. Privacy lead with NO phone — held, not assigned');
  reset();
  fr.onMessage({ jid: LID, phone: '', kind: 'text', text: 'nak tanya harga Zontes 368G' });
  await wait(120);
  ok('\u{1F6A8} assign() never reached — no Lark row, no SLA, no DM', assigned.length === 0);
  ok('held', fr.gateStatus().length === 1);
  ok('customer still got a real answer', sent.length >= 2);
  ok('then asked for a number', /nombor telefon tuan|phone number/i.test(texts()));
  ok('\u{1F6A8} no salesperson named while unassigned', !/NAZRIN/i.test(texts()));
  ok('sent to the raw @lid (never a fabricated phone JID)',
     sent.every(s => s.to === LID) && !sent.some(s => s.to.includes(LIDD + '@s.whatsapp.net')));

  // ── 3. Customer gives the number ───────────────────────────────────────────
  console.log('\n3. Held customer replies with a number');
  sent = [];
  fr.onMessage({ jid: LID, phone: '', kind: 'text', text: 'ok 012-345 6789' });
  await wait(120);
  ok('assigned now', assigned.length === 1);
  ok('real phone on the Lark row', larkRows[0] && larkRows[0].phone === '60123456789');
  ok('\u{1F6A8} LID digits never written as a phone', !larkRows.some(r => String(r.phone).includes(LIDD)));
  ok('thanked the customer', /terima kasih|thank you/i.test(texts()));
  ok('salesperson now named', /NAZRIN/i.test(texts()));
  ok('hold cleared', fr.gateStatus().length === 0);

  // ── 4. "Why do you need it?" ───────────────────────────────────────────────
  console.log('\n4. Held customer pushes back');
  for (const [probe, label] of [['kenapa nak nombor saya', 'Malay kenapa'],
                                ['why you need my number', 'English why'],
                                ['scam ke ni', 'scam accusation']]) {
    reset();
    fr.onMessage({ jid: LID, phone: '', kind: 'text', text: 'nak tanya harga Zontes' });
    await wait(80); sent = [];
    fr.onMessage({ jid: LID, phone: '', kind: 'text', text: probe });
    await wait(80);
    ok(`${label} → explains WhatsApp's setting`, /username|sorok nombor|hide-my-number/i.test(texts()));
    ok(`${label} → still not assigned`, assigned.length === 0);
  }

  // ── 5. The real-world case: customer offers a username ─────────────────────
  console.log('\n5. Customer offers their username (seen live 2026-08-04)');
  reset();
  fr.onMessage({ jid: LID, phone: '', kind: 'text', text: 'nak tanya harga Zontes' });
  await wait(80); sent = [];
  fr.onMessage({ jid: LID, phone: '', kind: 'text', text: 'U can find my username to contact me' });
  await wait(80);
  ok('asks them to type the username', /username/i.test(texts()));
  ok('does NOT repeat the same phone request', !/Boleh reply nombor telefon tuan\?$/.test(texts().trim()));
  ok('still held', fr.gateStatus().length === 1);

  // ── 5b. …then actually types it → the hold releases ────────────────────────
  // Benjamin, 2026-08-04: either identifier is enough. This is the full live sequence — refuse
  // the number, offer the username, get asked to type it, type it, get assigned.
  console.log('\n5b. Customer types the username → assigned');
  sent = [];
  fr.onMessage({ jid: LID, phone: '', kind: 'text', text: 'Nataliewpe' });
  await wait(80);
  ok('bare handle accepted once we asked for one', assigned.length === 1);
  ok('hold released', fr.gateStatus().length === 0);
  ok('the handle reaches the lead', /nataliewpe/i.test(JSON.stringify(assigned)));
  ok('\u{1F6A8} it is labelled as NOT dialable', /not dialable/i.test(JSON.stringify(assigned)));
  ok('\u{1F6A8} the phone field stays empty — never a handle',
     assigned.every(a => !a.phone || !/[a-z]/i.test(String(a.phone))));
  ok('customer told the advisor follows up in this chat', /chat|advisor/i.test(texts()));

  // An '@handle' works on the FIRST reply, with no preceding "please type it" ask.
  console.log('\n5c. Customer leads with @handle');
  reset();
  fr.onMessage({ jid: LID, phone: '', kind: 'text', text: 'nak tanya harga Zontes' });
  await wait(80); sent = [];
  fr.onMessage({ jid: LID, phone: '', kind: 'text', text: 'im @natalie_wpe' });
  await wait(80);
  ok('@handle releases the hold immediately', assigned.length === 1 && fr.gateStatus().length === 0);
  ok('handle normalised to lowercase', /natalie_wpe/.test(JSON.stringify(assigned)));

  // The guard that matters most: an ordinary reply must never be filed as somebody's handle.
  console.log('\n5d. An ordinary reply is never mistaken for a handle');
  reset();
  fr.onMessage({ jid: LID, phone: '', kind: 'text', text: 'nak tanya harga Zontes' });
  await wait(80); sent = [];
  fr.onMessage({ jid: LID, phone: '', kind: 'text', text: 'zontes' });
  await wait(80);
  ok('\u{1F6A8} a bare product word does NOT release the hold',
     assigned.length === 0 && fr.gateStatus().length === 1);
  reset();
  fr.onMessage({ jid: LID, phone: '', kind: 'text', text: 'nak tanya harga Zontes' });
  await wait(80); sent = [];
  fr.onMessage({ jid: LID, phone: '', kind: 'text', text: 'email saya ben@gmail.com' });
  await wait(80);
  ok('\u{1F6A8} an email address is never read as a handle',
     assigned.length === 0 && fr.gateStatus().length === 1);

  // ── 6. Never nag a third time ──────────────────────────────────────────────
  console.log('\n6. Message budget');
  reset();
  fr.onMessage({ jid: LID, phone: '', kind: 'text', text: 'nak tanya harga Zontes' });
  await wait(80);
  fr.onMessage({ jid: LID, phone: '', kind: 'text', text: 'U can find my username to contact me' });
  await wait(80);
  sent = [];
  fr.onMessage({ jid: LID, phone: '', kind: 'text', text: 'still not giving lah' });
  await wait(80);
  ok('\u{1F6A8} silent after two asks', sent.length === 0);
  ok('still held, still unassigned', fr.gateStatus().length === 1 && assigned.length === 0);

  // ── 7. Nobody is abandoned ─────────────────────────────────────────────────
  console.log('\n7. Hold expires → assigned anyway');
  const st = fr._state();
  st.awaitingPhone[LID].ts = Date.now() - 61000;
  sent = [];
  await fr.gateSweep();
  ok('assigned at timeout', assigned.length === 1);
  ok('\u{1F6A8} phone left blank — nothing invented', larkRows[0] && !larkRows[0].phone);
  ok('customer told who has them', /NAZRIN/i.test(texts()));
  ok('hold cleared', fr.gateStatus().length === 0);

  // ── 8. Timer does not fire early ───────────────────────────────────────────
  console.log('\n8. Sweep leaves a fresh hold alone');
  reset();
  fr.onMessage({ jid: LID, phone: '', kind: 'text', text: 'nak tanya harga Zontes' });
  await wait(80);
  await fr.gateSweep();
  ok('still held', fr.gateStatus().length === 1);
  ok('not assigned', assigned.length === 0);

  // ── 9. A human taking over wins ────────────────────────────────────────────
  console.log('\n9. Human replies during the hold — bot backs off');
  fr.markHuman(LID);
  fr._state().awaitingPhone[LID].ts = Date.now() - 61000;
  assigned = [];
  await fr.gateSweep();
  ok('\u{1F6A8} does NOT double-handle a chat a human owns', assigned.length === 0);
  ok('hold dropped', fr.gateStatus().length === 0);

  console.log(`\n${'='.repeat(54)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(54)}`);
  try { require('fs').unlinkSync(process.env.FR_STATE_FILE); } catch {}
  process.exit(fail ? 1 : 0);
})();
