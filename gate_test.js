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
// Cumulative, NEVER reset — `sent` is cleared between sections, but the dash regression at the
// bottom has to see every message the gate ever produced (ask, why, username, got, release).
const allSent = [];
const reset = () => { sent = []; assigned = []; larkRows = []; logs = [];
  const st = fr._state(); st.awaitingPhone = {}; st.greeted = {}; st.pending = {}; };

// ⚠️ `init()` REPLACES the dep bag, it does not merge. A test that wants one dep changed must
// re-init with the whole set or the module loses waSend/log and dies on the next message.
const BASE_DEPS = {
  waSend: async (to, text) => { sent.push({ to, text }); allSent.push({ to, text }); },
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
};
const initWith = (overrides) => fr.init({ ...BASE_DEPS, ...(overrides || {}) });
initWith();

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

  // ── 8b. THE 2026-08-05 BUG: the bot's own reply must not deafen it ─────────
  // `markHuman` fires on any fromMe message, and the bot's OWN sends echo back as fromMe — so the
  // chat is flagged human-owned the instant the bot asks. The customer's number was then dropped
  // at the top of onMessage, before buffering, and the lead timed out as "never answered".
  // Four real TM customers replied with a number inside ONE MINUTE and every one was discarded.
  // ⚠️ `humanTouched` is a module-level Set that reset() does NOT clear (by design — it mirrors
  // production, where it only clears on restart). So each case below uses its OWN jid; reusing
  // one would leave it flagged and the next hold would never be created.
  console.log('\n8b. Bot\'s own send marks the chat — the held customer must still be heard');
  const LID_A = '111111111111111@lid', LID_B = '222222222222222@lid';
  reset();
  fr.onMessage({ jid: LID_A, phone: '', kind: 'text', text: 'nak tanya harga Zontes' });
  await wait(80);
  fr.markHuman(LID_A);                     // exactly what the bot's own outbound echo does
  ok('still held after the bot replied', fr.gateStatus().length === 1);
  sent = []; assigned = [];
  fr.onMessage({ jid: LID_A, phone: '', kind: 'text', text: '014-8369971' });
  await wait(80);
  ok('\u{1F6A8} the number is HEARD, not dropped', assigned.length === 1);
  ok('\u{1F6A8} released on the customer, not a timeout', fr.gateStatus().length === 0);
  ok('the real number reaches the lead', /60148369971/.test(JSON.stringify(assigned)));
  // A username must survive the same path — @Keekzy77 was one of the real dropped replies.
  reset();
  fr.onMessage({ jid: LID_B, phone: '', kind: 'text', text: 'nak tanya harga Zontes' });
  await wait(80);
  fr.markHuman(LID_B);
  sent = []; assigned = [];
  fr.onMessage({ jid: LID_B, phone: '', kind: 'text', text: '@Keekzy77' });
  await wait(80);
  ok('\u{1F6A8} a username is heard too', assigned.length === 1
     && /keekzy77/i.test(JSON.stringify(assigned)));

  // Leave a fresh hold on LID for case 9, which expects one.
  reset();
  fr.onMessage({ jid: LID, phone: '', kind: 'text', text: 'nak tanya harga Zontes' });
  await wait(80);

  // ── 9. A human taking over wins ────────────────────────────────────────────
  console.log('\n9. Human replies during the hold — bot backs off');
  fr.markHuman(LID);
  fr._state().awaitingPhone[LID].ts = Date.now() - 61000;
  assigned = [];
  // Count BEFORE, not an absolute total — the event log is append-only and survives across test
  // runs, so any fixed expected count passes once and then rots.
  const takeoversBefore = fr.gateReadEvents(500).filter(e => e.kind === 'human_takeover').length;
  await fr.gateSweep();
  ok('\u{1F6A8} does NOT double-handle a chat a human owns', assigned.length === 0);
  ok('hold dropped', fr.gateStatus().length === 0);
  // Silently dropping the hold made the lead read as stuck forever in /gate-status — 2 of TM's
  // first 4 gated leads ended this way (2026-08-05), so the outcome must be recorded, not just
  // logged. A real ending that leaves no trace is indistinguishable from a lost lead.
  const takeovers = fr.gateReadEvents(500).filter(e => e.kind === 'human_takeover');
  ok('\u{1F6A8} the takeover is RECORDED, not just logged',
     takeovers.length === takeoversBefore + 1);
  ok('it names the chat it ended', takeovers.at(-1) && takeovers.at(-1).chat_id === LID);

  // ── 10. A released lead must say WHY nobody's name is on it ────────────────
  // 2026-08-06: the event log wrote an empty salesperson for three different situations — a rep
  // holds it, it is parked until the 9am drain, and NOBODY took it. All three printed the same
  // dash in /gate-status, so a lead sitting with no owner (which nothing will ever chase, because
  // the SLA sweep skips ownerless CRM rows) looked exactly like a routine overnight park.
  console.log('\n10. The reason there is no salesperson name is recorded');
  const lastGate = () => fr.gateReadEvents(500).filter(e => ['assigned','timeout'].includes(e.kind)).at(-1);

  const LID_C = '333333333333333@lid';
  reset();
  fr.onMessage({ jid: LID_C, phone: '', kind: 'text', text: 'nak tanya harga Zontes' });
  await wait(80);
  fr.onMessage({ jid: LID_C, phone: '', kind: 'text', text: '0169559643' });
  await wait(80);
  ok('a normal release is marked assigned', lastGate() && lastGate().assign_state === 'assigned');
  ok('and still carries the rep name', lastGate().salesperson === 'Nazrin');

  // Outside the assignment window the staff half is queued — the customer is told someone will
  // follow up, but no rep has it yet. That is NOT the same as a failure and must not read as one.
  const parked = [];
  initWith({ inDistHours: () => false, deferStaffNotify: e => parked.push(e) });
  const LID_D = '444444444444444@lid';
  reset();
  fr.onMessage({ jid: LID_D, phone: '', kind: 'text', text: 'nak tanya harga Zontes' });
  await wait(80);
  fr.onMessage({ jid: LID_D, phone: '', kind: 'text', text: '0102360706' });
  await wait(80);
  ok('\u{1F6A8} an after-hours release is marked PARKED, not failed', lastGate().assign_state === 'parked');
  ok('the parked entry carries the chat so the drain can close it out',
     parked.length === 1 && parked[0].jid === LID_D && parked[0].gated === true);

  // The morning drain writes the ending back — without this the lead's last word in the log is
  // "parked", and finding out who ended up with the customer means opening the CRM by hand.
  fr.gateLogParked(LID_D, { salesperson: 'Fazwan', parked_seconds: 57600, reason: 'released from overnight park' });
  const release = fr.gateReadEvents(500).filter(e => e.kind === 'assigned_after_park').at(-1);
  ok('the drain closes the story with a name', release && release.salesperson === 'Fazwan');
  ok('and says how long the customer waited', release.parked_seconds === 57600);

  // The failure the dash was hiding: an empty pool means the CRM row has no owner at all.
  initWith({ assignLeads: (leads) => leads.map(l => ({ ...l, assignee: '', staff: null })) });
  const LID_E = '555555555555555@lid';
  reset();
  fr.onMessage({ jid: LID_E, phone: '', kind: 'text', text: 'nak tanya harga Zontes' });
  await wait(80);
  fr.onMessage({ jid: LID_E, phone: '', kind: 'text', text: '0148369971' });
  await wait(80);
  ok('\u{1F6A8} nobody taking the lead is recorded as no_rep', lastGate().assign_state === 'no_rep');
  ok('and it is loud in the log', logs.some(l => /NO SALESPERSON/.test(l)));

  // ⚠️ SUITE-WIDE DASH REGRESSION (2026-08-14). This file drives gateAsk / gateWhy /
  // gateUsername / gateGot / gateGotUser through REAL flows in both the ask and release paths —
  // exactly the copy the hand-written sweep inventory had missed two lines of.
  {
    const dashed = allSent.filter(s => /—/.test(s.text));
    ok(`🚨 no em dash in ANY of the ${allSent.length} gate sends`
       + (dashed.length ? ` — first: "${dashed[0].text.slice(0, 80)}"` : ''), dashed.length === 0);
    ok('the phone/username ask really was exercised', allSent.some(s => /Satu je bos|One thing ya/.test(s.text)));
    ok('the why-explainer really was exercised', allSent.some(s => /sorok nombor|hide-my-number/.test(s.text)));
    ok('the username hand-off really was exercised', allSent.some(s => /pass username tuan|Passing your username/.test(s.text)));
  }

  console.log(`\n${'='.repeat(54)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(54)}`);
  try { require('fs').unlinkSync(process.env.FR_STATE_FILE); } catch {}
  process.exit(fail ? 1 : 0);
})();
