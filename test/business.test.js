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
  delete process.env.ANTHROPIC_API_KEY;
  const ask = await call('/api/biz/ask', { method: 'POST', headers: K, body: JSON.stringify({ q: 'What is my dead stock?' }) });
  check('asking without an AI key says what is missing', ask.status === 503 && /ANTHROPIC_API_KEY/.test(ask.body.error));
  const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'business.html'), 'utf8');
  check('the page is noindex and signs in with the admin key', /noindex, nofollow/.test(page) && /Admin key/.test(page));
  const w = fs.readFileSync(path.join(__dirname, '..', 'worker.js'), 'utf8');
  check('  ...and /business is a page the Worker serves', /'business'/.test(w.slice(w.indexOf('STATIC_PAGES'), w.indexOf('STATIC_PAGES') + 400)));
  await call('/api/biz/inventory/all', { method: 'DELETE', headers: K });
  server.close();
  console.log(failures ? `\n${failures} check(s) failed` : '\nall business checks passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
