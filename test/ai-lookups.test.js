// Huddle AI lookups for questions it had no answer to (Nov 2026): a product's
// sets and parallels, and who is selling most by team or set.
'use strict';
process.env.NODE_ENV = 'test';
const path = require('path');
let failures = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`); if (!ok) failures++; };
const db = require(path.join(__dirname, '..', 'db.js'));
const store = new Map();
db.cacheGet = async (k) => (store.has(k) ? store.get(k) : null);
db.cachePut = (k, v) => { store.set(k, v); };
const S = require(path.join(__dirname, '..', 'server.js'));

(async () => {
  const names = S.BIZ_AI_TOOLS.map(t => t.name);
  check('Huddle AI has product_overview and top_players', names.includes('product_overview') && names.includes('top_players'));
  const po = await S._productOverview({ product: '2025-panini-prizm-football' });
  const base = (po.list || []).find(x => /base/i.test(x.set));
  check('product_overview lists the sets with their parallels', po.sets > 10 && base && base.parallels.length > 10, `${po.sets} sets, base ${base && base.parallels.length} parallels`);
  const autos = await S._productOverview({ product: '2025-panini-prizm-football', set: 'autographs' });
  check('  ...and narrows to matching sets', autos.list.length >= 1 && autos.list.every(x => /autograph/i.test(x.set)), autos.list.map(x => x.set).join(', '));
  check('  ...and says when the product is unknown', !!(await S._productOverview({ product: 'no-such-product' })).error);

  const pg = (sales, median, top) => ({ sales, cards: 20, median, top });
  store.set('priceblocks:v1', { from: '2026-09-28', to: '2026-11-06', pages: {
    'player:josh-allen': pg(500, 60, [{ label: '2018 Panini Prizm #205', sales: 90, median: 120 }]),
    'player:keon-coleman': pg(120, 15, [{ label: '2024 Panini Prizm #331', sales: 40, median: 9 }]),
    'player:bo-nix': pg(400, 30, [{ label: '2024 Panini Prizm #301', sales: 80, median: 25 }]),
    'set:2024-panini-prizm-football': pg(1000, 10, []) } });
  const bills = await S._topPlayers({ team: 'Bills' });
  check('top_players narrows by NFL team', bills.top.length === 2 && bills.top[0].player === 'Josh Allen' && bills.top.every(r => /Bills/.test(r.team)), JSON.stringify(bills.top.map(r => r.player)));
  const prizm24 = await S._topPlayers({ set: '2024 Prizm' });
  check('  ...and by the set in the card names, counting only those cards', prizm24.top.length === 2 && prizm24.top[0].player === 'Bo Nix' && prizm24.top[0].sales === 80, JSON.stringify(prizm24.top.map(r => [r.player, r.sales])));
  const dear = await S._topPlayers({ sort: 'price' });
  check('  ...and sorts by price when asked', dear.top[0].player === 'Josh Allen' && dear.top[dear.top.length - 1].player === 'Keon Coleman');
  console.log(failures ? `\n${failures} ai-lookups check(s) failed` : '\nall ai-lookups checks passed');
  process.exit(failures ? 1 : 0);
})();
