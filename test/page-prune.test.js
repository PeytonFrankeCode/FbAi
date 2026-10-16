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
    prunedPath('/sets/2025-panini-select-football/field-level/') && prunedPath('/basketball/players/lebron-james/')
    && prunedPath('/baseball/') && prunedPath('/players/mystery-rookie-6/'));
  check('  ...player pages, main set pages, teams, the set index and the stylesheet are not',
    !prunedPath('/players/jaxon-smith-njigba/') && !prunedPath('/sets/2023-panini-prizm-football/') && !prunedPath('/sets/')
    && !prunedPath('/teams/miami-dolphins/') && !prunedPath('/sets/landing.css') && !prunedPath('/news/market-movers'));
  const u = (p) => `  <url><loc>https://thecardhuddle.com${p}</loc></url>\n`;
  const xml = '<urlset>\n' + u('/players/bo-nix/') + u('/sets/2025-panini-select-football/field-level/') + u('/basketball/') + u('/sets/2025-panini-select-football/') + '</urlset>';
  for (const [label, blocks] of [['with the price map', { pages: { 'player:bo-nix': 1, 'set:2025-panini-select-football': 1 } }], ['without it', { pages: {} }]]) {
    const out = filterSitemap(xml, blocks);
    check(`the sitemap leaves them out (${label})`, out.includes('/players/bo-nix/') && out.includes('/sets/2025-panini-select-football/</loc>')
      && !out.includes('field-level') && !out.includes('/basketball/'), out);
  }
  check('old long or misspelt player addresses go to the real page',
    SEARCH_CONSOLE_REDIRECTS['garrett-wilson-ohio-state-buckeyes'] === 'garrett-wilson' && SEARCH_CONSOLE_REDIRECTS['audric-estim'] === 'audric-estime');
  const fs = require('fs');
  const w = fs.readFileSync(path.join(__dirname, '..', 'worker.js'), 'utf8');
  check('  ...and a pruned page is served noindex', /const pruned = resp\.status === 200 && prunedPath\(url\.pathname\);/.test(w)
    && /if \(unpriced \|\| pruned\) h\.set\('X-Robots-Tag', 'noindex, follow'\)/.test(w));
  console.log(failures ? `\n${failures} check(s) failed` : '\nall page-prune checks passed');
  process.exit(failures ? 1 : 0);
})();
