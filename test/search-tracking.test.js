// Every search is counted in Google Analytics.
//
// The site is a single page, so a search never loads a new one and GA saw a
// whole session as one pageview, whether it held one lookup or a hundred at a
// card show. This runs the real tracker from app.js against a stand-in gtag.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

const src = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const code = src.slice(src.indexOf('let _lastTracked = '), src.indexOf('async function fetchDirectSearch('));
function sandbox(search = '') {
  const sent = [];
  let now = 1_000_000;
  const ctx = {
    gtag: (...a) => sent.push(a), location: { origin: 'https://thecardhuddle.com', search },
    URLSearchParams, Date: { now: () => now }, String, encodeURIComponent,
  };
  vm.createContext(ctx);
  vm.runInContext(code + '\nthis._trackSearch = _trackSearch;', ctx);
  return { track: ctx._trackSearch, sent, tick: (ms) => { now += ms; } };
}

{
  const s = sandbox();
  s.track('2018 Donruss Josh Allen 304', 'sold');
  const [ev, pv] = s.sent;
  check('a search sends GA4\'s "search" event with the term',
    ev && ev[0] === 'event' && ev[1] === 'search' && ev[2].search_term === '2018 Donruss Josh Allen 304');
  check('  ...and a pageview of its own, at the search\'s own address',
    pv && pv[1] === 'page_view' && pv[2].page_location === 'https://thecardhuddle.com/?q=2018%20Donruss%20Josh%20Allen%20304');

  s.tick(20_000);
  s.track('1986 Topps Jerry Rice 161', 'sold');
  s.tick(20_000);
  s.track('1986 Topps Jerry Rice 161', 'sold');
  check('a hundred lookups are a hundred pageviews: each search counts, a repeat later too',
    s.sent.filter(a => a[1] === 'page_view').length === 3, `${s.sent.length} events`);

  s.tick(300);
  s.track('1986 topps jerry rice 161', 'sold');
  check('  ...but the same search fired twice at once is counted once',
    s.sent.filter(a => a[1] === 'page_view').length === 3);
  check('an empty search counts nothing', s.track('   ', 'sold') === false);
}
{
  const s = sandbox('?q=Brock%20Purdy');
  s.track('Brock Purdy', 'sold');
  check('a link opened on a search is not counted twice (the page load was its pageview)',
    s.sent.length === 1 && s.sent[0][1] === 'search');
  s.tick(5000);
  s.track('Bijan Robinson', 'sold');
  check('  ...and the searches after it are', s.sent.filter(a => a[1] === 'page_view').length === 1);
}
{
  const ctx = { location: { origin: '', search: '' }, URLSearchParams, Date, String, encodeURIComponent };
  vm.createContext(ctx);
  vm.runInContext(code + '\nthis._trackSearch = _trackSearch;', ctx);
  check('with GA blocked (no gtag), a search still runs', ctx._trackSearch('Josh Allen', 'sold') === false);
}
check('both search paths are counted, and a fallback retry is not a second lookup',
  /async function fetchDirectSearch\(query\) \{\s*_hideHomeContent\(\);\s*_trackSearch\(/.test(src)
  && /if \(!opts\.fallback\) _trackSearch\(query, 'version'\)/.test(src));

console.log(failures ? `\n${failures} check(s) failed` : '\nall search-tracking checks passed');
process.exit(failures ? 1 : 0);
