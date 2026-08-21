// cards.js — the four audience-split report cards (Benjamin, 2026-08-17).
//
// 🚨 THE RULE THAT SHAPES ALL OF THEM: 发现 → 自己 fix → 3 次不行 → 才通知群组.
// A card carries ONLY what the system could not fix itself. A lead that was auto-assigned, a rep
// who was auto-reassigned, a customer who already has a salesperson — none of it appears. On a
// clean day the sales card is two lines, and that is the point: a report nobody can act on is a
// report nobody reads, and then the one line that mattered is missed too.
//
// One audience per card, because they were conflated in one group and everybody scrolled:
//   SALES      → did every lead get a salesperson, and who must be chased by hand
//   MARKETING  → where the leads came from
//   OPERATIONS → what is broken in the listing pipeline  (built on box-66, not here — it needs the
//                Mudah group ledger, which this process cannot read)
//   BOSS       → what is costing money, worst first
//
// Pure render functions. index.js boots a server on require and cannot host tested logic.

// WhatsApp hard-rejects over 4096 (422) and alertReview does NOT truncate, so an over-long card
// does not get trimmed, it never arrives. Four separate messages each get their own headroom.
const MAX = 3900;

const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - String(s).length));
const dots = (label, n) => label + ' ' + '.'.repeat(Math.max(1, n - label.length)) + ' ';
// Never emit a wa.me link for a number we do not have — a dead link that LOOKS actionable is the
// 2026-08-02 failure wearing a new hat.
const digits = (p) => String(p || '').replace(/\D/g, '');
const clip = (s, n) => { const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t; };

// 🚨 Every card trims itself rather than trusting a length assumption. `keep` is the header that
// must survive; the body is cut from the end, and the reader is told it was cut.
function fit(head, body){
  const all = head.concat(body);
  let t = all.join('\n');
  if (t.length <= MAX) return t;
  const out = body.slice();
  while (out.length && (head.concat(out, ['', '⚠️ list trimmed to fit one message'])).join('\n').length > MAX) out.pop();
  return head.concat(out, ['', '⚠️ list trimmed to fit one message']).join('\n');
}

// ---------------------------------------------------------------------------------------------
// 1. SALES — ONE FUNNEL, three stages, 100% the target at each (Benjamin, 2026-08-21).
// ---------------------------------------------------------------------------------------------
// 🚨 THE GOAL THIS CARD SERVES, in the client's words: "capture all leads → assign all leads to a
// salesperson → make sure the leads are responded to promptly." Three stages, one direction, and
// the only interesting thing on any given day is WHERE IT LEAKS.
//
// This replaces a card that answered the same question four different ways. The old shape opened
// with counts and a *Why* list, then named waiting customers under one clock ("Escalated"), while
// the Boss card separately named a second clock ("no reply within 75 minutes") and a third
// ("never contacted at all"), and the orphan sweep a fourth. Four labels, four ages, two cards,
// one underlying event — a customer nobody replied to — and NO single number a reader could act
// on. Benjamin, 2026-08-21: "I cannot tell immediately what to do."
//
// So: three lines, each `have/target` with a percent bar, then ONLY the leak. The three stages
// come from the client's own contract (locked 08-14 `3d8b44b`: how many leads · how many assigned ·
// why not the rest), with the response stage added as stage 3.
//
// 🚨 THE TWO STAGES COME FROM DIFFERENT SOURCES AND THAT IS DELIBERATE.
//   Captured + Assigned + the WHY buckets → the decision log (`leadsummary`), the counting path
//     the client's contract is written against. Unchanged.
//   Replied → Lark's per-lead SLA fields (`SLA Response Time (min)`, `SLA Within SLA?`), which the
//     SLA engine has been writing durably since 2026-07. NOTHING NEW IS MEASURED HERE — this is
//     aggregation of a number that already existed per row and was never put on a card.
//   When the two sources disagree on the assigned count, BOTH numbers print (standing rule 2).
//
// ⚠️ WHAT "REPLIED" HONESTLY MEANS. `SLA Response Time (min)` is stamped when the rep replies to
// the BOT ("YES"), not when the rep messages the customer. A rep who acknowledges and then does
// nothing scores fast. The card therefore says "Acknowledged", never "Replied to customer" —
// naming a weaker fact is the honest move; renaming it would be the lie. Measuring the real reply
// needs the rep's outbound message to that customer, which this process cannot see (flagged to
// Benjamin 2026-08-21, not built).
//
// d = {
//   dateLabel, periodLabel,          // 'Thu 21 Aug' · 'Yesterday' | 'Today so far'
//   s,                               // leadsummary.summarize() — total, buckets, sumOk, read_error,
//                                    //   no_data, partialFrom. THE CONTRACT'S counting path.
//   cross,                           // { lark: {rows, capped, error} } — source #2
//   resp: {                          // stage 3, aggregated from Lark SLA fields
//     measured,                      //   rows that carry an SLA response time at all
//     onTime,                        //   of those, within `thresholdMin`
//     thresholdMin,                  //   75 (the reassign mark the client already knows)
//     byRep: [{rep, leads, avgMin, onTime}],
//     error,                         //   🚨 unreadable ⇒ the stage prints "could not read", never 0
//   },
//   lateBy: [{rep, n}],              // reps with customers past the threshold — NAME + COUNT ONLY.
//                                    //   Benjamin 08-21 simplified this deliberately: the reps get
//                                    //   the customer itself by DM, so the group card is a
//                                    //   scoreboard, not a worklist. ⚠️ Consequence, stated out
//                                    //   loud: an admin can no longer chase on a rep's behalf from
//                                    //   this card.
//   stuckUnavailable,                // string when the Lark read failed — an unknown is not a zero
//   notLeads,                        // chats that were not sales leads (context, never in the funnel)
// }
const LS = require('./leadsummary');

const BAR_N = 10;
function bar(p){ const f = Math.max(0, Math.min(BAR_N, Math.round(p / (100 / BAR_N))));
  return '▓'.repeat(f) + '░'.repeat(BAR_N - f); }
const share = (a, b) => (b ? Math.round(100 * a / b) : 0);
function mins(m){ if (m == null) return '—';
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`; }

function salesCard(d){
  const s = d.s || {};
  const resp = d.resp || {};
  const period = d.periodLabel || 'Yesterday';
  const head = [`🏍️ *TM SALES* — ${d.dateLabel}`, ''];
  const body = [];

  // 🚨 Rule 3, both halves: an unreadable log says "could not read", and a date before the log
  // begins says "cannot see" — NEVER a confident zero in either case. The funnel cannot be drawn
  // at all without stage 1, so these return early rather than render a 0/0 that looks measured.
  if (s.read_error){
    body.push(`⚠️ Could not read the decision log, so there are no lead counts: ${clip(s.read_error, 80)}`,
      '👉 The leads themselves are unaffected. This is a reporting failure.');
    return fit(head, body);
  }
  if (s.no_data){
    body.push('ℹ️ We have no lead records for this period, so there are no counts.',
      '👉 Lead logging began later. This is NOT a quiet day.');
    return fit(head, body);
  }

  const captured = s.total || 0;
  const assigned = (s.buckets && s.buckets.assigned) || 0;
  const pA = share(assigned, captured);

  // ---- THE FUNNEL. Three lines, in the client's own order. ----
  // Labels are padded to a common width so the numbers line up. WhatsApp renders proportionally so
  // this is never pixel-perfect, but a ragged left edge reads as three unrelated facts rather than
  // one funnel — and the funnel is the whole point of the card.
  const stage = (icon, label) => `${icon} *${label}*${' '.repeat(Math.max(1, 15 - label.length))}`;
  body.push(`${stage('📥', 'Captured')}${captured}`);
  body.push(`${stage('👤', 'Assigned')}${assigned}/${captured}   ${pA}%  ${bar(pA)}`);
  if (resp.error){
    body.push(`${stage('⚡', 'Acknowledged')}could not read (${clip(resp.error, 40)})`);
  } else if (!resp.measured){
    // Nobody has acknowledged anything yet in this window. That is a real 0%, not a failed read —
    // but say WHY it is empty so it cannot be mistaken for the unreadable case above.
    body.push(`${stage('⚡', 'Acknowledged')}0/${assigned}   0%  ${bar(0)}`,
      '   (no salesperson has confirmed a lead in this window yet)');
  } else {
    const pR = share(resp.onTime, resp.measured);
    body.push(`${stage('⚡', `Answered ≤${resp.thresholdMin || 75}min`)}${resp.onTime}/${resp.measured}   ${pR}%  ${bar(pR)}`);
    // 🚨 The response stage is measured on Lark rows, the first two on the decision log. If Lark
    // has SLA data for fewer rows than the log says were assigned, the denominator is NOT the same
    // population — say so rather than letting the percentages read as one clean funnel.
    if (resp.measured < assigned)
      body.push(`   (${assigned - resp.measured} assigned lead(s) have no response record yet)`);
  }

  if (s.partialFrom) body.push('⚠️ counts cover only part of this period (lead logging began mid-window)');
  // 🚨 If the numbers do not add up, SAY SO rather than printing a tidy lie.
  if (s.sumOk === false) body.push(`⚠️ buckets don't sum to the total (${s.bucketSum} vs ${captured}), treat these numbers as suspect`);

  // ---- LEAK 1: not assigned, and why. The buckets leadsummary already computed. ----
  if (assigned < captured){
    const gap = captured - assigned;
    body.push('', `⚠️ *${gap} not assigned yet — why:*`);
    for (const k of LS.LEAD_BUCKETS.concat(['other']))
      if (k !== 'assigned' && s.buckets && s.buckets[k]) body.push(`   ${s.buckets[k]}  ${LS.WHY[k] || k}`);
  }

  // 🚨 Two sources. When they disagree, BOTH numbers go on the card.
  const lk = (d.cross || {}).lark;
  if (lk){
    if (lk.error) body.push('', `⚠️ couldn't read Lark for the cross-check: ${clip(lk.error, 60)}`);
    else {
      const expect = assigned + ((s.buckets && s.buckets.parked) || 0);
      if (lk.rows !== expect)
        body.push('', `⚠️ decision log says ${expect} assigned+parked · Lark shows ${lk.rows} row(s). Both printed because they disagree.`);
      if (lk.capped) body.push('⚠️ Lark cross-check read only the newest 100 rows — older rows may be uncounted');
    }
  }

  // ---- LEAK 2: assigned but nobody acknowledged in time. NAME + COUNT ONLY (Benjamin 08-21). ----
  const late = d.lateBy || [];
  if (d.stuckUnavailable){
    body.push('', `⚠️ Could not read Lark, so the "waited too long" list is UNKNOWN, not empty: ${clip(d.stuckUnavailable, 60)}`);
  } else if (late.length){
    const n = late.reduce((t, x) => t + x.n, 0);
    body.push('', `🔴 *${n} customer${n > 1 ? 's' : ''} waited over ${resp.thresholdMin || 75} min:*`);
    for (const x of late.slice().sort((a, b) => b.n - a.n))
      body.push(`   ${pad(x.rep || '?', 9)} ${x.n}`);
  }

  // 🚨 Say "nothing to do" OUT LOUD — but ONLY when every input was actually readable. A card that
  // is silent when all is well is indistinguishable from a card that failed to send, and an
  // all-clear over an unreadable source is the confident-zero lie.
  if (assigned >= captured && !late.length && !d.stuckUnavailable && !resp.error && captured > 0)
    body.push('', '✅ *100% at every step. Nothing to chase.*');

  // ---- THE SCOREBOARD: how fast each rep acknowledges. Stage 3's whole point. ----
  const byRep = (resp.byRep || []).slice().sort((a, b) => a.avgMin - b.avgMin);
  if (byRep.length){
    body.push('', `⏱️ *Response speed ${period === 'Yesterday' ? 'yesterday' : 'today'}*`);
    for (const r of byRep){
      const p = share(r.onTime, r.leads);
      const flag = p === 100 ? ' ✅' : (p < 70 ? ' 🔴' : '');
      body.push(`   ${pad(r.rep, 9)} ${String(r.leads).padStart(2)} leads · avg ${String(mins(r.avgMin)).padStart(6)} · ${String(p).padStart(3)}%${flag}`);
    }
    // 🚨 This card exists because ONE event was being counted on four different clocks under four
    // different names. It now uses two — deliberately, because they answer two different questions —
    // so it must say so in one line rather than let a reader discover it as a contradiction:
    // a rep can show a fast average AND appear in the late list above, when a lead was handed to
    // them after someone else had already sat on it.
    body.push('   (each salesperson\'s own clock — it restarts when a lead is passed on)');
  }

  // Context, never part of the funnel — a repeat customer is not a lead we failed to capture.
  if (d.notLeads) body.push('', `ℹ️ ${d.notLeads} other chats were not sales leads (repeat customers, staff, spam).`);
  return fit(head, body);
}

// ---------------------------------------------------------------------------------------------
// 2. MARKETING · 3. OPERATIONS · 4. BOSS — REMOVED FROM THIS FILE, 2026-08-21.
// ---------------------------------------------------------------------------------------------
// BOSS is gone entirely (Benjamin, 2026-08-21: "remove boss report, left only 3 reports — sales,
// marketing and ops"). Its content was a restatement of the other three in different words and
// different units, which is how one event — a customer nobody replied to — came to be counted four
// separate ways. Deleting it is the point, not a simplification of it.
//
// MARKETING and OPERATIONS still exist, but they are built on **box-66** in
// `/opt/apps/tm-daily-report/daily_report.py`, because both need the Mudah group ledger, the Relay
// DB and `pending_review.json` — files that physically live on that box. This process cannot read
// them, and a JS copy here could only ever be a second, drifting source of truth for numbers the
// Python already computes correctly.
//
// 🚨 That is not a hypothetical. Fork drift — the same fix landing on one copy and not the other —
// is the named root cause of the 2026-08-21 bot-fleet review. Two renderers for one card is the
// same mistake in miniature, so the JS versions are deleted rather than left dark behind an env
// flag: an unused copy is exactly the copy nobody remembers to update.
//
// Where each one now lives:
//   📣 MARKETING  → daily_report.py, `MKT_CARD=1`,  09:10 MYT → AI Agent Project TM Motoworld group
//   🔧 OPERATIONS → daily_report.py, `OPS_CARD=1`,  09:10 MYT → Benjamin's QA group
//
// ---------------------------------------------------------------------------------------------
// 5. OPS — Benjamin's card, QA group ONLY. "Everything is in order — or exactly what is broken."
// ---------------------------------------------------------------------------------------------
// NOT the client-facing `operationsCard` above (that one is the LISTING pipeline, built on box-66).
// This one is the BOT's own health, built from signals that actually exist inside this process:
//   BOOT_AT · digest.sent markers · the decision log · undelivered digest events · larkMissing +
//   sumOk from leadsummary · the backlog count · the durable last-inbound marker (heartbeat.js).
// 🚨 Every line is grounded in one of those signals. If a signal does not exist, the line does not
// either — an invented health line is worse than no line.
//
// Broken states are RANKED: SEV1 losing leads now → SEV2 client-facing numbers broken →
// SEV3 degrading → SEV4 going blind. A healthy day is SHORT, and it must still name its own blind
// spots — a health card that cannot see something and does not say so is claiming coverage it
// does not have (the inbox cross-check lives on box-66 at 09:57, not here).
//
// d = {
//   dateLabel,
//   upSinceLabel, restartedInWindow,      // BOOT_AT, rendered; restart = informational, not an issue
//   reports,                              // { expected:[..], sent:[..], missing:[..] }
//                                         //   or { legacyOff:true, cardsSentYesterday:n }
//   log: { readable, error, lastEventLabel, parseErrors },
//   counts: { larkMissing, sumOk }        // null fields = window not countable (no_data)
//        or { unavailable: '...' },       //   log unreadable — say so, never render zeros
//   undelivered: [{to, attempts, error}],
//   backlog: { count, prev, error },      // prev = last client report's count; both print, they
//                                         //   are related but not identical counters
//   inbound: { at, minutesAgo, quietBusinessHours, alarmH, noMarker, error },
//   blind: ['...'],                       // MANDATORY on a healthy card too
// }
function opsCard(d){
  const head = [`🛠️ *TM OPS* — ${d.dateLabel}`, ''];
  const lg = d.log || {}, cn = d.counts || {}, ud = d.undelivered || [];
  const bk = d.backlog || {}, ib = d.inbound || {}, rp = d.reports || {};
  const issues = [];

  // SEV1 — losing leads RIGHT NOW.
  if (cn.larkMissing) issues.push(`🔴 SEV1 · ${cn.larkMissing} lead(s) have NO Lark row — the CRM write failed, nothing downstream will ever find them`);
  for (const u of ud) issues.push(`🔴 SEV1 · a send was given up on after ${u.attempts || '?'} attempt(s) → ${u.to || '?'} (${clip(u.error, 40)})`);
  // SEV2 — the client-facing numbers are broken.
  if ((rp.missing || []).length) issues.push(`🟠 SEV2 · no sent-marker for yesterday's ${rp.missing.join(', ')} report(s) — cannot prove they went out`);
  if (cn.sumOk === false) issues.push('🟠 SEV2 · lead buckets do not sum to the total — the client card\'s numbers are suspect');
  // SEV3 — degrading.
  if (bk.count != null && bk.prev != null && bk.count > bk.prev)
    issues.push(`🟡 SEV3 · stuck backlog ${bk.count}, UP from ${bk.prev} at the last client report (related counters, cross-check /lead-summary)`);
  // SEV4 — going blind. 🚨 A quiet day and a dead WaSender session look IDENTICAL from inside the
  // bot without the inbound marker; this is the line that tells them apart.
  if (lg.readable === false) issues.push(`⚪ SEV4 · decision log unreadable: ${clip(lg.error, 60)} — reporting is blind (the leads themselves are unaffected)`);
  if (lg.parseErrors) issues.push(`⚪ SEV4 · ${lg.parseErrors} unreadable line(s) in the decision log were skipped`);
  if (cn.unavailable) issues.push(`⚪ SEV4 · ${clip(cn.unavailable, 90)}`);
  if (bk.error) issues.push(`⚪ SEV4 · could not read the backlog from Lark: ${clip(bk.error, 50)}`);
  if (ib.error) issues.push(`⚪ SEV4 · could not read the last-inbound marker: ${clip(ib.error, 50)}`);
  else if (ib.at != null && ib.quietBusinessHours != null && ib.alarmH != null && ib.quietBusinessHours >= ib.alarmH)
    issues.push(`⚪ SEV4 · no inbound WhatsApp message for ${ib.quietBusinessHours}h of business hours (alarm at ${ib.alarmH}h) — a dead WaSender session looks exactly like a quiet day`);

  const body = [];
  body.push(issues.length ? issues.shift() : '✅ No problems detected.');
  body.push(...issues);
  body.push('');
  body.push(`▸ Up since ${d.upSinceLabel || 'unknown'}${d.restartedInWindow ? ' (restarted inside this window — RAM-only lists from before are gone)' : ''}`);
  if (rp.legacyOff)
    body.push(`▸ Legacy client reports are OFF · ${rp.cardsSentYesterday != null ? rp.cardsSentYesterday + ' card(s) provably sent yesterday' : 'card markers unavailable'}`);
  else if ((rp.expected || []).length)
    body.push(`▸ Reports provably sent yesterday: ${(rp.sent || []).length}/${rp.expected.length}${(rp.missing || []).length ? '' : ' ✅'}`);
  if (lg.readable) body.push(`▸ Decision log OK · last event ${lg.lastEventLabel || '(none yet)'}${lg.parseErrors ? '' : ' · no parse errors'}`);
  if (ib.at != null) body.push(`▸ Last inbound message ${ib.minutesAgo} min ago`);
  else if (!ib.error) body.push('▸ Last inbound message: no marker on disk yet (nothing recorded since this feature deployed)');
  if (bk.count != null) body.push(`▸ Backlog: ${bk.count} stuck lead(s)${bk.prev != null ? ' (last client report counted ' + bk.prev + ')' : ''}`);
  // 🚨 The blind line is NOT optional. A healthy card that does not say what it cannot see is
  // claiming coverage it does not have.
  const blind = (d.blind && d.blind.length) ? d.blind
    : ['inbox cross-check runs on box-66 at 09:57, not from this process'];
  body.push('', `Blind: ${blind.join(' · ')}`);
  return fit(head, body);
}

module.exports = { salesCard, opsCard, MAX };
