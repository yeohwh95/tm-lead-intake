#!/usr/bin/env node
// Load-check for index.js. Run: node loadcheck.js
//
// WHY THIS EXISTS: `node --check index.js` only validates SYNTAX. On 2026-07-30 a bad edit deleted
// `larkSearch`, `slaFieldText`, `slaRecCreated` and the SLA_SWEEP_* constants — every one still
// *referenced* elsewhere in the file — and `node --check` passed happily, because a missing function
// is a runtime ReferenceError, not a syntax error. It was only caught by reading the git diff.
//
// This actually LOADS the module with a scrubbed environment, so every live path is gated off:
//   FIRSTRESPONSE_ON unset → first-response bot off      SLA_ON unset  → SLA engine + intervals off
//   WASENDER_TOKEN   unset → waSend no-ops               LIVE_LARK unset → no Lark writes
// It therefore sends nothing and writes nothing — it just proves the module can be evaluated and
// survives a couple of seconds without a deferred crash.
// Add it to any pre-deploy check alongside the unit tests.

const path = require('path');
let failed = false;
process.on('uncaughtException', (e) => { console.log(`❌ THREW ${e.name}: ${e.message}`); failed = true; process.exit(1); });
process.on('unhandledRejection', (e) => { console.log(`❌ UNHANDLED REJECTION: ${(e && e.message) || e}`); failed = true; process.exit(1); });

const dangerous = ['FIRSTRESPONSE_ON', 'SLA_ON', 'SLA_SWEEP', 'WASENDER_TOKEN', 'REVIEW_TOKEN', 'LIVE_LARK', 'ROSTER_FROM_SHEET'];
for (const k of dangerous) delete process.env[k];

try {
  require(path.join(__dirname, 'index.js'));
  console.log('✅ index.js evaluated — no ReferenceError, every top-level symbol resolves');
} catch (e) {
  console.log(`❌ index.js failed to load — ${e.name}: ${e.message}`);
  process.exit(1);
}
// ---- PHASE 2: static undefined-call scan ----
// Loading the module is NOT enough on its own. A deleted helper only throws when it is CALLED, and
// most of this file's helpers (larkSearch, slaFieldText, slaRecCreated…) are called from timers or
// webhook handlers, never at load time — so the 2026-07-30 deletion sailed past both `node --check`
// AND a plain require(). This scan is what actually catches it: collect every declared name, then
// flag any bare `name(` call that resolves to nothing.
function staticScan(file) {
  const fs = require('fs');
  const src = fs.readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')          // block comments
    .replace(/(^|[^:])\/\/.*$/gm, '$1')          // line comments (keep http:// intact)
    .replace(/`(?:\\[\s\S]|[^`\\])*`/g, '``')    // template literals
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""');
  const declared = new Set();
  const add = (re, g = 1) => { let m; const r = new RegExp(re, 'gm'); while ((m = r.exec(src))) declared.add(m[g]); };
  add('function\\s+([A-Za-z_$][\\w$]*)');                     // function decls
  add('(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)');            // simple bindings
  add('(?:const|let|var)\\s*\\{([^}]*)\\}');                  // destructured — split below
  for (const d of [...declared]) if (d.includes(',') || d.includes(':')) {
    declared.delete(d);
    d.split(',').forEach(part => { const n = part.split(':').pop().trim().replace(/=.*/, '').trim(); if (/^[A-Za-z_$][\w$]*$/.test(n)) declared.add(n); });
  }
  add('([A-Za-z_$][\\w$]*)\\s*:\\s*(?:async\\s*)?(?:function|\\()');   // object-literal methods
  // params: cheap but effective — any identifier inside a param list counts as in-scope somewhere
  let m, pr = /(?:function\s*[\w$]*\s*|\)\s*=>|\(\s*)\(([^)]*)\)\s*(?:=>|\{)/g;
  while ((m = pr.exec(src))) m[1].split(',').forEach(p => { const n = p.trim().replace(/[=:].*/, '').replace(/^\.\.\./, '').trim(); if (/^[A-Za-z_$][\w$]*$/.test(n)) declared.add(n); });
  pr = /\(([^()]*)\)\s*=>/g;
  while ((m = pr.exec(src))) m[1].split(',').forEach(p => { const n = p.trim().replace(/[=:].*/, '').replace(/^\.\.\./, '').trim(); if (/^[A-Za-z_$][\w$]*$/.test(n)) declared.add(n); });

  const GLOBALS = new Set(['require','fetch','setTimeout','setInterval','clearTimeout','clearInterval','JSON','Object','Array','String','Number','Boolean','Math','Date','Promise','Error','Map','Set','WeakMap','RegExp','parseInt','parseFloat','isNaN','encodeURIComponent','decodeURIComponent','Buffer','process','console','module','exports','__dirname','__filename','AbortController','URL','URLSearchParams','Symbol','BigInt','structuredClone','queueMicrotask','TextEncoder','TextDecoder','if','for','while','switch','catch','return','typeof','function','await','new','delete','void','do','else','try','throw','case','in','of','yield','constructor','async','get','set','static']);
  const calls = new Map();
  const cr = /(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g;
  while ((m = cr.exec(src))) {
    const n = m[2];
    if (GLOBALS.has(n) || declared.has(n)) continue;
    calls.set(n, (calls.get(n) || 0) + 1);
  }
  return [...calls.entries()].sort((a, b) => b[1] - a[1]);
}

const missing = staticScan(path.join(__dirname, 'index.js'));
if (missing.length) {
  console.log('❌ called but NOT DEFINED anywhere in index.js:');
  for (const [n, c] of missing) console.log(`     ${n}()  ×${c}`);
  failed = true;
} else {
  console.log('✅ static scan — every called function resolves to a definition');
}

setTimeout(() => {
  if (!failed) console.log('✅ survived 2.5s with no deferred crash');
  process.exit(failed ? 1 : 0);
}, 2500);
