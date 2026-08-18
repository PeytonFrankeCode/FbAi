// Integration test for the market index.
//
// This exists because a syntax check is not enough: the index endpoints were
// shipped once with `_mkDay` deleted, and nothing caught it. `node --check`
// passes on a missing global, the unit test for the maths defined its own copy
// of the helper, and the local server has no D1 binding so the endpoint
// returned "no dataset" before it ever reached the broken line.
//
// So this stubs the D1 binding with a real in-memory SQLite database and calls
// the endpoints for real. Anything undefined on those paths now throws here.
let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (err) {
  // Fail loudly rather than skipping. A test that quietly no-ops on an older
  // runtime is worse than no test — it reports success over untested code,
  // which is the exact failure mode this file exists to prevent.
  console.error('FAIL  node:sqlite unavailable on ' + process.version +
                ' — this test needs Node 22.5+. Update the runtime, do not skip it.');
  process.exit(1);
}
const path = require('path');

const db = new DatabaseSync(':memory:');
db.exec(`CREATE TABLE sales (
  item_id TEXT, sold_date TEXT, title TEXT, price_cents INTEGER, currency TEXT,
  listing_format TEXT, grader TEXT, grade TEXT, player TEXT, parallel TEXT,
  year TEXT, set_name TEXT, confidence REAL, best_offer INTEGER, bids INTEGER,
  image_url TEXT
)`);

// 400 cards over 200 days — big enough that a per-sale JavaScript grouping
// pass would be visibly slow, which is what tripped the Worker CPU limit.
const DAY = 86400000;
const iso = (off) => new Date(Date.now() + off * DAY).toISOString().slice(0, 10);
const ins = db.prepare(
  `INSERT INTO sales (item_id, sold_date, price_cents, player, year, set_name, parallel, grader, grade, confidence)
   VALUES (?,?,?,?,?,?,?,?,?,?)`);
let n = 0;
for (let c = 0; c < 400; c++) {
  for (let d = -200; d <= 0; d++) {
    if ((c + d) % 3) continue;
    const drift = 1 + 0.08 * (d + 200) / 200;
    ins.run(`i${n++}`, iso(d), Math.round(10000 * drift), `Player ${c}`, '2020',
            'Prizm', 'Base', 'PSA', '10', 0.9);
  }
}

// The two cases the old volume index got backwards, as player-scoped fixtures.
// Each gets 20 distinct cards so it clears the matched-card gate on its own.
function scenario(player, priceFor, salesFor) {
  for (let c = 0; c < 20; c++) {
    for (let d = -200; d <= 0; d++) {
      if (d % 3) continue;
      for (let k = 0; k < salesFor(d); k++) {
        ins.run(`s${n++}`, iso(d), Math.round(priceFor(d) * 100), player, '2021',
                'Select', `P${c}`, 'PSA', '10', 0.9);
      }
    }
  }
}
// Prices never move; volume triples over the last 40 days.
scenario('Volume Spike', () => 100, (d) => (d > -40 ? 3 : 1));
// Prices double over the last 40 days; volume falls to a quarter.
scenario('Price Double', (d) => (d > -40 ? 200 : 100), (d) => (d > -40 ? 1 : 4));

// Minimal D1 shim over SQLite: prepare().bind().all()/.first().
const d1 = {
  prepare(sql) {
    const clean = sql.replace(/\s+/g, ' ').trim();
    let bound = [];
    const api = {
      bind(...args) { bound = args; return api; },
      all() { return { results: db.prepare(clean).all(...bound) }; },
      first() { return db.prepare(clean).get(...bound) || null; },
    };
    return api;
  },
};

// Patch the binding BEFORE server.js destructures it off the module.
const dbMod = require(path.join(__dirname, '..', 'db.js'));
dbMod.getNflDb = () => d1;
process.env.CF_WORKER = '1'; // don't bind a port

const { app } = require(path.join(__dirname, '..', 'server.js'));

// Listen on a real port and use fetch — a hand-rolled req/res stub is not
// faithful enough (the CORS middleware alone needs more of the ServerResponse
// surface than is worth reimplementing).
const PORT = 3199;
const server = app.listen(PORT);
const call = async (url) => {
  const r = await fetch(`http://127.0.0.1:${PORT}${url}`);
  return { status: r.status, body: await r.json() };
};

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

(async () => {
  for (const days of [7, 30, 90]) {
    const { body } = await call(`/api/market-index?days=${days}`);
    check(`market-index days=${days} returns a number`, body.available === true,
          body.available ? `score=${body.score} change=${body.changePct}% matched=${body.matchedCards} tier=${body.tier} bucket=${body.bucketDays}d` : `reason=${body.reason || body.error}`);
    if (body.available) {
      check(`  days=${days} bucket never exceeds the period`, body.bucketDays <= days,
            `bucket=${body.bucketDays}d days=${days}`);
      check(`  days=${days} rising market reads above 100`, body.score >= 100, `score=${body.score}`);
    }
  }

  // Wall-clock guard. These endpoints run inside a Worker CPU budget, and the
  // first version blew it by grouping raw sales in JavaScript. A generous
  // ceiling here still catches a return to per-sale work.
  for (const url of ['/api/market-index?days=90', '/api/debug/index-health']) {
    const t0 = Date.now();
    await call(url);
    const ms = Date.now() - t0;
    check(`${url} completes quickly`, ms < 2000, `${ms}ms`);
  }

  const health = await call('/api/debug/index-health');
  check('index-health runs without throwing', health.body.available === true,
        health.body.available ? `pricedSales=${health.body.dataset.pricedSales} repeatShare=${health.body.repeatSales180d.repeatShare} matched30d=${health.body.periods[30].matchedCards}` : `error=${health.body.error}`);

  // The properties that matter: neither of these may be moved by volume.
  const spike = await call('/api/player-index?player=Volume%20Spike&days=90');
  check('volume triples, prices flat -> stays ~100',
        spike.body.available && Math.abs(spike.body.score - 100) <= 2,
        spike.body.available ? `score=${spike.body.score}` : spike.body.reason);

  const dbl = await call('/api/player-index?player=Price%20Double&days=90');
  check('prices double, volume quarters -> reads ~200',
        dbl.body.available && dbl.body.score >= 180,
        dbl.body.available ? `score=${dbl.body.score}` : dbl.body.reason);

  // A period the dataset cannot cover must say so, and must not be confused
  // with cards failing to resell — only one of the two resolves on its own.
  const long = await call('/api/market-index?days=90');
  check('long period on short history names the right reason',
        long.body.available || long.body.reason === 'not enough history yet',
        long.body.available ? 'available (fixture covers it)' : `reason="${long.body.reason}"`);

  const player = await call('/api/player-index?player=Player%201&days=30');
  check('player-index runs without throwing', player.body.available !== undefined,
        player.body.available ? `score=${player.body.score}` : `reason=${player.body.reason}`);

  server.close();
  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('THREW:', e && e.stack || e); process.exit(1); });
