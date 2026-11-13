// Inventory tabs (owner, Nov 2026: "a PC tab ... switch between tabs of PC,
// Storage etc. and see the value, and for PC no cost to pay, just value").
'use strict';
const fs = require('fs');
const path = require('path');
let failures = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`); if (!ok) failures++; };
const ROOT = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
check('the Inventory has a tab row', /id="inv-tabs"/.test(html) && /_renderInvTabs\(inv\);/.test(app));
check('  ...All, PC and each location, each with its value and card count',
  /key: 'all', label: 'All'/.test(app) && /key: 'pc'/.test(app) && /inv\.locations\.map\(l => \(\{ key: 'loc'/.test(app) && /_invTabValue\(t\.items\)/.test(app));
check('a PC card shows its value only, no paid or net', /const pl = i\.pc \? `<div class="inv-item-pl inv-item-pl-pc"/.test(app));
check('  ...and stays out of the net +/- (its cost is not an investment)', /const invOnly = inv\.items\.filter\(i => !i\.pc\);/.test(app));
check('  ...and its form has no price paid; a card added from the PC tab starts as PC',
  /onchange="_invPcToggle\(\)"/.test(html) && /checked = item \? !!item\.pc : _invFilter\.type === 'pc';/.test(app) && /paid\.classList\.toggle\('hidden', !!pc\.checked\)/.test(app));
console.log(failures ? `\n${failures} inventory-tabs check(s) failed` : '\nall inventory-tabs checks passed');
process.exit(failures ? 1 : 0);
