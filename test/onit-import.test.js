// ONIT checklists (owner, Nov 2026): the PDFs onitathlete.com publishes, read
// into products. The text below is pdftotext -layout output of real ONIT PDFs
// (the 2025 Alabama team set and the 2025 Ohio State ONIT Black), trimmed.
'use strict';
const path = require('path');
const { parseChecklistText, toProduct, listFromPage, nameCase, firstYear } = require(path.join(__dirname, '..', 'scripts', 'import-onit.js'));
let failures = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`); if (!ok) failures++; };

const alabama = `         Alabama Football Checklist 2025
       CARD NUMBER         No                    Name    Pos
Base
B-1                             35 Abduall Sanders Jr.   LB
B-2                              6 Aeryn Hampton         WR
B-56                            15 Ty Simpson            QB
\fB-57                                        75 Wilkin Formby             OL
Autographs
A-1                             15 Ty Simpson            QB
`;
const sets = parseChecklistText(alabama);
check('sections become sets, the title and header are skipped', sets.length === 2 && sets[0].name === 'Base' && sets[1].name === 'Autographs', JSON.stringify(sets.map(s => [s.name, s.cards.length])));
check('rows read number and player, past the jersey number and position, across a page break',
  sets[0].cards.length === 4 && sets[0].cards[0].number === 'B-1' && sets[0].cards[0].player === 'Abduall Sanders Jr.' && sets[0].cards[3].player === 'Wilkin Formby' && sets[0].cards[3].number === 'B-57');

const black = `      Ohio State Football 2025 ONIT Black Checklist
 CARD NUMBER         No                       Name         Pos
Base
B-11                      11 C.J. HICKS               LB
B-31                      18 JAYLEN McCLAIN           SAF
B-34                       7 JERMAINE MATHEWS JR.     CB
B-56                      17 TARVOS "TJ" ALFORD       LB
B-21                      43 DIANTÉ GRIFFIN           CB
`;
const b = parseChecklistText(black)[0].cards.map(c => c.player);
check('capitalised names are title-cased, keeping initials, Mc and suffixes', JSON.stringify(b) === JSON.stringify(['C.J. Hicks', 'Jaylen McClain', 'Jermaine Mathews Jr.', 'Tarvos "TJ" Alford', 'Dianté Griffin']), JSON.stringify(b));
check('mixed-case names are left as written', nameCase('Mal Waldrep Jr.') === 'Mal Waldrep Jr.' && nameCase('LT Overton') === 'LT Overton');

const p = toProduct({ brand: 'Gravity', school: 'Alabama', sport: 'Football', year: '2025', suffix: '' }, sets);
check('a product per line, school and season, named as the cards are sold', p.id === '2025-onit-gravity-alabama-football' && p.name === '2025 ONIT Gravity Alabama Football' && p.year === 2025 && p.sport === 'Football' && p.brand === 'ONIT Athlete');
check('  ...every card carries the school as its team; sets get categories', p.sets[0].cards.every(c => c.team === 'Alabama') && p.sets[0].category === 'base' && p.sets[1].category === 'autograph');
check('team sets are "ONIT Athlete"; a two-season year starts the season', toProduct({ brand: 'Team Set', school: 'Texas A&M', year: '2026' }, sets).id === '2026-onit-athlete-texas-a-and-m-football' && firstYear('2025-2026') === 2025);

// The 2026 team sets (2026 Texas Tech, trimmed): a two-line title, group
// names before each header, a parallels line, lettered autograph numbers.
const tt = `                      ONIT Team Trading Cards Checklist
                          2026 Texas Tech Football
BASE SET   CARD NO.      JERSEY NO.      PLAYER NAME            POS.
           B-1                        15 Austin Romaine         LB
           B-2                        13 Ben Roberts            LB
\f                  B-71                          49 Will Karoll                P
Base Parallels (Teal, Purple, Black, Green /100, Orange /75, Gold /1)
                  B-1                           15 Austin Romaine             LB
                  B-2                           13 Ben Roberts                LB
INSERTS           CARD NO.       JERSEY NO.      PLAYER NAME           POS.   SEQ
Campus Colors Standard
                  CC-1                        15 Austin Romaine        LB
City Limits Gold Parallel
                  CL-1                         8 Cameron Dickey        RB     /1
AUTOGRAPHS         CARD NO.        JERSEY NO.      PLAYER NAME           POS.   SEQ
Black & Team Color Base Signature
                   S-CD                          8 Cameron Dickey        RB
                   GA-WH                       15 Will Hammond      QB   /9
* Look for Special Parallels in These Series
`;
const ts = parseChecklistText(tt);
check('2026 layout: title lines skipped, group before the header names the base set',
  JSON.stringify(ts.map(s => [s.name, s.cards.length])) === JSON.stringify([['Base', 3], ['Campus Colors Standard', 1], ['City Limits Gold Parallel', 1], ['Black & Team Color Base Signature', 2]]), JSON.stringify(ts.map(s => [s.name, s.cards.length])));
check('  ...the parallels line becomes the base set\'s parallels, not a second copy of the cards',
  JSON.stringify(ts[0].parallels) === JSON.stringify([{ name: 'Teal', printRun: null }, { name: 'Purple', printRun: null }, { name: 'Black', printRun: null }, { name: 'Green', printRun: 100 }, { name: 'Orange', printRun: 75 }, { name: 'Gold', printRun: 1 }]));
check('  ...lettered numbers and a trailing print run read cleanly', ts[2].cards[0].player === 'Cameron Dickey' && ts[3].cards[0].number === 'S-CD' && ts[3].cards[1].number === 'GA-WH' && ts[3].cards[1].player === 'Will Hammond');
check('  ...and the product carries them', toProduct({ brand: 'Team Set', school: 'Texas Tech', year: '2026' }, ts).sets[0].parallels.length === 6);

const page = '<script type="application/json" data-ca-part>{"checklists":[{"brand":"Team Set","school":"Alabama","sport":"Football","year":"2026","pdf":"x.pdf"}]}</script>'
  + '<script type="application/json" data-ca-part>{"checklists":[{"brand":"Gravity","school":"Texas","sport":"Football","year":"2025","pdf":"y.pdf"}]}</script>';
check('the checklist list is read from every part of the page', listFromPage(page).length === 2);

console.log(failures ? `\n${failures} onit check(s) failed` : '\nall onit checks passed');
process.exit(failures ? 1 : 0);
