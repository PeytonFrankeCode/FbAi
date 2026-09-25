// Parallel lists restored from their sources by scripts/audit-parallels.js
// (it reads every source, so it runs by hand, not here — ~45s). This pins the
// sets that sent us looking, and checks no junk rode in with the repair.
const fs = require('fs');
const path = require('path');
const DIR = path.join(__dirname, '..', 'public', 'data', 'checklists');

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};
const load = (id) => JSON.parse(fs.readFileSync(path.join(DIR, `${id}.json`), 'utf8'));
const par = (id, set) => ((load(id).sets || []).find(s => s.name === set) || {}).parallels || [];
const has = (list, name, run) => list.some(p => p.name === name && (run === undefined || p.printRun === run));

// 2024 Prizm Rookie Variations: the source lists six parallels under
// "Rookie Variations Prizms Silver Checklist"; the parse kept Base and Silver,
// so a Troy Franklin Gold /10 variation had nothing to match.
const rv = par('2024-panini-prizm-football', 'Rookie Variations Prizms');
check('2024 Prizm Rookie Variations lists its Gold /10 and Black Finite 1/1',
  has(rv, 'Gold Prizms', 10) && has(rv, 'Black Finite Prizms', 1) && has(rv, 'Mojo Prizms', 25),
  rv.map(p => p.name + (p.printRun ? '/' + p.printRun : '')).join(', '));
check('  ...and keeps what it had', has(rv, 'Base') && has(rv, 'Silver'));
check('2017 Prizm Rookie Autographs lists its Gold /10',
  has(par('2017-panini-prizm-football', 'Rookie Autographs'), 'Prizm Gold', 10));
check('2021 Prizm Rookie Autographs lists its Black Finite 1/1',
  has(par('2021-panini-prizm-football', 'Rookie Autographs'), 'Black Finite Prizms', 1));

// No junk anywhere: page furniture, notes, a set's sections or another set.
const JUNK = /(19|20)\d{2}|https?:|www\.|explore|buy on|checklist|:$|\(no |list below|print runs vary|[–—] \/?\d/i;
const SECTION = /^(rookies?|veterans?(\/.*)?|pro bowl|nfl debut|hall of fame|mvps?)$/i;
const bad = [];
for (const f of fs.readdirSync(DIR).filter(f => f.endsWith('.json') && f !== 'index.json')) {
  const doc = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
  for (const s of doc.sets || []) {
    for (const p of s.parallels || []) {
      if (JUNK.test(p.name) || SECTION.test(p.name) || p.name.length > 60) bad.push(`${f.replace('.json', '')} · ${s.name} · "${p.name}"`);
    }
  }
}
check('no parallel name is page furniture, a note or a section heading', bad.length === 0,
  bad.length ? `${bad.length}: ${bad.slice(0, 8).join('; ')}` : 'all clean');

console.log(failures ? `\n${failures} check(s) failed` : '\nall checklist-parallels checks passed');
process.exit(failures ? 1 : 0);
