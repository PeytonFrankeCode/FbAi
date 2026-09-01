// The checklist index is the only way into the checklist data.
//
// app.js fetches /data/checklists/index.json, renders the product list from it,
// and fetches /data/checklists/<id>.json only when a product is opened. So a
// product that is not in the index does not exist as far as the site is
// concerned, however complete its file is, and an index entry with no file
// behind it is a row that 404s when clicked.
//
// Both had already happened when this test was written: 2026 Bowman had a
// 2,138-card file and no index entry, and 2024 Donruss Optic Draft Picks had an
// entry claiming 220 sets with no file behind it in any commit in the repo's
// history. Neither is visible from reading either file alone, which is why this
// is a test rather than a convention.
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'public', 'data', 'checklists');
let failures = 0;

function check(name, ok, detail) {
  if (ok) { console.log(`PASS    ${name}`); return; }
  failures++;
  console.log(`FAIL    ${name}`);
  if (detail) console.log(`        ${detail}`);
}

const index = JSON.parse(fs.readFileSync(path.join(DIR, 'index.json'), 'utf8'));
const entries = index.products || [];
const files = fs.readdirSync(DIR)
  .filter(f => f.endsWith('.json') && f !== 'index.json')
  .map(f => f.replace(/\.json$/, ''));

const indexed = new Set(entries.map(p => p.id));
const onDisk = new Set(files);

const unlisted = files.filter(id => !indexed.has(id));
check('every checklist file has an index entry', unlisted.length === 0,
  unlisted.length ? `invisible on the site: ${unlisted.join(', ')}` : '');

const dangling = entries.filter(p => !onDisk.has(p.id)).map(p => p.id);
check('every index entry has a checklist file', dangling.length === 0,
  dangling.length ? `would 404 when opened: ${dangling.join(', ')}` : '');

// Counts are what the product list renders before anything is opened, so a
// stale one is wrong on screen. totalCards is the sum of each set's declared
// totalCards, not the number of rows in cards[] — a published checklist is the
// authority on how big a set is, and a transcription of it may be incomplete.
const wrong = [];
for (const p of entries) {
  if (!onDisk.has(p.id)) continue;
  const doc = JSON.parse(fs.readFileSync(path.join(DIR, `${p.id}.json`), 'utf8'));
  const sets = doc.sets || [];
  const setCount = sets.length;
  const totalCards = sets.reduce((n, s) => n + (Number(s.totalCards) || (s.cards || []).length), 0);
  if (p.setCount !== setCount || p.totalCards !== totalCards) {
    wrong.push(`${p.id}: index says ${p.setCount}/${p.totalCards}, file has ${setCount}/${totalCards}`);
  }
}
check('index counts match the files', wrong.length === 0,
  wrong.length ? `${wrong.length} stale:\n        ${wrong.slice(0, 5).join('\n        ')}` : '');

// A file whose internal id disagrees with its name would be fetched by name and
// then read under a different id, which is the kind of mismatch that produces an
// empty page rather than an error.
const misnamed = files.filter(id => {
  const doc = JSON.parse(fs.readFileSync(path.join(DIR, `${id}.json`), 'utf8'));
  return doc.id && doc.id !== id;
});
check('each file\'s internal id matches its filename', misnamed.length === 0,
  misnamed.length ? misnamed.join(', ') : '');

// The browser filters sets with `s.category !== checklistFilter` against tabs
// hardcoded to these four values in index.html, and picks its AUTO/MEMO/INSERT
// badges the same way. A set with any other category — including one of these
// words capitalised — loads fine and then cannot be found under any tab, which
// is what happened to all 46 sets of 2026 Bowman.
const CATEGORIES = new Set(['base', 'autograph', 'memorabilia', 'insert']);
const badCategory = [];
for (const id of files) {
  const doc = JSON.parse(fs.readFileSync(path.join(DIR, `${id}.json`), 'utf8'));
  for (const s of doc.sets || []) {
    if (!CATEGORIES.has(s.category)) badCategory.push(`${id} :: ${s.name} :: ${JSON.stringify(s.category)}`);
  }
}
check('every set has a category the filter tabs recognise', badCategory.length === 0,
  badCategory.length
    ? `${badCategory.length} unreachable:\n        ${badCategory.slice(0, 5).join('\n        ')}`
    : '');

console.log('');
if (failures) {
  console.log(`${failures} check(s) failed. Run: node scripts/rebuild-checklist-index.js`);
  process.exit(1);
}
console.log(`checklist index is consistent — ${entries.length} products`);
