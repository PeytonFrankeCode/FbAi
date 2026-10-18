// Does app.js dereference an element the markup no longer has?
//
// Deleting the retired Floor, Showcase and Pro-tools markup took the site's
// navigation down. switchView held
//
//   const sellerView = document.getElementById('seller-view');
//   ...
//   sellerView.classList.add('hidden');
//
// with no guard, so once seller-view was gone that line threw a TypeError on
// every call — after the nav tab had been highlighted and before the target
// view was shown. Every tab lit up and rendered nothing. `node --check` passes
// on it, the whole test suite passed on it, and it shipped.
//
// A blanket "every id app.js names must exist" rule does not work here: 154 do
// not, nearly all of them predating this and harmless, because they are only
// ever touched behind a guard or inside a function nothing calls. The bug is
// narrower and so is this check — an id absent from the markup AND dereferenced
// without a guard. That is the combination that throws.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));

// Elements app.js writes into the DOM itself are legitimately absent from
// index.html — look for the id being emitted in a template or markup string.
const injects = (id) =>
  app.includes(`id="${id}"`) || app.includes(`id='${id}'`) || app.includes(`id=\\"${id}\\"`);

// Module-level bindings only — declared at column 0, so the name means one
// thing for the whole file and a dereference of it can be attributed with
// certainty.
//
// Function-local bindings are deliberately out of scope. A first version
// included them and reported 1,500 offenders, all false: names like `gate`,
// `content` and `typePanel` are reused in dozens of functions, and without
// tracking scope every use of the name anywhere was blamed on whichever
// binding happened to match. A check that cries wolf 1,500 times is not a
// check — it is noise that the real one hides inside.
const bindings = [...app.matchAll(/^(?:const|let|var)\s+(\w+)\s*=\s*document\.getElementById\('([^']+)'\)/gm)]
  .map(m => ({ name: m[1], id: m[2] }));

const lines = app.split('\n');
const offenders = [];
for (const { name, id } of bindings) {
  if (ids.has(id) || injects(id)) continue;   // present, or created at runtime

  // Every dereference of this binding has to be defensive. Optional chaining
  // counts; so does a same-line truthiness guard, which is the shape the rest
  // of switchView already uses.
  const deref = new RegExp(`(?<![\\w.?])${name}\\.`);
  const guarded = new RegExp(`(?:if\\s*\\(\\s*${name}\\b|${name}\\s*&&|${name}\\?\\.)`);
  lines.forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, '');
    if (!deref.test(code)) return;
    if (guarded.test(code)) return;
    offenders.push({ name, id, line: i + 1, code: code.trim().slice(0, 78) });
  });
}

check('no element missing from index.html is dereferenced unguarded',
  offenders.length === 0,
  offenders.length
    ? `${offenders.length} would throw:\n        `
      + offenders.slice(0, 6).map(o => `app.js:${o.line}  ${o.id} -> ${o.code}`).join('\n        ')
    : `${bindings.length} bindings checked against ${ids.size} ids in the markup`);

// The specific regression, named. switchView is the one function every tab goes
// through, so anything that throws inside it takes the whole navigation with it
// rather than breaking one view.
{
  const start = app.indexOf('function switchView(');
  const body = start === -1 ? '' : app.slice(start, app.indexOf('\n}', start));
  const bare = [...body.matchAll(/^\s*(\w+)\.classList\.(?:add|remove)\(/gm)]
    .map(m => m[1])
    .filter(n => {
      const b = bindings.find(x => x.name === n);
      return b && !ids.has(b.id) && !injects(b.id);
    });
  check('  ...and switchView in particular touches nothing that is gone',
    bare.length === 0,
    bare.length ? `${bare.join(', ')} — every tab would break, not just one` : 'the navigation cannot be taken down this way');
}

// Boot has to route, not assume.
//
// index.html hardcodes which tab is active — <button class="nav-tab active"
// data-view="search"> — so Search looks selected before a line of JS runs. But
// the chrome that selection implies is not in the markup's hands: the Search /
// Grading Advisor / Scan Card strip ships with the `hidden` class and is
// revealed only by switchView('search'). While boot routed conditionally
// (`if (view) switchView(view)`), a first load at '/' matched no route and
// called nothing, so the strip stayed hidden under an active-looking tab. It
// appeared on the first trip to another tab and back, which is why it read as
// a rendering glitch rather than a missing call.
//
// Two sources of truth for what a view looks like is the actual defect, and
// the fix is for switchView to be the only one. So: boot calls it
// unconditionally, with a default.
{
  const start = app.indexOf('function bootFromPath(');
  const body = start === -1 ? '' : app.slice(start, app.indexOf('})();', start));
  check('boot routes a view on every load, not only on a recognised path',
    start !== -1 && /switchView\(/.test(body) && !/if\s*\(\s*view\s*\)\s*switchView/.test(body),
    start === -1
      ? 'bootFromPath is gone — nothing establishes the starting view'
      : (/if\s*\(\s*view\s*\)\s*switchView/.test(body)
        ? "guarded call: '/' falls through and the Search subtab strip stays hidden"
        : 'switchView owns the starting view'));
  check('  ...and names a fallback view for the paths no route matches',
    /\|\|\s*'search'/.test(body),
    /\|\|\s*'search'/.test(body) ? "'/' boots on Search" : 'no default — switchView(undefined) is not a view');
}

// The strip this was about. If it ever stops shipping hidden the checks above
// are no longer load-bearing, and this is the line that will say so.
check('  ...which is what the Search subtab strip depends on',
  /id="search-subtabs"[^>]*class="[^"]*\bhidden\b/.test(html)
    || !/id="search-subtabs"/.test(html),
  /id="search-subtabs"/.test(html)
    ? 'the strip is hidden in the markup and un-hidden by switchView alone'
    : 'the strip is gone from the markup');

// The phone menu (Oct 2026): one dropdown in place of tabs that scrolled off
// the edge. It opens the same .nav-tab buttons, so switchView stays the only
// thing that decides which view is active, and the menu names it.
{
  const vi = html.indexOf('<div class="nav-views" id="nav-views"');
  const views = vi < 0 ? '' : html.slice(vi, html.indexOf('<button class="nav-tab alerts-tab"', vi));
  check('the phone menu holds every view tab',
    ['search', 'checklist', 'rainbow', 'market', 'community', 'inventory'].every(v => views.includes(`data-view="${v}"`)));
  check('  ...but not the bell or the gear, which stay on the bar',
    !/alerts-tab|settings-tab/.test(views) && /alerts-tab/.test(html) && /settings-tab/.test(html));
  const sv = app.slice(app.indexOf('function switchView('), app.indexOf('function switchView(') + 1500);
  check('  ...and switchView names the view on the button and closes the menu',
    /_setNavMenuLabel\(activeTab\)/.test(sv) && /toggleNavMenu\(false\)/.test(sv));
}

// Search home (Oct 2026): the logo goes home, a search puts the market panel
// away (and "back to search" brings it back), and the box offers typeahead.
{
  check('the logo links to the home page', /<a href="\/" class="header-logo-link"[^>]*><img src="logo(-dark)?\.png"/.test(html));
  // The logo for the background it sits on (Oct 2026): logo.png's charcoal
  // vanished on the dark theme. Dark places carry logo-dark.png, the light
  // theme's green header logo-on-green.png, and light places logo.png.
  check('  ...in a version made for each background',
    /class="header-logo logo-for-dark"/.test(html) && /src="logo-on-green\.png"[^>]*class="header-logo logo-for-light"/.test(html)
    && /src="logo-dark\.png"[^>]*class="footer-logo-img logo-for-dark"/.test(html) && /src="logo\.png"[^>]*class="footer-logo-img logo-for-light"/.test(html)
    && ['logo-dark.png', 'logo-on-green.png'].every(f => fs.existsSync(path.join(__dirname, '..', 'public', f))));
  const hide = app.slice(app.indexOf('function _hideHomeContent('), app.indexOf('function _hideHomeContent(') + 400);
  check('every search hides the market panel, and going back shows it',
    /document\.body\.classList\.add\('has-searched'\)/.test(hide)
    && /document\.body\.classList\.remove\('has-searched'\)/.test(app)
    && /body\.has-searched #market-pulse \{ display: none/.test(css));
  check('the search box has its typeahead list, for sold and for sale alike',
    /id="search-suggest"/.test(html) && /aria-controls="search-suggest"/.test(html)
    && /\/api\/player-cards\?player=/.test(app) && !/currentMode[^\n]{0,40}_ssUpdate/.test(app));
}

// The theme switch (Oct 2026): a second, later set of .theme-toggle rules
// turned its sliding knob into a little switch of its own, which stuck out of
// the side of the pill. One set of rules for it, and it works from the keyboard.
check('the theme switch is styled once, so its knob stays inside the pill',
  (css.match(/^\.theme-toggle-thumb \{/gm) || []).length === 1 && !/\.theme-toggle-thumb::after/.test(css));
check('  ...and Enter or Space flips it, like a click',
  /id="theme-toggle"[^>]*onkeydown="[^"]*toggleTheme\(\)/.test(html));

// One menu on every screen (owner, Oct 2026): the drawer is not scoped to
// phones or to the saved layout setting, so desktop gets it too.
check('every screen gets the same drawer menu, not tabs on desktop',
  /^\.nav-menu-btn \{\n  display: inline-flex;/m.test(css) && !/\.nav-views \{ display: contents; \}/.test(css)
  && !/\.mobile-layout \.nav-views/.test(css));
check('  ...a drawer that slides in from the left over a backdrop',
  /\.nav-views \{[^}]*position: fixed;[^}]*transform: translateX\(-104%\);/.test(css)
  && /id="nav-backdrop" onclick="toggleNavMenu\(false\)"/.test(html)
  && /\.nav-bar\.menu-open \.nav-backdrop \{ opacity: 1; pointer-events: auto; \}/.test(css));
check('  ...that locks the page under it, closes on a swipe, and respects reduced motion',
  /classList\.toggle\('nav-locked'/.test(app) && /html\.nav-locked, html\.nav-locked body \{ overflow: hidden; \}/.test(css)
  && /prefers-reduced-motion: reduce\) \{\n  \.nav-views/.test(css));


// Swipe (owner, Oct 2026): right from the left half opens, left closes, the
// drawer following the finger. It leaves the iOS back edge, vertical scrolls,
// sideways-scrolling rows and form fields alone.
{
  const sw = app.slice(app.indexOf('(function navSwipe() {'), app.indexOf('function switchView(view) {'));
  check('the drawer opens and closes with a swipe that follows the finger',
    /document\.addEventListener\('touchmove'[\s\S]*\{ passive: false \}/.test(sw)
    && /drawer\.style\.transform = `translateX\(\$\{shown - g\.w\}px\)`/.test(sw)
    && /toggleNavMenu\(wantOpen\)/.test(sw)
    && /\.nav-bar\.nav-dragging \.nav-views \{ visibility: visible; transition: none; \}/.test(css));
  check('  ...and leaves the back edge, scrolling, sideways rows and fields alone',
    /const EDGE_SKIP = 20;/.test(sw) && /Math\.abs\(dx\) < Math\.abs\(dy\) \* 1\.3/.test(sw)
    && /scrollsSideways\(e\.target\)/.test(sw) && /input, textarea, select/.test(sw));
}

// The front page ad (owner, Oct 2026): below the market panel, above the
// searches and the about text; built by the app, never on an ad-free device.
{
  const ad = html.indexOf('id="home-ad"');
  check('the front page ad sits below the market panel and above the searches',
    ad > html.indexOf('id="market-pulse"') && ad < html.indexOf('id="recent-section"') && ad < html.indexOf('id="about-section"'));
  const m = app.slice(app.indexOf('function _mountHomeAd('), app.indexOf('function _mountHomeAd(') + 900);
  check('  ...with the owner\'s unit, pushed once, and left out where ads are off',
    /HOME_AD_SLOT = '4014689556'/.test(app) && /if \(_adFree\(\)\) \{ el\.remove\(\); return; \}/.test(m)
    && /el\.dataset\.mounted/.test(m) && /\n_mountHomeAd\(\);\n$/.test(app));
  check('  ...as a strip (horizontal, height set in CSS), not a full-width block',
    /data-ad-slot="\$\{HOME_AD_SLOT\}"`\n    \+ ' data-ad-format="horizontal"><\/ins>'/.test(app)
    && /\.home-ad \.home-ad-ins \{ display: block; width: 100%; max-width: 728px; height: 90px;/.test(css));
  check('  ...and an unfilled slot leaves no empty box', /\.home-ad:has\(ins\.adsbygoogle\[data-ad-status="unfilled"\]\) \{ display: none; \}/.test(css));
}

// The results ad (owner, Oct 2026): one full-width tile after the sixth card,
// one ad request per search, kept in place through the redraws that follow.
{
  const pr = app.slice(app.indexOf('function _placeResultsAd('), app.indexOf('function _placeResultsAd(') + 1200);
  check('search results carry one ad tile, after the sixth card, never on an ad-free device',
    /RESULTS_AD_SLOT = '9669331752'/.test(app) && /RESULTS_AD_AFTER = 6/.test(app) && /if \(_adFree\(\) \|\| !grid\) return;/.test(pr)
    && (app.match(/_placeResultsAd\(\);/g) || []).length >= 2);
  check('  ...asked of Google once a search, and put back after a redraw instead of re-asked',
    /new MutationObserver\([\s\S]{0,600}_seatResultsAd\(\)/.test(app) && (pr.match(/\.push\(\{\}\)/g) || []).length === 1);
  // "App In-Content" (Oct 2026): a second tile in a long list, asked once.
  const seat = app.slice(app.indexOf('function _seatResultsAd('), app.indexOf('function _seatResultsAd(') + 1400);
  check('  ...and a long list (15+ cards) a second, "App In-Content", after the thirteenth, asked once',
    /RESULTS_AD2_SLOT = '6056036132'/.test(app) && /RESULTS_AD2_AFTER = 13/.test(app) && /RESULTS_AD2_MIN = 15/.test(app)
    && /if \(!_resultsAd2Asked && el2\.isConnected\) \{\s*_resultsAd2Asked = true;/.test(seat));
  check('  ...the full width of the grid, collapsing when unfilled',
    /\.results-ad \{\n  grid-column: 1 \/ -1;/.test(css) && /\.results-ad:has\(ins\.adsbygoogle\[data-ad-status="unfilled"\]\) \{ display: none; \}/.test(css));
}

// The front panel (owner, Oct 2026): Deals right now is off it, and the total
// value card counts up to its number, says its period, and carries ornament
// that draws no data.
check('Deals right now is off the front page', !/parts\.push\('<div id="mp-deals"><\/div>'\)/.test(app) && !/\n  _mpLoadDeals\(/.test(app));
check('  ...and the total value counts up, names its period, honours reduced motion',
  /_mpCountUp\(body\.querySelector\('\.mp-figure-hero \.mp-figure-n'\)\)/.test(app) && /mp-hero-period/.test(app)
  && /prefers-reduced-motion: reduce\)'\)\.matches/.test(app) && /\.mp-figure-hero::after \{ animation: none; \}/.test(css));

// Pick a card (owner, Oct 2026): the dropdowns overlapped, wider than their
// columns. They may shrink, and the box lays them out two by two.
check('the Pick-a-card dropdowns shrink to their columns instead of overlapping',
  /\.tracked-checklist-grid > \* \{ min-width: 0; \}/.test(css)
  && /\.cl-picker-box \.tracked-checklist-grid \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}/.test(css));

// The checklist ad (owner, Oct 2026): a strip after the 25th card of an opened
// long set, asked of Google once per product, never on an ad-free device.
{
  const f = app.slice(app.indexOf('function _clSeatAd('), app.indexOf('function _clSeatAd(') + 1700);
  check('a long checklist set carries one strip after its 25th card',
    /CL_AD_SLOT = '5664392157'/.test(app) && /CL_AD_AFTER = 25/.test(app) && /rows\[CL_AD_AFTER - 1\]\.after\(_clAd\.el\)/.test(f)
    && /if \(_adFree\(\) \|\| !setEl\) return;/.test(f) && /loadChecklistSetValues\(setEl\); _clSeatAd\(setEl\);/.test(app));
  check('  ...asked of Google once per product, however often the tables redraw',
    /if \(_clAd\.data !== checklistData\)/.test(f) && /if \(fresh\) \{ try \{ \(window\.adsbygoogle/.test(f) && (f.match(/\.push\(\{\}\)/g) || []).length === 1);
  check('  ...a strip at a set height, collapsing when unfilled',
    /\.cl-ad \.cl-ad-ins \{ display: block; width: 100%; max-width: 728px; height: 90px;/.test(css)
    && /\.cl-ad-row:has\(ins\.adsbygoogle\[data-ad-status="unfilled"\]\) \{ display: none; \}/.test(css));
}

// The Market tab ad (owner, Oct 2026): a strip under the index chart, one per
// visit, put back after every redraw, asked of Google only when on screen.
{
  const f = app.slice(app.indexOf('function _mkSeatAd('), app.indexOf('function _mkSeatAd(') + 1100);
  check('the Market tab carries one strip under the index chart',
    /MARKET_AD_SLOT = '1900496256'/.test(app) && /<\/div>\n\n    <div id="market-ad-slot" class="market-ad-slot"><\/div>\n\n    <div class="market-basket"/.test(app)
    && /_mkRenderChart\(data\);\n  _mkSeatAd\(\);/.test(app) && /if \(_adFree\(\)\) return;/.test(f));
  check('  ...asked of Google once, and only once the tab is on screen',
    /if \(!_mkAd\.asked && slot\.offsetWidth > 0\)/.test(f) && (f.match(/\.push\(\{\}\)/g) || []).length === 1
    && /initMarketView\(\);\n      _mkSeatAd\(\);/.test(app));
}

// The login screen (owner, Oct 2026): form on the left, a drawn showcase on
// the right; phones stack the art on top as a short banner.
{
  const box = html.slice(html.indexOf('<div class="login-box">'), html.indexOf('<!-- Search top-tab subtab strip'));
  check('the login box splits into a form column and a showcase panel',
    /<div class="login-main">/.test(box) && /<aside class="login-showcase" aria-hidden="true">/.test(box)
    && box.indexOf('login-main') < box.indexOf('login-showcase')
    && ['login-heading', 'login-subtext', 'social-auth', 'login-form', 'auth-username', 'auth-password', 'auth-confirm', 'auth-email', 'auth-submit-btn', 'login-error', 'login-toggle-link']
      .every(id => box.indexOf(`id="${id}"`) > box.indexOf('login-main') && box.indexOf(`id="${id}"`) < box.indexOf('login-showcase')));
  check('  ...side by side on wide screens, art banner on top for phones',
    /grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1\.05fr\);/.test(css)
    && /@media \(max-width: 760px\) \{\n  \.login-box \{ grid-template-columns: 1fr;[^}]*\}\n  \.login-showcase \{ order: -1;/.test(css)
    && /\.mobile-layout \.login-showcase \{ order: -1;/.test(css)
    && /@media \(prefers-reduced-motion: reduce\) \{\n  \.ls-c3, \.ls-chart, \.ls-shine \{ animation: none; \}/.test(css));
}

// Get the app (owner, Oct 2026): a menu item until installed, a phone banner
// on a second visit that "Not now" snoozes, and steps for iPhone and Android.
{
  const f = app.slice(app.indexOf('// ===== Get the app'), app.indexOf('// ===== Get the app') + 6000);
  check('the menu offers Get the app, and an installed copy hides it',
    /<div class="nav-install-wrap hidden" id="nav-install">/.test(html) && html.indexOf('id="nav-install"') < html.indexOf('class="nav-tab alerts-tab"')
    && /display-mode: standalone/.test(f) && /navigator\.standalone === true/.test(f));
  check('  ...the how-to sheet has steps for both iPhone and Android',
    /class="install-steps" data-os="ios"/.test(html) && /class="install-steps" data-os="android"/.test(html)
    && /Add to Home Screen/.test(html) && /Add to Home screen/.test(html));
  check('  ...one-tap install where the browser offers it, banner on second visit after a first search, snoozed 21 days',
    /addEventListener\('beforeinstallprompt'/.test(f) && /e\.preventDefault\(\)/.test(f) && /p\.prompt\(\)/.test(f)
    && /if \(visits < 2 \|\| _lsGet\('chInstalled'\) === '1' \|\| !_hasSearched\(\)\) return;/.test(f) && /INSTALL_SNOOZE_MS = 21 \* 24 \* 3600 \* 1000/.test(f));
}

// Phone notifications (owner, Oct 2026): a row in the alerts panel; the
// service worker shows each push and opens the alerts page when tapped.
{
  const sw = fs.readFileSync(path.join(ROOT, 'public', 'sw.js'), 'utf8');
  const f = app.slice(app.indexOf('// ===== Phone notifications'), app.indexOf('// ===== Get the app'));
  check('the alerts panel has a notifications row, drawn when it opens',
    /<div id="push-row" class="push-row hidden" aria-live="polite"><\/div>/.test(html) && /_renderPushRow\(\);\n  const data = await _fetchAlerts\(\);/.test(app));
  check('  ...asking permission from the tap, subscribing with the server key',
    /const perm = await Notification\.requestPermission\(\);/.test(f) && /userVisibleOnly: true, applicationServerKey: _keyBytes\(key\)/.test(f) && /'\/api\/push\/subscribe'/.test(f));
  check('  ...pointing iPhones in a Safari tab at the home-screen steps',
    /if \(_installOS\(\) === 'ios' && !_isInstalled\(\)\) return \{ state: 'ios-install' \};/.test(f) && /openInstallApp\('push'\)/.test(f));
  check('  ...and signing out stops this device getting that account\'s alerts', /if \(token\) _pushForgetDevice\(token\);\n  disableUserSync\(\);/.test(app));
  check('the service worker shows every push and opens the page on tap',
    /addEventListener\('push'/.test(sw) && /event\.waitUntil\(self\.registration\.showNotification\(title, opts\)\)/.test(sw)
    && /addEventListener\('notificationclick'/.test(sw) && /if \(target\.origin !== self\.location\.origin\) return;/.test(sw));
}

// The owner's home-screen app (owner, Oct 2026): an iPhone web app has its own
// storage, with no local account copy, so the owner is also known by the email
// the server returns, on sign-in and on every load while signed in.
{
  const f = app.slice(app.indexOf('async function _refreshAdFreePlan('), app.indexOf('async function _refreshAdFreePlan(') + 1400);
  check("the owner's email from the server makes a fresh app ad-free",
    /if \(d && AD_FREE_EMAILS\.includes\(String\(d\.email \|\| ''\)\.toLowerCase\(\)\)\) \{\n      _markOwnerAdFree\(\);/.test(f)
    && /function _markOwnerAdFree\(\) \{\n  try \{ localStorage\.setItem\(AD_FREE_KEY, '1'\); localStorage\.removeItem\('chAdFreeSrc'\); \} catch \(_\) \{\}\n  _removeAds\(\);/.test(app));
  check('  ...checked on load while signed in, not only at sign-in',
    /updateAuthButton\(\);\n[^\n]*\n[^\n]*\nif \(getSessionToken\(\) && getCurrentUser\(\)\) _refreshAdFreePlan\(\);/.test(app));
  const man = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'manifest.json'), 'utf8'));
  check('  ...and the app icons carry a version, so phones fetch the padded ones',
    /href="\/apple-touch-icon\.png\?v=2"/.test(html) && man.icons.every(i => /\?v=2$/.test(i.src)));
}

// ---- Chart.js off the critical path (Oct 2026) -----------------------------
// 205 KB ran ahead of app.js, so no result and no ad appeared until it had.
{
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  check('Chart.js is not a blocking script on the page; app.js loads it when idle',
    !/<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/chart\.js/.test(html) && /function _loadChart\(\)/.test(app)
    && /requestIdleCallback[\s\S]{0,80}_loadChart\(\)/.test(app));
  check('  ...every chart waits for it and draws when it lands, or says it is unavailable if it fails',
    (app.match(/_chartReady\(/g) || []).length >= 6 && /s\.onerror = \(\) => \{ _chartFailed = true;/.test(app)
    && /s\.onload = \(\) => \{ _chartDefaults\(\); _chartScrubPlugin\(\);/.test(app));
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall dom-contract checks passed');
process.exit(failures ? 1 : 0);
