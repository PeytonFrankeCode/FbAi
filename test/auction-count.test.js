// The auction-count check (owner, Nov 2026: count how many football, baseball
// and basketball auctions end on eBay before building an auction watcher).
'use strict';
process.env.NODE_ENV = 'test';
process.env.CF_WORKER = '1';
const path = require('path');
const fs = require('fs');
let failures = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`); if (!ok) failures++; };
const ROOT = path.join(__dirname, '..');
const S = require(path.join(ROOT, 'server.js'));
const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

(async () => {
  const server = S.app.listen(0), base = `http://127.0.0.1:${server.address().port}`;
  try {
    const r = await fetch(base + '/api/debug/auction-count');
    const body = await r.json().catch(() => null);
    check('without eBay keys it answers with an error, never hangs or crashes', (r.status === 502 && body && body.error) || (r.status === 200 && body && body.next24h), `${r.status} ${JSON.stringify(body).slice(0, 120)}`);
  } finally { server.close(); }
  const fn = src.slice(src.indexOf('async function _auctionCount'), src.indexOf("app.get('/api/debug/auction-count'"));
  check('it asks eBay for totals only (limit 1), in Sports Trading Card Singles', /limit: 1/.test(fn) && /category_ids: '261328'/.test(fn));
  check('it counts auctions ending in the next 24 hours, per sport, and in the next 2 minutes', /buyingOptions:\{AUCTION\},\$\{window\(24 \* 60\)\}/.test(fn) && /window\(2\)/.test(fn) && /Sport:\{\$\{sport\}\}/.test(fn));
  check('the answer is cached an hour, so the public page costs at most 11 calls an hour', /cachePut\(AUCTION_COUNT_KEY, out, 3600\)/.test(src) && (fn.match(/await total\(/g) || []).length === 7);
  console.log(failures ? `\n${failures} auction-count check(s) failed` : '\nall auction-count checks passed');
  process.exit(failures ? 1 : 0);
})();
