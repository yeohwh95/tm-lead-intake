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

  console.log('\n--- TIMEOUT: a hung request must not stall the shared send chain ---');
  ({ r, calls } = await run([{ hang: true }, OK], { timeoutMs: 30 }));
  ok('hung request aborts and retries → delivered', r.ok === true && calls.length === 2);
  ok('an AbortSignal was passed to fetch', !!calls[0].signal);
  ({ r, calls } = await run([{ hang: true }], { timeoutMs: 30 }));
  ok('always hanging → gives up, reports timeout', r.ok === false && /timeout/.test(r.error));

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
