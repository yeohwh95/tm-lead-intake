// Tests for cards.js — the four audience-split report cards. Run: node cards_test.js
//
// These assert the REPORTING CONTRACT as much as the layout: a card must never carry work the
// system already did, must say so out loud when there is nothing to do, and must fit in one
// WhatsApp message. Fixtures use the real 17 Aug numbers.
const C = require('./cards');

let pass = 0, fail = 0;
const ok = (c, n) => { c ? (pass++, console.log('✅', n)) : (fail++, console.log('❌', n)); };

// ── SALES ──────────────────────────────────────────────────────────────────
{
  // The clean day: everything the system rescued is invisible.
  const clean = C.salesCard({ dateLabel: 'Tue 18 Aug', total: 69, assigned: 69, orphans: [], stuck: [] });
  ok(/all 69 assigned ✅/.test(clean), 'sales: a fully assigned day reconciles in one line');
  ok(/✅ Nothing needs a human today\./.test(clean),
     '🚨 sales: says "nothing to do" OUT LOUD — silence is indistinguishable from a failed send');
  ok(clean.split('\n').length <= 6, 'sales: a clean day is a SHORT card');
  ok(!/could not/i.test(clean), 'sales: no scary wording when nothing is wrong');

  // The real 17 Aug escalations: reassigned once, still nothing.
  const busy = C.salesCard({ dateLabel: 'Tue 18 Aug', total: 69, assigned: 68,
    orphans: [{ phone: '60186682249', want: 'Hello! Can I get more info on this?' }],
    stuck: [{ rep: 'Shahrin', phone: '60164193883', want: 'Motor kawasaki 1000sx ader ka' },
            { rep: 'Amir', phone: '601126329213', want: 'Saya nak tanya skuter nova 250' }] });
  ok(/1 LEAD WITH NO SALESPERSON/.test(busy), 'sales: an unrescued orphan is named');
  ok(/tried 3 times/.test(busy), '🚨 sales: says the bot already tried, so the human knows why they were asked');
  ok(/https:\/\/wa\.me\/60186682249/.test(busy), 'sales: orphan carries a tap-to-open link');
  ok(/2 LEADS THE SYSTEM COULD NOT RESCUE/.test(busy), 'sales: escalated leads counted');
  ok(/Shahrin/.test(busy) && /Amir/.test(busy), 'sales: names WHICH salesperson to chase');
  ok(!/Nothing needs a human/.test(busy), 'sales: no all-clear when there is work');

  // 🚨 No fabricated link when there is no number.
  const noPhone = C.salesCard({ dateLabel: 'x', total: 1, assigned: 0,
    orphans: [{ phone: '', want: 'trade in' }], stuck: [] });
  ok(/no number/.test(noPhone) && !/wa\.me/.test(noPhone),
     '🚨 sales: never invents a wa.me link for a customer with no number');

  // Rule 3 shape: an unreadable source says so, never zero.
  const blind = C.salesCard({ dateLabel: 'x', total: null, assigned: null });
  ok(/Could not read/.test(blind) && !/0 leads/.test(blind),
     '🚨 sales: an unreadable source says "could not read", never "0 leads"');
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

// ── 🚨 EVERY CARD FITS IN ONE WHATSAPP MESSAGE ─────────────────────────────
// WhatsApp rejects >4096 with a 422 and alertReview does not truncate, so an over-long card does
// not arrive at all. Rendering an absurd backlog is the only way to prove the trim works.
{
  const many = Array.from({ length: 300 }, (_, i) => ({ rep: 'Salesperson' + i,
    phone: '6012345' + String(1000 + i), want: 'Assalammualaikum nak tanya motor ni ada lagi ke bos boleh bagi harga' }));
  const huge = C.salesCard({ dateLabel: 'x', total: 400, assigned: 100, orphans: [], stuck: many });
  ok(huge.length <= C.MAX, `🚨 sales: 300 stuck leads still fits (${huge.length} <= ${C.MAX})`);
  ok(/list trimmed to fit one message/.test(huge), '🚨 sales: and it SAYS it was trimmed, never silently');
  const hugeOps = C.operationsCard({ dateLabel: 'x',
    missing: Array.from({ length: 300 }, (_, i) => ({ title: 'Yamaha Model Number ' + i, plate: 'WXY ' + i })),
    attention: [], posted: 1, live: 1 });
  ok(hugeOps.length <= C.MAX, `🚨 ops: 300 missing bikes still fits (${hugeOps.length})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
