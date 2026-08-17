// The LLM must not downgrade a confident regex `sell`. Run: node sell_override_test.js
//
// Two real misses, two days running, both flagged by the 9:57 FR self-audit:
//   16/08 "Cbr650r / Mt25 / Trade in mt25 2024 mileage 25k"      -> ai said product
//   17/08 "hi boss nk tnye moto masih ade loan lgi boleh trade in" -> ai said greeting
// RE_SELL had BOTH right. classifySmart handed the verdict to the LLM unconditionally, so
// each customer went to a salesperson instead of Fitri the purchaser and TM never bought
// the bike. The rule now: the LLM may UPGRADE to sell (it reads Malay phrasings the regex
// cannot), never DOWNGRADE away from one.
process.env.FIRSTRESPONSE_ON = '1';
process.env.FR_EVENTS_FILE = require('path').join(
  require('os').tmpdir(), `sell_override_${process.pid}.jsonl`);
const fr = require('./firstresponse');

let pass = 0, fail = 0;
const ok = (cond, name) => { cond ? pass++ : (fail++, console.log('❌', name)); cond && console.log('✅', name); };

// aiVerdict is whatever we want the LLM to have "said" for this run.
let aiVerdict = null;
fr.init({ aiClassify: async () => aiVerdict, log: () => {} });

const smart = async (t, img) => (await fr._classifySmart(t, !!img)).cat;
const rx = (t) => fr._classify(t, false).cat;

(async () => {
  const CBR = 'Cbr650r \n Mt25 \n Trade in mt25 2024 mileage 25k';
  const HI = 'hi boss \n nk tnye moto masih ade loan lgi boleh trade in ata';

  console.log('\nthe regex already knew (this is why the guard is safe)');
  ok(rx(CBR) === 'sell', 'regex: 16/08 case is sell');
  ok(rx(HI) === 'sell', 'regex: 17/08 case is sell');
  ok(rx('kedai ada jual motor Yamaha R15 tak?') === 'product', 'regex: shop-sells trap stays product');

  console.log('\nthe LLM may NOT downgrade a regex sell');
  aiVerdict = 'product';
  ok(await smart(CBR) === 'sell', '16/08 case survives ai=product');
  aiVerdict = 'greeting';
  ok(await smart(HI) === 'sell', '17/08 case survives ai=greeting');
  aiVerdict = 'loan';
  ok(await smart(HI) === 'sell', 'survives ai=loan (the 24 Jul trade-in-with-loan trap)');
  aiVerdict = 'skip';
  ok(await smart(CBR) === 'sell', 'survives ai=skip');

  console.log('\nbut the LLM keeps its job everywhere else');
  aiVerdict = 'sell';
  ok(await smart('moto saya nak lepas, boleh tengok tak') === 'sell',
     'ai UPGRADES a phrasing the regex misses');
  aiVerdict = 'loan';
  ok(await smart('bulanan berapa untuk cbr650r') === 'loan', 'ai still decides loan');
  aiVerdict = 'testride';
  ok(await smart('boleh test ride tak') === 'testride', 'ai still decides testride');
  aiVerdict = 'product';
  ok(await smart('berapa harga cbr650r') === 'product', 'ai still decides product');
  aiVerdict = 'product';
  ok(await smart('kedai ada jual motor Yamaha R15 tak?') === 'product',
     'shop-sells stays product (regex is not sell, so no guard, ai wins)');

  console.log('\nfallbacks unchanged');
  aiVerdict = 'banana';
  ok(await smart(CBR) === 'sell', 'garbage ai verdict -> regex fallback');
  aiVerdict = null;
  ok(await smart('berapa harga cbr650r') === 'product', 'null ai verdict -> regex fallback');

  console.log(`\n${'='.repeat(56)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(56)}`);
  process.exit(fail ? 1 : 0);
})();
