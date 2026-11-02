#!/usr/bin/env node
// Tell Bing (and DuckDuckGo, Yandex, Naver, Seznam) which pages changed.
//
// IndexNow is a push protocol: instead of waiting for a crawler to notice a
// page has changed, the site says so. One endpoint reaches every participating
// engine. Google is not among them — it has its own machinery and ignores this
// — so the win here is the non-Google half of search, which also happens to be
// what several AI assistants query.
//
// The protocol's one rule that matters: submit what CHANGED. Re-submitting
// several thousand unchanged URLs on every deploy is how a site gets its
// submissions ignored, and it would be the natural thing to do here because
// the landing pages are regenerated from scratch every time. So this reads the
// <lastmod> the sitemap already carries — derived from the last commit that
// touched each underlying checklist — and submits only what is genuinely
// recent.
//
// Removed pages count as changes too. IndexNow is also how an engine is told a
// page is GONE: it re-fetches the URL, gets the 404 and drops it, instead of
// finding out one crawl at a time (Bing Webmaster flags this as "notify
// IndexNow of dead links"). Two ways in:
//   default run   also submits pages built last deploy but not this one, and
//                 pages new this deploy, by comparing the live site's
//                 built-pages.json (fetched before the deploy into
//                 .cache/live-built-pages.json) with this build's
//   --dead        submits every generated address the build chose not to
//                 build (.cache/unbuilt-pages.json, written by build:pages):
//                 a one-off catch-up for the pages pruned in Oct 2026
//
// Run: node scripts/indexnow-submit.js [--days N] [--max N] [--dead] [--dry]
const fs = require('fs');
const path = require('path');

const SITE = 'https://thecardhuddle.com';
const HOST = 'thecardhuddle.com';
const KEY = '6d4386f41690944fb4fc16656b8290bb';
// The key must be readable at the site root: that file is what proves the
// submitter controls the domain. public/<key>.txt is served by the assets
// binding like any other static file.
const KEY_LOCATION = `${SITE}/${KEY}.txt`;
const ENDPOINT = 'https://api.indexnow.org/IndexNow';
const ROOT = path.join(__dirname, '..');
const SITEMAP = path.join(ROOT, 'public', 'sitemap.xml');
const BUILT_NOW = path.join(ROOT, 'public', 'data', 'built-pages.json');
const BUILT_LIVE = path.join(ROOT, '.cache', 'live-built-pages.json');
const UNBUILT = path.join(ROOT, '.cache', 'unbuilt-pages.json');
const BATCH = 10000;                 // the protocol's per-request limit

const args = process.argv.slice(2);
const num = (flag, dflt) => {
  const a = args.find(x => x.startsWith(`--${flag}=`));
  return a ? (Number(a.split('=')[1]) || dflt) : dflt;
};
const days = num('days', 7);
const max = num('max', 2000);        // protocol allows 10,000 per request
const dry = args.includes('--dry');
const dead = args.includes('--dead');

const readList = (f) => {
  try { const v = JSON.parse(fs.readFileSync(f, 'utf8')); return Array.isArray(v) ? v : null; }
  catch { return null; }
};
const abs = (p) => SITE + p;

// Pages that left or joined the site with this deploy. Needs the live list,
// fetched before the deploy replaced it; without it there is nothing to compare.
function builtChanges() {
  const live = readList(BUILT_LIVE), now = readList(BUILT_NOW);
  if (!live || !live.length || !now) return { gone: [], added: [], compared: false };
  const L = new Set(live), N = new Set(now);
  return {
    gone: live.filter(p => !N.has(p)).map(abs),
    added: now.filter(p => !L.has(p)).map(abs),
    compared: true,
  };
}

function changedUrls() {
  let xml;
  try { xml = fs.readFileSync(SITEMAP, 'utf8'); }
  catch { return { error: 'no sitemap.xml — run npm run build:pages first' }; }

  const cutoff = Date.now() - days * 86400000;
  const out = [];
  let total = 0;
  for (const m of xml.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
    const block = m[1];
    const loc = (block.match(/<loc>([^<]+)<\/loc>/) || [])[1];
    if (!loc) continue;
    total++;
    const mod = (block.match(/<lastmod>([^<]+)<\/lastmod>/) || [])[1];
    // No lastmod means no evidence it changed, so it is left alone. Submitting
    // it anyway would be guessing, and guessing at scale is the thing that gets
    // a host's submissions discounted.
    if (!mod) continue;
    const t = Date.parse(mod);
    if (Number.isFinite(t) && t >= cutoff) out.push(loc);
  }
  return { urls: out.slice(0, max), total, eligible: out.length };
}

async function submit(urls, label) {
  let ok = 0;
  for (let i = 0; i < urls.length; i += BATCH) {
    const batch = urls.slice(i, i + BATCH);
    const resp = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ host: HOST, key: KEY, keyLocation: KEY_LOCATION, urlList: batch }),
    });
    // 200 accepted, 202 accepted but key not yet verified — both are fine.
    const body = await resp.text().catch(() => '');
    if (resp.status === 200 || resp.status === 202) { ok += batch.length; continue; }
    // Never fail the deploy over this. A search-engine ping is not worth
    // blocking a release, and the status line says plainly what happened.
    console.error(`indexnow: ${label} batch NOT submitted — HTTP ${resp.status} ${body.slice(0, 200)}`);
    if (resp.status === 403) console.error(`  403 means the key file is unreachable. Check ${KEY_LOCATION} returns exactly the key.`);
    if (resp.status === 429) console.error('  429: too many requests; the rest waits for the next run.');
    break;
  }
  console.log(`indexnow: submitted ${ok} of ${urls.length} ${label} URLs`);
}

function preview(urls) {
  for (const u of urls.slice(0, 5)) console.log(`    ${u}`);
  if (urls.length > 5) console.log(`    ... and ${urls.length - 5} more`);
}

async function main() {
  if (dead) {
    const list = readList(UNBUILT);
    if (!list) { console.error('indexnow: no .cache/unbuilt-pages.json — run npm run build:pages first'); process.exit(1); }
    // A page the live site does serve is never reported gone, whatever this
    // build's plan says (a build without the price map plans differently).
    const live = new Set(readList(BUILT_LIVE) || []);
    const urls = list.filter(p => !live.has(p)).map(abs);
    console.log(`indexnow: ${urls.length} generated addresses that are not built (they answer 404)`
      + (live.size ? `, checked against the ${live.size} live pages` : ''));
    preview(urls);
    if (dry) { console.log('  --dry: nothing submitted'); return; }
    if (urls.length) await submit(urls, 'removed');
    return;
  }

  const { urls, total, eligible, error } = changedUrls();
  if (error) { console.error(`indexnow: ${error}`); process.exit(1); }
  const { gone, added, compared } = builtChanges();

  console.log(`indexnow: ${total} URLs in sitemap, ${eligible} changed in the last ${days} day(s)`);
  if (eligible > urls.length) console.log(`  capped at ${urls.length}`);
  console.log(compared
    ? `  against the live site: ${added.length} page(s) new, ${gone.length} removed`
    : '  no live built-pages list to compare with, so removed pages are not checked this run');
  const all = [...new Set([...urls, ...added, ...gone])];
  if (!all.length) { console.log('  nothing to submit — no page has changed recently'); return; }
  preview(all);
  if (dry) { console.log('  --dry: nothing submitted'); return; }
  await submit(all, 'changed');
}

main().catch(err => {
  console.error(`indexnow: ${err && err.message}`);
  // Deliberately exit 0 — see above.
});
