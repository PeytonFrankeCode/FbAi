// Player pages link on to the rest of the rookie class and the current
// teammates (owner, Oct 2026), and a player's rookie year skips the college
// and draft-prospect cards that come before it. Reads the built pages, which
// CI builds (npm run build:pages) before it runs the tests.
'use strict';
const fs = require('fs');
const path = require('path');
let failures = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`); if (!ok) failures++; };
const page = (slug) => { const f = path.join(__dirname, '..', 'public', 'players', slug, 'index.html'); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null; };
const nix = page('bo-nix');
if (!nix) { console.error('Built pages missing: run npm run build:pages first.'); process.exit(1); }
const section = (html, h) => { const i = html.indexOf(`<h2>${h}</h2>`); return i < 0 ? '' : html.slice(i, html.indexOf('</ul>', i)); };
const cls = section(nix, '2024 rookie class');
check('Bo Nix is in the 2024 rookie class, not 2022 (his first cards are college ones)',
  !!cls && /Jayden Daniels/.test(cls) && !/2022 rookie class/.test(nix) && /2024 \(rookie\)/.test(nix), cls.slice(0, 200));
const team = section(nix, 'More Denver Broncos players');
check('  ...links to his teammates, and no name twice', !!team && !/>Bo Nix</.test(team) && (cls.match(/href=/g) || []).length <= 12,
  team.slice(0, 160));
const all = (nix.slice(nix.indexOf('<section class="lp-related">')).match(/href="\/players\/[^"]+\/"/g) || []);
check('  ...each linked player appears once across the lists', all.length === new Set(all).size, String(all.length));
const ward = page('cam-ward');
check('a 2025 rookie links to his own class', ward && /<h2>2025 rookie class<\/h2>/.test(ward));
console.log(failures ? `\n${failures} check(s) failed` : '\nall player-links checks passed');
process.exit(failures ? 1 : 0);
