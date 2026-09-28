// Checklist matching against the way people actually write titles.
//
// Built from an audit of 779 live sold listings across 12 checklist cards.
// Two kinds of miss came out of it, and both are held here with the real
// titles:
//   - the card was right there and the matcher refused it: a number with no
//     "#", "#325b", "#74TF-12", "Rated Rookie" for the Rated Rookies set,
//     typos ("Sliver"), no number at all but a listed parallel, and a number
//     shared by five sets when the title names none of them;
//   - it placed a different product's card on this one: "Optic" in a Donruss
//     search, Optic Preview (a Donruss card) in an Optic search, Clearly,
//     Elite, Sapphire, Cosmic, "DP" for Draft Picks.
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

const slices = [
  ['const PARALLEL_STRIP_TEAMS', '// Used when the query matches no checklist product.'],
  ['const SCAN_KEY_PARALLEL_PHRASES', 'function _scanKeyTerms'],
  ['function _fallbackParallelMatchers', '// Context for the active search'],
  ['const _VERSION_SUFFIX_RE', 'function _versionOf'],
];
let code = 'let _fallbackMatchersCache = null;\n';
for (const [a, b] of slices) {
  const i = src.indexOf(a), j = src.indexOf(b, i + 1);
  if (i < 0 || j < 0) { console.log(`FAIL  app.js no longer holds "${a}"`); process.exit(1); }
  code += src.slice(i, j) + '\n';
}
const ctx = { console };
vm.createContext(ctx);
vm.runInContext(code + '\nthis.build = _buildVersionCtx; this.match = _matchVersion; this.fix = _fixTypos;', ctx);

const product = (id) => JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'data', 'checklists', id + '.json'), 'utf8'));
const read = (vctx, title) => { const v = ctx.match(title, vctx); return v ? `#${v.card.number} ${v.parallel}` : null; };
const run = (label, id, player, cases) => {
  const vctx = ctx.build(product(id), player, player);
  const wrong = cases.map(([t, want]) => [t, want, read(vctx, t)]).filter(([, want, got]) => want !== got);
  check(`${label} (${cases.length})`, wrong.length === 0,
    wrong.map(([t, want, got]) => `"${t}" -> ${got} (want ${want})`).join(' | '));
};

run('2023 Donruss Stroud: the base Rated Rookie, however it is written', '2023-donruss-football', 'CJ Stroud', [
  // #339 is on five of his lists; a title naming none of them is the base run.
  ['2023 Panini Donruss CJ Stroud #339 PSA 10', '#339 Base'],
  ['2023 PANINI DONRUSS #339 CJ STROUD ROOKIE RC PSA 9', '#339 Base'],
  ['2023 Panini Donruss Cj Stroud Rated Rookie PSA 10 #339', '#339 Base'],
  // No "#".
  ['2023 PANINI DONRUSS 339 CJ STROUD PRESS PROOF SILVER DIE-CUT /75 RARE', '#339 Silver Press Proof Die Cut'],
  // Donruss's own Optic Preview, however it is worded.
  ['2023 Panini Donruss CJ Stroud #339 Optic Preview Pink PSA 10', '#339 Pink'],
  ['2023 Donruss Optic Rated Rookies Preview Blue Scope CJ Stroud PSA Gem Mint (10)', '#339 Blue Scope'],
]);
run('  ...and what is some other product, refused', '2023-donruss-football', 'CJ Stroud', [
  ['CJ Stroud 2023 Donruss Optic Rated Rookie Green Hyper #244 PSA 10', null],   // Optic, not Donruss
  ['2023 Donruss Optic CJ Stroud Blue Hyper Rookie PSA 10 GEM MINT', null],
  ['2023 Panini Clearly Donruss #93 CJ Stroud RATED ROOKIE PSA 10', null],
  ['CJ STROUD 2023 Donruss Elite BLUE parallel RC Rookie /99 SP Houston Texans', null],
  ['2023 Donruss Optic - CJ Stroud - Hidden Potential Ice 12/15 - PSA 9 - Texans', null],
]);
run('2025 Optic Dart: no number, but a parallel his base card lists', '2025-donruss-optic-football', 'Jaxson Dart', [
  ['2025 Panini Donruss Optic Jaxson Dart Rated Rookie Red Mojo Prizm Giants SM5', '#273 Red Mojo'],
  ['Jaxson Dart PSA 10 2025 Panini Donruss Optic Rated RC Purple Shock Giants 0208', '#273 Purple Shock'],
  ['2025 Panini Donruss Optic Jaxson Dart Rated Rookie Aqua Prizm #/349 Giants PSA 9', '#273 Aqua'],
  // An insert the list may not hold is not guessed onto the base card.
  ['Jaxson Dart 2025 Panini Donruss Optic - My House!  Gem Psa 10', null],
  // Optic Preview is a Donruss card.
  ['2025 Donruss Optic Preview - Rated Rookie Jaxson Dart - Red Pandora (RC) PSA 9', null],
  // "PSA GEM MT 10" is a grade, not card #10.
  ['2025 Donruss Optic Jaxson Dart Rated Rookie #273 Holo Prizm (RC) Giants', '#273 Holo'],
]);
run('2020 Prizm Herbert: "#325b" is the #325 variation', '2020-panini-prizm-football', 'Justin Herbert', [
  ['2020 Panini Prizm Justin Herbert Variation SP Rookie RC #325b Chargers (B)', '#325 Base'],
]);
{
  const vctx = ctx.build(product('2020-panini-prizm-football'), 'Justin Herbert', 'Justin Herbert');
  const v = ctx.match('2020 Panini Prizm Justin Herbert Variation SP Rookie RC #325b Chargers (B)', vctx);
  check('  ...on the Rookie Variations set', v && /variation/i.test(v.card.set), v && v.card.set);
}
run('2023 Prizm Stroud: a grade is not a card number', '2023-panini-prizm-football', 'CJ Stroud', [
  ['2023 Panini Prizm Football CJ Stroud Prizm Break Green Prizm PSA GEM MT 10', '#6 Green'],
  ['2023 Panini Red Ice Prizm DP #102 CJ Stroud RC Rookie PSA 10 GEM MINT', null],   // DP = Draft Picks
  ['2023 Panini Prizm Draft Licks Brilliance CJ Stroud Rookie #BR17 PSA GEM MT 10', null],  // "Licks" = Picks
]);
run('2024 Topps Chrome Bowers: codes, refractors, other Chrome products', '2024-topps-chrome-football', 'Brock Bowers', [
  ['2024 Topps Chrome Brock Bowers 1974 Football Rookie RC #74TF-12 Raiders PSA 9', '#f-12 Base'],
  ['2024 Topps Chrome Rookies Brock Bowers #207 Negative Refractor RC PSA 10 Raiders', '#207 Negative'],
  ['2024 Topps Chrome Football #207 Prizm Refractor Brock Bowers PSA 10', '#207 Refractor'],
  ['2024 Topps Chrome Brock Bowers #207 Magenta Speckle Refractor /399 (RC)', '#207 Magenta Speckle'],
  ['2024 Topps Chrome Brock Bowers Magenta Speckle /399 Raiders PSA 10 GEM POP 7', '#207 Magenta Speckle'],
  ['2024 Topps Chrome Sapphire Edition Rookies Brock Bowers RC #207 Raiders', null],
  ['2024 Topps Cosmic Chrome Brock Bowers Blue Moon Refractor RC #/99 Raiders', null],
]);
run('2024 Optic Daniels: an insert named in the singular; Optic Preview refused', '2024-donruss-optic-football', 'Jayden Daniels', [
  ['2024 Panini Donruss Optic Jayden Daniels Uptown Rookie RC SSP #2 Commanders', '#2 Base'],
  ['2024 Panini Donruss - Rated Rookie Jayden Daniels #389 Optic Preview Pink Prizm', null],
  ['2024 Donruss Optic Football Jayden Daniels RC Rated Rookie PSA 10 #248', '#248 Base'],   // not a "Footballs" parallel
]);
run('2021 Optic Fields: a "Variation" of the named set stays the variation', '2021-donruss-optic-football', 'Justin Fields', [
  ['2021 Panini Donruss Optic - Rated Rookie Justin Fields #204 Holo Prizm Variation', '#204 Base'],
  ['2021 Donruss Optic Legendary Logo Black Pandora Justin Fields RC 6/25 PSA 5', '#2 Black Pandora'],
]);

run('2020 Select Herbert: word order does not make a new version', '2020-panini-select-football', 'Justin Herbert', [
  ['2020 Panini Select JUSTIN HERBERT RC #44 Concourse Die-cut Maroon LA Chargers', '#44 Maroon Die Cut'],
  ['2020 Panini Select Concourse Justin Herbert #44 Maroon Prizm Die-Cut Rookie', '#44 Maroon Die Cut'],
]);

// ---- typos ----
{
  const vctx = ctx.build(product('2023-panini-prizm-football'), 'CJ Stroud', 'CJ Stroud');
  const f = (h) => ctx.fix(h, vctx.vocab);
  check('a letter-off parallel word is read as the word it means',
    f(' 2023 prizm sliver ') === ' 2023 prizm silver ' && f(' prizim ') === ' prizm ', `${f(' 2023 prizm sliver ')}|${f(' prizim ')}`);
  check('  ...but a real word is left alone, plurals included', f(' football rookie stroud ') === ' football rookie stroud ');
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall matching-human-errors checks passed');
process.exit(failures ? 1 : 0);
