// The home-page boards are built once a day, not on demand.
//
// They were computed behind a one-hour TTL, which meant that every hour some
// visitor paid for several passes over `sales` plus a JS reduction over up to
// 4,000 groups, and waited with an empty home page while it ran. With four
// periods on four separate keys that could be four people an hour, and the one
// most likely to be caught is the first real visitor after a quiet spell.
//
// The fix is not a longer TTL. A longer TTL makes the slow load rarer without
// making it unowned — somebody still eats it, and the longer the TTL the more
// likely that somebody is a real visitor. The cron pays it instead, at a time
// nobody is waiting.
//
// So this test is about WHO pays, and it counts queries to find out. Checks
// that only assert "the endpoint returns data" would pass against the old
// build and against a build with the warm job deleted.
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
db.exec(`CREATE TABLE daily (sold_date TEXT, sales INTEGER, priced INTEGER, total_cents INTEGER)`);

const DAY = 86400000;
const iso = (off) => new Date(Date.now() + off * DAY).toISOString().slice(0, 10);
const ins = db.prepare(
  `INSERT INTO sales (item_id, sold_date, title, price_cents, player, year, set_name,
                      parallel, card_number, grader, grade, confidence, image_url)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);

// Enough real cards for the mover boards to have something to rank, so the
// payload is a genuine one rather than an empty shell that caches trivially.
let n = 0;
for (let c = 1; c <= 8; c++) {
  const player = `Player ${c}`;
  for (const [day, price, count] of [[-25, 100, 8], [-5, 160, 8]]) {
    for (let k = 0; k < count; k++) {
      ins.run(`i${n++}`, iso(day + (k % 3)),
              `2023 Prizm ${player} Silver #${c}`, price * 100,
              player, '2023', 'Prizm', 'Silver', String(c), '', '', 0.9, null);
    }
  }
}
for (let d = 0; d < 40; d++) {
  db.prepare('INSERT INTO daily (sold_date, sales, priced, total_cents) VALUES (?,?,?,?)')
    .run(iso(-d), 100, 90, 900000);
}

// Count every query the boards actually run, so "served from cache" can be
// proved rather than assumed.
let queries = 0;
const d1 = {
  prepare(sql) {
    const st = db.prepare(sql);
    const count = () => { queries++; };
    return {
      bind(...a) {
        return {
          all: async () => { count(); return { results: st.all(...a) }; },
          first: async () => { count(); return st.get(...a) || null; },
        };
      },
      all: async () => { count(); return { results: st.all() }; },
      first: async () => { count(); return st.get() || null; },
    };
  },
};

// KV stubbed, with the TTL recorded. Without a stub cacheGet returns null and
// cachePut is a no-op, so the cache under test would never engage and every
// check below would pass against a build with caching removed.
const store = new Map();
const ttls = new Map();
const dbMod = require(path.join(__dirname, '..', 'db.js'));
dbMod.getNflDb = () => d1;
dbMod.cacheGet = async (k) => (store.has(k) ? store.get(k) : null);
dbMod.cachePut = (k, v, ttl) => { store.set(k, v); ttls.set(k, ttl); };
process.env.CF_WORKER = '1';

const srv = require(path.join(__dirname, '..', 'server.js'));
const { app, warmSoldStats } = srv;
const PORT = 3212;
const server = app.listen(PORT);
const call = async (u) => (await fetch(`http://127.0.0.1:${PORT}${u}`)).json();

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

(async () => {
  // ---- the cron can build them, and is the thing that does ----------------
  check('warmSoldStats is exported for the cron to call',
    typeof warmSoldStats === 'function',
    'an unexported job is one the cron silently never runs');
  if (typeof warmSoldStats !== 'function') { server.close(); process.exit(1); }

  queries = 0;
  const warm = await warmSoldStats();
  const warmCost = queries;
  check('the warm job builds every period the UI can ask for',
    warm && warm.ok && (warm.periods || []).length === 4,
    warm ? JSON.stringify(warm.periods) : 'no result');
  check('  ...and that costs real queries, paid by the cron',
    warmCost > 0, `${warmCost} queries`);

  // ---- a visitor then pays nothing ---------------------------------------
  for (const days of [7, 30, 90, 365]) {
    queries = 0;
    const r = await call(`/api/sold-stats?days=${days}`);
    check(`a visitor asking for ${days} days runs no queries`,
      queries === 0 && r.available === true,
      `${queries} queries, available=${r.available}`);
  }

  // ---- the cache outlives the day it was built ---------------------------
  // Deliberately longer than the daily rebuild. If the TTL expired exactly when
  // the boards were due to be rebuilt, any gap between the two — a missed tick,
  // a slow run, a deploy at the wrong minute — would put the home page back on
  // the slow path, which is the thing being removed.
  const ttl = [...ttls.entries()].find(([k]) => k.includes('soldstats'));
  check('the cached boards outlive a day, so a missed run is not a slow page',
    !!ttl && ttl[1] > 86400,
    ttl ? `${ttl[1]}s for ${ttl[0]}` : 'nothing cached under a soldstats key');

  // ---- a cold cache still answers ----------------------------------------
  // The on-demand path stays as a fallback. A fresh deploy, an evicted key or a
  // missed cron must still produce boards rather than an empty home page.
  store.clear();
  queries = 0;
  const cold = await call('/api/sold-stats?days=30');
  check('a cold cache still returns boards rather than an empty page',
    cold.available === true && queries > 0,
    `${queries} queries on the cold path`);
  queries = 0;
  await call('/api/sold-stats?days=30');
  check('  ...and the first caller fills the cache for everyone after',
    queries === 0, `${queries} queries on the repeat`);

  // ---- a broken build must not replace good boards with an error ---------
  // A transient D1 failure during the nightly run would otherwise overwrite
  // working boards with an "unavailable" payload for a whole day.
  //
  // The break has to reach the object server.js already holds. It captured
  // getNflDb from db.js at require time, so reassigning dbMod.getNflDb now does
  // nothing at all — an earlier version of this check did exactly that, watched
  // the warm job succeed, and reported a failure it had never actually caused.
  const key = [...store.keys()].find(k => k.includes('soldstats'));
  const good = store.get(key);
  const realPrepare = d1.prepare;
  d1.prepare = () => { throw new Error('D1 down'); };
  const broken = await warmSoldStats().catch(() => null);
  d1.prepare = realPrepare;

  const after = store.get(key);
  check('a failed refresh leaves yesterday\'s boards in place',
    after && after.available === true && after === good,
    after ? `available=${after.available}, replaced=${after !== good}` : 'cache emptied');
  check('  ...and reports the periods it skipped rather than claiming success',
    broken && (broken.periods || []).every(p => /skipped/.test(p)),
    broken ? JSON.stringify(broken.periods) : 'no result');

  // ---- the cron actually calls it ----------------------------------------
  // server.js exporting the job and the cron running it are different claims,
  // and the whitelist in init() is a place where one has silently not implied
  // the other before.
  const workerSrc = fs.readFileSync(path.join(__dirname, '..', 'worker.js'), 'utf8');
  const code = workerSrc.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  check('the cron calls warmSoldStats',
    /warmSoldStats\(\)/.test(code),
    'exported but never invoked is the same as not built');
  check('  ...and init() passes it through to the scheduled handler',
    (code.match(/warmSoldStats/g) || []).length >= 3,
    'init() keeps a whitelist; a name missing there makes the cron a silent no-op');

  // Not in the same tick as the price-block build. Both are heavy D1 jobs and
  // this one runs last in the handler, so sharing a tick means the boards are
  // what silently fails to rebuild whenever that tick runs long.
  const blocksHour = (code.match(/getUTCHours\(\)\s*===\s*(\d+)[\s\S]{0,120}?buildPriceBlocks\(\)/) || [])[1]
    || (code.match(/buildPriceBlocks[\s\S]{0,300}?getUTCHours\(\)\s*===\s*(\d+)/) || [])[1];
  const statsHour = (code.match(/getUTCHours\(\)\s*===\s*(\d+)[^)]*\)[\s\S]{0,200}?warmSoldStats\(\)/) || [])[1];
  check('  ...in its own tick, not competing with the price-block build',
    !!statsHour && !!blocksHour && statsHour !== blocksHour,
    `price blocks ${blocksHour}:xx, boards ${statsHour}:xx`);

  server.close();
  console.log(failures ? `\n${failures} check(s) failed` : '\nall sold-stats-cache checks passed');
  process.exit(failures ? 1 : 0);
})().catch(err => { console.error(err); server.close(); process.exit(1); });
