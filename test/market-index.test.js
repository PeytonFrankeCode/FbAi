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

// 60 cards, each selling every 3rd day for 120 days, drifting +8% overall.
const DAY = 86400000;
const iso = (off) => new Date(Date.now() + off * DAY).toISOString().slice(0, 10);
const ins = db.prepare(
  `INSERT INTO sales (item_id, sold_date, price_cents, player, year, set_name, parallel, grader, grade, confidence)
   VALUES (?,?,?,?,?,?,?,?,?,?)`);
let n = 0;
for (let c = 0; c < 60; c++) {
  for (let d = -120; d <= 0; d++) {
    if ((c + d) % 3) continue;
    const drift = 1 + 0.08 * (d + 120) / 120;
    ins.run(`i${n++}`, iso(d), Math.round(10000 * drift), `Player ${c}`, '2020',
            'Prizm', 'Base', 'PSA', '10', 0.9);
  }
}

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
          body.available ? `score=${body.score} change=${body.changePct}% matched=${body.matchedCards} tier=${body.tier} window=${body.valueWindow}` : `reason=${body.reason || body.error}`);
    if (body.available) {
      check(`  days=${days} value window never exceeds the period`, body.valueWindow <= days,
            `window=${body.valueWindow} days=${days}`);
      check(`  days=${days} rising market reads above 100`, body.score >= 100, `score=${body.score}`);
    }
  }

  const health = await call('/api/debug/index-health');
  check('index-health runs without throwing', health.body.available === true,
        health.body.available ? `pricedSales=${health.body.dataset.pricedSales} distinctCards=${health.body.periods[30].distinctCards}` : `error=${health.body.error}`);

  const player = await call('/api/player-index?player=Player%201&days=30');
  check('player-index runs without throwing', player.body.available !== undefined,
        player.body.available ? `score=${player.body.score}` : `reason=${player.body.reason}`);

  server.close();
  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('THREW:', e && e.stack || e); process.exit(1); });
