#!/usr/bin/env node
// Fingerprint card photos, on a machine that can actually decode a JPEG.
//
// This started life inside the Worker and did not belong there. A Worker has no
// JPEG decoder, so the plan was to have Cloudflare's image service shrink each
// photo to a PNG first — which failed in production on every row:
//
//   {"why":"not-resized (image/jpeg)","n":40}
//
// The resizer is a paid zone feature, and at ~340,000 images the per-image
// billing is not small. But none of that was ever necessary: this is a batch
// backfill, not a request. It has no reason to run somewhere with a 30-second
// CPU ceiling, no image libraries and a bundle size that can take the site
// down. It runs in CI instead, where Node is complete and the only limit is
// wall-clock.
//
// So the Worker keeps none of this. It reads the results.
//
// Run: node scripts/fingerprint-photos.js [--limit N] [--dry]
const { execFileSync } = require('node:child_process');
const jpeg = require('jpeg-js');
const { signatureFromPixels } = require('../photo-signature.js');

const DB = 'nflcarddb';
const TABLE = 'photo_sig';
// One run's worth. Big enough to make progress against ~149k reference photos,
// small enough that a failure loses minutes rather than an afternoon.
const DEFAULT_LIMIT = 1500;
const CONCURRENCY = 12;
const WRITE_CHUNK = 100;
const TIMEOUT_MS = 8000;

const args = process.argv.slice(2);
const limit = Number((args.find(a => a.startsWith('--limit=')) || '').split('=')[1]) || DEFAULT_LIMIT;
const dry = args.includes('--dry');

// eBay serves the same photo at many sizes and the number in the filename is
// the whole difference. A 64px thumbnail is all a colour fingerprint needs, and
// asking for it moves perhaps 3 KB instead of 300 — kinder to eBay and a great
// deal faster across thousands of rows.
function thumbnail(url) {
  return url.replace(/\/s-l\d+\.(jpg|jpeg|png|webp)/i, '/s-l64.$1');
}

// Cloudflare's failures come back as JSON on stdout with a numeric code, and
// the codes mean genuinely different things — a missing permission is a token
// setting, a missing table is a migration, a bad id is a typo. Left as a raw
// execFileSync throw they all arrive as the same wall of stack trace with the
// one useful line buried in the middle of it.
function explain(stdout) {
  let code = null, text = '', notes = '';
  try {
    const j = JSON.parse(stdout.slice(stdout.indexOf('{')));
    code = j && j.error && j.error.code;
    text = (j && j.error && j.error.text) || '';
    notes = ((j && j.error && j.error.notes) || []).map(n => n.text).join('; ');
  } catch { /* not JSON — fall through to the raw text */ }

  if (code === 7403 || /not authorized to access this service/i.test(notes)) {
    return 'CLOUDFLARE_API_TOKEN cannot access D1.\n'
         + '  The deploy token only carries Workers permissions; this job also writes to the\n'
         + '  database. Cloudflare dashboard -> My Profile -> API Tokens -> edit the token ->\n'
         + '  add Account | D1 | Edit. (Or mint a new token with Workers Scripts:Edit AND\n'
         + '  D1:Edit and update the CLOUDFLARE_API_TOKEN secret in GitHub.)';
  }
  if (/authentication|10000|unauthorized/i.test(notes + text)) {
    return 'CLOUDFLARE_API_TOKEN was rejected. Check the secret is set and has not expired.';
  }
  return `${text || 'wrangler failed'}${notes ? `\n  ${notes}` : ''}`;
}

function d1(sql, { json = true } = {}) {
  let out;
  try {
    out = execFileSync('npx', [
      'wrangler', 'd1', 'execute', DB, '--remote',
      ...(json ? ['--json'] : []),
      '--command', sql,
    ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    const stdout = String((err && err.stdout) || '');
    console.error(`\nD1 request failed.\n\n  ${explain(stdout).replace(/\n/g, '\n  ')}\n`);
    process.exit(1);
  }
  if (!json) return null;
  // wrangler prints progress lines around the JSON payload.
  const start = out.indexOf('[');
  if (start < 0) throw new Error(`no JSON in wrangler output: ${out.slice(0, 300)}`);
  return JSON.parse(out.slice(start));
}

const esc = (s) => String(s).replace(/'/g, "''");

async function fetchSignature(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(thumbnail(url), {
      signal: ctl.signal,
      headers: { 'user-agent': 'thecardhuddle-fingerprint/1.0 (+https://thecardhuddle.com)' },
    });
    if (!resp.ok) return { ok: 0, why: `http-${resp.status}` };
    const type = resp.headers.get('content-type') || '';
    if (!/jpe?g/i.test(type)) return { ok: 0, why: `not-jpeg (${type || 'unknown'})` };
    const buf = Buffer.from(await resp.arrayBuffer());
    // Guard against a decoder blowing up memory on a hostile or corrupt file.
    const raw = jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 64 });
    if (!raw || !raw.width) return { ok: 0, why: 'decode-empty' };
    return { ok: 1, sig: signatureFromPixels(raw.data, 4), px: `${raw.width}x${raw.height}` };
  } catch (err) {
    return { ok: 0, why: (err && err.name === 'AbortError') ? 'timeout' : `error: ${String(err && err.message).slice(0, 60)}` };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  console.log(`fingerprint-photos: up to ${limit} reference photos${dry ? ' (dry run)' : ''}`);

  // Create the table here rather than relying on the Worker having done it.
  // The Worker does create it, but only when someone happens to load the status
  // endpoint — which makes whether this job runs depend on whether a page was
  // visited, and that is not a dependency worth having.
  d1(`CREATE TABLE IF NOT EXISTS ${TABLE} (
        url        TEXT PRIMARY KEY,
        sig        TEXT,
        ok         INTEGER NOT NULL DEFAULT 0,
        why        TEXT,
        updated_at TEXT
      )`, { json: false });

  // Reference photos first: sales whose parallel is already known. Those are
  // what everything else gets matched against, so identifying blank cards
  // before this library exists would be guesswork with extra steps.
  const rows = d1(
    `SELECT DISTINCT image_url AS url FROM sales
      WHERE image_url IS NOT NULL AND image_url <> ''
        AND price_cents IS NOT NULL AND price_cents > 0
        AND COALESCE(TRIM(parallel), '') <> ''
        AND COALESCE(TRIM(year), '') <> '' AND COALESCE(TRIM(set_name), '') <> ''
        AND NOT EXISTS (SELECT 1 FROM ${TABLE} s WHERE s.url = sales.image_url)
      LIMIT ${limit}`
  );
  const list = ((rows && rows[0] && rows[0].results) || []).map(r => r.url).filter(Boolean);
  console.log(`  ${list.length} to fetch`);
  if (!list.length) { console.log('  nothing left — reference library is complete'); return; }

  const t0 = Date.now();
  const done = [];
  let cursor = 0;
  async function worker() {
    for (;;) {
      const i = cursor++;
      if (i >= list.length) return;
      const url = list[i];
      done.push({ url, ...(await fetchSignature(url)) });
      if (done.length % 250 === 0) {
        console.log(`  ${done.length}/${list.length}  (${Math.round((Date.now() - t0) / 1000)}s)`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, list.length) }, worker));

  const good = done.filter(r => r.ok).length;
  const why = {};
  for (const r of done) if (!r.ok) why[r.why] = (why[r.why] || 0) + 1;
  console.log(`  decoded ${good}/${done.length} in ${Math.round((Date.now() - t0) / 1000)}s`);
  for (const [k, n] of Object.entries(why).sort((a, b) => b[1] - a[1]).slice(0, 6)) {
    console.log(`    ${n.toString().padStart(5)}  ${k}`);
  }

  if (dry) { console.log('  --dry: nothing written'); return; }

  // Failures are written too. A dead link recorded once is not re-fetched every
  // run forever, and the scan above skips anything with a row.
  const now = new Date().toISOString();
  let written = 0;
  for (let i = 0; i < done.length; i += WRITE_CHUNK) {
    const values = done.slice(i, i + WRITE_CHUNK).map(r =>
      `('${esc(r.url)}', ${r.sig ? `'${esc(JSON.stringify(r.sig))}'` : 'NULL'}, ${r.ok}, `
      + `${r.why ? `'${esc(r.why).slice(0, 80)}'` : 'NULL'}, '${now}')`).join(',');
    d1(`INSERT OR REPLACE INTO ${TABLE} (url, sig, ok, why, updated_at) VALUES ${values}`, { json: false });
    written += Math.min(WRITE_CHUNK, done.length - i);
    console.log(`  wrote ${written}/${done.length}`);
  }
  console.log(`fingerprint-photos: ${written} rows, ${good} usable`);
}

main().catch(err => { console.error(err); process.exit(1); });
