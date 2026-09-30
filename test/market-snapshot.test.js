// The basketball and baseball market, before there is history.
//
// The index needs weeks of repeat sales; these sports have days. What a few
// days can say honestly is which sales were priciest and what sold most, so
// /api/market-snapshot says that and nothing that needs a past. What matters:
// only the asked-for sport's sales are read (a football sale on the basketball
// page would be wrong on its face), accepted best offers stay out of prices,
// and a sport with no sales yet keeps "coming soon" rather than an empty page.
let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (err) {
  console.error('FAIL  node:sqlite unavailable on ' + process.version + ' — this test needs Node 22.5+.');
  process.exit(1);
}
const fs = require('fs');
const path = require('path');

const db = new DatabaseSync(':memory:');
db.exec(`CREATE TABLE sales (
  item_id TEXT, sold_date TEXT, title TEXT, price_cents INTEGER, currency TEXT,
  listing_format TEXT, grader TEXT, grade TEXT, player TEXT, parallel TEXT,
  year TEXT, set_name TEXT, card_number TEXT, confidence REAL,
  best_offer INTEGER, bids INTEGER, image_url TEXT, sport TEXT
)`);
db.exec('CREATE TABLE daily (sold_date TEXT, sales INTEGER, priced INTEGER, total_cents INTEGER)');
const day = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
const ins = db.prepare(`INSERT INTO sales (item_id, sold_date, title, price_cents, player, year, set_name,
  card_number, parallel, grader, grade, confidence, best_offer, sport) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
let n = 0;
const add = (o) => ins.run(`i${n++}`, o.date || day, o.title, o.cents, o.player, '2023', o.set || 'Prizm',
  o.num || '1', o.par || '', o.grader || '', o.grade || '', 0.9, o.bo ? 1 : 0, o.sport);
// Football's own rows, older and pricier than anything basketball sold.
for (let i = 0; i < 20; i++) add({ title: `2023 Prizm C.J. Stroud #${i}`, cents: 500000, player: 'C.J. Stroud', num: String(i), sport: null });
add({ title: '2023 Prizm Brock Purdy', cents: 900000, player: 'Brock Purdy', sport: 'football' });
// Basketball: Wembanyama sells most, one big graded LeBron, and a best offer
// at a price that would top the list if it counted.
for (let i = 0; i < 6; i++) add({ title: '2023-24 Prizm Victor Wembanyama #136', cents: 4000 + i * 100, player: 'Victor Wembanyama', num: '136', sport: 'basketball' });
add({ title: '1986 Fleer Michael Jordan PSA 10', cents: 9000000, player: 'Michael Jordan', num: '57', grader: 'PSA', grade: '10', sport: 'NBA' });
add({ title: '2003-04 Topps Chrome LeBron James PSA 10', cents: 250000, player: 'LeBron James', num: '111', grader: 'PSA', grade: '10', sport: 'Basketball' });
add({ title: 'Best offer Wemby auto', cents: 999999, player: 'Victor Wembanyama', num: 'A-VW', bo: true, sport: 'basketball' });
add({ title: '2023-24 Prizm Victor Wembanyama Silver #136', cents: 30000, player: 'Victor Wembanyama', num: '136', par: 'Silver', sport: 'basketball' });

let queries = 0;
const d1 = {
  prepare(sql) {
    let bound = [];
    const api = {
      bind(...args) { bound = args; return api; },
      all: async () => { queries++; return { results: db.prepare(sql).all(...bound) }; },
      first: async () => { queries++; return db.prepare(sql).get(...bound) || null; },
      run: async () => { queries++; return { success: true, meta: db.prepare(sql).run(...bound) }; },
    };
    return api;
  },
  batch(stmts) { return Promise.all(stmts.map(st => st.run())); },
};
const store = new Map();
const dbMod = require(path.join(__dirname, '..', 'db.js'));
dbMod.getNflDb = () => d1;
dbMod.cacheGet = async (k) => (store.has(k) ? store.get(k) : null);
dbMod.cachePut = (k, v) => { store.set(k, v); };
globalThis.__kvWaitUntil = () => {};
process.env.CF_WORKER = '1';

const { app } = require(path.join(__dirname, '..', 'server.js'));
const PORT = 3219;
const server = app.listen(PORT);
const call = async (u) => {
  const r = await fetch(`http://127.0.0.1:${PORT}${u}`);
  return { status: r.status, body: await r.json() };
};

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

(async () => {
  const bb = (await call('/api/market-snapshot?sport=basketball')).body;
  check('basketball has a snapshot once its first sales are in', bb.available === true && bb.days === 1 && bb.through === day,
    JSON.stringify({ available: bb.available, days: bb.days, reason: bb.reason }));
  check('  ...counting only basketball sales, whatever the tag\'s case', bb.sales === 10, `${bb.sales} sales`);
  const titles = (bb.topSales || []).map(r => r.title);
  check('  ...with no football sale in it', !titles.some(t => /Stroud|Purdy/.test(t)));
  check('  ...the most expensive first, and an accepted best offer left out',
    titles[0] === '1986 Fleer Michael Jordan PSA 10' && titles[1] === '2003-04 Topps Chrome LeBron James PSA 10'
      && !titles.includes('Best offer Wemby auto') && bb.topSales[0].price === 90000 && bb.topSales[0].grade === 'PSA 10', titles.slice(0, 3).join(' | '));
  const top = (bb.mostSoldPlayers || [])[0] || {};
  check('  ...the most sold player, with a typical price once there are three sales',
    top.player === 'Victor Wembanyama' && top.sales === 7 && top.average > 0, JSON.stringify(top));
  const card = (bb.mostSoldCards || [])[0] || {};
  check('  ...and the most sold card, raw copies only (no Silver, no slab)',
    card.number === '136' && card.sales === 6 && card.low === 40 && card.high === 45, JSON.stringify(card));

  const mlb = (await call('/api/market-snapshot?sport=baseball')).body;
  check('a sport with no sales yet says so, and the page keeps "coming soon"', mlb.available === false && /no sales/.test(mlb.reason), JSON.stringify(mlb));
  check('football is not a snapshot sport: it has the index', (await call('/api/market-snapshot?sport=football')).status === 400);

  queries = 0;
  await call('/api/market-snapshot?sport=basketball');
  check('a second visitor is served from the cache', queries === 0, `${queries} queries`);

  // Football's own boards read the same table. A basketball sale there would
  // be wrong on its face, and 1,224 Michael Jordan sales a day would own them.
  const fb = (await call('/api/sold-stats?days=30')).body;
  const fbTitles = (fb.priciest || []).map(r => r.title);
  check('football\'s boards leave basketball out, and keep untagged football sales',
    fbTitles.includes('2023 Prizm Brock Purdy') && fbTitles.some(t => /Stroud/.test(t))
      && !fbTitles.some(t => /Jordan|LeBron|Wembanyama|Wemby/.test(t)), JSON.stringify({ a: fb.available, n: fbTitles.length, t: fbTitles }));

  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  check('the Market loads the snapshot for basketball and baseball', /if \(!view\.classList\.contains\('hidden'\)\) _mkLoadSnapshot\(id\);/.test(js)
    && /\/api\/market-snapshot\?sport=/.test(js) && /if \(!data \|\| !data\.available\) return;/.test(js));
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  check('  ...into its own panel on the Market page', /<div id="market-snapshot" class="market-snapshot hidden"><\/div>/.test(html));

  server.close();
  console.log(failures ? `\n${failures} check(s) failed` : '\nall market-snapshot checks passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('THREW:', e && e.stack || e); server.close(); process.exit(1); });
