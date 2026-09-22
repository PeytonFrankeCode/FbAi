// Ads only on a page that has something of its own to say.
//
// WHY THIS EXISTS. The generated pages are one template over checklist data —
// facts published by Panini and Topps, reformatted. What makes any given page
// worth reading is its price block: our own sold data, which no other site
// has. price-block-core.js says as much in its own opening lines, about pages
// "titled 'Checklist & Prices'" that "carry a checklist and no prices".
//
// A page whose block came back empty did not clear MIN_SALES/MIN_CARDS, so
// what is left is the template. Google's scaled-content policy is aimed at
// exactly that: many pages carrying advertising and no material information
// beyond the substitutions. So those pages do not carry advertising.
//
// The build already gates the tag on whether a page is INDEXABLE. This is the
// stricter half of the same question — indexable AND priced — and it has to
// happen at the edge because only the edge knows whether a block exists.
//
// THE FAILURE THAT WOULD MATTER MOST is the safety one: KV returning nothing
// is indistinguishable from "no page has prices", and treating it that way
// would strip every ad on the site over one failed read. There is a check for
// that below, and it is the reason the caller tests Object.keys(pages).length
// before building the rewriter at all.
const path = require('path');
const ROOT = path.join(__dirname, '..');
const fs = require('fs');

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

(async () => {
  const { priceKeyForPath, AdTagRemover } = await import(path.join(ROOT, 'worker.js'));

  // ---- The URL has to produce the key the build wrote ----
  //
  // These are not invented: build-landing-pages.js calls priceSlot('set', cl.id),
  // priceSlot('subset', cl.id + '/' + slug) and priceSlot('player', p.slug), and
  // keyFor is `${kind}:${id}`. A drift here silently strips ads from priced
  // pages, so the mapping is pinned.
  const KEYS = [
    ['/players/caleb-williams/', 'player:caleb-williams'],
    ['/players/caleb-williams', 'player:caleb-williams'],       // no trailing slash
    ['/sets/2024-panini-prizm-football/', 'set:2024-panini-prizm-football'],
    ['/sets/2024-panini-prizm-football/downtown/', 'subset:2024-panini-prizm-football/downtown'],
  ];
  for (const [p, want] of KEYS) {
    const got = priceKeyForPath(p);
    check(`${p} -> ${want}`, got === want, got === want ? '' : `got ${got}`);
  }

  // ---- Paths that are not a priced page produce no key ----
  for (const p of ['/', '/teams/kansas-city-chiefs/', '/about.html', '/sets/', '/players/']) {
    check(`no key for ${p}`, priceKeyForPath(p) === null, String(priceKeyForPath(p)));
  }
  // A year hub lands in the set namespace and simply misses, which is correct
  // for it — it is not a product and has no block.
  check('a year hub yields a key that will miss, not a crash',
    priceKeyForPath('/sets/2024/') === 'set:2024');

  // ---- The remover takes the ad tag and nothing else ----
  {
    const r = new AdTagRemover();
    const el = (src) => { let removed = false;
      return { getAttribute: () => src, remove() { removed = true; }, get removed() { return removed; } }; };

    const ad = el('https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-3644779384068007');
    r.element(ad);
    check('the AdSense tag is removed', ad.removed && r.removed === 1);

    const keep = [
      'https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js',
      'https://www.googletagmanager.com/gtag/js?id=G-37RKDTRBCH',
      'https://www.google.com/recaptcha/api.js?render=abc',
      '/app.js?v=deadbeef',
    ];
    let kept = 0;
    for (const src of keep) {
      const e = el(src);
      r.element(e);
      if (!e.removed) kept++; else check(`WRONGLY removed ${src}`, false);
    }
    check(`  ...and analytics, chart.js, reCAPTCHA and app.js are left alone`,
      kept === keep.length && r.removed === 1,
      `${kept}/${keep.length} kept, ${r.removed} removed total`);

    // A <script> with no src at all must not throw.
    const inline = { getAttribute: () => null, remove() { check('inline script removed', false); } };
    let threw = null;
    try { r.element(inline); } catch (e) { threw = e.message; }
    check('an inline script is ignored rather than throwing', threw === null, threw || 'handled');
  }

  // ---- THE SAFETY CHECK: a KV failure must not strip the site ----
  {
    const src = fs.readFileSync(path.join(ROOT, 'worker.js'), 'utf8');
    check('the rewriter only runs when the price map actually loaded',
      /if \(blocks && Object\.keys\(blocks\.pages\)\.length\)/.test(src),
      'priceBlocks() returns { pages: {} } on a KV failure, and an empty map '
      + 'means "no page has prices" — stripping every ad over one failed read '
      + 'would be far worse than serving a page unpriced');
    check('  ...and the ad handler is only attached when THIS page has no block',
      /const key = priceKeyForPath\(url\.pathname\);\s*\n\s*if \(key && !blocks\.pages\[key\]\)/.test(src),
      'a page with a block keeps its ads');
    check('  ...while the price filler is attached either way',
      /\.on\('div\[data-price-key\]', new PriceSlotFiller/.test(src));
  }

  console.log(failures ? `\n${failures} check(s) failed` : '\nall ad-gate checks passed');
  process.exit(failures ? 1 : 0);
})();
