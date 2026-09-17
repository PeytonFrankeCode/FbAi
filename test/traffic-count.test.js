// Counting requests where they can actually be seen.
//
// WHY THIS EXISTS. Google Analytics reported 918 users, 919 sessions, 907 views
// and ZERO seconds of average engagement in one day. That is not a shape people
// make — one session each, fewer views than sessions, nobody's page staying
// open. Bot Fight Mode was on throughout and changed nothing, which fits: it
// scores known-bad signatures, and a real headless Chrome does not look like
// one.
//
// The trouble is that GA cannot settle its own question. It only sees clients
// that run its JavaScript, so every headless browser is counted and every plain
// scraper is invisible. The one number available was the one guaranteed to
// undercount the problem, and I twice recommended Cloudflare changes off the
// back of it.
//
// The Worker sees every request. These checks are about the two ways a counter
// like this silently becomes decorative: it stops counting, or it counts and
// nothing ever persists it.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

// KV stubbed before the require: server.js destructures these off db.js at load.
const KV = new Map();
const dbMod = require(path.join(ROOT, 'db.js'));
dbMod.cacheGet = async (k) => (KV.has(k) ? KV.get(k) : null);
dbMod.cachePut = (k, v) => { KV.set(k, v); };
process.env.CF_WORKER = '1';
process.env.ADMIN_PASSWORD = 'test-key-for-traffic';

const srv = require(path.join(ROOT, 'server.js'));
const { app, flushTraffic } = srv;
const server = app.listen(3229);
const K = encodeURIComponent(process.env.ADMIN_PASSWORD);
const hit = (p, ua) => fetch(`http://127.0.0.1:3229${p}`,
  ua === null ? {} : { headers: { 'user-agent': ua } });
const get = async (p) => (await fetch(`http://127.0.0.1:3229${p}`,
  { headers: { 'user-agent': 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/120' } })).json();

(async () => {
  // ---- the door is shut --------------------------------------------------
  //
  // Unlike the d1-usage endpoint next door. User agents are close to visitor
  // detail, and a traffic profile is exactly what someone probing the site
  // would like to read.
  {
    const r = await fetch('http://127.0.0.1:3229/api/debug/traffic');
    check('the traffic report refuses an unauthenticated request',
      r.status === 403, `HTTP ${r.status}`);
  }

  // ---- it counts, and it tells the classes apart -------------------------
  {
    await hit('/', 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/120');
    await hit('/', 'Mozilla/5.0 (Windows NT 10.0) Chrome/119');
    await hit('/app.js', 'Mozilla/5.0 (Macintosh) Chrome/120');
    await hit('/styles.css', 'Mozilla/5.0 (Macintosh) Chrome/120');
    await hit('/', 'Googlebot/2.1 (+http://www.google.com/bot.html)');
    await hit('/', 'python-requests/2.31.0');
    await hit('/', 'curl/8.4.0');

    const d = await get(`/api/debug/traffic?key=${K}`);
    check('the report is available and stamped',
      d.available === true && Number.isFinite(Date.parse(d.generatedAt || '')),
      d.available ? d.generatedAt : JSON.stringify(d).slice(0, 80));

    const s = d.sinceLastFlush || {};
    check('every request is counted, including the report\'s own',
      s.requests >= 8, `${s.requests} requests seen`);
    check('  ...self-declared crawlers are counted as such',
      s.declaredBot >= 3, `${s.declaredBot} declared bots (googlebot, python-requests, curl)`);
    check('  ...and anything claiming to be a browser is not',
      s.browserLike >= 4, `${s.browserLike} browser-like`);
    check('  ...pages, assets and api are separated',
      s.pages >= 5 && s.assets >= 2 && s.api >= 1,
      `pages=${s.pages} assets=${s.assets} api=${s.api}`);
  }

  // ---- and it names names ------------------------------------------------
  //
  // The answer to "what the heck is this" is usually just legible in a list of
  // user agents, biggest first.
  {
    const d = await get(`/api/debug/traffic?key=${K}`);
    const uas = (d.topUserAgents || []).map(x => x.name).join(' | ');
    check('the report names the user agents it saw',
      /Googlebot/.test(uas) && /python-requests/.test(uas),
      uas.slice(0, 110));
    check('  ...and the paths they asked for',
      (d.topPaths || []).some(x => x.name === '/'),
      (d.topPaths || []).map(x => `${x.name}:${x.hits}`).join(' ').slice(0, 90));
  }

  // ---- the tell that a user agent cannot fake ----------------------------
  //
  // A person opening a page pulls its CSS, its JS and some images with it, so
  // assets-per-page runs to several. A client that takes the HTML and leaves
  // sits near zero whatever it calls itself — and fetching all the assets is
  // the part that makes scraping at scale expensive.
  {
    const before = await flushTraffic();
    check('the tally can be persisted', before && before.ok === true,
      JSON.stringify(before));
    const d = await get(`/api/debug/traffic?key=${K}`);
    const today = (d.days || [])[0];
    check('  ...and comes back as a day row',
      today && today.requests >= 8, today ? `${today.requests} requests` : 'no day row');
    check('  ...reporting assets per page, the ratio a fake user agent cannot help',
      today && typeof today.assetsPerPage === 'number',
      today ? `${today.assetsPerPage} assets per page` : 'absent');
  }

  // ---- a report that is always empty is worse than none ------------------
  //
  // It reads as "no traffic" rather than as "not wired up". So the cron has to
  // actually call the flush, and the name has to survive init()'s whitelist —
  // a place where an export and a call have silently failed to connect before.
  {
    const w = fs.readFileSync(path.join(ROOT, 'worker.js'), 'utf8');
    const code = w.replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
    check('the cron flushes the traffic tally',
      /flushTraffic\(\)/.test(code),
      'an unflushed counter reports nothing, quietly');
    check('  ...and init() passes it through to the scheduled handler',
      (code.match(/flushTraffic/g) || []).length >= 4,
      'init() keeps a whitelist; a name missing there makes the cron a no-op');
    check('  ...and server.js exports it for the cron to find',
      /module\.exports = \{[^}]*flushTraffic/.test(
        fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8')),
      'unexported is the same as not built');
  }

  // ---- counting must never break a request -------------------------------
  //
  // This runs on EVERY request before anything else. A throw here would take
  // the whole site down, which would be an absurd way to lose a site: killed
  // by its own analytics.
  {
    // Kept inside what fetch will actually put on the wire — an unpaired
    // surrogate is rejected by the client before the server ever sees it, so
    // testing with one proves nothing about the server. Long, and full of the
    // characters a tally key would choke on.
    const r = await fetch('http://127.0.0.1:3229/api/debug/traffic?key=' + K, {
      headers: { 'user-agent': '__proto__ {}[]"\'\\ <script> ' + 'x'.repeat(8000) },
    });
    check('a hostile user agent does not break the request',
      r.status === 200, `HTTP ${r.status}`);
    const noUa = await fetch('http://127.0.0.1:3229/api/debug/traffic?key=' + K);
    check('  ...and nor does a missing one', noUa.status === 200, `HTTP ${noUa.status}`);
  }

  // ---- the tallies are bounded -------------------------------------------
  //
  // Both keys are attacker-supplied. An unbounded tally is a memory leak
  // someone else controls, in a process that is meant to run for weeks.
  {
    const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    check('the per-agent and per-path tallies are capped',
      /Object\.keys\(_traffic\.byUa\)\.length < 60/.test(src)
      && /Object\.keys\(_traffic\.byPath\)\.length < 60/.test(src),
      'unbounded growth on an attacker-supplied key is a leak, not a report');

    for (let i = 0; i < 120; i++) await hit('/x' + i, 'Agent/' + i);
    const d = await get(`/api/debug/traffic?key=${K}`);
    check('  ...and stay capped when flooded',
      (d.topUserAgents || []).length <= 15 && (d.topPaths || []).length <= 15,
      `${(d.topUserAgents || []).length} agents, ${(d.topPaths || []).length} paths returned`);
  }

  // ---- and it says what it is, because the last number was misread -------
  {
    const d = await get(`/api/debug/traffic?key=${K}`);
    check('the report says it is not comparable to Google Analytics',
      /Google Analytics/.test(d.note || '') && /HIGHER/.test(d.note || ''),
      'a number next to a GA number gets compared to it whether or not that is valid');
  }

  server.close();
  console.log(failures ? `\n${failures} check(s) failed` : '\nall traffic-count checks passed');
  process.exit(failures ? 1 : 0);
})().catch(err => { console.error(err); server.close(); process.exit(1); });
