// My Account: the profile, the email, and the giveaway entry.
//
// Drives the real app: only the signed-in owner reads or changes their own
// address, entering needs one, removing it takes them out, only the admin key
// lists entrants, and export and account deletion both cover it. Then checks
// the menu no longer carries the old email box that saved to the browser only.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

const { validateShipping, formatAddress } = require(path.join(ROOT, 'account-profile.js'));

// ---- the rules, pure ------------------------------------------------------
const HOME = { name: 'Pat Fan', line1: '1 Lambeau Way', city: 'Green Bay', state: 'wi', zip: '54304', country: 'US' };
{
  const v = validateShipping(HOME);
  check('a US address is accepted, the state upper-cased', v.ok && v.shipping.state === 'WI' && v.shipping.country === 'US');
  check('  ...the country defaults to the US', validateShipping({ ...HOME, country: '' }).ok);
  check('  ...a bad state or ZIP is refused, naming the field',
    validateShipping({ ...HOME, state: 'ZZ' }).field === 'state' && validateShipping({ ...HOME, zip: '5430' }).field === 'zip');
  check('  ...ZIP+4 is fine', validateShipping({ ...HOME, zip: '54304-1234' }).ok);
  check('a Canadian address needs a province and a postal code',
    validateShipping({ ...HOME, country: 'CA', state: 'ON', zip: 'k1a 0b1' }).ok
    && validateShipping({ ...HOME, country: 'CA', state: 'WI', zip: 'K1A 0B1' }).field === 'state'
    && validateShipping({ ...HOME, country: 'CA', state: 'ON', zip: '54304' }).field === 'zip');
  check('other countries are refused for now', validateShipping({ ...HOME, country: 'GB' }).field === 'country');
  check('name, street and city are required',
    validateShipping({ ...HOME, name: '' }).field === 'name' && validateShipping({ ...HOME, line1: '' }).field === 'line1'
    && validateShipping({ ...HOME, city: '' }).field === 'city');
  check('a phone is optional but must look like one',
    validateShipping({ ...HOME, phone: '(920) 555-0100' }).ok && validateShipping({ ...HOME, phone: 'call me' }).field === 'phone');
  check('long or control characters are cleaned', validateShipping({ ...HOME, name: 'Pat\n\u0000Fan' + 'x'.repeat(200) }).shipping.name.length === 80
    && !/[\n\u0000]/.test(validateShipping({ ...HOME, name: 'Pat\nFan' }).shipping.name));
  check('the label line reads as an address', formatAddress(v.shipping) === 'Pat Fan, 1 Lambeau Way, Green Bay, WI 54304, United States');
}

// ---- the flow, against the real app --------------------------------------
process.env.CF_WORKER = '1';
process.env.ADMIN_PASSWORD = 'giveaway-admin';
const { app } = require(path.join(ROOT, 'server.js'));
const PORT = 3255;
const server = app.listen(PORT);
const base = `http://127.0.0.1:${PORT}`;
let ip = 10;
const call = (p, { method = 'GET', token, body, headers = {} } = {}) => fetch(base + p, {
  method, body: body ? JSON.stringify(body) : undefined,
  headers: { 'content-type': 'application/json', 'cf-connecting-ip': `203.0.113.${ip++}`, ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
});
const json = async (r) => (await r).json();
const admin = { 'x-admin-key': 'giveaway-admin' };

(async () => {
  const reg = async (username, email) => (await json(call('/api/auth/register', { method: 'POST', body: { username, password: 'secret123', email } }))).token;
  // Fresh names each run: the file store keeps accounts between runs.
  const run = Date.now().toString(36);
  const alice = await reg('acct_a' + run, 'alice@example.com');
  const bob = await reg('acct_b' + run, '');
  // Entrants from this run only.
  const mine = async () => (await json(call('/api/admin/giveaway-entrants', { headers: admin }))).entrants.filter(x => x.username.endsWith(run)).length;
  check('both test accounts signed up', !!alice && !!bob);

  check('the profile needs a session', (await call('/api/account/profile')).status === 401);
  check('  ...and so does saving an address', (await call('/api/account/giveaways', { method: 'PUT', body: { optIn: true, shipping: HOME } })).status === 401);
  const p0 = await json(call('/api/account/profile', { token: alice }));
  check('a new profile: username, email, a join date, password sign-in, not entered',
    p0.username === 'acct_a' + run && p0.email === 'alice@example.com' && !!p0.memberSince && p0.signIn.join() === 'password'
    && p0.giveaways === false && p0.shipping === null && p0.alerts.count === 0, JSON.stringify(p0));

  // Email.
  check('a bad email is refused', (await call('/api/auth/email', { method: 'PUT', token: alice, body: { email: 'nope' } })).status === 400);
  const e = await json(call('/api/auth/email', { method: 'PUT', token: alice, body: { email: ' Alice2@Example.com ' } }));
  check('  ...a good one is saved lower-case', e.email === 'alice2@example.com'
    && (await json(call('/api/account/profile', { token: alice }))).email === 'alice2@example.com');

  // Giveaways.
  const noAddr = await call('/api/account/giveaways', { method: 'PUT', token: alice, body: { optIn: true } });
  check('entering with no address is refused', noAddr.status === 400);
  const bad = await call('/api/account/giveaways', { method: 'PUT', token: alice, body: { optIn: true, shipping: { ...HOME, zip: 'x' } } });
  check('  ...a bad address is refused, naming the field', bad.status === 400 && (await bad.json()).field === 'zip');
  const saved = await json(call('/api/account/giveaways', { method: 'PUT', token: alice, body: { optIn: true, shipping: HOME } }));
  check('  ...a good one enters them', saved.ok && saved.giveaways === true && saved.shipping.state === 'WI');
  const p1 = await json(call('/api/account/profile', { token: alice }));
  check('  ...and it is on their profile', p1.giveaways === true && p1.shipping.city === 'Green Bay' && !!p1.shippingUpdatedAt);
  check('  ...but not on anyone else\'s', (await json(call('/api/account/profile', { token: bob }))).shipping === null);

  await call('/api/account/giveaways', { method: 'PUT', token: bob, body: { optIn: false, shipping: { ...HOME, name: 'Bob Fan' } } });
  check('the entrants list needs the admin key', (await call('/api/admin/giveaway-entrants')).status === 401);
  const list = await json(call('/api/admin/giveaway-entrants', { headers: admin }));
  check('  ...lists who opted in, with a label line, and not who only saved an address',
    list.entrants.filter(x => x.username.endsWith(run)).length === 1 && list.entrants[0].username === 'acct_a' + run && list.entrants[0].email === 'alice2@example.com'
    && /Green Bay, WI 54304/.test(list.entrants[0].address), JSON.stringify(list));

  const optOut = await json(call('/api/account/giveaways', { method: 'PUT', token: alice, body: { optIn: false } }));
  check('opting out keeps the address', optOut.giveaways === false && optOut.shipping.city === 'Green Bay'
    && (await mine()) === 0);
  await call('/api/account/giveaways', { method: 'PUT', token: alice, body: { optIn: true } });
  check('  ...and opting back in reuses it', (await mine()) === 1);

  const exp = await json(call('/api/account/export', { token: alice }));
  check('the data export includes the address', exp.giveawayProfile && exp.giveawayProfile.shipping.line1 === '1 Lambeau Way');

  check('removing the address works', (await call('/api/account/shipping', { method: 'DELETE', token: alice })).status === 200);
  const p2 = await json(call('/api/account/profile', { token: alice }));
  check('  ...and takes them out of giveaways', p2.shipping === null && p2.giveaways === false
    && (await mine()) === 0);

  await call('/api/account/giveaways', { method: 'PUT', token: bob, body: { optIn: true } });
  const del = await json(call('/api/account/delete', { method: 'POST', token: bob, body: { password: 'secret123', confirm: 'DELETE' } }));
  check('deleting an account removes the address too', (del.removed || []).some(r => /shipping address/.test(r))
    && (await mine()) === 0, JSON.stringify(del));

  server.close();

  // ---- the page -----------------------------------------------------------
  const js = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  check('the menu links My Account, alerts, collection, giveaways, settings and log out',
    ['openAccount()', 'showAlerts()', "switchView('inventory')", "openAccount(\\'giveaways\\')", 'showSettings()', 'handleLogout()']
      .every(s => js.slice(js.indexOf('function toggleAuthDropdown'), js.indexOf('function _acctAlertCount')).includes(s)));
  check('  ...the old email box that saved only to the browser is gone', !/saveDropdownEmail/.test(js));
  check('  ...and the name and email are escaped', /escHtml\(user\)/.test(js) && /escHtml\(email\)/.test(js));
  check('the page has the My Account panel', /id="account-overlay"/.test(html) && /id="account-body"/.test(html));
  check('the privacy page mentions the shipping address',
    /shipping address/i.test(fs.readFileSync(path.join(ROOT, 'public', 'privacy.html'), 'utf8')));

  console.log(failures ? `\n${failures} check(s) failed` : '\nall account checks passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
