// A player too thin for the measured trend still gets a reading — pooled
// across his parallels, leaning on the market by how little he has, flagged
// as an estimate and carrying a band — and a player who clears the measured
// gate keeps exactly the reading he had.
const path = require('path');
process.env.CF_WORKER = '1';
const S = require(path.join(__dirname, '..', 'server.js'));

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

const DAY = 86400000;
const iso = (d) => new Date(Date.parse('2026-09-01') + d * DAY).toISOString().slice(0, 10);
const through = iso(29);
// Card keys as _playerTrendQuery builds them: year|set|player|number|grader|grade|parallel.
const key = (par) => `2017|prizm|thin player|269|||${par}`;
const PID = '2017-panini-prizm-football';
S._primeParallelLadder({ builtAt: 'test', products: { [PID]: { ref: '', rungs: {
  '': { f: 1, n: 50, lo: 0.9, hi: 1.1 }, silver: { f: 3, n: 40, lo: 0.9, hi: 1.1 }, blue: { f: 5, n: 30, lo: 0.9, hi: 1.1 },
  red: { f: 8, n: 30, lo: 0.9, hi: 1.1 }, green: { f: 4, n: 30, lo: 0.9, hi: 1.1 } } } }, curves: {} });

(async () => {
  // A thin player whose market rises 30% over the month: a handful of sales,
  // spread over five parallels of one card, one or two sales each.
  const rise = (d) => Math.exp(Math.log(1.3) * d / 29);
  const rows = [];
  const sale = (d, par, f) => rows.push({ card: key(par), sold_date: iso(d), s: String(Math.round(1000 * f * rise(d))), c: '1' });
  for (const [d, par, f] of [[0, '', 1], [1, 'silver', 3], [2, 'blue', 5], [3, 'red', 8], [5, 'green', 4], [4, '', 1],
                             [23, '', 1], [24, 'silver', 3], [25, 'blue', 5], [27, 'red', 8], [28, 'green', 4], [29, 'silver', 3]]) sale(d, par, f);

  const measured = S._playerTrendPayload(rows, through, 30, 'Thin Player');
  check('the measured trend declines a player this thin', !measured.available && measured.reason === 'not enough sales for a reliable reading',
    measured.reason);

  const pooledRows = await S._poolParallelRows(rows);
  check('a card\'s parallels become one series, each sale on the base scale', new Set(pooledRows.map(r => r.card)).size === 1
    && Math.abs(Number(pooledRows.find(r => r.card && r.sold_date === iso(3)).s) - 1000 * rise(3)) < 1,
    `${new Set(pooledRows.map(r => r.card)).size} series`);

  const flat = S._marketMoveFn({ available: true, series: [{ date: iso(0), score: 100 }, { date: iso(29), score: 100 }] });
  const opts = (k) => ({ pooled: true, minWindow: 3, minCardDays: 2, shrinkK: k, market: flat });
  const own = S._playerTrendPayload(pooledRows, through, 30, 'Thin Player', null, opts(0));
  check('pooled, his own sales read his rise', own.available && own.changePct > 20 && own.changePct < 40, `${own.changePct}%`);
  const blended = S._playerTrendPayload(pooledRows, through, 30, 'Thin Player', null, opts(6));
  check('  ...and blended with a flat market, he leans toward it by how little he has',
    blended.available && blended.changePct > 0 && blended.changePct < own.changePct && blended.ownWeight < 1 && blended.marketChangePct === 0,
    `${blended.changePct}% (own weight ${blended.ownWeight})`);
  check('  ...flagged as an estimate, with a band around it', blended.estimated && blended.method === 'player-trend-pooled'
    && blended.band && blended.band.low < blended.changePct && blended.band.high > blended.changePct,
    JSON.stringify(blended.band));

  // A busy player: the default options are the measured reading, untouched.
  const busy = [];
  for (let d = 0; d <= 29; d++) for (let c = 0; c < 4; c++) busy.push({ card: `2017|prizm|busy|${c}|||`, sold_date: iso(d), s: String(1000 * rise(d)), c: '1' });
  const b = S._playerTrendPayload(busy, through, 30, 'Busy');
  check('a busy player keeps the measured reading, with no band or blend', b.available && b.method === 'player-trend' && !b.band && b.ownWeight === undefined,
    `${b.method} ${b.changePct}%`);

  console.log(failures ? `\n${failures} check(s) failed` : '\nall player-pooled checks passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
