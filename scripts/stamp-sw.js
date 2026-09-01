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

function main() {
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
