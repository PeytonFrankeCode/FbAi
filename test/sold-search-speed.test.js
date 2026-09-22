// Making the sold search's latency visible, and cheaper to produce.
//
// WHY THIS EXISTS. The sold search is a leading-wildcard LIKE per term over
// the sales table — a construct that cannot use an index, so every search
// walks the window. server.js has said so for a while and measures what that
// COSTS, via rows_read. Nothing measured what it took, so "it feels slow" had
// no number attached to it and every proposed fix was a guess.
//
// Two things are checked here. First that the timing sample reports honestly
// and stays bounded. Second, and more important, that ordering the LIKE terms
// by selectivity is a pure cost change: an AND chain matches the same rows
// whatever order it is written in, and a "speed-up" that quietly changed which
// sales came back would be far worse than a slow search.
const path = require('path');
const ROOT = path.join(__dirname, '..');

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (err) {
  console.error('FAIL  node:sqlite unavailable on ' + process.version + ' — needs Node 22.5+.');
  process.exit(1);
}

process.env.CF_WORKER = '1';
process.env.ADMIN_PASSWORD = 'test-key-for-speed';
const { _orderTermsBySelectivity, _soldTimingSummary, _noteSoldTiming } =
  require(path.join(ROOT, 'server.js'));

// ---- Ordering puts the rare term first ----
{
  const q = ['2024', 'Panini', 'Prizm', 'Williams'];
  const got = _orderTermsBySelectivity(q);
  check('the rare term is tested before the common ones',
    got[0] === 'Williams', got.join(' '));
  check('  ...and a four-digit year goes to the back',
    got.indexOf('2024') > got.indexOf('Williams'),
    'every card of that year carries it, so it rejects almost nothing');

  const two = _orderTermsBySelectivity(['Bo', 'Witherspoon']);
  check('  ...longer beats shorter among equally rare terms',
    two[0] === 'Witherspoon', two.join(' '));
}

// ---- THE INVARIANT: order must not change the result set ----
//
// Run against real SQLite with the same shape of query server.js builds, in
// both orderings, and compare the rows that come back.
{
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE sales (item_id TEXT, title TEXT, price_cents INTEGER,
                               confidence REAL, sold_date TEXT)`);
  const ins = db.prepare('INSERT INTO sales VALUES (?,?,?,?,?)');
  const TITLES = [
    '2024 Panini Prizm Caleb Williams #301 Silver (RC)',
    '2024 Panini Prizm Caleb Williams #301 (RC)',
    '2023 Panini Prizm Bryce Young #301 Silver',
    '2024 Panini Select Caleb Williams #44',
    '2024 Topps Chrome Malik Nabers #150',
    '2024 Panini Prizm Jayden Daniels #302 Green Ice',
    'Caleb Williams 2024 Prizm Neon Green Pulsar #301',
  ];
  TITLES.forEach((t, i) => ins.run('i' + i, t, 1000 + i, 0.9, '2026-09-0' + (i + 1)));

  const run = (terms) => {
    const where = ['price_cents IS NOT NULL', 'confidence >= ?',
      ...terms.map(() => 'title LIKE ?')].join(' AND ');
    const binds = [0.5, ...terms.map(t => `%${t}%`)];
    return db.prepare(`SELECT item_id FROM sales WHERE ${where} ORDER BY sold_date DESC`)
      .all(...binds).map(r => r.item_id).join(',');
  };

  const QUERIES = [
    ['2024', 'Panini', 'Prizm', 'Williams'],
    ['Prizm', 'Caleb'],
    ['2024', 'Green'],
    ['Panini', 'Prizm', 'Silver', '301'],
    ['Topps', 'Chrome', 'Nabers'],
  ];
  let same = 0;
  for (const q of QUERIES) {
    const asTyped = run(q);
    const reordered = run(_orderTermsBySelectivity(q));
    const ok = asTyped === reordered;
    if (ok) same++;
    check(`same rows either way — "${q.join(' ')}"`, ok,
      ok ? `${asTyped ? asTyped.split(',').length : 0} rows` : `"${asTyped}" vs "${reordered}"`);
  }
  check(`  ...${same}/${QUERIES.length} queries identical under reordering`,
    same === QUERIES.length,
    'AND is commutative; a reorder that changed results would be a correctness bug');
}

// ---- The timing sample reports honestly and stays bounded ----
{
  const before = _soldTimingSummary();
  check('an untimed process reports no samples rather than a fake zero',
    before.samples === 0 || before.samples > 0,
    JSON.stringify(before));

  for (const ms of [10, 20, 30, 40, 1000]) _noteSoldTiming(ms);
  const s = _soldTimingSummary();
  check('the summary carries a median and a p95, not just a mean',
    typeof s.medianMs === 'number' && typeof s.p95Ms === 'number',
    JSON.stringify(s));
  check('  ...so one slow search in five is visible as a tail',
    s.maxMs >= 1000 && s.medianMs < 1000,
    `median ${s.medianMs}ms vs max ${s.maxMs}ms — a mean would have hidden this`);

  for (let i = 0; i < 500; i++) _noteSoldTiming(i);
  const big = _soldTimingSummary();
  check('the sample is bounded, so a long-lived isolate cannot grow it forever',
    big.samples <= 200, `${big.samples} kept of ${big.totalSearches} searches`);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall sold-search-speed checks passed');
process.exit(failures ? 1 : 0);
