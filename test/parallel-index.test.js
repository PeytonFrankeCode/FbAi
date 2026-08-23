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

// The two halves of the seller-vs-catalogue spelling gap. variants() covers the
// catalogue being more verbose ("Silver Prizms" for a listing's "Silver Prizm");
// this is the other direction, a seller appending a product word the checklist
// leaves off. Both must work without reopening the hole strict mode exists to
// close — a one-word remainder is the rest of the sentence, not a parallel.
{
  const shock = resolveParallel('2025 Panini Donruss Optic Jaxson Dart Rated Rookie Purple Shock Prizm #273');
  const chrome = resolveParallel('2025 Topps Chrome Cam Ward #14 Chrome Refractor Thing');
  check('a product word the checklist omits is trimmed',
        eq(shock.parallel, 'Purple Shock'),
        `${shock.how} ${shock.parallel || '-'}`);
  check('  ...but never down to a single generic word',
        !/^chrome$/i.test(String(chrome.parallel || '')),
        `"Chrome Refractor" -> ${chrome.parallel || 'refused'} (Chrome would make every Topps title a Refractor)`);
}

// classify() has to admit when a name is both. "Kaboom" is a parallel in one
// product and an insert set in seven others; answering 'parallel' because that
// test ran first counted correctly-read set cards as reader defects and
// inflated the one number the wiring decision turns on.
{
  const { classify } = require('../parallel-index.js');
  const got = ['Kaboom', 'Downtown', 'Purple Shock', 'Wibblesnorf'].map(classify);
  check('a name that is both a set and a parallel is reported as both',
        got[0] === 'both' && got[1] === 'subset' && got[2] === 'parallel' && got[3] === 'unknown',
        `Kaboom=${got[0]} Downtown=${got[1]} Purple Shock=${got[2]} Wibblesnorf=${got[3]}`);
}

// Words that sit NEXT to the answer rather than being it. The residual has to
// cover the whole remainder, so one unstripped word is as fatal as a wrong one:
// each of these read as base — a real parallel silently demoted — because a
// signature word or the sport was still standing beside it.
{
  const cases = [
    ['WILL HOWARD Rookie 2025 Topps Resurgence Refractor Auto Steelers RC #182', 'refractor'],
    ['Topps 2026 Chrome Football Mojo Caleb Downs Cowboys RC 35 Anniversary #91TRC-49', 'mojo'],
  ];
  const missed = cases.filter(([t, want]) =>
    !String(resolveParallel(t).parallel || '').toLowerCase().includes(want));
  check('a parallel is still found with a signature word or the sport beside it',
        missed.length === 0,
        missed.length ? missed.map(([t]) => `"${t.slice(0, 40)}..." -> ${resolveParallel(t).how}`).join('; ')
                      : `${cases.length} recovered that previously read as base`);
}

// A title with no card number gives no segment to read, so nothing is claimed.
{
  const junk = resolveParallel('SEE SCAN For The Exact Card Up For Auction! NFL READ FREE SHIPPING');
  check('  ...and an unstructured title claims nothing',
        junk.how === 'no-number' && junk.parallel === null,
        `${junk.how}`);
}

// Cost per title, which is a correctness concern here rather than a nicety.
//
// residual() strips every known product and subset off a title. Done naively
// that is ~4,900 substring scans over two freshly allocated strings each, per
// title — and /api/debug/parallel-resolve runs it across 6,000 titles, so about
// 58 million allocations in a single request. That was enough to exhaust the
// Worker: the endpoint returned nothing while the rest of the site was fine.
//
// Phrases are indexed by first word so only real candidates are tested. The
// budget below is ~5x the measured cost of that version and ~2x under the
// version it replaced, so it fails if the full scan is reintroduced without
// tripping on a slow CI box.
{
  const players = ['Jaxson Dart', 'Caleb Williams', 'A.J. Green', 'John Elway'];
  const titles = [];
  for (let i = 0; i < 3000; i++) {
    const p = players[i % players.length];
    titles.push(`2025 Panini Prizm - Rookies ${p} #${300 + (i % 99)} Wibblesnorf Foil (RC)`);
  }
  resolveParallel(titles[0]);                       // pay for build() first
  const t0 = Date.now();
  for (const t of titles) resolveParallel(t);
  const ms = Date.now() - t0;
  const per = ms / titles.length;
  check('reading a title stays cheap enough for the diagnostics to run',
        per < 0.2,
        `${per.toFixed(3)}ms/title over ${titles.length} (budget 0.2ms)`);
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
