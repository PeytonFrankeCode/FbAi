// The Ad-free plan (owner, Oct 2026): $2.99 a month or $24.99 a year turns
// Google ads off for the account. Drives the real app for the parts that
// guard money: the plan lands only on the signed-in account, billing opens
// only for its owner, and an unsigned webhook is never trusted on the live
// site. Then checks the browser side is wired.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

process.env.CF_WORKER = '1';
process.env.STRIPE_SECRET_KEY = 'sk_test_adfree_suite';   // Stripe "on", never reached
delete process.env.STRIPE_WEBHOOK_SECRET;
const S = require(path.join(ROOT, 'server.js'));
const PORT = 3273;
const server = S.app.listen(PORT);
const base = `http://127.0.0.1:${PORT}`;
let ip = 40;
const call = (p, { method = 'GET', token, body, raw, headers = {} } = {}) => fetch(base + p, {
  method, body: raw != null ? raw : body ? JSON.stringify(body) : undefined,
  headers: { 'content-type': 'application/json', 'cf-connecting-ip': `203.0.113.${ip++}`, ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
});

(async () => {
  check('the prices are $2.99 a month and $24.99 a year',
    S.ADFREE_PRICES.monthly.unit_amount === 299 && S.ADFREE_PRICES.monthly.recurring.interval === 'month'
    && S.ADFREE_PRICES.yearly.unit_amount === 2499 && S.ADFREE_PRICES.yearly.recurring.interval === 'year');

  // ---- an unsigned webhook would grant a paid plan: refused ----
  const fake = { type: 'checkout.session.completed', data: { object: { metadata: { username: 'freeloader', plan: 'adfree' }, subscription: 'sub_x', customer: 'cus_x' } } };
  const w = await call('/api/stripe/webhook', { method: 'POST', raw: JSON.stringify(fake) });
  check('an unsigned webhook is refused on the live site, and grants nothing', w.status === 503 && !S.isAdFreeUser('freeloader'), `status ${w.status}`);

  // ---- checkout: the signed-in account only ----
  check('checkout needs a signed-in account', (await call('/api/stripe/create-checkout-adfree', { method: 'POST', body: { period: 'monthly', username: 'someone' } })).status === 401);
  const run = Date.now().toString(36);
  const reg = async (u) => (await (await call('/api/auth/register', { method: 'POST', body: { username: u, password: 'secret123', email: '' } })).json()).token;
  const alice = await reg('adf_a' + run);
  check('  (a test account signed up)', !!alice);

  // ---- billing portal: the owner only ----
  check('billing needs a signed-in account', (await call('/api/stripe/create-portal-session', { method: 'POST', body: { username: 'adf_a' + run } })).status === 401);
  const other = await call('/api/stripe/create-portal-session', { method: 'POST', token: alice, body: { username: 'someone_else' } });
  check('  ...and never opens another account\'s billing', other.status === 403, `status ${other.status}`);
  const own = await call('/api/stripe/create-portal-session', { method: 'POST', token: alice, body: {} });
  check('  ...an account with no plan is told so', own.status === 404, `status ${own.status}`);

  check('the retired Pro and Pro+ checkouts take no money',
    (await call('/api/stripe/create-checkout', { method: 'POST', body: { username: 'x' } })).status === 410
    && (await call('/api/stripe/create-checkout-proplus', { method: 'POST', body: { username: 'x' } })).status === 410);

  // ---- only an active ad-free plan counts ----
  check('no record, no plan: not ad-free', S.isAdFreeUser('nobody_' + run) === false && S.isAdFreeUser('') === false);

  // ---- the browser side ----
  const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  check('every ad label offers "Remove ads"', /const AD_LABEL = [\s\S]{0,300}Remove ads/.test(app) && (app.match(/AD_LABEL/g) || []).length >= 5
    && !/<p class="ad-label">Advertisement<\/p>/.test(app));
  check('checkout goes through the signed-in session, not a username', /authFetch\('\/api\/stripe\/create-checkout-adfree'/.test(app)
    && !/create-checkout-adfree[^\n]*username/.test(app));
  check('a paid plan marks the device as from a subscription, and the mark is taken back when it ends',
    /localStorage\.setItem\(AD_FREE_SRC_KEY, 'sub'\)/.test(app) && /if \(localStorage\.getItem\(AD_FREE_SRC_KEY\) === 'sub'\)/.test(app));
  check('Settings offers the plan', /onclick="closeSettings\(\); openAdFree\(\);">Go ad-free</.test(html));

  server.close();
  console.log(failures ? `\n${failures} check(s) failed` : '\nall adfree-plan checks passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('THREW:', e && e.stack || e); process.exit(1); });
