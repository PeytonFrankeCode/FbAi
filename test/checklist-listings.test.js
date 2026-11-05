// Checklist card panels (owner, Nov 2026: "when you click on a card ... for
// sale and sold most of the time it shows nothing"). The panel searches eBay
// for the card; eBay returns only listings with every word, so the full set
// name often found nothing. It now steps down from the exact card to simpler
// searches, and For Sale no longer empties when the word filter keeps none.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
let failures = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`); if (!ok) failures++; };

const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const grab = (name) => {
  const i = app.indexOf(`function ${name}(`);
  let depth = 0, j = app.indexOf('{', i);
  for (let k = j; k < app.length; k++) { if (app[k] === '{') depth++; else if (app[k] === '}' && --depth === 0) return app.slice(i, k + 1); }
  throw new Error(name);
};
const ctx = { checklistData: null };
vm.createContext(ctx);
vm.runInContext(['checklistSearchBrand', 'checklistSetWords', 'checklistQueryLadder'].map(grab).join('\n'), ctx);
const ladder = (data, ...a) => { ctx.checklistData = data; return vm.runInContext(`checklistQueryLadder(${a.map(x => JSON.stringify(x)).join(',')})`, ctx); };

const onit = ladder({ name: '2025 ONIT Athlete Alabama Football', brand: 'ONIT Athlete' }, 'Ty Simpson', '2025', 'ONIT Athlete', 'Team Color Signature Shimmer (/15)', 'autograph', '');
check('ONIT: searched as sellers write it, set name without the print run, then simpler', JSON.stringify(onit) === JSON.stringify(['2025 Onit Team Color Signature Shimmer Ty Simpson', '2025 Onit Ty Simpson', 'Onit Ty Simpson']), JSON.stringify(onit));
const grav = ladder({ name: '2026 ONIT Gravity Football', brand: 'ONIT Athlete' }, 'Jeremiah Smith', '2026', 'ONIT Athlete', 'Base', 'base', '');
check('ONIT Gravity keeps its line', grav[0] === '2026 Onit Gravity Jeremiah Smith' && grav[1] === 'Onit Gravity Jeremiah Smith', JSON.stringify(grav));
const prizm = ladder({ name: '2024 Panini Prizm Football', brand: 'Prizm' }, 'Caleb Williams', '2024', 'Prizm', 'Rookie Autographs', 'autograph', '25');
check('a numbered insert steps from the exact card to the player', JSON.stringify(prizm) === JSON.stringify(['2024 Prizm Rookie Autographs Caleb Williams /25', '2024 Prizm Caleb Williams /25', '2024 Prizm Caleb Williams', 'Prizm Caleb Williams']), JSON.stringify(prizm));
const base = ladder({ name: '2024 Panini Prizm Football', brand: 'Prizm' }, 'Caleb Williams', '2024', 'Prizm', 'Base', 'base', '');
check('a base card starts at year, brand, player', JSON.stringify(base) === JSON.stringify(['2024 Prizm Caleb Williams', 'Prizm Caleb Williams']), JSON.stringify(base));
check('"Standard" and a "(2)" are not search words', vm.runInContext('checklistSetWords("Hype Standard (2)")', ctx) === 'Hype');

check('the panel walks the ladder for sold and for sale', /for \(let i = 0; i < ladder\.length; i\+\+\)/.test(app) && /s\.query = s\.ladder\.shift\(\)/.test(app) && /checklistQueryLadder\(player, year, brand, setName, category, printRun\)/.test(app));
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
check('For Sale shows eBay\'s matches, marked similar, when the word filter keeps none', /if \(!filtered\.length && offset === 0 && !clientFilters\)[\s\S]{0,300}searchType: 'broadened'/.test(server));

console.log(failures ? `\n${failures} checklist-listings check(s) failed` : '\nall checklist-listings checks passed');
process.exit(failures ? 1 : 0);
