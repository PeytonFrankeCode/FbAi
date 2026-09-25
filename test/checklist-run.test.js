// The checklist's print run for a parallel outranks what a title claims. A
// Green Sparkle is /8 in 2024 Prizm whatever the seller writes: "1/1" is a
// flourish, and a title with no run at all is still one of the eight.
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const db = new DatabaseSync(':memory:');
db.exec(`CREATE TABLE sales (item_id TEXT, sold_date TEXT, title TEXT, price_cents INTEGER, currency TEXT,
  listing_format TEXT, grader TEXT, grade TEXT, player TEXT, parallel TEXT, year TEXT, set_name TEXT,
  card_number TEXT, confidence REAL, best_offer INTEGER, bids INTEGER, image_url TEXT)`);
const iso = (off) => new Date(Date.now() + off * 86400000).toISOString().slice(0, 10);
const ins = db.prepare(`INSERT INTO sales (item_id, sold_date, title, price_cents, player, year, set_name,
  parallel, card_number, grader, grade, confidence, best_offer) VALUES (?,?,?,?,?,?,?,?,?,'','',0.9,0)`);
const sale = (id, title, price, day, parallel, number = '393') =>
  ins.run(id, iso(day), title, price * 100, 'Troy Franklin', '2024', 'Prizm', parallel, number);

sale('g1', '2024 Panini Prizm Troy Franklin #393 Green Sparkle Rookie RC 1/1 Broncos', 300, -30, 'Green Sparkle');
sale('g2', '2024 Panini Prizm Troy Franklin #393 Green Sparkle Rookie RC 5/8 Broncos', 250, -20, 'Green Sparkle');
sale('g3', '2024 Panini Prizm Troy Franklin #393 Green Sparkle Rookie RC Broncos', 280, -10, 'Green Sparkle');
// A title stating a different real run is believed: a /5 is another card.
sale('g4', '2024 Panini Prizm Troy Franklin #393 Green Sparkle Rookie RC /5 Broncos', 900, -5, 'Green Sparkle');
// A Gold Sparkle (/24) sold as "1/1" is a /24 — and stays apart from the /8.
sale('d1', '2024 Panini Prizm Troy Franklin #393 Gold Sparkle Rookie RC 1/1 Broncos', 90, -15, 'Gold Sparkle');

const d1 = { prepare(sql) {
  const st = db.prepare(sql);
  return { bind(...a) { return { all: async () => ({ results: st.all(...a) }), first: async () => st.get(...a) || null }; },
           all: async () => ({ results: st.all() }), first: async () => st.get() || null };
} };
require(path.join(__dirname, '..', 'db.js')).getNflDb = () => d1;
process.env.CF_WORKER = '1';
const { app } = require(path.join(__dirname, '..', 'server.js'));
const PORT = 3243;
const server = app.listen(PORT);
const call = async (url) => (await fetch(`http://127.0.0.1:${PORT}${url}`)).json();

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

(async () => {
  const g = await call('/api/card-analysis?itemId=g1');
  check('a Green Sparkle sold as "1/1" is read as the checklist\'s /8', g.identity && g.identity.printRun === 8,
    JSON.stringify(g.identity && { printRun: g.identity.printRun, otherPrintRuns: g.identity.otherPrintRuns }));
  check('  ...and grouped with its stamped and unstamped /8 sales', g.totalSales === 3, `totalSales=${g.totalSales}`);
  check('  ...but not with a sale stating a different run', g.identity && g.identity.otherPrintRuns === 1);
  const u = await call('/api/card-analysis?itemId=g3');
  check('opened from the sale that states no run, it is the same /8 card', u.totalSales === 3 && u.identity.printRun === 8,
    `totalSales=${u.totalSales} printRun=${u.identity && u.identity.printRun}`);
  const d = await call('/api/card-analysis?itemId=d1');
  check('a Gold Sparkle "1/1" is the checklist\'s /24', d.identity && d.identity.printRun === 24 && d.totalSales === 1,
    JSON.stringify(d.identity && d.identity.printRun));
  server.close();
  console.log(failures ? `\n${failures} check(s) failed` : '\nall checklist-run checks passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); server.close(); process.exit(1); });
