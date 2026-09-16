// The sorting desk: human answers for the cases no rule reaches.
//
// THE ARITHMETIC THAT DECIDES THE UNIT OF WORK, which is the whole design.
//
// A month's sample holds 15,917 sales across 4,000 distinct titles — so a
// decision about one TITLE is worth about four sales, and there are ~200,000
// titles. That is not a system, it is a lifetime. A decision about one (year,
// set name) is worth every sale ever filed under that spelling, and those
// cluster hard: 3,385 sales matched no product at all, concentrated in a few
// dozen spellings.
//
// So the desk works on set spellings, and the endpoint reports the ratio
// (`salesPerDecision`) so the premise can be checked rather than believed. If
// that number is not large, the screen is not worth anyone's evening.
//
// What this asserts is the part that fails silently: an alias must be keyed the
// way the JOIN looks sales up. variants() strips the year, the sport suffix and
// a leading maker before matching, so an alias keyed the obvious way — "2025 |
// Panini Prizm" — would sit in KV forever and never be consulted, with nothing
// thrown to say so.
let DatabaseSync;
try { ({ DatabaseSync } = require('node:sqlite')); }
catch (err) {
  console.error('FAIL  node:sqlite unavailable on ' + process.version + ' — needs Node 22.5+.');
  process.exit(1);
}
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { buildIndex, matchSale, saleKeys } = require(path.join(ROOT, 'set-key.js'));

const db = new DatabaseSync(':memory:');
db.exec(`CREATE TABLE sales (item_id TEXT, sold_date TEXT, title TEXT, price_cents INTEGER,
  currency TEXT, listing_format TEXT, grader TEXT, grade TEXT, player TEXT, parallel TEXT,
  year TEXT, set_name TEXT, card_number TEXT, confidence REAL, best_offer INTEGER,
  bids INTEGER, image_url TEXT)`);
const iso = (o) => new Date(Date.now() + o * 86400000).toISOString().slice(0, 10);
const ins = db.prepare(`INSERT INTO sales (item_id,sold_date,title,price_cents,player,year,
  set_name,parallel,card_number,confidence) VALUES (?,?,?,?,?,?,?,?,?,?)`);
let n = 0;
const add = (setName, year, title, times) => {
  for (let i = 0; i < times; i++) {
    ins.run('i' + n++, iso(-3 - (i % 20)), title, 5000, 'Player ' + (i % 5),
            year, setName, '', String(i % 50), 0.9);
  }
};
// "Optic Preview" is a real spelling from live data (73 sales in one month) that
// the join cannot reach, while 2025 Donruss Optic IS in the catalogue — the
// exact shape an alias exists for.
// The sport suffix is on the set_name deliberately. variants() strips it before
// matching, so the join looks this up as "2025|optic preview" while the obvious
// hand-built key would be "2025|optic preview football" — an alias that is
// stored, looks correct, and is never once consulted. Without a spelling that
// variants() actually transforms, that bug cannot be caught: the first version
// of this fixture used a bare "Optic Preview", where both spellings agree, and
// breaking the key generation changed nothing.
add('Optic Preview Football', '2025', '2025 Donruss Optic Preview Jaxson Dart RC #301', 120);
// One the join already handles, to prove resolved work stays out of the queue.
add('Prizm', '2017', '2017 Panini Prizm Patrick Mahomes II #269', 60);

const d1 = { prepare(sql) { const st = db.prepare(sql); return {
  bind: (...a) => ({ all: async () => ({ results: st.all(...a) }), first: async () => st.get(...a) || null }),
  all: async () => ({ results: st.all() }), first: async () => st.get() || null }; } };

const store = new Map();
const dbMod = require(path.join(ROOT, 'db.js'));
dbMod.getNflDb = () => d1;
dbMod.archiveGet = async (k) => (store.has(k) ? store.get(k) : null);
dbMod.archivePut = async (k, v) => { store.set(k, v); };
process.env.CF_WORKER = '1';
process.env.ADMIN_PASSWORD = 'testkey';

const { app } = require(path.join(ROOT, 'server.js'));
const PORT = 3214;
const server = app.listen(PORT);
const URLB = `http://127.0.0.1:${PORT}/api/review/sets`;
const K = '?key=testkey';

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

(async () => {
  // ---- the queue is admin-only. It writes data. --------------------------
  check('the desk is closed without an admin key',
    (await fetch(URLB)).status === 403, 'an open write endpoint is not a feature');
  check('  ...and so is recording a decision',
    (await fetch(URLB, { method: 'POST', headers: { 'content-type': 'application/json' },
                         body: '{}' })).status === 403);

  const q1 = await (await fetch(URLB + K)).json();
  check('the queue lists spellings that match no product',
    q1.available === true && q1.openSpellings === 1,
    `${q1.openSpellings} open, ${q1.salesHeldUp} sales held up`);

  // The premise, reported rather than assumed.
  check('  ...and reports what one decision is worth',
    q1.salesPerDecision >= 100,
    `${q1.salesPerDecision} sales per decision — a title decision is worth about 4`);

  const top = (q1.queue || [])[0];
  check('  ...and a spelling the join already handles stays out',
    top && /optic preview/i.test(top.setName),
    top ? `top is "${top.setName}"` : 'empty queue');

  // The suggestions are what make it one keystroke rather than a search.
  check('  ...with the right product suggested first',
    top && (top.suggestions || [])[0] && top.suggestions[0].id === '2025-donruss-optic-football',
    top ? (top.suggestions || []).slice(0, 3).map(s => s.id).join(', ') : '');

  // ---- the key must be one the join will actually look up ----------------
  // The silent failure this whole endpoint could have had.
  {
    const keys = saleKeys(top.year, top.setName);
    check('the alias key is one the join itself would try',
      keys.includes(top.key),
      `key "${top.key}" vs join keys [${keys.join(', ')}]`);
  }

  // ---- a bad decision is refused, not stored -----------------------------
  const bad = await fetch(URLB + K, { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: top.key, productId: 'no-such-product' }) });
  check('an alias to a product that does not exist is refused',
    bad.status === 400,
    'a typo stored as an answer resolves nothing and looks like it worked');

  // ---- and a good one resolves the sales ---------------------------------
  const ok = await fetch(URLB + K, { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: top.key, productId: '2025-donruss-optic-football' }) });
  check('a decision is accepted', ok.status === 200);

  const q2 = await (await fetch(URLB + K)).json();
  check('  ...and the queue empties by the sales it was holding up',
    q2.openSpellings === 0 && q2.resolvedSales > q1.resolvedSales,
    `${q2.openSpellings} open, resolved ${q1.resolvedSales} -> ${q2.resolvedSales}`);

  // ---- the decision reaches the join, not just the store ------------------
  // Storing an answer nobody reads is the same as not answering.
  {
    const idx = require(path.join(ROOT, 'public', 'data', 'checklists', 'index.json'));
    const aliases = store.get('setaliases:v1') || {};
    const withOut = buildIndex(idx.products || []).index;
    const withIn = buildIndex(idx.products || [], undefined, aliases).index;
    check('the alias changes what the join matches',
      !matchSale(withOut, '2025', 'Optic Preview')
      && matchSale(withIn, '2025', 'Optic Preview')
      && matchSale(withIn, '2025', 'Optic Preview').id === '2025-donruss-optic-football',
      'unmatched before, 2025-donruss-optic-football after');
  }

  // Removing one is possible without a deploy.
  await fetch(URLB + K, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: top.key, productId: null }) });
  const q3 = await (await fetch(URLB + K)).json();
  check('  ...and a decision can be taken back',
    q3.openSpellings === 1, `${q3.openSpellings} open again`);

  server.close();
  console.log(failures ? `\n${failures} check(s) failed` : '\nall sort-desk checks passed');
  process.exit(failures ? 1 : 0);
})().catch(err => { console.error(err); server.close(); process.exit(1); });
