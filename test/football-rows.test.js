// Football's boards read untagged rows as football (Oct 2026): a 1953 Topps
// Satchel Paige and "2026 Bowman Chrome" reached them. Those stay out now, and
// movers rest on medians of 5+ sales from 1990 on.
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
let failures = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`); if (!ok) failures++; };
const db = new DatabaseSync(':memory:');
db.exec('CREATE TABLE sales (sport TEXT, title TEXT, set_name TEXT, year TEXT)');
const rows = [
  [null, '1953 Topps Satchel Paige #220', 'Topps', '1953', false],
  [null, '2026 Bowman Chrome Prospect Auto', 'Bowman Chrome', '2026', false],
  [null, '2025 Topps Chrome Baseball Ohtani', 'Topps Chrome', '2025', false],
  ['baseball', '2024 Topps Judge', 'Topps', '2024', false],
  [null, '1955 Topps All-American Jim Thorpe', 'Topps', '1955', true],
  [null, '2024 Bowman University Chrome Arch Manning', 'Bowman University Chrome', '2024', true],
  [null, '1953 Bowman Football Frank Gifford', 'Bowman', '1953', true],
  [null, '2018 Prizm Josh Allen #205', 'Prizm', '2018', true],
  ['football', '2024 Prizm Bo Nix', 'Prizm', '2024', true],
];
const ins = db.prepare('INSERT INTO sales VALUES (?,?,?,?)');
rows.forEach(r => ins.run(r[0], r[1], r[2], r[3]));
const d1 = { prepare(sql) { return { first: async () => db.prepare(sql).get() || null }; } };
process.env.CF_WORKER = '1';
require(path.join(__dirname, '..', 'db.js')).getNflDb = () => null;
const S = require(path.join(__dirname, '..', 'server.js'));
const R = require(path.join(__dirname, '..', 'market-report.js'));
(async () => {
  await S._nflHasSportColumn(d1);
  const kept = db.prepare(`SELECT title FROM sales WHERE 1=1${S._footballSql()}`).all().map(r => r.title);
  const want = rows.filter(r => r[4]).map(r => r[1]);
  check('football keeps its own untagged rows and drops the baseball ones', JSON.stringify(kept) === JSON.stringify(want), JSON.stringify(kept));
  const aliased = db.prepare(`SELECT s.title FROM sales s WHERE 1=1${S._footballSql('s.sport')}`).all().length;
  check('  ...the same with a table alias', aliased === want.length);
  check('movers need 5 sales at each end and start at 1990', S.MOVERS_MIN_HALF === 5 && S.MOVERS_MIN_YEAR === 1990);
  const old = { risers: [{ name: '1984 Topps John Elway', changePct: -64 }], fallers: [], sales: 10, value: 100 };
  const html = R.renderReportBody(old, { week: '2026-W42', builtAt: '2026-10-15T12:00:00Z', site: 'https://x', archive: [] });
  check('a week filed on averages has its movers withdrawn, said so on the page',
    R.moversWithdrawn(old) && !/Elway/.test(html) && /withdrawn/.test(html) && !/Elway/.test(R.reportSummary(old)));
  check('  ...a median week shows them', !R.moversWithdrawn({ ...old, moversCalc: 'median' }));
  console.log(failures ? `\n${failures} check(s) failed` : '\nall football-rows checks passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
