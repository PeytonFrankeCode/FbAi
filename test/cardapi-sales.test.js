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
check('the collector keeps under the plan storage cap and can purge after cancelling', /def prune_to_cap/.test(py) && /def purge/.test(py) && /"starter": \{"rows": 10_000,\s+"store": 500_000\}/.test(py));
check('most expensive first, and at most 6 of one card in one grade a day', /SORT = os\.environ\.get\("CARDAPI_SORT"\) or "price_desc"/.test(py) && /PER_CARD_DAY = int\(os\.environ\.get\("CARDAPI_PER_CARD_DAY"\) or 6\)/.test(py) && /def cap_per_card/.test(py));
check('a blank sport is filled from the site\'s basketball, baseball and football player lists', /sport-players\.json/.test(py) && /players" \/ "index\.json/.test(py) && /def _player_sport/.test(py));
const wf = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'collect-sold-cardapi.yml'), 'utf8');
check('the workflow runs nightly and reads CARDAPI_PLAN from a repo variable', /cron:/.test(wf) && /vars\.CARDAPI_PLAN/.test(wf));

console.log(failures ? `\n${failures} cardapi check(s) failed` : '\nall cardapi checks passed');
process.exit(failures ? 1 : 0);
