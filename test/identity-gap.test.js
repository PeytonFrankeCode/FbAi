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
  check('the fixture key really is ambiguous in the catalogue',
    (AMB[PRODUCT] || []).includes(AMBIGUOUS_KEY),
    `${AMBIGUOUS_KEY} in ${PRODUCT}`);
  check('  ...and the control key really is not',
    !(AMB[PRODUCT] || []).includes(UNAMBIGUOUS_KEY),
    `${UNAMBIGUOUS_KEY} absent from the ambiguity map`);

  const r = await (await fetch(`http://127.0.0.1:${PORT}/api/debug/identity-gap`)).json();
  check('the endpoint answers', r.available === true, r.available ? `${r.salesCovered} sales` : r.reason);

  const a = r.ambiguity || {};
  check('the ambiguity map is loaded, not reported unavailable',
    !a.unavailable && a.catalogueKeysAmbiguous > 10000,
    a.unavailable || `${(a.catalogueKeysAmbiguous || 0).toLocaleString()} catalogue keys`);

  // The join works. A zero here is what a normaliser drift looks like.
  check('sales resolve to a product',
    a.salesResolvedToAProduct === r.salesCovered && r.salesCovered > 0,
    `${a.salesResolvedToAProduct} of ${r.salesCovered}`);

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

  server.close();
  console.log(failures ? `\n${failures} check(s) failed` : '\nall identity-gap checks passed');
  process.exit(failures ? 1 : 0);
})().catch(err => { console.error(err); server.close(); process.exit(1); });
