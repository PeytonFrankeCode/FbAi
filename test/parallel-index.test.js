// Can the parallel be read out of a listing title?
//
// 48.4% of priced sales carry a parallel in the column and 38.9% carry a full
// card identity, which caps the index at about a third of the data. The titles
// name the parallel plainly, so most of the rest should be recoverable.
//
// The risk is not failing to read one. It is reading the WRONG one: a title
// says "A.J. Green" and Green is a parallel in nearly every product, so a naive
// substring search turns a base card into a Green parallel and merges two
// different cards. That is why the reader only looks at the segment after the
// card number — the player and the set both sit before it — and why half of
// what follows asserts that things are NOT matched.
const { resolveParallel, stats } = require('../parallel-index.js');

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

console.log(`vocabulary: ${stats.distinctParallels.toLocaleString('en-US')} parallels `
          + `from ${stats.products} products, ${stats.lookupEntries.toLocaleString('en-US')} spellings\n`);

const eq = (a, b) => String(a || '').toLowerCase().replace(/s$/, '')
                   === String(b || '').toLowerCase().replace(/s$/, '');

// Real title shapes, taken from live data.
const shouldRead = [
  ['2025 Panini Prizm - Rookies Jaxson Dart #332 Silver Prizm (RC)', 'Silver Prizm'],
  ['2025 Topps Chrome - Rookies Jaxson Dart #306 Refractor (RC)',    'Refractor'],
  ['2023 Panini Prizm - Justin Jefferson #150 Gold Vinyl',           'Gold Vinyl'],
];
let read = 0;
for (const [title, want] of shouldRead) {
  const hit = resolveParallel(title);
  if (hit.how === 'matched' && eq(hit.parallel, want)) read++;
  else console.log(`      MISS: "${title}" -> ${hit.how} ${hit.parallel || ''} (wanted ${want})`);
}
check('a parallel named in the title is read',
      read === shouldRead.length, `${read}/${shouldRead.length}`);

// The dangerous half. Each of these would silently merge two different cards.
const mustNotMatch = [
  ['2024 Panini Prizm - A.J. Green #12 (RC)',        'a player surnamed Green'],
  ['2023 Panini Prizm - Gabe Davis #77',             'a player, no parallel'],
  ['1984 Topps - John Elway #63 (RC)',               'a plain base card'],
  ['2022 Panini Black - Garrett Wilson #40',         'a set called Black'],
  ['2023 Panini Gold Standard - Bijan Robinson #12', 'a set called Gold Standard'],
];
const wrongly = mustNotMatch.filter(([t]) => resolveParallel(t).how === 'matched');
check('  ...and a parallel word before the card number is not',
      wrongly.length === 0,
      wrongly.length
        ? `MATCHED: ${wrongly.map(([t]) => `"${t}" -> ${resolveParallel(t).parallel}`).join('; ')}`
        : `all ${mustNotMatch.length} correctly read as base`);

// Longest match: "Silver Prizm" must beat the "Prizm" inside it, and "Gold
// Vinyl" must beat "Gold". Getting this backwards merges a /5 into the base run.
{
  const a = resolveParallel('2025 Panini Prizm - Player Name #1 Silver Prizm');
  const b = resolveParallel('2023 Panini Prizm - Player Name #1 Gold Vinyl');
  check('  ...and the longest parallel name wins',
        eq(a.parallel, 'Silver Prizm') && eq(b.parallel, 'Gold Vinyl'),
        `${a.parallel} / ${b.parallel}`);
}

// The cases the live conflict report exposed. Every one of these was a WRONG
// match before — a rarer card silently merged into a commoner one, which
// nothing downstream can detect.
{
  const cases = [
    // "&" broke the token run, so the reader settled for the "Blue Prizm" inside.
    ['2024 Panini Prizm - Rookies Caleb Williams #301 Red White & Blue Prizm (RC)',
     'matched', 'red white and blue'],
    // Matched the bare "White" — a real but different parallel — because the
    // full name was not in the vocabulary. Must refuse instead.
    ['2025 Panini Prizm - Rookies Jaxson Dart #332 White Disco Prizm (RC)',
     'unmatched', null],
    // The parallel is stated BEFORE the card number here, and the trailing
    // "Giants Rookie" is junk. Found by stripping the product, the subset, the
    // player and the filler and seeing what stands alone.
    ['2025 Topps Chrome Jaxson Dart RC Refractor #306 Giants Rookie',
     'matched-before-number', 'refractor'],
    // Only a team follows the number, and nothing before it names a parallel
    // either. Base is safe to conclude only because the second check ran — it
    // is what distinguishes this from the Refractor case above.
    ['2025 Topps Cosmic Chrome Cam Skattebo Stars In The Night RC Rookie #STN-5 Giants',
     'base', null],
    // Only a grade follows — same reasoning.
    ['2024 Panini Prizm - Rookies Jayden Daniels #347 (RC) PSA 10 GEM MINT',
     'base', null],
  ];
  const wrong = [];
  for (const [title, how, contains] of cases) {
    const r = resolveParallel(title);
    const okHow = r.how === how;
    const okVal = contains == null
      ? true
      : String(r.parallel || '').toLowerCase().replace(/[^a-z ]/g, '').includes(contains);
    if (!okHow || !okVal) wrong.push(`"${title.slice(0, 48)}..." -> ${r.how} ${r.parallel || ''}`);
  }
  check('the live conflicts are read correctly or refused',
        wrong.length === 0,
        wrong.length ? wrong.join('; ') : `all ${cases.length} correct`);
}

// A title with no card number gives no segment to read, so nothing is claimed.
{
  const junk = resolveParallel('SEE SCAN For The Exact Card Up For Auction! NFL READ FREE SHIPPING');
  check('  ...and an unstructured title claims nothing',
        junk.how === 'no-number' && junk.parallel === null,
        `${junk.how}`);
}

// Base is reported as its own answer, not as a failure to read. The two mean
// different things and only one of them is safe to act on.
{
  const base = resolveParallel('1984 Topps - John Elway #63 (RC)');
  const unread = resolveParallel('2025 Topps Chrome - Player #1 Wibblesnorf Foil');
  check('base and unreadable are told apart',
        base.how === 'base' && unread.how === 'unmatched',
        `base -> "${base.how}", unknown parallel -> "${unread.how}" (segment "${unread.segment}")`);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall parallel-index checks passed');
process.exit(failures ? 1 : 0);
