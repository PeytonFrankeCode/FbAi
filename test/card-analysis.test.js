// The card modal: which sales are the SAME card, and which grade series they
// belong to.
//
// Three reported defects, one fixture. All three were visible on a single page
// — 2017 Panini Prizm, Patrick Mahomes II, #269:
//
//   1. A 1/1 Gold Vinyl auto was grouped with the base card, and the "trend"
//      across that pair read as a 44,446,000% rise.
//   2. Graded copies appeared in the Raw list.
//   3. The card showed 2 sales when the page in front of the user had 5.
//
// (2) and (3) have the same shape as each other and the opposite shape to (1):
// (1) is a FALSE MERGE, (2) and (3) are FALSE SPLITS. A fixture that only
// tested one direction would pass with the fix for the other, so this tests
// both at once — the Silvers must come together AND the auto must stay out.
//
// The parallel column here is deliberately inconsistent, because that is what
// the real table looks like: only 48.4% of priced sales carry a parallel at
// all, and the ones that do disagree about spelling.
let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (err) {
  console.error('FAIL  node:sqlite unavailable on ' + process.version +
                ' — this test needs Node 22.5+. Update the runtime, do not skip it.');
  process.exit(1);
}
const path = require('path');

const db = new DatabaseSync(':memory:');
db.exec(`CREATE TABLE sales (
  item_id TEXT, sold_date TEXT, title TEXT, price_cents INTEGER, currency TEXT,
  listing_format TEXT, grader TEXT, grade TEXT, player TEXT, parallel TEXT,
  year TEXT, set_name TEXT, card_number TEXT, confidence REAL,
  best_offer INTEGER, bids INTEGER, image_url TEXT
)`);

const DAY = 86400000;
const iso = (off) => new Date(Date.now() + off * DAY).toISOString().slice(0, 10);
const ins = db.prepare(
  `INSERT INTO sales (item_id, sold_date, title, price_cents, player, year, set_name,
                      parallel, card_number, grader, grade, confidence, image_url)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);

const PLAYER = 'Patrick Mahomes II';
let n = 0;
// `parallel` is the COLUMN; the title carries its own spelling. The gap between
// them is the bug.
function sale(id, { title, price, day, parallel = '', grader = '', grade = '', number = '269' }) {
  ins.run(id, iso(day), title, Math.round(price * 100), PLAYER, '2017', 'Prizm',
          parallel, number, grader, grade, 0.9, null);
  n++;
}

// ---- The five Silver sales the user counted on screen ----------------------
// Five spellings of one card. Two carry a parallel in the column and disagree
// with each other; three carry nothing and state it only in the title, in three
// different positions. Under the old column-equality rule these formed three
// separate cards, which is why the page said 2.
sale('s1', { title: '2017 Panini Prizm - Rookies Patrick Mahomes II #269 Silver Prizm (RC)',
             price: 792, day: -14, parallel: 'Silver Prizm' });
sale('s2', { title: '2017 Panini Prizm - Rookies Patrick Mahomes II #269 Silver Prizms (RC)',
             price: 565, day: -14, parallel: 'Silver' });
sale('s3', { title: '2017 Panini Prizm Rookies Silver #269 Patrick Mahomes II RC',
             price: 640, day: -13 });
sale('s4', { title: 'Panini 2017 Prizm Rookies Patrick Mahomes II Silver #269',
             price: 600, day: -20 });
sale('s5', { title: '2017 Panini Prizm Patrick Mahomes II Rookie Silver Prizm #269',
             price: 712.50, day: -28 });

// ---- The base card, and the 1/1 that must not join it ----------------------
// Both have an EMPTY parallel column, which is exactly how the auto got in:
// "parallel IS NULL OR parallel = ''" is not "the base card", it is the base
// card plus everything unparsed.
sale('b1', { title: '2017 Panini Prizm - Rookies Patrick Mahomes II #269 (RC)', price: 18, day: -25 });
sale('b2', { title: '2017 Panini Prizm - Rookies Patrick Mahomes II #269 (RC)', price: 21, day: -18 });
sale('b3', { title: '2017 Panini Prizm - Rookies Patrick Mahomes II #269 (RC)', price: 19, day: -10 });
sale('b4', { title: '2017 Panini Prizm - Rookies Patrick Mahomes II #269 (RC)', price: 20, day: -3 });
// The 1/1. Priced to produce an absurd percentage if it lands in the base
// bucket, which is what was happening.
sale('a1', { title: '2017 Panini Prizm Patrick Mahomes II #269 Gold Vinyl 1/1 Auto', price: 8900, day: -2 });
// The harder 1/1: this one's parallel is not in the vocabulary at all, so the
// reader returns "unmatched" rather than naming it.
//
// This row is the whole reason "unreadable" and "base" are kept apart. The
// Gold Vinyl above is excluded because its parallel is READ and differs; this
// one can only be excluded by the rule that an unreadable parallel is not
// evidence of a base card. Without that row the rule can be deleted and every
// other check here still passes — which is exactly what happened the first time
// this fixture was run against a deliberately broken build.
sale('a2', { title: '2017 Panini Prizm Patrick Mahomes II #269 Emerald Kaleidoscope Patch Auto 1/1',
             price: 12500, day: -1 });

// ---- Graded copies of the Silver ------------------------------------------
// The grader written hard against its number is the commonest spelling on eBay
// and the one \b could not match. Empty grade columns throughout, because that
// is the case that fell through to Raw.
sale('g1', { title: '2017 Panini Prizm Patrick Mahomes II #269 Silver Prizm PSA10', price: 3200, day: -12 });
sale('g2', { title: '2017 Panini Prizm Patrick Mahomes II #269 Silver Prizm BGS9.5', price: 2400, day: -9 });
sale('g3', { title: '2017 Panini Prizm Patrick Mahomes II #269 Silver Prizm PSA 10', price: 3100, day: -6 });

// A different card entirely: same player, same year, same set, different
// number. It must never be grouped in, whatever its parallel says.
sale('x1', { title: '2017 PANINI PRIZM INSTANT IMPACT #8 PATRICK MAHOMES II',
             price: 223.05, day: -15, number: '8' });

const d1 = {
  prepare(sql) {
    const st = db.prepare(sql);
    return {
      bind(...a) { return { all: async () => ({ results: st.all(...a) }), first: async () => st.get(...a) || null }; },
      all: async () => ({ results: st.all() }),
      first: async () => st.get() || null,
    };
  },
};

const dbMod = require(path.join(__dirname, '..', 'db.js'));
dbMod.getNflDb = () => d1;
// KV is absent in Node, so cacheGet/cachePut no-op. That matters here: the
// endpoint caches its payload, and a warm entry from an earlier check would
// serve a later one a stale grouping.
process.env.CF_WORKER = '1';

const { app } = require(path.join(__dirname, '..', 'server.js'));
const PORT = 3211;
const server = app.listen(PORT);
const call = async (url) => (await fetch(`http://127.0.0.1:${PORT}${url}`)).json();

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

const bucketNames = (d) => (d.grades || []).map(g => g.label);
const bucket = (d, label) => (d.grades || []).find(g => g.label === label);
const rawTitles = (d) => {
  const r = bucket(d, 'Raw');
  return r ? r.recent.map(x => x.title) : [];
};

(async () => {
  // ---- 3. the card that showed 2 sales when there were 5 -------------------
  const silver = await call('/api/card-analysis?itemId=s1');
  check('the clicked Silver resolves to a card', silver.available === true,
        silver.available ? `${silver.totalSales} sales` : `reason=${silver.reason}`);

  // Two different counts, and conflating them is how the report was ambiguous.
  // totalSales is every sale of this card at ANY grade — 5 raw plus 3 slabs.
  // The five the user counted on screen were the raw ones, and those are the
  // Raw series, checked at the end. Both have to be right: a card that groups
  // its slabs but loses its raw copies would pass one and fail the other.
  check('every spelling of the Silver groups as one card',
        silver.totalSales === 8,
        `got ${silver.totalSales} — expected 5 raw + 3 graded, across four column spellings`);

  // Every one of the five, by id, so a count that happens to be 5 for the
  // wrong reason cannot pass.
  const gotIds = new Set((silver.grades || []).flatMap(g => g.recent.map(r => r.itemUrl)));
  const wanted = ['s1', 's2', 's3', 's4', 's5'];
  const missing = wanted.filter(id => ![...gotIds].some(u => u.endsWith('/' + id)));
  check('  ...and it is those five, not five of something else',
        missing.length === 0,
        missing.length ? `missing ${missing.join(', ')}` : 's1–s5 all present');

  check('  ...without dragging in the #8 Instant Impact card',
        ![...gotIds].some(u => u.endsWith('/x1')),
        'a different card number is a different card');

  check('  ...and without dragging in the 1/1 auto',
        ![...gotIds].some(u => u.endsWith('/a1')),
        'Gold Vinyl is a different parallel');

  // ---- 1. the 1/1 auto merged into the base card --------------------------
  const base = await call('/api/card-analysis?itemId=b1');
  check('the base card resolves', base.available === true,
        base.available ? `${base.totalSales} sales` : `reason=${base.reason}`);

  const baseIds = new Set((base.grades || []).flatMap(g => g.recent.map(r => r.itemUrl)));
  check('the named 1/1 auto is NOT grouped with the base card',
        ![...baseIds].some(u => u.endsWith('/a1')),
        'Gold Vinyl is read, and a read parallel that differs is a different card');

  // The one that only the unreadable rule can catch.
  check('the UNREADABLE 1/1 auto is NOT grouped with the base card either',
        ![...baseIds].some(u => u.endsWith('/a2')),
        'an unreadable parallel is not evidence of a base card');

  check('  ...and it is counted as unreadable rather than silently dropped',
        base.identity && base.identity.unreadable >= 1,
        base.identity ? `unreadable=${base.identity.unreadable}` : 'no identity block');

  check('  ...and the base card keeps its own four sales',
        base.totalSales === 4, `got ${base.totalSales}`);

  check('  ...so no grade series reports an absurd trend',
        (base.grades || []).every(g => g.changePct === null || Math.abs(g.changePct) < 10000),
        (base.grades || []).map(g => `${g.label}:${g.changePct}`).join(' ') || 'no grades');

  // The endpoint says how it decided, and the counts are checkable.
  check('  ...and the payload states what it excluded',
        base.identity && base.identity.otherParallels >= 1,
        base.identity ? JSON.stringify(base.identity) : 'no identity block');

  // ---- the fallback path, where the spread guard is the only defence ------
  //
  // Clicking the unreadable 1/1 itself: its own parallel cannot be read, so
  // there is no key to group on and the endpoint falls back to matching the
  // column, which is the old behaviour with its old flaw — blank column means
  // the base cards come too. That fallback is deliberate (inventing an identity
  // from a title we could not parse would be worse), but it means a bucket
  // holding $18 base cards and a $12,500 auto can still reach the chart.
  //
  // Nothing above can catch that, because the grouping fix is precisely what
  // does not apply here. The spread guard is what stops it being published as a
  // five-figure percentage.
  const murky = await call('/api/card-analysis?itemId=a2');
  check('a card whose own parallel cannot be read still answers',
        murky.available === true,
        murky.available ? `${murky.totalSales} sales` : `reason=${murky.reason}`);

  check('  ...and says the identity is unresolved rather than claiming one',
        murky.identity && murky.identity.parallel === null,
        murky.identity ? JSON.stringify(murky.identity) : 'no identity block');

  const wild = (murky.grades || []).find(g => g.label === 'Raw');
  check('  ...and refuses a trend across prices that cannot be one card',
        wild && wild.changePct === null && !!wild.trendSuppressed,
        wild ? `changePct=${wild.changePct} low=${wild.low} high=${wild.high} suppressed=${wild.trendSuppressed || 'no'}`
             : 'no Raw series');

  // ---- 2. graded cards in the raw list ------------------------------------
  const raws = rawTitles(silver);
  const leaked = raws.filter(t => /PSA|BGS/i.test(t));
  check('no graded copy appears in the Raw list',
        leaked.length === 0,
        leaked.length ? `leaked: ${leaked.join(' | ')}` : `${raws.length} raw sales, none graded`);

  check('  ...including the ones written PSA10 and BGS9.5 with no space',
        !raws.some(t => /PSA10|BGS9\.5/i.test(t)),
        'a digit is a word character, so \\b never matched between PSA and 10');

  check('  ...and they land in their own labelled series',
        bucketNames(silver).includes('PSA 10') && bucketNames(silver).includes('BGS 9.5'),
        bucketNames(silver).join(', '));

  check('  ...with the spaced and unspaced PSA 10s in the SAME series',
        (bucket(silver, 'PSA 10') || {}).sales === 2,
        `PSA 10 has ${(bucket(silver, 'PSA 10') || {}).sales} sales, expected g1 + g3`);

  // Raw must still contain the five raw Silvers — the fix must not throw real
  // raw sales out to achieve a clean list.
  check('  ...while every genuinely raw sale is kept',
        (bucket(silver, 'Raw') || {}).sales === 5,
        `Raw has ${(bucket(silver, 'Raw') || {}).sales}, expected 5`);

  server.close();
  console.log(failures ? `\n${failures} check(s) failed` : '\nall card-analysis checks passed');
  process.exit(failures ? 1 : 0);
})().catch(err => { console.error(err); server.close(); process.exit(1); });
