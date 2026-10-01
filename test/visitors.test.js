// Visitors are counted at the front of the Worker, for every request.
//
// The old tally sat behind the ASSETS binding (so no page view ever reached
// it) and was flushed from the cron's isolate (so it always wrote ~0): the
// report read "1 request today" while bots crawled the site. This checks the
// counting itself and that the Worker counts before it routes anything.
const fs = require('fs');
const path = require('path');
const T = require(path.join(__dirname, '..', 'traffic-core.js'));

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

check('a phone on a home ISP is a person', T.classify({ ua: 'Mozilla/5.0 (iPhone)', asn: 7922 }) === 'human');
check('a browser-looking visitor from AWS is a datacentre visitor', T.classify({ ua: 'Mozilla/5.0 (Windows NT 10.0)', asn: 16509 }) === 'datacenter');
check('python-requests says it is a bot', T.classify({ ua: 'python-requests/2.31', asn: 14061 }) === 'declaredBot');
check('Googlebot verified by Cloudflare is not a datacentre bot, though it comes from Google\'s network',
  T.classify({ ua: 'Mozilla/5.0 (compatible; Googlebot/2.1)', asn: 15169, verifiedBot: true }) === 'verifiedBot');
check('SEO-tool crawlers are blocked, even when Cloudflare verifies them',
  T.classify({ ua: 'Mozilla/5.0 (compatible; DotBot/1.2; +https://opensiteexplorer.org/dotbot)', asn: 23033, verifiedBot: true }) === 'blockedBot'
  && T.classify({ ua: 'Mozilla/5.0 (compatible; AhrefsBot/7.0)', asn: 16276 }) === 'blockedBot');
check('  ...but not search engines or AI assistants', T.classify({ ua: 'Mozilla/5.0 (compatible; bingbot/2.0)', asn: 8075, verifiedBot: true }) === 'verifiedBot'
  && T.classify({ ua: 'Mozilla/5.0 (compatible; ChatGPT-User/1.0)', asn: 8075, verifiedBot: true }) === 'verifiedBot');
const robots = fs.readFileSync(path.join(__dirname, '..', 'public', 'robots.txt'), 'utf8');
check('  ...and robots.txt disallows each of them by name', T.BLOCKED_BOTS.filter(b => b !== 'Linguee')
  .every(b => new RegExp(`User-agent: ${b}\\nDisallow: /`).test(robots)) && /User-agent: \*\nAllow: \//.test(robots));
check('no user agent at all is its own kind', T.classify({ ua: '', asn: 7922 }) === 'noUa');

const day = '2026-09-27';
const a = T.newTally(day), b = T.newTally(day);
T.noteRequest(a, { day, path: '/', ua: 'Mozilla/5.0 (iPhone)', asn: 7922, asOrg: 'Comcast', country: 'US' });
T.noteRequest(a, { day, path: '/players/bo-nix/', ua: 'Mozilla/5.0 (Windows)', asn: 16509, asOrg: 'AMAZON-02', country: 'US' });
T.noteRequest(b, { day, path: '/', ua: 'Mozilla/5.0 (X11)', asn: 45102, asOrg: 'Alibaba', country: 'SG' });
T.noteRequest(b, { day, path: '/app.js', ua: 'Mozilla/5.0 (X11)', asn: 45102, asOrg: 'Alibaba', country: 'SG' });
T.noteRequest(b, { day, path: '/api/search', ua: 'curl/8', asn: 14061, country: 'NL' });
const r = T.mergeTallies([a, b]);
check('isolates are summed', r.requests === 5 && r.isolates === 2 && r.pages === 3 && r.assets === 1 && r.api === 1, JSON.stringify({ req: r.requests, pages: r.pages }));
check('visitors are split by kind', r.visitors.human === 1 && r.visitors.datacenter === 3 && r.visitors.declaredBot === 1, JSON.stringify(r.visitors));
check('page views are broken down by network and country', r.topNetworks.some(x => x.name === '45102 Alibaba' && x.hits === 1)
  && r.topCountries.some(x => x.name === 'SG'), JSON.stringify(r.topNetworks));
const c = T.newTally('2026-09-26');
T.noteRequest(c, { day: '2026-09-27', path: '/', ua: 'x', asn: 1 });
check('a new day starts a new tally', c.day === '2026-09-27' && c.total === 1);

const worker = fs.readFileSync(path.join(__dirname, '..', 'worker.js'), 'utf8');
const fetchAt = worker.indexOf('async fetch(request, env, ctx)');
const countAt = worker.indexOf('_countVisitor(request, url, env, ctx)', fetchAt);
const assetsAt = worker.indexOf('env.ASSETS.fetch(request)', fetchAt);
check('the Worker counts every request before it serves pages or assets', fetchAt > 0 && countAt > fetchAt && countAt < assetsAt);
check('  ...and each isolate writes its own key, not a shared one', /\$\{VISITORS_PREFIX\}\$\{_visitors\.day\}:\$\{_isolateId\}/.test(worker));
check('blocked crawlers get a 403 everywhere but robots.txt', /visitorKind === 'blockedBot' && url\.pathname !== '\/robots\.txt'/.test(worker)
  && worker.indexOf("visitorKind === 'blockedBot'") < worker.indexOf('env.ASSETS.fetch(request)'));
check('the visitors report is admin only', /key !== env\.ADMIN_PASSWORD/.test(worker));

(async () => {
  const { NO_TAGS_FOR, BotTagRemover, stripsTags } = await import(path.join(__dirname, '..', 'worker.js'));
  check('bots, datacentre visitors and verified crawlers lose the ad and analytics tags; people keep them',
    ['declaredBot', 'noUa', 'datacenter', 'verifiedBot'].every(k => NO_TAGS_FOR.has(k)) && !NO_TAGS_FOR.has('human'));
  const macChrome = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
  check("  ...Bing's renderer, a verified bot with a browser user agent, is stripped",
    stripsTags('verifiedBot', macChrome) && !stripsTags('human', macChrome));
  check("  ...but Google's ad crawlers still see the AdSense code",
    !stripsTags('verifiedBot', 'Mediapartners-Google') && !stripsTags('verifiedBot', 'Mozilla/5.0 (compatible; AdsBot-Google; +http://www.google.com/adsbot.html)'));
  const r = new BotTagRemover();
  const el = (src) => ({ removed: false, getAttribute: (k) => (k === 'src' ? src : null), remove() { this.removed = true; } });
  const ads = el('https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-1');
  const ga = el('https://www.googletagmanager.com/gtag/js?id=G-37RKDTRBCH');
  const app = el('/app.js?v=1');
  [ads, ga, app].forEach(e => r.element(e));
  check('  ...the AdSense and Analytics scripts come off, the app does not', ads.removed && ga.removed && !app.removed && r.removed === 2);
  check('  ...applied to HTML pages by visitor kind', /if \(stripsTags\(visitorKind, request\.headers\.get\('user-agent'\)\)\) \{\s*out = new HTMLRewriter\(\)\.on\('script\[src\], script\[data-ga\]', new BotTagRemover\(\)\)/.test(worker));
  // Analytics loads on a person's first action, from an inline loader; it
  // comes off for bots too.
  const loader = { removed: false, getAttribute: (k) => (k === 'data-ga' ? '' : null), remove() { this.removed = true; } };
  const plain = { removed: false, getAttribute: () => null, remove() { this.removed = true; } };
  r.element(loader); r.element(plain);
  check('  ...the analytics loader comes off too, other inline scripts stay', loader.removed && !plain.removed);
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  check('Analytics waits for a person: no gtag.js on load, a loader that starts on a trusted tap, scroll, key or mouse move',
    !/<script[^>]*src="https:\/\/www\.googletagmanager\.com\/gtag\/js/.test(html) && /<script data-ga>/.test(html)
      && /e\.isTrusted === false/.test(html) && /'pointerdown', 'touchstart', 'keydown', 'scroll', 'wheel', 'mousemove'/.test(html)
      && /held\.forEach/.test(html));
  console.log(failures ? `\n${failures} check(s) failed` : '\nall visitors checks passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
