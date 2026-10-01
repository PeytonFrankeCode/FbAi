// The rainbow's parallel matcher, on titles taken from live eBay listings.
//
// It was too strict to be useful: 3 of 34 tiles across six real rainbows found
// a listing. A Prizm parallel is stored as "Blue Prizms" and sellers write
// "Blue Prizm"; an autograph set's listings say "Auto" and were refused for
// it; "Green Bay Packers" read as a colour; "X-Fractor" was looked for as
// "xfractor". Loosening it let in the opposite mistakes — a Pink Refractor
// on the plain Refractor tile, an insert on the base card's — so both
// directions are pinned here.
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

// The matcher and what it reads, lifted out of app.js.
const NAMES = ['_PARALLEL_COLORS', 'SCAN_KEY_PARALLEL_PHRASES', 'SCAN_KEY_PARALLEL_WORDS', '_RB_GENERIC_WORDS',
  '_RB_EXCLUSIVE_EFFECTS', '_rbEffectText', '_rbEffectsIn', '_RB_TEAM_COLOR_PHRASES', '_rbWithoutTeams', '_rbWord',
  '_RB_PRODUCT_LINES', '_RB_SET_GENERIC', 'filterStrictVariant', '_rbQueryName', '_rbNumbered', '_rbNumberFirst'];
function lift(name) {
  const m = new RegExp(`^(const|function|let|var) ${name}\\b`, 'm').exec(src);
  if (!m) throw new Error(`${name} not found in app.js`);
  let depth = 0, started = false, j = m.index;
  for (; j < src.length; j++) {
    const ch = src[j];
    if ('([{'.includes(ch)) { depth++; started = true; }
    else if (')]}'.includes(ch)) depth--;
    else if (ch === '\n' && started && depth === 0) {
      const prev = src.slice(m.index, j).trimEnd();
      if (prev.endsWith(';') || prev.endsWith('}') || prev.endsWith(']')) break;
    } else if (ch === ';' && depth === 0 && !started) { j++; break; }
  }
  return src.slice(m.index, j);
}
const M = new Function(NAMES.map(lift).join('\n') + '\nreturn { filterStrictVariant, _rbQueryName, _rbNumberFirst };')();

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};
const PRIZM = { category: 'base', setName: 'Base Set', product: '2024 Panini Prizm Football Prizm', otherSets: ['Rookie Gear', 'Flashback Rookies', 'Rookie Autographs'] };
const CHROME = { category: 'base', setName: 'Base Set', product: '2024 Topps Chrome Football Topps Chrome', otherSets: ['Youthquake', '1974 Topps Football', 'All-Etch Autographs', 'Rookies'] };
const AUTOS = { category: 'autograph', setName: 'Rookie Autographs', product: '2024 Panini Prizm Football Prizm', otherSets: ['Base Set', 'Rookie Gear'] };
const hit = (title, variant, pr, opts, relax) => M.filterStrictVariant([{ title }], variant, pr || '', { ...opts, relaxPrintRun: !!relax }).length === 1;

// ---- what it used to miss ----
check('"Blue Prizms" matches a title that says "Blue Prizm"',
  hit('JAYDEN DANIELS ROOKIE - 2024 Prizm #347 Blue Prizm SUPER RARE', 'Blue Prizms', '', PRIZM));
check('  ...and a print run missing from the title is allowed when relaxed, a different one never',
  hit('2024 Prizm #347 Jayden Daniels Blue Prizm RC', 'Blue Prizms', '199', PRIZM, true)
    && !hit('2024 Prizm #347 Jayden Daniels Blue Prizm /99 RC', 'Blue Prizms', '199', PRIZM, true));
check('a Packers card is not "Green" for its team, base or parallel',
  hit('2024 Panini Prizm #101 Jordan Love Green Bay Packers Pink Prizm', 'Pink Prizms', '', PRIZM)
    && hit('2024 Panini Prizm Football Jordan Love #101 Green Bay Packers', 'Base', '', PRIZM));
check('"X-Fractor" matches X-Fractor, Xfractor and X Fractor',
  ['2024 Topps Chrome #202 Caleb Williams X-Fractor RC', '2024 Topps Chrome Caleb Williams #202 Xfractor', '2024 Topps Chrome Caleb Williams #202 X Fractor']
    .every(t => hit(t, 'X-Fractor', '', CHROME)));
check('an autograph set\'s parallel matches its "Auto" listings',
  hit('Caleb Williams 2024 Prizm Rookie Auto Gold Prizm 3/10 Bears', 'Gold Prizms', '10', AUTOS));
check('  ...and not a listing with no autograph', !hit('Caleb Williams 2024 Prizm Gold Prizm 3/10 Bears', 'Gold Prizms', '10', AUTOS));
check('"Red White and Blue" matches though it names three colours',
  hit('Jayden Daniels 2024 Prizm #347 Red White Blue Prizm RC', 'Red White and Blue Prizms', '', PRIZM));
check('the search drops the plural and the commas sellers do not write',
  M._rbQueryName('Red, White, and Blue Prizms') === 'Red White Blue Prizm' && M._rbQueryName('Pink Refractors') === 'Pink Refractor');

// ---- what loosening must not let in ----
check('a plain Refractor tile does not take a Pink Refractor',
  !hit('2024 Topps Chrome Jackson Holliday #88 Pink Refractor RC', 'Refractor', '', CHROME)
    && hit('2024 Topps Chrome Jackson Holliday #88 Refractor RC', 'Refractor', '', CHROME));
check('  ...nor an X-Fractor, and an X-Fractor tile no plain Refractor',
  !hit('2024 Topps Chrome #202 Caleb Williams X-Fractor RC', 'Refractor', '', CHROME)
    && !hit('2024 Topps Chrome #202 Caleb Williams Refractor RC', 'X-Fractor', '', CHROME));
check('"Aqua Refractor" is not an Aqua RayWave', !hit('2024 Topps Chrome #88 Jackson Holliday Aqua Raywave Refractor /199', 'Aqua Refractor', '199', CHROME));
check('"Green Prizms" is not a Green Wave', !hit('2024 Prizm Jayden Daniels Prismatic GREEN WAVE PRIZM RC', 'Green Prizms', '', PRIZM));
check('a base card\'s rainbow refuses the product\'s inserts',
  !hit('Caleb Williams 2024 Topps Chrome Youthquake X-Fractor RC', 'X-Fractor', '', CHROME)
    && !hit('2024 TOPPS CHROME 1974 TOPPS FOOTBALL GREEN REFRACTOR CALEB WILLIAMS', 'Green Refractor', '', CHROME));
check('  ...and other products of the line (Update, Sapphire, Logofractor)',
  !hit('2024 Topps Chrome Update #USC89 Jackson Holliday X-Fractor', 'X-Fractor', '', CHROME)
    && !hit('2024 Topps Chrome Logofractor Jackson Holliday #88 Gold Refractor /50', 'Gold Refractor', '50', CHROME));
check('Boston Red Sox is not a Red parallel', hit('2024 Topps Chrome #50 Triston Casas Boston Red Sox Blue Refractor /150', 'Blue Refractor', '150', CHROME, true));

check('a Prism Refractor is not the plain Refractor, and is its own tile',
  !hit('2024 Topps Chrome - Rookies Caleb Williams #202 Prism Refractor (RC)', 'Refractor', '', CHROME)
    && hit('2024 Topps Chrome - Rookies Caleb Williams #202 Prism Refractor (RC)', 'Prism Refractor', '', CHROME));
check('a checkerboard is not a plain Refractor', !hit('Caleb Williams CHECKERBOARD REFRACTOR CHROME TOPPS CHROME BEARS', 'Refractor', '', CHROME));
const CW = { ...CHROME, year: '2024', number: '202' };
check('another year is another card', !hit('2025 Topps Chrome Caleb Williams Green Refractor 42/99', 'Green Refractor', '99', CW)
  && hit('2024 Topps Chrome #202 Caleb Williams Green Refractor 42/99', 'Green Refractor', '99', CW));
check('  ...but a season carries its first year', hit('2023-24 Panini Prizm #136 Victor Wembanyama Green Prizm', 'Green', '', { category: 'base', setName: 'Base', product: '2023-24 Panini Prizm Basketball Prizm', year: '2023', number: '136' }));
check('another card number is another card, and a print run is not a number',
  !hit('2024 Topps Chrome Jackson Holliday Aqua Refractor #USC200 RC /199', 'Aqua Refractor', '199', { ...CHROME, year: '2024', number: '88' })
    && hit('2024 Topps Chrome Jackson Holliday #88 SuperFractor #1/1', 'SuperFractor', '1', { ...CHROME, year: '2024', number: '88' }));
check('a Donruss card is not on a Prizm rainbow', !hit('2024 Panini Donruss-Rated Rookie Jayden Daniels #389 Red Wave Prizm', 'Red Wave Prizms', '', PRIZM));

// ---- this card first ----
const ranked = M._rbNumberFirst([{ title: '2024 Topps Chrome Caleb Williams Gold Refractor 1974' }, { title: '2024 Topps Chrome #202 Caleb Williams Gold Refractor' }], '202');
check('a listing naming the card\'s number comes before one that does not', /#202/.test(ranked[0].title));

// ---- the server lets the rainbow read the parallels itself ----
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
check('/api/search skips its own parallel filter for filter=client',
  /const clientFilters = req\.query\.filter === 'client';/.test(server) && /mode === 'forsale' && !clientFilters/.test(server));
check('  ...and every rainbow request asks for it', (src.match(/filter: 'client'/g) || []).length >= 2 && /params\.set\('filter', 'client'\)/.test(src));

console.log(failures ? `\n${failures} check(s) failed` : '\nall rainbow-match checks passed');
process.exit(failures ? 1 : 0);
