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

// ---- TAG: a grading company, and also a part of a card -------------------
//
// Found by measurement, not by guessing. /api/debug/grade-gap sampled a 30-day
// window: of 87,238 sales that eBay's own structured fields call graded, 562
// named no grader in the title — and every one of the commonest was a LAUNDRY
// TAG. The manufacturer's tag cut from the jersey. A patch card, usually
// numbered, often the most valuable card in the product.
//
// All 562 were being pulled out of Raw and filed under TAG, and one shape was
// worse still: "LAUNDRY TAG 1/1" read the print run as a grade and produced a
// price series called "TAG 1" — a bucket no grader has ever issued, holding
// Flawless one-of-ones.
//
// These titles are copied from that output, emoji included, because that is
// what the data actually looks like.
const LAUNDRY = [
  '2025 Panini National Treasures Jaydon Blue Printing Plate 1/1 Patch Laundry Tag',
  '2024 Illusions Brock Bowers Travis Kelce Rookie Idols Laundry Tag Green #/10',
  '🦅1 of 1🦅 2022 DESMOND RIDDER NATIONAL TREASURES DUAL TAG PATCH COM-DR ROOKIE🏈',
  '🔥Tyler Lockett 4/5 2015 National Treasures Laundry Tag Booklet AUTO ROOKIE RC🔥',
  '💎1/1💎Sanders/Martin/Faulk/Riggins 2021 NT Quad Tag Patch Card #QM-BCMT',
  '🏈2025 PANINI FLAWLESS XAVIER WORTHY LAUNDRY TAG 1/1 NFL SHIELD AND NIKE LOGO🏈',
];
{
  const wrong = LAUNDRY.filter(t => bucketOf(t) !== 'Raw');
  check('a laundry tag is a patch card, not a slab',
    wrong.length === 0,
    wrong.length ? wrong.map(t => `"${t.slice(0, 40)}" -> ${bucketOf(t)}`).join('; ')
                 : `all ${LAUNDRY.length}`);
}

// The collector's columns carry the same mistake, because they were filled by a
// parser reading these same titles. Fixing only the title reader would leave
// every stored row exactly as wrong as it was.
check('  ...even when the stored columns say it was graded',
  bucketOf('🏈2025 PANINI FLAWLESS XAVIER WORTHY LAUNDRY TAG 1/1 NFL SHIELD AND NIKE LOGO🏈',
           { grader: 'TAG', grade: 1 }) === 'Raw',
  bucketOf('🏈2025 PANINI FLAWLESS XAVIER WORTHY LAUNDRY TAG 1/1 NFL SHIELD AND NIKE LOGO🏈',
           { grader: 'TAG', grade: 1 }));

// The print-run half of the same fix, on a grader where the TAG guard cannot
// help. A number in front of a slash is how many copies exist, not a grade, and
// reading it as one invents a series — "HGA 1" — that nobody was ever issued.
check('a print run behind a grader is not read as a grade',
  bucketOf('2025 Panini Flawless Xavier Worthy #12 HGA 1/1') === 'HGA (no grade read)',
  bucketOf('2025 Panini Flawless Xavier Worthy #12 HGA 1/1'));

// And the fix must not throw the company away with the cloth.
check('a real TAG slab is still a slab',
  bucketOf('2017 Prizm Mahomes #269 TAG 10', { grader: 'TAG', grade: '10' }) === 'TAG 10',
  bucketOf('2017 Prizm Mahomes #269 TAG 10', { grader: 'TAG', grade: '10' }));
// A title may name a laundry tag and THEN a real grader. Stopping at the first
// grader token would return the disqualified one and lose the grade that is
// genuinely there.
check('a laundry tag does not hide a real grade later in the title',
  bucketOf('2017 Prizm Mahomes #269 Laundry Tag PSA 10', { grader: 'TAG' }) === 'PSA 10',
  bucketOf('2017 Prizm Mahomes #269 Laundry Tag PSA 10', { grader: 'TAG' }));
// The parallel reader is handed the stripped title. "Laundry Tag" is part of
// what the card IS, so removing it would describe a different card.
check('stripGrade keeps a laundry tag in the title',
  stripGrade('2024 Illusions Brock Bowers Rookie Idols Laundry Tag Green #/10')
    === '2024 Illusions Brock Bowers Rookie Idols Laundry Tag Green #/10',
  stripGrade('2024 Illusions Brock Bowers Rookie Idols Laundry Tag Green #/10'));

// ---- the browser's copy of this reader ------------------------------------
//
// public/app.js groups search results under "Raw / Ungraded" using its own
// detectGrade(), and it knew four graders where this file knows fifteen. A
// Beckett, HGA, CSG or GMA slab therefore sat in the raw group at slab prices.
//
// Two implementations of one rule will drift, and the drift is silent — the
// page simply disagrees with its own price chart. So the lists are compared
// character for character here, and the browser function is executed against
// the same titles rather than read.
{
  const fs = require('fs');
  const path = require('path');
  const vm = require('vm');
  const { GRADERS } = require('../grade-core');
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

  const start = src.indexOf('const APP_GRADERS');
  const end = src.indexOf('const GRADE_ORDER');
  check('the browser grade reader is where the parity check expects it',
    start > 0 && end > start, `start=${start} end=${end}`);

  const ctx = { console };
  vm.createContext(ctx);
  // `const` at the top level of a script is a lexical binding, not a property
  // of the global object, so it has to be handed out explicitly. A function
  // declaration does become one, which is why detectGrade needs no help — and
  // why the first run of this check reported "browser=0" against correct code.
  vm.runInContext(src.slice(start, end) + '\nthis.__graders = APP_GRADERS;', ctx);

  check('the browser knows exactly the graders the server knows',
    JSON.stringify(ctx.__graders) === JSON.stringify(GRADERS),
    `browser=${(ctx.__graders || []).length} server=${GRADERS.length}`);

  // The cases that used to land in the raw group. Each is a slab.
  const notRaw = [
    '2017 Panini Prizm Mahomes #269 Silver BECKETT 9.5',
    '2020 Prizm Justin Herbert #325 HGA 10',
    '2023 Prizm C.J. Stroud #301 CSG 9.5',
    '2026 Topps Now Fernando Mendoza RC #FMEN GMA 10',
    '2024 Prizm Caleb Williams #301 KSA 9',
    '2017 Prizm Mahomes #269 Silver SLABBED cert #12345678',
  ];
  const leaked = notRaw.filter(t => ctx.detectGrade(t) === 'Raw / Ungraded');
  check('  ...so a slab it used to call raw no longer is',
    leaked.length === 0,
    leaked.length ? leaked.map(t => `"${t.slice(0, 45)}"`).join('; ') : `all ${notRaw.length}`);

  // And the collisions that adding eleven bare substrings would have caused.
  // Every one of these is a raw card, and calling it graded would take it out
  // of the group a shopper is actually browsing.
  const stillRaw = [
    '2020 Prizm Isaiah Simmons #150 Silver',                         // ISA
    '2024 Panini Obsidian - Magmatic Memorabilia Joe Burrow #MM-JBW', // GMA
    '2026 Panini Prizm World Cup - Landon Donovan Auto #NH-LD USMNT', // MNT
    '2025 Panini Enigma Jayden Daniels #12',                          // GMA
    '2024 Illusions Brock Bowers Rookie Idols Laundry Tag Green #/10', // TAG
    '2017 Prizm Mahomes #269 Silver Prizm raw ungraded',
  ];
  const stolen = stillRaw.filter(t => ctx.detectGrade(t) !== 'Raw / Ungraded');
  check('  ...and a raw card whose words merely contain a grader still is',
    stolen.length === 0,
    stolen.length ? stolen.map(t => `"${t.slice(0, 45)}" -> ${ctx.detectGrade(t)}`).join('; ')
                  : `all ${stillRaw.length}`);

  // The fine-grained labels the page prices separately must not have moved.
  const labels = [
    ['2017 Prizm Mahomes #269 PSA10', 'PSA 10'],
    ['2017 Prizm Mahomes #269 PSA 9.5', 'PSA 9.5'],
    ['2017 Prizm Mahomes #269 BGS9.5', 'BGS 9.5'],
    ['2017 Prizm Mahomes #269 BGS PRISTINE', 'BGS 10'],
    ['2017 Prizm Mahomes #269 SGC 10', 'SGC'],
    ['2017 Prizm Mahomes #269 Silver Prizm', 'Raw / Ungraded'],
  ];
  const moved = labels.filter(([t, want]) => ctx.detectGrade(t) !== want);
  check('  ...and the existing grade labels are unchanged',
    moved.length === 0,
    moved.length ? moved.map(([t, w]) => `"${t.slice(0, 35)}" -> ${ctx.detectGrade(t)} (wanted ${w})`).join('; ')
                 : `all ${labels.length}`);

  // A label the page cannot sort or order is a label that renders nowhere.
  check('  ...and every label it can return has a place in the page ordering',
    /'Graded \(other\)'/.test(src.slice(end, end + 600)),
    'GRADE_ORDER and GRADE_SORT_DESC must both list Graded (other)');
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall grade-core checks passed');
process.exit(failures ? 1 : 0);
