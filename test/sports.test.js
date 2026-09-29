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
check('the switch above the search shows only with a choice to make', /id="sport-switch"/.test(html) && /sw\.classList\.toggle\('hidden', p\.enabled\.length < 2\)/.test(js));
check('a testing sport says so on the search page, and hides the football market numbers',
  /id="sport-note"/.test(html) && /is under testing\.<\/strong> Live listings work/.test(js) && /\.sport-testing #market-pulse \{ display: none !important; \}/.test(css));
check('  ...and on the football-only pages, with a way back to football',
  ['checklist-view', 'rainbow-page', 'market-view'].every(id => js.includes(`['${id}',`)) && /onclick="setActiveSport\('football'\)"/.test(js));
check('the choice follows the account to other devices', /'chSports',\n\];/.test(js) && /applySport\(\);\s*const picker = document\.getElementById\('sports-picker'\)/.test(js));
check('the sport code runs before the start-up code that calls it', js.indexOf('var SPORTS_KEY') < js.indexOf('\napplySport();\nmaybeAskSports();'));

console.log(failures ? `\n${failures} check(s) failed` : '\nall sports checks passed');
process.exit(failures ? 1 : 0);
