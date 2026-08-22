// Does the index recover a price trend it is given?
//
// The unit-style checks in market-index.test.js prove the index ignores volume.
// They do not prove it reports the right MAGNITUDE, and they run on a fixture
// small enough to hide scale bugs. This file builds a market-shaped dataset —
// ~100k sales, a large majority of them cards that sell exactly once — where
// prices follow a known continuous trend, and asserts the index finds it.
//
// It exists because the whole-market view once returned "not enough repeat
// sales" on a dataset with 14,000 of them: the query capped its result by row
// count, and since a GROUP BY returns rows ordered by its grouping columns,
// the cap kept only the newest time bucket. Nothing could pair. A single-player
// fixture could never have caught it, because one player never hits the cap.
let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (err) {
  console.error('FAIL  node:sqlite unavailable on ' + process.version + ' — needs Node 22.5+.');
  process.exit(1);
}
const path = require('path');

const DAY = 86400000;
const iso = (o) => new Date(Date.now() + o * DAY).toISOString().slice(0, 10);

function buildDb(driftPct) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE sales (item_id TEXT, sold_date TEXT, title TEXT, price_cents INTEGER,
    currency TEXT, listing_format TEXT, grader TEXT, grade TEXT, player TEXT, parallel TEXT,
    year TEXT, set_name TEXT, confidence REAL, best_offer INTEGER, bids INTEGER, image_url TEXT)`);
  const priceAt = (d, base) => base * Math.pow(1 + driftPct / 100, (d + 35) / 30);
  db.exec('BEGIN');
  const ins = db.prepare(`INSERT INTO sales
    (item_id, sold_date, price_cents, player, year, set_name, parallel, grader, grade, confidence, image_url)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  let n = 0;
  // A real card market has a concentrated head and a very long tail, and the
  // index is built to track the head. So: 200 traded players with a dozen cards
  // each, and 20,000 names that sold once and never again. The basket should
  // find the head and ignore the tail entirely.
  for (let p = 0; p < 200; p++) {
    for (let c = 0; c < 12; c++) {
      const base = 2000 + (c === 0 ? 20000 : 0) + c * 400;   // card 0 is the key rookie
      const times = c < 10 ? 14 : 4;
      for (let k = 0; k < times; k++) {
        const d = -Math.floor(Math.random() * 34) - 1;
        // The photo URL carries its own sale date so the "newest sale that had
        // a photo wins" rule can be checked from the outside.
        ins.run(`h${n++}`, iso(d), Math.round(priceAt(d, base)), `Star ${p}`,
                '2023', 'Prizm', `Var${c}`, '', '', 0.9,
                `https://img.test/${iso(d)}.jpg`);
      }
    }
  }
  for (let c = 0; c < 20000; c++) {
    ins.run(`s${n++}`, iso(-Math.floor(Math.random() * 35)), 5000, `Junk ${c}`,
            '2023', 'Prizm', 'Base', '', '', 0.9, null);
  }
  db.exec('COMMIT');
  return { db, sales: n };
}

let active = null;
// Each scenario builds its own in-memory database, and several hold six figures
// of rows. Handing over without closing the previous one leaves that native
// memory held for the rest of the run, which is fine on a workstation and not
// fine on a CI runner. Always swap through here.
function use(db) {
  if (active && active !== db) { try { active.close(); } catch (_) { /* already gone */ } }
  active = db;
}
const d1 = {
  prepare(sql) {
    // Deliberately NOT collapsing whitespace. An earlier version did, for
    // readability, and it rewrote the two-space literal inside
    // REPLACE(col, '  ', ' ') into a single space — silently disabling the
    // key normalisation this suite is meant to verify. D1 does not rewrite
    // SQL, so neither may the stub.
    const clean = sql;
    let bound = [];
    const api = {
      bind(...a) { bound = a; return api; },
      all() { return { results: active.prepare(clean).all(...bound) }; },
      // D1's write API. The index only reads, but the alias backfill writes,
      // and a stub without these silently skips the code path under test.
      run() { return { success: true, meta: active.prepare(clean).run(...bound) }; },
      first() { return active.prepare(clean).get(...bound) || null; },
    };
    return api;
  },
  batch(stmts) { return stmts.map(st => st.run()); },
};
require(path.join(__dirname, '..', 'db.js')).getNflDb = () => d1;
process.env.CF_WORKER = '1';
const { app, backfillPlayerAliases } = require(path.join(__dirname, '..', 'server.js'));
const { resolvePlayer, norm: normPlayer } = require(path.join(__dirname, '..', 'card-index.js'));
const PORT = 3196;
const server = app.listen(PORT);

const call = async (url) => {
  const r = await fetch(`http://127.0.0.1:${PORT}${url}`);
  return { status: r.status, body: await r.json() };
};

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

(async () => {
  for (const drift of [10, 0, -20]) {
    const built = buildDb(drift);
    use(built.db);
    // No KV binding in this harness, so cacheGet always misses and each
    // scenario really is recomputed against its own dataset.
    const r = await (await fetch(`http://127.0.0.1:${PORT}/api/market-index?days=30`)).json();
    const got = r.available ? r.changePct : null;
    const within = got !== null && Math.abs(got - drift) <= Math.max(3, Math.abs(drift) * 0.25);
    check(`market index recovers a ${drift > 0 ? '+' : ''}${drift}% trend`, within,
          r.available ? `reported ${got > 0 ? '+' : ''}${got}% on ${built.sales} sales, matched=${r.matchedCards}`
                      : `FAILED: ${r.reason}`);
    // The bug this file exists for: a market full of single-sale cards must
    // still pair up.
    // The itemised basket is what makes the number auditable, so it has to
    // arrive populated, labelled, and consistent with the index. It is its own
    // endpoint — see the comment on /api/market-basket for why.
    const bres = await call(`/api/market-basket?days=30`);
    const basket = bres.body && bres.body.available && Array.isArray(bres.body.cards) ? bres.body.cards : [];
    check(`  ...and itemises the cards behind it`,
          basket.length >= 10 && basket.every(c => c.label && c.label !== 'Unknown card' && c.sales > 0),
          basket.length ? `${basket.length} cards, top: "${basket[0].label}" ${basket[0].sales} sold ${basket[0].changePct}%` : 'empty');
    // Photos have to arrive as usable URLs. The date the query prefixes to sort
    // by must be gone: leaving it on yields "2026-08-01|https://..." in a src.
    const withPhoto = basket.filter(c => typeof c.imageUrl === 'string' && c.imageUrl.startsWith('https://img.test/'));
    check(`  ...and carries a photo for each, sort key stripped`,
          withPhoto.length === basket.length && !basket.some(c => String(c.imageUrl).includes('|')),
          `${withPhoto.length}/${basket.length} usable, e.g. ${basket[0] && basket[0].imageUrl}`);
    // Card moves should point the same way as the index, not contradict it.
    if (basket.length && drift !== 0) {
      const withMove = basket.filter(c => c.changePct != null);
      const agreeing = withMove.filter(c => (c.changePct > 0) === (drift > 0)).length;
      check(`  ...and those cards agree with the index direction`,
            withMove.length > 0 && agreeing / withMove.length >= 0.8,
            `${agreeing}/${withMove.length} moved the same way as the ${drift > 0 ? 'rising' : 'falling'} index`);
    }

    // The basket must find the head and ignore the 20,000 one-sale names.
    check(`  ...and builds its basket from the traded head, not the tail`,
          r.available && r.matchedCards >= 30,
          r.available ? `players/bucket=${r.matchedCards} weakest=${r.minMatchedInAnyStep} gap=${r.typicalGapDays}d obs=${r.totalObservations}` : 'n/a');
  }
  // The specific fix for Card Ladder's time-attribution error. Two markets
  // drift by the same amount; in one, cards resell quickly, in the other they
  // resell slowly. Their raw price ratios differ a lot — a card reappearing
  // after 20 days has moved further than one reappearing after 4 — so an index
  // that applies the whole change on the day of resale would read them very
  // differently. Normalising each observation to a per-day rate should make
  // them agree.
  const readings = {};
  for (const [label, gapDays] of [['fast resales', 4], ['slow resales', 20]]) {
    const db2 = new DatabaseSync(':memory:');
    db2.exec(`CREATE TABLE sales (item_id TEXT, sold_date TEXT, title TEXT, price_cents INTEGER,
      currency TEXT, listing_format TEXT, grader TEXT, grade TEXT, player TEXT, parallel TEXT,
      year TEXT, set_name TEXT, confidence REAL, best_offer INTEGER, bids INTEGER, image_url TEXT)`);
    const priceAt = (d, base) => base * Math.pow(1.15, (d + 100) / 30);  // +15%/30d in both
    db2.exec('BEGIN');
    const ins2 = db2.prepare(`INSERT INTO sales
      (item_id, sold_date, price_cents, player, year, set_name, parallel, grader, grade, confidence)
      VALUES (?,?,?,?,?,?,?,?,?,?)`);
    let m = 0;
    for (let c = 0; c < 15000; c++) {
      const base = 5000 + (c % 40) * 300;
      // Sales spaced gapDays apart, so every pair is measured over that gap.
      // The span is the same for both so the only difference is the spacing —
      // it has to be long enough that the slow case still clears the history
      // guard, or the comparison tests nothing.
      // Stagger each card's schedule, or every card sells on the same dates and
      // whole buckets come back empty — which is a fixture artefact, not
      // something a real market does.
      for (let d = -95 + (c % gapDays); d <= -1; d += gapDays) {
        ins2.run(`g${m++}`, iso(d), Math.round(priceAt(d, base)), `Gap ${c}`,
                 '2023', 'Prizm', 'Base', '', '', 0.9);
      }
    }
    db2.exec('COMMIT');
    use(db2);
    const r = await (await fetch(`http://127.0.0.1:${PORT}/api/market-index?days=30`)).json();
    readings[label] = r.available ? r.changePct : null;
    console.log(`      ${label} (${gapDays}d apart): index ${r.available ? (r.changePct > 0 ? '+' : '') + r.changePct + '%' : r.reason}, median gap seen ${r.typicalGapDays}d`);
  }
  const spread = Math.abs(readings['fast resales'] - readings['slow resales']);
  check('same drift reads the same whether cards resell fast or slowly', spread <= 3,
        `fast=${readings['fast resales']}%  slow=${readings['slow resales']}%  spread=${spread.toFixed(1)}pp`);

  // Name fragmentation. The live player column holds ~15x more distinct values
  // than there are footballers, because it is parsed from listing titles. Each
  // variant splits one card into several that can never pair, so the index
  // groups on a normalised key. This writes the same 4,000 cards under six
  // spellings each and checks they come back together.
  {
    const dbF = new DatabaseSync(':memory:');
    dbF.exec(`CREATE TABLE sales (item_id TEXT, sold_date TEXT, title TEXT, price_cents INTEGER,
      currency TEXT, listing_format TEXT, grader TEXT, grade TEXT, player TEXT, parallel TEXT,
      year TEXT, set_name TEXT, confidence REAL, best_offer INTEGER, bids INTEGER, image_url TEXT)`);
    const spellings = (n) => [n, n.toLowerCase(), n.toUpperCase(), ' ' + n + ' ', n + '.', n.replace(/ /g, '  ')];
    dbF.exec('BEGIN');
    const insF = dbF.prepare(`INSERT INTO sales
      (item_id, sold_date, price_cents, player, year, set_name, parallel, grader, grade, confidence)
      VALUES (?,?,?,?,?,?,?,?,?,?)`);
    let f = 0;
    for (let c = 0; c < 4000; c++) {
      const name = `Player ${c}`;
      for (let k = 0; k < 6; k++) {
        insF.run(`f${f++}`, iso(-Math.floor(Math.random() * 60) - 1), 10000 + c,
                 spellings(name)[Math.floor(Math.random() * 6)],
                 '2023', 'Prizm', 'Base', '', '', 0.9);
      }
    }
    dbF.exec('COMMIT');
    use(dbF);
    const q = await (await fetch(`http://127.0.0.1:${PORT}/api/debug/player-quality`)).json();
    const norm = q.normalisation;
    check('spelling variants collapse to one card each',
          !!norm && norm.players.normalised === 4000,
          norm ? `${norm.players.raw} raw -> ${norm.players.normalised} normalised (merged ${norm.players.merged})`
               : 'no normalisation block returned');
    const idx = await (await fetch(`http://127.0.0.1:${PORT}/api/market-index?days=30`)).json();
    check('  ...and the index pairs them', idx.available && idx.matchedCards > 0,
          idx.available ? `obs/bucket=${idx.matchedCards} total=${idx.totalObservations}` : idx.reason);
  }

  // Which photo represents a card. Listings are relisted constantly and old
  // eBay image URLs go dead, so the newest one wins — but a sale that carried
  // no photo must not win by being newest, or the card shows a placeholder
  // while perfectly good images sit one row down.
  {
    const dbP = new DatabaseSync(':memory:');
    dbP.exec(`CREATE TABLE sales (item_id TEXT, sold_date TEXT, title TEXT, price_cents INTEGER,
      currency TEXT, listing_format TEXT, grader TEXT, grade TEXT, player TEXT, parallel TEXT,
      year TEXT, set_name TEXT, confidence REAL, best_offer INTEGER, bids INTEGER, image_url TEXT)`);
    const insP = dbP.prepare(`INSERT INTO sales
      (item_id, sold_date, price_cents, player, year, set_name, parallel, grader, grade, confidence, image_url)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    // -2 is the newest sale, so it sets `through` and is itself excluded by the
    // one-day trailing guard. In range: -30 (old photo), -20 (the one we want),
    // -10 (newest in range, but no photo).
    insP.run('p1', iso(-30), 10000, 'Photo Guy', '2023', 'Prizm', 'Base', '', '', 0.9, 'https://img.test/old.jpg');
    insP.run('p2', iso(-20), 11000, 'Photo Guy', '2023', 'Prizm', 'Base', '', '', 0.9, 'https://img.test/want.jpg');
    insP.run('p3', iso(-10), 12000, 'Photo Guy', '2023', 'Prizm', 'Base', '', '', 0.9, '');
    insP.run('p4', iso(-2),  13000, 'Photo Guy', '2023', 'Prizm', 'Base', '', '', 0.9, null);
    use(dbP);
    const b = await call('/api/market-basket?days=30');
    const card = ((b.body && b.body.cards) || [])[0];
    check('the newest sale that had a photo supplies it',
          !!card && card.imageUrl === 'https://img.test/want.jpg',
          card ? `got ${card.imageUrl}` : `no card (${b.body && b.body.reason})`);
  }

  // Raw only. The index measures ungraded cards, so slabs must not reach it —
  // and the hard half of that is the slab whose grade the collector failed to
  // parse, which looks exactly like a raw card in the columns and can only be
  // caught in the title.
  //
  // Each name below is one player whose cards trade at a price that identifies
  // the group: raw names run 100 -> 110 across the period, slab names 1000 ->
  // 2000. Presence is checked per name with a player-scoped basket rather than
  // by reading the whole-market basket, because that list is capped at 24 rows
  // ordered by volume then key, so one name can fill every slot and hide the
  // rest — a display artefact that would look exactly like a filter bug.
  {
    const dbG = new DatabaseSync(':memory:');
    dbG.exec(`CREATE TABLE sales (item_id TEXT, sold_date TEXT, title TEXT, price_cents INTEGER,
      currency TEXT, listing_format TEXT, grader TEXT, grade TEXT, player TEXT, parallel TEXT,
      year TEXT, set_name TEXT, confidence REAL, best_offer INTEGER, bids INTEGER, image_url TEXT)`);
    const insG = dbG.prepare(`INSERT INTO sales
      (item_id, sold_date, title, price_cents, player, year, set_name, parallel, grader, grade, confidence)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    let g = 0;
    const sale = (name, parallel, title, cents, grader, grade, d) =>
      insG.run(`g${g++}`, iso(d), title, cents, name, '2023', 'Prizm', parallel, grader, grade, 0.9);

    const RAW = [
      ['Raw Plain',      '2023 Prizm Base'],
      // "ungraded" contains "graded"; it is a raw claim, not a slab.
      ['Raw Claimed',    '2023 Prizm Base RAW ungraded'],
      // Grader abbreviations that live inside ordinary words. ISA/TAG/AGS are
      // left out of the token list precisely so these survive — a filter that
      // discarded every Isaiah would cost far more than those graders are worth.
      ['Isaiah Vintage', '2023 Prizm Isaiah vintage flags mint'],
      // "gem mint" and "mint" are condition claims raw listings make constantly;
      // treating them as slab language would gut the sample.
      ['Raw Mint',       '2023 Prizm Base gem mint sharp corners'],
      ['Raw Pack',       '2023 Prizm Base fresh out of pack'],
      ['Raw Centered',   '2023 Prizm Base well centered nice'],
    ];
    const SLAB = [
      // Fully parsed slab — the easy case.
      ['Slab Parsed',    '2023 Prizm Base PSA 10',        'PSA', '10'],
      // Grade column empty, grader column empty: indistinguishable from raw
      // except in the title. This is the leak the filter exists to stop.
      ['Slab Unparsed',  '2023 Prizm Base PSA 10 GEM MT', '',    ''],
      ['Slab Parens',    '2023 Prizm Base (BGS 9.5)',     '',    ''],
      ['Slab Hyphen',    '2023 Prizm Base SGC-9',         '',    ''],
      ['Slab Worded',    '2023 Prizm Base graded gem',    '',    ''],
      ['Slab Certed',    '2023 Prizm Base cert 12345678', '',    ''],
      // Grader column set but no grade parsed — still unambiguously a slab.
      ['Slab NoNumber',  '2023 Prizm Base',               'CGC', ''],
    ];
    // Genuinely raw listings the filter drops anyway, because their titles name
    // a grader. Pinned deliberately: erring this way costs a little sample,
    // erring the other way puts slab money in a raw index.
    const CONSERVATIVE = [
      ['Raw Candidate',  '2023 Prizm Base raw, PSA 10 candidate'],
      ['Raw Worthy',     '2023 Prizm Base ungraded, BGS 9.5 worthy'],
    ];
    // Each name gets 4 cards selling 5 times across the window, so pairs land in
    // every bucket the 30-day geometry asks for rather than piling into one.
    const DAYS = [-33, -26, -19, -12, -5];
    const spread = (name, title, lo, hi, grader, grade) => {
      for (let c = 0; c < 4; c++) {
        DAYS.forEach((d, i) => {
          const price = Math.round(lo * Math.pow(hi / lo, i / (DAYS.length - 1)));
          sale(name, `Var${c}`, title, price, grader, grade, d);
        });
      }
    };
    for (const [name, title] of RAW) spread(name, title, 10000, 11000, '', '');
    for (const [name, title] of CONSERVATIVE) spread(name, title, 10000, 11000, '', '');
    for (const [name, title, grader, grade] of SLAB) spread(name, title, 100000, 200000, grader, grade);
    sale('Anchor', 'Base', '2023 Prizm Base', 10000, '', '', -2);   // sets `through`
    use(dbG);

    // A name is in the index iff its own scoped basket returns cards.
    const present = async (name) => {
      const r = await call(`/api/market-basket?days=30&player=${encodeURIComponent(name)}`);
      return !!(r.body && r.body.available && (r.body.cards || []).length);
    };
    const leaked = [];
    for (const [name] of SLAB) if (await present(name)) leaked.push(name);
    const kept = [];
    for (const [name] of RAW) if (await present(name)) kept.push(name);
    const trusted = [];
    for (const [name] of CONSERVATIVE) if (await present(name)) trusted.push(name);

    check('no graded sale reaches the index',
          leaked.length === 0,
          leaked.length ? `LEAKED: ${leaked.join(', ')}` : `all ${SLAB.length} slab variants excluded`);
    check('  ...and raw cards are not thrown out with them',
          kept.length === RAW.length,
          `kept ${kept.length}/${RAW.length}${kept.length < RAW.length
            ? ' — missing ' + RAW.map(r => r[0]).filter(n => !kept.includes(n)).join(', ') : ''}`);
    check('  ...while a raw listing naming a grader is dropped, not trusted',
          trusted.length === 0,
          trusted.length ? `admitted: ${trusted.join(', ')}` : `both grader-naming raw listings excluded`);
    // Raw names double-sell 100 -> 110; slabs 1000 -> 2000. A leak would drag
    // the index far above the raw trend, so the magnitude is the real assertion.
    const idx = await call('/api/market-index?days=30');
    check('  ...so the index reads the raw trend, not the slab trend',
          idx.body.available && idx.body.changePct > 0 && idx.body.changePct < 30,
          idx.body.available ? `changePct=${idx.body.changePct}% (a slab leak reads far higher)`
                             : `reason=${idx.body.reason}`);
  }

  // The noise floor. Every other accuracy check prices sales exactly on the
  // trend, which no real comp does — raw cards carry condition variance, and
  // two copies of the same card sell days apart at different money for no
  // reason the index can see. So: markets whose true price never moves, priced
  // with lognormal noise. Whatever the index reports is entirely noise.
  //
  // Two checks, because the interesting property is not cheaply assertable.
  //
  // The reading is averaged over several draws rather than asserted on one: a
  // single draw cannot tell the basket sizes apart, which was checked rather
  // than assumed — at 125 players one draw of this fixture reads 1.0%, inside
  // any sane bound, despite that basket's spread being some five times wider.
  // Averaging helps but does not settle it either (125 players gives a mean
  // absolute of 2.7pp against 1.0pp here, which a bound loose enough not to
  // flake still lets through), so that check is a sanity bound and no more.
  //
  // What actually catches the basket being narrowed is the width assertion
  // below. It is deterministic, and the sweep in server.js is what ties width
  // to the noise floor. Verified both ways: at 125 players the width check
  // fails and the reading check passes.
  {
    // Half the trading volume the basket was tuned against, to keep CI quick.
    // The floor rises with the square root of that; the bound has room for it.
    const flatMarket = (seed) => {
      const dbN = new DatabaseSync(':memory:');
      dbN.exec(`CREATE TABLE sales (item_id TEXT, sold_date TEXT, title TEXT, price_cents INTEGER,
        currency TEXT, listing_format TEXT, grader TEXT, grade TEXT, player TEXT, parallel TEXT,
        year TEXT, set_name TEXT, confidence REAL, best_offer INTEGER, bids INTEGER, image_url TEXT)`);
      let s = seed;
      const rand = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
      const noise = (sigma) => Math.exp(sigma * Math.sqrt(-2 * Math.log(Math.max(rand(), 1e-9)))
                                              * Math.cos(2 * Math.PI * rand()));
      dbN.exec('BEGIN');
      const insN = dbN.prepare(`INSERT INTO sales
        (item_id, sold_date, title, price_cents, player, year, set_name, parallel, grader, grade, confidence)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
      let k = 0;
      // A head-and-tail market to select from, so "top 600" is a real choice out
      // of 1,500 rather than a list that happens to include everyone.
      for (let p = 0; p < 1500; p++) {
        const heat = 200 / (1 + p / 25);
        for (let c = 0; c < 12; c++) {
          const base = 2000 + c * 500;
          const times = Math.max(0, Math.round(heat / (1 + c * 0.8)));
          for (let t = 0; t < times; t++) {
            const d = -1 - Math.floor(rand() * 34);
            insN.run(`n${k++}`, iso(d), '2023 Prizm Base', Math.round(base * noise(0.25)),
                     `Star ${p}`, '2023', 'Prizm', `Var${c}`, '', '', 0.9);
          }
        }
      }
      dbN.exec('COMMIT');
      return { db: dbN, sales: k };
    };

    // Seeded, so a failure is a regression rather than an unlucky day.
    const draws = [];
    let width = 0, obs = 0, sales = 0;
    for (const seed of [20260822, 19870401, 20240915]) {
      const built = flatMarket(seed);
      sales = built.sales;
      use(built.db);
      const r = await call('/api/market-index?days=30');
      if (!r.body.available) { draws.length = 0; break; }
      draws.push(r.body.changePct);
      width = r.body.matchedCards;
      obs = r.body.totalObservations;
    }
    const meanAbs = draws.length
      ? draws.reduce((a, b) => a + Math.abs(b), 0) / draws.length : Infinity;
    check('a market that did nothing reads close to nothing',
          draws.length === 3 && meanAbs <= 3,
          draws.length ? `mean |reading| ${meanAbs.toFixed(1)}pp over ${draws.join('%, ')}% `
                       + `on ${sales.toLocaleString('en-US')} noisy sales each`
                       : 'index unavailable');
    // The width the noise floor depends on, asserted directly because it is
    // deterministic where the floor is not.
    check('  ...because the basket really is that wide',
          width >= 500 && obs >= 15000,
          `${width} players, ${obs.toLocaleString('en-US')} comparisons per point`);
  }

  // Ungraded is not always spelled the same way.
  //
  // The raw filter first assumed one convention: grader and grade empty. A
  // collector can just as reasonably write "Raw" or "None", and under that
  // convention the filter matched NOTHING — which does not thin the index, it
  // takes it off the page, because zero rows reads as "market unavailable".
  // That is what happened in production. Both spellings must work.
  {
    const spellings = [
      ['empty string', '', ''],
      ['NULL',         null, null],
      ['Raw',          'Raw', 'Raw'],
      ['None',         'None', ''],
      ['N/A',          'n/a', 'N/A'],
      ['Ungraded',     'Ungraded', ''],
    ];
    const missed = [];
    for (const [label, grader, grade] of spellings) {
      const dbS = new DatabaseSync(':memory:');
      dbS.exec(`CREATE TABLE sales (item_id TEXT, sold_date TEXT, title TEXT, price_cents INTEGER,
        currency TEXT, listing_format TEXT, grader TEXT, grade TEXT, player TEXT, parallel TEXT,
        year TEXT, set_name TEXT, confidence REAL, best_offer INTEGER, bids INTEGER, image_url TEXT)`);
      dbS.exec('BEGIN');
      const insS = dbS.prepare(`INSERT INTO sales
        (item_id, sold_date, title, price_cents, player, year, set_name, parallel, grader, grade, confidence)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
      let j = 0;
      for (let p = 0; p < 40; p++) {
        for (let c = 0; c < 4; c++) {
          for (let d = -30; d <= -2; d += 4) {
            insS.run(`w${j++}`, iso(d), '2023 Prizm Base', Math.round(10000 * Math.pow(1.1, (d + 30) / 30)),
                     `Star ${p}`, '2023', 'Prizm', `Var${c}`, grader, grade, 0.9);
          }
        }
      }
      dbS.exec('COMMIT');
      use(dbS);
      const r = await call('/api/market-index?days=30');
      if (!r.body.available) missed.push(`${label} -> ${r.body.reason}`);
    }
    check('ungraded reaches the index however the column spells it',
          missed.length === 0,
          missed.length ? `NOT MATCHED: ${missed.join('; ')}`
                        : `all ${spellings.length} spellings scored`);
  }

  // The same sales in a different order must give the same number.
  //
  // Sales sharing a date have no defined order inside the pairing window, and
  // pairs are dropped at gap < 1, so which same-day sale survives to pair across
  // a date boundary was decided by whatever order rows happened to arrive in.
  // On a busy card that is most of the pairs. It was found by adding
  // MATERIALIZED to a CTE — a change that alters row order and nothing else —
  // and watching a flat market go from -0.9% to -67.5%.
  //
  // Collapsing each card's day to one price fixes it at the source. This asserts
  // the property directly instead of the fix, by loading identical data in
  // opposite orders: two sales every trading day, at prices far enough apart
  // that picking the wrong one cannot hide in rounding.
  {
    const readAt = async (reverse) => {
      const dbO = new DatabaseSync(':memory:');
      dbO.exec(`CREATE TABLE sales (item_id TEXT, sold_date TEXT, title TEXT, price_cents INTEGER,
        currency TEXT, listing_format TEXT, grader TEXT, grade TEXT, player TEXT, parallel TEXT,
        year TEXT, set_name TEXT, confidence REAL, best_offer INTEGER, bids INTEGER, image_url TEXT)`);
      const rows = [];
      for (let p = 0; p < 200; p++) {
        for (let c = 0; c < 4; c++) {
          for (let d = -30; d <= -2; d += 4) {
            const mid = 10000 * Math.pow(1.1, (d + 30) / 30);
            // A cheap copy and a dear one on the same day, 40% apart.
            rows.push([iso(d), Math.round(mid * 0.8), `Star ${p}`, `Var${c}`]);
            rows.push([iso(d), Math.round(mid * 1.2), `Star ${p}`, `Var${c}`]);
          }
        }
      }
      if (reverse) rows.reverse();
      dbO.exec('BEGIN');
      const insO = dbO.prepare(`INSERT INTO sales
        (item_id, sold_date, title, price_cents, player, year, set_name, parallel, grader, grade, confidence)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
      rows.forEach(([d, cents, player, parallel], i) =>
        insO.run(`o${i}`, d, '2023 Prizm Base', cents, player, '2023', 'Prizm', parallel, '', '', 0.9));
      dbO.exec('COMMIT');
      use(dbO);
      const r = await call('/api/market-index?days=30');
      return r.body.available ? r.body.changePct : `unavailable: ${r.body.reason}`;
    };
    const forward = await readAt(false);
    const backward = await readAt(true);
    check('the same sales in a different order read the same',
          forward === backward && typeof forward === 'number',
          `forward=${forward}  reversed=${backward}`);
  }

  // Canonical names, end to end: fixture -> backfill -> index.
  //
  // On live data Tom Brady arrives under 80 different spellings and the index
  // treats each as a different player, so his 5,365 sales become fragments of
  // about 67 apiece. Meanwhile parse failures like "Cdt All" stay whole at 796,
  // outranking every real player and taking basket slots. The fixture below is
  // that shape in miniature.
  //
  // Also asserted here, and it is the more important half: an EMPTY alias table
  // must leave the index working. Grouping on a table the backfill has not
  // filled yet would return nothing, which is exactly how the NULL-key outage
  // read to a user.
  {
    const REAL = ['Justin Jefferson', 'Patrick Mahomes', 'Josh Allen', 'Joe Burrow',
                  'Kyler Murray', 'Travis Kelce', 'Tyreek Hill', 'Bijan Robinson'];
    const JUNK = ['Cdt All', 'Signature Class', 'Complete Your Set', 'Or Better'];
    const spellings = (p) => [p, p.toUpperCase(), `${p} RC`, `2023 Prizm ${p}`,
                              `${p} #331`, `${p} PSA 10`];

    const dbA = new DatabaseSync(':memory:');
    dbA.exec(`CREATE TABLE sales (item_id TEXT, sold_date TEXT, title TEXT, price_cents INTEGER,
      currency TEXT, listing_format TEXT, grader TEXT, grade TEXT, player TEXT, parallel TEXT,
      year TEXT, set_name TEXT, confidence REAL, best_offer INTEGER, bids INTEGER, image_url TEXT)`);
    dbA.exec('BEGIN');
    const insA = dbA.prepare(`INSERT INTO sales
      (item_id, sold_date, title, price_cents, player, year, set_name, parallel, grader, grade, confidence)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    let a = 0;
    const sell = (name, parallel, cents, d) =>
      insA.run(`a${a++}`, iso(d), '2023 Prizm Base', cents, name, '2023', 'Prizm', parallel, '', '', 0.9);
    // Each real player: six spellings x four cards, rising 10% over the window.
    for (const p of REAL) {
      for (const spelling of spellings(p)) {
        for (let c = 0; c < 4; c++) {
          for (let d = -30; d <= -2; d += 4) {
            sell(spelling, `Var${c}`, Math.round(10000 * Math.pow(1.1, (d + 30) / 30)), d);
          }
        }
      }
    }
    // Junk strings stay whole and trade heavily, as they do in the real data.
    for (const j of JUNK) {
      for (let c = 0; c < 4; c++) {
        for (let d = -30; d <= -2; d += 2) sell(j, `Var${c}`, 50000, d);
      }
    }
    dbA.exec('COMMIT');
    use(dbA);

    const before = await call('/api/market-index?days=30');
    check('an empty alias table leaves the index working',
          before.body.available === true,
          before.body.available ? `${before.body.matchedCards} players (fragmented), ${before.body.changePct}%`
                                : `BROKE: ${before.body.reason}`);

    const fill = await backfillPlayerAliases({ limit: 500 });
    check('  ...then the backfill resolves the variants',
          fill.ok && fill.resolved >= REAL.length,
          fill.ok ? `${fill.inserted} variants written, ${fill.resolved} resolved`
                  : `FAILED: ${fill.reason}`);

    // Resumability is what makes chunked writes safe: if a chunk fails midway,
    // the next run must pick up from there rather than redo everything or
    // duplicate it. The backfill skips variants that already have a row, so a
    // second pass over the same data has nothing left to do.
    const again = await backfillPlayerAliases({ limit: 500 });
    check('  ...and running it again has nothing left to do',
          again.ok && again.inserted === 0,
          again.ok ? `${again.inserted} inserted on the second pass` : `FAILED: ${again.reason}`);

    const after = await call('/api/market-index?days=30');
    const bres = await call('/api/market-basket?days=30');
    const names = ((bres.body && bres.body.cards) || []).map(c => c.label);
    check('  ...and the index then groups on canonical names',
          after.body.available === true && after.body.matchedCards < before.body.matchedCards,
          `${before.body.matchedCards} player strings -> ${after.body.matchedCards} canonical players`);
    check('  ...with the parse failures no longer taking basket slots',
          names.length > 0 && !names.some(l => JUNK.some(j => l.includes(j))),
          names.length ? `basket: ${[...new Set(names.map(l => l.replace(/^\d+ \w+ /, '')))].slice(0, 4).join(', ')}`
                       : 'empty');
  
    // Partial coverage is the normal state, not an edge case: the backfill
    // reaches names head-first over hours. Every level of it must be an
    // improvement on none, so a name with no alias row yet has to keep working
    // exactly as it did before rather than dropping out of the market.
    {
      const dbP2 = new DatabaseSync(':memory:');
      dbP2.exec(`CREATE TABLE sales (item_id TEXT, sold_date TEXT, title TEXT, price_cents INTEGER,
        currency TEXT, listing_format TEXT, grader TEXT, grade TEXT, player TEXT, parallel TEXT,
        year TEXT, set_name TEXT, confidence REAL, best_offer INTEGER, bids INTEGER, image_url TEXT)`);
      dbP2.exec(`CREATE TABLE player_alias (variant TEXT PRIMARY KEY, canonical TEXT NOT NULL,
        display TEXT NOT NULL, how TEXT, resolved INTEGER NOT NULL DEFAULT 1, n INTEGER, updated_at TEXT)`);
      dbP2.exec('BEGIN');
      const insP2 = dbP2.prepare(`INSERT INTO sales
        (item_id, sold_date, title, price_cents, player, year, set_name, parallel, grader, grade, confidence)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
      let q = 0;
      const sell2 = (name, parallel, cents, d) =>
        insP2.run(`q${q++}`, iso(d), '2023 Prizm Base', cents, name, '2023', 'Prizm', parallel, '', '', 0.9);
      const COVERED = ['Justin Jefferson', 'Patrick Mahomes', 'Josh Allen', 'Joe Burrow'];
      const NOT_YET = ['Kyler Murray', 'Travis Kelce', 'Tyreek Hill', 'Bijan Robinson'];
      for (const p2 of [...COVERED, ...NOT_YET]) {
        for (const spelling of [p2, `${p2} RC`, `2023 Prizm ${p2}`]) {
          for (let c = 0; c < 4; c++) {
            for (let d = -30; d <= -2; d += 4) {
              sell2(spelling, `Var${c}`, Math.round(10000 * Math.pow(1.1, (d + 30) / 30)), d);
            }
          }
        }
      }
      sell2('Cdt All', 'Var0', 50000, -10);   // junk, and aliased as unresolved
      dbP2.exec('COMMIT');
      // Only half the roster has been reached, exactly as mid-backfill looks.
      const insAl = dbP2.prepare(`INSERT INTO player_alias
        (variant, canonical, display, how, resolved, n) VALUES (?,?,?,?,?,?)`);
      for (const p2 of COVERED) {
        for (const spelling of [p2, `${p2} RC`, `2023 Prizm ${p2}`]) {
          const hit = resolvePlayer(spelling);
          insAl.run(normPlayer(spelling), hit.key, hit.canonical, hit.how, 1, 100);
        }
      }
      insAl.run(normPlayer('Cdt All'), 'cdt all', 'Cdt All', 'none', 0, 500);
      use(dbP2);

      const r2 = await call('/api/market-index?days=30');
      const b2 = await call('/api/market-basket?days=30&days=30');
      const labels = ((b2.body && b2.body.cards) || []).map(c => c.label);
      const coveredSeen = COVERED.filter(p2 => labels.some(l => l.includes(p2)));
      const uncoveredSeen = NOT_YET.filter(p2 => labels.some(l => l.includes(p2)));
      check('  ...and a half-filled table still counts the names it has not reached',
            r2.body.available === true && uncoveredSeen.length > 0,
            r2.body.available
              ? `${coveredSeen.length}/${COVERED.length} aliased and ${uncoveredSeen.length}/${NOT_YET.length} not-yet-aliased players present`
              : `BROKE: ${r2.body.reason}`);
      check('  ...while junk already marked unresolved stays out',
            !labels.some(l => l.includes('Cdt All')),
            labels.length ? `${labels.length} cards, no junk` : 'empty');
    }
  }

  server.close();
  console.log(failures ? `\n${failures} check(s) failed` : '\nall accuracy checks passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('THREW:', e && e.stack || e); process.exit(1); });
