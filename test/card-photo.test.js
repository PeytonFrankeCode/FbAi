// A sale whose eBay photo is gone gets another photo of the same card, from
// eBay itself, or a tile naming the card (server.js /api/card-photo, app.js
// _photoGone). Oct 2026: we keep no copies of sellers' photos, and a card that
// sells once a quarter had every row go grey once eBay dropped the photos.
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

const db = new DatabaseSync(':memory:');
db.exec(`CREATE TABLE sales (item_id TEXT, sold_date TEXT, title TEXT, price_cents INTEGER, player TEXT,
  year TEXT, set_name TEXT, parallel TEXT, card_number TEXT, grader TEXT, grade TEXT, confidence REAL, image_url TEXT)`);
const DAY = 86400000;
const iso = (o) => new Date(Date.now() + o * DAY).toISOString().slice(0, 10);
const ins = db.prepare(`INSERT INTO sales VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
const img = (k) => `https://i.ebayimg.com/images/g/${k}/s-l500.jpg`;
// The rare card: sold 120 days ago (photo gone), again 40 and 10 days ago.
ins.run('100000001', iso(-120), '2024 Prizm Bo Nix #309 Silver', 9000, 'Bo Nix', '2024', 'Prizm', 'Silver', '309', null, null, 0.9, img('GONE1'));
ins.run('100000002', iso(-40), '2024 Prizm Bo Nix #309 Silver PSA 10', 30000, 'Bo Nix', '2024', 'Prizm', 'Silver', '309', 'PSA', '10', 0.9, img('LIVEPSA'));
ins.run('100000003', iso(-10), '2024 Prizm Bo Nix #309 Silver', 9500, 'Bo Nix', '2024', 'Prizm', 'Silver', '309', null, null, 0.9, img('GONE3'));
// Another card of the same player and set: never a stand-in.
ins.run('100000004', iso(-5), '2024 Prizm Bo Nix #301 Silver', 4000, 'Bo Nix', '2024', 'Prizm', 'Silver', '301', null, null, 0.9, img('OTHERCARD'));
// The same card's base version: not the Silver either.
ins.run('100000005', iso(-5), '2024 Prizm Bo Nix #309', 2000, 'Bo Nix', '2024', 'Prizm', '', '309', null, null, 0.9, img('BASE'));
// A card with no number known: no same-card sale lookup at all.
ins.run('100000006', iso(-120), '2024 Mosaic Bo Nix', 900, 'Bo Nix', '2024', 'Mosaic', '', null, null, null, 0.9, img('GONE6'));
ins.run('100000007', iso(-3), '2024 Mosaic Bo Nix Green', 900, 'Bo Nix', '2024', 'Mosaic', '', null, null, null, 0.9, img('LIVE7'));

const d1 = { prepare(sql) {
  let b = [];
  const api = { bind(...a) { b = a; return api; },
    async all() { return { results: db.prepare(sql).all(...b) }; },
    async first() { return db.prepare(sql).get(...b) || null; },
    async run() { return { success: true }; } };
  return api;
} };

// eBay's image host: a removed photo is a 200 with a 696-byte grey square.
const checked = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (/ebayimg\.com/.test(u)) {
    checked.push(u);
    const size = /GONE|LIVE7X/.test(u) ? 696 : 6844;
    return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(size) };
  }
  return realFetch(url, init);
};

const dbMod = require(path.join(__dirname, '..', 'db.js'));
dbMod.getNflDb = () => d1;
const store = new Map();
dbMod.cacheGet = async (k) => (store.has(k) ? JSON.parse(store.get(k)) : null);
dbMod.cachePut = async (k, v) => { store.set(k, JSON.stringify(v)); };
process.env.CF_WORKER = '1';
const S = require(path.join(__dirname, '..', 'server.js'));

(async () => {
  // ---- the liveness test -----------------------------------------------------
  check('a photo eBay has removed (its 696-byte stand-in) reads as gone', !(await S._ebayPhotoLive(img('GONE1'))));
  check('  ...a real one as up, checked at the small size', await S._ebayPhotoLive(img('LIVEPSA')) && /s-l140\.webp$/.test(checked[checked.length - 1]));
  check('  ...and nothing but eBay\'s image host is ever fetched', !(await S._ebayPhotoLive('http://169.254.169.254/latest')));

  // ---- 1. a newer sale of the same card ------------------------------------
  const r1 = await S._cardPhotoLookup(d1, '100000001');
  check('a gone photo is replaced by a newer sale of the same card whose photo is up',
    r1.photo && r1.photo.source === 'sale' && /LIVEPSA/.test(r1.photo.url), JSON.stringify(r1.photo));
  check('  ...skipping a newer sale whose photo is gone too', checked.some(u => /GONE3/.test(u)));
  check('  ...never another card of the set, or the base of a parallel',
    !checked.some(u => /OTHERCARD|BASE/.test(u)));
  check('  ...and the card is named for a tile either way',
    r1.card && r1.card.player === 'Bo Nix' && r1.card.number === '309' && r1.card.parallel === 'Silver' && r1.card.set === 'Prizm');

  const order = S._cardPhotoCandidates({ item_id: 'x', grader: 'PSA', grade: '10' }, [
    { item_id: 'a', image_url: 'u', sold_date: '2026-10-01', grader: null, grade: null },
    { item_id: 'b', image_url: 'u', sold_date: '2026-09-01', grader: 'PSA', grade: '10' },
    { item_id: 'x', image_url: 'u', sold_date: '2026-10-05', grader: 'PSA', grade: '10' },
    { item_id: 'c', image_url: null, sold_date: '2026-10-09', grader: 'PSA', grade: '10' }]);
  check('candidates: the same grade first, then newest; never the sale itself or one with no photo',
    order.map(r => r.item_id).join(',') === 'b,a');

  // ---- 2/3. no card number: no same-card sale; listing or the tile ---------
  checked.length = 0;
  const r6 = await S._cardPhotoLookup(d1, '100000006');
  check('with no card number, no other sale stands in (it could be any card of the set)',
    !checked.some(u => /LIVE7/.test(u)) && (!r6.photo || r6.photo.source === 'listing'));
  check('  ...and the card still comes back to draw a tile', r6.card && r6.card.player === 'Bo Nix' && r6.card.set === 'Mosaic');

  const unknown = await S._cardPhotoLookup(d1, '999999999');
  check('an unknown sale: nothing, quietly', unknown.photo === null && unknown.card === null);

  // ---- which listings may stand in -----------------------------------------
  const hn = S._titleHasCardNumber;
  check('a listing must name the card number: "#309" and a bare "309" do',
    hn('2024 Prizm Bo Nix #309 Silver', '309') && hn('Bo Nix 309 Silver RC', '309'));
  check('  ...a print run "/309" or "309/499", or a longer number, does not',
    !hn('Bo Nix Silver /309', '309') && !hn('Bo Nix 309/499', '309') && !hn('Bo Nix 13090', '309'));
  check('  ...and a short number needs its "#"', hn('Mahomes #7 PSA', '7') && !hn('Mahomes 7 PSA 10', '7'));

  // ---- the route: rate-limited, validated, cached --------------------------
  check('the route takes only a numeric item id, and is rate-limited',
    S.RL_TIERS.some(t => t.name === 'photo' && t.match('/api/card-photo')));
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  check('the page treats an 80x80 eBay image as gone, as well as one that fails to load',
    /img\.naturalWidth === 80 && img\.naturalHeight === 80/.test(app)
    && /addEventListener\('load',[\s\S]{0,200}_ebayPhotoGone\(img\)/.test(app));
  check('  ...says on the photo when it is another sale or a current listing',
    /Photo from a later sale/.test(app) && /Photo from a current listing/.test(app));
  check('  ...and the main sale lists carry the item id it looks up by',
    (app.match(/_itemAttr\((item|r|sale)\)/g) || []).length >= 3);

  console.log(failures ? `\n${failures} check(s) failed` : '\nall card-photo checks passed');
  process.exit(failures ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
