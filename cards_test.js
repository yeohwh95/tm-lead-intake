// Tests for cards.js — the SALES funnel + Benjamin's OPS health card. Run: node cards_test.js
//
// These assert the REPORTING CONTRACT as much as the layout: a card must never carry work the
// system already did, must say so out loud when there is nothing to do, must never render an
// unreadable source as a zero, and must fit in one WhatsApp message.
//
// 2026-08-21: MARKETING / OPERATIONS / BOSS tests are gone with their renderers. Boss was deleted;
// Marketing + Operations moved to box-66 (`daily_report.py`) where the Mudah ledger and Relay DB
// physically live. Testing a JS copy of a card that box-66 actually sends would be testing the
// wrong artefact — and keeping that copy alive is the fork-drift trap this fleet already paid for.
const C = require('./cards');

let pass = 0, fail = 0;
const ok = (c, n) => { c ? (pass++, console.log('✅', n)) : (fail++, console.log('❌', n)); };

// ── SALES — one funnel, three stages, 100% the target at each ──────────────
// Benjamin, 2026-08-21: "capture all leads → assign all leads to a salesperson → make sure the
// leads are responded to promptly. That is the final goal."
const LS = require('./leadsummary');
const S = (over) => Object.assign({ total: 69, sumOk: true, bucketSum: 69,
  buckets: { assigned: 69, parked: 0, qualified: 0, gate_held: 0, no_rep: 0, awaiting_model: 0, other: 0 } }, over);
const R = (over) => Object.assign({ measured: 69, onTime: 69, thresholdMin: 75,
  byRep: [{ rep: 'Fitri', leads: 40, avgMin: 12, onTime: 40 }, { rep: 'Raja', leads: 29, avgMin: 31, onTime: 29 }] }, over);
{
  // ---- The perfect day: three full bars and an explicit all-clear. ----
  const clean = C.salesCard({ dateLabel: 'Sat 16 Aug', s: S(), resp: R(), lateBy: [] });
  ok(/📥 \*Captured\* +69/.test(clean), 'sales: stage 1 — captured');
  ok(/👤 \*Assigned\* +69\/69 +100% +▓{10}/.test(clean), 'sales: stage 2 — assigned, with a full bar');
  ok(/⚡ \*Answered ≤75min\* +69\/69 +100% +▓{10}/.test(clean), 'sales: stage 3 — the CUSTOMER was answered in time');
  ok(clean.indexOf('Captured') < clean.indexOf('Assigned') && clean.indexOf('Assigned') < clean.indexOf('Answered ≤'),
     '🚨 sales: the three stages print in the client\'s own order — capture → assign → respond');
  ok(/✅ \*100% at every step\. Nothing to chase\.\*/.test(clean),
     '🚨 sales: says "nothing to do" OUT LOUD — silence is indistinguishable from a failed send');
  ok(!/could not/i.test(clean), 'sales: no scary wording when nothing is wrong');

  // ---- Leak 1: not assigned, and WHY. Strings come from leadsummary.WHY, never a copy. ----
  const why = C.salesCard({ dateLabel: 'Sat 16 Aug',
    s: S({ buckets: { assigned: 60, parked: 5, qualified: 2, gate_held: 2, no_rep: 0, awaiting_model: 0, other: 0 } }),
    resp: R({ measured: 60, onTime: 60 }), lateBy: [] });
  ok(/👤 \*Assigned\* +60\/69 +87%/.test(why), 'sales: an incomplete stage shows have/target and the percent');
  ok(/⚠️ \*9 not assigned yet — why:\*/.test(why), 'sales: the WHY header counts the gap');
  ok(why.includes(`5  ${LS.WHY.parked}`) && why.includes(`2  ${LS.WHY.gate_held}`),
     '🚨 sales: WHY strings are leadsummary.WHY verbatim — a second copy of the map always drifts');
  ok(why.indexOf(LS.WHY.parked) < why.indexOf(LS.WHY.gate_held),
     'sales: WHY buckets print in leadsummary bucket order');
  ok(!/100% at every step/.test(why), 'sales: no all-clear while a stage is leaking');

  // ---- Leak 2: waited too long. NAME + COUNT ONLY (Benjamin, 2026-08-21). ----
  // ⚠️ The consequence is deliberate and worth a test: no customer, no phone, no wa.me link. The
  // reps get the customer itself by DM; this card is a scoreboard, not a worklist.
  const late = C.salesCard({ dateLabel: 'Sat 16 Aug', s: S(),
    resp: R({ measured: 69, onTime: 65 }),
    lateBy: [{ rep: 'Adib', n: 1 }, { rep: 'Shahrin', n: 2 }, { rep: 'Raja', n: 1 }] });
  ok(/🔴 \*4 customers waited over 75 min:\*/.test(late), 'sales: the late block counts the customers, not the reps');
  ok(/Shahrin +2/.test(late) && /Adib +1/.test(late), 'sales: name + count');
  ok(late.indexOf('Shahrin') < late.indexOf('Adib'), 'sales: worst first');
  ok(!/wa\.me|\+601|"/.test(late.split('🔴')[1].split('⏱️')[0]),
     '🚨 sales: the late block carries NO customer, phone or link — simplified deliberately 2026-08-21');
  const one = C.salesCard({ dateLabel: 'x', s: S(), resp: R({ measured: 69, onTime: 68 }), lateBy: [{ rep: 'Adib', n: 1 }] });
  ok(/1 customer waited over 75 min/.test(one), 'sales: singular reads correctly');

  // ---- The scoreboard: stage 3's whole point. ----
  const speed = C.salesCard({ dateLabel: 'x', s: S(), lateBy: [],
    resp: R({ measured: 69, onTime: 60, byRep: [
      { rep: 'Shahrin', leads: 10, avgMin: 130, onTime: 5 },
      { rep: 'Fitri', leads: 30, avgMin: 12, onTime: 30 },
      { rep: 'Raja', leads: 29, avgMin: 41, onTime: 25 } ] }) });
  ok(speed.indexOf('Fitri') < speed.indexOf('Raja') && speed.indexOf('Raja') < speed.indexOf('Shahrin'),
     'sales: the speed table is sorted FASTEST first');
  ok(/Fitri +30 leads · avg +12m · +100% ✅/.test(speed), 'sales: a perfect rep is flagged ✅');
  ok(/Shahrin +10 leads · avg +2h 10m · +50% 🔴/.test(speed),
     '🚨 sales: minutes over an hour render as h+m, and under 70% is flagged 🔴');
  ok(!/ 🔴/.test(speed.match(/Raja.*/)[0]), 'sales: 86% is neither flagged good nor bad');

  // ---- 🚨 ONE LEAD IS NOT A SCORE. The shipped card printed `Jue 1 leads · avg 1h 24m · 0% 🔴`. ----
  const folded = C.salesCard({ dateLabel: 'x', s: S(), lateBy: [], captured: 69, assigned: 69,
    resp: R({ minLeads: 3,
      byRep: [{ rep: 'Jebat', leads: 6, avgMin: 77, onTime: 1 }, { rep: 'Nabil', leads: 5, avgMin: 50, onTime: 4 }],
      rest: { reps: 10, leads: 14, avgMin: 62, onTime: 6 } }) });
  ok(/⏱️ \*Response speed yesterday\*  \(3\+ leads\)/.test(folded), 'sales: the scoreboard states its cutoff');
  ok(/Everyone else 14 leads across 10 people · avg 1h 2m/.test(folded),
     '🚨 sales: reps below the cutoff are FOLDED into one honest line, not scored on noise');
  ok(!/Jue/.test(folded), 'sales: and are not individually flagged');
  ok(/business hours only · each salesperson's own clock, which restarts when a lead is passed on/.test(speed),
     '🚨 sales: the scoreboard NAMES its clock — the funnel counts the customer\'s wait, this counts the rep\'s, and a reader must not have to discover that as a contradiction');

  // ---- 🚨 NEVER A CONFIDENT ZERO, in every direction this card can be blind. ----
  const respDead = C.salesCard({ dateLabel: 'x', s: S(), lateBy: [],
    resp: { error: 'lark search 99991663', thresholdMin: 75 } });
  ok(/⚡ \*Acknowledged\* +could not read \(lark search 99991663\)/.test(respDead),
     '🚨 sales: an unreadable Lark renders stage 3 as "could not read", NEVER as 0%');
  ok(!/100% at every step/.test(respDead), 'sales: and no all-clear over a source it could not read');
  const noAck = C.salesCard({ dateLabel: 'x', s: S(), lateBy: [], resp: R({ measured: 0, onTime: 0, byRep: [] }) });
  ok(/no salesperson has confirmed a lead in this window yet/.test(noAck),
     '🚨 sales: a real 0% explains WHY it is empty, so it cannot be mistaken for a failed read');
  const partialResp = C.salesCard({ dateLabel: 'x', s: S(), lateBy: [], resp: R({ measured: 60, onTime: 60 }) });
  ok(/\(9 assigned lead\(s\) have no response record yet\)/.test(partialResp),
     '🚨 sales: stage 3 is measured on Lark and stages 1-2 on the log — a smaller denominator is NAMED, not hidden');
  const stuckBlind = C.salesCard({ dateLabel: 'x', s: S(), resp: R(), lateBy: [],
    stuckUnavailable: 'lark search 99991663' });
  ok(/"waited too long" list is UNKNOWN, not empty/.test(stuckBlind),
     '🚨 sales: an unreadable Lark is an UNKNOWN list, never an empty one');
  ok(!/100% at every step/.test(stuckBlind), 'sales: and never an all-clear over it');
  const nodata = C.salesCard({ dateLabel: 'x', s: { no_data: true }, resp: R() });
  ok(/This is NOT a quiet day/.test(nodata), '🚨 sales: a date before the log begins is not a zero');
  ok(!/📥 \*Captured\*/.test(nodata), 'sales: and no funnel is drawn over data that does not exist');
  const readErr = C.salesCard({ dateLabel: 'x', s: { read_error: 'EACCES /data' }, resp: R() });
  ok(/Could not read the decision log/.test(readErr) && /reporting failure/.test(readErr),
     'sales: an unreadable log says so, and says the leads are unaffected');
  const bad = C.salesCard({ dateLabel: 'x', resp: R(), lateBy: [],
    s: S({ sumOk: false, bucketSum: 61 }) });
  ok(/buckets don't sum to the total \(61 vs 69\)/.test(bad), 'sales: numbers that do not add up SAY SO');
  const partial = C.salesCard({ dateLabel: 'x', s: S({ partialFrom: 1 }), resp: R(), lateBy: [] });
  ok(/counts cover only part of this period/.test(partial), 'sales: a partial window is declared');

  // ---- 🚨 THE DAILY FALSE WARNING IS GONE (2026-08-23). ----
  // The old card compared the decision log's assigned+parked against Lark's row count and printed
  // "Both printed because they disagree" — every single day, because those two count DIFFERENT
  // POPULATIONS (the log never sees a TikTok lead). It reported a design error as a data fault, and
  // a warning that fires daily teaches the reader to ignore warnings.
  const cross = C.salesCard({ dateLabel: 'x', resp: R(), lateBy: [], captured: 53, assigned: 46,
    s: S({ buckets: { assigned: 15, parked: 2, qualified: 0, gate_held: 0, no_rep: 0, awaiting_model: 0, other: 0 } }),
    cross: { lark: { rows: 53 } } });
  ok(!/Both printed because they disagree/.test(cross),
     '🚨 sales: no daily cross-check warning — one source means there is nothing to disagree with');
  ok(/📥 \*Captured\* +53/.test(cross) && /👤 \*Assigned\* +46\/53/.test(cross),
     '🚨 sales: the funnel takes BOTH stages from Lark, so it can never report more answered than captured');
  ok(/Lark read only the newest 100 rows/.test(
      C.salesCard({ dateLabel: 'x', s: S(), resp: R(), lateBy: [], captured: 69, assigned: 69,
        cross: { lark: { rows: 69, capped: true } } })),
     'sales: a capped Lark read still says how it was capped');

  // ---- The WHY list explains a SUBSET, and says how much it could not explain. ----
  const subset = C.salesCard({ dateLabel: 'x', resp: R(), lateBy: [], captured: 53, assigned: 46,
    s: S({ buckets: { assigned: 15, parked: 2, qualified: 2, gate_held: 1, no_rep: 0, awaiting_model: 1, other: 0 } }) });
  ok(/⚠️ \*7 not assigned yet — why:\*/.test(subset), 'sales: the gap is counted from the Lark funnel');
  ok(/1  no reason recorded \(came in from TikTok, not through the bot\)/.test(subset),
     '🚨 sales: reasons come from a log that never sees TikTok leads — the shortfall is NAMED, never left to read as complete');

  // ---- A rep the roster does not know is NAMED, not bucketed. ----
  const unk = C.salesCard({ dateLabel: 'x', s: S(), resp: R(), lateBy: [], captured: 69, assigned: 69,
    unresolvedReps: ['Farhan'] });
  ok(/Not in the staff list, so their name may be wrong: Farhan/.test(unk),
     '🚨 sales: an unknown salesperson is named — otherwise a whole person hides behind a bucket');

  // ---- Context that is NOT part of the funnel. ----
  const nl = C.salesCard({ dateLabel: 'x', s: S(), resp: R(), lateBy: [], notLeads: 11 });
  ok(/ℹ️ 11 other chats were not sales leads/.test(nl),
     'sales: non-leads are context — a repeat customer is not a lead we failed to capture');
  ok(nl.indexOf('not sales leads') > nl.indexOf('Response speed'), 'sales: and they sit at the bottom');

  // The 14:00 card covers TODAY and is labelled so — "yesterday" twice a day reads as stuck.
  const midday = C.salesCard({ dateLabel: 'Mon 18 Aug (up to 14:00)', periodLabel: 'Today so far',
    s: S({ total: 12, bucketSum: 12, buckets: { assigned: 12, parked: 0, qualified: 0, gate_held: 0, no_rep: 0, awaiting_model: 0, other: 0 } }),
    resp: R({ measured: 12, onTime: 12 }), lateBy: [] });
  ok(/⏱️ \*Response speed today\*/.test(midday), 'sales 14:00: the scoreboard header matches the period');
  ok(/⏱️ \*Response speed yesterday\*/.test(clean), 'sales 09:15: and says "yesterday" on the morning card');

  // The threshold is configurable in ONE place and the card renders whatever it is told.
  const t60 = C.salesCard({ dateLabel: 'x', s: S(), lateBy: [{ rep: 'Adib', n: 1 }],
    resp: R({ thresholdMin: 60, measured: 69, onTime: 68 }) });
  ok(/⚡ \*Answered ≤60min\*/.test(t60) && /waited over 60 min/.test(t60),
     '🚨 sales: the threshold is rendered from data — the header and the late block can never disagree');
}

// ── OPS (Benjamin's health card, QA group only) ────────────────────────────
// "Everything is in order — or exactly what is broken." Every line grounded in a signal that
// exists; broken states ranked SEV1 (losing leads now) → SEV4 (going blind); a healthy card is
// SHORT and still names its own blind spots.
{
  const healthy = {
    dateLabel: 'Mon 18 Aug 09:15',
    upSinceLabel: 'Sun 17 Aug 12:07', restartedInWindow: false,
    reports: { expected: ['10:00', '12:00', '16:00', '18:00'], sent: ['10:00', '12:00', '16:00', '18:00'], missing: [] },
    log: { readable: true, error: null, lastEventLabel: 'Sat 16 Aug 17:41', parseErrors: 0 },
    counts: { larkMissing: 0, sumOk: true },
    undelivered: [], backlog: { count: 15, prev: 15, error: null },
    inbound: { at: 1755500000000, minutesAgo: 12, quietBusinessHours: 0.2, alarmH: 3, noMarker: false, error: null },
  };
  const h = C.opsCard(healthy);
  ok(/✅ No problems detected\./.test(h), 'ops: a healthy day says so out loud');
  ok(/Up since Sun 17 Aug 12:07/.test(h), 'ops: BOOT_AT is exposed, not implied');
  ok(/Reports provably sent yesterday: 4\/4 ✅/.test(h), 'ops: reports proven by the durable markers, not assumed');
  ok(/Decision log OK · last event Sat 16 Aug 17:41 · no parse errors/.test(h), 'ops: log health with the last event');
  ok(/Last inbound message 12 min ago/.test(h), 'ops: the heartbeat line — quiet day vs dead session');
  ok(/Blind: /.test(h) && /box-66 at 09:57/.test(h),
     '🚨 ops: a healthy card still names what it CANNOT see — coverage it does not have is never claimed');
  ok(h.split('\n').length <= 11, `ops: a healthy day is SHORT (${h.split('\n').length} lines)`);

  // The bad day: everything broken at once, ranked.
  const bad = C.opsCard({
    dateLabel: 'Mon 18 Aug 09:15',
    upSinceLabel: 'Mon 18 Aug 03:12', restartedInWindow: true,
    reports: { expected: ['10:00', '12:00', '16:00', '18:00'], sent: ['10:00', '12:00'], missing: ['16:00', '18:00'] },
    log: { readable: true, error: null, lastEventLabel: 'Sat 16 Aug 17:41', parseErrors: 3 },
    counts: { larkMissing: 2, sumOk: false },
    undelivered: [{ to: '60123456789', attempts: 3, error: 'HTTP 500' }],
    backlog: { count: 19, prev: 15, error: null },
    inbound: { at: 1755300000000, minutesAgo: 2000, quietBusinessHours: 6.5, alarmH: 3, noMarker: false, error: null },
  });
  ok(/🔴 SEV1 · 2 lead\(s\) have NO Lark row/.test(bad), 'ops SEV1: a failed CRM write is losing leads NOW');
  ok(/🔴 SEV1 · a send was given up on after 3 attempt\(s\) → 60123456789/.test(bad), 'ops SEV1: undelivered sends named');
  ok(/🟠 SEV2 · no sent-marker for yesterday's 16:00, 18:00 report\(s\)/.test(bad), 'ops SEV2: unproven reports named');
  ok(/🟠 SEV2 · lead buckets do not sum/.test(bad), 'ops SEV2: broken client numbers flagged');
  ok(/🟡 SEV3 · stuck backlog 19, UP from 15/.test(bad), 'ops SEV3: a rising backlog is the news');
  ok(/⚪ SEV4 · 3 unreadable line\(s\)/.test(bad), 'ops SEV4: parse errors are going-blind, not ignorable');
  ok(/⚪ SEV4 · no inbound WhatsApp message for 6\.5h of business hours \(alarm at 3h\)/.test(bad),
     '🚨 ops SEV4: the dead-WaSender alarm — the failure that loses every lead at once');
  ok(bad.indexOf('SEV1') < bad.indexOf('SEV2') && bad.indexOf('SEV2') < bad.indexOf('SEV3')
     && bad.indexOf('SEV3') < bad.indexOf('SEV4'), '🚨 ops: severity order is the layout — worst first');
  ok(/restarted inside this window/.test(bad), 'ops: a mid-window restart is named (RAM lists are gone)');
  ok(!/No problems detected/.test(bad), 'ops: no all-clear when something is broken');
  ok(/Blind: /.test(bad), 'ops: the blind line survives a bad day too');

  // 🚨 Never a confident zero, in every direction this card can be blind.
  const logDead = C.opsCard({ dateLabel: 'x', upSinceLabel: 'x', reports: { expected: [], sent: [], missing: [] },
    log: { readable: false, error: 'decision-log directory is unreadable (/data)', parseErrors: null },
    counts: { unavailable: 'decision log unreadable, so lead counts and integrity cannot be checked' },
    undelivered: [], backlog: { count: null, prev: null, error: null },
    inbound: { at: null, minutesAgo: null, quietBusinessHours: null, alarmH: 3, noMarker: true, error: null } });
  ok(/⚪ SEV4 · decision log unreadable/.test(logDead), 'ops: an unreadable log is SEV4, not silence');
  ok(!/Decision log OK/.test(logDead), 'ops: and never simultaneously claims the log is OK');
  ok(/no marker on disk yet/.test(logDead), '🚨 ops: a missing inbound marker renders as UNKNOWN, never as an age');
  ok(!/no inbound WhatsApp message for/.test(logDead), 'ops: and the quiet-hours alarm cannot fire off a marker that does not exist');
  const hbDead = C.opsCard({ dateLabel: 'x', upSinceLabel: 'x', reports: { expected: [], sent: [], missing: [] },
    log: { readable: true, lastEventLabel: 'x', parseErrors: 0 }, counts: { larkMissing: 0, sumOk: true },
    undelivered: [], backlog: { count: 1, prev: 1, error: null },
    inbound: { at: null, minutesAgo: null, quietBusinessHours: null, alarmH: 3, noMarker: true, error: 'last-inbound directory is unreadable (/data)' } });
  ok(/⚪ SEV4 · could not read the last-inbound marker/.test(hbDead),
     '🚨 ops: an unreadable marker dir (unmounted /data) is SEV4, never "fresh feature"');
  const larkDead = C.opsCard({ dateLabel: 'x', upSinceLabel: 'x', reports: { expected: [], sent: [], missing: [] },
    log: { readable: true, lastEventLabel: 'x', parseErrors: 0 }, counts: { larkMissing: 0, sumOk: true },
    undelivered: [], backlog: { count: null, prev: 15, error: 'lark search 99991663' },
    inbound: { at: 1, minutesAgo: 5, quietBusinessHours: 0.1, alarmH: 3, noMarker: false, error: null } });
  ok(/⚪ SEV4 · could not read the backlog from Lark/.test(larkDead), 'ops: a failed backlog read says so, never 0');
  ok(!/Backlog: /.test(larkDead), 'ops: and no backlog count line is invented');

  // Legacy switched off: the proof moves to the cards' own markers.
  const legOff = C.opsCard({ dateLabel: 'x', upSinceLabel: 'x', reports: { legacyOff: true, cardsSentYesterday: 4 },
    log: { readable: true, lastEventLabel: 'x', parseErrors: 0 }, counts: { larkMissing: 0, sumOk: true },
    undelivered: [], backlog: { count: 1, prev: 1, error: null },
    inbound: { at: 1, minutesAgo: 5, quietBusinessHours: 0.1, alarmH: 3, noMarker: false, error: null } });
  ok(/Legacy client reports are OFF · 4 card\(s\) provably sent yesterday/.test(legOff),
     'ops: with LEGACY_REPORTS=0 the proof-of-send comes from the card markers');
}

// ── 🚨 EVERY CARD FITS IN ONE WHATSAPP MESSAGE ─────────────────────────────
// WhatsApp rejects >4096 with a 422 and alertReview does not truncate, so an over-long card does
// not arrive at all. Rendering an absurd fleet is the only way to prove the trim works.
{
  const manyReps = Array.from({ length: 300 }, (_, i) => ({ rep: 'Salesperson' + i, n: i + 1 }));
  const manySpeed = Array.from({ length: 300 }, (_, i) => ({ rep: 'Salesperson' + i, leads: 9, avgMin: i, onTime: 3 }));
  const huge = C.salesCard({ dateLabel: 'x', lateBy: manyReps,
    s: S({ total: 400, bucketSum: 400,
      buckets: { assigned: 100, parked: 300, qualified: 0, gate_held: 0, no_rep: 0, awaiting_model: 0, other: 0 } }),
    resp: R({ measured: 100, onTime: 40, byRep: manySpeed }) });
  ok(huge.length <= C.MAX, `🚨 sales: 300 reps still fits (${huge.length} <= ${C.MAX})`);
  ok(/list trimmed to fit one message/.test(huge), '🚨 sales: and it SAYS it was trimmed, never silently');
  ok(/📥 \*Captured\* +400/.test(huge), '🚨 sales: the funnel survives the trim — the header is what must never be cut');
  const hugeHealth = C.opsCard({ dateLabel: 'x', upSinceLabel: 'x',
    reports: { expected: [], sent: [], missing: [] },
    log: { readable: true, lastEventLabel: 'x', parseErrors: 0 }, counts: { larkMissing: 0, sumOk: true },
    undelivered: Array.from({ length: 300 }, (_, i) => ({ to: '60123456' + i, attempts: 3, error: 'HTTP 500 something long here' })),
    backlog: { count: 1, prev: 1, error: null },
    inbound: { at: 1, minutesAgo: 5, quietBusinessHours: 0.1, alarmH: 3, noMarker: false, error: null } });
  ok(hugeHealth.length <= C.MAX, `🚨 ops-health: 300 undelivered sends still fits (${hugeHealth.length})`);
  ok(/list trimmed to fit one message/.test(hugeHealth), 'ops-health: and says it was trimmed');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
