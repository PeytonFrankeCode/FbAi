// "Load more" on For Sale results.
//
// Two ways it ended a list that had hundreds of listings left:
//   - "more?" was read off how many listings survived the junk and variant
//     filters, so a page of 40 that lost one (39) said "that's all";
//   - one dropped request from eBay ("Could not load more — Failed to fetch
//     from eBay") was final: the retry knew three Node error codes, and on
//     Workers a timeout or a 503 reports none of them.
// eBay's API is stubbed here, so each failure can be made to happen on cue.
const path = require('path');
const axios = require('axios');
process.env.EBAY_APP_ID = 'test-app';
process.env.EBAY_CERT_ID = 'test-cert';
process.env.CF_WORKER = '1';

const dbMod = require(path.join(__dirname, '..', 'db.js'));
dbMod.cacheGet = async () => null;
dbMod.cachePut = () => {};

let calls = [];
let script = [];   // what the next Browse calls do, in order
const page = (offset, n) => ({
  data: {
    total: 500,
    itemSummaries: Array.from({ length: n }, (_, i) => ({
      itemId: `v1|${offset + i}|0`, title: `2023-24 Panini Prizm Victor Wembanyama #136 Rookie RC ${offset + i}`,
      price: { value: '25.00', currency: 'USD' }, itemWebUrl: 'https://www.ebay.com/itm/1', buyingOptions: ['FIXED_PRICE'],
    })),
  },
});
axios.post = async () => ({ data: { access_token: 'tok', expires_in: 7200 } });
axios.get = async (url, cfg) => {
  const offset = cfg.params.offset;
  calls.push(offset);
  const step = script.shift();
  if (step && step.fail) { const e = new Error('Request failed'); if (step.fail !== 'network') e.response = { status: step.fail, data: {}, headers: {} }; throw e; }
  const r = page(offset, step && step.n != null ? step.n : cfg.params.limit);
  // One listing the junk filter removes, as in real pages.
  if (step && step.junk) r.data.itemSummaries[0].title = 'Victor Wembanyama REPRINT custom card';
  return r;
};

const { app } = require(path.join(__dirname, '..', 'server.js'));
const PORT = 3223;
const server = app.listen(PORT);
const call = async (q) => {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/search?${new URLSearchParams(q)}`);
  return { status: r.status, body: await r.json() };
};
const Q = { q: '2023-24 Prizm Victor Wembanyama', mode: 'forsale', limit: '40' };

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

(async () => {
  calls = []; script = [{ junk: true }];
  const a = await call({ ...Q, offset: '40' });
  check('a page the filters trimmed (39 of 40) is not the end of the list: eBay\'s total says 500',
    a.status === 200 && a.body.hasMore === true && a.body.results.length < 40, `${a.body.results.length} shown, hasMore ${a.body.hasMore}`);
  check('  ...and the next page starts where eBay\'s ended, not after the survivors', a.body.nextOffset === 80, `nextOffset ${a.body.nextOffset}`);

  calls = []; script = [{ n: 20 }];
  const end = await call({ ...Q, offset: '480' });
  check('the last page of eBay\'s 500 does end it', end.body.hasMore === false, `hasMore ${end.body.hasMore}`);

  calls = []; script = [{ fail: 503 }, {}];
  const b = await call({ ...Q, offset: '120' });
  check('a 503 from eBay is retried, and the page arrives', b.status === 200 && b.body.results.length > 0 && calls.length === 2, `${calls.length} calls, HTTP ${b.status}`);

  calls = []; script = [{ fail: 'network' }, {}];
  const c = await call({ ...Q, offset: '160' });
  check('  ...as is a dropped connection with no error code (how Workers reports one)', c.status === 200 && calls.length === 2, `${calls.length} calls`);

  calls = []; script = [{ fail: 429 }, { fail: 429 }, {}];
  const d = await call({ ...Q, offset: '200' });
  check('  ...and a 429, twice', d.status === 200 && calls.length === 3, `${calls.length} calls`);

  calls = []; script = [{ fail: 400 }, {}];
  const e = await call({ ...Q, offset: '240' });
  check('a 400 is not retried: the query is wrong, and asking again repeats it', e.status === 400 && calls.length === 1, `${calls.length} calls, HTTP ${e.status}`);

  calls = []; script = [{}];
  await call({ ...Q, offset: '600' });
  check('pages past 500 are asked for, not clamped to page 500 again', calls[0] === 600, `asked eBay for offset ${calls[0]}`);

  const fs = require('fs');
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  check('the page follows the server\'s next offset and drops listings it already shows',
    /_forsalePaging\.offset = data\.nextOffset \|\| _forsalePaging\.offset \+ 40;/.test(js) && /filter\(r => !seen\.has\(r\.itemId\)\)/.test(js));
  check('  ...and a failed page offers Try again instead of ending the list',
    /_loadMoreFailed\(grid, \(\) => loadMoreForsaleResults\(grid\)\)/.test(js) && /_loadMoreFailed\(grid, \(\) => fetchMoreFromServer\(grid\)\)/.test(js)
      && !/Could not load more/.test(js));

  server.close();
  console.log(failures ? `\n${failures} check(s) failed` : '\nall load-more checks passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('THREW:', e && e.stack || e); server.close(); process.exit(1); });
