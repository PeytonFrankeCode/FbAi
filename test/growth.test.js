// Growth tracking (owner, Nov 2026): ?ref= links, a visit count per source,
// a new account claiming the link it came from, the source carried into
// checkout and counted on trials and paid plans, and the owner's panel.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

process.env.CF_WORKER = '1';
const S = require(path.join(ROOT, 'server.js'));
const PORT = 3291;
const server = S.app.listen(PORT);
const base = `http://127.0.0.1:${PORT}`;
let ip = 10;
const NEWU = 'growth' + Date.now().toString(36);
const call = (p, { method = 'GET', token, body } = {}) => fetch(base + p, {
  method, body: body ? JSON.stringify(body) : undefined,
  headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0', 'cf-connecting-ip': `198.51.100.${ip++}`, ...(token ? { authorization: `Bearer ${token}` } : {}) },
});

(async () => {
  try {
    check('source names are cleaned to a short slug', S._growthSrc(' Card Collector 22! ') === 'card-collector-22' && S._growthSrc('x'.repeat(60)).length === 40 && S._growthSrc('!!!') === '');

    const v = await call('/api/growth/visit', { method: 'POST', body: { src: 'cardguy' } });
    check('a visit is accepted (204) even without D1', v.status === 204, `status ${v.status}`);

    const reg = await (await call('/api/auth/register', { method: 'POST', body: { username: NEWU, password: 'secret123' } })).json();
    const c1 = await (await call('/api/growth/claim', { method: 'POST', token: reg.token, body: { src: 'CardGuy' } })).json();
    check('a new account claims the link it came from', c1.ok === true && S._growthRefOf(NEWU) === 'cardguy', JSON.stringify(c1));
    const c2 = await (await call('/api/growth/claim', { method: 'POST', token: reg.token, body: { src: 'other' } })).json();
    check('only once: a second claim changes nothing', c2.ok === false && S._growthRefOf(NEWU) === 'cardguy');
    const anon = await (await call('/api/growth/claim', { method: 'POST', body: { src: 'cardguy' } })).json();
    check('a claim with no account counts nothing', anon.ok === false);

    const unauth = await call('/api/admin/growth');
    check('the growth table is owner-only', unauth.status === 401, `status ${unauth.status}`);
  } finally {
    server.close();
  }

  // An old account signing in from a link claims nothing.
  const src = read('server.js');
  check('only an account made in the last ten minutes can claim', /GROWTH_CLAIM_MS = 10 \* 60 \* 1000/.test(src) && /Date\.now\(\) - Date\.parse\(u\.createdAt \|\| 0\) < GROWTH_CLAIM_MS/.test(src));
  check('checkout carries the source to Stripe', /\.\.\.\(_growthRefOf\(username\) \? \{ ref: _growthRefOf\(username\) \} : \{\}\)/.test(src));
  check('a trial or a sale is counted for the source', /_growthBump\(session\.metadata\.ref, session\.metadata\?\.trial \? 'trials' : 'paid'\)/.test(src));
  check('a trial that turns paid is counted', /was === 'trialing' && data\.status === 'active' && data\.ref\) await _growthBump\(data\.ref, 'converted'\)/.test(src));

  const g = read('public/growth.js');
  check('growth.js reads ?ref= and utm_source', /p\.get\('ref'\) \|\| p\.get\('utm_source'\)/.test(g));
  check('growth.js keeps the first named source for 30 days', /DAYS = 30/.test(g) && /if \(src && !stored\(\)\)/.test(g));
  check('growth.js counts a visit only after a real tap, touch, key or wheel, not on page load (Nov 2026 bots)',
    /var ON = \['pointerdown', 'touchstart', 'keydown', 'wheel'\]/.test(g) && /e\.isTrusted === false/.test(g)
    && !/mousemove/.test(g) && /window\.addEventListener\(t, send/.test(g));
  check('growth.js counts once per tab session and skips moves within the site', /sessionStorage\.getItem\('chRefSeen'\)/.test(g) && /h === location\.hostname\) return/.test(g));
  const app = read('public/app.js');
  check('a sign-in claims the source', /if \(token\) _growthClaim\(token\);/.test(app) && /'\/api\/growth\/claim'/.test(app));
  check('?plans=1 opens the plan picker and ?ai=1 opens Huddle AI', /params\.get\('plans'\) === '1'\) setTimeout\(openAdFree/.test(app) && /params\.get\('ai'\) === '1'\) setTimeout\(openHuddleAI/.test(app));
  check('the app, landing pages and /ai load growth.js',
    read('public/index.html').includes('<script src="/growth.js" defer></script>')
    && read('scripts/build-landing-pages.js').includes('<script src="/growth.js" defer></script>')
    && read('public/ai.html').includes('<script src="/growth.js" defer></script>'));

  const ai = read('public/ai.html');
  check('/ai shows tokens, never dollar credits', /2\.5 million\+/.test(ai) && /6\.5 million\+/.test(ai) && /12\.5 million\+/.test(ai) && !/\$3 of|\$7 of|\$13 of|credits/i.test(ai));
  check('/ai sends people to the plan picker', (ai.match(/href="\/\?plans=1"/g) || []).length >= 4);
  check('/ai is in the sitemap', /\$\{SITE\}\/ai<\/loc>/.test(read('scripts/build-landing-pages.js')));
  const admin = read('public/admin.html');
  check('the admin page has the growth panel and link maker', /function loadGrowth\(\)/.test(admin) && /function growthLink\(\)/.test(admin) && /loadGrowth\(\);/.test(admin));

  console.log(failures ? `\n${failures} growth check(s) failed` : '\nall growth checks passed');
  process.exit(failures ? 1 : 0);
})();
