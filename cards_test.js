// Tests for cards.js — the four audience-split report cards. Run: node cards_test.js
//
// These assert the REPORTING CONTRACT as much as the layout: a card must never carry work the
// system already did, must say so out loud when there is nothing to do, and must fit in one
// WhatsApp message. Fixtures use the real 17 Aug numbers.
const C = require('./cards');

let pass = 0, fail = 0;
const ok = (c, n) => { c ? (pass++, console.log('✅', n)) : (fail++, console.log('❌', n)); };

// ── SALES ──────────────────────────────────────────────────────────────────
// The contract locked 2026-08-14 (`3d8b44b`): how many leads · how many assigned · WHY not the
// rest — then the action list, with CUSTOMERS STILL WAITING as the main event.
const LS = require('./leadsummary');
const S = (over) => Object.assign({ total: 69, sumOk: true, bucketSum: 69,
  buckets: { assigned: 69, parked: 0, qualified: 0, gate_held: 0, no_rep: 0, awaiting_model: 0, other: 0 } }, over);
{
  // The clean day: everything the system rescued is invisible.
  const clean = C.salesCard({ dateLabel: 'Sat 16 Aug', s: S(), stuck: [], orphans: [] });
  ok(/Yesterday: 69 leads → all 69 assigned ✅/.test(clean), 'sales: Q1+Q2 reconcile in one line');
  ok(/✅ Everyone got a reply yesterday\./.test(clean),
     '🚨 sales: says "nothing to do" OUT LOUD — silence is indistinguishable from a failed send');
  ok(clean.split('\n').length <= 6, 'sales: a clean day is a SHORT card');
  ok(!/could not/i.test(clean), 'sales: no scary wording when nothing is wrong');

  // Q3: WHY the rest were not assigned — the strings come from leadsummary.WHY, never a copy.
  const why = C.salesCard({ dateLabel: 'Sat 16 Aug',
    s: S({ buckets: { assigned: 60, parked: 5, qualified: 2, gate_held: 2, no_rep: 0, awaiting_model: 0, other: 0 } }),
    stuck: [], orphans: [] });
  ok(/Yesterday: 69 leads → 60 assigned/.test(why), 'sales: an incomplete day shows both numbers');
  ok(/\*Why the other 9 were not assigned:\*/.test(why), 'sales: the WHY header counts the gap');
  ok(why.includes(`5 ${LS.WHY.parked}`) && why.includes(`2 ${LS.WHY.gate_held}`),
     '🚨 sales: WHY strings are leadsummary.WHY verbatim — a second copy of the map always drifts');
  ok(why.indexOf(LS.WHY.parked) < why.indexOf(LS.WHY.gate_held),
     'sales: WHY buckets print in leadsummary bucket order');

  // 🚨 THE MAIN EVENT: SLA Status=Escalated — reassigned once, still nobody replied (~23% of
  // leads measured, so this list is usually non-empty and is the whole point of the card).
  const busy = C.salesCard({ dateLabel: 'Sat 16 Aug',
    s: S({ buckets: { assigned: 68, parked: 1, qualified: 0, gate_held: 0, no_rep: 0, awaiting_model: 0, other: 0 } }),
    orphans: [{ phone: '60186682249', want: 'Hello! Can I get more info on this?' }],
    stuck: [{ rep: 'Shahrin', phone: '60164193883', want: 'Motor kawasaki 1000sx ader ka' },
            { rep: 'Amir', phone: '601126329213', want: 'Saya nak tanya skuter nova 250' }] });
  ok(/2 CUSTOMERS STILL WAITING — nobody replied\./.test(busy), '🚨 sales: the waiting list is the headline block');
  ok(/Shahrin/.test(busy) && /Amir/.test(busy), 'sales: names WHICH salesperson to chase');
  ok(/https:\/\/wa\.me\/60164193883/.test(busy) && /https:\/\/wa\.me\/601126329213/.test(busy),
     'sales: every waiting customer carries a tap-to-open link');
  ok(busy.indexOf('STILL WAITING') < busy.indexOf('NO SALESPERSON'),
     'sales: waiting customers print before the (usually empty) orphan block');
  ok(/1 LEAD WITH NO SALESPERSON/.test(busy), 'sales: an unrescued orphan is named');
  ok(/tried 3 times/.test(busy), '🚨 sales: says the bot already tried, so the human knows why they were asked');
  ok(/https:\/\/wa\.me\/60186682249/.test(busy), 'sales: orphan carries a tap-to-open link');
  ok(!/Everyone got a reply/.test(busy), 'sales: no all-clear when there is work');

  // 🚨 No fabricated link when there is no number.
  const noPhone = C.salesCard({ dateLabel: 'x', s: S({ total: 1, bucketSum: 1,
    buckets: { assigned: 0, parked: 1, qualified: 0, gate_held: 0, no_rep: 0, awaiting_model: 0, other: 0 } }),
    orphans: [{ phone: '', want: 'trade in' }], stuck: [] });
  ok(/no number/.test(noPhone) && !/wa\.me/.test(noPhone),
     '🚨 sales: never invents a wa.me link for a customer with no number');

  // Rule 3 shape, all three honesty cases: unreadable log, a date before the log, a broken sum.
  const blind = C.salesCard({ dateLabel: 'x', s: { read_error: 'EACCES /data/fr_events.jsonl' } });
  ok(/Could not read the decision log/.test(blind) && !/0 leads?/.test(blind),
     '🚨 sales: an unreadable log says "could not read", never "0 leads"');
  ok(/reporting failure/.test(blind), 'sales: and says the leads themselves are unaffected');
  ok(!/Everyone got a reply/.test(blind), '🚨 sales: no all-clear over a source it could not read');
  const nodata = C.salesCard({ dateLabel: 'x', s: { no_data: true } });
  ok(/NOT a quiet day/.test(nodata) && !/0 leads?/.test(nodata),
     '🚨 sales: a date before the log begins is "cannot see", never a confident zero');
  const badsum = C.salesCard({ dateLabel: 'x', s: S({ sumOk: false, bucketSum: 66 }), stuck: [], orphans: [] });
  ok(/buckets don't sum to the total \(66 vs 69\)/.test(badsum),
     'sales: numbers that do not add up say so rather than printing a tidy lie');
  const partial = C.salesCard({ dateLabel: 'x', s: S({ partialFrom: 1755400000000 }), stuck: [], orphans: [] });
  ok(/counts cover only part of this period/.test(partial), 'sales: a partial window says so');

  // 🚨 Two sources for one fact: when Lark and the decision log disagree, BOTH numbers print.
  const cross = C.salesCard({ dateLabel: 'x',
    s: S({ buckets: { assigned: 20, parked: 3, qualified: 0, gate_held: 0, no_rep: 0, awaiting_model: 0, other: 0 }, total: 23, bucketSum: 23 }),
    cross: { lark: { rows: 25, capped: false, error: null } }, stuck: [], orphans: [] });
  ok(/decision log says 23 assigned\+parked · Lark shows 25 row\(s\)/.test(cross),
     '🚨 sales: sources disagree ⇒ BOTH numbers on the card');
  const crossErr = C.salesCard({ dateLabel: 'x', s: S(), cross: { lark: { rows: 0, capped: false, error: 'lark 500' } },
    stuck: [], orphans: [] });
  ok(/couldn't read Lark for the cross-check/.test(crossErr), 'sales: a failed cross-check says so, never fakes agreement');
  const capped = C.salesCard({ dateLabel: 'x', s: S(), cross: { lark: { rows: 69, capped: true, error: null } },
    stuck: [], orphans: [] });
  ok(/newest 100 rows/.test(capped), '🚨 sales: a page-capped Lark read is named — no silent caps');

  // 🚨 An unreadable waiting list is UNKNOWN, not empty — the confident-zero lie in list form.
  const stuckBlind = C.salesCard({ dateLabel: 'x', s: S(), stuck: [], stuckUnavailable: 'lark 502', orphans: [] });
  ok(/UNKNOWN, not empty/.test(stuckBlind), '🚨 sales: a failed Lark read never renders as an empty waiting list');
  ok(!/Everyone got a reply/.test(stuckBlind), '🚨 sales: and never earns the all-clear');

  // The 14:00 card covers TODAY and is labelled so — "yesterday" twice a day reads as stuck.
  const midday = C.salesCard({ dateLabel: 'Mon 18 Aug (up to 14:00)', periodLabel: 'Today so far',
    s: S({ total: 12, bucketSum: 12, buckets: { assigned: 12, parked: 0, qualified: 0, gate_held: 0, no_rep: 0, awaiting_model: 0, other: 0 } }),
    stuck: [], orphans: [] });
  ok(/Today so far: 12 leads → all 12 assigned ✅/.test(midday), 'sales 14:00: covers this morning, not yesterday');
  ok(/✅ Everyone got a reply so far today\./.test(midday), 'sales 14:00: the all-clear matches the period');
}

// ── MARKETING ──────────────────────────────────────────────────────────────
{
  const m = C.marketingCard({ dateLabel: 'Tue 18 Aug', total: 69, sources: [
    { label: 'WhatsApp Direct', count: 23 }, { label: 'Tiktok DM', count: 26 },
    { label: 'Tiktok Get Leads', count: 13 }, { label: 'Ads Tiktok', count: 7 } ] });
  ok(m.indexOf('TikTok DM') < m.indexOf('WhatsApp direct'), 'marketing: sorted biggest first');
  ok(/TikTok is 67% of all leads/.test(m),
     'marketing: the SHARE is derived — a percentage is a decision, a count is not');
  ok(!/Ads Tiktok/.test(m) && /TikTok ads/.test(m), 'marketing: raw Lark labels are humanised');
  ok(C.marketingCard({ dateLabel: 'x', total: null }).includes('Could not read'),
     'marketing: unreadable source says so');
}

// ── OPERATIONS ─────────────────────────────────────────────────────────────
{
  const o = C.operationsCard({ dateLabel: 'Tue 18 Aug',
    missing: [{ title: 'HONDA CBR150 BLACK', plate: 'BQV 6413' },
              { title: '2011 Yamaha LC 135 Blue', plate: 'WVY 5252' }],
    attention: [{ title: 'Lambretta X300GT', why: 'model needs review' }],
    posted: 38, live: 32, draft: 1, waitingOn: 'Loan submission — waiting on Benjamin' });
  ok(/2 BIKES POSTED BUT NOT ON THE WEBSITE/.test(o), 'ops: missing bikes counted');
  ok(/BQV 6413/.test(o), '🚨 ops: carries the PLATE, which is what makes it findable');
  ok(/Buyers cannot find these/.test(o), 'ops: says why it matters, not just what it is');
  ok(/1 BIKE CANNOT BE LISTED/.test(o), 'ops: singular reads correctly');
  ok(/38 posted · 32 live · 1 draft/.test(o), 'ops: weekly totals for context');
  ok(/Loan submission/.test(o), 'ops: carries the waiting-on line');
  const clean = C.operationsCard({ dateLabel: 'x', missing: [], attention: [], posted: 10, live: 10 });
  ok(/✅ Nothing broken/.test(clean), 'ops: all-clear is explicit');
}

// ── BOSS ───────────────────────────────────────────────────────────────────
{
  const b = C.bossCard({ dateLabel: 'Mon 17 Aug', total: 69, assigned: 68, breached: 14,
    breachByRep: [{ rep: 'Azrul', n: 4 }, { rep: 'Allysa', n: 2 }, { rep: 'Roy', n: 2 }],
    neverContacted: 15, oldestDays: 17,
    neverContactedModels: ['CBR250RR', 'Tracer 900GT', 'Royal Enfield'],
    missingBikes: 5, topSourceLabel: 'TikTok', topSourcePct: 67 });
  // 🚨 The ordering IS the design: problems before totals.
  ok(b.indexOf('no reply within 75 minutes') < b.indexOf('69 leads yesterday'),
     '🚨 boss: the PROBLEM comes before the count, or he stops opening it');
  ok(/1 in 5 customers waited/.test(b), 'boss: the ratio, because 14 of 69 means nothing at a glance');
  ok(/Azrul 4/.test(b), 'boss: names who');
  ok(/15 older leads never contacted/.test(b) && /Oldest 17 days/.test(b), 'boss: the standing loss');
  ok(/CBR250RR/.test(b), 'boss: what those customers actually wanted, so it reads as money');
  ok(b.length < 700, `boss: stays short (${b.length} chars) — it is read in 15 seconds or not at all`);

  const quiet = C.bossCard({ dateLabel: 'x', total: 40, assigned: 40, breached: 0, neverContacted: 0, missingBikes: 0 });
  ok(/✅ Nothing to flag today/.test(quiet), 'boss: a good day says so in one line');
  ok(quiet.length < 200, 'boss: a good day is tiny');
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
// not arrive at all. Rendering an absurd backlog is the only way to prove the trim works.
{
  const many = Array.from({ length: 300 }, (_, i) => ({ rep: 'Salesperson' + i,
    phone: '6012345' + String(1000 + i), want: 'Assalammualaikum nak tanya motor ni ada lagi ke bos boleh bagi harga' }));
  const huge = C.salesCard({ dateLabel: 'x', s: S({ total: 400, bucketSum: 400,
    buckets: { assigned: 100, parked: 300, qualified: 0, gate_held: 0, no_rep: 0, awaiting_model: 0, other: 0 } }),
    orphans: [], stuck: many });
  ok(huge.length <= C.MAX, `🚨 sales: 300 stuck leads still fits (${huge.length} <= ${C.MAX})`);
  ok(/list trimmed to fit one message/.test(huge), '🚨 sales: and it SAYS it was trimmed, never silently');
  ok(/300 CUSTOMERS STILL WAITING/.test(huge), '🚨 sales: the TRUE count survives the trim — no silent cap');
  const hugeOps = C.operationsCard({ dateLabel: 'x',
    missing: Array.from({ length: 300 }, (_, i) => ({ title: 'Yamaha Model Number ' + i, plate: 'WXY ' + i })),
    attention: [], posted: 1, live: 1 });
  ok(hugeOps.length <= C.MAX, `🚨 ops: 300 missing bikes still fits (${hugeOps.length})`);
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
