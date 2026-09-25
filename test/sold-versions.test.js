// Sold search, grouped by version: each listing tied to ONE of the searched
// player's checklist cards and one of that set's parallels, or to nothing.
//
// The matching runs in the browser (public/app.js), so this lifts the pieces it
// needs out of app.js and runs them against the real checklist file — the same
// approach search-identity.test.js takes for _isOtherCard. The listings are the
// shapes that were checked in a real browser when this was built, including
// the three it first got wrong.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

// [start marker, end marker] — each slice must exist, or the test is testing
// nothing and must say so.
const slices = [
  ['const PARALLEL_STRIP_TEAMS', '// Used when the query matches no checklist product.'],
  ['const SCAN_KEY_PARALLEL_PHRASES', 'function _scanKeyTerms'],
  ['function _fallbackParallelMatchers', '// Context for the active search'],
  ['const _VERSION_SUFFIX_RE', 'function _versionOf'],
];
let code = 'let _fallbackMatchersCache = null;\n';
for (const [a, b] of slices) {
  const i = src.indexOf(a), j = src.indexOf(b, i + 1);
  check(`app.js still holds "${a}" where this test expects it`, i > 0 && j > i, `start=${i} end=${j}`);
  if (i < 0 || j < 0) { console.log('\ncannot continue'); process.exit(1); }
  code += src.slice(i, j) + '\n';
}
const ctx = { console };
vm.createContext(ctx);
vm.runInContext(code + '\nthis.build = _buildVersionCtx; this.match = _matchVersion;', ctx);

const product = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'public', 'data', 'checklists', '2017-panini-prizm-football.json'), 'utf8'));
const vctx = ctx.build(product, 'Patrick Mahomes', '2017 Panini Prizm Patrick Mahomes Silver');
check('the player is found in the checklist ("Mahomes II" there, "Mahomes" in the query)',
  vctx && vctx.cards.some(c => c.number === '269'),
  vctx ? `${vctx.cards.length} cards: ${vctx.cards.map(c => '#' + c.number).join(' ')}` : 'no context');

const read = (title) => {
  const v = ctx.match(title, vctx);
  return v ? `#${v.card.number} ${v.parallel}` : null;
};
const CASES = [
  // [title, expected (#number parallel) or null for "cannot tell"]
  ['2017 Panini Prizm Patrick Mahomes II #269 Silver Prizm RC', '#269 Silver'],
  ['2017 Panini Prizm Patrick Mahomes #269 Silver Holo Prizm RC', '#269 Silver'],
  ['2017 Prizm Patrick Mahomes Silver Prizm RC #269 PSA 10', '#269 Silver'],
  ['2017 Panini Prizm Patrick Mahomes II #269 Base Rookie RC', '#269 Base'],
  ['2017 Panini Prizm Patrick Mahomes #269 RC Chiefs', '#269 Base'],
  // "Red, White and Blue" in the checklist; read as plain Blue at first.
  ['2017 Panini Prizm Patrick Mahomes II #269 Red White Blue RC', '#269 Red White Blue'],
  ['2017 Panini Prizm Patrick Mahomes Illumination #3 Rookie', '#3 Base'],
  ['2017 Panini Prizm Patrick Mahomes Rookie Autographs #65 Auto', '#65 Base'],
  // An insert named without its number.
  ['2017 Panini Prizm Patrick Mahomes Illumination Rookie', '#3 Base'],
  // Not his number in this product.
  ['2017 Panini Prizm Patrick Mahomes #401 Silver', null],
  // A parallel the set's list does not name: read as Green at first. The card
  // is confirmed, so it is its own version under the name it sold as — the
  // lists are short of real parallels ("Orange Disco", "Reactive Yellow").
  ['2017 Panini Prizm Patrick Mahomes #269 Neon Green Pulsar RC', '#269 Neon Green Pulsar'],
  // An auto with no number or set name: he has several auto cards here.
  ['2017 Panini Prizm Patrick Mahomes Auto RC', null],
];
const wrong = CASES.map(([t, want]) => [t, want, read(t)]).filter(([, want, got]) => want !== got);
check(`every listing is tied to the right version, or to none (${CASES.length})`,
  wrong.length === 0,
  wrong.length ? wrong.map(([t, want, got]) => `"${t}" -> ${got} (want ${want})`).join(' | ') : 'Silver, Holo, RWB, inserts, autos, #401, Pulsar');

// Inserts, autographs and coded numbers, from real sold titles. Each shape was
// missed before: the insert's name is also a parallel word ("Prizmatic"), the
// number carries the insert's code ("#RI-5", "#K41", "#DT-39"), several sets
// share his number (#325 base, variation and auto), or the title names a
// sibling product ("Draft Picks").
{
  const cases = [
    ['2024-panini-prizm-football', 'Bo Nix', [
      ['2024 Panini Prizm - Prizmatic Bo Nix #11 Green Prizm (RC) PSA 9', '#11 Prizmatic Green'],
      ['2024 Panini Prizm Prizmatic Bo Nix #11 Green Wave Prizm (RC)', '#11 Prizmatic Wave Green'],
      ['2024 Panini Prizm - Fireworks Bo Nix #23 Green Wave Prizm (RC)', '#23 Fireworks Wave Green'],
      ['2024 Panini Prizm Bo Nix Rookie Orange Lazer Prizm #309 RC Broncos', '#309 Rookies Orange Lazer'],
      ['2024 PANINI PRIZM BO NIX RC ROOKIE PSA 9 MINT', '#309 Rookies Base'],
      ['113277948 Bo Nix 2024 Panini Prizm Collegiate Draft Picks #HP-BN Hype RC PSA 10', null],
    ]],
    ['2020-panini-prizm-football', 'Justin Herbert', [
      ['2020 Panini Prizm Justin Herbert Red White and Blue Rookie RC #325 Chargers', '#325 Rookies Red White Blue'],
      ['2020 Panini Prizm Rookie Autograph #325 Justin Herbert Silver BGS 9.5 Auto 10', '#325 Rookie Autographs Silver'],
    ]],
    ['2018-panini-prizm-football', 'Josh Allen', [
      ['2018 Panini Prizm Rookie Introduction Josh Allen #RI-5 (RC) PSA 9 Buffalo Bills', '#5 Rookie Introduction Base'],
      ['2018 Panini Prizm - Instant Impact Josh Allen #II-5 (RC)', '#5 Instant Impact Base'],
    ]],
    ['2021-donruss-football', 'Justin Fields', [
      ['2021 Panini Donruss Downtown! Justin Fields #DT-39 (RC) PSA 10', '#39 Downtown! Base'],
      // A jumbo is a different card (a case hit, a different price).
      ['2021 Panini Donruss - Downtown! Justin Fields #39 (RC)- Jumbo', '#39 Downtown! Jumbo'],
      ['2021 Donruss Downtown Oversized Justin Fields #39 Bears', '#39 Downtown! Jumbo'],
    ]],
    ['2021-panini-absolute-football', 'Trevor Lawrence', [
      ['2021 Panini Absolute Trevor Lawrence Kaboom RC Rookie #K41 Jaguars PSA 9', '#41 Kaboom! Base'],
    ]],
    // 301-350 were one glued line opening with "301 BJ Ojulari", which the
    // 2023 parser refused for its initials; Stroud's rookie was not on file.
    ['2023-panini-prizm-football', 'C.J. Stroud', [
      ['2023 Panini Prizm #339 CJ Stroud Rookie RC PSA 9 MINT Texans', '#339 Rookies Base'],
      ['2023 PANINI PRIZM PRIZMATIC #6 CJ STROUD ROOKIE RC PSA 9', '#6 Prizmatic Base'],
    ]],
    // "Rated Rookies" is filed as an insert, but it is the base rookie card.
    ['2021-donruss-optic-football', 'Trevor Lawrence', [
      ['Trevor Lawrence 2021 Optic Blue Hyper PSA 10 GEM MINT', '#201 Rated Rookies Blue Hyper'],
    ]],
    ['2023-panini-select-football', 'C.J. Stroud', [
      ['2023 PANINI SELECT DRAFT PICKS BLUE #2 CJ STROUD PSA 9', null],
    ]],
  ];
  const wrong2 = [];
  let n = 0;
  for (const [file, player, list] of cases) {
    const prod = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'data', 'checklists', file + '.json'), 'utf8'));
    const vc = ctx.build(prod, player, `${prod.year} ${player}`);
    for (const [t, want] of list) {
      n++;
      const v = ctx.match(t, vc);
      const got = v ? `#${v.card.number} ${v.card.set} ${v.parallel}` : null;
      if (got !== want) wrong2.push(`"${t}" -> ${got} (want ${want})`);
    }
  }
  check(`inserts, autos and coded numbers are tied to the right card (${n})`,
    wrong2.length === 0, wrong2.join(' | ') || 'Prizmatic, Fireworks, #RI-5, #DT-39, #K41, #325 auto, Draft Picks');
}

// The page wiring: grouped listings that match nothing leave the main list,
// the stats skip them, and a new search starts ungrouped.
check('unmatched listings go to the collapsed section, not the comps',
  /_isOtherCard = \(r\) => !!\(r && \(r\.sameCard === false \|\| \(_versionCtx && _versionOf\(r\) === null\)\)\)/.test(src));
check('  ...and are left out of the value stats and chart',
  /function _countedResults\(/.test(src) && /renderStatsBar\(counted, true\)/.test(src));
check('  ...and a new search never inherits the last one\'s grouping',
  /async function buildParallelFilter\(query\) \{[\s\S]{0,200}_versionCtx = null;/.test(src));
check('the versions container is on the page and styled',
  /id="version-groups"/.test(fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8'))
  && /\.version-grid\s*\{/.test(fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8')));

// Best offers: shown in the comps, left out of every average. The figure held
// for an accepted offer is the seller's ask, not what was paid.
{
  const i = src.indexOf('const _isBestOffer');
  const pred = i > 0 ? src.slice(i, src.indexOf('\n', i)) : '';
  const c2 = { console }; vm.createContext(c2);
  if (pred) vm.runInContext(pred + '\nthis.f = _isBestOffer;', c2);
  check('a best offer is recognised, and nothing else is',
    !!c2.f && c2.f({ saleType: 'offer' }) === true && c2.f({ saleType: 'auction' }) === false
    && c2.f({}) === false && c2.f(null) === false, pred || 'missing');
  const statsFn = src.slice(src.indexOf('function renderStatsBar'), src.indexOf('function renderStatsBar') + 900);
  check('  ...and the value stats average without them',
    /results\.filter\(r => !_isBestOffer\(r\)\)/.test(statsFn) && /counted\.map\(r => parseFloat\(r\.price\)\)/.test(statsFn));
  const verFn = src.slice(src.indexOf('function _buildVersionCard'), src.indexOf('function _buildVersionCard') + 1400);
  check('  ...and so does each version card',
    /items\.filter\(r => !_isBestOffer\(r\)\)/.test(verFn) && /const raw = clean\.filter/.test(verFn));
}

// Busy cards lose their best offers altogether; rare ones keep them.
{
  const a = src.indexOf('const _isBestOffer'), b = src.indexOf('const _withoutDroppedOffers');
  const e = src.indexOf('\n', b);
  check('the best-offer rule is where this check expects it', a > 0 && b > a, `start=${a} end=${b}`);
  const c3 = { console, currentMode: 'sold', currentResults: [], _versionCtx: null };
  vm.createContext(c3);
  vm.runInContext('var currentMode = this.currentMode, currentResults = [], _versionCtx = null;\n'
    + 'function _versionOf(r) { return r.v ? { key: r.v } : null; }\n'
    + src.slice(a, e) + '\nthis.drop = _offerDropped; this.set = (r, ctx) => { currentResults = r; _versionCtx = ctx; };', c3);
  const sale = (v, offer) => ({ v, saleType: offer ? 'offer' : 'auction' });
  const busyOffer = sale('silver', true), rareOffer = sale('gold', true);
  const pool = [sale('silver'), sale('silver'), sale('silver'), busyOffer, rareOffer, sale('base')];
  c3.set(pool, { grouped: true });
  check('grouped: a version with 3+ other sales drops its best offers, a rare one keeps them',
    c3.drop(busyOffer) === true && c3.drop(rareOffer) === false && c3.drop(pool[0]) === false,
    `silver offer dropped=${c3.drop(busyOffer)}, gold offer dropped=${c3.drop(rareOffer)}`);
  c3.set([sale(null), sale(null), sale(null), sale(null, true)], null);
  const flatOffer = c3.drop(sale(null, true));
  c3.set([sale(null), sale(null, true)], null);
  check('  ...and ungrouped, the whole result set is the card',
    flatOffer === true && c3.drop(sale(null, true)) === false);
}

// Each version opens its full sold history and graph: the card detail view,
// on one of its own sales that the server can resolve to a card.
{
  const verFn = src.slice(src.indexOf('function _buildVersionCard'), src.indexOf('function _buildVersionCard') + 6000);
  check('each version card has a button to its sold history and graph',
    /class="version-history-btn"/.test(verFn) && /openCardModal\(histFrom\)/.test(verFn)
    && /r\.source === 'nflcarddb' && r\.itemId && r\.hasAnalysis/.test(verFn)
    && /e\.stopPropagation\(\)/.test(verFn),
    'the button must open the detail view without also toggling the comps filter');
}
// Grouped, the history belongs to the version, not to each comp under it:
// no per-comp "View price history" cue, and a comp opens without the chart.
{
  const cardFn = src.slice(src.indexOf('function buildCard('), src.indexOf('// ---- Card Detail Modal ----'));
  const modalFn = src.slice(src.indexOf('function openCardModal('), src.indexOf('function openCardModal(') + 6000);
  check('grouped comps carry no price-history cue of their own',
    /item\.hasAnalysis && !_versionCtx \?/.test(cardFn)
    && /openCardModal\(item, \{ history: !_versionCtx \}\)/.test(cardFn)
    && /opts\.history === false/.test(modalFn),
    'the cue and the modal chart are both gated on the grouping');
}
// The price chart that sat above every search is gone, markup and code alike:
// a module-level binding to a removed element would take the page down.
{
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  check('the search results no longer draw a price chart',
    !/id="chart-section"/.test(html) && !/id="price-chart"/.test(html)
    && !/updatePriceChart|chartSection|chartCanvas/.test(src));
}

// The home page's long-form text hides once anyone searches, whatever started
// the search, and stays in the HTML for the home page itself (500+ words).
{
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const a = html.indexOf('id="about-section"'), b = html.indexOf('</section>', a);
  const words = a > 0 ? html.slice(a, b).replace(/<[^>]+>/g, ' ').split(/\s+/).filter(w => /[a-z]/i.test(w)).length : 0;
  check('the home page keeps its long-form text in the HTML', words >= 500, `${words} words`);
  check('  ...and every search hides it, not just the search box',
    /async function fetchDirectSearch\(query\) \{\s*_hideHomeContent\(\);/.test(src)
    && /async function performSearch\(query, opts = \{\}\) \{\s*_hideHomeContent\(\);/.test(src));
}

// The card's sale-history chart draws every sale, even one or two.
check('the sale-history chart charts a card with a single sale',
  /if \(!g \|\| !g\.points\.length \|\| typeof Chart === 'undefined'\)/.test(src)
  && !/g\.points\.length < 3/.test(src));

console.log(failures ? `\n${failures} check(s) failed` : '\nall sold-versions checks passed');
process.exit(failures ? 1 : 0);
