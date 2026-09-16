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

// ---- players ----
//
// Player pages are 1,228 of the 2,173 indexable URLs, so the same question
// asked of sets has to be asked of them, and the same way it went wrong once
// already is available here: a name written two ways.
//
// The hazard is the generational suffix. The checklist says "Patrick Mahomes
// II"; plenty of eBay titles say "Patrick Mahomes". Matching only the exact
// string silently orphans the larger half of a superstar's sales, which is
// the set-name failure again with a different column.
const SUFFIXES = ['jr', 'sr', 'ii', 'iii', 'iv', 'v'];

function playerVariants(raw) {
  const s = norm(raw);   // norm() already drops the period from "Jr."
  if (!s) return [];
  const out = [s];
  const parts = s.split(' ');
  if (parts.length > 2 && SUFFIXES.includes(parts[parts.length - 1])) {
    // Same guard as the makers: a bare suffix is not a name. Requiring more
    // than two parts keeps "Deebo Jr" — were such a name to exist — from
    // collapsing to "Deebo".
    out.push(parts.slice(0, -1).join(' '));
  }
  return out;
}

// Keys for a player page, and for the player named on a sale. Unlike sets,
// both sides are just a name, so one function serves both.
const playerKeys = (p) => playerVariants(p && p.name);

// Build the lookup, and refuse to guess.
//
// A key claimed by two items is dropped rather than handed to whichever came
// first. Silently picking one is what produced three Donruss products with
// identical sales figures, and a dropped key shows up honestly as an unmatched
// sale instead of as confident nonsense. The catalogue currently produces
// none, and this exists so that a future product — or a second player whose
// name collides once a suffix is stripped — is reported rather than absorbed.
// `aliases` maps a sale key — "<year>|<normalised set name>" — to a product id,
// and is how a human answer enters the join.
//
// Some spellings no rule will ever reach. A seller types "Topps Flagship" for
// a product catalogued as "2026 Topps Football"; nothing about those two
// strings connects them, and no amount of stripping makers or years bridges it.
// A fifth of sampled sales match no product at all, and that is a ceiling on
// every other identity fix: a sale outside the catalogue cannot be helped by
// reading its parallel, its kind or its insert, because there is nothing to
// read it against.
//
// One alias is worth far more than one of anything else that can be corrected
// here. A title decision resolves about four sales; a set alias resolves every
// sale ever filed under that spelling, which for the common ones is hundreds.
// That ratio is the whole argument for doing this by hand.
//
// Applied AFTER the ambiguity check, deliberately. A human saying "this
// spelling is that product" is a stronger statement than the catalogue
// accidentally producing two owners for a key, and it should settle the case
// rather than be dropped by it.
function buildIndex(products, keyFn = productKeys, aliases = null) {
  const owners = new Map();
  for (const p of products || []) {
    for (const k of keyFn(p)) {
      if (!owners.has(k)) owners.set(k, []);
      owners.get(k).push(p);
    }
  }
  const index = new Map();
  const ambiguous = [];
  for (const [k, list] of owners) {
    if (list.length === 1) index.set(k, list[0]);
    // Products are identified by id, player pages by slug. Falling back keeps
    // this readable for both rather than printing a list of empty strings.
    else ambiguous.push({ key: k, products: list.map(p => p.id || p.slug || p.name) });
  }

  if (aliases) {
    const byId = new Map();
    for (const p of products || []) {
      const id = p && (p.id || p.slug);
      if (id) byId.set(String(id), p);
    }
    for (const [key, id] of Object.entries(aliases)) {
      const p = byId.get(String(id));
      // An alias naming a product that no longer exists is ignored rather than
      // written as a null the join would later treat as a match. Products get
      // renamed; a stale alias should degrade to "unmatched", which is where
      // the sale already was.
      if (p) index.set(String(key), p);
    }
  }
  return { index, ambiguous };
}

// First unambiguous match wins. The order the *Keys functions return matters:
// the more specific spelling comes first, so "Patrick Mahomes II" is preferred
// over the suffix-stripped form and "donruss optic" over "optic".
function matchKeys(index, keys) {
  for (const k of keys) {
    const hit = index.get(k);
    if (hit) return hit;
  }
  return null;
}

// Which product a sale belongs to, or null.
const matchSale = (index, year, setName) => matchKeys(index, saleKeys(year, setName));

// Which player page a sale belongs to, or null.
const matchPlayer = (index, name) => matchKeys(index, playerVariants(name));

module.exports = {
  norm, variants, productKeys, saleKeys, buildIndex, matchKeys, matchSale, MAKERS,
  playerVariants, playerKeys, matchPlayer, SUFFIXES,
};
