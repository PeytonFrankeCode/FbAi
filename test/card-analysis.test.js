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
const fs = require('fs');
const ROOT = path.join(__dirname, '..');

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
function sale(id, { title, price, day, parallel = '', grader = '', grade = '', number = '269', player = PLAYER }) {
  ins.run(id, iso(day), title, Math.round(price * 100), player, '2017', 'Prizm',
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
// Deliberately carries NO autograph or relic word. Once card identity started
// separating base from auto (a2 used to read "Patch Auto"), the kind filter
// pulled it out of the base group on its own and the spread guard below stopped
// being reachable at all — the check passed for the wrong reason. This title
// keeps the parallel unreadable while leaving the card the same KIND as the
// base cards, which is the only shape that still reaches the fallback.
sale('a2', { title: '2017 Panini Prizm Patrick Mahomes II #269 Emerald Kaleidoscope 1/1',
             price: 12500, day: -1 });

// ---- Graded copies of the Silver ------------------------------------------
// The grader written hard against its number is the commonest spelling on eBay
// and the one \b could not match. Empty grade columns throughout, because that
// is the case that fell through to Raw.
// ---- The autograph of the SAME card ---------------------------------------
// 2025 Prizm lists Tyler Shough at #327 in the Base Set AND in Base
// Autographs; every product does this. `set_name` holds the product, so the
// auto and the base card arrive identical in every column and were grouped
// together — a $20 base rookie averaged with a $900 on-card auto. This is
// 65.5% of all ambiguous keys in the catalogue, more than twice the inserts.
//
// The auto word sits BEFORE the card number on purpose. A base autograph has no
// parallel, so the segment after the number is empty and the parallel reads as
// "base" — which is what puts these on the SAME path as the base cards, where
// only the kind can separate them. Putting "Auto" after the number instead made
// the parallel unreadable, sent them down the fallback, and tested the fallback
// rather than the thing being built.
sale('u1', { title: '2017 Panini Prizm Rookie Auto Patrick Mahomes II #269 (RC)', price: 940, day: -22 });
sale('u2', { title: '2017 Panini Prizm On-Card Autograph Patrick Mahomes II #269 (RC)', price: 880, day: -16 });
// And the relic version, which is a third card again.
sale('u3', { title: '2017 Panini Prizm Patch Jersey Patrick Mahomes II #269 (RC)', price: 260, day: -11 });

sale('g1', { title: '2017 Panini Prizm Patrick Mahomes II #269 Silver Prizm PSA10', price: 3200, day: -12 });
sale('g2', { title: '2017 Panini Prizm Patrick Mahomes II #269 Silver Prizm BGS9.5', price: 2400, day: -9 });
sale('g3', { title: '2017 Panini Prizm Patrick Mahomes II #269 Silver Prizm PSA 10', price: 3100, day: -6 });

// ---- the same auto at two different print runs -----------------------------
//
// A Cam Ward auto /5 and a Cam Ward auto /10 are different cards with very
// different prices, and EVERY column is identical for both: same player, year,
// set, card number, and both read as kind "auto". Only the title separates
// them. Different player from the rows above so they form their own card.
sale('p1', { title: '2017 Panini Prizm Rookie Auto Cam Ward #40 /5', price: 1400, day: -20, player: 'Cam Ward', number: '40' });
sale('p2', { title: '2017 Panini Prizm Rookie Auto Cam Ward #40 /5', price: 1250, day: -9,  player: 'Cam Ward', number: '40' });
sale('p3', { title: '2017 Panini Prizm Rookie Auto Cam Ward #40 /10', price: 520, day: -17, player: 'Cam Ward', number: '40' });
sale('p4', { title: '2017 Panini Prizm Rookie Auto Cam Ward #40 /10', price: 480, day: -6,  player: 'Cam Ward', number: '40' });
// Same card, run not stated. Must NOT be split off — silence about a print run
// is not evidence of one, which is where the rule differs from `kind`.
sale('p5', { title: '2017 Panini Prizm Rookie Auto Cam Ward #40', price: 900, day: -13, player: 'Cam Ward', number: '40' });

// A different card entirely: same player, same year, same set, different
// number. It must never be grouped in, whatever its parallel says.
sale('x1', { title: '2017 PANINI PRIZM INSTANT IMPACT #8 PATRICK MAHOMES II',
             price: 223.05, day: -15, number: '8' });

// ---- the insert that shares a number with the base card --------------------
//
// The case from the original report, in the form that actually collides. 2017
// Prizm has a base #8 AND an Instant Impact #8 AND eight more sets at #8, all
// arriving as "Prizm #8" because set_name holds the product. These are a
// DIFFERENT player from the Mahomes rows above so they form their own card, and
// the only thing separating them from each other is the insert name.
sale('n1', { title: '2017 Panini Prizm Dalvin Cook #8 (RC)', price: 14, day: -21, player: 'Dalvin Cook' });
sale('n2', { title: '2017 Panini Prizm Dalvin Cook #8 (RC)', price: 16, day: -12, player: 'Dalvin Cook' });
sale('n3', { title: '2017 Panini Prizm Instant Impact Dalvin Cook #8', price: 190, day: -19, player: 'Dalvin Cook' });
sale('n4', { title: '2017 Panini Prizm Instant Impact Dalvin Cook #8', price: 205, day: -8, player: 'Dalvin Cook' });

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

  // The kind filter applies on THIS path too, and asserting only that the
  // endpoint answered did not test that: removing the filter from the fallback
  // changed the count and every check still passed. The fallback is where the
  // data is already weakest, so letting autographs back in here is the worst
  // place to do it.
  const murkyIds = new Set((murky.grades || []).flatMap(g => g.recent.map(r => r.itemUrl)));
  check('  ...and still keeps autographs and relics out',
        !['u1', 'u2', 'u3'].some(id => [...murkyIds].some(u => u.endsWith('/' + id))),
        `otherKinds=${murky.identity && murky.identity.otherKinds}`);

  check('  ...and says the identity is unresolved rather than claiming one',
        murky.identity && murky.identity.parallel === null,
        murky.identity ? JSON.stringify(murky.identity) : 'no identity block');

  const wild = (murky.grades || []).find(g => g.label === 'Raw');
  check('  ...and refuses a trend across prices that cannot be one card',
        wild && wild.changePct === null && !!wild.trendSuppressed,
        wild ? `changePct=${wild.changePct} low=${wild.low} high=${wild.high} suppressed=${wild.trendSuppressed || 'no'}`
             : 'no Raw series');

  // ---- the autograph of the same card is a different card -----------------
  //
  // Same player, same year, same product, same card number, same (empty)
  // parallel column. Only the title says one is signed. Before this, all three
  // kinds sat in one median.
  const baseIds2 = new Set((base.grades || []).flatMap(g => g.recent.map(r => r.itemUrl)));
  check('the autograph version is NOT grouped with the base card',
    !['u1', 'u2'].some(id => [...baseIds2].some(u => u.endsWith('/' + id))),
    'an auto and a base card share every column but the title');
  check('  ...nor is the relic version',
    ![...baseIds2].some(u => u.endsWith('/u3')),
    'a patch card is a third card again');
  check('  ...and the payload counts them rather than hiding the split',
    base.identity && base.identity.otherKinds >= 3,
    base.identity ? `otherKinds=${base.identity.otherKinds}` : 'no identity block');

  // Clicking the auto gets the autos — both spellings, and nothing else.
  const auto = await call('/api/card-analysis?itemId=u1');
  const autoIds = new Set((auto.grades || []).flatMap(g => g.recent.map(r => r.itemUrl)));
  check('clicking the autograph gets the autographs',
    auto.available === true && auto.totalSales === 2
      && ['u1', 'u2'].every(id => [...autoIds].some(u => u.endsWith('/' + id))),
    `${auto.totalSales} sales, kind=${auto.identity && auto.identity.kind}`);
  check('  ...and not the $20 base cards',
    !['b1', 'b2', 'b3', 'b4'].some(id => [...autoIds].some(u => u.endsWith('/' + id))),
    'base money in an autograph median is the merge in the other direction');

  // ---- the insert that shares a number with the base card -----------------
  //
  // Both are "2017 Prizm Dalvin Cook #8" in every column. Only the title says
  // one is an Instant Impact. Before this they were one card with a median
  // somewhere between $16 and $190, describing neither.
  const plain = await call('/api/card-analysis?itemId=n1');
  const plainIds = new Set((plain.grades || []).flatMap(g => g.recent.map(r => r.itemUrl)));
  check('the base card does not absorb the insert sharing its number',
    plain.available === true && plain.totalSales === 2
      && !['n3', 'n4'].some(id => [...plainIds].some(u => u.endsWith('/' + id))),
    `${plain.totalSales} sales, otherSubsets=${plain.identity && plain.identity.otherSubsets}`);

  const ins2 = await call('/api/card-analysis?itemId=n3');
  const insIds = new Set((ins2.grades || []).flatMap(g => g.recent.map(r => r.itemUrl)));
  check('  ...and the insert gets its own two sales, not the base card\'s',
    ins2.available === true && ins2.totalSales === 2
      && !['n1', 'n2'].some(id => [...insIds].some(u => u.endsWith('/' + id))),
    `${ins2.totalSales} sales`);

  // The point of all of it: the medians now describe different cards.
  {
    const m1 = (plain.grades || [])[0], m2 = (ins2.grades || [])[0];
    check('  ...so the two medians are genuinely different numbers',
      m1 && m2 && Math.abs(m1.median - m2.median) > 100,
      m1 && m2 ? `base $${m1.median} vs insert $${m2.median}` : 'missing a series');
  }

  // ---- the same auto at two different print runs --------------------------
  const five = await call('/api/card-analysis?itemId=p1');
  const fiveIds = new Set((five.grades || []).flatMap(g => g.recent.map(r => r.itemUrl)));
  check('a /5 auto is not averaged with the /10',
    five.available === true && !['p3', 'p4'].some(id => [...fiveIds].some(u => u.endsWith('/' + id))),
    `printRun=${five.identity && five.identity.printRun}, `
    + `otherPrintRuns=${five.identity && five.identity.otherPrintRuns}`);

  // The rule that separates this from the `kind` filter: silence is not
  // evidence. A sale that states no run stays with whatever it was grouped
  // with, because a /199 goes unstated often enough that splitting on silence
  // would tear real cards apart.
  check('  ...but a sale that states no run at all is NOT split off',
    [...fiveIds].some(u => u.endsWith('/p5')),
    'an unstated print run merges; only a stated, different one separates');

  const ten = await call('/api/card-analysis?itemId=p3');
  const tenIds = new Set((ten.grades || []).flatMap(g => g.recent.map(r => r.itemUrl)));
  check('  ...and the /10 gets its own history',
    ten.available === true && !['p1', 'p2'].some(id => [...tenIds].some(u => u.endsWith('/' + id))),
    `printRun=${ten.identity && ten.identity.printRun}`);

  // The point of it: the medians describe different cards.
  {
    const a5 = (five.grades || [])[0], a10 = (ten.grades || [])[0];
    check('  ...so the two medians are genuinely different numbers',
      a5 && a10 && a5.median > a10.median * 1.5,
      a5 && a10 ? `/5 $${a5.median} vs /10 $${a10.median}` : 'missing a series');
  }

  // ---- the explain mode: WHY is this sale in this list? --------------------
  //
  // The grouping runs on database columns plus four separate title reads, and
  // when the result looks wrong from outside there is no way to tell which of
  // them said yes. A slab in the Raw list could be an empty grade column, a
  // title that never names the grade, or the bucket rule — three different
  // fixes. This reports the signals rather than the verdict.
  {
    const ex = await call('/api/card-analysis?itemId=b1&explain=1');
    check('explain mode reports what was read from the clicked sale',
      ex.explain === true && ex.seed && ex.seed.read
        && ex.seed.read.kind === 'base' && typeof ex.seed.columns.set_name === 'string',
      ex.seed ? JSON.stringify(ex.seed.read) : 'no seed block');

    check('  ...and gives a reason for every candidate it dropped',
      Array.isArray(ex.trace) && ex.trace.length > 0
        && ex.trace.filter(t => t.verdict === 'dropped').every(t => t.why && t.why.length > 3),
      `${(ex.trace || []).length} traced, `
      + `${(ex.trace || []).filter(t => t.verdict === 'dropped').length} dropped`);

    // The reasons have to be distinguishable, or the trace cannot point at a
    // fix. These are the three that matter on a real card.
    const reasons = new Set((ex.trace || []).filter(t => t.verdict === 'dropped')
      .map(t => String(t.why).split(':')[0]));
    check('  ...naming which rule excluded it, not just that one did',
      reasons.size >= 2,
      [...reasons].join(' | '));

    // Every traced row carries the columns AND the title reads side by side,
    // which is what separates "the collector parsed it wrong" from "our reader
    // read it wrong".
    const t0 = (ex.trace || [])[0];
    check('  ...with the raw columns beside what we read from the title',
      t0 && t0.columns && t0.read && 'gradeBucket' in t0.read && 'printRun' in t0.read,
      t0 ? Object.keys(t0.read).join(', ') : 'no rows');

    // A trace must never be served from cache: it is a question about the
    // grouping right now.
    const again = await call('/api/card-analysis?itemId=b1');
    check('  ...and the trace never replaces the cached payload',
      again.explain === undefined && again.available === true,
      'a cached trace would answer about a grouping that no longer exists');
  }

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

  // ---- the cached answer must not outlive the code that produced it -------
  //
  // THE FAILURE THIS PREVENTS, which already happened once. Card groupings are
  // cached in KV for 30 minutes under a hand-written version, and every change
  // to identity so far has bumped it — v4, v5, v6. The change after those did
  // not. The fix deployed, this suite passed, and the site went on serving the
  // old grouping for half an hour to the person who had reported the bug. From
  // outside it looked exactly like the work had never shipped.
  //
  // A convention that has to be remembered will eventually not be, so it is
  // enforced instead: the modules that decide the grouping are hashed, and the
  // hash is pinned beside the version. Change one without bumping the other and
  // this fails.
  {
    const crypto = require('crypto');
    const srv = require(path.join(ROOT, 'server.js'));
    const h = crypto.createHash('sha256');
    for (const f of srv.CARD_IDENTITY_MODULES) {
      h.update(f).update(fs.readFileSync(path.join(ROOT, f)));
    }
    const actual = h.digest('hex').slice(0, 12);
    check('the cache version matches the identity code it was written for',
      actual === srv.CARD_IDENTITY_FINGERPRINT,
      actual === srv.CARD_IDENTITY_FINGERPRINT
        ? `${srv.CARD_IDENTITY_VERSION} @ ${actual}`
        : `${srv.CARD_IDENTITY_MODULES.join(', ')} changed since ${srv.CARD_IDENTITY_VERSION} `
          + `was set. Bump CARD_IDENTITY_VERSION and set CARD_IDENTITY_FINGERPRINT `
          + `to '${actual}', or every visitor keeps the old grouping for ${'30 minutes'}.`);

    // The version has to be part of the key it versions. A constant that is
    // bumped but never read is the same bug with more ceremony.
    const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    check('  ...and the version is actually used in the cache key',
      /cacheKey = `\$\{CARD_IDENTITY_VERSION\}:/.test(src),
      'the cache key must be built from CARD_IDENTITY_VERSION');
  }

  server.close();
  console.log(failures ? `\n${failures} check(s) failed` : '\nall card-analysis checks passed');
  process.exit(failures ? 1 : 0);
})().catch(err => { console.error(err); server.close(); process.exit(1); });
