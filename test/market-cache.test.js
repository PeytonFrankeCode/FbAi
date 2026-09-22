// The Market tab's caching: who waits for the index query, and when.
//
// The index and basket are the heaviest reads a visitor can cause, and they sat
// behind a plain one-hour TTL, so switching period or player regularly landed
// on an expired key and made someone wait for the whole query. Now an entry is
// fresh for an hour but kept for two days, a stale hit is served at once and
// rebuilt in the background, and the cron fills whatever is missing.
//
// Like sold-stats-cache.test.js this counts queries, because "the endpoint
// returns data" passes with the caching deleted.
let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (err) {
  console.error('FAIL  node:sqlite unavailable on ' + process.version +
                ' — this test needs Node 22.5+. Update the runtime, do not skip it.');
  process.exit(1);
}
const fs = require('fs');
const path = require('path');

const db = new DatabaseSync(':memory:');
db.exec(`CREATE TABLE sales (
  item_id TEXT, sold_date TEXT, title TEXT, price_cents INTEGER, currency TEXT,
  listing_format TEXT, grader TEXT, grade TEXT, player TEXT, parallel TEXT,
  year TEXT, set_name TEXT, card_number TEXT, confidence REAL,
  best_offer INTEGER, bids INTEGER, image_url TEXT
)`);

// Enough repeat sales, over enough days, for every period to score.
const DAY = 86400000;
const iso = (off) => new Date(Date.now() + off * DAY).toISOString().slice(0, 10);
const ins = db.prepare(
  `INSERT INTO sales (item_id, sold_date, title, price_cents, player, year, set_name, parallel,
                      card_number, grader, grade, confidence)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
let n = 0;
for (let c = 0; c < 150; c++) {
  for (let d = -200; d <= 0; d++) {
    if ((c + d) % 3) continue;
    ins.run(`i${n++}`, iso(d), `2020 Prizm Player ${c} Base #${c}`,
            Math.round(10000 * (1 + 0.05 * (d + 200) / 200)),
            `Player ${c}`, '2020', 'Prizm', 'Base', String(c), '', '', 0.9);
  }
}

let queries = 0;
let broken = false;
const d1 = {
  prepare(sql) {
    if (broken) throw new Error('D1 down');
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

// KV stubbed, TTLs recorded. Without it cachePut is a no-op and nothing below
// would engage.
const store = new Map();
const ttls = new Map();
const dbMod = require(path.join(__dirname, '..', 'db.js'));
dbMod.getNflDb = () => d1;
dbMod.cacheGet = async (k) => (store.has(k) ? store.get(k) : null);
dbMod.cachePut = (k, v, ttl) => { store.set(k, v); ttls.set(k, ttl); };
// Background refreshes go through waitUntil on Workers; collect them here so
// the test can wait for one to land.
const pending = [];
globalThis.__kvWaitUntil = (p) => { pending.push(p); };
process.env.CF_WORKER = '1';

const { app, warmMarket } = require(path.join(__dirname, '..', 'server.js'));
const PORT = 3217;
const server = app.listen(PORT);
const call = async (u) => {
  const r = await fetch(`http://127.0.0.1:${PORT}${u}`);
  return { body: await r.json(), cacheControl: r.headers.get('cache-control') || '' };
};
const indexKey = (days) => [...store.keys()].find(k => k.startsWith('marketindex:') && k.endsWith(`:${days}`));
const age = (key, seconds) => {
  store.set(key, { ...store.get(key), generatedAt: new Date(Date.now() - seconds * 1000).toISOString() });
};

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

(async () => {
  // ---- the cron fills the whole-market entries --------------------------
  check('warmMarket is exported for the cron to call', typeof warmMarket === 'function');
  if (typeof warmMarket !== 'function') { server.close(); process.exit(1); }

  queries = 0;
  const warm = await warmMarket();
  check('the warm job builds the index and basket for every period',
    warm && warm.ok && (warm.periods || []).filter(p => /:built$/.test(p)).length === 6,
    warm ? JSON.stringify(warm.periods) : 'no result');

  for (const days of [7, 30, 90]) {
    queries = 0;
    const idx = await call(`/api/market-index?days=${days}`);
    const bsk = await call(`/api/market-basket?days=${days}`);
    check(`a visitor switching to ${days}d runs no queries`,
      queries === 0 && idx.body.available === true && bsk.body.available === true,
      `${queries} queries, index=${idx.body.available} basket=${bsk.body.available}`);
  }

  queries = 0;
  const again = await warmMarket();
  check('  ...and a tick with nothing missing costs no queries',
    queries === 0 && (again.periods || []).every(p => /:cached$/.test(p)),
    `${queries} queries, ${JSON.stringify(again.periods)}`);

  const ttl = ttls.get(indexKey(30));
  check('entries are kept well past their freshness, so stale beats slow',
    ttl > 86400, `${ttl}s`);

  // ---- stale: served at once, rebuilt behind the visitor ----------------
  const key = indexKey(30);
  const before = store.get(key);
  age(key, 2 * 3600);
  queries = 0;
  pending.length = 0;
  const stale = await call('/api/market-index?days=30');
  check('a stale entry is served immediately, not recomputed first',
    stale.body.available === true && stale.body.refreshing === true && stale.body.score === before.score,
    `refreshing=${stale.body.refreshing}`);
  check('  ...and the rebuild was handed to waitUntil', pending.length === 1, `${pending.length} background task(s)`);
  await Promise.all(pending);
  const rebuilt = store.get(key);
  check('  ...which replaces it with a fresh one',
    rebuilt && Date.now() - Date.parse(rebuilt.generatedAt) < 60000 && queries > 0,
    rebuilt ? rebuilt.generatedAt : 'gone');

  // ---- a failure is never remembered, and never replaces a good answer --
  age(key, 2 * 3600);
  const good = store.get(key);
  broken = true;
  pending.length = 0;
  const during = await call('/api/market-index?days=30');
  await Promise.all(pending);
  broken = false;
  check('a failed background rebuild keeps the good answer',
    during.body.available === true && store.get(key).score === good.score, `served available=${during.body.available}`);

  store.clear();
  broken = true;
  const down = await call('/api/market-index?days=7');
  broken = false;
  check('  ...and a failure on a cold key is not cached',
    down.body.available === false && !indexKey(7) && !('transient' in down.body),
    `reason=${down.body.reason}, cached=${!!indexKey(7)}`);

  // ---- a settled "no" is remembered briefly -----------------------------
  queries = 0;
  await call('/api/player-index?player=Nobody%20At%20All&days=30');
  const firstCost = queries;
  queries = 0;
  const no = await call('/api/player-index?player=Nobody%20At%20All&days=30');
  const noKey = [...store.keys()].find(k => k.includes('nobody at all'));
  check('a player with no sales is not recomputed on every click',
    firstCost > 0 && queries === 0 && no.body.available === false,
    `${firstCost} then ${queries} queries`);
  check('  ...but only for a short while, since data arrives daily',
    noKey && ttls.get(noKey) <= 3600, noKey ? `${ttls.get(noKey)}s` : 'not cached');

  // ---- the browser may reuse answers for a few minutes ------------------
  const hdr = (await call('/api/market-index?days=30')).cacheControl;
  check('market answers are browser-cacheable, privately, for minutes',
    /private/.test(hdr) && /max-age=300/.test(hdr), hdr);

  // ---- the roster, for filtering as you type ----------------------------
  const roster = await call('/api/player-search?all=1');
  check('the whole player roster can be fetched once for local search',
    roster.body.available === true && roster.body.players.length > 12,
    `${(roster.body.players || []).length} players`);

  // ---- the cron actually calls it ---------------------------------------
  const code = fs.readFileSync(path.join(__dirname, '..', 'worker.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  check('the cron calls warmMarket, and init() passes it through',
    /warmMarket\(\)/.test(code) && (code.match(/warmMarket/g) || []).length >= 4,
    'a name missing from the init() whitelist makes the cron a silent no-op');

  server.close();
  console.log(failures ? `\n${failures} check(s) failed` : '\nall market-cache checks passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('THREW:', e && e.stack || e); process.exit(1); });
