// Chunked extraction for PASTED lead lists.
//
// WHY THIS EXISTS (same incident class, twice):
// 2026-07-21 — Harith dropped a 139-row test-ride Excel. `aiExtract()` was handed the whole sheet
// as one blob and returned 21 leads with `finish_reason=stop` — the model just stopped early. No
// error, no warning, a clean-looking PARTIAL result. Fixed then by `excelToChunks()` in index.js.
//
// 2026-08-04 — Harith asked whether staff can PASTE a 53-lead event list straight into the intake
// group instead of attaching a file. They can, and it hit the identical trap from the other side:
// the `document` branch chunks, the `text` branch never did. One `aiExtract` call, `max_tokens:1500`,
// ~2,700 tokens of expected JSON — so a paste either truncates into invalid JSON (→ `parseLeads`
// returns [], and a TEXT drop with no leads returns SILENTLY) or the model stops early and the group
// gets a confident "✅ 22 LEADS" card while 31 real customers vanish with no log line.
//
// Staff paste. That is how they work. So the paste path gets the same protection the file path has.
//
// Pure + exported so it can be unit-tested — index.js boots a server on require.

// A Malaysian mobile is 9+ digits after any country code, and the whole codebase already matches
// staff/rep identity on the LAST 9 DIGITS. Below 9 we would start counting dates ("2026-08-04" is
// 8 digits) and model codes as phone numbers.
const MIN_PHONE_DIGITS = 9;

// A phone-shaped run: digits plus the separators humans actually type. Deliberately EXCLUDES the
// comma, so "X250, X300, G350, LS250-S" breaks into 250 / 300 / 350 / 250 and never looks like a
// number. Letters are excluded too, so "LS250-S" and "Thunder X250" can't match.
const PHONE_RUN = /\+?\d[\d\s().+-]{6,}\d/g;

// Repeated into every chunk, so a long preamble can't bloat each call.
const PREAMBLE_MAX_LINES = 20;
const PREAMBLE_MAX_CHARS = 800;

function isLeadLine(line){
  const runs = String(line == null ? '' : line).match(PHONE_RUN) || [];
  return runs.some(r => r.replace(/\D/g, '').length >= MIN_PHONE_DIGITS);
}

// How many lines in this paste look like they carry a customer's number. Used two ways in index.js:
// to decide whether to chunk at all, and afterwards as a COMPLETENESS CHECK — if the AI returns
// fewer leads than there were phone lines, the group is told so instead of the shortfall being
// silent. It is a heuristic and is only ever used to warn a human, never to drop or invent a lead.
function leadLineCount(text){
  return String(text == null ? '' : text).split(/\r?\n/).filter(isLeadLine).length;
}

// Split a pasted list into chunks of at most `perChunk` phone-bearing records.
// Returns the text unchanged (single chunk) when nothing looks like a lead — plain group chatter
// must keep behaving exactly as it does today.
function textToChunks(text, perChunk){
  const n = Math.max(1, Number(perChunk) || 20);
  const raw = String(text == null ? '' : text);
  const lines = raw.split(/\r?\n/);
  const firstLead = lines.findIndex(isLeadLine);
  if (firstLead < 0) return [raw];

  // PREAMBLE = the header a human typed above the list, e.g. "LAMBRETTA / THUNDER LEADS (53)".
  // Repeated into EVERY chunk exactly like excelToChunks repeats the CSV header — chunk 2 must not
  // lose brand context that is only stated at the top.
  // The contiguous NON-BLANK run directly above the first phone belongs to the first RECORD (people
  // also paste "Name\n+6012...\nName\n+6019..."), so it is excluded from the preamble.
  let pEnd = firstLead;
  while (pEnd > 0 && lines[pEnd - 1].trim()) pEnd--;
  let preamble = lines.slice(0, pEnd);
  if (preamble.length > PREAMBLE_MAX_LINES) preamble = preamble.slice(0, PREAMBLE_MAX_LINES);
  let head = preamble.join('\n');
  if (head.length > PREAMBLE_MAX_CHARS) head = head.slice(0, PREAMBLE_MAX_CHARS);

  // RECORDS = each phone line plus the context lines above it. Any trailing lines after the last
  // phone attach to the last record, so no pasted line is ever thrown away.
  const records = [];
  let buf = [];
  for (let i = pEnd; i < lines.length; i++){
    buf.push(lines[i]);
    if (isLeadLine(lines[i])) { records.push(buf); buf = []; }
  }
  if (buf.length) {
    if (records.length) records[records.length - 1].push(...buf);
    else records.push(buf);
  }

  const chunks = [];
  for (let i = 0; i < records.length; i += n){
    const part = records.slice(i, i + n);
    // The "x-y of N" line mirrors excelToChunks' row counter: it tells the model how many records
    // are in front of it, which is what stops it summarising instead of extracting.
    chunks.push(
      (head ? head + '\n' : '') +
      `(leads ${i + 1}-${i + part.length} of ${records.length})\n` +
      part.map(r => r.join('\n')).join('\n')
    );
  }
  return chunks;
}

// Collapse leads that repeat the same phone number WITHIN ONE DROP.
//
// WHY (measured on the real 53-lead list, 2026-08-04): chunked extraction returned 57 leads for 53
// customers. A line naming several bikes — "48. Muhammad Amzar - +601151689420 - Lambretta X250,
// Thunder LS250-S" — makes the model emit one lead PER MODEL. That is one customer, and without
// this each copy would be round-robinned to a DIFFERENT salesperson, so two reps call the same
// person about the same enquiry. The models are merged into `interest` instead, which is the thing
// the salesperson actually needs to read.
//
// Scope is deliberately ONE drop. De-duplicating ACROSS drops is a separate, known gap (re-sending
// the same file still creates fresh rows — see the 2026-07-21 operational note) and needs a Lark
// lookup, not a local set. Leads with NO phone are never merged into each other: blank is not an
// identity, and @lid customers legitimately have none.
function dedupeByPhone(leads){
  const out = [], seen = new Map();
  for (const l of (leads || [])) {
    const key = String((l && l.phone) || '').replace(/\D/g, '').slice(-9);
    if (key.length < MIN_PHONE_DIGITS) { out.push(l); continue; }   // no usable phone → always kept
    const prev = seen.get(key);
    if (!prev) { seen.set(key, l); out.push(l); continue; }
    // Same customer twice — keep the first, but don't lose the other bike they asked about.
    const a = String(prev.interest || '').trim(), b = String(l.interest || '').trim();
    if (b && !a.toLowerCase().includes(b.toLowerCase())) prev.interest = a ? `${a}, ${b}` : b;
    if (!prev.brand && l.brand) prev.brand = l.brand;
    if (!prev.name && l.name) prev.name = l.name;
  }
  return out;
}

module.exports = { isLeadLine, leadLineCount, textToChunks, dedupeByPhone, MIN_PHONE_DIGITS };
