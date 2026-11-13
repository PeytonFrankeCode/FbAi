// Sold search rides out a D1 reset (owner, Nov 2026: "why does it say the
// sold search is unavailable"): a query D1 resets for running past its CPU
// limit is tried once more, and if the database stays down the sales the
// search found before (the archive) are shown instead of an error.
'use strict';
process.env.NODE_ENV = 'test';
const path = require('path');
const fs = require('fs');
let failures = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`); if (!ok) failures++; };
const ROOT = path.join(__dirname, '..');
const S = require(path.join(ROOT, 'server.js'));

(async () => {
  let n = 0;
  const flaky = async () => { n++; if (n === 1) throw new Error('D1_ERROR: D1 DB exceeded its CPU time limit and was reset.'); return 'rows'; };
  const got = await S._d1Retry(flaky, 5);
  check('a query D1 reset is tried once more, and the retry answers', got === 'rows' && n === 2, `${n} tries`);
  let m = 0;
  const broken = async () => { m++; throw new Error('no such column: foo'); };
  let threw = false;
  try { await S._d1Retry(broken, 5); } catch (_) { threw = true; }
  check('  ...but a real error (a bad query) is not retried', threw && m === 1, `${m} tries`);
  let k = 0;
  const down = async () => { k++; throw new Error('D1_ERROR: D1 DB exceeded its CPU time limit and was reset.'); };
  let threw2 = false;
  try { await S._d1Retry(down, 5); } catch (_) { threw2 = true; }
  check('  ...and a database still down after the retry is reported, not retried forever', threw2 && k === 2, `${k} tries`);
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  check('when the database stays down, sold search answers from the archive before it says unavailable',
    /const kept = filterJunkListings\(await getArchivedSales\(keywords, opts\)\);\s*if \(kept\.length\)/.test(src)
    && /provider: 'archive', fromArchive: true/.test(src) && /await _d1Retry\(\(\) => stmt\.all\(\)\)/.test(src));
  console.log(failures ? `\n${failures} sold-resilient check(s) failed` : '\nall sold-resilient checks passed');
  process.exit(failures ? 1 : 0);
})();
