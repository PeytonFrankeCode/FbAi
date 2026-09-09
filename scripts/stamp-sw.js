#!/usr/bin/env node
// Stamp the service worker's cache version from the content it caches.
//
// sw.js caches app.js, style.css, index.html and the checklist JSON, and keys
// its caches on a VERSION constant whose comment reads "Bump VERSION to force a
// clean cache swap on the next visit." Nobody ever did: it sat at 'v1' for 137
// commits, so every returning visitor kept whatever app.js and checklist index
// they first downloaded, for months.
//
// That failure is invisible from the inside. Deploys go green, the site is
// correct for anyone with an empty cache, and the bug only shows up as a user
// describing something that cannot happen — a banner announcing 2026 Bowman
// that opens 2026 Topps, because the banner text came from index.html
// (network-first, fresh) and its click handler came from app.js (cached,
// months old). Two halves of one feature at different ages.
//
// So the version is computed rather than remembered. It hashes the files whose
// staleness is user-visible, which means an unchanged deploy keeps the same
// version and does not needlessly evict anyone's offline copy — the caching
// exists so the app works on bad wifi at a card show, and throwing it away on
// every deploy would trade one bug for a worse one.
//
// The same class of bug lives in index.html, which requests its assets as
// `style.css?v=159` and `app.js?v=210` — cache keys a human has to remember to
// bump. #550 changed style.css and did not bump the number, so returning
// visitors were served new HTML against a months-old stylesheet. The homepage
// <h1> that commit added is styled by a .sr-only rule in the CSS they did not
// have, so it rendered as a giant green heading instead of being invisible:
// one feature, two halves, different ages. Again.
//
// So those are computed here too, from the content of the file each one points
// at. Note this runs BEFORE the sw.js version is computed, because index.html
// is one of the files that version hashes — stamp it after and the recorded
// version would describe an index.html that no longer exists.
//
// Run: node scripts/stamp-sw.js [--check]
//   --check  verify the file is stampable and report the version, write nothing
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PUBLIC = path.join(__dirname, '..', 'public');
const SW = path.join(PUBLIC, 'sw.js');

// The files a stale copy of which produces a visibly wrong site. Not every
// asset: adding a landing page should not evict everyone's cache, and those are
// not served from these caches anyway.
const WATCHED = [
  'app.js',
  'style.css',
  'index.html',
  'data/checklists/index.json',
];

// An exact anchor rather than a loose regex. If someone renames the constant or
// changes its shape, this must fail loudly at build time — silently not
// stamping is precisely the failure being fixed.
const ANCHOR = /^(const VERSION = ')([^']*)(';)$/m;

function version(swSrc) {
  const h = crypto.createHash('sha256');
  for (const rel of WATCHED) {
    const p = path.join(PUBLIC, rel);
    if (!fs.existsSync(p)) throw new Error(`stamp-sw: ${rel} is missing — refusing to stamp a version that ignores it`);
    // The name goes into the hash too, so moving content between files changes
    // the version rather than cancelling out.
    h.update(rel).update('\0').update(fs.readFileSync(p));
  }
  // sw.js counts as well — a change to the caching strategy itself needs to
  // reach existing visitors just as much as a change to app.js does. It is
  // hashed with its own VERSION line blanked, because otherwise stamping would
  // change the input that produced the stamp and never settle.
  h.update('sw.js').update('\0').update(swSrc.replace(ANCHOR, "$1$3"));
  return 'b' + h.digest('hex').slice(0, 12);
}

// `<link href="style.css?v=159">` and `<script src="app.js?v=210">`.
//
// An exact shape again, and a hard failure if a reference goes missing: a
// silently un-stamped asset is the whole bug. The tag order in index.html is
// not assumed — each asset is matched on its own.
const ASSET_REFS = ['style.css', 'app.js'];

function stampAssetRefs() {
  const INDEX = path.join(PUBLIC, 'index.html');
  let html = fs.readFileSync(INDEX, 'utf8');
  const before = html;
  const changes = [];

  for (const asset of ASSET_REFS) {
    const p = path.join(PUBLIC, asset);
    if (!fs.existsSync(p)) throw new Error(`stamp-sw: public/${asset} is missing`);
    const hash = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 10);
    const ref = new RegExp(`(${asset.replace('.', '\\.')}\\?v=)([A-Za-z0-9]+)`, 'g');
    const found = html.match(ref);
    if (!found) throw new Error(`stamp-sw: index.html has no ${asset}?v= reference to stamp`);
    let from = null;
    html = html.replace(ref, (_, head, old) => { from = old; return head + hash; });
    if (from !== hash) changes.push(`${asset} ?v=${from} -> ?v=${hash}`);
  }

  if (html !== before) {
    fs.writeFileSync(INDEX, html);
    for (const c of changes) console.log(`index.html ${c}`);
  } else {
    console.log('index.html asset versions already current');
  }
}

function main() {
  if (!process.argv.includes('--check')) stampAssetRefs();
  const src = fs.readFileSync(SW, 'utf8');
  const m = src.match(ANCHOR);
  if (!m) {
    console.error(`stamp-sw: could not find "const VERSION = '...';" in public/sw.js.`);
    console.error(`  The service worker keys its caches on that constant. Without it every`);
    console.error(`  returning visitor keeps a stale app.js and checklist index indefinitely.`);
    process.exit(1);
  }

  const next = version(src);
  const current = m[2];

  if (process.argv.includes('--check')) {
    console.log(`sw.js VERSION = '${current}'`);
    console.log(`content hash   = '${next}'`);
    console.log(current === next ? 'up to date' : 'would restamp');
    return;
  }

  if (current === next) {
    console.log(`sw.js VERSION already '${next}' — nothing cached needs evicting`);
    return;
  }

  fs.writeFileSync(SW, src.replace(ANCHOR, `$1${next}$3`));
  console.log(`sw.js VERSION '${current}' -> '${next}'`);
  console.log(`  hashed: ${WATCHED.join(', ')}`);
}

main();
