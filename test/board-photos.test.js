// The home page boards' sales that came with no photo (the Card API sends
// none for Fanatics Collect or Yahoo sales; owner, Nov 2026: "every top 50
// card really didn't have a photo") are filled by the card-photo finder.
'use strict';
process.env.NODE_ENV = 'test';
process.env.CF_WORKER = '1';
const path = require('path');
const fs = require('fs');
let failures = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`); if (!ok) failures++; };
const ROOT = path.join(__dirname, '..');
const S = require(path.join(ROOT, 'server.js'));
const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');

check('the boards carry each sale\'s id (Most expensive, Most sold, movers)', (src.match(/itemId: r\.item_id \|\| null,/g) || []).length >= 3);
(async () => {
  const server = S.app.listen(0), base = `http://127.0.0.1:${server.address().port}`;
  try {
    const get = async (id) => (await fetch(`${base}/api/card-photo?itemId=${encodeURIComponent(id)}`, { headers: { 'user-agent': 'Mozilla/5.0' } })).status;
    check('the photo finder takes an eBay item id', await get('123456789012') === 200);
    check('...and a Fanatics Collect sale id', await get('fanatics-FC-SALE-v1|BOV2_e90d37dd-0f48-4ac9-a89d-57cee2f62e37') === 200);
    check('...but not anything else', await get('<script>') === 400 && await get('') === 400);
  } finally { server.close(); }
  const SALE_ID = new Function(app.match(/const _SALE_ID_RE = (\/.*\/);/)[0] + ' return _SALE_ID_RE;')();
  check('the page recognises Fanatics sale ids too', SALE_ID.test('fanatics-FC-SALE-v1|BOV2_e90d37dd') && SALE_ID.test('123456789012') && !SALE_ID.test('<b>'));
  check('a board tile with no photo asks the finder (waiting image tagged with the sale)', /_needPhotoImg\('mp-tile-img'/.test(app) && /thumb\(r\.imageUrl, r\.title, r\)/.test(app) && /_needPhotoImg\('st-img'/.test(app));
  check('tagged images are filled as they appear on the page', /new MutationObserver/.test(app) && /function _fillNeedPhotos/.test(app) && /_photoGone\(img\);\n  \}\);/.test(app));
  console.log(failures ? `\n${failures} board-photo check(s) failed` : '\nall board-photo checks passed');
  process.exit(failures ? 1 : 0);
})();
