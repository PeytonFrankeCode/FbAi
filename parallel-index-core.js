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

// A key for deciding whether two spellings name the SAME parallel, used to
// group one card's sales together.
//
// The vocabulary holds "Silver" and "Silver Prizm" as separate entries, because
// different products name the same idea differently, and the 2017 Prizm
// checklist writes its parallels the other way round again — "Prizm Gold
// Vinyl", where a seller types "Gold Vinyl Prizm". Reading a title therefore
// returns whichever spelling happened to match, and grouping on the raw answer
// splits one card's sales across two or three piles. That is exactly what left
// a card showing two sales when it had five.
//
// So the product word is stripped from either end. This is not a new rule:
// variants() above already indexes "X Prizm" under "X" for lookup, so the
// vocabulary has always treated them as one name. This applies the same rule at
// grouping time.
//
// WHY STRIPPING THIS HARD IS SAFE HERE, AND ONLY HERE: these keys are never
// compared globally. They are compared only between sales that already share a
// player, a year, a set and a card number — so "Red" colliding with some other
// product's "Red" cannot happen, because the other product is a different set
// and never reaches the same comparison. A global lookup could not do this.
//
// The guard against emptying the string matters: "Prizm" and "Refractor" ARE
// the parallel in their own products, and reducing either to nothing would
// merge it into the base card — the single most expensive mistake available
// here, since it puts a parallel's price into the base card's median.
const PRODUCT_WORD = new Set(['prizm', 'prizms', 'refractor', 'refractors',
                              'parallel', 'parallels']);

function parallelKey(name) {
  const toks = norm(name).split(' ').filter(Boolean);
  while (toks.length > 1 && PRODUCT_WORD.has(toks[toks.length - 1])) toks.pop();
  while (toks.length > 1 && PRODUCT_WORD.has(toks[0])) toks.shift();
  return toks.join(' ');
}

// Parallels that say what they are wherever they sit in a title. "Tiffany" is
// the glossy factory parallel of a whole set (Topps and Topps Traded 1984-91,
// Bowman 1989-90, Fleer Tradition 2002-03) and is never a product, an insert
// or a player (owner, Oct 2026). Read first, because it is usually written
// beside the product name, ahead of a player this reader may not know: "1987
// TOPPS TIFFANY #366 MARK MCGWIRE" and "1984 Topps Tiffany Set-Break #300"
// were read as nothing.
const SELF_EVIDENT = [{ re: /(?<![a-z])tiffany(?![a-z])/i, name: 'Tiffany' }];

// Team names with a colour (or a parallel word) in them. Rookie cards show
// the college, and sellers write it: "2017 Score Patrick Mahomes II #403 Red
// Raiders RC" read as the Red parallel, because "raiders" is NFL filler and
// "red" was all that was left. Removed as whole phrases before any parallel
// is looked for. public/app.js keeps a copy in PARALLEL_STRIP_TEAMS; a test
// holds the two equal, and holds every phrase clear of every parallel name we
// know ("Green Wave" is Tulane, and also a Prizm parallel, so it is not here).
const COLOR_TEAM_PHRASES = [
  'red raiders', 'crimson tide', 'blue devils', 'mean green',
  'golden bears', 'golden gophers', 'golden hurricane', 'golden flashes',
  'golden eagles', 'golden knights', 'golden lions', 'golden griffins',
  'golden panthers', 'golden rams', 'scarlet knights', 'black knights',
  'blue raiders', 'blue hens', 'rainbow warriors', 'red wolves', 'red hawks',
  'redhawks', 'purple eagles', 'black bears', 'big red', 'syracuse orange',
  'green bay', 'red sea',
].sort((a, b) => b.length - a.length);
// NFL teams by full name, and the two-word cities, blanked the same way:
// "Red Sparkle #138 Kansas City Chiefs" left "kansas city" standing beside
// the parallel, the reader could not cover it, and a Red Sparkle went unread.
// (A lone nickname after the number is already filler.)
const NFL_TEAM_PHRASES = [
  'arizona cardinals', 'atlanta falcons', 'baltimore ravens', 'buffalo bills',
  'carolina panthers', 'chicago bears', 'cincinnati bengals', 'cleveland browns',
  'dallas cowboys', 'denver broncos', 'detroit lions', 'green bay packers',
  'houston texans', 'indianapolis colts', 'jacksonville jaguars', 'kansas city chiefs',
  'las vegas raiders', 'oakland raiders', 'los angeles chargers', 'san diego chargers',
  'los angeles rams', 'st louis rams', 'miami dolphins', 'minnesota vikings',
  'new england patriots', 'new orleans saints', 'new york giants', 'new york jets',
  'philadelphia eagles', 'pittsburgh steelers', 'san francisco 49ers', 'seattle seahawks',
  'tampa bay buccaneers', 'tennessee titans', 'houston oilers', 'washington commanders',
  'washington redskins', 'washington football team',
  'kansas city', 'new england', 'new orleans', 'tampa bay', 'las vegas',
  'los angeles', 'san francisco', 'new york', 'green bay',
];
// NFL nicknames on their own. A team is never a player: the card index build
// strips these from checklist player fields, and the alias table is cleaned
// of names resolved before it did (owner, Oct 2026).
const NFL_NICKNAMES = ['cardinals', 'falcons', 'ravens', 'bills', 'panthers', 'bears', 'bengals', 'browns',
  'cowboys', 'broncos', 'lions', 'packers', 'texans', 'colts', 'jaguars', 'chiefs', 'raiders', 'chargers',
  'rams', 'dolphins', 'vikings', 'patriots', 'saints', 'giants', 'jets', 'eagles', 'steelers', '49ers',
  'niners', 'seahawks', 'buccaneers', 'bucs', 'titans', 'oilers', 'commanders', 'redskins'];
const _TEAM_STRIP = [...new Set([...COLOR_TEAM_PHRASES, ...NFL_TEAM_PHRASES])].sort((a, b) => b.length - a.length);
const _COLOR_TEAM_RE = new RegExp(`\\b(?:${_TEAM_STRIP.map(p => p.replace(/ /g, '\\s+')).join('|')})\\b`, 'gi');
// The text with those team names (both lists) blanked out.
function stripColorTeams(text) {
  return String(text == null ? '' : text).replace(_COLOR_TEAM_RE, ' ');
}

// What sellers write about condition, grading and themselves, never part of a
// parallel's name: "NR-MINT *GMCARDS*", "NM-MT OR BETTER", "HOF PSA 10 GEM
// MINT", "RC Base Rookie Cardinals Nice". Left in, they sat after the number,
// the reader could not cover them, and a plain base card came back unread.
// Any of these that is also a word of a real parallel name is dropped from
// the list when the vocabulary is built (build()), so none can delete one.
const SELLER_WORDS = [
  'nm', 'mt', 'nmmt', 'nr', 'nrmt', 'nrmint', 'ex', 'exmt', 'exmint', 'vg', 'vgex', 'vgexmt',
  'or', 'better', 'gmcards', 'setbreak', 'hof', 'nfl', 'pop', 'invest', 'investment',
  'centered', 'graded', 'slabbed', 'ungraded', 'raw', 'nice', 'sharp', 'clean',
  'beautiful', 'wow', 'look', 'hot', 'rated', 'prospect', 'rookies', 'card', 'cards',
  'football', 'pack', 'fresh', 'pulled', 'pull', 'mint', 'gem', 'near', 'excellent',
];
// One-word "parallels" that are words sellers write about any card: "Las
// Vegas Raiders NFL Football" was read as the NFL parallel.
const NEVER_ALONE = new Set(['nfl', 'base', 'rookie', 'rc', 'football',
  // A product's own name on its own is the product: "2025 Prizm Cam Ward Auto"
  // is not a Prizm parallel.
  'prizm', 'prizms', 'chrome', 'optic', 'mosaic', 'select', 'topps', 'panini', 'donruss']);
// Words that are part of a few real parallel names ("Gold NFL Shield", "Rated
// Rookie Logo Holo") but far more often are sellers talking. A match is tried
// with them first, then without: "Gold Ice Rated Prospect" is Gold Ice, while
// "Gold NFL Shield" keeps its NFL.
const SOFT_WORDS = new Set(['nfl', 'rated', 'base', 'prospect', 'prospects', 'or', 'better', 'less', 'fewer']);
const dropSoft = (text) => String(text || '').split(' ').filter(w => w && !SOFT_WORDS.has(w)).join(' ');
// Product words a seller leaves beside the parallel: "Chrome Mojo Refractor",
// "Holo Prizm". Dropped from either end only while what remains is itself a
// parallel name, and never down to a bare product word ("chrome refractor"
// must not become "Chrome").
const EDGE_PRODUCT = new Set(['chrome', 'prizm', 'prizms', 'optic', 'mosaic', 'select', 'topps', 'panini', 'donruss']);

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
  // The product word can lead as well: the 2025 Prizm checklist says "Prizm
  // White Disco", sellers say "White Disco". Only when two words remain.
  for (const v of [...out]) {
    const lead = v.replace(/^(prizms?|refractors?)\s+/, '').trim();
    if (lead && lead !== v && lead.split(' ').length >= 2) out.add(lead);
  }
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
let VOCAB_TOKENS = null;
let JUNK = null;
let PARALLEL_SIGNAL = null;
let TOKSET = null;

function build() {
  if (LOOKUP) return;
  LOOKUP = new Map();
  // The first spelling seen names the parallel, so the modern checklists go
  // first: sellers write today's names ("Gold Refractors", "Gold Vinyl"), and
  // the 2010-2016 catalogues only add the spellings nobody newer uses.
  const byProduct = Object.entries(PARALLELS.parallelsByProduct || {});
  const older = ([id]) => /^(19\d\d|20(0\d|1[0-6]))-/.test(id);
  const ordered = [...byProduct.filter(e => !older(e)), ...byProduct.filter(older)];
  for (const [, list] of ordered) {
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

  // Every word of every parallel name, and the seller words that are none of
  // them (so filler can never delete part of a real name).
  VOCAB_TOKENS = new Set();
  for (const k of LOOKUP.keys()) for (const w of k.split(' ')) if (w) VOCAB_TOKENS.add(w);
  JUNK = new Set(SELLER_WORDS.filter(w => !VOCAB_TOKENS.has(w)));
  // The words that say "a parallel is named here": parallel-name words that
  // are not also product names or glue. A base reading is refused while one of
  // these is left unexplained in the title.
  const WEAK = new Set(['prizm', 'prizms', 'chrome', 'select', 'mosaic', 'optic', 'topps', 'panini',
    'donruss', 'bowman', 'score', 'the', 'of', 'and', 'on', 'a', 'in', 'no', 'to', 'at', 'for',
    'card', 'cards', 'edition', 'level', 'die', 'cut', 'set', 'series', 'rookie', 'rookies', 'rc',
    'base', 'nfl', 'football', 'auto', 'autograph', 'autographs', 'signature', 'signatures', 'patch',
    'draft', 'picks', 'premium', 'variation', 'variations', 'insert', 'inserts', 'ssp', 'sp', 'stars']);
  PARALLEL_SIGNAL = new Set([...VOCAB_TOKENS].filter(w => !WEAK.has(w) && !/^\d+$/.test(w) && w.length > 1));
  // Word order: sellers write "White Disco" and "Disco White", "Neon Green
  // Pulsar" and "Green Pulsar Neon". The same words in any order name the
  // parallel, when exactly one parallel has those words.
  TOKSET = new Map();
  for (const [k, name] of LOOKUP) {
    const toks = [...new Set(k.split(' ').filter(Boolean))].sort();
    if (toks.length < 2) continue;
    const key = toks.join(' ');
    // Two names with the same words are one parallel spelled two ways
    // ("White Disco" in one checklist, "Disco White" in another). The first
    // spelling seen stands for both.
    if (!TOKSET.has(key)) TOKSET.set(key, name);
  }
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
  return norm(stripColorTeams(seg)).replace(/\s+/g, ' ').trim();
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
  // A name's suffix, left behind when the search names "Patrick Mahomes" and
  // the title says "Patrick Mahomes II": "ii red sparkle" covered nothing, and
  // with nothing after the number the card was read as BASE.
  'ii', 'iii', 'iv', 'jr', 'sr',
  // Team nicknames, for the same reason: "Red Sparkle Chiefs #138" is a Red
  // Sparkle. No parallel name in the checklists contains one (a test holds it).
  'cardinals', 'falcons', 'ravens', 'bills', 'panthers', 'bears', 'bengals',
  'browns', 'cowboys', 'broncos', 'lions', 'packers', 'texans', 'colts',
  'jaguars', 'chiefs', 'raiders', 'chargers', 'rams', 'dolphins', 'vikings',
  'patriots', 'saints', 'giants', 'jets', 'eagles', 'steelers', 'niners',
  '49ers', 'seahawks', 'buccaneers', 'titans', 'commanders', 'oilers', 'redskins',
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

function residual(title, playerHint, opts = {}) {
  build();
  let t = norm(stripColorTeams(String(title || '').replace(/\([^)]*\)/g, ' ')));
  t = t.replace(/#\s*[a-z0-9-]+/gi, ' ').replace(/\b(19|20)\d{2}\b/g, ' ');
  t = t.replace(/\s+/g, ' ').trim();
  for (const p of candidates(PRODUCTS_BY_FIRST, t)) { const n = stripPhrase(t, p); if (n !== t) { t = n; break; } }
  // Insert-set names come out of the words BEFORE the number only. After it
  // they stay: "#106 Signatures" is a set in one product and something else in
  // another, and a /25 of it is numbered: the review desk decides those per
  // product, and a blanket strip here would call them all base.
  if (opts.subsets !== false) {
    for (const sub of candidates(SUBSETS_BY_FIRST, t)) { const n = stripPhrase(t, sub); if (n !== t) t = n; }
  }
  // "Set-Break" is how vintage sellers say "from a broken-up set"; its
  // "break" is also a parallel word ("Fast Break"), so the phrase goes whole.
  t = t.replace(/\bset\s+break\b/g, ' ').replace(/\s+/g, ' ').trim();
  const hit = resolvePlayer(playerHint || t);
  if (hit && hit.key) for (const w of hit.key.split(' ')) t = stripPhrase(t, w);
  // A player the index does not know yet (a new rookie) but the caller named:
  // his name is still not a parallel.
  else if (playerHint) for (const w of norm(playerHint).split(' ')) if (w) t = stripPhrase(t, w);
  // Deliberately NOT the FILLER set. That contains "refractor" and "prizm",
  // which are real parallel names — stripping them here deletes the very thing
  // being looked for, and is why "RC Refractor #306 Giants" read as nothing.
  return t.split(' ')
    .map(w => w.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, ''))
    .filter(w => w && !RESIDUAL_FILLER.has(w) && !JUNK.has(w) && !/^\d+(\.\d+)?$/.test(w))
    .join(' ');
}

// The parallel named by these words in any order, when exactly one is.
function tokenSetMatch(text) {
  build();
  const toks = [...new Set(String(text || '').split(' ').filter(Boolean))].sort();
  if (toks.length < 2) return null;
  return TOKSET.get(toks.join(' ')) || null;
}

// The parallel a run of leftover words names: whole, in any order, with
// product words at its edges set aside, and then again without the soft words.
function leftoverMatch(text) {
  const tryOne = (txt) => {
    if (!txt) return null;
    const direct = alone(coverMatch(txt, true)) || tokenSetMatch(txt);
    if (direct) return direct;
    let toks = txt.split(' ');
    while (toks.length > 1 && EDGE_PRODUCT.has(toks[0])) toks = toks.slice(1);
    while (toks.length > 1 && EDGE_PRODUCT.has(toks[toks.length - 1])) toks = toks.slice(0, -1);
    const trimmed = toks.join(' ');
    const hit = trimmed !== txt && !EDGE_PRODUCT.has(trimmed)
      ? (alone(coverMatch(trimmed, true)) || tokenSetMatch(trimmed)) : null;
    if (hit) return hit;
    // "Mojo Refractor" where the checklist says "Mojo": a trailing finish
    // word, set aside only when what remains is a parallel on its own.
    if (toks.length > 1 && /^refractors?$/.test(toks[toks.length - 1])) {
      const rest = toks.slice(0, -1).join(' ');
      if (!EDGE_PRODUCT.has(rest)) return alone(coverMatch(rest, true)) || tokenSetMatch(rest);
    }
    return null;
  };
  return tryOne(text) || (dropSoft(text) !== text ? tryOne(dropSoft(text)) : null);
}

// A one-word match that is only a word sellers write about any card.
function alone(hit) {
  return hit && NEVER_ALONE.has(norm(hit)) ? null : hit;
}

// Is there a parallel word left unexplained in this text? Then "base" would
// be a guess: "Mojo Refractor RC #91TRC-1 Rookie" has only filler after the
// number, and was read as the base card.
function namesAParallel(text) {
  build();
  return dropSoft(text).split(' ').some(w => PARALLEL_SIGNAL.has(w));
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
  const isFiller = (t) => FILLER.has(t) || JUNK.has(t.replace(/[^a-z0-9]/g, '')) || !/[a-z0-9]/.test(t) || /^\d+(\.\d+)?$/.test(t);
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

// Which catalogued SUBSET does this title name?
//
// A product is not one list of cards. 2017 Panini Prizm is a 300-card base set
// plus fourteen inserts, and every insert restarts numbering at #1 — so "#8" in
// that product is a base card, an Instant Impact, a Hall of Fame, an NFL MVP, a
// Rize Up and five more. The sales table has one `set_name` column and it holds
// the PRODUCT, so all of those are "Prizm" with a card number that does not
// distinguish them.
//
// The subset is usually sitting in the title. This reports it.
//
// The vocabulary is the one residual() already strips with — SUBSETS, built
// from the checklists' set names and filtered against LOOKUP, so a name that is
// also a parallel ("Silver", "Gold Vinyl") is never returned here. Longest
// match wins, because "Rookie Patch Autographs" contains "Rookie Autographs"
// and the shorter one is a different set.
function resolveSubset(title, opts = {}) {
  build();
  let t = norm(String(title || '').replace(/\([^)]*\)/g, ' '));
  // The card number and the year are stripped for the same reason residual()
  // strips them: a subset name never contains either, and leaving them in only
  // creates chances to match across them.
  t = t.replace(/#\s*[a-z0-9-]+/gi, ' ').replace(/\b(19|20)\d{2}\b/g, ' ')
       .replace(/\s+/g, ' ').trim();
  if (!t) return { subset: null, how: 'empty' };

  // The PRODUCT comes out first, exactly as residual() does it, and for a
  // reason found by testing rather than reasoning: some checklist catalogues a
  // set literally named "Topps", so "1984 Topps - John Elway #63" was read as
  // an insert called Topps. The product name is in every title by definition,
  // which makes it the one phrase guaranteed to create a false match.
  for (const p of candidates(PRODUCTS_BY_FIRST, t)) {
    const n = stripPhrase(t, p);
    if (n !== t) { t = n.replace(/\s+/g, ' ').trim(); break; }
  }

  // candidates() is indexed by first word, so this does not scan 4,522 names.
  for (const sub of candidates(SUBSETS_BY_FIRST, t)) {
    if (stripPhrase(t, sub) !== t) {
      // A single generic word is the rest of the sentence, not a set name —
      // the same trap coverMatch() guards against for parallels.
      if (sub.split(' ').length < 2 && GENERIC_SUBSET.has(sub)) continue;
      if (unsafeSubset(sub)) continue;
      return { subset: sub, how: 'matched' };
    }
  }
  return { subset: null, how: 'unmatched' };
}

// Catalogued set names that are real but must never be matched against a title.
//
// Both kinds were found by running the reader over a month of live sales and
// reading the top of the list, not by thinking about it beforehand.
//
//   A TRIBUTE SET NAMED AFTER A PLAYER. 2019 National Treasures has a two-card
//   set called "Tom Brady". Matching it tags EVERY Brady listing in the dataset
//   as belonging to those two cards — including "TOM BRADY 25 CARD LOT INVEST
//   GOAT HOF MVP TB12", which is not a card at all. It was the fourth-commonest
//   "subset" in the sample at 343 sales.
//
//   A TRUNCATED NAME. The 2018 Flawless checklist carries a set called "Red,
//   White and" — source data cut off mid-phrase. It matched Prizm's "Red White
//   and Blue" PARALLEL, which is a different product entirely.
//
// Both would have caused false SPLITS if this were wired into card identity:
// one card's sales divided because some titles matched a set that was never
// really named. That is the failure mode this whole reader is meant to avoid,
// and it took real data to see it.
let UNSAFE = null;

function unsafeSubset(name) {
  if (!UNSAFE) {
    UNSAFE = new Set();
    for (const n of SUBSETS) {
      // Cut off mid-phrase: a set name never ends on a conjunction or article.
      if (/\b(and|or|the|of|with|vs|in|on|for|a|an|to)$/.test(n)) { UNSAFE.add(n); continue; }
      // Named after a player. Two words or more, because a one-word name
      // resolving through the surname index is far too loose to act on —
      // "Blitz" and "Concourse" are sets, not people.
      if (n.split(' ').length >= 2) {
        const hit = resolvePlayer(n);
        if (hit && hit.key && hit.confident) UNSAFE.add(n);
      }
    }
  }
  return UNSAFE.has(name);
}

// One-word set names that are really just words. Matching any of these would
// attach an insert to titles that merely mention a brand or say "rookie".
//
// The brand half is the same list variants() refuses to shorten a parallel down
// to, and for the same reason: a one-word remainder that is a brand is the rest
// of the sentence, not a name.
const GENERIC_SUBSET = new Set([
  'topps', 'panini', 'bowman', 'leaf', 'donruss', 'score', 'upper', 'deck',
  'chrome', 'select', 'mosaic', 'optic', 'prizm', 'prizms', 'refractor',
  'refractors', 'absolute', 'certified', 'contenders', 'elite', 'illusions',
  'obsidian', 'origins', 'phoenix', 'playbook', 'spectra', 'zenith',
  'base', 'rookie', 'rookies', 'insert', 'inserts', 'autograph', 'autographs',
  'auto', 'patch', 'jersey', 'relic', 'variation', 'variations',
  'football', 'legends', 'stars', 'rated', 'update', 'series',
  // Accolades. Every one of these is a real one-word set name somewhere, and
  // every one is also what a seller types to talk the card up: "TOM BRADY 25
  // CARD LOT INVEST GOAT HOF MVP TB12" matched the set called "MVP". A set name
  // is only worth matching bare when it is a name rather than a boast.
  'mvp', 'mvps', 'goat', 'hof', 'roy', 'champ', 'champs', 'champion',
  'champions', 'prime', 'signature', 'signatures', 'graded', 'invest',
]);

// One-word names kept DELIBERATELY, for the record: Uptowns, Downtown,
// Concourse, Illumination and Anniversary are all one word, all real sets, and
// between them were 1,223 sales in a one-month sample. A blanket "two words or
// more" rule would be simpler and would throw all of that away.

function resolveParallel(title, opts = {}) {
  const t = String(title || '');
  for (const s of SELF_EVIDENT) if (s.re.test(t)) return { parallel: s.name, how: 'matched', segment: s.name };
  build();
  // The words before the number with everything known taken out: product,
  // subset, year, player, filler, seller words. What is left, if anything, is
  // the parallel — or a word this reader does not know.
  const res = residual(t, opts.player);
  const early = res ? leftoverMatch(res) : null;

  if (!CARD_NUMBER.test(t)) {
    // No number to anchor on, but a title whose leftovers are exactly one
    // parallel's name still says which parallel it is: "Jaxson Dart 2025 Topps
    // Chrome Refractor Rookie New York Giants RC". Nothing left is NOT base
    // here — without a number it may be a lot, or another card.
    if (early) return { parallel: early, how: 'matched-no-number', segment: res };
    return { parallel: null, how: 'no-number', segment: '' };
  }

  const segment = parallelSegment(t);
  // The segment with what is known to be no parallel taken out: the player's
  // name when the title puts it after the number ("#304 JOSH ALLEN RC"),
  // nicknames, suffixes, seller words.
  const segLeft = segment ? residual(segment, opts.player || t, { subsets: false }) : '';

  if (segment) {
    // Anchored at the start of the segment, longest first.
    //
    // Matching anywhere inside the segment is what made this unsafe. "White
    // Disco Prizm" is not in the vocabulary, so a floating search found the
    // "Disco Prizms" inside it; "Red White and Blue Prizm" gave up its "Blue
    // Prizm"; and a segment of trailing junk like "Giants Rookie" matched
    // "Rookie", which is a parallel in some product. Each of those merges two
    // different cards and nothing downstream can notice.
    //
    // The match must cover the ENTIRE segment once trailing filler is removed.
    // Partial matches are the whole danger: "White Disco Prizm" matching the
    // bare "White" merges two cards. Covering everything means the reader
    // either understands the segment or admits it does not.
    const after = alone(coverMatch(segment)) || (segLeft && leftoverMatch(segLeft));
    if (after) return { parallel: after, how: 'matched', segment };
  }

  // Not after the number. The parallel stated before it.
  if (early) return { parallel: early, how: 'matched-before-number', segment: res };

  // Base only when nothing is left after the number but filler (the player's
  // name and seller words count as filler there) AND nothing before it names
  // a parallel. "Holo Prizm #273 Giants" and "Mojo Refractor RC #91TRC-1
  // Rookie" were read as base on the first test alone.
  if (!dropSoft(segLeft)) {
    if (namesAParallel(res)) return { parallel: null, how: 'unmatched', segment: res };
    // Nothing left because an insert's name was taken out: "1996 Fleer Metal
    // - Gold Fingers Jerry Rice #6" is the Gold Fingers card, not the base
    // card, and calling it base would merge the two: its #6 is also a base
    // number. An insert-coded number ("#STN-5") cannot collide, and a
    // base-like subset ("Rated Rookie", "Rookies") is still base.
    const num = (t.match(/#\s*([A-Za-z0-9-]+)/) || [])[1] || '';
    const named = /^\d+$/.test(num) ? resolveSubset(t).subset : null;
    if (named && !/\b(base|rookies?|rated|rc)\b/.test(named)) return { parallel: null, how: 'unmatched', segment: named };
    return { parallel: null, how: 'base', segment };
  }
  // Something after the number this reader does not know. Base is an
  // actionable answer and unmatched is not, so the honest one wins.
  return { parallel: null, how: 'unmatched', segment };
}

  return {
  resolveParallel,
  resolveSubset,
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

const SELF_EVIDENT_PARALLELS = SELF_EVIDENT.map(s => s.name);
module.exports = { createParallelIndex, norm, parallelKey, COLOR_TEAM_PHRASES, NFL_TEAM_PHRASES, stripColorTeams,
                   SELF_EVIDENT_PARALLELS, NFL_NICKNAMES };
