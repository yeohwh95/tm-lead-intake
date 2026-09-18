'use strict';
// "Message Types" tab -> how the bot reads a customer's first message.
//
// Benjamin, 2026-09-18: one sheet TM edits, so the bot gets more accurate without us. What that
// actually means, precisely, because it is easy to promise more than this delivers:
//   • the sheet is re-read every 5 min and rebuilt into the classifier's prompt — NOTHING is
//     trained or remembered. The AI is handed these words fresh on every single message.
//   • KEYWORDS are deterministic and win outright. EXAMPLES steer the AI and do not.
//   • the TYPE NAMES and what each one DOES stay in code. A sheet edit must never be able to
//     invent a destination or send a lead somewhere nobody is watching.
//
// Parsed BY CONTENT (a row whose column A is a known type), not by row number — the team will
// insert rows.

// The closed set. Column A must match one of these; anything else is reported, never guessed at.
// `action` is what index.js/firstresponse.js DO with it and is deliberately not editable.
const TYPES = {
  product:  { action: 'assign',            desc: 'wants to BUY - model, price, stock, colour' },
  sell:     { action: 'purchaser',         desc: 'selling or trading in their OWN bike to us' },
  loan:     { action: 'assign',            desc: 'financing to buy from us' },
  testride: { action: 'assign',            desc: 'wants a test ride' },
  chasing:  { action: 'reping',            desc: 'already ours, nobody has contacted them' },
  admin:    { action: 'handoff_admin',     desc: 'paperwork only - ownership, roadtax, insurance' },
  hiring:   { action: 'handoff_hr',        desc: 'asking about a job' },
  workshop: { action: 'handoff_workshop',  desc: 'parts, service, repair' },
  greeting: { action: 'ask',               desc: 'hello and nothing else' },
  skip:     { action: 'ignore',            desc: 'OTP / vendor / automated' },
};
// Types whose regex in firstresponse.js is battle-tested. A sheet KEYWORD must never override one
// of these, or a stray word in the sheet could redirect a trade-in away from the purchaser.
const PROTECTED = new Set(['sell']);
// Cost guard: every example is re-sent on EVERY classification call. Past ~12 per type the accuracy
// gain is negligible and the bill is not, so the extras are dropped and the team is told.
const MAX_EXAMPLES = 12;

const norm = s => String(s == null ? '' : s)
  .replace(/[‐-―−]/g, '-').replace(/[   ]/g, ' ')
  .replace(/\s+/g, ' ').trim().toLowerCase();

// A cell holds one item per LINE. Everything after a "<-" or "←" is the team explaining themselves
// to each other ("kedai ada jual X? <- that asks what WE sell"), not part of the customer's words.
function lines(cell){
  return String(cell == null ? '' : cell).split(/\r?\n/)
    .map(x => x.split(/\s*(?:<-|←)/)[0].trim())
    .filter(x => x && x.length > 1);
}
function commas(cell){
  return String(cell == null ? '' : cell).split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
}

// rows = raw A..G off the sheet.
function parseTypes(rows){
  const out = {}, warnings = [], seen = new Set();
  (rows || []).forEach((row, i) => {
    const key = norm(row && row[0]);
    if (!key) return;
    if (!TYPES[key]) return;                       // prose / headings / anything not a known type
    const at = `row ${i + 1}`;
    if (seen.has(key)) { warnings.push(`"${key}" appears twice (${at}) — the FIRST row is used, delete the duplicate`); return; }
    seen.add(key);

    let examples = lines(row[2]), never = lines(row[3]);
    const keywords = commas(row[4]);
    if (examples.length > MAX_EXAMPLES){
      warnings.push(`"${key}" has ${examples.length} example messages (${at}) — only the first ${MAX_EXAMPLES} are used. Every example is re-sent on every message, so more costs money without helping much.`);
      examples = examples.slice(0, MAX_EXAMPLES);
    }
    if (never.length > MAX_EXAMPLES) never = never.slice(0, MAX_EXAMPLES);
    // A keyword like "ada" matches nearly every Malay message. Silently accepting it would quietly
    // route most of the day's leads to one type.
    for (const k of keywords) if (k.length < 3) warnings.push(`"${key}" has the keyword "${k}" (${at}) — too short, it would match almost every message. Ignored.`);
    out[key] = { type: key, action: TYPES[key].action, meaning: String(row[1] || '').trim(),
                 examples, never, keywords: keywords.filter(k => k.length >= 3), row: i + 1 };
  });

  const missing = Object.keys(TYPES).filter(t => !out[t]);
  if (missing.length) warnings.push(`these types are not on the page, so the bot uses its built-in wording for them: ${missing.join(', ')}`);
  return { ok: Object.keys(out).length > 0, types: out, warnings, found: Object.keys(out).length };
}

// Deterministic layer. Whole-word match so "loan" does not fire inside "loanable", and the longest
// keyword wins so a specific phrase beats a generic one.
function keywordMatch(text, types){
  const t = ' ' + norm(text).replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ') + ' ';
  let best = null;
  for (const k of Object.keys(types || {})){
    for (const kw of types[k].keywords || []){
      const n = norm(kw).replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ');
      if (!n) continue;
      if (t.includes(' ' + n + ' ') && (!best || n.length > best.len)) best = { type: k, kw: n, len: n.length };
    }
  }
  return best;
}

// Rebuild the classifier prompt from the sheet. `builtin` is the shipped prompt, used when the
// sheet gives us nothing usable — never a blank prompt, which would make the AI answer anything.
function buildPrompt(parsed, builtin){
  if (!parsed || !parsed.ok) return builtin;
  const names = Object.keys(parsed.types);
  const L = [];
  L.push('You classify the FIRST WhatsApp message a customer sends to TM Motoworld, a Malaysian motorcycle dealer. Messages are Malay (often short-forms: nk, sy, x, bleh, tnya), English, or mixed.');
  L.push('Answer with EXACTLY one word from: ' + names.join(', '));
  for (const n of names){
    const t = parsed.types[n];
    let line = `- ${n} = ${t.meaning || TYPES[n].desc}`;
    if (t.examples.length) line += `\n    Real customer messages that ARE ${n}: ` + t.examples.map(e => `"${e}"`).join(' | ');
    if (t.never.length) line += `\n    NOT ${n} (these were classified wrongly before): ` + t.never.map(e => `"${e}"`).join(' | ');
    L.push(line);
  }
  // Kept in code, not on the sheet: these two rules are why trade-ins reach the purchaser at all,
  // and a well-meaning edit that dropped them would cost TM the bike.
  L.push('Priority for mixed messages: sell beats loan beats product beats greeting.');
  L.push('A message that opens with a greeting and then says something is NOT greeting - classify what comes after the greeting.');
  L.push('Naming bike models does NOT make it product when the customer is handing US a bike.');
  return L.join('\n');
}

module.exports = { TYPES, PROTECTED, MAX_EXAMPLES, norm, lines, parseTypes, keywordMatch, buildPrompt };
