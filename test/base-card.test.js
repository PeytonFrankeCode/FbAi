// Which sales the market index accepts as a BASE card.
//
// The index tracks base cards only — the base rookie, the Rated Rookie — keyed
// by card number. It used to be built from parallels, and the live basket read
// Refractor, Refractor, XFractor, Cosmic, Blue Hyper, with moves of -93.7% and
// +1500%: a parallel is the hardest thing in a listing title to read, and
// "Jaxson Dart Refractor" pooled every Refractor he has in the product.
//
// The rule has to do two opposite things, and both are checked here against
// the exact SQL the index runs:
//   keep  base cards whose parallel column is blank (the norm), even when the
//         title contains a colour inside a NAME — Jerry Rice, A.J. Green,
//         Green Bay, the Mosaic and Prizm products;
//   drop  anything the title shows is not the base card — a parallel, a print
//         run, an autograph or relic — and anything without a card number.
let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (err) {
  console.error('FAIL  node:sqlite unavailable on ' + process.version + ' — needs Node 22.5+.');
  process.exit(1);
}
const path = require('path');
process.env.CF_WORKER = '1';
const { _rsiBaseSql } = require(path.join(__dirname, '..', 'server.js'));
const { RSI_BASE_CARD, RSI_BASE_SERIAL, RSI_BASE_TITLE_WORDS, RSI_BASE_TITLE_TEST, kind } = _rsiBaseSql();

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

// [title, player, set, card number, parallel column]
const KEEP = [
  ['2024 Panini Prizm Caleb Williams #301 RC Bears', 'Caleb Williams', 'Prizm', '301', ''],
  ['2024 Prizm Caleb Williams RC #301 Base', 'Caleb Williams', 'Prizm', '301', 'Base'],
  ['2024 Donruss Rated Rookie Caleb Williams #351', 'Caleb Williams', 'Donruss', '351', 'Rated Rookie'],
  ['1986 Topps Jerry Rice #161 RC 49ers', 'Jerry Rice', 'Topps', '161', ''],
  ['2024 Mosaic Caleb Williams #301 Rookie', 'Caleb Williams', 'Mosaic', '301', ''],
  ['2020 Prizm Jordan Love RC #325 Green Bay Packers', 'Jordan Love', 'Prizm', '325', ''],
  ['2019 Topps Chrome A.J. Green #50', 'A.J. Green', 'Topps Chrome', '50', ''],
  ['1989 Score Barry Sanders #257 Rookie', 'Barry Sanders', 'Score', '257', ''],
  ['1986 Topps Reggie White #275 RC', 'Reggie White', 'Topps', '275', ''],
];
const DROP = [
  ['2025 Topps Chrome Jaxson Dart #306 Refractor', 'Jaxson Dart', 'Topps Chrome', '306', ''],
  ['2025 Topps Chrome Jaxson Dart Refractor RC #306', 'Jaxson Dart', 'Topps Chrome', '306', 'Refractor'],
  ['2024 Prizm Caleb Williams #301 Silver Prizm', 'Caleb Williams', 'Prizm', '301', ''],
  ['2024 Prizm Caleb Williams Green Ice #301', 'Caleb Williams', 'Prizm', '301', ''],
  ['2024 Donruss Optic Bo Nix Purple Shock #209', 'Bo Nix', 'Donruss Optic', '209', ''],
  ['2025 Topps Chrome Cam Ward #314 Gold /50', 'Cam Ward', 'Topps Chrome', '314', ''],
  ['2025 Topps Chrome Cam Ward #314 1/1 Superfractor', 'Cam Ward', 'Topps Chrome', '314', ''],
  ['2024 Prizm Caleb Williams #RA-CW Rookie Auto', 'Caleb Williams', 'Prizm', 'RA-CW', ''],
  ['2024 Prizm Caleb Williams #301 Tie Dye', 'Caleb Williams', 'Prizm', '301', ''],
  ['2024 Donruss Caleb Williams Downtown #21', 'Caleb Williams', 'Donruss', '21', 'Downtown'],
  ['2025 Topps Chrome Jaxson Dart Cosmic #306', 'Jaxson Dart', 'Topps Chrome', '306', ''],
  ['2024 Prizm Caleb Williams #301 Jersey Patch', 'Caleb Williams', 'Prizm', '301', ''],
  ['2024 Prizm Caleb Williams #301', 'Caleb Williams', 'Prizm', '', ''],   // no number
];

const db = new DatabaseSync(':memory:');
db.exec('CREATE TABLE sales (title TEXT, player TEXT, year TEXT, set_name TEXT, card_number TEXT, parallel TEXT)');
const ins = db.prepare('INSERT INTO sales VALUES (?,?,?,?,?,?)');
for (const [t, p, set, num, par] of [...KEEP, ...DROP]) ins.run(t, p, t.slice(0, 4), set, num, par);
// The same two stages the index runs: column and substring tests, then the
// kind and whole-word tests on the cleaned title.
const kept = new Set(db.prepare(
  `SELECT title FROM (SELECT title, ${RSI_BASE_TITLE_WORDS} AS tw, ${kind} AS kind
                        FROM sales WHERE 1 = 1 ${RSI_BASE_CARD}${RSI_BASE_SERIAL})
    WHERE kind = '' AND ${RSI_BASE_TITLE_TEST}`).all().map(r => r.title));

const wrongKeep = KEEP.filter(([t]) => !kept.has(t)).map(([t]) => t);
const wrongDrop = DROP.filter(([t]) => kept.has(t)).map(([t]) => t);
check(`every base card is kept, names with colours in them included (${KEEP.length})`,
  wrongKeep.length === 0, wrongKeep.length ? 'dropped: ' + wrongKeep.join(' | ') : 'Rice, A.J. Green, Green Bay, Reggie White, Mosaic…');
check(`every parallel, numbered, autograph, relic or numberless sale is dropped (${DROP.length})`,
  wrongDrop.length === 0, wrongDrop.length ? 'kept: ' + wrongDrop.join(' | ') : 'Refractor, Silver Prizm, /50, 1/1, Auto, Patch, no #…');

// ---- it has to compile on D1, not just on stock SQLite ----------------------
//
// D1 caps expression depth at 100; stock SQLite, which every test here runs
// on, allows 1,000. SQLite nests a chain of ORs one level per term, so the
// first version of the title test — ~115 LIKEs in one chain — passed every
// local test and failed on D1 with "Expression tree is too large (maximum depth
// 100)", taking the market index off the site. Measure the longest chain of
// OR/AND at any one bracket level and keep it far from the cap.
{
  const longestChain = (sql) => {
    const stack = [0]; let worst = 0;
    const str = sql.replace(/'(?:[^']|'')*'/g, "''");       // ignore literals
    for (const tok of str.match(/\(|\)|\bOR\b|\bAND\b/gi) || []) {
      if (tok === '(') stack.push(0);
      else if (tok === ')') stack.pop();
      else { stack[stack.length - 1]++; worst = Math.max(worst, stack[stack.length - 1]); }
    }
    return worst;
  };
  const parts = { RSI_BASE_CARD, RSI_BASE_SERIAL, RSI_BASE_TITLE_WORDS, RSI_BASE_TITLE_TEST, kind };
  const worst = Object.entries(parts).map(([k, v]) => [k, longestChain(v)]).sort((a, b) => b[1] - a[1]);
  check('no OR/AND chain comes near D1\'s expression-depth cap of 100',
    worst[0][1] <= 40, worst.map(([k, n]) => `${k}=${n}`).join(', '));
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall base-card checks passed');
process.exit(failures ? 1 : 0);
