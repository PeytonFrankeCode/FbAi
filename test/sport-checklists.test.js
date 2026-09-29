// Basketball and baseball checklists: their own folders, their own indexes.
//
// They are kept apart from football's public/data/checklists so the
// football-only builds (card index, landing pages, attribution, parallel
// spellings) never read another sport's cards. The browser finds a product's
// file from its id, which always ends in its sport, so an id and its folder
// must agree, and each index must be exactly the files beside it.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'public', 'data');

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

for (const sport of ['basketball', 'baseball']) {
  const dir = path.join(DATA, `checklists-${sport}`);
  if (!fs.existsSync(dir)) { check(`${sport}: folder exists`, false); continue; }
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && f !== 'index.json');
  const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8')).products || [];
  check(`${sport}: has checklists`, files.length > 0, `${files.length} products`);
  check(`${sport}: the index lists exactly the files`, index.length === files.length
    && index.every(p => files.includes(p.id + '.json')));

  const bad = [];
  let cards = 0;
  for (const f of files) {
    const doc = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const id = f.replace(/\.json$/, '');
    const Sport = sport[0].toUpperCase() + sport.slice(1);
    if (!id.endsWith(`-${sport}`)) bad.push(`${id}: id does not end in -${sport}`);
    if (doc.sport !== Sport) bad.push(`${id}: sport is ${doc.sport}`);
    if (!(doc.year >= 2018 && doc.year <= 2026)) bad.push(`${id}: year ${doc.year}`);
    if (!new RegExp(`^${doc.year}(-\\d\\d)? `).test(doc.name)) bad.push(`${id}: name "${doc.name}" does not start with its year`);
    // An announced product whose checklist is not out yet has no sets, by design.
    if (!Array.isArray(doc.sets) || (!doc.sets.length && !doc.unreleased)) bad.push(`${id}: no sets`);
    for (const s of doc.sets || []) {
      if (!s.cards || !s.cards.length) bad.push(`${id}/${s.id}: empty set`);
      for (const c of s.cards || []) {
        cards++;
        if (!c.number || !c.player) { bad.push(`${id}/${s.id}: a card with no number or name`); break; }
      }
    }
  }
  check(`${sport}: every product is named, dated and filed for its sport, with no empty sets`, bad.length === 0, bad.slice(0, 5).join('; '));
  check(`${sport}: cards on file`, cards > 0, cards.toLocaleString('en-US') + ' cards');
}

// Football's folder holds football only: the football builds read all of it.
const football = JSON.parse(fs.readFileSync(path.join(DATA, 'checklists', 'index.json'), 'utf8')).products;
check('the football index holds no basketball or baseball products', !football.some(p => /-(basketball|baseball)$/.test(p.id) || (p.sport && p.sport !== 'Football')));

// Every index agrees with its files (the script checks all three folders).
let ok = true, out = '';
try { out = execFileSync('node', [path.join(ROOT, 'scripts', 'rebuild-checklist-index.js'), '--check'], { encoding: 'utf8' }); }
catch (e) { ok = false; out = e.stdout || ''; }
check('each sport\'s index is built from its files', ok && /checklists-basketball:/.test(out) && /checklists-baseball:/.test(out), ok ? '' : out.slice(-300));

// The browser: a product's folder comes from its id; the list from the sport picked.
const js = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const start = js.indexOf('var CHECKLIST_DIRS');
const dirFor = new Function(`${js.slice(start, js.indexOf('async function fetchSportChecklists'))}; return _checklistDirFor;`)();
check('a product file is fetched from its sport\'s folder', dirFor('2023-24-panini-prizm-basketball') === '/data/checklists-basketball'
  && dirFor('2024-topps-chrome-baseball') === '/data/checklists-baseball' && dirFor('2024-panini-prizm-football') === '/data/checklists');
check('the checklist list loads the picked sport', /const data = await fetchSportChecklists\(sport\);/.test(js)
  && /if \(_checklistListSport !== sport\) return;/.test(js));
check('the football-only features keep reading football', /async function fetchChecklistsList\(\) \{\s*if \(_checklistsIndexCache\) return _checklistsIndexCache;\s*_checklistsIndexCache = await _fetchJson\('\/data\/checklists\/index\.json'/.test(js));

console.log(failures ? `\n${failures} check(s) failed` : '\nall sport-checklist checks passed');
process.exit(failures ? 1 : 0);
