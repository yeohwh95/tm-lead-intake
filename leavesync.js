'use strict';
// Planned Leave → the Available? column on the "Salesman Availability" tab.
//
// WHY it writes into that tab instead of being a second source of truth: every consumer already
// reads Available? (this bot every 5 min, tiktok-lead-engine every run at 09:00, and the rotation
// skip inside both). A parallel "is X on leave" flag would be a FIFTH copy of the team list, and
// drift between copies has already cost TM real leads four times. So leave is an INPUT that sets
// the one column everybody already obeys.
//
// 🔑 It restores the PRIOR value, not YES. Bella sits at NO for a reason that has nothing to do
// with leave; a resigned rep sits at NO permanently. Blindly writing YES on the return date would
// switch such a person back on and start feeding them customers with nobody noticing.
//
// Pure: takes today's date + the two sheets' rows, returns the writes to make. index.js executes.

const STAMP = /\(was\s+(YES|NO)\)/i;

function norm(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase(); }

// avail = [{ name, value:'YES'|'NO'|'', row }]  (row = 1-indexed row on the availability tab)
// leave = parseLeave().leave
// today = 'YYYY-MM-DD' in Malaysia time
function plan(leave, avail, today) {
  const writes = [];        // { row, value }            → Available? column on the availability tab
  const statuses = [];      // { row, value }            → Status column on the control panel
  const alerts = [];        // human-readable, for the internal group
  const notes = [];         // log lines

  const byName = new Map();
  for (const a of avail || []) {
    const k = norm(a.name);
    if (k && !byName.has(k)) byName.set(k, a);
  }

  // group leave rows per person — someone can have several bookings on the page
  const groups = new Map();
  for (const l of leave || []) {
    const k = norm(l.name);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(l);
  }

  for (const [key, rows] of groups) {
    const person = byName.get(key);
    if (!person) {
      // NEVER fuzzy-match a name onto a real person's lead allocation. Guessing "megat" → "jebat"
      // once already cost leads; here a wrong guess would switch off somebody who is working.
      for (const l of rows) {
        const want = `⚠️ name not found on the Salesman Availability tab — check the spelling`;
        if (l.status !== want) statuses.push({ row: l.row, value: want });
      }
      alerts.push(`⚠️ *Planned Leave*: "${rows[0].name}" is not on the Salesman Availability tab, so their leave cannot be applied. Check the spelling — it must match column A exactly.`);
      continue;
    }

    const cur = /^no$/i.test(person.value) ? 'NO' : 'YES';
    const active = rows.filter(l => l.from <= today && today <= l.to);
    const ended = rows.filter(l => l.to < today);

    if (active.length) {
      // pick the booking that is already stamped, so a prior value captured on day 1 survives
      const stamped = active.find(l => STAMP.test(l.status));
      const lead = stamped || active[0];
      const prior = stamped ? STAMP.exec(stamped.status)[1].toUpperCase() : cur;

      if (cur !== 'NO') {
        writes.push({ row: person.row, value: 'NO', name: person.name });
        if (stamped) {
          // Someone flipped them back ON while the page still says they are away. Respect the
          // page (it is the declaration) but say so once — silently fighting a human edit every
          // 5 minutes is how a control panel loses trust.
          alerts.push(`🔄 *Planned Leave*: ${person.name} was set to YES but the page says they are off until ${lead.to} — set back to NO. If they are back early, change "Leave until" on the Planned Leave rows.`);
        } else {
          alerts.push(`🌴 *Planned Leave*: ${person.name} is off ${lead.from} → ${lead.to}${lead.reason ? ` (${lead.reason})` : ''} — switched OFF, no new leads. Will go back to ${prior} on ${nextDay(lead.to)}.`);
        }
      } else if (!stamped && prior === 'NO') {
        // AMBIGUOUS, and it must not be guessed at: they are already OFF on day one of their leave.
        // Either a human switched them off FOR this leave (so they should come back ON), or they are
        // off for an unrelated reason such as a resignation (so they must stay OFF). Recording
        // "was NO" is the safe choice, but silently leaving somebody switched off after they return
        // is the failure this feature exists to prevent - so say it now, while there is time to fix
        // it, not on the return date.
        alerts.push(`⚠️ *Planned Leave*: ${person.name} is booked off ${lead.from} → ${lead.to}, but Available? is ALREADY NO.\n\nSo on ${nextDay(lead.to)} they will stay OFF, not come back.\nIf they should come back: set ${person.name} to *YES* on the Salesman Availability tab now — the bot will switch them off again within 5 minutes and remember YES as the value to restore.`);
      }
      const want = `on leave until ${lead.to} (was ${prior})`;
      if (lead.status !== want) statuses.push({ row: lead.row, value: want });
      // any other overlapping booking for the same person is just noted as covered
      for (const l of active) if (l !== lead) {
        const w = `on leave (covered by row ${lead.row})`;
        if (l.status !== w) statuses.push({ row: l.row, value: w });
      }
      notes.push(`${person.name}: on leave until ${lead.to}, prior=${prior}`);
      continue;
    }

    if (ended.length) {
      // the most recent finished booking decides what to restore
      const last = ended.reduce((a, b) => (b.to > a.to ? b : a));
      const m = STAMP.exec(last.status);
      if (m) {
        const prior = m[1].toUpperCase();
        if (cur !== prior) writes.push({ row: person.row, value: prior, name: person.name });
        const want = `returned ${nextDay(last.to)}`;
        // Announce on the TRANSITION, not on the write. Someone who was already OFF before their
        // leave needs no write on the return day — but saying nothing at all would read as "the bot
        // forgot to switch me back on", which is the one promise this feature makes.
        if (last.status !== want) {
          statuses.push({ row: last.row, value: want });
          alerts.push(prior === 'YES'
            ? `✅ *Planned Leave*: ${person.name} is back from leave (ended ${last.to}) — switched back ON.`
            : `ℹ️ *Planned Leave*: ${person.name}'s leave ended ${last.to}. They were already OFF before the leave, so they stay OFF — flip them to YES by hand if that is wrong.`);
        }
        notes.push(`${person.name}: returned, restored to ${prior}`);
      } else if (!/^returned/i.test(last.status)) {
        // Leave typed in after it had already finished — nothing was ever switched off, so there
        // is nothing to restore. Mark it so it is not reconsidered every 5 minutes.
        statuses.push({ row: last.row, value: `returned ${nextDay(last.to)} (never activated)` });
      }
      continue;
    }

    // future booking only
    for (const l of rows) {
      const want = `scheduled — off from ${l.from}`;
      if (l.from > today && l.status !== want && !STAMP.test(l.status)) statuses.push({ row: l.row, value: want });
    }
  }

  return { writes, statuses, alerts, notes };
}

function nextDay(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + 1));
  return dt.toISOString().slice(0, 10);
}

// today's date in Malaysia (UTC+8), as YYYY-MM-DD
function todayMYT(now) { return new Date((now == null ? Date.now() : now) + 8 * 3600 * 1000).toISOString().slice(0, 10); }

module.exports = { plan, nextDay, todayMYT };
