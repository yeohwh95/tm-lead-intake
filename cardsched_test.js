// Tests for cardsched.js — working-day maths + confirmed-delivery retry. Run: node cardsched_test.js
//
// These pin the two cardsTick failures the module removes: the Monday card reporting SUNDAY (a
// closed day) while Saturday was never covered by any report, and a single transient HTTP failure
// burning a card slot with nothing delivered.
const CS = require('./cardsched');

let pass = 0, fail = 0;
const ok = (c, n) => { c ? (pass++, console.log('✅', n)) : (fail++, console.log('❌', n)); };

const MYT = 8 * 3600 * 1000;
// An instant in MYT local time.
const myt = (y, mo, d, h, mi) => Date.UTC(y, mo - 1, d, h || 0, mi || 0) - MYT;

// ── workingDayBefore ───────────────────────────────────────────────────────
{
  // 2026-08-17 is a Monday (this repo's own fixtures), 2026-08-15 a Saturday.
  ok(CS.workingDayBefore(myt(2026, 8, 17, 9, 15)) === '2026-08-15',
     '🚨 Monday 09:15 reports SATURDAY — a working day — never Sunday, a closed one');
  ok(CS.workingDayBefore(myt(2026, 8, 18, 9, 15)) === '2026-08-17',
     'Tuesday reports literal yesterday (Monday)');
  ok(CS.workingDayBefore(myt(2026, 8, 15, 9, 15)) === '2026-08-14',
     'Saturday reports Friday — Saturday IS in the working week');
  // cardsTick skips Sundays, but the function must still answer sanely if ever asked.
  ok(CS.workingDayBefore(myt(2026, 8, 16, 9, 15)) === '2026-08-15',
     'Sunday (never scheduled) would still answer Saturday, not loop');
  // Month boundary: Mon 1 Jun 2026 → Sat 30 May.
  ok(CS.workingDayBefore(myt(2026, 6, 1, 9, 15)) === '2026-05-30',
     'month boundary: Mon 1 Jun → Sat 30 May');
  // 🚨 The maths is MYT, not server-UTC: 18:00Z Monday is 02:00 Tuesday in MYT.
  ok(CS.workingDayBefore(Date.UTC(2026, 7, 17, 18, 0)) === '2026-08-17',
     '🚨 computed in MYT — 18:00Z Mon is already Tue in MYT, so "yesterday" is Monday');
  // The day set is a parameter, so the unresolved Saturday-assignment question stays env-only.
  ok(CS.workingDayBefore(myt(2026, 8, 17, 9, 15), null, [1, 2, 3, 4, 5]) === '2026-08-14',
     'a Mon–Fri day set makes Monday report Friday — day set is a parameter, not a constant');
  // A broken day set degrades to literal yesterday rather than never answering.
  ok(CS.workingDayBefore(myt(2026, 8, 17, 9, 15), null, []) === '2026-08-16',
     'an empty day set falls back to literal yesterday — a wrong date beats a report that never fires');
}

// ── sendWithRetry ──────────────────────────────────────────────────────────
(async () => {
  const noSleep = { sleep: async () => {} };

  // First-try success: one attempt, zero waiting.
  {
    let calls = 0, sleeps = 0;
    const r = await CS.sendWithRetry(async () => { calls++; return true; },
      { sleep: async () => { sleeps++; } });
    ok(r.ok === true && r.attempts === 1 && calls === 1, 'retry: a clean send is one attempt');
    ok(sleeps === 0, 'retry: and no backoff is paid for success');
  }
  // Two transient failures then success — the card still arrives.
  {
    let calls = 0;
    const r = await CS.sendWithRetry(async () => { calls++; return calls >= 3; }, noSleep);
    ok(r.ok === true && r.attempts === 3, '🚨 retry: two transient failures no longer lose the card');
  }
  // All three fail: ok:false with the attempt count, so the caller can say "tried 3 times".
  {
    let calls = 0, sleeps = 0;
    const r = await CS.sendWithRetry(async () => { calls++; return false; },
      { sleep: async () => { sleeps++; } });
    ok(r.ok === false && r.attempts === 3 && calls === 3,
       '🚨 retry: total failure reports ok:false after exactly 3 attempts (发现→fix→3次→通知)');
    ok(sleeps === 2, 'retry: backoff between attempts, none after the last');
  }
  // A THROWING send function is a failure, never an escape — one bad card must not kill the tick.
  {
    const r = await CS.sendWithRetry(async () => { throw new Error('ECONNRESET'); }, noSleep);
    ok(r.ok === false && r.attempts === 3, '🚨 retry: a throwing send counts as failure and never escapes');
  }
  // The default backoff is real (5s then 15s) — pinned so a future edit cannot silently zero it.
  {
    const seen = [];
    await CS.sendWithRetry(async () => false, { sleep: async ms => { seen.push(ms); } });
    ok(seen.join(',') === '5000,15000', 'retry: default backoff is 5s then 15s');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
