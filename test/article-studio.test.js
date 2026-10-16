// The article posting tool on /admin (owner, Oct 2026): write, add photos,
// preview, publish. It replaced the sales vetting desk on that page.
const fs = require('fs');
const path = require('path');

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

const NEWS_FILE = path.join(__dirname, '..', 'data', 'news.json');
const hadNews = fs.existsSync(NEWS_FILE);
const dbMod = require(path.join(__dirname, '..', 'db.js'));
dbMod.getNflDb = () => null;
process.env.ADMIN_PASSWORD = 'test-key-for-the-article-studio';
process.env.CF_WORKER = '1';
const N = require(path.join(__dirname, '..', 'news.js'));
const S = require(path.join(__dirname, '..', 'server.js'));
const server = S.app.listen(0);
const port = server.address().port;
const KEY = { 'x-admin-key': process.env.ADMIN_PASSWORD };
const call = async (p, opts = {}) => {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { ...opts,
    headers: { ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(opts.headers || {}) } });
  const type = r.headers.get('content-type') || '';
  return { status: r.status, type, cache: r.headers.get('cache-control'), body: type.includes('json') ? await r.json() : await r.text() };
};
// A 1x1 WebP.
const WEBP = 'data:image/webp;base64,UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==';

(async () => {
  try {
    const anon = await call('/api/admin/news/image', { method: 'POST', body: JSON.stringify({ dataUrl: WEBP }) });
    check('photo uploads need the admin key', anon.status === 401);
    const bad = await call('/api/admin/news/image', { method: 'POST', headers: KEY, body: JSON.stringify({ dataUrl: 'data:text/html;base64,PGI+' }) });
    check('  ...and only take images', bad.status === 400);
    const up = await call('/api/admin/news/image', { method: 'POST', headers: KEY, body: JSON.stringify({ dataUrl: WEBP }) });
    check('a photo uploads and gets a permanent address named by its content',
      up.status === 200 && /^\/news\/img\/[a-f0-9]{20}\.webp$/.test(up.body.url), JSON.stringify(up.body));
    const again = await call('/api/admin/news/image', { method: 'POST', headers: KEY, body: JSON.stringify({ dataUrl: WEBP }) });
    check('  ...the same photo twice is one file', again.body.url === up.body.url);
    const got = await call(up.body.url);
    check('  ...served as an image, cached for good', got.status === 200 && got.type === 'image/webp' && /immutable/.test(got.cache || ''));
    check('  ...and an address that is not one of ours is a 404', (await call('/news/img/..%2Fsecret.webp')).status === 404);

    const body = `Harrison's Silver ran hard in August.\n\n[![The PSA 9 Silver ran from $14 to $30](${up.body.url})](/?q=Marvin%20Harrison%20Prizm%20Silver)\n\nThen it cooled.\n\nMore words.\n\n![](${up.body.url})`;
    const draft = { title: 'Marvin Harrison Jr. Silver Prizm: the August run', standfirst: 'What the sales say.', category: 'Rookies', body, status: 'draft' };
    const pv = await call('/api/admin/news/preview', { method: 'POST', headers: KEY, body: JSON.stringify(draft) });
    check('the preview is the real page, marked, never indexed and with no ads',
      pv.status === 200 && /Preview: not published yet/.test(pv.body) && /noindex/.test(pv.body)
      && !/adsbygoogle\.js/.test(pv.body) && /<figure class="photo"><a href="\/\?q=Marvin%20Harrison%20Prizm%20Silver"><img src="\/news\/img\//.test(pv.body)
      && /<figcaption>The PSA 9 Silver ran from \$14 to \$30<\/figcaption>/.test(pv.body));

    const saved = await call('/api/admin/news', { method: 'POST', headers: KEY, body: JSON.stringify(draft) });
    check('a draft saves', saved.status === 200 && saved.body.article.status === 'draft');
    check('  ...and is not on the site yet', (await call('/news/' + saved.body.article.slug)).status === 404);
    const pub = await call('/api/admin/news', { method: 'POST', headers: KEY,
      body: JSON.stringify({ ...draft, status: 'published', originalSlug: saved.body.article.slug, publishedAt: new Date(Date.now() - 1000).toISOString() }) });
    const live = await call('/news/' + pub.body.article.slug);
    check('published, it is live with its photos and captions', live.status === 200 && (live.body.match(/<figure class="photo">/g) || []).length === 2);
    check('  ...its first photo is the share image and the structured-data image',
      live.body.includes(`<meta property="og:image" content="https://thecardhuddle.com${up.body.url}">`)
      && live.body.includes(`"image":["https://thecardhuddle.com${up.body.url}"]`));
    check('  ...with one real, labelled ad unit in the text, not a placeholder box',
      (live.body.match(/data-ad-slot="4442737418"/g) || []).length === 1 && /Advertisement/.test(live.body) && !/>Ad slot</.test(live.body));
    check('  ...and its summary leaves the photo markup out', !/!\[/.test(N.excerpt({ body })));

    check('a photo block takes our photos or https, never a script address',
      N.imageBlock('![x](javascript:alert(1))') === null && N.imageBlock('[![x](/news/img/abc.webp)](javascript:alert(1))') === null
      && N.imageBlock('![x](https://example.com/a.jpg)').src === 'https://example.com/a.jpg');

    const admin = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.html'), 'utf8');
    check('the admin page has the posting tool and no vetting desk',
      /id="art-editor"/.test(admin) && /Add photos/.test(admin) && /\/api\/admin\/news\/image/.test(admin) && /\/api\/admin\/news\/preview/.test(admin)
      && !/Sales Vetting/.test(admin) && !/loadVetting/.test(admin));
    check('  ...shrinking photos before they upload',
      /toDataURL\('image\/webp', 0\.82\)/.test(admin) && /1600 \/ Math\.max/.test(admin));
    const idx = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    const appjs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
    check('published articles have their own tab in the app, beside Market',
      /data-view="market"[\s\S]{0,800}data-view="news" onclick="switchView\('news'\)"/.test(idx) && /id="news-view"/.test(idx)
      && /view === 'news'/.test(appjs) && /fetch\('\/api\/news'/.test(appjs) && /'\/news\/' \+ encodeURIComponent\(a\.slug\)/.test(appjs));
    const worker = fs.readFileSync(path.join(__dirname, '..', 'worker.js'), 'utf8');
    check('on Workers the photos come straight from R2', /env\.PHOTOS\.get\('news\/' \+ name\)/.test(worker));
  } finally {
    server.close();
    if (!hadNews) { try { fs.unlinkSync(NEWS_FILE); } catch (_) { /* never written */ } }
  }
  console.log(failures ? `\n${failures} check(s) failed` : '\nall article-studio checks passed');
  process.exit(failures ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
