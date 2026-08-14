// Tests for notify.js — the salesperson's lead DM. Run: node notify_test.js
//
// This card is the ONLY thing a rep sees for a lead, so it has to be readable and complete.
// Two failures it now guards against:
//   • `👤 —` printed for a lead with no name (a placeholder that reads as a broken field).
//   • a no-phone @lid lead handed over with no way to reach the customer (2026-08-02).
const { notifyText } = require('./notify');

let pass = 0, fail = 0;
const ok = (cond, name) => { cond ? (pass++, console.log('✅', name)) : (fail++, console.log('❌', name)); };

// 🚨 The dash rule, in one place. Em dash AND standalone spaced hyphen — these fixtures are fully
// controlled, so both can be asserted here (the suite-wide assert in the flow tests checks only the
// em dash, because an interpolated WooCommerce product name may legitimately contain " - ").
const NO_DASH = t => !/—/.test(t) && !/ - /.test(t);

const withName = { name: 'Ariff', phone: '+60123456789', want: 'zontes 368G', brand: 'Zontes', origin: 'WhatsApp Direct' };
const noName   = { name: '',      phone: '+60123456789', want: 'zontes 368G', brand: 'Zontes', origin: 'WhatsApp Direct' };
const noPhone  = { name: '',      phone: '',              want: 'cbr150',     brand: '',       origin: 'WhatsApp Direct' };

// ---- single lead, with a name ----
const a = notifyText([withName]);
ok(/🔔 \*New Lead: Zontes\*/.test(a), 'single: header uses a colon, not an em dash');
ok(/👤 Ariff/.test(a), 'single: the name is shown when we have one');
ok(/👉 https:\/\/wa\.me\/60123456789/.test(a), 'single: wa.me link on a real phone');
ok(NO_DASH(a), 'single: no dash anywhere');

// ---- single lead, NO name: the line is OMITTED, never a placeholder ----
const b = notifyText([noName]);
ok(!/👤/.test(b), '🚨 no name → the 👤 line is omitted entirely (not "👤 —")');
ok(/🎯 Wants: zontes 368G/.test(b), 'no name: the rest of the card is intact');
ok(NO_DASH(b), 'no name: no dash anywhere');

// ---- single lead, NO phone: the rep must still be told how to reach them ----
const c = notifyText([noPhone]);
ok(/hidden by WhatsApp/.test(c) && /TM Marketing \(93210\)/.test(c),
   'no phone: the inbox fallback line is present (2026-08-02 — an unactionable lead)');
ok(!/wa\.me/.test(c), 'no phone: never a wa.me link to nothing');
ok(NO_DASH(c), '🚨 no phone: the fallback line is dash-free');
ok(/🔔 \*New Lead: TM Motoworld\*/.test(c), 'no brand: falls back to TM Motoworld, still a colon');

// ---- multi-lead ----
const d = notifyText([withName, noName, noPhone]);
ok(/🔔 \*3 New Leads\*/.test(d), 'multi: counted header');
ok(/\*1\.\* 👤 Ariff/.test(d), 'multi: numbered, name shown when present');
ok(/\*2\.\*\n🎯/.test(d), 'multi: the number survives when the name is missing');
ok(!/👤 —/.test(d), '🚨 multi: no "👤 —" placeholder either');
ok(/zontes 368G · Zontes · WhatsApp Direct/.test(d), 'multi: the · separator stays (a middot is not a dash)');
ok(NO_DASH(d), 'multi: no dash anywhere');

// ---- in-word hyphens must SURVIVE the sweep ----
const e = notifyText([{ name: 'Bob', phone: '+60129323259', want: 'MT-09 trade-in', brand: 'HQ', origin: 'Mudah' }]);
ok(/MT-09 trade-in/.test(e), 'hyphens inside words and model names are kept (MT-09, trade-in)');
ok(NO_DASH(e), 'in-word hyphens do not trip the dash assert');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
