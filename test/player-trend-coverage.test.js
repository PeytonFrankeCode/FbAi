// A single player's chart reads enough of their sales to chart them.
//
// Bo Nix, with ~8,000 sales, read "not enough sales": the player chart took
// the market basket's ten raw base cards, and a newer player's sales are
// mostly slabs of a handful of rookies — three qualifying card-days a week
// against the eight a window needs. It now follows up to 40 base cards and
// their graded copies (each grade its own card). And a period older than the
// data says so, rather than blaming the player.
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const DAY = 86400000;
const iso = (o) => new Date(Date.now() + o * DAY).toISOString().slice(0, 10);
const db = new DatabaseSync(':memory:');
db.exec(`CREATE TABLE sales (item_id TEXT, sold_date TEXT, title TEXT, price_cents INTEGER, currency TEXT,
  listing_format TEXT, grader TEXT, grade TEXT, player TEXT, parallel TEXT, year TEXT, set_name TEXT,
  card_number TEXT, confidence REAL, best_offer INTEGER, bids INTEGER, image_url TEXT)`);
const ins = db.prepare(`INSERT INTO sales (item_id, sold_date, title, price_cents, grader, grade, player, parallel,
  year, set_name, card_number, confidence, best_offer) VALUES (?,?,?,?,?,?,?,'',?,?,?,0.9,0)`);
let n = 0;
// Twelve cards, 45 days. Every one sells as a PSA 10 most days; raw copies
// almost never. Before, none of this counted.
for (let c = 0; c < 12; c++) {
  for (let d = -45; d <= -1; d++) {
    if ((d + c) % 3 === 0) continue;                 // not every day
    ins.run(`g${n++}`, iso(d), `2024 Panini Prizm Bo Nix #${601 + c} RC PSA 10`, 4000 + c * 100,
            'PSA', '10', 'Bo Nix', '2024', 'Prizm', String(601 + c));
  }
  ins.run(`r${n++}`, iso(-20), `2024 Panini Prizm Bo Nix #${601 + c} RC`, 900, null, null, 'Bo Nix', '2024', 'Prizm', String(601 + c));
}

const d1 = { prepare(sql) {
  const st = db.prepare(sql);
  const api = { _b: [], bind(...a) { api._b = a; return api; },
    async all() { return { results: st.all(...api._b) }; }, async first() { return st.get(...api._b) || null; } };
  return api;
} };
require(path.join(__dirname, '..', 'db.js')).getNflDb = () => d1;
process.env.CF_WORKER = '1';
const { app } = require(path.join(__dirname, '..', 'server.js'));
const PORT = 3245;
const server = app.listen(PORT);
const call = async (url) => (await fetch(`http://127.0.0.1:${PORT}${url}`)).json();

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

(async () => {
  const r30 = await call('/api/player-index?player=Bo%20Nix&days=30');
  check('a player whose sales are mostly slabs charts over 30 days', r30.available === true,
    JSON.stringify({ available: r30.available, reason: r30.reason, firstWindow: r30.firstWindow, lastWindow: r30.lastWindow }));
  check('  ...following more than the basket\'s ten cards', (r30.matchedCards || 0) > 10, `matchedCards=${r30.matchedCards}`);
  check('  ...and reading a flat market as flat', Math.abs(r30.changePct || 0) < 3, `changePct=${r30.changePct}`);
  const r90 = await call('/api/player-index?player=Bo%20Nix&days=90');
  check('a period older than the data says so, not "not enough sales"', r90.available === false && r90.reason === 'not enough history yet',
    JSON.stringify({ available: r90.available, reason: r90.reason }));
  server.close();
  console.log(failures ? `\n${failures} check(s) failed` : '\nall player-trend-coverage checks passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); server.close(); process.exit(1); });
