// Recover a card's parallel from its listing title.
//
// Only 48.4% of priced sales carry a parallel in the column, and 38.9% carry a
// full card identity — which caps the index at roughly a third of the data,
// because a sale whose parallel is unknown cannot be compared against one whose
// parallel is known. Yet the parallel is sitting in the title:
//
//   2025 Panini Prizm - Rookies Jaxson Dart #332 Silver Prizm (RC)
//   2025 Topps Chrome - Rookies Jaxson Dart #306 Refractor (RC)
//   1984 Topps - John Elway #63 (RC)
//
// These titles are structured, not free text, and the shape is the useful part:
// the parallel sits AFTER the card number and before the trailing (RC). Reading
// only that segment is what keeps "A.J. Green" from being read as a Green
// parallel and "Panini Prizm" from being read as a Prizm one — the player and
// the set both live before the number.
//
// The third title has nothing in that segment. In a feed this regular that is
// evidence of a base card rather than of a failed parse, but it is reported
// separately rather than assumed, because guessing "Base" wrongly merges a
// $400 parallel into a $3 card.
const PARALLELS = require('./data/parallel-index.json');

function norm(s) {
  return String(s == null ? '' : s)
    .replace(/[.,''`"’]/g, '')
    .replace(/[-/]/g, ' ')
    // "&" is not punctuation to throw away here. Left in place it split
    // "Red White & Blue Prizm" into tokens the vocabulary could not span, and
    // the reader settled for the "Blue Prizm" inside it — a different, commoner
    // card. Both spellings are indexed, so either can be the canonical one.
    .replace(/&/g, ' and ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// Checklists write "Silver Prizms", sellers write "Silver Prizm". Both forms go
// in, so neither spelling has to be the canonical one.
function variants(name) {
  const n = norm(name);
  if (!n) return [];
  const out = new Set([n]);
  out.add(n.replace(/s$/, ''));
  out.add(n + 's');
  // Sellers drop the conjunction: "Red White and Blue" and "Red White Blue" are
  // the same parallel and both appear.
  const noAnd = n.replace(/\band\b/g, ' ').replace(/\s+/g, ' ').trim();
  if (noAnd && noAnd !== n) { out.add(noAnd); out.add(noAnd.replace(/s$/, '')); }
  // "White Disco Prizms" is also written "White Disco". Without the shortened
  // form the reader cannot cover the whole segment and falls back to the bare
  // "White", which is a different parallel.
  for (const v of [...out]) {
    const short = v.replace(/\s+(prizms?|refractors?|parallels?)$/,'').trim();
    if (short && short !== v) out.add(short);
  }
  return [...out].filter(Boolean);
}

// One vocabulary across all products. Scoping to the product the sale came from
// would be tighter, but the year and set in the sales row are themselves
// unreliable — that is the problem being solved — and a parallel name is
// specific enough on its own that "Refractor" is never a Prizm.
const LOOKUP = new Map();   // normalised variant -> canonical parallel name
let maxWords = 1;
for (const list of Object.values(PARALLELS.parallelsByProduct || {})) {
  for (const name of list) {
    for (const v of variants(name)) {
      if (!LOOKUP.has(v)) LOOKUP.set(v, name);
      maxWords = Math.max(maxWords, v.split(' ').length);
    }
  }
}

// Words that may trail a parallel without being part of it. Stripping them is
// what lets a match cover the WHOLE segment, which is the safety property: a
// match that covers only part of it is a different card.
const FILLER = new Set([
  'prizm', 'prizms', 'refractor', 'refractors', 'parallel', 'parallels',
  'rc', 'rookie', 'rookies', 'ssp', 'sp', 'insert', 'card', 'variation',
  'psa', 'bgs', 'sgc', 'cgc', 'gem', 'mint', 'mt', 'nm',
  // Team nicknames trail constantly in the Cosmic Chrome inserts
  // ("... #STN-5 Giants"), and one of them would otherwise be read as a
  // parallel outright.
  'cardinals', 'falcons', 'ravens', 'bills', 'panthers', 'bears', 'bengals',
  'browns', 'cowboys', 'broncos', 'lions', 'packers', 'texans', 'colts',
  'jaguars', 'chiefs', 'raiders', 'chargers', 'rams', 'dolphins', 'vikings',
  'patriots', 'saints', 'giants', 'jets', 'eagles', 'steelers', 'niners',
  '49ers', 'seahawks', 'buccaneers', 'titans', 'commanders',
]);

// The part of the title that can hold a parallel: after the card number, before
// the trailing designations.
const CARD_NUMBER = /#\s*[A-Za-z0-9-]+/;
function parallelSegment(title) {
  const t = String(title || '');
  const m = t.match(CARD_NUMBER);
  let seg = m ? t.slice(m.index + m[0].length) : '';
  // (RC), (Rookie Card), and similar trailing notes are not parallels.
  seg = seg.replace(/\([^)]*\)/g, ' ');
  return norm(seg);
}

/**
 * @returns {{parallel: string|null, how: string, segment: string}}
 *   how: 'matched'    a known parallel name was found
 *        'base'       the segment is empty — a base card, if the feed is regular
 *        'unmatched'  something is there but it is not a parallel we know
 *        'no-number'  no card number, so the segment cannot be located
 */
function resolveParallel(title) {
  const t = String(title || '');
  if (!CARD_NUMBER.test(t)) return { parallel: null, how: 'no-number', segment: '' };

  const segment = parallelSegment(t);
  if (!segment) return { parallel: null, how: 'base', segment: '' };

  // Anchored at the start of the segment, longest first.
  //
  // Matching anywhere inside the segment is what made this unsafe. "White Disco
  // Prizm" is not in the vocabulary, so a floating search found the "Disco
  // Prizms" inside it; "Red White and Blue Prizm" gave up its "Blue Prizm"; and
  // a segment of trailing junk like "Giants Rookie" matched "Rookie", which is
  // a parallel in some product. Each of those merges two different cards and
  // nothing downstream can notice.
  //
  // The parallel begins where the segment begins, so requiring the match to
  // start at the first word turns all three into an honest "unmatched", which
  // costs sample and cannot corrupt a price.
  // The match must cover the ENTIRE segment once trailing filler is removed.
  //
  // Partial matches are the whole danger. Anchoring at the first word was not
  // enough on its own: "White Disco Prizm" then matched the bare "White", which
  // is a real but different parallel, and merging those two is exactly the harm
  // this is meant to avoid. Covering everything means the reader either
  // understands the segment or admits it does not.
  const isFiller = (t) => FILLER.has(t) || /^\d+(\.\d+)?$/.test(t);
  let toks = segment.split(' ');
  while (toks.length) {
    const hit = LOOKUP.get(toks.join(' '));
    if (hit) return { parallel: hit, how: 'matched', segment };
    if (!isFiller(toks[toks.length - 1])) break;
    toks = toks.slice(0, -1);
  }
  // Filler-only is NOT the same evidence as an empty segment, and treating it
  // as base asserts something false. "Jaxson Dart RC Refractor #306 Giants
  // Rookie" leaves only "giants rookie" after the number, but the card is a
  // Refractor — the parallel is stated before the number in that title format.
  // Base is an actionable answer and unmatched is not, so the honest one wins:
  // a parallel may be named somewhere this reader does not look.
  return { parallel: null, how: 'unmatched', segment };
}

module.exports = {
  resolveParallel,
  norm,
  stats: {
    products: (PARALLELS.products || []).length,
    distinctParallels: new Set(
      Object.values(PARALLELS.parallelsByProduct || {}).flat()).size,
    lookupEntries: LOOKUP.size,
    longestName: maxWords,
  },
};
