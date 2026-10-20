// A player's market is slabs, and two slab sales are enough (owner, Oct 2026).
// Run through the real route and SQL over an in-memory SQLite table, with no
// PLAYER_MARKET_SERIES set: the live behaviour.
'use strict';
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

let failures = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`); if (!ok) failures++; };
delete process.env.PLAYER_MARKET_SERIES;

const db = new DatabaseSync(':memory:');
db.exec(`CREATE TABLE sales (item_id TEXT, sold_date TEXT, title TEXT, price_cents INTEGER, currency TEXT,
  listing_format TEXT, grader TEXT, grade TEXT, player TEXT, parallel TEXT, year TEXT, set_name TEXT,
  card_number TEXT, confidence REAL, best_offer INTEGER, bids INTEGER)`);
const DAY = 86400000;
const iso = (d) => new Date(Date.now() + d * DAY).toISOString().slice(0, 10);
const ins = db.prepare(`INSERT INTO sales (item_id, sold_date, title, price_cents, grader, grade, player, parallel, year, set_name, card_number, confidence)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,0.9)`);
let n = 0;
// Bo Nix's Prizm rookie. Raw copies quadruple over the month (a condition
// story, not a price one); his PSA 10s sell twice early and twice late at a
// steady $200 -> $220.
for (let d = -32; d <= -3; d++) ins.run(`r${n++}`, iso(d), '2024 Panini Prizm Bo Nix #309 RC', 2000 + (d + 32) * 250, '', '', 'Bo Nix', '', '2024', 'Panini Prizm', '309');
for (const [d, c] of [[-31, 20000], [-30, 20000], [-5, 22000], [-4, 22000]]) {
  ins.run(`g${n++}`, iso(d), '2024 Panini Prizm Bo Nix #309 RC PSA 10', c, 'PSA', '10', 'Bo Nix', '', '2024', 'Panini Prizm', '309');
}
// Jayden Daniels: raw sales only.
for (let d = -32; d <= -3; d++) ins.run(`j${n++}`, iso(d), '2024 Panini Prizm Jayden Daniels #347 RC', 3000, '', '', 'Jayden Daniels', '', '2024', 'Panini Prizm', '347');

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
const dbMod = require(path.join(__dirname, '..', 'db.js'));
dbMod.getNflDb = () => d1;
process.env.CF_WORKER = '1';
const { app } = require(path.join(__dirname, '..', 'server.js'));
const server = app.listen(0);
const get = async (q) => (await fetch(`http://127.0.0.1:${server.address().port}/api/player-index?${q}`)).json();

(async () => {
  const nix = await get('player=Bo%20Nix&days=30');
  check('a player\'s trend reads his slabs, two sales at each end being enough',
    nix.available === true && Math.abs(nix.changePct - 10) <= 3, JSON.stringify({ available: nix.available, changePct: nix.changePct, reason: nix.reason }));
  check('  ...and his raw copies, up 300%, are not in it', nix.available && nix.changePct < 50);
  const jd = await get('player=Jayden%20Daniels&days=30');
  check('a player with raw sales only gets no slab reading', jd.available === false, JSON.stringify({ available: jd.available, reason: jd.reason }));
  server.close();
  console.log(failures ? `\n${failures} check(s) failed` : '\nall player-slabs checks passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
