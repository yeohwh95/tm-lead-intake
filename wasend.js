// WaSenderAPI send with retry — the single chokepoint every outbound message passes through
// (customer replies, salesperson DMs, group reports, SLA nudges). Extracted so the retry policy is
// unit-testable; index.js keeps the serialized 5.2s-spaced send chain around it.
//
// WHY THIS EXISTS (incident 2026-07-30):
// A real customer (+60192822043) asked "Boleh sy nk tau zontes 368D". The bot classified it, created
// the lead, assigned Nazrin and DM'd him — then the CUSTOMER's reply got `HTTP 520` from WaSenderAPI
// (a transient Cloudflare "unknown error", an HTML page, not JSON) and was **dropped on the spot**.
// The old loop retried ONLY on 429; every other failure returned null immediately, with no retry and
// no alert. One blip on their side = one customer silently unanswered. Nobody knew but a log line.
//
// Two things were wrong, and the second was the more dangerous:
//   1. No retry on transient failures (5xx / Cloudflare 52x / network errors).
//   2. No TIMEOUT. `fetch` with no deadline can hang indefinitely, and because all sends share ONE
//      serialized chain, a single hung request stalls EVERY outbound message the bot has queued —
//      which presents exactly as "the bot stopped responding".

// Transient → worth retrying. Deliberately EXCLUDES ordinary 4xx (400/401/403/404/422): a malformed
// payload or a bad token will not fix itself, and hammering it just delays the whole send chain.
const RETRYABLE_STATUS = new Set([
  408, // request timeout
  425, // too early
  429, // rate limited (the only one the old code handled)
  500, 502, 503, 504,           // upstream errors
  520, 521, 522, 523, 524, 525, 527, // Cloudflare family — 520 is the one that bit us
]);
const isRetryableStatus = (s) => RETRYABLE_STATUS.has(Number(s));

const DEFAULT_BACKOFF_MS = [3000, 8000];   // waits BETWEEN attempts (attempt 1→2, 2→3)

// Send one message, retrying transient failures. NEVER throws — always resolves to a result object
// so the caller can decide whether to alert a human.
// Returns { ok, msgId, status, error, attempts, retried }
async function sendWithRetry(opts) {
  const {
    fetchImpl, base, token, ua, to, text, imageUrl,
    log = () => {},
    attempts = 3,
    timeoutMs = 45000,
    backoffMs = DEFAULT_BACKOFF_MS,
    sleep = (ms) => new Promise(r => setTimeout(r, ms)),
    onAttempt,                    // test hook
  } = opts;

  const payload = imageUrl ? { to, imageUrl, text } : { to, text };
  let last = { ok: false, msgId: null, status: 0, error: 'no attempt made', attempts: 0, retried: false };

  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (onAttempt) onAttempt(attempt);
    let r = null, threw = null;
    // A hung request must not stall the shared send chain — bound every attempt.
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      r = await fetchImpl(base + '/send-message', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'User-Agent': ua },
        body: JSON.stringify(payload),
        signal: ac.signal,
      });
    } catch (e) {
      threw = e;                  // network error / DNS / abort (timeout)
    } finally {
      clearTimeout(timer);
    }

    // --- our own timeout → UNKNOWN, not failed. Do NOT retry. (2026-09-21) ---------------------
    // 🚨 Measured in TM's intake group, 21 Sep 16:44–16:51. WaSenderAPI was slow to ANSWER, not slow
    // to send: every attempt was delivered, we gave up waiting after 20s, retried, and the same lead
    // card was posted three times — then we alarmed "Message NOT delivered, follow up manually".
    //   16:44:28 ✅ 1 LEAD — paoloxcoba …
    //   16:44:51 ✅ 1 LEAD — paoloxcoba …   (+23s = 20s timeout + 3s backoff)
    //   16:45:18 ✅ 1 LEAD — paoloxcoba …   (+27s)
    // The staff member then re-dropped the same screenshot five times because he could not tell what
    // had worked, which is how that customer ended up with TWO rows in Lark.
    // 🔑 The distinction that matters: WE RETRY WHEN THE SERVER TOLD US IT FAILED, AND NOT WHEN THE
    // SERVER TOLD US NOTHING. A 429 or a 520 is the server answering "no" — the message did not go,
    // so sending it again is correct and stays exactly as it was. An abort is OUR clock running out
    // with no answer at all; the message may well be on its way, and a retry is a coin flip between
    // a duplicate and a delivery.
    // ⚠️ Deliberately ONLY a true AbortError. A DNS failure or a refused connection never reached
    // WaSender at all, so those keep retrying as before — narrowing this to the one ambiguous case
    // is the whole point.
    // ⚠️ This is only safe because an unsent message is no longer invisible: alertSendFailure() tells
    // a human either way. Before that existed (2026-07-30) not retrying would have been silent loss.
    if (threw && (threw.name === 'AbortError' || /abort/i.test(String(threw.message || '')))) {
      log(`waSend no answer in ${timeoutMs}ms → NOT retrying (it may already be delivered) to ${to}`);
      return { ok: false, msgId: null, status: 0, unconfirmed: true,
               error: `no answer in ${timeoutMs}ms`, attempts: attempt, retried: attempt > 1 };
    }

    // --- network error (DNS / refused / reset) → never reached WaSender, retry ---
    if (threw) {
      last = { ok: false, msgId: null, status: 0, error: String(threw.message || threw), attempts: attempt, retried: attempt > 1 };
      if (attempt < attempts) {
        const wait = backoffMs[Math.min(attempt - 1, backoffMs.length - 1)];
        log(`waSend ${last.error} → retry in ${Math.round(wait / 1000)}s (attempt ${attempt}/${attempts}) to ${to}`);
        await sleep(wait);
        continue;
      }
      break;
    }

    // --- 429: honour the server's retry_after ---
    if (r.status === 429) {
      let ra = 5;
      try { ra = JSON.parse(await r.text()).retry_after || 5; } catch { /* keep default */ }
      last = { ok: false, msgId: null, status: 429, error: 'rate limited', attempts: attempt, retried: attempt > 1 };
      if (attempt < attempts) {
        log(`waSend 429 → retry after ${ra}s (attempt ${attempt}/${attempts})`);
        await sleep((ra + 0.6) * 1000);
        continue;
      }
      break;
    }

    // --- other transient status → back off and retry (this is the 520 case) ---
    if (!r.ok && isRetryableStatus(r.status)) {
      let body = ''; try { body = (await r.text()).slice(0, 120); } catch {}
      last = { ok: false, msgId: null, status: r.status, error: `HTTP ${r.status} ${body}`, attempts: attempt, retried: attempt > 1 };
      if (attempt < attempts) {
        const wait = backoffMs[Math.min(attempt - 1, backoffMs.length - 1)];
        log(`waSend HTTP ${r.status} (transient) → retry in ${Math.round(wait / 1000)}s (attempt ${attempt}/${attempts}) to ${to}`);
        await sleep(wait);
        continue;
      }
      break;
    }

    // --- permanent failure (400/401/403/422/…) → do NOT retry, it will not fix itself ---
    if (!r.ok) {
      let body = ''; try { body = (await r.text()).slice(0, 150); } catch {}
      log(`waSend HTTP ${r.status} (permanent, no retry) ${body}`);
      return { ok: false, msgId: null, status: r.status, error: `HTTP ${r.status} ${body}`, attempts: attempt, retried: attempt > 1 };
    }

    // --- success ---
    let msgId = null;
    try { const j = await r.json(); msgId = j.data?.msgId || j.data?.id || null; } catch { /* 2xx with unparseable body still counts as sent */ }
    if (attempt > 1) log(`waSend ✅ recovered on attempt ${attempt}/${attempts} to ${to}`);
    return { ok: true, msgId, status: r.status, error: null, attempts: attempt, retried: attempt > 1 };
  }

  log(`waSend ❌ GAVE UP after ${last.attempts} attempt(s) to ${to} — ${last.error}`);
  return last;
}

module.exports = { sendWithRetry, isRetryableStatus, RETRYABLE_STATUS, DEFAULT_BACKOFF_MS };
