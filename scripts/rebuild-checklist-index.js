#!/usr/bin/env node
// Rebuild public/data/checklists/index.json from the product files on disk.
//
// The index is what the checklist browser loads first: app.js fetches
// index.json, renders the product list from it, and only then fetches the
// individual product file when one is opened. So the index is not a summary of
// the data — it is the only way into it. A product missing from the index is
// invisible no matter how complete its file is, and an index entry with no file
// behind it is a row that 404s when clicked.
//
// Both had happened by the time this was written. 2026 Bowman had a complete
// 2,148-card file and no index entry, so adding it to the site did not actually
// put it on the site. 2024 Donruss Optic Draft Picks had an index entry
// claiming 220 sets and 6,320 cards, with no file behind it in any commit in
// the repo's history.
//
// Neither was noticed because the index was maintained by hand, one entry per
// import script, which is exactly the kind of bookkeeping that drifts. Deriving
// it from the files removes the opportunity: the files are the data, and the
// index is now a function of them. checklist-index.test.js fails the build if
// the two ever disagree again.
//
// Run: node scripts/rebuild-checklist-index.js [--check]
//   --check  report drift and exit non-zero, write nothing
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'public', 'data', 'checklists');
const INDEX = path.join(DIR, 'index.json');

function buildIndex() {
  const products = [];
  for (const file of fs.readdirSync(DIR).sort()) {
    if (!file.endsWith('.json') || file === 'index.json') continue;
    const doc = JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8'));
    const sets = doc.sets || [];
    products.push({
      // The id is the filename, not doc.id. The browser builds the fetch URL
      // from it, so a file whose internal id disagrees with its name would
      // produce an index row pointing at nothing.
      id: file.replace(/\.json$/, ''),
      name: doc.name,
      year: doc.year,
      brand: doc.brand,
      sport: doc.sport,
      setCount: sets.length,
      // The set's declared totalCards, not cards.length. These are not the same
      // number: a checklist can declare 240 cards and list fewer, because the
      // published checklist is the authority on how big a set is and our
      // transcription of it may be incomplete. The index has always carried the
      // declared figure — 291 of 360 entries matched it, 6 matched the row
      // count — so counting rows here would silently restate 230 products as
      // smaller than they are, which reads as data loss rather than a fix.
      totalCards: sets.reduce((n, s) => n + (Number(s.totalCards) || (s.cards || []).length), 0),
    });
  }
  // Newest year first, alphabetical within a year — the order the existing
  // index was in, and the order the browser renders without re-sorting.
  products.sort((a, b) => (b.year - a.year) || a.id.localeCompare(b.id));
  return { products };
}

function main() {
  const built = buildIndex();
  const check = process.argv.includes('--check');

  let current = null;
  try { current = JSON.parse(fs.readFileSync(INDEX, 'utf8')); } catch { /* absent */ }

  const have = new Set((current && current.products || []).map(p => p.id));
  const want = new Set(built.products.map(p => p.id));
  const added = built.products.filter(p => !have.has(p.id)).map(p => p.id);
  const dropped = [...have].filter(id => !want.has(id));

  console.log(`${built.products.length} products, `
    + `${built.products.reduce((n, p) => n + p.totalCards, 0).toLocaleString('en-US')} cards`);
  for (const id of added) console.log(`  + ${id} — had a file but no index entry`);
  for (const id of dropped) console.log(`  - ${id} — had an index entry but no file`);

  // Fields drift quietly: an index entry can name a real file and still carry a
  // stale count, or a stale name after the product was renamed. Every field is
  // compared, not just the counts — reporting "already correct" after a rename
  // is how a rename gets believed and never checked.
  const FIELDS = ['name', 'year', 'brand', 'sport', 'setCount', 'totalCards'];
  const byId = new Map((current && current.products || []).map(p => [p.id, p]));
  const restated = [];
  for (const p of built.products) {
    const was = byId.get(p.id);
    if (!was) continue;
    const diffs = FIELDS.filter(f => was[f] !== p[f]);
    if (diffs.length) restated.push({ id: p.id, diffs, was, now: p });
  }
  for (const r of restated) {
    const detail = r.diffs.map(f => `${f}: ${JSON.stringify(r.was[f])} -> ${JSON.stringify(r.now[f])}`);
    console.log(`  ~ ${r.id} — ${detail.join(', ')}`);
  }

  const drifted = added.length + dropped.length + restated.length;
  if (check) {
    if (drifted) {
      console.log(`\nindex.json is out of date. Run: node scripts/rebuild-checklist-index.js`);
      process.exit(1);
    }
    console.log('index.json matches the files on disk');
    return;
  }

  fs.writeFileSync(INDEX, JSON.stringify(built, null, 2) + '\n');
  console.log(drifted ? `\nwrote index.json (${drifted} change(s))` : '\nindex.json was already correct');
}

main();
