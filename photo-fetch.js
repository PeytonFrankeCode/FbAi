// Get pixels out of a card photo, inside a Worker, with no image library.
//
// This is the part with the real constraint. Workers have no canvas, no
// createImageBitmap, and no JPEG decoder — and adding one is exactly the move
// that took the site down this morning, because a Worker compiles its whole
// script before serving anything.
//
// The way around it is to make Cloudflare do the hard part. Asking the image
// service for a tiny PNG turns an arbitrary JPEG into a format that needs only
// inflate plus a few lines of unfiltering — and inflate is built in, as
// DecompressionStream, in both Workers and Node 22. So no decoder ships.
//
// The image comes back at 16x16, which sounds absurdly small until you remember
// what is being asked of it: not "which card is this" but "what colour is it".
// A thumbnail that size still says gold, and it keeps the cost low enough to
// process a few hundred per background tick.

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Inflate a zlib stream using the platform's built-in decompressor. */
async function inflate(bytes) {
  const ds = new DecompressionStream('deflate');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  const chunks = [];
  let total = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

/**
 * Decode a non-interlaced 8-bit PNG to RGB(A) pixels.
 *
 * Deliberately partial. Cloudflare's resizer emits exactly this shape, and
 * accepting more formats would mean carrying decode paths nothing produces —
 * bytes that would still be compiled on every cold start. Anything unexpected
 * throws and the caller skips that image.
 */
async function decodePng(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < 8; i++) {
    if (b[i] !== PNG_MAGIC[i]) throw new Error('not a PNG');
  }
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let pos = 8;
  let width = 0, height = 0, colourType = -1, bitDepth = 0;
  const idat = [];

  while (pos + 8 <= b.length) {
    const len = dv.getUint32(pos);
    const type = String.fromCharCode(b[pos + 4], b[pos + 5], b[pos + 6], b[pos + 7]);
    const data = pos + 8;
    if (type === 'IHDR') {
      width = dv.getUint32(data);
      height = dv.getUint32(data + 4);
      bitDepth = b[data + 8];
      colourType = b[data + 9];
      if (b[data + 12] !== 0) throw new Error('interlaced PNG');
    } else if (type === 'IDAT') {
      idat.push(b.subarray(data, data + len));
    } else if (type === 'IEND') {
      break;
    }
    pos = data + len + 4;               // skip payload + CRC
  }

  if (bitDepth !== 8) throw new Error(`bit depth ${bitDepth} unsupported`);
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colourType];
  if (!channels) throw new Error(`colour type ${colourType} unsupported`);
  if (!width || !height || !idat.length) throw new Error('malformed PNG');

  let z = idat[0];
  if (idat.length > 1) {
    let n = 0;
    for (const c of idat) n += c.length;
    z = new Uint8Array(n);
    let o = 0;
    for (const c of idat) { z.set(c, o); o += c.length; }
  }
  const raw = await inflate(z);

  // Undo the per-scanline filters. Each row is prefixed with a filter byte and
  // is predicted from the pixel to its left and the row above, so this has to
  // run in order — it is the one genuinely sequential part.
  const stride = width * channels;
  const out = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    const up = dst - stride;
    for (let x = 0; x < stride; x++) {
      const rv = raw[src + x];
      const a = x >= channels ? out[dst + x - channels] : 0;    // left
      const bb = y > 0 ? out[up + x] : 0;                       // above
      const c = (x >= channels && y > 0) ? out[up + x - channels] : 0;
      let v;
      switch (filter) {
        case 0: v = rv; break;
        case 1: v = rv + a; break;
        case 2: v = rv + bb; break;
        case 3: v = rv + ((a + bb) >> 1); break;
        case 4: {
          const p = a + bb - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - bb), pc = Math.abs(p - c);
          v = rv + (pa <= pb && pa <= pc ? a : pb <= pc ? bb : c);
          break;
        }
        default: throw new Error(`filter ${filter} unsupported`);
      }
      out[dst + x] = v & 0xff;
    }
  }

  // Greyscale is widened to RGB so callers only ever see 3 or 4 channels.
  if (channels === 1 || channels === 2) {
    const wide = new Uint8Array(width * height * (channels === 2 ? 4 : 3));
    const outCh = channels === 2 ? 4 : 3;
    for (let i = 0, j = 0; i < out.length; i += channels, j += outCh) {
      wide[j] = wide[j + 1] = wide[j + 2] = out[i];
      if (outCh === 4) wide[j + 3] = out[i + 1];
    }
    return { px: wide, width, height, channels: outCh };
  }
  return { px: out, width, height, channels };
}

/**
 * Fetch one image and return its pixels, shrunk by Cloudflare on the way.
 *
 * Returns null rather than throwing on anything expected — a dead link, a
 * seller who deleted the photo, an image service that is not enabled on this
 * zone. The caller is a batch job walking hundreds of rows and one bad URL must
 * not end the tick.
 */
async function fetchTinyPixels(url, opts = {}) {
  const size = opts.size || 16;
  const timeoutMs = opts.timeoutMs || 5000;
  if (!url || !/^https?:\/\//i.test(url)) return { ok: false, why: 'bad-url' };

  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
  try {
    const resp = await fetch(url, {
      signal: ctl ? ctl.signal : undefined,
      cf: { image: { width: size, height: size, fit: 'cover', format: 'png' } },
    });
    if (!resp || !resp.ok) return { ok: false, why: `http-${resp && resp.status}` };
    const type = resp.headers.get('content-type') || '';
    // The resizer is a zone feature. Where it is not enabled the original JPEG
    // comes back untouched, which cannot be decoded here — and saying so
    // plainly beats failing later with "not a PNG" on every single row.
    if (!/png/i.test(type)) return { ok: false, why: `not-resized (${type || 'unknown'})` };
    const buf = new Uint8Array(await resp.arrayBuffer());
    const img = await decodePng(buf);
    return { ok: true, ...img, bytes: buf.length };
  } catch (err) {
    return { ok: false, why: (err && err.name === 'AbortError') ? 'timeout' : `error: ${err && err.message}` };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

module.exports = { decodePng, fetchTinyPixels, inflate };
