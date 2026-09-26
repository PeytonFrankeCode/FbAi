// Reading the parallel from a sold listing's title: real titles from the
// live reader's report (/api/debug/parallel-resolve), each with what it is.
//
// The number this guards above all is FALSE BASE: a real parallel read as the
// base card puts a parallel's price into the base card's comps. Before this
// sweep 18 of these 66 readings were false base ("Holo Prizm #273", "Mojo
// Refractor RC #91TRC-1", "White Disco RC #332"); a reading that cannot be
// sure must say so ("unread"), never guess base.
//
// Each title is read twice: with the player's name (as search and card pages
// pass it) and without (as the column-agreement report does).
const path = require('path');
process.env.CF_WORKER = '1';
const { parallelIndex } = require(path.join(__dirname, '..', 'server.js'));

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

// [title, player, what it is]: BASE, a parallel name, NOT-BASE-OK (an insert
// or variation the reader may leave unread but must not call base), or UNREAD
// (the title names no parallel and cannot be called base either).
const CORPUS = [
  ["1986 Topps Set-Break #161 Jerry Rice RC ! NR-MINT *GMCARDS*", "Jerry Rice", "BASE"],
  ["1989 Topps Traded Set-Break # 83T Barry Sanders NM-MT OR BETTER *GMCARDS*", "Barry Sanders", "BASE"],
  ["1981 Topps Set-Break #216 Joe Montana RC EX-EXMINT *GMCARDS*", "Joe Montana", "BASE"],
  ["2018 PANINI DONRUSS #304 JOSH ALLEN RC RATED ROOKIE BILLS PSA 10", "Josh Allen", "BASE"],
  ["2024 TOPPS NOW #2 CALEB WILLIAMS ROOKIE RC PSA 10", "Caleb Williams", "BASE"],
  ["1998 Topps Finest #121 Peyton Manning Colts RC Rookie HOF PSA 10 GEM MINT", "Peyton Manning", "BASE"],
  ["Topps 2026 Fernando Mendoza Rookie Card #301 Las Vegas Raiders NFL Football", "Fernando Mendoza", "BASE"],
  ["2026 Topps Fernando Mendoza 1991 Chrome Mojo Refractor RC #91TRC-1 Rookie", "Fernando Mendoza", "Mojo"],
  ["2026 Topps Flagship CARDINALS Jeremiah Love Rookie Mojo Refractor RC #91TRC-9", "Jeremiah Love", "Mojo"],
  ["2025 Panini Donruss Optic Jaxson Dart Rated Rookie Holo Prizm #273 Giants", "Jaxson Dart", "Holo"],
  ["2023 Panini Donruss Optic C.J. Stroud Holo Prizm RC Rated Rookie #244 PSA 10", "C.J. Stroud", "Holo"],
  ["2025 Panini Prizm Jaxson Dart White Disco Rookie RC #332 Giants", "Jaxson Dart", "White Disco"],
  ["2025 Panini Prizm Jaxson Dart White Disco RC #332 PSA 10 Giants", "Jaxson Dart", "White Disco"],
  ["2025 Panini Prizm Draft Picks Arch Manning Gold Ice Rated Prospect #166", "Arch Manning", "Gold Ice"],
  ["2025 Topps Resurgence Chrome Colston Loveland Refractor Auto Rookie Bears #116", "Colston Loveland", "Refractor"],
  ["Jaxson Dart 2025 Topps Chrome Refractor Rookie New York Giants #306 RC", "Jaxson Dart", "Refractor"],
  ["Jaxson Dart 2025 Topps Chrome Refractor Rookie New York Giants RC", "Jaxson Dart", "Refractor"],
  ["2024 Panini Prizm Caleb Williams Silver Prizm Rookie RC", "Caleb Williams", "Silver"],
  ["1986 Topps - Jerry Rice #161 (RC)", "Jerry Rice", "BASE"],
  ["1984 Topps - John Elway #63 (RC)", "John Elway", "BASE"],
  ["2025 Topps Chrome - Rookies Jaxson Dart #306 Refractor (RC)", "Jaxson Dart", "Refractor"],
  ["2017 Panini Prizm Patrick Mahomes II #269 Silver Prizm RC", "Patrick Mahomes", "Silver"],
  ["2017 Panini Prizm Patrick Mahomes II #269 RC Chiefs", "Patrick Mahomes", "BASE"],
  ["2024 Panini Mosaic - Rookies Caleb Williams #301 Reactive Blue Mosaic Prizm (RC)", "Caleb Williams", "Reactive Blue Mosaic"],
  ["2024 Panini Prizm - Rookies Caleb Williams #301 Neon Green Pulsar Prizm (RC)", "Caleb Williams", "Neon Green Pulsar"],
  ["1986 Topps - Reggie White #275 (RC)", "Reggie White", "BASE"],
  ["1996 Fleer Metal - Gold Fingers Jerry Rice #6", "Jerry Rice", "NOT-BASE-OK"],
  ["2020 Panini Prizm Joe Burrow #307 Rookie Base PSA 10", "Joe Burrow", "BASE"],
  ["2020 Panini Prizm Justin Herbert Silver #325 RC BGS 9.5", "Justin Herbert", "Silver"],
  ["2024 Panini Prizm Patrick Mahomes II Red Sparkle #138 Kansas City Chiefs", "Patrick Mahomes", "Red Sparkle"],
  ["2021 Donruss Optic Mac Jones Rated Rookie #201 Pink Velocity", "Mac Jones", "Pink Velocity"],
  ["2019 Panini Prizm Kyler Murray #301 RC Base Rookie Cardinals Nice", "Kyler Murray", "BASE"],
  ["2022 Panini Select Brock Purdy Concourse #44 Silver Prizm RC 49ers", "Brock Purdy", "Silver"],
  // A product's name alone is not a parallel: this names none, and has no
  // number to call it base by.
  ["2025 Prizm Cam Ward Auto /5", "Cam Ward", "UNREAD"],
  ["2025 Topps Chrome Jaxson Dart Rookie Auto", "Jaxson Dart", "UNREAD"],
];

const key = (x) => String(x).toLowerCase().replace(/\b(prizms?)\b/g, '').replace(/\brefractors\b/g, 'refractor')
  .replace(/[^a-z0-9]+/g, ' ').trim();

(async () => {
  const pi = await parallelIndex();
  let right = 0, falseBase = 0;
  const wrong = [];
  for (const [title, player, want] of CORPUS) {
    for (const hint of [player, null]) {
      const r = pi.resolveParallel(title, hint ? { player: hint } : {});
      const got = r.parallel || (r.how === 'base' ? 'BASE' : `unread (${r.how})`);
      const ok = want === 'BASE' ? got === 'BASE' : want === 'NOT-BASE-OK' ? got !== 'BASE'
        : want === 'UNREAD' ? !r.parallel && r.how !== 'base' : key(got) === key(want);
      if (want !== 'BASE' && got === 'BASE') falseBase++;
      if (ok) right++; else wrong.push(`${hint ? 'named' : 'bare '} ${got} (want ${want}): ${title}`);
    }
  }
  const total = CORPUS.length * 2;
  check('no parallel is ever read as the base card', falseBase === 0, `${falseBase} false base`);
  // One reading is allowed to miss: a 2026 rookie the player index does not
  // know yet, read without his name, is honestly unread.
  check(`titles are read right (${right}/${total})`, right >= total - 1, wrong.join(' | '));
  console.log(failures ? `\n${failures} check(s) failed` : '\nall title-reading checks passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
