// Simulated-time test for sla.js — proves nudge/reassign/escalate/YES/off-hours with injectable clock.
process.env.SLA_STORE = '/tmp/sla_test_store.json';
const fs = require('fs');
try { fs.unlinkSync(process.env.SLA_STORE); } catch {}
const sla = require('./sla');

let pass = 0, fail = 0;
const ok = (n, c) => { console.log((c ? '✅' : '❌') + ' ' + n); c ? pass++ : fail++; };

// Monday 2026-06-29 10:00 MYT  (=02:00 UTC)
let clock = Date.UTC(2026, 5, 29, 2, 0, 0);
const MIN = 60000;

// mock deps — record calls
const calls = { sent: [], deleted: [], lark: [], group: [] };
let msgSeq = 1000;
const deps = {
  waSend: async (phone, text) => { msgSeq++; calls.sent.push({ phone, text, id: msgSeq }); return msgSeq; },
  waDelete: async (id) => { calls.deleted.push(id); },
  larkUpdateSalesman: async (rec, openId) => { calls.lark.push({ rec, openId }); },
  groupNotify: async (t) => { calls.group.push(t); },
  pickNextRep: async (brand, currentKey) => ({ key: 'Ahmad', name: 'Ahmad', phone: '+60111111111', openId: 'ou_ahmad' }),
  log: () => {},
};
sla.init(deps, { now: () => clock });

(async () => {
  // T+0 register a lead to Ali during hours
  sla.register('Ali', '+60122223333', [{ recordId: 'rec1', summary: 'Lambretta V200', brand: 'Lambretta', custName: 'Encik Ahmad', custPhone: '+60199998888' }], 9001);
  ok('registered (in hours)', Object.keys(sla._state().reps.Ali.leads).length === 1);

  // T+30 → nothing
  clock += 30 * MIN; await sla.tick();
  ok('T+30: no nudge yet', calls.sent.length === 0);

  // T+61 → summary nudge to Ali
  clock += 31 * MIN; await sla.tick();
  ok('T+61: summary nudge sent to Ali', calls.sent.length === 1 && /Not acknowledged|reassigned in 15 min/i.test(calls.sent[0].text));

  // T+76 → reassign to Ahmad
  clock += 15 * MIN; await sla.tick();
  ok('T+76: old DM 9001 deleted', calls.deleted.includes(9001));
  ok('T+76: summary deleted too', calls.deleted.length === 2);
  ok('T+76: new rep Ahmad DMed', calls.sent.some(s => s.phone === '+60111111111' && /Reassigned Lead/.test(s.text)));
  ok('T+76: Lark Salesman updated', calls.lark.length === 1 && calls.lark[0].openId === 'ou_ahmad');
  ok('T+76: group notified of reassign', calls.group.some(t => /Reassigned/.test(t)));
  ok('T+76: lead moved off Ali', !sla._state().reps.Ali.leads.rec1);
  ok('T+76: lead now under Ahmad, reassignCount=1', sla._state().reps.Ahmad.leads.rec1.reassignCount === 1);

  // Ahmad also ignores → T+76 of the new assignment → escalate (2nd miss)
  clock += 76 * MIN; await sla.tick();
  ok('2nd miss: escalated to manager', calls.group.some(t => /not picked up|Needs a manager/i.test(t)));
  ok('2nd miss: status escalated', sla._state().reps.Ahmad.leads.rec1.status === 'escalated');

  // ACK path — ANY message confirms (not just "yes")
  sla.register('Bella', '+60133334444', [{ recordId: 'rec2', summary: 'Honda CB650', brand: 'Honda', custName: 'Siti', custPhone: '+60177776666' }], 9002);
  const matched = await sla.onReply('60133334444', 'ok on it thanks');
  ok('ANY message acknowledges (not just YES)', matched && matched.action === 'ack' && matched.repKey === 'Bella' && sla._state().reps.Bella.leads.rec2.status === 'contacted');
  clock += 80 * MIN; const before = calls.sent.length; await sla.tick();
  ok('acknowledged lead never reassigns', calls.sent.length === before);

  // NAME-match path — reply from a @lid JID (no phone), matched by NAME → still acknowledges (the real bug)
  sla.register('Syaza', '+60123773259', [{ recordId: 'rec4', summary: 'Honda RS150', brand: 'Honda', custName: 'Lim', custPhone: '+60188887777' }], 9004);
  const byName = await sla.onReply('', '👍', 'Syaza');   // empty phone (@lid), name hint only
  ok('acknowledges by NAME when phone is a @lid', byName && byName.action === 'ack' && sla._state().reps.Syaza.leads.rec4.status === 'contacted');

  // PASS path — "pass" reassigns immediately (not wait 75min)
  sla.register('Jue', '+60155556666', [{ recordId: 'rec3', summary: 'KTM Duke', brand: 'KTM', custName: 'Ravi', custPhone: '+60166665555' }], 9003);
  const gcBefore = calls.group.length;
  const passRes = await sla.onReply('60155556666', 'pass');
  ok('PASS reassigns immediately', passRes && passRes.action === 'pass' && !sla._state().reps.Jue?.leads?.rec3 && sla._state().reps.Ahmad?.leads?.rec3);
  ok('PASS notified the group', calls.group.slice(gcBefore).some(t => /Passed/.test(t)));

  // off-hours: register at Sunday → skipped
  let clock2 = Date.UTC(2026, 5, 28, 4, 0, 0); // Sunday 12:00 MYT
  sla.init(deps, { now: () => clock2 });
  try { fs.unlinkSync(process.env.SLA_STORE); } catch {}
  sla.init(deps, { now: () => clock2 });
  sla.register('Ali', '+60122223333', [{ recordId: 'rec9', summary: 'x', brand: '', custName: 'z', custPhone: '' }], 9009);
  ok('off-hours (Sunday) register skipped', !sla._state().reps.Ali);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
