// Titles that name no single card, kept out of the market index.
//
// WHY THIS EXISTS. /api/debug/raw-filter reported the commonest title reaching
// the index as "SEE SCAN For The Exact Card Up For Auction! NFL READ FREE
// SHIPPING AutographDen" — 247 sales, player parsed as "See". One seller's
// template, relisted, entering the basket as a player named See who traded 247
// times. An index compares sales of the same card; a title naming no card
// cannot be one side of that comparison.
//
// THE RISK THIS GUARDS. Every pattern is a SQL substring, chosen for cost. A
// substring that also occurs inside a real card title does not produce a
// visible error — it silently deletes real sales from the index, which is the
// same failure as the junk it removes, pointing the other way. So the bulk of
// this file is legitimate titles that must SURVIVE.
//
// Printing plates in particular: a plate is a real card, filed by the
// checklists under the set whose number it shares. 'plate' is deliberately not
// a pattern, and there is a check below that says so.
const path = require('path');
const ROOT = path.join(__dirname, '..');

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (err) {
  console.error('FAIL  node:sqlite unavailable on ' + process.version + ' — needs Node 22.5+.');
  process.exit(1);
}

process.env.CF_WORKER = '1';
process.env.ADMIN_PASSWORD = 'test-key-for-junk';
const { RSI_JUNK_WORDS, _rsiRawOnlySql, RSI_JUNK_ONLY } = require(path.join(ROOT, 'server.js'));

// Run the REAL predicate against real SQLite, so this tests the SQL that
// ships rather than a JavaScript re-implementation of it.
const db = new DatabaseSync(':memory:');
db.exec(`CREATE TABLE sales (title TEXT, grade TEXT, grader TEXT, price_cents INTEGER)`);
const ins = db.prepare('INSERT INTO sales (title, grade, grader, price_cents) VALUES (?, NULL, NULL, 1000)');
const survives = (title) => {
  db.exec('DELETE FROM sales');
  ins.run(title);
  // The BASKET predicate: raw-only plus the junk clause. The whole-window
  // aggregate deliberately omits the junk clause — it has no CPU budget left
  // for it. See the comment on RSI_JUNK_ONLY for why the basket is where junk
  // actually shows.
  const r = db.prepare(
    `SELECT COUNT(*) AS n FROM sales
      WHERE price_cents IS NOT NULL ${_rsiRawOnlySql()}${RSI_JUNK_ONLY}`).get();
  return r.n === 1;
};

// ---- The reported case, and its family ----
const JUNK = [
  'SEE SCAN For The Exact Card Up For Auction! NFL READ FREE SHIPPING AutographDen',
  '2024 Panini Prizm Caleb Williams - see scans for condition',
  'NFL Card Lot of 25 Assorted Rookies',
  'You Pick Your Card 2024 Prizm Base Rookies',
  '2024 Prizm Case Break Spot - Kansas City Chiefs',
  'Mystery Pack 5 Cards Guaranteed Auto',
  '1984 Topps John Elway REPRINT #63',
  'Custom Made Patrick Mahomes ACEO Art Card',
];
let caught = 0;
for (const t of JUNK) {
  const ok = !survives(t);
  if (ok) caught++;
  check(`junk kept out: "${t.slice(0, 52)}${t.length > 52 ? '…' : ''}"`, ok);
}
check(`  ...${caught}/${JUNK.length} of the junk family removed`, caught === JUNK.length);

// ---- THE PART THAT MATTERS: real cards must survive ----
//
// Each of these was chosen because it sits near a pattern above. If one starts
// failing, a substring has grown teeth.
const REAL = [
  ['a plain base rookie', '2024 Panini Prizm Caleb Williams #301 (RC)'],
  ['a printing plate — a real card', 'Jaden Greathouse 2025 Leaf Football Nation 1/1 Printing Plate'],
  ['a cyan printing plate', '2024 Donruss Optic Marvin Harrison Jr Printing Plate Cyan 1/1'],
  ['a 1/1 that is not a plate', '2024 Prizm Bo Nix Gold Vinyl 1/1'],
  ['a card whose player name contains "pick"', '2023 Prizm Jaylen Pickett #88'],
  ['a "Draft Picks" product', '2024 Panini Prizm Draft Picks Caleb Williams #1'],
  ['a card naming a lottery-ish parallel', '2024 Select Brock Bowers Scope Prizm #44'],
  ['a card with "choice" in the parallel', '2024 Prizm Choice Tiger Stripe Jayden Daniels'],
  ['a Red, White and Blue parallel', '2024 Prizm Red White and Blue Bo Nix #304'],
  ['a card mentioning free shipping', '2024 Prizm Caleb Williams #301 RC Free Shipping'],
  ['a card with a scan reference in the set name', '2024 Topps Chrome Malik Nabers #150'],
];
for (const [label, t] of REAL) {
  check(`real card survives — ${label}`, survives(t), t.slice(0, 60));
}

// ---- The plate rule, stated so it cannot be quietly reversed ----
check('no pattern targets printing plates',
  !RSI_JUNK_WORDS.some(w => /plate/i.test(w)),
  'a plate is a real card; the checklists file it under the set whose number it shares');
check('no pattern targets "1/1"',
  !RSI_JUNK_WORDS.some(w => w.includes('1/1')),
  'a one-of-one is the opposite of junk');
check('no pattern targets "digital"',
  !RSI_JUNK_WORDS.some(w => /digital/i.test(w)),
  'Topps Digital is a real product line');

// ---- Grade filtering is untouched by this ----
// The junk clause is ANDed on last; a slab must still be excluded for being a
// slab, and a plain raw card must still pass.
db.exec('DELETE FROM sales');
db.prepare('INSERT INTO sales (title, grade, grader, price_cents) VALUES (?,?,?,?)')
  .run('2017 Prizm Mahomes #269 Silver', '10.0', 'psa', 50000);
const slab = db.prepare(
  `SELECT COUNT(*) AS n FROM sales
    WHERE price_cents IS NOT NULL ${_rsiRawOnlySql()}${RSI_JUNK_ONLY}`).get();
check('a graded sale is still excluded for being graded', slab.n === 0,
  'the junk clause must not have loosened the grade stages');

// ---- The split is load-bearing ----
check('the junk clause is NOT in the whole-window raw predicate',
  !/see scan/.test(_rsiRawOnlySql()),
  'the aggregate runs at ~95% of its 2,000ms budget before this; putting the '
  + 'clause back there is what market-index.test catches');
check('  ...and IS in the basket clause', /see scan/.test(RSI_JUNK_ONLY));
check('  ...with the list short enough to afford',
  // 13 since "chaser" (chase-pack listings sold on a card's photo): one more
  // LIKE on the basket query only, never the whole-window aggregate.
  RSI_JUNK_WORDS.length <= 13,
  `${RSI_JUNK_WORDS.length} patterns — each is another LIKE per row`);

console.log(failures ? `\n${failures} check(s) failed` : '\nall junk-title checks passed');
process.exit(failures ? 1 : 0);
