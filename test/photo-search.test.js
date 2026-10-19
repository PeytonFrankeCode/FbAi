// The photo search on the front page searches by itself (owner, Oct 2026): a
// photo in, the best eBay match picked, its sold results loaded, with the
// other matches one tap away. The code under test is app.js's own, run in a
// sandbox against a stub page and a stub /api/scan-card.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const grab = (name) => { const i = src.indexOf(`function ${name}(`); const j = src.indexOf('\n}\n', i); return src.slice(i, j + 3); };
const between = (a, b) => { const i = src.indexOf(a); const j = src.indexOf(b, i); return src.slice(i, j); };

let failures = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`); if (!ok) failures++; };

// A stub page: every element the flow touches, with what it needs.
function makePage() {
  const els = {};
  const el = (id) => els[id] || (els[id] = {
    id, value: '', src: '', innerHTML: '', textContent: '', dataset: {},
    _cls: new Set(['hidden']),
    classList: { add(c) { this.o._cls.add(c); }, remove(c) { this.o._cls.delete(c); }, contains(c) { return this.o._cls.has(c); } },
    dispatchEvent() {}, focus() {}, form: null,
    querySelectorAll(sel) {
      if (sel !== '.scanner-match-card') return [];
      return [...this.innerHTML.matchAll(/data-title="([^"]*)"/g)].map(m => ({ dataset: { title: m[1].replace(/&amp;/g, '&') } }));
    },
  });
  for (const id of Object.keys(els)) els[id].classList.o = els[id];
  const document = {
    getElementById: (id) => { const e = el(id); e.classList.o = e; return e; },
    querySelector: () => ({ classList: { add() {}, remove() {} } }),
  };
  return { els, document, el };
}

function run(matches) {
  const page = makePage();
  const calls = { searches: [], fetches: 0 };
  const ctx = {
    document: page.document, console, Math, Number, String, Object, JSON, Set, Map, Array, RegExp, Event: function (t) { this.type = t; },
    alert: (m) => { calls.alert = m; },
    fetch: async () => { calls.fetches++; return { ok: true, json: async () => ({ matches }) }; },
    performSearch: () => { calls.searches.push(page.el('search-input').value); },
    _startCam() {}, _stopCam() {},
    _captureFrame: () => 'data:image/jpeg;base64,AAAA',
    addScannerCardToCollection() { calls.collection = true; },
    // Stand-ins for the title readers, which have their own tests.
    parsePrintRun: (t) => { const m = /\/(\d{1,4})\b/.exec(t); return m ? +m[1] : null; },
    detectGrade: (t) => { const m = /\b(PSA|BGS|SGC|CGC)\s*\d+(?:\.\d)?/i.exec(t); return m ? m[0].toUpperCase() : 'Raw / Ungraded'; },
  };
  vm.createContext(ctx);
  const code = [
    between('const SCAN_KEY_SETS = [', 'function _renderScannerMatches('),
    grab('escHtml'), grab('captureScanFill'),
    between('// ---- Scan-to-Fill Modal', '// ---- Pro+ Tools ----'),
    'this.api = { openScanFillModal, captureScanFill, reopenScanMatches, _bestScanMatchIndex, selectScanFillMatch, state: () => ({ last: _scanFillLastMatches }) };',
  ].join('\n');
  vm.runInContext(code, ctx);
  return { api: ctx.api, page, calls };
}

const T = (title) => ({ title, imageUrl: '' });
(async () => {
  // eBay's first match is the odd one out; the other four agree on the card.
  const matches = [
    T('2024 Panini Prizm Malik Nabers Silver #305 RC'),
    T('2024 Panini Prizm Bo Nix #309 Rookie RC Broncos'),
    T('2024 Prizm Bo Nix RC #309 Denver Broncos'),
    T('Bo Nix 2024 Panini Prizm #309 Rookie Card'),
    T('2024 Panini Prizm Bo Nix #309 RC PSA 10'),
  ];
  {
    const { api } = run(matches);
    check('the best match is the one the others agree on, not eBay\'s first', api._bestScanMatchIndex(matches) === 1, String(api._bestScanMatchIndex(matches)));
    check('  ...a lone match is the match', api._bestScanMatchIndex([T('2023 Prizm C.J. Stroud #339')]) === 0);
  }

  {
    const { api, page, calls } = run(matches);
    api.openScanFillModal('search-input');
    api.captureScanFill();
    await new Promise(r => setTimeout(r, 0));
    check('a photo in the front-page search searches with no tap on Find or a match',
      calls.fetches === 1 && calls.searches.length === 1 && /Bo Nix/.test(calls.searches[0]) && /Prizm/.test(calls.searches[0]),
      JSON.stringify(calls.searches));
    check('  ...the modal closes and the results say what the photo was searched as',
      page.el('scan-fill-modal').classList.contains('hidden') && !page.el('scan-search-note').classList.contains('hidden')
      && /Searched from your photo: <strong>2024 Bo Nix Prizm/.test(page.el('scan-search-note').innerHTML),
      page.el('scan-search-note').innerHTML);
    check('  ...with the other matches a tap away', /onclick="reopenScanMatches\(\)">Not this card\?/.test(page.el('scan-search-note').innerHTML));
    api.reopenScanMatches();
    check('"Not this card?" reopens the matches, all of them',
      !page.el('scan-fill-modal').classList.contains('hidden') && (page.el('scan-fill-matches-grid').innerHTML.match(/data-title=/g) || []).length === 5);
    api.selectScanFillMatch(0);
    check('  ...and picking another searches that one instead', /Malik Nabers/.test(calls.searches[1] || '') && /Nabers/.test(page.el('scan-search-note').innerHTML));
  }

  {
    const { api, calls } = run(matches);
    api.openScanFillModal('bulk-input', true);
    api.captureScanFill();
    await new Promise(r => setTimeout(r, 0));
    check('a bulk-pricer line still waits for the photo to be confirmed', calls.fetches === 0 && calls.searches.length === 0);
    api.openScanFillModal(null, false, 'collection');
    api.captureScanFill();
    await new Promise(r => setTimeout(r, 0));
    check('  ...and so does an add to My Cards', calls.fetches === 0 && !calls.collection);
  }

  check('the page carries the note\'s slot under the search bar, and the modal says it will search',
    /id="scan-search-note" class="scan-search-note hidden" role="status"/.test(html) && /search its sold prices for you/.test(html));
  check('a typed search clears the photo note', /if \(!_scanSearchPending\) _hideScanSearchNote\(\);/.test(src));

  if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
  console.log('\nall photo-search checks passed');
})().catch(e => { console.error(e); process.exit(1); });
