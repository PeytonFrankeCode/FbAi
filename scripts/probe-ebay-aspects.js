#!/usr/bin/env node
// Does eBay already know the parallel, on the sales we could not read?
//
// A question that should have been asked before a colour fingerprint was built.
// The parallel column is filled on 48% of sales and that data came from
// somewhere — eBay's item specifics, the structured fields a seller fills in
// when listing. If those fields are still present on the sales where our column
// is blank, then the answer is sitting in the listing, free and authoritative,
// and no amount of image recognition was ever needed for it.
//
// This is a PROBE, not a pipeline. It samples a couple of hundred sold listings
// and reports how often a parallel-ish aspect is actually there. Production
// would go through eBay's API rather than the public page; the point here is
// only to find out whether the data exists at all before anyone builds or buys
// anything to reconstruct it.
//
// Run: node scripts/probe-ebay-aspects.js [--limit N]
const { execFileSync } = require('node:child_process');

const DB = 'nflcarddb';
const DEFAULT_LIMIT = 150;
const CONCURRENCY = 4;          // a probe, and someone else's servers
const TIMEOUT_MS = 12000;

const limit = Number((process.argv.find(a => a.startsWith('--limit=')) || '').split('=')[1]) || DEFAULT_LIMIT;

function d1(sql) {
  let out;
  try {
    out = execFileSync('npx', ['wrangler', 'd1', 'execute', DB, '--remote', '--json', '--command', sql],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    console.error(`\nD1 request failed.\n  ${String((err && err.stdout) || '').slice(0, 500)}\n`);
    process.exit(1);
  }
  const start = out.indexOf('[');
  if (start < 0) throw new Error('no JSON in wrangler output');
  return JSON.parse(out.slice(start));
}

// The names eBay's card category actually uses for this field. Sellers pick
// from a list, so these are the labels rather than free text.
const PARALLEL_LABELS = /^(parallel|parallel\/variety|variety|features|card variation|insert set|autograph format)$/i;
// The grade side of the same question, and it exists for the same reason.
//
// A 2025 Prizm Mahomes Silver came back with a PSA slab and a CGC slab in its
// RAW list. Three things could cause that, needing opposite fixes, and one of
// them — the grade is simply not in the title — is the case people reach for
// image recognition to solve. Reading a slab label with OCR is a build: a
// vendor API or a model, per-image cost, a backfill over ~340,000 photos, and
// a pipeline to keep it fed.
//
// eBay may already know. "Professional Grader", "Grade" and "Graded" are
// standard item specifics that a seller fills in when listing a slab, and
// USEFUL_LABELS has been collecting them all along without anyone reporting
// them. If they are present on the sales we call Raw, the answer is structured,
// authoritative and free — and no OCR was ever needed.
//
// This is the same question that should have been asked before the colour
// fingerprint was built. Asking it costs one probe run.
const GRADE_LABELS = /^(professional grader|grade|graded|card condition)$/i;
const USEFUL_LABELS = /^(parallel|parallel\/variety|variety|features|set|card set|card number|player\/athlete|player|season|year|manufacturer|card condition|professional grader|grade|card name|league|team|card type|print run|serial numbered|autographed|graded)$/i;

// eBay renders item specifics as label/value pairs. The markup has changed
// repeatedly over the years, so match on the shape of the pair rather than on
// any one class name — and take whichever variant yields more, instead of
// assuming which one this page happens to use.
function extractAspects(html) {
  const found = new Map();

  // Modern: <span class="ux-textspans">Label</span> ... <span ...>Value</span>
  const pairRe = /<div class="ux-labels-values__labels"[\s\S]{0,400}?<span[^>]*>([^<]{2,40})<\/span>[\s\S]{0,300}?<div class="ux-labels-values__values"[\s\S]{0,400}?<span[^>]*>([^<]{1,120})<\/span>/gi;
  for (const m of html.matchAll(pairRe)) {
    const k = m[1].replace(/:$/, '').trim();
    const v = m[2].trim();
    if (k && v && !found.has(k)) found.set(k, v);
  }

  // Older table markup, as a fallback.
  if (found.size === 0) {
    const tdRe = /<td[^>]*class="[^"]*attrLabels[^"]*"[^>]*>\s*([^<]{2,40}?)\s*:?\s*<\/td>\s*<td[^>]*>\s*(?:<[^>]+>\s*)*([^<]{1,120}?)\s*</gi;
    for (const m of html.matchAll(tdRe)) {
      const k = m[1].trim(), v = m[2].trim();
      if (k && v && !found.has(k)) found.set(k, v);
    }
  }
  return found;
}

async function fetchListing(itemId) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(`https://www.ebay.com/itm/${encodeURIComponent(itemId)}`, {
      signal: ctl.signal,
      headers: {
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
        'accept-language': 'en-US,en;q=0.9',
      },
    });
    if (!resp.ok) return { ok: false, why: `http-${resp.status}` };
    return { ok: true, html: await resp.text() };
  } catch (err) {
    return { ok: false, why: (err && err.name === 'AbortError') ? 'timeout' : `error: ${String(err && err.message).slice(0, 50)}` };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  console.log(process.argv.includes('--grade')
    ? `probe-ebay-aspects --grade: sampling ${limit} sold listings we currently call RAW\n`
    : `probe-ebay-aspects: sampling ${limit} sold listings whose parallel column is BLANK\n`);

  // Two populations, because the two questions are different. The parallel
  // question asks about sales whose parallel column is blank; the grade
  // question asks about sales we currently present as RAW — the ones a slab
  // would be hiding in.
  const wantGrade = process.argv.includes('--grade');
  const rows = d1(wantGrade
    ? `SELECT item_id, title, year, set_name FROM sales
        WHERE item_id IS NOT NULL AND item_id <> ''
          AND price_cents IS NOT NULL AND price_cents > 0
          AND COALESCE(TRIM(grade), '') = ''
          AND COALESCE(TRIM(grader), '') = ''
          AND sold_date > date('now', '-45 day')
        ORDER BY sold_date DESC LIMIT ${limit}`
    : `SELECT item_id, title, year, set_name FROM sales
        WHERE item_id IS NOT NULL AND item_id <> ''
          AND price_cents IS NOT NULL AND price_cents > 0
          AND COALESCE(TRIM(parallel), '') = ''
          AND sold_date > date('now', '-45 day')
        ORDER BY sold_date DESC LIMIT ${limit}`);
  const list = ((rows && rows[0] && rows[0].results) || []).filter(r => r.item_id);
  console.log(`  ${list.length} sampled\n`);
  if (!list.length) return;

  const results = [];
  let cursor = 0;
  async function worker() {
    for (;;) {
      const i = cursor++;
      if (i >= list.length) return;
      const row = list[i];
      const got = await fetchListing(row.item_id);
      if (!got.ok) { results.push({ row, ok: false, why: got.why }); continue; }
      const aspects = extractAspects(got.html);
      results.push({ row, ok: true, aspects });
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, list.length) }, worker));

  const reachable = results.filter(r => r.ok);
  const failed = results.length - reachable.length;
  const why = {};
  for (const r of results) if (!r.ok) why[r.why] = (why[r.why] || 0) + 1;

  console.log(`  pages reachable   ${reachable.length}/${results.length}`);
  for (const [k, n] of Object.entries(why).sort((a, b) => b[1] - a[1])) console.log(`    ${String(n).padStart(4)}  ${k}`);

  const withAny = reachable.filter(r => r.aspects.size > 0);
  console.log(`  specifics parsed  ${withAny.length}/${reachable.length}`);

  // The question this exists to answer.
  const withParallel = withAny.filter(r => [...r.aspects.keys()].some(k => PARALLEL_LABELS.test(k)));
  const pct = (a, b) => (b ? (a / b * 100).toFixed(1) + '%' : 'n/a');
  console.log('');
  console.log(`  CARRY A PARALLEL-ISH ASPECT: ${withParallel.length}/${withAny.length}  (${pct(withParallel.length, withAny.length)})`);
  console.log(`  — these are sales our column has BLANK, so this is recoverable for free.`);

  for (const r of withParallel.slice(0, 12)) {
    const hits = [...r.aspects.entries()].filter(([k]) => PARALLEL_LABELS.test(k))
      .map(([k, v]) => `${k}=${v}`).join(', ');
    console.log(`      ${hits}   << ${String(r.row.title || '').slice(0, 54)}`);
  }

  // ---- the grade question ----
  //
  // Every row here has an EMPTY grade and grader column, which is why the site
  // calls them Raw. If eBay says otherwise, the slab was knowable all along.
  if (wantGrade) {
    const graded = withAny.filter(r => {
      for (const [k, v] of r.aspects) {
        if (!GRADE_LABELS.test(k)) continue;
        const val = String(v || '').trim().toLowerCase();
        if (!val || val === 'ungraded' || val === 'not graded' || val === 'raw') continue;
        return true;
      }
      return false;
    });
    console.log('');
    console.log(`  SAY THEY ARE GRADED, WHILE OUR COLUMNS SAY RAW: ${graded.length}/${withAny.length}  (${pct(graded.length, withAny.length)})`);
    console.log('  — if this is large, slabs in the Raw list are an eBay-aspects fix, not an OCR one.');
    console.log('  — if it is near zero, the grade really is only in the photo, and OCR is the');
    console.log('    remaining option. Either way the number decides it rather than an opinion.');
    for (const r of graded.slice(0, 15)) {
      const hits = [...r.aspects.entries()].filter(([k]) => GRADE_LABELS.test(k))
        .map(([k, v]) => `${k}=${v}`).join(', ');
      console.log(`      ${hits}   << ${String(r.row.title || '').slice(0, 52)}`);
    }
    // And the one that decides whether the TITLE was ever going to be enough.
    const titleSaysGrade = graded.filter(r =>
      /(?<![A-Za-z])(psa|bgs|sgc|cgc|beckett|csg|hga)(?![A-Za-z])/i.test(String(r.row.title || '')));
    console.log('');
    console.log(`  ...and of those, the TITLE also names a grader: ${titleSaysGrade.length}/${graded.length}  (${pct(titleSaysGrade.length, graded.length)})`);
    console.log('  — a high number here means our title reader is missing them and the fix is a');
    console.log('    pattern. A low one means the title genuinely never said it.');
  }

  // What else is on offer, since year/set/player are only 96%/68%/38% filled
  // and every one of them is part of the card identity the index groups on.
  const freq = new Map();
  for (const r of withAny) for (const k of r.aspects.keys()) freq.set(k, (freq.get(k) || 0) + 1);
  console.log('');
  console.log('  most common aspects available (any label):');
  for (const [k, n] of [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 18)) {
    console.log(`    ${String(n).padStart(4)}  ${pct(n, withAny.length).padStart(6)}  ${k}${USEFUL_LABELS.test(k) ? '' : '   (probably noise)'}`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
