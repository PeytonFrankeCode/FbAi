// A colour fingerprint for a card photo.
//
// Parallels are, by definition, the same card printed in different foil —
// Silver, Gold, Red, Blue, Disco. That difference is visual and survives in
// even a very small thumbnail, which is why this is worth trying after the
// titles ran out of road: a listing can spell the parallel any way it likes, or
// omit it, but the picture still shows a gold card.
//
// The signature has to survive what eBay photos actually do: different crops,
// slight rotation, phone-camera white balance, a hand or a desk in frame. So it
// deliberately throws away layout and keeps colour. Two photos of the same
// Silver Prizm taken by different sellers should land close together; a Silver
// and a Gold of the same card should not.
//
// What it CANNOT do, stated here so nobody expects it later: separate print
// runs. A /25 and a /99 of one parallel are physically identical apart from
// tiny serial numbering that no thumbnail preserves. Those stay a text problem.

const HUE_BINS = 12;              // 30° each — finer splits just chase noise
// Near-grey pixels have a meaningless hue, and card photos are full of them
// (white borders, black slabs, grey desks). Counting them would swamp the
// signal from the foil, so they are measured separately instead.
const GREY_SAT = 0.15;

/**
 * Build a signature from raw RGB(A) pixels.
 * @param {Uint8Array|Uint8ClampedArray} px  RGB or RGBA, row-major
 * @param {number} channels 3 or 4
 * @returns {{hues: number[], grey: number, sat: number, light: number, satSpread: number}}
 */
function signatureFromPixels(px, channels = 3) {
  const hues = new Array(HUE_BINS).fill(0);
  let greyWeight = 0, satSum = 0, lightSum = 0, satSqSum = 0, n = 0;

  for (let i = 0; i + channels - 1 < px.length; i += channels) {
    // A transparent pixel is padding from the resize, not part of the card.
    if (channels === 4 && px[i + 3] < 8) continue;
    const r = px[i] / 255, g = px[i + 1] / 255, b = px[i + 2] / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const light = (max + min) / 2;
    const d = max - min;
    const sat = d === 0 ? 0 : d / (1 - Math.abs(2 * light - 1) || 1);

    n++;
    lightSum += light;
    satSum += sat;
    satSqSum += sat * sat;

    if (d < GREY_SAT * 0.5 || sat < GREY_SAT) { greyWeight++; continue; }

    let h;
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
    // Weighted by saturation, so a vividly gold pixel counts for more than a
    // washed-out one. Foil is the loud part of the picture and should dominate.
    hues[Math.min(HUE_BINS - 1, Math.floor(h / (360 / HUE_BINS)))] += sat;
  }

  if (!n) return { hues, grey: 1, sat: 0, light: 0, satSpread: 0 };

  const total = hues.reduce((a, b) => a + b, 0);
  if (total > 0) for (let i = 0; i < HUE_BINS; i++) hues[i] /= total;

  const meanSat = satSum / n;
  return {
    hues: hues.map(v => Math.round(v * 1000) / 1000),
    grey: Math.round((greyWeight / n) * 1000) / 1000,
    sat: Math.round(meanSat * 1000) / 1000,
    light: Math.round((lightSum / n) * 1000) / 1000,
    // How uneven the saturation is. Foil parallels glare in patches, so a
    // rainbow or disco card spreads wide where a matte base card does not.
    satSpread: Math.round(Math.sqrt(Math.max(0, satSqSum / n - meanSat * meanSat)) * 1000) / 1000,
  };
}

/**
 * Distance between two signatures. 0 is identical, 1 is unrelated.
 *
 * Hue is most of it, because that is what tells Gold from Silver. The scalars
 * carry the rest: a Silver and a White parallel share a hue histogram made
 * almost entirely of grey, and only lightness and saturation separate them.
 */
function distance(a, b) {
  if (!a || !b) return 1;
  let hue = 0;
  for (let i = 0; i < HUE_BINS; i++) hue += Math.abs((a.hues[i] || 0) - (b.hues[i] || 0));
  hue /= 2;                                    // L1 over two distributions ∈ [0,2]
  const scalar = (Math.abs(a.grey - b.grey)
                + Math.abs(a.sat - b.sat)
                + Math.abs(a.light - b.light)
                + Math.abs(a.satSpread - b.satSpread)) / 4;
  // Weighted toward hue, but never ignoring the greyscale case, where hue says
  // nothing at all and the scalars are the entire answer.
  const colourfulness = 1 - Math.min(a.grey, b.grey);
  const w = 0.35 + 0.4 * colourfulness;
  return Math.min(1, w * hue + (1 - w) * scalar);
}

/** Average several signatures into a reference for one parallel. */
function centroid(sigs) {
  const list = (sigs || []).filter(Boolean);
  if (!list.length) return null;
  const hues = new Array(HUE_BINS).fill(0);
  let grey = 0, sat = 0, light = 0, satSpread = 0;
  for (const s of list) {
    for (let i = 0; i < HUE_BINS; i++) hues[i] += (s.hues[i] || 0);
    grey += s.grey; sat += s.sat; light += s.light; satSpread += s.satSpread;
  }
  const n = list.length;
  const r = (v) => Math.round((v / n) * 1000) / 1000;
  return {
    hues: hues.map(v => Math.round((v / n) * 1000) / 1000),
    grey: r(grey), sat: r(sat), light: r(light), satSpread: r(satSpread),
    samples: n,
  };
}

/**
 * Pick the best candidate — or refuse.
 *
 * Refusing is the whole point. A wrong parallel merges two different cards and
 * nothing downstream can detect it, whereas declining only costs sample. So a
 * winner has to be both close in absolute terms AND clearly better than the
 * runner-up: a photo that is equally near Gold and Bronze has not identified
 * anything, however near it is.
 *
 * @param {object} sig
 * @param {Array<{key: string, centroid: object}>} candidates
 * @param {{maxDistance?: number, minMargin?: number}} opts
 */
function bestMatch(sig, candidates, opts = {}) {
  // Calibrated by measurement, not taste. Across colour swatches under varying
  // noise and crop, distance-to-own-centroid reaches 0.427 while
  // distance-to-a-different-centroid starts at 0.158 — the two distributions
  // OVERLAP, so no absolute cutoff can separate them and one alone would be
  // false confidence. The margin does the real work: nearest-centroid alone got
  // 29/32 right (3 wrong), and requiring a clear gap turned all three errors
  // into refusals for 21 right, 11 refused, ZERO wrong. Wrong answers merge two
  // markets invisibly; refusals only cost sample.
  const maxDistance = opts.maxDistance == null ? 0.45 : opts.maxDistance;
  const minMargin = opts.minMargin == null ? 0.06 : opts.minMargin;
  const scored = (candidates || [])
    .filter(c => c && c.centroid)
    .map(c => ({ key: c.key, distance: distance(sig, c.centroid) }))
    .sort((a, b) => a.distance - b.distance);

  if (!scored.length) return { key: null, why: 'no-candidates' };
  const [top, next] = scored;
  if (top.distance > maxDistance) {
    return { key: null, why: 'too-far', distance: top.distance, nearest: top.key };
  }
  if (next && next.distance - top.distance < minMargin) {
    return { key: null, why: 'ambiguous', distance: top.distance,
             nearest: top.key, runnerUp: next.key, margin: Math.round((next.distance - top.distance) * 1000) / 1000 };
  }
  return { key: top.key, why: 'matched', distance: Math.round(top.distance * 1000) / 1000,
           margin: next ? Math.round((next.distance - top.distance) * 1000) / 1000 : null };
}

module.exports = { signatureFromPixels, distance, centroid, bestMatch, HUE_BINS };
