// What does a sold search cost in D1 rows read?
//
// D1 bills rows read, and this is the query that reads them: `title LIKE
// '%term%'` has a leading wildcard, so no index serves it and the search walks
// the sales table. A search returning three rows can read millions on the way.
// The Workers Paid plan includes 25 billion reads a month and charges beyond
// it, so the cost of this one path decides whether the bill is $5 or not.
//
// Three properties are asserted, because all three are invisible from reading
// the code and each would silently stop working:
//
//   the cache absorbs a repeat            — else every search pays full price
//   an empty result is cached too         — the worst case, and the easiest to
//                                           forget, since nothing came back
//   the scan is bounded by a date floor   — else the walk runs to the first row
//                                           ever stored, and grows forever
let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (err) {
  console.error('FAIL  node:sqlite unavailable on ' + process.version +
                ' — this test needs Node 22.5+. Update the runtime, do not skip it.');
  process.exit(1);
}
const path = require('path');

const db = new DatabaseSync(':memory:');
db.exec(`CREATE TABLE sales (
  item_id TEXT, sold_date TEXT, title TEXT, price_cents INTEGER, currency TEXT,
  listing_format TEXT, grader TEXT, grade TEXT, player TEXT, parallel TEXT,
  year TEXT, set_name TEXT, card_number TEXT, confidence REAL, image_url TEXT
)`);
const iso = (off) => new Date(Date.now() + off * 86400000).toISOString().slice(0, 10);
const ins = db.prepare(`INSERT INTO sales (item_id, sold_date, title, price_cents, player, confidence)
                        VALUES (?,?,?,?,?,?)`);
for (let i = 0; i < 60; i++) {
  ins.run(`i${i}`, iso(-i), `2022 Prizm Patrick Mahomes Silver #1`, 5000 + i, 'Patrick Mahomes', 0.9);
}
// Far outside the search window, so a bounded scan must not return it.
ins.run('old1', iso(-4000), '1999 Ancient Relic Card', 100, 'Ancient Relic', 0.9);

// Every statement the endpoint runs, so the SQL itself can be asserted on.
const sqlSeen = [];
const d1 = {
  prepare(sql) {
    let bound = [];
    const api = {
      bind(...args) { bound = args; return api; },
      all() {
        sqlSeen.push({ sql, bound });
        const rows = db.prepare(sql).all(...bound);
        // Real D1 reports rows_read on meta; the code accumulates it, so the
        // stub has to provide it or the usage counters silently stay at zero.
        return { results: rows, meta: { rows_read: 1234, rows_written: 0 } };
      },
      run() { return { success: true }; },
      first() { sqlSeen.push({ sql, bound }); return db.prepare(sql).get(...bound) || null; },
    };
    return api;
  },
  batch(stmts) { return stmts.map(s => s.run()); },
};

// KV must be stubbed as well. Without it cacheGet returns null and cachePut is
// a no-op, so the cache under test would never engage and the test would pass
// against a build with caching removed.
const store = new Map();
const dbMod = require(path.join(__dirname, '..', 'db.js'));
dbMod.getNflDb = () => d1;
dbMod.cacheGet = async (k) => (store.has(k) ? store.get(k) : null);
dbMod.cachePut = (k, v) => { store.set(k, v); };
process.env.CF_WORKER = '1';
process.env.SOLD_PROVIDER = 'nflcarddb';

const { app } = require(path.join(__dirname, '..', 'server.js'));
const PORT = 3207;
const server = app.listen(PORT);
const call = async (u) => (await fetch(`http://127.0.0.1:${PORT}${u}`)).json();

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};
const searchSql = () => sqlSeen.filter(s => /FROM sales WHERE/.test(s.sql) && /title LIKE/.test(s.sql));

(async () => {
  // ---- a repeat costs nothing ----
  const before = searchSql().length;
  const a = await call('/api/search?mode=sold&q=' + encodeURIComponent('Patrick Mahomes Prizm'));
  const afterFirst = searchSql().length;
  const b = await call('/api/search?mode=sold&q=' + encodeURIComponent('Patrick Mahomes Prizm'));
  const afterSecond = searchSql().length;

  check('the first search reaches D1', afterFirst - before === 1,
        `${afterFirst - before} quer(ies)`);
  check('  ...and an identical repeat does not', afterSecond === afterFirst,
        afterSecond === afterFirst ? 'served from cache' : `${afterSecond - afterFirst} extra D1 quer(ies)`);
  check('  ...and returns the same results either way',
        JSON.stringify((a.results || []).map(r => r.itemId)) === JSON.stringify((b.results || []).map(r => r.itemId)),
        `${(a.results || []).length} vs ${(b.results || []).length} rows`);

  // ---- the expensive case: nothing matched ----
  const q = 'Zzzz Nonexistent Player ' + Date.now();
  const c0 = searchSql().length;
  await call('/api/search?mode=sold&q=' + encodeURIComponent(q));
  const c1 = searchSql().length;
  await call('/api/search?mode=sold&q=' + encodeURIComponent(q));
  const c2 = searchSql().length;
  check('a search that matches nothing is cached too', c1 - c0 === 1 && c2 === c1,
        c2 === c1 ? 'the full-table walk happens once, not every time'
                  : 'repeated — this is the most expensive query on the site');

  // ---- the scan is bounded ----
  const last = searchSql().slice(-1)[0] || { sql: '', bound: [] };
  check('the scan is bounded by a date floor', /sold_date >= \?/.test(last.sql),
        /sold_date >= \?/.test(last.sql)
          ? `floor bound = ${last.bound.find(x => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x))}`
          : 'unbounded — the walk runs to the first row ever stored');

  const ancient = await call('/api/search?mode=sold&q=' + encodeURIComponent('Ancient Relic'));
  check('  ...so a sale outside the window is not returned',
        (ancient.results || []).length === 0,
        `${(ancient.results || []).length} rows from ~11 years ago`);

  // ---- the cost is reported, not modelled ----
  const usage = await call('/api/debug/d1-usage');
  check('rows read are measured from D1 meta, not estimated',
        usage.rowsRead > 0 && usage.rowsPerQuery === 1234,
        `${usage.rowsRead} rows over ${usage.d1Queries} quer(ies), ${usage.rowsPerQuery}/query`);
  check('  ...and the cache hit rate is reported', usage.fromCache >= 2,
        `${usage.fromCache} of ${usage.searchesServed} served from cache (${usage.cacheHitRate})`);
  check('  ...with the monthly headroom that implies',
        usage.searchesPerMonthWithinIncluded > 0,
        `${Number(usage.searchesPerMonthWithinIncluded).toLocaleString('en-US')} searches/month within the included reads`);

  server.close();
  console.log(failures ? `\n${failures} check(s) failed` : '\nall sold-search-cost checks passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('THREW:', e && e.stack || e); process.exit(1); });
