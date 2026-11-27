// The Card API collector (scripts/collect-sold-cardapi.py, owner Nov 2026:
// "$15 a month" budget) stores eBay sales under their eBay item id and other
// platforms' sales as "<platform>-<id>". The site must label those by platform
// and never send a collector to a broken eBay /itm/ page for them.
'use strict';
process.env.NODE_ENV = 'test';
process.env.CF_WORKER = '1';
const path = require('path');
const fs = require('fs');
let failures = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`); if (!ok) failures++; };
const ROOT = path.join(__dirname, '..');
const S = require(path.join(ROOT, 'server.js'));

check('an eBay sale links to its eBay page', S._saleLink({ item_id: '1234567890123', title: 'x' }) === 'https://www.ebay.com/itm/1234567890123');
check('an eBay sale is labelled eBay', S._salePlatform('1234567890123') === 'eBay');
const fan = S._saleLink({ item_id: 'fanatics-42', title: '2024 Prizm Bo Nix Silver  PSA 10' });
check('a Fanatics sale links to an eBay sold search for its title, not /itm/', fan.startsWith('https://www.ebay.com/sch/i.html?_nkw=2024%20Prizm%20Bo%20Nix%20Silver%20PSA%2010') && fan.includes('LH_Sold=1') && !fan.includes('/itm/'), fan);
check('a Fanatics sale is labelled Fanatics Collect', S._salePlatform('fanatics-42') === 'Fanatics Collect');
check('a Goldin sale is labelled Goldin', S._salePlatform('goldin-7') === 'Goldin');
check('no title, no link (never a broken one)', S._saleLink({ item_id: 'goldin-7' }) === '');
check('a test-style id like s1 or w1 keeps its eBay link', S._saleLink({ item_id: 's1', title: 'x' }) === 'https://www.ebay.com/itm/s1' && S._salePlatform('j1') === 'eBay');
check('no id, no link', S._saleLink({}) === '');

const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
check('no D1 sale link is built straight from item_id any more', !/ebay\.com\/itm\/\$\{encodeURIComponent\(r\.item_id\)\}/.test(src.replace(/function _saleLink[\s\S]*?\n}\n/, '')));
const py = fs.readFileSync(path.join(ROOT, 'scripts', 'collect-sold-cardapi.py'), 'utf8');
check('the collector uploads nothing on the free key (non-commercial terms)', /DRY_RUN = os\.environ\.get\("DRY_RUN"\) == "1" or not PAID/.test(py));
const slugs = (py.match(/KNOWN_SLUGS = \{([^}]*)\}/) || [])[1] || '';
check('every platform the collector writes is one the site labels', slugs && slugs.match(/"([a-z]+)"/g).every(q => S._salePlatform(q.slice(1, -1) + '-1') !== 'eBay'), slugs);
check('the collector keeps under the plan storage cap and can purge after cancelling', /def prune_to_cap/.test(py) && /def purge/.test(py) && /"starter": \{"rows": 10_000,\s+"store": 500_000,/.test(py));
check('most expensive first, and at most 6 of one card in one grade a day', /SORT = os\.environ\.get\("CARDAPI_SORT"\) or "price_desc"/.test(py) && /PER_CARD_DAY = int\(os\.environ\.get\("CARDAPI_PER_CARD_DAY"\) or 6\)/.test(py) && /def cap_per_card/.test(py));
check('a blank sport is filled from the site\'s basketball, baseball and football player lists', /sport-players\.json/.test(py) && /players" \/ "index\.json/.test(py) && /def _player_sport/.test(py));
check('a dry run never spends more than 300 rows, on any plan', /if os\.environ\.get\("DRY_RUN"\) == "1":\s+ROWS = min\(ROWS, 300\)/.test(py));
check('the rows the fresh day leaves go to the day 14 days back, nearly complete by then', /def process_day/.test(py) && /## complete pass/.test(py) && /"window": 60/.test(py) && /MATURE_DAYS = int\(os\.environ\.get\("CARDAPI_MATURE_DAYS"\) or 14\)/.test(py));
const wf = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'collect-sold-cardapi.yml'), 'utf8');
check('the workflow runs nightly and reads CARDAPI_PLAN from a repo variable', /cron:/.test(wf) && /vars\.CARDAPI_PLAN/.test(wf));

check('every fetched page is saved as a 30-day artifact, and a saved run can be replayed without spending rows', /def save_raw/.test(py) && /save_raw\(j\.get\("data"\)/.test(py) && /REPLAY_DIR/.test(py) && /actions\/upload-artifact@v4/.test(wf) && /retention-days: 30/.test(wf) && /cardapi-replay\.txt/.test(wf) && /github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'/.test(wf));
check('a photo-less sale borrows an eBay photo of the same card (same grade first, then any), marked #same-card', /def fill_photos/.test(py) && /any_grade\.get\(r\["card_key"\]\)/.test(py) && /SAME_CARD_TAG = "#same-card"/.test(py) && /fill_photos\(rows\)/.test(py));
check('soccer is dropped, and the player lists outrank a set name when the sport is blank', /SOCCER_RE = re\.compile/.test(py) && py.indexOf('by_player = _player_sport(title)') < py.indexOf('guess = sport_from_title(title)'));
check('a change pushed to main re-checks stored sales (sport, photos) first', /def fix_stored/.test(py) && /CARDAPI_FIX/.test(wf));
const appjs = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
check('the site labels a borrowed photo "Photo of the same card"', /card: 'Photo of the same card'/.test(appjs) && /#same-card\$\/\.test/.test(appjs));
check('the chosen sport is final: set on the card before it is stored, so the parser\'s set-name guess cannot undo it', /attrs\.sport = s\.sport/.test(py));
const ninja = fs.readFileSync(path.join(ROOT, 'scripts', 'collect-sold-ninja.py'), 'utf8');
check('soccer is kept out of football: the OpenWeb Ninja collector drops it, and the fix pass sweeps what any collector stored', /SOCCER\.search/.test(ninja) && /SOCCER_SQL_WORDS/.test(py) && /removed from football/.test(py));
// eBay sales only (owner, Nov 2026).
check('the collector keeps eBay sales only, by default', /EBAY_ONLY = os\.environ\.get\("CARDAPI_EBAY_ONLY", "1"\) != "0"/.test(py) && /if EBAY_ONLY and not is_ebay\(s\):\s+return None, "not eBay"/.test(py));
check('...asks the vendor for eBay only, and drops the filter if it is refused or empties the day', /PLATFORM_PARAM: dict\[str, str\] = \{"platform": "ebay"\}/.test(py) && /\*\*PLATFORM_PARAM/.test(py) && (py.match(/PLATFORM_PARAM\.clear\(\)/g) || []).length === 2);
check('...and the stored non-eBay sales are removed on the next fix pass', /non-eBay sales removed \(eBay only\)/.test(py));
const boards = S._ebayOnlyBoards({ available: true, priciest: [{ itemId: '1234567890' }, { itemId: 'fanatics-9' }, { itemId: 'goldin-3' }, { itemId: null }], mostSold: [1] });
check('home boards cached before the change leave non-eBay sales off Most expensive', boards.priciest.length === 2 && boards.priciest[0].itemId === '1234567890' && boards.mostSold.length === 1, JSON.stringify(boards.priciest));
check('...and a board without sales passes through untouched', S._ebayOnlyBoards({ available: false }).available === false && S._ebayOnlyBoards(null) === null);
// The Python itself: a Fanatics sale is dropped before anything else is read.
const { execFileSync } = require('child_process');
let pyOut = '';
try {
  pyOut = execFileSync('python3', ['-c', [
    'import importlib.util, sys',
    `spec = importlib.util.spec_from_file_location("c", ${JSON.stringify(path.join(ROOT, 'scripts', 'collect-sold-cardapi.py'))})`,
    'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
    'print(m.to_sale({"platform": "Fanatics Collect", "id": "9", "title": "2024 Panini Prizm Bo Nix Silver PSA 10", "price": 500, "sold_at": "2026-11-20"})[1])',
    'print(m.is_ebay({"platform": "eBay"}), m.is_ebay({"platform": "goldin"}))',
  ].join('\n')], { encoding: 'utf8', env: { ...process.env, CARD_API_KEY: '' }, timeout: 60000 }).trim();
} catch (e) { pyOut = 'python failed: ' + String(e.stderr || e.message).slice(-300); }
// Deploy's runner has no NflCardDB installed (the collector's own workflow
// does): there the source checks above stand in for this one.
if (/No module named '?nflcarddb|python3: not found|ENOENT/.test(pyOut)) console.log('SKIP  the collector really drops a Fanatics sale (NflCardDB is not installed here)');
else check('the collector really drops a Fanatics sale as "not eBay"', /^not eBay\nTrue False$/.test(pyOut), pyOut);
console.log(failures ? `\n${failures} cardapi check(s) failed` : '\nall cardapi checks passed');
process.exit(failures ? 1 : 0);
