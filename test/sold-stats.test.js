// Integration test for the home-page stats, and specifically for the two
// mover boards.
//
// "Biggest increase" is the easiest statistic here to get wrong, because the
// top of a percentage ranking is exactly where the noisiest estimates land. A
// card with two sales either side can post +400% off one lucky copy and outrank
// every genuine move; a player's mean price rises when their expensive cards
// merely trade more often. This site has already shipped that bug once, as a
// +7,127% mover built from sales whose parallel could not be read.
//
// So this fixture is built adversarially: alongside real movers it contains
// exactly the cards that would top a naive board, and the checks assert they do
// NOT appear. A version of these boards with the guards removed fails here.
let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (err) {
  console.error('FAIL  node:sqlite unavailable on ' + process.version +
                ' — this test needs Node 22.5+. Update the runtime, do not skip it.');
  process.exit(1);
}
const path = require('path');

const db = new DatabaseSync(':memory:');
db.exec(`CREATE TABLE sales (
  item_id TEXT, sold_date TEXT, title TEXT, price_cents INTEGER, currency TEXT,
  listing_format TEXT, grader TEXT, grade TEXT, player TEXT, parallel TEXT,
  year TEXT, set_name TEXT, card_number TEXT, confidence REAL,
  best_offer INTEGER, bids INTEGER, image_url TEXT
)`);
db.exec(`CREATE TABLE daily (sold_date TEXT, sales INTEGER, priced INTEGER, total_cents INTEGER)`);

const DAY = 86400000;
const iso = (off) => new Date(Date.now() + off * DAY).toISOString().slice(0, 10);
const ins = db.prepare(
  `INSERT INTO sales (item_id, sold_date, title, price_cents, player, year, set_name,
                      parallel, card_number, grader, grade, confidence, image_url)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
let n = 0;

// days: -29..0, so the split lands at -15.
const WINDOW = 30;
const RECENT = -7;   // comfortably in the recent half
const OLDER = -25;   // comfortably in the older half

// `sales` per half, at `price` dollars. A title is supplied because the raw-only
// filter reads it, not just the grade columns.
function card(opts) {
  const { player, set = 'Prizm', parallel = 'Silver', number = '1', year = '2022',
          oldPrice, newPrice, oldN, newN, title, grader = '', grade = '' } = opts;
  const t = title || `${year} ${set} ${player} ${parallel} #${number}`;
  const put = (day, price, count) => {
    for (let k = 0; k < count; k++) {
      ins.run(`x${n++}`, iso(day + (k % 3)), t, Math.round(price * 100), player, year,
              set, parallel, number, grader, grade, 0.9, null);
    }
  };
  put(OLDER, oldPrice, oldN);
  put(RECENT, newPrice, newN);
}

// --- Genuine movers: plenty of sales both sides, a real rise -----------------
card({ player: 'Real Riser', oldPrice: 100, newPrice: 180, oldN: 12, newN: 12 });          // +80%
card({ player: 'Real Riser', parallel: 'Base', number: '2', oldPrice: 40, newPrice: 68, oldN: 10, newN: 10 });   // +70%
card({ player: 'Real Riser', parallel: 'Gold', number: '3', oldPrice: 200, newPrice: 320, oldN: 8, newN: 8 });   // +60%

// --- The trap: a huge percentage off almost no data --------------------------
// Two sales each side. A naive board ranks this first at +900%; the
// minimum-sales-per-half floor must keep it off entirely.
card({ player: 'Thin Sample', oldPrice: 10, newPrice: 100, oldN: 2, newN: 2 });

// --- The trap: a cheap card whose percentage is meaningless ------------------
// $1 -> $6 is +500% and is noise. The price floor must exclude it.
card({ player: 'Penny Common', oldPrice: 1, newPrice: 6, oldN: 20, newN: 20 });

// --- The trap: a slab among raw copies --------------------------------------
// Same card key, but the recent sales are PSA 10s at 10x. That is a different
// market, not a price move, and the raw-only filter must drop the graded rows.
// What remains is flat, so this card must not appear as a riser.
card({ player: 'Slab Mixed', oldPrice: 50, newPrice: 50, oldN: 10, newN: 10 });
(() => {
  const t = '2022 Prizm Slab Mixed Silver #1 PSA 10 GEM MINT';
  for (let k = 0; k < 12; k++) {
    ins.run(`g${n++}`, iso(RECENT + (k % 3)), t, 50000, 'Slab Mixed', '2022', 'Prizm',
            'Silver', '1', 'PSA', '10', 0.9, null);
  }
})();

// --- The trap: unidentified sales that would collapse into one bucket -------
// Blank parallel, base and patch prices together — the Jaxson Dart shape. The
// identity filter must drop these before they can be grouped.
(() => {
  for (let k = 0; k < 14; k++) {
    ins.run(`u${n++}`, iso(OLDER + (k % 3)), '2025 Chrome Blank Parallel', 500,
            'Blank Parallel', '2025', 'Chrome', '', '1', '', '', 0.9, null);
  }
  for (let k = 0; k < 14; k++) {
    ins.run(`u${n++}`, iso(RECENT + (k % 3)), '2025 Chrome Blank Parallel', 50000,
            'Blank Parallel', '2025', 'Chrome', '', '1', '', '', 0.9, null);
  }
})();

// --- The trap: one hot card must not carry a whole player -------------------
// Four cards. One triples; the other three are flat. The player's MEDIAN change
// is 0%, so they must not lead the player board — a mean would put them top.
card({ player: 'One Hot Card', parallel: 'Silver', number: '1', oldPrice: 50, newPrice: 200, oldN: 10, newN: 10 });
card({ player: 'One Hot Card', parallel: 'Base', number: '2', oldPrice: 50, newPrice: 50, oldN: 10, newN: 10 });
card({ player: 'One Hot Card', parallel: 'Gold', number: '3', oldPrice: 60, newPrice: 60, oldN: 10, newN: 10 });
card({ player: 'One Hot Card', parallel: 'Red', number: '4', oldPrice: 70, newPrice: 70, oldN: 10, newN: 10 });

// --- A player who genuinely moved across their whole card list --------------
for (let c = 1; c <= 4; c++) {
  card({ player: 'Broad Riser', parallel: `P${c}`, number: String(c),
         oldPrice: 100, newPrice: 150, oldN: 10, newN: 10 });   // every card +50%
}

// --- Set volume, for the demand board ---------------------------------------
// A cheap set that trades constantly must outrank an expensive one that barely
// moves, because demand is how much is changing hands.
for (let k = 0; k < 600; k++) {
  ins.run(`v${n++}`, iso(-(k % WINDOW)), '2023 Busy Set Player A Base', 800,
          `Filler ${k % 40}`, '2023', 'Busy Set', 'Base', String(k % 40), '', '', 0.9, null);
}
for (let k = 0; k < 40; k++) {
  ins.run(`w${n++}`, iso(-(k % WINDOW)), '2023 Quiet Set Player B Base', 90000,
          `Rich ${k % 10}`, '2023', 'Quiet Set', 'Base', String(k % 10), '', '', 0.9, null);
}

// The pre-aggregated totals table the endpoint reads for the headline figures.
db.exec(`INSERT INTO daily (sold_date, sales, priced, total_cents)
         SELECT sold_date, COUNT(*), COUNT(price_cents), SUM(price_cents)
         FROM sales GROUP BY sold_date`);

const d1 = {
  prepare(sql) {
    let bound = [];
    const api = {
      bind(...args) { bound = args; return api; },
      all() { return { results: db.prepare(sql).all(...bound) }; },
      run() { return { success: true, meta: db.prepare(sql).run(...bound) }; },
      first() { return db.prepare(sql).get(...bound) || null; },
    };
    return api;
  },
  batch(stmts) { return stmts.map(st => st.run()); },
};

const dbMod = require(path.join(__dirname, '..', 'db.js'));
dbMod.getNflDb = () => d1;
process.env.CF_WORKER = '1';

const { app } = require(path.join(__dirname, '..', 'server.js'));
const PORT = 3204;
const server = app.listen(PORT);
const call = async (url) => (await fetch(`http://127.0.0.1:${PORT}${url}`)).json();

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};
const names = (rows) => (rows || []).map(r => r.name || r.player);

(async () => {
  const s = await call(`/api/sold-stats?days=${WINDOW}`);
  check('sold-stats returns data', s.available === true,
        s.available ? `${s.pricedSales} priced sales` : `error=${s.error}`);
  if (!s.available) { server.close(); process.exit(1); }

  // ---- the existing boards still work ----
  check('most sold is ranked by sales', (s.mostSold || []).length > 0 &&
        (s.mostSold || []).every((r, i, a) => !i || a[i - 1].sales >= r.sales),
        `${(s.mostSold || []).length} rows, top=${s.mostSold[0] && s.mostSold[0].sales}`);
  check('most expensive is ranked by price', (s.priciest || []).length > 0 &&
        (s.priciest || []).every((r, i, a) => !i || a[i - 1].price >= r.price));

  // ---- lists are computed deep enough for the full leaderboard ----
  check('lists go deeper than the three the home strip shows',
        (s.mostSold || []).length > 3 && (s.topSets || []).length > 1,
        `mostSold=${s.mostSold.length} topSets=${s.topSets.length}`);

  // ---- highest demand by set ----
  const setNames = names(s.topSets);
  check('demand ranks the busy set above the expensive quiet one',
        setNames.indexOf('2023 Busy Set') > -1 &&
        setNames.indexOf('2023 Busy Set') < setNames.indexOf('2023 Quiet Set'),
        setNames.slice(0, 3).join(' | '));

  // ---- card movers: the real one is there ----
  const cardNames = names(s.cardMovers);
  check('a genuine riser reaches the card board',
        cardNames.some(x => /Real Riser/.test(x)),
        (s.cardMovers[0] && `${s.cardMovers[0].name} ${s.cardMovers[0].changePct}%`) || 'empty');

  // ---- card movers: every trap is excluded ----
  check('a +900% card with two sales a side is excluded',
        !cardNames.some(x => /Thin Sample/.test(x)),
        `min ${s.moversBasis.minSalesPerHalf}/half`);
  check('a $1 -> $6 common is excluded',
        !cardNames.some(x => /Penny Common/.test(x)),
        `floor $${s.moversBasis.minPrice}`);
  check('PSA 10s among raw copies do not become a price move',
        !cardNames.some(x => /Slab Mixed/.test(x)), 'raw-only filter');
  check('sales with no readable parallel never group together',
        !cardNames.some(x => /Blank Parallel/.test(x)), 'identity filter');

  // The single most important property: nothing excluded may outrank the real
  // mover by sneaking in under another name.
  check('the top of the card board is a real mover, not an artefact',
        s.cardMovers.length > 0 && /Real Riser|Broad Riser|One Hot Card/.test(s.cardMovers[0].name),
        `${s.cardMovers[0] && s.cardMovers[0].name}`);

  // ---- player movers: median, not mean ----
  const playerNames = names(s.playerMovers);
  const hot = (s.playerMovers || []).find(p => p.player === 'One Hot Card');
  const broad = (s.playerMovers || []).find(p => p.player === 'Broad Riser');
  check('a player whose cards all rose is on the board',
        !!broad, broad ? `${broad.changePct}% across ${broad.cards} cards` : 'missing');
  check('one tripling card does not carry a player whose others are flat',
        !!hot && Math.abs(hot.changePct) < 5,
        hot ? `median ${hot.changePct}% (a mean would read ~+75%)` : 'missing');
  check('the broad riser outranks the one-hot-card player',
        !!broad && !!hot && playerNames.indexOf('Broad Riser') < playerNames.indexOf('One Hot Card'),
        playerNames.slice(0, 3).join(' | '));

  // ---- the page must be able to say what it measured ----
  check('the basis of the boards is reported', !!s.moversBasis &&
        s.moversBasis.rawOnly === true && s.moversBasis.cardsConsidered > 0,
        s.moversBasis ? `${s.moversBasis.cardsConsidered} cards, split ${s.moversBasis.splitDate}` : 'missing');

  // ---- it has to fit in a Worker's CPU budget ----
  const t0 = Date.now();
  await call(`/api/sold-stats?days=90`);
  const ms = Date.now() - t0;
  check('sold-stats completes inside the Worker budget', ms < 2000, `${ms}ms`);

  server.close();
  console.log(failures ? `\n${failures} check(s) failed` : '\nall sold-stats checks passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('THREW:', e && e.stack || e); process.exit(1); });
