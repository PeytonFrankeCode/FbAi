// Resolve a listing's player field to a canonical player.
//
// The sales table's `player` column is parsed out of eBay titles, so the same
// person arrives as "Justin Jefferson", "JUSTIN JEFFERSON RC", "Justin
// Jefferson Vikings Prizm", "Jefferson" and a hundred other ways. The index
// groups on that column, so every spelling is a different card and none of them
// pair. The checklists know the correct spelling of 16,075 players; this maps
// the mess onto them.
//
// The rule throughout is that declining beats guessing. A name that cannot be
// resolved confidently is returned as unresolved and the caller can keep the
// raw string; a name resolved to the WRONG player silently merges two markets,
// which is worse than leaving one fragmented.
const INDEX = require('./data/card-index.json');

// Must match _normCol in server.js. Same punctuation set, same collapse, and
// generational suffixes deliberately kept — Marvin Harrison Jr and Marvin
// Harrison are different players with different markets.
function norm(s) {
  return String(s == null ? '' : s)
    .replace(/[.,''`"’-]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

const NOISE = new Set(INDEX.noise);
const PLAYERS = INDEX.players;
const SURNAMES = INDEX.uniqueSurnames;
// "Luther Burden" -> "luther burden iii". Only populated where one player has
// that base name and the base is not itself somebody's full name.
const SUFFIXLESS = INDEX.suffixless || {};

// Stored as 1 when the canonical spelling is just the normalised key with each
// word capitalised, which is true of most names.
function display(key) {
  const v = PLAYERS[key];
  if (v === undefined) return null;
  if (v !== 1) return v;
  return key.split(' ').map(w => w ? w[0].toUpperCase() + w.slice(1) : w).join(' ');
}

// Tokens that carry no name: pure numbers, card numbers, print runs, years,
// and anything in the noise vocabulary built from the checklists.
function isNoiseToken(t) {
  if (!t || t.length < 2) return true;
  if (/^\d+$/.test(t)) return true;             // 331
  if (/^\d+\/\d+$/.test(t)) return true;        // 25/99
  if (/^#/.test(t)) return true;                // #331
  if (/^(19|20)\d{2}$/.test(t)) return true;    // 2023
  return NOISE.has(t);
}

const SUFFIX = /^(jr|sr|ii|iii|iv|v)$/;

// Windows of adjacent tokens, longest first, so "marvin harrison jr" wins over
// the "marvin harrison" sitting inside it. Those are different people.
function* windows(tokens) {
  for (let len = Math.min(4, tokens.length); len >= 2; len--) {
    for (let i = 0; i + len <= tokens.length; i++) {
      yield tokens.slice(i, i + len).join(' ');
    }
  }
}

/**
 * @returns {{canonical: string, key: string, how: string, confident: boolean}|null}
 */
function resolvePlayer(raw) {
  const n = norm(raw);
  if (!n) return null;

  // 1. Already correct.
  if (PLAYERS[n] !== undefined) {
    return { canonical: display(n), key: n, how: 'exact', confident: true };
  }

  const all = n.split(' ');
  const kept = all.filter(t => !isNoiseToken(t) || SUFFIX.test(t));

  // 2. Correct once the listing furniture is stripped.
  const cleaned = kept.join(' ');
  if (cleaned && PLAYERS[cleaned] !== undefined) {
    return { canonical: display(cleaned), key: cleaned, how: 'cleaned', confident: true };
  }

  // 3. The same name without its generational suffix. Sellers drop the III far
  //    more often than they include it, and the build only offers a base name
  //    here when it is unambiguous.
  if (SUFFIXLESS[cleaned]) {
    const key = SUFFIXLESS[cleaned];
    return { canonical: display(key), key, how: 'suffix', confident: true };
  }

  // 4. A canonical name sitting inside a longer string. Longest window wins;
  //    two different players in one string is a lot (or a mis-parse), so it is
  //    declined rather than arbitrated.
  let found = null;
  let foundLen = 0;
  for (const w of windows(kept)) {
    if (PLAYERS[w] === undefined) continue;
    const len = w.split(' ').length;
    if (found && found !== w && len === foundLen) return null; // tie between two names
    if (!found || len > foundLen) { found = w; foundLen = len; }
  }
  if (found) {
    return { canonical: display(found), key: found, how: 'embedded', confident: true };
  }

  // 5. Surname only, and only when exactly one player in the whole catalogue
  //    has it. 1,260 surnames are shared and every one of them is declined —
  //    picking between two Harrisons would merge two markets into one wrong one.
  for (const t of kept) {
    if (SUFFIX.test(t)) continue;
    const hit = SURNAMES[t];
    if (!hit) continue;
    return { canonical: display(hit), key: hit, how: 'surname', confident: false };
  }

  return null;
}

// Bulk helper for diagnostics and backfills: resolve a list of raw strings and
// report how far the dictionary actually gets on real data.
function resolveMany(rawList, { requireConfident = true } = {}) {
  const byCanonical = new Map();
  const unresolved = [];
  let resolved = 0;
  for (const raw of rawList) {
    const hit = resolvePlayer(raw);
    if (!hit || (requireConfident && !hit.confident)) { unresolved.push(raw); continue; }
    resolved++;
    if (!byCanonical.has(hit.key)) byCanonical.set(hit.key, { canonical: hit.canonical, variants: [] });
    byCanonical.get(hit.key).variants.push(raw);
  }
  return {
    input: rawList.length,
    resolved,
    unresolved,
    canonicalPlayers: byCanonical.size,
    byCanonical,
  };
}

module.exports = {
  resolvePlayer,
  resolveMany,
  norm,
  stats: {
    canonicalPlayers: Object.keys(PLAYERS).length,
    uniqueSurnames: Object.keys(SURNAMES).length,
    noiseWords: NOISE.size,
    builtAt: INDEX.builtAt,
    source: INDEX.source,
  },
};
