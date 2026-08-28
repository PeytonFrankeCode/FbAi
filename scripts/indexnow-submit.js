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
// Run: node scripts/indexnow-submit.js [--days N] [--max N] [--dry]
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
const SITEMAP = path.join(__dirname, '..', 'public', 'sitemap.xml');

const args = process.argv.slice(2);
const num = (flag, dflt) => {
  const a = args.find(x => x.startsWith(`--${flag}=`));
  return a ? (Number(a.split('=')[1]) || dflt) : dflt;
};
const days = num('days', 7);
const max = num('max', 2000);        // protocol allows 10,000 per request
const dry = args.includes('--dry');

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

async function main() {
  const { urls, total, eligible, error } = changedUrls();
  if (error) { console.error(`indexnow: ${error}`); process.exit(1); }

  console.log(`indexnow: ${total} URLs in sitemap, ${eligible} changed in the last ${days} day(s)`);
  if (!urls.length) {
    console.log('  nothing to submit — no page has changed recently');
    return;
  }
  if (eligible > urls.length) console.log(`  capped at ${urls.length}`);
  for (const u of urls.slice(0, 5)) console.log(`    ${u}`);
  if (urls.length > 5) console.log(`    ... and ${urls.length - 5} more`);

  if (dry) { console.log('  --dry: nothing submitted'); return; }

  const resp = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ host: HOST, key: KEY, keyLocation: KEY_LOCATION, urlList: urls }),
  });

  // 200 accepted, 202 accepted but key not yet verified — both are fine and
  // the second is expected on the very first run, before any engine has
  // fetched the key file.
  const body = await resp.text().catch(() => '');
  if (resp.status === 200 || resp.status === 202) {
    console.log(`indexnow: submitted ${urls.length} URLs (HTTP ${resp.status}${resp.status === 202 ? ' — key pending verification, normal on first run' : ''})`);
    return;
  }
  // Never fail the deploy over this. A search-engine ping is not worth
  // blocking a release, and the status line says plainly what happened.
  console.error(`indexnow: NOT submitted — HTTP ${resp.status} ${body.slice(0, 200)}`);
  if (resp.status === 403) {
    console.error(`  403 means the key file is unreachable. Check ${KEY_LOCATION} returns exactly the key.`);
  }
}

main().catch(err => {
  console.error(`indexnow: ${err && err.message}`);
  // Deliberately exit 0 — see above.
});
