// The sold-stats strip under the search bar, per sport.
//
// The collector stores all three sports in one table. The strip follows the
// sports a visitor has switched on: one sport shows its own boards, several
// are merged. What matters: each sport's boards read only that sport's sales
// (a football sale on the basketball strip, or Michael Jordan topping the
// football one, is wrong on its face), accepted best offers stay out of
// prices, a sport with no sales yet is left out rather than breaking the
// strip, and football's totals do not count the other sports that the
// collector's pre-aggregated `daily` table now holds.
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
const iso = (off) => new Date(Date.now() + off * 86400000).toISOString().slice(0, 10);
const day = iso(-2);          // the day basketball arrived
const ins = db.prepare(`INSERT INTO sales (item_id, sold_date, title, price_cents, player, year, set_name,
  card_number, parallel, grader, grade, confidence, best_offer, sport) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
let n = 0;
const add = (o) => ins.run(`i${n++}`, o.date || day, o.title, o.cents, o.player, '2023', o.set || 'Prizm',
  o.num || '1', o.par || '', o.grader || '', o.grade || '', 0.9, o.bo ? 1 : 0, o.sport);
// Football, untagged as every row from before the column was, and tagged.
for (let i = 0; i < 20; i++) add({ title: `2023 Prizm C.J. Stroud #${i}`, cents: 500000, player: 'C.J. Stroud', num: String(i), sport: null });
add({ title: '2023 Prizm Brock Purdy', cents: 900000, player: 'Brock Purdy', sport: 'football' });
// Basketball: a Jordan pricier than anything football sold, Wembanyama
// selling most, and a best offer that would top the board if it counted.
add({ title: '1986 Fleer Michael Jordan PSA 10', cents: 9000000, player: 'Michael Jordan', num: '57', grader: 'PSA', grade: '10', sport: 'NBA' });
for (let i = 0; i < 6; i++) add({ title: '2023-24 Prizm Victor Wembanyama #136', cents: 4000 + i * 100, player: 'Victor Wembanyama', num: '136', sport: 'basketball' });
add({ title: 'Best offer Wemby auto', cents: 99999999, player: 'Victor Wembanyama', num: 'A-VW', bo: true, sport: 'Basketball' });
// `daily` counts every sport from the day they arrived: 100 football sales
// the week before, and all 29 rows above on the day.
db.prepare('INSERT INTO daily VALUES (?,?,?,?)').run(iso(-9), 100, 100, 1000000);
db.prepare('INSERT INTO daily VALUES (?,?,?,?)').run(day, 29, 29, 0);

const d1 = {
  prepare(sql) {
    let bound = [];
    const api = {
      bind(...args) { bound = args; return api; },
      all: async () => ({ results: db.prepare(sql).all(...bound) }),
      first: async () => db.prepare(sql).get(...bound) || null,
      run: async () => ({ success: true, meta: db.prepare(sql).run(...bound) }),
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
const call = async (u) => (await (await fetch(`http://127.0.0.1:${PORT}${u}`)).json());

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

(async () => {
  const bb = await call('/api/sold-stats?days=30&sport=basketball');
  const bbTitles = (bb.priciest || []).map(r => r.title);
  check('basketball has its own boards once its first sales are in', bb.available === true && bb.sport === 'basketball',
    JSON.stringify({ available: bb.available, error: bb.error, reason: bb.reason }));
  check('  ...counting only basketball, whatever the tag\'s case, best offers aside',
    bb.pricedSales === 8 && bbTitles[0] === '1986 Fleer Michael Jordan PSA 10'
      && !bbTitles.includes('Best offer Wemby auto') && !bbTitles.some(t => /Stroud|Purdy/.test(t)),
    `${bb.pricedSales} priced: ${bbTitles.join(' | ')}`);
  const ms = (bb.mostSold || [])[0] || {};
  check('  ...and a most-sold board from a single day (a lower bar than football\'s 25)',
    /Wembanyama/.test(ms.name || '') && ms.sales === 6, JSON.stringify(ms));

  const mlb = await call('/api/sold-stats?days=30&sport=baseball');
  check('a sport with no sales yet has none, for the page to leave out', mlb.available === false, JSON.stringify(mlb).slice(0, 120));

  const fb = await call('/api/sold-stats?days=30');
  const fbTitles = (fb.priciest || []).map(r => r.title);
  check('football\'s boards leave basketball out, and keep untagged football sales',
    fbTitles.includes('2023 Prizm Brock Purdy') && fbTitles.some(t => /Stroud/.test(t))
      && !fbTitles.some(t => /Jordan|Wembanyama|Wemby/.test(t)), fbTitles.slice(0, 3).join(' | '));
  check('  ...and its totals take `daily` only up to the day the other sports arrived, then count football\'s own',
    fb.pricedSales === 121, `${fb.pricedSales} priced sales (100 before + 21 football on the day)`);

  // The page: one fetch per sport switched on, merged.
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const merge = new Function(js.slice(js.indexOf('function _mpMerge'), js.indexOf('async function _mpFetch')) + '; return _mpMerge;')();
  const both = merge([{ ...fb, sport: 'football' }, { ...bb, sport: 'basketball' }]);
  check('with several sports on, the strip merges them: the priciest across both, totals added',
    both.priciest[0].title === '1986 Fleer Michael Jordan PSA 10' && both.priciest.some(r => /Purdy/.test(r.title))
      && both.pricedSales === 129 && both.sports.join() === 'football,basketball',
    `${both.priciest[0].title}, ${both.pricedSales} sales`);
  check('  ...and the most sold ranked by count across them',
    both.mostSold.every((r, i, a) => !i || a[i - 1].sales >= r.sales));
  check('  ...one sport alone shows its own boards unchanged', merge([{ ...bb, sport: 'basketball' }]).priciest[0].title === bbTitles[0]);
  check('the strip asks for each sport switched on, and reloads when that changes',
    /const _mpSports = \(\) => sportsPrefs\(\)\.enabled;/.test(js) && /&sport=' \+ sp/.test(js)
      && /_mpRefreshForSports\(\);/.test(js) && /_mpTitle\(\);/.test(js));

  server.close();
  console.log(failures ? `\n${failures} check(s) failed` : '\nall sport-sold-stats checks passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('THREW:', e && e.stack || e); server.close(); process.exit(1); });
