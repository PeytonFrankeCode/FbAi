#!/usr/bin/env node
// Build public/data/sport-players.json: the basketball and baseball players a
// listing title can be recognised by.
//
// Search covers every sport a person has turned on, with no sport to pick, so
// the page has to tell from a listing which sport it is: to hide the sports
// that are off, and to say "under testing" when basketball or baseball comes
// back. Few titles say "NBA" or "baseball" (2 of 16 in a Wembanyama search);
// nearly all name the player. So: every player on at least 3 cards in that
// sport's checklists, and at least 80% of all their cards (football from 1990
// on counts too), since a name shared across sports says nothing. Football needs no
// list: a title that names no basketball or baseball player is read as
// football, which the site has always been.
//
// Run: node scripts/build-sport-players.js [--check]
const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '..', 'public', 'data');
const OUT = path.join(DATA, 'sport-players.json');
const MIN_CARDS = 3;

// Same normalisation as _sportNorm() in app.js: accents off, lower case,
// suffixes and punctuation dropped.
function norm(name) {
  return String(name || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z' .-]/g, ' ').replace(/\b(jr|sr|ii|iii|iv)\b\.?/g, '').replace(/[.']/g, '')
    .replace(/[-\s]+/g, ' ').trim();
}

function playersIn(dir, minYear) {
  const counts = new Map();
  const full = path.join(DATA, dir);
  for (const f of fs.readdirSync(full)) {
    if (!f.endsWith('.json') || f === 'index.json') continue;
    const doc = JSON.parse(fs.readFileSync(path.join(full, f), 'utf8'));
    if (minYear && (doc.year || 0) < minYear) continue;
    for (const s of doc.sets || []) {
      for (const c of s.cards || []) {
        for (const one of String(c.player || '').split(/\s*\/\s*|\s+&\s+|,\s*/)) {
          const n = norm(one);
          const words = n.split(' ').length;
          if (words >= 2 && words <= 3 && n.length >= 6) counts.set(n, (counts.get(n) || 0) + 1);
        }
      }
    }
  }
  return counts;
}

function build() {
  const football = playersIn('checklists', 1990);
  const basketball = playersIn('checklists-basketball');
  const baseball = playersIn('checklists-baseball');
  // A player belongs to a sport when at least 80% of their cards are in it:
  // multi-sport inserts (Allen & Ginter, Finest, Exquisite) put Wembanyama in
  // baseball and football checklists, and one such card must not cost him.
  const keep = (mine, ...others) => [...mine]
    .filter(([n, k]) => k >= MIN_CARDS && k >= 4 * others.reduce((a, o) => a + (o.get(n) || 0), 0))
    .map(([n]) => n).sort();
  return { basketball: keep(basketball, football, baseball), baseball: keep(baseball, football, basketball) };
}

const built = JSON.stringify(build()) + '\n';
if (process.argv.includes('--check')) {
  const have = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (have !== built) { console.log('sport-players.json is out of date. Run: node scripts/build-sport-players.js'); process.exit(1); }
  console.log('sport-players.json matches the checklists');
} else {
  fs.writeFileSync(OUT, built);
  const d = JSON.parse(built);
  console.log(`wrote sport-players.json: ${d.basketball.length} basketball, ${d.baseball.length} baseball players (${Math.round(built.length / 1024)} KB)`);
}
