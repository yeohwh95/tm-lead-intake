// heartbeat.js — durable "when did WhatsApp last speak to us" marker (2026-08-18).
//
// 🚨 WHY THIS EXISTS. `recent[]` is RAM-only, so from inside the bot a QUIET DAY and a DEAD
// WASENDER SESSION are indistinguishable — both look like "no recent webhooks", and a restart
// wipes even that. The session dying is the one failure that silently loses EVERY lead at once,
// and nothing on the Render side could see it. So: every inbound message stamps a timestamp to a
// file on the persistent disk (beside fr_state.json, same derivation as gate_events.jsonl /
// fr_events.jsonl — lands on /data in prod with no new env var). The ops card then measures how
// many BUSINESS hours have passed since the stamp: a weekend of silence is normal, three business
// hours of silence at TM's volume (20–70 leads/day) is a dead session until proven otherwise.
//
// 🚨 BEST-EFFORT, ALWAYS — same contract as frLogEvent/gateLogEvent, with the same ENOSPC test:
// a full disk or a bad permission costs a marker write, NEVER a message. Writes are throttled
// (default at most once per 60s) because this fires on every webhook.
const fs = require('fs'), path = require('path');

const DEFAULT_FILE = process.env.LAST_INBOUND_FILE
  || path.join(path.dirname(process.env.FR_STATE_FILE || path.join(__dirname, 'fr_state.json')), 'last_inbound.json');
const DEFAULT_THROTTLE_MS = Number(process.env.INBOUND_STAMP_MS || 60000);

// An INBOUND message: a `messages.upsert` that is not our own echo. `fromMe` echoes are excluded
// so the marker means "someone out there reached us", not "we talked to ourselves" — though in
// practice a dead session delivers no echoes either. Anything that is not a message event
// (session updates, receipts under other event names) does not count: the claim on the ops card
// is "last inbound MESSAGE", and the marker must mean exactly what the card says.
function isInboundMessage(payload){
  if (!payload || payload.event !== 'messages.upsert') return false;
  let m = (payload.data || {}).messages;
  if (Array.isArray(m)) m = m[0];
  const key = (m && m.key) || {};
  if (!key.remoteJid) return false;
  return key.fromMe !== true;
}

// Business minutes elapsed between two instants, given working days + a start/end hour (MYT by
// default). Walked minute-by-minute — dumb, but correct across weekends, overnight gaps and any
// day-set, and cheap at the 2×/day the ops card runs. 🚨 NO SILENT CAPS: the walk is capped at 14
// days and the result SAYS when the cap was hit, so ">= 76.5h" can never be misread as exact.
function businessMinutesBetween(fromMs, toMs, days, startH, endH, off){
  const o = off == null ? 8 * 3600 * 1000 : off;
  const ds = (days && days.length ? days : [1, 2, 3, 4, 5, 6]).filter(n => Number.isInteger(n) && n >= 0 && n <= 6);
  const sH = startH == null ? 9 : startH, eH = endH == null ? 18 : endH;
  if (!(toMs > fromMs) || !ds.length) return { minutes: 0, capped: false };
  const CAP_MIN = 14 * 24 * 60;
  let start = fromMs;
  const capped = (toMs - fromMs) / 60000 > CAP_MIN;
  if (capped) start = toMs - CAP_MIN * 60000;
  let mins = 0;
  for (let t = start; t < toMs; t += 60000){
    const d = new Date(t + o);
    if (!ds.includes(d.getUTCDay())) continue;
    const h = d.getUTCHours();
    if (h >= sH && h < eH) mins++;
  }
  return { minutes: mins, capped };
}

// Stateful instance (index.js keeps exactly one). Factory so tests get isolated state + their own
// scratch file.
function create(opts){
  const o = opts || {};
  const file = o.file || DEFAULT_FILE;
  const throttleMs = o.throttleMs == null ? DEFAULT_THROTTLE_MS : o.throttleMs;
  let ramAt = 0;          // precise, survives nothing
  let lastWriteAt = 0;    // throttle clock (attempts count, so a full disk is not hammered)
  let writeError = null;  // last write failure, surfaced on /ops — never thrown
  let fileAt = 0;         // the previous life's marker, read once at boot
  let fileError = null;

  // Boot read. ENOENT means two OPPOSITE things (the readFrEvents lesson, 2026-08-14): a missing
  // FILE in a healthy directory is a fresh feature with nothing stamped yet — legitimately blank.
  // A missing DIRECTORY means /data is not mounted or the path has a typo, and treating that as
  // "no messages yet" would be a confident zero about a thing we cannot see.
  try { fileAt = Number(JSON.parse(fs.readFileSync(file, 'utf8')).at) || 0; }
  catch (e){
    if (e && e.code === 'ENOENT'){
      try { fs.accessSync(path.dirname(file)); }
      catch { fileError = `last-inbound directory is unreadable (${path.dirname(file)})`; }
    } else fileError = String(e.message || e).slice(0, 80);
  }

  // Called on every inbound webhook. Filters to real inbound messages itself when handed the
  // payload; called with no payload it stamps unconditionally. 🚨 NEVER throws — a marker is
  // monitoring, and monitoring must never break a lead.
  function noteInbound(nowMs, payload){
    try {
      if (payload !== undefined && !isInboundMessage(payload)) return false;
      if (nowMs > ramAt) ramAt = nowMs;
      if (nowMs - lastWriteAt >= throttleMs){
        lastWriteAt = nowMs;
        try { fs.writeFileSync(file, JSON.stringify({ at: nowMs })); writeError = null; }
        catch (e){ writeError = String(e.message || e).slice(0, 80); }
      }
      return true;
    } catch { return false; }
  }

  // Best knowledge of the last inbound message. RAM wins when fresher (the file is up to a
  // throttle-interval stale by design); the boot-read file value covers the span before this
  // process started. `at: null` means "no marker exists", which is NOT the same as "a long time
  // ago" — the caller must render it as unknown, never as an age.
  function status(nowMs){
    const at = Math.max(ramAt, fileAt) || null;
    return { at, minutesAgo: at ? Math.round((nowMs - at) / 60000) : null,
      file, fileError, writeError };
  }

  return { noteInbound, status, _file: file };
}

module.exports = { create, isInboundMessage, businessMinutesBetween };
