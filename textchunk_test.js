// Tests for textchunk.js — chunking a PASTED lead list. Run: node textchunk_test.js
const { isLeadLine, leadLineCount, textToChunks, dedupeByPhone } = require('./textchunk');

let pass = 0, fail = 0;
function eq(name, got, want){
  const good = JSON.stringify(got) === JSON.stringify(want);
  console.log((good ? '✅ ' : '❌ ') + name + (good ? ` → ${JSON.stringify(got)}` : `\n     got  ${JSON.stringify(got)}\n     want ${JSON.stringify(want)}`));
  good ? pass++ : fail++;
}
function ok(name, cond){ eq(name, !!cond, true); }

// ── THE REAL FIXTURE ──────────────────────────────────────────────────────────────────────────
// Harith's actual event list, 2026-08-04 — the paste that prompted this module. 53 leads.
const REAL = `LAMBRETTA / THUNDER LEADS (53)

1. Mohaamad Ubaidillah B Jamarizan - +850124065799 - Lambretta X250
2. Ahmad Fauzan Fikhry Bin Abd Kadir - +601165622346 - Thunder LS250-S, Lambretta X250
3. Ahmad Aidid Fikry Bin Ahmad Fairuzy - +601111581676 - Lambretta X250, Thunder LS250-S
4. Benjamin Lim - +60173434830 - Thunder LS250-S
5. Alif Aisy - +601113068905 - Thunder LS250-S
6. Khairul Zaim Bin Ahmad Azahari - +60192402406 - Lambretta G350
7. Shafrizaq - +60173010462 - Thunder LS250-S
8. Rayan Medimegh - +33751026512 - Thunder LS250-S
9. Sean Wu - +60174303898 - Thunder LS250-S
10. Adi Kusuma - +6596551034 - Thunder LS250-S
11. Irfan Naufal - +6591733139 - Thunder LS250-S
12. Ikmalakim - +601111515583 - Thunder LS250-S
13. Muhammad Shafiq - +60127519198 - Thunder LS250-S
14. Harith Fahmi - +60166753500 - Thunder LS250-S
15. Iqbal Safari - +60176846269 - Thunder LS250-S
16. Asyraf Izaham - +601137154912 - Thunder LS250-S
17. Nizam Jati - +60123756918 - Thunder LS250-S
18. Muhammad Qayyim Bin Mohd Nizam - +601111389055 - Thunder LS250-S
19. Faiz - +60176639695 - Lambretta X250
20. Wan Afiq - +60183887798 - Lambretta X250
21. Leong V-Keen - +60122398396 - Thunder LS250-S
22. Wong Jit Fung - +601156382395 - Thunder LS250-S
23. Tan Pak Siew - +60172007272 - Thunder LS250-S
24. Lee Sheng - +60165248234 - Lambretta X250
25. Mohd Nor Afandi Bin Ramani - +60173367254 - Lambretta X300
26. Alice Saila - +601123276962 - Thunder LS250-S
27. Saiful Azlan - +60192113075 - Lambretta X300
28. Mohd Rizal - +60195530255 - Lambretta X250, X300
29. Afif Asyraf - +60134410182 - Thunder LS250-S
30. Muaz Bin Mohd Yusof - +60135305997 - Lambretta X300, Thunder LS250-S
31. Hilmi - +60132796171 - Lambretta X250
32. Harith Hadziq Shaik Mohd Sheriff - +60183261911 - Thunder LS250-S
33. Muhammad Athar Zaim Bin Muhammad Kamri - +60174745916 - Lambretta X300
34. Aqil Nazri - +60184074626 - Lambretta X250
35. Raja Mohd Naqiuddin Raja Bahtiar - +60167055260 - Thunder LS250-S
36. Saiful Syaifuddin - +60136883042 - Lambretta X250
37. Roslan Hussien - +60123485567 - Lambretta X250
38. Daniel - +60173584583 - Thunder LS250-S
39. Mohamad Addar Quthni Bin Mohd Hanif - +601164001233 - Thunder LS250-S
40. Muhammad Izral Fizani Bin Mohd Jalani - +60175172482 - X250, X300, G350, LS250-S
41. Raihan Izzatie - +60134997270 - X250, X300, G350, LS250-S
42. Khairul Azzam - +60126350940 - Thunder LS250-S
43. Muhammad Aminuddin Bin Mohammad Rozali - +601116153897 - Thunder LS250-S
44. Basil Hadri - +60182655762 - Thunder LS250-S
45. Syed Ahmad Farhan Bin Wan Abdurahman - +60128542618 - Thunder LS250-S
46. Shaikh Muhammad Mustafa - +60179894619 - Thunder LS250-S
47. Aiman Safwan - +60142794709 - Thunder LS250-S
48. Muhammad Amzar Bin Mustafa - +601151689420 - Lambretta X250, Thunder LS250-S
49. Ahmad Muslim - +601139131623 - Thunder LS250-S
50. Muhammad Badrul Amin - +60199702370 - Thunder LS250-S
51. Muhammad Adam Ashraf Bin Mohd Yasin - +60138562994 - Thunder LS250-S
52. Muhammad Fadzli - +601121680206 - Thunder LS250-S
53. Mohd Khalid Adenan - +60146280483 - Lambretta X300`;

console.log('\n--- THE REAL 53-LEAD PASTE (Harith, 2026-08-04) ---');
eq('all 53 lines detected as leads', leadLineCount(REAL), 53);
const c = textToChunks(REAL, 20);
eq('splits into 3 chunks', c.length, 3);
eq('chunk sizes 20/20/13', c.map(x => leadLineCount(x)), [20, 20, 13]);
ok('every chunk repeats the header (brand context)', c.every(x => x.includes('LAMBRETTA / THUNDER LEADS')));
ok('chunk 1 counter', c[0].includes('(leads 1-20 of 53)'));
ok('chunk 3 counter', c[2].includes('(leads 41-53 of 53)'));

console.log('\n--- NOTHING IS LOST: every lead line survives into exactly one chunk ---');
const srcLines = REAL.split('\n').filter(isLeadLine);
const outLines = c.flatMap(x => x.split('\n')).filter(isLeadLine);
eq('same count out as in', outLines.length, srcLines.length);
eq('no lead duplicated across chunks', new Set(outLines).size, 53);
eq('lead 1 present exactly once', outLines.filter(l => l.includes('+850124065799')).length, 1);
eq('lead 53 present exactly once', outLines.filter(l => l.includes('+60146280483')).length, 1);
ok('every original line is somewhere in the output', srcLines.every(l => outLines.includes(l)));

console.log('\n--- MODEL CODES ARE NOT PHONE NUMBERS (the thing that would corrupt the count) ---');
eq('Lambretta X250 alone',      isLeadLine('19. Faiz - Lambretta X250'), false);
eq('Thunder LS250-S alone',     isLeadLine('Thunder LS250-S'), false);
eq('multi-model line, no phone', isLeadLine('X250, X300, G350, LS250-S'), false);
eq('a date is not a phone',     isLeadLine('Event 2026-08-04 Klang roadshow'), false);
eq('bare list number',          isLeadLine('7. Shafrizaq'), false);
eq('price is not a phone',      isLeadLine('Lambretta X300 - RM 23,888'), false);

console.log('\n--- PHONE FORMATS STAFF ACTUALLY TYPE ---');
eq('+60 international', isLeadLine('Ali - +60173434830 - Thunder'), true);
eq('local 012-345 6789', isLeadLine('Ali - 012-345 6789 - Thunder'), true);
eq('local no separators', isLeadLine('Ali 0123456789'), true);
eq('bracketed', isLeadLine('Ali (012) 345-6789'), true);
eq('Singapore +65', isLeadLine('Adi Kusuma - +6596551034'), true);
eq('France +33', isLeadLine('Rayan Medimegh - +33751026512'), true);

console.log('\n--- NAME ON ONE LINE, PHONE ON THE NEXT (the other way staff paste) ---');
const TWOLINE = `Event leads Klang

Ali Bin Ahmad
+60123456789
Siti Nurhaliza
+60198765432
Chong Wei
+60111222333`;
eq('3 leads counted', leadLineCount(TWOLINE), 3);
const t = textToChunks(TWOLINE, 2);
eq('2 chunks', t.length, 2);
ok('name stays with its own phone (not orphaned into the header)', t[0].includes('Ali Bin Ahmad\n+60123456789'));
ok('header repeated, and does NOT swallow lead 1s name', t[1].includes('Event leads Klang') && !t[1].includes('Ali Bin Ahmad'));
ok('chunk 2 keeps its pair intact', t[1].includes('Chong Wei\n+60111222333'));

console.log('\n--- PLAIN CHATTER MUST BEHAVE EXACTLY AS BEFORE ---');
eq('no phone lines at all', leadLineCount('ok noted boss, thanks'), 0);
eq('chatter returns unchanged, single chunk', textToChunks('ok noted boss, thanks', 20), ['ok noted boss, thanks']);
eq('empty string', textToChunks('', 20), ['']);
eq('null safe', leadLineCount(null), 0);
eq('undefined safe', textToChunks(undefined, 20), ['']);

console.log('\n--- SMALL DROPS: the normal daily case is untouched ---');
const SMALL = 'tiktok dm lambretta\nAli - +60123456789 - x250';
eq('1 lead counted', leadLineCount(SMALL), 1);
eq('single chunk', textToChunks(SMALL, 20).length, 1);

console.log('\n--- BOUNDARIES ---');
const mk = (n) => Array.from({ length: n }, (_, i) => `${i + 1}. Cust${i + 1} - +6012345${String(1000 + i)} - x250`).join('\n');
eq('exactly 20 → 1 chunk',  textToChunks(mk(20), 20).length, 1);
eq('21 → 2 chunks',         textToChunks(mk(21), 20).length, 2);
eq('40 → 2 chunks',         textToChunks(mk(40), 20).length, 2);
eq('41 → 3 chunks',         textToChunks(mk(41), 20).length, 3);
eq('139 (the Excel incident size) → 7 chunks', textToChunks(mk(139), 20).length, 7);
eq('perChunk=0 falls back to 20', textToChunks(mk(41), 0).length, 3);
eq('no leads lost at 139', textToChunks(mk(139), 20).reduce((s, x) => s + leadLineCount(x), 0), 139);

console.log('\n--- TRAILING TEXT AFTER THE LAST LEAD IS NOT DROPPED ---');
const TAIL = `1. Ali - +60123456789 - x250\n2. Siti - +60198765432 - x300\nthats all boss, please assign today`;
const tt = textToChunks(TAIL, 20);
ok('trailing note survives', tt.join('\n').includes('thats all boss, please assign today'));

console.log('\n--- DEDUPE WITHIN ONE DROP (measured: the real list returned 57 leads for 53 customers) ---');
// The exact live artifact: a multi-model line emits one lead per model.
const AMZAR = [
  { name:'Muhammad Amzar Bin Mustafa', phone:'+601151689420', interest:'lambretta x250', brand:'Lambretta', origin:'' },
  { name:'Muhammad Amzar Bin Mustafa', phone:'+601151689420', interest:'thunder ls250-s', brand:'Thunder', origin:'' },
];
const d = dedupeByPhone(AMZAR);
eq('two model-rows collapse to one customer', d.length, 1);
eq('both bikes kept in interest', d[0].interest, 'lambretta x250, thunder ls250-s');
eq('first brand wins', d[0].brand, 'Lambretta');

eq('same phone written differently still merges',
  dedupeByPhone([{ phone:'+60123456789', interest:'x250' }, { phone:'012-345 6789', interest:'x300' }]).length, 1);
eq('different customers are NOT merged',
  dedupeByPhone([{ phone:'+60123456789' }, { phone:'+60198765432' }]).length, 2);
eq('duplicate interest is not repeated',
  dedupeByPhone([{ phone:'+60123456789', interest:'x250' }, { phone:'+60123456789', interest:'x250' }])[0].interest, 'x250');
eq('blank interest on the copy changes nothing',
  dedupeByPhone([{ phone:'+60123456789', interest:'x250' }, { phone:'+60123456789', interest:'' }])[0].interest, 'x250');
eq('brand backfilled from the copy',
  dedupeByPhone([{ phone:'+60123456789', brand:'' }, { phone:'+60123456789', brand:'Thunder' }])[0].brand, 'Thunder');

console.log('\n--- 🚨 NO-PHONE LEADS ARE NEVER MERGED INTO EACH OTHER ---');
// @lid customers legitimately have no number (2026-08-02 incident). Blank is not an identity —
// collapsing them would silently delete real, different customers.
eq('two blank-phone leads both survive',
  dedupeByPhone([{ name:'Ali', phone:'' }, { name:'Siti', phone:'' }]).length, 2);
eq('missing phone field survives',
  dedupeByPhone([{ name:'Ali' }, { name:'Siti' }]).length, 2);
eq('short/junk numbers are not treated as identity',
  dedupeByPhone([{ name:'Ali', phone:'123' }, { name:'Siti', phone:'123' }]).length, 2);
eq('empty input', dedupeByPhone([]), []);
eq('null input', dedupeByPhone(null), []);

console.log('\n--- the real list: 53 in, 53 out, order preserved ---');
const realLeads = REAL.split('\n').filter(isLeadLine).map(l => ({ phone: l.match(/\+[\d]+/)[0], interest: 'x' }));
eq('53 distinct customers stay 53', dedupeByPhone(realLeads).length, 53);
eq('first is still first', dedupeByPhone(realLeads)[0].phone, '+850124065799');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
