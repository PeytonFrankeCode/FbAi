#!/usr/bin/env node
// Build the 2000 Bowman Football checklist <- scripts/data/2000-bowman.txt
//
// Then run: node scripts/rebuild-checklist-index.js && npm run build:card-index
//
// Source: the SportsCardsPro 2000 Bowman list (TCDB blocks automated
// access), "<number> <player>" per line, 240 cards. #1-140 are veterans,
// #141-240 rookies (#236 is the Tom Brady rookie). One parallel runs the
// whole set: Gold /99. Left out: the two checklist cards, the hobby pack and
// a lone "Cracked Ice" Brady listing with no other card beside it. The list
// carried no teams, so the team column is empty rather than guessed.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'public', 'data', 'checklists');

function build2000Bowman() {
  const cards = fs.readFileSync(path.join(__dirname, 'data', '2000-bowman.txt'), 'utf8')
    .split('\n').map(l => l.trim()).filter(Boolean)
    .map(line => {
      const m = line.match(/^(\d+)\s+(.+)$/);
      if (!m) throw new Error(`unreadable line: ${line}`);
      return { number: m[1], player: m[2], team: '' };
    });
  return {
    id: '2000-bowman-football', name: '2000 Bowman Football', year: 2000, brand: 'Bowman', sport: 'Football',
    note: 'Cards #141-240 are rookie cards, including #236 Tom Brady. Gold parallels are numbered to 99.',
    sets: [{
      id: 'base-set', name: 'Base Set', category: 'base', totalCards: cards.length,
      parallels: [{ name: 'Base', printRun: null }, { name: 'Gold', printRun: 99 }],
      cards,
    }],
  };
}

if (require.main === module) {
  const doc = build2000Bowman();
  fs.writeFileSync(path.join(OUT, `${doc.id}.json`), JSON.stringify(doc, null, 2) + '\n');
  console.log(doc.id, doc.sets.length, 'set,', doc.sets[0].cards.length, 'cards');
}
module.exports = { build2000Bowman };
