// About, Contact and Methodology.
//
// The site had none of these. Google's publisher guidance treats "who runs this
// and how do I reach them" as part of whether a site is trustworthy, and their
// absence is a routine contributor to the low-value-content finding this site
// actually received.
//
// A page nobody can reach is worth nothing, so this checks they are linked from
// both footers and listed in the sitemap — not merely that the files exist.
const fs = require('fs');
const path = require('path');

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

const ROOT = path.join(__dirname, '..');
const PAGES = ['about.html', 'contact.html', 'methodology.html'];
const EMAIL = 'cardhuddlecollectors@gmail.com';

for (const p of PAGES) {
  const file = path.join(ROOT, 'public', p);
  if (!fs.existsSync(file)) { check(`${p} exists`, false); continue; }
  const html = fs.readFileSync(file, 'utf8');

  check(`${p} exists and has real content`,
    html.replace(/<[^>]*>/g, ' ').split(/\s+/).filter(Boolean).length > 300,
    `${html.replace(/<[^>]*>/g, ' ').split(/\s+/).filter(Boolean).length} words`);

  // A page added to demonstrate the site is legitimate must itself be
  // indexable, or it demonstrates nothing to the crawler.
  check(`  ...and is indexable`,
    /<meta name="robots" content="index, follow"/.test(html));

  check(`  ...with its own title and canonical`,
    new RegExp(`<link rel="canonical" href="https://thecardhuddle.com/${p}"`).test(html)
      && /<title>[^<]{8,}<\/title>/.test(html));
}

// The contact route has to actually be a route.
{
  const contact = fs.readFileSync(path.join(ROOT, 'public', 'contact.html'), 'utf8');
  check('contact.html carries a working mailto',
    contact.includes(`mailto:${EMAIL}`) && contact.includes(EMAIL),
    'a contact page with no address is worse than none');
}

// Reachable from both footers — the app shell and the generated landing pages
// are separate templates and it is easy to update one and forget the other.
{
  const idx = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const build = fs.readFileSync(path.join(ROOT, 'scripts', 'build-landing-pages.js'), 'utf8');
  for (const p of PAGES) {
    check(`/${p} is linked from the app footer`, idx.includes(`href="/${p}"`));
    check(`  ...and from the landing-page footer`, build.includes(`href="/${p}"`));
  }
}

// In the sitemap, or a crawler only finds them by following a footer link.
{
  const sm = path.join(ROOT, 'public', 'sitemap.xml');
  if (!fs.existsSync(sm)) {
    console.log('SKIP  sitemap listing  — run `npm run build:pages` first (CI does)');
  } else {
    const xml = fs.readFileSync(sm, 'utf8');
    for (const p of PAGES) {
      check(`/${p} is in the sitemap`, xml.includes(`<loc>https://thecardhuddle.com/${p}</loc>`));
    }
  }
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall info-page checks passed');
process.exit(failures ? 1 : 0);
