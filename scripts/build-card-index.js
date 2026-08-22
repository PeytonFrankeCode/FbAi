#!/usr/bin/env node
// Build a canonical card index from the checklists.
//
// The sales table holds 96,445 distinct values in its `player` column. There
// are not 96,445 football players — the column is parsed out of eBay listing
// titles, so one player arrives under dozens of spellings and the index groups
// them as if they were different people. The checklists are the cure: 361
// products, 374,840 catalogued cards, and the correct spelling of every name.
//
// This emits the dictionary the resolver matches against. Three vocabularies
// come out of it, and two are the interesting part:
//
//   players   Canonical names, with the surname index the resolver falls back
//             to, and a note of which surnames are ambiguous (Harrison Jr and
//             Harrison Sr are different players with different markets, so a
//             bare "Harrison" must resolve to neither).
//   noise     Words that appear in listing titles but are not part of a name:
//             team names, set names, parallel names, product names. Derived
//             from the checklists themselves rather than hand-listed, so it
//             stays current as new products are added.
//   parallels Canonical parallel names per product, for the second stage.
//
// Run: node scripts/build-card-index.js
const fs = require('fs');
const path = require('path');

const CHECKLIST_DIR = path.join(__dirname, '..', 'public', 'data', 'checklists');
const OUT = path.join(__dirname, '..', 'data', 'card-index.json');
// Parallels ship separately. They are only needed by the second stage, and
// folding them in nearly doubles an artifact that gets bundled into the Worker.
const OUT_PARALLELS = path.join(__dirname, '..', 'data', 'parallel-index.json');

// Same normalisation the SQL side uses, so a name that matches here matches
// there. Punctuation goes, case goes, runs of spaces collapse — and generational
// suffixes deliberately stay, because they are identity, not noise.
function norm(s) {
  return String(s == null ? '' : s)
    .replace(/[.,''`"’-]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// Listing jargon that is never part of a player's name. Everything else in the
// noise vocabulary is derived from the checklists; this is the residue that
// only ever appears in seller prose.
const LISTING_JARGON = [
  'rc', 'rookie', 'rookies', 'auto', 'autograph', 'autographed', 'signed',
  'patch', 'relic', 'jersey', 'mem', 'memorabilia', 'sp', 'ssp', 'case', 'hit',
  'card', 'cards', 'football', 'nfl', 'mint', 'nm', 'gem', 'lot', 'psa', 'bgs',
  'sgc', 'cgc', 'beckett', 'graded', 'ungraded', 'raw', 'slab', 'slabbed',
  'the', 'and', 'of', 'a', 'an', 'to', 'vs', 'w', 'with', 'new', 'hot',
  'invest', 'investment', 'rare', 'sharp', 'centered', 'pack', 'fresh', 'read',
  'see', 'photos', 'pics', 'pictures', 'free', 'shipping', 'ship', 'buy', 'now',
  'nice', 'clean', 'great', 'look', 'wow', 'l@@k', 'combined',
];

function collect() {
  const players = new Map();      // norm -> canonical spelling
  const teamNames = new Set();    // norm team name, e.g. "minnesota vikings"
  const playerTeams = new Map();  // norm -> Set(team)
  const surnames = new Map();     // norm surname -> Set(player norm)
  const parallelsByProduct = {};  // product id -> [parallel names]
  const noise = new Set(LISTING_JARGON);
  const products = [];

  let cardCount = 0;
  const files = fs.readdirSync(CHECKLIST_DIR).filter(f => f.endsWith('.json'));
  for (const file of files) {
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(path.join(CHECKLIST_DIR, file), 'utf8'));
    } catch (err) {
      console.warn(`  skipped ${file}: ${err.message}`);
      continue;
    }
    const sets = Array.isArray(doc.sets) ? doc.sets : [];
    products.push({
      id: doc.id || file.replace(/\.json$/, ''),
      name: doc.name || '',
      year: doc.year != null ? String(doc.year) : '',
      brand: doc.brand || '',
    });

    // Product and brand words are noise inside a player field: "Justin
    // Jefferson Prizm" is Justin Jefferson.
    for (const w of norm(doc.name).split(' ')) if (w.length > 1) noise.add(w);
    if (doc.brand) for (const w of norm(doc.brand).split(' ')) if (w.length > 1) noise.add(w);

    const pset = new Set();
    for (const set of sets) {
      for (const w of norm(set.name).split(' ')) if (w.length > 1) noise.add(w);
      for (const par of (set.parallels || [])) {
        const name = typeof par === 'string' ? par : (par && par.name);
        if (!name) continue;
        // Checklists carry the occasional prose footnote in the parallels list
        // ("listed under Autographs tab."). Those are not parallel names.
        if (name.length > 60 || /[.]$/.test(name.trim())) continue;
        pset.add(name);
        for (const w of norm(name).split(' ')) if (w.length > 1) noise.add(w);
      }
      for (const card of (set.cards || [])) {
        cardCount++;
        if (card.team) {
          teamNames.add(norm(card.team));
          for (const w of norm(card.team).split(' ')) if (w.length > 1) noise.add(w);
        }
        const raw = String(card.player || '').trim();
        if (!raw) continue;
        const n = norm(raw);
        if (!n) continue;
        if (!players.has(n)) players.set(n, raw);
        if (card.team) {
          if (!playerTeams.has(n)) playerTeams.set(n, new Set());
          playerTeams.get(n).add(card.team);
        }
      }
    }
    parallelsByProduct[doc.id || file.replace(/\.json$/, '')] = [...pset].sort();
  }

  // Sets catalogue team cards, so "Minnesota Vikings" arrives as a player name.
  // In a listing title that string is the team, not the subject, and leaving it
  // in the dictionary makes "Justin Jefferson - Minnesota Vikings" match two
  // names at once — which the resolver then declines rather than arbitrates,
  // losing a name it should have got. Teams come out.
  let droppedTeams = 0;
  for (const t of teamNames) {
    if (players.delete(t)) { droppedTeams++; playerTeams.delete(t); }
  }

  // Surname index, for titles that only give the last name. A surname shared by
  // more than one canonical player is recorded but marked unusable — guessing
  // between Marvin Harrison Jr and Marvin Harrison Sr is worse than declining.
  for (const n of players.keys()) {
    const parts = n.split(' ');
    if (parts.length < 2) continue;
    // Generational suffixes are part of identity, so the surname for lookup is
    // the last token that is not one.
    let i = parts.length - 1;
    while (i > 0 && /^(jr|sr|ii|iii|iv|v)$/.test(parts[i])) i--;
    const sur = parts[i];
    if (!sur || sur.length < 3) continue;
    if (!surnames.has(sur)) surnames.set(sur, new Set());
    surnames.get(sur).add(n);
  }

  // A player's own name tokens must never count as noise, or "Green" the
  // surname disappears because "Green" is also a parallel.
  const nameTokens = new Set();
  for (const n of players.keys()) for (const w of n.split(' ')) nameTokens.add(w);

  return { players, playerTeams, surnames, parallelsByProduct, noise, products,
           cardCount, nameTokens, teamNames, droppedTeams };
}

// Restores the display spelling for the common case where a canonical name is
// nothing but capitalised words. Anything with internal punctuation or unusual
// casing is stored verbatim instead.
function titleCase(n) {
  return n.split(' ').map(w => w ? w[0].toUpperCase() + w.slice(1) : w).join(' ');
}

function main() {
  const t0 = Date.now();
  const c = collect();

  const uniqueSurnames = {};
  let ambiguous = 0;
  for (const [sur, set] of c.surnames) {
    if (set.size === 1) uniqueSurnames[sur] = [...set][0];
    else ambiguous++;
  }

  // Noise words that are also somebody's name token are dropped from the noise
  // list. Stripping them would delete real names — there are players called
  // Green, Brown, Ice and Gold, and those are all parallel names too.
  const safeNoise = [...c.noise].filter(w => !c.nameTokens.has(w)).sort();
  const collides = [...c.noise].filter(w => c.nameTokens.has(w)).length;

  // Canonical spellings that survive normalisation unchanged are stored as 1
  // rather than repeated. Most names are already lowercase-and-spaces once
  // normalised, so this is most of them, and the resolver reads a 1 as "the
  // key is the answer, restored to title case".
  const players = {};
  for (const [n, raw] of [...c.players].sort((a, b) => a[0] < b[0] ? -1 : 1)) {
    players[n] = titleCase(n) === raw ? 1 : raw;
  }

  const out = {
    builtAt: new Date().toISOString(),
    source: { products: c.products.length, cards: c.cardCount },
    players,
    uniqueSurnames,
    noise: safeNoise,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out));
  fs.writeFileSync(OUT_PARALLELS, JSON.stringify({
    builtAt: out.builtAt,
    products: c.products,
    parallelsByProduct: c.parallelsByProduct,
  }));
  const kb = Math.round(fs.statSync(OUT).size / 1024);
  const pkb = Math.round(fs.statSync(OUT_PARALLELS).size / 1024);

  console.log(`card index -> ${path.relative(process.cwd(), OUT)}  (${kb} KB, ${Date.now() - t0}ms)`);
  console.log(`  products            ${c.products.length}`);
  console.log(`  catalogued cards    ${c.cardCount.toLocaleString('en-US')}`);
  console.log(`  canonical players   ${c.players.size.toLocaleString('en-US')} (${c.droppedTeams} team cards dropped)`);
  console.log(`  unique surnames     ${Object.keys(uniqueSurnames).length.toLocaleString('en-US')} usable, ${ambiguous} ambiguous (declined)`);
  console.log(`  noise vocabulary    ${safeNoise.length.toLocaleString('en-US')} words, ${collides} dropped for colliding with real names`);
  console.log(`  parallel sets       ${Object.keys(c.parallelsByProduct).length} (${pkb} KB, separate artifact)`);
}

main();
