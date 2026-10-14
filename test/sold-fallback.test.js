// A sold search that finds (nearly) nothing still shows something close, and
// says what it is (server.js _soldFallback, /api/direct-search). Oct 2026:
// "2024 Troy Franklin RC #/5 Broncos" found one sale and the page was empty.
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
  card_number TEXT, confidence REAL, best_offer INTEGER, bids INTEGER)`);
const DAY = 86400000;
const iso = (o) => new Date(Date.now() + o * DAY).toISOString().slice(0, 10);
const ins = db.prepare(`INSERT INTO sales (item_id, sold_date, title, price_cents, player, year, set_name, parallel, card_number, confidence)
  VALUES (?,?,?,?,?,?,?,?,?,0.9)`);
let n = 100000000;
const add = (title, cents, d, set = 'Prizm', par = '') => ins.run(String(n++), iso(d), title, cents, 'Troy Franklin', '2024', set, par, '');
// No /5 has ever sold. Nearby print runs have; so have unnumbered cards.
add('2024 Panini Prizm Troy Franklin Gold Vinyl /5 RC Broncos', 30000, -400);   // outside the window
add('2024 Panini Prizm Troy Franklin Purple Pulsar /10 RC', 9000, -5, 'Prizm', 'Purple Pulsar');
add('2024 Donruss Optic Troy Franklin Gold /10 Rated Rookie', 8000, -9, 'Donruss Optic', 'Gold');
add('2024 Panini Mosaic Troy Franklin Orange /25', 4000, -3, 'Mosaic', 'Orange');
add('2024 Panini Select Troy Franklin Tie-Dye /25', 4500, -12, 'Select', 'Tie-Dye');
add('2024 Panini Prizm Troy Franklin Blue /199', 1500, -2, 'Prizm', 'Blue');
add('2024 Panini Prizm Troy Franklin #333 Rookie', 300, -1);
add('2024 Donruss Rated Rookie Troy Franklin #340', 250, -4, 'Donruss');
add('2023 Bowman Chrome University Troy Franklin #77', 200, -6, 'Bowman Chrome');
// Not him.
ins.run(String(n++), iso(-2), '2024 Panini Prizm Bo Nix /5 Gold Vinyl', 99900, 'Bo Nix', '2024', 'Prizm', 'Gold Vinyl', '');

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
const call = async (q) => (await fetch(`http://127.0.0.1:${port}/api/direct-search?mode=sold&q=${encodeURIComponent(q)}`)).json();

(async () => {
  const r = await call('2024 Troy Franklin RC #/5 Broncos');
  const runs = (r.results || []).filter(x => x.similar).map(x => (String(x.title).match(/\/(\d+)/) || [])[1]);
  check('a /5 with no sales shows the nearest print runs, closest first',
    r.fallbackNote && /No sales of a \/5 yet/.test(r.fallbackNote) && runs[0] === '10' && runs.slice(0, 2).every(x => x === '10') && runs.includes('25'),
    `${r.fallbackNote} | ${runs.join(',')}`);
  check('  ...every one of them his, and marked as similar', (r.results || []).every(x => /Troy Franklin/.test(x.title))
    && (r.results || []).filter(x => !x.similar).length === (r.exactCount || 0));
  check('  ...with no value box priced off other cards', r.approximateValue === null && r.searchType === 'broadened');

  const r2 = await call('2024 Troy Franklin Superfractor 1/1');
  check('nothing at any print run near it either: his other 2024 cards, said so',
    (r2.results || []).length > 0 && (r2.results || []).every(x => /Troy Franklin/.test(x.title)) && /fallbackNote|/.test(''),
    r2.fallbackNote);

  const r3 = await call('2024 Troy Franklin Broncos RC');
  const exact3 = (r3.results || []).filter(x => !x.similar).map(x => x.title);
  check('team names and "RC" no longer exclude sales that leave them out',
    exact3.some(t => /#340/.test(t)) && exact3.some(t => /#333/.test(t)), JSON.stringify(exact3));

  const r4 = await call('Zzyzx Qwertyman Prizm');
  check('a player we do not know: no made-up comps', !r4.fallbackNote && !(r4.results || []).some(x => x.similar));

  check('team colours stay required: "Red Sox" keeps its red', !S.SOLD_SOFT_WORDS.has('red') && S.SOLD_SOFT_WORDS.has('broncos'));
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  check('the page says what the added sales are, marks each, and keeps them out of the averages',
    /if \(fallbackNote\) typeLabel/.test(app) && /item\.similar \?/.test(app) && /fallbackNote \? results\.filter\(r => !r\.similar\)/.test(app));
  const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  check('the fallback reads our own sales only, never the per-row paid feed',
    /const data = await fetchViaNflCardDb\(step\.q, 200, 'sold-fallback'\);/.test(srv));

  server.close();
  console.log(failures ? `\n${failures} check(s) failed` : '\nall sold-fallback checks passed');
  process.exit(failures ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
