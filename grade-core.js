// Which price series a sale belongs to: raw, or a specific slab.
//
// Split out of server.js so it can be tested directly. It decides two visible
// things — the "Ungraded" badge on every sold tile, and which sales land in the
// Raw line of the price chart — and both were wrong in the same way.
//
// THE BUG THIS EXISTS TO FIX
//
// The old test was /\b(PSA|BGS|SGC|...)\b/i. \b marks a boundary between a word
// character and a non-word character, and a digit is a word character, so
// "PSA10" has no boundary after PSA and the pattern does not match. Nor does it
// match BGS9.5, SGC10, or CGC9. Those are not edge cases — a grader written
// hard against its number is one of the commonest ways a slab is listed on
// eBay, and every one of them was being called Raw.
//
// That is the worst direction to be wrong in. A PSA 10 among raw copies is not
// a comp; it is a different market, often ten times the price, and it lands in
// the median that the page presents as what a raw card is worth.
//
// The fix is to bound on LETTERS instead of word characters, so a digit may
// follow the grader but another letter may not. That keeps the collisions the
// old pattern was careful about — 'isa' inside "Isaiah", 'tag' inside
// "vintage", 'ags' inside "flags" all still fail, because what follows them
// there is a letter — while admitting the numbers.
'use strict';

// Grading companies as they appear in listing titles.
//
// The market index carries its own copy of this list as lowercase substrings,
// because it runs as SQL LIKEs over the whole sales table and cannot afford
// regex. That copy deliberately omits ISA, TAG and AGS, which are unsafe as
// bare substrings. Here they are safe, because the boundaries below are real.
// BVG is Beckett Vintage Grading, and it was missing. /api/debug/raw-filter
// found 102 sales in a 30-day window carrying grader='bvg' in the column, so
// it is demonstrably in this dataset — and a title reading "BVG 9.5" with
// empty columns was landing in Raw. Safe as a bare token for the same reason
// PSA and BGS are: 'bvg' does not occur inside an ordinary word.
const GRADERS = ['PSA', 'BGS', 'BVG', 'BCCG', 'BECKETT', 'SGC', 'CGC', 'CSG',
                 'HGA', 'TAG', 'ISA', 'GMA', 'KSA', 'AGS', 'RCG', 'MNT'];

// Letters, not word characters. See the header: this is the whole fix.
const GRADER_RE = new RegExp(`(?<![A-Za-z])(${GRADERS.join('|')})(?![A-Za-z])`, 'i');

// Phrases that only appear on encapsulated cards. Deliberately excludes bare
// "mint" and "gem mint", which raw listings use constantly as condition claims
// — a seller calling their loose card "gem mint" is making a claim about its
// corners, not saying it is in a holder.
const SLAB_RE = /\b(slab(bed)?|graded|encapsulated|pop\s*\d|cert(ification|ificate|ified)?\s*#?\s*\d)/i;

// An explicit raw claim outranks a grader mention, so "raw, PSA 10 candidate"
// and "ungraded — would grade BGS 9.5" stay where they belong.
const RAW_RE = /\b(raw|ungraded|not\s+graded|no\s+grade)\b/i;

// The grade as the LABEL prints it, when the seller copies the label and leaves
// the grader's name off: "Mint 9", "GEM MT 10", "NM-MT 8", "Pristine 10",
// "Black Label". These are PSA's and BGS's own words for a grade, and a title
// using them was being read as Raw — a slab you could see in the photo, in the
// raw list and the raw median. Measured on the collector's newest 1,500 sales:
// 3 of the 693 titles read as Raw carried one ("…#205 (RC) Mint 9", "…95/99
// GEM MT 10"), and none of the three was a loose card.
//
// Only with a grade NUMBER attached. Bare "mint" and "gem mint" remain the
// condition claims SLAB_RE already refuses to read as a slab ("gem mint
// corners!"). And not when the title is hoping — "gem mint 10 candidate",
// "could be a Mint 9" — which is a raw card being described, not a label.
const LABEL_GRADE_RE = /(?<![a-z])(gem\s*-?\s*mt|(?<!gem\s*-?\s*)mint|nm\s*-?\s*mt\+?|near\s+mint\s*-?\s*mint|pristine)\s*(10|[1-9](?:\.5)?)(?![\d./%])|\bblack\s+label\b/i;
const HOPE_RE = /\b(candidate|potential|could|would|should|ready|worthy|possible|looks?|like)\b/i;

// The grader and its number, pulled out of a title.
//
// Wanted because a slab whose grade column is empty used to land in a bucket
// labelled "Graded (ungraded number)" — every grader and every grade in one
// heap, which is not a price series. The number is right there in the title.
//
// Only a number attached to THIS grader counts. A trailing "10" somewhere later
// in the title may be a card number, a jersey number, or a print run, and
// reading one of those as a grade would invent a PSA 10 that does not exist.
//
// The trailing class excludes '/' as well as digits, because a number sitting
// in front of a slash is a print run. "LAUNDRY TAG 1/1" was being read as a
// grade of 1 and filed in a price series called "TAG 1" — a Flawless one-of-one
// patch card, priced against graded cards, in a bucket no grader ever issued.
const GRADE_AFTER = /^[\s._#:-]*(?:gem\s*)?(?:mt|mint)?[\s._#:-]*(10(?:\.0)?|[1-9](?:\.5)?)(?![\d./])/i;

// TAG is a grading company AND a part of a football card, which no other name
// on the list is.
//
// Measured, not guessed: of 87,238 sales in a 30-day window that eBay's own
// structured fields call graded, 562 had titles naming no grader — and every
// one of the commonest was a laundry tag. "Laundry Tag", "Dual Tag", "Quad
// Tag", "NFL Shield and Nike Logo". The manufacturer's tag cut from the jersey,
// which is a patch card, usually numbered, often the most valuable card in the
// product. Every one of them was being pulled out of Raw and filed under TAG.
//
// So TAG counts as a grader only when a grade number follows it AND no
// qualifier sits in front of it. A bare "tag" in a card title is cloth. The
// cost of this is a genuine TAG slab with no number in its title reading as
// raw; TAG, ISA and AGS together slab a rounding error of the football market,
// and the market index's copy of this list drops all three outright for the
// same reason.
const TAG_QUALIFIER = /(laundry|jersey|dual|quad|triple|jumbo|nike|shield|brand|size|name|price|hang|woven|patch|logo|manufacturer)[\s-]*$/i;

function _graderCounts(grader, before, grade) {
  if (grader !== 'TAG') return true;
  return grade != null && !TAG_QUALIFIER.test(before);
}

// The first grader in the title that survives the check above — not simply the
// first one matched. A title can name a disqualified TAG before it names a real
// grader ("Laundry Tag ... PSA 10"), and stopping at the first match would lose
// the grade that is actually there.
function gradeFromTitle(title) {
  const t = String(title || '');
  GRADER_GLOBAL.lastIndex = 0;
  let m;
  while ((m = GRADER_GLOBAL.exec(t)) !== null) {
    const grader = m[1].toUpperCase();
    const after = t.slice(m.index + m[1].length);
    const g = GRADE_AFTER.exec(after);
    const grade = g ? g[1].replace(/\.0$/, '') : null;
    if (!_graderCounts(grader, t.slice(0, m.index), grade)) continue;
    return { grader, grade };
  }
  return null;
}

// The bucket label for one sale row.
//
// A null grade column does NOT mean raw. It means the collector's parser
// extracted nothing, which happens both for genuinely raw cards and for slabs
// whose titles it could not read. Graded buckets stay clean because they only
// ever contain rows we positively identified, so every miss lands in Raw — and
// that is why the identification above has to be right.
function gradeBucket(r) {
  const row = r || {};
  const title = String(row.title || '');
  const fromTitle = gradeFromTitle(title);

  // A grader COLUMN reading TAG gets the same test as a title reading it.
  //
  // The column was filled by a collector parsing this same title, so it carries
  // the same mistake: grader "TAG" and grade "1", read off "LAUNDRY TAG 1/1",
  // describe a patch card wearing a grade nobody issued. When the title's TAG
  // does not survive the check, neither column is evidence of anything and both
  // are set aside — otherwise the fix would only reach the rows the collector
  // had already given up on.
  const colGrader = String(row.grader || '').toUpperCase();
  const columnsTrusted = !(colGrader === 'TAG' && !(fromTitle && fromTitle.grader === 'TAG'));

  if (columnsTrusted && row.grade != null && row.grade !== '') {
    const g = String(row.grade).replace(/\.0$/, '');
    // The grader may be missing from the column while sitting in the title.
    // Without this fallback the bucket was labelled with a bare number — a
    // series called "10", which tells a reader nothing about what it holds.
    const grader = colGrader || (fromTitle || {}).grader || '';
    return `${grader} ${g}`.trim();
  }

  // An explicit raw claim wins even over a grader mention.
  if (RAW_RE.test(title)) return 'Raw';

  // A grader column with no grade is still unambiguously a slab.
  const grader = (columnsTrusted && colGrader) || (fromTitle && fromTitle.grader) || '';
  if (grader) {
    const num = fromTitle && fromTitle.grade;
    // Named grader AND a number attached to it: a real series, not a heap.
    return num ? `${grader} ${num}` : `${grader} (no grade read)`;
  }
  if (SLAB_RE.test(title)) return 'Graded (ungraded number)';
  // The label's wording with no grader named: a slab, grader unknown, so it
  // joins the other slabs whose grader could not be read rather than
  // inventing a PSA series for it.
  if (LABEL_GRADE_RE.test(title) && !HOPE_RE.test(title)) return 'Graded (ungraded number)';
  return 'Raw';
}

// Is this sale raw? The one question the market index and the badge both ask.
const isRaw = (r) => gradeBucket(r) === 'Raw';

// The title with its grading noise removed, for anything that has to read the
// REST of the title.
//
// The parallel reader works by covering the whole segment after the card
// number, and it gives up when a token is not in its vocabulary. "PSA 10"
// survives that — its filler list holds "psa", and a bare "10" reads as a
// number — but "PSA10" and "BGS9.5" are single unknown tokens, so the reader
// returned "unmatched" and the sale was dropped as having no readable parallel.
//
// The effect was the PSA10 bug wearing a second hat: a slab of a card was not
// merely put in the wrong grade bucket, it was excluded from the card
// altogether. Stripping the grade first is the honest order of operations — a
// grade is not part of a parallel's name, and no parallel in any product
// contains a grader token.
const GRADER_GLOBAL = new RegExp(`(?<![A-Za-z])(${GRADERS.join('|')})(?![A-Za-z])`, 'gi');

function stripGrade(title) {
  const t = String(title || '');
  let out = '';
  let last = 0;
  GRADER_GLOBAL.lastIndex = 0;
  let m;
  while ((m = GRADER_GLOBAL.exec(t)) !== null) {
    // Take the grader token and, when one is attached to it, its number.
    const after = t.slice(m.index + m[1].length);
    const g = GRADE_AFTER.exec(after);
    const grade = g ? g[1].replace(/\.0$/, '') : null;
    // A disqualified TAG is part of the card's name, not grading noise.
    // Stripping it would delete "Laundry Tag" from the title and hand the
    // parallel reader a different card than the one that sold.
    if (!_graderCounts(m[1].toUpperCase(), t.slice(0, m.index), grade)) continue;
    out += t.slice(last, m.index);
    last = m.index + m[1].length + (g ? g[0].length : 0);
    out += ' ';
  }
  out += t.slice(last);
  return out.replace(/\s{2,}/g, ' ').trim();
}

module.exports = { GRADERS, GRADER_RE, SLAB_RE, RAW_RE, LABEL_GRADE_RE, HOPE_RE, gradeFromTitle, gradeBucket, isRaw, stripGrade };
