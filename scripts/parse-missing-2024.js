#!/usr/bin/env node
/**
 * Parse the missing 2024 products from the source DOCX and write each to
 * public/data/checklists/<id>.json + add to index.json.
 *
 * Background: the original parse-2024-checklist.js used hardcoded line
 * ranges that skipped a large chunk of the source doc. This script
 * auto-detects product header positions for the products that aren't yet
 * in our data and parses only those — leaving the existing 22 products
 * untouched in case they had manual corrections.
 */
const mammoth = require('mammoth');
const fs = require('fs');
const path = require('path');
const { parseProduct, consolidateSets } = require('../parse-2024-checklist.js');

// Escape a string for use inside a RegExp
function escapeReg(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

const DOCX_PATH = path.join(__dirname, '..', 'Peyton Code - Panini+Topps - Checklist 2024.docx');
const OUT_DIR = path.join(__dirname, '..', 'public', 'data', 'checklists');
const INDEX_PATH = path.join(OUT_DIR, 'index.json');

// Short brand label for each product (shown in some UI bits). Covers all
// 42 detected 2024 products so this script can re-parse the whole 2024
// catalog with the fixed parser, not just newly-missing ones.
const BRAND_BY_PRODUCT = new Map([
  // Donruss family
  ['2024 Donruss Football', 'Donruss'],
  ['2024 Donruss Optic Football', 'Donruss Optic'],
  ['2024 Donruss Optic Draft Picks Football', 'Donruss Optic Draft Picks'],
  ['2024 Donruss Elite Football', 'Donruss Elite'],
  ['2024 Clearly Donruss Football', 'Clearly Donruss'],
  ['2024 Score Football', 'Score'],
  // Panini mid-tier
  ['2024 Panini Prizm Football', 'Prizm'],
  ['2024 Panini Prizm Deca Football', 'Prizm Deca'],
  ['2024 Panini Prizm Draft Picks Football', 'Prizm Draft Picks'],
  ['2024 Panini Mosaic Football', 'Mosaic'],
  ['2024 Panini Phoenix Football', 'Phoenix'],
  ['2024 Panini Prestige Football', 'Prestige'],
  ['2024 Panini Contenders Football', 'Contenders'],
  ['2024 Panini Contenders Optic Football', 'Contenders Optic'],
  ['2024 Panini Certified Football', 'Certified'],
  ['2024 Panini Totally Certified Football', 'Totally Certified'],
  ['2024 Panini Absolute Football', 'Absolute'],
  ['2024 Panini Illusions Football', 'Illusions'],
  ['2024 Panini Rookies & Stars Football', 'Rookies & Stars'],
  ['2024 Panini Luminance Football', 'Luminance'],
  ['2024 Panini Zenith Football', 'Zenith'],
  ['2024 Panini Encore Football', 'Encore'],
  ['2024 Panini Obsidian Football', 'Obsidian'],
  ['2024 Panini Origins Football', 'Origins'],
  ['2024 Panini Photogenic Football', 'Photogenic'],
  ['2024 Panini Select Football', 'Select'],
  ['2024 Panini Spectra Football', 'Spectra'],
  ['2024 Panini Black Football', 'Black'],
  // Panini high-end
  ['2024 Panini Gold Standard Football', 'Gold Standard'],
  ['2024 Panini Immaculate Football', 'Immaculate'],
  ['2024 Panini Impeccable Football', 'Impeccable'],
  ['2024 Panini National Treasures Football', 'National Treasures'],
  ['2024 Panini One Football', 'Panini One'],
  ['2024 Panini Eminence Football', 'Eminence'],
  ['2024 Panini Flawless Football', 'Flawless'],
  ['2024 Panini National Treasures Collegiate Football', 'National Treasures Collegiate'],
  // Topps
  ['2024 Topps Midnight Football', 'Topps Midnight'],
  ['2024 Topps Finest Football', 'Topps Finest'],
  ['2024 Topps Chrome Football', 'Topps Chrome'],
  ['2024 Topps Cosmic Chrome Football', 'Topps Cosmic Chrome'],
  ['2024 Topps Resurgence Football', 'Topps Resurgence'],
  ['2024 Topps Signature Class Football', 'Topps Signature Class'],
]);

// Totally Certified uses dash separators between number and player name
const DASH_SEP_PRODUCTS = new Set(['2024 Panini Totally Certified Football']);

async function main() {
  const result = await mammoth.extractRawText({ path: DOCX_PATH });
  const allLines = result.value.split('\n');

  // Auto-detect every 2024 product header line. The regex matches the
  // checklist header phrasing even when mammoth concatenates it with the
  // following card data on a single line.
  const seen = new Set();
  const detected = [];
  allLines.forEach((line, idx) => {
    // The middle quantifier is *? (zero-or-more, lazy) so brands like
    // "Score" that go directly to "Football" with no middle word still match.
    const matches = [...line.matchAll(/(2024\s+(?:Topps|Panini|Donruss|Score|Clearly)(?:\s+[A-Za-z &'+]+?)?\s+Football)\s+Checklist/gi)];
    for (const m of matches) {
      const name = m[1].trim().replace(/\s+/g, ' ');
      if (!seen.has(name)) {
        seen.add(name);
        detected.push({ line: idx, name });
      }
    }
  });

  detected.sort((a, b) => a.line - b.line);

  // Only parse products we want to add — don't touch the 22 already imported
  const targets = detected.filter(p => BRAND_BY_PRODUCT.has(p.name));
  console.log(`Detected ${detected.length} 2024 products in source; targeting ${targets.length} missing.`);

  const products = [];
  for (const target of targets) {
    const next = detected.find(d => d.line > target.line);
    const endLine = next ? next.line : allLines.length;
    // Build the line slice. Include the next product's start line BUT
    // trimmed at the point where this product's content ends and the next
    // product's header begins — mammoth glues them onto the same line.
    const slice = allLines.slice(target.line, endLine + (next ? 1 : 0));
    if (next) {
      const last = slice[slice.length - 1] || '';
      const headerStart = last.search(new RegExp(`${escapeReg(next.name)}\\s+Checklist`, 'i'));
      slice[slice.length - 1] = headerStart >= 0 ? last.slice(0, headerStart) : '';
    }
    const header = {
      name: target.name,
      brand: BRAND_BY_PRODUCT.get(target.name),
      dashSep: DASH_SEP_PRODUCTS.has(target.name),
    };
    console.log(`\nParsing ${target.name} (lines ${target.line}-${endLine}, ${slice.length} lines)`);
    const product = parseProduct(slice, header);
    if (!product || !product.sets || product.sets.length === 0) {
      console.log('  -> no sets found, skipping');
      continue;
    }
    const before = product.sets.length;
    product.sets = consolidateSets(product.sets);
    const cards = product.sets.reduce((s, x) => s + (x.cards || []).length, 0);
    console.log(`  -> ${before} -> ${product.sets.length} sets after consolidate, ${cards} cards`);
    products.push(product);
  }

  if (products.length === 0) {
    console.log('\nNo products parsed. Exiting without changes.');
    return;
  }

  for (const p of products) {
    const file = path.join(OUT_DIR, `${p.id}.json`);
    fs.writeFileSync(file, JSON.stringify(p));
    console.log(`Wrote ${file}`);
  }

  const index = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
  const existingIds = new Set(index.products.map(p => p.id));
  for (const p of products) {
    if (existingIds.has(p.id)) {
      console.log(`Already in index: ${p.id} — replacing entry`);
      const i = index.products.findIndex(x => x.id === p.id);
      index.products.splice(i, 1);
    }
    index.products.push({
      id: p.id,
      name: p.name,
      year: p.year,
      brand: p.brand,
      sport: p.sport,
      setCount: (p.sets || []).length,
      totalCards: (p.sets || []).reduce((s, x) => s + (x.totalCards || (x.cards || []).length), 0),
    });
  }
  index.products.sort((a, b) => b.year - a.year || a.name.localeCompare(b.name));
  fs.writeFileSync(INDEX_PATH, JSON.stringify(index));
  console.log(`\nIndex updated: ${index.products.length} total products`);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
