// Basketball and baseball markets (owner, Oct 2026): the Market tab's index,
// basket and player markets for each sport, built from that sport's tagged
// sales alone, while football's stay exactly as they were. Run through the
// real routes and SQL over an in-memory table holding two sports that move in
// opposite directions, so a sport reading the other's rows shows at once.
'use strict';
let DatabaseSync;
try { ({ DatabaseSync } = require('node:sqlite')); } catch (err) { console.error('FAIL  node:sqlite unavailable'); process.exit(1); }
const path = require('path');
const fs = require('fs');

let failures = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`); if (!ok) failures++; };
const DAY = 86400000;
const iso = (off) => new Date(Date.now() + off * DAY).toISOString().slice(0, 10);

const db = new DatabaseSync(':memory:');
db.exec(`CREATE TABLE sales (item_id TEXT, sold_date TEXT, title TEXT, price_cents INTEGER, currency TEXT,
  listing_format TEXT, grader TEXT, grade TEXT, player TEXT, parallel TEXT, year TEXT, set_name TEXT,
  card_number TEXT, confidence REAL, best_offer INTEGER, bids INTEGER, sport TEXT)`);
const ins = db.prepare(`INSERT INTO sales (item_id, sold_date, title, price_cents, player, year, set_name, parallel, card_number, grader, grade, confidence, sport)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
let n = 0;
db.exec('BEGIN');
// Football slabs rise 8% over the window; basketball slabs fall 10%. Every
// player's PSA 10 sells every other day.
for (const [sport, move, who] of [['football', 0.08, 'Gridiron'], ['basketball', -0.10, 'Hoops']]) {
  for (let c = 0; c < 120; c++) {
    for (let d = -100; d <= 0; d++) {
      if ((c + d) % 2) continue;
      const drift = 1 + move * (d + 100) / 100;
      ins.run(`${sport[0]}${n++}`, iso(d), `2020 Prizm ${who} ${c} #1 PSA 10`, Math.round(50000 * drift), `${who} ${c}`, '2020', 'Prizm', 'Base', '1', 'PSA', '10', 0.9, sport);
    }
  }
}
db.exec('COMMIT');
const d1 = {
  prepare(sql) {
    let bound = [];
    const api = {
      bind(...a) { bound = a; return api; },
      all() { return { results: db.prepare(sql).all(...bound) }; },
      run() { return { success: true, meta: db.prepare(sql).run(...bound) }; },
      first() { return db.prepare(sql).get(...bound) || null; },
    };
    return api;
  },
  batch(stmts) { return stmts.map(st => st.run()); },
};
const dbMod = require(path.join(__dirname, '..', 'db.js'));
dbMod.getNflDb = () => d1;
// KV stubbed, for the cron's records.
const store = new Map();
dbMod.cacheGet = async (k) => (store.has(k) ? store.get(k) : null);
dbMod.cachePut = (k, v) => { store.set(k, { ...v, generatedAt: new Date().toISOString() }); };
process.env.CF_WORKER = '1';
process.env.DISABLE_RATE_LIMIT = '1';
const S = require(path.join(__dirname, '..', 'server.js'));
const server = S.app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
const get = async (p) => (await fetch(base + p)).json();

(async () => {
  try {
    const fb = await get('/api/market-index?days=30');
    const bb = await get('/api/market-index?days=30&sport=basketball');
    const base0 = await get('/api/market-index?days=30&sport=baseball');
    check('football\'s market reads football alone: it rose', fb.available && fb.changePct > 0, JSON.stringify({ a: fb.available, ch: fb.changePct, r: fb.reason }));
    check('basketball\'s market reads basketball alone: it fell', bb.available && bb.changePct < 0, JSON.stringify({ a: bb.available, ch: bb.changePct, r: bb.reason }));
    check('a sport with no sales says so rather than borrowing another\'s', base0.available === false, JSON.stringify(base0).slice(0, 160));
    const bk = await get('/api/market-basket?days=30&sport=basketball');
    const names = ((bk && bk.cards) || []).map(c => c.player || c.name || c.label || '').join(' ');
    check('basketball\'s basket holds basketball cards only', bk.available && bk.cards.length > 0 && /Hoops/.test(JSON.stringify(bk.cards)) && !/Gridiron/.test(JSON.stringify(bk.cards)), names.slice(0, 120));
    const fk = await get('/api/market-basket?days=30');
    check('  ...and football\'s football only', fk.available && !/Hoops/.test(JSON.stringify(fk.cards)));
    const pl = await get('/api/player-index?days=30&player=' + encodeURIComponent('Hoops 4') + '&sport=basketball');
    const plFb = await get('/api/player-index?days=30&player=' + encodeURIComponent('Hoops 4'));
    check('a basketball player\'s own market reads with the sport, falling with it', pl.available && pl.changePct < 0, JSON.stringify({ a: pl.available, ch: pl.changePct, r: pl.reason }));
    check('  ...where football\'s filter finds none of his sales', plFb.available === false, JSON.stringify({ a: plFb.available, r: plFb.reason }));
    check('an unknown sport is football', (await get('/api/market-index?days=30&sport=cricket')).changePct === fb.changePct);
    check('each sport has its own cache keys, football\'s unchanged',
      S._marketIndexKey(30) !== S._marketIndexKey(30, 'basketball') && !/football/.test(S._marketIndexKey(30, 'football'))
      && S._marketBasketKey(30, '', 'baseball').endsWith(':baseball') && S._marketIndexKey(30) === S._marketIndexKey(30, 'football'));
    // The cron: builds each sport's market, and keeps a settled "no" (baseball
    // has no sales here) so the next tick does not ask again.
    const w1 = await S.warmMarket(), w2 = await S.warmMarket();
    const p1 = (w1 && w1.periods) || [], p2 = (w2 && w2.periods) || [];
    check('the cron builds basketball\'s market and records baseball\'s "no"',
      S.MARKET_OTHER_SPORTS.join() === 'basketball,baseball' && p1.includes('basketball:index:7d:built') && p1.includes('baseball:index:7d:none'), p1.join(' '));
    check('  ...and the next tick asks for neither again', p2.filter(x => /^(basketball|baseball):/.test(x)).every(x => x.endsWith(':cached')), p2.join(' '));
    const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
    check('the Market tab asks for the sport picked, and shows the market for all three',
      /function _isMarketSport\(id\) \{ return id === 'football' \|\| id === 'basketball' \|\| id === 'baseball'; \}/.test(app) && /\+ _mkSportQ\(\)/.test(app) && !/market data is coming soon[\s\S]{0,40}football/.test(app));
  } catch (e) { console.error(e); failures++; }
  server.close();
  console.log(failures ? `\n${failures} check(s) failed` : '\nall market-sports checks passed');
  process.exit(failures ? 1 : 0);
})();
