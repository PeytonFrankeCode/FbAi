#!/usr/bin/env node
/**
 * Splits the monolithic public/data/checklists.json into:
 *   - public/data/checklists/index.json           (light product listing)
 *   - public/data/checklists/<productId>.json     (one file per product)
 *
 * Run when checklist data changes:
 *   node scripts/split-checklists.js
 *
 * The frontend fetches index.json upfront (small) and each product on
 * demand when the user opens it. First-checklist-load goes from ~12MB
 * to a few KB; subsequent product opens are 100–500KB each.
 */

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'public', 'data', 'checklists.json');
const OUT_DIR = path.join(__dirname, '..', 'public', 'data', 'checklists');

if (!fs.existsSync(SRC)) {
  console.error(`Source file missing: ${SRC}`);
  process.exit(1);
}

console.log(`Reading ${SRC}...`);
const data = JSON.parse(fs.readFileSync(SRC, 'utf-8'));
const products = data.products || [];
console.log(`Found ${products.length} products`);

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const index = { products: [] };
let totalBytes = 0;

for (const p of products) {
  const out = path.join(OUT_DIR, `${p.id}.json`);
  const json = JSON.stringify(p);
  fs.writeFileSync(out, json);
  totalBytes += json.length;

  index.products.push({
    id: p.id,
    name: p.name,
    year: p.year,
    brand: p.brand,
    sport: p.sport,
    setCount: (p.sets || []).length,
    totalCards: (p.sets || []).reduce((sum, s) => sum + (s.totalCards || 0), 0),
  });
}

const indexPath = path.join(OUT_DIR, 'index.json');
fs.writeFileSync(indexPath, JSON.stringify(index));

console.log(`Wrote ${products.length} product files + index.json to ${OUT_DIR}`);
console.log(`Total split size: ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);
console.log(`Index size: ${(fs.statSync(indexPath).size / 1024).toFixed(1)} KB`);
