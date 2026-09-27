// The estimator adapts to each player's market, and the backtest proves it.
//
// An unsold parallel is priced as the card's level times the parallel's step
// on the product's ladder. That used to treat every player the same and every
// sale as current. Here a synthetic market has players whose prices rise or
// fall over the two months, and stars whose rare parallels run much further
// above their base than the ladder's average (and role players whose run
// less far). The backtest hides each parallel that sold lately, prices it
// from what else sold before, and must find — on its own — settings that
// follow each player's drift and spread, and adopt them only because they
// measurably beat the old estimator.
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const EST = require(path.join(__dirname, '..', 'estimator-core.js'));

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

// ---- the pieces, alone ----
{
  // A drift read from repeat sales, not from which card happened to sell when.
  const obs = [];
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let g = 0; g < 6; g++) {
    for (let age = 0; age < 60; age += 4) {
      obs.push({ group: `c${g}`, age, logp: Math.log(100 * (g + 1)) - 0.006 * age + (rnd() - 0.5) * 0.2 });
    }
  }
  const t = EST.trendDrift(obs, 0.005);
  check('a player\'s drift is read from his repeat sales', Math.abs(t.drift - 0.006) < 0.0015, `drift ${t.drift.toFixed(4)}/day`);
  check('  ...and not at all with the prior at 0 (the old behaviour)', EST.trendDrift(obs, 0).drift === 0);
  // A cheap card selling early and a dear one late is not a rising market.
  const mix = [];
  for (let age = 30; age < 60; age += 3) mix.push({ group: 'cheap', age, logp: Math.log(10) + (rnd() - 0.5) * 0.1 });
  for (let age = 0; age < 30; age += 3) mix.push({ group: 'dear', age, logp: Math.log(500) + (rnd() - 0.5) * 0.1 });
  check('  ...so a dear card selling after a cheap one is not a trend', Math.abs(EST.trendDrift(mix, 0.005).drift) < 0.002,
    `drift ${EST.trendDrift(mix, 0.005).drift.toFixed(4)}`);
  // Two noisy sales say little: shrunk toward flat.
  const thin = [{ group: 'a', age: 40, logp: Math.log(100) }, { group: 'a', age: 0, logp: Math.log(180) },
    { group: 'b', age: 30, logp: Math.log(50) }, { group: 'b', age: 2, logp: Math.log(40) }];
  check('  ...and a thin, contradictory one is shrunk toward flat',
    Math.abs(EST.trendDrift(thin, 0.002).drift) < Math.abs(EST.trendDrift(thin, 0.02).drift) + 1e-12);

  const sales = [{ price: 10, age: 50 }, { price: 12, age: 40 }, { price: 30, age: 2 }, { price: 31, age: 1 }, { price: 11, age: 45 }];
  check('with the default settings the price is the plain median', EST.adjustedMedian(sales) === 12);
  check('  ...a half-life leans on the recent sales', EST.adjustedMedian(sales, { halfLife: 10 }) >= 30);
  check('  ...and a rising drift moves old sales up to today', EST.adjustedMedian([{ price: 100, age: 30 }], { drift: 0.01 }) > 134);

  const star = [0, Math.log(2), Math.log(5), Math.log(14), Math.log(25)]
    .map(lf => ({ logf: lf, logr: Math.log(20) + 1.35 * lf, w: 3 }));
  const sp = EST.fitSpread(star, 0.35);
  check('a star\'s spread along the ladder is read from his own parallels', sp.k > 1.25 && sp.k <= 1.35, `k=${sp.k.toFixed(3)}`);
  check('  ...and is 1 (the product\'s spread) with the prior at 0', EST.fitSpread(star, 0).k === 1);
  check('  ...or with parallels all about one step apart',
    EST.fitSpread([{ logf: 0, logr: 1 }, { logf: 0.1, logr: 1.5 }, { logf: 0.2, logr: 1.2 }], 0.35).k === 1);

  const cases = [];
  for (let i = 0; i < 40; i++) cases.push({ actual: 100, predicted: 80, basis: 'ladder', player: `p${i % 8}` });
  const cal = EST.calibrate(cases);
  check('calibration lifts a basis the backtest shows running low, shrunk by its sample',
    cal.ladder > 1.1 && cal.ladder < 1.25, JSON.stringify(cal));
  const sc = EST.scoreCases(cases);
  check('scores are median error and bias in percent', sc.mdape === 20 && sc.bias === -20, JSON.stringify({ mdape: sc.mdape, bias: sc.bias }));
}

// ---- the whole loop, on a market with players moving differently ----
const db = new DatabaseSync(':memory:');
db.exec(`CREATE TABLE sales (item_id TEXT, sold_date TEXT, title TEXT, price_cents INTEGER, currency TEXT,
  listing_format TEXT, grader TEXT, grade TEXT, player TEXT, parallel TEXT, year TEXT, set_name TEXT,
  card_number TEXT, confidence REAL, best_offer INTEGER, bids INTEGER, image_url TEXT)`);
const ins = db.prepare(`INSERT INTO sales (item_id, sold_date, title, price_cents, grader, grade, player, parallel,
  year, set_name, card_number, confidence, best_offer) VALUES (?,?,?,?,NULL,NULL,?,?,'2017','Prizm',?,0.9,0)`);
const d1 = { prepare(sql) {
  let b = [];
  const api = { bind(...a) { b = a; return api; },
    async all() { return { results: db.prepare(sql).all(...b) }; },
    async first() { return db.prepare(sql).get(...b) || null; },
    async run() { return { success: true, meta: db.prepare(sql).run(...b) }; } };
  return api;
} };
const store = new Map();
const dbMod = require(path.join(__dirname, '..', 'db.js'));
dbMod.getNflDb = () => d1;
dbMod.cacheGet = async (k) => (store.has(k) ? JSON.parse(store.get(k)) : null);
dbMod.cachePut = async (k, v) => { store.set(k, JSON.stringify(v)); };
process.env.CF_WORKER = '1';
const S = require(path.join(__dirname, '..', 'server.js'));

const PID = '2017-panini-prizm-football';
// The product's ladder: each parallel's step over base for its average player.
const PARS = [['', 'Base', 1], ['Silver Prizm', 'Prizm', 2], ['Orange', 'Prizm Orange', 4], ['Light Blue', 'Prizm Light Blue', 5],
  ['Green Scope', 'Prizm Green Scope', 8], ['Red Power', 'Prizm Red Power', 14], ['Camo', 'Prizm Camo', 25]];
// Numbered parallels carry their serial on the title, as real ones do.
const RUNS = { Orange: 275, 'Light Blue': 199, 'Green Scope': 99, 'Red Power': 49, Camo: 25 };
const titleOf = (player, num, col) => `2017 Panini Prizm ${player} #${num}${col ? ' ' + col : ''}${RUNS[col] ? ' /' + RUNS[col] : ''} RC`;
const rungs = {};
for (const [, name, f] of PARS) rungs[S._ladderKey(name === 'Base' ? '' : name)] = { f, n: 80, lo: 0.9, hi: 1.1 };
// The column the sales carry must land on the same rung as the checklist name.
for (const [col, name] of PARS) {
  if (col && S._ladderKey(col) !== S._ladderKey(name)) rungs[S._ladderKey(col)] = rungs[S._ladderKey(name)];
}

const DAY = 86400000;
const iso = (o) => new Date(Date.now() + o * DAY).toISOString().slice(0, 10);
let seed = 11;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
// [number, player, base level today, spread k, drift per day]
const PLAYERS = [
  ['1', 'Aaron Rodgers', 40, 1.4, 0.008], ['2', 'Eric Ebron', 3, 0.75, -0.006], ['3', 'A.J. Green', 8, 1.0, 0.006],
  ['4', 'Kirk Cousins', 5, 0.8, 0], ['6', 'Carlos Hyde', 3, 0.75, -0.007], ['7', 'Antonio Gates', 6, 1.0, 0.007],
  ['8', 'Matt Ryan', 10, 1.35, 0.008], ['9', 'Frank Gore', 6, 0.8, -0.005], ['10', 'Aaron Donald', 25, 1.4, 0.007],
  ['11', 'Larry Fitzgerald', 12, 1.3, 0], ['12', 'Ezekiel Elliott', 20, 1.35, 0.008],
];
let n = 0;
for (const [num, player, level, k, drift] of PLAYERS) {
  for (const [col, , f] of PARS) {
    for (let d = -60; d <= -1; d += 5 + Math.floor(rnd() * 4)) {
      const price = level * Math.pow(f, k) * Math.exp(drift * d) * Math.exp((rnd() - 0.5) * 0.25);
      ins.run(`s${n++}`, iso(d), titleOf(player, num, col), Math.round(price * 100),
              player, col, num);
    }
  }
}

(async () => {
  S._primeParallelLadder({ builtAt: 'test', products: { [PID]: { ref: '', rungs, levels: { q25: 5, q50: 12, cards: 200 } } }, curves: {} });
  S._primeEstimatorParams(null);

  // A ladder whose base was inflated by unnamed parallels says Silver is
  // worth a third of base. Taken at its word, a $12 Silver made a $1.54 base
  // card "$36"; a parallel is never worth less than its base.
  {
    const set = { parallels: [{ name: 'Silver' }, { name: 'Green' }] };
    const fit = { ref: '', rungs: { '': { f: 1, n: 50, lo: 0.9, hi: 1.1 }, silver: { f: 0.33, n: 30, lo: 0.9, hi: 1.1 },
                                    green: { f: 0.5, n: 30, lo: 0.9, hi: 1.1 } } };
    const out = S._checklistParallels(set, [{ key: 'silver', name: 'Silver', raw: 12, rawN: 3, sales: 3 }], fit, null,
      { params: { ...EST.DEFAULT_PARAMS, floorBase: true } });
    const base = out.find(x => x.name === 'Base'), green = out.find(x => x.name === 'Green');
    check('with floorBase, a rung under base is not believed: base is not priced above the Silver it came from',
      !base || !base.estimate || base.estimate.price <= 12, JSON.stringify(base && base.estimate && base.estimate.price));
    check('  ...and no parallel is estimated under base', !green || !green.estimate || !base || !base.estimate
      || green.estimate.price >= base.estimate.price, JSON.stringify(green && green.estimate && green.estimate.price));
  }

  // Slabs of a cheap card are mostly grading fee: with slabs 'fallback', a
  // parallel known only from its slabs does not anchor a card that has raw
  // sales to go on.
  {
    const set = { parallels: [{ name: 'Silver' }, { name: 'Red' }] };
    const fit = { ref: '', rungs: { '': { f: 1, n: 50, lo: 0.9, hi: 1.1 }, silver: { f: 4, n: 30, lo: 0.9, hi: 1.1 },
                                    red: { f: 6, n: 30, lo: 0.9, hi: 1.1 } } };
    const known = [{ key: 'silver', name: 'Silver', raw: 8, rawN: 3, sales: 3 },
                   { key: 'red', name: 'Red', raw: null, rawN: 0, sales: 2, grades: { 'PSA 9': 60 }, gradeN: { 'PSA 9': 2 } }];
    const use = S._checklistParallels(set, known, fit, null, { params: EST.DEFAULT_PARAMS });
    const fb = S._checklistParallels(set, known, fit, null, { params: { ...EST.DEFAULT_PARAMS, slabs: 'fallback' } });
    const baseOf = (o) => o.find(x => x.name === 'Base').estimate.price;
    check('with slabs "fallback", a slab-only parallel does not pull up a card with raw sales',
      baseOf(fb) === 2 && baseOf(use) > 2, `use $${baseOf(use)}, fallback $${baseOf(fb)}`);
  }

  const r = await S.runEstimatorBacktest({ save: true });
  check('the backtest runs on the players with the most parallel sales', r.ok && r.report.pairs === PLAYERS.length,
    r.ok ? `${r.report.pairs} pairs, ${r.report.chosen.n} cases` : JSON.stringify(r));
  const base = r.report.baseline, got = r.report.chosen;
  check('the old estimator is measured on the same cases', base.n === got.n && base.n >= EST.MIN_CASES,
    `baseline MdAPE ${base.mdape}% on ${base.n}`);
  check('a tuned setting is adopted because it beats the old estimator', r.report.adopted === 'tuned'
    && got.mdape <= base.mdape - EST.MIN_GAIN, `${base.mdape}% -> ${got.mdape}%`);
  check('  ...by a lot, on a market this uneven', got.mdape < base.mdape / 2, `${base.mdape}% -> ${got.mdape}%`);
  check('  ...and it follows each player\'s spread and drift', r.params.spreadTau > 0 && r.params.trendTau > 0,
    JSON.stringify(r.params));
  check('the settings are stored for the estimator to read', store.has('estimator:params:v1'));

  // Rainbow Mode prices with them: a star's Gold /10 now sits further over
  // his base than the ladder's average player's would, and his rise shows.
  const withTuned = await S._checklistPrices(PID, 'Aaron Rodgers');
  const gold = (res) => res.cards.find(c => c.set === 'Base Set').parallels.find(p => p.name === 'Prizm Gold');
  S._primeEstimatorParams(null);
  const withOld = await S._checklistPrices(PID, 'Aaron Rodgers');
  const truth = 40 * Math.pow(40, 1.4);
  check('a star\'s unsold Gold /10 is priced for a star', gold(withTuned).price > gold(withOld).price * 2
    && Math.abs(Math.log(gold(withTuned).price / truth)) < Math.abs(Math.log(gold(withOld).price / truth)),
    `old $${gold(withOld).price}, tuned $${gold(withTuned).price}, true $${Math.round(truth)} (ladder says 40x base)`);
  check('  ...and his market\'s drift is reported', withTuned.drift > 10, `${withTuned.drift}%/30 days`);
  check('with no backtest yet, the estimator is exactly the old one', withOld.drift === undefined);

  // Nothing to gain: a market where every player IS the ladder's average and
  // nobody moves. The old estimator must stay.
  db.exec('DELETE FROM sales');
  for (const [num, player, level] of PLAYERS) {
    for (const [col, , f] of PARS) {
      for (let d = -60; d <= -1; d += 6) {
        ins.run(`s${n++}`, iso(d), titleOf(player, num, col),
                Math.round(level * f * Math.exp((rnd() - 0.5) * 0.25) * 100), player, col, num);
      }
    }
  }
  const flat = await S.runEstimatorBacktest({ save: false });
  check('on a market the old estimator already fits, it is kept', flat.ok && flat.report.adopted !== 'tuned',
    flat.ok ? `${flat.report.baseline.mdape}% vs best ${flat.report.grid[0].mdape}%` : JSON.stringify(flat));

  const src = require('fs').readFileSync(path.join(__dirname, '..', 'worker.js'), 'utf8');
  check('the cron runs the backtest daily', /getUTCHours\(\) === 8 && aliasTick\)[\s\S]{0,80}runEstimatorBacktest\(\)/.test(src));

  console.log(failures ? `\n${failures} check(s) failed` : '\nall estimator-backtest checks passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
