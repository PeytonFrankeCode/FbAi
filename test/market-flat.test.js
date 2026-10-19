// The market index against markets whose answer is known.
//
// A flat market — no card's true price ever moves, every sale carries noise —
// must read flat, and a market that rose 10% must read about +10%, for every
// basket the index can follow (MARKET_SERIES). Run through the real server and
// its real SQL over an in-memory SQLite table, one child process per basket,
// because MARKET_SERIES is read when server.js loads.
//
// Written when slabs-only read +22.5% on real sales against a median graded
// card's +0.9%, to settle whether the index drifts on thin slab data. It does
// not: both baskets read within a few points of flat here. What it found
// instead (600 players, three seeds, a true +9.9% over 90 days):
//
//   graded (raw + slabs)   +1.8 to +8.4    raw condition noise, clamped per
//                                          player per day, flattens real moves
//   slabs                  +7.8 to +9.4
//
// Moving the clamp from each player to the whole step fixed the raw basket's
// level but left it swinging from +2.4 to +19.9, so the clamp stays. Slabs are
// the basket that tracks the market, and the rise check holds them to it.
//
// (A first version of this simulation used a linear-congruential generator and
// "found" a +30% drift; consecutive LCG outputs are correlated, which tied each
// sale's noise to whether it happened. The generator below is mulberry32.)
'use strict';
const path = require('path');
const { spawnSync } = require('child_process');

if (process.argv[2] === '--child') {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE sales (item_id TEXT, sold_date TEXT, title TEXT, price_cents INTEGER, currency TEXT,
    listing_format TEXT, grader TEXT, grade TEXT, player TEXT, parallel TEXT, year TEXT, set_name TEXT,
    card_number TEXT, confidence REAL, best_offer INTEGER, bids INTEGER)`);
  let seed = Number(process.env.SEED || 20261019);
  const rnd = () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const DAY = 86400000;
  const iso = (off) => new Date(Date.now() + off * DAY).toISOString().slice(0, 10);
  const ins = db.prepare(`INSERT INTO sales (item_id, sold_date, price_cents, player, year, set_name, parallel,
    card_number, grader, grade, confidence) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  const rise = Number(process.env.RISE || 0);         // total move over the last 90 days
  // [grader, grade, mean days between sales, log-noise sd, price multiple]:
  // raw copies trade often and noisily, slabs less often with tight prices.
  const COPIES = [['', '', 2, 0.35, 1], ['PSA', '10', 6, 0.12, 4], ['PSA', '9', 8, 0.12, 1.6]];
  let n = 0;
  db.exec('BEGIN');
  // 600 players, as MARKET_TOP_PLAYERS: at 300 the noise floor alone is ±4.
  for (let p = 0; p < Number(process.env.PLAYERS || 600); p++) {
    for (let c = 0; c < 10; c++) {
      const base = 800 + 4000 * rnd();
      for (const [gr, g, gap, sd, mult] of COPIES) {
        for (let d = -130; d <= 0; d++) {
          if (rnd() > 1 / gap) continue;
          const trend = Math.pow(1 + rise, Math.max(0, Math.min(1, (d + 90) / 90)));
          ins.run(`i${n++}`, iso(d), Math.round(base * mult * trend * Math.exp(sd * gauss())),
            `Player ${p}`, '2023', 'Prizm', 'Base', String(c + 1), gr, g, 0.9);
        }
      }
    }
  }
  db.exec('COMMIT');
  const d1 = {
    prepare(sql) {
      let b = [];
      const api = {
        bind(...a) { b = a; return api; },
        all() { return { results: db.prepare(sql).all(...b) }; },
        first() { return db.prepare(sql).get(...b) || null; },
        run() { return { success: true, meta: db.prepare(sql).run(...b) }; },
      };
      return api;
    },
    batch(s) { return s.map(x => x.run()); },
  };
  require(path.join(__dirname, '..', 'db.js')).getNflDb = () => d1;
  process.env.CF_WORKER = '1';
  const { app } = require(path.join(__dirname, '..', 'server.js'));
  const server = app.listen(0);
  (async () => {
    const out = {};
    for (const days of [30, 90]) {
      const b = await (await fetch(`http://127.0.0.1:${server.address().port}/api/market-index?days=${days}`)).json();
      out[days] = b.available ? b.changePct : null;
    }
    process.stdout.write('@@' + JSON.stringify(out) + '\n');
    server.close();
    process.exit(0);
  })();
  return;
}

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};
const run = (series, rise) => {
  const r = spawnSync(process.execPath, [__filename, '--child'], {
    env: { ...process.env, MARKET_SERIES: series, RISE: String(rise) }, encoding: 'utf8', timeout: 240000 });
  const line = String(r.stdout || '').split('\n').find(l => l.startsWith('@@'));
  return line ? JSON.parse(line.slice(2)) : { error: (r.stderr || '').slice(-600) };
};

for (const series of ['graded', 'slabs']) {
  const flat = run(series, 0);
  check(`${series}: a flat market reads flat over 30 and 90 days`,
    flat[30] != null && flat[90] != null && Math.abs(flat[30]) <= 5 && Math.abs(flat[90]) <= 5,
    JSON.stringify(flat));
}
// The raw basket is not held to this: it reads a true +9.9% anywhere from +2
// to +8 depending on the noise, which is the finding, not a regression.
const up = run('slabs', 0.10);
check('slabs: a market up 10% over 90 days reads about +10%',
  up[90] != null && up[90] >= 5 && up[90] <= 15, JSON.stringify(up));
check('  ...and about +3% over the last 30 of them',
  up[30] != null && up[30] >= 0.5 && up[30] <= 6, JSON.stringify(up));

console.log(failures ? `\n${failures} check(s) failed` : '\nall market-flat checks passed');
process.exit(failures ? 1 : 0);
