// Simulated-time test for sla.js — proves nudge/reassign/escalate/YES/off-hours with injectable clock.
process.env.SLA_STORE = '/tmp/sla_test_store.json';
process.env.SLA_REASSIGN = '1';
const fs = require('fs');
try { fs.unlinkSync(process.env.SLA_STORE); } catch {}
const sla = require('./sla');

let pass = 0, fail = 0;
const ok = (n, c) => { console.log((c ? '✅' : '❌') + ' ' + n); c ? pass++ : fail++; };

// Monday 2026-06-29 10:00 MYT  (=02:00 UTC)
let clock = Date.UTC(2026, 5, 29, 2, 0, 0);
const MIN = 60000;

// mock deps — record calls
const calls = { sent: [], deleted: [], lark: [], group: [], digest: [] };
let msgSeq = 1000;
const deps = {
  waSend: async (phone, text) => { msgSeq++; calls.sent.push({ phone, text, id: msgSeq }); return msgSeq; },
  waDelete: async (id) => { calls.deleted.push(id); },
  larkUpdateSalesman: async (rec, openId) => { calls.lark.push({ rec, openId }); },
  groupNotify: async (t) => { calls.group.push(t); },
  digestPush: (ev) => { calls.digest.push(ev); },
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
  ok('T+76: reassign buffered for digest', calls.digest.some(e => e.type === 'reassign' && e.reason === 'no_response'));
  ok('T+76: lead moved off Ali', !sla._state().reps.Ali.leads.rec1);
  ok('T+76: lead now under Ahmad, reassignCount=1', sla._state().reps.Ahmad.leads.rec1.reassignCount === 1);

  // Ahmad also ignores → T+76 of the new assignment → escalate (2nd miss)
  clock += 76 * MIN; await sla.tick();
  ok('2nd miss: escalation buffered for digest', calls.digest.some(e => e.type === 'escalate'));
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
  ok('PASS buffered for digest', calls.digest.some(e => e.type === 'reassign' && e.reason === 'passed'));

  // LATE-ACK RECOVERY (the 2026-07-03 bug) — reassign PAUSED, lead flags No-Response at 75min,
  // then the rep replies LATE → must still acknowledge (not drop as noop).
  process.env.SLA_REASSIGN = '';   // pause auto-reassign (live condition)
  sla.register('Allysa', '+60123343259', [{ recordId: 'rec5', summary: 'Lambretta X250', brand: 'Lambretta', custName: 'Fara', custPhone: '+60137508882' }], 9005);
  clock += 80 * MIN; await sla.tick();   // T+80 → flags No-Response (paused, stays in store)
  ok('paused: lead flagged No-Response (not moved)', sla._state().reps.Allysa.leads.rec5.status === 'flagged_noreassign');
  const late = await sla.onReply('60123343259', '✅', 'Allysa');
  ok('LATE reply recovers the flagged lead → ack', late && late.action === 'ack' && late.late === 1 && sla._state().reps.Allysa.leads.rec5.status === 'contacted');
  const trulyNoop = await sla.onReply('60123343259', '✅', 'Allysa');   // nothing left to ack
  ok('reply with nothing pending → noop', trulyNoop && trulyNoop.action === 'noop');
  process.env.SLA_REASSIGN = '1';   // restore for any later tests

  // NAMED-LEAD PROTECTION — reassign ON, but a deliberately-named lead (override) must NOT auto-move.
  process.env.SLA_REASSIGN = '1';
  sla.register('Nabil', '+60124164828', [{ recordId: 'rec6', summary: 'X250 (Nabil)', brand: 'Lambretta', custName: 'Aiman', custPhone: '+60111222333', override: true }], 9006);
  const gc6 = calls.group.length; const snt6 = calls.sent.length;
  clock += 80 * MIN; await sla.tick();
  ok('named lead NOT auto-moved (override)', sla._state().reps.Nabil.leads.rec6.status === 'flagged_noreassign' && !sla._state().reps.Ahmad?.leads?.rec6);
  ok('named lead flagged (buffered for digest, not moved)', calls.digest.some(e => e.type === 'flag' && /named to Nabil/.test(e.why)));

  // GO-LIVE CUTOFF — a lead assigned BEFORE SLA_REASSIGN_FROM must NOT move even if round-robin.
  process.env.SLA_REASSIGN_FROM = String(clock + 1000 * MIN);   // cutoff far in the future
  sla.register('Aso', '+60127674828', [{ recordId: 'rec7', summary: 'old lead', brand: 'Lambretta', custName: 'Old', custPhone: '+60199000111' }], 9007);
  clock += 80 * MIN; await sla.tick();
  ok('pre-cutoff lead NOT moved (new-leads-only guard)', sla._state().reps.Aso.leads.rec7.status === 'flagged_noreassign');
  process.env.SLA_REASSIGN_FROM = '';

  // REHYDRATE (2026-07-24): register with an ORIGINAL assignedAt (boot restore after deploy) —
  // the 60-min nudge must fire relative to the original time, not the restore time.
  sla.register('Roy', '+60123943259', [{ recordId: 'recR', summary: 'rehydrated', brand: 'HQ', custName: '', custPhone: '+60177778888', override: true, assignedAt: clock - 61 * MIN, firstAssignedAt: clock - 61 * MIN }], null);
  ok('rehydrated lead keeps original assignedAt', sla._state().reps.Roy.leads.recR.assignedAt === clock - 61 * MIN);
  clock += 1 * MIN; await sla.tick();   // 62 min after ORIGINAL assign (still in hours) → nudge due, reassign not yet
  ok('rehydrated timer resumes (nudge fires past T+60 of original assign)', calls.sent.some(s => s.phone === '+60123943259' && /Not acknowledged yet/.test(s.text)));
  ok('rehydrated lead not reassigned before T+75', sla._state().reps.Roy.leads.recR.status === 'pending');

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
