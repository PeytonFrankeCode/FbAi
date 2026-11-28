// The auction watcher pilot (owner, Nov 2026). Its one job is to record what
// an auction REALLY sold for: the winning bid read after the end, never the
// price seen before it (owner: "what if the numbers are higher than what you
// saw it at?"). Runs the real tick against a SQLite stand-in for D1 and a
// stubbed eBay.
'use strict';
process.env.NODE_ENV = 'test';
process.env.CF_WORKER = '1';
process.env.EBAY_APP_ID = 'test-app';
process.env.EBAY_CERT_ID = 'test-cert';
const path = require('path');
let failures = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`); if (!ok) failures++; };
const ROOT = path.join(__dirname, '..');
const { DatabaseSync } = require('node:sqlite');
const axios = require('axios');

// D1's shape over node:sqlite.
const sql = new DatabaseSync(':memory:');
const stmt = (q, b = []) => ({
  bind: (...a) => stmt(q, a),
  run: async () => { sql.prepare(q).run(...b); return { success: true }; },
  all: async () => ({ results: sql.prepare(q).all(...b) }),
  first: async () => sql.prepare(q).get(...b) || null,
});
const fakeD1 = { prepare: (q) => stmt(q), batch: async (l) => Promise.all(l.map(s => s.run())), exec: async (q) => sql.exec(q) };
sql.exec(`CREATE TABLE sales (item_id TEXT PRIMARY KEY, price_cents INTEGER, title TEXT)`);

// eBay: three auctions about to end, then their results.
let clock = Date.parse('2026-11-28T12:00:00Z');
const realNow = Date.now;
Date.now = () => clock;
const end = (m) => new Date(clock + m * 60000).toISOString();
const live = [
  { itemId: 'v1|111|0', legacyItemId: '111', title: '2024 Prizm Bo Nix Silver PSA 10', itemEndDate: end(5), currentBidPrice: { value: '80.00' }, bidCount: 7 },
  { itemId: 'v1|222|0', legacyItemId: '222', title: '2023 Topps Chrome Elly De La Cruz', itemEndDate: end(6), currentBidPrice: { value: '20.00' }, bidCount: 3 },
  { itemId: 'v1|333|0', legacyItemId: '333', title: '2022 Hoops Paolo Banchero RC', itemEndDate: end(7), currentBidPrice: { value: '5.00' }, bidCount: 0 },
  { itemId: 'v1|444|0', legacyItemId: '444', title: '2021 Select Ja Morant', itemEndDate: end(8), currentBidPrice: { value: '50.00' }, bidCount: 4 },
];
const finals = {
  'v1|111|0': { itemId: 'v1|111|0', itemEndDate: end(5), currentBidPrice: { value: '112.50' }, bidCount: 15 },   // sniped up
  'v1|222|0': { itemId: 'v1|222|0', itemEndDate: end(6), currentBidPrice: { value: '20.00' }, bidCount: 3 },
  'v1|333|0': { itemId: 'v1|333|0', itemEndDate: end(7), currentBidPrice: { value: '5.00' }, bidCount: 0 },       // no bids: not a sale
  'v1|444|0': { itemId: 'v1|444|0', itemEndDate: end(8), currentBidPrice: { value: '61.00' }, bidCount: 6, reservePriceMet: false }, // reserve missed
};
let bulkRefused = false, bulkCalls = 0, singleCalls = 0;
axios.post = async () => ({ data: { access_token: 't', expires_in: 7200 } });
axios.get = async (url, opts = {}) => {
  if (url.endsWith('/item_summary/search')) return { data: { itemSummaries: live } };
  if (url.endsWith('/buy/browse/v1/item/')) {
    bulkCalls++;
    if (bulkRefused) { const e = new Error('403'); e.response = { status: 403 }; throw e; }
    const ids = String(opts.params.item_ids).split(',');
    return { data: { items: ids.map(i => finals[i]).filter(Boolean) } };
  }
  const m = url.match(/\/item\/([^/?]+)$/);
  if (m) { singleCalls++; const it = finals[decodeURIComponent(m[1])]; if (!it) { const e = new Error('404'); e.response = { status: 404 }; throw e; } return { data: it }; }
  throw new Error('unexpected ' + url);
};

const S = require(path.join(ROOT, 'server.js'));

(async () => {
  await S.connectDB({ NFLDB: fakeD1 });
  let r = await S.auctionPilotTick();
  check('a tick picks up to 4 auctions ending soon', r.watched === 4, JSON.stringify(r));
  const row = (id) => sql.prepare('SELECT * FROM auction_pilot WHERE legacy_id = ?').get(id);
  check('...watched, not sold: the price before the end is never a sale', row('111').status === 'watching' && row('111').final_price_cents == null && row('111').pre_price_cents === 8000);

  clock += 9 * 60000;   // 1 minute after the last one ended: too soon
  r = await S.auctionPilotTick();
  check('results are not read until 10 minutes after the end', r.resolved === 0 && row('111').status === 'watching', JSON.stringify(r));

  clock += 15 * 60000;
  r = await S.auctionPilotTick();
  check('after that, each auction is read again (bulk, 20 at a time)', r.resolved === 4 && r.method === 'bulk', JSON.stringify(r));
  check('the sold price is the FINAL winning bid, last-second bids included ($80 seen, $112.50 sold)', row('111').status === 'sold' && row('111').final_price_cents === 11250 && row('111').final_bids === 15);
  check('an auction with no bids is not a sale', row('333').status === 'unsold');
  check('an auction whose reserve was missed is not a sale', row('444').status === 'unsold' && row('444').reserve_met === 0);

  // The cross-check against The Card API's eBay sales of the same item numbers.
  sql.prepare('INSERT INTO sales VALUES (?,?,?)').run('111', 11250, 'x');
  sql.prepare('INSERT INTO sales VALUES (?,?,?)').run('222', 2100, 'x');
  const rep = await S._auctionPilotReport(fakeD1);
  check('the scorecard compares our sold prices with The Card API\'s for the same items', rep.crossCheck.matched === 2 && rep.crossCheck.exact === 1 && rep.crossCheck.exactPct === 50 && rep.crossCheck.passMark === 95, JSON.stringify(rep.crossCheck));
  check('...lists every mismatch with its eBay link', rep.crossCheck.mismatches[0].item === 'https://www.ebay.com/itm/222' && rep.crossCheck.mismatches[0].ours === 20 && rep.crossCheck.mismatches[0].cardApi === 21);
  check('...measures how often the final price beat the pre-end price', rep.snipes.sold === 2 && rep.snipes.finalAbovePreEnd === 1, JSON.stringify(rep.snipes));
  check('...and gives 20 recent sales with links for a spot check', rep.spotCheck.length === 2 && /ebay\.com\/itm\//.test(rep.spotCheck[0].item));

  // A week later, the same items are read once more.
  clock += 7 * 86400000 + 60000;
  delete finals['v1|222|0'];          // eBay stopped answering for one
  r = await S.auctionPilotTick();
  check('a week on, sold items are read again', r.weekChecked === 2 && row('111').week_price_cents === 11250 && row('222').week_price_cents === -1, JSON.stringify(r));

  // Bulk refused: one at a time, a few a tick.
  sql.exec(`DELETE FROM auction_pilot`);
  bulkRefused = true; clock += 60000;
  live.forEach((it, i) => { it.itemEndDate = end(5 + i); if (finals[it.itemId]) finals[it.itemId].itemEndDate = it.itemEndDate; });
  finals['v1|222|0'] = { itemId: 'v1|222|0', itemEndDate: live[1].itemEndDate, currentBidPrice: { value: '20.00' }, bidCount: 3 };
  await S.auctionPilotTick();
  clock += 20 * 60000;
  r = await S.auctionPilotTick();
  check('if eBay refuses the bulk read, results are read one at a time instead', r.method === 'single' && singleCalls > 0 && row('111').status === 'sold', JSON.stringify(r));

  process.env.AUCTION_PILOT = 'off';
  check('AUCTION_PILOT=off stops it', (await S.auctionPilotTick()).off === true);
  const rep2 = await S._auctionPilotReport(fakeD1);
  check('the scorecard shows the last run, errors included', rep2.lastTick && rep2.lastTick.off === true && rep2.lastTick.at, JSON.stringify(rep2.lastTick));
  Date.now = realNow;
  console.log(failures ? `\n${failures} auction-pilot check(s) failed` : '\nall auction-pilot checks passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
