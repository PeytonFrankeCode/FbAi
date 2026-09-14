// Can the parallel be read out of a listing title?
//
// 48.4% of priced sales carry a parallel in the column and 38.9% carry a full
// card identity, which caps the index at about a third of the data. The titles
// name the parallel plainly, so most of the rest should be recoverable.
//
// The risk is not failing to read one. It is reading the WRONG one: a title
// says "A.J. Green" and Green is a parallel in nearly every product, so a naive
// substring search turns a base card into a Green parallel and merges two
// different cards. That is why the reader only looks at the segment after the
// card number — the player and the set both sit before it — and why half of
// what follows asserts that things are NOT matched.
const { resolveParallel, stats } = require('../parallel-index.js');

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

console.log(`vocabulary: ${stats.distinctParallels.toLocaleString('en-US')} parallels `
          + `from ${stats.products} products, ${stats.lookupEntries.toLocaleString('en-US')} spellings\n`);

const eq = (a, b) => String(a || '').toLowerCase().replace(/s$/, '')
                   === String(b || '').toLowerCase().replace(/s$/, '');

// Real title shapes, taken from live data.
const shouldRead = [
  ['2025 Panini Prizm - Rookies Jaxson Dart #332 Silver Prizm (RC)', 'Silver Prizm'],
  ['2025 Topps Chrome - Rookies Jaxson Dart #306 Refractor (RC)',    'Refractor'],
  ['2023 Panini Prizm - Justin Jefferson #150 Gold Vinyl',           'Gold Vinyl'],
];
let read = 0;
for (const [title, want] of shouldRead) {
  const hit = resolveParallel(title);
  if (hit.how === 'matched' && eq(hit.parallel, want)) read++;
  else console.log(`      MISS: "${title}" -> ${hit.how} ${hit.parallel || ''} (wanted ${want})`);
}
check('a parallel named in the title is read',
      read === shouldRead.length, `${read}/${shouldRead.length}`);

// The dangerous half. Each of these would silently merge two different cards.
const mustNotMatch = [
  ['2024 Panini Prizm - A.J. Green #12 (RC)',        'a player surnamed Green'],
  ['2023 Panini Prizm - Gabe Davis #77',             'a player, no parallel'],
  ['1984 Topps - John Elway #63 (RC)',               'a plain base card'],
  ['2022 Panini Black - Garrett Wilson #40',         'a set called Black'],
  ['2023 Panini Gold Standard - Bijan Robinson #12', 'a set called Gold Standard'],
];
const wrongly = mustNotMatch.filter(([t]) => resolveParallel(t).how === 'matched');
check('  ...and a parallel word before the card number is not',
      wrongly.length === 0,
      wrongly.length
        ? `MATCHED: ${wrongly.map(([t]) => `"${t}" -> ${resolveParallel(t).parallel}`).join('; ')}`
        : `all ${mustNotMatch.length} correctly read as base`);

// Longest match: "Silver Prizm" must beat the "Prizm" inside it, and "Gold
// Vinyl" must beat "Gold". Getting this backwards merges a /5 into the base run.
{
  const a = resolveParallel('2025 Panini Prizm - Player Name #1 Silver Prizm');
  const b = resolveParallel('2023 Panini Prizm - Player Name #1 Gold Vinyl');
  check('  ...and the longest parallel name wins',
        eq(a.parallel, 'Silver Prizm') && eq(b.parallel, 'Gold Vinyl'),
        `${a.parallel} / ${b.parallel}`);
}

// The cases the live conflict report exposed. Every one of these was a WRONG
// match before — a rarer card silently merged into a commoner one, which
// nothing downstream can detect.
{
  const cases = [
    // "&" broke the token run, so the reader settled for the "Blue Prizm" inside.
    ['2024 Panini Prizm - Rookies Caleb Williams #301 Red White & Blue Prizm (RC)',
     'matched', 'red white and blue'],
    // Matched the bare "White" — a real but different parallel — because the
    // full name was not in the vocabulary. Must refuse instead.
    ['2025 Panini Prizm - Rookies Jaxson Dart #332 White Disco Prizm (RC)',
     'unmatched', null],
    // The parallel is stated BEFORE the card number here, and the trailing
    // "Giants Rookie" is junk. Found by stripping the product, the subset, the
    // player and the filler and seeing what stands alone.
    ['2025 Topps Chrome Jaxson Dart RC Refractor #306 Giants Rookie',
     'matched-before-number', 'refractor'],
    // Only a team follows the number, and nothing before it names a parallel
    // either. Base is safe to conclude only because the second check ran — it
    // is what distinguishes this from the Refractor case above.
    ['2025 Topps Cosmic Chrome Cam Skattebo Stars In The Night RC Rookie #STN-5 Giants',
     'base', null],
    // Only a grade follows — same reasoning.
    ['2024 Panini Prizm - Rookies Jayden Daniels #347 (RC) PSA 10 GEM MINT',
     'base', null],
  ];
  const wrong = [];
  for (const [title, how, contains] of cases) {
    const r = resolveParallel(title);
    const okHow = r.how === how;
    const okVal = contains == null
      ? true
      : String(r.parallel || '').toLowerCase().replace(/[^a-z ]/g, '').includes(contains);
    if (!okHow || !okVal) wrong.push(`"${title.slice(0, 48)}..." -> ${r.how} ${r.parallel || ''}`);
  }
  check('the live conflicts are read correctly or refused',
        wrong.length === 0,
        wrong.length ? wrong.join('; ') : `all ${cases.length} correct`);
}

// The two halves of the seller-vs-catalogue spelling gap. variants() covers the
// catalogue being more verbose ("Silver Prizms" for a listing's "Silver Prizm");
// this is the other direction, a seller appending a product word the checklist
// leaves off. Both must work without reopening the hole strict mode exists to
// close — a one-word remainder is the rest of the sentence, not a parallel.
{
  const shock = resolveParallel('2025 Panini Donruss Optic Jaxson Dart Rated Rookie Purple Shock Prizm #273');
  const chrome = resolveParallel('2025 Topps Chrome Cam Ward #14 Chrome Refractor Thing');
  check('a product word the checklist omits is trimmed',
        eq(shock.parallel, 'Purple Shock'),
        `${shock.how} ${shock.parallel || '-'}`);
  check('  ...but never down to a single generic word',
        !/^chrome$/i.test(String(chrome.parallel || '')),
        `"Chrome Refractor" -> ${chrome.parallel || 'refused'} (Chrome would make every Topps title a Refractor)`);
}

// classify() has to admit when a name is both. "Kaboom" is a parallel in one
// product and an insert set in seven others; answering 'parallel' because that
// test ran first counted correctly-read set cards as reader defects and
// inflated the one number the wiring decision turns on.
{
  const { classify } = require('../parallel-index.js');
  const got = ['Kaboom', 'Downtown', 'Purple Shock', 'Wibblesnorf'].map(classify);
  check('a name that is both a set and a parallel is reported as both',
        got[0] === 'both' && got[1] === 'subset' && got[2] === 'parallel' && got[3] === 'unknown',
        `Kaboom=${got[0]} Downtown=${got[1]} Purple Shock=${got[2]} Wibblesnorf=${got[3]}`);
}

// Words that sit NEXT to the answer rather than being it. The residual has to
// cover the whole remainder, so one unstripped word is as fatal as a wrong one:
// each of these read as base — a real parallel silently demoted — because a
// signature word or the sport was still standing beside it.
{
  const cases = [
    ['WILL HOWARD Rookie 2025 Topps Resurgence Refractor Auto Steelers RC #182', 'refractor'],
    ['Topps 2026 Chrome Football Mojo Caleb Downs Cowboys RC 35 Anniversary #91TRC-49', 'mojo'],
  ];
  const missed = cases.filter(([t, want]) =>
    !String(resolveParallel(t).parallel || '').toLowerCase().includes(want));
  check('a parallel is still found with a signature word or the sport beside it',
        missed.length === 0,
        missed.length ? missed.map(([t]) => `"${t.slice(0, 40)}..." -> ${resolveParallel(t).how}`).join('; ')
                      : `${cases.length} recovered that previously read as base`);
}

// A title with no card number gives no segment to read, so nothing is claimed.
{
  const junk = resolveParallel('SEE SCAN For The Exact Card Up For Auction! NFL READ FREE SHIPPING');
  check('  ...and an unstructured title claims nothing',
        junk.how === 'no-number' && junk.parallel === null,
        `${junk.how}`);
}

// Cost per title, which is a correctness concern here rather than a nicety.
//
// residual() strips every known product and subset off a title. Done naively
// that is ~4,900 substring scans over two freshly allocated strings each, per
// title — and /api/debug/parallel-resolve runs it across 6,000 titles, so about
// 58 million allocations in a single request. That was enough to exhaust the
// Worker: the endpoint returned nothing while the rest of the site was fine.
//
// Phrases are indexed by first word so only real candidates are tested. The
// budget below is ~5x the measured cost of that version and ~2x under the
// version it replaced, so it fails if the full scan is reintroduced without
// tripping on a slow CI box.
{
  const players = ['Jaxson Dart', 'Caleb Williams', 'A.J. Green', 'John Elway'];
  const titles = [];
  for (let i = 0; i < 3000; i++) {
    const p = players[i % players.length];
    titles.push(`2025 Panini Prizm - Rookies ${p} #${300 + (i % 99)} Wibblesnorf Foil (RC)`);
  }
  resolveParallel(titles[0]);                       // pay for build() first
  const t0 = Date.now();
  for (const t of titles) resolveParallel(t);
  const ms = Date.now() - t0;
  const per = ms / titles.length;
  check('reading a title stays cheap enough for the diagnostics to run',
        per < 0.2,
        `${per.toFixed(3)}ms/title over ${titles.length} (budget 0.2ms)`);
}

// Base is reported as its own answer, not as a failure to read. The two mean
// different things and only one of them is safe to act on.
{
  const base = resolveParallel('1984 Topps - John Elway #63 (RC)');
  const unread = resolveParallel('2025 Topps Chrome - Player #1 Wibblesnorf Foil');
  check('base and unreadable are told apart',
        base.how === 'base' && unread.how === 'unmatched',
        `base -> "${base.how}", unknown parallel -> "${unread.how}" (segment "${unread.segment}")`);
}

// ---- the shipped vocabulary matches the checklists it was built from -------
//
// public/data/parallel-index.json and card-index.json are GENERATED from
// public/data/checklists/ by scripts/build-card-index.js. Editing a checklist
// without re-running that script changes nothing the site actually reads, and
// nothing fails — the artifact is still valid, just describing an older
// catalogue.
//
// That is not hypothetical. Commit deeb9c0 corrected two 2026 product names in
// the checklists and did not rebuild, so for two weeks the vocabulary shipped
// the names that commit existed to fix. Nobody could have noticed: the site
// behaved consistently, it was consistently out of date.
//
// Comparing product ids and names is enough to catch that class of drift
// without re-implementing any of the build's logic here.
{
  const fs = require('fs');
  const path = require('path');
  const dir = path.join(__dirname, '..', 'public', 'data', 'checklists');
  const PARALLELS = require('../public/data/parallel-index.json');

  const onDisk = new Map();
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
    const doc = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    // index.json is the landing-page manifest, not a product. The build skips
    // anything with no `sets` for the same reason, and the two have to agree
    // about what counts as a product or this check reports drift that is not.
    if (!Array.isArray(doc.sets)) continue;
    onDisk.set(doc.id || f.replace(/\.json$/, ''), doc.name);
  }

  const built = new Map((PARALLELS.products || []).map(p => [p.id, p.name]));
  const missing = [...onDisk.keys()].filter(id => !built.has(id));
  const extra = [...built.keys()].filter(id => !onDisk.has(id));
  const renamed = [...onDisk.entries()].filter(([id, name]) => built.has(id) && built.get(id) !== name);

  check('every checklist on disk is in the built index',
    missing.length === 0,
    missing.length ? `not built: ${missing.join(', ')} — run npm run build:card-index` : `${onDisk.size} products`);
  check('  ...and the index holds no product whose checklist is gone',
    extra.length === 0,
    extra.length ? `stale: ${extra.join(', ')}` : 'none stale');
  check('  ...and no product name has drifted since the last build',
    renamed.length === 0,
    renamed.length
      ? renamed.map(([id, name]) => `${id}: built "${built.get(id)}" vs checklist "${name}"`).join(' | ')
      : 'names agree');

  // ---- aliases reach the vocabulary --------------------------------------
  //
  // A checklist parallel may carry `aliases`: what the market calls it, when
  // that is not what the catalogue calls it. These are not spelling variants —
  // variants() already handles those — they are different words for the same
  // thing, which no morphology recovers.
  //
  // The whole mechanism is one loop in build-card-index.js, and deleting it
  // breaks nothing loudly: the checklists still parse, the artifact is still
  // valid, and the reader just stops understanding a spelling. Verified by
  // removing the aliases and rebuilding — every other check in this file still
  // passed, which is exactly why this one exists.
  const aliased = [];
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
    const doc = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (!Array.isArray(doc.sets)) continue;
    const id = doc.id || f.replace(/\.json$/, '');
    for (const s of doc.sets) {
      for (const par of (s.parallels || [])) {
        for (const a of (par && Array.isArray(par.aliases) ? par.aliases : [])) {
          aliased.push({ id, set: s.id, name: par.name, alias: a });
        }
      }
    }
  }
  const lost = aliased.filter(x =>
    !((PARALLELS.parallelsByProduct || {})[x.id] || []).includes(x.alias));
  check('every alias a checklist declares is in the built vocabulary',
    aliased.length > 0 && lost.length === 0,
    lost.length ? `missing: ${lost.map(x => `${x.id}/${x.alias}`).join(', ')}`
                : `${aliased.length} aliases across ${new Set(aliased.map(x => x.id)).size} product(s)`);

  // ---- the case that prompted it -----------------------------------------
  //
  // Panini's own 2017 Prizm checklist names the unnumbered chrome parallel
  // "Prizm". Every seller writes "Silver" or "Silver Prizm", and the Mahomes
  // #269 Silver is one of the most traded cards in the hobby. Before the alias
  // the reader still resolved those titles — by matching "Silver" out of a
  // DIFFERENT product's vocabulary, since the lookup is global. That worked by
  // luck, not by knowing anything about this product, so a check on
  // resolveParallel alone would have passed before the fix too.
  //
  // This asserts against the product's own vocabulary, which is the thing that
  // actually changed.
  const prizm2017 = (PARALLELS.parallelsByProduct || {})['2017-panini-prizm-football'] || [];
  check('2017 Prizm knows its own Silver parallel',
    prizm2017.some(p => /silver/i.test(p)),
    prizm2017.filter(p => /silver/i.test(p)).join(', ')
      || 'no Silver spelling — the reader can only borrow one from another product');
  check('  ...while still knowing the bare "Prizm" the catalogue calls it',
    prizm2017.includes('Prizm'),
    'dropping the catalogue name to add the market name would trade one gap for another');
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall parallel-index checks passed');
process.exit(failures ? 1 : 0);
