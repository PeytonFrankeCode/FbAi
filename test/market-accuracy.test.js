// Does the index recover a price trend it is given?
//
// The unit-style checks in market-index.test.js prove the index ignores volume.
// They do not prove it reports the right MAGNITUDE, and they run on a fixture
// small enough to hide scale bugs. This file builds a market-shaped dataset —
// ~100k sales, a large majority of them cards that sell exactly once — where
// prices follow a known continuous trend, and asserts the index finds it.
//
// It exists because the whole-market view once returned "not enough repeat
// sales" on a dataset with 14,000 of them: the query capped its result by row
// count, and since a GROUP BY returns rows ordered by its grouping columns,
// the cap kept only the newest time bucket. Nothing could pair. A single-player
// fixture could never have caught it, because one player never hits the cap.
let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (err) {
  console.error('FAIL  node:sqlite unavailable on ' + process.version + ' — needs Node 22.5+.');
  process.exit(1);
}
const path = require('path');

const DAY = 86400000;
const iso = (o) => new Date(Date.now() + o * DAY).toISOString().slice(0, 10);

function buildDb(driftPct) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE sales (item_id TEXT, sold_date TEXT, title TEXT, price_cents INTEGER,
    currency TEXT, listing_format TEXT, grader TEXT, grade TEXT, player TEXT, parallel TEXT,
    year TEXT, set_name TEXT, confidence REAL, best_offer INTEGER, bids INTEGER, image_url TEXT)`);
  const priceAt = (d, base) => base * Math.pow(1 + driftPct / 100, (d + 35) / 30);
  db.exec('BEGIN');
  const ins = db.prepare(`INSERT INTO sales
    (item_id, sold_date, price_cents, player, year, set_name, parallel, grader, grade, confidence)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  let n = 0;
  // Cards that sell once and never again. These are the majority of a real
  // dataset and the rows that used to flood the query's row cap.
  for (let c = 0; c < 40000; c++) {
    ins.run(`s${n++}`, iso(-Math.floor(Math.random() * 35)), 5000, `Junk ${c}`,
            '2023', 'Prizm', 'Base', '', '', 0.9);
  }
  // Cards that resell, priced off the trend at whatever date they sold.
  for (let c = 0; c < 20000; c++) {
    const base = 5000 + (c % 50) * 200;
    const times = 2 + Math.floor(Math.random() * 3);
    for (let k = 0; k < times; k++) {
      const d = -Math.floor(Math.random() * 34) - 1;
      ins.run(`r${n++}`, iso(d), Math.round(priceAt(d, base)), `Real ${c}`,
              '2023', 'Prizm', 'Base', 'PSA', '10', 0.9);
    }
  }
  db.exec('COMMIT');
  return { db, sales: n };
}

let active = null;
const d1 = {
  prepare(sql) {
    const clean = sql.replace(/\s+/g, ' ').trim();
    let bound = [];
    const api = {
      bind(...a) { bound = a; return api; },
      all() { return { results: active.prepare(clean).all(...bound) }; },
      first() { return active.prepare(clean).get(...bound) || null; },
    };
    return api;
  },
};
require(path.join(__dirname, '..', 'db.js')).getNflDb = () => d1;
process.env.CF_WORKER = '1';
const { app } = require(path.join(__dirname, '..', 'server.js'));
const PORT = 3196;
const server = app.listen(PORT);

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

(async () => {
  for (const drift of [10, 0, -20]) {
    const built = buildDb(drift);
    active = built.db;
    // No KV binding in this harness, so cacheGet always misses and each
    // scenario really is recomputed against its own dataset.
    const r = await (await fetch(`http://127.0.0.1:${PORT}/api/market-index?days=30`)).json();
    const got = r.available ? r.changePct : null;
    const within = got !== null && Math.abs(got - drift) <= Math.max(3, Math.abs(drift) * 0.25);
    check(`market index recovers a ${drift > 0 ? '+' : ''}${drift}% trend`, within,
          r.available ? `reported ${got > 0 ? '+' : ''}${got}% on ${built.sales} sales, matched=${r.matchedCards}`
                      : `FAILED: ${r.reason}`);
    // The bug this file exists for: a market full of single-sale cards must
    // still pair up.
    check(`  ...and pairs sales despite 40k single-sale cards`,
          r.available && r.matchedCards >= 500,
          r.available ? `obs/bucket=${r.matchedCards} weakest=${r.minMatchedInAnyStep} gap=${r.typicalGapDays}d` : 'n/a');
  }
  // The specific fix for Card Ladder's time-attribution error. Two markets
  // drift by the same amount; in one, cards resell quickly, in the other they
  // resell slowly. Their raw price ratios differ a lot — a card reappearing
  // after 20 days has moved further than one reappearing after 4 — so an index
  // that applies the whole change on the day of resale would read them very
  // differently. Normalising each observation to a per-day rate should make
  // them agree.
  const readings = {};
  for (const [label, gapDays] of [['fast resales', 4], ['slow resales', 20]]) {
    const db2 = new DatabaseSync(':memory:');
    db2.exec(`CREATE TABLE sales (item_id TEXT, sold_date TEXT, title TEXT, price_cents INTEGER,
      currency TEXT, listing_format TEXT, grader TEXT, grade TEXT, player TEXT, parallel TEXT,
      year TEXT, set_name TEXT, confidence REAL, best_offer INTEGER, bids INTEGER, image_url TEXT)`);
    const priceAt = (d, base) => base * Math.pow(1.15, (d + 100) / 30);  // +15%/30d in both
    db2.exec('BEGIN');
    const ins2 = db2.prepare(`INSERT INTO sales
      (item_id, sold_date, price_cents, player, year, set_name, parallel, grader, grade, confidence)
      VALUES (?,?,?,?,?,?,?,?,?,?)`);
    let m = 0;
    for (let c = 0; c < 15000; c++) {
      const base = 5000 + (c % 40) * 300;
      // Sales spaced gapDays apart, so every pair is measured over that gap.
      // The span is the same for both so the only difference is the spacing —
      // it has to be long enough that the slow case still clears the history
      // guard, or the comparison tests nothing.
      // Stagger each card's schedule, or every card sells on the same dates and
      // whole buckets come back empty — which is a fixture artefact, not
      // something a real market does.
      for (let d = -95 + (c % gapDays); d <= -1; d += gapDays) {
        ins2.run(`g${m++}`, iso(d), Math.round(priceAt(d, base)), `Gap ${c}`,
                 '2023', 'Prizm', 'Base', 'PSA', '10', 0.9);
      }
    }
    db2.exec('COMMIT');
    active = db2;
    const r = await (await fetch(`http://127.0.0.1:${PORT}/api/market-index?days=30`)).json();
    readings[label] = r.available ? r.changePct : null;
    console.log(`      ${label} (${gapDays}d apart): index ${r.available ? (r.changePct > 0 ? '+' : '') + r.changePct + '%' : r.reason}, median gap seen ${r.typicalGapDays}d`);
  }
  const spread = Math.abs(readings['fast resales'] - readings['slow resales']);
  check('same drift reads the same whether cards resell fast or slowly', spread <= 3,
        `fast=${readings['fast resales']}%  slow=${readings['slow resales']}%  spread=${spread.toFixed(1)}pp`);

  server.close();
  console.log(failures ? `\n${failures} check(s) failed` : '\nall accuracy checks passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('THREW:', e && e.stack || e); process.exit(1); });
