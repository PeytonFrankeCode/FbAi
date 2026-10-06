#!/usr/bin/env node
// Score raw-filed sale photos for "is this a graded slab?", and store the scores.
//
// See photo-slab-core.js for why and for what the scores mean. This is the
// batch half: it runs in CI (score-slab-photos.yml), never in the Worker, which
// has no image decoder and no business loading a 350 MB model. The Worker only
// reads photo_slab.
//
//   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... \
//     node scripts/score-slab-photos.mjs [--days 3] [--limit 6000] [--dry]
//
// Needs @huggingface/transformers, installed by the workflow with --no-save so
// it never enters package.json or the Worker bundle.
//
// Which sales: sold in the last --days, a photo, no grader or grade stored, $10
// or more (below that a slab barely moves a price), and not scored yet by this
// head (a retrained head, with a new PHOTO_SLAB_MODEL, redoes the window). Newest
// first. A sale whose title already reads as graded is written with no score,
// so it is not picked up again.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { gradeBucket } = require(path.join(ROOT, 'grade-core.js'));
const { slabScore, PHOTO_SLAB_TABLE, PHOTO_SLAB_MIN_CENTS, PHOTO_SLAB_MODEL } = require(path.join(ROOT, 'photo-slab-core.js'));
const HEAD = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'data', 'slab-head.json'), 'utf8'));

const DATABASE_ID = 'a887dd0e-d852-4ebc-98f0-0e01bc82ad0b';   // nflcarddb, wrangler.toml
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > -1 ? process.argv[i + 1] : d; };
const DAYS = Math.max(1, parseInt(arg('days', '3'), 10));
const LIMIT = Math.max(1, parseInt(arg('limit', '6000'), 10));
const DRY = process.argv.includes('--dry');
const FETCHERS = 8;
const WRITE_CHUNK = 200;

const { CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT } = process.env;
if (!TOKEN || !ACCOUNT) { console.error('set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID'); process.exit(2); }

async function d1(sql, params = []) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${DATABASE_ID}/query`, {
        method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql, params }),
      });
      const j = await r.json();
      if (!j.success) {
        const msg = JSON.stringify(j.errors || j).slice(0, 300);
        // A permission problem will not fix itself on a retry.
        if (r.status === 401 || r.status === 403 || /7403|not authorized/i.test(msg)) {
          throw Object.assign(new Error(`D1 refused: ${msg}. The token needs Account | D1 | Edit.`), { fatal: true });
        }
        throw new Error(msg);
      }
      return j.result[0].results;
    } catch (err) {
      if (err.fatal || attempt === 3) throw err;
      await new Promise(res => setTimeout(res, 1000 * 2 ** attempt));
    }
  }
}

// eBay serves whatever format it likes whatever the extension; 300px is plenty
// for a label and a holder, and a tenth of the full photo's bytes.
const sized = (url) => url.replace(/\/s-l\d+\.(jpg|jpeg|png|webp)/i, '/s-l300.jpg');
// Only failures that will still be failures tomorrow are written; anything
// else is left for the next run (a written row is never retried).
const permanent = (why) => /^http-4(0[0-9]|1[0-9])$/.test(why) && why !== 'http-408' && why !== 'http-429';

async function main() {
  const sha = process.env.GITHUB_SHA;
  console.log(`score-slab-photos: last ${DAYS} days, up to ${LIMIT}${DRY ? ' (dry run)' : ''}${sha ? `  [commit ${sha.slice(0, 7)}]` : ''}`);
  // A dry run needs only read access, so it neither creates the table nor
  // assumes it exists.
  if (!DRY) {
    await d1(`CREATE TABLE IF NOT EXISTS ${PHOTO_SLAB_TABLE} (
                item_id   TEXT PRIMARY KEY,
                score     REAL,
                model     TEXT NOT NULL,
                why       TEXT,
                scored_at TEXT NOT NULL)`);
  }
  const haveTable = (await d1(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, [PHOTO_SLAB_TABLE])).length > 0;

  const newest = await d1('SELECT sold_date FROM sales ORDER BY sold_date DESC LIMIT 1');
  const through = newest[0] && newest[0].sold_date;
  if (!through) { console.log('  no sales'); return; }
  const since = new Date(Date.parse(String(through).slice(0, 10) + 'T00:00:00Z') - (DAYS - 1) * 864e5).toISOString().slice(0, 10);
  const rows = await d1(
    `SELECT s.item_id, s.title, s.image_url, s.price_cents, s.grader, s.grade FROM sales s
      WHERE s.sold_date >= ? AND s.image_url IS NOT NULL AND s.image_url <> ''
        AND COALESCE(TRIM(s.grader), '') = '' AND s.grade IS NULL
        AND s.price_cents >= ?
        ${haveTable ? `AND NOT EXISTS (SELECT 1 FROM ${PHOTO_SLAB_TABLE} p WHERE p.item_id = s.item_id AND p.model = ?)` : ''}
      ORDER BY s.sold_date DESC LIMIT ?`, [since, PHOTO_SLAB_MIN_CENTS, ...(haveTable ? [PHOTO_SLAB_MODEL] : []), LIMIT]);
  console.log(`  ${rows.length} unscored sales since ${since}`);
  if (!rows.length) return;

  const { AutoProcessor, CLIPVisionModelWithProjection, RawImage, env } = await import('@huggingface/transformers');
  if (process.env.MODEL_CACHE) env.cacheDir = process.env.MODEL_CACHE;
  const proc = await AutoProcessor.from_pretrained(HEAD.model);
  const model = await CLIPVisionModelWithProjection.from_pretrained(HEAD.model, { dtype: 'fp32' });

  const out = [];
  const textGraded = rows.filter(r => gradeBucket(r) !== 'Raw');
  for (const r of textGraded) out.push({ id: r.item_id, score: null, why: 'title-graded' });
  const todo = rows.filter(r => gradeBucket(r) === 'Raw');

  // Fetch ahead of the model so the network and the CPU overlap.
  const queue = [];
  let next = 0;
  async function fetcher() {
    for (;;) {
      const i = next++;
      if (i >= todo.length) return;
      const r = todo[i];
      try {
        const resp = await fetch(sized(r.image_url), { signal: AbortSignal.timeout(15000) });
        if (!resp.ok) { queue.push({ r, why: `http-${resp.status}` }); continue; }
        queue.push({ r, blob: new Blob([await resp.arrayBuffer()]) });
      } catch (err) { queue.push({ r, why: 'fetch-error' }); }
    }
  }
  const fetching = Promise.all(Array.from({ length: FETCHERS }, fetcher));
  const t0 = Date.now();
  let done = 0, scored = 0;
  const why = {};
  while (done < todo.length) {
    const job = queue.shift();
    if (!job) { await new Promise(res => setTimeout(res, 20)); continue; }
    done++;
    if (job.why) { why[job.why] = (why[job.why] || 0) + 1; if (permanent(job.why)) out.push({ id: job.r.item_id, score: null, why: job.why }); continue; }
    try {
      const img = await RawImage.fromBlob(job.blob);
      const { image_embeds } = await model(await proc(img));
      const v = Array.from(image_embeds.data);
      const norm = Math.hypot(...v) || 1;
      out.push({ id: job.r.item_id, score: slabScore(v.map(x => x / norm), HEAD), why: null });
      scored++;
    } catch (err) {
      why.decode = (why.decode || 0) + 1;
      out.push({ id: job.r.item_id, score: null, why: 'decode' });
    }
    if (done % 500 === 0) console.log(`  ${done}/${todo.length}  (${Math.round((Date.now() - t0) / 1000)}s)`);
  }
  await fetching;
  const slabs = out.filter(o => o.score != null && o.score >= 0.8).length;
  console.log(`  scored ${scored} photos in ${Math.round((Date.now() - t0) / 1000)}s; ${slabs} read as slabs; `
            + `${textGraded.length} already graded by title; failures ${JSON.stringify(why)}`);
  if (DRY) {
    const titles = new Map(rows.map(r => [r.item_id, r]));
    for (const o of out.filter(o => o.score != null && o.score >= 0.5).sort((a, b) => b.score - a.score).slice(0, 30)) {
      const r = titles.get(o.id);
      console.log(`    ${o.score.toFixed(2)}  $${(r.price_cents / 100).toFixed(2).padStart(8)}  ${String(r.title).slice(0, 80)}  [${o.id}]`);
    }
    console.log('  --dry: nothing written');
    return;
  }

  // item_id is digits and the score a number, both checked, so the values can
  // go inline: D1 caps bound parameters at 100 a statement.
  const now = new Date().toISOString();
  const safe = out.filter(o => /^\d{6,20}$/.test(String(o.id)));
  for (let i = 0; i < safe.length; i += WRITE_CHUNK) {
    const values = safe.slice(i, i + WRITE_CHUNK).map(o =>
      `('${o.id}', ${o.score == null ? 'NULL' : Number(o.score).toFixed(4)}, '${PHOTO_SLAB_MODEL}', `
      + `${o.why ? `'${String(o.why).replace(/[^a-z0-9-]/gi, '')}'` : 'NULL'}, '${now}')`).join(',');
    await d1(`INSERT OR REPLACE INTO ${PHOTO_SLAB_TABLE} (item_id, score, model, why, scored_at) VALUES ${values}`);
  }
  console.log(`score-slab-photos: wrote ${safe.length} rows`);
}

main().catch(err => {
  // A token without D1 access fails the same way every hour until someone
  // edits it, and an hourly red run is an hourly email. Say it once as a
  // warning (it shows on the run) and stop cleanly; anything else is a real
  // failure.
  if (err && err.fatal) {
    console.log(`::warning title=Photo scoring is waiting on the Cloudflare token::${err.message} `
      + 'Cloudflare dashboard -> My Profile -> API Tokens -> edit the token in the CLOUDFLARE_API_TOKEN secret -> '
      + 'add Account | D1 | Edit.');
    process.exit(0);
  }
  console.error(err.message || err);
  process.exit(1);
});
