// Checklists: a year opens onto the companies that made cards that year
// (owner, Nov 2026: "when you click on a year it drops down into the different
// companies that made cards so panini Topps Onit etc").
'use strict';
const path = require('path');
const fs = require('fs');
let failures = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`); if (!ok) failures++; };
const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

const start = src.indexOf('function checklistMaker(');
const end = src.indexOf('function _checklistMakers(');
const end2 = src.indexOf('\n}\n', end) + 3;
check('app.js has checklistMaker and _checklistMakers', start > 0 && end > start);
// eslint-disable-next-line no-new-func
const lib = new Function(src.slice(start, end2) + '\nreturn { checklistMaker, _checklistMakers };')();

const cases = [
  [{ brand: 'ONIT Athlete', year: 2026 }, 'ONIT'],
  [{ brand: 'Prizm', year: 2024 }, 'Panini'],
  [{ brand: 'Panini Obsidian', year: 2026 }, 'Panini'],
  [{ brand: 'Donruss', year: 2026 }, 'Panini'],
  [{ brand: 'Donruss', year: 2005 }, 'Donruss / Playoff'],
  [{ brand: 'Bowman', year: 1950 }, 'Bowman Gum'],
  [{ brand: 'Bowman', year: 2024 }, 'Topps'],
  [{ brand: 'Topps Chrome', year: 2026 }, 'Topps'],
  [{ brand: 'SP Authentic', year: 2003 }, 'Upper Deck'],
  [{ brand: 'Score', year: 1995 }, 'Score / Pinnacle'],
  [{ brand: 'Fleer Ultra', year: 1998 }, 'Fleer / SkyBox'],
];
for (const [p, want] of cases) {
  const got = lib.checklistMaker(p);
  check(`${p.year} ${p.brand} → ${want}`, got === want, got);
}
const order = lib._checklistMakers([
  { brand: 'Sage', year: 2010 }, { brand: 'Sage', year: 2010 }, { brand: 'Sage', year: 2010 },
  { brand: 'Prizm', year: 2010 }, { brand: 'Topps', year: 2010 }, { brand: 'Topps', year: 2010 },
]).map(e => e[0]);
check('Panini, Topps, ONIT lead; "Other makers" is listed last', order.join(',') === 'Panini,Topps,Other makers', order.join(','));
check('a year renders a collapsible header per company', /checklist-maker-header/.test(src) && /makers\.length === 1/.test(src));
const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
check('company grids are closed until tapped', /\.checklist-maker-grid\s*\{\s*display:\s*none/.test(css) && /\.checklist-maker-grid\.open\s*\{\s*display:\s*grid/.test(css));

console.log(failures ? `\n${failures} checklist-makers check(s) failed` : '\nall checklist-makers checks passed');
process.exit(failures ? 1 : 0);
