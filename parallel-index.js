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

  // Longest match wins: "silver prizm" must beat the "prizm" inside it.
  const words = segment.split(' ');
  for (let len = Math.min(maxWords, words.length); len >= 1; len--) {
    for (let i = 0; i + len <= words.length; i++) {
      const hit = LOOKUP.get(words.slice(i, i + len).join(' '));
      if (hit) return { parallel: hit, how: 'matched', segment };
    }
  }
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
