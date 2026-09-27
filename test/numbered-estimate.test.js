// A numbered card with no sale of its own is priced from numbered cards
// printed in greater numbers only: the /25s, /49s and /99s that sell far more
// often. Never from the unnumbered base (a different market), and never from a
// rarer copy (/5, 1/1), whose few sales say more about one buyer than the card.
const path = require('path');
process.env.CF_WORKER = '1';
const { buildSimilarCardEstimate } = require(path.join(__dirname, '..', 'server.js'));

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

const sale = (title, price) => ({ title, price: String(price), soldDate: '2026-09-01' });
const SALES = [
  sale('2024 Panini Prizm Bo Nix #309 RC', 6),                       // unnumbered base
  sale('2024 Panini Prizm Bo Nix #309 Silver Prizm RC', 25),         // unnumbered parallel
  sale('2024 Panini Prizm Bo Nix #309 Blue Prizm /199 RC', 45),
  sale('2024 Panini Prizm Bo Nix #309 Red Prizm /299 RC', 38),
  sale('2024 Panini Prizm Bo Nix #309 Orange Prizm /49 RC', 110),
  sale('2024 Panini Prizm Bo Nix #309 Purple Prizm /25 RC', 160),
  sale('2024 Panini Prizm Bo Nix #309 Green Prizm /5 RC', 900),      // rarer than the /10
  sale('2024 Panini Prizm Bo Nix #309 Black Finite 1/1 RC', 4000),   // rarer still
];

const est = buildSimilarCardEstimate('2024 Prizm Bo Nix Gold /10', SALES);
const runs = (est && est.comps || []).map(c => c.printRun);
check('a /10 is estimated', !!est && est.value > 0, est ? `$${est.value.toFixed(2)} from ${runs.map(r => '/' + r).join(' ')}` : 'none');
check('  ...from numbered cards only', runs.length > 0 && runs.every(r => r != null), JSON.stringify(runs));
check('  ...printed in greater numbers than it (no /5, no 1/1)', runs.every(r => r >= 10), JSON.stringify(runs));

const none = buildSimilarCardEstimate('2024 Prizm Bo Nix Gold /10', SALES.filter(s => !/\/(199|299|49|25)\b/.test(s.title)));
check('with no more-printed numbered sales, there is no estimate rather than a worse one', none === null,
  none ? `got $${none.value} from ${none.comps.map(c => c.title).join(' | ')}` : 'null');

// An unnumbered card has nothing printed in greater numbers; it is estimated as before.
const base = buildSimilarCardEstimate('2024 Prizm Bo Nix Hyper', SALES);
check('an unnumbered search is still estimated as before', !!base, base ? `$${base.value.toFixed(2)}` : 'none');

// A sold search never shows the estimate as a box: a search often does not
// say enough to price one card ("/1 prizm" was priced from a $5 base card, a
// Cracked Ice and a Green Ice insert). Collection values still use it.
{
  const app = require('fs').readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  check('a sold search does not show an "estimated value" box',
    !/buildSimilarEstimateSection/.test(app) && /estimate: data\.estimate \|\| null/.test(app));
  // Nor an empty one: "No recent sold listings found" was followed by
  // "Estimated $10.88", priced off two PSA 9 sales that merely matched words.
  check('  ...nor a search with no sales ("Estimated price" under "No recent sold listings")',
    !/loadQueryEstimate|query-estimate|\/api\/price-estimate/.test(app));
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall numbered-estimate checks passed');
process.exit(failures ? 1 : 0);
