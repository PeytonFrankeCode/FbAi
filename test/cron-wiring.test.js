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

console.log(failures ? `\n${failures} check(s) failed` : '\nall cron-wiring checks passed');
process.exit(failures ? 1 : 0);
