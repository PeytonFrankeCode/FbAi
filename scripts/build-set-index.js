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
 *   { builtAt, products: [[id, name, year]], sets: [[productIdx, setId, name, category, cards, "par1|par2"]],
 *     teams: { playerSlug: "Denver Broncos" } }
 *
 * teams: each player's NFL team on their most recent card, for questions by
 * team ("hottest Bills cards"). College teams are left out.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const DIR = path.join(__dirname, '..', 'public', 'data', 'checklists');
const OUT = path.join(__dirname, '..', 'public', 'data', 'set-index.json');

const NFL = ['Cardinals', 'Falcons', 'Ravens', 'Bills', 'Panthers', 'Bears', 'Bengals', 'Browns', 'Cowboys', 'Broncos',
  'Lions', 'Packers', 'Texans', 'Colts', 'Jaguars', 'Chiefs', 'Raiders', 'Chargers', 'Rams', 'Dolphins', 'Vikings',
  'Patriots', 'Saints', 'Giants', 'Jets', 'Eagles', 'Steelers', '49ers', 'Seahawks', 'Buccaneers', 'Titans', 'Commanders',
  'Redskins', 'Oilers', 'Football Team'];
const NFL_RE = new RegExp(`\\b(${NFL.join('|')})$`);
// The site's player slug (scripts/build-landing-pages.js slugify).
const slugify = (s) => String(s).toLowerCase().replace(/['’.]/g, '').replace(/&/g, ' and ')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-');
const teamOf = new Map();   // slug -> [year, team]
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
    const y = Number(doc.year) || 0;
    for (const c of s.cards) {
      const team = String((c && c.team) || '').trim();
      if (!c || !c.player || String(c.player).includes('/') || !NFL_RE.test(team)) continue;
      const slug = slugify(c.player), had = teamOf.get(slug);
      if (!had || y > had[0]) teamOf.set(slug, [y, team]);
    }
  }
}
const teams = {};
for (const [slug, [, team]] of teamOf) teams[slug] = team;
const out = JSON.stringify({ builtAt: new Date().toISOString(), products, sets, teams });
fs.writeFileSync(OUT, out);
console.log(`set index: ${products.length} products, ${sets.length} sets, ${Object.keys(teams).length} players' teams (${Math.round(out.length / 1024)} KB)`);
