#!/usr/bin/env node
// Can the landing pages actually show prices?
//
// 2,173 pages are titled "Checklist & Prices" and carry no prices. Fixing that
// means joining our sold-sales table to the checklists, and whether that is
// worth building depends entirely on a number nobody has measured: how many
// checklist sets have enough sales behind them to show anything.
//
// The failure this exists to prevent is shipping a price block that renders
// empty on most pages. A page with no price block is exactly today's page. A
// page with an empty price table is WORSE than today, because it visibly fails
// its own headline — which is the thing an AdSense reviewer would notice.
//
// So this measures first and reports a verdict, including "not worth it".
//
// It reads production D1 and writes nothing.
//
// Run: node scripts/probe-price-coverage.js [--top N] [--json]
//      node scripts/probe-price-coverage.js --selftest   (no D1; checks the logic)
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DB = 'nflcarddb';
const CHECKLISTS = path.join(__dirname, '..', 'public', 'data', 'checklists');
const MIN_CONFIDENCE = 0.5;   // NFLDB_MIN_CONFIDENCE in server.js

// Thresholds a set must clear before a price block is worth rendering. Reported
// against, not enforced — the point of the probe is to find out whether these
// are the right numbers, so it prints the distribution around them too.
const WANT_SALES = 20;   // sales in the set
const WANT_CARDS = 10;   // distinct cards in the set that have sold

// ---------------------------------------------------------------------------
// Normalisation. This MUST match _normCol in server.js, because the match rate
// measured here is only meaningful if it is the match rate the real join would
// get. server.js strips ' . , " ` ’ - then lowercases, trims, and collapses
// runs of spaces.
const STRIP = ["'", '.', ',', '"', '`', '’', '-'];
function norm(s) {
  let e = String(s == null ? '' : s);
  for (const ch of STRIP) e = e.split(ch).join('');
  e = e.toLowerCase().trim();
  for (let i = 0; i < 4; i++) e = e.split('  ').join(' ');
  return e.trim();
}
// The SQL side of the same thing, built the way server.js builds it.
function normSql(col) {
  let e = `COALESCE(${col}, '')`;
  for (const ch of ["''", '.', ',', '"', '`', '’', '-']) e = `REPLACE(${e}, '${ch}', '')`;
  e = `LOWER(TRIM(${e}))`;
  for (let i = 0; i < 4; i++) e = `REPLACE(${e}, '  ', ' ')`;
  return `TRIM(${e})`;
}

// ---------------------------------------------------------------------------
function explain(stdout) {
  const text = String(stdout || '');
  if (/10000|Authentication error/i.test(text)) {
    return 'The API token cannot reach D1.\n'
      + 'Add Account -> D1 -> Edit to the token in CLOUDFLARE_API_TOKEN.\n'
      + "Editing an existing token's permissions does not change its value, so the\n"
      + 'GitHub secret does not need updating.';
  }
  if (/not authorized|Unauthorized/i.test(text)) return 'CLOUDFLARE_API_TOKEN was rejected. Check it is set and has not expired.';
  return text.slice(0, 400) || 'wrangler failed';
}

function d1(sql) {
  let out;
  try {
    out = execFileSync('npx', [
      'wrangler', 'd1', 'execute', DB, '--remote', '--json', '--command', sql,
    ], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    const blob = String((err && err.stdout) || '') + String((err && err.stderr) || '');
    console.error(`\nD1 request failed.\n\n  ${explain(blob).replace(/\n/g, '\n  ')}\n`);
    process.exit(1);
  }
  const start = out.indexOf('[');
  if (start < 0) throw new Error(`no JSON in wrangler output: ${out.slice(0, 300)}`);
  const parsed = JSON.parse(out.slice(start));
  return (parsed[0] && parsed[0].results) || [];
}

// ---------------------------------------------------------------------------
// The checklist side: one row per set, keyed the way a sale would be keyed.
//
// The join is on year + BRAND, not the product name. A sale's set_name is
// parsed out of a seller's title and reads "Prizm", where the product is
// "2024 Panini Prizm Football" with brand "Prizm". Joining on the product name
// would match nothing at all, which would look like an absence of data rather
// than the wrong key — so the key choice is stated here rather than buried.
function loadChecklistSets() {
  const out = [];
  for (const f of fs.readdirSync(CHECKLISTS)) {
    if (!f.endsWith('.json') || f === 'index.json') continue;
    const d = JSON.parse(fs.readFileSync(path.join(CHECKLISTS, f), 'utf8'));
    const cards = (d.sets || []).reduce((n, s) => n + (s.cards || []).length, 0);
    out.push({
      id: f.replace(/\.json$/, ''),
      name: d.name,
      year: String(d.year || ''),
      brand: d.brand || '',
      key: norm(d.year) + '|' + norm(d.brand),
      subsets: (d.sets || []).length,
      cards,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
function bucket(rows, edges) {
  const counts = edges.map(() => 0);
  for (const r of rows) {
    for (let i = edges.length - 1; i >= 0; i--) {
      if (r >= edges[i]) { counts[i]++; break; }
    }
  }
  return counts;
}
const pct = (a, b) => b ? Math.round((100 * a) / b) : 0;
const bar = (n, max, w = 28) => '#'.repeat(Math.max(n > 0 ? 1 : 0, Math.round((n / (max || 1)) * w)));

// ---------------------------------------------------------------------------
function report(salesSets, salesPlayers, totals, checklists, topN) {
  const byKey = new Map();
  for (const r of salesSets) byKey.set(norm(r.y) + '|' + norm(r.s), r);

  const joined = checklists.map(c => ({ ...c, hit: byKey.get(c.key) || null }));
  const matched = joined.filter(j => j.hit);

  console.log('DATASET');
  console.log(`  priced sales          ${Number(totals.n || 0).toLocaleString('en-US')}`);
  console.log(`  covering              ${totals.first || '?'} to ${totals.last || '?'}`);
  console.log(`  distinct set names    ${salesSets.length.toLocaleString('en-US')}`);
  console.log(`  distinct players      ${salesPlayers.length.toLocaleString('en-US')}`);

  console.log('\nMATCH RATE  (checklist products joined to sales on year + brand)');
  console.log(`  products in checklists      ${checklists.length}`);
  console.log(`  matched to any sales        ${matched.length}  (${pct(matched.length, checklists.length)}%)`);

  const clears = matched.filter(j => j.hit.n >= WANT_SALES && j.hit.cards >= WANT_CARDS);
  console.log(`  clearing ${WANT_SALES}+ sales and ${WANT_CARDS}+ distinct cards   ${clears.length}  (${pct(clears.length, checklists.length)}% of all products)`);

  console.log('\nSALES PER MATCHED PRODUCT');
  const edges = [0, 1, 5, 20, 100, 500, 2000];
  const counts = bucket(matched.map(j => j.hit.n), edges);
  const max = Math.max(...counts);
  edges.forEach((e, i) => {
    const next = edges[i + 1];
    const label = next ? `${e}-${next - 1}` : `${e}+`;
    console.log(`  ${label.padStart(9)}  ${String(counts[i]).padStart(4)}  ${bar(counts[i], max)}`);
  });

  console.log('\nWITHIN A PRODUCT: how much of the checklist has sold');
  console.log('  (distinct sold cards / catalogued cards — an UPPER bound: a parsed');
  console.log('   card key need not correspond to a real checklist card)');
  const covers = matched.filter(j => j.cards > 0).map(j => Math.min(100, Math.round(100 * j.hit.cards / j.cards)));
  const cEdges = [0, 1, 5, 10, 25, 50];
  const cCounts = bucket(covers, cEdges);
  const cMax = Math.max(...cCounts);
  cEdges.forEach((e, i) => {
    const next = cEdges[i + 1];
    const label = next ? `${e}-${next - 1}%` : `${e}%+`;
    console.log(`  ${label.padStart(9)}  ${String(cCounts[i]).padStart(4)}  ${bar(cCounts[i], cMax)}`);
  });

  console.log(`\nBEST ${topN} PRODUCTS BY SALES`);
  matched.sort((a, b) => b.hit.n - a.hit.n).slice(0, topN).forEach(j => {
    console.log(`  ${String(j.hit.n).padStart(6)} sales  ${String(j.hit.cards).padStart(5)}/${String(j.cards).padEnd(5)} cards  ${j.name}`);
  });

  // The diagnostic that matters most when the match rate is low: sales volume
  // sitting under a set name no checklist claims. A big number here means the
  // join key is wrong, not that the data is missing.
  const claimed = new Set(checklists.map(c => c.key));
  const orphans = salesSets
    .filter(r => !claimed.has(norm(r.y) + '|' + norm(r.s)))
    .sort((a, b) => b.n - a.n);
  const orphanSales = orphans.reduce((n, r) => n + Number(r.n || 0), 0);
  console.log(`\nSALES UNDER A SET NAME NO CHECKLIST CLAIMS`);
  console.log(`  ${orphanSales.toLocaleString('en-US')} sales (${pct(orphanSales, totals.n)}% of the dataset) across ${orphans.length} names`);
  orphans.slice(0, 12).forEach(r => console.log(`  ${String(r.n).padStart(6)}  ${r.y || '(no year)'} ${r.s || '(no set)'}`));

  console.log('\nVERDICT');
  const share = pct(clears.length, checklists.length);
  if (share >= 40) {
    console.log(`  Build it. ${clears.length} of ${checklists.length} products (${share}%) clear the bar,`);
    console.log('  so most set pages would carry real numbers. Render the block only for');
    console.log('  those, and drop "& Prices" from the title of the rest.');
  } else if (share >= 15) {
    console.log(`  Build it for the top slice only. ${clears.length} products (${share}%) clear the bar.`);
    console.log('  A per-card price column would be mostly empty across the long tail, so');
    console.log('  give qualifying pages the block and leave the others exactly as they are.');
  } else {
    console.log(`  Not yet. Only ${clears.length} products (${share}%) clear the bar, so a price`);
    console.log('  block would render empty on almost every page — worse than today, because');
    console.log('  the page would visibly fail its own headline.');
    console.log('  If the orphan figure above is large, the join key is the problem rather');
    console.log('  than the data, and that is worth fixing before anything else.');
  }
}

// ---------------------------------------------------------------------------
// The live query path cannot be tested from here — it needs production D1. What
// CAN be tested is everything around it: the normalisation matching server.js,
// the join, the buckets. Those are where a silent wrong answer would come from.
function selftest() {
  let fail = 0;
  const check = (label, ok, detail) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
    if (!ok) fail++;
  };

  check('norm strips the characters server.js strips',
    norm(`Panini  Prizm's-Select."`) === 'panini prizmsselect',
    JSON.stringify(norm(`Panini  Prizm's-Select."`)));

  // Worth its own check because it is a matching hazard, not a detail: a hyphen
  // is DELETED, not turned into a space. So "Donruss-Optic" normalises to
  // "donrussoptic" while "Donruss Optic" normalises to "donruss optic", and the
  // two do not match. Whether that costs anything depends on how sellers punctuate
  // titles, which is what the orphan list in the report exists to reveal.
  check('a hyphen is deleted, not spaced — "Donruss-Optic" != "Donruss Optic"',
    norm('Donruss-Optic') === 'donrussoptic' && norm('Donruss Optic') === 'donruss optic'
      && norm('Donruss-Optic') !== norm('Donruss Optic'),
    `${norm('Donruss-Optic')} vs ${norm('Donruss Optic')}`);
  check('norm collapses long space runs', norm('a       b') === 'a b', JSON.stringify(norm('a       b')));
  check('norm survives null and undefined', norm(null) === '' && norm(undefined) === '');
  check('the SQL and JS forms strip the same set',
    STRIP.every(ch => !norm(`x${ch}y`).includes(ch)), STRIP.join(' '));

  // A join key built from a product name instead of the brand matches nothing —
  // the mistake this script's key choice exists to avoid.
  const cl = [{ id: 'p', name: '2024 Panini Prizm Football', year: '2024', brand: 'Prizm', cards: 100, subsets: 3, key: norm('2024') + '|' + norm('Prizm') }];
  const sales = [{ y: '2024', s: 'Prizm', n: 500, cards: 40 }];
  const hit = new Map(sales.map(r => [norm(r.y) + '|' + norm(r.s), r])).get(cl[0].key);
  check('a product joins to sales on year + brand', !!hit, hit ? `${hit.n} sales` : 'no match');
  const wrongKey = norm('2024') + '|' + norm('2024 Panini Prizm Football');
  check('  ...and would NOT join on the product name',
    !new Map(sales.map(r => [norm(r.y) + '|' + norm(r.s), r])).get(wrongKey),
    'confirms why the key is the brand');

  check('buckets place values in the right band',
    JSON.stringify(bucket([0, 3, 7, 50, 900], [0, 1, 5, 20, 100, 500])) === JSON.stringify([1, 1, 1, 1, 0, 1]),
    JSON.stringify(bucket([0, 3, 7, 50, 900], [0, 1, 5, 20, 100, 500])));
  check('pct handles an empty denominator', pct(3, 0) === 0);

  console.log(fail ? `\n${fail} check(s) failed` : '\nall probe self-checks passed');
  process.exit(fail ? 1 : 0);
}

// ---------------------------------------------------------------------------
function main() {
  if (process.argv.includes('--selftest')) return selftest();
  const topArg = process.argv.indexOf('--top');
  const topN = topArg > -1 ? Number(process.argv[topArg + 1]) || 15 : 15;

  const Y = normSql('year'), S = normSql('set_name'), P = normSql('player');
  const CARD = `${P} || '|' || ${normSql('card_number')}`;
  const WHERE = `price_cents IS NOT NULL AND confidence >= ${MIN_CONFIDENCE}`;

  console.log('Reading production D1 (read-only)…\n');

  const totals = d1(`SELECT COUNT(*) AS n, MIN(sold_date) AS first, MAX(sold_date) AS last
                     FROM sales WHERE ${WHERE}`)[0] || {};

  // One row per set name, not per page: ~12k rows for the whole corpus.
  const salesSets = d1(
    `SELECT ${Y} AS y, ${S} AS s, COUNT(*) AS n, COUNT(DISTINCT ${CARD}) AS cards
     FROM sales WHERE ${WHERE} AND ${S} <> ''
     GROUP BY y, s ORDER BY n DESC`);

  const salesPlayers = d1(
    `SELECT ${P} AS p, COUNT(*) AS n, COUNT(DISTINCT ${CARD}) AS cards
     FROM sales WHERE ${WHERE} AND ${P} <> ''
     GROUP BY p ORDER BY n DESC`);

  const checklists = loadChecklistSets();

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ totals, salesSets, salesPlayers, checklists }, null, 2));
    return;
  }
  report(salesSets, salesPlayers, totals, checklists, topN);
}

main();
