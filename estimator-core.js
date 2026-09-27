// The adaptive part of the parallel estimator, kept pure so the backtest and
// the tests run it exactly as the site does.
//
// An unsold parallel is priced as the card's level times the parallel's step
// on the product's ladder (_checklistParallels). Three things about that were
// fixed guesses, and each is wrong for someone:
//
//   1. Every sale counted the same whatever its date. A player whose market
//      doubled since August was priced off August.
//      → trendDrift: the player's own drift, read from repeat sales of the
//        same card/parallel/grade, so a mix of cheap and dear cards selling
//        at different times is not mistaken for a trend. Shrunk toward flat
//        by how noisy it is (a Bayesian prior of `trendTau` log-units a day).
//      → adjustedMedian: each sale moved to today by that drift, then a
//        median weighted by recency (half-life `halfLife` days).
//
//   2. Every player's parallels were spread like the product's average
//      player's. A star's rare parallels run further above his base than a
//      backup's do (collectors chase the scarce copy of a star).
//      → fitSpread: from the player's own sold parallels, how far his prices
//        stretch along the ladder (k = 1 is the product's spread), shrunk
//        toward 1 by a prior of `spreadTau`.
//
//   3. Each kind of estimate (ladder rung, print-run curve, line-wide rung...)
//      was trusted as it came.
//      → calibration: the backtest's median error per basis, fed back.
//
// The prior widths and the half-life are not guessed either: the nightly
// backtest (server.js, runEstimatorBacktest) hides parallels that did sell,
// prices them from what sold before, and keeps the settings that came closest.

const DAY = 86400000;

const DEFAULT_PARAMS = Object.freeze({
  halfLife: null,     // days; null = every sale weighs the same (the old behaviour)
  trendTau: 0,        // prior sd of daily drift, log units; 0 = no trend adjustment
  spreadTau: 0,       // prior sd of the spread k around 1; 0 = product spread for all
  floorBase: false,   // hold every parallel's step to at least base
  numberedFrom: 'all', // 'larger': a numbered parallel is priced from this card's larger print runs
  numberedNearest: 0, // with 'larger': only the N closest larger runs (0 = all of them)
  liftRarer: true,    // lift an estimate above the dearest larger run on the card
  slabs: 'use',       // 'use': slabs anchor like raw sales; 'fallback': only when nothing sold raw
  calib: {},          // basis -> multiplier
});

const TREND_MAX = 0.01;        // ±1%/day, ~±35%/month: past this it is data, not market
const SPREAD_MIN = 0.6, SPREAD_MAX = 1.6;

const daysBetween = (a, b) => (Date.parse(String(b).slice(0, 10)) - Date.parse(String(a).slice(0, 10))) / DAY;

// The player's drift, as log-price change per day forward. `obs` is
// [{ group, age, logp }]: age in days before the reference date, group the
// identity a repeat sale shares (card, parallel, grade).
function trendDrift(obs, tau) {
  if (!(tau > 0)) return { drift: 0, n: 0 };
  const groups = new Map();
  for (const o of obs) {
    if (!Number.isFinite(o.logp) || !Number.isFinite(o.age)) continue;
    if (!groups.has(o.group)) groups.set(o.group, []);
    groups.get(o.group).push(o);
  }
  let sxy = 0, sxx = 0, n = 0, g = 0;
  const demeaned = [];
  for (const xs of groups.values()) {
    if (xs.length < 2) continue;
    const ma = xs.reduce((t, o) => t + o.age, 0) / xs.length;
    const my = xs.reduce((t, o) => t + o.logp, 0) / xs.length;
    for (const o of xs) {
      const x = o.age - ma, y = o.logp - my;
      sxy += x * y; sxx += x * x; n++;
      demeaned.push([x, y]);
    }
    g++;
  }
  if (n - g < 3 || !(sxx > 0)) return { drift: 0, n };
  const beta = sxy / sxx;                              // per day of AGE: rising prices give beta < 0
  const rss = demeaned.reduce((t, [x, y]) => t + (y - beta * x) ** 2, 0);
  const s2 = rss / Math.max(1, n - g - 1);
  const varB = s2 / sxx;
  const shrink = (tau * tau) / (tau * tau + varB);
  const drift = Math.max(-TREND_MAX, Math.min(TREND_MAX, -beta * shrink));
  return { drift, n, raw: -beta, shrink };
}

// A median weighted by recency, of prices first moved to the reference date
// by the drift. `sales` is [{ price, age }].
function adjustedMedian(sales, { drift = 0, halfLife = null } = {}) {
  const xs = sales.filter(s => s.price > 0 && Number.isFinite(s.age))
    .map(s => ({ v: s.price * Math.exp(drift * s.age), w: halfLife > 0 ? Math.pow(0.5, Math.max(0, s.age) / halfLife) : 1 }))
    .sort((a, b) => a.v - b.v);
  if (!xs.length) return null;
  const total = xs.reduce((t, x) => t + x.w, 0);
  let acc = 0;
  for (let i = 0; i < xs.length; i++) {
    acc += xs[i].w;
    // Exactly half: the midpoint of this and the next, as a plain median does.
    if (Math.abs(acc - total / 2) < 1e-9 * total && i + 1 < xs.length) return (xs[i].v + xs[i + 1].v) / 2;
    if (acc > total / 2) return xs[i].v;
  }
  return xs[xs.length - 1].v;
}

// How far this player's prices stretch along the ladder. `points` is
// [{ logf, logr, w }]: a sold parallel's ladder factor and its price.
function fitSpread(points, tau) {
  if (!(tau > 0)) return { k: 1, n: 0 };
  const ps = points.filter(p => Number.isFinite(p.logf) && Number.isFinite(p.logr));
  if (ps.length < 3) return { k: 1, n: ps.length };
  const W = ps.reduce((t, p) => t + (p.w || 1), 0);
  const mx = ps.reduce((t, p) => t + (p.w || 1) * p.logf, 0) / W;
  const my = ps.reduce((t, p) => t + (p.w || 1) * p.logr, 0) / W;
  let sxx = 0, sxy = 0;
  for (const p of ps) { const w = p.w || 1; sxx += w * (p.logf - mx) ** 2; sxy += w * (p.logf - mx) * (p.logr - my); }
  // Parallels all at about one step say nothing about the spread.
  const range = Math.max(...ps.map(p => p.logf)) - Math.min(...ps.map(p => p.logf));
  if (!(sxx > 0) || range < Math.log(2)) return { k: 1, n: ps.length };
  const kHat = sxy / sxx;
  const rss = ps.reduce((t, p) => t + (p.w || 1) * (p.logr - my - kHat * (p.logf - mx)) ** 2, 0);
  const s2 = rss / Math.max(1, W - 2);
  const varK = s2 / sxx;
  const shrink = (tau * tau) / (tau * tau + varK);
  const k = Math.max(SPREAD_MIN, Math.min(SPREAD_MAX, 1 + (kHat - 1) * shrink));
  return { k, n: ps.length, raw: kHat, shrink };
}

// ---- scoring ----

const _med = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const TIERS = [[0, 10, 'under $10'], [10, 50, '$10-50'], [50, 250, '$50-250'], [250, Infinity, '$250+']];

// cases: [{ actual, predicted, basis, product, player }]. MdAPE is the median
// of |error| / actual; bias the median of log(predicted / actual) as a
// percentage (positive: estimates run high).
function scoreCases(cases) {
  const ok = cases.filter(c => c.actual > 0 && c.predicted > 0);
  const summarise = (xs) => {
    if (!xs.length) return { n: 0 };
    const ape = xs.map(c => Math.abs(c.predicted - c.actual) / c.actual);
    const lr = xs.map(c => Math.log(c.predicted / c.actual));
    return {
      n: xs.length,
      mdape: Math.round(_med(ape) * 1000) / 10,
      bias: Math.round((Math.exp(_med(lr)) - 1) * 1000) / 10,
      within25: Math.round(ape.filter(a => a <= 0.25).length / xs.length * 1000) / 10,
      within50: Math.round(ape.filter(a => a <= 0.5).length / xs.length * 1000) / 10,
    };
  };
  const by = (f) => {
    const m = new Map();
    for (const c of ok) { const k = f(c); if (!m.has(k)) m.set(k, []); m.get(k).push(c); }
    return Object.fromEntries([...m].map(([k, xs]) => [k, summarise(xs)]));
  };
  return {
    ...summarise(ok),
    byTier: by(c => TIERS.find(([lo, hi]) => c.actual >= lo && c.actual < hi)[2]),
    byBasis: by(c => c.basis || 'unknown'),
  };
}

// A multiplier per basis from the backtest's own errors, shrunk toward 1 by
// how few cases stand behind it and held to ±30%.
const CALIB_PRIOR = 20;
function calibrate(cases) {
  const by = new Map();
  for (const c of cases) {
    if (!(c.actual > 0 && c.predicted > 0)) continue;
    const k = c.basis || 'unknown';
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(Math.log(c.actual / c.predicted));
  }
  const out = {};
  for (const [k, xs] of by) {
    if (xs.length < 10) continue;
    const m = _med(xs) * xs.length / (xs.length + CALIB_PRIOR);
    out[k] = Math.round(Math.max(0.7, Math.min(1.3, Math.exp(m))) * 1000) / 1000;
  }
  return out;
}

const withCalib = (cases, calib) => cases.map(c => ({ ...c, predicted: c.predicted * ((calib || {})[c.basis] || 1) }));

// Calibration judged on cases it was not fitted to: two folds by player, so
// one player's many parallels cannot fit and then grade themselves.
function crossCalibrated(cases) {
  const fold = (c) => {
    let h = 0;
    for (const ch of String(c.player || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return h % 2;
  };
  const a = cases.filter(c => fold(c) === 0), b = cases.filter(c => fold(c) === 1);
  return [...withCalib(b, calibrate(a)), ...withCalib(a, calibrate(b))];
}

// The settings the tuner tries. Each is a hyperparameter of a per-player fit,
// not a price: how much a player's own evidence is allowed to say.
// Each setting and the values the tuner tries. Not every combination: a
// full grid (64) ran past the Worker's CPU limit on live data, so the tuner
// walks from the old settings one setting at a time (see server.js
// _tuneEstimator), keeping each change that helps — ~15 evaluations.
const PARAM_DIMS = {
  numberedFrom: ['all', 'larger'],
  liftRarer: [true, false],
  numberedNearest: [0, 2],
  slabs: ['use', 'fallback'],
  floorBase: [false, true],
  spreadTau: [0, 0.2],
  trendTau: [0, 0.004],
  halfLife: [null, 45],
};
const PARAM_START = Object.freeze({ halfLife: null, trendTau: 0, spreadTau: 0, floorBase: false, slabs: 'use', numberedFrom: 'all',
  liftRarer: true, numberedNearest: 0 });

// Adopt a tuned setting only if it beats the old estimator by a margin the
// sample can show: at least MIN_CASES cases, and MIN_GAIN points of MdAPE.
const MIN_CASES = 60, MIN_GAIN = 1;
// The case that matters most — a numbered parallel priced from the card's
// larger print runs — is judged on its own once it has this many cases.
const MIN_NUMBERED_CASES = 30;
// How many points further from zero a setting's lean may be than the old
// estimator's, before it is refused however much less it misses.
const MAX_EXTRA_BIAS = 10;

module.exports = {
  DEFAULT_PARAMS, PARAM_DIMS, PARAM_START, MIN_CASES, MIN_GAIN, MIN_NUMBERED_CASES, MAX_EXTRA_BIAS, DAY,
  daysBetween, trendDrift, adjustedMedian, fitSpread,
  scoreCases, calibrate, withCalib, crossCalibrated,
};
