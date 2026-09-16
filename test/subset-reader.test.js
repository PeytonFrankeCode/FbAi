// Which catalogued SUBSET does a listing title name?
//
// A product is not one list of cards. 2017 Panini Prizm is a 300-card base set
// plus fourteen inserts, and every insert restarts numbering at #1 — so "#8" in
// that product is a base card, an Instant Impact, a Hall of Fame, an NFL MVP, a
// Rize Up and five more. The sales table has one `set_name` column and it holds
// the PRODUCT, so all of those arrive as "Prizm".
//
// The vocabulary for this already existed: residual() strips catalogued set
// names out of a title to find the parallel. It just threw the answer away.
//
// The risk here is the same one that governs the parallel reader, and it points
// the same way: reading a subset that is not there is far worse than reading
// none. A wrong subset says two sales are different cards when they are the
// same, which splits a card's history; no subset leaves things exactly as they
// were. So most of what follows asserts that things are NOT matched.
const { resolveSubset } = require('../parallel-index.js');

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

// ---- real inserts are read ------------------------------------------------
const shouldRead = [
  ['2017 PANINI PRIZM INSTANT IMPACT #8 PATRICK MAHOMES II Silver', 'instant impact'],
  ['2017 Panini Prizm Hall of Fame Patrick Mahomes II #3 Silver',   'hall of fame'],
  ['2017 Panini Prizm Rookie Introductions Mahomes #2',             'rookie introductions'],
  ['2017 Panini Prizm Super Bowl MVPs Tom Brady #33',               'super bowl mvps'],
  // Real and catalogued in 65 checklists. An earlier version of this file
  // listed it as a title that must NOT match, which was simply wrong about the
  // product — Rated Rookies is a Donruss set, not seller prose.
  ['2023 Panini Donruss Optic Rated Rookie Bijan Robinson #201',    'rated rookie'],
];
{
  const missed = [];
  for (const [title, want] of shouldRead) {
    const got = resolveSubset(title).subset;
    if (got !== want) missed.push(`"${title.slice(0, 44)}" -> ${got} (wanted ${want})`);
  }
  check('an insert named in the title is read',
    missed.length === 0,
    missed.length ? missed.join('; ') : `all ${shouldRead.length}`);
}

// ---- the dangerous direction ----------------------------------------------
// Each of these would split one card's sales in two.
const mustNotMatch = [
  ['2017 Panini Prizm - Rookies Patrick Mahomes II #269 Silver Prizm (RC)', 'a base card'],
  ['2025 Panini Prizm - Rookies Jaxson Dart #332 Silver Prizm (RC)',        'a base card'],
  ['2023 Panini Prizm Justin Jefferson #150 Gold Vinyl',                    'a parallel, not a set'],
  ['2024 Panini Prizm - A.J. Green #12 (RC)',                               'a player surnamed Green'],
  ['2025 Topps Chrome - Rookies Jaxson Dart #306 Refractor (RC)',           'a parallel'],
  ['2022 Panini Prizm Patrick Mahomes #1 Rookie Football Card',             'seller prose'],
  // The one that found the product-stripping bug. Some checklist catalogues a
  // set literally named "Topps", so without stripping the product first this
  // read as an insert called Topps — on a 1984 base card.
  ['1984 Topps - John Elway #63 (RC)',                                      'the product name'],
];
{
  const wrong = mustNotMatch.filter(([t]) => resolveSubset(t).subset);
  check('  ...and a title with no insert in it reads as none',
    wrong.length === 0,
    wrong.length
      ? wrong.map(([t]) => `"${t.slice(0, 40)}" -> ${resolveSubset(t).subset}`).join('; ')
      : `all ${mustNotMatch.length} correctly refused`);
}

// A parallel is never a subset. SUBSETS is built by filtering the catalogued
// set names against the parallel LOOKUP, so this is a property of the
// vocabulary rather than of the matcher — and it is the property that stops
// "Silver" being read as an insert, which would split every parallel off its
// own card.
{
  const leaked = ['Silver Prizm', 'Gold Vinyl', 'Refractor', 'Prizm Red']
    .filter(p => resolveSubset(`2017 Panini Prizm Player Name #5 ${p}`).subset);
  check('  ...and a parallel name is never returned as a subset',
    leaked.length === 0,
    leaked.length ? `read as subsets: ${leaked.join(', ')}` : 'none leaked');
}

// Longest match wins, and the case has to be one name literally CONTAINING
// another as a whole phrase.
//
// The first version of this check used "Rookie Patch Autographs" against
// "Rookie Autographs" — which are different sets, but one does not contain the
// other as a contiguous phrase, so reversing the match order changed nothing
// and the check passed against a build that preferred the shortest name. There
// are 8,422 genuine containment pairs in the catalogue; "Rookie Cuts Blue Ink"
// holding "Rookie Cuts" is one, and they are different sets with different
// prices.
{
  const got = resolveSubset('2016 Leaf Rookie Cuts Blue Ink Carson Wentz #12').subset;
  check('  ...and the longest set name wins',
    got === 'rookie cuts blue ink',
    `got "${got}" — the shorter "rookie cuts" is a different set`);
}

// ---- the measurement this was built to enable -----------------------------
// The claim that justifies reading subsets at all is that a product's inserts
// collide with its base set on (player, number). Against 2017 Prizm's own
// catalogue that is true but rare — and rare enough to matter for the decision,
// so it is asserted rather than remembered.
{
  const path = require('path');
  const doc = require(path.join(__dirname, '..', 'public', 'data', 'checklists',
                                '2017-panini-prizm-football.json'));
  const norm = (s) => String(s || '').toLowerCase().replace(/[.,']/g, '').replace(/\s+/g, ' ').trim();
  const keys = new Map();
  for (const s of doc.sets) {
    for (const c of (s.cards || [])) {
      const k = `${norm(c.player)}|${c.number}`;
      if (!keys.has(k)) keys.set(k, new Set());
      keys.get(k).add(s.name);
    }
  }
  const collide = [...keys.values()].filter(v => v.size > 1).length;
  const share = collide / keys.size;
  check('the base-vs-insert collision is real but uncommon',
    collide > 0 && share < 0.10,
    `${collide} of ${keys.size} (player, number) keys span more than one set — ${(share * 100).toFixed(1)}%`);

  // The specific card the question was asked about. Nine cards in this product,
  // every one differently numbered — so the number alone separates his base
  // from his Instant Impact, and no photo is needed to do it.
  const mahomes = [...keys.entries()].filter(([k]) => k.startsWith('patrick mahomes'));
  const ambiguous = mahomes.filter(([, v]) => v.size > 1);
  check('  ...and does not affect the card it was reported on',
    mahomes.length > 1 && ambiguous.length === 0,
    `Mahomes has ${mahomes.length} cards in 2017 Prizm, ${ambiguous.length} with an ambiguous number`);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall subset-reader checks passed');
process.exit(failures ? 1 : 0);
