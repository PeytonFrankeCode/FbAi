// The checklist validator, checked against the two ways a checklist fails.
//
// Adding products is the highest-value work available: 21% of sampled sales
// match no product at all, and no reader can identify a card that is not in the
// answer key. So the tool that says whether a new checklist is any good has to
// be right, and it has to be right in a particular way.
//
// A validator that cries wolf is worse than no validator, because it trains you
// to ignore it. The first version of this one errored on every card number
// shared by two players — which is what a quad autograph looks like — and
// reported 12,901 errors across a catalogue that is mostly fine. Half the
// checks below exist to prove the legitimate shapes stay quiet.
const { execFileSync } = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'validate-checklist.js');

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checklist-'));
// The filename matters: the product index is keyed by it, so the validator
// compares it against the file's own id.
const write = (name, doc) => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, JSON.stringify(doc, null, 2));
  return p;
};
const run = (file, extra = []) => {
  try {
    return { out: execFileSync('node', [SCRIPT, file, ...extra], { encoding: 'utf8' }), code: 0 };
  } catch (e) {
    return { out: String(e.stdout || ''), code: e.status };
  }
};

// A minimal product that should pass everything. Panini Prizm is used as the
// brand because the join test needs a spelling the catalogue can actually
// reach — that is the point of the check, so the fixture has to satisfy it.
const good = (over = {}) => ({
  id: '2017-panini-prizm-football',
  name: '2017 Panini Prizm Football',
  year: 2017,
  brand: 'Prizm',
  sport: 'Football',
  sets: [{
    id: 'base-set', name: 'Base Set', category: 'base', totalCards: 2,
    parallels: [{ name: 'Silver Prizm', printRun: null }, { name: 'Gold', printRun: 10 }],
    cards: [{ number: '1', player: 'Patrick Mahomes II' },
            { number: '2', player: 'Josh Allen' }],
  }],
  ...over,
});

// ---- a good file passes, and says so ------------------------------------
{
  const r = run(write('2017-panini-prizm-football.json', good()));
  check('a well-formed checklist passes with no errors and no warnings',
    r.code === 0 && /0 error\(s\), 0 warning\(s\)/.test(r.out),
    r.out.split('\n').filter(l => /ERROR|WARN/.test(l)).join(' | ') || 'clean');
  check('  ...and it confirms a sale can actually reach the product',
    /joins to this product/.test(r.out),
    'the join check is the one that catches a catalogued-but-unreachable product');
}

// ---- the legitimate shapes must stay quiet ------------------------------
//
// Every one of these looks wrong and is not. They are the reason the first
// version of this validator was useless.
{
  const quad = good();
  quad.sets[0].totalCards = 5;
  // One quad autograph: four players, one card number. 12,198 rows in the live
  // catalogue look like this.
  quad.sets[0].cards = [
    { number: '1', player: 'Patrick Mahomes II' },
    { number: 'RPA-1', player: 'Deshaun Watson' },
    { number: 'RPA-1', player: 'DeShone Kizer' },
    { number: 'RPA-1', player: 'Mitchell Trubisky' },
    { number: 'RPA-1', player: 'Deshaun Watson/DeShone Kizer/Mitchell Trubisky/Patrick Mahomes II' },
  ];
  const r = run(write('2017-panini-prizm-football.json', quad));
  check('a quad autograph sharing one card number is not an error',
    r.code === 0 && !/ERROR/.test(r.out),
    r.out.split('\n').filter(l => /ERROR/.test(l)).join(' | ') || 'no errors');
  check('  ...nor is a long slash-separated multi-player name',
    !/Deshaun Watson\/DeShone/.test(r.out.replace(/^.*joins to.*$/gm, '')),
    '367 of these are real cards in the live catalogue');
}

// ---- the failures that break something ----------------------------------
{
  const cases = [
    ['id that disagrees with the filename',
      good({ id: 'something-else' }), /does not match the filename/],
    ['year as a string',
      good({ year: '2017' }), /year\s+must be a number/],
    ['a set with no cards',
      good({ sets: [{ id: 's', name: 'S', category: 'base', cards: [] }] }), /has no cards/],
    ['an unknown category',
      good({ sets: [{ id: 's', name: 'S', category: 'chase', cards: [{ number: '1', player: 'A B' }] }] }),
      /is not one of/],
    ['a numeric card number',
      (() => { const d = good(); d.sets[0].cards[0].number = 1; return d; })(),
      /number must be a string/],
    ['a print run of zero',
      (() => { const d = good(); d.sets[0].parallels[1].printRun = 0; return d; })(),
      /printRun must be a positive number/],
  ];
  for (const [label, doc, re] of cases) {
    const r = run(write('2017-panini-prizm-football.json', doc));
    check(`rejected: ${label}`, r.code === 1 && re.test(r.out),
      r.code !== 1 ? `exit ${r.code}` : (re.test(r.out) ? '' : r.out.slice(0, 120)));
  }
}

// ---- the same player twice on one number IS an error --------------------
// The one duplicate shape that is not a multi-player card: a duplicated row,
// which double-counts the card. 461 of these are in the live catalogue.
{
  const dup = good();
  dup.sets[0].cards = [{ number: '1', player: 'Patrick Mahomes II' },
                       { number: '1', player: 'Patrick Mahomes II' }];
  const r = run(write('2017-panini-prizm-football.json', dup));
  check('the same player listed twice on one number is an error',
    r.code === 1 && /listed twice on #1/.test(r.out),
    r.out.split('\n').find(l => /ERROR/.test(l)) || `exit ${r.code}`);
}

// ---- the warnings that mean "this will not do its job" -------------------
{
  const soft = good();
  soft.sets[0].totalCards = 99;
  soft.sets[0].parallels.push({ name: 'Also available in the convention exclusive box configuration.' });
  soft.sets[0].parallels.push({ name: 'Bronze', printRun: '25' });
  soft.sets[0].cards.push({ number: '3', player: 'Mack Hollins/Eagles VAR AUTO[/column]' });
  const r = run(write('2017-panini-prizm-football.json', soft));
  check('a prose footnote in the parallels list is reported as dropped',
    /reads as a footnote and will be DROPPED/.test(r.out), '');
  check('  ...a totalCards that disagrees with the file is reported',
    /totalCards says 99, the file holds/.test(r.out), '');
  check('  ...a string print run is a warning, not an error',
    /printRun is the string "25"/.test(r.out) && !/ERROR.*printRun/.test(r.out),
    '300+ live entries do this and every consumer coerces it');
  check('  ...and markup left in a player name is caught',
    /markup leaked in from the source page/.test(r.out), '');
  check('  ...while none of those block the file',
    r.code === 0, `exit ${r.code} — warnings must not fail the run`);
}

// ---- the check that matters most: breaking a product that already works --
//
// The worst thing a new checklist can do, and it is completely silent. Two
// products whose names reduce to the same key make that key ambiguous, and
// buildIndex drops ambiguous keys rather than guess — so BOTH become
// unreachable. Verified directly against the live catalogue: adding a second
// "2017 Panini Prizm Football" takes 2017 "Prizm" from the real product to
// null, and every 2017 Prizm sale on the site stops joining to anything.
//
// Nothing throws. The new file looks broken; the old one looks fine until
// somebody checks it, which is how this would reach production.
{
  const collides = good({
    id: '2017-panini-prizm-collectors-football',
    name: '2017 Panini Prizm Football',       // the name of a product already on disk
  });
  const r = run(write('2017-panini-prizm-collectors-football.json', collides));
  check('a name that collides with an existing product is rejected',
    r.code === 1 && /makes \d+ EXISTING product\(s\) unreachable/.test(r.out),
    r.out.split('\n').filter(l => /ERROR/.test(l)).join(' | ') || `exit ${r.code}`);
  check('  ...and it names the product it would break',
    /2017-panini-prizm-football/.test(r.out),
    'the message has to say WHICH product, or it is not actionable');

  // And the same check must stay quiet for an ordinary new product, or it is
  // just another false alarm.
  const fine = good({
    id: '2017-panini-prizm-collegiate-draft-football',
    name: '2017 Panini Prizm Collegiate Draft Football',
  });
  const r2 = run(write('2017-panini-prizm-collegiate-draft-football.json', fine));
  check('  ...while a genuinely new product does not trip it',
    /no existing product loses its join/.test(r2.out),
    r2.out.split('\n').filter(l => /ERROR/.test(l)).join(' | ') || 'quiet');
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) failed` : '\nall validate-checklist checks passed');
process.exit(failures ? 1 : 0);
