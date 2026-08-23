// The parallel reader, with no data attached. Split for the same reason as
// card-index-core.js: anything server.js can reach is compiled on every cold
// start, and 347 KB of JSON there is 347 KB paid for by requests that never
// read a title.
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

function createParallelIndex(PARALLELS, resolvePlayer) {

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
  // Only when what remains is still a name. "Topps Refractor" shortened to
  // "topps" made every Topps title match a Refractor — including a 1984 Elway
  // base card. A one-word remainder that is a brand or generic word is not a
  // parallel, it is the rest of the sentence.
  const GENERIC = new Set(['topps', 'panini', 'bowman', 'leaf', 'donruss', 'score',
                           'upper', 'deck', 'chrome', 'select', 'mosaic', 'optic',
                           'prizm', 'prizms', 'refractor', 'refractors', 'base']);
  for (const v of [...out]) {
    const short = v.replace(/\s+(prizms?|refractors?|parallels?)$/, '').trim();
    if (!short || short === v) continue;
    if (short.split(' ').length < 2 && GENERIC.has(short)) continue;
    out.add(short);
  }
  return [...out].filter(Boolean);
}

// One vocabulary across all products. Scoping to the product the sale came from
// would be tighter, but the year and set in the sales row are themselves
// unreliable — that is the problem being solved — and a parallel name is
// specific enough on its own that "Refractor" is never a Prizm.
// Built on first use, not at module scope.
//
// This is 47ms of Map, Set and sort work over 3,751 parallels and 4,522 subset
// names, and at module scope it ran during Worker startup on every cold isolate
// — for every request, including the ones that never read a title. Together
// with the rest of startup it was enough to trip the Worker resource limit.
// esbuild hoists the module body regardless of where the require() sits, so
// deferring has to happen in here.
let LOOKUP = null;
let maxWords = 1;
let PRODUCT_NAMES = null;
let SUBSETS = null;
let PRODUCTS_BY_FIRST = null;
let SUBSETS_BY_FIRST = null;
let SUBSET_ALL = null;
let SUBSET_ALL_BARE = null;

function build() {
  if (LOOKUP) return;
  LOOKUP = new Map();
  for (const list of Object.values(PARALLELS.parallelsByProduct || {})) {
    for (const name of list) {
      for (const v of variants(name)) {
        if (!LOOKUP.has(v)) LOOKUP.set(v, name);
        maxWords = Math.max(maxWords, v.split(' ').length);
      }
    }
  }
  PRODUCT_NAMES = [...new Set((PARALLELS.productNames || [])
    .map(n => norm(n).replace(/^(19|20)\d{2}\s+/, '').replace(/\s+(football|basketball|baseball)$/, '').trim())
    .filter(Boolean))].sort((a, b) => b.length - a.length);
  SUBSETS = (PARALLELS.setNames || [])
    .map(norm).filter(n => n && !LOOKUP.has(n))
    .sort((a, b) => b.length - a.length);

  // Indexed by first word, which is what makes residual() affordable.
  //
  // It used to test every phrase against every title: 361 products + 4,522
  // subsets, each an indexOf over two freshly allocated strings. That is ~4,900
  // scans and ~9,800 allocations PER TITLE, and the diagnostics run it over
  // 6,000 titles — about 58 million allocations in one request, which is enough
  // to exhaust a Worker on GC pressure alone even when the CPU budget holds.
  //
  // A phrase can only occur in a title if its first word does, so grouping by
  // that word turns the scan into a lookup over the handful of candidates that
  // could possibly match. Nothing about the ANSWER changes — stripPhrase can
  // only remove text and never fuses two words together, so no phrase becomes
  // newly matchable partway through, and the candidates drawn from the original
  // title stay a superset of everything the old loop could have stripped.
  PRODUCTS_BY_FIRST = groupByFirstWord(PRODUCT_NAMES);
  SUBSETS_BY_FIRST = groupByFirstWord(SUBSETS);

  // Every catalogued set name, including the ones SUBSETS drops for also being
  // parallels — classify() needs to see that overlap, not have it hidden.
  const allSets = (PARALLELS.setNames || []).map(norm).filter(Boolean);
  SUBSET_ALL = new Set(allSets);
  SUBSET_ALL_BARE = new Set(allSets.map(s => s.replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim()).filter(Boolean));
}

function groupByFirstWord(phrases) {
  const m = new Map();
  for (const p of phrases) {
    const first = p.split(' ', 1)[0];
    if (!first) continue;
    let list = m.get(first);
    if (!list) m.set(first, list = []);
    list.push(p);
  }
  // Longest first, so "Stars In The Night" is stripped before "Stars".
  for (const list of m.values()) list.sort((a, b) => b.length - a.length);
  return m;
}

// The phrases that could possibly appear in `text`, longest first.
function candidates(index, text) {
  const out = [];
  for (const tok of new Set(text.split(' '))) {
    const list = index.get(tok);
    if (list) for (const p of list) out.push(p);
  }
  return out.sort((a, b) => b.length - a.length);
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

// Everything in a title that is known NOT to be a parallel: the product, the
// subset, the year, the card number, the player, and the filler. Half the
// titles put the parallel before the card number — "Jaxson Dart RC Refractor
// #306 Giants" — where the after-number rule cannot see it, and searching there
// blind is what turned "A.J. Green" into a Green parallel. Removing the known
// parts instead leaves the parallel standing alone, with nothing to collide
// with.

// Filler for the residual: things that are never a parallel under any product.
// Narrower than FILLER on purpose — FILLER holds "refractor" and "prizm", which
// are real parallel names, so using it here deletes the answer.
//
// "variation" is absent for that same reason and must stay absent. It is a
// parallel in its own right ("Image Variation"), and stripping it turned that
// card's residual into the bare word "image", which matches nothing, so a real
// parallel was read as base. Full coverage already stops it being claimed
// wrongly: "variation silver prizm" has to match end to end, so leaving the
// word in cannot promote a Silver Prizm to a Variation.
const RESIDUAL_FILLER = new Set([
  'rc', 'rookie', 'rookies', 'ssp', 'sp', 'insert', 'card',
  'psa', 'bgs', 'sgc', 'cgc', 'gem', 'mint', 'mt', 'nm', 'lot', 'the',
  // Signature words. Left in, they sat next to the answer and stopped the
  // residual covering it: "Refractor Auto" is a Refractor that happens to be
  // signed, but the pair matches no vocabulary entry and the card fell through
  // to base. Whether a card is autographed is a different fact from which
  // parallel it is.
  'auto', 'autos', 'autograph', 'autographs', 'autographed', 'au', 'signed',
  // The sport. Sellers write it, the catalogue puts it in the product name
  // where it is already stripped, and one leftover word is enough to block a
  // match — "football mojo" instead of "mojo".
  'football', 'basketball', 'baseball', 'hockey', 'soccer',
  // Manufacturer names. The catalogue's product names are the line, not the
  // maker -- "Donruss Optic", not "Panini Donruss Optic" -- so stripping the
  // product leaves the maker behind, and one stray word is enough to stop the
  // residual covering a parallel. It left "panini purple shock prizm" where
  // "purple shock" was sitting in plain sight. A maker is never a parallel.
  'panini', 'topps', 'bowman', 'leaf', 'fleer', 'donruss', 'score', 'upper', 'deck',
  'cardinals', 'falcons', 'ravens', 'bills', 'panthers', 'bears', 'bengals',
  'browns', 'cowboys', 'broncos', 'lions', 'packers', 'texans', 'colts',
  'jaguars', 'chiefs', 'raiders', 'chargers', 'rams', 'dolphins', 'vikings',
  'patriots', 'saints', 'giants', 'jets', 'eagles', 'steelers', 'niners',
  '49ers', 'seahawks', 'buccaneers', 'titans', 'commanders',
]);

function stripPhrase(text, phrase) {
  const i = (' ' + text + ' ').indexOf(' ' + phrase + ' ');
  if (i < 0) return text;
  return (' ' + text + ' ').slice(0, i) + ' ' + (' ' + text + ' ').slice(i + phrase.length + 1);
}

function residual(title, playerHint) {
  build();
  let t = norm(String(title || '').replace(/\([^)]*\)/g, ' '));
  t = t.replace(/#\s*[a-z0-9-]+/gi, ' ').replace(/\b(19|20)\d{2}\b/g, ' ');
  t = t.replace(/\s+/g, ' ').trim();
  for (const p of candidates(PRODUCTS_BY_FIRST, t)) { const n = stripPhrase(t, p); if (n !== t) { t = n; break; } }
  for (const sub of candidates(SUBSETS_BY_FIRST, t)) { const n = stripPhrase(t, sub); if (n !== t) t = n; }
  const hit = resolvePlayer(playerHint || t);
  if (hit && hit.key) for (const w of hit.key.split(' ')) t = stripPhrase(t, w);
  // Deliberately NOT the FILLER set. That contains "refractor" and "prizm",
  // which are real parallel names — stripping them here deletes the very thing
  // being looked for, and is why "RC Refractor #306 Giants" read as nothing.
  return t.split(' ')
    .filter(w => w && !RESIDUAL_FILLER.has(w) && !/^\d+(\.\d+)?$/.test(w))
    .join(' ');
}

/**
 * @returns {{parallel: string|null, how: string, segment: string}}
 *   how: 'matched'    a known parallel name was found
 *        'base'       the segment is empty — a base card, if the feed is regular
 *        'unmatched'  something is there but it is not a parallel we know
 *        'no-number'  no card number, so the segment cannot be located
 */
// strict: no trailing-filler stripping. The residual has already had its filler
// removed, so everything left is meant to be the parallel — and stripping
// further there is what turned "chrome refractor" into "Chrome" by discarding
// the actual answer as though it were noise.
// Product words a seller appends that the catalogue leaves off. The checklist
// says "Purple Shock"; the listing says "Purple Shock Prizm". This is the
// mirror of what variants() handles (the catalogue's "Silver Prizms" against a
// seller's "Silver Prizm") and it needs the opposite trim.
const APPENDED_PRODUCT = new Set(['prizm', 'prizms', 'refractor', 'refractors',
                                  'mosaic', 'optic', 'parallel', 'parallels']);

function coverMatch(segment, strict = false) {
  build();
  const isFiller = (t) => FILLER.has(t) || /^\d+(\.\d+)?$/.test(t);
  let toks = segment.split(' ').filter(Boolean);
  while (toks.length) {
    const hit = LOOKUP.get(toks.join(' '));
    if (hit) return hit;
    if (strict) {
      // One concession inside strict mode: drop a trailing product word, but
      // only while at least two words remain. That is what separates this from
      // the trimming strict mode exists to forbid -- "chrome refractor" must
      // NOT become "Chrome", because a one-word remainder is the rest of the
      // sentence rather than a parallel, and that mistake made every Topps
      // title a Refractor. "purple shock prizm" -> "Purple Shock" keeps two
      // words and stays specific enough to be an answer.
      if (toks.length > 2 && APPENDED_PRODUCT.has(toks[toks.length - 1])) {
        toks = toks.slice(0, -1);
        continue;
      }
      return null;
    }
    if (!isFiller(toks[toks.length - 1])) return null;
    toks = toks.slice(0, -1);
  }
  return null;
}

function resolveParallel(title, opts = {}) {
  const t = String(title || '');
  if (!CARD_NUMBER.test(t)) return { parallel: null, how: 'no-number', segment: '' };

  const segment = parallelSegment(t);
  if (!segment) {
    // Nothing after the number. Before concluding base, check whether the
    // parallel is stated earlier in the title instead.
    const res = residual(t, opts.player);
    const early = res ? coverMatch(res, true) : null;
    if (early) return { parallel: early, how: 'matched-before-number', segment: res };
    return { parallel: null, how: 'base', segment: '' };
  }

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
  const after = coverMatch(segment);
  if (after) return { parallel: after, how: 'matched', segment };

  // Not after the number. Strip everything known and see what stands alone.
  const res = residual(t, opts.player);
  const early = res ? coverMatch(res, true) : null;
  if (early) return { parallel: early, how: 'matched-before-number', segment: res };

  // Nothing but filler followed the number, and nothing before it named a
  // parallel either. Now base is a safe reading: the earlier objection was
  // that a parallel might be stated before the number, and that has just been
  // checked.
  const onlyFiller = segment.split(' ').every(
    w => FILLER.has(w) || /^\d+(\.\d+)?$/.test(w));
  if (onlyFiller) return { parallel: null, how: 'base', segment };
  // Filler-only is NOT the same evidence as an empty segment, and treating it
  // as base asserts something false. "Jaxson Dart RC Refractor #306 Giants
  // Rookie" leaves only "giants rookie" after the number, but the card is a
  // Refractor — the parallel is stated before the number in that title format.
  // Base is an actionable answer and unmatched is not, so the honest one wins:
  // a parallel may be named somewhere this reader does not look.
  return { parallel: null, how: 'unmatched', segment };
}

  return {
  resolveParallel,
  norm,
  // Is this string an insert SET rather than a parallel? The two are different
  // things in the checklists and the sales column does not distinguish them —
  // it writes "Downtown" in the parallel field, where the catalogue calls
  // Downtown! a set. Telling them apart is what separates the reader being
  // wrong from the column being loose, and they need opposite fixes.
  classify(name) {
    build();
    const n = norm(name);
    if (!n) return 'empty';
    // The column drops the punctuation the checklist keeps: "Downtown" for
    // "Downtown!". Compare on letters and digits alone as well.
    const bare = n.replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
    const isParallel = LOOKUP.has(n) || (bare && LOOKUP.has(bare));
    // SUBSET_SET excludes anything already in LOOKUP, so a name that is both
    // only ever appears there under its raw catalogue spelling — check the
    // set names directly instead.
    const isSubset = SUBSET_ALL.has(n) || (bare && SUBSET_ALL_BARE.has(bare));
    // Both, and it matters. "Kaboom" is a parallel in one product and the name
    // of an insert set in seven others, so asking which one it "is" has no
    // answer — and answering 'parallel' because that test ran first counted
    // every Kaboom! Horizontal card as a reader defect when the reader had
    // correctly read it as a set with no parallel. That inflated the one number
    // the wiring decision turns on.
    if (isParallel && isSubset) return 'both';
    if (isParallel) return 'parallel';
    if (isSubset) return 'subset';
    return 'unknown';
  },
  stats: {
    get products() { return (PARALLELS.products || []).length; },
    get distinctParallels() {
      return new Set(Object.values(PARALLELS.parallelsByProduct || {}).flat()).size;
    },
    get lookupEntries() { build(); return LOOKUP.size; },
    get longestName() { build(); return maxWords; },
  },
  };
}

module.exports = { createParallelIndex, norm };
