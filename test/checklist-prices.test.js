// A price on every parallel of every card a player has in a product — what
// Rainbow Mode shows on its tiles — sold or not.
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const db = new DatabaseSync(':memory:');
db.exec(`CREATE TABLE sales (item_id TEXT, sold_date TEXT, title TEXT, price_cents INTEGER, currency TEXT,
  listing_format TEXT, grader TEXT, grade TEXT, player TEXT, parallel TEXT, year TEXT, set_name TEXT,
  card_number TEXT, confidence REAL, best_offer INTEGER, bids INTEGER, image_url TEXT)`);
const ins = db.prepare(`INSERT INTO sales (item_id, sold_date, title, price_cents, grader, grade, player, parallel,
  year, set_name, card_number, confidence, best_offer) VALUES (?,?,?,?,?,?,?,?,?,?,?,0.9,0)`);
let n = 0;
const sale = (title, cents, { parallel = '', num, grader = null, grade = null, player = 'Patrick Mahomes' } = {}) =>
  ins.run(`i${n++}`, `2026-09-${String(10 + (n % 15)).padStart(2, '0')}`, title, cents, grader, grade, player,
          parallel, '2017', 'Prizm', num);
for (let i = 0; i < 3; i++) sale('2017 Panini Prizm Patrick Mahomes II #269 RC', 30000, { num: '269' });
for (let i = 0; i < 3; i++) sale('2017 Panini Prizm Patrick Mahomes II #269 Silver Prizm RC', 90000, { num: '269', parallel: 'Silver Prizm' });
sale('2017 Panini Prizm Patrick Mahomes II #269 RC PSA 10', 150000, { num: '269', grader: 'PSA', grade: '10' });
for (let i = 0; i < 2; i++) sale('2017 Panini Prizm Instant Impact Patrick Mahomes II #8', 6000, { num: '8' });
// A chase pack is not the card on its photo.
sale('2017 Prizm Mahomes CHASE PACK #269 Gold?', 500000, { num: '269' });

const d1 = { prepare(sql) {
  let b = [];
  const api = { bind(...a) { b = a; return api; },
    async all() { return { results: db.prepare(sql).all(...b) }; },
    async first() { return db.prepare(sql).get(...b) || null; } };
  return api;
} };
require(path.join(__dirname, '..', 'db.js')).getNflDb = () => d1;
process.env.CF_WORKER = '1';
const S = require(path.join(__dirname, '..', 'server.js'));

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

(async () => {
  const PID = '2017-panini-prizm-football';
  S._primeParallelLadder({ builtAt: 'test', products: {
    [PID]: { ref: '', rungs: { '': { f: 1, n: 60, lo: 0.9, hi: 1.1 }, silver: { f: 3, n: 40, lo: 0.9, hi: 1.1 },
                               gold: { f: 40, n: 9, lo: 0.7, hi: 1.4 } },
             levels: { q25: 5, q50: 12, cards: 200 } },
  }, curves: {} });

  const r = await S._checklistPrices(PID, 'Patrick Mahomes II');
  check('the player\'s cards are found', r.available && r.cards.length === 9, `${r.cards && r.cards.length} cards`);
  const card = (set) => r.cards.find(c => c.set === set);
  const par = (set, name) => (card(set).parallels || []).find(p => p.name === name);

  check('Base #269 carries its raw sales price', par('Base Set', 'Base').price === 300 && !par('Base Set', 'Base').estimated,
    JSON.stringify(par('Base Set', 'Base')));
  check('Silver (the checklist\'s "Prizm") carries its own', par('Base Set', 'Prizm').price === 900);
  const gold = par('Base Set', 'Prizm Gold');
  check('Gold /10 is estimated off the ladder from the card\'s own level ($300 × 40)',
    gold.estimated && Math.abs(gold.price - 12000) < 1, JSON.stringify(gold));
  check('the slab and the chase pack are not in the raw price', par('Base Set', 'Base').sales === 4);
  check('Instant Impact #8 is placed on its insert and priced', par('Instant Impact', 'Base').price === 60);
  check('an insert with no sale of its own is left unpriced',
    card('Rookie Introductions').parallels.every(p => p.price == null));

  // A player with no sales at all: base-set cards from the product's typical card.
  const e = await S._checklistPrices(PID, 'Eric Ebron');
  const eb = e.cards.find(c => c.set === 'Base Set');
  const ebBase = eb.parallels.find(p => p.name === 'Base'), ebGold = eb.parallels.find(p => p.name === 'Prizm Gold');
  check('an unsold base card is priced from the product\'s typical card', ebBase.estimated && ebBase.price === 5
    && ebBase.confidence === 'low', JSON.stringify(ebBase));
  check('and its Gold /10 off the ladder from there', ebGold.estimated && ebGold.price === 200, JSON.stringify(ebGold));

  const none = await S._checklistPrices(PID, 'Nobody At All');
  check('a player not in the checklist is refused', !none.available && none.reason === 'not-in-checklist');

  console.log(failures ? `\n${failures} check(s) failed` : '\nall checklist-prices checks passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
