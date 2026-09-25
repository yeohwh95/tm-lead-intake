'use strict';
// Reads the "BOT CONTROL PANEL" page (the tab Harith gave us, 2026-09-18) and turns it into
// settings the bot actually obeys. Replaces: Render env vars for the hours, the hardcoded
// CAMPAIGN_ADS table in tiktok-lead-engine, and four reply strings baked into firstresponse.js.
//
// 🔑 PARSED BY CONTENT, NOT BY ROW NUMBER. The page is one tab with eight sections, and a human
// will insert rows, add a campaign, or paste a block in the middle of it. Every earlier version of
// this kind of reader keyed off "section starts at row 32" and broke the first time someone pressed
// Insert Row — silently, because a shifted read still returns plausible-looking strings.
//   • a key/value setting  = column A matches one of the LABELS below (whitespace/case/dash-insensitive)
//   • a campaign row       = column D is a 15–25 digit TikTok form id
//   • a planned-leave row  = column A is NOT a known label and column B is a YYYY-MM-DD date
// Those three tests cannot collide, so sections may be moved or reordered freely.
//
// Pure + injected rows so it is unit-testable; index.js does the fetching.

// ---- normalisation ---------------------------------------------------------------------------
// The sheet is typed by humans on two continents: en-dash vs em-dash vs hyphen, curly vs straight
// apostrophes, non-breaking spaces pasted out of Lark, and a stray double space in
// "Off today?  (holiday / off day)". Normalise all of it before matching, or the bot silently
// falls back to defaults on a label that looks identical on screen.
function norm(s) {
  return String(s == null ? '' : s)
    .replace(/[‐-―−]/g, '-')       // ‐ ‑ ‒ – — ― − → -
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[   ]/g, ' ')        // nbsp variants
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// id, the label as it appears in column A, and how to read column B.
const LABELS = [
  ['botOn',            'Bot ON / OFF',                                          'onoff',  true],
  ['offToday',         'Off today? (holiday / off day)',                        'yesno',  false],
  ['offDates',         'Extra off dates',                                       'dates',  []],
  ['distDays',         'Days leads are handed to a salesperson',                'days',   [1, 2, 3, 4, 5, 6]],
  ['distStart',        'Start hour',                                            'hour',   9],
  ['distEnd',          'End hour',                                              'hour',   18],
  ['replyOffHours',    'Reply to customers outside these hours?',               'yesno',  true],
  ['maySayStock',      'May the bot say whether a bike is in stock?',           'yesno',  false],
  ['maySayPrice',      'May the bot quote a price?',                            'yesno',  false],
  ['maySayWorkshop',   'May the bot answer parts / service / workshop?',        'yesno',  false],
  ['intentHold',       'Ask buy-or-sell before assigning?',                     'onoff',  true],
  ['intentHoldMin',    'How long to hold for that answer (minutes)',            'int',    10],
  ['sellGoesTo',       'Sell / trade-in leads go to',                           'name',   'FITRI'],
  ['adminGoesTo',      'Insurance / roadtax / name-change go to',               'name',   'ADMIN'],
  ['stickyOwner',      'If the same customer comes back, keep the same salesperson?', 'onoff', true],
  ['replyGeneral',     'Reply - general enquiry',                               'text',   ''],
  ['replyTestRide',    'Reply - test ride',                                     'text',   ''],
  ['replyAdmin',       'Reply - insurance / roadtax / name change',             'text',   ''],
  ['replyOffHoursMsg', 'Reply - outside working hours',                         'text',   ''],
];
const BY_LABEL = new Map(LABELS.map(r => [norm(r[1]), r]));
const DEFAULTS = Object.fromEntries(LABELS.map(r => [r[0], r[3]]));

const DAYS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
// "looks like somebody tried to type a date": 18/09/2026, 2026-9-1, 18.09.26 — but NOT prose that
// merely happens to contain a number.
const DATEISH = /^\s*\d{1,4}\s*[-/.]\s*\d{1,2}/;

function isDate(s) {
  const m = DATE_RE.exec(String(s == null ? '' : s).trim());
  if (!m) return false;
  const [, y, mo, d] = m.map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

// A leave cell as the sheet API hands it over → 'YYYY-MM-DD', or '' when it cannot be read safely.
// 🚨 2026-09-25: when staff type a date, Lark converts the cell to a DATE and the v2 values API
// returns its serial day number (46287), not text. Amirul's 22–30 Sep leave arrived as
// 46287 / 46295 and was dropped with no warning — DATEISH needs a separator, a bare number has none.
// The serial is unambiguous whatever the cell's display format (m/d/yyyy, d/m/yyyy…), so convert it
// (epoch 1899-12-30, same as Excel). Typed TEXT like "9/10/2026" stays rejected + warned: that one
// really is ambiguous (9 Oct or 10 Sep) and a guessed leave switches the wrong days off.
const SERIAL_RE = /^\d{5}$/;                 // 40000–60000 ≈ 2009–2064; anything else is not a date
function leaveDate(s) {
  const t = String(s == null ? '' : s).trim();
  if (isDate(t)) return t;
  if (SERIAL_RE.test(t) && +t >= 40000 && +t <= 60000)
    return new Date(Date.UTC(1899, 11, 30) + (+t) * 86400000).toISOString().slice(0, 10);
  return '';
}

// "Mon-Sat" / "mon - fri" / "Mon,Tue,Wed" / "1,2,3,4,5,6" → [1..6].
function parseDays(raw) {
  const s = norm(raw);
  if (!s) return null;
  if (/^[0-6](\s*,\s*[0-6])*$/.test(s)) return [...new Set(s.split(',').map(Number))].sort();
  const range = /^([a-z]{3})[a-z]*\s*-\s*([a-z]{3})[a-z]*$/.exec(s);
  if (range) {
    const a = DAYS[range[1]], b = DAYS[range[2]];
    if (a == null || b == null) return null;
    const out = [];
    for (let i = 0; i < 7; i++) { const d = (a + i) % 7; out.push(d); if (d === b) break; }
    return out.sort();
  }
  const parts = s.split(/[,/]/).map(x => DAYS[x.trim().slice(0, 3)]);
  if (parts.length && parts.every(x => x != null)) return [...new Set(parts)].sort();
  return null;
}

// ---- the key/value settings ------------------------------------------------------------------
// rows = raw A..G values straight off the sheet.
function parseSettings(rows) {
  const out = Object.assign({}, DEFAULTS);
  const warnings = [], seen = new Set(), found = {};

  (rows || []).forEach((row, i) => {
    const spec = BY_LABEL.get(norm(row && row[0]));
    if (!spec) return;
    const [id, label, type] = spec;
    const raw = row[1] == null ? '' : String(row[1]).trim();
    const at = `row ${i + 1}`;
    if (seen.has(id)) { warnings.push(`"${label}" appears more than once (${at}) — the FIRST one is used, please delete the duplicate`); return; }
    seen.add(id); found[id] = true;

    if (type === 'onoff' || type === 'yesno') {
      const on = type === 'onoff' ? /^on$/i : /^yes$/i;
      const off = type === 'onoff' ? /^off$/i : /^no$/i;
      if (on.test(raw)) { out[id] = true; return; }
      if (off.test(raw)) { out[id] = false; return; }
      // An unrecognised switch is NOT guessed at. Fall back to the built-in default and say so,
      // because a typo like "Y" or "ya" silently deciding a money path is the whole failure mode
      // this page exists to remove.
      warnings.push(`"${label}" (${at}) is "${raw || '(blank)'}" — expected ${type === 'onoff' ? 'ON or OFF' : 'YES or NO'}. Using ${DEFAULTS[id] ? (type === 'onoff' ? 'ON' : 'YES') : (type === 'onoff' ? 'OFF' : 'NO')}.`);
      return;
    }
    if (type === 'hour' || type === 'int') {
      const n = Number(raw);
      if (!raw || !Number.isFinite(n) || n < 0 || (type === 'hour' && (n > 23 || !Number.isInteger(n)))) {
        warnings.push(`"${label}" (${at}) is "${raw || '(blank)'}" — expected ${type === 'hour' ? 'a whole hour 0-23' : 'a number'}. Using ${DEFAULTS[id]}.`);
        return;
      }
      out[id] = type === 'hour' ? Math.trunc(n) : n;
      return;
    }
    if (type === 'days') {
      const d = parseDays(raw);
      if (!d || !d.length) { warnings.push(`"${label}" (${at}) is "${raw || '(blank)'}" — expected e.g. Mon-Sat. Using Mon-Sat.`); return; }
      out[id] = d;
      return;
    }
    if (type === 'dates') {
      const list = raw ? raw.split(',').map(x => x.trim()).filter(Boolean) : [];
      const good = list.filter(isDate), bad = list.filter(x => !isDate(x));
      if (bad.length) warnings.push(`"${label}" (${at}): ${bad.map(b => `"${b}"`).join(', ')} is not a date — use YYYY-MM-DD. Ignored.`);
      out[id] = good;
      return;
    }
    if (type === 'name') { out[id] = raw || DEFAULTS[id]; if (!raw) warnings.push(`"${label}" (${at}) is blank — using ${DEFAULTS[id]}.`); return; }
    // text: a blank reply template means "keep whatever the bot already says", never "say nothing".
    out[id] = raw;
  });

  // A label that has VANISHED is the dangerous case: the bot would quietly run on defaults and the
  // page would look like it was in control. Name the missing row rather than describing the problem.
  const missing = LABELS.filter(r => !found[r[0]]).map(r => r[1]);
  if (missing.length) warnings.push(`these rows are missing from column A — the bot is using its built-in value for them: ${missing.join(' · ')}`);

  return { ok: Object.keys(found).length > 0, settings: out, warnings, foundCount: Object.keys(found).length };
}

// ---- section 5: TikTok ad campaigns → salesmen ------------------------------------------------
const FORM_ID_RE = /^\d{15,25}$/;

function parseCampaigns(rows) {
  const out = [], warnings = [], seenForm = new Map();
  (rows || []).forEach((row, i) => {
    const formId = String((row && row[3]) == null ? '' : row[3]).trim();
    if (!FORM_ID_RE.test(formId)) return;                         // not a campaign row
    const at = `row ${i + 1}`;
    const campaign = String(row[0] == null ? '' : row[0]).trim();
    const activeRaw = String(row[1] == null ? '' : row[1]).trim();
    const namesRaw = String(row[2] == null ? '' : row[2]).trim();

    if (seenForm.has(formId)) { warnings.push(`form id ${formId} appears twice (${at} and row ${seenForm.get(formId) + 1}) — the FIRST row wins, delete the duplicate`); return; }
    seenForm.set(formId, i);

    let active;
    if (/^yes$/i.test(activeRaw)) active = true;
    else if (/^no$/i.test(activeRaw)) active = false;
    else { active = false; warnings.push(`campaign "${campaign || formId}" (${at}) has Active?="${activeRaw || '(blank)'}" — expected YES or NO. Treated as NO, so its leads are captured but NOT auto-assigned.`); }

    // Rotation order is the order typed in the cell. Duplicates are dropped rather than served
    // twice — a name pasted in twice would otherwise get double the leads and look like a bug in
    // the rotation, not a typo in the sheet.
    const names = [], dupes = [];
    for (const raw of namesRaw.split(',').map(x => x.trim()).filter(Boolean)) {
      const key = raw.toUpperCase();
      if (names.some(n => n.toUpperCase() === key)) { dupes.push(raw); continue; }
      names.push(raw);
    }
    if (dupes.length) warnings.push(`campaign "${campaign || formId}" (${at}) lists ${dupes.map(d => `"${d}"`).join(', ')} more than once — counted once.`);
    if (active && !names.length) warnings.push(`campaign "${campaign || formId}" (${at}) is Active?=YES but no salesmen are listed — its leads would have NOBODY to go to. Treated as NO.`);

    out.push({ formId, campaign: campaign || formId, active: active && names.length > 0, names, row: i + 1 });
  });
  if (!out.length) warnings.push('no campaign rows found on the page (a campaign row is one with a 15-25 digit TikTok form id in the "TikTok form ID" column)');
  return { ok: out.length > 0, campaigns: out, warnings };
}

// ---- section 6: planned leave -----------------------------------------------------------------
// A leave row is: column A is not a known setting label, and column B is a date.
function parseLeave(rows) {
  const out = [], warnings = [];
  (rows || []).forEach((row, i) => {
    const name = String((row && row[0]) == null ? '' : row[0]).trim();
    if (!name || BY_LABEL.has(norm(name))) return;                // a setting row, not leave
    const rawFrom = String((row[1] == null ? '' : row[1])).trim();
    const rawTo = String((row[2] == null ? '' : row[2])).trim();
    const at = `row ${i + 1}`;
    if (!rawFrom && !rawTo) return;                               // blank leave row, or some other text row
    const from = leaveDate(rawFrom), to = leaveDate(rawTo);
    if (!from || !to) {
      // Only complain when the cell LOOKS like a date attempt. "contains a digit" was too loose:
      // the page's own pointer rows ("Written by the bot every 15 minutes") tripped it, and those
      // two false warnings would have been WhatsApp'd to the group on every change — the fastest
      // way to teach the team to ignore this alert.
      // A bare number counts as a date attempt too — that is what a Lark date cell looks like here.
      if ([rawFrom, rawTo].some(x => DATEISH.test(x) || /^\d+$/.test(x))) warnings.push(`planned leave for "${name}" (${at}): "${rawFrom}" - "${rawTo}" is not a valid date pair. Pick the date from the calendar, or type YYYY-MM-DD. This leave is IGNORED.`);
      return;
    }
    if (to < from) { warnings.push(`planned leave for "${name}" (${at}): "Leave until" (${to}) is BEFORE "Leave from" (${from}) — IGNORED. Swap them.`); return; }
    out.push({ name, from, to, reason: String(row[3] == null ? '' : row[3]).trim(), status: String(row[4] == null ? '' : row[4]).trim(), row: i + 1 });
  });
  return { ok: true, leave: out, warnings };
}

// Lark's v2 values PUT rejects a SINGLE-CELL range: "E47" returns code=90202 "wrong range". It
// wants "E47:E47". Proven against the live sheet 2026-09-18 ("Z80" -> 90202, "Z80:Z80" -> 0).
// Lives here, tested, rather than inline at the call site: this is the write that switches a
// salesperson off and back on, and it failed silently the first time it ran for real.
function a1Range(a1){
  const s = String(a1 == null ? '' : a1).trim();
  return s.includes(':') ? s : `${s}:${s}`;
}

module.exports = { norm, isDate, leaveDate, parseDays, parseSettings, parseCampaigns, parseLeave, a1Range, LABELS, DEFAULTS };
