// A sale whose title never says the card number still opens the card's whole
// history (Oct 2026). "Sharp 1986 Topps 49ers Jerry Rice Rookie Card RC GOAT"
// is stored with no number; its page grouped it with the other number-less
// sales and showed "1 sale" for a card with 467, under a version box that
// said 31.
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
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
const ins = db.prepare(`INSERT INTO sales (item_id, sold_date, title, price_cents, player, year, set_name, parallel, card_number, confidence)
  VALUES (?,?,?,?,?,?,?,'',?,0.9)`);
let n = 500000000;
const add = (title, cents, d, player, year, set, num) => { const id = String(n++); ins.run(id, iso(d), title, cents, player, year, set, num); return id; };

for (let i = 0; i < 12; i++) add(`1986 Topps Jerry Rice #161 RC 49ers`, 5000 + i * 100, -i - 1, 'Jerry Rice', '1986', 'Topps', '161');
const sharp = add('Sharp 1986 Topps San Francisco 49ers Jerry Rice Rookie Card RC GOAT', 4800, -2, 'Jerry Rice', '1986', 'Topps', '');
// Two cards of one player in one set, sold evenly: no number is "the" card.
for (let i = 0; i < 6; i++) add(`1990 Score Barry Sanders #${i % 2 ? '255' : '336'}`, 900, -i - 1, 'Barry Sanders', '1990', 'Score', i % 2 ? '255' : '336');
const sanders = add('1990 Score Barry Sanders Rookie Detroit Lions', 900, -3, 'Barry Sanders', '1990', 'Score', '');

const d1 = { prepare(sql) {
  let b = [];
  const api = { bind(...a) { b = a; return api; },
    async all() { return { results: db.prepare(sql).all(...b) }; },
    async first() { return db.prepare(sql).get(...b) || null; },
    async run() { return { success: true }; } };
  return api;
} };
const dbMod = require(path.join(__dirname, '..', 'db.js'));
dbMod.getNflDb = () => d1;
const store = new Map();
dbMod.cacheGet = async (k) => (store.has(k) ? JSON.parse(store.get(k)) : null);
dbMod.cachePut = async (k, v) => { store.set(k, JSON.stringify(v)); };
process.env.CF_WORKER = '1';
const S = require(path.join(__dirname, '..', 'server.js'));
const server = S.app.listen(0);
const port = server.address().port;
const open = async (id) => (await fetch(`http://127.0.0.1:${port}/api/card-analysis?itemId=${id}`)).json();

(async () => {
  const r = await open(sharp);
  check('a sale whose title has no number opens its card\'s whole history',
    r.available && r.totalSales === 13 && r.card && r.card.cardNumber === '161', `${r.totalSales} sales, #${r.card && r.card.cardNumber}`);

  const s2 = await open(sanders);
  check('  ...but not when the player has two cards in the set: no guessing between them',
    s2.available && s2.totalSales === 1, `${s2.totalSales} sales`);

  check('a number in the title is a number; a year, grade or bare figure is not',
    S._titleNamesANumber('1986 Topps Jerry Rice #161') && S._titleNamesANumber('Prizm No. 15 Allen')
    && !S._titleNamesANumber('Sharp 1986 Topps Jerry Rice Rookie Card') && !S._titleNamesANumber('1986 Topps Jerry Rice PSA 8'));

  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  check('the version box\'s history button opens a sale whose title says the number',
    /\.sort\(\(a, b\) => \(saysNum\(b\) - saysNum\(a\)\) \|\| \(raw\.length \? isRaw\(b\) - isRaw\(a\) : 0\)/.test(app));

  server.close();
  console.log(failures ? `\n${failures} check(s) failed` : '\nall card-number-infer checks passed');
  process.exit(failures ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
