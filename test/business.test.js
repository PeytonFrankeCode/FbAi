// Card Huddle for Business (owner, Oct 2026): a seller's inventory priced
// against our sold data, the daily brief, and the admin gate while in build.
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};
const B = require(path.join(__dirname, '..', 'business-core.js'));
const DAY = 86400000, now = Date.now();
const iso = (o) => new Date(now + o * DAY).toISOString().slice(0, 10);

// ---- pure ----
const csvRow = B.normalizeItem({ 'Title': '2024 Prizm Bo Nix Silver #309 PSA 10', 'Current price': '$1,250.00', 'Quantity available': '2', 'Start date': '2026-06-01' });
check('an eBay export row is read: title, grade from the title, price, quantity, date',
  csvRow.title.startsWith('2024 Prizm') && csvRow.grade === 'PSA 10' && csvRow.price === 1250 && csvRow.qty === 2 && csvRow.listedAt.startsWith('2026-06-01'), JSON.stringify(csvRow));
check('  ...and a row with no title is nothing', B.normalizeItem({ price: 5 }) === null);
const raw = { title: 'x', grade: null };
const sales = [40, 42, 38, 300, 41].map((p, i) => ({ price: p, soldDate: iso(-i - 1), grade: null, grader: null, condition: 'Ungraded' }))
  .concat([{ price: 900, soldDate: iso(-2), grade: '10', grader: 'PSA', condition: 'PSA 10' }]);
const v = B.valueFromSales(raw, sales, now);
check('a raw card is priced from raw sales only, by median (one stray $300 does not move it)', v.market === 41 && v.n === 5, JSON.stringify(v));
check('  ...a PSA 10 from PSA 10 sales only, and too few is no price, not a guess',
  B.valueFromSales({ title: 'x', grade: 'PSA 10' }, sales, now).market === null && B.valueFromSales({ title: 'x', grade: 'PSA 10' }, sales, now).n === 1);
const items = [
  { id: 'aaaaaa1', title: 'Over', qty: 1, price: 80, cost: 20, listedAt: new Date(now - 40 * DAY).toISOString(), value: { market: 50, n: 6, low: 40, high: 60 } },
  { id: 'aaaaaa2', title: 'Under', qty: 1, price: 30, cost: 10, listedAt: new Date(now - 3 * DAY).toISOString(), value: { market: 50, n: 6, low: 45, high: 55 } },
  { id: 'aaaaaa3', title: 'Old', qty: 4, price: 5, cost: 1, listedAt: new Date(now - 120 * DAY).toISOString(), value: { market: 5, n: 4 } },
];
const br = B.analyze(items, now);
check('the brief says reprice the stale overpriced card, raise the underpriced one, and names dead stock',
  br.actions.some(a => a.kind === 'reprice' && a.id === 'aaaaaa1' && a.suggest === 50) && br.actions.some(a => a.kind === 'underpriced' && a.id === 'aaaaaa2')
  && br.actions.some(a => a.kind === 'dead') && br.kpis.marketValue === 120 && br.kpis.deadStock === 4, JSON.stringify(br.kpis));
check('  ...biggest dollars first', br.actions[0].dollars >= br.actions[br.actions.length - 1].dollars);
check('the AI is given the totals, the actions and the inventory table', /Totals: .*marketValue/.test(B.aiContext(items, br)) && /Over \| raw \| 1 \| 20 \| 80 \| 50/.test(B.aiContext(items, br)));

// eBay sync: kept, updated, added, ended; other platforms untouched.
const held = [
  { id: 'eb00001', title: 'Old title PSA 9', ebayItemId: '111', cost: 12, price: 30, qty: 1, platform: 'eBay', value: { market: 25 } },
  { id: 'eb00002', title: 'Sold one', ebayItemId: '222', cost: 5, price: 10, qty: 1, platform: 'eBay' },
  { id: 'wn00001', title: 'Whatnot card', cost: 3, price: 8, qty: 1, platform: 'Whatnot' },
];
const mg = B.mergeEbay(held, [
  { ebayItemId: '111', title: 'New title PSA 10', price: 35 },
  { ebayItemId: '333', title: '2024 Prizm Caleb Williams Silver', price: 22, listedAt: '2026-09-01T00:00:00Z' },
], now);
const k1 = mg.items.find(i => i.id === 'eb00001');
check('a sync keeps a held listing (its cost), takes the new price and title, and re-prices a retitled one',
  k1 && k1.cost === 12 && k1.price === 35 && k1.grade === 'PSA 10' && !k1.value, JSON.stringify(k1));
check('  ...adds new listings, moves the ones gone from eBay to ended, and leaves Whatnot cards alone',
  mg.added === 1 && mg.items.some(i => i.ebayItemId === '333' && i.platform === 'eBay') && mg.ended.length === 1 && mg.ended[0].ebayItemId === '222'
  && mg.items.some(i => i.id === 'wn00001'));

// Sales: fees, profit, groupings; a sale with no cost is revenue, not profit.
const rep = B.salesReport([
  { id: 's1', title: 'A', soldFor: 100, cost: 40, platform: 'eBay', player: 'Bo Nix', set: '2024 Prizm', soldAt: new Date(now - 2 * DAY).toISOString() },
  { id: 's2', title: 'B', soldFor: 50, cost: 60, platform: 'Whatnot', player: 'Bo Nix', set: '2024 Prizm', soldAt: new Date(now - 5 * DAY).toISOString() },
  { id: 's3', title: 'C', soldFor: 20, platform: 'Shop', player: 'Cam Ward', soldAt: new Date(now - 60 * DAY).toISOString() },
], now);
check('eBay and Whatnot fees are estimated; profit is after fees and cost',
  B.feeFor('eBay', 100) === 13.65 && B.feeFor('Whatnot', 50) === 5.75 && B.feeFor('Shop', 20) === 0
  && rep.last30.sales === 2 && rep.last30.profit === round2(100 - 13.65 - 40 + 50 - 5.75 - 60), JSON.stringify(rep.last30));
check('  ...grouped by player and set, a sale with no cost counted as missing, and losses listed',
  rep.byPlayer[0].name === 'Bo Nix' && rep.byPlayer[0].sales === 2 && rep.allTime.missingCost === 1 && rep.worst.length === 1 && rep.worst[0].title === 'B');
function round2(n) { return Math.round(n * 100) / 100; }

// ---- server ----
const db = new DatabaseSync(':memory:');
db.exec(`CREATE TABLE sales (item_id TEXT, sold_date TEXT, title TEXT, price_cents INTEGER, currency TEXT, listing_format TEXT, grader TEXT, grade TEXT,
  player TEXT, parallel TEXT, year TEXT, set_name TEXT, card_number TEXT, confidence REAL, best_offer INTEGER, bids INTEGER, image_url TEXT)`);
const ins = db.prepare(`INSERT INTO sales (item_id, sold_date, title, price_cents, player, year, set_name, parallel, card_number, confidence) VALUES (?,?,?,?,'Bo Nix','2024','Prizm','Silver','309',0.9)`);
[4000, 4200, 3900, 4100, 4300].forEach((c, i) => ins.run(String(700000 + i), iso(-i - 1), '2024 Panini Prizm Bo Nix Silver #309 RC', c));
const d1 = { prepare(sql) { let b = []; const api = { bind(...a) { b = a; return api; }, async all() { return { results: db.prepare(sql).all(...b) }; },
  async first() { return db.prepare(sql).get(...b) || null; }, async run() { return { success: true }; } }; return api; } };
const dbMod = require(path.join(__dirname, '..', 'db.js'));
dbMod.getNflDb = () => d1;
process.env.CF_WORKER = '1';
process.env.ADMIN_PASSWORD = 'test-key-for-business';
const S = require(path.join(__dirname, '..', 'server.js'));
const server = S.app.listen(0);
const port = server.address().port;
const K = { 'x-admin-key': process.env.ADMIN_PASSWORD, 'content-type': 'application/json' };
const call = async (p, o = {}) => { const r = await fetch(`http://127.0.0.1:${port}${p}`, o); return { status: r.status, body: await r.json().catch(() => ({})) }; };
(async () => {
  check('the business API is closed without the admin key', (await call('/api/biz/inventory')).status === 401 && (await call('/api/biz/brief')).status === 401);
  await call('/api/biz/inventory', { method: 'POST', headers: K, body: JSON.stringify({ mode: 'replace', items: [{ title: '2024 Prizm Bo Nix Silver #309', price: 80, cost: 20, listed: new Date(now - 30 * DAY).toISOString() }] }) });
  const val = await call('/api/biz/value', { method: 'POST', headers: K, body: '{}' });
  const inv = await call('/api/biz/inventory', { headers: K });
  const it = inv.body.items[0];
  check('an imported card is priced from our own sales', val.body.valued === 1 && it.value && it.value.market === 41 && it.value.n === 5, JSON.stringify(it.value));
  const brief = await call('/api/biz/brief', { headers: K });
  check('  ...and the brief tells the seller to reprice it to the market', brief.body.actions.some(a => a.kind === 'reprice' && a.suggest === 41));
  const p = await call('/api/biz/inventory/' + it.id, { method: 'PATCH', headers: K, body: JSON.stringify({ price: 41 }) });
  check('  ...which one tap does', p.body.item && p.body.item.price === 41);
  await call('/api/biz/inventory/' + it.id, { method: 'PATCH', headers: K, body: JSON.stringify({ sold: true, soldFor: 45 }) });
  const sales = await call('/api/biz/sales', { headers: K });
  const sale = sales.body.sold[0];
  check('marking a card sold records the sale with its player and set, and the report counts it',
    sale && sale.soldFor === 45 && sale.player === 'Bo Nix' && /Prizm/.test(sale.set || '') && sales.body.report.allTime.sales === 1
    && sales.body.report.allTime.profit === round2(45 - B.feeFor(null, 45) - 20), JSON.stringify(sale && { p: sale.player, s: sale.set, r: sales.body.report.allTime }));
  const noSeller = await call('/api/biz/ebay-sync', { method: 'POST', headers: K, body: JSON.stringify({ seller: '' }) });
  check('an eBay sync with no username asks for one', noSeller.status === 400 && /eBay username/.test(noSeller.body.error));
  delete process.env.ANTHROPIC_API_KEY;
  const ask = await call('/api/biz/ask', { method: 'POST', headers: K, body: JSON.stringify({ q: 'What is my dead stock?' }) });
  check('asking with no AI set up says what is missing', ask.status === 503 && /ANTHROPIC_API_KEY or Workers AI/.test(ask.body.error));
  const cmp = await call('/api/biz/compare', { method: 'POST', headers: K, body: JSON.stringify({ q: 'What is my dead stock?' }) });
  check('the owner can ask both AIs at once; with neither set up each says why, side by side',
    cmp.status === 200 && /ANTHROPIC_API_KEY/.test(cmp.body.anthropic.error || '') && /Workers AI/.test(cmp.body.workers.error || '')
    && cmp.body.anthropic.model === 'claude-haiku-5-5', JSON.stringify(cmp.body));
  const sum = await call('/api/biz/summary', { headers: K });
  check('with no AI key the morning summary is simply left out', sum.status === 200 && sum.body.summary === null && sum.body.reason === 'no-key');
  const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'business.html'), 'utf8');
  check('the page is a public landing page (indexed) with the waitlist, and still signs in with the admin key', /index, follow/.test(page) && /id="waitlist"/.test(page) && /Admin key/.test(page));
  const w = fs.readFileSync(path.join(__dirname, '..', 'worker.js'), 'utf8');
  check('  ...and /business is a page the Worker serves', /'business'/.test(w.slice(w.indexOf('STATIC_PAGES'), w.indexOf('STATIC_PAGES') + 400)));
  // Accounts: a signed-in seller with Business has their own inventory; one
  // without is asked to subscribe; Business never overwrites the ad-free plan.
  dbMod.saveData('sessions', null, { tokPaid: { username: 'seller1', expiresAt: now + DAY }, tokFree: { username: 'seller2', expiresAt: now + DAY } });
  dbMod.saveData('subscriptions', null, { seller1: { plan: 'adfree', status: 'active', stripeCustomerId: 'cus_1',
    business: { status: 'active', stripeSubscriptionId: 'sub_biz', stripeCustomerId: 'cus_1' } }, seller2: {} });
  const P = { Authorization: 'Bearer tokPaid', 'content-type': 'application/json' };
  const free = await call('/api/biz/inventory', { headers: { Authorization: 'Bearer tokFree' } });
  check('a signed-in account without Business is asked to subscribe ($20 a month)', free.status === 402 && free.body.needs === 'subscribe');
  check('  ...and no account at all is asked to log in', (await call('/api/biz/inventory')).body.needs === 'login');
  await call('/api/biz/inventory', { method: 'POST', headers: P, body: JSON.stringify({ items: [{ title: 'Seller one card', price: 5 }] }) });
  const mine = await call('/api/biz/inventory', { headers: P });
  const owners = await call('/api/biz/inventory', { headers: K });
  check('a paying seller works their own inventory, apart from the owner\'s',
    mine.body.items.length === 1 && mine.body.items[0].title === 'Seller one card' && !owners.body.items.some(i => i.title === 'Seller one card'));
  const me = await call('/api/biz/me', { headers: { Authorization: 'Bearer tokPaid' } });
  check('  ...and the page knows who they are; checkout stays closed until the owner opens it',
    me.body.user === 'seller1' && me.body.active === true && me.body.checkoutOpen === false
    && (await call('/api/biz/checkout', { method: 'POST', headers: P, body: '{}' })).status === 503);
  const subs = { seller1: { plan: 'adfree', status: 'active', stripeCustomerId: 'cus_1', business: { status: 'active', stripeSubscriptionId: 'sub_biz' } } };
  check('cancelling Business cancels Business only, never the ad-free plan on the same customer',
    S._bizSubEvent(subs, { id: 'sub_biz', customer: 'cus_1' }, 'cancelled') && subs.seller1.business.status === 'cancelled' && subs.seller1.status === 'active'
    && !S._bizSubEvent(subs, { id: 'sub_adfree', customer: 'cus_1', metadata: { plan: 'adfree' } }, 'cancelled'));
  const J = { 'content-type': 'application/json' };
  const w1 = await call('/api/biz/waitlist', { method: 'POST', headers: J, body: JSON.stringify({ email: 'Seller@Example.com', where: 'Whatnot', size: '250 to 1,000' }) });
  const w2 = await call('/api/biz/waitlist', { method: 'POST', headers: J, body: JSON.stringify({ email: 'seller@example.com', where: 'eBay' }) });
  const bad = await call('/api/biz/waitlist', { method: 'POST', headers: J, body: JSON.stringify({ email: 'nope' }) });
  const bot = await call('/api/biz/waitlist', { method: 'POST', headers: J, body: JSON.stringify({ email: 'bot@example.com', website: 'x' }) });
  const list = await call('/api/biz/waitlist', { headers: K });
  check('anyone can join the waitlist once (re-joining updates it), bots and bad emails are not added',
    w1.body.ok && !w1.body.already && w2.body.already && bad.status === 400 && bot.body.ok
    && list.body.count === 1 && list.body.rows[0].email === 'seller@example.com' && list.body.rows[0].where === 'eBay', JSON.stringify(list.body));
  check('  ...and only the owner can read it', (await call('/api/biz/waitlist')).status === 401);
  await call('/api/biz/inventory/all', { method: 'DELETE', headers: K });
  server.close();
  console.log(failures ? `\n${failures} check(s) failed` : '\nall business checks passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
