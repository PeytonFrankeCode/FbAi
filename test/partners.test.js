// Partner program (owner, Nov 2026: "15% and then we do like an apply
// program"): creators apply, the owner approves, and a partner earns 15% of
// every payment a member from their link makes in that member's first 12
// months, held 30 days, taken back on a refund, paid out once $25 is ready.
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
const DAY = 86400000;

(async () => {
  const server = S.app.listen(0), base = `http://127.0.0.1:${server.address().port}`;
  let ip = 30;
  const call = async (p, { method = 'GET', body, token, admin } = {}) => {
    const r = await fetch(base + p, { method, body: body ? JSON.stringify(body) : undefined, headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0',
      'cf-connecting-ip': `198.51.100.${ip++ % 250}`, ...(token ? { authorization: `Bearer ${token}` } : {}), ...(admin ? { 'x-admin-key': process.env.ADMIN_PASSWORD } : {}) } });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  try {
    const stamp = Date.now().toString(36), maker = 'creator' + stamp;
    const tok = (await call('/api/auth/register', { method: 'POST', body: { username: maker, password: 'secret123' } })).body.token;
    check('applying needs an account', (await call('/api/partners/apply', { method: 'POST', body: { name: 'x', channel: 'y', payout: 'a@b.co' } })).status === 401);
    check('...a name, where they post, and a PayPal email', (await call('/api/partners/apply', { method: 'POST', token: tok, body: { name: 'Card Guy', channel: 'https://youtube.com/@cardguy' } })).status === 400);
    let r = await call('/api/partners/apply', { method: 'POST', token: tok, body: { name: 'Card Guy', channel: 'https://youtube.com/@cardguy', audience: '5k', payout: 'cardguy@example.com' } });
    check('an application goes in as pending', r.status === 200 && r.body.partner.status === 'pending');
    check('...and cannot be sent twice', (await call('/api/partners/apply', { method: 'POST', token: tok, body: { name: 'Card Guy', channel: 'x', payout: 'cardguy@example.com' } })).status === 409);
    r = await call('/api/partners/me', { token: tok });
    check('the account page shows it pending, with the terms (15%, 12 months, 30-day hold, $25)', r.body.partner.status === 'pending' && r.body.terms.rate === 0.15 && r.body.terms.months === 12 && r.body.terms.holdDays === 30 && r.body.terms.minPayout === 2500 && !r.body.link);
    check('the admin list is admin only', (await call('/api/admin/partners')).status === 401);
    const adm = (await call('/api/admin/partners', { admin: true })).body;
    check('...and shows the application', adm.partners.some(p => p.user === maker && p.status === 'pending' && p.payout === 'cardguy@example.com'));
    check('a reserved link name is refused', (await call('/api/admin/partners/decide', { method: 'POST', admin: true, body: { user: maker, approve: true, code: 'org-search' } })).status === 400);
    const code = 'cardguy' + stamp;
    r = await call('/api/admin/partners/decide', { method: 'POST', admin: true, body: { user: maker, approve: true, code } });
    check('the owner approves, with a link name', r.status === 200 && r.body.partner.status === 'approved' && r.body.partner.code === code);
    r = await call('/api/partners/me', { token: tok });
    check('...and the partner gets their link and a dashboard', r.body.link && r.body.link.endsWith('/?ref=' + code) && r.body.totals && r.body.stats);

    // Earning.
    const now = Date.now();
    const subs = { member1: { plan: 'plus', tier: 'veteran', status: 'active', stripeCustomerId: 'cus_m1', ref: code },
      self: { plan: 'plus', tier: 'rookie', status: 'active', stripeCustomerId: 'cus_self', ref: code },
      other: { plan: 'plus', tier: 'rookie', status: 'active', stripeCustomerId: 'cus_o', ref: 'org-search' } };
    subs[maker] = { plan: 'plus', tier: 'rookie', status: 'active', stripeCustomerId: 'cus_maker', ref: code };
    let e = await S.partnerInvoicePaid({ id: 'in_1', customer: 'cus_m1', amount_paid: 999, charge: 'ch_1' }, subs, now);
    check('a paid invoice from a referred member earns the partner 15%', e.entry && e.partner === maker && e.entry.cents === 149 && e.entry.member === 'member1' && subs.member1.firstPaidAt);
    check('...once per invoice', (await S.partnerInvoicePaid({ id: 'in_1', customer: 'cus_m1', amount_paid: 999 }, subs, now)).skip === 'already counted');
    check('...not for the partner\'s own account', (await S.partnerInvoicePaid({ id: 'in_s', customer: 'cus_maker', amount_paid: 499 }, subs, now)).skip === 'own account');
    check('...not for a member who came another way', (await S.partnerInvoicePaid({ id: 'in_o', customer: 'cus_o', amount_paid: 499 }, subs, now)).skip === 'no partner link');
    check('...not for a $0 trial invoice', (await S.partnerInvoicePaid({ id: 'in_t', customer: 'cus_m1', amount_paid: 0 }, subs, now)).skip === 'nothing paid');
    check('...and not after the member\'s first 12 months', (await S.partnerInvoicePaid({ id: 'in_late', customer: 'cus_m1', amount_paid: 999 }, subs, now + 380 * DAY)).skip === 'past 12 months');
    await S.partnerInvoicePaid({ id: 'in_2', customer: 'cus_m1', amount_paid: 999, charge: 'ch_2' }, subs, now - 40 * DAY);
    const back = await S.partnerChargeRefunded({ invoice: 'in_2', amount: 999, amount_refunded: 999 });
    check('a refund takes the partner\'s share back', back.partner === maker && back.reversed === 149);
    const T = S._partnerTotals([{ member: 'a', cents: 1000, at: new Date(now - 40 * DAY).toISOString() }, { member: 'b', cents: 500, at: new Date(now - 2 * DAY).toISOString() },
      { member: 'a', cents: 300, at: new Date(now - 60 * DAY).toISOString(), paidAt: 'x' }, { member: 'c', cents: 200, at: new Date(now - 50 * DAY).toISOString(), reversedCents: 200 }], now);
    check('earnings are pending for 30 days, then ready; paid and refunded ones are kept apart', T.ready === 1000 && T.pending === 500 && T.paid === 300 && T.members === 2 && T.earned === 1800, JSON.stringify(T));
    check('nothing ready yet means nothing to mark paid', (await call('/api/admin/partners/paid', { method: 'POST', admin: true, body: { user: maker } })).status === 400);
  } finally { server.close(); }

  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8'), app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8'), admin = fs.readFileSync(path.join(ROOT, 'public', 'admin.html'), 'utf8'), html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  check('the Stripe webhook earns on invoice.paid and takes back on charge.refunded', /case 'invoice\.paid': \{\s*const r = await partnerInvoicePaid\(event\.data\.object, subs\);/.test(src) && /case 'charge\.refunded': \{\s*await partnerChargeRefunded\(event\.data\.object\);/.test(src));
  check('My Account has the program, the footer links to it, and Admin decides and pays', /id="acct-partner"/.test(app) && /function acctPartnerApply/.test(app) && /openPartners\(\)">Partner program<\/a>/.test(html)
    && /id="partner-rows"/.test(admin) && /loadPartners\(\);/.test(admin) && /\/api\/admin\/partners\/paid/.test(admin));
  console.log(failures ? `\n${failures} partner check(s) failed` : '\nall partner checks passed');
  process.exit(failures ? 1 : 0);
})();
