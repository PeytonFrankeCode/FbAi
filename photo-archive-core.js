// Copying eBay listing photos into R2, as pure logic.
//
// eBay purges images for long-ended listings, so an image_url on an old sale
// eventually points at nothing. The dataset holds about 42 days of sales and
// eBay keeps images roughly 90, which puts the first losses around seven weeks
// out. This is what gets ahead of that.
//
// Everything here is deliberately free of bindings — no D1, no R2, no fetch —
// so the decisions can be tested without a Worker. The caller supplies the
// rows, does the fetching, and performs the writes. What lives here is the
// part that is easy to get quietly wrong: which size to ask eBay for, what to
// call the object, and how far the cursor may advance.
'use strict';

// eBay serves the same photo at several sizes from one URL shape, the size
// encoded as `s-l<N>`. The fingerprint job asks for s-l64 because it only
// needs colour; that is far too small to show anyone.
//
// 225 is chosen against the layout rather than by taste: .mp-tile-img caps at
// max-height 160px, so 225 covers it with room for a 1.5x display, and the
// card modal is the only larger use. Going to s-l500 triples the bytes for
// detail these layouts never render.
const PHOTO_SIZE = 225;

function sizedUrl(url, size = PHOTO_SIZE) {
  const u = String(url || '');
  if (!u) return '';
  // Replace whatever size the stored URL happens to carry. Some rows hold
  // s-l1600, some s-l64, depending on what the importer captured.
  return u.replace(/\/s-l\d+\.(jpg|jpeg|png|webp)/i, `/s-l${size}.$1`);
}

// The object key has to be derivable from the URL alone, because serving needs
// to find the copy without a database lookup — a lookup would put a D1 read on
// every image request, which is the cost this whole exercise is avoiding.
//
// So: a hash of the URL, computed the same way on both sides. Async because
// crypto.subtle is the only hash available in a Worker.
async function keyForUrl(url, subtle) {
  const data = new TextEncoder().encode(String(url || ''));
  const digest = await subtle.digest('SHA-256', data);
  const hex = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
  // Sharded two levels deep. R2 does not need it for lookups, but a flat
  // million-key bucket is miserable to browse or audit by hand.
  return `p/${hex.slice(0, 2)}/${hex.slice(2, 4)}/${hex.slice(0, 32)}`;
}

// Which failures are worth remembering as final.
//
// Same rule as fingerprint-photos.js, and for the same reason: recording a
// TRANSIENT failure as permanent throws a recoverable photo away for good. A
// 404 means eBay has already purged it and no retry will help; a timeout means
// try again later.
function isPermanent(status) {
  const n = Number(status);
  return (n >= 400 && n < 420) || n === 451;
}

// How far the cursor may move.
//
// The cursor is (sold_date, item_id) and advances only over rows the caller
// actually finished with — a row still worth retrying holds it back, because
// advancing past a transient failure loses that photo silently and forever.
//
// A row that failed permanently does NOT hold it back: eBay has purged the
// image, and waiting for it is waiting for something that will never arrive.
function nextCursor(prev, results) {
  let cur = prev;
  for (const r of results) {
    if (!r) break;
    if (!r.ok && !r.permanent) break;   // retry this one next tick
    cur = { soldDate: r.soldDate, itemId: r.itemId };
  }
  return cur;
}

// A batch is worth stopping early if the source is exhausted — that is what
// tells the caller it has caught up and can stop asking for more.
function summarise(results) {
  const out = { total: results.length, stored: 0, skipped: 0, permanent: 0, retry: 0, bytes: 0 };
  for (const r of results) {
    if (!r) continue;
    if (r.ok) { out.stored++; out.bytes += r.bytes || 0; }
    else if (r.alreadyStored) { out.skipped++; }
    else if (r.permanent) { out.permanent++; }
    else { out.retry++; }
  }
  return out;
}

module.exports = { PHOTO_SIZE, sizedUrl, keyForUrl, isPermanent, nextCursor, summarise };
