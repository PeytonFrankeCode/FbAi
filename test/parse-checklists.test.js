// Set headers the checklist parser used to refuse, and what refusing cost.
//
// A refused header is not dropped quietly: its cards run on into the set above
// it. That is how 2021 Score Team came to hold 606 cards (25 of its own and all
// 581 of "Tom Brady TD Tribute"), how Gold Standard's Golden Shield Signatures
// held three sets at once ("Good as Gold" and both its parallels), and how
// Downtown!, Kaboom! and Bang! vanished from their products. Each case below is
// a line from the source, with what follows it there.
const P = require('../scripts/parse-checklists.js');

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

const header = (lines) => P.isSetHeader(lines[0], lines, 0);

const HEADERS = [
  // "as" was not an allowed lowercase word.
  [['Good as Gold Checklist', '40 cards.', '1 Joe Montana /10'], 'Good as Gold'],
  // A name that starts with a digit read as a card or a count.
  [['1981 Tribute Checklist', '35 cards.', 'Parallels:'], '1981 Tribute'],
  [['1-2 Punch Checklist', '20 cards.', '1 Tom Brady'], '1-2 Punch'],
  [['100 Years Signatures Checklist', '20 cards.'], '100 Years Signatures'],
  [['3D Checklist', '15 cards.', 'Parallels:'], '3D'],
  // No "Checklist" suffix, but "N cards." straight after and not a card.
  [['1999 Elite Rookies', '50 cards.', 'Buy on:'], '1999 Elite Rookies'],
  // "!" in the name.
  [['Bang! Checklist', '15 cards.', 'Parallels:'], 'Bang!'],
  [['Extra! Extra! Checklist', '20 cards.'], 'Extra! Extra!'],
  // The Word sources space every line out; the count was 8 raw lines down.
  [['Tom Brady TD Tribute Checklist', '', 'Buy on:', '', 'eBay', '', '', '', '2001', '18 cards.', '1 Tom Brady'], 'Tom Brady TD Tribute'],
  // OCR reads the 1 of "1st" as l or I.
  [['lst Round Gems Platinum Checklist', '20 cards.'], '1st Round Gems Platinum'],
];
for (const [lines, name] of HEADERS) {
  check(`"${lines[0]}" is a set header named "${name}"`,
    header(lines) && P.cleanSetName(lines[0]) === name,
    `header=${header(lines)} name="${P.cleanSetName(lines[0])}"`);
}

// And what must still NOT be a header.
const NOT_HEADERS = [
  // A card line, even with a count after it.
  ['12 Tom Brady', '50 cards.'],
  // A card with a set name glued onto its end by the source.
  ['340 Marlon Mack, Indianapolis Colts /99 — Rookie Jersey Auto Jumbo Photo Variations Checklist', '15 cards.'],
  // A card count, a range note.
  ['379 cards.', 'Parallels:'],
  ['#2-60 — Rookies', '1 Tom Brady'],
  // "!" inside a word is page noise, not a title.
  ['Wh!te Noise Checklist', '10 cards.'],
];
for (const lines of NOT_HEADERS) {
  check(`"${lines[0].slice(0, 50)}" is not a set header`, !header(lines));
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall parse-checklists checks passed');
process.exit(failures ? 1 : 0);
