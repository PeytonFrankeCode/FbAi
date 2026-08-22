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
  // A real card market has a concentrated head and a very long tail, and the
  // index is built to track the head. So: 200 traded players with a dozen cards
  // each, and 20,000 names that sold once and never again. The basket should
  // find the head and ignore the tail entirely.
  for (let p = 0; p < 200; p++) {
    for (let c = 0; c < 12; c++) {
      const base = 2000 + (c === 0 ? 20000 : 0) + c * 400;   // card 0 is the key rookie
      const times = c < 10 ? 14 : 4;
      for (let k = 0; k < times; k++) {
        const d = -Math.floor(Math.random() * 34) - 1;
        ins.run(`h${n++}`, iso(d), Math.round(priceAt(d, base)), `Star ${p}`,
                '2023', 'Prizm', `Var${c}`, 'PSA', '10', 0.9);
      }
    }
  }
  for (let c = 0; c < 20000; c++) {
    ins.run(`s${n++}`, iso(-Math.floor(Math.random() * 35)), 5000, `Junk ${c}`,
            '2023', 'Prizm', 'Base', '', '', 0.9);
  }
  db.exec('COMMIT');
  return { db, sales: n };
}

let active = null;
const d1 = {
  prepare(sql) {
    // Deliberately NOT collapsing whitespace. An earlier version did, for
    // readability, and it rewrote the two-space literal inside
    // REPLACE(col, '  ', ' ') into a single space — silently disabling the
    // key normalisation this suite is meant to verify. D1 does not rewrite
    // SQL, so neither may the stub.
    const clean = sql;
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
    // The itemised basket is what makes the number auditable, so it has to
    // arrive populated, labelled, and consistent with the index. It is its own
    // endpoint — see the comment on /api/market-basket for why.
    const bres = await call(`/api/market-basket?days=30`);
    const basket = bres.body && bres.body.available && Array.isArray(bres.body.cards) ? bres.body.cards : [];
    check(`  ...and itemises the cards behind it`,
          basket.length >= 10 && basket.every(c => c.label && c.label !== 'Unknown card' && c.sales > 0),
          basket.length ? `${basket.length} cards, top: "${basket[0].label}" ${basket[0].sales} sold ${basket[0].changePct}%` : 'empty');
    // Card moves should point the same way as the index, not contradict it.
    if (basket.length && drift !== 0) {
      const withMove = basket.filter(c => c.changePct != null);
      const agreeing = withMove.filter(c => (c.changePct > 0) === (drift > 0)).length;
      check(`  ...and those cards agree with the index direction`,
            withMove.length > 0 && agreeing / withMove.length >= 0.8,
            `${agreeing}/${withMove.length} moved the same way as the ${drift > 0 ? 'rising' : 'falling'} index`);
    }

    // The basket must find the head and ignore the 20,000 one-sale names.
    check(`  ...and builds its basket from the traded head, not the tail`,
          r.available && r.matchedCards >= 30,
          r.available ? `players/bucket=${r.matchedCards} weakest=${r.minMatchedInAnyStep} gap=${r.typicalGapDays}d obs=${r.totalObservations}` : 'n/a');
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

  // Name fragmentation. The live player column holds ~15x more distinct values
  // than there are footballers, because it is parsed from listing titles. Each
  // variant splits one card into several that can never pair, so the index
  // groups on a normalised key. This writes the same 4,000 cards under six
  // spellings each and checks they come back together.
  {
    const dbF = new DatabaseSync(':memory:');
    dbF.exec(`CREATE TABLE sales (item_id TEXT, sold_date TEXT, title TEXT, price_cents INTEGER,
      currency TEXT, listing_format TEXT, grader TEXT, grade TEXT, player TEXT, parallel TEXT,
      year TEXT, set_name TEXT, confidence REAL, best_offer INTEGER, bids INTEGER, image_url TEXT)`);
    const spellings = (n) => [n, n.toLowerCase(), n.toUpperCase(), ' ' + n + ' ', n + '.', n.replace(/ /g, '  ')];
    dbF.exec('BEGIN');
    const insF = dbF.prepare(`INSERT INTO sales
      (item_id, sold_date, price_cents, player, year, set_name, parallel, grader, grade, confidence)
      VALUES (?,?,?,?,?,?,?,?,?,?)`);
    let f = 0;
    for (let c = 0; c < 4000; c++) {
      const name = `Player ${c}`;
      for (let k = 0; k < 6; k++) {
        insF.run(`f${f++}`, iso(-Math.floor(Math.random() * 60) - 1), 10000 + c,
                 spellings(name)[Math.floor(Math.random() * 6)],
                 '2023', 'Prizm', 'Base', 'PSA', '10', 0.9);
      }
    }
    dbF.exec('COMMIT');
    active = dbF;
    const q = await (await fetch(`http://127.0.0.1:${PORT}/api/debug/player-quality`)).json();
    const norm = q.normalisation;
    check('spelling variants collapse to one card each',
          !!norm && norm.players.normalised === 4000,
          norm ? `${norm.players.raw} raw -> ${norm.players.normalised} normalised (merged ${norm.players.merged})`
               : 'no normalisation block returned');
    const idx = await (await fetch(`http://127.0.0.1:${PORT}/api/market-index?days=30`)).json();
    check('  ...and the index pairs them', idx.available && idx.matchedCards > 0,
          idx.available ? `obs/bucket=${idx.matchedCards} total=${idx.totalObservations}` : idx.reason);
  }

  server.close();
  console.log(failures ? `\n${failures} check(s) failed` : '\nall accuracy checks passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('THREW:', e && e.stack || e); process.exit(1); });
