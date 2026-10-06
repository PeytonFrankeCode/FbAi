// Is this sale a graded slab? Read from its PHOTO, for the titles that never say.
//
// WHY. eBay's catalog titles ("1989 Score - 1989 Rookie Barry Sanders #257
// (RC)") read the same for a raw card and a PSA 7, and a PSA 7 sells too close
// to raw for any price rule to tell them apart. One slab in a card's raw sales
// moves the raw price people check their own cards against. The photo, though,
// is unmistakable: a slab is a clear holder with a grading label across the top.
//
// HOW. scripts/score-slab-photos.mjs runs an off-the-shelf image model (CLIP
// ViT-B/32) over raw-filed sale photos in CI, applies a small head trained on
// our own sales (scripts/data/slab-head.json, trained by
// scripts/train-slab-head.mjs), and writes one score per sale to the D1 table
// photo_slab. The Worker never sees the model; it only reads the scores.
//
// MEASURED (Oct 2026, trained on four days, tested on two unseen days):
//   score >= 0.8 alone: about half of title-confirmed slabs, and of the "raw"
//     sales it flagged, 10 of the top 12 were in fact slabs the title hid.
//   0.6-0.8 is where raw cards in toploaders and magnetic one-touch holders
//     sit, so a score there counts only with the price agreeing: at least
//     1.5x the card's other raw sales, and $10 or more.
'use strict';

const PHOTO_SLAB_TABLE = 'photo_slab';
// A score at or above this is a slab on the photo alone.
const PHOTO_SLAB_SURE = 0.8;
// From here up, a slab only when the price agrees (see photoSlabPriced).
const PHOTO_SLAB_MAYBE = 0.5;
const PHOTO_SLAB_PRICE_X = 1.5;
const PHOTO_SLAB_MIN_CENTS = 1000;
// Which head produced a score, so a retrained head can rescore old rows.
const PHOTO_SLAB_MODEL = 'clip-vit-b32+head-2026-10';
// The grade bucket for a sale only its photo calls graded. "Likely": the
// photo shows a slab, not whose or what grade, and the model is right about
// nine times in ten at this score, not every time.
const PHOTO_SLAB_LABEL = 'Likely graded (photo shows a slab)';

// The head: a logistic layer over a unit-length CLIP image embedding.
function slabScore(embedding, head) {
  let z = head.b;
  for (let i = 0; i < head.w.length; i++) z += head.w[i] * embedding[i];
  return 1 / (1 + Math.exp(-z));
}

const _score = (r) => (r && typeof r.slab_score === 'number' ? r.slab_score : null);

// A slab on the photo alone.
function photoSlabSure(r) {
  const s = _score(r);
  return s != null && s >= PHOTO_SLAB_SURE;
}

// A slab because the photo leans that way AND the price agrees: at least
// PHOTO_SLAB_PRICE_X the median of the card's other raw sales.
function photoSlabPriced(r, othersMedianCents) {
  const s = _score(r);
  const c = (r && r.price_cents) || 0;
  return s != null && s >= PHOTO_SLAB_MAYBE && c >= PHOTO_SLAB_MIN_CENTS
      && othersMedianCents > 0 && c >= PHOTO_SLAB_PRICE_X * othersMedianCents;
}

// The raw sales of one card that the photo and the price together call slabs:
// each priced against the median of the OTHER raw sales, so the sale under
// test is not in its own reference. Needs two others to say anything.
function photoPricedSlabs(raws) {
  if (!raws || raws.length < 3) return [];
  const c = (r) => (r && r.price_cents) || 0;
  // Only a leaning photo on a $10+ sale can qualify, so only those pay for a
  // median: a popular card has hundreds of raw sales and a few such photos.
  const lean = new Set(raws.filter(r => _score(r) >= PHOTO_SLAB_MAYBE && c(r) >= PHOTO_SLAB_MIN_CENTS));
  if (!lean.size) return [];
  const med = (xs) => { const a = xs.slice().sort((x, y) => x - y); const m = a.length >> 1;
    return a.length ? (a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2) : 0; };
  return raws.filter((r, i) => lean.has(r)
    && photoSlabPriced(r, med(raws.filter((_, j) => j !== i).map(c).filter(x => x > 0))));
}

module.exports = { PHOTO_SLAB_TABLE, PHOTO_SLAB_SURE, PHOTO_SLAB_MAYBE, PHOTO_SLAB_PRICE_X,
                   PHOTO_SLAB_MIN_CENTS, PHOTO_SLAB_MODEL, PHOTO_SLAB_LABEL,
                   slabScore, photoSlabSure, photoSlabPriced, photoPricedSlabs };
