// Is this sale a base card, an autograph, or a relic?
//
// WHY THIS IS THE BIGGEST IDENTITY FIX AVAILABLE.
//
// A product's autograph sets reuse the base set's card numbers. 2025 Panini
// Prizm lists Tyler Shough at #327 in the Base Set, again in Base Autographs,
// and again in Rookie Prizm Choice Auto. The sales table has one `set_name`
// column holding the PRODUCT, so all three arrive as "Prizm #327" and group
// together — a $12 base rookie averaged with a $300 on-card auto.
//
// Measured against the whole catalogue, this is 65.5% of all ambiguous
// (player, number) keys — 41,529 of 63,417. Inserts, which look like the
// obvious problem, are 28.2%. Base-against-its-own-variation is 6.4%.
//
// And unlike a parallel, the signal is nearly free. A seller does not omit
// "auto" or "patch": it is most of what the card is worth. The catalogue agrees
// — across every autograph set name in 361 checklists the commonest words are
// "autographs" (2,021) and "signatures" (1,931), and "autograph", "signature",
// "relic" and "mem" appear in no base set name at all.
'use strict';

// Ordered: an auto beats a relic, because a rookie patch AUTOGRAPH is priced
// and catalogued as an autograph first. Checking relic first would file every
// RPA as a relic and merge it with the plain patch card, which is the mistake
// this exists to prevent.
//
// Bounded on letters rather than \b so "AUTO/PATCH", "auto-graph" and
// "#RPA-TS" behave, while "automatic" and "jerseys" are still matched on their
// own terms below.
// Built from a word list rather than written out, because the "Most sold"
// board has to ask the same question in SQL — it groups half a million sales a
// day and cannot pull them into a Worker to run this. One list, two readers,
// and card-kind.test.js runs a corpus through both and requires them to agree.
const AUTO_WORDS = ['auto', 'autos', 'autod', 'autograph', 'autographs', 'autographed',
                    'autogr', 'signed', 'signature', 'signatures', 'sig', 'rpa',
                    'oncard', 'on-card'];
const AUTO_RE = new RegExp(`(?<![a-z])(${AUTO_WORDS.join('|')})(?![a-z])`, 'i');

// A REDEMPTION is not the card. It is a voucher saying the card will be mailed
// to you, and it trades at a fraction of the price while carrying the card's
// name, its number and the word "autograph".
//
// Found in the Most Sold board: "2026 Topps Fernando Mendoza #301" showed 440
// sales at a $31 average with a $1,300 high, and the photo was a Topps
// Redemption Card reading "You are due to receive a Rookie Real One Autograph".
// Vouchers, base cards and real autographs in one average.
//
// Checked BEFORE auto, because a redemption for an autograph says "autograph"
// on its face and would otherwise be filed as one — which is the merge this
// exists to prevent.
const REDEMPTION_WORDS = ['redemption', 'redemptions', 'redeemable'];
const REDEMPTION_RE = new RegExp(`(?<![a-z])(${REDEMPTION_WORDS.join('|')})(?![a-z])`, 'i');

// Deliberately NOT "prime", "premium" or "materials" on their own — those are
// parallel and set names as often as they are relic markers, and a false relic
// reading splits a base card's history exactly as badly as a false auto one.
// "jersey" carries a place as well as a swatch. New Jersey is a real thing on
// a football card — the USFL's New Jersey Generals, and plenty of listings that
// simply say where a card is shipping from — and reading it as a relic splits a
// base card's history exactly as badly as any other false positive. So the word
// is matched except when "New" is sitting in front of it.
const RELIC_WORDS = ['relic', 'relics', 'patch', 'patches', 'swatch', 'swatches',
                     'memorabilia', 'gameused', 'game-used', 'worn', 'threads',
                     'laundry\\s*tag'];
// "jersey" is kept out of the list above and spliced in with its own guard,
// because it is the one relic word that is also a place.
const RELIC_RE = new RegExp(
  `(?<![a-z])(${RELIC_WORDS.join('|')}|(?<!new\\s)jerseys?)(?![a-z])`, 'i');

// The words above are strong, but a title can name the card it is NOT.
// "PSA 10 candidate, no auto" and "base version, not the auto" are rare enough
// not to chase; "1/1 Printing Plate" is not. A plate is its own thing and
// carries none of these words, so it falls through to base — correct, because
// the checklist files plates under the set whose number they share.
function cardKind(title) {
  const t = String(title || '');
  if (REDEMPTION_RE.test(t)) return 'redemption';
  if (AUTO_RE.test(t)) return 'auto';
  if (RELIC_RE.test(t)) return 'relic';
  return '';
}

// The print run, read strictly — a /5 and a /10 are different cards.
//
// This is deliberately NOT parsePrintRunFromTitle() in server.js, and the
// difference is the point. That one feeds the similar-card estimator, where a
// fuzzy read costs a slightly wrong scaling factor. Here a wrong read SPLITS a
// card's history, so it has to be right more often than it is useful.
//
// What that rules out: the bare "a/b" form. "2025 Prizm Cam Ward RC #14 sold
// 9/16" is a date, and the loose parser reads it as a print run of 16 — which
// would tear one card into two on a phrase about when it sold. So the slash
// must not be preceded by a digit, which costs the genuine "copy 5 of 10"
// spelling and is the right trade: an unknown print run merges, which is where
// those sales already are, while a wrong one splits.
//
// Returns null for "not stated", never 0, so "no print run" and "one of one"
// can never be confused.
const ONE_OF_ONE = /(?<![\d/])1\s*\/\s*1(?![\d/])|\bone[-\s]of[-\s]one\b|\b1\s*of\s*1\b/i;
const NUMBERED = /(?:\bnumbered\s*(?:to\s*)?|#\s*\/|(?<![\d])\/)\s*(\d{1,4})\b/i;

// A serial stamp, "8/8" or "12/99": the card's number over the run. A title
// can say "1/1" beside one — "Green Sparkle 8/8 1/1", the last of eight sold
// as a one-of-one — and the stamp is what the card says, so it wins.
//
// But "9/16" is as often a date ("sold 9/16"), which the test corpus pins as
// unstated. So a stamp counts only when it cannot be a date or says it is a
// serial: a run over 31 (no day of a month), a number equal to its run (the
// last copy), a "#" in front, or a "1/1" elsewhere in the same title. Never
// when it is a full date (9/16/25) or follows "sold", "ended" or "on".
const SERIAL_STAMP = /(^|[^\d/])(#\s*)?(\d{1,4})\s*\/\s*(\d{1,4})(?![\d/])/g;
function serialStamp(t) {
  for (const m of t.matchAll(SERIAL_STAMP)) {
    const n = parseInt(m[3], 10), run = parseInt(m[4], 10);
    if (!(run >= 2 && run <= 5000 && n >= 1 && n <= run)) continue;
    const before = t.slice(Math.max(0, m.index - 8), m.index + m[1].length).toLowerCase();
    if (/\b(sold|ended|on|date)\s*$/.test(before)) continue;
    if (run > 31 || n === run || m[2] || ONE_OF_ONE.test(t)) return run;
  }
  return null;
}

function printRun(title) {
  const t = String(title || '');
  const stamped = serialStamp(t);
  if (stamped) return stamped;
  if (ONE_OF_ONE.test(t)) return 1;
  const m = NUMBERED.exec(t);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  // 5,000 is past any real print run and into "part number" territory.
  return (n >= 1 && n <= 5000) ? n : null;
}

// The identity component. Empty string for a base card so it concatenates into
// a key without a separator surprise, and so an existing key is unchanged for
// the overwhelming majority of sales.
const kindKey = (title) => cardKind(title);

// cardKind(), in SQL, for a GROUP BY that cannot bring every title back to JS.
//
// The movers board aggregates every raw sale in the window, so reading titles
// one by one in the Worker is not an option there the way it is for Most Sold.
// Generated from the same word lists, never transcribed, and card-kind.test.js
// runs a corpus through both readers and requires the same answer.
//
// The regexes want a non-letter either side of each word. SQL has no lookaround,
// so the title is lowercased, its common punctuation turned into spaces and
// padded, and each word is looked for as ' word '. A cheap substring test runs
// first, so the padding is only built for the few titles that could match.
const _SQL_PUNCT = ['-', '/', '(', ')', ',', '.', '!', '#', ':', ';', '"', "'", '&', '+', '*', '[', ']', '|'];
function kindSql(titleCol = 'title') {
  const T = `LOWER(COALESCE(${titleCol}, ''))`;
  let P = T;
  for (const c of _SQL_PUNCT) P = `REPLACE(${P}, '${c.replace(/'/g, "''")}', ' ')`;
  P = `(' ' || ${P} || ' ')`;
  // A word as it reads once punctuation is a space: 'on-card' is 'on card'.
  const spaced = (w) => w.replace(/\\s\*/g, ' ').replace(/[-]/g, ' ');
  const words = (list) => [...new Set(list.map(spaced))];
  const hit = (list, pad) => words(list).map(w => `${pad} LIKE '% ${w} %'`).join(' OR ');
  // The quick substring pre-check needs no LOWER(): LIKE is already
  // case-insensitive for these ASCII words, and lowercasing the title once per
  // word, ~30 times a row, was most of this expression's cost.
  const U = `COALESCE(${titleCol}, '')`;
  const rough = (list) => words(list).map(w => `${U} LIKE '%${w.split(' ')[0]}%'`).join(' OR ');
  // "laundry\s*tag" also matches with no space at all.
  const relic = [...RELIC_WORDS, 'laundrytag'];
  // Jerseys, except the state: the regex's (?<!new\s).
  const noState = `REPLACE(${P}, ' new jersey', ' ')`;
  const jersey = `${noState} LIKE '% jersey %' OR ${noState} LIKE '% jerseys %'`;
  return `(CASE
      WHEN (${rough(REDEMPTION_WORDS)}) AND (${hit(REDEMPTION_WORDS, P)}) THEN 'redemption'
      WHEN (${rough(AUTO_WORDS)}) AND (${hit(AUTO_WORDS, P)}) THEN 'auto'
      WHEN (${rough(relic)} OR ${U} LIKE '%jersey%')
           AND (${hit(relic, P)} OR ${jersey}) THEN 'relic'
      ELSE '' END)`;
}

module.exports = { AUTO_RE, RELIC_RE, REDEMPTION_RE, AUTO_WORDS, RELIC_WORDS,
                   REDEMPTION_WORDS, cardKind, kindKey, kindSql, printRun };
