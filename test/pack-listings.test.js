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

console.log(failures ? `\n${failures} check(s) failed` : '\nall pack-listing checks passed');
process.exit(failures ? 1 : 0);
