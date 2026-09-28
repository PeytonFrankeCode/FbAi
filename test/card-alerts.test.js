// Card alerts: "tell me when this card is listed".
//
// It had stopped working three ways at once: the checker was stubbed to an
// empty result, the alerts lived in one blob stale isolates overwrote, and the
// routes took the username from the page. This drives the real app: create,
// check against eBay's newest listings (stubbed), notify, see, delete.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
check('the live-listings route caches with the helper that exists', !/setCached\(/.test(src));
check('the checker asks eBay for the newest listings, not an empty stub',
  /sort: 'newlyListed'/.test(src) && !/results: \[\] \};\s*\n\s*const currentIds/.test(src));

process.env.CF_WORKER = '1';
process.env.RESEND_API_KEY = 'test-key';
const sent = [];
const axios = require('axios');
axios.post = async (url, body) => {
  if (url.endsWith('/emails')) { sent.push({ to: body.to[0], subject: body.subject, html: body.html }); return { data: { id: 'x' } }; }
  throw new Error('unexpected ' + url);
};
// Cloudflare KV's list is eventually consistent: a key written a moment ago
// can be missing from it for up to a minute. The in-memory stand-in is
// instantly consistent, which is how "Track" showing nothing got past these
// tests. While staleList is on, list answers as KV can: without new keys.
const dbMod = require(path.join(ROOT, 'db.js'));
const realList = dbMod.recordList;
let staleList = false;
dbMod.recordList = async (prefix) => (staleList ? [] : realList(prefix));
const { app, checkAlerts, _alertFinds } = require(path.join(ROOT, 'server.js'));

// ---- the rule, pure --------------------------------------------------------
{
  const alert = { createdAt: '2026-09-28T10:00:00Z', lastChecked: null, seen: [], found: [], unread: 0 };
  const L = (id, listedAt, price = '50') => ({ itemId: id, title: 'Card ' + id, price, listedAt });
  const first = _alertFinds(alert, [L('a', '2026-09-28T09:00:00Z'), L('b', '2026-09-28T09:30:00Z')]);
  check('the first check only learns what is already listed', first.finds.length === 0 && first.next.seen.length === 2 && first.next.lastChecked);
  const second = _alertFinds(first.next, [L('c', '2026-09-28T11:00:00Z'), L('a', '2026-09-28T09:00:00Z'), L('old', '2026-09-27T09:00:00Z')]);
  check('  ...after that, a listing never seen and listed since the alert is a find',
    second.finds.map(f => f.itemId).join() === 'c' && second.next.unread === 1 && second.next.found[0].itemId === 'c');
  const again = _alertFinds(second.next, [L('c', '2026-09-28T11:00:00Z')]);
  check('  ...and is found once', again.finds.length === 0 && again.next.unread === 1);
  const priced = _alertFinds({ ...first.next, priceThreshold: 40, priceCondition: 'below' },
    [L('cheap', '2026-09-28T12:00:00Z', '35'), L('dear', '2026-09-28T12:00:00Z', '60')]);
  check('a price alert keeps only listings on the right side of the price', priced.finds.map(f => f.itemId).join() === 'cheap');
}

// ---- the flow, against the real app ---------------------------------------
const PORT = 3241;
const server = app.listen(PORT);
const base = `http://127.0.0.1:${PORT}`;
const call = (p, { method = 'GET', token, body } = {}) => fetch(base + p, {
  method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: body ? JSON.stringify(body) : undefined,
});

(async () => {
  const reg = async (username, email) => (await (await call('/api/auth/register', { method: 'POST', body: { username, password: 'secret123', email } })).json()).token;
  // Unique per run: off-Worker, accounts persist in data/users.json.
  const run = Date.now().toString(36);
  const alice = await reg('alice_' + run, 'alice@example.com');
  const bob = await reg('bob_' + run, '');

  check('alerts need a signed-in user', (await call('/api/alerts')).status === 401
    && (await call('/api/alerts', { method: 'POST', body: { query: 'Josh Allen 304', username: 'alice_' + run } })).status === 401);

  staleList = true;
  const made = await (await call('/api/alerts', { method: 'POST', token: alice, body: { query: '2018 Donruss Josh Allen 304' } })).json();
  check('a signed-in user can track a card', made.alert && made.alert.id);
  check('  ...and the answer carries the saved list, for the panel to draw', made.alerts && made.alerts.length === 1 && made.alerts[0].id === made.alert.id);
  const listed = await (await call('/api/alerts', { token: alice })).json();
  check('  ...and it is there straight away, even while KV\u2019s key list lags', listed.alerts.length === 1 && listed.alerts[0].id === made.alert.id);
  staleList = false;
  check('  ...but not the same one twice', (await call('/api/alerts', { method: 'POST', token: alice, body: { query: '2018 donruss josh allen 304' } })).status === 400);
  const bobs = await (await call('/api/alerts', { token: bob })).json();
  check("  ...and nobody else can see it", bobs.alerts.length === 0);
  check("  ...or delete it", (await call(`/api/alerts/${made.alert.id}`, { method: 'DELETE', token: bob })).status === 404);

  // eBay's newest listings, as the stub sees them over time.
  let listings = [{ itemId: 'v1|100|0', title: '2018 Donruss Josh Allen #304 RC', price: '120.00', listedAt: '2026-09-01T00:00:00Z', itemUrl: 'https://www.ebay.com/itm/100' }];
  const fetchListings = async () => listings;
  const t0 = Date.now();
  const r1 = await checkAlerts({ now: t0, fetchListings });
  check('the first check runs and finds nothing new', r1.ok && r1.checked === 1 && r1.found === 0 && sent.length === 0, JSON.stringify(r1));
  const r1b = await checkAlerts({ now: t0 + 5 * 60 * 1000, fetchListings });
  check('  ...and an alert is not rechecked within half an hour', r1b.checked === 0);

  listings = [{ itemId: 'v1|200|0', title: '2018 Donruss Josh Allen #304 <b>PSA 10</b>', price: '450.00', listedAt: new Date(t0 + 60000).toISOString(), itemUrl: 'https://www.ebay.com/itm/200', imageUrl: 'https://i.ebayimg.com/x.jpg' }, ...listings];
  const r2 = await checkAlerts({ now: t0 + 31 * 60 * 1000, fetchListings });
  check('a new listing is found on the next check', r2.found === 1, JSON.stringify(r2));
  const mail = sent.find(m => m.to === 'alice@example.com');
  check('  ...and emailed to the owner', mail && /Just listed: 2018 Donruss Josh Allen 304/.test(mail.subject));
  check('  ...with the eBay link carrying the affiliate tag', mail && /itm\/200\?mkcid=1&amp;.*campid=5339145753/.test(mail.html));
  check('  ...with listing text escaped', mail && mail.html.includes('&lt;b&gt;PSA 10&lt;/b&gt;') && !mail.html.includes('<b>PSA 10</b>'));

  const mine = await (await call('/api/alerts', { token: alice })).json();
  const a = mine.alerts[0];
  check('the find shows on the site, marked new', a.unread === 1 && a.found[0].itemId === 'v1|200|0' && a.found[0].itemUrl === 'https://www.ebay.com/itm/200');
  await call('/api/alerts/seen', { method: 'POST', token: alice });
  const after = await (await call('/api/alerts', { token: alice })).json();
  check('  ...until the panel is opened', after.alerts[0].unread === 0 && after.alerts[0].found.length === 1);

  check('the owner can delete it', (await call(`/api/alerts/${made.alert.id}`, { method: 'DELETE', token: alice })).status === 200
    && (await (await call('/api/alerts', { token: alice })).json()).alerts.length === 0);

  server.close();
  console.log(failures ? `\n${failures} check(s) failed` : '\nall card-alerts checks passed');
  process.exit(failures ? 1 : 0);
})().catch(err => { console.error(err); server.close(); process.exit(1); });
