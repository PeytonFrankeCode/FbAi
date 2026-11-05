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
  JSON.stringify(ts.map(s => [s.name, s.cards.length])) === JSON.stringify([['Base', 3], ['Base Parallels', 2], ['Campus Colors Standard', 1], ['City Limits Gold Parallel', 1], ['Black & Team Color Base Signature', 2]]), JSON.stringify(ts.map(s => [s.name, s.cards.length])));
check('  ...the parallels line, which covers some of the base cards, is a "Base Parallels" set carrying the list',
  !ts[0].parallels && JSON.stringify(ts[1].parallels) === JSON.stringify([{ name: 'Teal', printRun: null }, { name: 'Purple', printRun: null }, { name: 'Black', printRun: null }, { name: 'Green', printRun: 100 }, { name: 'Orange', printRun: 75 }, { name: 'Gold', printRun: 1 }]));
check('  ...lettered numbers and a trailing print run read cleanly', ts[3].cards[0].player === 'Cameron Dickey' && ts[4].cards[0].number === 'S-CD' && ts[4].cards[1].number === 'GA-WH' && ts[4].cards[1].player === 'Will Hammond');
check('  ...and the product carries them', toProduct({ brand: 'Team Set', school: 'Texas Tech', year: '2026' }, ts).sets[1].parallels.length === 6);

// 2026 Gravity: one checklist for every school, a SCHOOL column, parallels
// in the heading running onto the next line.
const grav = `                               2026 ONIT Gravity Football Checklist
BASE SET            CARD NUMBER            SCHOOL                   PLAYER                           SEQ
Base Set (Parallels: Orange, Silver, Teal /250, Blue /200,
Pulsar /175, Ultra Gold /1)
                                        1 Ohio State                Jeremiah Smith
39 Mississippi State   Fluff Bothwell
Galaxy (Parallels: Blue /200, Ultra Gold /1)
G-KMA   Indiana    Kurtis Mitchell-Allen
Base Signatures                                           SEQ
S-BI    Ohio State     Bo Jackson     /25
`;
const gs = parseChecklistText(grav);
check('Gravity: school column read as the team, the player after it',
  JSON.stringify(gs.map(s => [s.name, s.cards.map(c => c.number + ' ' + c.player + ' / ' + c.team)])) === JSON.stringify([['Base', ['1 Jeremiah Smith / Ohio State', '39 Fluff Bothwell / Mississippi State']], ['Galaxy', ['G-KMA Kurtis Mitchell-Allen / Indiana']], ['Base Signatures', ['S-BI Bo Jackson / Ohio State']]]), JSON.stringify(gs.map(s => [s.name, s.cards])));
check('  ...a heading\'s parallels across two lines', gs[0].parallels.length === 6 && gs[0].parallels[5].name === 'Ultra Gold' && gs[0].parallels[4].printRun === 175 && gs[1].parallels.length === 2);
check('  ...and a multi-school product keeps each card\'s own school', toProduct({ brand: 'Gravity', school: 'Multi-School', year: '2026' }, gs).sets[0].cards[1].team === 'Mississippi State');

// ONIT Black: a parallels line covering only some base cards stays a set.
const blk = parseChecklistText(`Base
B-1     72 ADEDAMOLA AJANI    OL
B-2     4 AIDEN FISHER        LB
B-3     16 ALBERTO MENDOZA    QB
Parallels (Blue; Pink /150; Black /1)
B-2     4 AIDEN FISHER        LB
`);
check('a parallels list for some of the base cards stays its own set', blk.length === 2 && blk[0].cards.length === 3 && !blk[0].parallels && blk[1].name === 'Base Parallels' && blk[1].cards.length === 1 && blk[1].parallels.length === 3, JSON.stringify(blk));
const full = parseChecklistText('Base\nB-1  1 Al Bee  QB\nB-2  2 Cy Dee  WR\nBase Parallels (Gold /1)\nB-1  1 Al Bee  QB\nB-2  2 Cy Dee  WR\n');
check('  ...and one for all of them becomes the base set\'s parallels', full.length === 1 && full[0].parallels[0].name === 'Gold' && full[0].parallels[0].printRun === 1, JSON.stringify(full));

// 2023/2024 team sets: a font drawn 29 codes below its letters, and a note
// column before the jersey number.
const enc = (s) => s.split('').map(c => c === ' ' ? '\u0003' : String.fromCharCode(c.charCodeAt(0) - 29)).join('');
const old = parseChecklistText(['       ' + enc('CARD NUMBER') + '     ' + enc('No') + '    ' + enc('Name'), enc('Base'),
  enc('B-1') + '          ' + enc('17') + ' ' + enc('Amari Jefferson') + '      ' + enc('WR'),
  '   * Series Cards Look for Parallels', enc('B-2') + '    ' + enc('10') + ' ' + enc('Austin Mack') + '  ' + enc('QB'), enc('ICON'),
  enc('IC-1') + '     ' + enc('Additional Signature Edition') + '       ' + enc('2') + ' ' + enc('Ryan Williams') + '       ' + enc('WR')].join('\n'));
check('shifted-font PDFs are read back', JSON.stringify(old.map(s => [s.name, s.cards.map(c => c.number + ' ' + c.player)])) === JSON.stringify([['Base', ['B-1 Amari Jefferson', 'B-2 Austin Mack']], ['ICON', ['IC-1 Ryan Williams']]]), JSON.stringify(old));

const dup = parseChecklistText('Hype Standard\nH-1  2 Isaiah Mozee  WR\nHype Standard\nH-1  2 Isaiah Mozee  WR\nFilm Signature\nFS-DM   14 Dwayne Mcdougle III S\n');
check('a heading printed twice gets a (2); a position set against the name is dropped',
  dup.map(s => s.name).join('|') === 'Hype Standard|Hype Standard (2)|Film Signature' && dup[2].cards[0].player === 'Dwayne Mcdougle III', JSON.stringify(dup));

const page = '<script type="application/json" data-ca-part>{"checklists":[{"brand":"Team Set","school":"Alabama","sport":"Football","year":"2026","pdf":"x.pdf"}]}</script>'
  + '<script type="application/json" data-ca-part>{"checklists":[{"brand":"Gravity","school":"Texas","sport":"Football","year":"2025","pdf":"y.pdf"}]}</script>';
check('the checklist list is read from every part of the page', listFromPage(page).length === 2);

console.log(failures ? `\n${failures} onit check(s) failed` : '\nall onit checks passed');
process.exit(failures ? 1 : 0);
