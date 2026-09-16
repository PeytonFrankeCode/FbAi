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
const { cardKind, printRun } = require('../card-kind.js');

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

// ---- the print run -------------------------------------------------------
//
// A Cam Ward auto /5 and a Cam Ward auto /10 are different cards with very
// different prices, and every column in the sales table is identical for both.
// Only the title separates them.
//
// This reader is deliberately STRICTER than parsePrintRunFromTitle() in
// server.js, which feeds the similar-card estimator. There, a fuzzy read costs
// a slightly wrong scaling factor; here it SPLITS a card's history.
{
  const runs = [
    ['2025 Panini Prizm Cam Ward RC Auto /5', 5],
    ['2025 Panini Prizm Cam Ward RC Auto /10', 10],
    ['2025 Prizm Cam Ward Gold Auto 1/1', 1],
    ['2025 Prizm Cam Ward Auto numbered to 25', 25],
    ['2025 Prizm Cam Ward Auto #/99', 99],
    // Not stated. Must be null, never 0 — "no print run" and "one of one" can
    // never be allowed to collapse into each other.
    ['2025 Prizm Cam Ward #14 Auto', null],
    ['2024 Panini Prizm Caleb Williams #301 (RC)', null],
    // THE TRAP, and the reason for the stricter reading. This is a DATE. The
    // estimator's parser reads it as a print run of 16, which would tear one
    // card into two on a phrase about when it sold.
    ['2025 Prizm Cam Ward RC #14 sold 9/16', null],
    ['2023-24 Topps Chrome Josh Allen #4', null],
    ['Football Card Lot of 24 - Vintage 70s 80s 90s', null],
  ];
  const wrong = runs.filter(([t, want]) => printRun(t) !== want);
  check('the print run is read when stated, and refused when it is not',
    wrong.length === 0,
    wrong.length
      ? wrong.map(([t, w]) => `"${t.slice(0, 40)}" -> ${printRun(t)} (wanted ${w})`).join('; ')
      : `all ${runs.length}`);
}

// ---- the shape of the output ----------------------------------------------
// Empty string rather than null, because it concatenates into an identity key
// and a null would stringify to "null" — a kind of its own, silently splitting
// every base card away from itself.
check('a base card returns an empty string, never null or undefined',
  cardKind('2017 Prizm Player #1') === '' && cardKind('') === '' && cardKind(null) === '',
  `${JSON.stringify(cardKind('2017 Prizm Player #1'))} / ${JSON.stringify(cardKind(null))}`);

// ---- a redemption is not the card -----------------------------------------
//
// Found on the Most Sold board: "2026 Topps Fernando Mendoza #301" showed 440
// sales at a $31 average with a $1,300 high, and the tile's photo was a Topps
// Redemption Card — "You are due to receive a Rookie Real One Autograph".
//
// A redemption is a voucher. It trades for a fraction of the card while
// carrying the card's name, its number, and the word "autograph", so it lands
// in the autograph group and drags its average down. Checked BEFORE auto for
// exactly that reason.
expect([
  ['2026 Topps Flagship Football Redemption Fernando Mendoza Rookie Real One Auto #301', 'redemption'],
  ['2026 Topps Redemption Card Fernando Mendoza Las Vegas Raiders 301', 'redemption'],
  ['Topps 2026 Mendoza REDEMPTION unredeemed', 'redemption'],
  // The real card, same player, same number, same product.
  ['2026 Topps Flagship Football Fernando Mendoza RC #301 Auto', 'auto'],
  ['2026 Topps Flagship Football Fernando Mendoza RC #301 Las Vegas Raiders', ''],
], 'a redemption voucher is its own kind, not an autograph');

// ---- the SQL reader must agree with this one -------------------------------
//
// The Most Sold board groups every priced sale in a 30-day window — around half
// a million rows — so it decides the kind inside the query. Two implementations
// of one rule drift silently, and this codebase has paid for that twice in a
// day: two grade readers that disagreed about what a slab was, and two search
// endpoints where only one had the identity check wired in.
//
// So the SQL is GENERATED from the same word lists, and both readers are run
// over the same corpus here. Exercised against real SQLite rather than by
// reading the string, because the whole point is what the database does with it.
{
  let DatabaseSync;
  try { ({ DatabaseSync } = require('node:sqlite')); } catch (_) { DatabaseSync = null; }
  if (!DatabaseSync) {
    check('the SQL kind reader agrees with the JS one', false,
      `node:sqlite unavailable on ${process.version} — needs Node 22.5+, do not skip this`);
  } else {
    process.env.CF_WORKER = '1';
    const path = require('path');
    const { _sqlKindExpr } = require(path.join(__dirname, '..', 'server.js'));

    const corpus = [
      // Straight from the live boards and from identity-gap output.
      '2026 Topps Flagship Football - Fernando Mendoza RC #301 Las Vegas Raiders',
      '2026 Topps Redemption Card Fernando Mendoza Las Vegas Raiders 301',
      'Topps 2026 Flagship Football First Signatures Ty Simpson RC Auto FFS-TS Rams',
      '2017 Panini Prizm Rookie Patch Autographs Patrick Mahomes II #18',
      '2017 Panini Prizm Prizm Premier Jerseys Dalvin Cook #8',
      '2025 Panini National Treasures Jaydon Blue Printing Plate 1/1 Patch Laundry Tag',
      '2024 Panini Obsidian - Magmatic Memorabilia Joe Burrow #MM-JBW (MEM)',
      '2023 Panini Absolute Game Worn Swatch Bijan Robinson',
      '2024 Prizm Caleb Williams On-Card Auto /25',
      '1986 Topps - Jerry Rice #161 C* on Copyright Line (RC)',
      // The traps. Every one of these would SPLIT a base card's history.
      '2024 Panini Prizm Automatic Bijan Robinson #12',
      '2023 Prizm New Jersey Generals Herschel Walker #5',
      '2024 Prizm Josh Allen #4 RC Fast Dispatch Free Shipping',
      '2020 Prizm Isaiah Simmons #150 Silver',
      '2017 Panini Prizm Mahomes #269 Silver Prizm PSA 10 GEM MINT',
    ];

    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE sales (title TEXT)');
    const ins = db.prepare('INSERT INTO sales (title) VALUES (?)');
    for (const t of corpus) ins.run(t);
    const rows = db.prepare(`SELECT title, ${_sqlKindExpr()} AS kind FROM sales`).all();

    const disagree = rows.filter(r => r.kind !== cardKind(r.title));
    check('the SQL kind reader agrees with the JS one, title for title',
      disagree.length === 0,
      disagree.length
        ? disagree.map(r => `"${r.title.slice(0, 44)}" SQL=${JSON.stringify(r.kind)} JS=${JSON.stringify(cardKind(r.title))}`).join('; ')
        : `all ${corpus.length}`);

    // And it must be generated, not transcribed — a hand-written copy is the
    // thing that drifts. Adding a word to card-kind.js has to reach the SQL.
    const { AUTO_WORDS } = require('../card-kind.js');
    check('  ...and the SQL is built from the shared word list',
      AUTO_WORDS.every(w => _sqlKindExpr().includes(w.replace(/-/g, ' '))),
      'every AUTO_WORDS entry must appear in the generated SQL');
  }
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall card-kind checks passed');
process.exit(failures ? 1 : 0);
