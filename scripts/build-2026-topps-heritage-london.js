#!/usr/bin/env node
// Build two 2026 Topps checklists from Topps's published text:
//   2026 Topps Heritage Football        <- scripts/data/2026-topps-heritage.txt
//   2026 Topps London Games Flagship    <- scripts/data/2026-topps-london-games.txt
//
// Then run: node scripts/rebuild-checklist-index.js && npm run build:card-index
//
// Heritage text: category headers (BASE, INSERT, AUTOGRAPH, MEMORABILIA) and
// set headers in capitals, then "<number> <player> <team>[ Rookie| Record
// Breakers| League Leaders| Team Cards]". What was cleaned from Topps's copy:
//   - "331 2026 AFC Championship Game 332 ... 334 Tyler Shough ..." ran four
//     cards onto one line; split.
//   - Chrome Variation repeats the base list (@SAMEAS). Topps's copy printed
//     Aidan Hutchinson as #142 beside A.J. Terrell and skipped #259, and spelt
//     Cade Otton "Otten"; the base list has both right.
//   - Cut Signatures sat under RELIC but are autographs; the relic-autograph
//     sets are autographs, as in 2026 Topps (an RPA prices as an auto).
//   - The Walter Payton Rookie Redemption numbers and grades were run
//     together; rebuilt (@PAYTON) from their order: 1 PSA 10, 3 PSA 9, 5 PSA 8,
//     12 PSA 7, 13 PSA 6.
// Parallels for Heritage were not in the source, so every set carries Base
// only, with a note, as 2026 Bowman University did.
//
// London Games is Flagship's 400 with London-exclusive parallels. Its insert
// section lists only parallels for 1991 Topps Chrome and 1991 Topps Chrome
// Rookies, so their cards are taken from the 2026 Topps Flagship checklist.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'public', 'data', 'checklists');
const read = (f) => fs.readFileSync(path.join(__dirname, 'data', f), 'utf8').split('\n').map(l => l.trim()).filter(Boolean);

const TEAMS = [
  'Arizona Cardinals', 'Atlanta Falcons', 'Baltimore Ravens', 'Buffalo Bills', 'Carolina Panthers', 'Chicago Bears',
  'Cincinnati Bengals', 'Cleveland Browns', 'Dallas Cowboys', 'Denver Broncos', 'Detroit Lions', 'Green Bay Packers',
  'Houston Texans', 'Indianapolis Colts', 'Jacksonville Jaguars', 'Kansas City Chiefs', 'Las Vegas Raiders',
  'Los Angeles Chargers', 'Los Angeles Rams', 'Miami Dolphins', 'Minnesota Vikings', 'New England Patriots',
  'New Orleans Saints', 'New York Giants', 'New York Jets', 'Philadelphia Eagles', 'Pittsburgh Steelers',
  'San Francisco 49ers', 'Seattle Seahawks', 'Tampa Bay Buccaneers', 'Tennessee Titans', 'Washington Commanders',
  // Legends' teams as Topps prints them.
  'Washington Redskins', 'Oakland Raiders', 'San Diego Chargers', 'Houston Oilers', 'Los Angeles Raiders',
].sort((a, b) => b.length - a.length);
const SUFFIXES = [' Record Breakers', ' League Leaders', ' Team Cards', ' Chrome Variation', ' Rookie'];
const CATEGORY = { BASE: 'base', INSERT: 'insert', AUTOGRAPH: 'autograph', MEMORABILIA: 'memorabilia' };

const slug = (s) => s.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const titleCase = (s) => s.toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase())
  .replace(/\bAnd\b/g, 'and').replace(/\bThe\b(?!^)/g, (m, i) => (i === 0 ? m : 'the')).replace(/^the/, 'The');

function splitPlayerTeam(rest) {
  let s = rest;
  for (let changed = true; changed;) {
    changed = false;
    for (const suf of SUFFIXES) if (s.endsWith(suf)) { s = s.slice(0, -suf.length); changed = true; }
  }
  const team = TEAMS.find(t => s.endsWith(' ' + t) || s === t);
  if (!team) return { player: s, team: '' };
  const player = s === team ? team : s.slice(0, -(team.length + 1)).trim();
  return { player: player || team, team };
}

// Heritage set names: drop the "Base Cards" prefix Topps puts on variations.
const heritageName = (h) => {
  if (h === 'BASE CARDS') return 'Base Set';
  return titleCase(h.replace(/^BASE CARDS /, ''));
};

function buildHeritage() {
  const sets = [];
  let category = null, cur = null;
  const byName = new Map();
  for (const line of read('2026-topps-heritage.txt')) {
    if (CATEGORY[line]) { category = CATEGORY[line]; continue; }
    if (line.startsWith('@SAMEAS ')) {
      cur.cards = byName.get(heritageName(line.slice(8))).cards.map(c => ({ ...c }));
      continue;
    }
    if (line === '@PAYTON') {
      const grades = [10, 9, 9, 9, 8, 8, 8, 8, 8, ...Array(12).fill(7), ...Array(13).fill(6)];
      cur.cards = grades.map((g, i) => ({ number: `WPRR-${i + 1}`, player: 'Walter Payton', team: 'Chicago Bears' }));
      cur.note = `1976 Topps Walter Payton rookie redemptions: ${grades.map((g, i) => `WPRR-${i + 1} PSA ${g}`).join(', ')}.`;
      continue;
    }
    const m = line.match(/^(\S+)\s+(.+)$/);
    // "1", "NAP-1", "FEI-AW", "CA-WP1": a number, or a coded one with a dash.
    const isCard = m && (/^\d+$/.test(m[1]) || /^[A-Z]{1,5}-[A-Z0-9]+$/.test(m[1]));
    if (!isCard) {
      cur = { id: slug(heritageName(line)), name: heritageName(line), category, totalCards: 0,
              parallels: [{ name: 'Base', printRun: null }], cards: [] };
      sets.push(cur); byName.set(cur.name, cur);
      continue;
    }
    cur.cards.push({ number: m[1], ...splitPlayerTeam(m[2]) });
  }
  for (const s of sets) s.totalCards = s.cards.length;
  return {
    id: '2026-topps-heritage-football', name: '2026 Topps Heritage Football', year: 2026, brand: 'Topps Heritage',
    sport: 'Football',
    note: 'Parallels for this product have not been published yet. Card numbers and names are final; parallel lists will be added as Topps publishes them.',
    sets,
  };
}

function buildLondon() {
  const flagship = JSON.parse(fs.readFileSync(path.join(OUT, '2026-topps-football.json'), 'utf8'));
  const fBase = new Map(flagship.sets[0].cards.map(c => [c.number, c]));
  const cards = read('2026-topps-london-games.txt').map(line => {
    const m = line.match(/^(\d+)\s+(.+)$/);
    let [, number, rest] = m;
    rest = rest.replace(/\s+RC$/, '');
    let player, team;
    if (rest.includes(' - ')) {
      [player, team] = rest.split(' - ').map(s => s.trim());
      if (/^(Team|Combo) Cards$/.test(player)) player = team;
    } else {
      // League leaders: three players, teams as Flagship prints the same card.
      player = rest;
      const f = fBase.get(number);
      const norm = (x) => String(x || '').replace(/[\u2018\u2019]/g, "'");
      team = f && norm(f.player) === norm(player) ? f.team : '';
    }
    return { number, player, team };
  });
  const P = (name, printRun = null) => ({ name, printRun });
  const refractors = [P('Union Jack Refractor'), P('Big Ben Refractor'), P('Tudor Rose Refractor'), P('Crown Jewels Refractor')];
  const fromFlagship = (id, name) => {
    const s = flagship.sets.find(x => x.id === id);
    return { id: slug(name), name, category: 'insert', totalCards: s.cards.length, parallels: [P('Base'), ...refractors],
             cards: s.cards.map(c => ({ ...c })) };
  };
  return {
    id: '2026-topps-london-games-football', name: '2026 Topps London Games Flagship Football', year: 2026,
    brand: 'Topps London Games', sport: 'Football',
    note: 'London Games exclusive parallels. The 1991 Topps Chrome and 1991 Topps Chrome Rookies card lists are the same as 2026 Topps Flagship; refractor print runs were not published. Base Lenticular London (1:360 packs) is listed as a Base parallel.',
    sets: [
      { id: 'base-set', name: 'Base Set', category: 'base', totalCards: cards.length,
        parallels: [P('Base'), P('Union Jack Rainbow Foil'), P('Union Jack Blue Rainbow Foil'), P('Lenticular London'),
                    P('Big Ben', 59), P('Tudor Rose', 5), P('Crown Jewels', 1)],
        cards },
      fromFlagship('1991-topps-football-chrome', '1991 Topps Chrome'),
      fromFlagship('1991-topps-rookies-football-chrome', '1991 Topps Chrome Rookies'),
    ],
  };
}

if (require.main === module) {
  for (const doc of [buildHeritage(), buildLondon()]) {
    fs.writeFileSync(path.join(OUT, `${doc.id}.json`), JSON.stringify(doc, null, 2) + '\n');
    console.log(doc.id, doc.sets.length, 'sets,', doc.sets.reduce((t, s) => t + s.cards.length, 0), 'cards');
  }
}
module.exports = { buildHeritage, buildLondon, splitPlayerTeam };
