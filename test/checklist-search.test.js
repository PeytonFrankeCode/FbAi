// Huddle AI searches every checklist at once (owner, Nov 2026: "What Denver
// Broncos have colorblasts?" got "I can't search across all players by
// parallel"). search_checklists finds an insert or parallel by name in every
// product, narrowed by team, player, year or product.
'use strict';
process.env.NODE_ENV = 'test';
const path = require('path');
let failures = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`); if (!ok) failures++; };
const s = require(path.join(__dirname, '..', 'server.js'));

(async () => {
  check('Huddle AI has the search_checklists lookup', s.BIZ_AI_TOOLS.some(t => t.name === 'search_checklists'));
  const r = await s._searchChecklists({ set: 'colorblasts', team: 'Denver Broncos' });
  const names = (r.cards || []).map(c => c.player);
  check('"colorblasts" for the Broncos finds Color Blasts across products, plural and spacing aside',
    r.matches >= 3 && r.productsWithSet >= 5 && (r.cards || []).every(c => /Broncos/.test(c.team) && /color blast/i.test(c.set + ' ' + (c.parallel || ''))),
    `${r.matches} cards in ${r.productsWithSet} products: ${names.slice(0, 5).join(', ')}`);
  const y = await s._searchChecklists({ set: 'Downtown', player: 'Bo Nix', year: '2024' });
  check('a player and a year narrow it', y.matches >= 1 && (y.cards || []).every(c => /Bo Nix/.test(c.player) && /^2024 /.test(c.product)), `${y.matches}`);
  const none = await s._searchChecklists({ set: '' });
  check('no set name asks for one', !!none.error);
  console.log(failures ? `\n${failures} checklist-search check(s) failed` : '\nall checklist-search checks passed');
  process.exit(failures ? 1 : 0);
})();
