// Chase / mystery pack listings are not the card on their photo, so they are
// left out of search, card history and the market. "Chase" is also a name.
const path = require('path');
process.env.CF_WORKER = '1';
const { _isPackListing, RSI_JUNK_WORDS } = require(path.join(__dirname, '..', 'server.js'));

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

const OUT = [
  ['2025 Donruss Cam Ward Downtown CHASE PACK 🔥', 'Cam Ward'],
  ['Chaser Pack #12 Bo Nix Silver Prizm hit shown', 'Bo Nix'],
  ['NFL MYSTERY PACK Mahomes auto chase!', 'Patrick Mahomes'],
  ['2024 Prizm Jayden Daniels CHASE - 1 hit per pack', 'Jayden Daniels'],
  ['Mystery Box - Caleb Williams Downtown possible', 'Caleb Williams'],
  ['Chase Box Josh Allen Kaboom', 'Josh Allen'],
];
const KEEP = [
  ["2021 Prizm Ja'Marr Chase Silver #294 RC", "Ja'Marr Chase"],
  ['2021 Prizm JaMarr Chase #294 PSA 10', ''],              // player column empty
  ['2023 Prizm Chase Brown Silver RC #312', 'Chase Brown'],
  ['2020 Prizm Chase Young #313 RC', 'Chase Young'],
  ['2021 Donruss Joe Burrow / Chase Dual Jersey #7', 'Joe Burrow'],
  ['2025 Score Mystery Rookie #305 Redemption', 'Mystery Rookie'],
  ['2022 Select XRC Mystery Autograph', 'Bryce Young'],
  ['2025 Donruss Downtown Cam Ward #12 Case Hit SSP', 'Cam Ward'],
];
const wrongOut = OUT.filter(([t, p]) => !_isPackListing(t, p));
check(`chase / chaser / mystery pack listings are left out (${OUT.length})`, !wrongOut.length,
  wrongOut.map(x => x[0]).join(' | ') || 'all');
const wrongKeep = KEEP.filter(([t, p]) => _isPackListing(t, p));
check(`players named Chase, "Mystery Rookie" and case hits are kept (${KEEP.length})`, !wrongKeep.length,
  wrongKeep.map(x => x[0]).join(' | ') || 'all');
check('the market basket leaves them out too',
  RSI_JUNK_WORDS.includes('chaser') && RSI_JUNK_WORDS.includes('mystery') && !RSI_JUNK_WORDS.includes('chase pack'));

const src = require('fs').readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
check('search results, card history and the sold archive all apply the filter',
  /rows\.filter\(r => !_isPackListing\(r\.title, r\.player\)\)/.test(src)
  && /\.results\) \|\| \[\]\)\s*\.filter\(r => !_isPackListing\(r\.title, r\.player\)/.test(src)
  && /rec\.sales\.filter\(x => !_isPackListing/.test(src));

// ---- not a card at all: app-only digital cards and "1st Graded" ----
// Kept out of every card's sales (owner, Oct 2026). "Digital" alone is not
// enough: Resurgence "Digital Surge", "Digital Camo" and Leaf "Digital Foil"
// are physical cards and must stay.
{
  const blocked = [
    '2025 Topps NFL Chrome Autograph Rookie RC - TYLER SHOUGH  (TOPPS NFL DigitalCard',
    'DIGITAL Topps NFL Collect Drake Maye 2025 Cosmic Chrome Black Equinox Auto /10',
    '2025 Topps Finest Digital Jaydon Blue Rookie Auto Legendary 50cc Cowboys',
    '2024 Topps Bowman Chrome 1st Rookie RC - JAC CAGLIANONE (TOPPS Bunt Dlgital card',
    'Jaxson Dart 2025 Topps Chrome #306 New York Giants Rookie Card RC 1st Graded 10',
  ];
  const kept = [
    '2025 Topps Resurgence Riley Leonard Digital Surge Refractor /100 Colts',
    'ISAAC TESLAA 2025 TOPPS CHROME TEAM DIGITAL CAMO REFRACTOR ROOKIE RC #320',
    '2026 Leaf Electrum Achromatic Red Gold Digital Foil 1/1 Mike Schmidt Auto',
    'Jerry Rice 1998 Fleer Ultra #6CC Canton Classics 49ers SSP RARE PSA 9',
    'Tom Brady MINT PANINI PRIZM FIREWORKS SP INSERT NFL COLLECTION CARD - MINT!',
    '2025 Topps Chrome Jaxson Dart #306 RC 1st Bowman Refractor',
  ];
  const wrongB = blocked.filter(t => !_isPackListing(t));
  check('app-only digital cards and "1st Graded" are not a card',
    !wrongB.length, wrongB.join(' | ') || `all ${blocked.length}`);
  const wrongK = kept.filter(t => _isPackListing(t));
  check('  ...while physical "Digital" parallels and look-alikes stay',
    !wrongK.length, wrongK.join(' | ') || `all ${kept.length}`);

}

console.log(failures ? `\n${failures} check(s) failed` : '\nall pack-listing checks passed');
process.exit(failures ? 1 : 0);
