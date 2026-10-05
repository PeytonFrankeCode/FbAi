// Where does this sale belong? The re-sort behind the sales vetting plan.
//
// See docs/vetting-plan.md. The rule is RE-SORT, NEVER DELETE: a sale that
// looks wrong under its card is almost always a real sale of a DIFFERENT card.
// "PSA Authentic 10 Auto" Griffey is a real $990 sale of an authenticated auto,
// not of the PSA 10 base card it was filed under. So this never answers "keep
// or drop". It answers where the sale goes:
//
//   keep        the row's own filing agrees with its title
//   auto/relic  the title says autograph or memorabilia; the row says base
//   not-auto    the row says auto; the title says facsimile (printed) signature
//   authentic   a slab with no card grade: PSA Authentic, DNA, altered
//   year        the title names a different year than the row
//   parallel    the title reads a parallel (or a print run) the row lacks, or
//               the row's parallel is the player's surname ("A.J. Green")
//   category:*  not a single card at all: lot, reprint, custom, you-pick,
//               break, repack, redemption. Kept and searchable, never priced
//               as one card.
//   unplaced    the row has no card to be filed under (no player or year)
//
// Each result carries a confidence. HIGH moves can be applied automatically.
// LOW ones are the purgatory list: the title and the row disagree and nothing
// here can say which is right — a person looking at the photo can.
//
// This module only READS. It never edits a sale; corrections live in their own
// table keyed by item_id (plan: "the sales row is never edited"), and every
// feature reads "sale + correction".
'use strict';

const { cardKind, printRun } = require('./card-kind');
const { gradeFromTitle, stripGrade } = require('./grade-core');

// ---- not one card ----------------------------------------------------------
//
// Checked first: a lot of three autos is a lot before it is an auto.
// Ordered by how sure the words are. Word-bounded on letters so "Lottery",
// "Slot" and "customer" do not match.
const W = (s) => `(?<![a-z])(?:${s})(?![a-z])`;
const CATEGORIES = [
  // A redemption is a voucher, not the card (card-kind.js has the history).
  ['redemption', null],
  ['you-pick', new RegExp(W(
    "you\\s*pick|u\\s*pick|pick\\s*(?:your|ur|from|a|one|any)|choose\\s*(?:your|ur|from|a|one|any)|" +
    "you\\s*choose|u\\s*choose|complete\\s*your\\s*set|pyc|finish\\s*your\\s*set"), 'i')],
  ['break', new RegExp(W(
    "case\\s*break|box\\s*break|break\\s*spot|random\\s*(?:team|player|division)|pyt|pick\\s*your\\s*team|" +
    "team\\s*spot"), 'i')],
  ['lot', new RegExp(W(
    "lots?|lot\\s*of|bundle|\\(\\s*\\d+\\s*cards?\\s*\\)|\\d+\\s*cards?\\s*(?:lot|bundle|set)|qty\\s*\\d+|quantity|" +
    "team\\s*set|complete\\s*set|base\\s*set\\s*complete|set\\s*of\\s*\\d+"), 'i')],
  // "Custom slab", "custom display" and "custom listing for <buyer>" are real
  // cards sold with something custom; the card is what the word describes
  // only when nothing of that kind follows it.
  ['custom', new RegExp(W("custom(?!\\s*(?:slab|label|listing|display|case|order|request|for|made\\s*(?:case|display|stand)|\\d*d\\s*display))|" +
                          "aceo|proxy|fan\\s*art|fake|counterfeit|unofficial|replica\\s*card"), 'i')],
  // Usually not a real card, but "Bowman U Now Art Card" is an official
  // product and "novelty" turns up on genuine Downtowns. For a person.
  ['custom?', new RegExp(W("art\\s*card|novelty"), 'i')],
  ['reprint', new RegExp(W("reprints?|re-print|reproductions?"), 'i')],
  ['repack', new RegExp(W("repacks?|mystery\\s*(?:pack|box|bag|card\\s*lot)|chaser|hot\\s*pack"), 'i')],
];

// "1 card" and "x1" are one card. Every other count is several.
function _isSingleCount(m) {
  const n = (String(m).match(/\d+/) || [])[0];
  return n === '1';
}

// "Lot" is also how an auction house numbers what it sells ("Lot #214",
// "Lot 214:"), and those are single cards.
const AUCTION_LOT = /(?<![a-z])lot\s*#?\s*\d{2,}\s*[:\-–]/i;

function categoryOf(title) {
  const t = String(title || '');
  for (const [name, re] of CATEGORIES) {
    if (name === 'redemption') {
      if (cardKind(t) === 'redemption') return name;
      continue;
    }
    const m = re.exec(t);
    if (!m) continue;
    if (name === 'lot') {
      if (AUCTION_LOT.test(t) && !/lot\s*of/i.test(t)) continue;
      // "1 card", "x1": a quantity of one is a single.
      if (/\d/.test(m[0]) && _isSingleCount(m[0])) continue;
    }
    return name;
  }
  return null;
}

// ---- a slab with no card grade ---------------------------------------------
//
// "PSA Authentic", "PSA A", "PSA/DNA Auth", "SGC Authentic", "Altered". The
// slab vouches for the card or the signature, not its condition, and the
// number on the label (when there is one) grades the AUTOGRAPH. Filed under a
// PSA 10 it is a different card at a different price.
//
// The grader must sit right before the word: "Panini Authentic" and "Upper
// Deck Authentics" are products, not slabs.
const GRADER_WORDS = 'psa|sgc|bgs|bvg|cgc|beckett|bas|jsa|csg|hga|tag';
const AUTHENTIC_RE = new RegExp(
  `(?<![a-z])(?:${GRADER_WORDS})[\\s/-]*(?:dna[\\s/-]*)?(?:authentic(?:ated)?|auth|altered|trimmed|aa|a)(?![a-z0-9])`, 'i');
const ALTERED_RE = /(?<![a-z])(?:altered|trimmed|evidence\s+of\s+trimming)(?![a-z])/i;

function isAuthenticSlab(title, row) {
  const t = String(title || '');
  if (AUTHENTIC_RE.test(t) || ALTERED_RE.test(t)) return true;
  // "PSA/DNA" or "PSA DNA" with a grade column but no card grade in the title:
  // the number is the autograph's grade, and the card itself is raw.
  const r = row || {};
  if (r.grade != null && r.grade !== '' && /(?<![a-z])dna(?![a-z])/i.test(t)) {
    const g = gradeFromTitle(t);
    if (!g || g.grade == null) return true;
  }
  return false;
}

// ---- autograph and memorabilia ---------------------------------------------
//
// cardKind() is the shared reader. Two things it does not see:
//   "(AU, RC)" — Topps' own checklist abbreviation, copied into titles by the
//   biggest feed. "Rookie Finest Autographs ... #RFA-SST (AU, RC)" arrived with
//   is_auto = 0.
//   Facsimile signatures — printed on the card, not signed. Worth base money.
const AU_RE = /\(\s*AU(?:\s*[,)]|\s+RC)|(?<![a-z])AU(?=\s*[,)])/;
const FACSIMILE_RE = /(?<![a-z])(?:facsimile|printed\s+(?:signature|auto(?:graph)?)|pre-?printed|stamped\s+(?:signature|auto))(?![a-z])/i;
const NOT_AUTO_RE = /(?<![a-z])(?:no|not|non)[\s-]*(?:an?\s+|the\s+)?auto(?:graph)?s?(?![a-z])/i;

// Product and feature names that carry an auto or relic word and are neither:
// Topps Signature Class / Signature Series base cards, Topps Chrome "Jersey
// Match" (the serial matches the jersey number; no swatch), Panini Threads.
const KIND_LOOKALIKES = /(?<![a-z])(?:signature\s+(?:class|series|edition)|jersey\s+(?:match(?:es)?|numbers?|#)|(?:panini|\d{4})\s+threads)(?![a-z])/gi;

function kindOf(title) {
  const t = String(title || '').replace(KIND_LOOKALIKES, ' ');
  if (FACSIMILE_RE.test(t)) return 'facsimile';
  if (NOT_AUTO_RE.test(t)) {
    const k = cardKind(t.replace(NOT_AUTO_RE, ' '));
    return k === 'auto' ? '' : k;
  }
  const k = cardKind(t);
  if (k) return k;
  if (AU_RE.test(t)) return 'auto';
  return '';
}

// ---- year ------------------------------------------------------------------
//
// Every plausible card year in the title, as numbers. A four-digit run that is
// a print run ("/2000") or a card number ("#1999") is not a year, and a season
// ("2023-24") contributes both of its years.
function titleYears(title) {
  const t = String(title || '');
  const out = [];
  const re = /(?<![\d/#])(19[4-9]\d|20[0-3]\d)(?:\s*[-/]\s*(\d{2}))?(?![\d/])/g;
  let m;
  while ((m = re.exec(t)) !== null) {
    const y = parseInt(m[1], 10);
    out.push(y);
    if (m[2]) out.push(Math.floor(y / 100) * 100 + parseInt(m[2], 10));
  }
  return out;
}

// The year the title files the card under, when it plainly disagrees with the
// row. A title can mention more than one year ("1984 Topps ... 2024 HOF"), so
// the row stands whenever ANY title year agrees with it, and the first year
// (where a card's year is written) is the answer otherwise.
function yearMove(title, rowYear) {
  const y = parseInt(rowYear, 10);
  if (!Number.isFinite(y)) return null;
  const ys = titleYears(title);
  if (!ys.length || ys.includes(y)) return null;
  // Seasons are filed under either year depending on the feed.
  if (ys.some(v => Math.abs(v - y) === 1) && /\d{4}\s*[-/]\s*\d{2}(?!\d)/.test(String(title))) return null;
  return ys[0];
}

// ---- parallel --------------------------------------------------------------

function _n(s) {
  return String(s == null ? '' : s).toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// Seller words that ride along on a parallel name and change nothing.
const PARALLEL_FILLER = new Set(['prizm', 'prizms', 'refractor', 'refractors', 'parallel',
  'parallels', 'ssp', 'sp', 'variation', 'var', 'insert', 'the', 'and', 'rc', 'rookie']);
function _parallelWords(s) {
  return _n(s).split(' ').map(w => w.replace(/s$/, ''))
    .filter(w => w && !PARALLEL_FILLER.has(w) && !PARALLEL_FILLER.has(w + 's'));
}

// Same parallel, as far as text can tell? One name's words all appear in the
// other's: "Silver" and "Silver Prizm", "Gold" and "Gold /10".
function sameParallel(a, b) {
  const A = _parallelWords(a), B = _parallelWords(b);
  if (!A.length || !B.length) return !A.length && !B.length;
  const sb = new Set(B), sa = new Set(A);
  return A.every(w => sb.has(w)) || B.every(w => sa.has(w));
}

// Parallel names that are base under another name.
const BASE_NAMES = new Set(['base', 'rookie', 'rookies', 'rated rookie', 'rc', 'base set', 'regular']);
// Brands whose name is also a parallel's, read from the title when the row has
// no set. Each one is a lesson from the vetting desk: "1984 STAR #12 LARRY
// BIRD" is the Star Company's card, not a Stars parallel.
const TITLE_BRANDS = new Set(['star']);

// What the reader sometimes hands back that is a kind or a seller word, not a
// parallel. Kinds are judged by kindOf(); these never move a sale.
const NOT_PARALLELS = /^(?:autographs?|signatures?|jerseys?|patch(?:es)?|relics?|memorabilia|fotl|first off the line|variations?|ssp|sp|case hit)$/i;

// The row's parallel is a word of the player's name: "A.J. Green" filed as a
// Green parallel, "AHMAN GREEN" as player "Ahman" and parallel "Green". True
// only when the title does not ALSO name the colour on its own ("A.J. Green
// Green Prizm" is a real Green Prizm).
function parallelIsPlayerName(row) {
  const par = _n(row.parallel);
  if (!par || par.includes(' ')) return false;
  const title = _n(row.title);
  const player = _n(row.player);
  const pw = player.split(' ').filter(Boolean);
  const inName = pw.includes(par);
  // The surname the row lost: player "Ahman" from "AHMAN GREEN". Only when
  // the player column is a lone name — "Jayden Daniels Downtown" is a
  // Downtown card that happens to follow the name.
  const glued = pw.length === 1 && ` ${title} `.includes(` ${pw[0]} ${par} `);
  if (!inName && !glued) return false;
  const uses = title.split(' ').filter(w => w === par).length;
  return uses <= 1;
}

// What the parallel reader says, given a reader. Returns null when it cannot
// say (no reader, no number, or a phrase it does not know).
function readParallel(row, pi) {
  if (!pi || typeof pi.resolveParallel !== 'function') return null;
  const hit = pi.resolveParallel(stripGrade(cleanTitle(row.title)), { player: row.player || '' });
  if (!hit) return null;
  if (hit.how === 'matched' || hit.how === 'matched-before-number') return { parallel: hit.parallel, how: hit.how };
  if (hit.how === 'base') return { parallel: null, how: 'base' };
  return null;
}

// Grading-label noise that the parallel and print-run readers would otherwise
// take for part of the card: the auto's grade ("PSA 9 w/ 10"), population
// counts ("POP 1/3"), and MBA's label tiers ("MBA Diamond", "MBA Silver"),
// which made a 1987 Fleer Jordan a Silver parallel by player "Mba".
const LABEL_NOISE = /(?<![a-z])(?:w\/\s*\d+(?:\s*auto)?|pop(?:ulation)?\s*\d+(?:\s*\/\s*\d+)?|mba\s+(?:diamond|silver|gold|platinum|elite|black)(?:\s+candidate)?)(?![a-z])/gi;
const cleanTitle = (t) => String(t || '').replace(LABEL_NOISE, ' ').replace(/\s{2,}/g, ' ').trim();

// ---- the decision ----------------------------------------------------------

// row: a `sales` row (title, player, year, parallel, print_run, is_auto,
// is_relic, grader, grade). pi: the parallel reader (parallel-index.js), or
// null to skip the parallel test.
//
// Returns { dest, confidence, reason, to, flags } where flags lists every
// disagreement found, and dest/reason/to describe the one that decides.
// opts.productParallels(row): the parallel names in this row's own product's
// checklist (a Set of norm()ed names), or null when the product is unknown.
// With it, a parallel read from the title is HIGH only when the product
// actually has that parallel. Without the product, only a name that is a
// parallel everywhere (never also an insert set) counts as HIGH.
function _readConfidence(row, name, pi, opts) {
  const listed = opts && typeof opts.productParallels === 'function' ? opts.productParallels(row) : null;
  if (listed) {
    const n = pi.norm(name);
    return (listed.has(n) || listed.has(n.replace(/s$/, '')) || listed.has(n + 's')) ? 'high' : 'low';
  }
  return typeof pi.classify === 'function' && pi.classify(name) === 'parallel' ? 'high' : 'low';
}

function resortSale(row, pi, opts) {
  const r = row || {};
  const title = String(r.title || '');
  const flags = [];
  const add = (dest, confidence, reason, to) => flags.push({ dest, confidence, reason, to: to === undefined ? null : to });

  const cat = categoryOf(title);
  if (cat === 'reprint') {
    // Always for a person. An official reprint INSERT (1996 Topps Namath
    // Reprint, 2001 Archives Reserve, Score 10th Anniversary Rookie Reprint
    // Autograph) is a real card with its own price; "1969 Topps #25 Unitas
    // Reprint" for $2 is not. The words are the same and the photo is not.
    add('category:reprint', 'low', 'title says reprint: official reprint insert, or not a real card?');
  } else if (cat === 'custom?') {
    add('category:custom', 'low', 'title says art card or novelty: custom, or an official card?');
  } else if (cat) add(`category:${cat}`, 'high', `title reads as ${cat}`);

  if (isAuthenticSlab(title, r)) add('authentic', 'high', 'slab with no card grade (Authentic / DNA / altered)');

  const kind = kindOf(title);
  const isAuto = Number(r.is_auto) === 1, isRelic = Number(r.is_relic) === 1;
  if (kind === 'auto' && !isAuto) add('auto', 'high', 'title says autograph, row says not');
  else if (kind === 'relic' && !isRelic && !isAuto) add('relic', 'high', 'title says memorabilia, row says not');
  else if (kind === 'facsimile' && isAuto) add('not-auto', 'high', 'facsimile (printed) signature filed as an auto');

  const ty = yearMove(title, r.year);
  if (ty != null) add('year', 'high', `title says ${ty}, row says ${r.year}`, ty);

  const rowPar = String(r.parallel == null ? '' : r.parallel).trim();
  const rowParIsBase = !rowPar || BASE_NAMES.has(_n(rowPar));
  if (rowPar && parallelIsPlayerName(r)) {
    add('parallel', 'high', `parallel "${rowPar}" is the player's name`, 'base');
  } else {
    const run = printRun(cleanTitle(title));
    const rowRun = r.print_run == null || r.print_run === '' ? null : parseInt(r.print_run, 10);
    if (run != null && rowRun != null && run !== rowRun) {
      // "BGS 9/10" is card grade 9, auto grade 10. When the row's run is that
      // auto grade the import read the slab as a serial, and the title's own
      // run is the answer: no person needed.
      const autoGrade = (title.match(/(?<![a-z])(?:psa|bgs|bvg|sgc|cgc|csg|hga|beckett)[\s._#:-]*(?:10|[1-9](?:\.5)?)\s*\/\s*(?:auto\s*)?(10|[5-9](?:\.5)?)(?![\d./])/i) || [])[1];
      const misread = autoGrade != null && parseFloat(autoGrade) === rowRun;
      add('parallel', misread ? 'high' : 'low',
          misread ? `title says /${run}; the row's /${rowRun} is the auto grade of a dual-graded slab`
                  : `title says /${run}, row says /${rowRun}`, `/${run}`);
    }
    const read = readParallel(r, pi);
    // A "parallel" spelled by the product's own name is the product: "1984
    // STAR #12 LARRY BIRD" is the Star Company's card, not a Stars parallel.
    // The import often leaves the set empty on vintage cards, so a brand named
    // right after the year in the title counts too.
    const titleBrand = (title.match(/(?<!\d)(?:19|20)\d{2}(?:\s*[-/]\s*\d{2})?\s+([a-z]+)/i) || [])[1] || '';
    const productWords = new Set(_parallelWords(`${r.brand || ''} ${r.set_name || ''} ${
      TITLE_BRANDS.has(titleBrand.toLowerCase()) ? titleBrand : ''}`));
    const isProductName = (name) => { const w = _parallelWords(name); return w.length > 0 && w.every(x => productWords.has(x)); };
    if (read && read.parallel && !BASE_NAMES.has(_n(read.parallel)) && !NOT_PARALLELS.test(_n(read.parallel))
        && !isProductName(read.parallel)) {
      if (rowParIsBase) {
        const conf = read.how === 'matched' ? _readConfidence(r, read.parallel, pi, opts) : 'low';
        add('parallel', conf, `title reads ${read.parallel}, row says base`, read.parallel);
      }
      else if (!sameParallel(rowPar, read.parallel)) {
        add('parallel', 'low', `title reads ${read.parallel}, row says ${rowPar}`, read.parallel);
      }
    } else if (rowParIsBase && run != null && rowRun == null) {
      // Not base, whatever its name: base cards are not numbered.
      add('parallel', 'high', `numbered /${run}, row says base`, `/${run}`);
    }
  }

  if (!flags.length && (!r.player || !Number.isFinite(parseInt(r.year, 10)))) {
    add('unplaced', 'low', 'no player or year to file it under');
  }

  if (!flags.length) return { dest: 'keep', confidence: 'high', reason: '', to: null, flags };
  // A category outranks everything (a lot of autos is a lot); then the slab
  // type, then what kind of card, then the year, then the parallel. A low
  // read never outranks a high one.
  const ORDER = ['category', 'authentic', 'auto', 'relic', 'not-auto', 'year', 'parallel', 'unplaced'];
  const rank = (f) => (f.confidence === 'high' ? 0 : 100) + ORDER.indexOf(f.dest.split(':')[0]);
  const top = flags.slice().sort((a, b) => rank(a) - rank(b))[0];
  return { dest: top.dest, confidence: top.confidence, reason: top.reason, to: top.to, flags };
}

// The opts.productParallels for resortSale(), built from the parallel
// dictionary (public/data/parallel-index.json). Product ids are
// "<year>-<brand> <set>-<sport>" slugs; the sales row carries year, set_name
// and (not always) brand, and a NULL sport is football (rows from before the
// column existed).
const _slug = (s) => String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const _BRANDS = ['', 'panini', 'topps', 'upper-deck', 'leaf', 'fleer', 'score', 'bowman', 'donruss', 'pacific', 'skybox', 'playoff'];
function productParallelsFrom(dict, norm) {
  const byId = new Map();
  for (const [id, names] of Object.entries((dict && dict.parallelsByProduct) || {})) {
    byId.set(id, new Set(names.map(norm)));
  }
  const memo = new Map();
  return (row) => {
    const r = row || {};
    const key = `${r.year}|${r.brand || ''}|${r.set_name || ''}|${r.sport || ''}`;
    if (memo.has(key)) return memo.get(key);
    let hit = null;
    if (r.year && r.set_name) {
      const sport = r.sport || 'football', set = _slug(r.set_name);
      const brands = r.brand ? [_slug(r.brand), ..._BRANDS] : _BRANDS;
      for (const b of brands) {
        const id = [r.year, b, set, sport].filter(Boolean).join('-');
        if (byId.has(id)) { hit = byId.get(id); break; }
      }
    }
    memo.set(key, hit);
    return hit;
  };
}

// Does this sale count toward its card's price as filed? Only "keep" does.
// Everything else either moved to another card or is not one card at all.
const counts = (decision) => !!decision && decision.dest === 'keep';

module.exports = { resortSale, counts, productParallelsFrom, categoryOf, isAuthenticSlab, kindOf, titleYears,
                   yearMove, sameParallel, parallelIsPlayerName, AUTHENTIC_RE };
