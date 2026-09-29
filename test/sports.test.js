// Sports: football is live, basketball and baseball are under testing.
//
// A first visit asks which sports; Settings changes it; the switch above the
// search picks the one in use; every page that is still football-only says
// so. The flow was driven in Chromium; this holds the rules.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

const js = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');
const body = (name) => {
  let start = js.indexOf(`function ${name}(`);
  let depth = 0, i = js.indexOf(') {', start) + 2;
  for (; i < js.length; i++) { if (js[i] === '{') depth++; else if (js[i] === '}' && --depth === 0) break; }
  return js.slice(start, i + 1);
};

// ---- the saved choice, run for real -------------------------------------------
const store = {};
const localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } };
const decl = js.slice(js.indexOf('var SPORTS_KEY'), js.indexOf('// The saved choice'));
const api = new Function('localStorage', `${decl}; ${body('_sportsSaved')}; ${body('sportsPrefs')}; return { SPORTS, SPORT_IDS, _sportsSaved, sportsPrefs };`)(localStorage);

check('three sports: football live, basketball and baseball under testing',
  api.SPORT_IDS.join() === 'football,basketball,baseball' && !api.SPORTS.football.testing && api.SPORTS.basketball.testing && api.SPORTS.baseball.testing);
check('  ...each with its own example searches and search hint',
  api.SPORT_IDS.every(id => api.SPORTS[id].chips.length === 6 && api.SPORTS[id].placeholder));
check('someone never asked reads as "not asked", and gets football meanwhile', api._sportsSaved() === null && api.sportsPrefs().active === 'football');
store.chSports = JSON.stringify({ enabled: ['baseball', 'hockey', 'football'], active: 'hockey' });
check('  ...an unknown sport is dropped and the active one falls back to one that is on',
  api.sportsPrefs().enabled.join() === 'football,baseball' && api.sportsPrefs().active === 'football');
store.chSports = JSON.stringify({ enabled: [], active: 'football' });
check('  ...an empty or broken choice asks again', api._sportsSaved() === null && ((store.chSports = '{nope'), api._sportsSaved() === null));
store.chSports = JSON.stringify({ enabled: ['basketball'], active: 'basketball' });
check('  ...basketball alone is a valid choice', api.sportsPrefs().active === 'basketball');

// ---- the page ------------------------------------------------------------------
check('a first visit is asked, with football ticked and a way to skip',
  /id="sports-picker"/.test(html) && /_sportChipsHtml\(\['football'\], 'picker'\)/.test(js) && /saveSportsPicker\(true\)/.test(html) && /\nmaybeAskSports\(\);\n/.test(js));
check('  ...the tour waits until it is answered', /if \(tourSeen\(\) \|\| !_sportsSaved\(\)\) return;/.test(js) && /\/\/ The tour waited for this; it can run now\.\s*maybeStartTour\(\);/.test(js));
check('Settings can turn each sport on or off, never all of them', /id="settings-sports"/.test(html)
  && /if \(!picked\.length\) \{ box\.checked = true;/.test(js));
// Search takes no sport pick: the switch lives on the Checklists page only.
const searchSection = (html.match(/<section class="search-section"[\s\S]*?<\/section>/) || [''])[0];
const checklistList = (html.match(/<div id="checklist-products"[\s\S]*?id="checklist-product-grid"/) || [''])[0];
check('the search has no sport switch; the Checklists page has one, shown with a choice to make',
  !/id="sport-switch"/.test(searchSection) && /id="sport-switch"/.test(checklistList) && /sw\.classList\.toggle\('hidden', p\.enabled\.length < 2\)/.test(js));
check('the search hint and example searches mix every sport turned on',
  /`e\.g\. \$\{names\.slice\(0, -1\)\.join\(', '\)\} or/.test(js) && /for \(const id of p\.enabled\) if \(SPORTS\[id\]\.chips\[i\]/.test(js));
check('a testing sport says so when its listings come back, and the football market box goes with football',
  /id="sport-note"/.test(html) && /is under testing\.<\/strong> Live listings and 2018&ndash;2026 checklists are in\. Sold prices are still thin/.test(js)
  && /\.no-football #market-pulse \{ display: none !important; \}/.test(css));
check('  ...the football-only pages say so when football is off',
  ['checklist-view', 'rainbow-page', 'market-view'].every(id => js.includes(`['${id}',`)) && /is football-only for now\.<\/strong>/.test(js));
check('both searches read their results through the sports turned on',
  (js.match(/const sportView = _sportFilterResults\(Array\.isArray\(data\.results\) \? data\.results : \[\]\);/g) || []).length === 2);

// The title reading and the filter, run for real.
{
  const src = js.slice(js.indexOf('var _SPORT_TITLE'), js.indexOf('// The note under the search'))
    + '; _sportPlayers = { basketball: new Set(["victor wembanyama", "lebron james"]), baseball: new Set(["shohei ohtani", "mike trout"]) };';
  const run = (enabled) => new Function('sportsPrefs', `${src}; return { _sportOfTitle, _sportFilterResults };`)(() => ({ enabled }));
  const { _sportOfTitle, _sportFilterResults } = run(['football']);
  check('a title says its sport by name, league or a one-sport product line',
    _sportOfTitle('2023-24 Panini Prizm Victor Wembanyama RC NBA') === 'basketball' && _sportOfTitle('2018 Topps Chrome Shohei Ohtani MLB') === 'baseball'
    && _sportOfTitle('2011 Topps Update Series Mike Trout') === 'baseball' && _sportOfTitle('2017 Panini Prizm Patrick Mahomes NFL') === 'football'
    && _sportOfTitle('2020 Prizm Silver Justin Herbert') === null);
  check('  ...and most titles by the player they name', _sportOfTitle('2023 Panini Prizm Victor Wembanyama Silver #136 RC PSA 10') === 'basketball'
    && _sportOfTitle('2011 Topps Update Mike Trout US175') === 'baseball' && _sportOfTitle('Lebron James 2003-04 Topps Chrome #111') === 'basketball'
    && _sportOfTitle('2017 Prizm Patrick Mahomes #269') === null);
  const L = (t) => ({ title: t });
  const mix = [L('2020 Prizm Justin Herbert Silver'), L('2020 Prizm Herbert RC NFL'), L('2020 Prizm Zion Williamson NBA'), L('2020 Prizm LaMelo Ball Basketball')];
  const f = _sportFilterResults(mix);
  check('with football on, plainly basketball listings are hidden and counted', f.results.length === 2 && f.hidden.basketball === 2 && f.sport === null);
  const only = _sportFilterResults([L('Wembanyama Prizm NBA'), L('Wembanyama Prizm Basketball')]);
  check('  ...but never down to nothing: a search that is all off-sport still shows', only.results.length === 2 && !Object.keys(only.hidden).length);
  const all = run(['football', 'basketball', 'baseball'])._sportFilterResults(mix);
  check('with every sport on, nothing is hidden, and a mostly-basketball search is named as one',
    all.results.length === 4 && !Object.keys(all.hidden).length && run(['basketball'])._sportFilterResults([L('A NBA'), L('B Basketball'), L('C')]).sport === 'basketball');
}
check('the choice follows the account to other devices', /'chSports',\n\];/.test(js) && /applySport\(\);\s*const picker = document\.getElementById\('sports-picker'\)/.test(js));
check('the sport code runs before the start-up code that calls it', js.indexOf('var SPORTS_KEY') < js.indexOf('\napplySport();\nmaybeAskSports();'));

console.log(failures ? `\n${failures} check(s) failed` : '\nall sports checks passed');
process.exit(failures ? 1 : 0);
