// Can a colour fingerprint tell one parallel from another?
//
// The titles topped out: 4.4% of cards carrying a parallel still read as base,
// and the stubborn ones are increasingly cards absent from the checklists
// altogether, which no text reader can recover. Photos carry the signal
// directly — a Gold Prizm is gold whatever the seller typed — and 100% of
// sales have one.
//
// The risk is the same one that has bitten every stage of this work: claiming a
// parallel that is wrong merges two different cards at two different prices and
// nothing downstream notices, while declining only costs sample. So most of
// what follows checks that it REFUSES.
//
// These are synthetic swatches, not real cards. That is on purpose — it pins
// the maths down before any of it depends on the network. Whether real eBay
// photos behave like this is a separate question that only production can
// answer, and the probe endpoint exists to ask it.
const { signatureFromPixels, distance, centroid, bestMatch } = require('../photo-signature.js');

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

// A card photo is mostly card, with some background. Build a swatch with a
// dominant colour plus a white border, the way a scan actually looks.
function swatch(rgb, { noise = 0, border = 0.25, size = 16 } = {}) {
  const px = new Uint8Array(size * size * 3);
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5) * 2;
  const edge = Math.floor(size * border / 2);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 3;
      const isBorder = x < edge || y < edge || x >= size - edge || y >= size - edge;
      const base = isBorder ? [245, 245, 245] : rgb;
      for (let c = 0; c < 3; c++) {
        px[i + c] = Math.max(0, Math.min(255, Math.round(base[c] + (noise ? rnd() * noise : 0))));
      }
    }
  }
  return px;
}

const COLOURS = {
  gold:   [212, 175, 55],
  silver: [190, 190, 195],
  red:    [200, 40, 40],
  blue:   [40, 80, 200],
  green:  [40, 160, 70],
  purple: [130, 60, 190],
};
const sig = (name, opts) => signatureFromPixels(swatch(COLOURS[name], opts), 3);

// 1. The core claim: same parallel photographed twice is closer to itself than
//    to a different parallel. If this fails nothing else matters.
{
  const goldA = sig('gold', { noise: 18, border: 0.25 });
  const goldB = sig('gold', { noise: 34, border: 0.35 });   // rougher photo, different crop
  const dSelf = distance(goldA, goldB);
  const worst = Math.min(...Object.keys(COLOURS).filter(k => k !== 'gold')
    .map(k => distance(goldA, sig(k, { noise: 18 }))));
  check('two photos of the same parallel sit closer than two different ones',
        dSelf < worst,
        `gold↔gold ${dSelf.toFixed(3)} vs nearest other ${worst.toFixed(3)}`);
}

// 2. Every pair of distinct colours must be separable, not just the easy ones.
{
  const names = Object.keys(COLOURS);
  const sigs = Object.fromEntries(names.map(n => [n, sig(n, { noise: 20 })]));
  const collisions = [];
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const d = distance(sigs[names[i]], sigs[names[j]]);
      if (d < 0.12) collisions.push(`${names[i]}/${names[j]} ${d.toFixed(3)}`);
    }
  }
  check('  ...and every pair of distinct colours is separable',
        collisions.length === 0,
        collisions.length ? `TOO CLOSE: ${collisions.join(', ')}` : `all ${names.length * (names.length - 1) / 2} pairs apart`);
}

// 3. The guarantee the whole approach rests on, swept rather than hand-picked:
//    across every colour and every photo variation, it must never return a
//    WRONG parallel. Refusing is fine and expected; being wrong is not, because
//    a wrong parallel merges two markets at two prices and nothing downstream
//    can see it happen.
//
//    Measured: nearest-centroid alone gets 29/32 with 3 errors. The margin rule
//    turns all three into refusals. That trade — coverage for correctness — is
//    the reason bestMatch requires a gap and not just proximity.
{
  // Includes the greyscale cases deliberately. White, Silver and Black are
  // where hue carries no information at all, so a sweep over vivid colours
  // alone would pass while the hardest real parallels went unguarded — and
  // Silver is one of the commonest parallels there is.
  const HARD = { ...COLOURS, white: [248, 248, 248], black: [35, 35, 38] };
  const hsig = (k, o) => signatureFromPixels(swatch(HARD[k], o), 3);
  const names = Object.keys(HARD);
  const cands = names.map(k => ({
    key: k, centroid: centroid([hsig(k, { noise: 8 }), hsig(k, { noise: 22 }), hsig(k, { border: 0.35 })]),
  }));
  const variations = [{ noise: 15 }, { noise: 30 }, { border: 0.3, noise: 12 }, { border: 0.18, noise: 25 }];
  let right = 0, refused = 0;
  const wrong = [];
  for (const k of names) {
    for (const v of variations) {
      const r = bestMatch(hsig(k, v), cands);
      if (r.key === k) right++;
      else if (r.key === null) refused++;
      else wrong.push(`${k} -> ${r.key} (d=${r.distance})`);
    }
  }
  const total = names.length * variations.length;
  check('across the whole sweep it is never wrong, only undecided',
        wrong.length === 0,
        wrong.length ? `WRONG: ${wrong.join('; ')}` : `${right} matched, ${refused} refused, 0 wrong of ${total}`);
  // A matcher that only ever declines is safe and useless, so the coverage has
  // to be real too. This is the floor, not the target.
  check('  ...while still answering more often than not',
        right > total / 2, `${right}/${total} answered`);
}

// 4. And a card unlike anything on file is refused too — an unseen parallel
//    must not be forced into the nearest known one.
{
  const odd = signatureFromPixels(swatch([255, 0, 255], { noise: 5 }), 3);
  const cands = [{ key: 'green', centroid: centroid([sig('green'), sig('green', { noise: 20 })]) }];
  const r = bestMatch(odd, cands, { maxDistance: 0.05 });
  check('  ...and a colour unlike anything on file is refused',
        r.key === null && r.why === 'too-far',
        `${r.why} d=${r.distance != null ? r.distance.toFixed(3) : '?'}`);
}

// 5. A vivid, unambiguous card must actually be claimed — the easy case has to
//    come out easy or the thresholds are simply too tight to be useful.
{
  const unknown = sig('red', { noise: 12, border: 0.25 });
  const cands = Object.keys(COLOURS).map(k => ({
    key: k, centroid: centroid([sig(k, { noise: 8 }), sig(k, { noise: 22 }), sig(k, { border: 0.3 })]),
  }));
  const r = bestMatch(unknown, cands);
  check('an unambiguous card is claimed, not declined',
        r.key === 'red', `${r.why} -> ${r.key} (d=${r.distance}, margin=${r.margin})`);
}

// 6. Greyscale is the hard case and the one most likely to be wrong in the
//    field: Silver, White and Base are all mostly colourless, so hue says
//    nothing and only lightness and saturation separate them. Recording the
//    real behaviour rather than asserting a hope.
{
  const white = signatureFromPixels(swatch([248, 248, 248], { noise: 6 }), 3);
  const silver = sig('silver', { noise: 6 });
  const black = signatureFromPixels(swatch([35, 35, 38], { noise: 6 }), 3);
  const dWS = distance(white, silver), dWB = distance(white, black);
  check('greyscale parallels separate by lightness, not hue',
        dWB > dWS && dWB > 0.1,
        `white↔silver ${dWS.toFixed(3)}, white↔black ${dWB.toFixed(3)}`);
}

// 7. A centroid is a reference only if it is built from enough photos. This
//    just pins the bookkeeping — the coverage probe showed 5,921 parallels with
//    a single photo, and those must stay identifiable as thin.
{
  const c = centroid([sig('blue'), sig('blue', { noise: 20 }), sig('blue', { border: 0.35 })]);
  check('a centroid records how many photos backed it',
        c && c.samples === 3, `samples=${c && c.samples}`);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall photo-signature checks passed');
process.exit(failures ? 1 : 0);
