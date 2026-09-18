'use strict';
// Debounced "what changed on the control sheet" announcer (Benjamin, 2026-09-18).
//
// BEFORE: pollAvailability announced every change the moment it saw it, every 2 minutes. Harith
// flips five people in one sitting and the group gets up to five messages — and a group that pings
// five times for one edit is a group people mute, which costs us the alerts that matter.
//
// Benjamin's shape: edit → wait 3 min → then one message. Three things added on top, each because
// the plain fixed delay gets one real case wrong:
//
//   1. DEBOUNCE ON QUIET, not a fixed delay. The timer restarts on every new edit, so one message
//      per editing SESSION rather than one per 3-minute slice of it.
//   2. HARD CAP from the first change. Pure debounce can be starved forever by somebody editing
//      continuously — the cap guarantees the message always lands.
//   3. NET-ZERO SUPPRESSION. The diff is taken against the state when the burst STARTED, not the
//      previous poll. Flip somebody OFF and back ON inside the window and there is nothing to
//      announce — a fixed delay would still send "X → OFF, X → back ON", which reads as an
//      incident and is really just somebody correcting a misclick.
//
// Pure. index.js owns the timers and the sending.

const QUIET_MS = Number(process.env.SHEET_QUIET_MS || 3 * 60 * 1000);   // 3 min of no edits
const MAX_MS   = Number(process.env.SHEET_MAX_MS   || 10 * 60 * 1000);  // …but never hold longer

// Ready to speak? Either the edits have stopped, or we have waited long enough.
function shouldFlush(now, lastChangeTs, burstStartTs, quietMs, maxMs){
  if (!lastChangeTs) return false;
  const q = quietMs == null ? QUIET_MS : quietMs;
  const m = maxMs == null ? MAX_MS : maxMs;
  return (now - lastChangeTs >= q) || (now - burstStartTs >= m);
}

// before/after: { name: 'YES'|'NO' }.  skip: Set of lowercased names the BOT itself changed —
// Planned Leave already announces those, and saying it twice makes the page look like two systems.
function diffAvail(before, after, skip){
  const out = [];
  const s = skip || new Set();
  for (const name of Object.keys(after || {})){
    const b = (before || {})[name], a = after[name];
    if (!b || b === a) continue;
    if (s.has(name.trim().toLowerCase())) continue;
    out.push({ name, from: b, to: a, line: a === 'NO' ? `🔴 ${name} → OFF (no new leads)` : `✅ ${name} → back ON` });
  }
  // Somebody REMOVED from the sheet stops receiving leads just as surely as somebody set to NO,
  // and that used to be invisible. A blank row is not the same as a row that says NO.
  for (const name of Object.keys(before || {})){
    if ((after || {})[name] == null && !s.has(name.trim().toLowerCase()))
      out.push({ name, from: before[name], to: '(removed)', line: `⚠️ ${name} → removed from the sheet (receives nothing)` });
  }
  return out;
}

// Generic: settings/campaign rows, compared as label -> printable value.
function diffMap(before, after, label){
  const out = [];
  if (!before) return out;                       // first read is a baseline, never an announcement
  for (const k of Object.keys(after || {})){
    const b = before[k], a = after[k];
    if (b === undefined || b === a) continue;
    out.push(`• ${label ? label + ' ' : ''}${k}: ${b} → ${a}`);
  }
  for (const k of Object.keys(before)) if ((after || {})[k] === undefined) out.push(`• ${label ? label + ' ' : ''}${k}: removed`);
  return out;
}

// Flatten what we want to watch on the panel into label -> string, so diffMap can do the work.
function settingsFingerprint(st, campaigns){
  if (!st) return null;
  const f = {};
  const show = v => Array.isArray(v) ? (v.length ? v.join(', ') : '(none)') : v === true ? 'ON' : v === false ? 'OFF' : String(v);
  for (const k of ['botOn','offToday','offDates','distDays','distStart','distEnd','replyOffHours',
                   'maySayStock','maySayPrice','intentHold','intentHoldMin','sellGoesTo','adminGoesTo','stickyOwner']) f[k] = show(st[k]);
  // Reply wording is watched by LENGTH + first words, not in full: the whole paragraph in a
  // WhatsApp diff is unreadable, and the useful signal is only "somebody changed this one".
  for (const k of ['replyGeneral','replyTestRide','replyAdmin','replyOffHoursMsg'])
    f[k] = st[k] ? `"${String(st[k]).slice(0, 40)}…" (${String(st[k]).length} chars)` : '(built-in)';
  for (const c of campaigns || []) f[`campaign "${c.campaign}"`] = `${c.active ? 'ON' : 'off'} — ${c.names.join(', ') || '(nobody)'}`;
  return f;
}

function buildMessage(availLines, settingLines){
  const parts = [];
  if (availLines.length) parts.push('🔔 *Salesman availability changed*\n' + availLines.map(x => x.line).join('\n'));
  if (settingLines.length) parts.push('🎛 *Bot settings changed*\n' + settingLines.join('\n'));
  return parts.join('\n\n');
}

module.exports = { shouldFlush, diffAvail, diffMap, settingsFingerprint, buildMessage, QUIET_MS, MAX_MS };
