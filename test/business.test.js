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

// Bulk reprice: to market, undercut, .99 endings, never below cost; eBay file.
const rp = B.repricePlan([
  { id: 'r1', title: 'Over', price: 80, cost: 20, ebayItemId: '111', value: { market: 50, n: 5 } },
  { id: 'r2', title: 'Under', price: 30, cost: 49, value: { market: 50, n: 5 } },
  { id: 'r3', title: 'Fine', price: 52, value: { market: 50, n: 5 } },
  { id: 'r4', title: 'Thin', price: 10, value: { market: 50, n: 2 } },
], { undercut: 5, end99: true });
check('bulk reprice moves over- and under-priced cards to market (5% under, .99), never below cost, skipping fine and thin ones',
  rp.length === 2 && rp.find(p => p.id === 'r1').to === 47.99 && rp.find(p => p.id === 'r2').to === 49 && !rp.some(p => p.id === 'r3' || p.id === 'r4'), JSON.stringify(rp));
check('  ...and writes the eBay listings into an eBay bulk-edit file',
  B.ebayReviseCsv(rp) === 'Action(SiteID=US|Country=US|Currency=USD|Version=1193),ItemID,StartPrice\nRevise,111,47.99\n');
check('  ..."only lower" leaves underpriced cards alone', B.repricePlan([{ id: 'x', price: 30, value: { market: 50, n: 5 } }], { mode: 'over' }).length === 0);

// Show tools: the feature list ranks value with heat; a buy offer prices
// what it can and leaves the rest out.
const sl = B.showList([
  { id: 'a', title: 'Steady', value: { market: 100, trend: 0 } },
  { id: 'b', title: 'Hot', value: { market: 90, trend: 20 } },
  { id: 'c', title: 'Cheap', value: { market: 5 } },
  { id: 'd', title: 'Unpriced', value: { market: null } },
], 10, 10);
check('the feature list puts a hot card above a slightly dearer steady one, and drops cheap and unpriced cards',
  sl.map(x => x.id).join() === 'b,a', sl.map(x => x.id).join());
const bo = B.buyOffer([{ title: 'A', value: { market: 100, n: 5 } }, { title: 'B', qty: 2, value: { market: 25, n: 4 } }, { title: 'C', value: { market: null, n: 1 } }], 60);
check('a buy offer is 60% of the priced market value, the unpriced card listed apart',
  bo.market === 150 && bo.offer === 90 && bo.cards.length === 2 && bo.unpriced.length === 1 && bo.unpriced[0].title === 'C', JSON.stringify(bo));

// Health: money-weighted parts that add to 100, with what would raise it.
const hh = B.health([
  { title: 'Right', price: 50, cost: 10, listedAt: new Date(now - 5 * DAY).toISOString(), value: { market: 50, n: 5 } },
  { title: 'Off and old', price: 90, listedAt: new Date(now - 120 * DAY).toISOString(), value: { market: 50, n: 5 } },
], now);
check('inventory health: a well-priced fresh card with a cost scores full marks, an overpriced dead one drags it down',
  B.health([{ title: 'x', price: 50, cost: 10, listedAt: new Date(now).toISOString(), value: { market: 50, n: 5 } }], now).score === 100
  && hh.score < 70 && hh.parts.priced === 20 && hh.tips[0].part === 'priced' && /Reprice 1 card off/.test(hh.tips[0].text), JSON.stringify(hh));
check('  ...and an empty inventory has no score', B.health([], now) === null);

// A lot's cost spread over its cards: by value when known, else evenly, to
// the cent.
const lot = B.splitLotCost([{ id: 'a', value: { market: 150 } }, { id: 'b', value: { market: 2 } }, { id: 'c', qty: 3, value: { market: 16 } }], 200);
const even = B.splitLotCost([{ id: 'a' }, { id: 'b' }, { id: 'c' }], 100);
check('a $200 lot is spread by market value; one with unknown values evenly, adding back to the cent',
  lot.find(x => x.id === 'a').cost === 150 && lot.find(x => x.id === 'c').cost === 16 && lot[0].by === 'value'
  && even.map(x => x.cost).join() === '33.34,33.33,33.33' && even[0].by === 'even');

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
  check('the brief carries the health score and keeps a reading for the day', brief.body.health && Number.isFinite(brief.body.health.score) && brief.body.health.history.length === 1);
  check('  ...and the brief tells the seller to reprice it to the market', brief.body.actions.some(a => a.kind === 'reprice' && a.suggest === 41));
  const p = await call('/api/biz/inventory/' + it.id, { method: 'PATCH', headers: K, body: JSON.stringify({ price: 41 }) });
  check('  ...which one tap does', p.body.item && p.body.item.price === 41);
  await call('/api/biz/inventory/' + it.id, { method: 'PATCH', headers: K, body: JSON.stringify({ sold: true, soldFor: 45 }) });
  await call('/api/biz/inventory', { method: 'POST', headers: K, body: JSON.stringify({ items: [{ title: 'Lot card one' }, { title: 'Lot card two' }] }) });
  const lotItems = (await call('/api/biz/inventory', { headers: K })).body.items.filter(i => /^Lot card/.test(i.title));
  const cs = await call('/api/biz/costs', { method: 'POST', headers: K, body: JSON.stringify({ ids: lotItems.map(i => i.id), lot: 30 }) });
  const after = (await call('/api/biz/inventory', { headers: K })).body.items.filter(i => /^Lot card/.test(i.title));
  const one = await call('/api/biz/inventory/' + lotItems[0].id, { method: 'PATCH', headers: K, body: JSON.stringify({ cost: 4.5 }) });
  check('a lot cost is spread over the ticked cards, and one card\'s cost can be edited on its own',
    cs.body.updated === 2 && after.every(i => i.cost === 15) && one.body.item.cost === 4.5);
  for (const i of lotItems) await call('/api/biz/inventory/' + i.id, { method: 'DELETE', headers: K });
  const pv = await call('/api/biz/reprice', { method: 'POST', headers: K, body: JSON.stringify({}) });
  check('the reprice preview returns a plan', Array.isArray(pv.body.plan) && pv.body.ebayRows === 0);
  const off = await call('/api/biz/offer', { method: 'POST', headers: K, body: JSON.stringify({ cards: ['2024 Prizm Bo Nix Silver #309', 'Zzyzx Nobody Card'], pct: 60 }) });
  check('the buy-offer calculator prices a walk-in card from our sales and says which it cannot',
    off.body.market === 41 && off.body.offer === 24.6 && off.body.unpriced.length === 1, JSON.stringify(off.body));
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

  // Price alerts: a 15%+ market move on 3+ sales either side, never on thin data.
  const pa = B.priceAlert({ id: 'x', title: 'T', price: 40 }, { market: 40, n: 5 }, { market: 60, n: 6 }, now);
  check('a price alert fires on a 15%+ move with enough sales, not on a small move or thin sales',
    pa && pa.pct === 50 && pa.from === 40 && pa.to === 60
    && !B.priceAlert({ id: 'x' }, { market: 40, n: 5 }, { market: 44, n: 5 }) && !B.priceAlert({ id: 'x' }, { market: 40, n: 2 }, { market: 80, n: 5 })
    && /up 50% to \$60\.00/.test(B.alertText(pa)), JSON.stringify(pa));
  await call('/api/biz/inventory', { method: 'POST', headers: K, body: JSON.stringify({ mode: 'replace', items: [{ title: '2024 Prizm Bo Nix Silver #309', price: 40 }] }) });
  await call('/api/biz/value', { method: 'POST', headers: K, body: '{}' });
  [6000, 6100, 5900, 6000, 6050, 6000].forEach((c, i) => ins.run(String(710000 + i), iso(-i - 1), '2024 Panini Prizm Bo Nix Silver #309 RC', c));
  const pushed = [];
  const run = await S.bizRevalueAll({ now: now + 13 * 3600000, push: async (u, m) => pushed.push([u, m]) });
  const al = await call('/api/biz/alerts', { headers: K });
  check('the daily re-price finds the move and keeps it as an alert (owner gets no push)',
    run.alerts === 1 && al.body.alerts.length === 1 && al.body.alerts[0].pct > 15 && pushed.length === 0, JSON.stringify([run, al.body]));
  const sellerInv = { items: [{ id: 'z', title: '2024 Prizm Bo Nix Silver #309', value: { market: 20, n: 5 } }] };
  const fresh = await S._bizRevalue('u:seller', sellerInv, sellerInv.items, now, { push: async (u, m) => pushed.push([u, m]) });
  check('  ...and a seller gets it on their phone, pointing at /business',
    fresh.length === 1 && pushed.length === 1 && pushed[0][0] === 'seller' && pushed[0][1].url === '/business' && /market up/.test(pushed[0][1].body), JSON.stringify(pushed));
  const dis = await call('/api/biz/alerts/' + al.body.alerts[0].id, { method: 'DELETE', headers: K });
  check('  ...and dismissing it clears it', dis.body.alerts.length === 0);
  {
    // Ask looks up the rest of Card Huddle with tools (owner, Oct 2026): a
    // stand-in Claude asks for a card's sales, the market and a player's cards,
    // then answers from what came back.
    const calls = [];
    let script = [];
    S._bizSetClient({ messages: { create: async (body) => { calls.push(JSON.parse(JSON.stringify(body))); return script.shift() || { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] }; } } });
    process.env.ANTHROPIC_API_KEY = 'test'; process.env.BIZ_AI_PROVIDER = 'anthropic';
    script = [
      { stop_reason: 'tool_use', content: [
        { type: 'tool_use', id: 't1', name: 'search_sold_sales', input: { query: '2024 Prizm Bo Nix Silver #309' } },
        { type: 'tool_use', id: 't2', name: 'market_index', input: { days: 30 } },
        { type: 'tool_use', id: 't3', name: 'player_cards', input: { player: 'Bo Nix' } }] },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Bo Nix Silvers sell for about $60.' }] },
    ];
    const a1 = await call('/api/biz/ask', { method: 'POST', headers: K, body: JSON.stringify({ q: 'What is a Bo Nix Silver worth?' }) });
    const back = calls[1] && calls[1].messages[calls[1].messages.length - 1].content;
    const sold = back && JSON.parse(back.find(b => b.tool_use_id === 't1').content);
    check('Ask can look up any card\'s sales, the market and a player, then answers from them',
      a1.body.answer === 'Bo Nix Silvers sell for about $60.' && calls.length === 2
      && calls[0].tools.map(t => t.name).join() === 'search_sold_sales,price_estimate,market_index,player_trend,player_cards'
      && calls[0].tool_choice.type === 'auto' && back.length === 3
      && sold.matched >= 5 && sold.median > 0 && sold.sales[0].date && !/imageUrl/.test(back.find(b => b.tool_use_id === 't1').content)
      && !/^\{"error"/.test(back.find(b => b.tool_use_id === 't2').content) && /Bo Nix/.test(back.find(b => b.tool_use_id === 't3').content),
      JSON.stringify({ answer: a1.body, back: back && back.map(b => b.content.slice(0, 160)) }));
    calls.length = 0;
    script = Array.from({ length: 9 }, (_, k) => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'x' + k, name: 'price_estimate', input: { query: 'Bo Nix Prizm' } }] }));
    script[4] = { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Answer after looking.' }] };
    const a2 = await call('/api/biz/ask', { method: 'POST', headers: K, body: JSON.stringify({ q: 'Keep looking' }) });
    check('  ...and after 4 rounds of lookups it must answer', a2.body.answer === 'Answer after looking.' && calls.length === 5 && calls[4].tool_choice.type === 'none', JSON.stringify(calls.map(c => c.tool_choice)));
    check('  ...a tool answer is capped and never carries photos', S._bizToolText({ imageUrl: 'x', rows: Array.from({ length: 500 }, (_, k) => ({ k, title: 'y'.repeat(300) })) }).length <= 9010);
    calls.length = 0; script = [];
    await call('/api/biz/summary?fresh=1', { headers: K });
    check('  ...while the morning summary stays a single, cheaper call with no tools', calls.length === 1 && !calls[0].tools);
    S._bizSetClient(null); delete process.env.ANTHROPIC_API_KEY; delete process.env.BIZ_AI_PROVIDER;
  }
  const bjs = fs.readFileSync(path.join(__dirname, '..', 'public', 'business.js'), 'utf8');
  check('Today shows the alerts with a set-price and dismiss', /\/api\/biz\/alerts/.test(bjs) && /data-dismiss/.test(bjs));
  {
    // The morning summary is a bulleted list with bold labels (owner, Oct 2026).
    const i = bjs.indexOf('function summaryHtml('), j = bjs.indexOf('\n  }\n', i);
    const esc = (x) => String(x).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const summaryHtml = new Function('esc', bjs.slice(i, j + 4) + '; return summaryHtml;')(esc);
    const html = summaryHtml('- Reprice: Smith is $13 under market.\n- **Check first:** the $12,000 Wembanyama <listing>.\n- Going well: Smith is up 76%.');
    check('the morning summary renders as a list, labels in bold, text escaped',
      (html.match(/<li>/g) || []).length === 3 && /<li><b>Reprice:<\/b> Smith/.test(html) && /<b>Check first:<\/b>/.test(html) && /&lt;listing&gt;/.test(html), html);
    check('  ...an older paragraph summary still shows as a paragraph', summaryHtml('Plain text.') === '<p>Plain text.</p>');
    const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const bpage = fs.readFileSync(path.join(__dirname, '..', 'public', 'business.html'), 'utf8');
    check('Ask is a chat bubble in the corner, not a tab, and shows it is thinking while it works',
      /id="aifab"/.test(bpage) && /id="aipanel"/.test(bpage) && !/data-tab="ask"/.test(bpage) && /@keyframes aidot/.test(bpage)
      && /function thinking\(\)/.test(bjs) && /Checking real sold prices/.test(bjs) && /prefers-reduced-motion: reduce/.test(bpage));
    {
      // Answers read easily: lead sentence, labelled list, dollar figures picked out, all escaped.
      const fi = bjs.indexOf('  function fmt('), fj = bjs.indexOf('\n  }\n', fi);
      const fmt = new Function('esc', bjs.slice(fi, fj + 4) + '; return fmt;')(esc);
      const out = fmt('Five cards need a look.\n- **Underpriced:** Allen is $5.99 against about $6, up 1,336%.\n- Over market: Purdy is $1,729.99 <b>.\n1. First\n2. Second');
      check('an AI answer renders as a lead line, a labelled list and a numbered list, with dollars marked and text escaped',
        /^<p>Five cards need a look\.<\/p><ul><li><b>Underpriced:<\/b> Allen is <span class="amt">\$5\.99<\/span> against about <span class="amt">\$6<\/span>,/.test(out)
        && /<li><b>Over market:<\/b> Purdy is <span class="amt">\$1,729\.99<\/span> &lt;b&gt;\.<\/li><\/ul><ol><li>First<\/li><li>Second<\/li><\/ol>$/.test(out)
        && !/\*\*/.test(out), out);
      check('  ...and the words type out once it arrives', /function typeOut\(/.test(bjs) && /\.tw\.on/.test(bpage)
        && /\*\*Short label:\*\*/.test(fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8')));
    }
    check('  ...and the AI is asked for labelled bullets', /morning summary as 3 to 5 bullet points, one per line, each starting with "- "/.test(srv));
  }
  const wk = fs.readFileSync(path.join(__dirname, '..', 'worker.js'), 'utf8');
  check('the cron runs the re-price, wired through init()', /flushTraffic, bizRevalueAll \} = await init\(env\)/.test(wk) && /await bizRevalueAll\(\)/.test(wk));
  await call('/api/biz/inventory/all', { method: 'DELETE', headers: K });
  server.close();
  console.log(failures ? `\n${failures} check(s) failed` : '\nall business checks passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
