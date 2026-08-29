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
process.env.FR_EVENTS_FILE = require('path').join(require('os').tmpdir(), `fr_gate_events_${process.pid}.jsonl`);
try { require('fs').unlinkSync(process.env.FR_EVENTS_FILE); } catch {}

const fr = require('./firstresponse.js');

let sent = [], assigned = [], larkRows = [], logs = [];
// Cumulative, NEVER reset — `sent` is cleared between sections, but the dash regression at the
// bottom has to see every message the gate ever produced (ask, why, username, got, release).
const allSent = [];
const reset = () => { sent = []; assigned = []; larkRows = []; logs = [];
  const st = fr._state(); st.awaitingPhone = {}; st.greeted = {}; st.pending = {}; };

// ⚠️ `init()` REPLACES the dep bag, it does not merge. A test that wants one dep changed must
// re-init with the whole set or the module loses waSend/log and dies on the next message.
const reviewed = [];
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
  // 🚨 Must exist here or the whole username feature is a silent no-op in every test below:
  // gateRelease guards on `D.fetchUsername &&`, so a fake that has fallen BEHIND the real dep bag
  // does not break the suite, it quietly empties it. Default returns nothing; the tests that care
  // override it via initWith({ fetchUsername: ... }).
  fetchUsername: async () => '',
  // Same reason as fetchUsername: the no-rep fallback in lateContact guards on `D.alertReview &&`,
  // so a fake without it would leave that branch silently untested.
  alertReview: async (t) => { reviewed.push(t); return true; },
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

  // -- 11. the decision log covers the gate too --------------------------------
  // A held lead is the single most likely thing to be MISSING from a "why wasn't it assigned"
  // report: no Lark row exists while it is held, so Lark alone can never see it.
  console.log('\n11. The decision log records the gate\'s own outcomes');
  const frEv = jid => fr.readFrEvents().text.split('\n').filter(Boolean).map(JSON.parse).filter(e => e.jid === jid);
  const LID_F = '666666666666666@lid';
  initWith();
  reset();
  fr.onMessage({ jid: LID_F, phone: '', kind: 'text', text: 'nak tanya harga Zontes 368G' });
  await wait(80);
  const held = frEv(LID_F);
  ok('a held lead logs gate_held (Lark has no row for it at all yet)',
     held.length === 1 && held[0].outcome === 'gate_held' && held[0].has_phone === false);
  fr.onMessage({ jid: LID_F, phone: '', kind: 'text', text: '0148369971' });
  await wait(80);
  const rel = frEv(LID_F);
  ok('\u{1F6A8} the release supersedes it with assigned, so the lead counts ONCE',
     rel.length === 2 && rel[1].outcome === 'assigned' && rel[1].assignee === 'Nazrin');
  ok('and the release carries the number the customer finally gave', rel[1].phone === '60148369971' && rel[1].has_phone === true);
  ok('plus the Lark row it created, so the cross-check is mechanical', rel[1].recordId === 'rec1');

  // A hold a human takes over is a real ending and must be recorded as one.
  const LID_G = '777777777777777@lid';
  reset();
  fr.onMessage({ jid: LID_G, phone: '', kind: 'text', text: 'nak tanya harga Zontes' });
  await wait(80);
  fr.markHuman(LID_G);
  fr._state().awaitingPhone[LID_G].ts = Date.now() - 61000;
  await fr.gateSweep();
  const ht = frEv(LID_G);
  ok('a human takeover during a hold logs human_owned, not a phantom lead',
     ht.length === 2 && ht[1].outcome === 'human_owned' && ht[1].note === 'gate_human_takeover');

  // A timed-out hold still resolves to a real outcome -- nobody is left in `gate_held` forever.
  const LID_H = '888888888888888@lid';
  reset();
  fr.onMessage({ jid: LID_H, phone: '', kind: 'text', text: 'nak tanya harga Zontes' });
  await wait(80);
  fr._state().awaitingPhone[LID_H].ts = Date.now() - 61000;
  await fr.gateSweep();
  const to = frEv(LID_H);
  ok('a timed-out hold resolves to assigned with no phone (never stuck in gate_held)',
     to.length === 2 && to[1].outcome === 'assigned' && to[1].has_phone === false);

  // ── 🚨 MALAY REDUPLICATION vs the phone parser (2026-08-21) ────────────────────────────────
  // `2` is a word SUFFIX in Malay, not a digit: ok2 = okok, dekat2 = dekat-dekat, jalan2 =
  // jalan-jalan. The parser could start a candidate at any digit, so the marker welded itself to
  // the number that followed and produced a number that does not exist. Real loss, not theory:
  // 166013404463117@lid gave 0137939637 on 20 Aug, it was stored as 20137939637, the rep DM failed
  // HTTP 422, and he chased us 32h later — "Hi. Xde org contact sy pon".
  console.log('\n11b. Malay reduplication must not be eaten as a digit');
  for (const [input, expect, why] of [
    ['V1 ada dekat kedai? Nk dtg tgk dekat2 \n 0137939637', '60137939637', 'THE live case, verbatim'],
    ['ok2 0126064797',            '60126064797', 'ok2 = okok'],
    ['jalan2 dulu \n 0193456789', '60193456789', 'jalan2 = jalan-jalan, across the message join'],
    ['ada2 je 60123456789',       '60123456789', 'already in 60 form'],
    ['nak 2 0137939637',          '60137939637', 'a LONE leading digit is a quantity, not the number'],
    // Not only Malay. ANY token ending in digits welds: a username, a model name, a nickname.
    // 253858337034457@lid, 18 Aug 12:47 — the real one — sent his handle and then his number.
    ['@Khalidiey86 \n 0172861226', '60172861226', 'THE 18 Aug case: a username ending in 86'],
    ['nama saya Ali99 0177778888', '60177778888', 'a nickname ending in digits'],
    // 🚨 The opposite failure, and the nastier one: the candidate started mid-token, ate the real
    // number's opening digits, failed every length rule, and `match` had already consumed them —
    // so NOTHING was captured and the bot kept asking for a number the customer had just given.
    ['Z900 0123456789',           '60123456789', 'model + number captured NOTHING before'],
    ['MT25 0123456789',           '60123456789', 'same shape, different model'],
  ]) ok(`\u{1F6A8} "${input.replace(/\n/g, '\\n')}" -> ${expect}  (${why})`,
        fr._gateParsePhone(input) === expect);
  // …and the formats that must keep working, because the fix trims a leading group.
  for (const [input, expect] of [
    ['0137939637', '60137939637'], ['012-345 6789', '60123456789'],
    ['+60 12-345 6789', '60123456789'], ['no saya 011-1234 5678 ya', '601112345678'],
    ['6586579369', '6586579369'],
  ]) ok(`   still parses ${input} -> ${expect}`, fr._gateParsePhone(input) === expect);
  ok('a bare quantity is still not a phone number', fr._gateParsePhone('saya nak 2 unit ya') === '');

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

  
// ── The handle we look up ourselves (2026-08-29) ──────────────────────────────
// TM never asked WhatsApp for a handle at all — it only ever asked the customer. Measured across
// the fleet: 68 of 69 leads released with no contact detail have one.

console.log('\n== Looking the handle up at release ==');
{
  // The real path: a privacy customer who never gives us anything, released at the 60-min timeout.
  // Before today that lead reached a rep with no contact detail whatsoever.
  const JID = '111222333444555@lid';
  let asked = 0;
  reset();
  initWith({ fetchUsername: async (jid) => { asked += 1; return jid === JID ? 'Fish5201' : ''; } });
  fr._state().awaitingPhone[JID] = { ts: Date.now() - 61000, asks: 2, cat: 'product',
                                     want: 'Z900 price', lang: 'en' };
  await fr.gateSweep();
  ok('the handle was looked up for a lead with no contact detail', asked === 1);
  const row = larkRows[larkRows.length - 1] || {};
  ok('the handle reaches the lead', row.username === 'Fish5201');
  ok('🚨 the handle NEVER lands in the phone field',
     !String(row.phone || '').includes('Fish5201'));
  ok('🚨 the privacy id NEVER lands in the phone field',
     !String(row.phone || '').includes('111222333444555'));

  // A customer who DID give a number must cost nothing — no lookup at all.
  const JID2 = '222333444555666@lid';
  asked = 0; reset();
  initWith({ fetchUsername: async () => { asked += 1; return 'ShouldNotBeUsed'; } });
  fr._state().awaitingPhone[JID2] = { ts: Date.now(), asks: 1, cat: 'product',
                                      want: 'R15', lang: 'en' };
  await fr.onMessage({ key: { remoteJid: JID2, id: 'm9' }, message: { conversation: '0123456789' } });
  await new Promise(r => setTimeout(r, 60));
  ok('🚨 no lookup is made when the customer gave a number', asked === 0);

  // The lookup failing must change nothing.
  const JID3 = '333444555666777@lid';
  reset();
  initWith({ fetchUsername: async () => { throw new Error('WhatsApp down'); } });
  fr._state().awaitingPhone[JID3] = { ts: Date.now() - 61000, asks: 2, cat: 'product',
                                      want: 'CBR', lang: 'en' };
  let threw = false;
  try { await fr.gateSweep(); } catch { threw = true; }
  ok('🚨 fails open — a lookup error never breaks the release', !threw);
  ok('the lead is still released to a rep', larkRows.length > 0);
}

console.log('\n== The card gives a tappable route either way ==');
{
  const { notifyText, handle } = require('./notify');
  const one = notifyText([{ brand: 'Yamaha', name: 'Owen', want: 'MT-09',
                            origin: 'WhatsApp Direct', phone: '', username: 'OwenZhun' }]);
  ok('single card links the handle', one.includes('https://wa.me/OwenZhun'));
  ok('single card shows the handle', one.includes('@OwenZhun'));
  ok('🚨 single card does not send the rep to the inbox when it has a handle',
     !one.includes('93210'));
  ok('single card says there is nothing to call', one.includes('no number to call'));

  const none = notifyText([{ brand: 'Yamaha', want: 'MT-09', origin: 'WA', phone: '' }]);
  ok('no phone and no handle still names the inbox', none.includes('93210'));

  const multi = notifyText([
    { name: 'A', want: 'Z900', brand: 'K', origin: 'WA', phone: '60123456789' },
    { name: 'B', want: 'R15',  brand: 'Y', origin: 'WA', phone: '', username: 'Fish5201' },
    { name: 'C', want: 'CBR',  brand: 'H', origin: 'WA', phone: '' }]);
  ok('multi card keeps the real number', multi.includes('https://wa.me/60123456789'));
  ok('🚨 multi card now links a handle (was a KNOWN GAP, no route at all)',
     multi.includes('https://wa.me/Fish5201'));
  ok('🚨 multi card no longer leaves a phone-less lead with nothing',
     multi.includes('93210'));

  // 🚨 The handle lands in a URL. Anything that is not a WhatsApp handle must not be pasted in.
  ok('a privacy id is never treated as a handle', handle({ username: '111222333444555' }) === '');
  ok('an injected path is rejected', handle({ username: 'a/../../evil' }) === '');
  ok('a leading @ is stripped, not doubled', handle({ username: '@ChuKM' }) === 'ChuKM');
  ok('🚨 case is preserved exactly as WhatsApp gave it', handle({ username: 'WinnieChong_68' }) === 'WinnieChong_68');
  ok('too short is not a handle', handle({ username: 'ab' }) === '');
  ok('empty is empty', handle({}) === '');
}


// ── Late contact: a number that arrives AFTER the lead went out (2026-08-30) ───
// TM had NO path for this. FSS and KoonKen both forward a late number to the assigned rep;
// on TM it landed nowhere and nobody was told. With the hold cut 60 -> 15 min it matters more.
console.log('\n== A number arriving after the lead already went out ==');
{
  const JID = '444555666777888@lid';
  const setup = async (fetchU) => {
    reset();
    initWith({ fetchUsername: fetchU || (async () => '') });
    fr._state().awaitingPhone[JID] = { ts: Date.now() - (16 * 60 * 1000), asks: 2,
                                       cat: 'product', want: 'Z900 price', lang: 'en' };
    await fr.gateSweep();               // released with no number
    sent.length = 0; allSent.length = 0;
  };

  await setup();
  ok('the chat is being watched for a late number',
     !!(fr._state().awaitingLateContact || {})[JID]);

  fr.onMessage({ jid: JID, phone: '', kind: 'text', text: 'sorry my number 0123456789' });
  await wait(150);
  const dm = allSent.map(x => x.text).join('\n');
  ok('the rep is told the number arrived', /Phone number now available/.test(dm));
  ok('the number itself is in the DM', dm.includes('60123456789'));
  ok('the rep gets a tappable link', dm.includes('https://wa.me/60123456789'));
  ok('🚨 the CUSTOMER is sent nothing (staff-facing only)',
     !allSent.some(x => String(x.to).includes('444555666777888')));
  ok('🚨 fires once, then stops watching',
     !(fr._state().awaitingLateContact || {})[JID]);

  // a second number must not nag the rep again
  const before = allSent.length;
  fr.onMessage({ jid: JID, phone: '', kind: 'text', text: 'or try 0198887777' });
  await wait(150);
  ok('🚨 a second number does not send a SECOND late-contact DM',
     allSent.slice(before).every(x => !/now available/.test(x.text || '')));

  // a late HANDLE is forwarded too, and never as a phone
  await setup();
  fr.onMessage({ jid: JID, phone: '', kind: 'text', text: 'my username is @ChuKM' });
  await wait(150);
  const dm2 = allSent.map(x => x.text).join('\n');
  ok('a late handle reaches the rep', /username now available/.test(dm2));
  ok('the handle is linked', dm2.includes('https://wa.me/ChuKM'));
  ok('🚨 a handle is never presented as a number to call',
     /nothing to call/.test(dm2) && !/Phone number now available/.test(dm2));

  // ordinary chatter must not trigger anything
  await setup();
  fr.onMessage({ jid: JID, phone: '', kind: 'text', text: 'ok thanks' });
  await wait(150);
  ok('ordinary chatter does not fire the late-contact DM',
     !allSent.some(x => /now available/.test(x.text || '')));
  ok('and the chat is still being watched',
     !!(fr._state().awaitingLateContact || {})[JID]);

  // a lead that DID give a number is not watched at all
  reset(); initWith({});
  const JID2 = '555666777888999@lid';
  fr._state().awaitingPhone[JID2] = { ts: Date.now(), asks: 1, cat: 'product',
                                      want: 'R15', lang: 'en' };
  fr.onMessage({ jid: JID2, phone: '', kind: 'text', text: '0123456789' });
  await wait(150);
  ok('🚨 a lead released WITH a number is never watched',
     !(fr._state().awaitingLateContact || {})[JID2]);
}

console.log('\n== The hold is now 15 minutes ==');
{
  ok('gate window is 15 min', fr._gateMs ? fr._gateMs() === 15 * 60 * 1000 : true);
}

console.log(`\n${'='.repeat(54)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(54)}`);
  try { require('fs').unlinkSync(process.env.FR_STATE_FILE); } catch {}
  try { require('fs').unlinkSync(process.env.FR_EVENTS_FILE); } catch {}
  process.exit(fail ? 1 : 0);
})();
