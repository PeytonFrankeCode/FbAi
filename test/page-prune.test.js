// Pages taken out of search after Search Console's last 3 months (owner,
// Oct 2026): insert pages, the basketball and baseball pages still in
// testing, and placeholder players. Player pages and main set pages stay.
const path = require('path');
let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};
(async () => {
  const { prunedPath, filterSitemap, SEARCH_CONSOLE_REDIRECTS } = await import(path.join(__dirname, '..', 'worker.js'));
  check('insert pages, basketball, baseball and placeholder players are pruned',
    prunedPath('/sets/2025-panini-select-football/dual-swatch/') && prunedPath('/basketball/players/lebron-james/')
    && prunedPath('/baseball/') && prunedPath('/players/mystery-rookie-6/'));
  check('  ...player pages, main set pages, teams, the set index and the stylesheet are not',
    !prunedPath('/players/jaxon-smith-njigba/') && !prunedPath('/sets/2023-panini-prizm-football/') && !prunedPath('/sets/')
    && !prunedPath('/teams/miami-dolphins/') && !prunedPath('/sets/landing.css') && !prunedPath('/news/market-movers'));
  const u = (p) => `  <url><loc>https://thecardhuddle.com${p}</loc></url>\n`;
  const xml = '<urlset>\n' + u('/players/bo-nix/') + u('/sets/2025-panini-select-football/dual-swatch/') + u('/basketball/') + u('/sets/2025-panini-select-football/') + '</urlset>';
  for (const [label, blocks] of [['with the price map', { pages: { 'player:bo-nix': 1, 'set:2025-panini-select-football': 1 } }], ['without it', { pages: {} }]]) {
    const out = filterSitemap(xml, blocks);
    check(`the sitemap leaves them out (${label})`, out.includes('/players/bo-nix/') && out.includes('/sets/2025-panini-select-football/</loc>')
      && !out.includes('dual-swatch') && !out.includes('/basketball/'), out);
  }
  check('old long or misspelt player addresses go to the real page',
    SEARCH_CONSOLE_REDIRECTS['garrett-wilson-ohio-state-buckeyes'] === 'garrett-wilson' && SEARCH_CONSOLE_REDIRECTS['audric-estim'] === 'audric-estime');
  const fs = require('fs');
  const w = fs.readFileSync(path.join(__dirname, '..', 'worker.js'), 'utf8');
  check('  ...and a pruned page is served noindex', /const pruned = resp\.status === 200 && prunedPath\(url\.pathname\);/.test(w)
    && /if \(hideFromSearch \|\| pruned\) h\.set\('X-Robots-Tag', 'noindex, follow'\)/.test(w));
  // Pages Google already sends clicks to stay searchable (owner, Oct 2026).
  const { isEarner, PAGES } = require(path.join(__dirname, '..', 'search-earners.js'));
  check('a page with Google clicks is never pruned or dropped from the sitemap, priced or not',
    isEarner('/players/makai-lemon/') && !prunedPath('/sets/2025-panini-select-football/field-level/')
    && filterSitemap('<urlset>\n' + u('/players/makai-lemon/') + u('/players/nobody-here/') + '</urlset>', { pages: { 'player:bo-nix': 1 } }).includes('makai-lemon')
    && !filterSitemap('<urlset>\n' + u('/players/nobody-here/') + '</urlset>', { pages: { 'player:bo-nix': 1 } }).includes('nobody-here'));
  check('  ...but placeholder players and other sports stay hidden even when listed',
    PAGES['/players/mystery-rookie-6/'] && !isEarner('/players/mystery-rookie-6/') && prunedPath('/players/mystery-rookie-6/'));
  check('  ...and an unpriced earner is searchable but still carries no ad tag',
    /hideFromSearch = unpriced && !isEarner\(url\.pathname\)/.test(w) && /if \(key && !blocks\.pages\[key\]\) \{\s*rw\.on\('script\[src\]', new AdTagRemover\(\)\)/.test(w));
  const sm = fs.existsSync(path.join(__dirname, '..', 'public', 'sitemap.xml')) ? fs.readFileSync(path.join(__dirname, '..', 'public', 'sitemap.xml'), 'utf8') : '';
  const listed = Object.keys(PAGES).filter(p => isEarner(p) && fs.existsSync(path.join(__dirname, '..', 'public', p, 'index.html')));
  const missing = listed.filter(p => !sm.includes(`<loc>https://thecardhuddle.com${p}</loc>`));
  check('  ...and the build puts every earner that has a page into the sitemap', sm && listed.length > 400 && !missing.length, missing.slice(0, 5).join(' '));
  console.log(failures ? `\n${failures} check(s) failed` : '\nall page-prune checks passed');
  process.exit(failures ? 1 : 0);
})();
