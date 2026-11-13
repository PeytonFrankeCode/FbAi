// Extra Huddle AI tokens (owner, Nov 2026: "buy a custom amount of credits if
// someone needs extra ... that roll over"). Huddle+ members only, $1.50 per
// million tokens, $3 to $100, never expire, spent after the month's plan.
'use strict';
process.env.NODE_ENV = 'test';
const path = require('path');
const fs = require('fs');
let failures = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`); if (!ok) failures++; };
const ROOT = path.join(__dirname, '..');
const S = require(path.join(ROOT, 'server.js'));

(async () => {
  check('$1.50 buys a million tokens: $3 is 2M, $15 is 10M',
    S.HUDDLE_TOPUP_PRICE_PER_M === 1.5 && S._topupCredit(3) === 2 && S._topupCredit(15) === 10);
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  check('extra tokens pay only for what runs past the month\'s plan',
    near(S._topupShare(1, 0.2, 3), 0) && near(S._topupShare(2.9, 0.2, 3), 0.1) && near(S._topupShare(3.5, 0.2, 3), 0.2),
    [S._topupShare(1, 0.2, 3), S._topupShare(2.9, 0.2, 3), S._topupShare(3.5, 0.2, 3)].join(', '));

  const server = S.app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const anon = await fetch(base + '/api/ai/topup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"usd":5}' });
    check('buying tokens needs an account (or says payments are off)', anon.status === 401 || anon.status === 503, String(anon.status));
  } finally { server.close(); }

  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  check('only Huddle+ members can buy, and only $3 to $100',
    /if \(!\(_huddleCredits\(username\) > 0\)\) return res\.status\(402\)/.test(src) && /HUDDLE_TOPUP_MIN = 3, HUDDLE_TOPUP_MAX = 100/.test(src));
  check('the balance is kept without an expiry, and a paid checkout is credited once',
    /archivePut\(k, next\)/.test(src) && /seen\.includes\(sessionId\)/.test(src) && /metadata\?\.kind === 'ai_topup'/.test(src) && /payment_status === 'paid'/.test(src));
  check('an answer is allowed past the plan when extra tokens are left, and charges them for the overflow',
    /spent >= credits && !\(credits > 0 && await _huddleTopup\(user\) > 0\)/.test(src) && /_topupShare\(spentBefore, cost, credits\)/.test(src));
  const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  check('Huddle AI shows the extra tokens and a Buy tokens button, and the out-of-tokens screen offers them',
    /\+\$\{escHtml\(_tok\(extra\)\)\} extra/.test(app) && /onclick="openHaiTopup\(\)">Buy tokens/.test(app) && /Buy extra tokens<\/button>/.test(app) && /function openHaiTopup\(\)/.test(app));
  console.log(failures ? `\n${failures} ai-topup check(s) failed` : '\nall ai-topup checks passed');
  process.exit(failures ? 1 : 0);
})();
