// The reCAPTCHA gate on the endpoints that cost money.
//
// WHAT THIS IS GUARDING AGAINST. A challenge is easy to add and easy to get
// wrong in ways nobody notices until traffic disappears:
//
//   1. It fires on a page load, and a crawler handed a challenge is a page
//      out of the index. This site's /sets, /players and /teams pages are how
//      it is found, so the path list has to stay narrow.
//   2. Google has an outage and search goes down with it. A dependency that
//      can take the site offline is worse than the bots it stops.
//   3. It turns real people away silently. Every outcome is counted so the
//      damage is visible at /api/debug/traffic before it is believed.
//   4. It cannot be turned off without a deploy, during an incident.
//
// Verification is stubbed at the network boundary, so these run offline and
// assert on this repo's decisions rather than on Google's behaviour.
const path = require('path');
const ROOT = path.join(__dirname, '..');

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

const KV = new Map();
const dbMod = require(path.join(ROOT, 'db.js'));
dbMod.cacheGet = async (k) => (KV.has(k) ? KV.get(k) : null);
dbMod.cachePut = (k, v) => { KV.set(k, v); };
// Suppresses server.js's own app.listen(3000), which the kill-switch check
// below would otherwise re-run when it reloads the module.
process.env.CF_WORKER = '1';
process.env.ADMIN_PASSWORD = 'test-key-for-recaptcha';
// Present before the require: the guard reads it at module load.
process.env.Recaptcha_secret = 'test-secret';
process.env.DISABLE_RATE_LIMIT = '1'; // isolate this gate from the other one

// Stand in for Google. Each case sets what siteverify will say next.
let verifyReply = { success: true, score: 0.9 };
let verifyCalls = [];
const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  if (String(url).includes('recaptcha/api/siteverify')) {
    verifyCalls.push(String((opts && opts.body) || ''));
    if (verifyReply === 'NETWORK_ERROR') throw new Error('getaddrinfo ENOTFOUND');
    return { json: async () => verifyReply };
  }
  return realFetch(url, opts);
};

const srv = require(path.join(ROOT, 'server.js'));
const { app } = srv;
const PORT = 3233;
const server = app.listen(PORT);
const base = `http://127.0.0.1:${PORT}`;

// A fresh address per case unless one is given: a passed check vouches for
// its address for ten minutes, which would otherwise carry across cases.
let _ipN = 10;
const call = async (p, headers = {}, ip = `5.5.5.${_ipN++}`) => {
  const r = await fetch(`${base}${p}`, { headers: { 'cf-connecting-ip': ip, ...headers } });
  let body = null;
  try { body = await r.json(); } catch (_) { /* html or empty */ }
  return { status: r.status, body, unverified: r.headers.get('x-captcha') === 'unverified' };
};

(async () => {
  try {
    // ---- A good token passes ----
    verifyReply = { success: true, score: 0.9 };
    let r = await call('/api/search?q=mahomes&mode=forsale', { 'x-recaptcha-token': 'good' }, '5.5.5.5');
    check('a verified request is not blocked',
      r.status !== 403 && !r.unverified, `status ${r.status}`);
    check('  ...and the token was actually sent to Google',
      verifyCalls.some(b => b.includes('response=good') && b.includes('secret=test-secret')),
      verifyCalls[0] || 'no verify call');
    check('  ...along with the caller IP, so Google can score it',
      verifyCalls.some(b => b.includes('remoteip=5.5.5.5')));
    verifyCalls = [];
    r = await call('/api/search?q=mahomes&mode=forsale', {}, '5.5.5.5');
    check('  ...and vouches for that address for a while: no token, no second call to Google',
      r.status !== 403 && !r.unverified && verifyCalls.length === 0, `status ${r.status}, ${verifyCalls.length} calls`);

    // ---- A failed check no longer refuses: it is served, marked unverified ----
    // It used to answer 403 "Couldn't verify this request came from a
    // browser", and the people it turned away were collectors on checklists
    // (a search per row) and on Safari (privacy features score low).
    verifyCalls = [];
    r = await call('/api/search?q=mahomes&mode=forsale');
    check('a request with no token is served, not refused',
      r.status !== 403 && r.unverified, `status ${r.status} ${JSON.stringify(r.body || {}).slice(0, 70)}`);
    check('  ...without wasting a call to Google on an empty token',
      verifyCalls.length === 0, `${verifyCalls.length} calls made`);

    verifyReply = { success: true, score: 0.1 };
    r = await call('/api/search?q=mahomes&mode=forsale', { 'x-recaptcha-token': 'botlike' });
    check('a score below the threshold is served, marked unverified', r.status !== 403 && r.unverified, `status ${r.status}`);
    verifyReply = { success: true, score: 0.35 };
    r = await call('/api/search?q=mahomes&mode=forsale', { 'x-recaptcha-token': 'safari' });
    check('  ...and 0.35, a typical Safari-with-privacy score, passes', r.status !== 403 && !r.unverified);

    // ---- v2 has no score, and must still work ----
    verifyReply = { success: true };
    r = await call('/api/search?q=mahomes&mode=forsale', { 'x-recaptcha-token': 'v2ok' });
    check('a v2 response carries no score and still passes',
      r.status !== 403 && !r.unverified, `status ${r.status} — the key can be swapped without a code change`);

    verifyReply = { success: false, 'error-codes': ['timeout-or-duplicate'] };
    r = await call('/api/search?q=mahomes&mode=forsale', { 'x-recaptcha-token': 'stale' });
    check('a token Google rejects is served, marked unverified', r.status !== 403 && r.unverified, `status ${r.status}`);

    // ---- Unverified callers meter at the tighter rate ----
    {
      const { rateLimitCheck } = srv;
      const was = process.env.DISABLE_RATE_LIMIT;
      const req = (unv, ip) => ({ path: '/api/search', headers: { 'cf-connecting-ip': ip }, captchaUnverified: unv });
      let ver = 0, unv = 0;
      const t0 = Date.now();
      for (let i = 0; i < 50; i++) { if (!rateLimitCheck(req(false, '9.9.9.1'), t0)) ver++; if (!rateLimitCheck(req(true, '9.9.9.2'), t0)) unv++; }
      check('unverified searches are held to the tighter limit',
        was ? true : (ver === 50 && unv === 30), was ? 'rate limiting disabled in this test' : `verified ${ver}/50, unverified ${unv}/50`);
    }

    // ---- THE ONE THAT MATTERS: Google down must not take search down ----
    verifyReply = 'NETWORK_ERROR';
    r = await call('/api/search?q=mahomes&mode=forsale', { 'x-recaptcha-token': 'whatever' });
    check('Google being unreachable does NOT take search down',
      r.status !== 403,
      `status ${r.status} — failing closed here would make Google an outage of ours`);

    // ---- Scope: pages and cheap endpoints are never gated ----
    verifyReply = { success: true, score: 0.9 };
    const page = await fetch(`${base}/players/patrick-mahomes`, { headers: { 'cf-connecting-ip': '5.5.5.5' } });
    check('page loads are never challenged',
      page.status !== 403,
      'a crawler handed a challenge is a page removed from the index');
    r = await call('/api/sold-stats');
    check('cheap endpoints are never challenged',
      r.status !== 403, `status ${r.status} — only the endpoints that spend money are gated`);

    // ---- Admin tooling is exempt ----
    r = await call(`/api/search?q=x&mode=forsale&key=${encodeURIComponent(process.env.ADMIN_PASSWORD)}`);
    check('admin requests skip the gate', r.status !== 403, `status ${r.status}`);

    // ---- Outcomes are visible, which is how the damage gets measured ----
    const t = await call(`/api/debug/traffic?key=${encodeURIComponent(process.env.ADMIN_PASSWORD)}`);
    const c = t.body && t.body.sinceLastFlush && t.body.sinceLastFlush.captcha;
    check('every outcome is counted where the traffic report can see it',
      !!c && c.pass > 0 && c.trusted > 0 && c.missing > 0 && c.fail > 0 && c.degraded > 0,
      JSON.stringify(c));
    check('  ...and the report states the gate\'s configuration',
      t.body && t.body.recaptcha && t.body.recaptcha.enforcing === true
        && Array.isArray(t.body.recaptcha.paths),
      JSON.stringify(t.body && t.body.recaptcha));

    // ---- The kill switch is real ----
    // Re-read in a fresh module registry, because the flag is read at load.
    {
      for (const k of Object.keys(require.cache)) delete require.cache[k];
      process.env.RECAPTCHA_ENFORCE = '0';
      const srv2 = require(path.join(ROOT, 'server.js'));
      const s2 = srv2.app.listen(3234);
      verifyReply = { success: true, score: 0.01 };
      const rr = await fetch('http://127.0.0.1:3234/api/search?q=x&mode=forsale',
        { headers: { 'cf-connecting-ip': '5.5.5.5', 'x-recaptcha-token': 'botlike' } });
      check('RECAPTCHA_ENFORCE=0 still serves (and skips the tighter limit)',
        rr.status !== 403,
        `status ${rr.status} — report-only, so a misfiring gate is one dashboard edit to disable`);
      s2.close();
      delete process.env.RECAPTCHA_ENFORCE;
    }
  } catch (err) {
    check('the suite ran', false, err && err.stack ? err.stack.split('\n')[0] : String(err));
  } finally {
    server.close();
  }

  console.log(failures ? `\n${failures} check(s) failed` : '\nall recaptcha checks passed');
  process.exit(failures ? 1 : 0);
})();
