// Tests for heartbeat.js — the durable last-inbound marker. Run: node heartbeat_test.js
//
// The failure this module removes: `recent[]` is RAM-only, so a QUIET DAY and a DEAD WASENDER
// SESSION were indistinguishable from inside the bot. These tests pin the three contracts:
// (1) best-effort ALWAYS — a full disk costs a marker, never a message; (2) never a confident
// zero — a missing file in a healthy dir is "fresh", a missing DIRECTORY is an error; (3) the
// quiet measure is BUSINESS hours, so a weekend of silence cannot false-alarm on Monday.
const fs = require('fs'), os = require('os'), path = require('path');
const HB = require('./heartbeat');

let pass = 0, fail = 0;
const ok = (c, n) => { c ? (pass++, console.log('✅', n)) : (fail++, console.log('❌', n)); };

const MYT = 8 * 3600 * 1000;
const myt = (y, mo, d, h, mi) => Date.UTC(y, mo - 1, d, h || 0, mi || 0) - MYT;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-hb-'));

// ── isInboundMessage ───────────────────────────────────────────────────────
{
  const up = (key) => ({ event: 'messages.upsert', data: { messages: { key } } });
  ok(HB.isInboundMessage(up({ remoteJid: '60123@s.whatsapp.net', fromMe: false })) === true,
     'inbound: a customer message counts');
  ok(HB.isInboundMessage(up({ remoteJid: '60123@s.whatsapp.net' })) === true,
     'inbound: fromMe absent counts as inbound (WaSender omits it on some paths)');
  ok(HB.isInboundMessage(up({ remoteJid: '60123@s.whatsapp.net', fromMe: true })) === false,
     'inbound: our own echo does NOT count — the marker means "someone reached us"');
  ok(HB.isInboundMessage({ event: 'messages.upsert', data: { messages: [{ key: { remoteJid: 'x@g.us' } }] } }) === true,
     'inbound: array-shaped messages payloads are read too');
  ok(HB.isInboundMessage({ event: 'session.status', data: {} }) === false,
     'inbound: non-message events do not count — the card says "last inbound MESSAGE" and must mean it');
  ok(HB.isInboundMessage({ event: 'messages.upsert', data: {} }) === false,
     'inbound: a message with no key/jid is not evidence of anything');
  ok(HB.isInboundMessage(null) === false && HB.isInboundMessage({ raw: 'not json' }) === false,
     'inbound: garbage payloads are calmly refused');
}

// ── stamping + throttle + best-effort ──────────────────────────────────────
{
  const file = path.join(tmp, 'last_inbound.json');
  const hb = HB.create({ file, throttleMs: 60000 });
  const msg = { event: 'messages.upsert', data: { messages: { key: { remoteJid: 'c@s.whatsapp.net' } } } };
  const t0 = myt(2026, 8, 17, 10, 0);

  ok(hb.status(t0).at === null, '🚨 no marker yet reads as UNKNOWN (null), never as an age');

  hb.noteInbound(t0, msg);
  ok(JSON.parse(fs.readFileSync(file, 'utf8')).at === t0, 'stamp: first inbound writes the durable marker');
  ok(hb.status(t0 + 5 * 60000).minutesAgo === 5, 'status: minutesAgo from the freshest knowledge');

  // Throttle: a burst inside 60s updates RAM but not the file.
  hb.noteInbound(t0 + 10000, msg);
  ok(JSON.parse(fs.readFileSync(file, 'utf8')).at === t0,
     'throttle: a second message 10s later does NOT rewrite the file (writes ≤ 1/min)');
  ok(hb.status(t0 + 10000).at === t0 + 10000, 'throttle: …but RAM still knows the precise instant');
  hb.noteInbound(t0 + 61000, msg);
  ok(JSON.parse(fs.readFileSync(file, 'utf8')).at === t0 + 61000, 'throttle: past 60s the file catches up');

  // Non-inbound payloads never stamp.
  const before = hb.status(t0 + 61000).at;
  hb.noteInbound(t0 + 120000, { event: 'messages.upsert', data: { messages: { key: { remoteJid: 'x', fromMe: true } } } });
  ok(hb.status(t0 + 120000).at === before, 'stamp: an echo of our own send moves nothing');

  // 🚨 ENOSPC: the write throws, noteInbound must not — same contract as frLogEvent, and the
  // failure is SURFACED on status rather than swallowed invisibly.
  const realWrite = fs.writeFileSync;
  fs.writeFileSync = () => { throw new Error('ENOSPC: no space left on device'); };
  let threw = false;
  try { hb.noteInbound(t0 + 200000, msg); } catch { threw = true; }
  fs.writeFileSync = realWrite;
  ok(!threw, '🚨 a full disk NEVER throws into the message path');
  ok(hb.status(t0 + 200000).at === t0 + 200000, 'ENOSPC: RAM still tracks the message that could not be stamped');
  ok(/ENOSPC/.test(hb.status(t0 + 200000).writeError || ''), 'ENOSPC: and the failure is surfaced, not swallowed');
}

// ── boot read: the two opposite ENOENTs ────────────────────────────────────
{
  // Missing FILE in a healthy directory = fresh feature, legitimately blank.
  const fresh = HB.create({ file: path.join(tmp, 'never_written.json') });
  ok(fresh.status(Date.now()).at === null && fresh.status(Date.now()).fileError === null,
     'boot: missing file in a healthy dir is "nothing stamped yet", not an error');
  // Missing DIRECTORY = /data not mounted or a typo'd path — an error, never a quiet blank.
  const dead = HB.create({ file: path.join(tmp, 'no-such-dir', 'last_inbound.json') });
  ok(/unreadable/.test(dead.status(Date.now()).fileError || ''),
     '🚨 boot: a missing DIRECTORY is reported — treating an unmounted disk as "no messages yet" is the confident-zero lie');
  // A surviving marker from the previous life is picked up at boot.
  const f2 = path.join(tmp, 'prev_life.json');
  fs.writeFileSync(f2, JSON.stringify({ at: 1755390000000 }));
  const reborn = HB.create({ file: f2 });
  ok(reborn.status(1755390600000).at === 1755390000000,
     'boot: the previous process\'s marker survives a restart — that is the point of the disk');
}

// ── businessMinutesBetween ─────────────────────────────────────────────────
{
  const B = HB.businessMinutesBetween;
  const days = [1, 2, 3, 4, 5, 6];   // TM: Mon–Sat, 9–18 MYT
  ok(B(myt(2026, 8, 17, 10, 0), myt(2026, 8, 17, 11, 0), days, 9, 18).minutes === 60,
     'bizhours: one plain working hour is 60 minutes');
  ok(B(myt(2026, 8, 17, 19, 0), myt(2026, 8, 17, 22, 0), days, 9, 18).minutes === 0,
     'bizhours: an evening of silence costs nothing');
  // 🚨 The Monday-morning case: last message Sat 17:50, ops card at Mon 09:15. The whole weekend
  // must count for 25 business minutes, NOT 39.4 wall-clock hours — or every Monday false-alarms.
  ok(B(myt(2026, 8, 15, 17, 50), myt(2026, 8, 17, 9, 15), days, 9, 18).minutes === 25,
     '🚨 bizhours: a weekend of silence is 25 business minutes, not 39 hours — no Monday false alarm');
  // A session that died Saturday noon IS alarming by Monday 09:15: 6h Sat + 15m Mon.
  ok(B(myt(2026, 8, 15, 12, 0), myt(2026, 8, 17, 9, 15), days, 9, 18).minutes === 6 * 60 + 15,
     'bizhours: a session dead since Saturday noon has burned 6h15m of business time by Monday 09:15');
  ok(B(myt(2026, 8, 16, 10, 0), myt(2026, 8, 16, 17, 0), days, 9, 18).minutes === 0,
     'bizhours: Sunday is not a business day');
  ok(B(5, 5, days, 9, 18).minutes === 0 && B(10, 5, days, 9, 18).minutes === 0,
     'bizhours: an empty or inverted span is zero, calmly');
  // 🚨 NO SILENT CAPS: a span beyond the 14-day walk says so.
  const capped = B(myt(2026, 7, 1, 9, 0), myt(2026, 8, 17, 9, 0), days, 9, 18);
  ok(capped.capped === true && capped.minutes > 0,
     '🚨 bizhours: a 47-day span reports capped:true — ">= X" can never be misread as exact');
  ok(B(myt(2026, 8, 17, 10, 0), myt(2026, 8, 17, 11, 0), days, 9, 18).capped === false,
     'bizhours: a normal span is not capped');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
