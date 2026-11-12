// Admin: who is on a plan or a free trial (owner, Nov 2026: "is there a way
// for me to see if someone has started a free trial?"). And a trial with no
// ?ref= link is counted in Growth too, as "No link".
'use strict';
process.env.NODE_ENV = 'test';
const path = require('path');
const fs = require('fs');
let failures = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`); if (!ok) failures++; };
const ROOT = path.join(__dirname, '..');
const SUBS_FILE = path.join(ROOT, 'data', 'subscriptions.json');
const before = fs.existsSync(SUBS_FILE) ? fs.readFileSync(SUBS_FILE) : null;
const S = require(path.join(ROOT, 'server.js'));

(async () => {
  const now = Date.now();
  S.saveSubscriptions({
    trialer: { plan: 'plus', tier: 'rookie', status: 'trialing', stripeCustomerId: 'cus_1', subscribedAt: new Date(now - 86400e3).toISOString(), trialUsed: new Date(now - 86400e3).toISOString(), ref: 'org-none' },
    payer: { plan: 'adfree', status: 'active', stripeCustomerId: 'cus_2', subscribedAt: new Date(now - 5 * 86400e3).toISOString(), period: 'yearly', ref: 'chatgpt-com' },
    owner: { plan: 'plus', status: 'active', permanent: true },
  });
  process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'test-admin';
  const server = S.app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const no = await fetch(base + '/api/admin/subscribers');
    check('the subscribers list is admin only', no.status === 401);
    const r = await (await fetch(base + '/api/admin/subscribers', { headers: { 'x-admin-key': process.env.ADMIN_PASSWORD, authorization: `Bearer ${process.env.ADMIN_PASSWORD}` } })).json();
    const t = (r.rows || []).find(x => x.username === 'trialer');
    check('it lists trials and paid plans, newest first, without permanent grants',
      r.total === 2 && r.trialing === 1 && r.active === 1 && r.rows[0].username === 'trialer' && !r.rows.some(x => x.username === 'owner'), JSON.stringify(r).slice(0, 300));
    check('  ...a trial says when it ends (7 days from the start) and its plan', t && t.plan === 'Huddle+ Rookie' && Math.abs(Date.parse(t.trialEnd) - (now - 86400e3 + 7 * 86400e3)) < 5000, JSON.stringify(t));
  } finally {
    server.close();
    if (before) fs.writeFileSync(SUBS_FILE, before); else { try { fs.unlinkSync(SUBS_FILE); } catch (_) {} }
  }
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  check('a trial or plan with no ?ref= link is counted in Growth as "No link"',
    /subs\[username\]\.ref = session\.metadata\?\.ref \|\| 'org-none'/.test(src) && /_growthBump\(data\.ref \|\| 'org-none', 'converted'\)/.test(src) && /GROWTH_ORGANIC = \['org-none'/.test(src));
  const admin = fs.readFileSync(path.join(ROOT, 'public', 'admin.html'), 'utf8');
  check('Admin shows the Subscribers section', /id="sub-rows"/.test(admin) && /loadSubscribers\(\);/.test(admin));
  console.log(failures ? `\n${failures} admin-subscribers check(s) failed` : '\nall admin-subscribers checks passed');
  process.exit(failures ? 1 : 0);
})();
