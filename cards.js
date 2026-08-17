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
// 1. SALES — "did every lead get a salesperson"
// ---------------------------------------------------------------------------------------------
// d = { dateLabel, total, assigned, orphans:[{phone,want}], stuck:[{rep,phone,want}] }
// `orphans` are ONLY leads the sweep failed 3× on. `stuck` are ONLY leads already reassigned once
// that still got no reply. Anything the system rescued never reaches here.
function salesCard(d){
  const o = d.orphans || [], s = d.stuck || [];
  const head = [`🏍️ *TM SALES* — ${d.dateLabel}`, ''];
  const body = [];
  if (d.total == null) body.push('⚠️ Could not read yesterday\'s leads, so there are no counts.',
    '👉 The leads themselves are unaffected. This is a reporting failure.');
  else if (d.assigned >= d.total) body.push(`Yesterday: ${d.total} leads → all ${d.total} assigned ✅`);
  else body.push(`Yesterday: ${d.total} leads → ${d.assigned} assigned`);

  if (o.length){
    body.push('', `🚨 *${o.length} LEAD${o.length > 1 ? 'S' : ''} WITH NO SALESPERSON*`,
      '   The bot tried 3 times and could not assign. Please do it by hand.');
    for (const x of o){
      const dg = digits(x.phone);
      body.push(`   • ${dg ? '+' + dg : 'no number'} "${clip(x.want, 46)}"`);
      if (dg) body.push(`     👉 https://wa.me/${dg}`);
    }
  }
  if (s.length){
    body.push('', `🚨 *${s.length} LEAD${s.length > 1 ? 'S' : ''} THE SYSTEM COULD NOT RESCUE*`,
      '   Reassigned once, still no reply.');
    for (const x of s){
      const dg = digits(x.phone);
      body.push(`   • ${pad(x.rep || '?', 9)} ${dg ? '+' + dg : 'no number'} "${clip(x.want, 38)}"`);
    }
  }
  // 🚨 Say "nothing to do" OUT LOUD. A card that is silent when all is well is indistinguishable
  // from a card that failed to send, and the reader cannot tell which.
  if (!o.length && !s.length && d.total != null) body.push('', '✅ Nothing needs a human today.');
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

module.exports = { salesCard, marketingCard, operationsCard, bossCard, MAX };
