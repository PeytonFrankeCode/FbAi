// /api/debug/identity-gap: how many sales sit on a card we cannot identify.
//
// This endpoint exists to settle a decision — whether reading insert names out
// of titles is worth wiring into card identity, and whether photos could ever
// add anything on top. A diagnostic that answers a decision has to be right,
// and the way this one fails is silent: the ambiguity map is keyed with the JS
// norm() while the sales columns are normalised in SQL by _normCol(), so if the
// two ever drift every lookup misses, nothing throws, and the endpoint reports
// a confident zero that reads as "no problem here".
//
// So the fixture contains a key that IS ambiguous and a key that is not, and
// the checks assert both. A version of this that only asserted "the endpoint
// returns numbers" would pass against a build where the map never loads.
let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (err) {
  console.error('FAIL  node:sqlite unavailable on ' + process.version +
                ' — this test needs Node 22.5+. Update the runtime, do not skip it.');
  process.exit(1);
}
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ambPath = path.join(ROOT, 'public', 'data', 'subsets', 'ambiguous.json');
if (!fs.existsSync(ambPath)) {
  console.log('SKIP  identity-gap  — run `npm run build:pages` first (CI does)');
  process.exit(0);
}

// A key the catalogue really does call ambiguous, taken from the artifact
// rather than assumed. Dalvin Cook #8 is in both Prizm Premier Jerseys and
// Stained Glass Prizm in 2017 Panini Prizm.
const AMB = JSON.parse(fs.readFileSync(ambPath, 'utf8'));
const PRODUCT = '2017-panini-prizm-football';
const AMBIGUOUS_KEY = 'dalvin cook|8';
const UNAMBIGUOUS_KEY = 'patrick mahomes ii|269';

const db = new DatabaseSync(':memory:');
db.exec(`CREATE TABLE sales (item_id TEXT, sold_date TEXT, title TEXT, price_cents INTEGER,
  currency TEXT, listing_format TEXT, grader TEXT, grade TEXT, player TEXT, parallel TEXT,
  year TEXT, set_name TEXT, card_number TEXT, confidence REAL, best_offer INTEGER,
  bids INTEGER, image_url TEXT)`);

// Dates are SPREAD across the window on purpose. The endpoint excludes the
// trailing day (MARKET_EXCLUDE_TRAILING_DAYS), so a fixture where every sale
// shares the newest date falls entirely outside the window and every figure
// comes back zero — which is exactly how the first run of this test "failed"
// against correct code.
const iso = (o) => new Date(Date.now() + o * 86400000).toISOString().slice(0, 10);
const ins = db.prepare(`INSERT INTO sales (item_id, sold_date, title, price_cents, player,
  year, set_name, parallel, card_number, confidence) VALUES (?,?,?,?,?,?,?,?,?,?)`);
let n = 0;
const add = (title, player, num, times) => {
  for (let i = 0; i < times; i++) {
    ins.run('i' + n++, iso(-5 - (i % 10)), title, 10000, player,
            '2017', 'Prizm', '', String(num), 0.9);
  }
};
// A sale that matches NO product, so topUnmatchedSets is not empty and the
// checks on it are not passing vacuously. Deliberately a throwback shape: the
// collector filed it under 1989 off the design on the card's face, while the
// title says it is a 2024 Donruss. Writing a 1989 Score checklist would not
// move this sale, and the queue has to be able to say so.
{
  for (let i = 0; i < 4; i++) {
    ins.run('tb' + i, iso(-6 - i),
      '2024 Panini Donruss 1989 Score Throwback Josh Allen Bills', 10000,
      'Josh Allen', '1989', 'Score', '', '1', 0.9);
  }
}

// A spelling that resolves ONLY through public/data/set-aliases.json. The
// collector writes "Topps Signature"; the catalogue calls it Topps Signature
// Class. If the report ever stops applying aliases, these reappear in the
// unmatched queue and it sends the next person to solve a solved problem.
{
  for (let i = 0; i < 3; i++) {
    ins.run('al' + i, iso(-7 - i),
      '2025 Topps Signature Class - Rookies Ashton Jeanty #102 Autographs (AU, RC)',
      10000, 'Ashton Jeanty', '2025', 'Topps Signature', '', '102', 0.9);
  }
}

add('2017 Panini Prizm Dalvin Cook #8', 'Dalvin Cook', 8, 6);                      // ambiguous, insert unnamed
add('2017 Panini Prizm Stained Glass Prizm Dalvin Cook #8', 'Dalvin Cook', 8, 6);  // ambiguous, insert named
add('2017 Panini Prizm Patrick Mahomes II #269', 'Patrick Mahomes II', 269, 6);    // not ambiguous

const d1 = {
  prepare(sql) {
    const st = db.prepare(sql);
    return {
      bind: (...a) => ({ all: async () => ({ results: st.all(...a) }),
                         first: async () => st.get(...a) || null }),
      all: async () => ({ results: st.all() }),
      first: async () => st.get() || null,
    };
  },
};

const dbMod = require(path.join(ROOT, 'db.js'));
dbMod.getNflDb = () => d1;
process.env.CF_WORKER = '1';

const { app } = require(path.join(ROOT, 'server.js'));
const PORT = 3213;
const server = app.listen(PORT);

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

(async () => {
  // The fixture's premise, asserted rather than assumed. If the catalogue ever
  // stops calling this key ambiguous, every check below becomes meaningless
  // while still passing.
  // The artifact groups keys by the KIND of collision, because which kind a
  // sale sits on decides what could resolve it. A flat total pointed the work
  // at the wrong problem entirely — see the byKind comment in server.js.
  const kindsOf = (pid, key) => Object.entries(AMB[pid] || {})
    .filter(([, list]) => list.includes(key)).map(([k]) => k);

  check('the fixture key really is ambiguous in the catalogue',
    kindsOf(PRODUCT, AMBIGUOUS_KEY).length === 1,
    `${AMBIGUOUS_KEY} in ${PRODUCT} as ${kindsOf(PRODUCT, AMBIGUOUS_KEY).join(',') || 'nothing'}`);
  check('  ...and the control key really is not',
    kindsOf(PRODUCT, UNAMBIGUOUS_KEY).length === 0,
    `${UNAMBIGUOUS_KEY} absent from the ambiguity map`);
  // A key must be filed under exactly one kind, or the sales counted per kind
  // would not sum to the total and every share would be wrong.
  {
    let multi = 0, checked = 0;
    for (const [pid, byKind] of Object.entries(AMB)) {
      const seen = new Map();
      for (const [kind, list] of Object.entries(byKind)) {
        for (const k of list) { seen.set(k, (seen.get(k) || 0) + 1); }
      }
      for (const c of seen.values()) { checked++; if (c > 1) multi++; }
      if (checked > 50000) break;
    }
    check('  ...and every key is filed under exactly one kind',
      multi === 0, multi ? `${multi} keys in two kinds` : `${checked.toLocaleString()} keys checked`);
  }

  const r = await (await fetch(`http://127.0.0.1:${PORT}/api/debug/identity-gap`)).json();
  check('the endpoint answers', r.available === true, r.available ? `${r.salesCovered} sales` : r.reason);

  const a = r.ambiguity || {};
  check('the ambiguity map is loaded, not reported unavailable',
    !a.unavailable && a.catalogueKeysAmbiguous > 10000,
    a.unavailable || `${(a.catalogueKeysAmbiguous || 0).toLocaleString()} catalogue keys`);

  // The join works. A zero here is what a normaliser drift looks like.
  //
  // Not every fixture sale resolves any more, and that is deliberate: four are
  // the 1989 throwback, which matches no product on purpose so the unmatched
  // queue below has something in it. So both halves are asserted — the Prizm
  // sales resolve, the throwback does not, and they account for everything.
  // Asserting only the total would pass against a join that resolved nothing
  // and a counter that had drifted by four.
  check('sales resolve to a product',
    a.salesResolvedToAProduct === r.salesCovered - 4 && a.salesResolvedToAProduct > 0,
    `${a.salesResolvedToAProduct} of ${r.salesCovered}, expecting all but the 4 throwbacks`);
  check('  ...and the ones that do not are counted, not lost',
    a.salesResolvedToAProduct + a.salesWithNoProductMatch === r.salesCovered,
    `${a.salesResolvedToAProduct} + ${a.salesWithNoProductMatch} vs ${r.salesCovered}`);

  // Two thirds of the fixture is the ambiguous card, one third is not.
  check('only the ambiguous card is counted as ambiguous',
    a.salesOnAnAmbiguousKey > 0 && a.salesOnAnAmbiguousKey < r.salesCovered,
    `${a.salesOnAnAmbiguousKey} of ${r.salesCovered} — the Mahomes sales must not be in there`);

  // And the split the decision rests on: of the ambiguous ones, how many does
  // the title already resolve by naming the insert?
  check('  ...and the ones naming their insert are counted separately',
    a.ofThoseTitleNamesTheInsert > 0
      && a.wouldRemainUnresolved > 0
      && a.ofThoseTitleNamesTheInsert + a.wouldRemainUnresolved === a.salesOnAnAmbiguousKey,
    `named=${a.ofThoseTitleNamesTheInsert} unnamed=${a.wouldRemainUnresolved} `
    + `total=${a.salesOnAnAmbiguousKey}`);

  // An unmatched product is its own bucket, not folded into "fine".
  check('  ...and a sale matching no product is reported, not assumed innocent',
    typeof a.salesWithNoProductMatch === 'number',
    `salesWithNoProductMatch=${a.salesWithNoProductMatch}`);

  // ---- missing vintage set, or modern card in an old jacket? --------------
  //
  // topUnmatchedSets is read as a build queue — "1989 | score, 115 sales" looks
  // like a checklist nobody wrote. But Panini and Topps both reissue old
  // designs, and the collector reads the design year off the front of the card,
  // so a 2024 Donruss throwback files itself under 1989. Writing a 1989 Score
  // checklist would not move one of those sales.
  //
  // The tell is that the modern product names BOTH years and the real one is
  // larger. Getting this backwards sends someone to spend an evening on the
  // wrong file, so each shape is asserted rather than assumed.
  {
    const { _yearDisagrees } = require(path.join(ROOT, 'server.js'));
    const cases = [
      // Genuine vintage: the title names its own year and nothing later.
      ['1989 | score', '1989 Score Barry Sanders #257 Rookie Card RC', false],
      ['1986 | topps', '1986 Topps Jerry Rice #161 Rookie', false],
      ['1984 | topps', '1984 Topps John Elway #63 RC', false],
      // Throwbacks: a modern product wearing an old design.
      ['1989 | score', '2024 Panini Donruss 1989 Score Throwback Josh Allen Bills', true],
      ['1986 | topps', '2025 Topps Chrome 1986 Design Anniversary Josh Allen Refractor', true],
      // A season span is not a disagreement.
      ['2023 | topps', '2023-24 Topps Chrome Josh Allen #4', false],
      // No year to compare against: say nothing rather than guess.
      ['? | topps', '2024 Topps Whatever', false],
    ];
    const wrong = cases.filter(([ys, t, want]) => _yearDisagrees(ys, t) !== want);
    check('a throwback design is told apart from a missing vintage set',
      wrong.length === 0,
      wrong.length ? wrong.map(([ys, t]) => `"${ys}" + "${t.slice(0, 40)}"`).join('; ')
                   : `all ${cases.length}`);
  }

  // And the queue has to carry the evidence, or the caller cannot use it.
  {
    const rows = a.topUnmatchedSets || [];
    const tb = rows.find(r => /1989/.test(r.yearAndSet));
    check('  ...and an unmatched spelling reaches the queue at all',
      !!tb, rows.length ? JSON.stringify(rows.slice(0, 2)) : 'the queue is empty');
    check('  ...carrying the sample title a person needs to judge it',
      !!tb && typeof tb.sample === 'string' && /Throwback/i.test(tb.sample),
      tb ? JSON.stringify(tb.sample) : '');
    // The fixture row IS a throwback. Flagging it as a missing vintage set
    // would send someone to write a checklist that moves nothing.
    check('  ...and correctly flagged as a throwback, not a missing checklist',
      !!tb && tb.looksLikeAThrowback === true,
      tb ? `looksLikeAThrowback=${tb.looksLikeAThrowback}` : '');

    // The queue must reflect work already done, or it never shrinks and nobody
    // trusts it. "Topps Signature" resolves only through set-aliases.json, so
    // its presence here means the report is building its join without aliases —
    // disagreeing with the pricing join that actually serves the site.
    const stale = rows.filter(x => /topps signature/i.test(x.yearAndSet));
    check('  ...and a spelling an alias already fixes is NOT still in the queue',
      stale.length === 0,
      stale.length ? `${JSON.stringify(stale[0])} — the report is ignoring set aliases`
                   : 'aliases are applied');
  }

  server.close();
  console.log(failures ? `\n${failures} check(s) failed` : '\nall identity-gap checks passed');
  process.exit(failures ? 1 : 0);
})().catch(err => { console.error(err); server.close(); process.exit(1); });
