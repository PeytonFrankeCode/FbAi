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

// Locating a function's body in server.js. Module scope because two separate
// checks need it; the first version scoped it inside one block and the second
// could not see it.
const rawBodyOf = (name) => {
  const start = serverSrc.indexOf(`async function ${name}`);
  if (start === -1) return '';
  const next = serverSrc.indexOf('\nasync function ', start + 1);
  return serverSrc.slice(start, next === -1 ? serverSrc.length : next);
};

// Follow a one-hop delegation.
//
// The D1 usage accounting wraps each scheduled job so its queries can be
// attributed — buildPriceBlocks now just calls _buildPriceBlocks inside a
// label. Reading the wrapper and concluding the marker is missing is a guard
// failing on a rename rather than on a regression, which is what it did.
const bodyOf = (name) => {
  const body = rawBodyOf(name);
  const hop = body.match(/_asD1Source\('[^']+',\s*\(\)\s*=>\s*(_\w+)\(/);
  return hop ? rawBodyOf(hop[1]) : body;
};

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


// ---- the price-block rebuild cannot become a retry loop ----
//
// The cron builds the price map immediately when there is no map, so a deploy
// fills the pages within a tick instead of waiting for 04:xx. The first
// version of that rule asked ONLY whether the map existed — and a build that
// failed left no map, so it retried every fifteen minutes, ninety-six times a
// day, each one two full aggregate passes over the sales table.
//
// Nothing about that is visible from inside: no error accumulates, no page
// looks wrong, the pages just stay empty. It shows up as a D1 bill.
{
  const src = serverSrc;

  // Bounded to the function itself, not a fixed character window. The first
  // version sliced 1200 characters from the declaration, which ran past the
  // end of this function into buildPriceBlocks — where the same constant
  // appears — so deleting the check here still "passed". A guard that reads
  // the next function's source is not a guard.
  const fn = bodyOf('priceBlocksMissing');
  check('the reactive rebuild is gated on more than "is the map missing"',
    /ATTEMPT_KEY/.test(fn),
    'without an attempt marker, a failing build retries on every tick');

  // The marker has to be written before the queries run, not after they
  // succeed — otherwise a failure or a crash leaves nothing recorded and the
  // loop is exactly as fast as before.
  const build = bodyOf('buildPriceBlocks');
  // The INVOCATION, not the constant. Looking for PRICE_BLOCKS_ATTEMPT_KEY
  // finds it in the helper that writes the marker, which is defined before the
  // queries regardless — so deleting the call that actually records the attempt
  // still passed. It is the call that has to happen first, not the definition.
  const markerAt = build.search(/await mark\('started'\)/);
  const firstQueryAt = build.indexOf('db.prepare');
  check('  ...and the attempt is recorded before any query runs',
    markerAt !== -1 && (firstQueryAt === -1 || markerAt < firstQueryAt),
    markerAt === -1 ? 'no marker written in buildPriceBlocks'
      : 'a marker written after the work does not survive a crash');

  // How bad a totally broken build is allowed to get.
  const m = src.match(/const PRICE_BLOCKS_RETRY_SECONDS = (\d+);/);
  const ticksPerDay = 96;
  const worst = m ? Math.ceil(86400 / Number(m[1])) : ticksPerDay;
  check('  ...capping a broken build to a few scans a day, not ninety-six',
    m && worst <= 6,
    `${worst} attempts/day worst case` + (m ? ` (retry window ${m[1]}s)` : ''));
}

// ---- the alias backfill must not pay full price to learn there is nothing to do ----
//
// Measured on one day: 20,219,058 rows read across 19 runs — 1.06M per run,
// more than twice the whole sales table — against 73,416 for the photo archive
// over 72 runs. _normCol() wraps the player column so idx_sales_player cannot
// be used, and the NOT EXISTS runs as a correlated lookup per row; then it
// groups and sorts. That cost is paid in full even when the answer is
// "nothing new", which it is almost every hour once the table has filled.
{
  const body = bodyOf('backfillPlayerAliases');

  // The READ, specifically. An earlier version of this check looked for the
  // constant anywhere in the function, and deleting the whole skip left it
  // passing — because the write at the bottom still names the same key. A
  // marker nothing ever reads saves nothing.
  const readAt = body.indexOf('cacheGet(ALIAS_CAUGHTUP_KEY)');
  check('the backfill checks whether it is already caught up',
    readAt !== -1,
    'without it, every hour costs a million rows to be told there is no work');

  // Before the query, or it saves nothing at all.
  const queryAt = body.indexOf('db.prepare');
  check('  ...before running the query, not after',
    readAt !== -1 && queryAt !== -1 && readAt < queryAt,
    'a check that runs after the scan has already paid for the scan');

  // And something has to write it. A read against a key nobody sets is a
  // permanent miss: the scan runs every hour exactly as it does today, and
  // every check above still passes.
  check('  ...and a run that finds nothing records that it is caught up',
    /cachePut\(ALIAS_CAUGHTUP_KEY/.test(body),
    'a marker that is never written is a skip that never happens');

  // A run that drained the table marks itself caught up without spending a
  // second scan to prove it.
  //
  // The query asked for `limit` and got fewer, so it returned every unaliased
  // variant there was, and all of them now have a row. The next scan is
  // guaranteed to match nothing. Without this the daily shape is two expensive
  // runs rather than one: the first writes the day's new spellings, and only
  // the second sees an empty result.
  //
  // The tail is everything after the batch was written, and it holds exactly
  // one cachePut. Reading the CONDITION that guards it — rather than searching
  // the whole function for the comparison — is what makes the pair below
  // distinguishable: a check that only asked whether "list.length < limit"
  // appears anywhere would still pass if the marker were written
  // unconditionally and the comparison left sitting in a log line.
  const tail = body.slice(body.indexOf('[alias] +'));
  const tailGuard = tail.match(/if \(([^)]*)\)\s*\{\s*try \{ await cachePut\(ALIAS_CAUGHTUP_KEY/);
  check('  ...and a run that drains the table skips the confirming scan',
    !!tailGuard,
    'otherwise every day costs two full scans instead of one');
  // Conditional on a SHORT batch. A full batch may have more behind it, and
  // marking caught up there would strand the initial fill partway and leave the
  // index on fragmented names for a day at a time.
  check('  ...but a full batch keeps going, so the first fill is not stranded',
    !!tailGuard && /list\.length\s*<\s*limit/.test(tailGuard[1]),
    tailGuard ? `guarded by: ${tailGuard[1].trim()}` : 'no guard on the drain marker');

  // It has to expire. A permanent marker would mean a quiet week wedges the
  // backfill off and new spellings are never picked up again.
  const ttl = serverSrc.match(/const ALIAS_CAUGHTUP_TTL = ([^;]+);/);
  check('  ...and the caught-up marker expires within a day',
    !!ttl && eval(ttl[1]) <= 86400 && eval(ttl[1]) >= 3600,
    ttl ? `${eval(ttl[1])}s` : 'no TTL found');

  // A test passing its own resolver must still exercise the real path, so the
  // skip itself has to sit inside the !resolve guard — not merely somewhere in
  // the same function, which the write below also satisfies.
  check('  ...and a caller with its own resolver is never skipped',
    /if \(!resolve\)\s*\{[\s\S]{0,240}?cacheGet\(ALIAS_CAUGHTUP_KEY\)/.test(body),
    'otherwise the tests would stop covering the work they exist to cover');
}

// ---- the skip has to be observable, and observable through the same key ----
//
// /api/debug/d1-usage reports whether the backfill is currently skipping,
// because the daily row counts only answer that a day later. The failure mode
// is not a crash: if the endpoint read a different key than the backfill
// writes, it would report "not caught up" forever while the skip worked
// perfectly — or worse, the reverse. /api/debug/price-blocks already did
// exactly this once, reporting a build as still running because it read its own
// marker back before KV had converged.
{
  const usage = serverSrc.slice(serverSrc.indexOf("app.get('/api/debug/d1-usage'"));
  const endpoint = usage.slice(0, usage.indexOf('\napp.get('));
  check('the D1 usage endpoint reports whether the backfill is skipping',
    /cacheGet\(ALIAS_CAUGHTUP_KEY\)/.test(endpoint),
    'otherwise the fix cannot be confirmed until a full day of counts has passed');
  check('  ...reading the same constant the backfill writes',
    /ALIAS_CAUGHTUP_KEY/.test(bodyOf('backfillPlayerAliases')),
    'a diagnostic on a different key reports confidently and wrongly');
}

// ---- the cron must keep its own KV writes alive ----
//
// cachePut() never returns its promise; it hands it to globalThis.__kvWaitUntil
// so the runtime holds the invocation open until the write lands. fetch() set
// that and scheduled() did not, so every KV write from the cron was a floating
// promise — and because globalThis survives across invocations in a warm
// isolate, a cron following a request would call waitUntil on that request's
// finalized ctx, throw, and have it swallowed. Survival depended on what else
// had just run in the same isolate.
//
// Both markers this file checks above — caught-up and price-block-attempt —
// are written from the cron. Neither gate works if its write evaporates.
{
  // Comments stripped first, and not as a nicety.
  //
  // The first version of this scanned the raw source, and the explanation
  // written directly above the binding names __kvWaitUntil four times. Deleting
  // the binding outright still "passed" two of the three checks, and moving it
  // after the jobs passed all three — the guard was reading the paragraph that
  // describes the fix rather than the fix. Prose cannot keep a promise alive.
  const stripped = workerSrc
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  const sched = stripped.slice(stripped.indexOf('async scheduled('));
  const bindAt = sched.search(/globalThis\.__kvWaitUntil\s*=/);
  const bodyAt = sched.indexOf('await init(env)');
  check('the cron binds waitUntil so its KV writes survive',
    bindAt !== -1,
    'without it every cachePut from the cron is a promise nothing is holding');
  check('  ...before it runs any job, not after',
    bindAt !== -1 && bodyAt !== -1 && bindAt < bodyAt,
    'a binding installed after the work has already lost the early writes');
  // Its own ctx, not whatever a previous request left behind.
  check('  ...using this invocation\'s ctx',
    /globalThis\.__kvWaitUntil\s*=\s*\(promise\)\s*=>\s*\{[\s\S]{0,120}?ctx\.waitUntil\(promise\)/.test(sched),
    'a stale ctx from an earlier request throws and the write is dropped');
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall cron-wiring checks passed');
process.exit(failures ? 1 : 0);
