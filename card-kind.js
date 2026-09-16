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
const AUTO_RE = /(?<![a-z])(auto|autos|autod|autograph|autographs|autographed|autogr|signed|signature|signatures|sig|rpa|oncard|on-card)(?![a-z])/i;

// Deliberately NOT "prime", "premium" or "materials" on their own — those are
// parallel and set names as often as they are relic markers, and a false relic
// reading splits a base card's history exactly as badly as a false auto one.
// "jersey" carries a place as well as a swatch. New Jersey is a real thing on
// a football card — the USFL's New Jersey Generals, and plenty of listings that
// simply say where a card is shipping from — and reading it as a relic splits a
// base card's history exactly as badly as any other false positive. So the word
// is matched except when "New" is sitting in front of it.
const RELIC_RE = /(?<![a-z])(relic|relics|patch|patches|(?<!new\s)jerseys?|swatch|swatches|memorabilia|gameused|game-used|worn|threads|laundry\s*tag)(?![a-z])/i;

// The words above are strong, but a title can name the card it is NOT.
// "PSA 10 candidate, no auto" and "base version, not the auto" are rare enough
// not to chase; "1/1 Printing Plate" is not. A plate is its own thing and
// carries none of these words, so it falls through to base — correct, because
// the checklist files plates under the set whose number they share.
function cardKind(title) {
  const t = String(title || '');
  if (AUTO_RE.test(t)) return 'auto';
  if (RELIC_RE.test(t)) return 'relic';
  return '';
}

// The identity component. Empty string for a base card so it concatenates into
// a key without a separator surprise, and so an existing key is unchanged for
// the overwhelming majority of sales.
const kindKey = (title) => cardKind(title);

module.exports = { AUTO_RE, RELIC_RE, cardKind, kindKey };
