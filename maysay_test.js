'use strict';
// The MAY-SAY switches, exercised through the real stockLineFor with an injected catalog.
process.env.FIRSTRESPONSE_ON = '1';
process.env.FR_STATE_FILE = require('path').join(require('os').tmpdir(), `fr_maysay_${process.pid}.json`);
process.env.FR_EVENTS_FILE = require('path').join(require('os').tmpdir(), `fr_maysay_ev_${process.pid}.jsonl`);
process.env.GATE_LOG_FILE = require('path').join(require('os').tmpdir(), `fr_maysay_gl_${process.pid}.jsonl`);
const fr = require('./firstresponse.js');
let fail = 0, n = 0;
const ok = (name, cond) => { n++; if (!cond) { fail++; console.log('  ❌ ' + name); } else console.log('  ✅ ' + name); };

// catalog stub: one used MT-09 in stock, plus a pre-release Zontes booking row
const CATALOG = {
  'mt09':   { matches: [{ name: '2015 Yamaha MT-09', mileage: 79000, isNew: false }], booking: [] },
  'zontes': { matches: [], booking: [{ name: 'OPEN FOR BOOKING NEW ZONTES 175X' }] },
};
fr.init({ log: () => {}, wooCheckStock: async t => CATALOG[/zontes/i.test(t) ? 'zontes' : 'mt09'] });
const line = (text) => fr._stockLineFor('product', text, 'bm');

(async () => {
  console.log('\n-- default (switches absent): behaves exactly as before --');
  fr.setConfig({});
  ok('an in-stock used unit is still named', /MT-09/.test(await line('ada mt09')));
  ok('the Zontes booking pitch still fires', /OPEN FOR BOOKING/i.test(await line('zontes 175x ada')));

  console.log('\n-- May the bot say whether a bike is in stock? = NO --');
  fr.setConfig({ maySayStock: false, maySayPrice: true });
  ok('\u{1F6A8} no stock claim is made at all', await line('ada mt09') === '');
  // REGRESSION 18 Sep: the guard was at the TOP of stockLineFor, which also deleted Steven's
  // booking pitch. A booking pitch is not a stock claim, and he asked for it by name on 24 Jul.
  ok('\u{1F6A8} but the Zontes BOOKING pitch survives', /OPEN FOR BOOKING/i.test(await line('zontes 175x ada')));
  ok('and it still carries the dealer + mystery gift line', /mystery gift/i.test(await line('zontes 175x ada')));

  console.log('\n-- May the bot quote a price? = NO --');
  fr.setConfig({ maySayStock: true, maySayPrice: false });
  const noPrice = await line('ada mt09');
  ok('a customer who never mentioned price still gets the no-numbers line', /tak berani bagi angka salah/.test(noPrice));
  ok('and no RM figure appears anywhere', !/RM\s?[\d,]/.test(noPrice));

  console.log('\n-- May the bot quote a price? = YES (and they asked) --');
  fr.setConfig({ maySayStock: true, maySayPrice: true });
  ok('asking a price still gets the CS no-numbers line (never a figure)', /tak berani bagi angka salah/.test(await line('mt09 harga berapa')));
  ok('not asking a price gets the neutral defer', /confirm harga/.test(await line('ada mt09')));

  console.log('\n-- both OFF --');
  fr.setConfig({ maySayStock: false, maySayPrice: false });
  ok('silent on stock and price together', await line('mt09 harga berapa') === '');

  console.log(`\n${n - fail}/${n} passed`);
  try { require('fs').unlinkSync(process.env.FR_STATE_FILE); } catch {}
  try { require('fs').unlinkSync(process.env.FR_EVENTS_FILE); } catch {}
  try { require('fs').unlinkSync(process.env.GATE_LOG_FILE); } catch {}
  process.exit(fail ? 1 : 0);
})();
