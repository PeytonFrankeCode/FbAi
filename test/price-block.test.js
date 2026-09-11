// The price block.
//
// This one renders numbers onto 900-odd public pages, so the failures that
// matter are not crashes. They are: printing a confident median from four
// sales, printing a price with no date attached to it, printing an empty
// widget on a page with no data, and quietly claiming a mixed-condition
// median is a card's value.
//
// Every check below is one of those.
const path = require('path');
const {
  median, money, summarise, render, keyFor, MIN_SALES, MIN_CARDS, TOP_CARDS,
} = require(path.join(__dirname, '..', 'price-block-core.js'));

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

// ---- median ----
//
// The reason this is not a mean: one 1/1 patch auto in a set of base cards.
{
  check('the median ignores the outlier a mean would chase',
    median([200, 300, 400, 500, 90000]) === 400,
    `median ${median([200, 300, 400, 500, 90000])} vs mean ${Math.round((200 + 300 + 400 + 500 + 90000) / 5)}`);
  check('  ...and averages the middle pair on an even count',
    median([100, 200, 300, 400]) === 250);
  check('  ...and returns null rather than NaN or 0 on nothing',
    median([]) === null && median([undefined, null, NaN]) === null);
}

// ---- money ----
{
  check('cents render as dollars', money(1240) === '$12.40', money(1240));
  check('  ...and big numbers drop false precision and get separators',
    money(128400) === '$1,284', money(128400));
  check('  ...and nothing renders as null, never "$NaN"',
    money(null) === null && money(undefined) === null);
}

// ---- the bar ----
//
// The failure this prevents: a page printing "median $4.00" off three sales.
// It looks authoritative and it is noise, which is worse than a page that says
// nothing at all.
{
  const rows = [{ label: 'A #1', sales: 5, median: 400 }];
  check('a page below the sales bar produces nothing',
    summarise({ sales: MIN_SALES - 1, cards: MIN_CARDS, median: 400 }, rows) === null,
    `${MIN_SALES - 1} sales`);
  check('  ...and so does one below the distinct-card bar',
    summarise({ sales: 500, cards: MIN_CARDS - 1, median: 400 }, rows) === null,
    'many sales of one card is not a set-wide price');
  check('  ...and so does one with sales but no median',
    summarise({ sales: 500, cards: 50, median: null }, rows) === null);
  check('a page that clears both bars produces a summary',
    summarise({ sales: MIN_SALES, cards: MIN_CARDS, median: 400 }, rows) !== null);

  // Null must mean "render nothing", not "render an empty box".
  check('  ...and nothing renders as an empty string, not a stub',
    render(null, {}) === '' && render(undefined, {}) === '');
}

// ---- what actually gets printed ----
{
  const s = summarise(
    { sales: 1247, cards: 318, median: 1240, low: 200, high: 89000 },
    [
      { label: 'Jayden Daniels #1 Silver', sales: 61, median: 4200 },
      { label: 'Caleb Williams #2', sales: 44, median: 2150 },
      { label: 'Bad row with no median', sales: 5, median: null },
    ],
  );
  const html = render(s, { noun: '2025 Panini Prizm Football', from: '2026-07-19', to: '2026-08-30' });

  check('the block states the sample it is drawn from',
    html.includes('1,247') && html.includes('318'),
    'a median with no n behind it is not checkable');

  // A price with no date is a claim about the present that rots silently.
  check('  ...and the dates the prices come from',
    html.includes('2026-07-19') && html.includes('2026-08-30'));

  check('  ...and says these are mixed conditions',
    /all conditions and grades/i.test(html),
    'otherwise a raw-and-PSA-10 median reads as a card value');

  check('  ...and says they are sales, not appraisals',
    /not appraisals/i.test(html));

  check('rows with no median are dropped rather than printed empty',
    !html.includes('Bad row'), 'a blank price cell reads as a broken page');

  check('  ...and the good rows are there with their own medians',
    html.includes('Jayden Daniels #1 Silver') && html.includes('$42.00')
      && html.includes('Caleb Williams #2') && html.includes('$21.50'));

  // Injected into a static page a crawler reads without running JS.
  check('the block needs no JavaScript to appear',
    !/<script/i.test(html), 'a JS-rendered price is invisible to the crawler this is for');

  check('  ...and is a real section with a heading',
    /<section[^>]*class="lp-prices"/.test(html) && /<h2>/.test(html));
}

// ---- card photos ----
//
// These come from eBay and eBay purges them, so the failure to design for is
// not "no photo" but "photo that used to exist". Eight broken-image icons on a
// page under review for quality is worse than none at all.
{
  const { thumb, THUMB_SIZE } = require(path.join(__dirname, '..', 'price-block-core.js'));

  check('a photo is requested at the size the cell renders',
    thumb('https://i.ebayimg.com/images/g/abc/s-l1600.jpg', 'x').includes(`s-l${THUMB_SIZE}.jpg`),
    'the stored url is often s-l1600 — 200KB to paint a 40px thumbnail');

  check('  ...and a dead photo removes itself rather than showing a broken icon',
    /onerror="this\.remove\(\)"/.test(thumb('https://i.ebayimg.com/x/s-l64.jpg', 'x')),
    'the span keeps the row height, so the table does not reflow as images fail');

  check('  ...and a missing photo still occupies the cell',
    thumb(null, 'x') === '<span class="lp-thumb"></span>',
    'an empty cell would make the rows different heights');

  // The url comes from the sales table, which is fed by an importer reading
  // seller-supplied listings. It is not trusted markup.
  // Checked by parsing the src, not by searching for "onload=". The escaped
  // form contains that literal substring — `onload=&quot;` — so the obvious
  // check fails against correctly escaped output, which is exactly what the
  // first version of this did.
  {
    const out = thumb('https://i.ebayimg.com/a.jpg" onload="alert(1)', 'x');
    const src = (out.match(/src="([^"]*)"/) || [])[1] || '';
    check('a photo url cannot break out of the attribute',
      src.includes('&quot;') && !/\son[a-z]+=["']/.test(out.replace(/onerror="this\.remove\(\)"/, '')),
      'the quote is escaped, so the rest stays inside the attribute');
  }
  check('  ...and a non-https url is refused outright',
    thumb('javascript:alert(1)', 'x') === '<span class="lp-thumb"></span>',
    'a javascript: src is the one that actually executes');
  check('  ...as is a protocol-relative one',
    thumb('//evil.example/x.jpg', 'x') === '<span class="lp-thumb"></span>');

  // Alt text is the card name: useful to a screen reader, and to the image
  // search that is part of why photos are worth adding at all.
  check('every photo carries the card name as alt text',
    thumb('https://i.ebayimg.com/x/s-l140.jpg', 'Jayden Daniels #1').includes('alt="Jayden Daniels #1"'));

  // Dimensions on the tag reserve the space before the image arrives. Without
  // them the whole table jumps as each one loads, which is a Core Web Vitals
  // failure on the pages this is meant to improve.
  check('  ...and width/height, so the page does not shift as photos load',
    /width="\d+" height="\d+"/.test(thumb('https://i.ebayimg.com/x/s-l140.jpg', 'x')),
    'layout shift is measured, and these pages are being judged');
}

// ---- injection safety ----
//
// Card labels come from eBay listing titles by way of the sales table. They
// are not trusted markup.
{
  const s = summarise({ sales: 100, cards: 50, median: 500 },
    [{ label: '<script>alert(1)</script> "Rookie" & co', sales: 9, median: 500 }]);
  const html = render(s, {});
  check('a card label cannot inject markup',
    !html.includes('<script>') && html.includes('&lt;script&gt;'),
    'labels are parsed from seller-written titles');
  check('  ...and quotes and ampersands survive as text',
    html.includes('&quot;Rookie&quot;') && html.includes('&amp; co'));
}

// ---- the cap ----
{
  const many = Array.from({ length: 30 }, (_, i) => ({ label: `Card ${i}`, sales: 30 - i, median: 1000 }));
  const s = summarise({ sales: 900, cards: 30, median: 1000 }, many);
  check(`at most ${TOP_CARDS} cards get a row`,
    s.top.length === TOP_CARDS, `${s.top.length} rows`);
  check('  ...and they are the ones the caller ordered first',
    s.top[0].label === 'Card 0' && s.top[TOP_CARDS - 1].label === `Card ${TOP_CARDS - 1}`);
}

// ---- the key ----
//
// The builder writes these and the injector reads them, from different files.
// A disagreement renders nothing and throws nothing.
{
  check('the key format is shared, not reimplemented',
    keyFor('set', '2025-panini-prizm-football') === 'set:2025-panini-prizm-football'
      && keyFor('player', 'josh-allen') === 'player:josh-allen');
}

// ---- the seam ----
//
// Three files have to agree for a single price to appear: the builder writes
// a slot with a key, the cron writes a map under the same key, and the Worker
// matches a selector against the slot. Any one of them being wrong renders
// nothing and throws nothing — the page just looks exactly like it does today,
// which is precisely how this would ship broken and go unnoticed.
{
  const fs = require('fs');
  const ROOT = path.join(__dirname, '..');
  const buildSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'build-landing-pages.js'), 'utf8');
  const workerSrc = fs.readFileSync(path.join(ROOT, 'worker.js'), 'utf8');
  const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

  // 1. The builder emits a slot on both page types.
  const slots = (buildSrc.match(/\$\{priceSlot\(/g) || []).length;
  check('the builder puts a price slot on both page kinds',
    slots >= 2, `${slots} call sites`);

  // 2. The Worker's selector matches the attribute the builder writes.
  const attr = /data-price-key/.test(buildSrc);
  const sel = workerSrc.match(/\.on\('([^']+)'\s*,\s*new PriceSlotFiller/);
  check('  ...and the Worker selects the element the builder emits',
    attr && sel && /data-price-key/.test(sel[1]),
    sel ? `selector ${sel[1]}` : 'no PriceSlotFiller registration found');

  // 3. Both sides build the key the same way. Checked against a real
  //    generated page rather than the source text: the first version of this
  //    matched a template literal by regex, got the escaping wrong, and
  //    failed on correct code — a guard that can only be satisfied by the
  //    exact spelling it was written against is worse than no guard.
  const sample = [
    ['set', '2025-panini-prizm-football', 'sets/2025-panini-prizm-football'],
    ['player', 'josh-allen', 'players/josh-allen'],
  ];
  for (const [kind, id, dir] of sample) {
    const file = path.join(ROOT, 'public', dir, 'index.html');
    if (!fs.existsSync(file)) {
      console.log(`SKIP  ${dir} slot key  — run \`npm run build:pages\` first (CI does)`);
      continue;
    }
    const page = fs.readFileSync(file, 'utf8');
    const m = page.match(/data-price-key="([^"]+)"/);
    check(`  ...and /${dir}/ carries exactly the key keyFor() builds`,
      m && m[1] === keyFor(kind, id),
      m ? `page has "${m[1]}", keyFor gives "${keyFor(kind, id)}"` : 'no slot on the page');
  }
  check('  ...and the cron writes its map under keys from keyFor()',
    /priceKeyFor\(kind, id\)/.test(serverSrc),
    'server.js uses the shared helper rather than its own template');

  // 4. Rendering only where it should. Running the rewriter over every HTML
  //    response would put a parser in front of the app shell for nothing.
  check('injection is scoped to the two page prefixes',
    /\^\\\/\(sets\|players\)\\\//.test(workerSrc),
    'and not run over every HTML response on the site');

  // 5. The failure mode. A missing price must never turn a working page into
  //    an error — this is a decoration on 900 pages, not a feature they need.
  const at = workerSrc.indexOf('PriceSlotFiller(blocks');
  const around = at === -1 ? '' : workerSrc.slice(Math.max(0, at - 900), at + 400);
  check('a failure to price degrades to the page as it is today',
    /catch\s*\(priceErr\)/.test(around),
    'injection is wrapped so it cannot 502 a page over a missing median');

  // 6. The pieces the call site needs must EXIST, not merely be called.
  //
  // This is the check that was missing, and its absence cost a day. A merge
  // resolving a conflict in worker.js deleted both priceBlocks() and
  // PriceSlotFiller while keeping the line that calls them. The call then threw
  // ReferenceError, the defensive try/catch around the injection swallowed it,
  // and every page quietly rendered without a price block — while every check
  // in this file still passed, because they all matched the surviving call
  // site.
  //
  // Worse, the D1 check below used indexOf() to slice between two names that
  // were both gone: indexOf returns -1, the slice is empty, and testing an
  // empty string for "no D1 query" passes. A guard that reads deleted code
  // reports success about nothing at all.
  const defines = (re, what) => check(`the Worker actually defines ${what}`,
    re.test(workerSrc), 'the call site alone is not enough — a merge can keep one and drop the other');
  defines(/async function priceBlocks\s*\(/, 'priceBlocks()');
  defines(/class PriceSlotFiller\b/, 'PriceSlotFiller');

  // Every identifier the injection block calls has to be defined somewhere in
  // the file. Checked generically so a future addition is covered too.
  {
    const at = workerSrc.indexOf("if (resp.status === 200 && /^\\/(sets|players)\\//");
    const inject = at === -1 ? '' : workerSrc.slice(at, at + 700);
    check('the injection block was found', at !== -1);
    const called = [...inject.matchAll(/\bnew (\w+)\(|\bawait (\w+)\(/g)]
      // Runtime globals the Worker gets from Cloudflare, and init() which is
      // defined above the region this slice covers.
      .map(m => m[1] || m[2])
      .filter(n => !['init', 'Response', 'Headers', 'HTMLRewriter', 'Request', 'URL'].includes(n));
    const undef = [...new Set(called)].filter(n =>
      !new RegExp(`(function|class|const|let)\\s+${n}\\b`).test(workerSrc));
    check('  ...and every name it calls is defined in worker.js',
      undef.length === 0,
      undef.length ? `UNDEFINED: ${undef.join(', ')}` : `${[...new Set(called)].join(', ')}`);
  }

  // The cost claim in the design: no D1 on the request path. Guarded against
  // the empty-slice trap above — an absent function must fail, not pass.
  const fnAt = workerSrc.indexOf('async function priceBlocks(env)');
  const endAt = workerSrc.indexOf('class PriceSlotFiller');
  const rewriterBlock = (fnAt === -1 || endAt === -1 || endAt <= fnAt)
    ? null : workerSrc.slice(fnAt, endAt);
  check('the request path reads KV, never D1',
    rewriterBlock !== null && !/getNflDb|\.prepare\(/.test(rewriterBlock),
    rewriterBlock === null ? 'could not locate the loader — it may not exist'
      : 'a D1 query per page view is the design this replaced');
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall price-block checks passed');
process.exit(failures ? 1 : 0);
