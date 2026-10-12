// The whole-market index follows graded copies too (server.js MARKET_SERIES,
// Oct 2026), each grade its own card. What must hold:
//
//   - slabs add readings: the index rests on more sales than raw alone;
//   - a slab is never compared with the raw card: a PSA 10 at ten times the
//     raw price, sold on the days between raw sales, would otherwise read as
//     the card jumping 10x and back, and the index would be wrecked;
//   - MARKET_SERIES=base still gives the raw-only index.
//
// The base run is the same file in a child process, because MARKET_SERIES is
// read when server.js loads.
let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (err) {
  console.error('FAIL  node:sqlite unavailable on ' + process.version + ' — needs Node 22.5+.');
  process.exit(1);
}
const path = require('path');
const { spawnSync } = require('child_process');

const DAY = 86400000;
const iso = (off) => new Date(Date.now() + off * DAY).toISOString().slice(0, 10);

function build() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE sales (
    item_id TEXT, sold_date TEXT, title TEXT, price_cents INTEGER, currency TEXT,
    listing_format TEXT, grader TEXT, grade TEXT, player TEXT, parallel TEXT,
    year TEXT, set_name TEXT, card_number TEXT, confidence REAL, best_offer INTEGER, bids INTEGER)`);
  const ins = db.prepare(`INSERT INTO sales (item_id, sold_date, price_cents, player, year, set_name,
    parallel, card_number, grader, grade, confidence) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  let n = 0;
  // 300 players, one card each, rising 8% over the 200 days. The raw copy
  // sells every third day; its PSA 10, at ten times the price and rising the
  // same 8%, sells on the days in between.
  db.exec('BEGIN');
  for (let c = 0; c < 300; c++) {
    for (let d = -200; d <= 0; d++) {
      const drift = 1 + 0.08 * (d + 200) / 200;
      if ((c + d) % 3 === 0) ins.run(`r${n++}`, iso(d), Math.round(10000 * drift), `Player ${c}`, '2020', 'Prizm', 'Base', '1', '', '', 0.9);
      else if ((c + d) % 3 === 1) ins.run(`g${n++}`, iso(d), Math.round(100000 * drift), `Player ${c}`, '2020', 'Prizm', 'Base', '1', 'PSA', '10', 0.9);
    }
  }
  db.exec('COMMIT');
  return db;
}

async function measure() {
  const db = build();
  const d1 = {
    prepare(sql) {
      let bound = [];
      const api = {
        bind(...a) { bound = a; return api; },
        all() { return { results: db.prepare(sql).all(...bound) }; },
        run() { return { success: true, meta: db.prepare(sql).run(...bound) }; },
        first() { return db.prepare(sql).get(...bound) || null; },
      };
      return api;
    },
    batch(stmts) { return stmts.map(st => st.run()); },
  };
  require(path.join(__dirname, '..', 'db.js')).getNflDb = () => d1;
  process.env.CF_WORKER = '1';
  const { app } = require(path.join(__dirname, '..', 'server.js'));
  const server = app.listen(0);
  const port = server.address().port;
  const idx = await (await fetch(`http://127.0.0.1:${port}/api/market-index?days=90`)).json();
  const basket = await (await fetch(`http://127.0.0.1:${port}/api/market-basket?days=90`)).json();
  server.close();
  return { available: idx.available, reason: idx.reason, changePct: idx.changePct, obs: idx.totalObservations,
           graded: ((basket && basket.cards) || []).filter(c => /PSA 10/.test(c.detail || "")).length,
           cards: ((basket && basket.cards) || []).length };
}

if (process.argv[2] === '--child') {
  measure().then(r => { process.stdout.write('@@' + JSON.stringify(r) + '\n'); process.exit(0); })
    .catch(e => { console.error(e); process.exit(1); });
} else {
  let failures = 0;
  const check = (label, ok, detail) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
    if (!ok) failures++;
  };
  const run = (series) => {
    const env = { ...process.env };
    if (series == null) delete env.MARKET_SERIES; else env.MARKET_SERIES = series;
    const p = spawnSync(process.execPath, [__filename, '--child'], { env, encoding: 'utf8', timeout: 240000 });
    const line = (p.stdout || '').split('\n').find(l => l.startsWith('@@'));
    if (!line) { console.error(p.stderr); return null; }
    return JSON.parse(line.slice(2));
  };
  const graded = run(null);
  const base = run('base');
  check('by default the index follows graded copies as well as raw',
    graded && graded.available && base && base.available && graded.obs > base.obs * 1.5,
    graded && base ? `sales used: graded ${graded.obs} vs raw-only ${base.obs}` : 'a run failed');
  check('  ...a slab never compared with its raw card: a market rising 8% reads as rising 8%',
    graded && graded.available && Math.abs(graded.changePct - (base && base.changePct)) <= 1.5 && graded.changePct > 0 && graded.changePct < 8,
    graded && base ? `graded ${graded.changePct}% vs raw-only ${base.changePct}% over the last 90 of 200 days` : '');
  check('  ...and the basket names the graded copies it follows',
    graded && graded.graded > 0 && base && base.graded === 0,
    graded && base ? `PSA 10 rows: ${graded.graded}/${graded.cards} (raw-only: ${base.graded})` : '');
  console.log(failures ? `\n${failures} check(s) failed` : '\nall market-graded checks passed');
  process.exit(failures ? 1 : 0);
}
