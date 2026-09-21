// Tests for wasend.js — the send retry policy. Run: node wasend_test.js
// Fixtures are the REAL failure modes seen in production, starting with the HTTP 520 that dropped a
// customer's reply on 2026-07-30.
const { sendWithRetry, isRetryableStatus } = require('./wasend');

let pass = 0, fail = 0;
const ok = (n, c) => { console.log((c ? '✅ ' : '❌ ') + n); c ? pass++ : fail++; };

// A fake fetch driven by a scripted list of outcomes.
// Each entry: {status, body} | {throw:'network'} | {hang:true}
function fakeFetch(script, calls) {
  return async (url, init) => {
    const step = script[Math.min(calls.length, script.length - 1)];
    calls.push({ url, body: JSON.parse(init.body), signal: init.signal });
    if (step.throw) { const e = new Error(step.throw); throw e; }
    if (step.hang) {
      // never resolves on its own — only the AbortController can end it
      return await new Promise((_, rej) => {
        init.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e); });
      });
    }
    return {
      ok: step.status >= 200 && step.status < 300,
      status: step.status,
      text: async () => step.body || '',
      json: async () => JSON.parse(step.body || '{}'),
    };
  };
}
const base = { base: 'https://x', token: 't', ua: 'ua', to: '60111@s.whatsapp.net', text: 'hi',
               sleep: async () => {}, log: () => {} };   // sleep stubbed → tests are instant
const run = (script, extra = {}) => {
  const calls = [];
  return sendWithRetry({ ...base, ...extra, fetchImpl: fakeFetch(script, calls) }).then(r => ({ r, calls }));
};
const OK = { status: 200, body: JSON.stringify({ data: { msgId: 'M1' } }) };

(async () => {
  console.log('\n--- the real incident: HTTP 520 must now RETRY, not give up ---');
  let { r, calls } = await run([{ status: 520, body: '<!DOCTYPE html>' }, OK]);
  ok('520 then 200 → delivered', r.ok === true && r.msgId === 'M1');
  ok('520 was retried (2 attempts)', calls.length === 2 && r.attempts === 2);
  ok('flagged as recovered-after-retry', r.retried === true);

  ({ r, calls } = await run([{ status: 520, body: 'x' }]));
  ok('520 every time → ok:false after 3 attempts', r.ok === false && r.attempts === 3 && calls.length === 3);
  ok('final result carries the status for the alert', r.status === 520 && /520/.test(r.error));

  console.log('\n--- other transient failures ---');
  ({ r, calls } = await run([{ status: 502, body: '' }, { status: 503, body: '' }, OK]));
  ok('502 → 503 → 200 delivered on the 3rd attempt', r.ok === true && calls.length === 3);
  ({ r, calls } = await run([{ status: 524, body: '' }, OK]));
  ok('Cloudflare 524 retried', r.ok === true && calls.length === 2);
  ({ r, calls } = await run([{ throw: 'ECONNRESET' }, OK]));
  ok('network error retried', r.ok === true && calls.length === 2);
  ({ r, calls } = await run([{ throw: 'ECONNRESET' }]));
  ok('persistent network error → ok:false, error kept', r.ok === false && /ECONNRESET/.test(r.error));

  console.log('\n--- 429 keeps honouring retry_after (unchanged behaviour) ---');
  ({ r, calls } = await run([{ status: 429, body: JSON.stringify({ retry_after: 2 }) }, OK]));
  ok('429 then 200 delivered', r.ok === true && calls.length === 2);
  ({ r, calls } = await run([{ status: 429, body: '{}' }]));
  ok('persistent 429 → ok:false after 3', r.ok === false && r.attempts === 3);

  console.log('\n--- permanent failures must NOT be retried (they never fix themselves) ---');
  for (const st of [400, 401, 403, 404, 422]) {
    ({ r, calls } = await run([{ status: st, body: 'bad' }]));
    ok(`HTTP ${st} → single attempt, no retry`, r.ok === false && calls.length === 1 && r.status === st);
  }

  console.log('\n--- TIMEOUT: no answer is UNKNOWN, not failed — it must NOT be resent ---');
  // ⚠️ This block previously asserted the OPPOSITE: "hung request aborts and retries → delivered".
  // That looked obviously right and was measured wrong on 21 Sep 2026 in TM's intake group —
  // WaSenderAPI was slow to ANSWER, not slow to send, so all three attempts were delivered and the
  // same lead card appeared three times before the bot alarmed "Message NOT delivered".
  // The staff member re-dropped the screenshot five times because nothing told him what had worked,
  // and that customer ended up with two rows in Lark. Keeping the old assertion would re-ship it.
  ({ r, calls } = await run([{ hang: true }, OK], { timeoutMs: 30 }));
  ok('🚨 no answer → sent ONCE, never resent', calls.length === 1);
  ok('🚨 reported as unconfirmed, not as failed', r.ok === false && r.unconfirmed === true);
  ok('the error says nobody answered, not that it failed', /no answer/.test(r.error));
  ok('an AbortSignal was passed to fetch', !!calls[0].signal);
  ({ r, calls } = await run([{ hang: true }], { timeoutMs: 30 }));
  ok('a single hang behaves the same way', calls.length === 1 && r.unconfirmed === true);

  console.log('\n--- but a server that ANSWERS "no" is still retried: that message did NOT go ---');
  // The distinction the fix rests on. A 520 or a 429 is WaSenderAPI refusing, so resending is
  // correct and is why this retry exists at all (a customer's reply was dropped on 2026-07-30).
  ({ r, calls } = await run([{ status: 520, body: 'bad gateway' }, OK], { backoffMs: [1, 1] }));
  ok('🚨 HTTP 520 still retries and delivers', r.ok === true && calls.length === 2);
  ok('and is NOT marked unconfirmed', !r.unconfirmed);
  ({ r, calls } = await run([{ throw: 'getaddrinfo ENOTFOUND' }, OK], { backoffMs: [1, 1] }));
  ok('🚨 a connection that never reached WaSender still retries', r.ok === true && calls.length === 2);
  ok('and is NOT marked unconfirmed either', !r.unconfirmed);

  console.log('\n--- happy path unchanged ---');
  ({ r, calls } = await run([OK]));
  ok('200 first time → 1 attempt, msgId returned', r.ok === true && r.msgId === 'M1' && calls.length === 1 && r.retried === false);
  ({ r, calls } = await run([{ status: 200, body: 'not json' }]));
  ok('2xx with unparseable body still counts as sent', r.ok === true && r.msgId === null);

  console.log('\n--- payload shape preserved ---');
  ({ r, calls } = await run([OK], { imageUrl: 'https://img' }));
  ok('imageUrl included when given', calls[0].body.imageUrl === 'https://img' && calls[0].body.to === '60111@s.whatsapp.net');
  ({ r, calls } = await run([OK]));
  ok('no imageUrl key on a text send', !('imageUrl' in calls[0].body));

  console.log('\n--- status classification ---');
  ok('429/520/502/503/504/524 retryable', [429,520,502,503,504,524].every(isRetryableStatus));
  ok('400/401/403/404/422 NOT retryable', [400,401,403,404,422].every(s => !isRetryableStatus(s)));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
