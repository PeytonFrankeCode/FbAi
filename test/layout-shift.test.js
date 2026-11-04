// The home page must not jump as it loads (owner, Nov 2026: PageSpeed CLS
// 0.32 desktop, 0.7 mobile). The market boards keep their room from the first
// paint and fill it in place; the announcement banner is shown before the
// first paint, not inserted after app.js runs.
const fs = require('fs');
const path = require('path');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
let failures = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`); if (!ok) failures++; };

const html = read('public/index.html'), app = read('public/app.js'), css = read('public/style.css');
check('the market boards start visible, with their room kept', /id="market-pulse" class="market-pulse mp-pending"/.test(html) && !/id="market-pulse" class="[^"]*\bhidden\b/.test(html));
check('  ...the room is the boards\' own height, on desktop and phones', /\.market-pulse\.mp-pending #mp-body\{min-height:1\d{3}px\}/.test(css) && /max-width:640px\)\{\.market-pulse\.mp-pending #mp-body\{min-height:1\d{3}px\}/.test(css));
check('  ...and the room is given back once they render, or the box hidden if they never come',
  /wrap\.classList\.remove\('hidden', 'mp-pending'\)/.test(app) && /wrap\.classList\.remove\('mp-pending'\);\s*wrap\.classList\.add\('hidden'\);/.test(app));
const htmlId = (html.match(/data-banner-id="([^"]+)"/) || [])[1];
const appId = (app.match(/const BANNER = \{\s*id: '([^']+)'/) || [])[1];
check('the banner is decided before the first paint, with the same dismissal key as app.js',
  /<script>try\{var sb=document\.getElementById\('site-banner'\)/.test(html) && htmlId && htmlId === appId, `${htmlId} vs ${appId}`);
// Phones: the phone layout from the first paint, by app.js's own rule.
const lp = (app.match(/const mode = saved \|\| \(window\.innerWidth <= (\d+) \? 'mobile' : 'desktop'\);/) || [])[1];
const hp = (html.match(/lm\|\|\(window\.innerWidth<=(\d+)\?'mobile':'desktop'\)\)==='mobile'\)document\.documentElement\.classList\.add\('mobile-layout'\)/) || [])[1];
check('the phone layout is set before the first paint, with app.js\'s breakpoint', lp && hp && lp === hp && html.indexOf("classList.add('mobile-layout')") < html.indexOf('style.css?v='), `${hp} vs ${lp}`);

check('the home page\'s Search tabs are shown before the first paint', /if\(location\.pathname==='\/'\)document\.getElementById\('search-subtabs'\)\.classList\.remove\('hidden'\)/.test(html));

console.log(failures ? `\n${failures} layout-shift check(s) failed` : '\nall layout-shift checks passed');
process.exit(failures ? 1 : 0);
