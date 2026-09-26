// A sold search matches the words typed as WORDS in the title, not as
// fragments. "Bo Nix" returned Bowman, Bomb Squad, Skattebo and Cowboys cards
// (for "bo") and Penix and Phoenix cards (for "nix") — 10 of 43 results were
// other players'.
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const db = new DatabaseSync(':memory:');
db.exec(`CREATE TABLE sales (item_id TEXT, sold_date TEXT, title TEXT, price_cents INTEGER, currency TEXT,
  listing_format TEXT, grader TEXT, grade TEXT, player TEXT, parallel TEXT, year TEXT, set_name TEXT,
  card_number TEXT, confidence REAL, image_url TEXT)`);
const iso = (off) => new Date(Date.now() + off * 86400000).toISOString().slice(0, 10);
const ins = db.prepare('INSERT INTO sales (item_id, sold_date, title, price_cents, player, confidence) VALUES (?,?,?,?,?,0.9)');
const rows = [
  // Bo Nix, however it is written.
  ['n1', '2024 Panini Prizm Bo Nix #309 RC Silver', 'Bo Nix'],
  ['n2', '2024 DONRUSS OPTIC BO NIX RATED ROOKIE #226', 'Bo Nix'],
  ['n3', "Bo Nix's 2024 Select Rookie Card #52", 'Bo Nix'],
  ['n4', '2024 Mosaic Bo Nix-Broncos RC #301', 'Bo Nix'],
  // Not Bo Nix: the live search's false matches.
  ['x1', '2021 Bowman University Michael Penix Jr. #41 (RC) 1st Bowman PSA', 'Michael Penix Jr.'],
  ['x2', 'Panini 2025 Phoenix Phoenician Cam Skattebo RC #23 - New York Giants', 'Cam Skattebo'],
  ['x3', '2024 Panini Donruss Bomb Squad #1 Michael Penix Jr. RC PSA 10', 'Michael Penix Jr.'],
  ['x4', 'CEEDEE LAMB 2025 PANINI PHOENIX FOOTBALL LIGHT BLUE MOJO /85 #125 COWBOYS', 'CeeDee Lamb'],
  // A longer word must start a word: "Ward" is not "Edwards".
  ['w1', '2025 Prizm Cam Ward #301 Silver Prizms RC', 'Cam Ward'],
  ['w2', '2025 Prizm Cam Edwards #12 Silver', 'Cam Edwards'],
];
rows.forEach(([id, title, player], i) => ins.run(id, iso(-i - 1), title, 1000 + i, player));

const d1 = { prepare(sql) {
  let b = [];
  const api = { bind(...a) { b = a; return api; },
    all() { return { results: db.prepare(sql).all(...b), meta: { rows_read: 1 } }; },
    first() { return db.prepare(sql).get(...b) || null; }, run() { return { success: true }; } };
  return api;
} };
require(path.join(__dirname, '..', 'db.js')).getNflDb = () => d1;
process.env.CF_WORKER = '1';
process.env.SOLD_PROVIDER = 'nflcarddb';
const { app } = require(path.join(__dirname, '..', 'server.js'));
const PORT = 3247;
const server = app.listen(PORT);
const ids = async (q) => ((await (await fetch(`http://127.0.0.1:${PORT}/api/search?mode=sold&q=${encodeURIComponent(q)}`)).json()).results || [])
  .map(r => r.itemId).sort();

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

(async () => {
  const bo = await ids('Bo Nix');
  check('"Bo Nix" finds his cards however the title writes him', ['n1', 'n2', 'n3', 'n4'].every(x => bo.includes(x)), bo.join(', '));
  check('  ...and no Bowman, Bomb Squad, Skattebo, Cowboys, Penix or Phoenix card', !bo.some(x => x.startsWith('x')), bo.join(', '));
  const ward = await ids('Cam Ward');
  check('"Cam Ward" is not "Cam Edwards"', ward.includes('w1') && !ward.includes('w2'), ward.join(', '));
  const prizm = await ids('Cam Ward Prizm');
  check('a longer word still finds its plural ("Prizm" finds "Prizms")', prizm.includes('w1'), prizm.join(', '));
  server.close();
  console.log(failures ? `\n${failures} check(s) failed` : '\nall search-words checks passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); server.close(); process.exit(1); });
