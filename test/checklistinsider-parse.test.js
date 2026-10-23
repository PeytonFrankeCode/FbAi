// Reading a checklistinsider.com page (owner, Oct 2026: "a lot of the new
// checklists don't have the parallels"). The page below copies the site's
// markup: each parallel ends in "<br />" and a line break, most carry pack
// odds, and the Checklist tab heading is not always there, so reading starts
// at the Base heading.
'use strict';
const path = require('path');
const { parsePage, parseParallels } = require(path.join(__dirname, '..', 'scripts', 'import-checklistinsider.js'));

let failures = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`); if (!ok) failures++; };

const page = `<p>Intro text about parallels.</p><p>&nbsp;</p><h3 id="base-checklist">Base Checklist</h3><div>150 cards.</div><div></div><div><span style="text-decoration: underline;"><em>Parallels</em>:</span><br />
Glitter Holiday (1:3)<br />
Light Blue &amp; White Glitter Holiday (1:13)<br />
Purple Glitter Holiday /99 (1:435)<br />
25th /25 (1:1,725)<br />
Golden Glitter Holiday 1/1 (1:66,377)</div><div>1 Marvin Harrison Jr. - Arizona Cardinals<br />
2 Kyler Murray - Arizona Cardinals<br />
3 Trey McBride - Arizona Cardinals</div><p>&nbsp;</p><h3 id="base-rookies-checklist">Base Rookies Checklist</h3><div>50 cards.</div><div>Odds - 2 per pack.</div><div><span><em>Parallels</em>:</span><br />
Glitter Holiday (1:8)<br />
Red Metallic Holiday /10 (1:6,782)</div><div>151 Fernando Mendoza - Las Vegas Raiders RC<br />
152 Jeremiyah Love - New York Jets RC</div><h3>Team Checklist</h3>`;

const sets = parsePage(page);
const base = sets.find(s => s.name === 'Base');
check('the Base set is read, though reading starts at its own heading', !!base && base.cards.length === 3, JSON.stringify(sets.map(s => s.name)));
check('  ...with every parallel in its list, not only the first',
  base && base.parallels.length === 5, JSON.stringify(base && base.parallels));
check('  ...the pack odds kept out of the names, and the print runs read past them',
  base && base.parallels[0].name === 'Glitter Holiday' && base.parallels[1].name === 'Light Blue & White Glitter Holiday'
  && base.parallels[2].printRun === 99 && base.parallels[3].name === '25th' && base.parallels[3].printRun === 25
  && base.parallels[4].name === 'Golden Glitter Holiday' && base.parallels[4].printRun === 1, JSON.stringify(base && base.parallels));
const rk = sets.find(s => s.name === 'Base Rookies');
check('the next set gets its own list, and its cards are not read as parallels',
  rk && rk.parallels.length === 2 && rk.parallels[1].printRun === 10 && rk.cards.length === 2 && rk.cards[0].rookie, JSON.stringify(rk));
check('a list on one line, and one-of-ones, read right',
  JSON.stringify(parseParallels('Gold /50, Red /25, Black 1/1\nInception - 1/1\nPurple - /150'))
  === JSON.stringify([{ name: 'Gold', printRun: 50 }, { name: 'Red', printRun: 25 }, { name: 'Black', printRun: 1 }, { name: 'Inception', printRun: 1 }, { name: 'Purple', printRun: 150 }]));
// Which set of ours takes a list (2026 Topps Midnight: its Base and Base
// Autographs share every number and player, and the Base list landed on the
// autographs).
const { matchSetForParallels, fillParallels, cardKey } = require(path.join(__dirname, '..', 'scripts', 'sync-checklistinsider.js'));
const mk = (name, n, from = 1) => ({ name, cards: Array.from({ length: n }, (_, i) => ({ number: String(i + from), player: 'Player ' + (i + from) })) });
const pick = (ours, theirs) => { const i = matchSetForParallels(ours, ours.map(o => new Set(o.cards.map(cardKey))), theirs.cards.map(cardKey), theirs); return i < 0 ? null : ours[i].name; };
const midnight = [mk('Base', 100), mk('Base Autographs', 75)];
check('a Base list goes to the Base, not to an autograph set with the same numbers and players',
  pick(midnight, mk('Base', 100)) === 'Base' && pick(midnight, mk('Base Autographs', 75)) === 'Base Autographs');
const holiday = [mk('Base', 200), mk('Base Chrome', 200)];
check('  ...a Base of 150 finds our Base of 200 (base and rookies together), and the 50 rookies\' own list goes nowhere',
  pick(holiday, mk('Base', 150)) === 'Base' && pick(holiday, mk('Base Chrome', 150)) === 'Base Chrome' && pick(holiday, mk('Base Rookies', 50, 151)) === null);
const gold = [{ name: 'Gold', printRun: 50 }, { name: 'Red', printRun: 5 }];
const a = { parallels: [] }, b = { parallels: [{ name: 'Silver', printRun: null }] }, c = { parallels: [{ name: 'Gold', printRun: 50 }] };
check('  ...a set with no parallels takes theirs, one from another source keeps its own, and a short list we built from the site is replaced',
  fillParallels(a, { parallels: gold }, false) === 2 && a.parallels.length === 2
  && fillParallels(b, { parallels: gold }, false) === 0 && b.parallels[0].name === 'Silver'
  && fillParallels(c, { parallels: gold }, true) === 1 && c.parallels.length === 2);
const src = require('fs').readFileSync(path.join(__dirname, '..', 'scripts', 'sync-checklistinsider.js'), 'utf8');
check('the sync fills a held set with no parallels (and a short list it built itself), and can re-read unchanged pages to do it',
  /function fillParallels\(/.test(src) && /--parallels/.test(src) && /lacksParallels\(load\(direct\)\)/.test(src));
console.log(failures ? `\n${failures} check(s) failed` : '\nall checklistinsider-parse checks passed');
process.exit(failures ? 1 : 0);
