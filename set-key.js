// Matching a sold sale to the product page it belongs on.
//
// The two sides name the same set differently and neither is wrong. A product
// in checklists/index.json is "2025 Panini Prizm Football" with brand "Panini
// Prizm". A sale's set_name is parsed out of a seller's eBay title and comes
// back as "Prizm" — sellers do not type the manufacturer, and the year is
// already its own column.
//
// The first attempt joined on year + brand, which fails in both directions at
// once and, worse, fails quietly:
//
//   * It MISSES. No 2025 product has brand exactly "Prizm", so every one of
//     the 14,444 sales under that name found no product and looked, from the
//     outside, like a set with no sales rather than a key that cannot match.
//     Same for select, mosaic, chrome, phoenix, finest and donruss optic —
//     37% of the priced dataset.
//
//   * It COLLIDES. 2025 Donruss, Donruss Elite and Donruss Optic all carry
//     brand "Donruss", so all three claimed the same sales group and reported
//     identical figures. Bowman and Bowman Sapphire did the same.
//
// A miss understates coverage and a collision overstates it, so the headline
// share was wrong without being obviously wrong.
//
// The replacement keys off the product NAME, not the brand. Measured across
// all 361 products, name and id together produce 706 distinct keys with zero
// collisions, and brand contributes no key those two do not already produce —
// so brand was not merely the wrong field to join on, it was a redundant one.
//
// Kept apart from server.js so the matching can be checked against real
// product names without a Worker or a D1 binding.
'use strict';

// Same shape as _normCol() in server.js: hyphens and punctuation are removed
// rather than spaced, so "Bowman's Best" and "Bowmans Best" land together.
function norm(v) {
  return String(v == null ? '' : v)
    .replace(/['.,"`’\-]/g, '')
    .toLowerCase()
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// Words a seller leaves off the front of a title.
//
// Panini and Topps are pure manufacturer prefixes. Donruss and Bowman are
// both — a brand on their own ("2025 Donruss Football") and a prefix on their
// sub-brands ("Donruss Optic", "Bowman Sapphire") — which the empty-result
// guard in variants() handles: stripping the word from a name that is only
// that word yields nothing and is discarded, so plain Donruss keeps its own
// key while Donruss Optic gains "optic" as well.
//
// Score, Leaf and Playoff are deliberately absent. They are manufacturer
// names historically and brand names here, and including all three added one
// key across the whole catalogue — not worth the room for error.
const MAKERS = ['panini', 'topps', 'donruss', 'bowman'];

// Strip year, the trailing sport, and a leading manufacturer.
//
// Returns candidates in preference order rather than one string, because both
// sides of the join are inconsistent: some sale titles do carry "Panini", and
// matching should not depend on guessing which convention a row followed.
function variants(raw) {
  let s = norm(raw);
  if (!s) return [];
  s = s.replace(/^\d{4}(\s?\d{2})?\s+/, '');       // "2025 " and "2025 26 "
  s = s.replace(/\s+(football|basketball|baseball|hockey)$/, '');
  s = s.trim();
  if (!s) return [];

  const out = [s];
  for (const maker of MAKERS) {
    if (s.startsWith(maker + ' ')) {
      const rest = s.slice(maker.length + 1).trim();
      // The guard that matters, twice over: it stops "Topps Football" from
      // becoming "" and matching every unparseable set name, and it is what
      // lets Donruss and Bowman sit in MAKERS without losing their own pages.
      if (rest) out.push(rest);
    }
  }
  return out;
}

// Every name a product could plausibly be sold under.
//
// Name and id only. Brand is not consulted: it is where the collisions came
// from and it adds nothing these two miss.
function productKeys(p) {
  if (!p) return [];
  const year = norm(p.year);
  const fromId = String(p.id || '').replace(/-/g, ' ');
  const seen = new Set();
  for (const src of [p.name, fromId]) {
    for (const v of variants(src)) seen.add(v);
  }
  return [...seen].map(v => `${year}|${v}`);
}

// Every key a sale could match on. The sale already has its year in a column,
// so only the set name needs unpicking.
function saleKeys(year, setName) {
  const y = norm(year);
  return variants(setName).map(v => `${y}|${v}`);
}

// Build the lookup, and refuse to guess.
//
// A key claimed by two products is dropped rather than handed to whichever
// came first. Silently picking one is what produced three Donruss products
// with identical sales figures, and a dropped key shows up honestly as an
// unmatched sale instead of as confident nonsense. The catalogue currently
// produces none, and this exists so that a future product that would collide
// is reported rather than absorbed.
function buildIndex(products) {
  const owners = new Map();
  for (const p of products || []) {
    for (const k of productKeys(p)) {
      if (!owners.has(k)) owners.set(k, []);
      owners.get(k).push(p);
    }
  }
  const index = new Map();
  const ambiguous = [];
  for (const [k, list] of owners) {
    if (list.length === 1) index.set(k, list[0]);
    else ambiguous.push({ key: k, products: list.map(p => p.id) });
  }
  return { index, ambiguous };
}

// Which product a sale belongs to, or null. First unambiguous match wins, and
// the order from variants() puts the more specific name first.
function matchSale(index, year, setName) {
  for (const k of saleKeys(year, setName)) {
    const hit = index.get(k);
    if (hit) return hit;
  }
  return null;
}

module.exports = { norm, variants, productKeys, saleKeys, buildIndex, matchSale, MAKERS };
