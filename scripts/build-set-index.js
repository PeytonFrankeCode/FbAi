#!/usr/bin/env node
/**
 * The set index (owner, Nov 2026: "What Denver Broncos have Color Blasts?").
 * Huddle AI could look up one product's checklist at a time, so a question
 * across every product, by insert or parallel and team, had no answer.
 *
 * public/data/set-index.json: every football set of every checklist, with its
 * category, card count and parallel names, compact enough for the Worker to
 * search whole. The cards themselves stay in each product's file; the search
 * opens only the products whose sets match.
 *
 *   { builtAt, products: [[id, name, year]], sets: [[productIdx, setId, name, category, cards, "par1|par2"]] }
 */
'use strict';
const fs = require('fs');
const path = require('path');
const DIR = path.join(__dirname, '..', 'public', 'data', 'checklists');
const OUT = path.join(__dirname, '..', 'public', 'data', 'set-index.json');

const products = [], sets = [];
for (const file of fs.readdirSync(DIR).sort()) {
  if (!file.endsWith('.json') || file === 'index.json') continue;
  let doc;
  try { doc = JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8')); } catch (_) { continue; }
  if (!doc || !Array.isArray(doc.sets) || (doc.sport && doc.sport !== 'Football')) continue;
  const pi = products.length;
  products.push([doc.id || file.replace(/\.json$/, ''), doc.name || '', Number(doc.year) || null]);
  for (const s of doc.sets) {
    const n = Array.isArray(s.cards) ? s.cards.length : 0;
    if (!n) continue;
    const par = [...new Set((s.parallels || []).map(p => String((p && p.name) || p || '').trim()).filter(Boolean))].join('|');
    sets.push([pi, s.id || '', s.name || '', s.category || '', n, par]);
  }
}
const out = JSON.stringify({ builtAt: new Date().toISOString(), products, sets });
fs.writeFileSync(OUT, out);
console.log(`set index: ${products.length} products, ${sets.length} sets (${Math.round(out.length / 1024)} KB)`);
