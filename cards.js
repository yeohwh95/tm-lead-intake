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
// 1. SALES — the client's three agreed questions (contract locked 2026-08-14, `3d8b44b`):
//    how many leads · how many assigned · WHY not the rest. Then the action list.
// ---------------------------------------------------------------------------------------------
// d = {
//   dateLabel,                       // 'Sat 16 Aug'
//   periodLabel,                     // 'Yesterday' | 'Today so far' (the 14:00 card covers TODAY)
//   s,                               // leadsummary.summarize() output — counts + WHY buckets.
//                                    //   Deliberately the SAME counting path as the client's own
//                                    //   summary card: two sources for "how many leads" is exactly
//                                    //   the confusion these cards remove.
//   cross,                           // { lark: {rows, capped, error} } — source #2; when the two
//                                    //   disagree BOTH numbers print (standing rule)
//   stuck:[{rep,phone,want}],        // Lark `SLA Status`=Escalated: reassigned once, STILL no reply.
//                                    //   ~23% of leads measured — this list is the whole point.
//   stuckUnavailable,                // string when the Lark read failed. 🚨 "couldn't read" must
//                                    //   never render as an empty list — an unknown is not a zero.
//   orphans:[{phone,want}],          // ONLY leads the orphan sweep failed 3× on. Usually empty.
// }
// The WHY strings come from leadsummary.WHY — the same map the client's summary prints. Never a
// second copy (two sources of truth for one fact always drift).
const LS = require('./leadsummary');
function salesCard(d){
  const o = d.orphans || [], st = d.stuck || [];
  const s = d.s || {};
  const period = d.periodLabel || 'Yesterday';
  const head = [`🏍️ *TM SALES* — ${d.dateLabel}`, ''];
  const body = [];

  // 🚨 Rule 3 shape, both halves: an unreadable log says "could not read", and a date before the
  // log begins says "cannot see" — NEVER a confident zero in either case.
  if (s.read_error){
    body.push(`⚠️ Could not read the decision log, so there are no lead counts: ${clip(s.read_error, 80)}`,
      '👉 The leads themselves are unaffected. This is a reporting failure.');
  } else if (s.no_data){
    body.push('ℹ️ We have no lead records for this period, so there are no counts.',
      '👉 Lead logging began later. This is NOT a quiet day.');
  } else {
    const assigned = (s.buckets && s.buckets.assigned) || 0;
    // Q1 + Q2 in one line.
    if (assigned >= s.total) body.push(`${period}: ${s.total} lead${s.total === 1 ? '' : 's'} → all ${s.total} assigned ✅`);
    else body.push(`${period}: ${s.total} lead${s.total === 1 ? '' : 's'} → ${assigned} assigned`);
    if (s.partialFrom) body.push('⚠️ counts cover only part of this period (lead logging began mid-window)');
    // 🚨 If the numbers do not add up, SAY SO rather than printing a tidy lie.
    if (s.sumOk === false) body.push(`⚠️ buckets don't sum to the total (${s.bucketSum} vs ${s.total}), treat these numbers as suspect`);
    // Q3: WHY the rest were not assigned — the buckets leadsummary already computed.
    if (assigned < s.total){
      body.push('', `*Why the other ${s.total - assigned} ${s.total - assigned === 1 ? 'was' : 'were'} not assigned:*`);
      for (const k of LS.LEAD_BUCKETS.concat(['other']))
        if (k !== 'assigned' && s.buckets && s.buckets[k]) body.push(`   • ${s.buckets[k]} ${LS.WHY[k] || k}`);
    }
    // 🚨 Two sources. When they disagree, BOTH numbers go on the card.
    const lk = (d.cross || {}).lark;
    if (lk){
      if (lk.error) body.push('', `⚠️ couldn't read Lark for the cross-check: ${clip(lk.error, 60)}`);
      else {
        const expect = ((s.buckets && s.buckets.assigned) || 0) + ((s.buckets && s.buckets.parked) || 0);
        if (lk.rows !== expect)
          body.push('', `⚠️ decision log says ${expect} assigned+parked · Lark shows ${lk.rows} row(s). Both printed because they disagree.`);
        if (lk.capped) body.push('⚠️ Lark cross-check read only the newest 100 rows — older rows may be uncounted');
      }
    }
  }

  // 🚨 THE MAIN EVENT: customers a salesperson has ignored TWICE. Measured at ~23% of leads, so
  // this list is usually non-empty and is what the client actually acts on.
  if (d.stuckUnavailable){
    body.push('', `⚠️ Could not read Lark, so the "customers still waiting" list is UNKNOWN, not empty: ${clip(d.stuckUnavailable, 60)}`);
  } else if (st.length){
    body.push('', `🚨 *${st.length} CUSTOMER${st.length > 1 ? 'S' : ''} STILL WAITING — nobody replied.*`,
      '   Reassigned once, still nothing. Please chase these by hand:');
    for (const x of st){
      const dg = digits(x.phone);
      body.push(`   • ${pad(x.rep || '?', 9)} ${dg ? '+' + dg : 'no number'} "${clip(x.want, 38)}"`);
      if (dg) body.push(`     👉 https://wa.me/${dg}`);
    }
  }

  if (o.length){
    body.push('', `🚨 *${o.length} LEAD${o.length > 1 ? 'S' : ''} WITH NO SALESPERSON*`,
      '   The bot tried 3 times and could not assign. Please do it by hand.');
    for (const x of o){
      const dg = digits(x.phone);
      body.push(`   • ${dg ? '+' + dg : 'no number'} "${clip(x.want, 46)}"`);
      if (dg) body.push(`     👉 https://wa.me/${dg}`);
    }
  }
  // 🚨 Say "nothing to do" OUT LOUD — but ONLY when both lists were actually readable. A card that
  // is silent when all is well is indistinguishable from a card that failed to send, and an
  // all-clear over an unreadable source is the confident-zero lie.
  if (!o.length && !st.length && !d.stuckUnavailable && !s.read_error && !s.no_data)
    body.push('', `✅ Everyone got a reply ${period === 'Yesterday' ? 'yesterday' : 'so far today'}.`);
  return fit(head, body);
}

// ---------------------------------------------------------------------------------------------
// 2. MARKETING — where the leads came from
// ---------------------------------------------------------------------------------------------
// d = { dateLabel, total, sources: [{label, count}] }
const SRC_ICON = { 'Tiktok DM': '💬', 'WhatsApp Direct': '📥', 'Tiktok Get Leads': '📋', 'Ads Tiktok': '🎯' };
const SRC_NAME = { 'Tiktok DM': 'TikTok DM', 'WhatsApp Direct': 'WhatsApp direct',
  'Tiktok Get Leads': 'TikTok forms', 'Ads Tiktok': 'TikTok ads' };
function marketingCard(d){
  const head = [`📣 *TM MARKETING* — ${d.dateLabel}`, ''];
  if (d.total == null) return fit(head, ['⚠️ Could not read yesterday\'s leads, so there are no counts.']);
  const src = (d.sources || []).slice().sort((a, b) => b.count - a.count);
  const body = [`Yesterday: ${d.total} leads`, ''];
  for (const s of src)
    body.push(`  ${SRC_ICON[s.label] || '•'} ${dots(SRC_NAME[s.label] || s.label, 18)}${s.count}`);
  // One derived line, because a share is a decision and a count is not.
  const tk = src.filter(s => /tiktok/i.test(s.label)).reduce((n, s) => n + s.count, 0);
  if (d.total > 0 && tk) body.push('', `TikTok is ${Math.round(100 * tk / d.total)}% of all leads.`);
  return fit(head, body);
}

// ---------------------------------------------------------------------------------------------
// 3. OPERATIONS — what is broken in the listing pipeline
// ---------------------------------------------------------------------------------------------
// d = { dateLabel, missing:[{title,plate}], attention:[{title,why}], posted, live, draft, waitingOn }
function operationsCard(d){
  const head = [`🔧 *TM OPERATIONS* — ${d.dateLabel}`, ''];
  const body = [];
  const miss = d.missing || [], att = d.attention || [];
  if (miss.length){
    body.push(`❌ *${miss.length} BIKE${miss.length > 1 ? 'S' : ''} POSTED BUT NOT ON THE WEBSITE*`,
      '   Buyers cannot find these:');
    for (const m of miss) body.push(`   • ${clip(m.title, 34)}${m.plate ? ' — ' + m.plate : ''}`);
  }
  if (att.length){
    body.push('', `⛔ *${att.length} BIKE${att.length > 1 ? 'S' : ''} CANNOT BE LISTED*`);
    for (const a of att) body.push(`   • ${clip(a.title, 32)}${a.why ? ' — ' + clip(a.why, 34) : ''}`);
  }
  if (d.posted != null)
    body.push('', `📊 This week: ${d.posted} posted · ${d.live} live${d.draft != null ? ' · ' + d.draft + ' draft' : ''}`);
  if (!miss.length && !att.length) body.push('', '✅ Nothing broken in the listing pipeline.');
  if (d.waitingOn) body.push('', `⏳ ${d.waitingOn}`);
  return fit(head, body);
}

// ---------------------------------------------------------------------------------------------
// 4. BOSS — what is costing money, worst first
// ---------------------------------------------------------------------------------------------
// d = { dateLabel, total, assigned, breached, breachByRep:[{rep,n}], neverContacted, oldestDays,
//       neverContactedModels:[..], missingBikes, topSourceLabel, topSourcePct }
// 🚨 Issues FIRST, counts last. A boss card that opens with a total is a card he stops opening,
// and then he misses the line that says leads are being lost.
function bossCard(d){
  const head = [`🏍️ *TM MOTOWORLD — Day End* (${d.dateLabel})`, ''];
  const body = [];
  if (d.breached){
    const share = d.total ? ` (1 in ${Math.max(2, Math.round(d.total / d.breached))} customers waited)` : '';
    body.push(`🔴 *${d.breached} of ${d.total} leads got no reply within 75 minutes*${share}`);
    const by = (d.breachByRep || []).slice().sort((a, b) => b.n - a.n);
    if (by.length) body.push('   ' + by.map(x => `${x.rep} ${x.n}`).join(' · '));
  }
  if (d.neverContacted){
    body.push('', `🔴 *${d.neverContacted} older leads never contacted at all*`);
    body.push(`   Oldest ${d.oldestDays} days.` +
      ((d.neverContactedModels || []).length ? ' ' + d.neverContactedModels.slice(0, 3).join(', ') + '.' : ''));
  }
  if (d.missingBikes){
    body.push('', `🟠 *${d.missingBikes} bikes posted but not live on the website*`,
      '   Buyers cannot find them.');
  }
  if (!body.length) body.push('✅ Nothing to flag today.');
  if (d.total != null){
    body.push('', `✅ ${d.total} leads yesterday` +
      (d.topSourcePct ? ` · ${d.topSourceLabel} brought ${d.topSourcePct}%` : ''));
  }
  return fit(head, body);
}

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

module.exports = { salesCard, marketingCard, operationsCard, bossCard, opsCard, MAX };
