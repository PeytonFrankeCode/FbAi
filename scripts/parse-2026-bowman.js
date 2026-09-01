#!/usr/bin/env node
// Turn the 2026 Bowman Football checklist as Topps publishes it into the
// checklist JSON the site reads.
//
// Kept as a script rather than a hand-typed JSON file because the source is
// ~1,900 rows: transcribing that by hand guarantees silent errors, and errors
// in a checklist are the kind nobody notices until a card will not group.
// Re-running this against a corrected paste is also how a fix gets made later.
//
// The parse is deliberately literal: it reports what looks odd and repairs
// nothing. A checklist that disagrees with the printed cards is worse than one
// with a visible gap, because the site treats it as ground truth when resolving
// what a listing is.
//
// That literalness matters more than it first appears. The team column here
// looked wrong on a first read — DJ Moore under Buffalo, Michael Pittman Jr.
// under Pittsburgh, Kenneth Walker III under Kansas City — and it is not: those
// are offseason moves, and the checklist is simply more current than whoever is
// reading it. Anything that "corrects" a roster against outside knowledge will
// eventually be wrong in exactly this way, so nothing here does.
//
// What IS worth flagging is internal inconsistency, which needs no knowledge of
// football to judge: a card number used twice, or a row whose columns ran
// together. Those are the only things reported.
//
// Run: node scripts/parse-2026-bowman.js <raw.txt> [--write]
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'public', 'data', 'checklists', '2026-bowman-football.json');

// Section header -> the set it opens. Anything not listed is ignored, which is
// how the prose header and the odds disclaimer stay out of the data.
//
// The third column is the category, and it has to be one of exactly these four
// strings: base, autograph, memorabilia, insert. The checklist browser filters
// with `s.category !== checklistFilter` against tabs hardcoded to those values
// (index.html:438-441) and picks badges with `set.category === 'autograph'`.
// Anything else — including the same words capitalised — matches no tab and
// gets no badge, so the sets load but cannot be found. Bowman's prospect sets
// map to base: they are the core cards of the product, and there is no
// prospects tab for them to land on.
const SECTIONS = [
  ['BASE NFL',                                   'Base', 'base'],
  ['BASE ROOKIE',                                'Base Rookies', 'base'],
  ['PAPER PROSPECTS',                            'Paper Prospects', 'base'],
  ['CHROME NFL BASE',                            'Chrome', 'base'],
  ['CHROME ROOKIE BASE',                         'Chrome Rookies', 'base'],
  ['CHROME PROSPECTS',                           'Chrome Prospects', 'base'],
  ['1955 ALL AMERICAN AUTOGRAPH VARIATION',      '1955 All American Autograph Variation', 'autograph'],
  ['1955 ALL AMERICAN',                          '1955 All American', 'insert'],
  ['ANIME NFL',                                  'Anime NFL', 'insert'],
  ['ANIME NIL',                                  'Anime NIL', 'insert'],
  ['BASE CHROME NFL ETCHED IN GLASS VARIATION',  'Chrome NFL Etched in Glass Variation', 'insert'],
  ['BASE CHROME NIL ETCHED IN GLASS VARIATION',  'Chrome NIL Etched in Glass Variation', 'insert'],
  ['BASE CHROME RETROFRACTOR',                   'Chrome RetroFractor', 'insert'],
  ['BOWMAN GPK NFL',                             'Bowman GPK NFL', 'insert'],
  ['BOWMAN GPK NIL',                             'Bowman GPK NIL', 'insert'],
  ['BOWMAN SPOTLIGHTS NFL',                      'Bowman Spotlights NFL', 'insert'],
  ['BOWMAN SPOTLIGHTS NIL',                      'Bowman Spotlights NIL', 'insert'],
  ['BOWMAN VERIFIED',                            'Bowman Verified', 'insert'],
  ['CRYSTALLIZED NFL',                           'Crystallized NFL', 'insert'],
  ['CRYSTALLIZED NIL',                           'Crystallized NIL', 'insert'],
  ['GEN NEXT',                                   'Gen Next', 'insert'],
  ['GREATNESS LOADING',                          'Greatness Loading', 'insert'],
  ['HOBBY STARS',                                'Hobby Stars', 'insert'],
  ['MEGA PROSPECTS',                             'Mega Prospects', 'insert'],
  ['MEGA ROOKIES',                               'Mega Rookies', 'insert'],
  ['ROY FAVORITES',                              'ROY Favorites', 'insert'],
  ['ROCKSTAR ROOKIES',                           'Rockstar Rookies', 'insert'],
  ['ROOKIE RED RC VARIATION',                    'Rookie Red RC Variation', 'insert'],
  ['TALENT TRACKER',                             'Talent Tracker', 'insert'],
  ['VERY IMPORTANT PROSPECTS',                   'Very Important Prospects', 'insert'],
  ['YOUNG KINGS',                                'Young Kings', 'insert'],
  ['BASE CHROME AUTOGRAPHS',                     'Chrome Autographs', 'autograph'],
  ['BASE PAPER NFL AUTOGRAPHS',                  'Paper NFL Autographs', 'autograph'],
  ['BASE CHROME ROOKIE AUTOGRAPHS',              'Chrome Rookie Autographs', 'autograph'],
  ['BASE PAPER ROOKIE AUTOGRAPHS',               'Paper Rookie Autographs', 'autograph'],
  ['CHROME PROSPECT AUTOGRAPHS',                 'Chrome Prospect Autographs', 'autograph'],
  ['PAPER PROSPECT AUTOGRAPHS',                  'Paper Prospect Autographs', 'autograph'],
  ['BOWMAN DUAL CROSS SPORT AUTOGRAPHS',         'Dual Cross Sport Autographs', 'autograph'],
  ['BOWMAN DUAL NFL AUTOGRAPHS',                 'Dual NFL Autographs', 'autograph'],
  ['BOWMAN DUAL NIL AUTOGRAPHS',                 'Dual NIL Autographs', 'autograph'],
  ['BOWMAN TRIPLE NFL AUTOGRAPHS',               'Triple NFL Autographs', 'autograph'],
  ['BOWMAN TRIPLE NIL AUTOGRAPHS',               'Triple NIL Autographs', 'autograph'],
  ['BUZZ FACTOR AUTOGRAPHS',                     'Buzz Factor Autographs', 'autograph'],
  ['FUTURE SCRIPT',                              'Future Script', 'autograph'],
  ['OPENING STATEMENT SIGNATURES',               'Opening Statement Signatures', 'autograph'],
  ['TIMELESS TOUCH SIGNATURES',                  'Timeless Touch Signatures', 'autograph'],
];
// Longest first, so "BASE CHROME NFL ETCHED IN GLASS VARIATION" is not eaten by
// a shorter header that happens to be a prefix of it.
SECTIONS.sort((a, b) => b[0].length - a[0].length);

// Headers that group other headers rather than opening a set of their own.
const GROUP_ONLY = new Set(['BASE', 'INSERT', 'AUTOGRAPH', 'AUTOGRAPHS']);

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

function parse(raw) {
  const sets = [];
  const notes = [];
  let current = null;

  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Tabs separate the columns, but the source uses a mix of tabs and runs of
    // spaces, and several rows carry a lone non-breaking space as a filler
    // column. Split on tabs, then discard blank cells.
    const cells = line.split('\t').map(c => c.replace(/ /g, ' ').trim());
    const joined = cells.join(' ').trim();
    if (!joined) continue;

    const upper = joined.toUpperCase().replace(/\s+/g, ' ').trim();
    if (GROUP_ONLY.has(upper)) continue;
    if (/^CHECKLISTS PROVIDED BY TOPPS/i.test(joined)) continue;
    if (/^PRODUCT AT THE TIME OF PRODUCTION/i.test(joined)) continue;
    if (/^2026 BOWMAN FOOTBALL CHECKLIST/i.test(joined)) continue;

    const hit = SECTIONS.find(([h]) => upper === h);
    if (hit) {
      current = { id: slug(hit[1]), name: hit[1], category: hit[2], cards: [], seen: new Map() };
      sets.push(current);
      continue;
    }

    const cols = cells.filter(Boolean);
    if (cols.length < 2 || !current) {
      if (cols.length && !hit && /^[A-Z0-9 &'!-]+$/.test(upper) && upper.length > 3 && !current) {
        notes.push(`line ${i + 1}: unrecognised header "${joined}"`);
      }
      continue;
    }

    let [number, player, team, flag] = cols;
    // One source row has the player and team run together into a single cell
    // where the column separator was lost. Rather than guess where the split
    // belongs, record it and keep the row with an empty team.
    if (!team && /\s{2,}/.test(player)) {
      notes.push(`line ${i + 1}: "${player}" — player and team share one column, team left blank`);
      player = player.replace(/\s{2,}.*$/, '').trim();
      team = '';
    }
    if (!number || !player) continue;

    const card = { number, player: player.replace(/\s+/g, ' ').trim() };
    if (team) card.team = team.replace(/\s+/g, ' ').trim();
    // Multi-signer autographs legitimately repeat a card number, one row per
    // signer, so a repeat is only worth reporting on a single-signer set.
    const multi = /Dual|Triple/i.test(current.name);
    if (current.seen.has(number) && !multi) {
      notes.push(`${current.name}: card #${number} appears twice `
        + `("${current.seen.get(number)}" and "${card.player}")`);
    }
    current.seen.set(number, card.player);
    if (flag && /rookie/i.test(flag)) card.rookie = true;
    current.cards.push(card);
  }

  for (const s of sets) delete s.seen;
  return { sets: sets.filter(s => s.cards.length), notes };
}

function main() {
  const file = process.argv[2];
  if (!file) { console.error('usage: parse-2026-bowman.js <raw.txt> [--write]'); process.exit(1); }
  const { sets, notes } = parse(fs.readFileSync(file, 'utf8'));

  const doc = {
    id: '2026-bowman-football',
    name: '2026 Bowman Football',
    year: 2026,
    brand: 'Bowman',
    sport: 'Football',
    sets: sets.map(s => ({
      id: s.id,
      name: s.name,
      category: s.category,
      totalCards: s.cards.length,
      parallels: [{ name: 'Base', printRun: null }],
      cards: s.cards,
    })),
  };

  const total = doc.sets.reduce((n, s) => n + s.cards.length, 0);
  console.log(`2026 Bowman Football: ${doc.sets.length} sets, ${total.toLocaleString('en-US')} cards`);
  for (const s of doc.sets) console.log(`  ${String(s.totalCards).padStart(4)}  ${s.name}`);

  if (notes.length) {
    console.log(`\n${notes.length} thing(s) worth a look in the source — reported, not repaired:`);
    for (const n of notes) console.log(`  - ${n}`);
  }

  if (!process.argv.includes('--write')) {
    console.log('\n--write not given: nothing saved');
    return;
  }
  fs.writeFileSync(OUT, JSON.stringify(doc, null, 2) + '\n');
  console.log(`\nwrote ${path.relative(process.cwd(), OUT)}`);
}

main();
