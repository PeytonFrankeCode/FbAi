// A board whose build fails is left alone for a while, not retried on every
// cron tick and every home-page visit.
//
// The 90 and 365-day football boards stopped building (Oct 2026). Each try
// reads ~3 million rows and D1 runs one query at a time, so while it ran every
// sold search waited behind it: 1-3 s searches took 27-29 s just after a cron
// tick. Nothing remembered the failure, so the gap warm tried again every
// 15 minutes and every visit started another build.
const path = require('path');

let d1Queries = 0;
const d1 = { prepare() {
  const api = { bind() { return api; },
    async all() { d1Queries++; throw new Error('D1_ERROR: query exceeded time limit'); },
    async first() { d1Queries++; throw new Error('D1_ERROR: query exceeded time limit'); },
    async run() { d1Queries++; throw new Error('D1_ERROR: query exceeded time limit'); } };
  return api;
} };
const store = new Map();
const dbMod = require(path.join(__dirname, '..', 'db.js'));
dbMod.getNflDb = () => d1;
dbMod.cacheGet = async (k) => (store.has(k) ? JSON.parse(store.get(k)) : null);
dbMod.cachePut = async (k, v) => { store.set(k, JSON.stringify(v)); };
process.env.CF_WORKER = '1';
const { app, warmSoldStats } = require(path.join(__dirname, '..', 'server.js'));
const server = app.listen(0);
const port = server.address().port;
const call = async (url) => (await fetch(`http://127.0.0.1:${port}${url}`)).json();

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const first = await warmSoldStats({ onlyMissing: true });
  const afterFirst = d1Queries;
  check('a failing board is tried by the gap warm', afterFirst > 0 && /football:?7d:skipped|^7d:skipped| 7d:skipped/.test(' ' + (first.periods || []).join(' ')),
    (first.periods || []).join(' '));

  const second = await warmSoldStats({ onlyMissing: true });
  check('  ...and the next tick leaves it alone, reading nothing',
    d1Queries === afterFirst && (second.periods || []).every(p => /backoff$/.test(p)),
    `${d1Queries - afterFirst} queries; ${(second.periods || []).join(' ')}`);

  // A visitor finds only the last good copy: served, and no build behind it.
  store.set('soldstats:last:90', JSON.stringify({ available: true, days: 90, marker: 'older', generatedAt: new Date().toISOString() }));
  const before = d1Queries;
  const r = await call('/api/sold-stats?days=90');
  await sleep(300);
  check('a visit serves the last good boards and starts no build while backing off',
    r.available === true && r.marker === 'older' && d1Queries === before, `${d1Queries - before} queries`);

  const dbg = await call('/api/debug/sold-stats-builds');
  const fb90 = (dbg.boards || []).find(b => b.sport === 'football' && b.days === 90);
  check('the debug page says which board failed, when, and why',
    fb90 && fb90.failedAt && /exceeded time limit/.test(fb90.error || '') && fb90.current === false,
    JSON.stringify(fb90));

  const daily = d1Queries;
  await warmSoldStats();
  check('the daily warm still tries every board', d1Queries > daily, `${d1Queries - daily} queries`);

  server.close();
  console.log(failures ? `\n${failures} check(s) failed` : '\nall sold-stats-backoff checks passed');
  process.exit(failures ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
