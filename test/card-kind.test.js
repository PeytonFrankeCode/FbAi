// Base, autograph or relic — read from a listing title.
//
// This is the largest single source of merged cards on the site. A product's
// autograph sets reuse the base set's numbering: 2025 Prizm lists Tyler Shough
// at #327 in the Base Set, again in Base Autographs, and again in Rookie Prizm
// Choice Auto. The sales table has one set_name column holding the PRODUCT, so
// all three arrive as "Prizm #327" and averaged together — a $12 base rookie
// with a $300 on-card auto.
//
// Measured against the whole catalogue it is 65.5% of ambiguous (player,
// number) keys — 41,529 of 63,417 — against 28.2% for inserts, which is the
// problem that looked obvious from the outside.
//
// The asymmetry here is deliberate and worth stating: absence of the word IS
// treated as evidence, which the parallel reader refuses to do. It is safe for
// this one signal because a seller does not leave "auto" or "patch" off a
// title — it is most of what the card is worth — and because the catalogue
// agrees: across 361 checklists, "autograph", "signature", "relic" and "mem"
// appear in no base set name at all.
const { cardKind } = require('../card-kind.js');

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};
const expect = (cases, label) => {
  const wrong = cases.filter(([t, want]) => cardKind(t) !== want);
  check(label, wrong.length === 0,
    wrong.length
      ? wrong.map(([t, w]) => `"${t.slice(0, 40)}" -> ${JSON.stringify(cardKind(t))} (wanted ${JSON.stringify(w)})`).join('; ')
      : `all ${cases.length}`);
};

// ---- base cards, taken from live identity-gap output ----------------------
expect([
  ['2025 Panini Prizm - Rookies Tyler Shough #327 Silver Prizm (RC)', ''],
  ['2025 Topps Chrome - Rookies Jaxson Dart #306 Refractor (RC)', ''],
  ['2020 Panini Prizm - Rookie Joe Burrow #307 (RC)', ''],
  ['2017 Panini Prizm - Rookies Patrick Mahomes II #269 Silver Prizm (RC)', ''],
  ['2026 Topps Flagship Football - Fernando Mendoza RC #301 Las Vegas Raiders', ''],
], 'a base card reads as base');

// ---- autographs -----------------------------------------------------------
expect([
  ['Topps 2026 Flagship Football First Signatures Ty Simpson RC Auto FFS-TS Rams', 'auto'],
  ['2026 Topps Flagship Jordyn Tyson RC Flagship First Signatures Auto Saints', 'auto'],
  ['2017 Panini Prizm Rookie Autographs Patrick Mahomes II #65', 'auto'],
  ['MIKE SINGLETARY SIGNED AUTOGRAPH BOOM CUSTOM CARD BEARS', 'auto'],
  ['Roger Craig Autograph Card', 'auto'],
  ['2025 Leaf Eclectic Signature Series Kamario Taylor 1/1', 'auto'],
  ['2024 Prizm Caleb Williams On-Card Auto /25', 'auto'],
], 'an autograph reads as auto');

// ---- relics ---------------------------------------------------------------
expect([
  ['2017 Panini Prizm Prizm Premier Jerseys Dalvin Cook #8', 'relic'],
  ['2019 Panini Immaculate Rookie Materials Patch Kyler Murray #12', 'relic'],
  ['2023 Panini Absolute Game Worn Swatch Bijan Robinson', 'relic'],
], 'a relic reads as relic');

// ---- auto beats relic -----------------------------------------------------
// A rookie patch AUTOGRAPH is priced and catalogued as an autograph first.
// Checking relic first would file every RPA with the plain patch card, which is
// the merge this exists to prevent, one layer down.
expect([
  ['2017 Panini Prizm Rookie Patch Autographs Patrick Mahomes II #18', 'auto'],
  ['2024 National Treasures RPA Jayden Daniels Patch Auto /99', 'auto'],
], 'an autographed patch is an autograph, not a relic');

// ---- the traps ------------------------------------------------------------
// Each of these would SPLIT a base card's history, which is the same damage as
// merging one, just harder to notice.
expect([
  // "auto" inside a longer word.
  ['2024 Panini Prizm Automatic Bijan Robinson #12', ''],
  ['2023 Topps Automotive Series Josh Allen #4', ''],
  // "Jersey" the place, not the swatch. The USFL's New Jersey Generals are on
  // real cards, and plenty of listings say where they ship from.
  ['2023 Prizm New Jersey Generals Herschel Walker #5', ''],
  ['2024 Prizm Jets vs New Jersey rivalry Aaron Rodgers #8', ''],
  // A grade is not a kind.
  ['2017 Panini Prizm Mahomes #269 Silver Prizm PSA 10 GEM MINT', ''],
  // "Fast Dispatch" is boilerplate a seller adds about SHIPPING, and it ends in
  // "patch". Without the leading boundary this reads as a relic and splits a
  // base card's history on a phrase about postage. Found by testing whether the
  // boundary protected anything real rather than assuming it did.
  ['2024 Prizm Josh Allen #4 RC Fast Dispatch Free Shipping', ''],
  ['2023 Topps Dispatch Rookie Card Bijan Robinson #12', ''],
], 'a word that merely contains a kind word does not count');

// ---- the shape of the output ----------------------------------------------
// Empty string rather than null, because it concatenates into an identity key
// and a null would stringify to "null" — a kind of its own, silently splitting
// every base card away from itself.
check('a base card returns an empty string, never null or undefined',
  cardKind('2017 Prizm Player #1') === '' && cardKind('') === '' && cardKind(null) === '',
  `${JSON.stringify(cardKind('2017 Prizm Player #1'))} / ${JSON.stringify(cardKind(null))}`);

console.log(failures ? `\n${failures} check(s) failed` : '\nall card-kind checks passed');
process.exit(failures ? 1 : 0);
