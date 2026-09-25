// A card whose only sales are accepted best offers shows them — labelled —
// rather than "no sales" beside the very sale that was clicked. Offers still
// stay out of a card that has other sales.
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const db = new DatabaseSync(':memory:');
db.exec(`CREATE TABLE sales (item_id TEXT, sold_date TEXT, title TEXT, price_cents INTEGER, currency TEXT,
  listing_format TEXT, grader TEXT, grade TEXT, player TEXT, parallel TEXT, year TEXT, set_name TEXT,
  card_number TEXT, confidence REAL, best_offer INTEGER, bids INTEGER, image_url TEXT)`);
const iso = (off) => new Date(Date.now() + off * 86400000).toISOString().slice(0, 10);
const ins = db.prepare(`INSERT INTO sales (item_id, sold_date, title, price_cents, player, year, set_name,
  parallel, card_number, grader, grade, confidence, best_offer) VALUES (?,?,?,?,?,?,?,?,?,?,?,0.9,?)`);
const sale = (id, title, price, day, { parallel = '', grader = '', grade = '', offer = 0, number = '329' } = {}) =>
  ins.run(id, iso(day), title, Math.round(price * 100), 'Troy Franklin', '2024', 'Prizm', parallel, number, grader, grade, offer);

// The screenshot: a Green Sparkle 1/1 whose one sale was a best offer.
sale('gs', '2024 Panini Prizm Troy Franklin Green Sparkle Rookie RC 1/1 PSA 9 Broncos', 124.99, -40,
     { parallel: 'Green Sparkle', grader: 'PSA', grade: '9', offer: 1 });
// His base card: three sales, one of them an offer well under the others.
sale('b1', '2024 Panini Prizm Troy Franklin #329 RC Broncos', 4, -30);
sale('b2', '2024 Panini Prizm Troy Franklin #329 RC Broncos', 5, -20);
sale('b3', '2024 Panini Prizm Troy Franklin #329 RC Broncos', 1, -10, { offer: 1 });

const d1 = { prepare(sql) {
  const st = db.prepare(sql);
  return { bind(...a) { return { all: async () => ({ results: st.all(...a) }), first: async () => st.get(...a) || null }; },
           all: async () => ({ results: st.all() }), first: async () => st.get() || null };
} };
require(path.join(__dirname, '..', 'db.js')).getNflDb = () => d1;
process.env.CF_WORKER = '1';
const { app } = require(path.join(__dirname, '..', 'server.js'));
const PORT = 3241;
const server = app.listen(PORT);
const call = async (url) => (await fetch(`http://127.0.0.1:${PORT}${url}`)).json();

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

(async () => {
  const gs = await call('/api/card-analysis?itemId=gs');
  check('a card sold only by best offer shows its sale, not "no sales"',
    gs.available === true && gs.totalSales === 1, JSON.stringify({ available: gs.available, reason: gs.reason, totalSales: gs.totalSales }));
  check('  ...labelled as offers only', gs.identity && gs.identity.offersOnly === true);
  const base = await call('/api/card-analysis?itemId=b1');
  check('a card with other sales still leaves its offer out', base.available && base.totalSales === 2
    && base.identity.offersOnly === false, `totalSales=${base.totalSales}`);
  server.close();
  console.log(failures ? `\n${failures} check(s) failed` : '\nall card-offers checks passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); server.close(); process.exit(1); });
