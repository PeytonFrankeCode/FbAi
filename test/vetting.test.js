// Where does a sale belong? The re-sort behind docs/vetting-plan.md.
//
// Every title here is a real sale from the D1 table (the Oct 2026 audit). The
// first half pins sales that ARE mis-filed and where each one goes. The second
// half pins look-alikes that are NOT, because a false move costs as much as a
// missed one: it takes a real sale away from the card that sold.
const { resortSale, productParallelsFrom, categoryOf, kindOf, titleYears } = require('../vetting-core.js');
const pi = require('../parallel-index.js');
const PP = productParallelsFrom(require('../public/data/parallel-index.json'), pi.norm);

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};
const sale = (title, cols = {}) => ({ title, player: 'Player', year: 2025, parallel: null,
  print_run: null, is_auto: 0, is_relic: 0, grader: null, grade: null, ...cols });
const dest = (row) => resortSale(row, pi, { productParallels: PP });

// ---- mis-filed: each goes somewhere specific ----------------------------
const moved = [
  // The plan's own example: an authenticated auto filed as the PSA 10 card.
  [sale('1984 Topps Roger Craig Autographed Rookie RC PSA Authentic AUTO 10 #138619826',
        { year: 1984, is_auto: 1, grader: 'PSA', grade: 10 }), 'authentic'],
  [sale('2020 Panini Contenders - Rookie Ticket Swatch VAR Jordan Love #RSV-JLO PSA AUTH',
        { year: 2020, grader: 'PSA' }), 'authentic'],
  [sale('Aaron Rodgers Auto PSA/DNA Authentic 2005 Topps Rookie Card Packers signed RC',
        { year: 2005, is_auto: 1, grader: 'PSA', grade: 10 }), 'authentic'],
  // Topps' own "(AU, RC)" — arrived as is_auto = 0.
  [sale('2025 Topps Finest - Rookie Finest Autographs Shemar Stewart #RFA-SST (AU, RC)'), 'auto'],
  [sale('2023 PANINI FLAWLESS True RPA Blue SAPPHIRE #RPA-JGS JAHMYR GIBBS ROOKIE 2/10',
        { year: 2023, parallel: 'Sapphire' }), 'auto'],
  [sale('2024 Panini Immaculate Collection - Rookie Jerseys Jayden Daniels /99', { year: 2024 }), 'relic'],
  [sale('Aaron Rodgers Rookie Card SAGE HIT Insert The Write Stuff. Facsimile Auto PSA 8',
        { year: 2005, is_auto: 1 }), 'not-auto'],
  // A.J. Green read as a Green parallel, at import time.
  [sale('AHMAN GREEN (Packers HOF) Signed 2001 Topps Heritage #29 Nebraska',
        { player: 'Ahman', year: 2001, parallel: 'Green', is_auto: 1 }), 'parallel'],
  [sale('1993 PRO LINE LIVE #92 REGGIE WHITE PACKERS HOF POP 1 PSA 9',
        { player: 'Reggie White', year: 1993, parallel: 'White' }), 'parallel'],
  [sale('2025 Panini Donruss Optic - Rated Rookie Ashton Jeanty #202 Blue Prizm /249 (RC)',
        { set_name: 'Donruss Optic', brand: 'Panini' }), 'parallel'],
  [sale('2022 Panini Score Kansas City Chiefs Travis Kelce 1 Of 1 metal Printing Plate',
        { year: 2022 }), 'parallel'],
  [sale('2023 Panini Prizm Tom Brady #1 Silver', { year: 2021 }), 'year'],
  // The import read "BGS 9/10" (card 9, auto 10) as a /10 serial.
  [sale('2020 Phoenix Joe Burrow Rising Rookie Material Gloves Auto #/35 BGS 9/10',
        { year: 2020, is_auto: 1, is_relic: 1, print_run: 10, grader: 'BGS', grade: 9 }), 'parallel'],
  [sale('2008 Topps Chrome Football Lot of 31 includes  30 Diff w/rookies & stars', { year: 2008 }), 'category:lot'],
  [sale('2015 Donruss Optic #1 TOM BRADY Lot (5 Cards) Mint G.O.A.T.', { year: 2015 }), 'category:lot'],
  [sale('2025 TOPPS CHROME FOOTBALL 1975 RC LOT18'), 'category:lot'],
  [sale('1964 PHILADELPHIA FOOTBALL YOU PICK #1 - #198  NM SHARP *** FREE SHIPPING ***', { year: 1964 }), 'category:you-pick'],
  [sale('Custom Kaboom! Jaxson Dart New York Giants Insert Card #KJD-1'), 'category:custom'],
  [sale('2026 Topps Chrome Black TreVeyon Henderson Quinshon Judkins Dual Auto Redemption', { year: 2026 }), 'category:redemption'],
  [sale('1969 Topps #25 Johnny Unitas Reprint', { year: 1969 }), 'category:reprint'],
  // A lot of autos is a lot before it is an auto.
  [sale('2024 Prizm Auto Lot of 3 rookies', { year: 2024 }), 'category:lot'],
];
for (const [row, want] of moved) {
  const d = dest(row);
  check(`moves: ${row.title.slice(0, 70)}`, d.dest === want, `${d.dest} (${d.reason}), wanted ${want}`);
}

// ---- reprints wait for a person ----------------------------------------
// "1996 Topps Namath Reprint" is an official card; "1969 Topps Unitas
// Reprint" for $2 is not. Text cannot tell them apart, so neither moves alone.
check('an art card waits for a person (Bowman U Now Art Cards are official)',
      dest(sale('Fernando Mendoza 2025-26 Bowman U Now #CSFM-A Art Card BGS-10 Black Label')).confidence === 'low');
check('a dual grade the import took for a print run is fixed without a person',
      dest(sale('2020 Phoenix Joe Burrow Rising Rookie Material Gloves Auto #/35 BGS 9/10',
                { year: 2020, is_auto: 1, is_relic: 1, print_run: 10, grader: 'BGS', grade: 9 })).confidence === 'high');
// "2025/26" is a season (basketball, hockey, soccer), not "/26" (owner, Oct 2026).
{
  const holiday = sale('2025/26 Topps Motif Jrue Holiday Halo On Card True 1/1 Auto Bucks Blazers Boston',
                       { player: 'Jrue Holiday', is_auto: 1, print_run: 26, card_number: '2025', sport: 'basketball' });
  const d = dest(holiday);
  check('a season the import read as a print run is fixed without a person',
        d.dest === 'parallel' && d.confidence === 'high' && /season/.test(d.reason), `${d.dest}/${d.confidence}: ${d.reason}`);
  check('  ...and so is a season year read as the card number',
        d.flags.some(f => f.dest === 'card-number' && f.confidence === 'high'));
  check('  ...while a real serial beside a season still reads',
        dest(sale('2024/25 Topps Chrome Wembanyama Gold /50', { print_run: 50, parallel: 'Gold', sport: 'basketball' })).dest === 'keep');
}
// "Pop 1/1" is the slab's population, not a serial (owner, Oct 2026).
{
  const favre = sale('Pop 1/1 Highest 2011 Panini Prime Signatures #/20 Brett Favre Auto Gold PSA 9',
                     { player: 'Brett Favre', year: 2011, parallel: 'Gold', print_run: 1, is_auto: 1, grader: 'PSA', grade: 9 });
  const d = dest(favre);
  check('a population the import read as a print run is fixed without a person',
        d.dest === 'parallel' && d.confidence === 'high' && d.to === '/20' && /population/.test(d.reason), `${d.dest}/${d.confidence}: ${d.reason}`);
  const diamond = dest(sale('2021 Panini Flawless Collegiate Emmitt Smith Diamond Gem PSA 10 POP 1/1',
                            { player: 'Emmitt Smith', year: 2021, parallel: 'Diamond', print_run: 1, grader: 'PSA', grade: 10 }));
  check('  ...but with no other run in the title (a true 1/1?) a person decides',
        diamond.flags.some(f => f.dest === 'parallel' && f.confidence === 'low' && f.to === 'not numbered'));
}
// Tiffany is a parallel wherever the title puts it (owner, Oct 2026).
{
  const pi2 = require('../parallel-index');
  const t = ['1987 TOPPS TIFFANY #366 MARK MCGWIRE PSA 10', '1984 Topps Tiffany Set-Break #300 Pete Rose PSA 10',
             '1989 Topps Traded Tiffany #41T Ken Griffey Jr Limited Collectors Edition PSA 10',
             '2003 Fleer Tradition Jerry Rice Tiffany /200', '1990 BOWMAN TIFFANY #481 KEN GRIFFEY JR'];
  const unread = t.filter(x => (pi2.resolveParallel(x, {}) || {}).parallel !== 'Tiffany');
  check('Tiffany reads as a parallel in every layout', !unread.length, unread.join(' | '));
  const d = dest(sale('1987 TOPPS TIFFANY #366 MARK MCGWIRE PSA 10', { player: 'Mark McGwire', year: 1987, grader: 'PSA', grade: 10 }));
  check('  ...and a Tiffany filed as the base card moves without a person',
    d.dest === 'parallel' && d.confidence === 'high' && d.to === 'Tiffany', `${d.dest}/${d.confidence} ${d.to}`);
}
check('a reprint is never moved without a person',
      dest(sale('1996 Topps Namath Reprint Joe Namath New York Jets #122 PSA 9 Rc', { year: 1996 })).confidence === 'low');

// ---- NOT mis-filed: each of these stays where it is ---------------------
const stays = [
  // Product names carrying auto/relic words.
  sale('2024 Topps Signature Class Blake Corum ODYSSEY RC Case Hit PSA 10 POP 1!', { year: 2024 }),
  sale('2025 Topps Chrome JAYDEN DANIELS True White Refractor JERSEY MATCH #’d 5/30',
       { parallel: 'True White Refractor', print_run: 30 }),
  sale('Chris Johnson 2011 Panini Threads #143 Titans NFL', { year: 2011 }),
  // Draft-pick wording, not "you pick".
  sale('Topps 2025 Signature Class Jaxson Dart Giants RC Auto Insert #106 Pick 25', { is_auto: 1 }),
  // Wild Card's products, and a print run, are not lot sizes.
  sale('2024 Wild Card 5 Card Draw Tetairoa McMillan Ace Of Heart Silver Orange Auto 1/1',
       { year: 2024, is_auto: 1, parallel: 'Silver Orange', print_run: 1 }),
  sale('2024 Topps Chrome Caleb Williams #202 X-fractor', { year: 2024, parallel: 'X-fractor' }),
  // Real inserts named Mystery.
  sale('1998 Topps Mystery Finest #M8 John Elway Denver Broncos HOF Beckett 9.5', { year: 1998 }),
  // A parallel after the player's name is not the player's name.
  sale('2025 Panini Donruss Cam Ward Downtown! SP RC Rookie #12 Titans PSA 10',
       { player: 'Cam Ward', parallel: 'Downtown' }),
  sale('2025 Topps Chrome Black Matthew Golden Super Futures Autograph Card Gold /50',
       { player: 'Matthew', is_auto: 1, parallel: 'Gold', print_run: 50 }),
  // "Panini Authentic" and "SP Authentic" are products, not slabs.
  sale('2023 Panini Authentic Bijan Robinson #12 RC', { year: 2023, grader: null }),
  sale('1998 SP Authentic Peyton Manning #14 PSA 9', { year: 1998, grader: 'PSA', grade: 9 }),
  // A season and a dual-grade slab.
  sale('2023-24 Panini Prizm Victor Wembanyama #136 Silver', { year: 2024, parallel: 'Silver', sport: 'basketball' }),
  sale('2020 CHRONICLES JALEN HURTS ROOKIE AUTO PURPLE 21/25 PSA 9 w/ 10',
       { year: 2020, is_auto: 1, parallel: 'Purple', print_run: 25, grader: 'PSA', grade: 9 }),
  sale('2025 Panini Prizm - Rookies Jaxson Dart #332 Silver Prizm (RC)',
       { parallel: 'Silver Prizm', set_name: 'Prizm' }),
  sale('1988 Topps Bo Jackson Rookie RC #327 Raiders', { year: 1988 }),
  // The Star Company's 1984 card, not a "Stars" parallel.
  sale('1984 STAR #12 LARRY BIRD PSA 7', { player: 'Larry Bird', year: 1984, set_name: null,
       grader: 'PSA', grade: 7, sport: 'basketball' }),
  // A real card sold in or with something custom.
  sale('2020 Panini Donruss Optic - Downtown Pat Tillman #DT-1 HGA 9.5 Custom Slab',
       { year: 2020, grader: 'HGA', grade: 9.5 }),
  // A grading label's tier is not a parallel.
  sale('1987 Fleer #59 Michael Jordan 2nd year PSA 9 - MBA Silver - 4SC Elite',
       { player: 'Michael Jordan', year: 1987, grader: 'PSA', grade: 9, sport: 'basketball' }),
];
for (const row of stays) {
  const d = dest(row);
  check(`stays: ${row.title.slice(0, 70)}`, d.dest === 'keep', `${d.dest} (${d.reason})`);
}

// ---- the readers on their own ------------------------------------------
check('titleYears ignores print runs and card numbers',
      JSON.stringify(titleYears('2021 Prizm #2020 Gold /2000')) === '[2021]', JSON.stringify(titleYears('2021 Prizm #2020 Gold /2000')));
check('titleYears reads both halves of a season',
      JSON.stringify(titleYears('2023-24 Prizm')) === '[2023,2024]');
check('an auction house lot number is a single card',
      categoryOf('Lot #214: 1958 Topps Jim Brown #62 PSA 5') === null);
check('"no auto" is not an auto', kindOf('Jaxson Dart Rookie Prizm, not the auto') === '');
check('a missing reader skips the parallel test, not the sale',
      resortSale(sale('2025 Panini Prizm #1 Silver'), null).dest === 'keep');

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nall vetting checks passed');
