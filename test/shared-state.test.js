// Several Worker copies serve the site (owner bug, Oct 2026): a login made on
// one copy must be honoured by another that preloaded its sessions earlier,
// or the collector is sent back to the login box (the Huddle+ buy loop).
// Plays the "other copy" by emptying this copy's view of the sessions, with a
// fake KV behind db.js.
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..');
let failures = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`); if (!ok) failures++; };

process.env.CF_WORKER = '1';
process.env.DISABLE_RATE_LIMIT = '1';
const kvStore = new Map();
const kvMeta = new Map();
const fakeKV = {
  async get(k, type) { const v = kvStore.has(k) ? kvStore.get(k) : null; return v == null ? null : (type === 'json' ? JSON.parse(v) : v); },
  async put(k, v, opts) { kvStore.set(k, typeof v === 'string' ? v : JSON.stringify(v)); if (opts && opts.metadata) kvMeta.set(k, opts.metadata); },
  async delete(k) { kvStore.delete(k); kvMeta.delete(k); },
  async list({ prefix = '' } = {}) { return { keys: [...kvStore.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name, metadata: kvMeta.get(name) })), list_complete: true }; },
};
const db = require(path.join(ROOT, 'db.js'));
const S = require(path.join(ROOT, 'server.js'));

(async () => {
  try {
    await db.connectDB({ KV: fakeKV });
    const server = S.app.listen(0);
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (p, { method = 'GET', token, body } = {}) => {
      const r = await fetch(base + p, { method, body: body ? JSON.stringify(body) : undefined,
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) } });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    };
    const u = 'shs' + Date.now().toString(36);
    const reg = await call('/api/auth/register', { method: 'POST', body: { username: u, password: 'secret123', email: '' } });
    const token = reg.body.token;
    await new Promise(r => setTimeout(r, 20));
    check('a new session is stored under its own key too', kvStore.has(`sess:${token}`) && kvMeta.get(`sess:${token}`).u === u);

    // The other copy: preloaded before this login, so its list has no such token.
    db.cacheOnly('sessions', {});
    const me = await call('/api/auth/me', { token });
    check('a copy that never saw the login still knows the collector', me.status === 200 && me.body.username === u, JSON.stringify(me.body));

    // Even when another copy's save dropped it from the shared list in KV.
    db.cacheOnly('sessions', {});
    kvStore.set('sessions', '{}');
    check('  ...and when the shared list lost it', (await call('/api/auth/me', { token })).status === 200);

    const login = await call('/api/auth/login', { method: 'POST', body: { username: u, password: 'secret123' } });
    await new Promise(r => setTimeout(r, 20));
    db.cacheOnly('sessions', {});
    check('a login (not just a sign-up) works on another copy', login.status === 200 && (await call('/api/auth/me', { token: login.body.token })).status === 200);

    await call('/api/auth/logout', { method: 'POST', token: login.body.token });
    await new Promise(r => setTimeout(r, 20));
    db.cacheOnly('sessions', {});
    check('logging out ends the session on every copy', !kvStore.has(`sess:${login.body.token}`) && (await call('/api/auth/me', { token: login.body.token })).status === 401);
    check('  ...a made-up token is still refused', (await call('/api/auth/me', { token: 'nope' })).status === 401);

    // A plan another copy recorded (a Stripe webhook) shows up after a refresh.
    const subs = JSON.parse(kvStore.get('subscriptions') || '{}');
    subs[u] = { plan: 'adfree', status: 'active', period: 'monthly' };
    kvStore.set('subscriptions', JSON.stringify(subs));
    await db.refreshKeys(['subscriptions'], 0);
    const me2 = await call('/api/auth/me', { token });
    check('a plan written by another copy is picked up', me2.body.huddlePlus === true, JSON.stringify(me2.body.subscription));
    check('  ...and each request refreshes a view older than 15 seconds', /refreshKeys\(\['sessions', 'users', 'subscriptions'\], SHARED_FRESH_MS\)/.test(require('fs').readFileSync(path.join(ROOT, 'server.js'), 'utf8')));
    server.close();
  } catch (e) { console.error(e); failures++; }
  console.log(failures ? `\n${failures} check(s) failed` : '\nall shared-state checks passed');
  process.exit(failures ? 1 : 0);
})();
