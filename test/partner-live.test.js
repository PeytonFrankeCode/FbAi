// Live now + stream overlay (owner, Nov 2026: "build the live now spot and
// overlay first"). An approved partner adds where they stream; they show on
// the home page's Live now strip while live (an "I'm live" tap, or their OBS
// overlay checking in with its private key); the owner can hide them.
'use strict';
process.env.NODE_ENV = 'test';
process.env.CF_WORKER = '1';
const path = require('path');
const fs = require('fs');
let failures = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`); if (!ok) failures++; };
const ROOT = path.join(__dirname, '..');
const S = require(path.join(ROOT, 'server.js'));
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'test-admin';

(async () => {
  const server = S.app.listen(0), base = `http://127.0.0.1:${server.address().port}`;
  let ip = 60;
  const call = async (p, { method = 'GET', body, token, admin } = {}) => {
    const r = await fetch(base + p, { method, body: body ? JSON.stringify(body) : undefined, headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0',
      'cf-connecting-ip': `198.51.100.${ip++ % 250}`, ...(token ? { authorization: `Bearer ${token}` } : {}), ...(admin ? { 'x-admin-key': process.env.ADMIN_PASSWORD } : {}) } });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const liveNow = async () => { S._liveNowMemo.at = 0; return (await call('/api/partners/live-now')).body; };
  try {
    const stamp = Date.now().toString(36), maker = 'streamer' + stamp, code = 'breaks' + stamp;
    const tok = (await call('/api/auth/register', { method: 'POST', body: { username: maker, password: 'secret123' } })).body.token;
    check('stream settings are for approved partners only', (await call('/api/partners/stream', { method: 'POST', token: tok, body: { platform: 'whatnot', url: 'https://whatnot.com/user/x' } })).status === 403);
    await call('/api/partners/apply', { method: 'POST', token: tok, body: { name: 'Big Breaks', channel: 'https://whatnot.com/user/bigbreaks', payout: 'bb@example.com' } });
    await call('/api/admin/partners/decide', { method: 'POST', admin: true, body: { user: maker, approve: true, code } });

    let r = await call('/api/partners/me', { token: tok });
    const si = r.body.streamInfo;
    check('an approved partner gets a private overlay link', si && /\/overlay\?ref=/.test(si.overlayUrl) && /&key=[0-9a-f]{24}$/.test(si.overlayUrl), si && si.overlayUrl);
    const key = si.overlayUrl.split('&key=')[1];
    check('"I\'m live" needs a stream link first', (await call('/api/partners/live', { method: 'POST', token: tok, body: { on: true } })).status === 400);
    check('a stream link must be a real https link', (await call('/api/partners/stream', { method: 'POST', token: tok, body: { platform: 'whatnot', url: 'javascript:alert(1)' } })).status === 400);
    check('...on a platform from the list', (await call('/api/partners/stream', { method: 'POST', token: tok, body: { platform: 'myspace', url: 'https://x.com/a' } })).status === 400);
    r = await call('/api/partners/stream', { method: 'POST', token: tok, body: { platform: 'whatnot', url: 'https://www.whatnot.com/user/bigbreaks' } });
    check('the partner saves where they stream', r.status === 200 && r.body.stream.platform === 'whatnot');

    let L = await liveNow();
    let me = L.partners.find(p => p.code === code);
    check('they are listed for the Live now strip, not live yet', me && !me.live && me.platformName === 'Whatnot' && me.url === 'https://www.whatnot.com/user/bigbreaks');
    r = await call('/api/partners/live', { method: 'POST', token: tok, body: { on: true } });
    check('"I\'m live" makes them live for about 4 hours', r.status === 200 && r.body.live && Date.parse(r.body.liveUntil) - Date.now() > 3.9 * 3600e3);
    L = await liveNow();
    check('...and they show as live on the strip', L.partners.find(p => p.code === code).live && L.live >= 1);
    await call('/api/partners/live', { method: 'POST', token: tok, body: { on: false } });
    check('"End live" takes them off', !(await liveNow()).partners.find(p => p.code === code).live);

    r = await call(`/api/partners/overlay?ref=${code}`);
    check('the overlay without its key works but does not mark them live', r.status === 200 && r.body.keyOk === false && r.body.link.endsWith('/?ref=' + code) && !(await liveNow()).partners.find(p => p.code === code).live);
    r = await call(`/api/partners/overlay?ref=${code}&key=${key}`);
    check('the overlay with its key marks them live while it is open', r.status === 200 && r.body.keyOk && (await liveNow()).partners.find(p => p.code === code).live);
    check('an unknown partner code has no overlay', (await call('/api/partners/overlay?ref=nobody' + stamp)).status === 404);

    await call('/api/partners/overlay-card', { method: 'POST', token: tok, body: { q: '  2024 Prizm   Bo Nix Silver ' } });
    r = await call(`/api/partners/overlay?ref=${code}&key=${key}`);
    check('the card set in My Account shows on the overlay', r.body.card === '2024 Prizm Bo Nix Silver');
    check('...but not to someone without the key', (await call(`/api/partners/overlay?ref=${code}`)).body.card === '');

    check('hiding a partner is admin only', (await call('/api/admin/partners/feature', { method: 'POST', body: { user: maker, featured: false } })).status === 401);
    await call('/api/admin/partners/feature', { method: 'POST', admin: true, body: { user: maker, featured: false } });
    check('the owner can hide a partner from the strip', !(await liveNow()).partners.find(p => p.code === code));
    await call(`/api/partners/overlay?ref=${code}&key=${key}`);
    check('...and a hidden partner\'s overlay does not put them back', !(await liveNow()).partners.find(p => p.code === code));
    const adm = (await call('/api/admin/partners', { admin: true })).body.partners.find(p => p.user === maker);
    check('Admin shows their stream and that they are hidden', adm && adm.stream && adm.stream.platform === 'whatnot' && adm.featured === false);
    await call('/api/admin/partners/feature', { method: 'POST', admin: true, body: { user: maker, featured: true } });
    check('...and can show them again', !!(await liveNow()).partners.find(p => p.code === code));
  } finally { server.close(); }

  const html = fs.readFileSync(path.join(ROOT, 'public', 'overlay.html'), 'utf8');
  check('the overlay page is noindex and has a transparent background for OBS', /name="robots" content="noindex/.test(html) && /background:transparent/.test(html));
  check('the overlay draws the QR code with the vendored library', /src="\/vendor\/qrcode\.js"/.test(html) && fs.existsSync(path.join(ROOT, 'public', 'vendor', 'qrcode.js')));
  const worker = fs.readFileSync(path.join(ROOT, 'worker.js'), 'utf8');
  check('/overlay is a served page', /'overlay'/.test(worker));
  const index = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8'), app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  check('the home page has the Live now strip, hidden until someone is live', /id="live-now" class="live-now" hidden/.test(index) && /async function loadLiveNow/.test(app) && /filter\(p => p\.live\)/.test(app));
  check('My Account has the stream, live and overlay controls', /function _partnerStreamHtml/.test(app) && /acctPartnerLive\(true\)/.test(app) && /partner-overlay-link/.test(app));
  console.log(failures ? `\n${failures} partner-live check(s) failed` : '\nall partner-live checks passed');
  process.exit(failures ? 1 : 0);
})();
