// Growth steps 3 and 4 (owner, Nov 2026): a one-tap price alert next to the
// price, the Monday email offered on every landing page, shared price links
// that show their picture when pasted, and the owner's weekly social images.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const ROOT = path.join(__dirname, '..');
let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

// A tiny real PNG (1x1), padded past the size floor with a text chunk.
function png() {
  const crc = (buf) => { let c = ~0; for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (type, data) => { const t = Buffer.from(type); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const c = Buffer.alloc(4); c.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr),
    chunk('tEXt', Buffer.from('Comment\0' + 'x'.repeat(300 + Math.floor(Math.random() * 1000)))),
    chunk('IDAT', zlib.deflateSync(Buffer.from([0, 255, 0, 0]))), chunk('IEND', Buffer.alloc(0))]);
}

process.env.CF_WORKER = '1';
const S = require(path.join(ROOT, 'server.js'));
const PORT = 3299;
const server = S.app.listen(PORT);
const base = `http://127.0.0.1:${PORT}`;
let ip = 30;
const call = (p, { method = 'GET', body } = {}) => fetch(base + p, {
  method, body: body ? JSON.stringify(body) : undefined, redirect: 'manual',
  headers: { 'content-type': 'application/json', 'cf-connecting-ip': `198.51.100.${ip++}` },
});

(async () => {
  try {
    const img = png();
    const r = await call('/api/share', { method: 'POST', body: { q: '2024 Prizm Bo Nix Silver', avg: 38.5, n: 41, sold: true, dataUrl: 'data:image/png;base64,' + img.toString('base64') } });
    const d = await r.json();
    check('a shared price image is stored and gets a /s/ link', r.ok && /^[a-f0-9]{16}$/.test(d.id) && /\/s\/[a-f0-9]{16}$/.test(d.url), JSON.stringify(d));
    const page = await (await call('/s/' + d.id)).text();
    check('the link page shows the picture as its preview', page.includes(`<meta property="og:image" content="https://thecardhuddle.com/s/${d.id}.png">`) && /summary_large_image/.test(page));
    check('...titled with the card and its price', /<meta property="og:title" content="2024 Prizm Bo Nix Silver: \$38\.50 average sold price">/.test(page));
    check('...and sends people to that card\'s prices, counted as a share', page.includes('/?q=2024%20Prizm%20Bo%20Nix%20Silver&amp;ref=share') && /noindex/.test(page));
    const pic = await call('/s/' + d.id + '.png');
    const bytes = Buffer.from(await pic.arrayBuffer());
    check('the picture is served as a PNG', pic.ok && pic.headers.get('content-type') === 'image/png' && bytes.equals(img));
    const notPng = await call('/api/share', { method: 'POST', body: { q: 'x', dataUrl: 'data:image/png;base64,' + Buffer.from('<svg>' + 'a'.repeat(400) + '</svg>').toString('base64') } });
    check('anything that is not a PNG is refused', notPng.status === 400);
    const noQ = await call('/api/share', { method: 'POST', body: { dataUrl: 'data:image/png;base64,' + img.toString('base64') } });
    check('a share with no card is refused', noQ.status === 400);
    const unknown = await call('/s/0123456789abcdef');
    check('an unknown link goes home, still counted as a share', unknown.status === 302 && unknown.headers.get('location') === '/?ref=share');
    check('the social images are owner-only', (await call('/api/admin/social')).status === 401);
  } finally {
    server.close();
  }

  const app = read('public/app.js');
  const fn = app.slice(app.indexOf('function _alertDealPrice('), app.indexOf('async function _quickPriceAlert('));
  const deal = new Function(fn + '; return _alertDealPrice;')();
  check('the alert price is 10% under the typical sale, rounded', deal(38) === 34 && deal(140) === 125 && deal(480) === 430 && deal(2500) === 2250 && deal(0.5) === 0,
    [deal(38), deal(140), deal(480), deal(2500)].join(','));
  check('a sold search gets the one-tap alert next to Share', /if \(isSold && prices\.length >= 3\)/.test(app) && /createCardAlert\(query, 'below', under\)/.test(app));
  check('sharing uploads the picture and shares the /s/ link', /_sharePriceLink\(blob, query, stats\)/.test(app) && /fetch\('\/api\/share'/.test(app) && /&ref=share/.test(app));

  const lp = read('scripts/build-landing-pages.js');
  check('every landing page offers the Monday email, shown only when email works', /return `\$\{DIGEST_BOX\}/.test(lp) && /fetch\('\/api\/digest\/status'\)/.test(lp) && /source:'landing'/.test(lp));
  const w = read('worker.js');
  check('the Worker sends /s/<id> to the server and serves its picture from R2', /s\\\/\[a-f0-9\]\{16\}\$\)\/;/.test(w) && /env\.PHOTOS\.get\('share\/' \+ name\)/.test(w));
  const admin = read('public/admin.html');
  check('the admin page draws the weekly social images with tracked captions', /function socDraw\(/.test(admin) && /loadSocial\(\);/.test(admin) && /\?ref=social-\$\{key\.toLowerCase\(\)\}/.test(admin));

  console.log(failures ? `\n${failures} share/prompt check(s) failed` : '\nall share/prompt checks passed');
  process.exit(failures ? 1 : 0);
})();
