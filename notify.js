// The salesperson's lead DM. Extracted from index.js 2026-08-14 so it can be unit-tested:
// index.js boots an HTTP server on require, so no testable logic may live there (same reason as
// catalog.js / hours.js / identity.js / roster.js).
//
// 🚨 DASH RULE (2026-08-14, Benjamin approved). No em dash `—` and no standalone ` - ` in anything
// the bot sends. Hyphens INSIDE words, model names and phone numbers stay (`012-932 3259`,
// `MT-09`, `trade-in`). A dash was doing three different jobs here:
//   • `New Lead — Honda`  → punctuation, now a colon.
//   • `👤 —`              → a placeholder for a name we do not have. A placeholder that means
//                           "blank" is worse than no line: the rep reads it as a real value that
//                           failed to render. The line is now OMITTED when there is no name.
//   • `hidden by WhatsApp — reply…` → punctuation, now a full stop.
// `notify_test.js` asserts all three, plus the suite-wide no-dash regression.

// A WhatsApp username is contact info but NOT a number. wa.me takes a handle where a number
// goes, so the rep gets one tappable link either way — verified against a real customer's personal
// account 2026-08-29. Sanitised because it lands in a URL: WhatsApp handles are letters, digits,
// dot and underscore, so anything else is not a handle and must not be pasted into a link.
function handle(l){
  const u = String((l && l.username) || '').trim().replace(/^@+/, '');
  // 🚨 MUST contain a letter. Without this an all-digit string passes — and the one all-digit
  // string that reaches here is a WhatsApp PRIVACY ID, which would render as
  // `wa.me/111222333444555`: a link to a number that does not exist. That is the precise
  // failure this whole change exists to prevent, rebuilt inside the fix for it.
  // The Python bots have carried this rule since 2026-08-04; I dropped it porting to JS.
  return /^[A-Za-z0-9._]{3,30}$/.test(u) && /[A-Za-z]/.test(u) ? u : '';
}

function notifyText(leads){
  if (leads.length === 1) {
    const l = leads[0]; const d = (l.phone || '').replace(/\D/g, '');
    const u = handle(l);
    // No phone = a @lid privacy chat where WhatsApp disclosed no number (2026-08-02). The rep can
    // still serve them — but only by replying in the 93210 inbox — so say that instead of leaving
    // them with a lead they have no way to action.
    return [`🔔 *New Lead: ${l.brand || 'TM Motoworld'}*`, ``,
      l.name ? `👤 ${l.name}` : ``,
      `🎯 Wants: ${l.want}`, `📍 From: ${l.origin}`,
      d ? `👉 https://wa.me/${d}`
        : u ? `👤 @${u}\n👉 https://wa.me/${u}\n(tap to chat, there is no number to call)`
        : `⚠️ Customer's number is hidden by WhatsApp. Reply to them directly in the *TM Marketing (93210)* inbox`].filter(Boolean).join('\n');
  }
  const head = `🔔 *${leads.length} New Leads*`;
  // The `·` separator stays — a middot is not a dash.
  const blocks = leads.map((l, i) => {
    const d = (l.phone || '').replace(/\D/g, '');
    const u = handle(l);
    return [l.name ? `*${i + 1}.* 👤 ${l.name}` : `*${i + 1}.*`,
      `🎯 ${l.want} · ${l.brand || ''} · ${l.origin}`,
      // 🚨 Until 2026-08-29 this was `d ? link : ''` — a phone-less lead in a multi-lead card got
      // NO contact route at all, not even the inbox line the single-lead card offered. Flagged as
      // a known gap on 2026-08-14 and left open. A handle closes it.
      d ? `👉 https://wa.me/${d}`
        : u ? `👤 @${u} 👉 https://wa.me/${u}`
        : `⚠️ no number shared, reply in the *TM Marketing (93210)* inbox`].filter(Boolean).join('\n');
  });
  return head + '\n\n' + blocks.join('\n\n');
}

module.exports = { notifyText, handle };
