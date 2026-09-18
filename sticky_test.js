'use strict';
// assignLeads is not exported, so exercise the sticky rule through a faithful copy of its shape.
// (Kept deliberately small: it asserts the RULE, not the plumbing — the plumbing is covered by the
// dry-run audit against the live CRM.)
let fail = 0, n = 0;
function ok(name, cond) { n++; if (!cond) { fail++; console.log('  ❌ ' + name); } else console.log('  ✅ ' + name); }

const STAFF = { NABIL: { openId: 'ou_n' }, JUE: { openId: 'ou_j' } };   // AZWIN deliberately absent (resigned)
function pick(phone, stickyOwner, rotationPick) {
  let assignee = '';
  if (stickyOwner) {
    const d9 = String(phone || '').replace(/\D/g, '').slice(-9);
    const prior = d9 && stickyOwner.get(d9);
    if (prior && STAFF[prior]) assignee = prior;
  }
  return assignee || rotationPick;
}

const owners = new Map([['137140357', 'NABIL'], ['199999999', 'AZWIN']]);
console.log('\n-- sticky owner --');
ok('a customer who already has a rep goes back to that rep', pick('+60137140357', owners, 'JUE') === 'NABIL');
ok('matching is on the last 9 digits, so +60/0 prefixes agree', pick('0137140357', owners, 'JUE') === 'NABIL');
ok('a NEW customer still rotates normally', pick('+60123456789', owners, 'JUE') === 'JUE');
ok('a RESIGNED prior owner is ignored — rotation wins', pick('+60199999999', owners, 'JUE') === 'JUE');
ok('switch OFF (no map) — pure rotation', pick('+60137140357', null, 'JUE') === 'JUE');
ok('blank phone cannot match anybody', pick('', owners, 'JUE') === 'JUE');
console.log(`\n${n - fail}/${n} passed`);
process.exit(fail ? 1 : 0);
