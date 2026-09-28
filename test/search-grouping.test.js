// A search naming a product we hold a checklist for, and a player in it,
// always gets the "Versions of this card" grouping.
//
// The page decided that from a fixed list of set words and whatever
// capitalised words were left: Resurgence was not on the list, a search with
// no year took whichever product had the shortest name (Bo Nix's 2025 Prizm
// rather than his 2024 rookie), and the player came out as "Mahomes Rated" or
// "Chrome Bo Nix". This runs the page's own code (public/app.js) against the
// real checklist files.
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

// A top-level declaration of app.js, lifted by name.
function decl(name) {
  const m = new RegExp('^(async function|function|const|let) ' + name + '\\b', 'm').exec(src);
  if (!m) throw new Error('app.js no longer declares ' + name);
  const fn = /function$/.test(m[1]);
  let depth = 0, started = false;
  for (let j = m.index; j < src.length; j++) {
    const c = src[j];
    if ('{[('.includes(c)) { depth++; started = true; }
    else if ('}])'.includes(c)) { depth--; if (fn && c === '}' && depth === 0) return src.slice(m.index, j + 1); }
    else if (!fn && started && depth === 0 && (c === ';' || c === '\n')) return src.slice(m.index, j + 1);
  }
  throw new Error('could not read ' + name);
}
const NAMES = ["_findChecklistPlayer", "_resolveVersionTarget", "_VT_MAKERS", "_VT_WEAK_BRAND", "_vocabFor", "_RELIC_RE", "_AUTO_RE", "_VERSION_SUFFIX_RE", "_titleCase", "SCAN_KEY_SETS", "SCAN_KEY_PARALLEL_PHRASES", "SCAN_KEY_PARALLEL_WORDS", "CLIENT_KNOWN_SETS", "CLIENT_KNOWN_PARALLELS", "NOISE_WORDS", "parseCardTitle", "_reEsc", "_cleanForMatch", "_normalizeParallelName", "_buildParallelMatchers", "VERSION_EXTRA_PARALLEL_WORDS", "_COLOUR_WORDS", "_fallbackParallelMatchers", "_versionName", "_setKind", "_BASE_LIKE_SET_RE", "_GENERIC_SET_RE", "_resolveParallelVocab", "_buildVersionCtx"];
const ctx = {
  console,
  fetchChecklistsList: async () => JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'data', 'checklists', 'index.json'), 'utf8')),
  fetchChecklistProduct: async (id) => JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'data', 'checklists', id + '.json'), 'utf8')),
};
vm.createContext(ctx);
vm.runInContext('let _fallbackMatchersCache = null;\n' + NAMES.map(decl).join('\n') +
  '\nthis.resolve = _resolveVersionTarget; this.build = _buildVersionCtx;', ctx);

// [search, sold titles (for a search with no year), "product|player"]
const CASES = [
  ["2017 Mahomes Prizm", [], "2017 Panini Prizm Football|Patrick Mahomes II"],
  ["2017 Patrick Mahomes Prizm Silver", [], "2017 Panini Prizm Football|Patrick Mahomes II"],
  ["patrick mahomes 2017 prizm", [], "2017 Panini Prizm Football|Patrick Mahomes II"],
  ["Bo Nix Prizm", ["2024 Panini Prizm Bo Nix #309 RC Silver", "2024 Prizm Bo Nix #309 Rookie"], "2024 Panini Prizm Football|Bo Nix"],
  ["bo nix 2024 prizm", [], "2024 Panini Prizm Football|Bo Nix"],
  ["2024 Topps Chrome Bo Nix", [], "2024 Topps Chrome Football|Bo Nix"],
  ["Bo Nix Topps Chrome", ["2024 Topps Chrome Bo Nix #206 RC"], "2024 Topps Chrome Football|Bo Nix"],
  ["2024 Donruss Optic Bo Nix", [], "2024 Donruss Optic Football|Bo Nix"],
  ["Bo Nix Optic", ["2024 Donruss Optic Bo Nix #209"], "2024 Donruss Optic Football|Bo Nix"],
  ["2024 Select Bo Nix", [], "2024 Panini Select Football|Bo Nix"],
  ["2017 Donruss Mahomes Rated Rookie", [], "2017 Donruss Football|Patrick Mahomes II"],
  ["Caleb Williams 2024 Prizm", [], "2024 Panini Prizm Football|Caleb Williams"],
  ["2018 Prizm Josh Allen", [], "2018 Panini Prizm Football|Josh Allen"],
  ["2018 Optic Josh Allen", [], "2018 Donruss Optic Football|Josh Allen"],
  ["2020 Prizm Justin Herbert", [], "2020 Panini Prizm Football|Justin Herbert"],
  ["2023 Mosaic CJ Stroud", [], "2023 Panini Mosaic Football|C.J. Stroud"],
  ["C.J. Stroud 2023 Prizm", [], "2023 Panini Prizm Football|C.J. Stroud"],
  ["2025 Topps Resurgence Colston Loveland", [], "2025 Topps Resurgence Football|Colston Loveland"],
  ["2024 Panini Prizm Mahomes Red Sparkle", [], "2024 Panini Prizm Football|Patrick Mahomes II"],
  ["Jaxson Dart 2025 Topps Chrome Refractor", [], "2025 Topps Chrome Football|Jaxson Dart"],
  ["2025 Prizm Cam Ward", [], "2025 Panini Prizm Football|Cam Ward"],
  ["2017 prizm mahomes", [], "2017 Panini Prizm Football|Patrick Mahomes II"],
  ["mahomes prizm 2017 silver", [], "2017 Panini Prizm Football|Patrick Mahomes II"],
  ["2019 Prizm Kyler Murray", [], "2019 Panini Prizm Football|Kyler Murray"],
  ["2021 Mosaic Mac Jones", [], "2021 Panini Mosaic Football|Mac Jones"],
  ["2025 Donruss Downtown Bijan Robinson", [], "2025 Donruss Football|Bijan Robinson"],
  ["2024 Prizm Mahomes Black", [], "2024 Panini Prizm Football|Patrick Mahomes II"],
  ["2023 Panini Black Bryce Young", [], "2023 Panini Black Football|Bryce Young"],
  ["2021 Prizm Mahomes Gold", [], "2021 Panini Prizm Football|Patrick Mahomes II"],
  ["2024 Donruss Bo Nix", [], "2024 Donruss Football|Bo Nix"],
  ["2025 Donruss Optic Cam Ward", [], "2025 Donruss Optic Football|Cam Ward"],
  ["Bo Nix 2024 Prizm Silver PSA 10", [], "2024 Panini Prizm Football|Bo Nix"],
  ["2024 Panini Prizm Draft Picks Bo Nix", [], "2024 Panini Prizm Draft Picks Football|Bo Nix"],
  ["2023 Prizm CJ Stroud Silver", [], "2023 Panini Prizm Football|C.J. Stroud"],
  ["Mahomes 2018 Prizm Silver", [], "2018 Panini Prizm Football|Patrick Mahomes II"],
];

(async () => {
  const wrong = [];
  for (const [q, titles, want] of CASES) {
    const t = await ctx.resolve(q, titles.map(title => ({ title })));
    const v = t && ctx.build(t.product, t.player, q);
    const got = t && v && v.cards.length ? `${t.product.name}|${t.player}` : 'no grouping';
    if (got !== want) wrong.push(`"${q}" -> ${got} (want ${want})`);
  }
  check(`every catalogued product + player search is grouped, on the right product and player (${CASES.length})`,
    wrong.length === 0, wrong.join(' | ') || 'Resurgence, no-year searches, lowercase, surname only, dual cards, "Black" the parallel vs Panini Black');
  check('the page asks the catalogue first', /const target = await _resolveVersionTarget\(query, results\)/.test(src)
    && /_resolveParallelVocab\(query, currentResults\)/.test(src));
  console.log(failures ? `\n${failures} check(s) failed` : '\nall search-grouping checks passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
