// The grading advisor prices only the card asked for (owner, Nov 2026): a
// base card's Raw and graded rows took the set's Laser and Red White & Blue
// sales too, on the Grading Advisor page and in Huddle AI's grading answers.
// Runs the real endpoint over an in-memory sales table.
'use strict';
let DatabaseSync;
try { ({ DatabaseSync } = require('node:sqlite')); } catch (_) { console.error('FAIL  node:sqlite unavailable'); process.exit(1); }
const path = require('path');
let failures = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`); if (!ok) failures++; };

const db = new DatabaseSync(':memory:');
db.exec(`CREATE TABLE sales (item_id TEXT, sold_date TEXT, title TEXT, price_cents INTEGER, currency TEXT, listing_format TEXT,
  grader TEXT, grade TEXT, player TEXT, parallel TEXT, year TEXT, set_name TEXT, card_number TEXT, confidence REAL,
  best_offer INTEGER, bids INTEGER, image_url TEXT)`);
const ins = db.prepare(`INSERT INTO sales (item_id, sold_date, title, price_cents, player, year, set_name, parallel, card_number, grader, grade, confidence)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
const day = (k) => new Date(Date.now() - k * 86400000).toISOString().slice(0, 10);
let n = 0;
for (let k = 0; k < 8; k++) {
  ins.run(`b${n++}`, day(k + 1), '2024 Panini Prizm Bo Nix #331 Rookie RC Broncos', 1000 + k * 20, 'Bo Nix', '2024', 'Panini Prizm', 'Base', '331', '', '', 0.9);
  ins.run(`l${n++}`, day(k + 1), '2024 Panini Prizm Bo Nix Laser Prizm #331 RC', 4000 + k * 50, 'Bo Nix', '2024', 'Panini Prizm', 'Laser', '331', '', '', 0.9);
  ins.run(`r${n++}`, day(k + 1), '2024 Panini Prizm Bo Nix Red White & Blue #331 RC', 3500 + k * 50, 'Bo Nix', '2024', 'Panini Prizm', 'Red White and Blue', '331', '', '', 0.9);
  ins.run(`p${n++}`, day(k + 1), '2024 Panini Prizm Bo Nix #331 RC PSA 10', 9000 + k * 100, 'Bo Nix', '2024', 'Panini Prizm', 'Base', '331', 'PSA', '10', 0.9);
  ins.run(`q${n++}`, day(k + 1), '2024 Panini Prizm Bo Nix Laser #331 RC PSA 10', 30000 + k * 100, 'Bo Nix', '2024', 'Panini Prizm', 'Laser', '331', 'PSA', '10', 0.9);
}
const d1 = {
  prepare(sql) {
    let bound = [];
    const api = {
      bind(...a) { bound = a; return api; },
      all() { return { results: db.prepare(sql).all(...bound) }; },
      run() { return { success: true, meta: db.prepare(sql).run(...bound) }; },
      first() { return db.prepare(sql).get(...bound) || null; },
    };
    return api;
  },
  batch(stmts) { return stmts.map(st => st.run()); },
};
const dbMod = require(path.join(__dirname, '..', 'db.js'));
dbMod.getNflDb = () => d1;
process.env.CF_WORKER = '1';
process.env.DISABLE_RATE_LIMIT = '1';
const { app } = require(path.join(__dirname, '..', 'server.js'));

(async () => {
  const server = app.listen(0);
  try {
    const r = await (await fetch(`http://127.0.0.1:${server.address().port}/api/grading-advisor?q=${encodeURIComponent('2024 Prizm Bo Nix')}`)).json();
    const raw = r.grades && r.grades.raw, p10 = r.grades && r.grades.psa10;
    const rawTitles = ((r.comps && r.comps.raw) || []).map(c => c.title);
    check('the base card\'s Raw row is priced from base sales only', raw && raw.median < 20 && rawTitles.length > 0
      && !rawTitles.some(t => /laser|red white/i.test(t)), JSON.stringify(raw) + ' ' + rawTitles.slice(0, 3).join(' | '));
    const p10Titles = ((r.comps && r.comps.psa10) || []).map(c => c.title);
    check('  ...and its PSA 10 row from base PSA 10s, not the Laser', p10 && p10.median < 150 && !p10Titles.some(t => /laser/i.test(t)), JSON.stringify(p10));
    const lz = await (await fetch(`http://127.0.0.1:${server.address().port}/api/grading-advisor?q=${encodeURIComponent('2024 Prizm Bo Nix Laser')}`)).json();
    check('a parallel asked for by name is priced from that parallel', lz.grades && lz.grades.raw && lz.grades.raw.median > 35
      && !((lz.comps && lz.comps.raw) || []).some(c => !/laser/i.test(c.title)), JSON.stringify(lz.grades && lz.grades.raw));
  } catch (e) { console.error(e); failures++; }
  server.close();
  console.log(failures ? `\n${failures} check(s) failed` : '\nall grading-same-card checks passed');
  process.exit(failures ? 1 : 0);
})();
