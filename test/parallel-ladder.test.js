// Pricing a card's unsold parallels off its product's parallel ladder: every
// parallel's price relative to the others, fitted across every card in the
// product that sold in two or more of them.
const path = require('path');
process.env.CF_WORKER = '1';
const S = require(path.join(__dirname, '..', 'server.js'));
const prizm17 = require(path.join(__dirname, '..', 'public', 'data', 'checklists', '2017-panini-prizm-football.json'));

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};
const near = (a, b, tol) => Math.abs(a - b) <= tol * b;

// ---- keys: every spelling of one parallel is one rung ----
for (const [a, b] of [['Prizm Gold', 'Gold Prizm'], ['Gold /10', 'Prizm Gold'], ['Silver Prizm', 'Silver'],
                      ['Red White & Blue Prizm', 'Prizm Red, White and Blue']]) {
  check(`"${a}" and "${b}" are one rung`, S._ladderKey(a) === S._ladderKey(b), `${S._ladderKey(a)} / ${S._ladderKey(b)}`);
}
for (const b of ['Base', 'base rookie', 'RC', '']) check(`"${b}" is base`, S._ladderKey(b) === '');

// ---- the fit: known multipliers come back, one bad sale does not move them ----
{
  const TRUE = { '': 1, silver: 3, green: 6, gold: 40 };
  const cards = new Map();
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let i = 0; i < 40; i++) {
    const worth = 2 + rnd() * 50;                        // each card its own price level
    const pars = new Map();
    for (const [k, f] of Object.entries(TRUE)) {
      if (rnd() < 0.6) pars.set(k, worth * f * (0.85 + rnd() * 0.3));
    }
    cards.set(`c${i}`, pars);
  }
  cards.get('c0').set('gold', 0.5);                      // a mislabelled sale
  const fit = S._fitParallelLadder(cards);
  check('ladder is anchored on base', fit && fit.ref === '');
  for (const [k, f] of Object.entries(TRUE)) {
    check(`rung "${k || 'base'}" ≈ ${f}×`, fit.rungs[k] && near(fit.rungs[k].f, f, 0.15), fit.rungs[k] && fit.rungs[k].f);
  }
  const lone = new Map([['x', new Map([['gold', 100]])]]);
  check('a card sold in one parallel ties nothing', S._fitParallelLadder(lone) === null);
}

// ---- which checklist set a card is in ----
{
  const base = S._checklistSetFor(prizm17, { player: 'Patrick Mahomes', cardNumber: '269', kind: '', subset: '' });
  check('Mahomes #269 is in the Base Set', base && base.name === 'Base Set', base && base.name);
  const ins = S._checklistSetFor(prizm17, { player: 'Patrick Mahomes II', cardNumber: '8', kind: '', subset: 'instant impact' });
  check('Mahomes #8 Instant Impact is in Instant Impact', ins && ins.name === 'Instant Impact', ins && ins.name);
  check('a card the checklist does not hold is placed nowhere',
    S._checklistSetFor(prizm17, { player: 'Nobody Real', cardNumber: '269', kind: '', subset: '' }) === null);
}

// ---- every checklist parallel, sold or estimated ----
{
  const set = S._checklistSetFor(prizm17, { player: 'Patrick Mahomes', cardNumber: '269', kind: '', subset: '' });
  const fit = { ref: '', rungs: {
    '': { f: 1, n: 50, lo: 0.9, hi: 1.1 },
    silver: { f: 3, n: 50, lo: 0.9, hi: 1.1 },
    green: { f: 5, n: 20, lo: 0.9, hi: 1.1 },
    orange: { f: 8, n: 12, lo: 0.8, hi: 1.2 },          // /275
    'light blue': { f: 10, n: 12, lo: 0.8, hi: 1.2 },   // /199
    'green scope': { f: 18, n: 6, lo: 0.8, hi: 1.2 },   // /99
    gold: { f: 60, n: 9, lo: 0.7, hi: 1.4 },            // /10
  } };
  const known = [
    { key: 'silver', itemId: 'A', sales: 3, raw: 300 },
    { key: '', itemId: 'B', sales: 1, raw: 100 },
    { key: 'green', itemId: 'C', sales: 1, raw: 500 },
  ];
  const list = S._checklistParallels(set, known, fit);
  const by = (n) => list.find(e => e.name === n);
  check('the whole checklist is listed', list.length === 1 + set.parallels.length, `${list.length} of ${1 + set.parallels.length}`);
  check('sold parallels keep their item ids', by('Base').itemId === 'B' && by('Prizm').itemId === 'A' && by('Prizm Green').itemId === 'C');
  const gold = by('Prizm Gold');
  check('Gold /10 is priced off the ladder: base $100 × 60', gold.estimate && near(gold.estimate.price, 6000, 0.01)
    && gold.estimate.basis === 'ladder' && gold.estimate.confidence === 'medium', JSON.stringify(gold.estimate));
  check('its range brackets the price', gold.estimate.low < gold.estimate.price && gold.estimate.high > gold.estimate.price);
  const black = by('Prizm Black Finite');
  check('Black Finite 1/1, off the ladder, is priced off the print-run curve and rarest of all',
    black.estimate && black.estimate.basis === 'print-run' && black.estimate.price > gold.estimate.price
    && black.estimate.confidence === 'low', JSON.stringify(black.estimate));
  const disco = by('Prizm Disco');
  check('an unnumbered parallel off the ladder gets the product\'s typical unnumbered rung',
    disco.estimate && disco.estimate.basis === 'unnumbered', JSON.stringify(disco.estimate));
  const odd = S._checklistParallels(set, [...known, { key: 'blue red white', name: 'Blue Red White', itemId: 'D', sales: 3, raw: 900 }], fit);
  check('a sold parallel the checklist spells differently is still listed',
    odd.some(e => e.name === 'Blue Red White' && e.itemId === 'D'));
  check('no graded or unanchored card is estimated', S._checklistParallels(set, [{ key: 'silver', itemId: 'A', sales: 2, raw: null }], fit)
    .every(e => e.itemId || !e.estimate));
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall parallel-ladder checks passed');
process.exit(failures ? 1 : 0);
