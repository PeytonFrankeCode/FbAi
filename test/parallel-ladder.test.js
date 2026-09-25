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
for (const [a, b] of [['Prizm', 'Silver Prizm'], ['Prizm Gold', 'Gold Prizm'], ['Gold /10', 'Prizm Gold'], ['Silver Prizm', 'Silver'],
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

// ---- part 2: pooled curves, anchoring through them, 1/1s, rarer-is-dearer ----
(async () => {
  const set = S._checklistSetFor(prizm17, { player: 'Patrick Mahomes', cardNumber: '269', kind: '', subset: '' });
  // A curve: /10 at 40x base, /100 at 10x, /1000 at 2.5x — slope -0.6 in log-log.
  const brand = { slope: -0.6021, icpt: Math.log(40) + 0.6021 * Math.log(10), unnumbered: 2.5 };
  const thin = { ref: '', rungs: { '': { f: 1, n: 30, lo: 0.9, hi: 1.1 }, silver: { f: 3, n: 30, lo: 0.9, hi: 1.1 } } };
  const known = [{ key: '', itemId: 'B', sales: 4, raw: 100 }];
  const list = S._checklistParallels(set, known, thin, { line: brand, all: null });
  const by = (n) => list.find(e => e.name === n);
  check('a product with no numbered rungs prices Gold /10 off its product line\'s curve (other years)',
    by('Prizm Gold').estimate && by('Prizm Gold').estimate.basis === 'line-curve'
    && near(by('Prizm Gold').estimate.price, 4000, 0.02), JSON.stringify(by('Prizm Gold').estimate));
  check('an unnumbered parallel off the ladder takes its line\'s typical unnumbered rung',
    by('Prizm Disco').estimate && by('Prizm Disco').estimate.basis === 'line-unnumbered', JSON.stringify(by('Prizm Disco').estimate));
  check('with no line curve, the site-wide curve prices it',
    S._checklistParallels(set, known, thin, { line: null, all: brand }).find(e => e.name === 'Prizm Gold').estimate.basis === 'site-curve');

  // No ladder for the product at all: a card that sold only its Gold /10 raw
  // is anchored through the curve, and its base is priced from there.
  const onlyGold = S._checklistParallels(set, [{ key: 'gold', itemId: 'G', sales: 1, raw: 4000 }], null, { line: brand, all: null });
  const baseE = onlyGold.find(e => e.name === 'Base');
  check('a card with only a numbered sale is anchored through the curve',
    baseE.estimate && near(baseE.estimate.price, 100, 0.02), JSON.stringify(baseE.estimate));

  // A 1/1 off the ladder: a wide range, low confidence, flagged.
  const bf = by('Prizm Black Finite');
  check('a 1/1 carries a wide range and says it is one',
    bf.estimate.oneOfOne && bf.estimate.confidence === 'low'
    && bf.estimate.low <= bf.estimate.price * 0.5 + 0.01 && bf.estimate.high >= bf.estimate.price * 2.2 - 0.01, JSON.stringify(bf.estimate));

  // Rarer is never cheaper: a sold Gold /10 at $9,000 lifts the curve's /5 and /1.
  const lifted = S._checklistParallels(set, [...known, { key: 'gold', itemId: 'G', sales: 1, raw: 9000 }], thin, { line: brand, all: null });
  const vinyl = lifted.find(e => e.name === 'Prizm Gold Vinyl');
  check('a curve-priced /5 is never below the card\'s sold /10', vinyl.estimate.price >= 9000 * 1.1 - 0.01, JSON.stringify(vinyl.estimate));

  // A thin product rung leans on its line's; a parallel off the product's
  // ladder takes the line's rung before any curve.
  const thinSilver = { ref: '', rungs: { '': { f: 1, n: 7, lo: 1, hi: 1 }, silver: { f: 1.0, n: 3, lo: 1, hi: 1 } } };
  const lineWith = { ...brand, rungs: { silver: { f: 2.5, p: 6 }, gold: { f: 55, p: 5 } } };
  const shr = S._checklistParallels(set, [{ key: '', itemId: 'B', sales: 4, raw: 100 }], thinSilver, { line: lineWith, all: null });
  const silverE = shr.find(e => e.name === 'Prizm');
  check('a thin rung (Silver 1.0x on 3 cards) is pulled toward the line\'s 2.5x',
    silverE.estimate && silverE.estimate.price > 150 && silverE.estimate.price < 250, JSON.stringify(silverE.estimate));
  const goldE = shr.find(e => e.name === 'Prizm Gold');
  check('a parallel off the product\'s ladder takes the line\'s rung',
    goldE.estimate && goldE.estimate.basis === 'line-ladder' && near(goldE.estimate.price, 5500, 0.01), JSON.stringify(goldE.estimate));

  check('a curve sloping the wrong way is refused',
    S._fitRunCurve([[0, 0], [1, 0.5], [2, 1], [3, 1.5], [4, 2], [5, 2.5], [6, 3], [7, 3.5]], 8) === null);

  // Pooled per brand and kind from ladders anchored on base.
  const curves = await S._ladderCurves({ '2017-panini-prizm-football': { ref: '', rungs: {
    '': { f: 1, n: 40 }, prizm: { f: 3, n: 40 }, 'prizm green': { f: 5, n: 20 }, orange: { f: 8, n: 12 },
    'light blue': { f: 10, n: 12 }, 'blue wave': { f: 12, n: 10 }, 'green scope': { f: 18, n: 8 },
    'purple crystals': { f: 22, n: 8 }, 'red power': { f: 30, n: 6 }, camo: { f: 45, n: 5 }, gold: { f: 70, n: 5 },
    disco: { f: 4, n: 9 }, pink: { f: 4, n: 9 }, red: { f: 3.5, n: 9 }, blue: { f: 3.5, n: 9 } } } });
  const pc = curves['prizm|'];
  check('the line curve is pooled from the product\'s numbered rungs', pc && pc.slope < 0 && pc.points >= 8, JSON.stringify(pc));
  check('and its typical unnumbered rung', pc && pc.unnumbered > 1, pc && pc.unnumbered);
  check('the site-wide pool gets the same points', curves['*|'] && curves['*|'].points === pc.points);
  const two = await S._ladderCurves({
    '2017-panini-prizm-football': { ref: '', rungs: { '': { f: 1, n: 9 }, silver: { f: 2, n: 9 } } },
    '2018-panini-prizm-football': { ref: '', rungs: { '': { f: 1, n: 9 }, silver: { f: 3, n: 9 } } } });
  check('a parallel in two of the line\'s releases becomes a line rung',
    two['prizm|'] && two['prizm|'].rungs && near(two['prizm|'].rungs.silver.f, 2.5, 0.01) && two['prizm|'].rungs.silver.p === 2,
    JSON.stringify(two['prizm|']));
  check('named rungs do not pool site-wide', !(two['*|'] && two['*|'].rungs));

  console.log(failures ? `\n${failures} check(s) failed` : '\nall parallel-ladder checks passed');
  process.exit(failures ? 1 : 0);
})();
