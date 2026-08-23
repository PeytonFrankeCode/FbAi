#!/usr/bin/env node
// Build the reference fingerprints, then find out whether they actually work.
//
// The accuracy figures so far — 21 right, 11 refused, zero wrong — came from
// synthetic colour swatches. That proved the maths, not the idea. Real card
// photos are shot on desks and carpets, at angles, under kitchen lighting,
// sometimes with a hand in frame, and nothing established that a Gold Prizm
// photographed by one seller resembles a Gold Prizm photographed by another.
//
// So this does two things, and the second matters more:
//
//   1. Averages the fingerprints of each (year, set, parallel) into a
//      reference, for cards whose parallel is already known.
//   2. Hides the answer for a sample of those same cards and asks the
//      reference library to identify them.
//
// Step 2 needs no waiting and no blank cards. Every card in it has a known
// answer, so accuracy is directly measurable rather than inferred — and a card
// is never allowed to vote for its own reference, which would let the library
// recognise a photo purely because that photo helped build it.
//
// Run: node scripts/build-photo-refs.js [--holdout N] [--write]
const { execFileSync } = require('node:child_process');
const { centroid, bestMatch, distance } = require('../photo-signature.js');

const DB = 'nflcarddb';
const SIG_TABLE = 'photo_sig';
const REF_TABLE = 'photo_ref';
// A reference built from fewer than this is not a reference — with two photos
// the "average" is whichever two sellers happened to sell first.
const MIN_SAMPLES = 5;
const PAGE = 5000;

const args = process.argv.slice(2);
const holdout = Number((args.find(a => a.startsWith('--holdout=')) || '').split('=')[1]) || 400;
const write = args.includes('--write');

function d1(sql, { json = true } = {}) {
  let out;
  try {
    out = execFileSync('npx', [
      'wrangler', 'd1', 'execute', DB, '--remote',
      ...(json ? ['--json'] : []), '--command', sql,
    ], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    const stdout = String((err && err.stdout) || '');
    console.error(`\nD1 request failed.\n  ${stdout.slice(0, 600)}\n`);
    process.exit(1);
  }
  if (!json) return null;
  const start = out.indexOf('[');
  if (start < 0) throw new Error(`no JSON in wrangler output: ${out.slice(0, 300)}`);
  return JSON.parse(out.slice(start));
}

const esc = (s) => String(s).replace(/'/g, "''");
const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim();
// Product scope. A parallel name only means something inside its product —
// "Gold" in Prizm and "Gold" in Donruss are different cards — and scoping the
// candidates this way also keeps the comparison to a few dozen references
// rather than thousands, which is what makes it both safer and affordable.
const productKey = (r) => `${norm(r.year)}|${norm(r.set_name)}`;
const cardKey = (r) => `${productKey(r)}|${norm(r.parallel)}`;

function loadAll() {
  const rows = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = d1(
      `SELECT s.url, s.sig, x.year, x.set_name, x.parallel
         FROM ${SIG_TABLE} s
         JOIN (SELECT DISTINCT image_url, year, set_name, parallel FROM sales
                WHERE image_url IS NOT NULL AND image_url <> ''
                  AND COALESCE(TRIM(parallel), '') <> ''
                  AND COALESCE(TRIM(year), '') <> '' AND COALESCE(TRIM(set_name), '') <> ''
              ) x ON x.image_url = s.url
        WHERE s.ok = 1 AND s.sig IS NOT NULL
        LIMIT ${PAGE} OFFSET ${offset}`);
    const got = (page && page[0] && page[0].results) || [];
    for (const r of got) {
      try { rows.push({ ...r, sig: JSON.parse(r.sig) }); } catch { /* skip unparseable */ }
    }
    if (got.length < PAGE) break;
  }
  return rows;
}

function main() {
  const sha = process.env.GITHUB_SHA;
  console.log(`build-photo-refs${sha ? `  [commit ${sha.slice(0, 7)}]` : ''}`);

  const rows = loadAll();
  console.log(`  ${rows.length.toLocaleString('en-US')} fingerprinted reference photos`);
  if (rows.length < MIN_SAMPLES * 4) {
    console.log('  too few to build references yet — let the backfill run');
    return;
  }

  const groups = new Map();
  for (const r of rows) {
    const k = cardKey(r);
    if (!groups.has(k)) groups.set(k, { key: k, product: productKey(r), parallel: r.parallel, rows: [] });
    groups.get(k).rows.push(r);
  }
  const anchored = [...groups.values()].filter(g => g.rows.length >= MIN_SAMPLES);
  console.log(`  ${groups.size.toLocaleString('en-US')} parallel groups, `
            + `${anchored.length.toLocaleString('en-US')} with ${MIN_SAMPLES}+ photos`);
  if (!anchored.length) { console.log('  nothing anchored yet — let the backfill run'); return; }

  // Candidates are scoped to the product, so a card is only ever compared with
  // parallels that exist in its own set.
  const byProduct = new Map();
  for (const g of anchored) {
    if (!byProduct.has(g.product)) byProduct.set(g.product, []);
    byProduct.get(g.product).push(g);
  }

  // --- Does it work? ---------------------------------------------------------
  // Leave-one-out. The held-out photo is removed from its own reference before
  // being matched, so nothing can be recognised merely because it helped define
  // the thing it is being compared against.
  const testable = anchored.filter(g => g.rows.length > MIN_SAMPLES
                                     && (byProduct.get(g.product) || []).length > 1);
  let right = 0, wrong = 0, refused = 0;
  const errors = [];
  let tested = 0;
  outer:
  for (const g of testable) {
    for (const held of g.rows) {
      if (tested >= holdout) break outer;
      tested++;
      const cands = byProduct.get(g.product).map(c => ({
        key: c.key,
        centroid: centroid(c === g ? c.rows.filter(r => r.url !== held.url).map(r => r.sig)
                                   : c.rows.map(r => r.sig)),
      })).filter(c => c.centroid);
      const hit = bestMatch(held.sig, cands);
      if (hit.key === g.key) right++;
      else if (hit.key === null) refused++;
      else {
        wrong++;
        if (errors.length < 10) errors.push(`${g.parallel} -> ${(groups.get(hit.key) || {}).parallel} (d=${hit.distance})`);
      }
    }
  }

  const pct = (a, b) => (b ? (a / b * 100).toFixed(1) + '%' : 'n/a');
  console.log('');
  console.log(`  HOLD-OUT TEST on ${tested} real card photos, answer hidden:`);
  console.log(`    correct   ${String(right).padStart(5)}  ${pct(right, tested)}`);
  console.log(`    refused   ${String(refused).padStart(5)}  ${pct(refused, tested)}   (costs sample, harmless)`);
  console.log(`    WRONG     ${String(wrong).padStart(5)}  ${pct(wrong, tested)}   (merges two cards — the number that matters)`);
  const answered = right + wrong;
  console.log(`    of the ones it answered, ${pct(right, answered)} were right`);
  for (const e of errors) console.log(`      miss: ${e}`);

  // The gate for using this on blank cards at all. Text parsing sits at 4.4%
  // false-base; a photo matcher that is wrong more often than that would be a
  // step backwards, however much coverage it buys.
  const wrongRate = answered ? wrong / answered : 1;
  console.log('');
  console.log(`  VERDICT: ${wrongRate <= 0.02 ? 'safe to apply to blank cards'
                          : wrongRate <= 0.05 ? 'borderline — tighten the margin before applying'
                          : 'NOT safe to apply — wrong too often'}`
            + `  (${pct(wrong, answered)} wrong of answered)`);

  if (!write) { console.log('\n  --write not given: no references stored'); return; }

  const now = new Date().toISOString();
  const stmts = anchored.map(g => {
    const c = centroid(g.rows.map(r => r.sig));
    return `('${esc(g.key)}', '${esc(g.parallel)}', '${esc(g.product)}', `
         + `'${esc(JSON.stringify(c))}', ${g.rows.length}, '${now}')`;
  });
  d1(`CREATE TABLE IF NOT EXISTS ${REF_TABLE} (
        card_key TEXT PRIMARY KEY, parallel TEXT NOT NULL, product TEXT NOT NULL,
        centroid TEXT NOT NULL, samples INTEGER NOT NULL, updated_at TEXT)`, { json: false });
  for (let i = 0; i < stmts.length; i += 100) {
    d1(`INSERT OR REPLACE INTO ${REF_TABLE}
          (card_key, parallel, product, centroid, samples, updated_at)
        VALUES ${stmts.slice(i, i + 100).join(',')}`, { json: false });
    console.log(`  stored ${Math.min(i + 100, stmts.length)}/${stmts.length} references`);
  }
}

main();
