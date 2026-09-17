// The photo strip on both desks, and the thing it exists to make visible.
//
// A 2025 Topps Chrome Jaxson Dart #306 sold under eight titles — Leather
// Refractor, X-Fractor, Red White & Blue, RayWave and so on. The desk showed
// four photos in a row, drawn from four of those titles, with nothing on screen
// tying a photo to a title.
//
// That is not a cosmetic problem. The split list names each parallel correctly,
// so the decision itself is not in doubt. What the pooled strip hides is a
// WONKY title: a photo tagged X-Fractor showing a card that is plainly a Hyper
// means that title is carrying sales it should not, and answering the card
// correctly does nothing about it. Unlabelled, the one photo that disagrees
// with its label looks exactly like the three that agree.
//
// So: every photo carries its title, every title with photos is represented,
// and clicking a photo picks that title. These run the real function out of
// both pages rather than reading the source, because the failure being guarded
// against is a strip that renders and says nothing.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PAGES = ['parallel-desk.html', 'insert-desk.html'];

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

// The reported card, with the photo counts the desk actually stores: up to
// three per title. The Hyper is last on purpose — it is the one a first-N
// strip would drop, and it is the one worth seeing.
const P = 'ration 2025 Topps Chrome - Rookies Jaxson Dart #306 ';
const SPLITS = [
  { label: P + 'Leather Refractor (RC)', sales: 16, photos: ['a1', 'a2', 'a3'] },
  { label: P + 'X-Fractor (RC)', sales: 13, photos: ['b1', 'b2'] },
  { label: P + 'RayWave Refractor (RC)', sales: 11, photos: ['c1'] },
  { label: P + 'Hyper (RC)', sales: 4, photos: ['d1'] },
];
const ITEM = { label: 'Jaxson Dart #306', sales: 44, photos: ['x1', 'x2', 'x3', 'x4'] };

for (const page of PAGES) {
  console.log(`\n--- ${page}`);
  const html = fs.readFileSync(path.join(ROOT, 'public', page), 'utf8');
  const src = html.slice(html.indexOf('function shotStrip('), html.indexOf('function flash('));

  let shotStrip;
  try {
    shotStrip = new Function(src + '; return shotStrip;')();
  } catch (e) {
    check(`${page} shotStrip parses`, false, String(e.message));
    continue;
  }

  const all = shotStrip(ITEM, SPLITS, []);

  check('every photo is labelled with the title it came from',
    all.length > 0 && all.every(s => s.tag),
    all.length ? all.map(s => s.tag).join(' | ').slice(0, 120) : 'empty strip');

  // THE CASE THIS IS FOR. Every title that has a photo must appear, or the
  // disagreeing one is the one that never gets looked at.
  check('  ...and every title with a photo is represented',
    new Set(all.map(s => s.at)).size === SPLITS.length,
    [...new Set(all.map(s => s.at))].join(',') + ' of 0,1,2,3');

  // Specifically the Hyper: four photos taken in order would be three Leather
  // Refractors and an X-Fractor, and the odd one out would never be on screen.
  const firstFour = all.slice(0, 4).map(s => s.at);
  check('  ...including the rarest one, which order would have buried',
    firstFour.includes(3) && new Set(firstFour).size === 4,
    'first four come from titles ' + firstFour.join(','));

  // The labels are identical up to the parallel name. Repeating the product,
  // the player and the number under every photo is the same wall of text the
  // strip already failed to distinguish.
  check('  ...by the part that differs, not the part they share',
    all.every(s => !s.tag.includes('Jaxson Dart')) &&
    all.some(s => s.tag === 'Hyper (RC)') && all.some(s => s.tag === 'X-Fractor (RC)'),
    all.map(s => s.tag).join(' | ').slice(0, 120));

  // Cut at a word boundary, not wherever the strings happen to diverge.
  //
  // This needs a fixture whose titles diverge MID-WORD, which the four above do
  // not — they split on the first letter after "#306 ", already a boundary, so
  // removing the backup loop changed nothing and this check passed against a
  // build without it. RayWave and Red White & Blue share an "R": a bare common
  // prefix caption them "ayWave Refractor" and "ed White & Blue Refractor".
  {
    const sameLetter = [
      { label: P + 'RayWave Refractor (RC)', sales: 11, photos: ['c1'] },
      { label: P + 'Red White & Blue Refractor (RC)', sales: 13, photos: ['e1'] },
    ];
    const tags = shotStrip(ITEM, sameLetter, []).map(s => s.tag).sort();
    check('  ...cut at a word boundary, never mid-word',
      tags.length === 2 && tags[0] === 'RayWave Refractor (RC)'
      && tags[1] === 'Red White & Blue Refractor (RC)',
      tags.join(' | '));
  }

  // Picking narrows the strip, so "show me just these" works.
  const two = shotStrip(ITEM, SPLITS, [1, 3]);
  check('picking titles narrows the strip to them',
    two.length > 0 && two.every(s => s.at === 1 || s.at === 3)
    && new Set(two.map(s => s.at)).size === 2,
    two.map(s => `${s.at}:${s.tag}`).join(' | '));

  // The index has to address the ORIGINAL split list — it is what a click
  // toggles. An index into the filtered subset would pick the wrong title,
  // silently, and save the answer against it.
  check('  ...and each photo still points at its own title',
    two.every(s => SPLITS[s.at] && SPLITS[s.at].label.endsWith(s.tag)),
    two.map(s => `${s.at} -> ${s.tag}`).join(' | '));

  // One title means there is nothing to tell apart, and a caption under every
  // photo repeating the same words is noise.
  const one = shotStrip(ITEM, [SPLITS[0]], []);
  check('a card sold under one title needs no captions',
    one.length === 3 && one.every(s => s.tag === '' && s.at === 0),
    one.map(s => `${s.at}:"${s.tag}"`).join(' | '));

  // Older queue entries, and any title whose sales carried no image, have no
  // per-title photos at all. Falling back unlabelled is right; inventing a
  // label would be the exact error this guards against.
  const pooled = shotStrip(ITEM, [{ label: 'x', sales: 1, photos: [] }], []);
  check('with no per-title photos it falls back, unlabelled rather than wrong',
    pooled.length === 4 && pooled.every(s => s.tag === '' && s.at === -1),
    pooled.map(s => s.url).join(','));

  check('  ...and an item with no photos at all renders nothing, not a crash',
    shotStrip({}, [], []).length === 0 && shotStrip({ photos: [] }, [], []).length === 0,
    'an empty strip must be empty, not an exception');

  // The strip is bounded. A card sold under eight titles with three photos
  // each is 24 images on a phone.
  const many = shotStrip(ITEM, Array.from({ length: 8 }, (_, i) =>
    ({ label: P + 'Parallel ' + i, sales: 5, photos: ['p' + i + 'a', 'p' + i + 'b', 'p' + i + 'c'] })), []);
  check('the strip stays a strip',
    many.length <= 12 && new Set(many.map(s => s.at)).size === 8,
    `${many.length} photos across ${new Set(many.map(s => s.at)).size} titles`);

  // ---- and the page has to actually use it ------------------------------
  //
  // A helper that is correct and unwired is a strip that still says nothing.
  // Named checks, because this is exactly the shape of mistake that passes
  // every test above.
  check('the page builds its strip from the helper',
    /const shots = shotStrip\(item, splits, chosen\);/.test(html),
    'render must call it, not read view.photos');
  check('  ...renders the caption',
    /s\.tag \? '<figcaption>' \+ esc\(s\.tag\) \+ '<\/figcaption>' : ''/.test(html),
    'the label has to reach the screen');
  check('  ...and a click on a photo picks its title',
    /document\.querySelectorAll\('\.shot\[data-s\]'\)\.forEach\(el => \{\s*\n\s*el\.onclick = \(\) => \{ toggle\(Number\(el\.dataset\.s\)\); \};/.test(html),
    'clicking the thing being looked at must select it');
  check('  ...with the picked ones marked',
    /s\.at >= 0 && picked\.has\(s\.at\) \? ' on' : ''/.test(html),
    'a selection you cannot see is one you cannot trust');
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall shot-strip checks passed');
process.exit(failures ? 1 : 0);
