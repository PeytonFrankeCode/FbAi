// An unknown URL answers 404, and carries no ad tag.
//
// WHY THIS EXISTS. not_found_handling is "single-page-application", so the
// ASSETS binding returns index.html — status 200, AdSense script included —
// for every path it does not recognise. Measured against the running app:
//
//   /wp-admin/                   ->  HTTP 200   adsense tags: 1
//   /.env                        ->  HTTP 200   adsense tags: 1
//   /this-page-does-not-exist    ->  HTTP 200   adsense tags: 1
//
// Three problems at once: ads on a page with no content, a soft 404 for
// Google to index, and ad impressions painted against the bot scans this
// worker's own comments note arriving at /wp-admin/*. That last one is
// invalid traffic, which costs an AdSense account rather than an application.
//
// THE RISK THIS FILE GUARDS is the opposite direction. A rule that answers 404
// too eagerly takes real pages off the site for every visitor at once, which
// is far worse than the soft 404s it replaces. So most of what follows is
// real routes that must keep returning HTML, including every page type the
// build emits and every static info page in public/.
const path = require('path');
const ROOT = path.join(__dirname, '..');
const fs = require('fs');

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

(async () => {
  const { isKnownHtmlPath, notFoundResponse } = await import(path.join(ROOT, 'worker.js'));

  // ---- Real routes must survive ----
  const KEEP = [
    ['the app shell', '/'],
    ['the inventory view', '/inventory'],
    ['  ...with a trailing slash', '/inventory/'],
    ['the stats view', '/stats'],
    ['a product page', '/sets/2024-panini-prizm-football/'],
    ['a subset page', '/sets/2024-panini-prizm-football/downtown/'],
    ['a year hub', '/sets/2024/'],
    ['the sets hub', '/sets/'],
    ['a player page', '/players/caleb-williams/'],
    ['the players hub', '/players/'],
    ['a team page', '/teams/kansas-city-chiefs/'],
    ['the news index', '/news'],
    ['a news article', '/news/whats-moving-this-week/'],
  ];
  for (const [label, p] of KEEP) {
    check(`kept — ${label} (${p})`, isKnownHtmlPath(p) === true);
  }

  // Every static page actually in public/ has to pass. Read from disk rather
  // than listed by hand, so adding one cannot silently start 404ing it.
  {
    const files = fs.readdirSync(path.join(ROOT, 'public')).filter(f => f.endsWith('.html'));
    const bad = files.filter(f => !isKnownHtmlPath('/' + f));
    check(`kept — all ${files.length} static .html pages in public/`,
      bad.length === 0, bad.length ? bad.join(', ') : files.slice(0, 4).join(', ') + '…');
  }

  // ---- Scans and junk must not ----
  const DROP = [
    ['a WordPress scan', '/wp-admin/'],
    ['an env-file probe', '/.env'],
    ['an xmlrpc probe', '/xmlrpc.php'],
    ['a php admin probe', '/admin/config.php'],
    ['a plain typo', '/this-page-does-not-exist'],
    ['a missing image', '/missing.png'],
    ['a missing script', '/vendor/nope.js'],
  ];
  for (const [label, p] of DROP) {
    check(`404 — ${label} (${p})`, isKnownHtmlPath(p) === false);
  }

  // ---- The 404 itself ----
  {
    const r = notFoundResponse();
    const body = await r.text();
    check('the 404 carries a 404 status', r.status === 404, String(r.status));
    check('  ...and no ad tag', !/adsbygoogle/.test(body),
      'serving the app shell with a 404 status would keep the script and the point of this');
    check('  ...and no script at all', !/<script/i.test(body),
      'a junk URL should cost nothing to serve');
    check('  ...and tells a crawler not to index it',
      /noindex/.test(body) && /noindex/.test(r.headers.get('x-robots-tag') || ''));
    check('  ...and is not cached, like every other HTML response here',
      /no-store/.test(r.headers.get('cache-control') || ''));
    check('  ...and still offers a way back',
      /href="\/"/.test(body), 'a dead end is a worse page than a 404');
  }

  // ---- It has to be wired in, not merely defined ----
  {
    const src = fs.readFileSync(path.join(ROOT, 'worker.js'), 'utf8');
    check('the check runs on the ASSETS HTML path',
      /if \(resp\.status === 200 && !isKnownHtmlPath\(url\.pathname\)\) \{\s*\n\s*return notFoundResponse\(\);/.test(src),
      'defined but never called is the failure this repo has already had once');
    check('  ...only on a 200, so a real upstream error is passed through',
      /resp\.status === 200 && !isKnownHtmlPath/.test(src));
  }

  console.log(failures ? `\n${failures} check(s) failed` : '\nall soft-404 checks passed');
  process.exit(failures ? 1 : 0);
})();
