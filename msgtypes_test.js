'use strict';
const mt = require('./msgtypes');
let fail = 0, n = 0;
const ok = (name, c) => { n++; if (!c) { fail++; console.log('  ❌ ' + name); } else console.log('  ✅ ' + name); };
const BUILTIN = 'BUILTIN PROMPT';

// a faithful slice of the real tab, including the "<-" explanations the team writes
const SHEET = [
  ['TM MOTOWORLD — WHAT THE BOT DOES WITH EACH KIND OF MESSAGE'],
  ['Fill in the YELLOW columns with REAL customer messages.'],
  ['Message type','What it means','✍️ EXAMPLE MESSAGES','❌ SHOULD NEVER BE THIS TYPE','✍️ Keywords','\U0001f512 What the bot does','Notes'],
  ['product','Wants to BUY','Lambretta x250 berapa\nHi boss is this still available?','nak jual motor saya  ← that is SELL','ada, harga, berapa','Replies + assigns',''],
  ['sell','Selling their own bike','nak jual motor yg belum habis bayar','kedai ada jual motor X?  <- that asks what WE sell','jual, trade in, tolak','Goes to FITRI',''],
  ['chasing','Already ours, nobody called','Hi, masih belum dapat ws dari SA\nDah 2 hari takde orang call saya','','belum dapat, takde orang call, still waiting','Replies + re-pings',''],
  ['admin','Paperwork only','Nak tukar nama boleh?','Hi, masih belum dapat ws dari SA  ← 18 Sep: should be CHASING','tukar nama, roadtax, insurance','Hands to admin',''],
  ['HOW THIS TAB WORKS'],
  ['The bot reads this page to decide what each customer message is about.'],
];

console.log('\n-- parsing --');
const p = mt.parseTypes(SHEET);
ok('4 types found; headings and prose ignored', p.found === 4);
ok('examples split per line', p.types.product.examples.length === 2);
ok('the team’s "← that is SELL" note is stripped from the message',
   p.types.product.never[0] === 'nak jual motor saya');
ok('and the "<-" ASCII form too', p.types.sell.never[0] === 'kedai ada jual motor X?');
ok('keywords lowercased + split', JSON.stringify(p.types.sell.keywords) === '["jual","trade in","tolak"]');
ok('missing types are NAMED, not silently defaulted', p.warnings.some(w => /not on the page/.test(w) && /workshop/.test(w)));
ok('action comes from CODE, not the sheet', p.types.sell.action === 'purchaser' && p.types.admin.action === 'handoff_admin');

console.log('\n-- a sheet edit can never invent a destination --');
const evil = mt.parseTypes([['vip','send to boss','x','','urgent','DM Steven','']]);
ok('an unknown type name is ignored entirely', evil.found === 0);

console.log('\n-- guards --');
const many = Array.from({length: 20}, (_, i) => 'example number ' + i).join('\n');
const big = mt.parseTypes([['product','buy',many,'','ada','',''],]);
ok('examples capped at 12', big.types.product.examples.length === 12);
ok('and the team is told why', big.warnings.some(w => /only the first 12/.test(w) && /costs money/.test(w)));
const shortkw = mt.parseTypes([['product','buy','x','','ada, ok, harga','','']]);
ok('a 2-letter keyword is dropped', !shortkw.types.product.keywords.includes('ok'));
ok('and warned about', shortkw.warnings.some(w => /too short/.test(w)));
const dup = mt.parseTypes([['product','first','a','','kw1','',''],['product','second','b','','kw2','','']]);
ok('duplicate row: first wins + warned', dup.types.product.meaning === 'first' && dup.warnings.some(w => /twice/.test(w)));

console.log('\n-- keyword matching (the deterministic half) --');
const T = p.types;
ok('\U0001F6A8 Harith’s real case resolves to CHASING',
   (mt.keywordMatch('Hi, masih belum dapat ws dari SA', T) || {}).type === 'chasing');
ok('whole-word only — "loanable" does not fire "loan"',
   mt.keywordMatch('is it loanable', { loan: { keywords: ['loan'] } }) === null);
ok('longest keyword wins over a generic one',
   (mt.keywordMatch('saya nak tukar nama motor', { admin: { keywords: ['tukar nama'] }, sell: { keywords: ['tukar'] } }) || {}).type === 'admin');
ok('no keyword → null, never a guess', mt.keywordMatch('zzz nothing here', T) === null);
ok('punctuation does not block a match',
   (mt.keywordMatch('roadtax!! expired', { admin: { keywords: ['roadtax'] } }) || {}).type === 'admin');

console.log('\n-- prompt building --');
const prompt = mt.buildPrompt(p, BUILTIN);
ok('lists only the types on the sheet', /EXACTLY one word from: product, sell, chasing, admin/.test(prompt));
ok('carries the real examples', /Lambretta x250 berapa/.test(prompt));
ok('carries the ❌ examples as NOT-this-type', /NOT admin \(these were classified wrongly before\)/.test(prompt));
ok('keeps the sell-beats-loan rule in CODE', /sell beats loan beats product/.test(prompt));
ok('keeps the greeting rule in CODE', /opens with a greeting/.test(prompt));
// 2026-09-21 — Harith: "auto bot salah assign kepada admin". A customer buying a NEW bike who
// asked what documents he needed to keep his own plate number was classified `admin` 12/12 at
// temperature 0 and was told "admin will contact you" instead of reaching a salesperson.
// The admin row's MEANING column already said "Never anything about buying or selling a bike" and
// the model still chose admin — a description of a type is not a rule about which type WINS.
// This rule must stay in CODE: TM can edit every row on that sheet, and a sheet with no admin row
// at all still has to route a buyer to a salesperson.
ok('\u{1F6A8} keeps the buying-beats-paperwork rule in CODE',
   /Anything to do with BUYING a bike from us is product, never admin/.test(prompt));
ok('the rule survives a sheet that says the opposite in its meaning column',
   /Anything to do with BUYING a bike from us is product, never admin/.test(
     mt.buildPrompt(mt.parseTypes([['admin', 'everything about bikes, buying included', '', '', '']]), BUILTIN)));

console.log('\n-- an unreadable sheet must never blank the prompt --');
ok('empty rows → built-in prompt', mt.buildPrompt(mt.parseTypes([]), BUILTIN) === BUILTIN);
ok('all-prose sheet → built-in prompt', mt.buildPrompt(mt.parseTypes([['hello'],['world']]), BUILTIN) === BUILTIN);
ok('null → built-in prompt', mt.buildPrompt(null, BUILTIN) === BUILTIN);

console.log(`\n${n - fail}/${n} passed`);
process.exit(fail ? 1 : 0);
