// Parse the "Salesman Availability" tab into the roster the bot runs on.
//
// WHY: the same team list currently lives in FOUR places — tm-lead-intake `POOLS`/`STAFF`,
// tiktok-lead-engine `POOL_*`, tm-daily-report `TEAM_KW`, and this Lark sheet (which until now only
// said who was PAUSED, not who was on the team). Every hire/leave/holiday needs all four to agree,
// and when one is missed it fails silently. It has, four times:
//   • Ikhwan added to the sheet but not to the code  → zero leads for weeks
//   • Ikhwan's openId left blank in the code         → another rep's leads reported as his misses
//   • Ikhwan missing from the report's keyword list  → his leads rendered team "—"
//   • Azwin resigned, removed from ONE roster        → kept getting TikTok leads for 2 more days
// This module makes the sheet the single source. Pure + injected rows so it is unit-testable.
//
// Sheet layout (col A/B pre-existed and are untouched; C–F added 2026-07-30):
//   A Salesman Name | B Available? (YES/NO) | C Branch | D Phone | E Lark ID | F Notes
//
// BRANCH fully determines pool membership — verified equal to the hardcoded POOLS on 2026-07-30:
//   Klang     → KS
//   Shah Alam → KS + ShahAlam          (Shah Alam reps take Lambretta/Thunder AND KTM/Zontes)
//   HQ        → HQ
//   Honda     → Honda
//   blank     → no rotation at all (e.g. a resigned rep kept for history)

const BRANCH_POOLS = {
  'klang':     ['KS'],
  'shah alam': ['KS', 'ShahAlam'],
  'shahalam':  ['KS', 'ShahAlam'],
  'hq':        ['HQ'],
  'honda':     ['Honda'],
};
const POOL_KEYS = ['KS', 'HQ', 'Honda', 'ShahAlam'];

const cell  = (r, i) => String((r && r[i] != null ? r[i] : '')).trim();
const lower = (s) => String(s || '').trim().toLowerCase();

// '012-817 4828' → '+60128174828' · '011-1858 3259' → '+601118583259' · already-+60 kept as-is
function normPhone(raw){
  const d = String(raw || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.startsWith('60')) return '+' + d;
  if (d.startsWith('0'))  return '+60' + d.slice(1);
  return '+60' + d;
}
const titleCase = (s) => String(s || '').trim().toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase());

// rows = raw A..F values from the sheet (row 0 = header). knownNames = existing code-roster keys, so
// established people keep their exact code spelling ('Fazwan', not 'FAZWAN') and nothing downstream
// has to care that the sheet SHOUTS names.
function parseRoster(rows, knownNames = []) {
  const canon = new Map(knownNames.map(n => [lower(n), n]));
  const staff = {};                                    // Name -> { phone, openId, branch, available }
  const pools = Object.fromEntries(POOL_KEYS.map(k => [k, []]));
  const unavailable = new Set();                       // lowercased names marked NO
  const warnings = [];
  const seen = new Set();
  let dataRows = 0;

  (rows || []).forEach((row, i) => {
    if (i === 0) return;                               // header
    const raw = cell(row, 0);
    if (!raw) return;
    dataRows++;
    const name = canon.get(lower(raw)) || titleCase(raw);
    if (seen.has(lower(name))) { warnings.push(`duplicate row for "${raw}" (row ${i + 1}) — ignored`); return; }
    seen.add(lower(name));

    const availRaw = cell(row, 1);
    const available = !/^no$/i.test(availRaw);         // anything other than NO counts as available
    if (!/^(yes|no)$/i.test(availRaw)) warnings.push(`"${raw}" has Available?="${availRaw}" (expected YES or NO) — treated as ${available ? 'YES' : 'NO'}`);
    if (!available) unavailable.add(lower(name));

    const branchRaw = cell(row, 2);
    const phone  = normPhone(cell(row, 3));
    const openId = cell(row, 4);

    let branchPools = [];
    if (branchRaw) {
      branchPools = BRANCH_POOLS[lower(branchRaw)] || null;
      if (!branchPools) { warnings.push(`"${raw}" has unknown Branch "${branchRaw}" — put HQ / Klang / Shah Alam / Honda, or leave blank. Receiving NO leads until fixed.`); branchPools = []; }
    }
    // A rep with no usable phone can never be DM'd, so they must not enter a rotation — a lead
    // assigned to an uncontactable person is worse than one assigned to nobody.
    if (branchPools.length && !phone) { warnings.push(`"${raw}" is in Branch "${branchRaw}" but has NO phone — excluded from rotation until a phone is added`); branchPools = []; }
    if (!openId) warnings.push(`"${raw}" has no Lark ID — WhatsApp DMs still work, but their name will not fill into the Lark CRM`);

    staff[name] = { phone, openId, branch: branchRaw, available };
    for (const p of branchPools) pools[p].push(name);
  });

  if (!dataRows) warnings.push('sheet produced ZERO rows — refusing to use it (wrong tab? cleared by accident?)');
  for (const k of POOL_KEYS) if (!pools[k].length) warnings.push(`pool ${k} is EMPTY — leads routed there would have nobody to go to`);
  return { staff, pools, unavailable, warnings, ok: dataRows > 0 };
}

// Compare a parsed sheet against the compiled-in roster. Used in shadow mode to prove the sheet is
// trustworthy BEFORE it is allowed to drive live assignment.
function diffRoster(sheet, codeStaff, codePools) {
  const d = [];
  const sNames = Object.keys(sheet.staff), cNames = Object.keys(codeStaff);
  for (const n of sNames) if (!codeStaff[n]) d.push(`+ ${n}: on the sheet, not in code`);
  for (const n of cNames) if (!sheet.staff[n]) d.push(`- ${n}: in code, not on the sheet`);
  for (const n of sNames) {
    const c = codeStaff[n]; if (!c) continue;
    const sp = String(sheet.staff[n].phone || '').replace(/\D/g, '').slice(-9);
    const cp = String(c.phone || '').replace(/\D/g, '').slice(-9);
    if (sp !== cp) d.push(`~ ${n}: phone sheet=${sheet.staff[n].phone} code=${c.phone}`);
    if ((sheet.staff[n].openId || '') !== (c.openId || '')) d.push(`~ ${n}: Lark ID sheet=${sheet.staff[n].openId || '(blank)'} code=${c.openId || '(blank)'}`);
  }
  for (const k of POOL_KEYS) {
    const a = [...(sheet.pools[k] || [])].sort().join(','), b = [...(codePools[k] || [])].sort().join(',');
    if (a !== b) d.push(`~ pool ${k}: sheet=[${a}] code=[${b}]`);
  }
  return d;
}

module.exports = { parseRoster, diffRoster, normPhone, titleCase, BRANCH_POOLS, POOL_KEYS };
