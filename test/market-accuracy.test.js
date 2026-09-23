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

// The sales table, as the live one has it — including card_number, which is
// how the index tells one base card from another.
//
// The fixtures below were written when a card was keyed on its parallel, so
// they model a player's distinct cards as parallels Var0, Var1, ... The index
// now tracks BASE cards only (server.js, RSI_BASE_CARD) and identifies them by
// number, so the trigger reads each fixture's intent that way: "Var<n>" is
// that player's base card #n+1, and "Base" is base card #1. Rows that set a
// card_number themselves are left exactly as written.
function salesTable(db) {
  db.exec(`CREATE TABLE sales (item_id TEXT, sold_date TEXT, title TEXT, price_cents INTEGER,
    currency TEXT, listing_format TEXT, grader TEXT, grade TEXT, player TEXT, parallel TEXT,
    year TEXT, set_name TEXT, card_number TEXT, confidence REAL, best_offer INTEGER, bids INTEGER,
    image_url TEXT)`);
  db.exec(`CREATE TRIGGER var_is_card_number AFTER INSERT ON sales
    WHEN NEW.card_number IS NULL AND (NEW.parallel GLOB 'Var[0-9]*' OR NEW.parallel = 'Base')
    BEGIN
      UPDATE sales SET
        card_number = CASE WHEN NEW.parallel = 'Base' THEN '1'
                           ELSE CAST(CAST(substr(NEW.parallel, 4) AS INTEGER) + 1 AS TEXT) END,
        parallel = CASE WHEN NEW.parallel = 'Base' THEN 'Base' ELSE '' END
      WHERE rowid = NEW.rowid;
    END`);
}

function buildDb(driftPct) {
  const db = new DatabaseSync(':memory:');
  salesTable(db);
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
    salesTable(db2);
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
    salesTable(dbF);
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
    salesTable(dbP);
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
    salesTable(dbG);
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
      salesTable(dbN);
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
    let width = 0, perPoint = 0, obs = 0, sales = 0, flatBasket = [], geometry = null;
    const playerReadings = [], playerOutcome = new Map();
    for (const seed of [20260822, 19870401, 20240915]) {
      const built = flatMarket(seed);
      sales = built.sales;
      use(built.db);
      const r = await call('/api/market-index?days=30');
      if (!r.body.available) { draws.length = 0; break; }
      draws.push(r.body.changePct);
      width = r.body.basketPlayers;
      perPoint = r.body.matchedCards;
      obs = r.body.totalObservations;
      geometry = { bucketDays: r.body.bucketDays, points: (r.body.series || []).length };
      // Players from busiest to barely trading. Star 400 sells a few times a
      // week across all their cards, too thin for daily points.
      for (const who of ['Star 0', 'Star 5', 'Star 20', 'Star 60', 'Star 150', 'Star 400']) {
        const pr = await call(`/api/player-index?days=30&player=${encodeURIComponent(who)}`);
        const got = pr.body.available
          ? `${(pr.body.series || []).length}pts${pr.body.estimated ? '~est' : ''}` : pr.body.reason;
        playerOutcome.set(who, (playerOutcome.get(who) || []).concat(got));
        if (pr.body.available) playerReadings.push(pr.body.changePct);
      }
      const b = await call('/api/market-basket?days=30');
      flatBasket = flatBasket.concat(((b.body && b.body.cards) || []).map(c => c.changePct).filter(v => v != null));
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
    // The list under the number, on the same flat market. Its moves were once
    // computed with the index's pair arithmetic — a day-to-day ratio raised to
    // (bucket / gap) — which is sound across hundreds of players and turns one
    // card's ordinary day-to-day noise into -93.7% or +1500%. That is what the
    // live list showed. On a market that did nothing, a card's move must be
    // noise-sized.
    const absMoves = flatBasket.map(Math.abs).sort((a, b) => a - b);
    const medMove = absMoves.length ? absMoves[absMoves.length >> 1] : Infinity;
    check('  ...and the cards under it read noise-sized moves, not the clamp',
          absMoves.length >= 30 && medMove <= 15 && absMoves[absMoves.length - 1] < 90,
          `median |move| ${medMove}%, largest ${absMoves[absMoves.length - 1]}% over ${absMoves.length} cards`);
    // Width is the basket's player count. It was the players behind a typical
    // point while points were weekly; a daily point holds fewer by design, so
    // that is floored separately rather than standing in for the basket.
    check('  ...because the basket really is that wide',
          width >= 500 && perPoint >= 300 && obs >= 15000,
          `${width} players in the basket, ${perPoint} behind a typical point, `
          + `${obs.toLocaleString('en-US')} comparisons`);
    // This is also the check that daily points are safe: the same flat market,
    // drawn one day at a time, still reads close to nothing. Averaging the two
    // middle ratios arithmetically once read it at +5% a month, entirely from
    // players with two comparisons in a day.
    // One player is a far smaller sample than the market. Their number was
    // once the market's chained index scoped to them, and on this flat market
    // it wandered: mean |reading| 9.7pp drawn daily, 19.5pp weekly, with single
    // readings past +100%. Live, it put Fernando Mendoza at -53% while his main
    // card was down 12%. A player is now read as a price level — each card
    // against its own typical price, the last week against the first — which
    // reads 3.0pp here (3.5pp with the live data's 14 missing days). The bound
    // catches a return to chaining with room over what it reads.
    const playerMean = playerReadings.length
      ? playerReadings.reduce((a, v) => a + Math.abs(v), 0) / playerReadings.length : Infinity;
    check('  ...and a player on it reads close to nothing too',
          playerReadings.length >= 12 && playerMean <= 6
          && playerReadings.every(v => Math.abs(v) <= 15),
          `mean |reading| ${playerMean.toFixed(1)}pp, largest ${Math.max(...playerReadings.map(Math.abs))}pp `
          + `over ${playerReadings.length} player readings`);
    // Busy players get a measured point per day. One trading a few times a
    // week gets an estimate — windows reaching back for enough sales, flagged
    // so the page says so — or, where even that cannot separate a first window
    // from a last, no number. Never an unflagged number. (Its estimates are in
    // the mean and the 15pp bound above.)
    const drawn = ['Star 0', 'Star 5', 'Star 20'].every(w =>
      (playerOutcome.get(w) || []).length && playerOutcome.get(w).every(x => /^\d+pts$/.test(x) && parseInt(x, 10) >= 20));
    const thinOk = (playerOutcome.get('Star 400') || []).length
      && playerOutcome.get('Star 400').every(x => /~est$/.test(x) || x === 'not enough sales for a reliable reading')
      && playerOutcome.get('Star 400').some(x => /~est$/.test(x));
    check('  ...busy players get measured daily points, a thin one an estimate flagged as one',
          drawn && thinOk,
          [...playerOutcome].map(([w, xs]) => `${w}: ${xs.join('/')}`).join(', '));
    check('  ...drawn one point per day',
          geometry && geometry.bucketDays === 1 && geometry.points === 31,
          geometry ? `bucket ${geometry.bucketDays}d, ${geometry.points} points` : 'index unavailable');
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
    const sparseBuckets = new Set();
    for (const [label, grader, grade] of spellings) {
      const dbS = new DatabaseSync(':memory:');
      salesTable(dbS);
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
      else sparseBuckets.add(r.body.bucketDays);
    }
    check('ungraded reaches the index however the column spells it',
          missed.length === 0,
          missed.length ? `NOT MATCHED: ${missed.join('; ')}`
                        : `all ${spellings.length} spellings scored`);
    // These markets trade one day in four, so most days are unmeasured and a
    // daily chain cannot be drawn. The index must fall back to weekly points
    // rather than go unavailable.
    check('  ...and a market trading one day in four falls back to weekly points',
          sparseBuckets.size === 1 && sparseBuckets.has(7),
          `bucket sizes used: ${[...sparseBuckets].join(', ') || 'none'}`);
  }

  // A player whose newest days were never collected. Live, every 7-day player
  // view said "not enough sales" because the last two days before the lag had
  // nothing in them. The period now ends on the last day that can be read,
  // says so, and flags the number as estimated; the rise still reads as one.
  {
    const dbE = new DatabaseSync(':memory:');
    salesTable(dbE);
    dbE.exec('BEGIN');
    const insE = dbE.prepare(`INSERT INTO sales
      (item_id, sold_date, title, price_cents, player, year, set_name, parallel, grader, grade, confidence)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    let e = 0;
    for (let c = 0; c < 6; c++) {
      for (let d = -40; d <= -1; d++) {
        if (d >= -4 && d <= -2) continue;            // three uncollected days
        for (let k = 0; k < 2; k++) {
          insE.run(`e${e++}`, iso(d), '2023 Prizm Base', Math.round(10000 * Math.pow(1.2, (d + 40) / 40)),
                   'Gap Guy', '2023', 'Prizm', `Var${c}`, '', '', 0.9);
        }
      }
    }
    // One lone sale on the newest day, the way a partial collection looks.
    insE.run(`e${e++}`, iso(0), '2023 Prizm Base', 12000, 'Gap Guy', '2023', 'Prizm', 'Var0', '', '', 0.9);
    dbE.exec('COMMIT');
    use(dbE);
    const r7 = await call('/api/player-index?player=Gap%20Guy&days=7');
    check('a player whose newest days are missing still gets a 7-day number, flagged as estimated',
          r7.body.available && r7.body.estimated === true && r7.body.shiftedDays > 0 && r7.body.changePct > 0,
          r7.body.available ? `changePct=${r7.body.changePct}% through ${r7.body.through}, shifted ${r7.body.shiftedDays}d`
                            : `reason=${r7.body.reason}`);
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
      salesTable(dbO);
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

  // A card is one card: a base card, with a year, a set and a number.
  //
  // The danger this guards is the bucket that holds several cards at once. It
  // happened: when a blank parallel was keyed as a card, every unreadable sale
  // for a player landed together — base cards, refractors, autos and patches —
  // and "2025 Topps Chrome Jaxson Dart" went on the page at +7,127%. Then, with
  // blank parallels excluded instead, the basket was ALL parallels, and with no
  // card number in the key "Jaxson Dart Refractor" pooled every Refractor he
  // has in the product: -93.7% and +1500% on the live list.
  //
  // So the index now takes base cards only, keyed by number. The sales below
  // are the ways a sale can look like a base card and not be one; none of them
  // may reach the basket, and the real base cards must.
  {
    const dbI = new DatabaseSync(':memory:');
    salesTable(dbI);
    dbI.exec('BEGIN');
    const insI = dbI.prepare(`INSERT INTO sales
      (item_id, sold_date, title, price_cents, player, year, set_name, parallel, card_number, grader, grade, confidence)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
    let z = 0;
    const sellI = (player, year, set_, parallel, number, title, cents, d) =>
      insI.run(`z${z++}`, iso(d), title, cents, player, year, set_, parallel, number, '', '', 0.9);

    for (let p2 = 0; p2 < 40; p2++) {
      const who = `Star ${p2}`;
      for (let c = 0; c < 3; c++) {
        const num = String(300 + c);
        // Every other day: a player's number needs enough card-days in its first
        // and last week to read (PLAYER_TREND_MIN_WINDOW), and every fourth day
        // left three cards with six.
        for (let d = -30; d <= -2; d += 2) {
          const px = Math.round(10000 * Math.pow(1.1, (d + 30) / 30));
          // The real thing: a base card, column blank, title plain.
          sellI(who, '2025', 'Topps Chrome', '', num, `2025 Topps Chrome ${who} #${num} RC`, px, d);
          // Same number, column blank, but the TITLE names what it is — a
          // parallel, a numbered card, an autograph patch. Wildly priced, and
          // not the base card whatever the column says.
          sellI(who, '2025', 'Topps Chrome', '', num, `2025 Topps Chrome ${who} #${num} Gold Refractor`, 50000, d);
          sellI(who, '2025', 'Topps Chrome', '', num, `2025 Topps Chrome ${who} #${num} /99`, 40000, d);
          sellI(who, '2025', 'Topps Chrome', '', num, `2025 Topps Chrome ${who} #${num} Rookie Patch Auto`, 90000, d);
          // Column names a parallel.
          sellI(who, '2025', 'Topps Chrome', 'Refractor', num, `2025 Topps Chrome ${who} #${num}`, 30000, d);
          // Plain title, but no card number: which card is it?
          sellI(who, '2025', 'Topps Chrome', '', '', `2025 Topps Chrome ${who} RC`, d % 8 === 0 ? 500 : 50000, d);
          // No set, no year.
          sellI(who, '2025', '', '', num, `2025 ${who} #${num}`, 30000, d);
          sellI(who, '', 'Topps Chrome', '', num, `Topps Chrome ${who} #${num}`, 30000, d);
        }
      }
    }
    // A base card running hard and reselling fast. Deliberately extreme — 1.5x
    // every two days — because that is where the arithmetic bites: converting a
    // ratio to a per-day rate divides by the gap, so a short gap raises the move
    // to a large power before it is compounded across every bucket. Each ratio
    // still sits inside the pair filter, so only the clamp bounds these.
    for (let p2 = 0; p2 < 12; p2++) {
      const who = `Rocket ${p2}`;
      for (let d = -30; d <= -2; d += 2) {
        sellI(who, '2025', 'Topps Chrome', '', '1', `2025 Topps Chrome ${who} #1 RC`,
              Math.round(500 * Math.pow(1.5, (d + 30) / 2)), d);
      }
    }
    dbI.exec('COMMIT');
    use(dbI);

    const b3 = await call('/api/market-basket?days=30');
    const cards = (b3.body && b3.body.cards) || [];
    check('every card in the basket is a numbered base card',
          cards.length > 0 && cards.every(c => / #\d+$/.test(c.label) && !c.detail),
          cards.length
            ? `${cards.length} cards, e.g. "${cards[0].label}"${cards[0].detail ? ` (${cards[0].detail})` : ''}`
            : 'empty');
    // Every Star base card sells at ~$100-110. Anything a parallel, a /99, an
    // auto or a numberless sale leaked into would average far above that.
    const stars = cards.filter(c => /^2025 Topps Chrome Star /.test(c.label));
    check('  ...priced as the base card, with nothing else mixed in',
          stars.length > 0 && stars.every(c => c.avgPrice >= 95 && c.avgPrice <= 115),
          stars.length ? `Star cards avg $${Math.min(...stars.map(c => c.avgPrice))}–$${Math.max(...stars.map(c => c.avgPrice))}`
                       : 'no Star cards');
    check('  ...so no card is listed twice under one label',
          new Set(cards.map(c => c.label)).size === cards.length,
          `${new Set(cards.map(c => c.label)).size} distinct labels of ${cards.length}`);
    // One Star player's own index: their base cards rise 10%. (The whole-market
    // reading also averages in the Rockets, built to hit the cap, so it is not
    // the number to test here.) A leak of the $300-900 parallels, numbered
    // cards and autos on the same numbers would swing this far off.
    const idx = await call('/api/player-index?player=Star%200&days=30');
    check('  ...and a player\'s index reads their base cards\' trend',
          idx.body.available && idx.body.changePct > 0 && idx.body.changePct < 20,
          idx.body.available ? `Star 0: changePct=${idx.body.changePct}%` : `reason=${idx.body.reason}`);
    // The clamp. Unbounded, the Rockets compound into thousands of percent; the
    // index has always bounded a bucket move and the list must too.
    const moves = cards.map(c => c.changePct).filter(v => v != null);
    const worst = moves.length ? Math.max(...moves.map(Math.abs)) : 0;
    check('  ...and no card reports an impossible move',
          worst <= 1600,
          `largest move ${worst}% across ${moves.length} cards`);
  }

  // The collector runs days behind. Live, the 7-day list read "no move" on
  // every card: its sales sat on four early days of the week and the later
  // days held none yet, so a calendar half-and-half left one side empty. A card
  // that traded on four days has a move to report, whatever the calendar.
  {
    const dbL = new DatabaseSync(':memory:');
    salesTable(dbL);
    dbL.exec('BEGIN');
    const insL = dbL.prepare(`INSERT INTO sales
      (item_id, sold_date, title, price_cents, player, year, set_name, parallel, card_number, grader, grade, confidence)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
    let l = 0;
    for (let p = 0; p < 40; p++) {
      // Four trading days early in the week, rising; nothing after.
      [-9, -8, -7, -6].forEach((d, i) => {
        for (let k = 0; k < 3; k++) {
          insL.run(`l${l++}`, iso(d), `2024 Prizm Lag ${p} #1 RC`, 10000 + i * 500, `Lag ${p}`,
                   '2024', 'Prizm', '', '1', '', '', 0.9);
        }
      });
    }
    // The newest sale in the table, which anchors "through" at day -3.
    insL.run(`l${l++}`, iso(-2), '2024 Prizm Anchor #1 RC', 10000, 'Anchor', '2024', 'Prizm', '', '1', '', '', 0.9);
    dbL.exec('COMMIT');
    use(dbL);
    const b7 = await call('/api/market-basket?days=7');
    const cards = (b7.body && b7.body.cards) || [];
    const moved = cards.filter(c => c.changePct != null);
    check('a card that traded on four days has a move, even with the week\'s end empty',
          cards.length > 0 && moved.length === cards.length && moved.every(c => c.changePct > 0),
          `${moved.length}/${cards.length} cards with a move, e.g. ${cards[0] ? cards[0].label + ' ' + cards[0].changePct + '%' : 'none'}`);
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
    salesTable(dbA);
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

    const fill = await backfillPlayerAliases({ limit: 500, resolve: resolvePlayer });
    check('  ...then the backfill resolves the variants',
          fill.ok && fill.resolved >= REAL.length,
          fill.ok ? `${fill.inserted} variants written, ${fill.resolved} resolved`
                  : `FAILED: ${fill.reason}`);

    // Resumability is what makes chunked writes safe: if a chunk fails midway,
    // the next run must pick up from there rather than redo everything or
    // duplicate it. The backfill skips variants that already have a row, so a
    // second pass over the same data has nothing left to do.
    const again = await backfillPlayerAliases({ limit: 500, resolve: resolvePlayer });
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
      salesTable(dbP2);
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
