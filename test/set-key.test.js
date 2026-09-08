// The sales-to-product join key.
//
// This is the file that was wrong once already, in a way that produced a
// confident number rather than an error: the old year+brand key sent 37% of
// priced sales to no product at all and gave three different Donruss sets the
// same sales figures. Nothing threw. The endpoint printed "Build it — most set
// pages would carry real numbers."
//
// So the checks below run against the REAL checklists/index.json rather than
// invented products. A join key can only be wrong relative to actual data, and
// a fixture of three tidy products would have passed the broken version too.
const path = require('path');
const {
  norm, variants, productKeys, saleKeys, buildIndex, matchSale,
} = require(path.join(__dirname, '..', 'set-key.js'));
const idx = require(path.join(__dirname, '..', 'public', 'data', 'checklists', 'index.json'));

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

const products = (idx && idx.products) || [];
check('the catalogue loaded', products.length > 300, `${products.length} products`);

const { index, ambiguous } = buildIndex(products);

// ---- the misses ----
//
// These seven set names are not hypothetical. They are the largest orphan
// groups the broken key produced, copied from the endpoint's own output, and
// between them they account for most of the 37%.
{
  const wants = {
    'prizm': '2025-panini-prizm-football',
    'select': '2025-panini-select-football',
    'donruss optic': '2025-donruss-optic-football',
    'mosaic': '2025-panini-mosaic-football',
    'chrome': '2025-topps-chrome-football',
    'phoenix': '2025-panini-phoenix-football',
    'finest': '2025-topps-finest-football',
  };
  for (const [saleName, wantId] of Object.entries(wants)) {
    const hit = matchSale(index, '2025', saleName);
    check(`a sale under "${saleName}" reaches its product`,
      hit && hit.id === wantId, hit ? hit.id : 'no match');
  }
}

// ---- the collisions ----
//
// The three Donruss products reported 5,087 sales and 1,709 cards each,
// identically, because brand could not tell them apart. They must now land
// somewhere different from each other.
{
  const donruss = ['donruss', 'donruss elite', 'donruss optic']
    .map(s => matchSale(index, '2025', s));
  const ids = donruss.map(h => h && h.id);
  check('the three 2025 Donruss sets no longer share one sales group',
    new Set(ids).size === 3 && ids.every(Boolean), ids.join(' / '));

  const bowman = ['bowman', 'bowman sapphire'].map(s => matchSale(index, '2025', s));
  check('  ...nor do Bowman and Bowman Sapphire',
    bowman[0] && bowman[1] && bowman[0].id !== bowman[1].id,
    bowman.map(h => h && h.id).join(' / '));

  check('  ...and plain "donruss" still finds the plain Donruss set',
    donruss[0] && donruss[0].id === '2025-donruss-football',
    donruss[0] ? donruss[0].id : 'no match');
}

// ---- the guard that makes Donruss and Bowman safe in MAKERS ----
{
  check('stripping a maker word never yields an empty candidate',
    variants('2025 Topps Football').every(v => v !== '')
      && variants('Panini').every(v => v !== '')
      && variants('2025 Donruss Football').includes('donruss'),
    JSON.stringify(variants('2025 Donruss Football')));

  // If the guard were removed, "" would become a key and match every sale
  // whose set_name failed to parse. Prove the empty name produces nothing.
  check('  ...and an unparseable set name matches no product',
    matchSale(index, '2025', '') === null && matchSale(index, '2025', null) === null);
}

// ---- uniqueness across the whole catalogue ----
{
  check('no key is claimed by two products',
    ambiguous.length === 0,
    ambiguous.length ? ambiguous.map(a => `${a.key} -> ${a.products.join(',')}`).join(' | ') : 'none');

  const reachable = products.filter(p => productKeys(p).some(k => index.get(k) === p));
  check('every product is reachable by at least one of its own keys',
    reachable.length === products.length,
    `${reachable.length} of ${products.length}`);
}

// ---- the sellers' conventions, both of them ----
{
  check('a title that does carry the manufacturer still matches',
    (matchSale(index, '2025', 'panini prizm') || {}).id === '2025-panini-prizm-football');
  check('  ...as does one that does not',
    (matchSale(index, '2025', 'prizm') || {}).id === '2025-panini-prizm-football');
  check('  ...and punctuation is not load-bearing',
    (matchSale(index, '2025', "Bowman's Best") || {}).id
      === (matchSale(index, '2025', 'Bowmans Best') || {}).id
      && matchSale(index, '2025', "Bowman's Best") !== null);
}

// ---- the year still separates ----
//
// Without it every Prizm sale since 2017 would pile onto one page.
{
  const a = matchSale(index, '2025', 'prizm');
  const b = matchSale(index, '2024', 'prizm');
  check('the same set name in two years reaches two products',
    a && b && a.id !== b.id, `${a && a.id} vs ${b && b.id}`);
  check('  ...and a year with no such product matches nothing',
    matchSale(index, '1993', 'prizm') === null);
}

// ---- normalisation matches server.js ----
{
  check('norm strips hyphens rather than spacing them, as _normCol does',
    norm('Rookies-Stars') === 'rookiesstars', norm('Rookies-Stars'));
  check('  ...and saleKeys carries the year through it',
    saleKeys('2025', 'Prizm')[0] === '2025|prizm', saleKeys('2025', 'Prizm')[0]);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall set-key checks passed');
process.exit(failures ? 1 : 0);
