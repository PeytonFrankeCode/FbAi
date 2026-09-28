// Keyword versions: sold listings no checklist can place, grouped by what
// their titles say (public/app.js, between KW_BEGIN and KW_END).
//
// The titles are real ones from live searches when this was built. The rule
// being held: brand, product line, year, number, parallel, print run and
// auto/relic decide a version; seller filler never does.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

const src = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const pick = (a, b) => { const i = src.indexOf(a); const j = src.indexOf(b, i); if (i < 0 || j < 0) throw new Error('missing ' + a); return src.slice(i, j); };
const ctx = {};
vm.createContext(ctx);
vm.runInContext([
  pick('const PARALLEL_STRIP_TEAMS = [', 'let _parallelCtx = null;'),
  pick('const SCAN_KEY_PARALLEL_PHRASES', '\n'), pick('const SCAN_KEY_PARALLEL_WORDS', ']);') + ']);',
  'const _titleCase = s => s.replace(/\\b\\w/g, c => c.toUpperCase());',
  pick('function _classifyParallel(title, ctx) {', 'function _parallelOf(r) {'),
  pick('// KW_BEGIN', '// KW_END'),
  `this.group = (titles, player) => {
     const p = _cleanForMatch(player).trim();
     const c = { matchers: _fallbackParallelMatchers(), playerRe: new RegExp('\\\\b' + _reEsc(p).replace(/\\s+/g, '[\\\\s-]+') + '\\\\b', 'g') };
     const rs = titles.map(title => ({ title }));
     const groups = _kwGroup(rs, { playerRe: c.playerRe, parallelOf: r => _classifyParallel(r.title, c) });
     return { groups: groups.map(g => ({ n: g.items.length, ..._kwLabels(g, player), titles: g.items.map(r => r.title) })), rs };
   };`,
].join('\n'), ctx);
const together = (res, a, b) => res.rs.find(r => r.title === a)._kw === res.rs.find(r => r.title === b)._kw;

// ---- seller filler never splits a card ----
{
  const t = ['1986 Topps Jerry Rice Rookie Card #161 San Francisco 49ers WR - Vintage HOF',
    'Topps 1986 Jerry Rice Rookie #161 San Francisco 49ers C* Copyright Line',
    '1986 Topps Set-Break #161 Jerry Rice RC ! NR-MINT *GMCARDS*',
    '1986 Topps Jerry Rice #161 RC Rookie PSA 6 EX-MT D 49ers HOF*',
    '1986 TOPPS #161 JERRY RICE RC 49ERS HOF BCCG 9',
    '1986 Jerry Rice Topps Rookie D #161 49ers NFL Trading Card'];
  const res = ctx.group(t, 'Jerry Rice');
  check('one card, however sellers dress up the title, is one version',
    res.groups.length === 1 && res.groups[0].n === t.length, res.groups.map(g => g.n).join(','));
  check('  ...labelled by year and set, then player, number and version',
    res.groups[0].tag === '1986 Topps' && res.groups[0].title === 'Jerry Rice #161 · Base', `${res.groups[0].tag} | ${res.groups[0].title}`);
}

// ---- what does make a different version ----
{
  const base = '2024 Topps Bo Jackson #100 Raiders';
  const chrome = '2024 Topps Chrome Bo Jackson #100 Raiders';
  const chrome2 = 'Bo Jackson 2024 Topps Chrome #100 Sharp';
  const res = ctx.group([base, chrome, chrome2], 'Bo Jackson');
  check('a product line splits the same number (Topps vs Topps Chrome)', !together(res, base, chrome) && together(res, chrome, chrome2));
}
{
  const t = ['2023 PANINI PHOENIX CJ STROUD ROOKIE SILVER #102 PSA 10',
    '2023 Panini Phoenix Silver CJ Stroud RC Rookie Card #102 Texans Gem Mint PSA 10',
    '2023 Panini Phoenix #102 Cj Stroud Fire Burst PSA 10',
    '2023 Panini Phoenix CJ Stroud #102 RC PSA 10',
    '2023 PANINI PHOENIX PURPLE #102 CJ STROUD 17/125 PSA 10',
    '2023 PANINI PHOENIX PURPLE #102 CJ STROUD /125 PSA 10',
    '2023 PANINI PHOENIX CJ STROUD ROOKIE FIRE FORGED #FF6 PSA 10',
    'Houston Texans CJ Stroud 2023 Panini Phoenix Fire Forged #FF-6 RC PSA 10'];
  const res = ctx.group(t, 'CJ Stroud');
  check('a parallel splits the same number (Silver vs base)', !together(res, t[0], t[3]) && together(res, t[0], t[1]));
  check('  ..."Fire Burst" and a bare title are still the base card', together(res, t[2], t[3]));
  check('a serial "17/125" and "/125" are one print run', together(res, t[4], t[5]));
  check('"#FF6" and "#FF-6" are one number', together(res, t[6], t[7]));
  check('  ...and a PSA 10 is not read as a /10 print run', !res.groups.some(g => /\/10\b/.test(g.title)), res.groups.map(g => g.title).join(' | '));
}
{
  const a = '2000 FLEER SKYBOX DOMINION #234 TOM BRADY ROOKIE NEW ENGLAND PATRIOTS';
  const b = 'SkyBox 2000 Dominion Rookies Pairs #234 Tom Brady Giovanni Carmazzi SGC 9';
  const auto = '2000 Skybox Dominion #234 Tom Brady Auto';
  const res = ctx.group([a, b, auto], 'Tom Brady');
  check('a line decides over the brand a seller names (Fleer / Skybox Dominion)', together(res, a, b));
  check('an autograph is its own version', !together(res, a, auto));
}

// ---- titles with no number ----
{
  const n1 = '2023 Panini Phoenix CJ Stroud #102 RC PSA 10';
  const n2 = '2023 Panini Phoenix CJ Stroud #PWF2 Playing With Fire';
  const bare = '2023 Panini Phoenix CJ Stroud PSA 10 Houston Texans';
  const res = ctx.group([n1, n2, bare], 'CJ Stroud');
  check('a title with no number does not guess between two numbered cards', !together(res, bare, n1) && !together(res, bare, n2));
  const one = ctx.group([n1, bare], 'CJ Stroud');
  check('  ...but joins the one numbered card it matches', together(one, n1, bare));
  const vague = ctx.group(['CJ Stroud Rookie PSA 10', 'CJ Stroud RC Texans'], 'CJ Stroud');
  check('a title with no number, brand or line is too vague to group', vague.groups.every(g => g.n === 1));
}

// ---- wiring ----
check('only versions with two or more sales are shown', /KW_MIN_SALES = 2/.test(src) && /g\.items\.length >= KW_MIN_SALES/.test(src));
check('grouping runs on what the checklist cannot account for, or everything when there is none',
  /_buildKwGroups\(_versionCtx\s*\? currentResults\.filter\(r => !_versionOf\(r\) && !_checklistCouldPlace\(r\.title, _versionCtx\)\)\s*: currentResults, player\)/.test(src));

// ---- a checklist card never shows in the keyword grouping ----
{
  const c2 = {};
  vm.createContext(c2);
  vm.runInContext([
    'const PARALLEL_STRIP_TEAMS = [];',
    pick('function _cleanForMatch(s) {', '// "Green Ice Prizms"'),
    pick('function _checklistCouldPlace(title, ctx) {', '// The keyword versions of the current search'),
    'this.could = _checklistCouldPlace;',
  ].join('\n'), c2);
  const ctx = { year: 2025, productName: '2025 Donruss Optic Football', playerRe: /\bjaxson dart\b/g,
    cards: [{ number: '273', setRe: null }, { number: '11', setRe: /\buptown\b/ }, { number: '2', setRe: /\bpassing grade\b/ }] };
  check('a listing with one of the checklist\u2019s numbers is the checklist\u2019s, confirmed parallel or not',
    c2.could('2025 Donruss Optic Jaxson Dart #273 Holo Wave PSA 10', ctx) && c2.could('Jaxson Dart Optic #273 RC Mystery Parallel', ctx));
  check('  ...as is one naming a checklist insert without a number', c2.could('2025 Optic Jaxson Dart Uptown SSP', ctx));
  check('  ...but another year, a sibling product or a number not on the checklist is grouped by title',
    !c2.could('2024 Donruss Optic Jaxson Dart #273', ctx) && !c2.could('2025 Donruss Optic Draft Picks Jaxson Dart #273', ctx)
    && !c2.could('2025 Donruss Optic Jaxson Dart #999', ctx));
}
check('a keyword version filters the comps like a checklist version', /if \(_kwGroups\) return r\._kw \|\| null;/.test(src));
check('a new search never inherits the last one\'s keyword versions',
  /async function buildParallelFilter\(query\) \{[\s\S]{0,260}_kwGroups = null;/.test(src));

console.log(failures ? `\n${failures} check(s) failed` : '\nall keyword-versions checks passed');
process.exit(failures ? 1 : 0);
