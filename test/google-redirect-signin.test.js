// Google sign-in without Google's script: /api/auth/google/start sends the
// visitor to Google's sign-in page, and /callback checks what comes back.
// Where the script was slow or blocked the login panel showed an "or" with
// nothing above it; the page's own button uses this path instead.
const path = require('path');
process.env.CF_WORKER = '1';
process.env.GOOGLE_CLIENT_ID = 'test-client.apps.googleusercontent.com';
const axios = require('axios');
let claims = null;
const realGet = axios.get;
axios.get = async (url, opts) => {
  if (String(url).includes('oauth2.googleapis.com/tokeninfo')) {
    if (!claims || opts.params.id_token !== 'good-token') throw new Error('invalid token');
    return { data: claims };
  }
  return realGet(url, opts);
};
const { app } = require(path.join(__dirname, '..', 'server.js'));
const PORT = 3249;
const server = app.listen(PORT);
const base = `http://127.0.0.1:${PORT}`;

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};
const post = (cookie, form) => fetch(`${base}/api/auth/google/callback`, {
  method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', cookie }, body: new URLSearchParams(form),
}).then(r => r.text());

(async () => {
  const r = await fetch(`${base}/api/auth/google/start?return=${encodeURIComponent('/?q=bo%20nix')}`, { redirect: 'manual' });
  const loc = new URL(r.headers.get('location'));
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  const saved = JSON.parse(decodeURIComponent(cookie.split('=').slice(1).join('=')));
  check('start sends the visitor to Google\'s sign-in page', r.status === 302 && loc.host === 'accounts.google.com');
  check('  ...asking for an ID token posted back to our callback',
    loc.searchParams.get('response_type') === 'id_token' && loc.searchParams.get('response_mode') === 'form_post'
    && loc.searchParams.get('redirect_uri') === `http://127.0.0.1:${PORT}/api/auth/google/callback`
    && loc.searchParams.get('client_id') === process.env.GOOGLE_CLIENT_ID, loc.searchParams.get('redirect_uri'));
  check('  ...with a state and nonce it keeps in a short-lived cookie',
    saved.state === loc.searchParams.get('state') && saved.nonce === loc.searchParams.get('nonce')
    && /SameSite=None/.test(r.headers.get('set-cookie')) && /HttpOnly/.test(r.headers.get('set-cookie')));
  const evil = await fetch(`${base}/api/auth/google/start?return=${encodeURIComponent('//evil.example')}`, { redirect: 'manual' });
  check('an off-site return address is not kept', JSON.parse(decodeURIComponent((evil.headers.get('set-cookie') || '').split(';')[0].split('=').slice(1).join('='))).ret === '/');

  check('a callback with the wrong state is refused', /expired/.test(await post(cookie, { state: 'nope', id_token: 'good-token' })));
  claims = { aud: process.env.GOOGLE_CLIENT_ID, sub: 'g-123', email: 'fan@example.com', email_verified: 'true', name: 'Fan', nonce: 'other' };
  check('a token issued for another sign-in (nonce) is refused', /could not confirm/.test(await post(cookie, { state: saved.state, id_token: 'good-token' })));
  check('a token Google does not vouch for is refused', /could not confirm/.test(await post(cookie, { state: saved.state, id_token: 'bad-token' })));
  claims.nonce = saved.nonce;
  const ok = await post(cookie, { state: saved.state, id_token: 'good-token' });
  check('a good one signs in: the session is stored and the visitor goes back where they were',
    /localStorage\.setItem\('cardHuddleToken'/.test(ok) && /location\.replace\("\/\?q=bo%20nix"\)/.test(ok), ok.slice(0, 160));
  check('  ...and nothing from the token can break out of the script', !/<\/script>.*<\/script>/s.test(ok.replace(/<script>[\s\S]*?<\/script>/, '')));
  server.close();
  console.log(failures ? `\n${failures} check(s) failed` : '\nall google-redirect-signin checks passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); server.close(); process.exit(1); });
