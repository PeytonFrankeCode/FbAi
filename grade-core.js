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
const GRADERS = ['PSA', 'BGS', 'BCCG', 'BECKETT', 'SGC', 'CGC', 'CSG',
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

// The grader and its number, pulled out of a title.
//
// Wanted because a slab whose grade column is empty used to land in a bucket
// labelled "Graded (ungraded number)" — every grader and every grade in one
// heap, which is not a price series. The number is right there in the title.
//
// Only a number attached to THIS grader counts. A trailing "10" somewhere later
// in the title may be a card number, a jersey number, or a print run, and
// reading one of those as a grade would invent a PSA 10 that does not exist.
const GRADE_AFTER = /^[\s._#:-]*(?:gem\s*)?(?:mt|mint)?[\s._#:-]*(10(?:\.0)?|[1-9](?:\.5)?)(?![\d.])/i;

function gradeFromTitle(title) {
  const t = String(title || '');
  const m = GRADER_RE.exec(t);
  if (!m) return null;
  const grader = m[1].toUpperCase();
  const after = t.slice(m.index + m[1].length);
  const g = GRADE_AFTER.exec(after);
  return { grader, grade: g ? g[1].replace(/\.0$/, '') : null };
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

  if (row.grade != null && row.grade !== '') {
    const g = String(row.grade).replace(/\.0$/, '');
    // The grader may be missing from the column while sitting in the title.
    // Without this fallback the bucket was labelled with a bare number — a
    // series called "10", which tells a reader nothing about what it holds.
    const grader = String(row.grader || '').toUpperCase()
      || (gradeFromTitle(title) || {}).grader
      || '';
    return `${grader} ${g}`.trim();
  }

  // An explicit raw claim wins even over a grader mention.
  if (RAW_RE.test(title)) return 'Raw';

  // A grader column with no grade is still unambiguously a slab.
  const fromTitle = gradeFromTitle(title);
  const grader = String(row.grader || '').toUpperCase() || (fromTitle && fromTitle.grader) || '';
  if (grader) {
    const num = fromTitle && fromTitle.grade;
    // Named grader AND a number attached to it: a real series, not a heap.
    return num ? `${grader} ${num}` : `${grader} (no grade read)`;
  }
  if (SLAB_RE.test(title)) return 'Graded (ungraded number)';
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
    out += t.slice(last, m.index);
    // Take the grader token and, when one is attached to it, its number.
    const after = t.slice(m.index + m[1].length);
    const g = GRADE_AFTER.exec(after);
    last = m.index + m[1].length + (g ? g[0].length : 0);
    out += ' ';
  }
  out += t.slice(last);
  return out.replace(/\s{2,}/g, ' ').trim();
}

module.exports = { GRADERS, GRADER_RE, SLAB_RE, RAW_RE, gradeFromTitle, gradeBucket, isRaw, stripGrade };
