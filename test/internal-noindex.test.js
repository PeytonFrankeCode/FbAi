// Internal pages (admin, desks, diagnostics) must tell crawlers not to index
// them. An AdSense reviewer that finds an admin login or a debug page reads
// the site as unfinished. Pages the public is meant to read are listed here;
// every other .html in public/ has to carry noindex.
const fs = require('fs');
const path = require('path');
const PUB = path.join(__dirname, '..', 'public');
const PUBLIC_PAGES = new Set(['index.html', 'about.html', 'contact.html',
  'methodology.html', 'privacy.html', 'terms.html']);

let failures = 0;
for (const f of fs.readdirSync(PUB).filter(f => f.endsWith('.html'))) {
  if (PUBLIC_PAGES.has(f)) continue;
  const ok = /<meta[^>]+name="robots"[^>]+noindex/i.test(fs.readFileSync(path.join(PUB, f), 'utf8'));
  console.log(`${ok ? 'PASS' : 'FAIL'}  internal page ${f} is noindex`);
  if (!ok) failures++;
}
console.log(failures ? `\n${failures} check(s) failed` : '\nall internal-noindex checks passed');
process.exit(failures ? 1 : 0);
