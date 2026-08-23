// Does the PNG decoder actually decode?
//
// Workers have no image decoder, and shipping one is the move that took the
// site down this morning. Instead Cloudflare shrinks the image to a tiny PNG,
// which needs only inflate — built in as DecompressionStream — plus scanline
// unfiltering. That unfiltering is the part worth testing: every row is
// predicted from the pixel to its left and the row above, so an off-by-one in
// any of the five filter types produces an image that still LOOKS like an
// image while every colour in it is wrong. A colour fingerprint built on that
// would be confidently, invisibly false.
//
// So this builds PNGs with known pixels, encodes each with a specific filter,
// and demands the exact bytes back.
const zlib = require('node:zlib');
const { decodePng } = require('../photo-fetch.js');

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

// Encode with one chosen filter for every row, so each filter path is exercised
// rather than whichever one an encoder happened to pick.
function makePng(pixels, width, height, channels, filter) {
  const stride = width * channels;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = filter;
    for (let x = 0; x < stride; x++) {
      const v = pixels[y * stride + x];
      const a = x >= channels ? pixels[y * stride + x - channels] : 0;
      const b = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const c = (x >= channels && y > 0) ? pixels[(y - 1) * stride + x - channels] : 0;
      let f;
      switch (filter) {
        case 0: f = v; break;
        case 1: f = v - a; break;
        case 2: f = v - b; break;
        case 3: f = v - ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          f = v - (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
      }
      raw[y * (stride + 1) + 1 + x] = f & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = { 1: 0, 3: 2, 4: 6 }[channels];
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function gradient(width, height, channels) {
  const px = new Uint8Array(width * height * channels);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      px[i] = (x * 17 + y * 3) & 0xff;
      if (channels >= 3) {
        px[i + 1] = (y * 23 + x * 5) & 0xff;
        px[i + 2] = (x * y * 7) & 0xff;
      }
      if (channels === 4) px[i + 3] = 255;
    }
  }
  return px;
}

(async () => {
  // Every filter type, exact bytes. A gradient is used because a flat colour
  // would decode correctly even with the predictors wired up wrongly.
  {
    const W = 16, H = 16, C = 3;
    const want = gradient(W, H, C);
    const bad = [];
    for (const filter of [0, 1, 2, 3, 4]) {
      const png = makePng(want, W, H, C, filter);
      const got = await decodePng(new Uint8Array(png));
      let diffs = 0;
      for (let i = 0; i < want.length; i++) if (got.px[i] !== want[i]) diffs++;
      if (got.width !== W || got.height !== H || diffs) bad.push(`filter ${filter}: ${diffs} wrong bytes`);
    }
    check('all five PNG scanline filters decode to the exact original pixels',
          bad.length === 0, bad.length ? bad.join('; ') : '5/5 exact over a 16x16 gradient');
  }

  // RGBA, since the resizer emits it whenever the source has transparency.
  {
    const want = gradient(8, 8, 4);
    const got = await decodePng(new Uint8Array(makePng(want, 8, 8, 4, 4)));
    const same = got.channels === 4 && want.every((v, i) => got.px[i] === v);
    check('  ...and RGBA survives the round trip', same, `channels=${got.channels}`);
  }

  // Greyscale is widened to RGB so callers never branch on channel count.
  {
    const want = gradient(8, 8, 1);
    const got = await decodePng(new Uint8Array(makePng(want, 8, 8, 1, 1)));
    let ok = got.channels === 3;
    for (let i = 0; ok && i < want.length; i++) {
      ok = got.px[i * 3] === want[i] && got.px[i * 3 + 1] === want[i] && got.px[i * 3 + 2] === want[i];
    }
    check('  ...and greyscale is widened to RGB', ok, `channels=${got.channels}`);
  }

  // A signature computed from a decode is only as good as the decode. This is
  // the property the whole approach leans on: same picture in, same numbers out.
  {
    const { signatureFromPixels, distance } = require('../photo-signature.js');
    const px = gradient(16, 16, 3);
    const a = await decodePng(new Uint8Array(makePng(px, 16, 16, 3, 0)));
    const b = await decodePng(new Uint8Array(makePng(px, 16, 16, 3, 4)));
    const d = distance(signatureFromPixels(a.px, 3), signatureFromPixels(b.px, 3));
    check('the same image encoded two ways gives the same fingerprint',
          d === 0, `distance ${d}`);
  }

  // Garbage must be refused rather than half-decoded into plausible nonsense.
  {
    const cases = [
      ['not a PNG at all', new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9])],
      ['truncated after the header', new Uint8Array(makePng(gradient(4, 4, 3), 4, 4, 3, 0)).subarray(0, 20)],
    ];
    const accepted = [];
    for (const [name, bytes] of cases) {
      try { await decodePng(bytes); accepted.push(name); } catch { /* expected */ }
    }
    check('malformed input is rejected, not guessed at',
          accepted.length === 0,
          accepted.length ? `ACCEPTED: ${accepted.join(', ')}` : 'both refused');
  }

  console.log(failures ? `\n${failures} check(s) failed` : '\nall photo-fetch checks passed');
  process.exit(failures ? 1 : 0);
})();
