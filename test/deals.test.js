// Deals right now (owner, Oct 2026): live Buy It Now listings of a busy raw
// base card, priced clearly under what that card has been selling for.
const path = require('path');
process.env.CF_WORKER = '1';
const S = require(path.join(__dirname, '..', 'server.js'));
const pi = require('../parallel-index');

let failures = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`); if (!ok) failures++; };

const card = { name: '2017 Donruss Patrick Mahomes Rated Rookie #327', query: '2017 Donruss Patrick Mahomes Rated Rookie',
  year: 2017, set: 'Donruss', number: '327', player: 'Patrick Mahomes', recent: 212, older: 200, sales: 161 };
const L = (title, price, extra = {}) => ({ title, price: String(price), buyingOptions: ['FIXED_PRICE'], shipping: 4.99,
  itemUrl: 'https://www.ebay.com/itm/1', imageUrl: null, ...extra });

const good = L('2017 Panini Donruss Rated Rookie Patrick Mahomes II #327 RC Chiefs', 150);
check('a raw base copy listed well under market is a deal', S._dealMatches(good, card, pi) && !!S._dealOf(good, card));
const d = S._dealOf(good, card);
check('  ...judged delivered, against the lower of recent and earlier price',
  d && d.market === 200 && d.total === 154.99 && d.pctUnder === 23, JSON.stringify(d));
check('  ...but not when shipping eats the discount', S._dealOf(L(good.title, 168, { shipping: 10 }), card) === null);
check('  ...nor when it is only a little under', S._dealOf(L(good.title, 175, { shipping: 0 }), card) === null);

const traps = [
  ['a slab', L('2017 Donruss Patrick Mahomes #327 Rated Rookie PSA 9 MINT', 120)],
  ['a parallel', L('2017 Donruss Patrick Mahomes #327 Rated Rookie Holo Press Proof', 120)],
  ['an autograph', L('2017 Donruss Patrick Mahomes #327 Rated Rookie Auto', 120)],
  ['a numbered copy', L('2017 Donruss Patrick Mahomes #327 Rated Rookie Silver /99', 120)],
  ['a lot', L('2017 Donruss Patrick Mahomes #327 Rated Rookie lot of 3', 120)],
  ['a reprint', L('2017 Donruss Patrick Mahomes #327 Rated Rookie reprint', 12)],
  ['another number', L('2017 Donruss Patrick Mahomes #3270 Rated Rookie', 120)],
  ['another year', L('2018 Donruss Patrick Mahomes #327', 120)],
  ['another player', L('2017 Donruss Deshaun Watson #327 Rated Rookie', 120)],
  ['an auction', L('2017 Donruss Patrick Mahomes #327 Rated Rookie', 120, { buyingOptions: ['AUCTION'] })],
];
const wrong = traps.filter(([, l]) => S._dealMatches(l, card, pi)).map(([w]) => w);
check('a listing that is not the same raw base card is never a deal', !wrong.length, wrong.join(', '));

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nall deals checks passed');
