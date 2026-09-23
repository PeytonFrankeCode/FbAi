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
  // A parallel this set was never printed in; read as Green at first.
  ['2017 Panini Prizm Patrick Mahomes #269 Neon Green Pulsar RC', null],
  // An auto with no number or set name: he has several auto cards here.
  ['2017 Panini Prizm Patrick Mahomes Auto RC', null],
];
const wrong = CASES.map(([t, want]) => [t, want, read(t)]).filter(([, want, got]) => want !== got);
check(`every listing is tied to the right version, or to none (${CASES.length})`,
  wrong.length === 0,
  wrong.length ? wrong.map(([t, want, got]) => `"${t}" -> ${got} (want ${want})`).join(' | ') : 'Silver, Holo, RWB, inserts, autos, #401, Pulsar');

// The page wiring: grouped listings that match nothing leave the main list,
// the stats skip them, and a new search starts ungrouped.
check('unmatched listings go to the collapsed section, not the comps',
  /_isOtherCard = \(r\) => !!\(r && \(r\.sameCard === false \|\| \(_versionCtx && _versionOf\(r\) === null\)\)\)/.test(src));
check('  ...and are left out of the value stats and chart',
  /function _countedResults\(/.test(src) && /renderStatsBar\(counted, true\)/.test(src) && /updatePriceChart\(counted\)/.test(src));
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

console.log(failures ? `\n${failures} check(s) failed` : '\nall sold-versions checks passed');
process.exit(failures ? 1 : 0);
