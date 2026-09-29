// Nothing may make the page wider than a phone.
//
// One element wider than the screen widens the whole document, and a phone
// browser then zooms the entire site out: text shrinks and anything pinned
// to the bottom of the screen falls below it. Each rule here fixed one case
// found by measuring the page in Chromium at 320px and 390px; the node test
// holds the rules, since the tests do not start a browser.
const fs = require('fs');
const path = require('path');

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
const rule = (sel) => [...css.matchAll(new RegExp(`(^|\\})\\s*${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'gm'))].map(m => m[2]).join(';');

check('the announcement wraps instead of being clipped (the site button rule sets nowrap)',
  /white-space:\s*normal/.test(rule('.site-banner-link')));
check('the footer links wrap onto more lines', /flex-wrap:\s*wrap/.test(rule('.footer-links')));
check('the search tabs never widen the page', /max-width:\s*min\(1200px,\s*100%\)/.test(rule('.page-subtabs'))
  && /overflow-x:\s*auto/.test(rule('.page-subtabs-inner')));
check('a sponsor\'s logo and coupon wrap within the screen', /max-width:\s*100%/.test(rule('.sponsor-item'))
  && /flex-wrap:\s*wrap/.test(rule('.sponsor-item')));

console.log(failures ? `\n${failures} check(s) failed` : '\nall mobile-fit checks passed');
process.exit(failures ? 1 : 0);
