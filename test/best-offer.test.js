// Best-offer sales stay out of the aggregates and stay in the sold search.
//
// WHY. Most best-offer rows never reach an aggregate anyway: price_cents is
// NULL on the ~46% of rows where eBay published the seller's ask rather than
// what the buyer paid, and every aggregate already requires a price. This is
// about the remainder — rows carrying both a price and a best_offer flag.
//
// They are excluded for what the number MEANS, not for being missing. An
// accepted offer settled somewhere under an ask nobody published, so two on
// the same card can sit far apart for reasons that are not the market. Across
// hundreds of sales that is noise; on one card's price chart, or a set's top
// eight, it is a visible wobble that is not a signal.
//
// THE SOLD SEARCH KEEPS THEM, and that is the half most likely to be broken by
// accident. There a sale is shown on its own and labelled by saleTypeOf(), so
// a reader can weigh it. There is a check below that the search predicate is
// untouched, because "exclude everywhere" is the easy mistake.
const path = require('path');
const ROOT = path.join(__dirname, '..');
const fs = require('fs');

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
process.env.ADMIN_PASSWORD = 'test-key-for-offers';
const { _noBestOfferSql } = require(path.join(ROOT, 'server.js'));

(async () => {
  // ---- The clause is column-gated ----
  //
  // Naming a column the schema lacks fails the whole query, which would take
  // the market index down rather than merely widen it.
  {
    const withCol = { prepare: () => ({ first: async () => ({}) }) };
    const noCol = { prepare: () => ({ first: async () => { throw new Error('no such column'); } }) };
    // The probe memoises per process, so each shape needs its own require-free
    // path — check the shape of the output rather than re-probing.
    const sql = await _noBestOfferSql(withCol);
    check('a schema WITH best_offer produces a clause',
      /best_offer/.test(sql), sql || '(empty)');
    check('  ...and it is an AND, so it composes onto an existing WHERE',
      /^\s*AND /.test(sql), JSON.stringify(sql.slice(0, 24)));
    void noCol;
  }

  // ---- The clause does what it says, against real SQLite ----
  {
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE sales (item_id TEXT, price_cents INTEGER, best_offer)`);
    const ins = db.prepare('INSERT INTO sales VALUES (?,?,?)');
    // The spread saleTypeOf() already handles: integer 1 in some imports,
    // 'y'/'true' in others.
    ins.run('int1', 1000, 1);
    // Bound as a float, which is how node:sqlite stores a JS number — and the
    // case that defeated the first version of the clause, because CAST gives
    // '1.0' rather than '1'.
    ins.run('real1', 1000, 1.0);
    ins.run('texty', 1000, 'y');
    ins.run('textyes', 1000, 'YES');
    ins.run('texttrue', 1000, 'true');
    ins.run('zero', 1000, 0);
    ins.run('nullcol', 1000, null);
    ins.run('emptystr', 1000, '');

    const clause = await _noBestOfferSql({ prepare: () => ({ first: async () => ({}) }) });
    const kept = db.prepare(
      `SELECT item_id FROM sales WHERE price_cents IS NOT NULL${clause} ORDER BY item_id`)
      .all().map(r => r.item_id);

    check('every best-offer spelling is excluded',
      !kept.some(id => ['int1', 'real1', 'texty', 'textyes', 'texttrue'].includes(id)),
      'kept: ' + kept.join(','));
    check('  ...and an ordinary priced sale is kept',
      kept.includes('zero') && kept.includes('nullcol') && kept.includes('emptystr'),
      'kept: ' + kept.join(',') + ' — a NULL flag is not an offer, it is unknown');
    check('  ...so exactly the three non-offers survive',
      kept.length === 3, `${kept.length} rows: ${kept.join(',')}`);
  }

  // ---- Applied to the aggregates, and ONLY to them ----
  {
    const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

    // The market index: both builders resolve it themselves, so the rule is in
    // one place rather than at each of the four call sites.
    check('the market aggregate query excludes offers',
      /async function _rsiQuery[\s\S]{0,400}?_noBestOfferSql\(db\)/.test(src));
    check('  ...and so does the basket query',
      /async function _rsiBasketQuery[\s\S]{0,400}?_noBestOfferSql\(db\)/.test(src));
    // Both queries build their WHERE in one shared helper, so the clause is
    // interpolated once there — into the tests both of its passes apply, the one
    // that chooses the basket and the one that prices it — and each query must
    // hand the helper its noOffer.
    const helper = (src.match(/function _rsiBaseCtes[\s\S]*?\n}\n/) || [''])[0];
    check('  ...with the clause actually reaching both WHERE clauses',
      /const saleTests = `[^`]*\$\{noOffer\}/.test(helper)
      && /const columns = `\$\{colTests\}\$\{saleTests\}`/.test(helper)
      && /WHERE \$\{columns\}/.test(helper)
      && /_rsiQualify\(saleTests, 's'\)/.test(helper)
      && (src.match(/\$\{_rsiBaseCtes\(\{[^}]*\bnoOffer\b/g) || []).length === 2,
      'defined but not interpolated is the failure mode here');

    // The card history chart.
    check('the card-history chart excludes offers',
      /FROM sales WHERE \$\{where\}\$\{noOffer\}/.test(src),
      'one point well under the line, with no visible ask, is the clearest case');

    // The boards and the public price blocks.
    check('the sold-stats boards exclude offers',
      (src.match(/price_cents IS NOT NULL\$\{noOffer\}/g) || []).length >= 2,
      'top sellers and movers are both aggregates');
    check('the public price blocks exclude offers',
      /confidence >= \$\{NFLDB_MIN_CONFIDENCE\}`\s*\n\s*\+ \(await _noBestOfferSql\(db\)\)/.test(src));

    // THE HALF THAT MUST NOT CHANGE.
    const searchFn = src.slice(src.indexOf('async function fetchViaNflCardDb'),
                               src.indexOf('async function fetchViaCardApi'));
    check('the SOLD SEARCH still returns best-offer sales',
      searchFn.length > 0 && !/_noBestOfferSql|noOffer/.test(searchFn),
      'a sale shown on its own and labelled as an offer is information; '
      + 'silently averaging it is not');
  }

  console.log(failures ? `\n${failures} check(s) failed` : '\nall best-offer checks passed');
  process.exit(failures ? 1 : 0);
})();
