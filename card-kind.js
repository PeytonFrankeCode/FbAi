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

function printRun(title) {
  const t = String(title || '');
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

module.exports = {
  AUTO_RE, RELIC_RE, REDEMPTION_RE, cardKind, kindKey, printRun,
  // The word lists, so the SQL copy in server.js is generated from the same
  // source rather than transcribed. Transcribed copies drift, and this codebase
  // has already paid for that twice today — two grade readers that disagreed,
  // and two search endpoints where only one had been wired up.
  AUTO_WORDS, RELIC_WORDS, REDEMPTION_WORDS,
};
