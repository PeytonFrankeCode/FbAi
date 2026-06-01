#!/usr/bin/env node
// Reconcile public/data/checklists/index.json with the actual per-product
// JSONs after a repair pass.
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, 'public', 'data', 'checklists');
const INDEX = path.join(DIR, 'index.json');

const idx = JSON.parse(fs.readFileSync(INDEX, 'utf8'));
let touched = 0;
for (const p of idx.products) {
  const file = path.join(DIR, `${p.id}.json`);
  if (!fs.existsSync(file)) continue;
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  const setCount = (d.sets || []).length;
  const total = (d.sets || []).reduce((s, x) => s + ((x.cards && x.cards.length) || x.totalCards || 0), 0);
  if (p.setCount !== setCount || p.totalCards !== total) {
    p.setCount = setCount;
    p.totalCards = total;
    touched++;
  }
}
fs.writeFileSync(INDEX, JSON.stringify(idx));
console.log(`Touched ${touched} index entries.`);
