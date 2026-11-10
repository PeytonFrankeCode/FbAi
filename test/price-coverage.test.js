// /api/debug/price-coverage answers from the nightly price map (Nov 2026): the
// old version scanned the sales table three times and hit D1's CPU limit on
// every call. Now: is this page priced, and if not, why not, with no D1 reads.
'use strict';
process.env.NODE_ENV = 'test';
const path = require('path');
const fs = require('fs');
let failures = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`); if (!ok) failures++; };
const db = require(path.join(__dirname, '..', 'db.js'));
const store = new Map();
db.cacheGet = async (k) => (store.has(k) ? store.get(k) : null);
db.cachePut = (k, v) => { store.set(k, v); };
const S = require(path.join(__dirname, '..', 'server.js'));

(async () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const i = src.indexOf("app.get('/api/debug/price-coverage'"), j = src.indexOf('\n});', i);
  const body = src.slice(i, j);
  check('the coverage report reads no sales table', !/getNflDb|FROM sales|db\.prepare/.test(body));

  store.set('priceblocks:v1', { built: '2026-11-10T04:00:00Z', from: '2026-09-25', to: '2026-11-03', pages: {
    'player:bo-nix': { sales: 412, cards: 88, median: 24 }, 'set:2024-panini-prizm-football': { sales: 900, cards: 300, median: 12 } } });
  const server = S.app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (q) => (await fetch(base + '/api/debug/price-coverage' + q)).json();
  try {
    const all = await get('');
    check('it summarises the price map', all.available && all.pricedPages.players === 1 && all.pricedPages.products === 1 && all.thresholds.minSales === 20, JSON.stringify(all.pricedPages));
    const nix = await get('?player=bo-nix');
    check('a priced player page says so, with its sales', nix.page.priced && nix.page.sales === 412 && nix.page.inSearch, JSON.stringify(nix.page));
    const gore = await get('?page=/players/frank-gore/');
    check('an unpriced page Google sends traffic to stays in search, and says why', !gore.page.priced && gore.page.searchEarner && gore.page.inSearch, gore.page.why);
    const nobody = await get('?page=https://thecardhuddle.com/players/no-such-player/');
    check('an unpriced page with no clicks is out of search, with the thresholds named', !nobody.page.priced && !nobody.page.inSearch && /20 matched sales/.test(nobody.page.why));
  } finally { server.close(); }
  console.log(failures ? `\n${failures} price-coverage check(s) failed` : '\nall price-coverage checks passed');
  process.exit(failures ? 1 : 0);
})();
