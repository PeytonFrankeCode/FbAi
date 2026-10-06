// The card chart's time periods (owner, Oct 2026): 7, 30, 90 days, a year or
// all time, each with its own price, sale count and start-against-end change.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const grab = (name) => { const i = src.indexOf(`function ${name}(`); const j = src.indexOf('\n}\n', i); return src.slice(i, j + 3); };
const ctx = { Date, Math, Number };
vm.createContext(ctx);
vm.runInContext(['_caRangePoints', '_caRangeStats', '_caDate'].map(grab).join('\n') + '\nthis.f = { _caRangePoints, _caRangeStats, _caDate };', ctx);
const { _caRangePoints, _caRangeStats, _caDate } = ctx.f;

let failures = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`); if (!ok) failures++; };
const ago = (d) => new Date(Date.now() - d * 864e5).toISOString().slice(0, 10);
const g = { points: [
  { date: ago(200), median: 500, sales: 1 }, { date: ago(60), median: 930, sales: 1 },
  { date: ago(25), median: 810, sales: 2 }, { date: ago(3), median: 765, sales: 1 },
] };
check('each period keeps only its own days',
  _caRangePoints(g, '7').length === 1 && _caRangePoints(g, '30').length === 2
  && _caRangePoints(g, '90').length === 3 && _caRangePoints(g, 'all').length === 4);
const s30 = _caRangeStats(_caRangePoints(g, '30'));
check('a period\'s change is its first sale day against its last', s30.changePct === -5.6 && s30.sales === 3, JSON.stringify(s30));
const sAll = _caRangeStats(_caRangePoints(g, 'all'));
check('  ...and all time runs from the first sale to the last sixth of the period', sAll.changePct === 57.5 && sAll.sales === 5, JSON.stringify(sAll));
check('  ...one sale day is a price, not a move', _caRangeStats(_caRangePoints(g, '7')).changePct === null);
check('a sale day reads as its own date, not the day before', /Sep 13/.test(_caDate('2026-09-13')), _caDate('2026-09-13'));

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nall card-range checks passed');
