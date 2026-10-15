// The boards' windows end at the newest sale held, not at today (Oct 2026).
// Sales arrive a few days behind; the 7-day movers board counted back from
// today and so compared a start with no end: 0 cards considered, no risers
// and no fallers, in the board, the weekly report and the email.
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

const db = new DatabaseSync(':memory:');
db.exec(`CREATE TABLE sales (item_id TEXT, sold_date TEXT, title TEXT, price_cents INTEGER, currency TEXT,
  listing_format TEXT, grader TEXT, grade TEXT, player TEXT, parallel TEXT, year TEXT, set_name TEXT,
  card_number TEXT, confidence REAL, best_offer INTEGER, bids INTEGER, image_url TEXT)`);
const DAY = 86400000;
const iso = (o) => new Date(Date.now() + o * DAY).toISOString().slice(0, 10);
const ins = db.prepare(`INSERT INTO sales (item_id, sold_date, title, price_cents, player, year, set_name, parallel,
  card_number, grader, grade, confidence, best_offer) VALUES (?,?,?,?,?,'2023','Prizm','',?,'','',0.9,0)`);
let n = 0;
// The newest sale is FIVE days old: everything in "the last 5 days" is empty.
const LAG = 5;
for (const [player, perDay] of [['Steady Climber', 0.03], ['Slow Fader', -0.02]]) {
  for (let c = 1; c <= 3; c++) {
    for (let d = -30; d <= -LAG; d++) {
      for (let k = 0; k < 2; k++) ins.run(`s${n++}`, iso(d), `2023 Prizm ${player} #${c}`, Math.round(4000 * Math.pow(1 + perDay, d + 30)), player, String(c));
    }
  }
}
db.exec(`CREATE TABLE daily (sold_date TEXT, sales INTEGER, priced INTEGER, total_cents INTEGER)`);
db.exec(`INSERT INTO daily SELECT sold_date, COUNT(*), COUNT(price_cents), SUM(price_cents) FROM sales GROUP BY sold_date`);
const d1 = { prepare(sql) {
  let b = [];
  const api = { bind(...a) { b = a; return api; },
    async all() { return { results: db.prepare(sql).all(...b) }; },
    async first() { return db.prepare(sql).get(...b) || null; },
    async run() { return { success: true }; } };
  return api;
} };
const store = new Map();
const dbMod = require(path.join(__dirname, '..', 'db.js'));
dbMod.getNflDb = () => d1;
dbMod.cacheGet = async (k) => (store.has(k) ? JSON.parse(store.get(k)) : null);
dbMod.cachePut = async (k, v) => { store.set(k, JSON.stringify(v)); };
process.env.CF_WORKER = '1';
const { app } = require(path.join(__dirname, '..', 'server.js'));
const server = app.listen(0);
const port = server.address().port;

(async () => {
  const r = await (await fetch(`http://127.0.0.1:${port}/api/sold-stats?days=7`)).json();
  const movers = (r.cardMovers || []);
  check(`with sales ${LAG} days behind, the 7-day board still finds its movers`,
    r.available && movers.length >= 4, `${movers.length} movers, ${r.moversBasis && r.moversBasis.cardsConsidered} considered`);
  check('  ...climbers up, faders down',
    movers.filter(m => /Climber/.test(m.name)).every(m => m.changePct > 0) && movers.filter(m => /Fader/.test(m.name)).every(m => m.changePct < 0));
  check('  ...its window ending at the newest sale, not today',
    r.moversBasis && r.moversBasis.endFrom <= iso(-LAG) && r.moversBasis.endFrom >= iso(-LAG - 3), r.moversBasis && r.moversBasis.endFrom);
  server.close();
  console.log(failures ? `\n${failures} check(s) failed` : '\nall sold-stats-lag checks passed');
  process.exit(failures ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
