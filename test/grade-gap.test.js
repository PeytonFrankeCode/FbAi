// /api/debug/grade-gap: how often is a card's grade ONLY in the photo?
//
// This endpoint exists to settle one expensive decision — whether to build
// image recognition over ~340,000 slab photos — so the way it fails matters
// more than the way it works. It fails by reporting a confident number that
// happens to be wrong: invert the colGraded predicate, or let "ungraded" count
// as slab language, and every figure still comes back, still looks plausible,
// and points the work at the wrong build.
//
// So the fixture contains all four populations at counts chosen to be distinct
// from one another, and the checks assert the exact numbers rather than that
// the endpoint returned some. A version of this asserting only "the endpoint
// answers" would pass against a build with the predicate backwards.
let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (err) {
  console.error('FAIL  node:sqlite unavailable on ' + process.version +
                ' — this test needs Node 22.5+. Update the runtime, do not skip it.');
  process.exit(1);
}
const path = require('path');
const ROOT = path.join(__dirname, '..');

const db = new DatabaseSync(':memory:');
db.exec(`CREATE TABLE sales (item_id TEXT, sold_date TEXT, title TEXT, price_cents INTEGER,
  currency TEXT, listing_format TEXT, grader TEXT, grade TEXT, player TEXT, parallel TEXT,
  year TEXT, set_name TEXT, card_number TEXT, confidence REAL, best_offer INTEGER,
  bids INTEGER, image_url TEXT)`);

// The endpoint takes the newest sale in the table and then drops the last
// MARKET_EXCLUDE_TRAILING_DAYS before measuring anything, because the most
// recent day is still filling in. That upper edge therefore moves with the
// fixture: whichever rows are newest get cut, and moving the whole fixture back
// does not help — it just cuts a different row. The first run of this test
// reported 15 of 20 sales against correct code for that reason.
//
// So the fixture plants one ANCHOR sale dated today whose only job is to set
// that edge. It is expected to be excluded, and everything below it then sits
// safely inside the window.
const iso = (o) => new Date(Date.now() + o * 86400000).toISOString().slice(0, 10);
const DAY0 = -10;
const ins = db.prepare(`INSERT INTO sales (item_id, sold_date, title, price_cents,
  grader, grade, player, year, set_name, card_number, parallel, confidence)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
let n = 0;
const add = (title, grader, grade, times) => {
  for (let i = 0; i < times; i++) {
    ins.run('i' + n++, iso(DAY0 - (i % 10)), title, 10000, grader, grade,
            'Patrick Mahomes II', '2017', 'Prizm', '269', '', 0.9);
  }
};

// The anchor. Dated today, so the window's upper edge lands a day behind it and
// every real fixture row clears the cut. It must not appear in any total below.
ins.run('anchor', iso(0), '2017 Panini Prizm Anchor Sale #1', 10000, '', '',
        'Anchor', '2017', 'Prizm', '1', '', 0.9);

// The four populations, at counts that cannot be confused with each other.
//
// A — a known slab whose title says so. The text carries the grade; if one of
//     these ever lands in a Raw list that is a reader bug, and no photo helps.
add('2017 Panini Prizm Patrick Mahomes II #269 Silver PSA 10', 'PSA', '10', 4);
// B — a known slab whose title says NOTHING. This is the population that makes
//     the case for OCR, and the only one that does.
add('2017 Panini Prizm Patrick Mahomes II #269 Silver Prizm', 'PSA', '9', 3);
// C — a known slab whose title admits it is graded without naming who. Counted
//     apart from B because the grade is not recoverable from it either way, but
//     the card is at least known not to be raw.
add('2017 Panini Prizm Dalvin Cook #8 Graded', 'SGC', '', 2);
// D — columns empty, title names the grader. The control: these are the slabs
//     the title reader already rescues, and an empty bucket here means the
//     reader is not running and every other figure describes the wrong thing.
add('2020 Panini Prizm Joe Burrow #307 PSA 10', '', '', 5);
// E — columns empty, title silent. Mostly genuinely raw cards, with an unknown
//     number of slabs hiding in it. Sizing that unknown is the whole job.
add('2020 Panini Prizm Joe Burrow #307 Silver', '', '', 6);

const d1 = {
  prepare(sql) {
    const st = db.prepare(sql);
    return {
      bind: (...a) => ({ all: async () => ({ results: st.all(...a) }),
                         first: async () => st.get(...a) || null }),
      all: async () => ({ results: st.all() }),
      first: async () => st.get() || null,
    };
  },
};

const dbMod = require(path.join(ROOT, 'db.js'));
dbMod.getNflDb = () => d1;
process.env.CF_WORKER = '1';

const { app } = require(path.join(ROOT, 'server.js'));
const PORT = 3219;
const server = app.listen(PORT);

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

(async () => {
  const r = await (await fetch(`http://127.0.0.1:${PORT}/api/debug/grade-gap`)).json();
  check('the endpoint answers', r.available === true, r.available ? `${r.pricedSales} sales` : r.reason);

  const k = r.knownSlabs || {}, c = r.columnsEmpty || {}, v = r.verdict || {};

  check('every sale in the window is counted', r.pricedSales === 20, `${r.pricedSales} of 20`);

  // The labelled set. A grader column alone is enough to label a slab — eBay
  // fills that field far more often than the grade field, and requiring both
  // would throw away most of the only evidence available here. C has no grade
  // and must still be counted.
  check('a sale is a known slab when EITHER grading column is filled',
    k.sales === 9, `${k.sales} of 9 (4 with both columns, 3 with both, 2 with grader only)`);

  check('  ...split by what its title admits',
    k.titleNamesTheGrader === 4 && k.titleSaysSlabButNotWho === 2 && k.titleSaysNothing === 3,
    `names=${k.titleNamesTheGrader} hints=${k.titleSaysSlabButNotWho} silent=${k.titleSaysNothing}`);

  // The three buckets must exhaust the labelled set. If they do not, sales are
  // being double-counted or dropped and the share below is meaningless.
  check('  ...and those three account for every known slab, exactly once',
    k.titleNamesTheGrader + k.titleSaysSlabButNotWho + k.titleSaysNothing === k.sales,
    `${k.titleNamesTheGrader} + ${k.titleSaysSlabButNotWho} + ${k.titleSaysNothing} vs ${k.sales}`);

  check('the unlabelled population is counted apart from it',
    c.sales === 11 && c.rescuedByTheTitle === 5 && c.titleSaysNothingEither === 6,
    `empty=${c.sales} rescued=${c.rescuedByTheTitle} silent=${c.titleSaysNothingEither}`);

  // THE NUMBER THE DECISION RESTS ON. 3 of 9 known slabs hide it from the
  // title, so 33.3%. A wrong predicate anywhere above moves this without
  // throwing anything.
  check('the share of grades lost by the title is the measured one',
    v.gradeLostByTitleShare === 33.3, `${v.gradeLostByTitleShare}% (want 33.3)`);

  check('  ...and it is applied to the unlabelled population as a floor',
    v.estimatedSlabsSittingInRaw === 2, `${v.estimatedSlabsSittingInRaw} of 6 silent sales (want 2)`);

  // The reading has to change with the number, or it is decoration. At 33.3%
  // it must be the one that argues FOR photos; the thresholds are 2% and 10%.
  check('  ...and the verdict text follows the number rather than being fixed',
    /case for OCR/i.test(String(v.reading || '')), String(v.reading || '').slice(0, 60));

  // The control. An empty list here means the title predicate never fires, and
  // "titles carry the grade" would be a statement about a broken query.
  check('the title reader demonstrably runs',
    Array.isArray(r.titleCaughtWhatTheColumnsMissed) && r.titleCaughtWhatTheColumnsMissed.length > 0,
    `${(r.titleCaughtWhatTheColumnsMissed || []).length} sample(s)`);

  // The evidence sample must show the SILENT titles — the ones a human has to
  // look at to judge whether a pattern is being missed. Showing the loud ones
  // instead would be worse than showing none: it would look like proof that
  // titles are fine.
  {
    const s = r.knownSlabsWithSilentTitles || [];
    const loud = s.filter(x => /psa|bgs|sgc|cgc|graded/i.test(String(x.title || '')));
    check('the samples are the silent titles, not the loud ones',
      s.length > 0 && loud.length === 0,
      s.length ? `${s.length} sample(s), ${loud.length} of them naming a grader` : 'no samples');
  }

  // "ungraded" is a raw claim. Counting it as slab language would manufacture
  // the population this endpoint exists to size, in the direction that argues
  // for the expensive build — so it is checked directly rather than trusted.
  {
    add('2017 Panini Prizm Patrick Mahomes II #269 Ungraded Raw', 'PSA', '8', 1);
    const r2 = await (await fetch(`http://127.0.0.1:${PORT}/api/debug/grade-gap`)).json();
    check('an "ungraded" claim does not read as slab language',
      r2.knownSlabs.titleSaysSlabButNotWho === 2 && r2.knownSlabs.titleSaysNothing === 4,
      `hints=${r2.knownSlabs.titleSaysSlabButNotWho} (want 2) silent=${r2.knownSlabs.titleSaysNothing} (want 4)`);
  }

  // The verdict is the part a person actually reads, so it has to move with the
  // evidence. Asserting only that it says "case for OCR" at 33% would pass
  // against a hardcoded sentence, which would recommend an expensive build
  // regardless of what the data said. So the data is changed underneath it:
  // 200 more slabs whose titles name the grader drop the miss rate to 1.9%,
  // under the 2% threshold, and the recommendation must reverse.
  {
    for (let i = 0; i < 200; i++) {
      ins.run('bulk' + i, iso(DAY0 - (i % 10)),
              '2017 Panini Prizm Patrick Mahomes II #269 Silver PSA 10', 10000,
              'PSA', '10', 'Patrick Mahomes II', '2017', 'Prizm', '269', '', 0.9);
    }
    const r3 = await (await fetch(`http://127.0.0.1:${PORT}/api/debug/grade-gap`)).json();
    const v3 = r3.verdict || {};
    check('the recommendation reverses when the evidence does',
      v3.gradeLostByTitleShare < 2 && /fix nothing/i.test(String(v3.reading || '')),
      `${v3.gradeLostByTitleShare}% — "${String(v3.reading || '').slice(0, 50)}"`);
  }

  server.close();
  console.log(failures ? `\n${failures} check(s) failed` : '\nall grade-gap checks passed');
  process.exit(failures ? 1 : 0);
})().catch(err => { console.error(err); server.close(); process.exit(1); });
