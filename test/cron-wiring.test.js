// Everything the cron calls must actually reach it.
//
// worker.js hands the scheduled handler a fixed object built by init(). That
// object is a whitelist: a function can be exported from server.js and called
// by name inside scheduled() and still never run, because init() never put it
// in. Guarded by `typeof fn === 'function'`, the result is not an error — it is
// nothing at all.
//
// That is not hypothetical. The alias backfill shipped exported, called, and
// unwired, so the table it creates was never created, and the only visible
// symptom was a debug endpoint reporting "no such table" hours later.
//
// This reads the source rather than running a Worker, because the bug lives in
// the wiring and not in the behaviour of any one function.
const fs = require('fs');
const path = require('path');

const workerSrc = fs.readFileSync(path.join(__dirname, '..', 'worker.js'), 'utf8');
const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

// Names the scheduled handler tries to call. Scoped to that handler's body:
// worker.js checks typeof on plenty of other things (addEventListener among
// them) that have nothing to do with the cron.
const schedStart = workerSrc.indexOf('async scheduled(');
const schedBody = schedStart === -1 ? '' : workerSrc.slice(schedStart);
const called = [...schedBody.matchAll(/typeof\s+(\w+)\s*===\s*'function'/g)].map(m => m[1]);

// Names init() actually passes through.
const passedMatch = workerSrc.match(/serverInit\s*=\s*\{([^}]*)\}/);
const passed = passedMatch
  ? passedMatch[1].split(',').map(s => s.split(':')[0].trim()).filter(Boolean)
  : [];

// Names server.js exports.
const exportMatch = serverSrc.match(/module\.exports\s*=\s*\{([^}]*)\}/);
const exported = exportMatch
  ? exportMatch[1].split(',').map(s => s.split(':')[0].trim()).filter(Boolean)
  : [];

check('the cron\'s job list was found in worker.js',
      called.length > 0 && passed.length > 0 && exported.length > 0,
      `${called.length} called, ${passed.length} passed by init(), ${exported.length} exported`);

const notPassed = called.filter(n => !passed.includes(n));
check('every job the cron calls is passed through init()',
      notPassed.length === 0,
      notPassed.length ? `NEVER RUNS: ${notPassed.join(', ')}` : called.join(', '));

const notExported = called.filter(n => !exported.includes(n));
check('  ...and exported from server.js',
      notExported.length === 0,
      notExported.length ? `NOT EXPORTED: ${notExported.join(', ')}` : 'all present');

// init() destructures from the server module before building serverInit; a name
// in the object literal that was never destructured is silently undefined.
const destructured = (workerSrc.match(/const\s*\{([^}]*)\}\s*=\s*exports;/) || [])[1] || '';
const notDestructured = passed.filter(n => !destructured.includes(n));
check('  ...and destructured off the module first',
      notDestructured.length === 0,
      notDestructured.length ? `UNDEFINED: ${notDestructured.join(', ')}` : 'all present');


// ---- D1 write budget ----
//
// D1 bills rows written, and the free tier allows 100,000 a day. The alias
// backfill is the only thing this Worker writes to D1, and it wrote a fixed
// batch on every cron tick. At 1200 rows every 15 minutes that is
//
//   1200 x 96 = 115,200 rows/day
//
// which is over the limit on its own, before the sales ingestion writes a
// single row — and Cloudflare counts index updates as rows written too, so the
// real figure was higher again. The account went over, D1 began refusing
// writes, and the first anyone knew was an email from Cloudflare.
//
// Nothing about that was visible in code review: both numbers are reasonable
// alone, and the product of them is the problem. So the product is what gets
// checked.
const D1_FREE_ROWS_PER_DAY = 100000;
// The backfill is not the only writer against this database — the sales
// ingestion writes to the same D1 — so the cron may not spend the whole
// allowance. A quarter leaves room for the rest.
const CRON_WRITE_BUDGET = D1_FREE_ROWS_PER_DAY / 4;

const cronMatch = fs.readFileSync(path.join(__dirname, '..', 'wrangler.toml'), 'utf8')
  .match(/crons\s*=\s*\[\s*"([^"]+)"/);
const cronExpr = cronMatch ? cronMatch[1] : '';
const everyN = (cronExpr.match(/^\*\/(\d+) /) || [])[1];
const ticksPerDay = everyN ? (60 / Number(everyN)) * 24 : null;

const batchMatch = serverSrc.match(/ALIAS_BACKFILL_BATCH\s*=\s*(\d+)/);
const batch = batchMatch ? Number(batchMatch[1]) : null;

// Does the handler run the backfill on every tick, or gate it to some of them?
const gated = /getUTCMinutes\(\)\s*<\s*15/.test(schedBody);
const runsPerDay = ticksPerDay === null ? null : (gated ? 24 : ticksPerDay);
const rowsPerDay = (batch === null || runsPerDay === null) ? null : batch * runsPerDay;

check('the cron schedule and batch size are both readable',
  ticksPerDay !== null && batch !== null,
  `cron="${cronExpr}" ticks/day=${ticksPerDay} batch=${batch}`);

check('the alias backfill stays inside the D1 free-tier write budget',
  rowsPerDay !== null && rowsPerDay <= CRON_WRITE_BUDGET,
  rowsPerDay === null ? 'could not compute'
    : `${batch} rows x ${runsPerDay} runs/day = ${rowsPerDay.toLocaleString('en-US')} `
      + `(budget ${CRON_WRITE_BUDGET.toLocaleString('en-US')}, D1 free tier ${D1_FREE_ROWS_PER_DAY.toLocaleString('en-US')})`);

// ---- Sold-unavailable must say which fault it was ----
//
// Three different causes reach one user-facing sentence: the D1 binding
// missing, a query throwing, and the sales table being empty. Each has a
// different fix, and with the message alone there is no way to tell from
// outside which one fired — which cost real time when the site reported "sold
// unavailable" during an unrelated D1 incident.
const soldReasons = ['no-d1-binding', 'sales-table-empty'];
for (const r of soldReasons) {
  check(`sold-unavailable can report "${r}"`, serverSrc.includes(`'${r}'`));
}
check('sendIfSoldBlocked forwards the reason rather than dropping it',
  /sendSoldUnavailable\(res,\s*blocked\.reason/.test(serverSrc));


console.log(failures ? `\n${failures} check(s) failed` : '\nall cron-wiring checks passed');
process.exit(failures ? 1 : 0);
