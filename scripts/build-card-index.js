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
// Emitted into public/, because that is how the Worker reads them: fetched over
// the assets binding at runtime rather than compiled into the script. A Worker
// compiles its whole bundle before serving anything, so 1.26 MB of JSON
// reachable from server.js cost CPU on every cold start whether or not the
// request touched it — which is what tripped the resource limit and took the
// site down. Node (tests, scripts) requires these same files, so there is one
// copy and it cannot drift from the one that ships.
const OUT = path.join(__dirname, '..', 'public', 'data', 'card-index.json');
// Parallels ship separately: they are only needed by the second stage, and
// folding them in nearly doubles the artifact.
const OUT_PARALLELS = path.join(__dirname, '..', 'public', 'data', 'parallel-index.json');

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

// A team is never a player (owner, Oct 2026). Checklist rows put teams in
// the player field three ways: team cards ("Steelers", "49ers Team", "Bears
// Logo"), a player with his team glued on ("Aaron Rodgers Green Bay Packers",
// "Earl Campbell / Houston Oilers"), and matchup cards ("Bengals vs Oilers
// Playoffs"). 705 dictionary "players" carried a team, so the reader resolved
// "Earl Campbell / Houston Oilers" to a player of that whole name, and
// "Steelers" to a player called Steelers.
//
// Stripped: every team phrase of two words or more the checklists use as a
// team, and NFL nicknames on their own. A glued-on team left behind is worse
// than useless: "Earl Dutch Clark/Colorado College Tigers" made "Tigers" a
// unique surname, and every "... Detroit Tigers" title resolved to Dutch
// Clark. NOT stripped: one-word college names, which are also surnames
// (Brown, Rice, Howard, Washington), and a phrase some checklist lists as a
// person on another team ("James Madison", Idaho State), unless it names an
// NFL team.
const { NFL_NICKNAMES } = require('../parallel-index-core');
const NFL_NICK_RE = new RegExp(`\\b(?:${NFL_NICKNAMES.join('|')})\\b`, 'i');
// What is left of a team card once the team is gone.
const TEAM_CARD_WORDS = new Set(['team', 'teams', 'checklist', 'checklists', 'logo', 'logos', 'pennant',
  'leaders', 'teamleaders', 'defense', 'offense', 'road', 'home', 'record', 'playoffs', 'playoff', 'vs',
  'v', 'at', 'and', 'champs', 'champions', 'championship', 'afc', 'nfc', 'sb', 'super', 'bowl', 'roster',
  'schedule', 'helmet', 'stadium', 'go', 'set', 'break', 'card', 'cards', 'the', 'of', 'in', 'season',
  'highlights', 'action', 'mascot', 'cheerleaders', 'franchise', 'history', 'rc']);

function teamStripper(teamCounts, personTeam) {
  const phrases = [...teamCounts].filter(([t]) => t.split(' ').length >= 2 && /[a-z]/.test(t)
      && !(personTeam.has(t) && !NFL_NICK_RE.test(t)))
    .map(([t]) => t).sort((a, b) => b.length - a.length);
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '[\\s.,\'’-]+');
  const phraseRe = new RegExp(`(?<![a-z0-9])(?:${phrases.map(esc).join('|')})(?![a-z0-9])`, 'gi');
  const nickRe = new RegExp(NFL_NICK_RE.source, 'gi');
  // The player with every team taken out, "/"-separated players kept apart;
  // null when nothing but a team (and team-card words) was there.
  return function cleanPlayer(raw) {
    const given = String(raw);
    // "Joe Theismann Go Irish", "Barry Sanders Go Cowboys!!": a cheer, not a name.
    const t = given.replace(/(?<![a-z])go\s+[a-z]+!*/gi, ' ').replace(phraseRe, ' ').replace(nickRe, ' ');
    if (t === given) return given;          // no team in it: left exactly as it was
    const parts = t.split('/').map(part => part.replace(/\s+/g, ' ').replace(/^[\s,;:&+-]+|[\s,;:&+-]+$/g, '').trim());
    const kept = parts.filter(x => norm(x).split(' ').some(w => w && !TEAM_CARD_WORDS.has(w) && /[a-z]/.test(w)));
    return kept.length ? kept.join(/\s\/\s/.test(given) ? ' / ' : '/') : null;
  };
}

function collect() {
  const players = new Map();      // norm -> canonical spelling
  const teamNames = new Set();    // norm team name, e.g. "minnesota vikings"
  const playerTeams = new Map();  // norm -> Set(team)
  const surnames = new Map();     // norm surname -> Set(player norm)
  const parallelsByProduct = {};  // product id -> [parallel names]
  const noise = new Set(LISTING_JARGON);
  const products = [];
  const setNames = new Set();   // subset names: "Rookies", "Concourse", "Fearless"
  const teamCounts = new Map();   // norm team -> cards listing it
  const personTeam = new Set();   // norm player names listed beside some other team
  const rawPlayers = [];          // { raw, team }, read once every team is known

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
    // checklists/index.json is the manifest the landing-page builder reads, not
    // a product. Without this it was catalogued as one: a 362nd product with no
    // id, no name and an empty parallel list, carried in every copy of the
    // shipped artifact. Harmless, but it is a product that does not exist, and
    // it made "does the built index match the checklists" impossible to assert
    // cleanly.
    if (!Array.isArray(doc.sets)) continue;
    const sets = doc.sets;
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
      if (set.name) setNames.add(norm(set.name));
      for (const w of norm(set.name).split(' ')) if (w.length > 1) noise.add(w);
      for (const par of (set.parallels || [])) {
        const name = typeof par === 'string' ? par : (par && par.name);
        if (!name) continue;
        // Checklists carry the occasional prose footnote in the parallels list
        // ("listed under Autographs tab."). Those are not parallel names.
        if (name.length > 60 || /[.]$/.test(name.trim())) continue;
        pset.add(name);
        for (const w of norm(name).split(' ')) if (w.length > 1) noise.add(w);

        // What the market calls this parallel, when that is not what the
        // catalogue calls it.
        //
        // These are not spelling variants — variants() in the reader already
        // handles "Silver Prizm"/"Silver Prizms"/"Silver". These are different
        // words for the same thing, which no amount of morphology recovers.
        // Panini's own checklists name the unnumbered chrome parallel "Prizm";
        // every seller on eBay writes "Silver" or "Silver Prizm". A reader
        // built only from the catalogue therefore cannot read the commonest
        // spelling of one of the most traded cards in the product.
        //
        // Aliases go into the VOCABULARY only. The UI and the landing-page
        // parallel counts read `name` and `printRun`, so an alias adds a
        // spelling the reader understands without inventing a parallel that
        // does not exist — which is what a duplicate entry would have done.
        for (const alias of (par && Array.isArray(par.aliases) ? par.aliases : [])) {
          const a = String(alias || '').trim();
          if (!a || a.length > 60) continue;
          pset.add(a);
          for (const w of norm(a).split(' ')) if (w.length > 1) noise.add(w);
        }
      }
      for (const card of (set.cards || [])) {
        cardCount++;
        if (card.team) {
          const t = norm(card.team);
          teamNames.add(t);
          teamCounts.set(t, (teamCounts.get(t) || 0) + 1);
          for (const w of t.split(' ')) if (w.length > 1) noise.add(w);
        }
        const raw = String(card.player || '').trim();
        if (!raw) continue;
        const n = norm(raw);
        if (!n) continue;
        if (card.team && norm(card.team) !== n) personTeam.add(n);
        rawPlayers.push({ raw, team: card.team || '' });
      }
    }
    parallelsByProduct[doc.id || file.replace(/\.json$/, '')] = [...pset].sort();
  }

  // Players, with teams taken out (see teamStripper above).
  const cleanPlayer = teamStripper(teamCounts, personTeam);
  let teamsStripped = 0;
  for (const { raw: given, team } of rawPlayers) {
    const raw = cleanPlayer(given);
    if (raw !== given) teamsStripped++;
    if (!raw) continue;
    const n = norm(raw);
    if (!n) continue;
    if (!players.has(n)) players.set(n, raw);
    if (team) {
      if (!playerTeams.has(n)) playerTeams.set(n, new Set());
      playerTeams.get(n).add(team);
    }
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

  // Rookies are listed both ways: the checklist says "Luther Burden III", the
  // seller writes "Luther Burden". A base name maps to its suffixed player only
  // when exactly one player has that base AND the base is not itself somebody's
  // full name — "Marvin Harrison" is a real player, so it must never be treated
  // as shorthand for "Marvin Harrison Jr".
  const baseNames = new Map();
  for (const n of players.keys()) {
    const parts = n.split(' ');
    if (parts.length < 3) continue;
    if (!/^(jr|sr|ii|iii|iv|v)$/.test(parts[parts.length - 1])) continue;
    const base = parts.slice(0, -1).join(' ');
    if (players.has(base)) continue;             // the base is its own player
    if (!baseNames.has(base)) baseNames.set(base, new Set());
    baseNames.get(base).add(n);
  }
  const suffixless = {};
  let baseAmbiguous = 0;
  for (const [base, set] of baseNames) {
    if (set.size === 1) suffixless[base] = [...set][0];
    else baseAmbiguous++;
  }

  // A player's own name tokens must never count as noise, or "Green" the
  // surname disappears because "Green" is also a parallel.
  const nameTokens = new Set();
  for (const n of players.keys()) for (const w of n.split(' ')) nameTokens.add(w);

  // The last word of every team of two words or more: "tigers", "irish",
  // "buckeyes". Never a surname to resolve a title by (see main()).
  const teamLast = new Set([...teamCounts.keys()].filter(t => t.split(' ').length >= 2)
    .map(t => t.split(' ').pop()).filter(w => /^[a-z]+$/.test(w)));

  return { players, playerTeams, surnames, parallelsByProduct, noise, products,
           cardCount, nameTokens, teamNames, droppedTeams, suffixless, baseAmbiguous,
           setNames, teamsStripped, teamLast };
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
  // A team's last word that is one player's last token is a team left in a
  // player field, not a surname: "Tigers" resolved every "... Detroit Tigers"
  // title to Earl "Dutch" Clark of the Colorado College Tigers. Declined.
  let teamWords = 0;
  for (const [sur, set] of c.surnames) {
    if (set.size === 1 && c.teamLast.has(sur)) { teamWords++; continue; }
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
    suffixless: c.suffixless,
    noise: safeNoise,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out));
  fs.writeFileSync(OUT_PARALLELS, JSON.stringify({
    builtAt: out.builtAt,
    products: c.products,
    parallelsByProduct: c.parallelsByProduct,
    // Product and subset names, so a reader can strip them off a title and see
    // what is left. Half the titles put the parallel BEFORE the card number
    // ("Jaxson Dart RC Refractor #306 Giants"), and the only safe way to find
    // it there is to remove everything that is known not to be a parallel.
    productNames: [...new Set(c.products.map(p => p.name).filter(Boolean))].sort(),
    setNames: [...c.setNames].sort(),
  }));
  const kb = Math.round(fs.statSync(OUT).size / 1024);
  const pkb = Math.round(fs.statSync(OUT_PARALLELS).size / 1024);

  console.log(`card index -> ${path.relative(process.cwd(), OUT)}  (${kb} KB, ${Date.now() - t0}ms)`);
  console.log(`  products            ${c.products.length}`);
  console.log(`  catalogued cards    ${c.cardCount.toLocaleString('en-US')}`);
  console.log(`  canonical players   ${c.players.size.toLocaleString('en-US')} (${c.droppedTeams} team cards dropped, ${c.teamsStripped} entries had a team taken out)`);
  console.log(`  unique surnames     ${Object.keys(uniqueSurnames).length.toLocaleString("en-US")} usable, ${ambiguous} ambiguous (declined), ${teamWords} team words refused`);
  console.log(`  suffix-optional     ${Object.keys(c.suffixless).length.toLocaleString('en-US')} names ("Luther Burden" -> "Luther Burden III"), ${c.baseAmbiguous} ambiguous (declined)`);
  console.log(`  noise vocabulary    ${safeNoise.length.toLocaleString('en-US')} words, ${collides} dropped for colliding with real names`);
  console.log(`  parallel sets       ${Object.keys(c.parallelsByProduct).length} (${pkb} KB, separate artifact)`);
}

main();
