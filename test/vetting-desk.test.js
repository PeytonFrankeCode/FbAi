// The vetting desk on /admin: the queue the re-sort builds, and the answers a
// person gives it.
//
// WHAT THESE GUARD. The plan's two promises: a sale row is never edited (an
// answer lives in sale_corrections and can be undone), and the queue shrinks
// as answers are given. Plus the admin gate, and that the stored suggestion is
// the reader's own rather than whatever the request claimed.
let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (err) {
  console.error('FAIL  node:sqlite unavailable on ' + process.version + ' — this test needs Node 22.5+.');
  process.exit(1);
}
const path = require('path');
const ROOT = path.join(__dirname, '..');

const db = new DatabaseSync(':memory:');
db.exec(`CREATE TABLE sales (item_id TEXT PRIMARY KEY, sold_date TEXT, title TEXT, price_cents INTEGER,
  player TEXT, year INTEGER, brand TEXT, set_name TEXT, parallel TEXT, card_number TEXT, grader TEXT,
  grade REAL, is_rookie INTEGER DEFAULT 0, is_auto INTEGER DEFAULT 0, is_relic INTEGER DEFAULT 0,
  print_run INTEGER, card_key TEXT, card_name TEXT, sport TEXT, image_url TEXT)`);
const ins = db.prepare(`INSERT INTO sales (item_id, sold_date, title, price_cents, player, year, set_name,
  parallel, card_number, grader, grade, is_auto, card_key, image_url) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
const DAY = '2026-10-01';
// Real titles from the audit, each mis-filed in the way the row says.
ins.run('AUTO', DAY, '2017 Donruss Optic Patrick Mahomes II Rated Rookie Auto 21/25', 1400000,
        'Patrick Mahomes', 2017, 'Donruss Optic', null, '177', null, null, 0, '2017-donruss-optic-n177', 'https://img/a.jpg');
ins.run('AUTH', DAY, '2000 Playoff Contenders Rookie Ticket #144 Tom Brady RC Auto PSA Authentic', 1901200,
        'Tom Brady', 2000, 'Contenders', null, '144', 'PSA', 10, 1, '2000-contenders-n144-auto', null);
ins.run('LOT', DAY, '2015 Donruss Optic #1 TOM BRADY Lot (5 Cards) Mint', 2900,
        'Tom Brady', 2015, 'Donruss Optic', null, '1', null, null, 0, '2015-donruss-optic-n1', null);
ins.run('FINE', DAY, '2025 Panini Prizm - Rookies Jaxson Dart #332 Silver Prizm (RC)', 5000,
        'Jaxson Dart', 2025, 'Prizm', 'Silver Prizm', '332', null, null, 0, '2025-prizm-n332-silver-prizm', null);
// One the reader cannot settle alone: an official reprint insert and a fake
// read the same, so it waits for a person.
ins.run('REPRINT', DAY, '1996 Topps Namath Reprint Joe Namath New York Jets #122 PSA 9 Rc', 4600,
        'Joe Namath', 1996, 'Topps', null, '122', 'PSA', 9, 0, '1996-topps-n122', null);
// Under the default $20 floor: not scanned at all.
ins.run('CHEAP', DAY, '2024 Prizm Caleb Williams Auto', 500,
        'Caleb Williams', 2024, 'Prizm', null, '1', null, null, 0, '2024-prizm-n1', null);

const d1 = {
  prepare(sql) {
    const st = db.prepare(sql);
    const bound = (a) => ({ all: async () => ({ results: st.all(...a) }),
                            first: async () => st.get(...a) || null,
                            run: async () => st.run(...a) });
    return { bind: (...a) => bound(a), ...bound([]) };
  },
};
const KV = new Map();
const CACHE = new Map();
const dbMod = require(path.join(ROOT, 'db.js'));
dbMod.getNflDb = () => d1;
dbMod.archiveGet = async (k) => (KV.has(k) ? KV.get(k) : null);
dbMod.archivePut = async (k, v) => { KV.set(k, v); };
dbMod.cacheGet = async (k) => (CACHE.has(k) ? CACHE.get(k) : null);
dbMod.cachePut = (k, v) => { CACHE.set(k, v); };
process.env.CF_WORKER = '1';
process.env.ADMIN_PASSWORD = 'test-key-for-the-vetting-desk';

const srv = require(path.join(ROOT, 'server.js'));
const server = srv.app.listen(3231);

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};
const BASE = 'http://127.0.0.1:3231/api/admin/vetting';
const K = encodeURIComponent(process.env.ADMIN_PASSWORD);
const queue = async (q = '') => (await fetch(`${BASE}?key=${K}${q}`)).json();
const answer = async (body, key = K) => {
  const r = await fetch(`${BASE}?key=${key}`, { method: 'POST', headers: { 'content-type': 'application/json' },
                                                body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

(async () => {
  try {
    check('the queue is admin-only', (await fetch(BASE)).status === 403);
    check('...and so are answers', (await answer({ itemId: 'AUTO', action: 'move' }, 'wrong')).status === 403);

    const mine = await queue();
    check('by default only the sales that need a person are shown',
          mine.queue.map(x => x.itemId).join(',') === 'REPRINT', mine.queue.map(x => x.itemId).join(','));
    check('...while the sure ones are still counted',
          mine.counts.filter(c => c.confidence === 'high').reduce((a, c) => a + c.open, 0) === 3);
    const q = await queue('&confidence=all');
    const ids = q.queue.map(x => x.itemId);
    check('the queue reads the newest day', q.available && q.window.through === DAY, JSON.stringify(q.window));
    check('mis-filed sales are queued, dearest first', ids.join(',') === 'AUTH,AUTO,REPRINT,LOT', ids.join(','));
    check('a sale filed right is not queued', !ids.includes('FINE'));
    check('a sale under the price floor is not scanned', !ids.includes('CHEAP'));
    const auto = q.queue.find(x => x.itemId === 'AUTO');
    check('each item says where it belongs and why', auto && auto.dest === 'auto' && /autograph/.test(auto.reason),
          auto && `${auto.dest}: ${auto.reason}`);
    check('the photo comes along', auto && auto.imageUrl === 'https://img/a.jpg');
    check('a category filter narrows the queue',
          (await queue('&confidence=all&dest=category:lot')).queue.map(x => x.itemId).join(',') === 'LOT');

    const before = db.prepare("SELECT * FROM sales WHERE item_id = 'AUTO'").get();
    const m = await answer({ itemId: 'AUTO', action: 'move', note: 'on-card auto' });
    check('an answer is accepted', m.status === 200 && m.body.status === 'moved' && m.body.dest === 'auto', JSON.stringify(m.body));
    const c = db.prepare("SELECT * FROM sale_corrections WHERE item_id = 'AUTO'").get();
    check('it is stored in sale_corrections', c && c.dest === 'auto' && c.suggested === 'auto' && c.note === 'on-card auto');
    const after = db.prepare("SELECT * FROM sales WHERE item_id = 'AUTO'").get();
    check('the sale row itself is untouched', JSON.stringify(before) === JSON.stringify(after));

    const k = await answer({ itemId: 'AUTH', action: 'keep' });
    check('"keep as filed" is an answer too', k.body.status === 'kept' &&
          db.prepare("SELECT suggested FROM sale_corrections WHERE item_id = 'AUTH'").get().suggested === 'authentic');

    const q2 = await queue('&confidence=all');
    check('answered sales leave the queue', q2.queue.map(x => x.itemId).join(',') === 'REPRINT,LOT', q2.queue.map(x => x.itemId).join(','));
    check('...and are counted', q2.decided.moved === 1 && q2.decided.kept === 1, JSON.stringify(q2.decided));

    const l = await answer({ itemId: 'FINE', action: 'category', category: 'reprint' });
    check('any sale can be marked "not one card"', l.body.dest === 'category:reprint');
    check('"move" refuses a sale the reader would keep',
          (await answer({ itemId: 'FINE', action: 'move' })).status === 409);
    check('an unknown category is refused',
          (await answer({ itemId: 'LOT', action: 'category', category: 'junk' })).status === 400);
    check('an unknown sale is refused', (await answer({ itemId: 'NOPE', action: 'keep' })).status === 404);

    await answer({ itemId: 'AUTO', action: 'undo' });
    check('undo forgets the answer and the sale comes back',
          !db.prepare("SELECT 1 FROM sale_corrections WHERE item_id = 'AUTO'").get()
          && (await queue('&confidence=all')).queue.some(x => x.itemId === 'AUTO'));
  } catch (err) {
    console.error(err); failures++;
  } finally {
    server.close();
    if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
    console.log('\nall vetting-desk checks passed');
    process.exit(0);
  }
})();
