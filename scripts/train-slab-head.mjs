#!/usr/bin/env node
// Retrain the photo slab head (scripts/data/slab-head.json).
//
// Not run by CI: the head changes when someone decides it should, and its
// numbers are checked by a person before it ships. This records how the
// shipped head was made, so it can be made again on fresh days.
//
//   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... \
//     node scripts/train-slab-head.mjs --train 2026-09-20,2026-09-22,2026-09-24,2026-09-26 \
//          --test 2026-09-29,2026-10-01 [--photos dir] [--write]
//
// LABELS come from the sales themselves. A slab: a big-grader sale whose
// grader is in its own title. Raw: no grader, no grade, and a title the
// reader also calls raw. Some "raw" sales are slabs whose titles never say so
// (which is the whole problem), so after a first fit the raw training photos
// the head is surest are slabs are dropped and it is fitted again.
//
// MODEL: CLIP ViT-B/32 image embeddings, unit length, under one logistic
// layer, class-balanced. Photos are eBay's 300px thumbnails, the size
// score-slab-photos.mjs reads.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { gradeBucket } = require(path.join(ROOT, 'grade-core.js'));
const { slabScore } = require(path.join(ROOT, 'photo-slab-core.js'));

const DATABASE_ID = 'a887dd0e-d852-4ebc-98f0-0e01bc82ad0b';
const MODEL = 'Xenova/clip-vit-base-patch32';
const BIG = ['PSA', 'BGS', 'SGC', 'CGC', 'CSG', 'HGA', 'TAG', 'BVG', 'ISA', 'GMA', 'KSA'];
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > -1 ? process.argv[i + 1] : d; };
const days = (s) => String(s || '').split(',').filter(Boolean);
const TRAIN = days(arg('train')), TEST = days(arg('test'));
const PHOTOS = arg('photos', path.join(ROOT, '.slab-photos'));
const { CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT } = process.env;
if (!TOKEN || !ACCOUNT || !TRAIN.length || !TEST.length) {
  console.error('set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID, and pass --train and --test days');
  process.exit(2);
}

async function d1(sql, params = []) {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${DATABASE_ID}/query`, {
    method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql, params }),
  });
  const j = await r.json();
  if (!j.success) throw new Error(JSON.stringify(j.errors || j).slice(0, 300));
  return j.result[0].results;
}

const COLS = 'item_id, sold_date, title, image_url, grader, grade, price_cents';
const NOT_ONE_CARD = /pack|lot|break|digital|collect/i;
async function labelled(day, split) {
  const pos = await d1(`SELECT ${COLS} FROM sales WHERE sold_date = ? AND image_url IS NOT NULL
                         AND grader IN (${BIG.map(() => '?').join(',')}) AND grade IS NOT NULL LIMIT 450`, [day, ...BIG]);
  const neg = await d1(`SELECT ${COLS} FROM sales WHERE sold_date = ? AND image_url IS NOT NULL
                         AND grader IS NULL AND grade IS NULL AND price_cents >= 300 LIMIT 900`, [day]);
  return [
    ...pos.filter(r => new RegExp(`(?<![a-z])${r.grader}`, 'i').test(r.title) && !NOT_ONE_CARD.test(r.title))
          .map(r => ({ ...r, split, label: 1 })),
    ...neg.filter(r => gradeBucket(r) === 'Raw' && !NOT_ONE_CARD.test(r.title))
          .map(r => ({ ...r, split, label: 0 })),
  ];
}

const sig = (z) => 1 / (1 + Math.exp(-z));
function fit(set, E, { epochs = 600, lr = 2, lam = 0.0005 } = {}) {
  const d = 512, w = new Float64Array(d);
  let b = 0;
  const np = set.filter(r => r.label).length, nn = set.length - np;
  const cw = (y) => set.length / (2 * (y ? np : nn));
  for (let ep = 0; ep < epochs; ep++) {
    const gw = new Float64Array(d);
    let gb = 0;
    for (const r of set) {
      const x = E.get(r.item_id);
      const e = (slabScore(x, { w, b }) - r.label) * cw(r.label);
      for (let j = 0; j < d; j++) gw[j] += e * x[j];
      gb += e;
    }
    for (let j = 0; j < d; j++) w[j] -= lr * (gw[j] / set.length + lam * w[j]);
    b -= lr * gb / set.length;
  }
  return { w: Array.from(w), b };
}

function report(name, set, E, head) {
  console.log(name);
  for (const t of [0.5, 0.6, 0.7, 0.8, 0.9]) {
    let tp = 0, fp = 0, fn = 0, tn = 0;
    for (const r of set) {
      const p = slabScore(E.get(r.item_id), head) >= t;
      if (p && r.label) tp++; else if (p) fp++; else if (r.label) fn++; else tn++;
    }
    console.log(`  t=${t}: slabs caught ${(100 * tp / (tp + fn)).toFixed(1)}%   raw flagged ${(100 * fp / (fp + tn)).toFixed(2)}% (${fp}/${fp + tn})`);
  }
}

async function main() {
  const items = [];
  for (const d of TRAIN) items.push(...await labelled(d, 'train'));
  for (const d of TEST) items.push(...await labelled(d, 'test'));
  console.log(`${items.length} labelled sales`);

  fs.mkdirSync(PHOTOS, { recursive: true });
  let next = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (next < items.length) {
      const it = items[next++];
      const f = path.join(PHOTOS, `${it.item_id}.img`);
      if (fs.existsSync(f)) continue;
      try {
        const r = await fetch(it.image_url.replace(/s-l\d+\.(webp|jpg|jpeg|png)/i, 's-l300.jpg'));
        if (r.ok) fs.writeFileSync(f, Buffer.from(await r.arrayBuffer()));
      } catch { /* a missing photo just leaves the sale out */ }
    }
  }));

  const { AutoProcessor, CLIPVisionModelWithProjection, RawImage, env } = await import('@huggingface/transformers');
  if (process.env.MODEL_CACHE) env.cacheDir = process.env.MODEL_CACHE;
  const proc = await AutoProcessor.from_pretrained(MODEL);
  const model = await CLIPVisionModelWithProjection.from_pretrained(MODEL, { dtype: 'fp32' });
  const E = new Map();
  for (const it of items) {
    try {
      const img = await RawImage.read(path.join(PHOTOS, `${it.item_id}.img`));
      const v = Array.from((await model(await proc(img))).image_embeds.data);
      const n = Math.hypot(...v) || 1;
      E.set(it.item_id, v.map(x => x / n));
    } catch { /* unreadable or missing */ }
  }
  const rows = items.filter(it => E.has(it.item_id));
  const train = rows.filter(r => r.split === 'train'), test = rows.filter(r => r.split === 'test');
  console.log(`embedded ${rows.length}: train ${train.length}, test ${test.length}`);

  const first = fit(train, E);
  report('first fit, on the unseen test days', test, E, first);
  const noisy = new Set(train.filter(r => !r.label && slabScore(E.get(r.item_id), first) >= 0.9).map(r => r.item_id));
  console.log(`dropping ${noisy.size} "raw" training photos the first fit is sure are slabs`);
  const head = fit(train.filter(r => !noisy.has(r.item_id)), E);
  report('refit', test, E, head);

  if (!process.argv.includes('--write')) { console.log('--write to save it'); return; }
  const out = {
    model: MODEL, trained: new Date().toISOString().slice(0, 10),
    trainedOn: `${TRAIN.join(', ')} (tested on ${TEST.join(', ')})`,
    b: +head.b.toFixed(6), w: head.w.map(x => +x.toFixed(6)),
  };
  fs.writeFileSync(path.join(ROOT, 'scripts', 'data', 'slab-head.json'), JSON.stringify(out) + '\n');
  console.log('wrote scripts/data/slab-head.json: bump PHOTO_SLAB_MODEL in photo-slab-core.js so the next runs rescore with it');
}

main().catch(err => { console.error(err.message || err); process.exit(1); });
