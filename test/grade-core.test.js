// Grade detection, at the unit level.
//
// card-analysis.test.js proves the endpoint gets this right on one card.
// This covers the shapes that card does not carry, because the cost of being
// wrong here is not cosmetic: a slab called Raw puts PSA 10 money into the
// median the site presents as what an ungraded copy is worth, and the same
// function stamps "Ungraded" on every sold tile.
//
// The bug being locked down: the old test was /\b(PSA|BGS|...)\b/i, and \b
// marks a word-character/non-word-character boundary. A digit is a word
// character, so "PSA10" has no boundary after PSA and never matched — nor did
// BGS9.5, SGC10 or CGC9, which is how most slabs are actually listed.
const { gradeBucket, gradeFromTitle, stripGrade } = require('../grade-core');

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};
const bucketOf = (title, extra) => gradeBucket({ title, grade: null, grader: null, ...(extra || {}) });

// ---- the hole ----------------------------------------------------------
// Every one of these was called Raw.
const GLUED = [
  ['PSA10', 'PSA 10'],
  ['PSA-10', 'PSA 10'],
  ['PSA.10', 'PSA 10'],
  ['BGS9.5', 'BGS 9.5'],
  ['SGC10', 'SGC 10'],
  ['CGC9', 'CGC 9'],
  ['BCCG10', 'BCCG 10'],
];
for (const [spelling, want] of GLUED) {
  const got = bucketOf(`2017 Panini Prizm Mahomes #269 Silver ${spelling}`);
  check(`"${spelling}" is a slab, not raw`, got === want, `got "${got}", want "${want}"`);
}

// The spaced spellings must land in the SAME bucket as the glued ones, or the
// fix has merely moved the split rather than closed it.
check('spaced and glued PSA 10 are one bucket',
  bucketOf('x #1 PSA 10') === bucketOf('x #1 PSA10'),
  `${bucketOf('x #1 PSA 10')} vs ${bucketOf('x #1 PSA10')}`);

// ---- what must stay raw ------------------------------------------------
// These are the collisions the old \b pattern was careful about. Bounding on
// letters instead of word characters has to keep every one of them.
const STAY_RAW = [
  '2020 Prizm Isaiah Simmons #150 Silver',            // 'isa' inside Isaiah
  '2017 Vintage Football Mahomes #269',               // 'tag' inside vintage
  '1994 Flags of the League #12 Young',               // 'ags' inside flags
  '2017 Prizm Mahomes #269 Silver GEM MINT 10',       // a seller's claim, not a slab
  '2017 Prizm Mahomes #269 Silver (RC)',              // nothing at all
  '2017 Prizm Mahomes #269 raw ungraded PSA 10 candidate', // explicit raw wins
];
for (const t of STAY_RAW) {
  const got = bucketOf(t);
  check(`stays raw: "${t.slice(0, 46)}"`, got === 'Raw', `got "${got}"`);
}

// ---- a number that is not a grade --------------------------------------
// Only a number attached to the grader counts. A stray 10 later in the title
// may be a card number, a jersey, or a print run, and reading one as a grade
// would invent a PSA 10 that never existed.
check('a loose number elsewhere is not read as the grade',
  bucketOf('2017 Prizm Mahomes #269 Silver PSA /10 numbered') !== 'PSA 10',
  `got "${bucketOf('2017 Prizm Mahomes #269 Silver PSA /10 numbered')}"`);

// ---- the grade column, when it has one ---------------------------------
check('a populated grade column wins',
  gradeBucket({ title: 'whatever', grader: 'PSA', grade: '9' }) === 'PSA 9');
// Used to produce a bucket labelled just "10" — a price series named after a
// number, which tells a reader nothing.
check('a grade with no grader column borrows the grader from the title',
  gradeBucket({ title: '2017 Prizm Mahomes #269 PSA10', grader: '', grade: '10' }) === 'PSA 10',
  gradeBucket({ title: '2017 Prizm Mahomes #269 PSA10', grader: '', grade: '10' }));

// ---- gradeFromTitle ----------------------------------------------------
check('gradeFromTitle reads grader and number',
  JSON.stringify(gradeFromTitle('a #1 BGS9.5')) === JSON.stringify({ grader: 'BGS', grade: '9.5' }),
  JSON.stringify(gradeFromTitle('a #1 BGS9.5')));
check('gradeFromTitle reads "PSA GEM MT 10"',
  (gradeFromTitle('a #1 PSA GEM MT 10') || {}).grade === '10',
  JSON.stringify(gradeFromTitle('a #1 PSA GEM MT 10')));
check('gradeFromTitle returns null when no grader is named',
  gradeFromTitle('2017 Prizm Mahomes #269 Silver') === null);

// ---- stripGrade --------------------------------------------------------
// The parallel reader gives up on tokens it does not know, and "PSA10" is one,
// so a slab's parallel read as unmatched and the sale was dropped from its own
// card entirely — the PSA10 bug wearing a second hat.
check('stripGrade removes a glued grade',
  stripGrade('2017 Panini Prizm Mahomes #269 Silver Prizm PSA10')
    === '2017 Panini Prizm Mahomes #269 Silver Prizm',
  stripGrade('2017 Panini Prizm Mahomes #269 Silver Prizm PSA10'));
check('stripGrade removes a spaced grade',
  stripGrade('2017 Panini Prizm Mahomes #269 Silver Prizm PSA 10')
    === '2017 Panini Prizm Mahomes #269 Silver Prizm',
  stripGrade('2017 Panini Prizm Mahomes #269 Silver Prizm PSA 10'));
// It must not eat the parallel while it is at it.
check('stripGrade leaves a title with no grade alone',
  stripGrade('2017 Panini Prizm Mahomes #269 Silver Prizm')
    === '2017 Panini Prizm Mahomes #269 Silver Prizm');
check('stripGrade does not eat a player whose name contains a grader string',
  stripGrade('2020 Prizm Isaiah Simmons #150 Silver')
    === '2020 Prizm Isaiah Simmons #150 Silver',
  stripGrade('2020 Prizm Isaiah Simmons #150 Silver'));

console.log(failures ? `\n${failures} check(s) failed` : '\nall grade-core checks passed');
process.exit(failures ? 1 : 0);
