// The grading advisor's four rows read one pool of our own sales, split by
// grade. Our rows carry the grade as data rather than a query filter, so
// without the split every row showed the same sales: Raw and PSA 10 alike.
const path = require('path');
process.env.CF_WORKER = '1';
const { _matchesGradeOpts } = require(path.join(__dirname, '..', 'server.js'));

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

const POOL = [
  { title: '2024 Prizm Bo Nix #301 RC', grader: null, grade: null },
  { title: '2024 Prizm Bo Nix #301 RC PSA 10 GEM MINT', grader: 'PSA', grade: '10' },
  { title: '2024 Prizm Bo Nix #301 RC PSA 9', grader: 'PSA', grade: '9' },
  { title: '2024 Prizm Bo Nix #301 RC PSA 8', grader: 'PSA', grade: '8.0' },
  { title: '2024 Prizm Bo Nix #301 RC BGS 9.5', grader: 'BGS', grade: '9.5' },
  { title: '2024 Prizm Bo Nix #301 RC SGC 10', grader: 'SGC', grade: '10' },
  // No grade column, but the title says it is slabbed: not raw.
  { title: '2024 Prizm Bo Nix #301 RC PSA 10', grader: null, grade: null },
];
const OPTS = {
  raw: { graded: false },
  psa8: { grader: 'PSA', grade: '8' },
  psa9: { grader: 'PSA', grade: '9' },
  psa10: { grader: 'PSA', grade: '10' },
};
const split = Object.fromEntries(Object.entries(OPTS).map(([k, o]) =>
  [k, POOL.filter(r => _matchesGradeOpts(r, o)).map(r => r.title)]));

check('raw holds only the ungraded sale', split.raw.length === 1 && !/PSA|BGS|SGC/.test(split.raw[0]), JSON.stringify(split.raw));
check('PSA 8 holds only the PSA 8', split.psa8.length === 1 && /PSA 8/.test(split.psa8[0]), JSON.stringify(split.psa8));
check('PSA 9 holds only the PSA 9', split.psa9.length === 1 && /PSA 9/.test(split.psa9[0]), JSON.stringify(split.psa9));
check('PSA 10 holds both PSA 10s and no SGC 10', split.psa10.length === 2 && split.psa10.every(t => /PSA 10/.test(t)), JSON.stringify(split.psa10));
const all = Object.values(split).flat();
check('no sale lands in two grades', new Set(all).size === all.length);

// ---- The grading fee: PSA's $74.99, in one place, and the page quotes it ----
// PSA shut its cheaper tiers to work down its backlog; the advisor still
// subtracted $25 and told people grading paid when it did not.
{
  const fs = require('fs');
  const root = require('path').join(__dirname, '..');
  const srv = fs.readFileSync(root + '/server.js', 'utf8');
  const app = fs.readFileSync(root + '/public/app.js', 'utf8');
  const html = fs.readFileSync(root + '/public/index.html', 'utf8');
  check('the fee is PSA\'s $74.99, defined once', /const PSA_GRADING_FEE = 74\.99;/.test(srv) && !/GRADING_COST/.test(srv));
  check('  ...the net premium subtracts it', /graded\.median - rawVal\.median - PSA_GRADING_FEE/.test(srv));
  check('  ...and every answer says what was subtracted', /gradingCost: \{ fee: PSA_GRADING_FEE/.test(srv));
  const render = app.slice(app.indexOf('function renderGradingResults'), app.indexOf('function renderGradingResults') + 6000);
  check('the page quotes the fee the server used, not a number of its own',
    /data\.gradingCost/.test(render) && !/\$25/.test(render) && !/\$25/.test(html));
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall grading-advisor checks passed');
process.exit(failures ? 1 : 0);
