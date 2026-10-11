#!/usr/bin/env node
// The deploy's test step: exactly the suites `npm test` runs, in the same
// order, except the slow ones, which run alongside instead of in line.
//
// market-accuracy builds a ~100k-sale market to prove the index survives real
// scale, and was 74 of the suite's 139 seconds. It runs in Worker mode on its
// own in-memory database and its own port, so nothing it does touches another
// suite; started first, it finishes while the rest are still running. Its
// output is held and printed whole at the end, so the log stays readable.
//
// Any failure fails the step, as `&&` would. `npm test` itself is unchanged
// for running locally.
const { spawn } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ALONGSIDE = ['test/market-accuracy.test.js'];

const chain = require(path.join(ROOT, 'package.json')).scripts.test
  .split('&&').map(s => s.trim().replace(/^node\s+/, ''));
const missing = ALONGSIDE.filter(f => !chain.includes(f));
if (missing.length) {
  console.error(`run-ci-tests: ${missing.join(', ')} is not in npm test; update ALONGSIDE`);
  process.exit(1);
}
const inLine = chain.filter(f => !ALONGSIDE.includes(f));

const run = (file, quiet) => new Promise((resolve) => {
  const out = [];
  const child = spawn(process.execPath, [file], { cwd: ROOT, stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
  if (quiet) { child.stdout.on('data', d => out.push(d)); child.stderr.on('data', d => out.push(d)); }
  child.on('close', (code) => resolve({ file, code, out: Buffer.concat(out).toString() }));
});

(async () => {
  const t0 = Date.now();
  const beside = Promise.all(ALONGSIDE.map(f => run(f, true)));
  let failed = null;
  for (const f of inLine) {
    const r = await run(f, false);
    if (r.code !== 0) { failed = r; break; }   // stop at the first failure, as && does
  }
  for (const r of await beside) {
    console.log(`\n---- ${r.file} (run alongside) ----\n${r.out}`);
    if (r.code !== 0 && !failed) failed = r;
  }
  console.log(`\nrun-ci-tests: ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  if (failed) { console.error(`FAILED: ${failed.file} (exit ${failed.code})`); process.exit(1); }
})();
