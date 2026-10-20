// How each article does, on the admin page (owner, Oct 2026): the article
// page sends read beacons, each adds to one D1 row per article per day, and
// the admin table sums them. Run through the real routes over an in-memory
// SQLite table.
'use strict';
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

let failures = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`); if (!ok) failures++; };

const NEWS_FILE = path.join(__dirname, '..', 'data', 'news.json');
const before = fs.existsSync(NEWS_FILE) ? fs.readFileSync(NEWS_FILE) : null;
const db = new DatabaseSync(':memory:');
const d1 = {
  prepare(sql) {
    let b = [];
    const api = {
      bind(...a) { b = a; return api; },
      all() { return { results: db.prepare(sql).all(...b) }; },
      first() { return db.prepare(sql).get(...b) || null; },
      run() { return { success: true, meta: db.prepare(sql).run(...b) }; },
    };
    return api;
  },
  batch(s) { return s.map(x => x.run()); },
};
const dbMod = require(path.join(__dirname, '..', 'db.js'));
dbMod.getNflDb = () => d1;
process.env.ADMIN_PASSWORD = 'test-key-for-article-stats';
process.env.CF_WORKER = '1';
process.env.DISABLE_RATE_LIMIT = '1';
const S = require(path.join(__dirname, '..', 'server.js'));
const server = S.app.listen(0);
const port = server.address().port;
const KEY = { 'x-admin-key': process.env.ADMIN_PASSWORD };
const BROWSER = { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1' };
const call = async (p, opts = {}) => {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { ...opts,
    headers: { ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(opts.headers || {}) } });
  const type = r.headers.get('content-type') || '';
  return { status: r.status, body: type.includes('json') ? await r.json() : await r.text() };
};
const beacon = (b, ua = BROWSER) => call('/api/news/beacon', { method: 'POST', headers: ua, body: JSON.stringify(b) });

(async () => {
  try {
    const pub = await call('/api/admin/news', { method: 'POST', headers: KEY, body: JSON.stringify({
      title: 'Bo Nix Prizm: what the sales say', standfirst: 'A look.', category: 'Rookies', body: 'One.\n\nTwo.\n\nThree.\n\nFour.',
      status: 'published', publishedAt: new Date(Date.now() - 1000).toISOString() }) });
    const slug = pub.body.article.slug;
    const page = await call('/news/' + slug);
    check('a live article carries the read tracker for its own slug',
      page.status === 200 && page.body.includes('/api/news/beacon') && page.body.includes(JSON.stringify(slug)));
    const pv = await call('/api/admin/news/preview', { method: 'POST', headers: KEY, body: JSON.stringify(pub.body.article) });
    check('  ...the editor\'s preview does not, so your own checks are not counted', pv.status === 200 && !pv.body.includes('/api/news/beacon'));

    await beacon({ s: slug, e: 'v', r: 'search' });
    await beacon({ s: slug, e: 'v', r: 'search' });
    await beacon({ s: slug, e: 'v', r: 'social' });
    await beacon({ s: slug, e: 'v', r: 'nonsense' });
    await beacon({ s: slug, e: 't', t: 90 });
    await beacon({ s: slug, e: 't', t: 30 });
    await beacon({ s: slug, e: 't', t: 999999 });
    await beacon({ s: slug, e: 'e' });
    await beacon({ s: slug, e: 'a' });
    await beacon({ s: slug, e: 's' });
    await beacon({ s: slug, e: 'v', r: 'search' }, { 'user-agent': 'Googlebot/2.1 (+http://www.google.com/bot.html)' });
    await beacon({ s: 'not-an-article', e: 'v', r: 'search' });
    await beacon({ s: 'market-movers-2026-w42', e: 'v', r: 'direct' });

    const anon = await call('/api/admin/news/stats');
    check('the numbers need the admin key', anon.status === 401);
    const st = await call('/api/admin/news/stats?days=30', { headers: KEY });
    const a = st.body.articles.find(x => x.slug === slug);
    check('views, time, read to the end, sources and clicks add up per article',
      a && a.views === 4 && a.seconds === 90 + 30 + 1800 && a.read_end === 1 && a.ad_clicks === 1 && a.site_clicks === 1
      && a.from_search === 2 && a.from_social === 1 && a.from_other === 1 && a.searchPct === 50 && a.title === 'Bo Nix Prizm: what the sales say'
      && a.url === '/news/' + slug, JSON.stringify(a));
    check('  ...a bot is not counted, and nor is a page that does not exist',
      !st.body.articles.some(x => x.slug === 'not-an-article') && a.from_search === 2);
    const mm = st.body.articles.find(x => x.slug === 'market-movers-2026-w42');
    check('  ...the weekly Market Movers report is counted too, linked to its week',
      mm && mm.views === 1 && mm.url === '/news/market-movers/2026-W42' && /Market Movers, week 42/.test(mm.title), JSON.stringify(mm));
    check('  ...with views by day for the chart', st.body.daily.length === 1 && st.body.daily[0].views === 5, JSON.stringify(st.body.daily));

    const admin = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.html'), 'utf8');
    check('the admin page shows the table, loaded on sign-in',
      /id="ap-rows"/.test(admin) && /\/api\/admin\/news\/stats/.test(admin) && /loadArticleStats\(\);/.test(admin));
    check('beacons have their own rate limit', S.RL_TIERS.some(t => t.name === 'beacon' && t.match('/api/news/beacon')));
  } catch (e) {
    console.error(e); failures++;
  } finally {
    server.close();
    if (before) fs.writeFileSync(NEWS_FILE, before); else { try { fs.unlinkSync(NEWS_FILE); } catch (_) { /* never written */ } }
    console.log(failures ? `\n${failures} check(s) failed` : '\nall article-stats checks passed');
    process.exit(failures ? 1 : 0);
  }
})();
