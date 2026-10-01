// Only pages with our own price data are offered to Google.
//
// AdSense rejected the site three times as "low value content". Most of what
// it crawled was the generated pages: a checklist reformatted from a template,
// the same card lists other checklist sites publish. The part no other site
// has is the price block, built from our own sold data. The Worker already took
// the ad tag off a page without one; this takes the page out of the index too,
// at serve time, from the same daily map — the build cannot, because it runs
// before the cron has priced anything.
const path = require('path');
const fs = require('fs');

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

(async () => {
  const { pricedPageKey, filterSitemap, RobotsNoindex } = await import(path.join(__dirname, '..', 'worker.js'));

  check('product, set and player pages need a price block, under the key it is built with',
    pricedPageKey('/sets/2024-panini-prizm-football/') === 'set:2024-panini-prizm-football'
      && pricedPageKey('/sets/2024-panini-prizm-football/downtown/') === 'subset:2024-panini-prizm-football/downtown'
      && pricedPageKey('/players/caleb-williams/') === 'player:caleb-williams');
  check('  ...and hubs, year hubs, teams and the app do not',
    ['/sets/', '/sets/2024/', '/players/', '/teams/', '/teams/chicago-bears/', '/', '/about', '/basketball/sets/2023-24/']
      .every(p => pricedPageKey(p) === null));
  check('  ...basketball and baseball pages carry their sport, so football\'s map never prices them',
    pricedPageKey('/basketball/sets/2023-24-panini-prizm-basketball/') === 'basketball:set:2023-24-panini-prizm-basketball'
      && pricedPageKey('/baseball/players/shohei-ohtani/') === 'baseball:player:shohei-ohtani');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://thecardhuddle.com/</loc>
  </url>
  <url>
    <loc>https://thecardhuddle.com/sets/2024-panini-prizm-football/</loc>
  </url>
  <url>
    <loc>https://thecardhuddle.com/sets/1999-pacific-omega-football/</loc>
  </url>
  <url>
    <loc>https://thecardhuddle.com/players/caleb-williams/</loc>
  </url>
  <url>
    <loc>https://thecardhuddle.com/sets/2024/</loc>
  </url>
  <url>
    <loc>https://thecardhuddle.com/basketball/sets/2023-24-panini-prizm-basketball/</loc>
  </url>
</urlset>
`;
  const blocks = { pages: { 'set:2024-panini-prizm-football': {}, 'player:caleb-williams': {} } };
  const out = filterSitemap(xml, blocks);
  const locs = (out.match(/<loc>[^<]+<\/loc>/g) || []).map(l => l.slice(5, -6).replace('https://thecardhuddle.com', ''));
  check('the sitemap keeps priced pages and navigation, and drops the unpriced',
    locs.join(' ') === '/ /sets/2024-panini-prizm-football/ /players/caleb-williams/ /sets/2024/', locs.join(' '));
  check('  ...and stays valid XML around what it drops', out.startsWith('<?xml') && out.trim().endsWith('</urlset>') && (out.match(/<url>/g) || []).length === (out.match(/<\/url>/g) || []).length);
  check('an empty map (a KV failure) changes nothing, rather than de-indexing the site', filterSitemap(xml, { pages: {} }) === xml && filterSitemap(xml, null) === xml);

  let content = null;
  new RobotsNoindex().element({ setAttribute: (k, v) => { if (k === 'content') content = v; } });
  check('an unpriced page\'s robots tag reads noindex, follow', content === 'noindex, follow');

  const worker = fs.readFileSync(path.join(__dirname, '..', 'worker.js'), 'utf8');
  check('the Worker serves /sitemap.xml through the filter',
    /if \(url\.pathname === '\/sitemap\.xml' && resp\.status === 200\)[\s\S]{0,200}filterSitemap\(await resp\.text\(\), await priceBlocks\(env\)\)/.test(worker));
  check('  ...and marks an unpriced page noindex only when the map loaded',
    /unpriced = !!\(blocks && Object\.keys\(blocks\.pages\)\.length && !blocks\.pages\[key\]\)/.test(worker)
      && /if \(unpriced\) h\.set\('X-Robots-Tag', 'noindex, follow'\)/.test(worker)
      && /if \(unpriced\) out = new HTMLRewriter\(\)\.on\('meta\[name="robots"\]', new RobotsNoindex\(\)\)/.test(worker));

  // The written side: guides are where original content goes, and an empty
  // section must not be offered to search in the meantime.
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  check('Guides & News is noindex while it has no articles, and articles carry the ad tag',
    /noindex: !list\.length,/.test(server) && /jsonLd: jsonLd, ads: true \}\)\);/.test(server)
      && /\(opts\.noindex \? 'noindex, follow' : 'index, follow'\)/.test(server));
  const about = fs.readFileSync(path.join(__dirname, '..', 'public', 'about.html'), 'utf8');
  check('  ...and the About page says which pages are offered to search, and why',
    /Which pages we put in front of search engines/.test(about) && /href="\/news"/.test(about));

  console.log(failures ? `\n${failures} check(s) failed` : '\nall priced-index checks passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('THREW:', e && e.stack || e); process.exit(1); });
