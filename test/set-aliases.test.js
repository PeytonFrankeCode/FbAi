// The static set-alias list, and whether each entry actually does anything.
//
// An alias is one line of JSON that claims "when a sale says this, it means
// that product". Both halves can be wrong in ways nothing reports:
//
//   the KEY can be spelled in a normalisation the join never produces, so the
//   alias is never consulted — it sits in the file looking like a fix while the
//   sales keep falling on the floor. This already happened once on this site
//   with a player alias whose key saleKeys() could not generate.
//
//   the TARGET can name a product that is not on disk, so the alias resolves to
//   nothing. Same symptom, different cause.
//
// Neither throws. So every entry is exercised end to end here: build the join
// index with and without the list, and require the alias to change a real
// lookup from unreachable to the named product.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { buildIndex, matchSale } = require(path.join(ROOT, 'set-key.js'));

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

const doc = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'data', 'set-aliases.json'), 'utf8'));
const aliases = {};
for (const [k, v] of Object.entries(doc)) if (!k.startsWith('_')) aliases[k] = v;

const index = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'public', 'data', 'checklists', 'index.json'), 'utf8'));
const products = index.products.map(p => ({ id: p.id, name: p.name, year: p.year }));
const ids = new Set(products.map(p => p.id));

const { index: without } = buildIndex(products);
const { index: withAliases } = buildIndex(products, undefined, aliases);
const idOf = (h) => (h && (typeof h === 'string' ? h : h.id)) || null;

check('the static alias list is present and non-empty',
  Object.keys(aliases).length > 0, `${Object.keys(aliases).length} alias(es)`);

// ---- the target must exist -------------------------------------------------
{
  const dangling = Object.entries(aliases).filter(([, id]) => !ids.has(id));
  check('every alias points at a product that is actually on disk',
    dangling.length === 0,
    dangling.length ? dangling.map(([k, v]) => `${k} -> ${v}`).join('; ')
                    : `${Object.keys(aliases).length} checked`);
}

// ---- the key must be one the join can produce ------------------------------
//
// The check that matters. A key spelled in the wrong normalisation is never
// looked up, and the file still reads as though the problem is solved.
{
  const bad = [];
  for (const [key, target] of Object.entries(aliases)) {
    const [year, setName] = key.split('|');
    if (!year || !setName) { bad.push(`${key} is not "<year>|<set name>"`); continue; }
    const got = idOf(matchSale(withAliases, year, setName));
    if (got !== target) bad.push(`${key} resolves to ${got || 'nothing'}, not ${target}`);
  }
  check('every alias actually resolves its own key to its own target',
    bad.length === 0, bad.length ? bad.join('; ') : `${Object.keys(aliases).length} checked`);
}

// ---- and it must be earning its place --------------------------------------
//
// An alias for a spelling the join already handles is dead weight, and dead
// weight is how a list like this stops being read.
{
  const redundant = Object.entries(aliases).filter(([key, target]) => {
    const [year, setName] = key.split('|');
    return idOf(matchSale(without, year, setName)) === target;
  });
  check('no alias duplicates something the join already does',
    redundant.length === 0,
    redundant.length ? redundant.map(([k]) => k).join('; ') : 'all load-bearing');
}

// ---- the reported case -----------------------------------------------------
// 213 sales in a 30-day sample said "2025 | topps signature" and matched no
// product, while 2025 Topps Signature Class sat in the catalogue unreached.
{
  check('"2025 topps signature" reaches Topps Signature Class',
    idOf(matchSale(withAliases, '2025', 'topps signature')) === '2025-topps-signature-class-football',
    String(idOf(matchSale(withAliases, '2025', 'topps signature'))));
  check('  ...and it genuinely could not before',
    idOf(matchSale(without, '2025', 'topps signature')) === null,
    `without the alias: ${idOf(matchSale(without, '2025', 'topps signature'))}`);
}

// ---- a human decision outranks the file ------------------------------------
//
// The desk writes KV aliases from someone looking at the photos, who knows
// things this file does not. The merge order in setAliases() has to keep that
// true, so it is asserted here rather than left to a comment.
{
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const merge = /return \{ \.\.\.base, \.\.\.\(\(await archiveGet\(SET_ALIAS_KEY\)\) \|\| \{\}\) \};/.test(src);
  check('KV aliases are spread AFTER the static ones, so a person wins',
    merge, 'setAliases() must merge { ...base, ...kv }');
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall set-alias checks passed');
process.exit(failures ? 1 : 0);
