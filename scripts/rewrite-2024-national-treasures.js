#!/usr/bin/env node
/**
 * Hand-curated rewrite of 2024 Panini National Treasures Football.
 * The auto-parser missed parallels and concatenated player lines for this
 * product; the data below was supplied by the user from a clean checklist.
 *
 * Writes public/data/checklists/2024-panini-national-treasures-football.json
 * and updates the corresponding entry in index.json.
 */
const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', 'public', 'data', 'checklists');
const FILE = path.join(OUT_DIR, '2024-panini-national-treasures-football.json');
const INDEX_PATH = path.join(OUT_DIR, 'index.json');
const TXT_PATH = path.join(__dirname, '2024-national-treasures.txt');

const RAW = fs.readFileSync(TXT_PATH, 'utf8');

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

function parseCardLine(line) {
  // Examples:
  //   1 Kyler Murray, Arizona Cardinals /99
  //   151 Chop Robinson, Miami Dolphins (NO BASE OR PURPLE)
  //   1 Mike Singletary/Dan Hampton/William Perry, Chicago Bears /25
  //   164 Ricky Pearsall, San Francisco 49ers /99 (NO PREMIUM GOLD VINYL)
  // Card number is the leading integer; everything else is the player/team.
  // Trailing "/<digits>" before any parenthetical is the per-card print run.
  // Trailing parenthetical "(...)" is a note we keep on the card.
  const m = line.match(/^(\d+)\s+(.+)$/);
  if (!m) return null;
  const num = m[1];
  let rest = m[2].trim();
  let note = null;
  const noteMatch = rest.match(/\s*\(([^)]+)\)\s*$/);
  if (noteMatch) {
    note = noteMatch[1].trim();
    rest = rest.slice(0, noteMatch.index).trim();
  }
  let printRun = null;
  const prMatch = rest.match(/\s+\/(\d+(?:\s*or fewer)?)\s*$/i);
  if (prMatch) {
    printRun = prMatch[1].replace(/\s*or fewer/i, '').trim();
    rest = rest.slice(0, prMatch.index).trim();
  }
  // Split player and team on the LAST comma (player names sometimes contain commas)
  const lastComma = rest.lastIndexOf(',');
  let player, team;
  if (lastComma === -1) {
    player = rest;
    team = '';
  } else {
    player = rest.slice(0, lastComma).trim();
    team = rest.slice(lastComma + 1).trim();
  }
  const card = { number: num, player, team };
  if (printRun) card.printRun = printRun;
  if (note) card.note = note;
  return card;
}

function parseParallelLine(line) {
  // Examples:
  //   Purple /75
  //   Holo Silver /25
  //   Printing Plates /1 (Each card has Cyan, Magenta, Yellow, and Black)
  //   Red /1 (See list below)
  //   Refractors (no print run)
  const printMatch = line.match(/\s+\/(\d+|1\/1)\s*(\(.*\))?$/);
  if (printMatch) {
    return { name: line.slice(0, printMatch.index).trim(), printRun: printMatch[1].replace('1/1', '1') };
  }
  return { name: line.replace(/\s*\([^)]*\)\s*$/, '').trim(), printRun: null };
}

function buildProduct(raw) {
  const lines = raw.split('\n').map(l => l.trim());
  const sets = [];
  let category = 'base';
  let i = 0;

  // Skip product title + intro paragraph
  while (i < lines.length) {
    if (lines[i].startsWith('Base Set Checklist')) break;
    i++;
  }

  while (i < lines.length) {
    const l = lines[i];
    if (!l) { i++; continue; }

    // Category transitions (lines that exactly equal one of these)
    if (l === 'Autographs') { category = 'autograph'; i++; continue; }
    if (l === 'Memorabilia Cards') { category = 'memorabilia'; i++; continue; }
    if (l === 'Inserts') { category = 'insert'; i++; continue; }
    if (l === 'Updates') { category = 'insert'; i++; continue; }
    // Year sub-headers in Updates section — keep category, skip line
    if (/^\d{4} National Treasures$/i.test(l)) { i++; continue; }
    // 'Checklist Top' or anything past the end of relevant data
    if (l === 'Checklist Top' || l.startsWith('Recent National Treasures')) break;

    // A set header is a non-empty line that is NOT a parallel/card line and
    // is followed (after blanks) by an "N cards" line.
    if (/^\d+\s/.test(l)) { i++; continue; } // stray card-looking line — skip
    let probe = i + 1;
    while (probe < lines.length && lines[probe] === '') probe++;
    const countMatch = lines[probe] && lines[probe].match(/^(\d+)\s+cards?/i);
    if (!countMatch) { i++; continue; }

    let setName = l.replace(/\s+Checklist$/i, '').trim();
    // "Base Set Checklist" is a wrapper around several sub-sets — skip the
    // wrapper card-count line and let the next iteration pick up Veterans etc.
    if (setName === 'Base Set') { i = probe + 1; continue; }

    const totalCards = parseInt(countMatch[1], 10);
    i = probe + 1;

    // Optional Parallels section
    const parallels = [];
    while (i < lines.length && lines[i] === '') i++;
    if (lines[i] === 'Parallels' || lines[i] === 'Parallel') {
      i++;
      while (i < lines.length) {
        const pl = lines[i];
        if (!pl) { i++; continue; }
        // Stop at card data
        if (/^\d+\s/.test(pl)) break;
        // Stop at a set header (next line is "N cards")
        let pn = i + 1;
        while (pn < lines.length && lines[pn] === '') pn++;
        if (lines[pn] && /^\d+\s+cards?/i.test(lines[pn])) break;
        // Stop at category transitions
        if (pl === 'Autographs' || pl === 'Memorabilia Cards' || pl === 'Inserts' || pl === 'Updates') break;
        if (/^\d{4} National Treasures$/i.test(pl)) break;
        parallels.push(parseParallelLine(pl));
        i++;
      }
    }

    // Card data
    const cards = [];
    while (i < lines.length) {
      const cl = lines[i];
      if (!cl) { i++; continue; }
      if (!/^\d+\s/.test(cl)) break;
      const card = parseCardLine(cl);
      if (card) cards.push(card);
      i++;
    }

    sets.push({
      id: slugify(setName),
      name: setName,
      category,
      totalCards: totalCards || cards.length,
      parallels: parallels.length > 0 ? parallels : [{ name: 'Base', printRun: null }],
      cards,
    });
  }

  return {
    id: '2024-panini-national-treasures-football',
    name: '2024 Panini National Treasures Football',
    year: 2024,
    brand: 'National Treasures',
    sport: 'Football',
    sets,
  };
}

function main() {
  const product = buildProduct(RAW);
  const setCount = product.sets.length;
  const cardCount = product.sets.reduce((s, x) => s + (x.cards || []).length, 0);
  console.log(`Built product: ${product.name}`);
  console.log(`  Sets: ${setCount}`);
  console.log(`  Cards: ${cardCount}`);
  console.log(`  Empty sets: ${product.sets.filter(s => s.cards.length === 0).length}`);

  fs.writeFileSync(FILE, JSON.stringify(product));
  console.log(`Wrote ${FILE}`);

  // Update index.json entry
  const index = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
  const i = index.products.findIndex(p => p.id === product.id);
  const entry = {
    id: product.id,
    name: product.name,
    year: product.year,
    brand: product.brand,
    sport: product.sport,
    setCount,
    totalCards: product.sets.reduce((s, x) => s + (x.totalCards || (x.cards || []).length), 0),
  };
  if (i >= 0) index.products[i] = entry;
  else index.products.push(entry);
  index.products.sort((a, b) => b.year - a.year || a.name.localeCompare(b.name));
  fs.writeFileSync(INDEX_PATH, JSON.stringify(index));
  console.log(`Index updated`);
}

main();
