// The search loader: one search owns the screen, a hung request is retried,
// and nothing on screen waits on the main thread to keep moving.
//
// Each rule here fixed something measured in Chromium: the older of two
// searches hid the loader over a blank grid and then landed its results over
// the newer ones; a request that never answered spun forever; the skeleton's
// shimmer stalled whenever the page was busy; and an uncapped fade-in kept
// the 40th card invisible for two seconds after the results arrived.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

const js = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');
// A function's source, from its `function`/`async function` keyword to its
// closing brace (the body starts after the parameter list, which may hold `{}`).
const body = (name) => {
  let start = js.indexOf(`function ${name}(`);
  if (js.slice(start - 6, start) === 'async ') start -= 6;
  let depth = 0, i = js.indexOf(') {', start) + 2;
  for (; i < js.length; i++) { if (js[i] === '{') depth++; else if (js[i] === '}' && --depth === 0) break; }
  return js.slice(start, i + 1);
};

// ---- one search at a time ---------------------------------------------------
for (const [fn, api] of [['fetchVariants', 'variants'], ['fetchDirectSearch', 'direct-search'], ['performSearch', 'search']]) {
  const b = body(fn);
  check(`${fn} takes a number, fetches through _searchFetch, and renders only while it is the latest`,
    /const seq = _beginSearch\(\);/.test(b) && new RegExp(`_searchFetch\\(\`/api/${api}\\?`).test(b)
    && /if \(_searchStale\(seq\)\) return;/.test(b) && /if \(err\.superseded \|\| _searchStale\(seq\)\) return;/.test(b)
    && !/finally \{\s*setLoading\(false\)/.test(b));
}

// _searchFetch, run for real with a stand-in fetch.
const make = (fetchImpl, ms) => new Function('fetch', 'SEARCH_ATTEMPT_MS', 'state',
  `let _searchCtl = state.ctl; const _searchStale = (s) => s !== state.seq; ${body('_searchFetch')}; return _searchFetch;`)(fetchImpl, ms, make.state);
make.state = { seq: 1, ctl: new AbortController() };
const hangs = (signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));

(async () => {
  {
    let tries = 0;
    const f = make((url, init) => (++tries === 1 ? hangs(init.signal) : Promise.resolve({ ok: true, tries })), 40);
    const r = await f('/api/x', {}, 1);
    check('a try that hangs is given up on and retried once', r.tries === 2 && tries === 2);
  }
  {
    let tries = 0;
    const f = make((url, init) => { tries++; return hangs(init.signal); }, 30);
    const err = await f('/api/x', {}, 1).catch(e => e);
    check('  ...a second hang is reported plainly, not spun on', tries === 2 && /taking too long/.test(err.message), err.message);
  }
  {
    const f = make(() => Promise.reject(new TypeError('Failed to fetch')), 1000);
    const err = await f('/api/x', {}, 1).catch(e => e);
    check('  ...a dropped connection is retried, then reported', /Could not reach the server/.test(err.message));
  }
  {
    make.state = { seq: 1, ctl: new AbortController() };
    const f = make((url, init) => hangs(init.signal), 5000);
    const pending = f('/api/x', {}, 1).catch(e => e);
    make.state.seq = 2; make.state.ctl.abort();       // a newer search starts
    const err = await pending;
    check('a newer search cancels the older request, which then stays quiet', err.superseded === true);
  }

  // ---- the fade-in ----------------------------------------------------------
  const cardDelay = new Function(`${body('_cardDelay')}; return _cardDelay;`)();
  check('cards fade in with a capped stagger', cardDelay(0) === '0s' && cardDelay(10) === '0.3s' && cardDelay(40) === '0.3s');
  check('  ...used by every result grid', !/card\.style\.animationDelay = `\$\{\w+ \* 0\.0\d\}s`/.test(js)
    && (js.match(/card\.style\.animationDelay = _cardDelay\(/g) || []).length >= 10);

  // ---- nothing waits on the main thread ------------------------------------
  const rule = (sel) => [...css.matchAll(new RegExp(`(^|\\})\\s*${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'gm'))].map(m => m[2]).join(';');
  check('the skeleton shimmer slides with transform, not a repainted background',
    /animation:\s*shimmerSlide/.test(css) && /@keyframes shimmerSlide\s*\{\s*to\s*\{\s*transform:/.test(css)
    && !/animation:\s*shimmer\s/.test(rule('.skeleton-image') + rule('.skeleton-line')));
  check('the card fade-in starts part-way visible and leaves hover alone',
    /animation:\s*cardIn [^;]*backwards/.test(rule('.card')) && /@keyframes cardIn\s*\{\s*from\s*\{\s*opacity:\s*0\.35/.test(css));
  check('a long wait says it is still going', /Still searching, checking more sales/.test(js));
  check('reduced motion turns the shimmer off', /prefers-reduced-motion: reduce\)\s*\{[^}]*skeleton-image::after/.test(css));

  console.log(failures ? `\n${failures} check(s) failed` : '\nall search-loading checks passed');
  process.exit(failures ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
