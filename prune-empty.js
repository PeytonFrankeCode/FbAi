#!/usr/bin/env node
// Remove product files where every set is empty (no useful data) and
// drop their entries from index.json.
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, 'public', 'data', 'checklists');
const INDEX = path.join(DIR, 'index.json');

const idx = JSON.parse(fs.readFileSync(INDEX, 'utf8'));
const before = idx.products.length;
const removed = [];

idx.products = idx.products.filter(p => {
  const file = path.join(DIR, `${p.id}.json`);
  if (!fs.existsSync(file)) return false;
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  const totalCards = (d.sets || []).reduce((s, x) => s + ((x.cards || []).length), 0);
  if (totalCards === 0) {
    removed.push(p.id);
    fs.unlinkSync(file);
    return false;
  }
  return true;
});

fs.writeFileSync(INDEX, JSON.stringify(idx));
console.log(`Removed ${removed.length} empty products (${before} -> ${idx.products.length} total).`);
for (const id of removed) console.log(`  - ${id}`);
