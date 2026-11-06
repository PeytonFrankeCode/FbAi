// One player, one page (Nov 2026, from Search Console's Sep-Oct pages): old
// and variant player URLs Google still shows redirect to the player's page,
// and a nickname spelling is folded into the player instead of a second page.
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
let failures = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`); if (!ok) failures++; };

(async () => {
  const { SEARCH_CONSOLE_REDIRECTS } = await import(path.join(ROOT, 'worker.js'));
  const want = {
    'devon-achane-3': 'devon-achane', 'john-metchie-i': 'john-metchie-iii', 'ahmad-sauce-gardner': 'sauce-gardner',
    'chris-olave-ohio-state-buckeyes': 'chris-olave', 'bryce-young-alabama-crimson-tide': 'bryce-young',
    'marshall-faulk-st-louis-rams': 'marshall-faulk', 'derek-stingley-jr-lsu-tigers': 'derek-stingley-jr',
  };
  const miss = Object.entries(want).filter(([a, b]) => SEARCH_CONSOLE_REDIRECTS[a] !== b);
  check('variant player URLs from Search Console redirect to the player', !miss.length, JSON.stringify(miss));
  const builtPlayer = (s) => fs.existsSync(path.join(ROOT, 'public', 'players', s, 'index.html'));
  const players = path.join(ROOT, 'public', 'players');
  if (fs.existsSync(path.join(players, 'sauce-gardner'))) {
    check('"Ahmad “Sauce” Gardner" is folded into Sauce Gardner: one page, under the playing name',
      builtPlayer('sauce-gardner') && !builtPlayer('ahmad-sauce-gardner'));
  }
  const targets = Object.values(SEARCH_CONSOLE_REDIRECTS).filter(t => fs.existsSync(players));
  const dead = fs.existsSync(path.join(players, 'josh-allen')) ? targets.filter(t => !builtPlayer(t)) : [];
  check('every redirect lands on a built player page', !dead.length, JSON.stringify(dead));
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'build-landing-pages.js'), 'utf8');
  check('the build folds the nickname spelling', /NAME_FOLD = \{ 'ahmad sauce gardner': 'sauce gardner' \}/.test(src));
  console.log(failures ? `\n${failures} player-dupes check(s) failed` : '\nall player-dupes checks passed');
  process.exit(failures ? 1 : 0);
})();
