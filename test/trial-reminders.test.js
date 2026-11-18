// Trial reminders (owner, Nov 2026: "you will be notified 3 and 2 days prior
// to your trial ending and set up an email"): a Huddle+ free trial gets an
// email 3 days and 2 days before it ends, each once, with the date, the price
// and a link to Manage billing. The plan picker promises it only when email
// is set up.
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
const DAY = 86400000;

(async () => {
  try {
    const now = Date.now();
    S.saveSubscriptions({
      tryer: { plan: 'plus', tier: 'veteran', status: 'trialing', trialEnd: now + 2.5 * DAY, email: 'tryer@example.com' },
      early: { plan: 'plus', tier: 'rookie', status: 'trialing', trialEnd: now + 6 * DAY, email: 'early@example.com' },
      noemail: { plan: 'plus', tier: 'rookie', status: 'trialing', trialEnd: now + 2.5 * DAY },
      paid: { plan: 'plus', tier: 'rookie', status: 'active', trialEnd: now + 2.5 * DAY, email: 'paid@example.com' },
    });
    const sent = [];
    const send = async (m) => { sent.push(m); return true; };
    let r = await S.trialReminders({ now, send });
    check('3 days before the end, a trial gets one reminder, to the email from checkout', r.ok && r.sent === 1 && sent.length === 1 && sent[0].to === 'tryer@example.com'
      && /ends in 3 days/.test(sent[0].subject), JSON.stringify(sent.map(m => [m.to, m.subject])));
    check('...saying the plan, the price that day, and where to cancel', /Huddle\+ Veteran/.test(sent[0].html) && /\$9\.99/.test(sent[0].html) && /\?plans=1/.test(sent[0].html)
      && /Cancel any time before then and you pay nothing/.test(sent[0].html) && /one more reminder/.test(sent[0].html));
    r = await S.trialReminders({ now: now + 3600e3, send });
    check('...only once', r.sent === 0 && sent.length === 1);
    r = await S.trialReminders({ now: now + DAY, send });
    check('a day later the 2-day reminder goes, and it says it is the last', r.sent === 1 && sent.length === 2 && /ends in 2 days/.test(sent[1].subject) && /last reminder/.test(sent[1].html));
    r = await S.trialReminders({ now: now + 2 * DAY, send });
    check('nothing for a trial too far out, a paid plan, or an account with no email', r.sent === 0 && !sent.some(m => /early|paid/.test(m.to))
      && S.loadSubscriptions().noemail.reminded && S.loadSubscriptions().noemail.reminded[3] === 'no-email');
    r = await S.trialReminders({ now });
    check('without email set up, nothing is sent', r.ok === false && /not configured/.test(r.reason));
    // The owner's test send (Admin > Subscribers): admin only, a real address, and email set up.
    process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'test-admin';
    const server = S.app.listen(0), base = `http://127.0.0.1:${server.address().port}`;
    const post = (body, key) => fetch(base + '/api/admin/test-email', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...(key ? { 'x-admin-key': key } : {}) } });
    const t1 = await post({ to: 'me@example.com' }), t2 = await post({ to: 'nope' }, process.env.ADMIN_PASSWORD), t3 = await post({ to: 'me@example.com' }, process.env.ADMIN_PASSWORD);
    server.close();
    check('a test email can be sent from Admin: admin only, a real address, and it says when email is not set up', t1.status === 401 && t2.status === 400 && t3.status === 503
      && /Email is not set up/.test((await t3.json()).error));
    const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8'), app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8'), wk = fs.readFileSync(path.join(ROOT, 'worker.js'), 'utf8');
    check('the checkout webhook keeps the email Stripe took', /const paidEmail = session\.customer_details && session\.customer_details\.email;/.test(src));
    check('the Worker runs it hourly', /typeof trialReminders === 'function' && aliasTick/.test(wk));
    check('the plan picker promises it only when email is on', /trialReminders: trialRemindersOn\(\)/.test(src) && /_planTrial\.remind \? `<span>\$\{tick\}We'll email you 3 days and 2 days before it ends<\/span>` : ''/.test(app));
  } finally {
    if (before) fs.writeFileSync(SUBS_FILE, before); else { try { fs.unlinkSync(SUBS_FILE); } catch (_) {} }
  }
  console.log(failures ? `\n${failures} trial-reminder check(s) failed` : '\nall trial-reminder checks passed');
  process.exit(failures ? 1 : 0);
})();
