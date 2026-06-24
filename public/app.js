// ---- Theme ----
(function initTheme() {
  const saved = localStorage.getItem('cardHuddleTheme');
  if (saved === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
  }
})();

// Checklist data is split: a tiny index lists all products, and each product
// lives in its own file fetched on demand. First-checklist-load is ~8KB
// instead of 12MB. Files are static assets served by Cloudflare's ASSETS
// binding and cached at the edge.
let _checklistsIndexCache = null;
const _checklistProductCache = {};

async function _fetchJson(url, label) {
  let res;
  try { res = await fetch(url); }
  catch (err) { throw new Error(`Network error loading ${label}: ${err.message}`); }
  if (!res.ok) {
    throw new Error(`Failed to load ${label} (HTTP ${res.status} ${res.statusText || ''})`);
  }
  const text = await res.text();
  if (!text) throw new Error(`${label} response was empty`);
  try { return JSON.parse(text); }
  catch (err) {
    throw new Error(`${label} was not valid JSON (got ${text.length} chars, starts with: ${text.slice(0, 80)})`);
  }
}

// Wrapper around fetch that automatically attaches the session token if present.
// Use for any endpoint that requires a logged-in user (e.g. Pro+ tools).
async function authFetch(url, options = {}) {
  const token = (typeof getSessionToken === 'function') ? getSessionToken() : null;
  const headers = { ...(options.headers || {}) };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return fetch(url, { ...options, headers });
}

// Mimics the old GET /api/checklists shape: { products: [...] }
async function fetchChecklistsList() {
  if (_checklistsIndexCache) return _checklistsIndexCache;
  _checklistsIndexCache = await _fetchJson('/data/checklists/index.json', 'checklist index');
  return _checklistsIndexCache;
}

// Mimics GET /api/checklists/:productId — fetches the per-product file.
async function fetchChecklistProduct(productId) {
  if (_checklistProductCache[productId]) return _checklistProductCache[productId];
  const product = await _fetchJson(`/data/checklists/${encodeURIComponent(productId)}.json`, `checklist product "${productId}"`);
  _checklistProductCache[productId] = product;
  return product;
}

// Build the variant list for one checklist set. The parser sometimes
// returns parallels:[{name:'Base'}] when no real parallels were detected;
// without this helper, every chip-rendering call site was prepending its
// own 'Base' on top of that one, producing two duplicate Base chips.
// Filters out any parallel that's just 'Base' (case-insensitive) so the
// prepended Base is the only one.
function buildVariants(set, baseExtras = {}) {
  const real = (set && Array.isArray(set.parallels))
    ? set.parallels.filter(p => p && String(p.name).trim().toLowerCase() !== 'base')
    : [];
  return [{ name: 'Base', printRun: '', ...baseExtras }, ...real];
}

// Read a fetch Response as JSON, tolerating empty bodies and HTML error pages.
// Throws an informative Error if the body isn't parseable so the caller's
// catch block can render a useful message instead of a cryptic engine error.
async function safeJson(response) {
  const text = await response.text();
  if (!text) {
    if (response.ok) return {};
    throw new Error(`The server returned an empty ${response.status} response. Please try again in a moment.`);
  }
  try {
    return JSON.parse(text);
  } catch (_) {
    // HTML body on an API endpoint = upstream (Cloudflare/Workers) error page.
    // Show something the user can act on instead of pasting the raw HTML.
    const head = text.slice(0, 64).toLowerCase();
    if (head.includes('<!doctype html') || head.includes('<html')) {
      throw new Error(`The server is having trouble (HTTP ${response.status}). Try again in a minute — if it keeps failing, the worker may need to be redeployed.`);
    }
    const snippet = text.slice(0, 160).replace(/\s+/g, ' ').trim();
    throw new Error(`Server returned non-JSON (HTTP ${response.status}): ${snippet}`);
  }
}

function toggleTheme() {
  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  if (isLight) {
    document.documentElement.removeAttribute('data-theme');
    localStorage.setItem('cardHuddleTheme', 'dark');
  } else {
    document.documentElement.setAttribute('data-theme', 'light');
    localStorage.setItem('cardHuddleTheme', 'light');
  }
}

function showSettings() {
  updateSettingsSubscription();
  loadScrapeDoStatus();
  document.getElementById('settings-overlay').classList.remove('hidden');
}

// ---- scrape.do API keys (per-user, server-stored, multi-key) ----
// Sold-data searches require the user's own scrape.do token. Users can
// save multiple keys to combine the monthly quotas of multiple scrape.do
// accounts — the server round-robins across them and falls back when one
// hits a quota. We never display the full token; the API only ever
// returns a masked hint per key.

async function loadScrapeDoStatus() {
  const loading = document.getElementById('settings-scrapedo-loading');
  const listEl = document.getElementById('settings-scrapedo-list');
  const emptyEl = document.getElementById('settings-scrapedo-empty');
  const addEl = document.getElementById('settings-scrapedo-add');
  const testBtn = document.getElementById('settings-scrapedo-test-all');
  const testResult = document.getElementById('settings-scrapedo-test-result');
  if (!loading || !listEl || !emptyEl || !addEl) return;
  loading.style.display = '';
  listEl.classList.add('hidden');
  emptyEl.classList.add('hidden');
  addEl.classList.add('hidden');
  if (testBtn) testBtn.style.display = 'none';
  if (testResult) testResult.classList.add('hidden');

  const user = typeof getCurrentUser === 'function' ? getCurrentUser() : null;
  if (!user) {
    loading.style.display = 'none';
    emptyEl.classList.remove('hidden');
    emptyEl.textContent = 'Log in to add your scrape.do keys.';
    return;
  }

  try {
    const token = getSessionToken();
    const res = await fetch('/api/user/scrape-do-key', {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      cache: 'no-store',
    });
    const data = await safeJson(res);
    loading.style.display = 'none';
    addEl.classList.remove('hidden');

    const keys = (data && Array.isArray(data.keys)) ? data.keys : [];
    if (keys.length === 0) {
      emptyEl.classList.remove('hidden');
      emptyEl.textContent = 'No keys yet — add one below to enable Sold searches.';
    } else {
      listEl.classList.remove('hidden');
      listEl.innerHTML = '';
      keys.forEach(k => {
        const li = document.createElement('li');
        li.className = 'settings-scrapedo-row';
        const added = k.addedAt ? new Date(k.addedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
        li.innerHTML = `
          <div class="settings-scrapedo-row-info">
            <div class="settings-scrapedo-row-label">${escHtml(k.label || 'Untitled')}</div>
            <div class="settings-scrapedo-row-hint">${escHtml(k.hint || '••••••••')}${added ? ' &middot; added ' + escHtml(added) : ''}</div>
          </div>
          <button class="settings-sub-btn settings-sub-cancel settings-scrapedo-row-remove"
                  data-label="${escHtml(k.label || '')}" onclick="removeScrapeDoKey(this.dataset.label)">Remove</button>`;
        listEl.appendChild(li);
      });
      if (testBtn) testBtn.style.display = '';
    }
  } catch (err) {
    loading.style.display = 'none';
    emptyEl.classList.remove('hidden');
    emptyEl.textContent = `Couldn't load: ${(err && err.message) || err}`;
  }
}

async function saveScrapeDoKey() {
  const input = document.getElementById('settings-scrapedo-input');
  const labelEl = document.getElementById('settings-scrapedo-label');
  const saveBtn = document.getElementById('settings-scrapedo-save');
  const value = (input && input.value || '').trim();
  const label = (labelEl && labelEl.value || '').trim();
  if (!value) { alert('Paste your scrape.do token first.'); return; }
  if (value.length < 8) { alert('That token looks too short. Double-check and try again.'); return; }
  const token = getSessionToken();
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Adding…'; }
  try {
    const res = await fetch('/api/user/scrape-do-key', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ apiKey: value, label }),
    });
    const data = await safeJson(res);
    if (!res.ok) throw new Error((data && (data.error || data.detail)) || `HTTP ${res.status}`);
    input.value = '';
    if (labelEl) labelEl.value = '';
    await loadScrapeDoStatus();
    showApiKeySuccessModal();
  } catch (err) {
    alert(`Couldn't save your scrape.do key:\n\n${(err && err.message) || err}`);
  } finally {
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Add Key'; }
  }
}

function toggleScrapeDoVideo() {
  const wrap = document.getElementById('settings-scrapedo-video-wrap');
  const btn = document.getElementById('settings-scrapedo-video-toggle');
  if (!wrap) return;
  const opening = wrap.classList.contains('hidden');
  wrap.classList.toggle('hidden');
  if (btn) btn.innerHTML = opening ? '&#9660; Hide video' : '&#9654; Watch: how to get your API key';
  const video = document.getElementById('settings-scrapedo-video');
  if (!opening && video) video.pause();
}

// "You're all set" beat after saving a key, then fade into the
// sold-data petition ask.
let apiKeySuccessTimer = null;
function showApiKeySuccessModal() {
  const modal = document.getElementById('apikey-success-modal');
  const step1 = document.getElementById('apikey-success-step1');
  const step2 = document.getElementById('apikey-success-step2');
  if (!modal || !step1 || !step2) return;
  step1.classList.remove('apikey-success-step--hidden');
  step2.classList.add('apikey-success-step--hidden');
  modal.classList.remove('hidden');
  clearTimeout(apiKeySuccessTimer);
  apiKeySuccessTimer = setTimeout(() => {
    step1.classList.add('apikey-success-step--hidden');
    step2.classList.remove('apikey-success-step--hidden');
  }, 2000);
}

function closeApiKeySuccessModal() {
  clearTimeout(apiKeySuccessTimer);
  const modal = document.getElementById('apikey-success-modal');
  if (modal) modal.classList.add('hidden');
}

async function removeScrapeDoKey(label) {
  if (!confirm(`Remove the scrape.do key "${label || 'this key'}"?`)) return;
  const token = getSessionToken();
  try {
    const res = await fetch('/api/user/scrape-do-key?label=' + encodeURIComponent(label || ''), {
      method: 'DELETE',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) {
      const data = await safeJson(res);
      throw new Error((data && data.error) || `HTTP ${res.status}`);
    }
    await loadScrapeDoStatus();
  } catch (err) {
    alert(`Couldn't remove the key:\n\n${(err && err.message) || err}`);
  }
}

// Hit /api/debug/sold and render a per-key health summary so users can
// see at a glance which of their saved keys are working and which are
// out of quota or bad.
async function testScrapeDoKey() {
  const btn = document.getElementById('settings-scrapedo-test-all');
  const out = document.getElementById('settings-scrapedo-test-result');
  if (!btn || !out) return;
  const origText = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Testing…';
  out.classList.remove('hidden');
  out.className = 'settings-scrapedo-test-result settings-scrapedo-test-result--pending';
  out.textContent = 'Asking scrape.do for sold listings of "Patrick Mahomes 2017 Prizm"…';
  try {
    const token = getSessionToken();
    const res = await fetch('/api/debug/sold?q=' + encodeURIComponent('Patrick Mahomes 2017 Prizm'), {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      cache: 'no-store',
    });
    const data = await safeJson(res);
    if (res.status === 401 && data && data.noKey) {
      out.className = 'settings-scrapedo-test-result settings-scrapedo-test-result--bad';
      out.textContent = 'No keys on file — add one above first.';
      return;
    }
    const perKey = Array.isArray(data && data.perKey) ? data.perKey : null;
    if (!perKey) {
      out.className = 'settings-scrapedo-test-result settings-scrapedo-test-result--bad';
      out.textContent = `✗ ${(data && data.error) || 'Unexpected response from debug endpoint.'}`;
      return;
    }
    const anyOk = perKey.some(r => r.itemCount > 0);
    out.className = 'settings-scrapedo-test-result ' + (anyOk
      ? 'settings-scrapedo-test-result--ok'
      : 'settings-scrapedo-test-result--bad');
    const rows = perKey.map((r, i) => {
      const label = escHtml(r.label || 'Key');
      if (r.badKey) return `<div>✗ <strong>${label}</strong> &mdash; rejected by scrape.do</div>`;
      if (r.quotaExceeded) return `<div>⚠ <strong>${label}</strong> &mdash; quota / rate-limit hit</div>`;
      if (r.error) return `<div>✗ <strong>${label}</strong> &mdash; ${escHtml(r.error)}</div>`;
      if (r.itemCount > 0) {
        const sample = r.firstItem || {};
        const title = (sample.title || '').slice(0, 60);
        const price = sample.price ? `$${parseFloat(sample.price).toFixed(2)}` : '?';
        return `<div>✓ <strong>${label}</strong> &mdash; ${r.itemCount} listings (sample: "${escHtml(title)}" at ${escHtml(price)})</div>`;
      }
      // 0 listings — surface diagnostics so we can see *why*.
      const d = r.debug || {};
      const diagBits = [];
      if (d.httpStatus) diagBits.push(`HTTP ${d.httpStatus}`);
      if (typeof d.bytes === 'number') diagBits.push(`${d.bytes.toLocaleString()} bytes`);
      const cc = d.classCounts || {};
      const counts = [];
      if (cc.sItem)    counts.push(`${cc.sItem} s-item`);
      if (cc.sCard)    counts.push(`${cc.sCard} s-card`);
      if (cc.srpItem)  counts.push(`${cc.srpItem} srp-results__item`);
      if (cc.srpRiver) counts.push(`${cc.srpRiver} srp-river`);
      if (counts.length) diagBits.push(counts.join(' / '));
      else if (cc.sItem === 0 && cc.sCard === 0 && cc.srpItem === 0)
        diagBits.push('no listing markup at all');
      if (d.looksLikeJson) diagBits.push('response is JSON, not HTML');
      if (d.looksLikeBlock) diagBits.push('looks like a bot-check / block page');
      const detail = diagBits.length ? ' (' + diagBits.join(' · ') + ')' : '';
      const titleLine = d.title ? `<div class="settings-scrapedo-subline">page title: <em>${escHtml(d.title)}</em></div>` : '';
      const canonicalLine = d.canonical ? `<div class="settings-scrapedo-subline">canonical: <code>${escHtml(d.canonical)}</code></div>` : '';
      const fc = d.firstCardExtract;
      const extractLine = fc
        ? `<div class="settings-scrapedo-subline">first card &mdash; `
          + `link: ${fc.link ? '✓' : '✗'} · title: ${fc.title ? '✓ <em>' + escHtml(fc.title) + '</em>' : '✗'} · `
          + `price: ${fc.price ? '✓ <code>' + escHtml(fc.price) + '</code>' : '✗'} · img: ${fc.hasImg ? '✓' : '✗'}`
          + (Array.isArray(fc.classes) && fc.classes.length
              ? `<br>classes: <code>${escHtml(fc.classes.join(' '))}</code>`
              : '')
          + `</div>`
        : '';
      const blockBlock = d.firstBlock
        ? `<details class="settings-scrapedo-snippet"><summary>Show first matched card block</summary><div class="settings-scrapedo-snippet-bar"><button type="button" class="settings-scrapedo-copy" onclick="copyDiagSnippet(this)">Copy all</button></div><pre>${escHtml(d.firstBlock)}</pre></details>`
        : '';
      const snippet = d.snippet
        ? `<details class="settings-scrapedo-snippet"><summary>Show page-head snippet</summary><div class="settings-scrapedo-snippet-bar"><button type="button" class="settings-scrapedo-copy" onclick="copyDiagSnippet(this)">Copy all</button></div><pre>${escHtml(d.snippet)}</pre></details>`
        : '';
      return `<div>✗ <strong>${label}</strong> &mdash; parsed 0 listings${detail}.${titleLine}${canonicalLine}${extractLine}${blockBlock}${snippet}</div>`;
    });
    out.innerHTML = rows.join('');
  } catch (err) {
    out.className = 'settings-scrapedo-test-result settings-scrapedo-test-result--bad';
    out.textContent = `✗ ${(err && err.message) || err}`;
  } finally {
    btn.disabled = false;
    btn.textContent = origText;
  }
}

// Copy the full text of a diagnostic snippet's <pre> to the clipboard. The
// <pre> is visually capped/scrollable so users can't always select all of it
// by hand — this grabs the complete (server-truncated) block in one click.
async function copyDiagSnippet(btn) {
  const details = btn.closest('details');
  const pre = details && details.querySelector('pre');
  if (!pre) return;
  const text = pre.textContent || '';
  const orig = btn.textContent;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      // Fallback for non-secure contexts / older browsers.
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    btn.textContent = 'Copied!';
  } catch (_) {
    btn.textContent = 'Copy failed';
  }
  setTimeout(() => { btn.textContent = orig; }, 1500);
}

// Backward-compat shim — old call sites delegate here. Clears all keys.
async function clearScrapeDoKey() {
  if (!confirm('Remove ALL of your scrape.do API keys? Sold searches will stop working until you add one again.')) return;
  const token = getSessionToken();
  try {
    const res = await fetch('/api/user/scrape-do-key', {
      method: 'DELETE',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) {
      const data = await safeJson(res);
      throw new Error((data && data.error) || `HTTP ${res.status}`);
    }
    await loadScrapeDoStatus();
  } catch (err) {
    alert(`Couldn't remove your keys:\n\n${(err && err.message) || err}`);
  }
}

function updateSettingsSubscription() {
  const desc = document.getElementById('settings-sub-desc');
  const action = document.getElementById('settings-sub-action');
  if (desc) desc.textContent = 'Every feature is unlocked and free. Enjoy!';
  if (action) action.innerHTML = '';
}

function closeSettings() {
  document.getElementById('settings-overlay').classList.add('hidden');
}

// Close settings on overlay click
document.addEventListener('click', function(e) {
  const overlay = document.getElementById('settings-overlay');
  if (e.target === overlay) closeSettings();
});

// ---- Tracked Cards / Card Alerts ----

function initTrackedView() {
  const gate = document.getElementById('tracked-gate');
  const content = document.getElementById('tracked-content');
  const upgradeBtn = document.getElementById('tracked-upgrade-btn');
  const user = getCurrentUser();

  // Logged-out users still need a sign-in nudge — every other gate is open.
  if (!user) {
    if (gate) {
      gate.classList.remove('hidden');
      gate.querySelector('h3').textContent = 'Sign in to track cards';
      gate.querySelector('p').textContent = 'Log in or create an account to start tracking cards.';
      if (upgradeBtn) { upgradeBtn.textContent = 'Log In'; upgradeBtn.onclick = () => showLogin(); }
    }
    if (content) content.classList.add('hidden');
    return;
  }

  if (gate) gate.classList.add('hidden');
  if (content) content.classList.remove('hidden');
  loadTrackedCards();
  initTrackedChecklistPicker();
}

// ---- Tracked Cards: "Pick from checklist" picker ----
// Mirrors the data layout of the Checklists/Set-Completion picker but
// stays self-contained inside the Tracked Cards tab. Fills the same
// `#tracked-query-input` that the free-text mode uses, so the form's
// submit handler doesn't need to know which mode generated the value.

let _trackedCl = {
  ready: false,
  productCache: null, // resolved fetchChecklistProduct() data for the current product
};

function switchTrackedMode(mode) {
  document.querySelectorAll('.tracked-mode-tab').forEach(b => {
    b.classList.toggle('active', b.dataset.mode === mode);
  });
  const typePanel = document.getElementById('tracked-mode-type');
  const clPanel = document.getElementById('tracked-mode-checklist');
  if (!typePanel || !clPanel) return;
  typePanel.classList.toggle('hidden', mode !== 'type');
  clPanel.classList.toggle('hidden', mode !== 'checklist');
  // Clear the query input on mode-switch so a stale value from the
  // previous mode doesn't accidentally get submitted.
  const q = document.getElementById('tracked-query-input');
  if (q) q.value = '';
  const prev = document.getElementById('tracked-cl-preview');
  if (prev) prev.textContent = '';
}

async function initTrackedChecklistPicker() {
  if (_trackedCl.ready) return;
  const productSel = document.getElementById('tracked-cl-product');
  if (!productSel) return;
  try {
    const idx = await fetchChecklistsList();
    const products = (idx && idx.products) || [];
    productSel.innerHTML = '<option value="">Select a product…</option>' + products
      .map(p => `<option value="${escHtml(p.id)}">${escHtml(p.name || p.id)}</option>`)
      .join('');
    _trackedCl.ready = true;
  } catch (err) {
    productSel.innerHTML = '<option value="">(failed to load checklists)</option>';
    console.warn('[tracked] checklist list load failed:', err && err.message || err);
  }
  // Wire all four comboboxes once the underlying selects exist.
  ['tracked-cl-product-combo', 'tracked-cl-set-combo', 'tracked-cl-card-combo', 'tracked-cl-variant-combo']
    .forEach(id => {
      const el = document.getElementById(id);
      if (el) { setupCombobox(el); syncComboboxFromSelect(el); }
    });
}

// Resync each combobox's visible label after we mutate its underlying
// <select>. setupCombobox handles user-driven changes via its own click
// path, but cascading dropdowns mutate the select programmatically and
// need this nudge to repaint the button text.
function syncTrackedCombo(id) {
  syncComboboxFromSelect(document.getElementById(id));
}

async function onTrackedChecklistProduct() {
  const productId = document.getElementById('tracked-cl-product').value;
  const setSel = document.getElementById('tracked-cl-set');
  const cardSel = document.getElementById('tracked-cl-card');
  const variantSel = document.getElementById('tracked-cl-variant');
  resetTrackedSelect(setSel, 'Set…');
  resetTrackedSelect(cardSel, 'Player / card…');
  resetTrackedSelect(variantSel, 'Parallel…');
  setSel.disabled = true;
  cardSel.disabled = true;
  variantSel.disabled = true;
  _trackedCl.productCache = null;
  syncTrackedCombo('tracked-cl-product-combo');
  syncTrackedCombo('tracked-cl-set-combo');
  syncTrackedCombo('tracked-cl-card-combo');
  syncTrackedCombo('tracked-cl-variant-combo');
  applyTrackedComboDisabled();
  trackedClUpdateQuery();
  if (!productId) return;
  try {
    const product = await fetchChecklistProduct(productId);
    _trackedCl.productCache = product;
    const sets = (product && product.sets) || [];
    setSel.innerHTML = '<option value="">Set…</option>' + sets
      .map((s, i) => `<option value="${i}">${escHtml(s.name || `Set ${i + 1}`)}</option>`)
      .join('');
    setSel.disabled = sets.length === 0;
    syncTrackedCombo('tracked-cl-set-combo');
    applyTrackedComboDisabled();
  } catch (err) {
    resetTrackedSelect(setSel, '(failed to load product)');
    console.warn('[tracked] product load failed:', err && err.message || err);
  }
}

function onTrackedChecklistSet() {
  const setIdx = parseInt(document.getElementById('tracked-cl-set').value, 10);
  const cardSel = document.getElementById('tracked-cl-card');
  const variantSel = document.getElementById('tracked-cl-variant');
  resetTrackedSelect(cardSel, 'Player / card…');
  resetTrackedSelect(variantSel, 'Parallel…');
  cardSel.disabled = true;
  variantSel.disabled = true;
  syncTrackedCombo('tracked-cl-set-combo');
  syncTrackedCombo('tracked-cl-card-combo');
  syncTrackedCombo('tracked-cl-variant-combo');
  applyTrackedComboDisabled();
  trackedClUpdateQuery();
  if (!Number.isFinite(setIdx) || !_trackedCl.productCache) return;
  const set = _trackedCl.productCache.sets[setIdx];
  if (!set) return;
  const cards = set.cards || [];
  cardSel.innerHTML = '<option value="">Player / card…</option>' + cards
    .map((c, i) => {
      const label = [c.number && `#${c.number}`, c.player].filter(Boolean).join(' ');
      return `<option value="${i}">${escHtml(label || `Card ${i + 1}`)}</option>`;
    })
    .join('');
  cardSel.disabled = cards.length === 0;
  syncTrackedCombo('tracked-cl-card-combo');
  applyTrackedComboDisabled();
}

function onTrackedChecklistCard() {
  const setIdx = parseInt(document.getElementById('tracked-cl-set').value, 10);
  const cardIdx = parseInt(document.getElementById('tracked-cl-card').value, 10);
  const variantSel = document.getElementById('tracked-cl-variant');
  resetTrackedSelect(variantSel, 'Parallel…');
  variantSel.disabled = true;
  syncTrackedCombo('tracked-cl-card-combo');
  syncTrackedCombo('tracked-cl-variant-combo');
  applyTrackedComboDisabled();
  trackedClUpdateQuery();
  if (!_trackedCl.productCache || !Number.isFinite(setIdx) || !Number.isFinite(cardIdx)) return;
  const set = _trackedCl.productCache.sets[setIdx];
  const card = set && set.cards && set.cards[cardIdx];
  if (!card) return;
  const variants = buildVariants(set, { printRun: card.printRun || '' });
  if (!variants.length) {
    variantSel.innerHTML = '<option value="">(no variants)</option>';
    syncTrackedCombo('tracked-cl-variant-combo');
    return;
  }
  variantSel.innerHTML = variants
    .map((v, i) => `<option value="${i}">${escHtml(v.name)}${v.printRun ? ` /${escHtml(v.printRun)}` : ''}</option>`)
    .join('');
  variantSel.disabled = false;
  // Auto-select first variant so a single card pick already produces a
  // usable query.
  variantSel.selectedIndex = 0;
  syncTrackedCombo('tracked-cl-variant-combo');
  applyTrackedComboDisabled();
  trackedClUpdateQuery();
}

function onTrackedChecklistVariant() {
  syncTrackedCombo('tracked-cl-variant-combo');
  trackedClUpdateQuery();
}

// Combobox toggles are buttons that don't know about the hidden
// <select>'s disabled state, so we mirror it ourselves whenever the
// cascade changes.
function applyTrackedComboDisabled() {
  ['set', 'card', 'variant'].forEach(suffix => {
    const sel = document.getElementById(`tracked-cl-${suffix}`);
    const combo = document.getElementById(`tracked-cl-${suffix}-combo`);
    if (!sel || !combo) return;
    combo.classList.toggle('cl-combo-disabled', !!sel.disabled);
    const toggle = combo.querySelector('.cl-combo-toggle');
    if (toggle) toggle.disabled = !!sel.disabled;
  });
}

function trackedClUpdateQuery() {
  const q = document.getElementById('tracked-query-input');
  const preview = document.getElementById('tracked-cl-preview');
  if (!q) return;
  const product = _trackedCl.productCache;
  const setIdx = parseInt(document.getElementById('tracked-cl-set').value, 10);
  const cardIdx = parseInt(document.getElementById('tracked-cl-card').value, 10);
  const variantIdx = parseInt(document.getElementById('tracked-cl-variant').value, 10);
  if (!product || !Number.isFinite(setIdx) || !Number.isFinite(cardIdx)) {
    q.value = '';
    if (preview) preview.textContent = '';
    return;
  }
  const set = product.sets[setIdx];
  const card = set && set.cards && set.cards[cardIdx];
  if (!set || !card) return;
  const variants = buildVariants(set, { printRun: card.printRun || '' });
  const variant = Number.isFinite(variantIdx) ? variants[variantIdx] : variants[0];
  const baseQuery = buildChecklistQuery(card.player, product.year, product.brand, set.name, set.category, (variant && variant.printRun) || card.printRun || '');
  const variantName = (variant && variant.name && variant.name.toLowerCase() !== 'base') ? variant.name : '';
  const fullQuery = variantName ? `${baseQuery} ${variantName}`.trim() : baseQuery;
  q.value = fullQuery;
  if (preview) preview.textContent = fullQuery ? `Will track: ${fullQuery}` : '';
}

function resetTrackedSelect(el, placeholder) {
  if (!el) return;
  el.innerHTML = `<option value="">${escHtml(placeholder)}</option>`;
}

// ---- Reusable "Pick from checklist" modal ----
// Any feature can call openChecklistPicker({ onPick: ctx => ... }) to
// drop a modal in front of the user. ctx contains:
//   { query: 'full search string',
//     player, year, brand, setName, parallel, printRun, cardNumber }
// onPick is called when the user clicks "Use this card".

let _clPicker = { callback: null, productCache: null, ready: false };

async function openChecklistPicker(opts) {
  opts = opts || {};
  _clPicker.callback = typeof opts.onPick === 'function' ? opts.onPick : null;
  const subtitle = document.getElementById('cl-picker-subtitle');
  if (subtitle && opts.subtitle) subtitle.textContent = opts.subtitle;
  // Reset state on each open so we don't bleed selections from the last
  // feature into this one.
  resetClPicker();
  document.getElementById('cl-picker-modal').classList.remove('hidden');
  if (!_clPicker.ready) await initClPicker();
}

function closeChecklistPicker() {
  document.getElementById('cl-picker-modal').classList.add('hidden');
  _clPicker.callback = null;
}

function confirmChecklistPicker() {
  const ctx = clPickerContext();
  if (!ctx || !ctx.query) return;
  const cb = _clPicker.callback;
  closeChecklistPicker();
  if (cb) cb(ctx);
}

async function initClPicker() {
  const productSel = document.getElementById('cl-picker-product');
  if (!productSel) return;
  try {
    const idx = await fetchChecklistsList();
    const products = (idx && idx.products) || [];
    productSel.innerHTML = '<option value="">Select a product…</option>' + products
      .map(p => `<option value="${escHtml(p.id)}">${escHtml(p.name || p.id)}</option>`)
      .join('');
    _clPicker.ready = true;
  } catch (err) {
    productSel.innerHTML = '<option value="">(failed to load checklists)</option>';
    console.warn('[clpicker] checklist list load failed:', err && err.message || err);
  }
  ['cl-picker-product-combo', 'cl-picker-set-combo', 'cl-picker-card-combo', 'cl-picker-variant-combo']
    .forEach(id => {
      const el = document.getElementById(id);
      if (el) { setupCombobox(el); syncComboboxFromSelect(el); }
    });
}

function resetClPicker() {
  const setSel = document.getElementById('cl-picker-set');
  const cardSel = document.getElementById('cl-picker-card');
  const variantSel = document.getElementById('cl-picker-variant');
  const productSel = document.getElementById('cl-picker-product');
  if (productSel) productSel.value = '';
  resetTrackedSelect(setSel, 'Set…');
  resetTrackedSelect(cardSel, 'Player / card…');
  resetTrackedSelect(variantSel, 'Parallel…');
  if (setSel) setSel.disabled = true;
  if (cardSel) cardSel.disabled = true;
  if (variantSel) variantSel.disabled = true;
  _clPicker.productCache = null;
  ['product', 'set', 'card', 'variant'].forEach(s => syncComboboxFromSelect(document.getElementById(`cl-picker-${s}-combo`)));
  applyClPickerDisabled();
  clPickerUpdatePreview();
}

async function onClPickerProduct() {
  const productId = document.getElementById('cl-picker-product').value;
  const setSel = document.getElementById('cl-picker-set');
  const cardSel = document.getElementById('cl-picker-card');
  const variantSel = document.getElementById('cl-picker-variant');
  resetTrackedSelect(setSel, 'Set…');
  resetTrackedSelect(cardSel, 'Player / card…');
  resetTrackedSelect(variantSel, 'Parallel…');
  setSel.disabled = true;
  cardSel.disabled = true;
  variantSel.disabled = true;
  _clPicker.productCache = null;
  ['set', 'card', 'variant'].forEach(s => syncComboboxFromSelect(document.getElementById(`cl-picker-${s}-combo`)));
  applyClPickerDisabled();
  clPickerUpdatePreview();
  if (!productId) return;
  try {
    const product = await fetchChecklistProduct(productId);
    _clPicker.productCache = product;
    const sets = (product && product.sets) || [];
    setSel.innerHTML = '<option value="">Set…</option>' + sets
      .map((s, i) => `<option value="${i}">${escHtml(s.name || `Set ${i + 1}`)}</option>`)
      .join('');
    setSel.disabled = sets.length === 0;
    syncComboboxFromSelect(document.getElementById('cl-picker-set-combo'));
    applyClPickerDisabled();
  } catch (err) {
    resetTrackedSelect(setSel, '(failed to load product)');
    console.warn('[clpicker] product load failed:', err && err.message || err);
  }
}

function onClPickerSet() {
  const setIdx = parseInt(document.getElementById('cl-picker-set').value, 10);
  const cardSel = document.getElementById('cl-picker-card');
  const variantSel = document.getElementById('cl-picker-variant');
  resetTrackedSelect(cardSel, 'Player / card…');
  resetTrackedSelect(variantSel, 'Parallel…');
  cardSel.disabled = true;
  variantSel.disabled = true;
  syncComboboxFromSelect(document.getElementById('cl-picker-card-combo'));
  syncComboboxFromSelect(document.getElementById('cl-picker-variant-combo'));
  applyClPickerDisabled();
  clPickerUpdatePreview();
  if (!Number.isFinite(setIdx) || !_clPicker.productCache) return;
  const set = _clPicker.productCache.sets[setIdx];
  if (!set) return;
  const cards = set.cards || [];
  cardSel.innerHTML = '<option value="">Player / card…</option>' + cards
    .map((c, i) => {
      const label = [c.number && `#${c.number}`, c.player].filter(Boolean).join(' ');
      return `<option value="${i}">${escHtml(label || `Card ${i + 1}`)}</option>`;
    })
    .join('');
  cardSel.disabled = cards.length === 0;
  syncComboboxFromSelect(document.getElementById('cl-picker-card-combo'));
  applyClPickerDisabled();
}

function onClPickerCard() {
  const setIdx = parseInt(document.getElementById('cl-picker-set').value, 10);
  const cardIdx = parseInt(document.getElementById('cl-picker-card').value, 10);
  const variantSel = document.getElementById('cl-picker-variant');
  resetTrackedSelect(variantSel, 'Parallel…');
  variantSel.disabled = true;
  syncComboboxFromSelect(document.getElementById('cl-picker-variant-combo'));
  applyClPickerDisabled();
  clPickerUpdatePreview();
  if (!_clPicker.productCache || !Number.isFinite(setIdx) || !Number.isFinite(cardIdx)) return;
  const set = _clPicker.productCache.sets[setIdx];
  const card = set && set.cards && set.cards[cardIdx];
  if (!card) return;
  const variants = buildVariants(set, { printRun: card.printRun || '' });
  if (!variants.length) {
    variantSel.innerHTML = '<option value="">(no variants)</option>';
    syncComboboxFromSelect(document.getElementById('cl-picker-variant-combo'));
    return;
  }
  variantSel.innerHTML = variants
    .map((v, i) => `<option value="${i}">${escHtml(v.name)}${v.printRun ? ` /${escHtml(v.printRun)}` : ''}</option>`)
    .join('');
  variantSel.disabled = false;
  variantSel.selectedIndex = 0; // auto-pick first parallel so one card pick = usable query
  syncComboboxFromSelect(document.getElementById('cl-picker-variant-combo'));
  applyClPickerDisabled();
  clPickerUpdatePreview();
}

function onClPickerVariant() {
  syncComboboxFromSelect(document.getElementById('cl-picker-variant-combo'));
  clPickerUpdatePreview();
}

function applyClPickerDisabled() {
  ['set', 'card', 'variant'].forEach(suffix => {
    const sel = document.getElementById(`cl-picker-${suffix}`);
    const combo = document.getElementById(`cl-picker-${suffix}-combo`);
    if (!sel || !combo) return;
    combo.classList.toggle('cl-combo-disabled', !!sel.disabled);
    const toggle = combo.querySelector('.cl-combo-toggle');
    if (toggle) toggle.disabled = !!sel.disabled;
  });
}

function clPickerContext() {
  const product = _clPicker.productCache;
  const setIdx = parseInt(document.getElementById('cl-picker-set').value, 10);
  const cardIdx = parseInt(document.getElementById('cl-picker-card').value, 10);
  const variantIdx = parseInt(document.getElementById('cl-picker-variant').value, 10);
  if (!product || !Number.isFinite(setIdx) || !Number.isFinite(cardIdx)) return null;
  const set = product.sets[setIdx];
  const card = set && set.cards && set.cards[cardIdx];
  if (!set || !card) return null;
  const variants = buildVariants(set, { printRun: card.printRun || '' });
  const variant = Number.isFinite(variantIdx) ? variants[variantIdx] : variants[0];
  const baseQuery = buildChecklistQuery(card.player, product.year, product.brand, set.name, set.category, (variant && variant.printRun) || card.printRun || '');
  const variantName = (variant && variant.name && variant.name.toLowerCase() !== 'base') ? variant.name : '';
  const fullQuery = variantName ? `${baseQuery} ${variantName}`.trim() : baseQuery;
  return {
    query: fullQuery,
    player: card.player,
    year: product.year,
    brand: product.brand,
    productName: product.name || product.id,
    setName: set.name || '',
    setCategory: set.category || '',
    parallel: variantName,
    printRun: (variant && variant.printRun) || card.printRun || '',
    cardNumber: card.number || '',
  };
}

function clPickerUpdatePreview() {
  const preview = document.getElementById('cl-picker-preview');
  const pickBtn = document.getElementById('cl-picker-pick');
  const ctx = clPickerContext();
  if (preview) preview.textContent = ctx ? `Will use: ${ctx.query}` : '';
  if (pickBtn) pickBtn.disabled = !ctx;
}

// Convenience: drop a "Pick from checklist" button right before the
// given input. The button opens the picker and fills the input on
// confirm. Used by the simple single-input features (Auto Pricer,
// Market Movers, Grading Advisor, Title Generator).
function attachChecklistPickerButton(inputId, opts) {
  opts = opts || {};
  const input = document.getElementById(inputId);
  if (!input || input._clPickerWired) return;
  input._clPickerWired = true;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'cl-pick-trigger';
  btn.textContent = opts.label || 'Pick from checklist';
  btn.addEventListener('click', () => {
    openChecklistPicker({
      subtitle: opts.subtitle || 'Pick a card to fill in the search.',
      onPick: (ctx) => {
        input.value = ctx.query;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        if (opts.afterPick) opts.afterPick(ctx);
      },
    });
  });
  // Place the button immediately after the input (or its wrapper if
  // any). Falls back to the input's parent.
  const target = input.closest('.pp-search-row') || input.parentElement;
  if (target) target.appendChild(btn);
}

async function loadTrackedCards() {
  const user = getCurrentUser();
  if (!user) return;

  const listEl = document.getElementById('tracked-list');
  try {
    const res = await fetch(`/api/alerts?username=${encodeURIComponent(user)}`);
    const data = await res.json();
    if (!data.alerts || data.alerts.length === 0) {
      listEl.innerHTML = '<p class="alerts-empty">No tracked cards yet. Add one above or use the bell icon in Checklists.</p>';
      return;
    }
    listEl.innerHTML = data.alerts.map(a => {
      const date = new Date(a.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      const thresholdBadge = a.priceThreshold && a.priceCondition
        ? `<span class="tracked-threshold-badge">${a.priceCondition === 'below' ? '↓' : '↑'} $${parseFloat(a.priceThreshold).toFixed(2)}</span>`
        : '';
      return `
        <div class="tracked-card-item" data-id="${a.id}">
          <div class="tracked-card-icon">&#128276;</div>
          <div class="tracked-card-info">
            <div class="tracked-card-query">${escHtml(a.label)}${thresholdBadge}</div>
            <div class="tracked-card-date">Tracking since ${date}</div>
          </div>
          <button class="tracked-card-search" onclick="switchView('search'); document.getElementById('search-input').value='${escHtml(a.query).replace(/'/g, "\\'")}'; document.getElementById('search-form').dispatchEvent(new Event('submit'))" title="Search eBay">&#128269;</button>
          <button class="tracked-card-delete" onclick="deleteTrackedCard('${a.id}')" title="Stop tracking">&times;</button>
        </div>`;
    }).join('');
  } catch (err) {
    listEl.innerHTML = '<p class="alerts-empty">Failed to load tracked cards.</p>';
  }
}

// Form handler for tracked view
document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('tracked-add-form');
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const user = getCurrentUser();
      const users = getUsers();
      const userData = users[user.toLowerCase()];
      const email = userData?.email;
      const input = document.getElementById('tracked-query-input');
      const query = input.value.trim();
      const conditionEl = document.getElementById('tracked-condition');
      const thresholdEl = document.getElementById('tracked-threshold');
      const priceCondition = conditionEl ? conditionEl.value || null : null;
      const priceThreshold = thresholdEl && thresholdEl.value ? parseFloat(thresholdEl.value) : null;
      const errEl = document.getElementById('tracked-error');
      errEl.classList.add('hidden');

      if (!email) {
        errEl.textContent = 'Add an email to your account to receive alerts (sign up again with email).';
        errEl.classList.remove('hidden');
        return;
      }

      try {
        const res = await fetch('/api/alerts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: user, email, query, label: query, priceThreshold, priceCondition }),
        });
        const data = await res.json();
        if (res.status === 402 || (data && data.upgrade)) {
          showUpgrade(data.error || 'Price Alerts is a Pro feature.');
          return;
        }
        if (!res.ok) {
          errEl.textContent = data.error || 'Failed to track card';
          errEl.classList.remove('hidden');
          return;
        }
        input.value = '';
        if (conditionEl) conditionEl.value = '';
        if (thresholdEl) thresholdEl.value = '';
        loadTrackedCards();
      } catch (err) {
        errEl.textContent = 'Network error. Try again.';
        errEl.classList.remove('hidden');
      }
    });
  }
});

async function deleteTrackedCard(id) {
  const user = getCurrentUser();
  if (!user) return;
  try {
    await fetch(`/api/alerts/${id}?username=${encodeURIComponent(user)}`, { method: 'DELETE' });
    loadTrackedCards();
  } catch (err) {
    console.error('Failed to delete tracked card:', err);
  }
}

async function addAlertForCard(query) {
  const user = getCurrentUser();
  if (!user) { showLogin(); return; }
  const users = getUsers();
  const userData = users[user.toLowerCase()];
  if (!userData?.email) {
    alert('Add an email to your account to use card tracking. Sign up again with an email address.');
    return;
  }
  try {
    const res = await fetch('/api/alerts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: user, email: userData.email, query, label: query }),
    });
    const data = await res.json();
    if (res.status === 402 || (data && data.upgrade)) {
      showUpgrade(data.error || 'Price Alerts is a Pro feature.');
      return;
    }
    if (res.ok) {
      // Visual feedback — find the button that triggered this
      const btns = document.querySelectorAll('.cl-alert-btn');
      btns.forEach(btn => {
        if (btn.getAttribute('onclick')?.includes(query.replace(/'/g, "\\'"))) {
          btn.classList.add('cl-alert-active');
          btn.title = 'Tracking this card';
        }
      });
    } else {
      alert(data.error || 'Failed to track card');
    }
  } catch (err) {
    alert('Network error');
  }
}

// ---- App ----
const form = document.getElementById('search-form');
const input = document.getElementById('search-input');
const btn = document.getElementById('search-btn');
const loading = document.getElementById('loading');
const loadingText = loading.querySelector('span');
const errorMsg = document.getElementById('error-message');
const grid = document.getElementById('results-grid');
const meta = document.getElementById('search-meta');
const suggestionsSection = document.getElementById('suggestions-section');
const chartSection = document.getElementById('chart-section');
const chartCanvas = document.getElementById('price-chart');
const variantsSection = document.getElementById('variants-section');
const variantsGrid = document.getElementById('variants-grid');
const variantsTitle = document.getElementById('variants-title');
const backBtn = document.getElementById('back-btn');
const approxSection = document.getElementById('approx-section');
const skeletonGrid = document.getElementById('skeleton-grid');
const sortControls = document.getElementById('sort-controls');
const recentSection = document.getElementById('recent-section');
const recentChips = document.getElementById('recent-chips');
const similarSection = document.getElementById('similar-section');
const similarGrid = document.getElementById('similar-grid');
const similarTitle = document.getElementById('similar-title');
let priceChart = null;

// State
let cachedVariants = null;
let currentVariantQuery = '';
let currentSearchMode = 'variants'; // 'variants' or 'direct'
let currentMode = 'sold'; // 'forsale' or 'sold'
let currentResults = []; // store results for sorting
let currentResultMode = 'sold'; // mode the visible results actually came from ('sold' | 'forsale'), which may differ from the toggle when we fall back
let currentGradeFilter = 'all'; // 'all' or a grade label from detectGrade()

// ---- Recent Searches (localStorage) ----
const MAX_RECENT = 6;

function getRecentSearches() {
  try {
    return JSON.parse(localStorage.getItem('recentSearches') || '[]');
  } catch { return []; }
}

function addRecentSearch(query) {
  let recent = getRecentSearches();
  recent = recent.filter(q => q.toLowerCase() !== query.toLowerCase());
  recent.unshift(query);
  if (recent.length > MAX_RECENT) recent = recent.slice(0, MAX_RECENT);
  localStorage.setItem('recentSearches', JSON.stringify(recent));
  renderRecentSearches();
}

function removeRecentSearch(query) {
  let recent = getRecentSearches();
  recent = recent.filter(q => q !== query);
  localStorage.setItem('recentSearches', JSON.stringify(recent));
  renderRecentSearches();
}

function renderRecentSearches() {
  const recent = getRecentSearches();
  if (recent.length === 0) {
    recentSection.classList.add('hidden');
    return;
  }
  recentChips.innerHTML = '';
  recent.forEach(query => {
    const chip = document.createElement('button');
    chip.className = 'recent-chip';
    chip.innerHTML = `${escHtml(query)}<span class="remove-recent">&times;</span>`;
    chip.addEventListener('click', (e) => {
      if (e.target.classList.contains('remove-recent')) {
        e.stopPropagation();
        removeRecentSearch(query);
        return;
      }
      input.value = query;
      suggestionsSection.classList.add('hidden');
      recentSection.classList.add('hidden');
      fetchDirectSearch(query);
    });
    recentChips.appendChild(chip);
  });
  recentSection.classList.remove('hidden');
}

// Show recent on load
renderRecentSearches();

// ---- Mode Tabs ----
function updatePriceFilterVisibility() {
  const wrap = document.getElementById('price-filter');
  if (!wrap) return;
  wrap.classList.toggle('hidden', currentMode !== 'forsale');
}

document.querySelectorAll('.mode-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    const newMode = tab.dataset.mode;
    if (newMode === currentMode) return;
    currentMode = newMode;
    document.querySelectorAll('.mode-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    cachedVariants = null; // clear cached variants since mode changed
    updatePriceFilterVisibility();
    // Re-run current search if there's an active query
    const query = input.value.trim();
    if (query) fetchDirectSearch(query);
  });
});

// Initial visibility + clear button wiring
updatePriceFilterVisibility();
document.getElementById('price-filter-clear')?.addEventListener('click', () => {
  document.getElementById('min-price').value = '';
  document.getElementById('max-price').value = '';
  const query = input.value.trim();
  if (query && currentMode === 'forsale') fetchDirectSearch(query);
});
// Re-run search on Enter in the price fields
['min-price', 'max-price'].forEach(id => {
  document.getElementById(id)?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const query = input.value.trim();
      if (query && currentMode === 'forsale') fetchDirectSearch(query);
    }
  });
});

// Reads current price filter values; returns { min, max } with non-finite
// values omitted. Used by every search call site so a user-set range
// propagates through variants → search → load-more.
function getPriceFilter() {
  const minRaw = document.getElementById('min-price')?.value;
  const maxRaw = document.getElementById('max-price')?.value;
  const out = {};
  const min = parseFloat(minRaw);
  const max = parseFloat(maxRaw);
  if (Number.isFinite(min) && min > 0) out.min = min;
  if (Number.isFinite(max) && max > 0) out.max = max;
  return out;
}

// ---- Sort Controls ----
document.querySelectorAll('.sort-btn').forEach(sortBtn => {
  sortBtn.addEventListener('click', () => {
    document.querySelectorAll('.sort-btn').forEach(b => b.classList.remove('active'));
    sortBtn.classList.add('active');
    applySortToResults(sortBtn.dataset.sort);
  });
});

function applySortToResults(sortType) {
  const base = getGradeFilteredResults();
  if (!base.length) return;

  let sorted = [...base];
  switch (sortType) {
    case 'price-low':
      sorted.sort((a, b) => (parseFloat(a.price) || 0) - (parseFloat(b.price) || 0));
      break;
    case 'price-high':
      sorted.sort((a, b) => (parseFloat(b.price) || 0) - (parseFloat(a.price) || 0));
      break;
    case 'date':
      sorted.sort((a, b) => new Date(b.soldDate || 0) - new Date(a.soldDate || 0));
      break;
    case 'grade':
      // Best grade first, raw last; ties keep their original relative order.
      sorted.sort((a, b) => gradeSortRank(a.title) - gradeSortRank(b.title));
      break;
    default: // 'default' — keep original order
      sorted = [...base];
  }

  // Re-render cards only (keep stats bar)
  const statsBar = grid.querySelector('.stats-bar');
  grid.innerHTML = '';
  if (statsBar) grid.appendChild(statsBar);
  if (currentMode === 'sold' && sortType === 'default') {
    renderGradeGroups(grid, sorted);
  } else {
    sorted.forEach((item, i) => {
      const card = buildCard(item);
      card.style.animationDelay = `${i * 0.05}s`;
      grid.appendChild(card);
    });
  }
  injectPromotedCards(grid);
}

// ---- Known sets/parallels for client-side detection ----
const CLIENT_KNOWN_SETS = ['Prizm', 'Select', 'Mosaic', 'Optic', 'Donruss', 'Bowman', 'Topps', 'Chronicles',
  'Contenders', 'Score', 'Immaculate', 'Spectra', 'Fleer', 'Hoops', 'Revolution', 'Absolute',
  'Certified', 'Playoff', 'National Treasures'];
const CLIENT_KNOWN_PARALLELS = ['Silver', 'Gold', 'Blue', 'Green', 'Red', 'Purple', 'Orange', 'Pink',
  'Holo', 'Shimmer', 'Hyper', 'Concourse', 'Rainbow', 'Scope', 'Disco', 'Neon', 'Wave', 'Camo',
  'Tie-Dye', 'Black', 'White', 'Aqua', 'Teal', 'Emerald', 'Ruby', 'Sapphire', 'Copper'];

// ---- Parse card details from title ----
const NOISE_WORDS = ['panini', 'psa', 'bgs', 'sgc', 'rc', 'rookie', 'card', 'football', 'nfl',
  'gem', 'mint', 'nm', 'mt', 'nm-mt', 'near', 'better', 'graded', 'raw', 'ungraded', 'auto', 'refractor'];

function parseCardTitle(title) {
  if (!title) return { player: '', set: '', parallel: '', cardNumber: '', year: '' };
  const lower = title.toLowerCase();

  // Year
  const yearMatch = title.match(/\b(201[5-9]|202[0-9])\b/);
  const year = yearMatch ? yearMatch[1] : '';

  // Set
  let set = '';
  for (const s of CLIENT_KNOWN_SETS) {
    if (lower.includes(s.toLowerCase())) { set = s; break; }
  }

  // Parallel (default to Base if set is known but no parallel detected)
  let parallel = '';
  for (const p of CLIENT_KNOWN_PARALLELS) {
    if (lower.includes(p.toLowerCase())) { parallel = p; break; }
  }
  if (!parallel && set) parallel = 'Base';

  // Card number (#123, /99, #/99, No. 123)
  const numMatch = title.match(/#\s*(\d+)|No\.?\s*(\d+)/i);
  const cardNumber = numMatch ? (numMatch[1] || numMatch[2]) : '';

  // Player name: remove known tokens from title to isolate the name
  let name = title;
  if (year) name = name.replace(new RegExp('\\b' + year + '\\b', 'g'), '');
  if (set) name = name.replace(new RegExp('\\b' + set + '\\b', 'gi'), '');
  if (parallel) name = name.replace(new RegExp('\\b' + parallel + '\\b', 'gi'), '');
  for (const w of NOISE_WORDS) {
    name = name.replace(new RegExp('\\b' + w + '\\b', 'gi'), '');
  }
  // Remove card numbers, grading scores, serial numbers like /99
  name = name.replace(/#\s*\d+/g, '');
  name = name.replace(/\/\s*\d+/g, '');
  name = name.replace(/\b\d+\.?\d*\b/g, '');
  // Remove special characters and dashes used as separators
  name = name.replace(/[-–—]/g, ' ');
  name = name.replace(/[#\/\\|:;,!]/g, ' ');
  // Collapse whitespace and take the first 2-3 capitalized words as the player name
  name = name.replace(/\s+/g, ' ').trim();
  const words = name.split(' ').filter(w => w.length > 1);
  // Take leading proper-case words (first letter uppercase) as the player name
  const nameWords = [];
  for (const w of words) {
    if (/^[A-Z]/.test(w) && nameWords.length < 3) {
      nameWords.push(w);
    } else if (nameWords.length > 0) {
      break;
    }
  }
  const player = nameWords.join(' ') || words.slice(0, 2).join(' ');

  return { player, set, parallel, cardNumber, year };
}

function buildShowingText(item) {
  const p = parseCardTitle(item.title);
  const parts = [];
  if (p.player) parts.push(p.player);
  if (p.year) parts.push(p.year);
  if (p.set) parts.push(p.set);
  if (p.parallel) parts.push(p.parallel);
  if (p.cardNumber) parts.push(`#${p.cardNumber}`);
  return parts.length > 0 ? `Showing ${parts.join(' ')}` : `Showing ${item.title}`;
}

function isDirectCardSearch(query) {
  const lower = query.toLowerCase();
  let matches = 0;
  if (/\b(201[5-9]|202[0-9])\b/.test(query)) matches++;
  if (CLIENT_KNOWN_SETS.some(s => lower.includes(s.toLowerCase()))) matches++;
  if (CLIENT_KNOWN_PARALLELS.some(p => lower.includes(p.toLowerCase()))) matches++;
  return matches >= 2;
}

// ---- Skeleton Loader ----
function showSkeleton() {
  skeletonGrid.innerHTML = '';
  for (let i = 0; i < 8; i++) {
    const skel = document.createElement('div');
    skel.className = 'skeleton-card';
    skel.innerHTML = `
      <div class="skeleton-image"></div>
      <div class="skeleton-body">
        <div class="skeleton-line medium"></div>
        <div class="skeleton-line short"></div>
        <div class="skeleton-line price"></div>
      </div>
    `;
    skeletonGrid.appendChild(skel);
  }
  skeletonGrid.classList.remove('hidden');
}

function hideSkeleton() {
  skeletonGrid.classList.add('hidden');
}

// ---- Form submit ----
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const query = input.value.trim();
  if (!query) return;
  suggestionsSection.classList.add('hidden');
  recentSection.classList.add('hidden');
  addRecentSearch(query);
  await fetchDirectSearch(query);
});

// ---- Suggestion chips ----
document.querySelectorAll('.chip').forEach(chip => {
  chip.addEventListener('click', () => {
    const query = chip.dataset.query;
    input.value = query;
    suggestionsSection.classList.add('hidden');
    recentSection.classList.add('hidden');
    addRecentSearch(query);
    fetchDirectSearch(query);
  });
});

// ---- Back button ----
backBtn.addEventListener('click', goBackToVariants);

// ---- Fetch Variants (Stage 1) ----
async function fetchVariants(query) {
  currentSearchMode = 'variants';
  currentVariantQuery = query;
  cachedVariants = null;
  currentResults = [];

  // Reset UI
  variantsSection.classList.add('hidden');
  backBtn.classList.add('hidden');
  sortControls.classList.add('hidden');
  similarSection.classList.add('hidden');
  similarGrid.innerHTML = '';
  grid.innerHTML = '';
  meta.classList.add('hidden');
  chartSection.classList.add('hidden');
  errorMsg.classList.add('hidden');
  if (priceChart) { priceChart.destroy(); priceChart = null; }

  loadingText.textContent = currentMode === 'sold' ? 'Finding sold card variants...' : 'Finding card variants...';
  setLoading(true);
  showSkeleton();

  try {
    const params = new URLSearchParams({ q: query, mode: currentMode });
    if (currentMode === 'forsale') {
      const f = getPriceFilter();
      if (f.min != null) params.set('minPrice', String(f.min));
      if (f.max != null) params.set('maxPrice', String(f.max));
    }
    const token = getSessionToken();
    const response = await fetch(`/api/variants?${params}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    const data = await safeJson(response);

    if (response.status === 401) {
      if (data && (data.noKey || data.badKey)) {
        setLoading(false);
        hideSkeleton();
        errorMsg.classList.remove('hidden');
        errorMsg.innerHTML = `${escHtml(data.error || 'Sold searches need a scrape.do API key.')} <button class="error-action-btn" onclick="showSettings()">Open Settings</button>`;
        return;
      }
      showLogin();
      return;
    }
    if (!response.ok) {
      const msg = data.detail ? `${data.error}: ${data.detail}` : (data.error || `Server error ${response.status}`);
      throw new Error(msg);
    }

    if (data.rateLimited || data.soldUnavailable) {
      variantsGrid.innerHTML = '';
      variantsTitle.innerHTML = '';
      const msg = document.createElement('div');
      msg.className = 'no-listings-box';
      msg.innerHTML = '<div class="no-listings-icon">&#9888;&#65039;</div><h3>Sold Search Currently Unavailable</h3><p>eBay retired the Finding API and we are awaiting approval for the Marketplace Insights API. Sold search will return once approved. In the meantime, use For Sale mode to search active listings.</p>';
      variantsGrid.appendChild(msg);
      variantsSection.classList.remove('hidden');
      return;
    }

    cachedVariants = data.variants || [];
    displayVariants(cachedVariants, query, data.mock, data.serial);

  } catch (err) {
    errorMsg.textContent = `Error: ${err.message}`;
    errorMsg.classList.remove('hidden');
  } finally {
    setLoading(false);
    hideSkeleton();
    loadingText.textContent = currentMode === 'sold' ? 'Searching eBay sold listings...' : 'Searching eBay listings...';
  }
}

// ---- Display Variants ----
function displayVariants(variants, query, mock, serial) {
  variantsGrid.innerHTML = '';
  variants = Array.isArray(variants) ? variants : [];

  const mockBadge = mock ? ' <span class="mock-badge">DEMO DATA</span>' : '';
  variantsTitle.innerHTML = `Results for &ldquo;${escHtml(query)}&rdquo;${mockBadge}`;
  const subtitle = document.getElementById('variants-subtitle');
  const serialNote = serial ? ` — filtering for /${serial} numbered cards` : '';
  subtitle.textContent = (currentMode === 'sold' ? 'Select a card to view recent sold listings' : 'Select a card to view current listings') + serialNote;

  if (variants.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'no-results';
    empty.textContent = 'No card variants found. Try a broader search term.';
    variantsGrid.appendChild(empty);
  } else {
    variants.forEach((v, i) => {
      const card = buildVariantCard(v);
      card.style.animationDelay = `${i * 0.06}s`;
      variantsGrid.appendChild(card);
    });
  }

  variantsSection.classList.remove('hidden');
}

// ---- Build Variant Card Tile ----
function buildVariantCard(variant) {
  const card = document.createElement('div');
  card.className = 'variant-card';

  const imageHtml = variant.imageUrl
    ? `<img src="${escHtml(variant.imageUrl)}" alt="${escHtml(variant.displayName)}" loading="lazy" />`
    : `<div class="variant-no-image"><span>&#127944;</span></div>`;

  const priceRange = variant.priceRange
    ? `<span class="variant-price-range">$${variant.priceRange.min.toFixed(0)} – $${variant.priceRange.max.toFixed(0)}</span>`
    : '';

  card.innerHTML = `
    <div class="variant-card-image">${imageHtml}</div>
    <div class="variant-card-body">
      <p class="variant-name">${escHtml(variant.displayName)}</p>
      <p class="variant-avg-price">Avg $${variant.avgPrice.toFixed(2)}</p>
      <div class="variant-footer">
        <span class="variant-sales-count">${variant.salesCount} ${currentMode === 'sold' ? 'sales' : 'listings'}</span>
        ${priceRange}
      </div>
    </div>
  `;

  card.addEventListener('click', () => selectVariant(variant));
  return card;
}

// ---- Select a Variant (Stage 2) ----
function selectVariant(variant) {
  variantsSection.classList.add('hidden');
  backBtn.classList.remove('hidden');
  // Show the full search query in the input (includes serial like /4 if present)
  input.value = variant.searchQuery;
  window.scrollTo({ top: 0, behavior: 'smooth' });
  performSearch(variant.searchQuery);
}

// ---- Go Back ----
function goBackToVariants() {
  backBtn.classList.add('hidden');
  approxSection.classList.add('hidden');
  sortControls.classList.add('hidden');
  similarSection.classList.add('hidden');
  similarGrid.innerHTML = '';
  grid.innerHTML = '';
  meta.classList.add('hidden');
  chartSection.classList.add('hidden');
  errorMsg.classList.add('hidden');
  currentResults = [];
  if (priceChart) { priceChart.destroy(); priceChart = null; }

  if (currentSearchMode === 'direct') {
    // Return to search home
    currentSearchMode = 'variants';
    input.value = '';
    suggestionsSection.classList.remove('hidden');
    renderRecentSearches();
    return;
  }

  input.value = currentVariantQuery;
  fetchDirectSearch(currentVariantQuery);
}

// ---- Direct Card Search (Stage: direct) ----
async function fetchDirectSearch(query) {
  currentSearchMode = 'direct';
  currentResults = [];

  // Reset UI
  variantsSection.classList.add('hidden');
  backBtn.classList.add('hidden');
  approxSection.classList.add('hidden');
  sortControls.classList.add('hidden');
  resetGradeFilter();
  similarSection.classList.add('hidden');
  similarGrid.innerHTML = '';
  grid.innerHTML = '';
  meta.classList.add('hidden');
  chartSection.classList.add('hidden');
  errorMsg.classList.add('hidden');
  if (priceChart) { priceChart.destroy(); priceChart = null; }

  const isSold = currentMode === 'sold';
  loadingText.textContent = isSold ? 'Searching eBay sold listings...' : 'Searching eBay listings...';
  setLoading(true);
  showSkeleton();

  try {
    const params = new URLSearchParams({ q: query, mode: currentMode });
    if (currentMode === 'forsale') {
      const f = getPriceFilter();
      if (f.min != null) params.set('minPrice', String(f.min));
      if (f.max != null) params.set('maxPrice', String(f.max));
    }
    const token = getSessionToken();
    const response = await fetch(`/api/direct-search?${params}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    const data = await safeJson(response);

    if (response.status === 401) {
      if (data && (data.noKey || data.badKey)) {
        setLoading(false);
        hideSkeleton();
        errorMsg.classList.remove('hidden');
        errorMsg.innerHTML = `${escHtml(data.error || 'Sold searches need a scrape.do API key.')} <button class="error-action-btn" onclick="showSettings()">Open Settings</button>`;
        return;
      }
      showLogin();
      return;
    }
    if (!response.ok) {
      const msg = data.detail ? `${data.error}: ${data.detail}` : (data.error || `Server error ${response.status}`);
      throw new Error(msg);
    }

    const { mock, searchType, approximateValue, relaxedNote } = data;
    const results = Array.isArray(data.results) ? data.results : [];
    currentResults = results;
    recordPriceHistory(query, results);

    // Check for rate limiting
    if (data.rateLimited || data.soldUnavailable) {
      meta.classList.add('hidden');
      const msg = document.createElement('div');
      msg.className = 'no-listings-box';
      msg.innerHTML = '<div class="no-listings-icon">&#9888;&#65039;</div><h3>Sold Search Currently Unavailable</h3><p>eBay retired the Finding API and we are awaiting approval for the Marketplace Insights API. Sold search will return once approved. In the meantime, use For Sale mode to search active listings.</p>';
      grid.appendChild(msg);
      backBtn.classList.remove('hidden');
      return;
    }

    // Show the print-run estimate when there were no sales at the exact print
    // run searched; otherwise the broadened approximate value (if any).
    if (data.estimate) {
      buildSimilarEstimateSection(data.estimate, query);
      approxSection.classList.remove('hidden');
    } else if (searchType === 'broadened' && approximateValue) {
      buildApproxValueSection(approximateValue, query);
      approxSection.classList.remove('hidden');
    }

    // Stats bar
    if (results.length > 0) {
      renderStatsBar(results, isSold);
      sortControls.classList.remove('hidden');
      // Reset sort to default
      document.querySelectorAll('.sort-btn').forEach(b => b.classList.remove('active'));
      document.querySelector('.sort-btn[data-sort="default"]').classList.add('active');
    }

    const mockBadge = mock ? ' <span class="mock-badge">DEMO DATA</span>' : '';
    let typeLabel = searchType === 'broadened' ? ' (similar cards)' : '';
    if (searchType === 'relaxed' && relaxedNote) typeLabel = ` <span class="relaxed-badge">${escHtml(relaxedNote)}</span>`;
    const listingWord = isSold ? 'sold listing' : 'listing';
    meta.innerHTML = `${results.length} ${listingWord}${results.length !== 1 ? 's' : ''} for &ldquo;${escHtml(query)}&rdquo;${typeLabel}${mockBadge}`;
    meta.classList.remove('hidden');

    if (results.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'no-results';
      empty.textContent = isSold ? 'No sold listings found. Try a broader search term.' : 'No listings found. Try a broader search term.';
      grid.appendChild(empty);
    } else {
      if (isSold) {
        renderGradeGroups(grid, results);
      } else {
        results.forEach((item, i) => {
          const card = buildCard(item);
          card.style.animationDelay = `${i * 0.05}s`;
          grid.appendChild(card);
        });
        // Paginated Load More for For Sale results. Skip when the server
        // had to broaden the query — pagination of a broadened search
        // would pull unrelated items.
        if (searchType !== 'broadened') {
          _forsalePaging = { query, offset: results.length, hasMore: true, fetching: false };
          addForsaleLoadMore(grid);
        }
      }
      injectPromotedCards(grid);
      if (isSold) { updatePriceChart(results); buildGradeFilter(); }
    }

    backBtn.classList.remove('hidden');

  } catch (err) {
    errorMsg.textContent = `Error: ${err.message}`;
    errorMsg.classList.remove('hidden');
  } finally {
    setLoading(false);
    hideSkeleton();
  }
}

// Paginated Load More for the main Search page in For Sale mode. Each click
// fetches the next 40 listings from /api/search via offset and appends them
// before the button. Tracks query and offset so successive clicks stay in
// sync with eBay's ordering.
let _forsalePaging = { query: '', offset: 0, hasMore: false, fetching: false };

function addForsaleLoadMore(grid) {
  let wrap = grid.querySelector('.load-more-wrap');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.className = 'load-more-wrap';
    grid.appendChild(wrap);
  }
  wrap.innerHTML = '';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'load-more-btn';
  btn.textContent = _forsalePaging.fetching ? 'Loading…' : 'Load 40 more listings';
  btn.disabled = !!_forsalePaging.fetching;
  btn.addEventListener('click', () => loadMoreForsaleResults(grid));
  wrap.appendChild(btn);
}

async function loadMoreForsaleResults(grid) {
  if (_forsalePaging.fetching || !_forsalePaging.hasMore) return;
  _forsalePaging.fetching = true;
  addForsaleLoadMore(grid);
  try {
    const params = new URLSearchParams({ q: _forsalePaging.query, mode: 'forsale', limit: '40', offset: String(_forsalePaging.offset) });
    const f = getPriceFilter();
    if (f.min != null) params.set('minPrice', String(f.min));
    if (f.max != null) params.set('maxPrice', String(f.max));
    const res = await fetch(`/api/search?${params}`);
    const data = await safeJson(res);
    if (!res.ok) throw new Error(data.error || `Server error ${res.status}`);
    const items = data.results || [];
    if (items.length === 0) {
      _forsalePaging.hasMore = false;
    } else {
      _forsalePaging.offset += items.length;
      _forsalePaging.hasMore = items.length >= 40;
      const wrap = grid.querySelector('.load-more-wrap');
      let baseIdx = grid.querySelectorAll('.card:not(.promoted-card)').length;
      items.forEach(item => {
        const card = buildCard(item);
        card.style.animationDelay = `${baseIdx * 0.05}s`;
        if (wrap) wrap.before(card); else grid.appendChild(card);
        baseIdx++;
      });
      currentResults.push(...items);
    }
  } catch (err) {
    const wrap = grid.querySelector('.load-more-wrap');
    if (wrap) wrap.innerHTML = `<span class="no-results">Could not load more — ${escHtml(err.message)}</span>`;
    _forsalePaging.hasMore = false;
    _forsalePaging.fetching = false;
    return;
  }
  _forsalePaging.fetching = false;
  if (!_forsalePaging.hasMore) {
    const wrap = grid.querySelector('.load-more-wrap');
    if (wrap) wrap.innerHTML = '<span class="cl-listings-end">— end of listings —</span>';
  } else {
    addForsaleLoadMore(grid);
  }
}

// ---- Approximate Value Section ----
function buildApproxValueSection(approx, originalQuery) {
  approxSection.innerHTML = `
    <div class="approx-badge">APPROXIMATE VALUE</div>
    <div class="approx-note">No exact sales found for "${escHtml(originalQuery)}"</div>
    <div class="approx-price">~$${approx.medianPrice.toFixed(2)}</div>
    <div class="approx-details">
      <span>Avg: $${approx.avgPrice.toFixed(2)}</span>
      <span>Range: $${approx.priceRange.min.toFixed(0)} – $${approx.priceRange.max.toFixed(0)}</span>
      <span>Based on ${approx.sampleSize} sale${approx.sampleSize !== 1 ? 's' : ''}</span>
    </div>
    <div class="approx-source">Estimated from: ${escHtml(approx.basedOn)}</div>
  `;
}

// ---- Similar-card price estimate (print-run + set adjusted) ----
// Shown when a sold search finds NO sale of the exact card. The server picks
// 3–5 of the same player's similar sales and adjusts each for print-run and
// set differences; we display the estimate crossed against the sold prices used.
function buildSimilarEstimateSection(est, query) {
  const fmt = n => `$${Number(n).toFixed(2)}`;
  const pr = est.targetPrintRun;
  const targetLabel = pr ? `/${pr}` : (est.targetSet || 'this card');

  const rows = (est.comps || []).map(c => {
    const dir = c.adjustedPrice >= c.soldPrice ? 'up' : 'down';
    const dirArrow = dir === 'up' ? '&#9650;' : '&#9660;';
    const tags = [];
    if (c.printRun) {
      const scarcity = pr ? (c.printRun > pr ? 'more common' : 'rarer') : null;
      tags.push(`<span class="est-comp-prtag">/${c.printRun}${scarcity ? ` <span class="est-comp-scar">(${scarcity})</span>` : ''}</span>`);
    }
    if (c.setName && c.setName !== est.targetSet) {
      tags.push(`<span class="est-comp-prtag est-comp-settag">${escHtml(c.setName)}</span>`);
    }
    const img = c.imageUrl
      ? `<img class="est-comp-img" src="${escHtml(c.imageUrl)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'" />`
      : '<div class="est-comp-img est-comp-img-empty"></div>';
    const titleInner = escHtml(c.title || '');
    const titleHtml = c.itemUrl
      ? `<a class="est-comp-title" href="${escHtml(c.itemUrl)}" target="_blank" rel="noopener">${titleInner}</a>`
      : `<span class="est-comp-title">${titleInner}</span>`;
    return `
      <div class="est-comp">
        ${img}
        <div class="est-comp-main">
          ${titleHtml}
          <div class="est-comp-sub">
            ${tags.join('')}
            ${c.soldDate ? `<span class="est-comp-date">${escHtml(timeAgo(c.soldDate))}</span>` : ''}
          </div>
        </div>
        <div class="est-comp-prices">
          <span class="est-comp-sold" title="Actual sold price">${fmt(c.soldPrice)}</span>
          <span class="est-comp-cross est-${dir}">${dirArrow}</span>
          <span class="est-comp-adj" title="Adjusted to ${escHtml(targetLabel)}">${fmt(c.adjustedPrice)}</span>
        </div>
      </div>`;
  }).join('');

  // Adaptive copy depending on what was adjusted.
  const adjustedBits = [];
  if (est.adjustedForPrintRun) adjustedBits.push('print run');
  if (est.adjustedForSet) adjustedBits.push('set value');
  const adjustedText = adjustedBits.length ? `, adjusted for ${adjustedBits.join(' and ')}` : '';
  const noWhat = pr
    ? `No sold sales found for a <strong>/${pr}</strong>${est.targetSet ? ` ${escHtml(est.targetSet)}` : ''}.`
    : `No exact sold sales found${est.targetSet ? ` for <strong>${escHtml(est.targetSet)}</strong>` : ''}.`;

  const formulaBits = [];
  if (est.adjustedForPrintRun) formulaBits.push(`print run by (its run &divide; ${targetLabel})<sup>${est.alpha}</sup> (a /25 &asymp; 2&times; a /99, not 4&times;; unnumbered treated as ~/250)`);
  if (est.adjustedForSet) formulaBits.push('set by relative set value (e.g. National Treasures &gt; Score)');
  if (est.neutralized) formulaBits.push('then neutralized toward the comps&rsquo; shared consensus so one off sale can&rsquo;t swing it');

  approxSection.innerHTML = `
    <div class="approx-badge">ESTIMATED VALUE</div>
    <div class="approx-note">${noWhat} Estimated from ${est.sampleSize} similar ${est.sampleSize === 1 ? 'sale' : 'sales'} of the same player${adjustedText}.</div>
    <div class="approx-price">~${fmt(est.value)}</div>
    <div class="approx-details">
      <span>Low: ${fmt(est.low)}</span>
      <span>High: ${fmt(est.high)}</span>
      <span>${est.sampleSize} adjusted comp${est.sampleSize !== 1 ? 's' : ''}</span>
    </div>
    <div class="est-comps-head">Sold comps used &rarr; adjusted to ${escHtml(targetLabel)}</div>
    <div class="est-comps">${rows}</div>
    ${formulaBits.length ? `<div class="approx-source">Each sale is adjusted for ${formulaBits.join('; and ')}.</div>` : ''}
  `;
}

// ---- Render Stats Bar ----
function renderStatsBar(results, isSold) {
  const prices = results.map(r => parseFloat(r.price)).filter(p => !isNaN(p));
  if (prices.length === 0) return;

  const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
  const minP = Math.min(...prices);
  const maxP = Math.max(...prices);

  const statsEl = document.createElement('div');
  statsEl.className = 'stats-bar';
  statsEl.innerHTML = `
    <div class="stat-item">
      <span class="stat-label">Results</span>
      <span class="stat-value">${results.length}</span>
    </div>
    <div class="stat-item">
      <span class="stat-label">${isSold ? 'Avg Sale' : 'Avg Price'}</span>
      <span class="stat-value">$${avg.toFixed(2)}</span>
    </div>
    <div class="stat-item">
      <span class="stat-label">Low</span>
      <span class="stat-value">$${minP.toFixed(2)}</span>
    </div>
    <div class="stat-item">
      <span class="stat-label">High</span>
      <span class="stat-value">$${maxP.toFixed(2)}</span>
    </div>
  `;
  grid.appendChild(statsEl);

  // Shareable price card — every share is free top-of-funnel marketing.
  const shareRow = document.createElement('div');
  shareRow.className = 'share-row';
  shareRow.innerHTML = `<button class="share-price-btn" onclick="shareSearchResult()" title="Share this card's price">&#128228; Share this price</button>`;
  grid.appendChild(shareRow);
}

// ---- Search (fetch individual sales for a specific variant) ----
// opts.fallback = true means "sold data is unavailable for this user (no/bad
// scrape.do key), so quietly search live For-Sale listings instead and show a
// soft note" — never a dead-end error wall.
async function performSearch(query, opts = {}) {
  setLoading(true);
  showSkeleton();
  grid.innerHTML = '';
  errorMsg.classList.add('hidden');
  meta.classList.add('hidden');
  chartSection.classList.add('hidden');
  sortControls.classList.add('hidden');
  similarSection.classList.add('hidden');
  similarGrid.innerHTML = '';
  approxSection.classList.add('hidden');
  document.getElementById('grade-panel').classList.add('hidden');
  resetGradeFilter();
  currentResults = [];
  if (priceChart) {
    priceChart.destroy();
    priceChart = null;
  }

  const fallback = !!opts.fallback;
  const effectiveMode = fallback ? 'forsale' : currentMode;
  const isSold = effectiveMode === 'sold';
  loadingText.textContent = isSold ? 'Searching eBay sold listings...' : 'Searching eBay listings...';

  try {
    const params = new URLSearchParams({ q: query, limit: '50', mode: effectiveMode });
    if (effectiveMode === 'forsale' && !fallback) {
      const f = getPriceFilter();
      if (f.min != null) params.set('minPrice', String(f.min));
      if (f.max != null) params.set('maxPrice', String(f.max));
    }
    // Sold searches need the user's scrape.do key — server reads it from
    // the authenticated user record. Pass the session token along.
    const token = getSessionToken();
    const response = await fetch(`/api/search?${params}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (response.status === 401) {
      const errData = await safeJson(response).catch(() => ({}));
      if (errData && (errData.noKey || errData.badKey)) {
        // No sold-data key for this user → don't dead-end. Fall back to live
        // For-Sale listings with a soft note (handled on re-entry).
        if (!fallback) return performSearch(query, { fallback: true });
        return; // shouldn't happen (For-Sale needs no key)
      }
    }
    const data = await safeJson(response);

    if (response.status === 401) { showLogin(); return; }
    if (response.status === 503 && effectiveMode === 'sold') {
      if (!fallback) return performSearch(query, { fallback: true });
      setLoading(false);
      const msg = document.createElement('div');
      msg.className = 'no-listings-box';
      msg.innerHTML = '<div class="no-listings-icon">&#9888;&#65039;</div><h3>Sold Data Unavailable</h3><p>' + (data.error || 'The sold listings service is not configured on this server.') + '</p>';
      grid.appendChild(msg);
      return;
    }
    if (response.status === 402 && data && data.limitReached) {
      // Hit today's free sold-search cap → invite them to fund / lift the cap.
      setLoading(false);
      refreshSoldUsage();
      showFund(data.error || `You've hit today's free sold-search limit (${data.freeLimit || 25}).`);
      return;
    }
    if (!response.ok) {
      const msg = data.detail ? `${data.error}: ${data.detail}` : (data.error || `Server error ${response.status}`);
      throw new Error(msg);
    }

    const { mock, serial, similarResults } = data;
    const results = Array.isArray(data.results) ? data.results : [];
    currentResults = results;
    currentResultMode = effectiveMode;
    recordPriceHistory(query, results);
    // A sold search may have consumed a free allowance unit — refresh the pill.
    if (effectiveMode === 'sold') refreshSoldUsage();

    // Reset pagination state for the new search
    _searchPaging = {
      query,
      mode: effectiveMode,
      offset: data.offset || 0,
      hasMore: !!data.hasMore,
      fetching: false,
    };

    // Check for rate limiting
    if (data.rateLimited || data.soldUnavailable) {
      if (!fallback) return performSearch(query, { fallback: true });
      meta.classList.add('hidden');
      const msg = document.createElement('div');
      msg.className = 'no-listings-box';
      msg.innerHTML = '<div class="no-listings-icon">&#9888;&#65039;</div><h3>Sold Search Currently Unavailable</h3><p>eBay retired the Finding API and we are awaiting approval for the Marketplace Insights API. Sold search will return once approved. In the meantime, use For Sale mode to search active listings.</p>';
      grid.appendChild(msg);
      return;
    }

    // No sales at the exact print run? Show the print-run-adjusted estimate
    // built from sales of the same card at other print runs.
    if (data.estimate) {
      buildSimilarEstimateSection(data.estimate, query);
      approxSection.classList.remove('hidden');
    }

    // Stats bar
    if (results.length > 0) {
      renderStatsBar(results, isSold);
      sortControls.classList.remove('hidden');
      document.querySelectorAll('.sort-btn').forEach(b => b.classList.remove('active'));
      document.querySelector('.sort-btn[data-sort="default"]').classList.add('active');
    }

    const mockBadge = mock ? ' <span class="mock-badge">DEMO DATA</span>' : '';
    const listingWord = isSold ? 'sold listing' : 'listing';
    meta.innerHTML = `${results.length} ${listingWord}${results.length !== 1 ? 's' : ''} for &ldquo;${escHtml(query)}&rdquo;${mockBadge}`;
    meta.classList.remove('hidden');

    if (results.length === 0) {
      // Show "No Listings" box instead of plain text
      const noBox = document.createElement('div');
      noBox.className = 'no-listings-box';
      const serialLabel = serial ? ` /${serial}` : '';
      noBox.innerHTML = `
        <div class="no-listings-icon">&#128269;</div>
        <h3>No Listings Found</h3>
        <p>No ${isSold ? 'sold listings' : 'listings'} found for &ldquo;${escHtml(query)}&rdquo;${serialLabel ? ` numbered <strong>${escHtml(serialLabel.trim())}</strong>` : ''}.</p>
      `;
      grid.appendChild(noBox);

      // Show similar numbered cards if available
      if (similarResults && similarResults.length > 0) {
        similarTitle.textContent = `Similar Numbered Cards${serial ? ` (other than /${serial})` : ''}`;
        similarGrid.innerHTML = '';
        similarResults.forEach((item, i) => {
          const card = buildCard(item);
          card.style.animationDelay = `${i * 0.05}s`;
          similarGrid.appendChild(card);
        });
        similarSection.classList.remove('hidden');
      }
    } else {
      if (isSold) {
        renderGradeGroups(grid, results);
      } else {
        results.forEach((item, i) => {
          const card = buildCard(item);
          card.style.animationDelay = `${i * 0.05}s`;
          grid.appendChild(card);
        });
        // Forsale Load More — uses /api/search offset that the initial
        // performSearch already consumed, so we pick up where it left off.
        _forsalePaging = {
          query,
          offset: (_searchPaging.offset || 0) + results.length,
          hasMore: !!_searchPaging.hasMore,
          fetching: false,
        };
        if (_forsalePaging.hasMore) addForsaleLoadMore(grid);
      }
      injectPromotedCards(grid);
      if (isSold) {
        updatePriceChart(results);
        loadGradePanel(query);
        buildGradeFilter();
      }

      // Also show similar cards below if serial search returned both
      if (serial && similarResults && similarResults.length > 0) {
        similarTitle.textContent = `Other Numbered Cards`;
        similarGrid.innerHTML = '';
        similarResults.forEach((item, i) => {
          const card = buildCard(item);
          card.style.animationDelay = `${i * 0.05}s`;
          similarGrid.appendChild(card);
        });
        similarSection.classList.remove('hidden');
      }
    }

    // Soft note: we fell back to live For-Sale listings because sold data
    // wasn't available for this user. Pin it above the results.
    if (fallback) {
      const note = document.createElement('div');
      note.className = 'sold-fallback-note';
      note.innerHTML = `<span class="sold-fallback-icon">&#128161;</span> <span>Showing <strong>live asking prices</strong> for &ldquo;${escHtml(query)}&rdquo;. Sold price history needs a scrape.do API key &mdash; <button type="button" class="sold-fallback-link" onclick="showSettings()">add yours</button> to see exact sold comps by grade.</span>`;
      grid.insertBefore(note, grid.firstChild);
    }

  } catch (err) {
    errorMsg.textContent = `Error: ${err.message}`;
    errorMsg.classList.remove('hidden');
  } finally {
    setLoading(false);
    hideSkeleton();
  }
}

// ---- Grade Value Panel ----
async function loadGradePanel(query) {
  const panel   = document.getElementById('grade-panel');
  const body    = document.getElementById('grade-panel-body');
  const loading = document.getElementById('grade-panel-loading');

  panel.classList.remove('hidden');
  loading.classList.remove('hidden');
  body.innerHTML = '';

  try {
    const res  = await authFetch(`/api/grading-advisor?q=${encodeURIComponent(query)}`);
    const data = await res.json();
    if (res.status === 402 && data && data.limitReached) {
      loading.classList.add('hidden');
      refreshSoldUsage();
      showFund(data.error || `You've hit today's free sold-search limit (${data.freeLimit || 25}).`);
      body.innerHTML = '<span style="color:var(--text-muted);font-size:0.8rem">Daily sold-search limit reached — ♥ Fund to help lift it.</span>';
      return;
    }
    if (!res.ok) throw new Error(data.error);

    const { grades } = data;
    const fmt = v => v != null ? `$${v.toFixed(2)}` : '—';

    const entries = [
      { label: 'Raw',    stats: grades.raw,   color: 'var(--text-secondary)' },
      { label: 'PSA 8',  stats: grades.psa8,  color: '#f59e0b' },
      { label: 'PSA 9',  stats: grades.psa9,  color: '#3b82f6' },
      { label: 'PSA 10', stats: grades.psa10, color: 'var(--accent)' },
    ];

    body.innerHTML = entries.map(({ label, stats, color }) => `
      <div class="grade-chip">
        <span class="grade-chip-label" style="color:${color}">${label}</span>
        <span class="grade-chip-price">${stats ? fmt(stats.median) : '—'}</span>
        ${stats ? `<span class="grade-chip-sales">${stats.sales} sales</span>` : '<span class="grade-chip-sales">no data</span>'}
      </div>
    `).join('');
  } catch {
    body.innerHTML = '<span style="color:var(--text-muted);font-size:0.8rem">Could not load grade data</span>';
  } finally {
    loading.classList.add('hidden');
  }
}

// ---- Price Chart ----
function updatePriceChart(results) {
  if (typeof Chart === 'undefined') return;

  // Full price history is free for everyone — show up to a year.
  const cutoffDate = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);

  const allSorted = [...results]
    .filter(r => r.soldDate && r.price)
    .sort((a, b) => new Date(a.soldDate) - new Date(b.soldDate));

  const sorted = allSorted.filter(r => new Date(r.soldDate) >= cutoffDate);

  // Show depth notice
  let depthEl = document.getElementById('chart-depth-notice');
  if (!depthEl) {
    depthEl = document.createElement('div');
    depthEl.id = 'chart-depth-notice';
    depthEl.className = 'chart-depth-notice';
    chartSection.appendChild(depthEl);
  }
  if (allSorted.length > 0) {
    depthEl.textContent = `Showing up to 1 year of price history`;
    depthEl.classList.remove('hidden');
  } else {
    depthEl.classList.add('hidden');
  }

  if (sorted.length < 2) {
    chartSection.classList.add('hidden');
    return;
  }

  const labels = sorted.map(r =>
    new Date(r.soldDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  );
  const prices = sorted.map(r => parseFloat(r.price));

  if (priceChart) {
    priceChart.destroy();
    priceChart = null;
  }

  priceChart = new Chart(chartCanvas, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Sale Price (USD)',
        data: prices,
        borderColor: '#52b788',
        backgroundColor: 'rgba(82, 183, 136, 0.08)',
        pointBackgroundColor: '#52b788',
        pointBorderColor: '#0f1117',
        pointBorderWidth: 2,
        pointRadius: 5,
        pointHoverRadius: 7,
        fill: true,
        tension: 0.3,
        borderWidth: 2,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#1a202c',
          borderColor: '#2d3748',
          borderWidth: 1,
          titleColor: '#8d99ae',
          bodyColor: '#52b788',
          callbacks: {
            label: ctx => ` $${ctx.parsed.y.toFixed(2)}`
          }
        }
      },
      scales: {
        x: {
          grid: { color: '#1a2030' },
          ticks: { color: '#8d99ae', font: { size: 11, family: 'Inter' } }
        },
        y: {
          grid: { color: '#2d3748' },
          ticks: {
            color: '#8d99ae',
            font: { size: 11, family: 'Inter' },
            callback: val => `$${val}`
          },
          beginAtZero: false
        }
      }
    }
  });

  chartSection.classList.remove('hidden');
}

// ---- Team Colors ----
const TEAM_COLORS = {
  mahomes: '#E31837', chiefs: '#E31837',
  brady: '#002244', patriots: '#002244',
  jefferson: '#4F2683', vikings: '#4F2683',
  allen: '#00338D', bills: '#00338D',
  burrow: '#FB4F14', bengals: '#FB4F14',
  chase: '#FB4F14',
  lamb: '#003594', cowboys: '#003594',
  jackson: '#241773', ravens: '#241773',
  purdy: '#AA0000', niners: '#AA0000',
  eagles: '#004C54',
  hurts: '#004C54',
  stroud: '#03202F', texans: '#03202F',
  '49ers': '#AA0000',
};

function getTeamColor(title) {
  const lower = (title || '').toLowerCase();
  for (const [key, color] of Object.entries(TEAM_COLORS)) {
    if (lower.includes(key)) return color;
  }
  return '#52b788';
}

// ---- Date helpers ----
function timeAgo(dateStr) {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return '';
  const days = Math.floor((Date.now() - date.getTime()) / 86400000);
  if (days === 0) return 'today';
  if (days === 1) return '1 day ago';
  if (days < 7) return `${days} days ago`;
  const weeks = Math.floor(days / 7);
  if (weeks === 1) return '1 week ago';
  if (weeks < 5) return `${weeks} weeks ago`;
  const months = Math.floor(days / 30);
  if (months === 1) return '1 month ago';
  return `${months} months ago`;
}

// ---- Grade helpers ----
function detectGrade(title) {
  const t = (title || '').toUpperCase();
  if (/PSA\s*10/.test(t)) return 'PSA 10';
  if (/PSA\s*9\.5/.test(t)) return 'PSA 9.5';
  if (/PSA\s*9/.test(t)) return 'PSA 9';
  if (/PSA\s*8/.test(t)) return 'PSA 8';
  if (/PSA\s*[0-9]/.test(t)) return 'PSA Other';
  if (/BGS\s*10|BGS\s*PRISTINE/.test(t)) return 'BGS 10';
  if (/BGS\s*9\.5/.test(t)) return 'BGS 9.5';
  if (/BGS/.test(t)) return 'BGS';
  if (/SGC/.test(t)) return 'SGC';
  if (/CGC/.test(t)) return 'CGC';
  return 'Raw / Ungraded';
}

const GRADE_ORDER = ['Raw / Ungraded', 'PSA 10', 'PSA 9.5', 'PSA 9', 'PSA 8', 'PSA Other', 'BGS 10', 'BGS 9.5', 'BGS', 'SGC', 'CGC'];

// Ranking for the "Grade" sort — best grade first, raw/ungraded last.
const GRADE_SORT_DESC = ['PSA 10', 'BGS 10', 'PSA 9.5', 'BGS 9.5', 'PSA 9', 'BGS', 'PSA 8', 'SGC', 'CGC', 'PSA Other', 'Raw / Ungraded'];
function gradeSortRank(title) {
  const i = GRADE_SORT_DESC.indexOf(detectGrade(title));
  return i < 0 ? GRADE_SORT_DESC.length : i;
}

function groupByGrade(results) {
  const groups = {};
  for (const item of results) {
    const grade = detectGrade(item.title);
    if (!groups[grade]) groups[grade] = [];
    groups[grade].push(item);
  }
  return GRADE_ORDER.filter(g => groups[g]?.length > 0).map(g => ({ grade: g, items: groups[g] }));
}

let _gradeGroups = [];
let _gradeShown = {};
let _gradeContainers = {};
// Pagination state for "Show more from eBay" — populated by performSearch.
let _searchPaging = { query: '', mode: '', offset: 0, hasMore: false, fetching: false };

function renderGradeGroups(grid, results) {
  _gradeGroups = groupByGrade(results);
  _gradeShown = {};
  _gradeContainers = {};
  let cardIndex = 0;

  for (const group of _gradeGroups) {
    const isRaw = group.grade === 'Raw / Ungraded';
    const initialLimit = isRaw ? 15 : 3;

    const avgPrice = group.items.map(i => parseFloat(i.price)).filter(p => p > 0).reduce((s, p, _, a) => s + p / a.length, 0);
    const header = document.createElement('div');
    header.className = 'grade-section-header';
    header.innerHTML = `<span class="grade-label">${escHtml(group.grade)}</span><span class="grade-meta">${group.items.length} sale${group.items.length !== 1 ? 's' : ''}${avgPrice > 0 ? ` &middot; avg $${avgPrice.toFixed(2)}` : ''}</span>`;
    grid.appendChild(header);

    const container = document.createElement('div');
    container.style.display = 'contents';
    grid.appendChild(container);
    _gradeContainers[group.grade] = container;

    const shown = group.items.slice(0, initialLimit);
    _gradeShown[group.grade] = shown.length;
    for (const item of shown) {
      const card = buildCard(item);
      card.style.animationDelay = `${cardIndex * 0.05}s`;
      container.appendChild(card);
      cardIndex++;
    }
  }

  updateLoadMoreButton(grid);
}

// ---- Grade Filter (sold searches) ----
// Lets the user narrow the value stats, chart and card list to a single
// grade (e.g. PSA 10) so the numbers reflect that grade only.
function getGradeFilteredResults() {
  if (currentGradeFilter === 'all') return currentResults;
  return currentResults.filter(r => detectGrade(r.title) === currentGradeFilter);
}

function resetGradeFilter() {
  currentGradeFilter = 'all';
  const wrap = document.getElementById('grade-filter');
  if (wrap) { wrap.innerHTML = ''; wrap.classList.add('hidden'); }
}

function buildGradeFilter() {
  currentGradeFilter = 'all';
  const wrap = document.getElementById('grade-filter');
  if (!wrap) return;
  wrap.innerHTML = '';

  // Only meaningful for sold results that actually span multiple grades.
  const groups = currentMode === 'sold' ? groupByGrade(currentResults) : [];
  if (groups.length < 2) { wrap.classList.add('hidden'); return; }

  const label = document.createElement('span');
  label.className = 'grade-filter-label';
  label.textContent = 'Grade:';
  wrap.appendChild(label);

  const addBtn = (grade, count, text) => {
    const btn = document.createElement('button');
    btn.className = 'grade-filter-btn' + (currentGradeFilter === grade ? ' active' : '');
    btn.dataset.grade = grade;
    btn.innerHTML = `${escHtml(text)} <span class="grade-filter-count">${count}</span>`;
    btn.addEventListener('click', () => applyGradeFilter(grade));
    wrap.appendChild(btn);
  };
  addBtn('all', currentResults.length, 'All');
  for (const g of groups) addBtn(g.grade, g.items.length, g.grade);

  wrap.classList.remove('hidden');
}

function applyGradeFilter(grade) {
  currentGradeFilter = grade;
  document.querySelectorAll('#grade-filter .grade-filter-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.grade === grade));

  const filtered = getGradeFilteredResults();

  // Re-render the value stats and card list for the selected grade,
  // honoring whichever sort is currently active.
  grid.innerHTML = '';
  if (filtered.length > 0) renderStatsBar(filtered, true);
  const sortType = document.querySelector('.sort-btn.active')?.dataset.sort || 'default';
  applySortToResults(sortType);

  // Re-render the price chart from the filtered sales only.
  updatePriceChart(filtered);
}

function updateLoadMoreButton(grid) {
  let wrap = grid.querySelector('.load-more-wrap');
  const hasCachedMore = _gradeGroups.some(g => (_gradeShown[g.grade] || 0) < g.items.length);
  const hasServerMore = _searchPaging.hasMore;

  if (!hasCachedMore && !hasServerMore) { if (wrap) wrap.remove(); return; }

  if (!wrap) {
    wrap = document.createElement('div');
    wrap.className = 'load-more-wrap';
    grid.appendChild(wrap);
  }
  wrap.innerHTML = '';

  const btn = document.createElement('button');
  btn.className = 'load-more-btn';
  if (hasCachedMore) {
    btn.textContent = 'Show 20 More';
    btn.addEventListener('click', () => loadMoreCards(grid));
  } else {
    btn.textContent = _searchPaging.fetching ? 'Loading…' : 'Load more from eBay';
    btn.disabled = !!_searchPaging.fetching;
    btn.addEventListener('click', () => fetchMoreFromServer(grid));
  }
  wrap.appendChild(btn);
}

async function fetchMoreFromServer(grid) {
  if (_searchPaging.fetching || !_searchPaging.hasMore) return;
  _searchPaging.fetching = true;
  updateLoadMoreButton(grid);
  try {
    const nextOffset = _searchPaging.offset + 50;
    const params = new URLSearchParams({ q: _searchPaging.query, limit: '50', offset: String(nextOffset), mode: _searchPaging.mode });
    if (_searchPaging.mode === 'forsale') {
      const f = getPriceFilter();
      if (f.min != null) params.set('minPrice', String(f.min));
      if (f.max != null) params.set('maxPrice', String(f.max));
    }
    const response = await fetch(`/api/search?${params}`);
    const data = await safeJson(response);
    if (!response.ok) throw new Error(data.error || `Server error ${response.status}`);
    const more = Array.isArray(data.results) ? data.results : [];
    if (more.length === 0) {
      _searchPaging.hasMore = false;
    } else {
      _searchPaging.offset = nextOffset;
      _searchPaging.hasMore = !!data.hasMore;
      // Merge new results into existing grade groups so Show 20 More keeps working
      const newGroups = groupByGrade(more);
      for (const ng of newGroups) {
        const existing = _gradeGroups.find(g => g.grade === ng.grade);
        if (existing) existing.items.push(...ng.items);
        else _gradeGroups.push(ng);
      }
      // Render the next 20 immediately
      loadMoreCards(grid);
    }
  } catch (err) {
    const wrap = grid.querySelector('.load-more-wrap');
    if (wrap) wrap.innerHTML = `<span class="no-results">Could not load more — ${escHtml(err.message)}</span>`;
  } finally {
    _searchPaging.fetching = false;
    updateLoadMoreButton(grid);
  }
}

function loadMoreCards(grid) {
  let remaining = 20;
  let cardIndex = grid.querySelectorAll('.card:not(.promoted-card)').length;

  for (const group of _gradeGroups) {
    if (remaining <= 0) break;
    const currentShown = _gradeShown[group.grade] || 0;
    if (currentShown >= group.items.length) continue;

    const toShow = group.items.slice(currentShown, currentShown + remaining);
    const container = _gradeContainers[group.grade];
    for (const item of toShow) {
      const card = buildCard(item);
      card.style.animationDelay = `${cardIndex * 0.05}s`;
      container.appendChild(card);
      cardIndex++;
    }
    _gradeShown[group.grade] = currentShown + toShow.length;
    remaining -= toShow.length;
  }

  updateLoadMoreButton(grid);
}

// ---- Build Sale Card ----
function buildCard(item) {
  const card = document.createElement('div');
  card.className = 'card';

  const teamColor = getTeamColor(item.title);
  card.style.setProperty('--team-color', teamColor);

  const price = item.price
    ? `$${parseFloat(item.price).toFixed(2)}`
    : 'Price N/A';

  const isSold = currentMode === 'sold';

  const dateStr = isSold
    ? timeAgo(item.soldDate)
    : (item.soldDate ? new Date(item.soldDate).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : '');

  const dateHtml = isSold && dateStr
    ? `<span class="card-date">${dateStr}</span>`
    : !isSold && dateStr
    ? `<span class="card-date">Ends: ${dateStr}</span>`
    : '';

  const badgeHtml = isSold
    ? '<div class="sold-badge">SOLD</div>'
    : '<div class="for-sale-badge">FOR SALE</div>';

  const imageHtml = item.imageUrl
    ? `<img src="${escHtml(item.imageUrl)}" alt="${escHtml(item.title)}" loading="lazy" />`
    : `<div class="no-image">
         <span class="no-image-icon">&#127183;</span>
         <span>No image</span>
       </div>`;

  // Parse card details for a specific subtitle
  const parsed = parseCardTitle(item.title);
  const tagParts = [parsed.year, parsed.set, parsed.parallel].filter(Boolean);
  const cardTag = tagParts.length >= 2 ? tagParts.join(' ') : '';
  const cardTagHtml = cardTag ? `<p class="card-tag">${escHtml(cardTag)}</p>` : '';

  card.innerHTML = `
    <div class="card-accent"></div>
    ${badgeHtml}
    <div class="card-image-wrap">${imageHtml}</div>
    <div class="card-body">
      ${cardTagHtml}
      <p class="card-title">${escHtml(item.title)}</p>
      <p class="card-price">${price}</p>
      <div class="card-meta">
        ${dateHtml}
        <span class="card-condition">${escHtml(item.condition)}</span>
        ${!isSold ? buyingOptionBadgeHtml(item) : ''}
      </div>
      ${!isSold ? `<a class="card-link" href="${epnUrl(item.itemUrl)}" target="_blank" rel="noopener noreferrer">View on eBay &#8599;</a>` : ''}
    </div>
  `;

  // Open modal on card click (but not when clicking the eBay link)
  card.addEventListener('click', (e) => {
    if (e.target.closest('.card-link')) return;
    openCardModal(item);
  });

  return card;
}

// ---- Card Detail Modal ----
const cardModal = document.getElementById('card-modal');
const cardModalShowing = document.getElementById('card-modal-showing');
const cardModalImage = document.getElementById('card-modal-image');
const cardModalTitle = document.getElementById('card-modal-title');
const cardModalPrice = document.getElementById('card-modal-price');
const cardModalMeta = document.getElementById('card-modal-meta');
const cardModalLink = document.getElementById('card-modal-link');

function openCardModal(item) {
  // "Showing X card" header with parsed details
  cardModalShowing.textContent = buildShowingText(item);

  // Image
  cardModalImage.innerHTML = item.imageUrl
    ? `<img src="${escHtml(item.imageUrl)}" alt="${escHtml(item.title)}" />`
    : `<div class="no-image"><span class="no-image-icon">&#127183;</span><span>No image</span></div>`;

  // Title & Price
  cardModalTitle.textContent = item.title || '';
  cardModalPrice.textContent = item.price
    ? `$${parseFloat(item.price).toFixed(2)}`
    : 'Price N/A';

  // Meta info
  const isSold = currentMode === 'sold';
  const badgeClass = isSold ? 'sold' : 'for-sale';
  const badgeText = isSold ? 'SOLD' : 'FOR SALE';

  const dateStr = item.soldDate
    ? new Date(item.soldDate).toLocaleDateString('en-US', {
        year: 'numeric', month: 'short', day: 'numeric',
      })
    : '';

  const dateLabel = isSold ? 'Sold' : 'Ends';

  let metaHtml = `<span class="modal-badge ${badgeClass}">${badgeText}</span>`;
  if (dateStr) metaHtml += `<span>${dateLabel}: ${dateStr}</span>`;
  if (item.condition) metaHtml += `<span class="modal-condition">${escHtml(item.condition)}</span>`;
  cardModalMeta.innerHTML = metaHtml;

  // eBay link — sold items link to completed listings search, not the (possibly relisted) item page
  const isSoldModal = currentMode === 'sold';
  cardModalLink.href = isSoldModal
    ? epnUrl(`https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(item.title)}&LH_Sold=1&LH_Complete=1`)
    : epnUrl(item.itemUrl || '#');
  cardModalLink.textContent = isSoldModal ? 'View sold listings on eBay ↗' : 'View on eBay ↗';

  // Show modal
  cardModal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function closeCardModal() {
  cardModal.classList.add('hidden');
  document.body.style.overflow = '';
}

// Close on overlay click
cardModal.querySelector('.card-modal-overlay').addEventListener('click', closeCardModal);
// Close on X button
cardModal.querySelector('.card-modal-close').addEventListener('click', closeCardModal);
// Close on Escape key
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !cardModal.classList.contains('hidden')) {
    closeCardModal();
  }
});

// ---- eBay Partner Network Affiliate Tracking ----
const EPN_PARAMS = 'mkcid=1&mkrid=711-53200-19255-0&siteid=0&campid=5339145753&toolid=10001&mkevt=1';
function epnUrl(url) {
  if (!url || typeof url !== 'string' || !url.includes('ebay.com')) return url || '#';
  return url + (url.includes('?') ? '&' : '?') + EPN_PARAMS;
}

// ---- Helpers ----
function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function setLoading(isLoading) {
  btn.disabled = isLoading;
  loading.classList.toggle('hidden', !isLoading);
}

// ---- Auth (localStorage-based) ----
const loginOverlay = document.getElementById('login-overlay');
const authBtn = document.getElementById('auth-btn');
const authBtnText = document.getElementById('auth-btn-text');
const loginHeading = document.getElementById('login-heading');
const loginSubtext = document.getElementById('login-subtext');
const authSubmitBtn = document.getElementById('auth-submit-btn');
const loginError = document.getElementById('login-error');
const authConfirm = document.getElementById('auth-confirm');
const authEmail = document.getElementById('auth-email');
const loginToggleText = document.getElementById('login-toggle-text');
const loginToggleLink = document.getElementById('login-toggle-link');

let authMode = 'login'; // 'login' or 'signup'

function getUsers() {
  try { return JSON.parse(localStorage.getItem('cardHuddleUsers') || '{}'); }
  catch { return {}; }
}

function getSessionToken() { return localStorage.getItem('cardHuddleToken') || null; }
function setSessionToken(token) {
  if (token) localStorage.setItem('cardHuddleToken', token);
  else localStorage.removeItem('cardHuddleToken');
}

function getCurrentUser() {
  return localStorage.getItem('cardHuddleCurrentUser') || null;
}

function setCurrentUser(username) {
  if (username) {
    localStorage.setItem('cardHuddleCurrentUser', username);
  } else {
    localStorage.removeItem('cardHuddleCurrentUser');
  }
  updateAuthButton();
  if (typeof updateProButton === 'function') updateProButton();
  if (username) { if (typeof startDmPoller === 'function') startDmPoller(); }
  else { if (typeof updateDmBadge === 'function') updateDmBadge(0); if (typeof disconnectDmSocket === 'function') disconnectDmSocket(); }
}

function updateAuthButton() {
  const user = getCurrentUser();
  if (user) {
    authBtnText.textContent = user;
    authBtn.classList.add('logged-in');
    authBtn.onclick = toggleAuthDropdown;
  } else {
    authBtnText.textContent = 'Log In';
    authBtn.classList.remove('logged-in');
    authBtn.onclick = showLogin;
    // Remove dropdown if present
    const existing = document.querySelector('.auth-dropdown');
    if (existing) existing.remove();
  }
}

function toggleAuthDropdown() {
  let dropdown = document.querySelector('.auth-dropdown');
  if (dropdown) {
    dropdown.remove();
    return;
  }

  const user = getCurrentUser();
  const users = getUsers();
  const userData = users[user?.toLowerCase()] || {};
  const email = userData.email || '';

  dropdown = document.createElement('div');
  dropdown.className = 'auth-dropdown';
  dropdown.innerHTML = `
    <div class="auth-dropdown-header">
      <div class="auth-dropdown-avatar">${(user || '?')[0].toUpperCase()}</div>
      <div class="auth-dropdown-info">
        <div class="auth-dropdown-username">${user}</div>
        <div class="auth-dropdown-email-display">${email || 'No email added'}</div>
      </div>
    </div>
    <div class="auth-dropdown-email-section">
      <input type="email" class="auth-dropdown-email-input" placeholder="${email ? 'Update email address' : 'Add email address'}" value="${email}" />
      <button class="auth-dropdown-save-btn" onclick="saveDropdownEmail(this)">Save</button>
    </div>
    <div class="auth-dropdown-divider"></div>
    <button onclick="closeAuthDropdown(); showSettings()">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
      Settings
    </button>
    <button class="auth-dropdown-logout" onclick="handleLogout()">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
      Log Out
    </button>
  `;

  // Append to body and position using fixed coords to avoid header overflow:hidden clipping
  document.body.appendChild(dropdown);
  const btnRect = authBtn.getBoundingClientRect();
  dropdown.style.position = 'fixed';
  dropdown.style.top = (btnRect.bottom + 6) + 'px';
  dropdown.style.left = btnRect.left + 'px';

  // Close on outside click
  setTimeout(() => {
    document.addEventListener('click', closeDropdownOutside, { once: true });
  }, 0);
}

function saveDropdownEmail(btn) {
  const input = btn.previousElementSibling;
  const email = input.value.trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    input.style.borderColor = 'var(--error)';
    setTimeout(() => { input.style.borderColor = ''; }, 2000);
    return;
  }
  const user = getCurrentUser();
  if (!user) return;
  const users = getUsers();
  if (!users[user.toLowerCase()]) return;
  users[user.toLowerCase()].email = email;
  localStorage.setItem('cardHuddleUsers', JSON.stringify(users));
  const displayEl = document.querySelector('.auth-dropdown-email-display');
  if (displayEl) displayEl.textContent = email || 'No email added';
  btn.textContent = 'Saved!';
  btn.style.background = 'var(--accent)';
  btn.style.color = '#0c0e14';
  setTimeout(() => closeAuthDropdown(), 1200);
}

function closeDropdownOutside(e) {
  const dropdown = document.querySelector('.auth-dropdown');
  if (dropdown && !dropdown.contains(e.target) && !authBtn.contains(e.target)) {
    dropdown.remove();
  }
}

function closeAuthDropdown() {
  const dropdown = document.querySelector('.auth-dropdown');
  if (dropdown) dropdown.remove();
}

function showLogin() {
  authMode = 'login';
  updateLoginForm();
  loginOverlay.classList.remove('hidden');
  document.getElementById('auth-username').focus();
  ensureSocialAuthMounted();
}

// ---- Social Sign-In (Google / Apple) ----
// Providers are mounted lazily: ask the server which are configured,
// then load the relevant identity SDKs on demand. If neither is enabled
// the whole social-auth row stays hidden and we look exactly like before.
let _socialAuthState = null;

async function ensureSocialAuthMounted() {
  if (_socialAuthState) return _socialAuthState;
  const wrap = document.getElementById('social-auth');
  const googleSlot = document.getElementById('google-signin');
  const appleBtn = document.getElementById('apple-signin');
  if (!wrap) return null;
  _socialAuthState = { google: false, apple: false };
  try {
    const res = await fetch('/api/auth/providers');
    if (!res.ok) return _socialAuthState;
    const data = await res.json();
    if (data.google && data.google.enabled) {
      _socialAuthState.google = true;
      _socialAuthState.googleClientId = data.google.clientId;
      mountGoogleSignIn(data.google.clientId, googleSlot);
    }
    if (data.apple && data.apple.enabled) {
      _socialAuthState.apple = true;
      _socialAuthState.appleClientId = data.apple.clientId;
      mountAppleSignIn(data.apple.clientId, appleBtn);
    }
    if (_socialAuthState.google || _socialAuthState.apple) {
      wrap.classList.remove('hidden');
    }
  } catch (err) {
    console.warn('[auth] providers fetch failed:', err && err.message);
  }
  return _socialAuthState;
}

function mountGoogleSignIn(clientId, slot) {
  if (!clientId || !slot) return;
  slot.classList.remove('hidden');
  const render = () => {
    try {
      window.google.accounts.id.initialize({
        client_id: clientId,
        callback: handleGoogleCredential,
        ux_mode: 'popup',
        auto_select: false,
      });
      slot.innerHTML = '';
      window.google.accounts.id.renderButton(slot, {
        theme: document.documentElement.getAttribute('data-theme') === 'light' ? 'outline' : 'filled_black',
        size: 'large',
        shape: 'rectangular',
        text: 'continue_with',
        width: 280,
      });
    } catch (err) {
      console.warn('[auth] Google SDK init failed:', err && err.message);
    }
  };
  if (window.google && window.google.accounts && window.google.accounts.id) {
    render();
    return;
  }
  if (document.getElementById('google-id-script')) {
    document.getElementById('google-id-script').addEventListener('load', render);
    return;
  }
  const script = document.createElement('script');
  script.id = 'google-id-script';
  script.src = 'https://accounts.google.com/gsi/client';
  script.async = true;
  script.defer = true;
  script.onload = render;
  script.onerror = () => console.warn('[auth] failed to load Google Identity script');
  document.head.appendChild(script);
}

async function handleGoogleCredential(response) {
  const credential = response && response.credential;
  if (!credential) return;
  loginError.classList.add('hidden');
  try {
    const res = await fetch('/api/auth/google', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential }),
    });
    const data = await safeJson(res);
    if (!res.ok || !data.token || !data.username) {
      loginError.textContent = (data && data.error) || 'Google sign-in failed.';
      loginError.classList.remove('hidden');
      return;
    }
    setSessionToken(data.token);
    setCurrentUser(data.username);
    if (data.email) {
      const users = getUsers();
      const key = data.username.toLowerCase();
      if (!users[key]) users[key] = {};
      users[key].email = data.email;
      localStorage.setItem('cardHuddleUsers', JSON.stringify(users));
    }
    closeLogin();
    syncSubscriptionStatus().catch(() => {});
    enableUserSync().catch(() => {});
  } catch (err) {
    loginError.textContent = describeAuthError(err);
    loginError.classList.remove('hidden');
  }
}

function mountAppleSignIn(clientId, btn) {
  if (!clientId || !btn) return;
  btn.classList.remove('hidden');
  _socialAuthState.appleClientId = clientId;
  // Apple's JS SDK is optional — we use it for the popup flow when
  // available, otherwise fall back to a manual redirect.
  if (document.getElementById('apple-id-script')) return;
  const script = document.createElement('script');
  script.id = 'apple-id-script';
  script.src = 'https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js';
  script.async = true;
  script.defer = true;
  script.onload = () => {
    try {
      window.AppleID.auth.init({
        clientId,
        scope: 'name email',
        redirectURI: window.location.origin + '/',
        usePopup: true,
      });
    } catch (err) {
      console.warn('[auth] Apple init failed:', err && err.message);
    }
  };
  document.head.appendChild(script);
}

async function handleAppleSignIn() {
  loginError.classList.add('hidden');
  if (!window.AppleID || !window.AppleID.auth) {
    loginError.textContent = 'Apple Sign-In is loading — try again in a moment.';
    loginError.classList.remove('hidden');
    return;
  }
  try {
    const result = await window.AppleID.auth.signIn();
    const idToken = result && result.authorization && result.authorization.id_token;
    if (!idToken) {
      loginError.textContent = 'Apple Sign-In did not return a token.';
      loginError.classList.remove('hidden');
      return;
    }
    const res = await fetch('/api/auth/apple', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id_token: idToken }),
    });
    const data = await safeJson(res);
    if (!res.ok || !data.token || !data.username) {
      loginError.textContent = (data && data.error) || 'Apple sign-in failed.';
      loginError.classList.remove('hidden');
      return;
    }
    setSessionToken(data.token);
    setCurrentUser(data.username);
    if (data.email) {
      const users = getUsers();
      const key = data.username.toLowerCase();
      if (!users[key]) users[key] = {};
      users[key].email = data.email;
      localStorage.setItem('cardHuddleUsers', JSON.stringify(users));
    }
    closeLogin();
    syncSubscriptionStatus().catch(() => {});
    enableUserSync().catch(() => {});
  } catch (err) {
    // popup_closed_by_user is a normal cancellation — don't show as an error
    if (err && /popup_closed|user_cancelled|cancelled/i.test(String(err.error || err.message || err))) return;
    loginError.textContent = describeAuthError(err);
    loginError.classList.remove('hidden');
  }
}

function closeLogin() {
  loginOverlay.classList.add('hidden');
  loginError.classList.add('hidden');
  document.getElementById('login-form').reset();
}

function toggleAuthMode(e) {
  e.preventDefault();
  authMode = authMode === 'login' ? 'signup' : 'login';
  updateLoginForm();
}

function updateLoginForm() {
  loginError.classList.add('hidden');
  if (authMode === 'signup') {
    loginHeading.textContent = 'Create Account';
    loginSubtext.textContent = 'Join The Card Huddle';
    authSubmitBtn.textContent = 'Create Account';
    authConfirm.classList.remove('hidden');
    authConfirm.required = true;
    authEmail.classList.remove('hidden');
    loginToggleText.textContent = 'Already have an account?';
    loginToggleLink.textContent = 'Log In';
  } else {
    loginHeading.textContent = 'Log In';
    loginSubtext.textContent = 'Welcome back to The Card Huddle';
    authSubmitBtn.textContent = 'Log In';
    authConfirm.classList.add('hidden');
    authConfirm.required = false;
    authEmail.classList.add('hidden');
    loginToggleText.textContent = "Don't have an account?";
    loginToggleLink.textContent = 'Sign Up';
  }
}

// Translate a fetch failure into a message that tells the user what to do,
// not a stack trace. AbortError = our own timeout, TypeError = browser
// couldn't open the connection at all.
function describeAuthError(err) {
  const name = err && err.name;
  const msg = (err && err.message) || String(err);
  if (name === 'AbortError') return 'The server took too long to respond. Try again — first sign-up after a quiet period can be slow.';
  if (name === 'TypeError') return 'Could not reach the server. Check your connection and try again.';
  return msg || 'Something went wrong. Try again.';
}

// Cold-start tolerant fetch wrapper. The first hit on a fresh worker has to
// preload KV and import server.js, which on a slow link can push past 15s.
// Bumped to 30s so the timeout doesn't fire mid-handshake.
async function authFetchJson(url, body) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 30000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: abort.signal,
    });
    return { res, data: await safeJson(res) };
  } finally {
    clearTimeout(timer);
  }
}

async function handleAuth(e) {
  e.preventDefault();
  const username = document.getElementById('auth-username').value.trim();
  const password = document.getElementById('auth-password').value;
  loginError.classList.add('hidden');

  const authSubmitBtn = document.getElementById('auth-submit-btn');
  if (authSubmitBtn) authSubmitBtn.disabled = true;

  try {
    if (authMode === 'signup') {
      const confirm = authConfirm.value;
      if (password !== confirm) {
        loginError.textContent = 'Passwords do not match';
        loginError.classList.remove('hidden');
        return false;
      }
      const email = document.getElementById('auth-email').value.trim();
      const { res, data } = await authFetchJson('/api/auth/register', { username, password, email });
      if (!res.ok) {
        loginError.textContent = data.error || 'Registration failed';
        loginError.classList.remove('hidden');
        return false;
      }
      // Server must return { token, username }. If either is missing the
      // user appears "still logged out" after the modal closes, so flag
      // it rather than silently storing undefined.
      if (!data || !data.token || !data.username) {
        console.error('[auth/register] unexpected response shape:', data);
        loginError.textContent = 'Sign-up succeeded but the server response was malformed. Try logging in.';
        loginError.classList.remove('hidden');
        return false;
      }
      setSessionToken(data.token);
      setCurrentUser(data.username);
      // Mirror the credentials into the local users db too, so that if a
      // future KV-read fails (eventual consistency, transient outage) the
      // local-fallback path in login can still let the user in on this
      // device. The /api/auth/login route is what actually authenticates;
      // this is just a belt-and-suspenders cache.
      {
        const usersLocal = getUsers();
        const lkey = data.username.toLowerCase();
        if (!usersLocal[lkey]) usersLocal[lkey] = {};
        usersLocal[lkey].username = data.username;
        usersLocal[lkey].password = password;
        if (email) usersLocal[lkey].email = email;
        localStorage.setItem('cardHuddleUsers', JSON.stringify(usersLocal));
      }
      closeLogin();
      // Everything below is fire-and-forget: the user is already signed in,
      // so a slow subscription/sync fetch must not block the modal closing
      // or the submit button re-enabling. Any earlier `await` here is what
      // made the screen feel "frozen" after a cold-start register.
      syncSubscriptionStatus().catch(err => console.warn('[auth] sub sync failed:', err && err.message || err));
      enableUserSync().catch(err => console.warn('[sync] init failed:', err && err.message || err));
    } else {
      const { res, data } = await authFetchJson('/api/auth/login', { username, password });
      if (!res.ok) {
        // Server doesn't know this user. If the local users db (legacy
        // accounts created before server-side auth, or accounts whose KV
        // write was killed pre-#222) has a matching password, run a
        // quiet migration: register the account on the server with the
        // same credentials so the next login on any device succeeds for
        // real. If migration fails for some reason, fall back to the
        // local-only login like before so the user isn't locked out on
        // this device.
        const users = getUsers();
        const localUser = users[username.toLowerCase()];
        if (localUser && localUser.password === password) {
          let migrated = false;
          try {
            const email = (localUser.email || '').trim();
            const mig = await authFetchJson('/api/auth/register', { username, password, email });
            if (mig.res.ok && mig.data && mig.data.token && mig.data.username) {
              setSessionToken(mig.data.token);
              setCurrentUser(mig.data.username);
              if (mig.data.email || email) {
                const usersNow = getUsers();
                const key = mig.data.username.toLowerCase();
                if (!usersNow[key]) usersNow[key] = {};
                usersNow[key].email = mig.data.email || email;
                localStorage.setItem('cardHuddleUsers', JSON.stringify(usersNow));
              }
              migrated = true;
              console.log('[auth] migrated local account to cloud');
            } else if (mig.res.status === 409) {
              // Server already has this username under a different password
              // (someone else registered it, or a stale prior attempt).
              // Can't migrate; just keep local-only login.
              console.warn('[auth] cannot migrate — username already taken on server');
            }
          } catch (err) {
            console.warn('[auth] migration attempt failed, falling back to local-only:', err && err.message || err);
          }
          if (!migrated) setCurrentUser(localUser.username);
          closeLogin();
          syncSubscriptionStatus().catch(() => {});
          if (migrated) enableUserSync().catch(() => {});
          return false;
        }
        loginError.textContent = data.error || 'Login failed';
        loginError.classList.remove('hidden');
        return false;
      }
      if (!data || !data.token || !data.username) {
        console.error('[auth/login] unexpected response shape:', data);
        loginError.textContent = 'Login succeeded but the server response was malformed. Refresh and try again.';
        loginError.classList.remove('hidden');
        return false;
      }
      setSessionToken(data.token);
      setCurrentUser(data.username);
      if (data.email) {
        const users = getUsers();
        const key = data.username.toLowerCase();
        if (!users[key]) users[key] = {};
        users[key].email = data.email;
        localStorage.setItem('cardHuddleUsers', JSON.stringify(users));
      }
      closeLogin();
      syncSubscriptionStatus().catch(err => console.warn('[auth] sub sync failed:', err && err.message || err));
      enableUserSync().catch(err => console.warn('[sync] init failed:', err && err.message || err));
    }
  } catch (err) {
    loginError.textContent = describeAuthError(err);
    loginError.classList.remove('hidden');
  } finally {
    if (authSubmitBtn) authSubmitBtn.disabled = false;
  }
  return false;
}

function handleLogout() {
  closeAuthDropdown();
  const token = getSessionToken();
  if (token) fetch('/api/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
  disableUserSync();
  setSessionToken(null);
  setCurrentUser(null);
}

// Close login modal on overlay click
loginOverlay.addEventListener('click', (e) => {
  if (e.target === loginOverlay) closeLogin();
});

// Close login on Escape
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !loginOverlay.classList.contains('hidden')) {
    closeLogin();
  }
});

// Init auth state on load
updateAuthButton();

// ---- Fund The Card Huddle ----
// No memberships, no paywalls — every feature is free for everyone. The site is
// community-funded: eBay Partner Network affiliate links on every listing,
// optional sponsors, and voluntary donations collected here via Stripe (one-time
// or a recurring monthly "Supporter"). Donations unlock NO extra features.
let _subscription = null;     // legacy: only set for pre-existing real subs
let _fundAmount = 5;          // selected donation amount in dollars
let _fundRecurring = false;   // monthly supporter vs one-time
let _checkoutEnabled = true;

function getUserSubscription() { return _subscription; }
// Memberships removed — nothing is gated. Kept so any legacy caller stays safe.
function hasPro() { return false; }
function isProPlus() { return false; }
function isProOrPlus() { return true; }

// Sold data is free for everyone but capped per day to protect the shared
// scrape.do quota while we're community-funded. The pill shows how many are
// left today and routes to the Fund modal — the cap lifts as funding grows.
let _soldUsage = null;
async function refreshSoldUsage() {
  try {
    const token = getSessionToken();
    const res = await fetch('/api/sold-usage', { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!res.ok) return;
    _soldUsage = await res.json();
  } catch { return; }
  renderSoldUsagePill();
}

function renderSoldUsagePill() {
  let pill = document.getElementById('sold-usage-pill');
  const u = _soldUsage;
  // Hide for own-key users (unlimited) or when usage is unknown.
  if (!u || u.unlimited || typeof u.remaining !== 'number') {
    if (pill) pill.style.display = 'none';
    return;
  }
  if (!pill) {
    pill = document.createElement('button');
    pill.id = 'sold-usage-pill';
    pill.type = 'button';
    pill.onclick = () => showFund(`You have ${(_soldUsage && _soldUsage.remaining) || 0} free sold searches left today. The cap protects our shared data costs — fund us to help lift it.`);
    pill.style.cssText = 'display:inline-flex;align-items:center;gap:6px;border:1px solid var(--border,#ddd);'
      + 'background:var(--bg-secondary,#f4f4f6);color:var(--text-secondary,#555);border-radius:999px;'
      + 'padding:4px 12px;font-size:.78rem;cursor:pointer;margin:6px auto 0;font-family:inherit';
    const form = document.getElementById('search-form');
    if (form && form.parentNode) form.parentNode.insertBefore(pill, form.nextSibling);
    else document.body.appendChild(pill);
  }
  pill.style.display = 'inline-flex';
  pill.textContent = u.remaining > 0
    ? `${u.remaining} free sold searches left today · ♥ Fund to lift the cap`
    : 'Daily sold-search limit reached · ♥ Fund to help lift it';
}

// Still pull /api/auth/me so a legacy subscriber can reach the billing portal to
// cancel now that the site is free; refreshes the Fund button either way.
async function syncSubscriptionStatus() {
  const user = getCurrentUser();
  if (!user) { _subscription = null; updateProButton(); return; }
  try {
    const token = getSessionToken();
    const res = await fetch('/api/auth/me', { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (res.ok) { const data = await res.json(); _subscription = data.subscription || null; }
  } catch { /* offline — keep last-known */ }
  updateProButton();
}

// ---- Fund modal (self-contained: injects its own DOM + styles) ----
function _ensureFundModal() {
  if (document.getElementById('fund-overlay')) return;
  const style = document.createElement('style');
  style.textContent = `
    #fund-overlay{position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:9999;padding:20px}
    #fund-overlay.hidden{display:none}
    .fund-card{background:var(--bg-card,#1a2133);color:var(--text-primary,#edf0f7);border:1px solid var(--border-primary,#232d42);border-radius:16px;max-width:430px;width:100%;padding:28px;box-shadow:0 20px 60px rgba(0,0,0,.45);position:relative;font-family:inherit}
    .fund-card h2{margin:0 0 6px;font-size:1.4rem;color:var(--text-primary,#edf0f7)}
    .fund-sub{color:var(--text-secondary,#9aa4bf);font-size:.9rem;margin:0 0 18px;line-height:1.5}
    .fund-amounts{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:12px}
    .fund-amt{border:1px solid var(--border-primary,#2b3650);background:var(--bg-secondary,#161b28);color:var(--text-primary,#edf0f7);padding:11px 0;border-radius:10px;cursor:pointer;font-weight:700;font-size:.95rem;font-family:inherit}
    .fund-amt.active{background:var(--accent,#5ece99);color:#06281b;border-color:var(--accent,#5ece99)}
    .fund-custom{width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid var(--border-primary,#2b3650);border-radius:10px;margin-bottom:14px;font-size:.95rem;font-family:inherit;background:var(--bg-secondary,#161b28);color:var(--text-primary,#edf0f7)}
    .fund-recurring{display:flex;align-items:center;gap:8px;font-size:.9rem;margin-bottom:16px;cursor:pointer;color:var(--text-secondary,#9aa4bf)}
    .fund-cta{width:100%;border:0;background:var(--accent,#5ece99);color:#06281b;padding:13px;border-radius:10px;font-size:1rem;font-weight:800;cursor:pointer;font-family:inherit}
    .fund-cta:disabled{opacity:.5;cursor:not-allowed}
    .fund-x{position:absolute;top:14px;right:16px;border:0;background:transparent;font-size:1.4rem;line-height:1;cursor:pointer;color:var(--text-secondary,#9aa4bf)}
    .fund-foot{margin-top:14px;font-size:.74rem;color:var(--text-muted,#6b7488);text-align:center;line-height:1.5}
  `;
  document.head.appendChild(style);
  const overlay = document.createElement('div');
  overlay.id = 'fund-overlay';
  overlay.className = 'hidden';
  overlay.innerHTML = `
    <div class="fund-card" role="dialog" aria-modal="true" aria-label="Fund The Card Huddle">
      <button class="fund-x" aria-label="Close" onclick="closeFund()">&times;</button>
      <h2>&#9829; Fund The Card Huddle</h2>
      <p class="fund-sub" id="fund-reason">The Card Huddle is free for everyone — no paywalls, ever. It runs on community support. Chip in to help cover sold-data costs and keep it growing.</p>
      <div class="fund-goal" id="fund-goal" style="display:none">
        <div class="fund-goal-row"><span id="fund-goal-text">—</span><span id="fund-goal-supporters"></span></div>
        <div class="fund-goal-track"><div class="fund-goal-fill" id="fund-goal-fill"></div></div>
      </div>
      <div class="fund-amounts" id="fund-amounts">
        ${[3, 5, 10, 25].map(a => `<button type="button" class="fund-amt${a === 5 ? ' active' : ''}" data-amt="${a}" onclick="selectFundAmount(${a})">$${a}</button>`).join('')}
      </div>
      <input class="fund-custom" id="fund-custom" type="number" min="1" max="1000" step="1" placeholder="Custom amount ($)" oninput="setFundCustom(this.value)" />
      <label class="fund-recurring"><input type="checkbox" id="fund-recurring" onchange="toggleFundRecurring(this.checked)" /> Make it monthly (become a Supporter)</label>
      <button class="fund-cta" id="fund-cta" onclick="submitDonation()">Donate $5</button>
      <p class="fund-foot">Secure checkout via Stripe &middot; Donations are voluntary and unlock no extra features — everything's free.</p>
    </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeFund(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !overlay.classList.contains('hidden')) closeFund(); });
}

function showFund(reason) {
  _ensureFundModal();
  const r = document.getElementById('fund-reason');
  if (r && reason) r.textContent = reason;
  _updateFundCta();
  loadFundGoal();
  document.getElementById('fund-overlay').classList.remove('hidden');
}

// ---- Funding goal progress ("$X of $Y this month") ----
let _fundGoal = null;
async function loadFundGoal() {
  try {
    const res = await fetch('/api/fund-goal');
    if (!res.ok) return;
    _fundGoal = await res.json();
  } catch { return; }
  renderFundGoal();
}
function renderFundGoal() {
  const g = _fundGoal;
  if (!g) return;
  const pct = typeof g.pct === 'number' ? g.pct : 0;
  const reached = pct >= 100;
  const width = Math.min(100, pct);
  const raised = Math.round(g.raised || 0);
  const goal = Math.round(g.goal || 0);
  const supText = g.supporters ? `${g.supporters} monthly supporter${g.supporters !== 1 ? 's' : ''}` : '';
  // Modal bar
  const box = document.getElementById('fund-goal');
  if (box) {
    box.style.display = 'block';
    box.classList.toggle('goal-reached', reached);
    const t = document.getElementById('fund-goal-text');
    if (t) t.textContent = reached ? `🎉 $${raised} raised — this month's goal is met!` : `$${raised} of $${goal} this month`;
    const s = document.getElementById('fund-goal-supporters'); if (s) s.textContent = supText;
    const fill = document.getElementById('fund-goal-fill'); if (fill) fill.style.width = width + '%';
  }
  // Footer bar (always visible passive nudge)
  const foot = document.getElementById('fund-goal-footer');
  if (foot) {
    foot.classList.remove('hidden');
    foot.classList.toggle('goal-reached', reached);
    const label = reached
      ? `&#127881; <strong>$${raised}</strong> raised — this month's goal is met. Thank you! &#128153;`
      : `Monthly goal: <strong>$${raised}</strong> of $${goal}${supText ? ' &middot; ' + escHtml(supText) : ''}`;
    foot.innerHTML = `<div class="fund-goal-foot-label">${label}</div>`
      + `<div class="fund-goal-track"><div class="fund-goal-fill" style="width:${width}%"></div></div>`
      + `<button type="button" class="fund-goal-foot-btn" onclick="showFund()">${reached ? '&#9829; Keep it going' : '&#9829; Chip in'}</button>`;
  }
}
// Back-compat: plenty of code still calls showUpgrade()/showPricing(). With
// memberships gone these all become a gentle "support us" nudge.
function showUpgrade(reason) { showFund(reason); }
function showPricing() { showFund(); }
function setPricingPeriod() {}
function handleSubscribe() { showFund(); }
function closeFund() { const o = document.getElementById('fund-overlay'); if (o) o.classList.add('hidden'); }
function closePricing() { closeFund(); }

function selectFundAmount(a) {
  _fundAmount = a;
  const custom = document.getElementById('fund-custom'); if (custom) custom.value = '';
  document.querySelectorAll('#fund-amounts .fund-amt').forEach(b => b.classList.toggle('active', Number(b.dataset.amt) === a));
  _updateFundCta();
}
function setFundCustom(val) {
  const n = parseFloat(val);
  if (n > 0) { _fundAmount = n; document.querySelectorAll('#fund-amounts .fund-amt').forEach(b => b.classList.remove('active')); }
  _updateFundCta();
}
function toggleFundRecurring(on) { _fundRecurring = !!on; _updateFundCta(); }
function _updateFundCta() {
  const cta = document.getElementById('fund-cta');
  if (!cta) return;
  const amt = _fundAmount > 0 ? _fundAmount : 0;
  cta.textContent = _fundRecurring ? `Support $${amt}/mo` : `Donate $${amt}`;
}

async function submitDonation() {
  const amt = _fundAmount;
  if (!(amt >= 1)) { alert('Please choose an amount of at least $1.'); return; }
  const cta = document.getElementById('fund-cta');
  if (cta) { cta.disabled = true; cta.textContent = 'Redirecting…'; }
  try {
    const res = await fetch('/api/stripe/create-donation', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: amt, recurring: _fundRecurring }),
    });
    const data = await safeJson(res);
    if (res.ok && data.url) { window.location.href = data.url; return; }
    alert(`Couldn't start the donation:\n\n${(data && (data.detail || data.error)) || `HTTP ${res.status}`}`);
  } catch (err) {
    alert(`Couldn't reach Stripe:\n\n${(err && err.message) || err}`);
  } finally {
    if (cta) { cta.disabled = false; _updateFundCta(); }
  }
}

// Header button → opens the Fund modal.
function updateProButton() {
  const btn = document.getElementById('pro-btn');
  if (!btn) return;
  btn.textContent = '♥ Fund';
  btn.classList.remove('subscribed');
  btn.onclick = () => showFund();
}

// Kept for any legacy subscriber who wants to cancel from Settings.
async function openBillingPortal() {
  const token = getSessionToken();
  try {
    const res = await fetch('/api/stripe/create-portal-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ username: getCurrentUser() }),
    });
    const data = await safeJson(res);
    if (res.ok && data.url) { window.location.href = data.url; return; }
    alert(`Couldn't open the billing portal:\n\n${(data && (data.detail || data.error)) || `HTTP ${res.status}`}`);
  } catch (err) {
    alert(`Couldn't reach Stripe:\n\n${(err && err.message) || err}`);
  }
}

// Donations aren't gated by the old tax-pause switch; this just records state.
function applyCheckoutState(enabled) { _checkoutEnabled = !!enabled; }

// ---- Soft Limits (Free tier) ----
// Free users get a generous but capped slice of every feature. Pro
// removes the caps. Each gate is a single function so the call site
// stays a one-liner: `if (!checkLimitFoo()) return;`
//
// Daily counters live in localStorage and reset on date change. Cap
// limits (collection size, watchlist size) compare against the
// existing local arrays. proPrompt() shows the pricing modal with a
// short reason in the title bar so the user knows why they're seeing
// it — much higher conversion than a generic "upgrade now".

// Everything is free and uncapped now. Kept only so the (always-passing) limit
// helpers still have values to reference. Promoted listings are capped at 5.
const FREE_LIMITS = {
  collection: Infinity,
  watchlist: Infinity,
  promotedSlots: 5,
  dailyGrading: Infinity,
  dailyAutoPricer: Infinity,
};

function _todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}
function _dailyUseGet(name) {
  try {
    const raw = JSON.parse(localStorage.getItem('cardHuddleDailyUse') || '{}');
    if (raw.day !== _todayKey()) return 0;
    return raw.counts && raw.counts[name] ? raw.counts[name] : 0;
  } catch { return 0; }
}
function _dailyUseInc(name) {
  let raw = {};
  try { raw = JSON.parse(localStorage.getItem('cardHuddleDailyUse') || '{}'); } catch {}
  if (raw.day !== _todayKey()) raw = { day: _todayKey(), counts: {} };
  raw.counts = raw.counts || {};
  raw.counts[name] = (raw.counts[name] || 0) + 1;
  localStorage.setItem('cardHuddleDailyUse', JSON.stringify(raw));
}

function dailyUsesLeft(name, limit) {
  if (hasPro()) return Infinity;
  return Math.max(0, limit - _dailyUseGet(name));
}

// Memberships removed — every feature is free, so all gates pass.
function proPrompt() { return true; }
function checkDailyLimit() { return true; }
function checkCapLimit() { return true; }
function proGate() { return true; }

// syncSubscriptionStatus / updateProButton are defined above (real impls).

// Stripe redirects back with ?payment=success|cancelled. On success, confirm
// the new plan, refresh subscription + allowance, then clean the URL.
function checkPaymentReturn() {
  const params = new URLSearchParams(window.location.search);
  // Donation return: ?funded=once|monthly|cancel
  const funded = params.get('funded');
  if (funded === 'once' || funded === 'monthly') {
    alert(funded === 'monthly'
      ? 'Thank you for becoming a Supporter! 💚 Your monthly contribution keeps The Card Huddle free for everyone.'
      : 'Thank you for your support! 💚 Every dollar helps keep The Card Huddle free and growing.');
  }
  if (params.has('funded') || params.has('payment')) {
    window.history.replaceState({}, '', window.location.pathname);
  }
}

// Drip/email deep-link: ?prefill=<card> drops the visitor straight into a sold
// search for that card, closing the loop from the nurture emails to the value
// they were promised.
function checkPrefillParam() {
  const params = new URLSearchParams(window.location.search);
  const prefill = params.get('prefill');
  if (!prefill) return;
  const inp = document.getElementById('search-input');
  const frm = document.getElementById('search-form');
  if (!inp || !frm) return;
  try { switchView('search'); } catch {}
  inp.value = prefill.slice(0, 120);
  // Strip params so a refresh doesn't re-run the search.
  window.history.replaceState({}, '', window.location.pathname);
  // Let the view switch settle before submitting.
  setTimeout(() => { frm.dispatchEvent(new Event('submit')); }, 60);
}

// updateProButton is defined above (real impl).

// Email-drip deep links (?prefill=<card>) → run that card's sold search.
checkPrefillParam();
// Pull this account's collection/watchlist/etc. from the server so they show
// up here even if the user signed in on a different device. No-op if not
// logged in (no session token).
enableUserSync();
checkPaymentReturn();

// Membership: sync the signed-in user's plan + today's free-search allowance,
// and learn whether paid checkout is currently open (server kill-switch).
syncSubscriptionStatus().catch(() => {});
refreshSoldUsage().catch(() => {});
fetch(`/api/stripe/config?_=${Date.now()}`, { cache: 'no-store' })
  .then(r => r.json())
  .then(cfg => { if (cfg && typeof cfg.checkoutEnabled === 'boolean') applyCheckoutState(cfg.checkoutEnabled); })
  .catch(() => {});

// ---- Donate / Support button ----
// The header heart button opens the in-app "Fund The Card Huddle" modal
// (Stripe). Always shown — funding is how the free site stays alive.
function initDonateButton() {
  const btn = document.getElementById('donate-btn');
  if (!btn) return;
  btn.classList.remove('hidden');
  btn.href = '#';
  btn.onclick = (e) => { e.preventDefault(); showFund(); };
  const label = btn.querySelector('span');
  if (label) label.textContent = 'Fund';
}
initDonateButton();

// ---- Sponsors ----
// Add sponsors here as they come on board (BCW, card shops, breakers, etc.).
// Each: { name, img (logo URL), url (affiliate/landing link) }. The strip stays
// hidden until at least one is configured, so it never ships empty.
//   e.g. { name: 'BCW Supplies', img: '/sponsors/bcw.png', url: 'https://www.bcwsupplies.com/?aff=...' }
// Show the monthly funding-goal bar in the footer on load.
loadFundGoal();

const SPONSORS = [];

function renderSponsors() {
  const strip = document.getElementById('sponsor-strip');
  if (!strip) return;
  if (!Array.isArray(SPONSORS) || SPONSORS.length === 0) {
    strip.classList.add('hidden');
    return;
  }
  strip.innerHTML = '<span class="sponsor-label">Supported by</span>'
    + SPONSORS.map(s => {
        const inner = s.img
          ? `<img src="${escHtml(s.img)}" alt="${escHtml(s.name || 'Sponsor')}" loading="lazy" />`
          : escHtml(s.name || 'Sponsor');
        return `<a class="sponsor-item" href="${escHtml(s.url || '#')}" target="_blank" rel="noopener sponsored" title="${escHtml(s.name || '')}">${inner}</a>`;
      }).join('');
  strip.classList.remove('hidden');
}
renderSponsors();

// ---- Checklist Browse Feature ----
const checklistView = document.getElementById('checklist-view');
const checklistProducts = document.getElementById('checklist-products');
const checklistProductGrid = document.getElementById('checklist-product-grid');
const checklistBrowser = document.getElementById('checklist-browser');
const checklistProductName = document.getElementById('checklist-product-name');
const checklistSearch = document.getElementById('checklist-search');
const checklistSets = document.getElementById('checklist-sets');
const checklistCategoryTabs = document.getElementById('checklist-category-tabs');
const mainEl = document.querySelector('main');

let checklistData = null;
let checklistFilter = 'all';
let checklistTeamFilter = '';
let checklistVariantFilters = {}; // { setIndex: { name, printRun } }

const trackedView = document.getElementById('tracked-view');

const collectionView = document.getElementById('collection-view');
const sellerView = document.getElementById('seller-view');
const gradingView = document.getElementById('grading-view');
const rainbowPage = document.getElementById('rainbow-page');

function switchView(view) {
  // Map legacy top-level view names onto the new 5-tab structure so
  // any deep links / older code paths still route somewhere sensible.
  // grading -> Search subtab, tracked -> My Cards subtab.
  // Tools (Auto-Pricer / Bulk Pricer / Promote Cards) is its own 'proplus' tab.
  let searchSub = null;
  let collSub = null;
  let proplusSub = null;
  if (view === 'grading') { view = 'search'; searchSub = 'grading'; }
  else if (view === 'tracked') { view = 'collection'; collSub = 'tracked'; }

  document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
  const activeTab = document.querySelector(`.nav-tab[data-view="${view}"]`);
  if (activeTab) activeTab.classList.add('active');

  const proplusView = document.getElementById('proplus-view');
  const browseView = document.getElementById('browse-view');
  const scannerView = document.getElementById('scanner-view');
  const floorView = document.getElementById('floor-view');
  const searchSubtabs = document.getElementById('search-subtabs');
  mainEl.classList.add('hidden');
  checklistView.classList.add('hidden');
  trackedView.classList.add('hidden');
  collectionView.classList.add('hidden');
  sellerView.classList.add('hidden');
  gradingView.classList.add('hidden');
  if (rainbowPage) rainbowPage.classList.add('hidden');
  if (proplusView) proplusView.classList.add('hidden');
  if (browseView) browseView.classList.add('hidden');
  if (scannerView) scannerView.classList.add('hidden');
  if (floorView) floorView.classList.add('hidden');
  if (searchSubtabs) searchSubtabs.classList.add('hidden');
  // The Floor runs an animation loop; pause it whenever we leave the tab.
  if (typeof stopFloor === 'function') stopFloor();

  if (view === 'checklist') {
    checklistView.classList.remove('hidden');
    if (!checklistData) loadChecklistProducts();
  } else if (view === 'rainbow') {
    if (rainbowPage) { rainbowPage.classList.remove('hidden'); initRainbowPage(); }
  } else if (view === 'browse') {
    if (browseView) { browseView.classList.remove('hidden'); initBrowseView(); }
  } else if (view === 'collection') {
    collectionView.classList.remove('hidden');
    initCollectionView();
    if (collSub) switchCollectionTab(collSub);
  } else if (view === 'seller') {
    sellerView.classList.remove('hidden');
    initShowcase();
  } else if (view === 'proplus') {
    if (proplusView) {
      proplusView.classList.remove('hidden');
      initProPlusView();
      switchProPlusTab(proplusSub || 'autoprices');
    }
  } else if (view === 'floor') {
    if (floorView) {
      floorView.classList.remove('hidden');
      if (typeof initFloor === 'function') initFloor();
    }
  } else {
    // Search top-tab. Show the subtab strip and either the main search
    // panel or the Grading Advisor panel based on the (optional) sub.
    if (searchSubtabs) searchSubtabs.classList.remove('hidden');
    switchSearchSub(searchSub || 'search');
  }
}

// ---- Search top-tab subtabs ----
// Toggles between the main search panel (mainEl), the Grading Advisor,
// and the Card Scanner. All three are siblings in the DOM.
function switchSearchSub(sub) {
  const tabs = document.querySelectorAll('.page-subtab[data-search-sub]');
  tabs.forEach(t => t.classList.toggle('active', t.dataset.searchSub === sub));
  const scannerView = document.getElementById('scanner-view');
  if (sub === 'grading') {
    mainEl.classList.add('hidden');
    gradingView.classList.remove('hidden');
    if (scannerView) scannerView.classList.add('hidden');
  } else if (sub === 'scanner') {
    mainEl.classList.add('hidden');
    gradingView.classList.add('hidden');
    if (scannerView) { scannerView.classList.remove('hidden'); initScannerView(); }
  } else {
    gradingView.classList.add('hidden');
    if (scannerView) scannerView.classList.add('hidden');
    mainEl.classList.remove('hidden');
  }
}

// ---- Card Scanner ----
// Sends the card photo to eBay's visual search API, shows the top matching
// listings, then loads sold prices when the user picks the right one.
// Uses the existing Browse API OAuth token — zero extra cost.
let _scannerImageDataUrl = null;
let _scannerBackImageDataUrl = null;
let _scannerLastMedian = null;
let _scannerLastQuery = null;

// Foil/shiny fronts confuse eBay's visual search, so we capture at higher
// resolution than the old 800px to give it more detail to match against.
const SCANNER_IMG_DIM = 1400;
const SCANNER_IMG_QUALITY = 0.85;

function initScannerView() { /* no gate needed */ }

async function handleScannerFile(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  if (!file.type.startsWith('image/')) { alert('Please select an image file.'); return; }
  if (file.size > 8 * 1024 * 1024) { alert('Image is too large (max 8MB).'); return; }
  try {
    _scannerImageDataUrl = await readImageFileAsDataUrl(file, SCANNER_IMG_DIM, SCANNER_IMG_QUALITY);
    document.getElementById('scanner-preview').src = _scannerImageDataUrl;
    document.getElementById('scanner-phase-upload').classList.remove('hidden');
    document.getElementById('scanner-preview-wrap').classList.remove('hidden');
    document.getElementById('scanner-error').classList.add('hidden');
    document.getElementById('scanner-phase-matches').classList.add('hidden');
    document.getElementById('scanner-results').classList.add('hidden');
  } catch (err) {
    alert('Could not load image: ' + (err.message || 'Unknown error'));
  }
}

// Optional back-of-card photo. The back is matte (no glare) and its title
// matches give us the base identity used to re-rank the front matches.
async function handleScannerBackFile(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  if (!file.type.startsWith('image/')) { alert('Please select an image file.'); return; }
  if (file.size > 8 * 1024 * 1024) { alert('Image is too large (max 8MB).'); return; }
  try {
    _scannerBackImageDataUrl = await readImageFileAsDataUrl(file, SCANNER_IMG_DIM, SCANNER_IMG_QUALITY);
    const prev = document.getElementById('scanner-back-preview');
    if (prev) prev.src = _scannerBackImageDataUrl;
    document.getElementById('scanner-back-preview-wrap').classList.remove('hidden');
    document.getElementById('scanner-back-add-label').classList.add('hidden');
  } catch (err) {
    alert('Could not load image: ' + (err.message || 'Unknown error'));
  }
}

function clearScannerBackImage() {
  _scannerBackImageDataUrl = null;
  const input = document.getElementById('scanner-back-file-input');
  if (input) input.value = '';
  document.getElementById('scanner-back-preview-wrap').classList.add('hidden');
  document.getElementById('scanner-back-add-label').classList.remove('hidden');
}

function clearScannerImage() {
  _scannerImageDataUrl = null;
  _scannerLastMedian = null;
  _scannerLastQuery = null;
  document.getElementById('scanner-file-input').value = '';
  document.getElementById('scanner-phase-upload').classList.remove('hidden');
  document.getElementById('scanner-preview-wrap').classList.add('hidden');
  document.getElementById('scanner-matching').classList.add('hidden');
  document.getElementById('scanner-error').classList.add('hidden');
  document.getElementById('scanner-phase-matches').classList.add('hidden');
  document.getElementById('scanner-results').classList.add('hidden');
  clearScannerBackImage();
  const collBtnWrap = document.getElementById('scanner-collection-btn-wrap');
  if (collBtnWrap) collBtnWrap.classList.add('hidden');
}

function showScannerMatches() {
  document.getElementById('scanner-results').classList.add('hidden');
  document.getElementById('scanner-phase-matches').classList.remove('hidden');
}

async function submitCardScan() {
  if (!_scannerImageDataUrl) { alert('Please select a card photo first.'); return; }

  const matchBtn = document.getElementById('scanner-match-btn');
  const spinner = document.getElementById('scanner-matching');
  const errEl = document.getElementById('scanner-error');

  document.getElementById('scanner-phase-upload').classList.add('hidden');
  spinner.classList.remove('hidden');
  errEl.classList.add('hidden');
  document.getElementById('scanner-phase-matches').classList.add('hidden');
  document.getElementById('scanner-results').classList.add('hidden');
  if (matchBtn) matchBtn.disabled = true;

  try {
    const res = await fetch('/api/scan-card', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        imageData: _scannerImageDataUrl,
        backImageData: _scannerBackImageDataUrl || undefined,
      }),
    });
    const data = await res.json();
    spinner.classList.add('hidden');
    if (matchBtn) matchBtn.disabled = false;

    if (!res.ok) {
      errEl.textContent = data.error || 'Image search failed. Try a clearer photo.';
      errEl.classList.remove('hidden');
      document.getElementById('scanner-phase-upload').classList.remove('hidden');
      return;
    }

    if (!data.matches || !data.matches.length) {
      errEl.textContent = 'No matching cards found. Try a clearer, straight-on photo with good lighting.';
      errEl.classList.remove('hidden');
      document.getElementById('scanner-phase-upload').classList.remove('hidden');
      return;
    }

    // If a back photo was sent, use the back's title matches to re-rank the
    // front matches so the correct card/parallel surfaces first.
    const reconciled = _reconcileMatchesWithBack(data.matches, data.backMatches || []);
    _renderScannerMatches(reconciled.matches, reconciled.identity);
  } catch (err) {
    spinner.classList.add('hidden');
    if (matchBtn) matchBtn.disabled = false;
    document.getElementById('scanner-phase-upload').classList.remove('hidden');
    errEl.textContent = 'Network error. Please try again.';
    errEl.classList.remove('hidden');
  }
}

function _broadenCardTitle(title) {
  return title
    .replace(/\b(PSA|BGS|SGC|CGC|HGA|CSG)\s*\d+(?:\.\d+)?\b/gi, '') // grades
    .replace(/#[\w-]+/g, '')           // card numbers (#269, #BU-4)
    .replace(/\/\d{1,4}\b/g, '')       // print runs (/25, /99)
    .replace(/\b(NM|MT|NM-MT|EX|VG|GD|PR|PO)\b/gi, '') // condition
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

// Key terms that decide which sold comps a scanned listing pulls — the set,
// the parallel/color, print run, grade and card type. Surfaced as labeled
// chips on each match tile so the user can confirm e.g. "Red Ice" instead of
// accidentally picking a plain "Ice" listing.
const SCAN_KEY_SETS = ['national treasures', 'prizm', 'optic', 'select', 'mosaic', 'donruss',
  'contenders', 'chronicles', 'phoenix', 'certified', 'absolute', 'spectra', 'origins',
  'illusions', 'prestige', 'luminance', 'immaculate', 'flawless', 'obsidian', 'playbook',
  'zenith', 'score', 'bowman', 'chrome', 'sage', 'leaf', 'revolution', 'hoops', 'playoff'];
const SCAN_KEY_PARALLEL_PHRASES = ['cracked ice', 'red ice', 'blue ice', 'fast break', 'tie-dye', 'snake skin'];
const SCAN_KEY_PARALLEL_WORDS = new Set(['silver', 'gold', 'blue', 'green', 'red', 'purple', 'orange',
  'pink', 'black', 'white', 'aqua', 'teal', 'emerald', 'ruby', 'sapphire', 'copper', 'bronze',
  'yellow', 'neon', 'camo', 'holo', 'hyper', 'mojo', 'cosmic', 'disco', 'lava', 'ice', 'shimmer',
  'wave', 'tiger', 'snakeskin', 'galaxy', 'choice', 'pulsar', 'sparkle', 'prizmatic', 'laser',
  'lazer', 'scope', 'reactive', 'velocity', 'genesis', 'flash', 'rainbow', 'concourse', 'pandora',
  'refractor', 'atomic', 'dragon', 'butterfly', 'seismic', 'fractor']);

const _titleCase = s => s.replace(/\b\w/g, c => c.toUpperCase());

function _scanKeyTerms(title) {
  const t = String(title || '');
  const lower = t.toLowerCase();
  const out = [];
  const seen = new Set();
  const add = v => { const k = (v || '').toLowerCase(); if (v && !seen.has(k)) { seen.add(k); out.push(v); } };

  // Set / product
  const set = SCAN_KEY_SETS.find(s => new RegExp(`\\b${s}\\b`).test(lower));
  if (set) add(_titleCase(set));

  // Multi-word parallels first (so "Red Ice" stays one chip). Strip each
  // matched phrase from the scratch text so its words aren't re-merged into a
  // stray chip (e.g. "Cracked Ice Concourse" -> "Cracked Ice" + "Concourse").
  let remaining = t;
  for (const p of SCAN_KEY_PARALLEL_PHRASES) {
    if (lower.includes(p)) { add(_titleCase(p)); remaining = remaining.replace(new RegExp(p, 'ig'), ' '); }
  }

  // Single-word parallels, merging consecutive hits in title order
  let run = [];
  const flush = () => { if (run.length) { add(run.join(' ')); run = []; } };
  for (const w of remaining.split(/\s+/)) {
    const clean = w.replace(/[^a-zA-Z-]/g, '');
    if (clean && SCAN_KEY_PARALLEL_WORDS.has(clean.toLowerCase())) run.push(_titleCase(clean));
    else flush();
  }
  flush();

  const pr = parsePrintRun(t); if (pr) add('/' + pr);
  const g = detectGrade(t); if (g && g !== 'Raw / Ungraded') add(g);
  if (/\b(rookie|rc)\b/i.test(t)) add('RC');
  if (/\bauto(graph)?\b/i.test(t)) add('Auto');
  if (/\b(patch|rpa|relic|jersey|memorabilia)\b/i.test(t)) add('Patch');
  return out;
}

function _keyTermsHtml(title) {
  const player = _extractPlayer(title);
  const year = (String(title).match(/\b(19|20)\d{2}\b/) || [])[0] || '';
  const rest = _scanKeyTerms(title);
  const chips = [];
  if (player) chips.push({ text: player, cls: 'scanner-key-chip-player' });
  if (year) chips.push({ text: year, cls: '' });
  rest.forEach(t => chips.push({ text: t, cls: '' }));
  if (!chips.length) return '';
  return `<div class="scanner-key-terms"><span class="scanner-key-label">Key terms</span>${chips.map(c => `<span class="scanner-key-chip ${c.cls}">${escHtml(c.text)}</span>`).join('')}</div>`;
}

// Build the comps search from a listing's key terms (year + player + set +
// parallel + numbering + grade) instead of the noisy full title — and keep the
// print run so comps stay matched to the right numbering.
const _SCAN_STOP = new Set([
  'panini', 'topps', 'leaf', 'sage', 'bowman', 'chrome', 'fanatics',
  'rookie', 'rc', 'auto', 'autograph', 'patch', 'rpa', 'relic', 'jersey', 'memorabilia',
  'base', 'insert', 'parallel', 'mint', 'gem', 'rare', 'hot', 'fire', 'sharp', 'centered',
  'invest', 'investment', 'psa', 'bgs', 'sgc', 'cgc', 'card', 'cards', 'nfl', 'football',
  'the', 'sp', 'ssp', 'numbered', 'of', 'to', 'rated', 'and',
  ...SCAN_KEY_SETS.join(' ').split(/\s+/),
  ...SCAN_KEY_PARALLEL_WORDS,
  ...SCAN_KEY_PARALLEL_PHRASES.join(' ').split(/\s+/),
]);

// Pull the player name — the first run of capitalized, non-stopword tokens
// once years, card numbers, print runs and grades are stripped out.
function _extractPlayer(title) {
  const s = String(title || '')
    .replace(/\b(19|20)\d{2}\b/g, ' ')
    .replace(/#[\w-]+/g, ' ')
    .replace(/\/\d{1,4}\b/g, ' ')
    .replace(/\b(PSA|BGS|SGC|CGC|HGA|CSG)\s*\d+(?:\.\d+)?\b/gi, ' ');
  const name = [];
  for (const w of s.split(/\s+/)) {
    const clean = w.replace(/[^a-zA-Z'.-]/g, '').replace(/\.$/, '');
    if (!clean) continue;
    if (_SCAN_STOP.has(clean.toLowerCase())) { if (name.length) break; else continue; }
    if (/^[A-Z]/.test(clean) && clean.length > 1) { name.push(clean); if (name.length >= 3) break; }
    else if (name.length) break;
  }
  return name.join(' ');
}

function _scanSearchQuery(title) {
  const year = (String(title).match(/\b(19|20)\d{2}\b/) || [])[0] || '';
  const player = _extractPlayer(title);
  const terms = _scanKeyTerms(title); // set, parallel(s), /printrun, grade, RC, Auto, Patch
  const q = [year, player, ...terms].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  // Fall back to a print-run-preserving broaden if we couldn't pull a player.
  if (!player || q.split(' ').length < 3) {
    return String(title)
      .replace(/\b(PSA|BGS|SGC|CGC|HGA|CSG)\s*\d+(?:\.\d+)?\b/gi, '')
      .replace(/#[\w-]+/g, '')
      .replace(/\b(NM|MT|NM-MT|EX|VG|GD|PR|PO)\b/gi, '')
      .replace(/\s+/g, ' ').trim().slice(0, 80);
  }
  return q;
}

// Helper: tally values and return the most common (consensus) one.
function _topTally(tally) {
  let best = '', bestN = 0;
  for (const [k, n] of Object.entries(tally)) { if (n > bestN) { best = k; bestN = n; } }
  return bestN > 0 ? { value: best, count: bestN } : null;
}

// Derive a consensus card identity (player surname, year, set, card number)
// from a list of eBay listing titles — used on the glare-free back matches.
function _identityFromTitles(titles) {
  const players = {}, years = {}, sets = {}, numbers = {};
  const bump = (o, k) => { if (k) o[k] = (o[k] || 0) + 1; };
  for (const t of (titles || [])) {
    const lower = String(t).toLowerCase();
    const p = _extractPlayer(t);
    if (p) bump(players, p.toLowerCase().split(' ').pop());
    bump(years, (String(t).match(/\b(19|20)\d{2}\b/) || [])[0]);
    bump(sets, SCAN_KEY_SETS.find(s => new RegExp(`\\b${s}\\b`).test(lower)));
    const num = (String(t).match(/#([\w-]+)/) || [])[1];
    bump(numbers, num ? num.toLowerCase() : '');
  }
  return {
    player: _topTally(players),
    year: _topTally(years),
    set: _topTally(sets),
    number: _topTally(numbers),
  };
}

// Score a front-match title against the back's consensus identity. Card number
// and player are the strongest identity signals.
function _scoreAgainstIdentity(title, id) {
  const orig = String(title || '');
  const lower = orig.toLowerCase();
  let score = 0;
  if (id.player && lower.includes(id.player.value)) score += 2;
  if (id.year && lower.includes(id.year.value)) score += 1;
  if (id.set && new RegExp(`\\b${id.set.value}\\b`).test(lower)) score += 1;
  if (id.number && new RegExp(`#${id.number.value}\\b`, 'i').test(orig)) score += 3;
  return score;
}

// Re-rank front matches using the back photo's identity. Front matches that
// contradict a confident player consensus are dropped (never to empty). Returns
// { matches, identity } where identity is null when there's nothing usable.
function _reconcileMatchesWithBack(frontMatches, backMatches) {
  if (!backMatches || backMatches.length === 0) return { matches: frontMatches, identity: null };
  const id = _identityFromTitles(backMatches.map(m => m.title));
  const hasSignal = id.player || id.number;
  if (!hasSignal) return { matches: frontMatches, identity: null };

  const scored = frontMatches.map((m, i) => ({
    m, i, score: _scoreAgainstIdentity(m.title, id),
  }));

  // Drop matches that clearly contradict a confident player consensus
  // (seen on 2+ back titles), but only if agreeing matches remain.
  let pool = scored;
  if (id.player && id.player.count >= 2) {
    const agree = scored.filter(s => s.m.title.toLowerCase().includes(id.player.value));
    if (agree.length > 0) pool = agree;
  }

  // Stable sort by score (keep eBay's original order as the tiebreak).
  pool.sort((a, b) => (b.score - a.score) || (a.i - b.i));
  const topScore = pool.length ? pool[0].score : 0;
  const matches = pool.map(s => ({ ...s.m, _agrees: s.score > 0 && s.score === topScore }));
  return { matches, identity: id };
}

function _identityLabel(id) {
  if (!id) return '';
  const parts = [
    id.year && id.year.value,
    id.player && _titleCase(id.player.value),
    id.set && _titleCase(id.set.value),
    id.number && `#${id.number.value.toUpperCase()}`,
  ].filter(Boolean);
  return parts.join(' ');
}

function _renderScannerMatches(matches, backIdentity) {
  const grid = document.getElementById('scanner-matches-grid');
  const note = document.getElementById('scanner-back-note');
  if (note) {
    const label = _identityLabel(backIdentity);
    if (label) {
      note.innerHTML = `&#10003; Card back read as <strong>${escHtml(label)}</strong> — best matches moved to the top.`;
      note.classList.remove('hidden');
    } else {
      note.classList.add('hidden');
    }
  }
  grid.innerHTML = matches.map((m, i) => `
    <div class="scanner-match-card${m._agrees ? ' scanner-match-agrees' : ''}" data-title="${escHtml(m.title)}">
      <div class="scanner-match-card-accent"></div>
      ${m._agrees ? '<span class="scanner-match-badge">&#10003; Matches back</span>' : ''}
      ${m.imageUrl
        ? `<img class="scanner-match-card-img" src="${escHtml(m.imageUrl)}" alt="" loading="lazy" />`
        : '<div class="scanner-match-card-noimg">&#127944;</div>'}
      <div class="scanner-match-card-body">
        <p class="scanner-match-card-title" title="${escHtml(m.title)}">${escHtml(m.title)}</p>
        ${_keyTermsHtml(m.title)}
        <button class="scanner-match-card-btn" onclick="selectScannerMatch(${i})">Use This Listing</button>
      </div>
    </div>
  `).join('');
  document.getElementById('scanner-phase-matches').classList.remove('hidden');
}

async function selectScannerMatch(index) {
  const cards = document.querySelectorAll('.scanner-match-card');
  const card = cards[index];
  if (!card) return;
  const rawTitle = card.dataset.title || '';
  const broadQuery = _scanSearchQuery(rawTitle);

  cards.forEach(c => c.classList.remove('selected'));
  card.classList.add('selected');

  document.getElementById('scanner-phase-matches').classList.add('hidden');

  const resultsEl = document.getElementById('scanner-results');
  const loading = document.getElementById('scanner-loading');
  const errEl = document.getElementById('scanner-error');
  const titleEl = document.getElementById('scanner-selected-title');
  const salesEl = document.getElementById('scanner-sales-list');

  resultsEl.classList.remove('hidden');
  titleEl.textContent = broadQuery;
  loading.classList.remove('hidden');
  errEl.classList.add('hidden');
  document.getElementById('scanner-price-summary').innerHTML = '';
  salesEl.innerHTML = '';

  try {
    const res = await authFetch(`/api/search?mode=sold&q=${encodeURIComponent(broadQuery)}&limit=20`);
    const data = await res.json();
    loading.classList.add('hidden');

    if (!res.ok) {
      errEl.textContent = data.noKey
        ? 'Add a scrape.do API key in Settings → scrape.do API key to see sold prices.'
        : (data.error || 'Search failed.');
      errEl.classList.remove('hidden');
      return;
    }

    // Strict key-term match so only true comps for this exact card count.
    const _allSold = data.results || [];
    const _qCard = _cardFromQuery(broadQuery);
    const _strictSold = _allSold.filter(r => _compMatchesCard(_qCard, r.title));
    _renderScannerSoldResults(broadQuery, _strictSold.length >= 1 ? _strictSold : _allSold);
  } catch (err) {
    loading.classList.add('hidden');
    errEl.textContent = 'Network error. Please try again.';
    errEl.classList.remove('hidden');
  }
}

function _renderScannerSoldResults(query, items) {
  _scannerLastQuery = query;
  // Stats bar — same HTML structure as the main search renderStatsBar()
  const pEl = document.getElementById('scanner-price-summary');
  const collBtnWrap = document.getElementById('scanner-collection-btn-wrap');
  if (items.length) {
    const prices = items.map(r => parseFloat(r.price)).filter(p => p > 0);
    const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
    const sorted = [...prices].sort((a, b) => a - b);
    _scannerLastMedian = sorted.length % 2 === 0
      ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
      : sorted[Math.floor(sorted.length / 2)];
    pEl.innerHTML = `
      <div class="stats-bar">
        <div class="stat-item"><span class="stat-label">Results</span><span class="stat-value">${items.length}</span></div>
        <div class="stat-item"><span class="stat-label">Avg Sale</span><span class="stat-value">$${avg.toFixed(2)}</span></div>
        <div class="stat-item"><span class="stat-label">Median</span><span class="stat-value">$${_scannerLastMedian.toFixed(2)}</span></div>
        <div class="stat-item"><span class="stat-label">Low</span><span class="stat-value">$${Math.min(...prices).toFixed(2)}</span></div>
        <div class="stat-item"><span class="stat-label">High</span><span class="stat-value">$${Math.max(...prices).toFixed(2)}</span></div>
      </div>`;
    if (collBtnWrap) collBtnWrap.classList.remove('hidden');
  } else {
    _scannerLastMedian = null;
    pEl.innerHTML = '';
    if (collBtnWrap) collBtnWrap.classList.add('hidden');
  }

  // Results cards — reuse buildCard() exactly like the main sold search
  const salesEl = document.getElementById('scanner-sales-list');
  if (items.length) {
    const savedMode = currentMode;
    currentMode = 'sold';
    items.forEach((item, i) => {
      const card = buildCard(item);
      card.style.animationDelay = `${i * 0.04}s`;
      salesEl.appendChild(card);
    });
    currentMode = savedMode;
  } else {
    const ebayUrl = `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(query)}&LH_Sold=1&LH_Complete=1`;
    salesEl.innerHTML = `<p style="color:var(--text-muted);font-size:0.9rem">No recent sold listings found. <a href="${escHtml(epnUrl(ebayUrl))}" target="_blank" rel="noopener">Search on eBay &rarr;</a></p>`;
  }
}

// Sold value (median of recent sold listings) captured from the last
// scanner result, carried into handleAddCard so it can be stored on the
// card as a distinct "Sold Value" alongside Paid and Mkt Value.
let _pendingScannedSoldValue = null;

// ---- Match a scanned card to a checklist entry (for accuracy) ----
let _checklistMatches = [];
let _checklistMatchMeta = { soldValue: null, query: '' };

function _normName(s) {
  return String(s || '').toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
}
function _playerMatches(checklistPlayer, target) {
  const a = _normName(checklistPlayer), b = _normName(target);
  if (!a || !b) return false;
  if (a.includes(b) || b.includes(a)) return true;
  const at = a.split(' '), bt = b.split(' ');
  const al = at[at.length - 1], bl = bt[bt.length - 1];
  return bl.length > 2 && al === bl && at[0][0] === bt[0][0];
}
function _bestParallelIndex(parallels, extracted) {
  if (!parallels || !parallels.length || !extracted || !extracted.length) return -1;
  for (const ex of extracted) {
    const exl = ex.toLowerCase();
    const i = parallels.findIndex(p => p.name && p.name.toLowerCase().includes(exl));
    if (i >= 0) return i;
  }
  return -1;
}

// Search the static checklist data for cards matching a scanned listing.
async function matchChecklistFromQuery(rawQuery) {
  const player = _extractPlayer(rawQuery);
  const year = (String(rawQuery).match(/\b(19|20)\d{2}\b/) || [])[0] || '';
  const lower = String(rawQuery).toLowerCase();
  const setTerms = SCAN_KEY_SETS.filter(s => new RegExp(`\\b${s}\\b`).test(lower));
  const skip = new Set(['rc', 'auto', 'patch']);
  const parallels = _scanKeyTerms(rawQuery).filter(t => {
    const tl = t.toLowerCase();
    return !/^\//.test(t) && !/^(psa|bgs|sgc|cgc|hga|csg)\b/i.test(t) && !skip.has(tl) && !SCAN_KEY_SETS.includes(tl);
  });
  if (!player) return { player: '', year, parallels, cards: [] };

  let index;
  try { index = await fetchChecklistsList(); } catch { return { player, year, parallels, cards: [] }; }
  const products = (index.products || [])
    .map(p => {
      const hay = `${p.id} ${p.name} ${p.brand}`.toLowerCase();
      return { p, score: setTerms.reduce((s, t) => s + (hay.includes(t) ? 1 : 0), 0) };
    })
    .filter(x => (year ? String(x.p.year) === String(year) : true) && (setTerms.length ? x.score > 0 : true))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map(x => x.p);

  const cards = [];
  const seen = new Set();
  for (const prod of products) {
    let data;
    try { data = await fetchChecklistProduct(prod.id); } catch { continue; }
    for (const set of data.sets || []) {
      for (const card of set.cards || []) {
        if (!_playerMatches(card.player, player)) continue;
        const key = `${data.id}|${set.name}|${card.number}|${card.player}`;
        if (seen.has(key)) continue;
        seen.add(key);
        cards.push({
          year: data.year, brand: data.brand, setName: set.name, category: set.category || 'base',
          number: card.number || '', player: card.player, team: card.team || '', parallels: set.parallels || [],
        });
        if (cards.length >= 60) break;
      }
      if (cards.length >= 60) break;
    }
    if (cards.length >= 60) break;
  }
  cards.sort((a, b) => (a.category === 'base' ? 0 : 1) - (b.category === 'base' ? 0 : 1));
  return { player, year, parallels, cards: cards.slice(0, 20) };
}

// Photo add → match to checklist for accuracy, with a manual fallback.
async function addScannerCardToCollection() {
  const q = _scannerLastQuery || '';
  _checklistMatchMeta = { soldValue: _scannerLastMedian != null ? _scannerLastMedian : null, query: q };
  document.getElementById('checklist-match-modal').classList.remove('hidden');
  const body = document.getElementById('checklist-match-body');
  body.innerHTML = '<div class="pp-loading"><div class="spinner"></div> Matching to the official checklist…</div>';
  let res;
  try { res = await matchChecklistFromQuery(q); } catch { res = { cards: [] }; }
  _checklistMatches = res.cards || [];
  renderChecklistMatchModal(res);
}

function renderChecklistMatchModal(res) {
  const body = document.getElementById('checklist-match-body');
  if (!body) return;
  if (!_checklistMatches.length) {
    body.innerHTML = `
      <p class="clm-none">No checklist match found${res && res.player ? ` for <strong>${escHtml(res.player)}</strong>` : ''}. You can still add it as a manual card.</p>
      <button class="pp-btn" onclick="addScannerCardManual()">Add manually instead</button>`;
    return;
  }
  const extracted = (res && res.parallels) || [];
  const rows = _checklistMatches.map((c, i) => _checklistCardRowHtml(c, i, extracted, 'addMatchedChecklistCard')).join('');
  body.innerHTML = `
    <div class="clm-matched-label">Matched <strong>${escHtml(res.player)}</strong> &middot; pick the exact card &amp; parallel</div>
    <div class="clm-list">${rows}</div>
    <button class="clm-manual-link" onclick="addScannerCardManual()">None of these — add manually</button>`;
}

// Shared candidate-card row (used by photo match + checklist search add).
function _checklistCardRowHtml(c, i, extractedParallels, addFn) {
  const best = _bestParallelIndex(c.parallels, extractedParallels || []);
  const opts = [`<option value="-1" ${best < 0 ? 'selected' : ''}>Base</option>`]
    .concat((c.parallels || []).map((p, j) =>
      `<option value="${j}" ${best === j ? 'selected' : ''}>${escHtml(p.name)}${p.printRun ? ` /${p.printRun}` : ''}</option>`));
  return `<div class="clm-row">
    <div class="clm-row-main">
      <span class="clm-row-title">${c.year} ${escHtml(c.brand)} &middot; ${escHtml(c.setName)} &middot; #${escHtml(String(c.number))}</span>
      <span class="clm-row-player">${escHtml(c.player)}${c.team ? ' &middot; ' + escHtml(c.team) : ''}</span>
    </div>
    <select id="clm-par-${i}" class="clm-select">${opts.join('')}</select>
    <button class="clm-add-btn" onclick="${addFn}(${i})">Add</button>
  </div>`;
}

// Add the candidate card at index i to the collection (shared core).
function _addChecklistCardByIndex(i) {
  const c = _checklistMatches[i];
  if (!c) return false;
  const sel = document.getElementById(`clm-par-${i}`);
  let parallelName = '', printRun = '';
  const j = sel ? parseInt(sel.value, 10) : -1;
  if (j >= 0 && c.parallels[j]) { parallelName = c.parallels[j].name; printRun = c.parallels[j].printRun || ''; }
  const ok = addToCollectionFromChecklist(c.player, c.year, c.brand, c.setName, parallelName, printRun || '', c.number, c.team, c.category);
  if (!ok) return false;
  if (_checklistMatchMeta.soldValue != null) {
    const coll = getCollection();
    const last = coll[coll.length - 1];
    if (last) { last.soldValue = _checklistMatchMeta.soldValue; saveCollection(coll); }
  }
  renderPortfolio();
  return true;
}

function addMatchedChecklistCard(i) {
  if (!_addChecklistCardByIndex(i)) return;
  closeChecklistMatchModal();
  showPortfolioToast('Added — matched to checklist for accuracy.');
}

function closeChecklistMatchModal() {
  document.getElementById('checklist-match-modal').classList.add('hidden');
}

// Add a card to the collection by photo — scan → checklist match → add.
function addPhotoToCollection() {
  openScanFillModal(null, false, 'collection');
}

// ---- Add from Checklist — uses the standard checklist picker (same product
// → set → card → parallel flow as everywhere else) for a consistent UX. ----
function openChecklistAddModal() {
  openChecklistPicker({
    subtitle: 'Pick a card to add to your collection — its value pulls automatically.',
    onPick: ctx => {
      if (!ctx) return;
      const ok = addToCollectionFromChecklist(
        ctx.player, ctx.year, ctx.brand, ctx.setName,
        ctx.parallel || '', ctx.printRun || '', ctx.cardNumber || '', '', ctx.setCategory || 'base'
      );
      if (ok) { renderPortfolio(); showPortfolioToast('Added to collection — matched to checklist.'); }
    },
  });
}

// Fallback: the original behavior — prefill the manual Add Card modal.
function addScannerCardManual() {
  closeChecklistMatchModal();
  _pendingScannedSoldValue = _checklistMatchMeta.soldValue;
  document.getElementById('add-card-name').value = _checklistMatchMeta.query || _scannerLastQuery || '';
  document.getElementById('add-card-price').value = '';
  document.getElementById('add-card-condition').value = '';
  document.getElementById('add-card-notes').value = '';
  showAddCardModal();
}

// ---- Scan-to-Fill Modal (shared camera scan for any search input) ----
let _scanFillTargetId = null;
let _scanFillIsTextarea = false;
let _scanFillImageDataUrl = null;
let _scanFillMode = 'fill'; // 'fill' = fill an input, 'collection' = add to My Cards

function openScanFillModal(targetId, isTextarea, mode) {
  _scanFillTargetId = targetId;
  _scanFillIsTextarea = !!isTextarea;
  _scanFillMode = mode || 'fill';
  _scanFillImageDataUrl = null;
  document.getElementById('scan-fill-file-input').value = '';
  document.getElementById('scan-fill-preview-wrap').classList.add('hidden');
  document.getElementById('scan-fill-matching').classList.add('hidden');
  document.getElementById('scan-fill-error').classList.add('hidden');
  document.getElementById('scan-fill-phase-matches').classList.add('hidden');
  document.getElementById('scan-fill-phase-upload').classList.remove('hidden');
  document.getElementById('scan-fill-modal').classList.remove('hidden');
}

function closeScanFillModal() {
  document.getElementById('scan-fill-modal').classList.add('hidden');
  _scanFillImageDataUrl = null;
  _scanFillTargetId = null;
}

function resetScanFill() {
  _scanFillImageDataUrl = null;
  document.getElementById('scan-fill-file-input').value = '';
  document.getElementById('scan-fill-preview-wrap').classList.add('hidden');
  document.getElementById('scan-fill-matching').classList.add('hidden');
  document.getElementById('scan-fill-error').classList.add('hidden');
  document.getElementById('scan-fill-phase-matches').classList.add('hidden');
  document.getElementById('scan-fill-phase-upload').classList.remove('hidden');
}

async function handleScanFillFile(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  if (!file.type.startsWith('image/')) { alert('Please select an image file.'); return; }
  if (file.size > 8 * 1024 * 1024) { alert('Image is too large (max 8MB).'); return; }
  try {
    _scanFillImageDataUrl = await readImageFileAsDataUrl(file, 800, 0.85);
    document.getElementById('scan-fill-preview').src = _scanFillImageDataUrl;
    document.getElementById('scan-fill-preview-wrap').classList.remove('hidden');
    document.getElementById('scan-fill-error').classList.add('hidden');
    document.getElementById('scan-fill-phase-matches').classList.add('hidden');
  } catch (err) {
    alert('Could not load image: ' + (err.message || 'Unknown error'));
  }
}

async function submitScanFill() {
  if (!_scanFillImageDataUrl) { alert('Please select a card photo first.'); return; }
  const spinner = document.getElementById('scan-fill-matching');
  const errEl = document.getElementById('scan-fill-error');
  document.getElementById('scan-fill-phase-upload').classList.add('hidden');
  spinner.classList.remove('hidden');
  errEl.classList.add('hidden');
  document.getElementById('scan-fill-phase-matches').classList.add('hidden');
  try {
    const res = await fetch('/api/scan-card', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageData: _scanFillImageDataUrl }),
    });
    const data = await res.json();
    spinner.classList.add('hidden');
    if (!res.ok) {
      errEl.textContent = data.error || 'Image search failed. Try a clearer photo.';
      errEl.classList.remove('hidden');
      document.getElementById('scan-fill-phase-upload').classList.remove('hidden');
      return;
    }
    if (!data.matches || !data.matches.length) {
      errEl.textContent = 'No matching cards found. Try a clearer, straight-on photo with good lighting.';
      errEl.classList.remove('hidden');
      document.getElementById('scan-fill-phase-upload').classList.remove('hidden');
      return;
    }
    _renderScanFillMatches(data.matches);
  } catch (err) {
    spinner.classList.add('hidden');
    document.getElementById('scan-fill-phase-upload').classList.remove('hidden');
    errEl.textContent = 'Network error. Please try again.';
    errEl.classList.remove('hidden');
  }
}

function _renderScanFillMatches(matches) {
  const grid = document.getElementById('scan-fill-matches-grid');
  grid.innerHTML = matches.map((m, i) => `
    <div class="scanner-match-card" data-title="${escHtml(m.title)}">
      <div class="scanner-match-card-accent"></div>
      ${m.imageUrl
        ? `<img class="scanner-match-card-img" src="${escHtml(m.imageUrl)}" alt="" loading="lazy" />`
        : '<div class="scanner-match-card-noimg">&#127944;</div>'}
      <div class="scanner-match-card-body">
        <p class="scanner-match-card-title" title="${escHtml(m.title)}">${escHtml(m.title)}</p>
        ${_keyTermsHtml(m.title)}
        <button class="scanner-match-card-btn" onclick="selectScanFillMatch(${i})">Use This</button>
      </div>
    </div>
  `).join('');
  document.getElementById('scan-fill-phase-matches').classList.remove('hidden');
}

function selectScanFillMatch(index) {
  const cards = document.getElementById('scan-fill-matches-grid').querySelectorAll('.scanner-match-card');
  const card = cards[index];
  if (!card) return;
  const rawTitle = card.dataset.title || '';
  const broadQuery = _scanSearchQuery(rawTitle);
  // Collection mode: route the picked card into the checklist-match → add flow.
  if (_scanFillMode === 'collection') {
    closeScanFillModal();
    _scannerLastQuery = broadQuery;
    _scannerLastMedian = null;
    addScannerCardToCollection();
    return;
  }
  const targetEl = _scanFillTargetId ? document.getElementById(_scanFillTargetId) : null;
  if (targetEl) {
    if (_scanFillIsTextarea) {
      const existing = targetEl.value.trim();
      targetEl.value = existing ? existing + '\n' + broadQuery : broadQuery;
    } else {
      targetEl.value = broadQuery;
    }
    targetEl.dispatchEvent(new Event('input', { bubbles: true }));
    targetEl.focus();
  }
  closeScanFillModal();
}

// ---- Pro+ Tools ----
function initProPlusView() {
  const gate = document.getElementById('proplus-gate');
  const content = document.getElementById('proplus-content');
  if (!gate || !content) return;
  // Pro Tools are open access — the gate is kept in the DOM so the upgrade
  // CTA can be re-enabled later by flipping this back to hasPro().
  gate.classList.add('hidden');
  content.classList.remove('hidden');
}

function switchProPlusTab(tab) {
  document.querySelectorAll('.proplus-tab').forEach(t => t.classList.toggle('active', t.dataset.pptab === tab));
  document.querySelectorAll('.pptab-panel').forEach(p => p.classList.toggle('hidden', p.id !== `pptab-${tab}`));
  if (tab === 'promote') initPromoteTab();
}

async function runFlipFinder() {
  const q = document.getElementById('ff-input').value.trim();
  const minDiscount = document.getElementById('ff-discount').value;
  const minProfit = document.getElementById('ff-minprofit').value || 10;
  const out = document.getElementById('ff-results');
  if (!q) { out.innerHTML = '<p class="pp-error">Enter a card to search.</p>'; return; }
  out.innerHTML = '<div class="pp-loading">&#128269; Scanning eBay for underpriced listings&hellip;</div>';
  try {
    const res = await authFetch(`/api/flip-finder?${new URLSearchParams({ q, minDiscount, minProfit, limit: 20 })}`);
    const data = await res.json();
    if (!res.ok) { out.innerHTML = `<p class="pp-error">${data.error}</p>`; return; }
    if (!data.results?.length) {
      out.innerHTML = `<p class="pp-empty">No flip opportunities found. Try a broader search or lower your discount threshold.<br><small>Sold median: $${data.soldMedian || '—'} from ${data.soldSampleSize || 0} sales</small></p>`;
      return;
    }
    out.innerHTML = `
      <div class="pp-summary">Sold median: <strong>$${data.soldMedian}</strong> &nbsp;·&nbsp; ${data.soldSampleSize} recent sales &nbsp;·&nbsp; ${data.results.length} flip${data.results.length !== 1 ? 's' : ''} found</div>
      <div class="ff-grid">
        ${data.results.map(r => `
          <a class="ff-card" href="${escHtml(epnUrl(`https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(r.title)}`))}  " target="_blank" rel="noopener noreferrer">
            ${r.imageUrl ? `<img class="ff-img" src="${escHtml(r.imageUrl)}" alt="" loading="lazy" />` : '<div class="ff-img ff-noimg">No Image</div>'}
            <div class="ff-body">
              <p class="ff-title">${escHtml(r.title)}</p>
              <div class="ff-prices">
                <span class="ff-listing-price">Listed: <strong>$${r.listingPrice.toFixed(2)}</strong></span>
                <span class="ff-sold-median">Sold median: $${r.soldMedian.toFixed(2)}</span>
              </div>
              <div class="ff-profit-row">
                <span class="ff-profit">+$${r.potentialProfit.toFixed(2)} potential</span>
                <span class="ff-discount">${r.discountPct}% below median</span>
              </div>
            </div>
          </a>`).join('')}
      </div>`;
  } catch (e) { out.innerHTML = `<p class="pp-error">Error: ${e.message}</p>`; }
}

async function runMarketMovers() {
  const q = document.getElementById('mm-input').value.trim();
  const out = document.getElementById('mm-results');
  if (!q) { out.innerHTML = '<p class="pp-error">Enter a card to analyse.</p>'; return; }
  out.innerHTML = '<div class="pp-loading">&#128200; Analysing price trend&hellip;</div>';
  try {
    const res = await authFetch(`/api/market-movers?q=${encodeURIComponent(q)}`);
    const data = await res.json();
    if (!res.ok || data.error) { out.innerHTML = `<p class="pp-error">${data.error || data.message}</p>`; return; }
    if (data.message) { out.innerHTML = `<p class="pp-empty">${data.message}</p>`; return; }
    const arrow = data.trending === 'up' ? '&#8679;' : data.trending === 'down' ? '&#8681;' : '&#8680;';
    const cls = data.trending === 'up' ? 'mm-up' : data.trending === 'down' ? 'mm-down' : 'mm-stable';
    out.innerHTML = `
      <div class="mm-summary ${cls}">
        <span class="mm-arrow">${arrow}</span>
        <span class="mm-change">${data.changePct > 0 ? '+' : ''}${data.changePct}%</span>
        <span class="mm-label">in last 7 days</span>
      </div>
      <div class="mm-stats">
        <div class="mm-stat"><div class="mm-stat-val">$${data.recentAvg}</div><div class="mm-stat-lbl">Avg last 7 days (${data.recentSales} sales)</div></div>
        <div class="mm-stat"><div class="mm-stat-val">$${data.olderAvg}</div><div class="mm-stat-lbl">Prior avg (${data.olderSales} sales)</div></div>
      </div>
      ${data.recentItems?.length ? `<div class="mm-recent-label">Most recent sales</div><div class="mm-recent-list">${data.recentItems.map(i => `<div class="mm-recent-item">${i.imageUrl ? `<img src="${escHtml(i.imageUrl)}" class="mm-thumb" alt="" />` : ''}<span class="mm-recent-title">${escHtml(i.title)}</span><span class="mm-recent-price">$${i.price.toFixed(2)}</span><span class="mm-recent-date">${i.date}</span></div>`).join('')}</div>` : ''}`;
  } catch (e) { out.innerHTML = `<p class="pp-error">Error: ${e.message}</p>`; }
}

let _apComps = [];     // [{ title, price, image, soldDate, url, pr, grade, include }]
let _apUserPR = null;  // user's card print run (number) or null
let _apUserSet = null; // user's card set { name, tier } or null

// Power-law scarcity exponent. Scarcer print runs command a premium that
// scales as a power law, not linearly — an experienced collector knows a /25
// isn't 4x a /99, it's closer to ~2x. 0.65 matches the value the checklist
// estimator (estimateByPrintRun) already uses, so the whole app is consistent.
const AP_SCARCITY_ALPHA = 0.65;

// Effective print run for UNNUMBERED cards so the power law yields a real
// multiplier between numbered and unnumbered comps (kept in sync with
// UNNUMBERED_EFFECTIVE_PR in server.js). At 250, a /25 ≈ 4.5× an unnumbered.
const UNNUMBERED_EFFECTIVE_PR = 250;
// Neutralizer strength (0 = scale comps independently; 1 = collapse to the
// group consensus). Pulls each comp toward the consensus before scaling so one
// off sale (e.g. a /25 that sold under a /50) can't swing the estimate.
const AP_NEUTRALIZER = 0.45;
function apEffectivePR(pr) { return pr && pr > 0 ? pr : UNNUMBERED_EFFECTIVE_PR; }
function apMedian(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const n = s.length;
  if (!n) return null;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

// Set desirability tiers — kept in sync with SET_VALUE_TIERS in server.js.
// Relative weights (not dollars) used to normalize a comp from a different set
// toward the searched card's set: a comp from set B is scaled by
// tier(targetSet)/tier(compSet), clamped. Higher = more premium. Tweak freely.
const SET_VALUE_TIERS = {
  'national treasures': 8, 'flawless': 8, 'immaculate': 6, 'impeccable': 6,
  'spectra': 4, 'obsidian': 4, 'noir': 4, 'encased': 3.5, 'limited': 3.5,
  'gold standard': 3.5, 'majestic': 3.5, 'origins': 3, 'contenders': 3,
  'prizm': 2.5, 'select': 2.5, 'mosaic': 2, 'optic': 2, 'phoenix': 2,
  'certified': 2, 'absolute': 2, 'zenith': 2, 'elements': 2,
  'luminance': 1.8, 'illusions': 1.8, 'chronicles': 1.8, 'photogenic': 1.8,
  'prestige': 1.5,
  'donruss': 1.2, 'score': 1, 'hoops': 1,
};

function clampNum(n, lo, hi) { return Math.min(Math.max(n, lo), hi); }

// Find the most specific known set named in a title → { name, tier } or null.
function detectSetTier(text) {
  const t = ' ' + String(text || '').toLowerCase().replace(/\s+/g, ' ') + ' ';
  let best = null;
  for (const name of Object.keys(SET_VALUE_TIERS)) {
    const re = new RegExp('(^| )' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '( |$)');
    if (re.test(t) && (!best || name.length > best.name.length)) {
      best = { name, tier: SET_VALUE_TIERS[name] };
    }
  }
  return best;
}

// Parse a print-run / serial denominator out of a listing title.
// Handles "/99", "#/25", "12/99" (serial stamp → denominator), "1/1",
// "one of one", "numbered to 99". Skips season ranges like "2020/21".
function parsePrintRun(title) {
  if (!title) return null;
  const t = title.toLowerCase();
  if (/\b1\s*\/\s*1\b/.test(title) || /\b1\s*of\s*1\b/.test(t) || /\bone[-\s]of[-\s]one\b/.test(t)) return 1;
  // X/Y serial stamp — take the denominator, ignoring year ranges (2020/21).
  const frac = title.match(/\b(\d{1,4})\s*\/\s*(\d{1,4})\b/);
  if (frac) {
    const num = parseInt(frac[1], 10), denom = parseInt(frac[2], 10);
    const looksLikeSeason = num >= 1900 && num <= 2099;
    if (!looksLikeSeason && denom >= 1 && denom <= 5000) return denom;
  }
  const m = title.match(/(?:numbered\s*(?:to\s*)?\/?|#\s*\/|\/)\s*(\d{1,4})\b/i);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n >= 1 && n <= 5000) return n;
  }
  return null;
}

async function runAutoPricer() {
  const q = document.getElementById('ap-input').value.trim();
  const out = document.getElementById('ap-results');
  if (!q) { out.innerHTML = '<p class="pp-error">Enter a card to price.</p>'; return; }
  _apUserPR = parsePrintRun(q);
  _apUserSet = detectSetTier(q);
  out.innerHTML = '<div class="pp-loading">&#128269; Finding sold comps&hellip;</div>';
  try {
    const res = await authFetch(`/api/auto-price/search?q=${encodeURIComponent(q)}`);
    const data = await res.json();
    if (!res.ok || data.error) { out.innerHTML = `<p class="pp-error">${escHtml(data.error || 'Search failed.')}</p>`; return; }
    if (!data.items || !data.items.length) { out.innerHTML = '<p class="pp-error">No sold listings found for this card.</p>'; return; }
    _apComps = data.items
      .filter(it => it && it.price > 0)
      .slice(0, 10) // cap comps at 10
      .map(it => ({ ...it, pr: parsePrintRun(it.title), set: detectSetTier(it.title), grade: detectGrade(it.title), include: true }));
    renderApComps(out);
  } catch (e) { out.innerHTML = `<p class="pp-error">Error: ${escHtml(e.message)}</p>`; }
}

function renderApComps(out) {
  const prVal = _apUserPR != null ? _apUserPR : '';
  out.innerHTML = `
    <div class="ap-pick-header">
      <div class="ap-pick-title">Select the comps that match your card</div>
      <div class="ap-pick-sub">Check the sold listings that truly match yours. We adjust each one for print-run differences, then estimate your card's value.</div>
    </div>
    <div class="ap-yourcard-row">
      <label class="ap-pr-label">Your card's print run
        <span class="ap-pr-input-wrap">/<input type="number" id="ap-user-pr" class="ap-pr-input" min="1" max="5000" placeholder="—" value="${prVal}" oninput="_apUserPR = this.value ? parseInt(this.value, 10) : null" /></span>
      </label>
      <span class="ap-pr-hint">${_apUserPR ? `Auto-detected /${_apUserPR} from your search` : 'Leave blank if your card isn\'t serial-numbered'}</span>
    </div>
    <div class="ap-select-actions">
      <button type="button" class="ap-mini-btn" onclick="apSelectAll(true)">Select all</button>
      <button type="button" class="ap-mini-btn" onclick="apSelectAll(false)">Clear</button>
      <span class="ap-select-count" id="ap-select-count"></span>
    </div>
    <div class="ap-comp-grid">
      ${_apComps.map((item, i) => apCompCardHtml(item, i)).join('')}
    </div>
    <button type="button" class="pp-btn ap-calc-btn" onclick="calculateApValue()">&#129518; Estimate My Card's Value</button>
    <div id="ap-value-section"></div>`;
  updateApSelectCount();
}

function apCompCardHtml(item, i) {
  const prTag = item.pr
    ? `<span class="ap-tag ap-tag-pr">/${item.pr}</span>`
    : `<span class="ap-tag ap-tag-unp">unnumbered</span>`;
  const gradeTag = item.grade && item.grade !== 'Raw / Ungraded'
    ? `<span class="ap-tag ap-tag-grade">${escHtml(item.grade)}</span>` : '';
  return `
    <label class="ap-comp-card ${item.include ? 'ap-comp-selected' : ''}" data-i="${i}">
      <input type="checkbox" class="ap-comp-check" ${item.include ? 'checked' : ''} onchange="toggleApComp(${i}, this.checked)" />
      <div class="ap-comp-img-wrap">
        <img class="ap-comp-img" src="${escHtml(item.image)}" onerror="this.parentElement.classList.add('no-img')" alt="" loading="lazy" />
      </div>
      <div class="ap-comp-info">
        <div class="ap-comp-name">${escHtml(item.title)}</div>
        <div class="ap-comp-tags">${prTag}${gradeTag}</div>
        <div class="ap-comp-bottom">
          <span class="ap-comp-price">$${item.price.toFixed(2)}</span>
          <span class="ap-comp-date">${timeAgo(item.soldDate)}</span>
        </div>
      </div>
    </label>`;
}

function toggleApComp(i, checked) {
  if (_apComps[i]) _apComps[i].include = checked;
  const card = document.querySelector(`.ap-comp-card[data-i="${i}"]`);
  if (card) card.classList.toggle('ap-comp-selected', checked);
  updateApSelectCount();
}

function apSelectAll(val) {
  _apComps.forEach(c => { c.include = val; });
  document.querySelectorAll('.ap-comp-check').forEach(el => { el.checked = val; });
  document.querySelectorAll('.ap-comp-card').forEach(el => el.classList.toggle('ap-comp-selected', val));
  updateApSelectCount();
}

function updateApSelectCount() {
  const n = _apComps.filter(c => c.include).length;
  const el = document.getElementById('ap-select-count');
  if (el) el.textContent = `${n} of ${_apComps.length} selected`;
}

// The heart of the revamp: take the comps the user selected, adjust each
// one for the difference between its print run and the user's card's print
// run (the way an experienced collector does it — scarcer = worth more, but
// sub-linearly), then aggregate into an estimated value with a transparent
// breakdown so the reasoning is visible.
function calculateApValue() {
  const section = document.getElementById('ap-value-section');
  if (!section) return;
  const userPR = _apUserPR;
  const sel = _apComps.filter(c => c.include && c.price > 0);
  if (sel.length < 1) {
    section.innerHTML = '<p class="pp-error">Select at least one comp to estimate value.</p>';
    return;
  }

  const med = apMedian;
  const userSet = _apUserSet;
  const targetEffPR = apEffectivePR(userPR);
  const targetFactor = Math.pow(targetEffPR, AP_SCARCITY_ALPHA);

  // Pass 1 — for each comp note its (effective) print run, normalize its price
  // to the target SET's value level, and compute its implied "price @ /1" scale.
  const scored = sel.map(c => {
    const compEffPR = apEffectivePR(c.pr);
    const compSet = c.set || detectSetTier(c.title);
    const notes = [];
    if (userPR && c.pr && c.pr !== userPR) notes.push(c.pr > userPR ? 'rarer than comp' : 'more common than comp');
    else if (userPR && !c.pr) notes.push('comp unnumbered');
    else if (!userPR && c.pr) notes.push('your card unnumbered');
    let setMult = 1;
    if (userSet && compSet && compSet.name !== userSet.name) {
      setMult = clampNum(userSet.tier / compSet.tier, 0.2, 5);
      notes.push(setMult > 1 ? `${userSet.name} > ${compSet.name}` : `${userSet.name} < ${compSet.name}`);
    }
    const prMult = clampNum(Math.pow(compEffPR / targetEffPR, AP_SCARCITY_ALPHA), 0.1, 15);
    const scale = (c.price * setMult) * Math.pow(compEffPR, AP_SCARCITY_ALPHA);
    return { c, compSet, prMult, setMult, scale, notes };
  });

  // Pass 2 — neutralizer: pull each comp's scale toward the group consensus,
  // then value at the target print run.
  const consensusScale = med(scored.map(s => s.scale));
  const sStr = AP_NEUTRALIZER;
  const rows = scored.map(o => {
    const neutralizedScale = Math.pow(consensusScale, sStr) * Math.pow(o.scale, 1 - sStr);
    const adj = neutralizedScale / targetFactor;
    return { title: o.c.title, raw: o.c.price, pr: o.c.pr, set: o.compSet, grade: o.c.grade, prMult: o.prMult, setMult: o.setMult, mult: adj / o.c.price, adj, note: o.notes.join(' · ') };
  });

  const adjPrices = rows.map(r => r.adj);
  const value = med(adjPrices);
  const low = Math.min(...adjPrices);
  const high = Math.max(...adjPrices);

  // Independent cross-check: if the selected comps span multiple print runs
  // and the user's print run is known, fit a log-log regression (same model
  // the checklist value estimator uses) and predict the price at the user's PR.
  let regVal = null;
  if (userPR) {
    const known = sel.filter(c => c.pr).map(c => ({ printRun: c.pr, price: c.price }));
    const est = estimateByPrintRun(userPR, known);
    if (est && isFinite(est.value) && est.value > 0) regVal = est.value;
  }

  // Confidence: more comps + tight spread + little adjustment = higher.
  const adjustedCount = rows.filter(r => Math.abs(r.mult - 1) > 0.01).length;
  const prAdjustedCount = rows.filter(r => Math.abs(r.prMult - 1) > 0.01).length;
  const setAdjustedCount = rows.filter(r => Math.abs(r.setMult - 1) > 0.01).length;
  const spread = value > 0 ? (high - low) / value : 2;
  let confidence = 'medium';
  if (sel.length >= 5 && spread < 0.9 && adjustedCount <= sel.length / 2) confidence = 'high';
  else if (sel.length <= 2 || spread > 1.8) confidence = 'low';

  const grades = [...new Set(sel.map(c => c.grade))];
  const mixedGrades = grades.length > 1;

  const recs = [
    { label: 'Fast Sale', price: value * 0.90, description: 'Move it quickly — priced just under market' },
    { label: 'Optimal',   price: value,        description: 'Fair market value from your adjusted comps' },
    { label: 'Premium',   price: value * 1.12, description: 'Top dollar for a patient seller' },
  ];

  const confColors = { high: '#4ade80', medium: '#fbbf24', low: '#f87171' };
  const confColor = confColors[confidence];
  const fmt = n => `$${n.toFixed(2)}`;
  const prLabel = userPR ? `/${userPR}` : 'unnumbered';

  section.innerHTML = `
    <div class="ap-value-card">
      <div class="ap-value-top">
        <div class="ap-value-label">Estimated value &middot; your ${escHtml(prLabel)} card</div>
        <div class="ap-value-amount">${fmt(value)}</div>
        <div class="ap-value-meta">
          <span class="ap-confidence" style="color:${confColor}">&#9679; ${confidence.charAt(0).toUpperCase() + confidence.slice(1)} confidence</span>
          &nbsp;&middot;&nbsp; ${sel.length} comp${sel.length !== 1 ? 's' : ''}
          &nbsp;&middot;&nbsp; range ${fmt(low)}&ndash;${fmt(high)}
          ${regVal ? ` &nbsp;&middot;&nbsp; regression check <strong>${fmt(regVal)}</strong>` : ''}
        </div>
      </div>
      <div class="ap-recs">
        ${recs.map(r => `
          <div class="ap-rec">
            <div class="ap-rec-label">${r.label}</div>
            <div class="ap-rec-price">${fmt(r.price)}</div>
            <div class="ap-rec-desc">${r.description}</div>
          </div>`).join('')}
      </div>
      ${prAdjustedCount > 0 ? `<div class="ap-method-note">&#9881;&#65039; ${prAdjustedCount} comp${prAdjustedCount !== 1 ? 's were' : ' was'} a different print run than your card, so ${prAdjustedCount !== 1 ? 'they were' : 'it was'} scaled by a power-law scarcity model (a /25 runs ~2&times; a /99, not 4&times;).</div>` : ''}
      ${setAdjustedCount > 0 ? `<div class="ap-method-note">&#127991;&#65039; ${setAdjustedCount} comp${setAdjustedCount !== 1 ? 's were from' : ' was from'} a different set${userSet ? ` than your <strong>${escHtml(userSet.name)}</strong>` : ''}, so ${setAdjustedCount !== 1 ? 'their prices were' : 'its price was'} balanced for set value (e.g. National Treasures &gt; Score).</div>` : ''}
      ${rows.length > 1 && AP_NEUTRALIZER > 0 ? `<div class="ap-method-note">&#9878;&#65039; Comps were neutralized toward their shared consensus before scaling, so one off sale (e.g. a rarer card that happened to sell low) can't swing the estimate.</div>` : ''}
      ${mixedGrades ? `<div class="ap-method-note ap-warn">&#9888;&#65039; Selected comps span multiple grades (${grades.map(escHtml).join(', ')}). For a tighter estimate, include only comps in your card's grade.</div>` : ''}
      <details class="ap-breakdown-wrap">
        <summary>Show the math &mdash; how each comp was adjusted</summary>
        <table class="ap-breakdown">
          <thead><tr><th>Comp</th><th>Sold</th><th>Print run</th><th>Set</th><th>Adj.</th><th>Value</th></tr></thead>
          <tbody>
            ${rows.map(r => {
              const adjBits = [];
              if (Math.abs(r.prMult - 1) > 0.01) adjBits.push(`print run &times;${r.prMult.toFixed(2)}`);
              if (Math.abs(r.setMult - 1) > 0.01) adjBits.push(`set &times;${r.setMult.toFixed(2)}`);
              return `
              <tr>
                <td class="ap-bd-title">${escHtml(r.title.length > 60 ? r.title.slice(0, 57) + '…' : r.title)}${r.grade && r.grade !== 'Raw / Ungraded' ? ` <span class="ap-tag ap-tag-grade">${escHtml(r.grade)}</span>` : ''}</td>
                <td>${fmt(r.raw)}</td>
                <td>${r.pr ? '/' + r.pr : '<span class="ap-bd-muted">—</span>'}</td>
                <td>${r.set ? escHtml(r.set.name) : '<span class="ap-bd-muted">—</span>'}</td>
                <td>${adjBits.length ? `<span class="ap-bd-mult" title="${adjBits.join(', ').replace(/&times;/g,'x')}">&times;${r.mult.toFixed(2)}</span>` : '<span class="ap-bd-muted">—</span>'}</td>
                <td class="ap-bd-adj">${fmt(r.adj)}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
        <div class="ap-breakdown-foot">Value = median of the adjusted comps. Print-run adjustment = (comp print run &divide; your print run)<sup>0.65</sup> (unnumbered cards treated as ~/250); set adjustment = (your set tier &divide; comp set tier); both clamped. Comps are then neutralized toward their shared consensus so a single off sale can't dominate.</div>
      </details>
    </div>`;
  section.querySelector('.ap-value-card').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

let bulkPriceResults = [];
async function runBulkPricer() {
  if (!proGate('Bulk CSV Pricer')) return;
  const raw = document.getElementById('bulk-input').value.trim();
  const out = document.getElementById('bulk-results');
  if (!raw) { out.innerHTML = '<p class="pp-error">Enter at least one card.</p>'; return; }
  const queries = raw.split('\n').map(l => l.trim()).filter(Boolean).slice(0, 20);
  out.innerHTML = `<div class="pp-loading">Pricing ${queries.length} card${queries.length !== 1 ? 's' : ''}&hellip;</div>`;
  try {
    const res = await authFetch('/api/bulk-price', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ queries }) });
    const data = await res.json();
    if (!res.ok) { out.innerHTML = `<p class="pp-error">${escHtml(data.error || 'Failed')}</p>`; return; }
    bulkPriceResults = (data.results || []).map(r => ({
      ...r,
      comps: (r.comps || []).map(c => ({ ...c, include: true })),
    }));
    renderBulkResults();
  } catch (e) { out.innerHTML = `<p class="pp-error">Error: ${escHtml(e.message)}</p>`; }
}

function renderBulkResults() {
  const out = document.getElementById('bulk-results');
  out.innerHTML = `
    <table class="bulk-table">
      <thead><tr><th>Card</th><th>Median Sold</th><th>Low</th><th>High</th><th># Sales</th><th></th></tr></thead>
      <tbody>
        ${bulkPriceResults.map((r, i) => bulkRowHtml(r, i)).join('')}
      </tbody>
    </table>`;
}

function bulkRowHtml(r, i) {
  const hasComps = r.comps && r.comps.length > 0;
  return `
    <tr class="${r.median != null ? '' : 'bulk-row-na'}" data-bulk-row="${i}">
      <td class="bulk-query">${escHtml(r.query)}</td>
      <td class="bulk-median" data-cell="median">${r.median != null ? `$${r.median.toFixed(2)}` : '—'}</td>
      <td data-cell="low">${r.low != null ? `$${r.low.toFixed(2)}` : '—'}</td>
      <td data-cell="high">${r.high != null ? `$${r.high.toFixed(2)}` : '—'}</td>
      <td data-cell="count">${r.count}</td>
      <td class="bulk-comps-cell">${hasComps ? `<button type="button" class="bulk-comps-btn" onclick="toggleBulkComps(${i})">Comps (${r.comps.length})</button>` : ''}</td>
    </tr>
    ${hasComps ? `<tr class="bulk-comps-row hidden" data-bulk-comps="${i}"><td colspan="6"><div class="bulk-comps-panel"></div></td></tr>` : ''}`;
}

function toggleBulkComps(i) {
  const row = document.querySelector(`tr[data-bulk-comps="${i}"]`);
  if (!row) return;
  if (row.classList.contains('hidden')) {
    renderBulkCompsPanel(i);
    row.classList.remove('hidden');
  } else {
    row.classList.add('hidden');
  }
}

function renderBulkCompsPanel(i) {
  const r = bulkPriceResults[i];
  const panel = document.querySelector(`tr[data-bulk-comps="${i}"] .bulk-comps-panel`);
  if (!panel || !r) return;
  const med = r.median || 0;
  const usedCount = r.comps.filter(c => c.include).length;
  panel.innerHTML = `
    <div class="bulk-comps-head">
      <span class="bulk-comps-summary">${usedCount} of ${r.comps.length} comps used in median</span>
      <button type="button" class="ap-mini-btn" onclick="bulkSelectAllComps(${i}, true)">Include all</button>
      <button type="button" class="ap-mini-btn" onclick="bulkAutoExclude(${i})">Auto-trim highs</button>
    </div>
    <div class="bulk-comps-list">
      ${r.comps.map((c, j) => {
        const high = med && c.price > med * 2;
        return `<label class="bulk-comp ${c.include ? '' : 'bulk-comp-excluded'}">
          <input type="checkbox" ${c.include ? 'checked' : ''} onchange="toggleBulkComp(${i}, ${j}, this.checked)" />
          ${c.image ? `<img class="bulk-comp-img" src="${escHtml(c.image)}" onerror="this.style.visibility='hidden'" loading="lazy" alt="" />` : '<span class="bulk-comp-img"></span>'}
          <span class="bulk-comp-title">${escHtml(c.title)}</span>
          <span class="bulk-comp-price ${high ? 'bulk-comp-high' : ''}">$${c.price.toFixed(2)}${high ? ' <span class="bulk-high-tag">high</span>' : ''}</span>
          ${c.url ? `<a class="bulk-comp-link" href="${escHtml(epnUrl(c.url))}" target="_blank" rel="noopener">view</a>` : '<span class="bulk-comp-link"></span>'}
        </label>`;
      }).join('')}
    </div>`;
}

function toggleBulkComp(i, j, checked) {
  const r = bulkPriceResults[i];
  if (!r || !r.comps[j]) return;
  r.comps[j].include = checked;
  recalcBulkRow(i);
  const panel = document.querySelector(`tr[data-bulk-comps="${i}"] .bulk-comps-panel`);
  if (panel) {
    const label = panel.querySelectorAll('.bulk-comp')[j];
    if (label) label.classList.toggle('bulk-comp-excluded', !checked);
    const summary = panel.querySelector('.bulk-comps-summary');
    if (summary) summary.textContent = `${r.comps.filter(c => c.include).length} of ${r.comps.length} comps used in median`;
  }
}

// Recompute a card's median/low/high/count from only the included comps and
// update its table row in place (so CSV export reflects the exclusions too).
function recalcBulkRow(i) {
  const r = bulkPriceResults[i];
  if (!r) return;
  const prices = r.comps.filter(c => c.include).map(c => c.price).filter(p => p > 0).sort((a, b) => a - b);
  if (prices.length) {
    const n = prices.length;
    const m = n % 2 ? prices[(n - 1) / 2] : (prices[n / 2 - 1] + prices[n / 2]) / 2;
    r.median = Math.round(m * 100) / 100;
    r.low = prices[0]; r.high = prices[n - 1]; r.count = n;
  } else {
    r.median = null; r.low = null; r.high = null; r.count = 0;
  }
  const tr = document.querySelector(`tr[data-bulk-row="${i}"]`);
  if (tr) {
    tr.classList.toggle('bulk-row-na', r.median == null);
    tr.querySelector('[data-cell="median"]').textContent = r.median != null ? `$${r.median.toFixed(2)}` : '—';
    tr.querySelector('[data-cell="low"]').textContent = r.low != null ? `$${r.low.toFixed(2)}` : '—';
    tr.querySelector('[data-cell="high"]').textContent = r.high != null ? `$${r.high.toFixed(2)}` : '—';
    tr.querySelector('[data-cell="count"]').textContent = r.count;
  }
}

function bulkSelectAllComps(i, val) {
  const r = bulkPriceResults[i];
  if (!r) return;
  r.comps.forEach(c => { c.include = val; });
  recalcBulkRow(i);
  renderBulkCompsPanel(i);
}

// Exclude comps priced more than 2x the median of the currently-included
// comps — the "random high ones" the user wants gone.
function bulkAutoExclude(i) {
  const r = bulkPriceResults[i];
  if (!r) return;
  const inc = r.comps.filter(c => c.include).map(c => c.price).sort((a, b) => a - b);
  if (inc.length < 3) { showPortfolioToast('Need at least 3 comps to auto-trim.'); return; }
  const med = inc.length % 2 ? inc[(inc.length - 1) / 2] : (inc[inc.length / 2 - 1] + inc[inc.length / 2]) / 2;
  let trimmed = 0;
  r.comps.forEach(c => { if (c.include && c.price > med * 2) { c.include = false; trimmed++; } });
  recalcBulkRow(i);
  renderBulkCompsPanel(i);
  showPortfolioToast(trimmed ? `Excluded ${trimmed} high comp${trimmed !== 1 ? 's' : ''}.` : 'No high outliers found.');
}

function exportBulkCSV() {
  if (!bulkPriceResults.length) { alert('Run Bulk Pricer first.'); return; }
  const header = 'Card,Median Sold,Low,High,Sales Count';
  const rows = bulkPriceResults.map(r => [r.query, r.median ?? '', r.low ?? '', r.high ?? '', r.count].map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));
  const csv = [header, ...rows].join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `card-prices-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
}

// ---- Grading Advisor ----
async function runGradingAdvisor(e) {
  e.preventDefault();
  const query = document.getElementById('grading-input').value.trim();
  if (!query) return false;
  if (!checkDailyLimit('grading', FREE_LIMITS.dailyGrading, 'Grading Advisor')) return false;

  const loading  = document.getElementById('grading-loading');
  const errorEl  = document.getElementById('grading-error');
  const results  = document.getElementById('grading-results');
  const btn      = document.getElementById('grading-btn');

  loading.classList.remove('hidden');
  errorEl.classList.add('hidden');
  results.classList.add('hidden');
  btn.disabled = true;
  btn.textContent = 'Analyzing...';

  try {
    const res  = await authFetch(`/api/grading-advisor?q=${encodeURIComponent(query)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to fetch data');
    renderGradingResults(data);
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.classList.remove('hidden');
  } finally {
    loading.classList.add('hidden');
    btn.disabled = false;
    btn.textContent = 'Analyze';
  }
  return false;
}

let _gradingComps = {};

function renderGradingResults(data) {
  const { grades, premiums, query } = data;
  const tbody  = document.getElementById('grading-tbody');
  const recBox = document.getElementById('grading-recommendation');
  const results = document.getElementById('grading-results');

  // Stash the comps behind each grade so "view" can open the listings.
  _gradingComps = data.comps || {};

  const fmt = v => v != null ? `$${v.toFixed(2)}` : '—';
  const fmtNet = net => {
    if (net == null) return '—';
    const cls = net > 0 ? 'grading-positive' : 'grading-negative';
    return `<span class="${cls}">${net > 0 ? '+' : ''}$${net.toFixed(2)}</span>`;
  };

  const rows = [
    { label: 'Raw',    key: 'raw',   stats: grades.raw,   premium: null },
    { label: 'PSA 8',  key: 'psa8',  stats: grades.psa8,  premium: premiums.psa8  },
    { label: 'PSA 9',  key: 'psa9',  stats: grades.psa9,  premium: premiums.psa9  },
    { label: 'PSA 10', key: 'psa10', stats: grades.psa10, premium: premiums.psa10 },
  ];

  tbody.innerHTML = rows.map(({ label, key, stats, premium }) => {
    if (!stats) return `<tr class="grading-no-data"><td>${label}</td><td colspan="6" style="color:var(--text-muted);font-style:italic">No recent sold data found</td></tr>`;
    const gross = premium ? fmt(premium.gross) : '—';
    const net   = premium ? fmtNet(premium.net) : '—';
    const isRaw = label === 'Raw';
    const hasComps = (_gradingComps[key] || []).length > 0;
    const salesCell = hasComps
      ? `<button type="button" class="grading-comps-link" onclick="openGradingComps('${key}')" title="View the sold listings behind this">${stats.sales} <span class="grading-comps-eye">&#128065;</span></button>`
      : `${stats.sales}`;
    return `<tr class="${isRaw ? 'grading-raw-row' : ''}">
      <td><strong>${label}</strong></td>
      <td>${fmt(stats.avg)}</td>
      <td>${fmt(stats.median)}</td>
      <td>${fmt(stats.min)} – ${fmt(stats.max)}</td>
      <td>${salesCell}</td>
      <td>${gross}</td>
      <td>${net}</td>
    </tr>`;
  }).join('');

  // Recommendation banner
  const bestGrade = ['psa10','psa9','psa8'].find(g => premiums[g]?.worthIt);
  if (bestGrade) {
    const label = bestGrade === 'psa10' ? 'PSA 10' : bestGrade === 'psa9' ? 'PSA 9' : 'PSA 8';
    const net   = premiums[bestGrade].net;
    recBox.className = 'grading-recommendation grading-rec-yes';
    recBox.innerHTML = `<span class="grading-rec-icon">✅</span> <strong>Grading looks worth it!</strong> A ${label} nets you an estimated <strong>+$${net.toFixed(2)}</strong> after the $25 grading fee.`;
  } else if (!grades.psa10 && !grades.psa9 && !grades.psa8) {
    recBox.className = 'grading-recommendation grading-rec-unknown';
    recBox.innerHTML = `<span class="grading-rec-icon">❓</span> <strong>Not enough data</strong> — no recent graded sales found for this card.`;
  } else {
    recBox.className = 'grading-recommendation grading-rec-no';
    recBox.innerHTML = `<span class="grading-rec-icon">❌</span> <strong>Probably not worth grading</strong> — the grade premium doesn't cover the $25 fee based on recent sales.`;
  }

  results.classList.remove('hidden');
}

// ---- Grading Advisor: view the comps behind each grade ----
const _GRADING_GRADE_LABELS = { raw: 'Raw / Ungraded', psa8: 'PSA 8', psa9: 'PSA 9', psa10: 'PSA 10' };

function openGradingComps(key) {
  const comps = _gradingComps[key] || [];
  const modal = document.getElementById('grading-comps-modal');
  const titleEl = document.getElementById('grading-comps-title');
  const body = document.getElementById('grading-comps-body');
  if (!modal || !body) return;

  titleEl.textContent = `${_GRADING_GRADE_LABELS[key] || key} — sold comps`;

  if (!comps.length) {
    body.innerHTML = '<p class="gc-empty">No comps available for this grade.</p>';
  } else {
    const prices = comps.map(c => parseFloat(c.price)).filter(p => !isNaN(p) && p > 0).sort((a, b) => a - b);
    const median = prices.length
      ? (prices.length % 2 ? prices[(prices.length - 1) / 2] : (prices[prices.length / 2 - 1] + prices[prices.length / 2]) / 2)
      : null;
    const summary = `<p class="gc-summary">${comps.length} sold ${comps.length === 1 ? 'listing' : 'listings'}${median != null ? ` · median <strong>$${median.toFixed(2)}</strong>` : ''}</p>`;
    const rows = comps.map(c => {
      const price = parseFloat(c.price);
      const priceStr = !isNaN(price) ? `$${price.toFixed(2)}` : (c.price || '');
      const when = _gradingCompDate(c.soldDate);
      const img = c.imageUrl
        ? `<img class="gc-comp-img" src="${escHtml(c.imageUrl)}" alt="" loading="lazy" />`
        : '<div class="gc-comp-img gc-comp-noimg">&#127944;</div>';
      const titleHtml = c.itemUrl
        ? `<a class="gc-comp-title" href="${escHtml(c.itemUrl)}" target="_blank" rel="noopener">${escHtml(c.title || '')}</a>`
        : `<span class="gc-comp-title">${escHtml(c.title || '')}</span>`;
      return `<div class="gc-comp">
        ${img}
        <div class="gc-comp-main">
          ${titleHtml}
          <div class="gc-comp-meta"><span class="gc-comp-price">${priceStr}</span>${when ? ` · ${escHtml(when)}` : ''}</div>
        </div>
      </div>`;
    }).join('');
    body.innerHTML = summary + `<div class="gc-comp-list">${rows}</div>`;
  }

  modal.classList.remove('hidden');
}

function closeGradingComps() {
  const modal = document.getElementById('grading-comps-modal');
  if (modal) modal.classList.add('hidden');
}

function _gradingCompDate(soldDate) {
  if (!soldDate) return '';
  const d = new Date(soldDate);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

// ---- Grading Advisor: Grade My Card (photo pre-grade estimator) ----
// Estimates a card's condition grade entirely client-side. The photo is drawn
// to a canvas and analyzed for the four pillars PSA uses — centering, corners,
// edges and surface — then mapped to a 1–10 estimate. Nothing is uploaded and
// no API is called, so it costs nothing to run.
let _gradeScanImageDataUrl = null;
let _lastGradeAnalysis = null;   // most recent scan result — drives the value/share funnel
let _scanValueQuery = '';        // card name the user looked up after scanning
const GRADESCAN_IMG_DIM = 1100;

const _GRADE_NAMES = {
  10: 'Gem Mint', 9: 'Mint', 8: 'NM-Mint', 7: 'Near Mint',
  6: 'Excellent-Mint', 5: 'Excellent', 4: 'Very Good-Excellent',
  3: 'Very Good', 2: 'Good', 1: 'Poor',
};

async function handleGradeScanFile(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  if (!file.type.startsWith('image/')) { alert('Please select an image file.'); return; }
  if (file.size > 8 * 1024 * 1024) { alert('Image is too large (max 8MB).'); return; }
  try {
    // Keep resolution high so edge/corner detail survives the downscale.
    _gradeScanImageDataUrl = await readImageFileAsDataUrl(file, GRADESCAN_IMG_DIM, 0.9);
    document.getElementById('gradescan-preview').src = _gradeScanImageDataUrl;
    document.getElementById('gradescan-preview-wrap').classList.remove('hidden');
    document.getElementById('gradescan-error').classList.add('hidden');
    document.getElementById('gradescan-results').classList.add('hidden');
  } catch (err) {
    alert('Could not load image: ' + (err.message || 'Unknown error'));
  }
}

function clearGradeScan() {
  _gradeScanImageDataUrl = null;
  const input = document.getElementById('gradescan-file-input');
  if (input) input.value = '';
  document.getElementById('gradescan-preview-wrap').classList.add('hidden');
  document.getElementById('gradescan-results').classList.add('hidden');
  document.getElementById('gradescan-error').classList.add('hidden');
}

function estimateCardGrade() {
  if (!_gradeScanImageDataUrl) { alert('Please select a card photo first.'); return; }
  const loading = document.getElementById('gradescan-loading');
  const errEl   = document.getElementById('gradescan-error');
  const results = document.getElementById('gradescan-results');
  const btn     = document.getElementById('gradescan-btn');

  loading.classList.remove('hidden');
  errEl.classList.add('hidden');
  results.classList.add('hidden');
  if (btn) btn.disabled = true;

  const img = new Image();
  img.onload = () => {
    // Defer to the next frame so the spinner actually paints before the
    // (synchronous) pixel crunch locks the main thread.
    setTimeout(() => {
      try {
        const analysis = _analyzeCardImage(img);
        _renderGradeEstimate(analysis);
        results.classList.remove('hidden');
      } catch (err) {
        errEl.textContent = err.message || 'Could not analyze this photo. Try a sharper, straight-on shot.';
        errEl.classList.remove('hidden');
      } finally {
        loading.classList.add('hidden');
        if (btn) btn.disabled = false;
      }
    }, 30);
  };
  img.onerror = () => {
    loading.classList.add('hidden');
    if (btn) btn.disabled = false;
    errEl.textContent = 'Could not read that image.';
    errEl.classList.remove('hidden');
  };
  img.src = _gradeScanImageDataUrl;
}

// Core analysis. Draws the image small enough to crunch quickly, then derives
// the four condition pillars from real pixel measurements. The first step is to
// locate the card itself within the photo (auto-crop) so every pillar measures
// the card — not the background or the table behind it.
function _analyzeCardImage(img) {
  const MAX = 600;
  const scale = Math.min(1, MAX / Math.max(img.width, img.height));
  const w = Math.max(8, Math.round(img.width * scale));
  const h = Math.max(8, Math.round(img.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);

  // Grayscale luminance buffer.
  const gray = new Float32Array(w * h);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    gray[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }
  const at = (x, y) => gray[y * w + x];

  // Detect the card's bounding box by separating it from the background.
  const box = _detectCardBox(data, w, h);

  const centering = _measureCentering(gray, w, h, box);
  const corners   = _measureCorners(data, w, h, box);
  const edges     = _measureEdges(data, w, h, box);
  const surface   = _measureSurface(at, w, h, box);

  // Overall: a card can't grade much above its weakest pillar, so blend the
  // weighted average toward the lowest sub-grade. Centering is the one pillar
  // we measure directly, so it leads — but only when we actually found a border
  // to measure. If we couldn't, drop it from the blend rather than guess.
  let overall, lowest;
  if (centering.measured) {
    lowest = Math.min(centering.grade, corners.grade, edges.grade, surface.grade);
    const weighted = centering.grade * 0.35 + corners.grade * 0.25 + edges.grade * 0.25 + surface.grade * 0.15;
    overall = Math.round(Math.min(weighted, lowest + 1));
  } else {
    lowest = Math.min(corners.grade, edges.grade, surface.grade);
    const weighted = corners.grade * 0.4 + edges.grade * 0.35 + surface.grade * 0.25;
    overall = Math.round(Math.min(weighted, lowest + 1));
  }
  overall = Math.max(1, Math.min(10, overall));

  // Confidence reflects how trustworthy the photo is for this kind of measure.
  const confidence = _gradeConfidence(centering, surface, box, w, h);

  return { overall, centering, corners, edges, surface, confidence };
}

// Sample the four photo corners to estimate the background colour, then find
// the contiguous central region that differs from it on each axis — that's the
// card. Falls back to the full frame for tight crops where the card already
// fills the photo (no background to separate from).
function _detectCardBox(data, w, h) {
  const p = Math.max(4, Math.round(Math.min(w, h) * 0.05));
  const corners = [[0, 0], [w - p, 0], [0, h - p], [w - p, h - p]];
  const means = [];
  let mr = 0, mg = 0, mb = 0, n = 0;
  for (const [sx, sy] of corners) {
    let rr = 0, gg = 0, bb = 0, c = 0;
    for (let y = sy; y < sy + p; y++) for (let x = sx; x < sx + p; x++) {
      const i = (y * w + x) * 4; rr += data[i]; gg += data[i + 1]; bb += data[i + 2]; c++;
    }
    means.push([rr / c, gg / c, bb / c]); mr += rr; mg += gg; mb += bb; n += c;
  }
  const bg = [mr / n, mg / n, mb / n];
  // How consistent are the corners? A busy/cluttered background spreads them out
  // and makes the card harder to isolate.
  let spread = 0;
  for (const m of means) spread += Math.hypot(m[0] - bg[0], m[1] - bg[1], m[2] - bg[2]);
  spread /= means.length;

  const T = Math.max(36, spread * 1.5 + 24); // colour distance that counts as "card"
  const colFg = new Float32Array(w), rowFg = new Float32Array(h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    const d = Math.hypot(data[i] - bg[0], data[i + 1] - bg[1], data[i + 2] - bg[2]);
    if (d > T) { colFg[x]++; rowFg[y]++; }
  }
  for (let x = 0; x < w; x++) colFg[x] /= h;
  for (let y = 0; y < h; y++) rowFg[y] /= w;

  const xExt = _cardExtent(colFg, w);
  const yExt = _cardExtent(rowFg, h);
  return {
    x0: xExt.a, x1: xExt.b, y0: yExt.a, y1: yExt.b,
    cropped: !xExt.tight || !yExt.tight,
    bgSpread: spread,
  };
}

// Longest contiguous run of "card" coverage on one axis. If no clear run stands
// out (card fills the frame, or background ≈ card), return the full extent.
function _cardExtent(fg, n) {
  let bestA = -1, bestB = -1, curA = -1;
  for (let i = 0; i < n; i++) {
    if (fg[i] > 0.45) { if (curA < 0) curA = i; }
    else if (curA >= 0) { if (i - curA > bestB - bestA) { bestA = curA; bestB = i; } curA = -1; }
  }
  if (curA >= 0 && n - curA > bestB - bestA) { bestA = curA; bestB = n; }
  const edgeLow = fg[Math.floor(n * 0.02)] < 0.4 && fg[Math.min(n - 1, Math.floor(n * 0.98))] < 0.4;
  if (bestA >= 0 && (bestB - bestA) >= n * 0.35 && edgeLow) {
    return { a: bestA, b: Math.min(n - 1, bestB), tight: false };
  }
  return { a: 0, b: n - 1, tight: true };
}

// Centering — the one pillar we can truly measure. Within the detected card box
// we find the inner frame (the border-to-artwork transition) on each side and
// compare the border widths, exactly the ratio PSA grades on. If there's no
// clear border (full-bleed art, or an angled shot), we say so instead of faking
// a number.
function _measureCentering(gray, w, h, box) {
  const colE = _axisEnergy(gray, w, h, box, 'x');
  const rowE = _axisEnergy(gray, w, h, box, 'y');
  const lr = _innerFrame(colE, box.x0, box.x1);
  const tb = _innerFrame(rowE, box.y0, box.y1);

  if (!lr || !tb) {
    return { grade: 8, detail: 'No clear border found (borderless art or angled shot)', found: false, measured: false };
  }

  const leftPct = (lr.near / (lr.near + lr.far)) * 100;
  const topPct  = (tb.near / (tb.near + tb.far)) * 100;
  // Worst (most off-center) axis drives the grade, as PSA does.
  const worstOff = Math.max(Math.abs(leftPct - 50), Math.abs(topPct - 50));

  // Map % off-center to a sub-grade. 50/50→10, ~55/45→9, 60/40→8 ...
  let grade;
  if (worstOff <= 3) grade = 10;
  else if (worstOff <= 7) grade = 9;
  else if (worstOff <= 12) grade = 8;
  else if (worstOff <= 17) grade = 7;
  else if (worstOff <= 22) grade = 6;
  else if (worstOff <= 28) grade = 5;
  else grade = 4;

  const fmt = (p) => `${Math.round(p)}/${Math.round(100 - p)}`;
  return { grade, detail: `${fmt(leftPct)} L/R · ${fmt(topPct)} T/B`, found: true, measured: true };
}

// Directional gradient energy, accumulated only over the orthogonal span of the
// card box so background rows/columns don't pollute the profile.
function _axisEnergy(gray, w, h, box, axis) {
  if (axis === 'x') {
    const e = new Float32Array(w);
    const ya = Math.max(1, box.y0), yb = Math.min(h - 1, box.y1);
    for (let y = ya; y < yb; y++) for (let x = 1; x < w - 1; x++) {
      e[x] += Math.abs(gray[y * w + x + 1] - gray[y * w + x - 1]);
    }
    return e;
  }
  const e = new Float32Array(h);
  const xa = Math.max(1, box.x0), xb = Math.min(w - 1, box.x1);
  for (let y = 1; y < h - 1; y++) for (let x = xa; x < xb; x++) {
    e[y] += Math.abs(gray[(y + 1) * w + x] - gray[(y - 1) * w + x]);
  }
  return e;
}

// Inside a card span [a,b], find the strongest gradient peak within the outer
// ~22% from each end — the border-to-artwork transition. Returns each side's
// border width (near/far), or null when no prominent, plausible frame exists.
function _innerFrame(energy, a, b) {
  const span = b - a;
  if (span < 20) return null;
  const band = Math.max(4, Math.floor(span * 0.22));
  const m = Math.max(2, Math.floor(span * 0.012));
  let maxE = 0;
  for (let i = a; i <= b; i++) if (energy[i] > maxE) maxE = energy[i];
  if (maxE <= 0) return null;

  const peak = (from, to, step) => {
    let bi = -1, bv = -Infinity;
    for (let i = from; step > 0 ? i <= to : i >= to; i += step) {
      if (energy[i] > bv) { bv = energy[i]; bi = i; }
    }
    return { i: bi, v: bv };
  };
  const L = peak(a + m, a + band, 1);
  const R = peak(b - m, b - band, -1);

  const minProm = maxE * 0.25; // frame edge should be a real, strong line
  if (L.v < minProm || R.v < minProm) return null;
  const near = L.i - a, far = b - R.i;
  // If a "frame" sits at the very edge of the search band, we didn't really find
  // one — likely a full-bleed design with no border to grade.
  if (near >= band - 1 || far >= band - 1 || near < 1 || far < 1) return null;
  return { near, far };
}

// Corners — sample the four corners of the *detected card* (not the photo);
// whitening shows as a cluster of near-white, colourless pixels. Approximate:
// sensitive to lighting and glare.
function _measureCorners(data, w, h, box) {
  const bw = box.x1 - box.x0, bh = box.y1 - box.y0;
  const s = Math.max(6, Math.round(Math.min(bw, bh) * 0.07));
  const regions = [
    [box.x0, box.y0], [box.x1 - s, box.y0], [box.x0, box.y1 - s], [box.x1 - s, box.y1 - s],
  ];
  let worst = 0;
  regions.forEach(([sx, sy]) => {
    sx = Math.max(0, Math.min(w - s, sx)); sy = Math.max(0, Math.min(h - s, sy));
    let white = 0, total = 0;
    for (let y = sy; y < sy + s; y++) {
      for (let x = sx; x < sx + s; x++) {
        const i = (y * w + x) * 4;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        const sat = Math.max(r, g, b) - Math.min(r, g, b);
        if (lum > 200 && sat < 30) white++; // bright + colorless = wear/whitening
        total++;
      }
    }
    worst = Math.max(worst, total ? white / total : 0);
  });
  const grade = _ratioToGrade(worst, [0.02, 0.05, 0.10, 0.18, 0.28]);
  return { grade, detail: `${Math.round(worst * 100)}% corner wear`, found: true, measured: false };
}

// Edges — thin strips just inside the detected card border; whitening/chipping
// reads as a band of near-white, colourless pixels. Approximate.
function _measureEdges(data, w, h, box) {
  const bw = box.x1 - box.x0, bh = box.y1 - box.y0;
  const t = Math.max(2, Math.round(Math.min(bw, bh) * 0.02));
  let white = 0, total = 0;
  const sample = (x, y) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const i = (y * w + x) * 4;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    const sat = Math.max(r, g, b) - Math.min(r, g, b);
    if (lum > 205 && sat < 28) white++;
    total++;
  };
  for (let k = 0; k < t; k++) for (let x = box.x0; x <= box.x1; x++) { sample(x, box.y0 + k); sample(x, box.y1 - k); }
  for (let k = 0; k < t; k++) for (let y = box.y0 + t; y <= box.y1 - t; y++) { sample(box.x0 + k, y); sample(box.x1 - k, y); }
  const ratio = total ? white / total : 0;
  const grade = _ratioToGrade(ratio, [0.04, 0.09, 0.16, 0.26, 0.38]);
  return { grade, detail: `${Math.round(ratio * 100)}% edge whitening`, found: true, measured: false };
}

// Surface — scratches, print lines and creases raise high-frequency contrast.
// We measure local Laplacian energy across the card interior; very high or
// very low both hurt (defects vs. out-of-focus), so we target a clean midrange.
// Approximate: easily thrown off by glare, focus and card texture/foil.
function _measureSurface(at, w, h, box) {
  const bw = box.x1 - box.x0, bh = box.y1 - box.y0;
  const x0 = Math.max(1, Math.floor(box.x0 + bw * 0.15)), x1 = Math.min(w - 1, Math.floor(box.x1 - bw * 0.15));
  const y0 = Math.max(1, Math.floor(box.y0 + bh * 0.15)), y1 = Math.min(h - 1, Math.floor(box.y1 - bh * 0.15));
  let spikes = 0, total = 0, sum = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const lap = Math.abs(4 * at(x, y) - at(x - 1, y) - at(x + 1, y) - at(x, y - 1) - at(x, y + 1));
      sum += lap;
      if (lap > 90) spikes++; // sharp local discontinuity = scratch/print line
      total++;
    }
  }
  const spikeRatio = total ? spikes / total : 0;
  const mean = total ? sum / total : 0;
  let grade = _ratioToGrade(spikeRatio, [0.015, 0.035, 0.065, 0.10, 0.16]);
  if (mean < 3) grade = Math.min(grade, 8); // too smooth → likely soft/blurry photo
  return { grade, detail: `${(spikeRatio * 100).toFixed(1)}% surface defects`, found: true, measured: false };
}

// Map a "defect ratio" to a 1–10 grade given ascending thresholds for 10/9/8/7/6.
function _ratioToGrade(ratio, thresholds) {
  if (ratio <= thresholds[0]) return 10;
  if (ratio <= thresholds[1]) return 9;
  if (ratio <= thresholds[2]) return 8;
  if (ratio <= thresholds[3]) return 7;
  if (ratio <= thresholds[4]) return 6;
  return 5;
}

function _gradeConfidence(centering, surface, box, w, h) {
  let score = 1; // start just below medium — this is an estimate, not a grade
  if (centering.measured) score += 1; else score -= 1; // a real border read is the strongest signal
  if (Math.max(w, h) < 250) score -= 1;             // low-res photo
  if (surface.detail.startsWith('0.0')) score -= 1; // basically no detail = blurry
  if (box.bgSpread > 70) score -= 1;                // cluttered background = shaky crop
  if (Math.max(w, h) >= 450) score += 1;
  if (score >= 3) return { level: 'High', cls: 'high' };
  if (score <= 0) return { level: 'Low', cls: 'low' };
  return { level: 'Medium', cls: 'med' };
}

function _renderGradeEstimate(a) {
  _lastGradeAnalysis = a;
  // Reset the funnel state for the new scan.
  _scanValueQuery = '';
  const valOut = document.getElementById('gradescan-value-out');
  if (valOut) { valOut.classList.add('hidden'); valOut.innerHTML = ''; }
  const qEl = document.getElementById('gradescan-card-q');
  if (qEl) qEl.value = '';
  document.getElementById('gradescan-grade-num').textContent = a.overall;
  document.getElementById('gradescan-grade-name').textContent = _GRADE_NAMES[a.overall] || '';

  const badge = document.getElementById('gradescan-badge');
  badge.className = 'gradescan-badge ' + (a.overall >= 9 ? 'is-gem' : a.overall >= 7 ? 'is-good' : 'is-low');

  const conf = document.getElementById('gradescan-confidence');
  conf.className = 'gradescan-confidence conf-' + a.confidence.cls;
  conf.textContent = `Confidence: ${a.confidence.level}`;

  const tip = document.getElementById('gradescan-tip');
  const subs = [
    { k: 'Centering', v: a.centering }, { k: 'Corners', v: a.corners },
    { k: 'Edges', v: a.edges }, { k: 'Surface', v: a.surface },
  ];
  // Only let directly-measured pillars (centering) claim to be "holding it
  // back" — the approximated ones aren't reliable enough to call out by name.
  const measuredSubs = subs.filter(s => s.v.measured);
  const weakest = (measuredSubs.length ? measuredSubs : subs).reduce((m, s) => s.v.grade < m.v.grade ? s : m);
  if (!a.centering.measured) {
    tip.textContent = 'Couldn’t lock onto the card’s border, so centering is a guess here. Re-shoot straight-on against a plain, contrasting background for a real read.';
  } else if (a.overall >= 9) {
    tip.textContent = 'Centering looks strong. Corners, edges & surface are rough reads from one photo — inspect those in hand before grading.';
  } else {
    tip.textContent = `${weakest.k.toLowerCase()} is the main concern. Re-shoot straight-on in even light to confirm.`;
  }

  const wrap = document.getElementById('gradescan-subgrades');
  wrap.innerHTML = subs.map(s => {
    const pct = s.v.grade * 10;
    const cls = s.v.grade >= 9 ? 'sg-gem' : s.v.grade >= 7 ? 'sg-good' : 'sg-low';
    const measured = s.v.measured;
    const tag = measured
      ? '<span class="gradescan-sg-tag tag-measured" title="Measured directly from the photo">measured</span>'
      : '<span class="gradescan-sg-tag tag-approx" title="Rough estimate — sensitive to lighting, angle & focus">approx</span>';
    const num = (s.k === 'Centering' && !measured) ? '—' : s.v.grade;
    return `<div class="gradescan-sg">
      <div class="gradescan-sg-top"><span>${s.k} ${tag}</span><strong>${num}</strong></div>
      <div class="gradescan-sg-bar"><div class="gradescan-sg-fill ${cls}" style="width:${pct}%"></div></div>
      <div class="gradescan-sg-detail">${s.v.detail}</div>
    </div>`;
  }).join('');
}

// ---- Grade scanner sales funnel ----
// The free scan is the hook; this turns it into a buy moment by answering the
// very next question — "so what's it worth, and should I grade & sell it?" — and
// routing intent into Pro (track-to-sell alerts), lead capture and sharing.
const _usd = (n) => (n == null || isNaN(n)) ? '—' : `$${Number(n).toFixed(2)}`;

function _gradeToTier(overall) {
  if (overall >= 10) return 'psa10';
  if (overall >= 9) return 'psa9';
  if (overall >= 8) return 'psa8';
  return 'raw';
}
const _TIER_LABEL = { psa10: 'PSA 10', psa9: 'PSA 9', psa8: 'PSA 8', raw: 'Raw' };

async function scanValueLookup() {
  const qEl = document.getElementById('gradescan-card-q');
  const out = document.getElementById('gradescan-value-out');
  if (!qEl || !out) return;
  const q = qEl.value.trim();
  out.classList.remove('hidden');
  if (q.length < 3) {
    out.innerHTML = '<p class="gradescan-value-hint">Type the card — year, set, player — to pull live sold values.</p>';
    return;
  }
  _scanValueQuery = q;
  out.innerHTML = '<div class="gradescan-value-loading"><div class="spinner"></div><span>Pulling live sold comps…</span></div>';
  try {
    const res = await authFetch(`/api/grading-advisor?q=${encodeURIComponent(q)}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.noKey || data.badKey || !data.grades) {
      out.innerHTML = _scanValueLocked(q, data);
      return;
    }
    _renderScanValue(q, data.grades);
  } catch {
    out.innerHTML = '<p class="gradescan-value-hint">Couldn’t load values right now — try again in a moment.</p>';
  }
}

// Shown when we can't pull live comps (no/invalid scrape.do key).
function _scanValueLocked(q, data) {
  const est = _lastGradeAnalysis ? _lastGradeAnalysis.overall : 9;
  const tier = _TIER_LABEL[_gradeToTier(est)];
  return `<div class="gradescan-value-card gradescan-value-locked">
    <p class="gradescan-value-swing">A <strong>${tier}</strong> often sells for several times its raw price. Add your free scrape.do API key to see the exact live swing for “${escHtml(q)}”.</p>
    <div class="gradescan-cta-card">
      <button class="gradescan-track-btn" onclick="showSettings()">Add your scrape.do key in Settings</button>
      <p class="gradescan-track-msg">It's free and unlocks live sold-price lookups everywhere.</p>
    </div>
  </div>` + _scanLeadBlock();
}

function _renderScanValue(q, grades) {
  const out = document.getElementById('gradescan-value-out');
  const est = _lastGradeAnalysis ? _lastGradeAnalysis.overall : 9;
  const raw = grades.raw;
  // Use the estimated tier, falling back to whatever graded data exists.
  const order = [_gradeToTier(est), 'psa10', 'psa9', 'psa8'].filter((v, i, a) => a.indexOf(v) === i && v !== 'raw');
  let gKey = null, gStat = null;
  for (const k of order) { if (grades[k] && grades[k].median) { gKey = k; gStat = grades[k]; break; } }

  if (!raw || !raw.median || !gStat) {
    out.innerHTML = `<div class="gradescan-value-card"><p class="gradescan-value-hint">Not enough sold data for “${escHtml(q)}”. Try a more specific card name (add the year & set).</p></div>` + _scanCtaBlock();
    return;
  }

  const GRADING_FEE = 25; // economy grading, roughly
  const swing = gStat.median - raw.median;
  const net = swing - GRADING_FEE;
  const worth = net > 0;
  out.innerHTML = `
    <div class="gradescan-value-card">
      <div class="gradescan-value-grid">
        <div class="gv-cell"><span class="gv-label">Raw</span><span class="gv-num">${_usd(raw.median)}</span></div>
        <div class="gv-arrow">→</div>
        <div class="gv-cell gv-graded"><span class="gv-label">${_TIER_LABEL[gKey]} · your est.</span><span class="gv-num">${_usd(gStat.median)}</span></div>
      </div>
      <p class="gradescan-value-swing">${worth
        ? `Grading could add about <strong>${_usd(net)}</strong> after fees — this looks <strong>worth grading</strong>.`
        : `The graded premium (~${_usd(Math.max(0, swing))}) barely clears grading fees here — likely <strong>not worth it</strong>.`}</p>
      <p class="gradescan-value-foot">Based on recent eBay sold medians (${raw.sales || 0} raw · ${gStat.sales || 0} graded).</p>
    </div>` + _scanCtaBlock();
}

// Track-to-sell CTA (Pro conversion) + email lead capture (works for anyone).
function _scanCtaBlock() {
  return `<div class="gradescan-cta-card">
    <button class="gradescan-track-btn" onclick="scanTrackCard()">&#128276; Track this card — get alerted when it&rsquo;s time to sell</button>
    <p class="gradescan-track-msg" id="gradescan-track-msg"></p>
  </div>` + _scanLeadBlock();
}

function _scanLeadBlock() {
  return `<form class="gradescan-lead" onsubmit="return scanLeadSubmit(event)">
    <input type="email" class="gradescan-lead-email" id="gradescan-lead-email" placeholder="you@email.com" autocomplete="email" />
    <button type="submit" class="gradescan-lead-btn">Email me sell tips</button>
    <p class="gradescan-lead-msg" id="gradescan-lead-msg"></p>
  </form>`;
}

async function scanTrackCard() {
  const q = _scanValueQuery || (document.getElementById('gradescan-card-q')?.value || '').trim();
  const msg = document.getElementById('gradescan-track-msg');
  if (!q) return;
  const user = getCurrentUser();
  if (!user) { showLogin(); return; }
  const email = getUsers()[user?.toLowerCase()]?.email;
  if (!email) { if (msg) msg.textContent = 'Add an email to your account first (Settings) to receive alerts.'; return; }
  try {
    const res = await fetch('/api/alerts', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: user, email, query: q, label: q }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 402 || (data && data.upgrade)) {
      showUpgrade(data.error || 'Price Alerts is a Pro feature.');
      if (msg) msg.textContent = '';
      return;
    }
    if (msg) msg.textContent = res.ok
      ? '✓ Tracking — we’ll email you when the market moves on this card.'
      : (data.error || 'Could not track this card.');
  } catch { if (msg) msg.textContent = 'Network error — try again.'; }
}

async function scanLeadSubmit(e) {
  e.preventDefault();
  const emailEl = document.getElementById('gradescan-lead-email');
  const msg = document.getElementById('gradescan-lead-msg');
  const email = (emailEl?.value || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { if (msg) msg.textContent = 'Enter a valid email.'; return false; }
  try {
    const res = await fetch('/api/scan-lead', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, card: _scanValueQuery || '', grade: _lastGradeAnalysis?.overall ?? null }),
    });
    if (msg) msg.textContent = res.ok ? '✓ You’re on the list — we’ll email sell-time tips for this card.' : 'Something went wrong, try again.';
    if (res.ok && emailEl) emailEl.value = '';
  } catch { if (msg) msg.textContent = 'Network error — try again.'; }
  return false;
}

// Build a shareable square image of the grade result and hand it to the native
// share sheet (or download + copy a link as a fallback). Every share is free
// top-of-funnel marketing.
async function shareGradeResult() {
  if (!_lastGradeAnalysis) return;
  try {
    const blob = await _buildShareImage(_lastGradeAnalysis);
    const origin = location.origin;
    const text = `My card scored an estimated ${_lastGradeAnalysis.overall}/10 on The Card Huddle — grade yours free at ${origin}`;
    const file = new File([blob], 'card-grade.png', { type: 'image/png' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], text, title: 'My Card Grade' });
      return;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'card-grade.png'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    try { await navigator.clipboard.writeText(text); } catch {}
    alert('Saved your grade image — share link copied to your clipboard!');
  } catch {
    alert('Could not create the share image on this device.');
  }
}

function _buildShareImage(a) {
  return new Promise((resolve, reject) => {
    const W = 1080, H = 1080;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    // Background
    const bg = ctx.createLinearGradient(0, 0, W, H);
    bg.addColorStop(0, '#0f1714'); bg.addColorStop(1, '#16241d');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);

    const accent = a.overall >= 9 ? '#5ece99' : a.overall >= 7 ? '#facc15' : '#f87171';
    ctx.textAlign = 'center';

    // Brand
    ctx.fillStyle = '#9fb3aa';
    ctx.font = '600 34px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
    ctx.fillText('THE CARD HUDDLE', W / 2, 110);
    ctx.fillStyle = '#6f857c';
    ctx.font = '500 26px system-ui, sans-serif';
    ctx.fillText('Free card grade estimate', W / 2, 156);

    // Big grade
    ctx.fillStyle = accent;
    ctx.font = '800 360px system-ui, sans-serif';
    ctx.fillText(String(a.overall), W / 2, 540);
    ctx.fillStyle = '#e6efea';
    ctx.font = '700 56px system-ui, sans-serif';
    ctx.fillText((_GRADE_NAMES[a.overall] || '') + ' · est. ' + a.overall + '/10', W / 2, 620);

    // Sub-grades row
    const subs = [['Centering', a.centering], ['Corners', a.corners], ['Edges', a.edges], ['Surface', a.surface]];
    const colW = 230, startX = W / 2 - (colW * 4) / 2 + colW / 2;
    subs.forEach(([k, v], i) => {
      const x = startX + i * colW;
      ctx.fillStyle = '#9fb3aa';
      ctx.font = '600 30px system-ui, sans-serif';
      ctx.fillText(k, x, 770);
      ctx.fillStyle = '#e6efea';
      ctx.font = '800 64px system-ui, sans-serif';
      ctx.fillText((k === 'Centering' && !v.measured) ? '—' : String(v.grade), x, 840);
    });

    // Footer CTA
    ctx.fillStyle = accent;
    ctx.font = '700 40px system-ui, sans-serif';
    ctx.fillText('Grade your cards free', W / 2, 970);
    ctx.fillStyle = '#9fb3aa';
    ctx.font = '500 32px system-ui, sans-serif';
    ctx.fillText(location.host, W / 2, 1018);

    c.toBlob((b) => b ? resolve(b) : reject(new Error('toBlob failed')), 'image/png');
  });
}

// Build a shareable square image of the current card's price summary and hand
// it to the native share sheet (or download + copy a link as a fallback).
async function shareSearchResult() {
  const prices = (currentResults || []).map(r => parseFloat(r.price)).filter(p => !isNaN(p));
  const query = (_searchPaging && _searchPaging.query) || (input && input.value) || '';
  if (!prices.length || !query) { alert('Run a search first, then share the price.'); return; }
  const sorted = [...prices].sort((a, b) => a - b);
  const stats = {
    count: prices.length,
    avg: prices.reduce((a, b) => a + b, 0) / prices.length,
    median: sorted[Math.floor(sorted.length / 2)],
    min: sorted[0],
    max: sorted[sorted.length - 1],
    isSold: currentResultMode === 'sold',
  };
  try {
    const blob = await _buildPriceShareImage(query, stats);
    const origin = location.origin;
    const text = `${query} — ${stats.isSold ? 'avg sold' : 'avg'} $${stats.avg.toFixed(2)} (${stats.count} ${stats.isSold ? 'recent sales' : 'listings'}). Check any card's value free at ${origin}`;
    const file = new File([blob], 'card-price.png', { type: 'image/png' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], text, title: 'Card Price' });
      return;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'card-price.png'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    try { await navigator.clipboard.writeText(text); } catch {}
    alert('Saved your price image — share link copied to your clipboard!');
  } catch {
    alert('Could not create the share image on this device.');
  }
}

function _buildPriceShareImage(query, stats) {
  return new Promise((resolve, reject) => {
    const W = 1080, H = 1080;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    const accent = '#5ece99';

    // Background
    const bg = ctx.createLinearGradient(0, 0, W, H);
    bg.addColorStop(0, '#0c0e14'); bg.addColorStop(1, '#161b28');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
    ctx.textAlign = 'center';

    // Brand
    ctx.fillStyle = '#9aa3b2';
    ctx.font = '700 36px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
    ctx.fillText('THE CARD HUDDLE', W / 2, 120);
    ctx.fillStyle = '#6f7a8c';
    ctx.font = '500 26px system-ui, sans-serif';
    ctx.fillText('Real eBay sold prices', W / 2, 164);

    // Card title (wrapped, up to 3 lines)
    ctx.fillStyle = '#edf0f7';
    ctx.font = '800 58px system-ui, sans-serif';
    const words = String(query).trim().split(/\s+/);
    const lines = []; let line = '';
    for (const w of words) {
      const t = line ? line + ' ' + w : w;
      if (ctx.measureText(t).width > W - 160 && line) { lines.push(line); line = w; } else line = t;
    }
    if (line) lines.push(line);
    if (lines.length > 3) { lines.length = 3; lines[2] = lines[2].replace(/\W*$/, '') + '…'; }
    const titleY = 300 - (lines.length - 1) * 34;
    lines.forEach((ln, i) => ctx.fillText(ln, W / 2, titleY + i * 70));

    const money = (v) => '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    // Big average price — shrink to fit the canvas width (4–5 digit prices
    // would otherwise overflow at a fixed size).
    const priceStr = money(stats.avg);
    let pf = 200;
    ctx.font = `800 ${pf}px system-ui, sans-serif`;
    while (ctx.measureText(priceStr).width > W - 120 && pf > 80) { pf -= 8; ctx.font = `800 ${pf}px system-ui, sans-serif`; }
    ctx.fillStyle = accent;
    ctx.fillText(priceStr, W / 2, 620);
    ctx.fillStyle = '#9aa3b2';
    ctx.font = '600 34px system-ui, sans-serif';
    ctx.fillText(`${stats.isSold ? 'Average of' : 'Average across'} ${stats.count} ${stats.isSold ? 'recent eBay sales' : 'live listings'}`, W / 2, 686);

    // Low / Median / High row
    const cells = [['Low', stats.min], ['Median', stats.median], ['High', stats.max]];
    const colW = 300, startX = W / 2 - colW, baseY = 820;
    cells.forEach(([k, v], i) => {
      const x = startX + i * colW;
      ctx.fillStyle = '#6f7a8c';
      ctx.font = '600 30px system-ui, sans-serif';
      ctx.fillText(k, x, baseY);
      ctx.fillStyle = '#edf0f7';
      ctx.font = '800 48px system-ui, sans-serif';
      ctx.fillText(money(v), x, baseY + 64);
    });

    // Footer CTA
    ctx.fillStyle = accent;
    ctx.font = '700 40px system-ui, sans-serif';
    ctx.fillText('Check any card’s value free', W / 2, 980);
    ctx.fillStyle = '#9aa3b2';
    ctx.font = '500 32px system-ui, sans-serif';
    ctx.fillText(location.host, W / 2, 1026);

    // Accent bar
    ctx.fillStyle = accent;
    ctx.fillRect(0, H - 12, W, 12);

    c.toBlob((b) => b ? resolve(b) : reject(new Error('toBlob failed')), 'image/png');
  });
}

async function loadChecklistProducts() {
  checklistProductGrid.innerHTML = '<div class="checklist-loading"><div class="spinner"></div><span>Loading checklists...</span></div>';
  try {
    const data = await fetchChecklistsList();
    checklistProductGrid.innerHTML = '';

    // Group products by year
    const byYear = {};
    data.products.forEach(p => {
      const yr = p.year || 'Other';
      if (!byYear[yr]) byYear[yr] = [];
      byYear[yr].push(p);
    });

    // Sort years descending (newest first)
    const years = Object.keys(byYear).sort((a, b) => b - a);

    years.forEach((year, idx) => {
      const section = document.createElement('div');
      section.className = 'checklist-year-section';

      const header = document.createElement('button');
      header.className = 'checklist-year-header';
      // First year expanded by default
      if (idx === 0) header.classList.add('open');
      header.innerHTML = `
        <span class="checklist-year-label">${escHtml(String(year))}</span>
        <span class="checklist-year-count">${byYear[year].length} product${byYear[year].length !== 1 ? 's' : ''}</span>
        <span class="checklist-year-toggle">&#9662;</span>
      `;

      const body = document.createElement('div');
      body.className = 'checklist-year-body';
      if (idx === 0) body.classList.add('open');

      const grid = document.createElement('div');
      grid.className = 'checklist-year-grid';

      byYear[year].forEach(p => {
        const card = document.createElement('div');
        card.className = 'checklist-product-card';
        card.innerHTML = `
          <div class="checklist-product-info">
            <h3>${escHtml(p.name)}</h3>
            <div class="checklist-product-stats">
              <span>${p.setCount} sets</span>
              <span>${p.totalCards} cards</span>
            </div>
          </div>
          <span class="checklist-product-arrow">&rarr;</span>
        `;
        card.addEventListener('click', () => loadProduct(p.id));
        grid.appendChild(card);
      });

      body.appendChild(grid);
      header.addEventListener('click', () => {
        header.classList.toggle('open');
        body.classList.toggle('open');
      });
      section.appendChild(header);
      section.appendChild(body);
      checklistProductGrid.appendChild(section);
    });
  } catch (err) {
    checklistProductGrid.innerHTML = `<p class="checklist-error">Failed to load checklists: ${escHtml(err.message)}</p>`;
  }
}

async function loadProduct(productId) {
  checklistProducts.classList.add('hidden');
  checklistBrowser.classList.remove('hidden');
  checklistSets.innerHTML = '<div class="checklist-loading"><div class="spinner"></div><span>Loading...</span></div>';

  try {
    checklistData = await fetchChecklistProduct(productId);
    checklistProductName.textContent = checklistData.name;
    checklistFilter = 'all';
    checklistTeamFilter = '';
    checklistVariantFilters = {};
    checklistSearch.value = '';
    document.querySelectorAll('.checklist-cat-tab').forEach(t => t.classList.toggle('active', t.dataset.cat === 'all'));
    populateTeamFilter();
    renderChecklistSets();
  } catch (err) {
    checklistSets.innerHTML = `<p class="checklist-error">Failed to load: ${escHtml(err.message)}</p>`;
  }
}

function checklistBack() {
  checklistBrowser.classList.add('hidden');
  checklistProducts.classList.remove('hidden');
  checklistData = null;
}

function populateTeamFilter() {
  const select = document.getElementById('checklist-team-filter');
  if (!select || !checklistData) return;
  const teams = new Set();
  (checklistData.sets || []).forEach(s => (s.cards || []).forEach(c => { if (c.team) teams.add(c.team); }));
  const sorted = [...teams].sort();
  select.innerHTML = '<option value="">All Teams</option>' +
    sorted.map(t => `<option value="${escHtml(t)}">${escHtml(t)}</option>`).join('');
  select.value = '';
}

function filterChecklistByTeam(team) {
  checklistTeamFilter = team;
  renderChecklistSets();
}

// Category tabs
checklistCategoryTabs.addEventListener('click', (e) => {
  const tab = e.target.closest('.checklist-cat-tab');
  if (!tab) return;
  checklistFilter = tab.dataset.cat;
  document.querySelectorAll('.checklist-cat-tab').forEach(t => t.classList.toggle('active', t === tab));
  renderChecklistSets();
});

// Search
checklistSearch.addEventListener('input', () => renderChecklistSets());
checklistSearch.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); searchChecklistQuery(); }
});

function renderChecklistSets() {
  if (!checklistData) return;
  const q = checklistSearch.value.toLowerCase().trim();
  checklistSets.innerHTML = '';

  const filteredSets = checklistData.sets.filter(s => {
    if (checklistFilter !== 'all' && s.category !== checklistFilter) return false;
    if (checklistTeamFilter && !s.cards.some(c => c.team === checklistTeamFilter)) return false;
    if (!q) return true;
    // If searching, filter to sets that have matching cards
    return s.cards.some(c =>
      c.player.toLowerCase().includes(q) ||
      c.team.toLowerCase().includes(q) ||
      c.number.toLowerCase().includes(q)
    );
  });

  if (filteredSets.length === 0) {
    checklistSets.innerHTML = '<p class="checklist-empty">No matching cards found.</p>';
    return;
  }

  filteredSets.forEach(set => {
    const setEl = document.createElement('div');
    setEl.className = 'checklist-set';

    // Filter cards by search and team
    let cards = set.cards;
    if (checklistTeamFilter) cards = cards.filter(c => c.team === checklistTeamFilter);
    if (q) {
      cards = cards.filter(c =>
        c.player.toLowerCase().includes(q) ||
        c.team.toLowerCase().includes(q) ||
        c.number.toLowerCase().includes(q)
      );
    }

    const categoryBadge = set.category === 'autograph' ? '<span class="checklist-badge auto">AUTO</span>'
      : set.category === 'memorabilia' ? '<span class="checklist-badge memo">MEMO</span>'
      : set.category === 'insert' ? '<span class="checklist-badge insert">INSERT</span>'
      : '<span class="checklist-badge base">BASE</span>';

    // Parallels summary (clickable to filter)
    const setIdx = checklistData.sets.indexOf(set);
    const activeVariant = checklistVariantFilters[setIdx];
    const parallelsList = set.parallels.map(p => {
      const pr = p.printRun ? ` /${p.printRun}` : '';
      const isActive = activeVariant && activeVariant.name === p.name;
      const nameEsc = escHtml(p.name).replace(/'/g, "\\'");
      const printRunVal = p.printRun || '';
      return `<span class="checklist-parallel ${isActive ? 'checklist-parallel-active' : ''}" onclick="event.stopPropagation(); toggleVariantFilter(${setIdx}, '${nameEsc}', '${printRunVal}')">${escHtml(p.name)}${pr}</span>`;
    }).join('');

    // Detect if this set has per-card print runs
    const hasPrintRuns = cards.some(c => c.printRun);
    const setId = set.id || '';

    setEl.innerHTML = `
      <div class="checklist-set-header" onclick="toggleChecklistSet(this)">
        <div class="checklist-set-title-row">
          ${categoryBadge}
          <h3 class="checklist-set-name">${escHtml(set.name)}</h3>
          <span class="checklist-set-count">${cards.length}${q ? '/' + set.totalCards : ''} cards</span>
          ${activeVariant ? `<span class="checklist-variant-label">${escHtml(activeVariant.name)}${activeVariant.printRun ? ' /' + activeVariant.printRun : ''}</span>` : ''}
          <span class="checklist-set-toggle">&#9660;</span>
        </div>
        <div class="checklist-parallels-row">${parallelsList}</div>
      </div>
      <div class="checklist-set-body">
        <table class="checklist-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Player</th>
              <th>Team</th>
              ${hasPrintRuns || activeVariant?.printRun ? `<th class="cl-pr-header" data-set-id="${escHtml(setId)}" onclick="sortChecklistByPrintRun(this)">Print Run <span class="cl-sort-arrow">&#9660;</span></th>` : ''}
              <th class="cl-val-header">Est. Value</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${cards.map(c => {
              const playerEsc = escHtml(c.player).replace(/'/g, "\\'");
              const year = checklistData.year || '2025';
              const brand = escHtml(checklistData.brand || 'Bowman').replace(/'/g, "\\'");
              const setName = escHtml(set.name).replace(/'/g, "\\'");
              const category = set.category || 'base';
              const cardNum = escHtml(c.number).replace(/'/g, "\\'");
              const printRun = c.printRun ? String(c.printRun) : '';
              const cardNote = c.note ? escHtml(c.note).replace(/'/g, "\\'") : '';
              const variantLabel = activeVariant ? escHtml(activeVariant.name).replace(/'/g, "\\'") : '';
              const variantPR = activeVariant ? (activeVariant.printRun || '') : '';
              const alertVariant = activeVariant ? ` ${activeVariant.name}${activeVariant.printRun ? ' /' + activeVariant.printRun : ''}` : '';
              const alertQuery = `${c.player} ${year} ${checklistData.brand || 'Bowman'} ${set.name}${alertVariant}`.replace(/'/g, "\\'");
              // Show the variant's print run in the table when a variant filter is active
              const displayPR = activeVariant && activeVariant.printRun ? activeVariant.printRun : printRun;
              return `
              <tr data-print-run="${c.printRun || ''}" data-card-num="${c.number}">
                <td class="cl-num">${escHtml(c.number)}</td>
                <td class="cl-player"><a href="#" class="cl-player-link" onclick="event.preventDefault(); togglePlayerListings(this, '${playerEsc}', '${year}', '${brand}', '${setName}', '${category}', '${cardNum}', '${variantPR || printRun}')">${escHtml(c.player)}</a></td>
                <td class="cl-team">${escHtml(c.team)}</td>
                ${hasPrintRuns || activeVariant?.printRun ? `<td class="cl-printrun ${displayPR && parseInt(displayPR) <= 25 ? 'cl-pr-rare' : displayPR && parseInt(displayPR) <= 99 ? 'cl-pr-low' : ''}">${displayPR ? '/' + displayPR : ''}</td>` : ''}
                <td class="cl-value" data-cl-player="${escHtml(c.player)}" data-cl-year="${year}" data-cl-brand="${brand}" data-cl-setname="${escHtml(set.name)}" data-cl-variant="${variantLabel}" data-cl-print-run="${displayPR}"><span class="cl-val-loading">·</span></td>
                <td class="cl-action">
                  <button class="cl-coll-btn" onclick="event.stopPropagation(); addToCollectionFromChecklist('${playerEsc}', '${year}', '${brand}', '${setName}', '${variantLabel}', '${variantPR || printRun}', '${cardNum}', '${escHtml(c.team).replace(/'/g, "\\'")}', '${category}'); this.textContent='&#10003;'; this.classList.add('cl-coll-added')" title="Add to collection">+</button>
                  <button class="cl-alert-btn" onclick="event.stopPropagation(); addAlertForCard('${alertQuery}')" title="Track this card (Pro)">&#128276;</button>
                  <button class="cl-search-btn" onclick="searchFromChecklist('${playerEsc}', '${year}', '${brand}', '${setName}${variantLabel ? ' ' + variantLabel : ''}', '${category}')" title="Search eBay">&#128269;</button>
                </td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    `;

    checklistSets.appendChild(setEl);
  });
}

// ---- Checklist Value Estimation ----
const checklistValueCache = new Map();   // query → {value, confidence, count, ts}
const checklistSetPriceData = new Map(); // setKey → [{printRun, price}] for cross-parallel interpolation
const CL_CACHE_TTL = 30 * 60 * 1000;
let clValueQueue = [];
let clQueueRunning = false;

function toggleChecklistSet(header) {
  const setEl = header.parentElement;
  setEl.classList.toggle('expanded');
  if (setEl.classList.contains('expanded')) loadChecklistSetValues(setEl);
}

function loadChecklistSetValues(setEl) {
  setEl.querySelectorAll('.cl-value[data-cl-player]').forEach(cell => {
    if (cell.dataset.loaded) return;
    cell.dataset.loaded = '1';
    const { clPlayer, clYear, clBrand, clSetname, clVariant, clPrintRun } = cell.dataset;
    const query = [clPlayer, clYear, clBrand, clSetname, clVariant].filter(Boolean).join(' ');
    const setKey = `${clPlayer}|${clYear}|${clBrand}|${clSetname}`;
    enqueueClValue(query, cell, setKey, clPrintRun ? parseInt(clPrintRun) : null);
  });
}

function enqueueClValue(query, cell, setKey, printRun) {
  clValueQueue.push(async () => {
    const cached = checklistValueCache.get(query);
    if (cached && Date.now() - cached.ts < CL_CACHE_TTL) {
      applyClValue(cell, cached, setKey, printRun);
      return;
    }
    try {
      const res = await fetch(`/api/search?${new URLSearchParams({ q: query, limit: '10', mode: 'sold' })}`);
      if (!res.ok) { applyClValue(cell, null, setKey, printRun); return; }
      const data = await res.json();
      const prices = (data.results || []).map(r => parseFloat(r.price)).filter(p => p > 0);
      if (prices.length) {
        const value = clMedian(prices);
        const result = { value, confidence: 'high', count: prices.length, ts: Date.now() };
        checklistValueCache.set(query, result);
        if (printRun) {
          const arr = checklistSetPriceData.get(setKey) || [];
          if (!arr.find(d => d.printRun === printRun)) arr.push({ printRun, price: value });
          checklistSetPriceData.set(setKey, arr);
        }
        applyClValue(cell, result, setKey, printRun);
      } else {
        checklistValueCache.set(query, { value: null, ts: Date.now() });
        applyClValue(cell, null, setKey, printRun);
      }
    } catch { applyClValue(cell, null, setKey, printRun); }
  });
  runClQueue();
}

async function runClQueue() {
  if (clQueueRunning) return;
  clQueueRunning = true;
  while (clValueQueue.length) {
    await clValueQueue.shift()();
    await new Promise(r => setTimeout(r, 450));
  }
  clQueueRunning = false;
}

function clMedian(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function applyClValue(cell, result, setKey, printRun) {
  if (!cell.isConnected) return;
  if (result?.value) {
    const cls = result.confidence === 'high' ? 'cl-val-real' : result.confidence === 'medium' ? 'cl-val-est' : 'cl-val-low';
    cell.innerHTML = `<span class="cl-value-amt ${cls}" title="${result.count || ''} sales">$${result.value.toFixed(2)}</span>`;
    return;
  }
  if (printRun) {
    const known = checklistSetPriceData.get(setKey) || [];
    const est = estimateByPrintRun(printRun, known);
    if (est) {
      const cls = est.confidence === 'medium' ? 'cl-val-est' : 'cl-val-low';
      const tip = `Estimated from ${known.length} related parallel${known.length !== 1 ? 's' : ''}`;
      cell.innerHTML = `<span class="cl-value-amt ${cls}" title="${tip}">~$${est.value.toFixed(2)}</span>`;
      return;
    }
  }
  cell.innerHTML = `<span class="cl-val-na">—</span>`;
}

// Log-linear regression on print run vs price (log-log space).
// α ≈ 0.65 reflects empirical sports-card scarcity premium (scarcer prints
// command a premium that scales as a power law, not linearly).
function estimateByPrintRun(targetPR, known) {
  const valid = known.filter(d => d.printRun > 0 && d.price > 0 && d.printRun !== targetPR);
  if (!valid.length) return null;
  if (valid.length === 1) {
    const { printRun: bPR, price: bPrice } = valid[0];
    return { value: bPrice * Math.pow(bPR / targetPR, 0.65), confidence: 'low' };
  }
  const xs = valid.map(d => Math.log(d.printRun));
  const ys = valid.map(d => Math.log(d.price));
  const n = valid.length, xm = xs.reduce((a, b) => a + b) / n, ym = ys.reduce((a, b) => a + b) / n;
  const slope = xs.reduce((s, x, i) => s + (x - xm) * (ys[i] - ym), 0) / xs.reduce((s, x) => s + (x - xm) ** 2, 0);
  return { value: Math.exp(slope * Math.log(targetPR) + (ym - slope * xm)), confidence: 'medium' };
}

// Toggle variant/parallel filter for a set
function toggleVariantFilter(setIdx, variantName, printRun) {
  const current = checklistVariantFilters[setIdx];
  if (current && current.name === variantName) {
    // Clicking the same variant again clears the filter
    delete checklistVariantFilters[setIdx];
  } else {
    checklistVariantFilters[setIdx] = { name: variantName, printRun: printRun || '' };
  }
  renderChecklistSets();
}

// Sort checklist table by print run
function sortChecklistByPrintRun(thEl) {
  const table = thEl.closest('table');
  const tbody = table.querySelector('tbody');
  const rows = Array.from(tbody.querySelectorAll('tr'));
  const arrow = thEl.querySelector('.cl-sort-arrow');

  // Toggle sort direction
  const currentDir = thEl.dataset.sortDir || 'none';
  let newDir;
  if (currentDir === 'none' || currentDir === 'desc') {
    newDir = 'asc'; // Low print run first (most rare)
  } else {
    newDir = 'desc'; // High print run first
  }
  thEl.dataset.sortDir = newDir;
  arrow.innerHTML = newDir === 'asc' ? '&#9650;' : '&#9660;';
  arrow.classList.add('cl-sort-active');

  rows.sort((a, b) => {
    const prA = parseInt(a.dataset.printRun) || 99999;
    const prB = parseInt(b.dataset.printRun) || 99999;
    if (newDir === 'asc') return prA - prB;
    return prB - prA;
  });

  rows.forEach(r => tbody.appendChild(r));
}

// Search eBay using whatever is typed in the checklist search bar
function searchChecklistQuery() {
  const q = checklistSearch.value.trim();
  if (!q || q.length < 2) return;
  // Prepend year + brand for context if not already present
  const year = checklistData?.year || '2025';
  const brand = checklistData?.brand || '';
  const hasYear = /\b20\d{2}\b/.test(q);
  const query = hasYear ? q : `${year} ${brand} ${q}`.trim();
  input.value = query;
  switchView('search');
  addRecentSearch(query);
  fetchDirectSearch(query);
}

function searchFromChecklist(player, year, brand, setName, category) {
  const query = buildChecklistQuery(player, year, brand, setName, category);
  input.value = query;
  switchView('search');
  addRecentSearch(query);
  fetchDirectSearch(query);
}

function buildChecklistQuery(player, year, brand, setName, category, printRun) {
  // For base/base-variant sets, just use year + brand + player
  if (!category || category === 'base') {
    // If card has individual print run (Season Stat Line, Jersey Number), include it
    if (printRun) {
      return `${year} ${brand} ${player} /${printRun}`;
    }
    return `${year} ${brand} ${player}`;
  }
  // For autographs, memorabilia, inserts — include the set name for specificity
  // Clean up set name: remove redundant brand name, "Checklist" etc.
  let setLabel = setName || '';
  setLabel = setLabel.replace(/Checklist/gi, '').trim();
  let q = `${year} ${brand} ${setLabel} ${player}`;
  if (printRun) {
    q += ` /${printRun}`;
  }
  return q;
}

// ---- Inline Player Listings in Checklist ----
let activePlayerPanel = null;

function togglePlayerListings(linkEl, player, year, brand, setName, category, cardNum, printRun) {
  const row = linkEl.closest('tr');
  const existingPanel = row.nextElementSibling;

  // If already open for this player, close it
  if (existingPanel && existingPanel.classList.contains('cl-listings-row')) {
    existingPanel.remove();
    linkEl.classList.remove('cl-player-active');
    if (activePlayerPanel === existingPanel) activePlayerPanel = null;
    return;
  }

  // Close any other open panel
  if (activePlayerPanel) {
    const prevLink = activePlayerPanel.previousElementSibling?.querySelector('.cl-player-active');
    if (prevLink) prevLink.classList.remove('cl-player-active');
    activePlayerPanel.remove();
    activePlayerPanel = null;
  }

  linkEl.classList.add('cl-player-active');

  // Create the expandable row
  const panelRow = document.createElement('tr');
  panelRow.className = 'cl-listings-row';
  const td = document.createElement('td');
  // Span all columns: #, Player, Team, (Print Run if present), Action
  const headerCols = row.closest('table').querySelectorAll('thead th').length;
  td.colSpan = headerCols;
  td.className = 'cl-listings-cell';

  const query = buildChecklistQuery(player, year, brand, setName, category, printRun);
  const subtitle = (setName && category !== 'base') ? setName : (printRun ? setName : '');
  const printRunLabel = printRun ? ` /${printRun}` : '';

  const subtitleHtml = subtitle ? `<span class="cl-listings-subtitle">${escHtml(subtitle)}${printRunLabel ? ' <span class="cl-listings-printrun">' + escHtml(printRunLabel) + '</span>' : ''}</span>` : '';
  td.innerHTML = `
    <div class="cl-listings-panel">
      <div class="cl-listings-header">
        <div class="cl-listings-title-group">
          <h4 class="cl-listings-title">${escHtml(player)}</h4>
          ${subtitleHtml}
        </div>
        <div class="cl-listings-tabs">
          <button class="cl-listings-tab active" data-lmode="forsale">For Sale</button>
          <button class="cl-listings-tab" data-lmode="sold">Sold</button>
        </div>
        <button class="cl-listings-close" title="Close">&times;</button>
      </div>
      <div class="cl-listings-body">
        <div class="cl-listings-loading"><div class="spinner"></div><span>Searching eBay...</span></div>
      </div>
    </div>
  `;

  panelRow.appendChild(td);
  row.after(panelRow);
  activePlayerPanel = panelRow;

  // Tab switching
  const tabs = td.querySelectorAll('.cl-listings-tab');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      fetchPlayerListings(td, query, tab.dataset.lmode);
    });
  });

  // Close button
  td.querySelector('.cl-listings-close').addEventListener('click', () => {
    linkEl.classList.remove('cl-player-active');
    panelRow.remove();
    if (activePlayerPanel === panelRow) activePlayerPanel = null;
  });

  // Fetch for-sale by default
  fetchPlayerListings(td, query, 'forsale');
}

// Generate reasoning text from listing results
function generateListingReasoning(results, isSold, serial) {
  const prices = results.map(r => parseFloat(r.price)).filter(p => !isNaN(p));
  if (prices.length === 0) return '';

  const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
  const low = Math.min(...prices);
  const high = Math.max(...prices);
  const spread = high - low;
  const spreadPct = avg > 0 ? ((spread / avg) * 100) : 0;

  const lines = [];

  // Price range insight
  if (prices.length >= 2) {
    if (spreadPct < 20) {
      lines.push(`Tight pricing — most listings clustered around $${avg.toFixed(2)}.`);
    } else if (spreadPct < 50) {
      lines.push(`Moderate spread ($${low.toFixed(2)}–$${high.toFixed(2)}).`);
    } else {
      lines.push(`Wide price range ($${low.toFixed(2)}–$${high.toFixed(2)}) — condition or variant differences likely.`);
    }
  }

  // Market activity
  if (isSold) {
    if (results.length >= 8) {
      lines.push('Active market with strong recent sales volume.');
    } else if (results.length >= 3) {
      lines.push('Moderate sales activity.');
    } else {
      lines.push('Limited recent sales — harder to pin down value.');
    }
  } else {
    if (results.length >= 10) {
      lines.push('Plenty of supply available — buyers have options.');
    } else if (results.length <= 2) {
      lines.push('Very low supply — could command a premium.');
    }
  }

  // Print run context
  if (serial) {
    const pr = parseInt(serial, 10);
    if (pr <= 10) {
      lines.push(`Numbered /${pr} — extremely limited, expect premium pricing.`);
    } else if (pr <= 25) {
      lines.push(`Numbered /${pr} — low print run, scarce card.`);
    } else if (pr <= 99) {
      lines.push(`Numbered /${pr} — short print parallel.`);
    } else if (pr <= 199) {
      lines.push(`Numbered /${pr} — mid-tier numbered parallel.`);
    }
  }

  // Value call
  if (isSold && prices.length >= 3) {
    const median = [...prices].sort((a, b) => a - b)[Math.floor(prices.length / 2)];
    lines.push(`Fair market value is around $${median.toFixed(2)} (median sale).`);
  } else if (!isSold && prices.length >= 2) {
    lines.push(`Best available price is $${low.toFixed(2)}.`);
  }

  return lines.join(' ');
}

// Build a single listing card for checklist inline results
function buildClListingCard(item, mode) {
  const price = item.price ? `$${parseFloat(item.price).toFixed(2)}` : 'N/A';
  const dateStr = item.soldDate
    ? new Date(item.soldDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : '';
  const isSold = mode === 'sold';
  const badge = isSold
    ? '<span class="cl-item-badge sold">SOLD</span>'
    : '<span class="cl-item-badge forsale">FOR SALE</span>';
  const buyOptBadge = isSold ? '' : buyingOptionBadgeHtml(item);
  const imgHtml = item.imageUrl
    ? `<img src="${escHtml(item.imageUrl)}" alt="" loading="lazy" />`
    : `<div class="cl-item-noimg">&#127944;</div>`;
  return `
    <a class="cl-listing-item" href="${escHtml(epnUrl(item.itemUrl))}" target="_blank" rel="noopener noreferrer">
      <div class="cl-item-img">${imgHtml}</div>
      <div class="cl-item-info">
        <span class="cl-item-price">${price}</span>
        ${badge}
        ${buyOptBadge}
        ${dateStr ? `<span class="cl-item-date">${dateStr}</span>` : ''}
      </div>
    </a>
  `;
}

// ---- Global Account Sync ----
// Mirrors the per-user portfolio/watchlist/etc. blobs into KV via
// /api/user/data so accounts are portable across devices. The data still
// lives in localStorage as the source of truth on each device — sync just
// pushes changes up (debounced) and pulls on login. Anonymous users are
// untouched: with no session token, every helper here exits silently.
const USER_SYNC_KEYS = [
  'cardHuddleCollection',
  'cardHuddleWatchlist',
  'cardHuddleCompletion',
  'cardHuddleSellerListings',
  'cardHuddlePromotedCards',
  'cardHuddleShowcase',
  'cardHuddleShowcaseSettings',
  'cardHuddleCharacter',
  'cardHuddleBoothLayout',
  'cardHuddlePortfolioHistory',
];
const USER_SYNC_DEBOUNCE_MS = 800;
let _userSyncEnabled = false;     // gates push so the initial pull doesn't echo back
let _userSyncTimer = null;
let _userSyncing = false;

function _userSyncPayload() {
  const data = {};
  for (const key of USER_SYNC_KEYS) {
    const raw = localStorage.getItem(key);
    if (raw == null) continue;
    try { data[key] = JSON.parse(raw); }
    catch (_) { /* skip malformed */ }
  }
  return data;
}

function _userSyncApply(data) {
  if (!data || typeof data !== 'object') return;
  for (const key of USER_SYNC_KEYS) {
    if (Object.prototype.hasOwnProperty.call(data, key)) {
      localStorage.setItem(key, JSON.stringify(data[key]));
    }
  }
}

function _userSyncHasContent(data) {
  if (!data || typeof data !== 'object') return false;
  for (const key of USER_SYNC_KEYS) {
    const v = data[key];
    if (Array.isArray(v)) { if (v.length > 0) return true; }
    else if (v && typeof v === 'object') { if (Object.keys(v).length > 0) return true; }
    else if (v) return true;
  }
  return false;
}

async function pushUserDataNow() {
  if (_userSyncing) return;
  const token = (typeof getSessionToken === 'function') ? getSessionToken() : null;
  if (!token) return;
  _userSyncing = true;
  try {
    await fetch('/api/user/data', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ data: _userSyncPayload() }),
    });
  } catch (err) {
    console.warn('[sync] push failed:', err && err.message);
  } finally {
    _userSyncing = false;
  }
}

// Save-paths call this on every mutation. Coalesces a burst of writes
// (e.g. bulk-toggling 30 checkboxes in Set Completion) into one PUT.
function schedulePushUserData() {
  if (!_userSyncEnabled) return;
  if (_userSyncTimer) clearTimeout(_userSyncTimer);
  _userSyncTimer = setTimeout(() => { _userSyncTimer = null; pushUserDataNow(); }, USER_SYNC_DEBOUNCE_MS);
}

function _userSyncRerender() {
  // Re-render anything that reads from the synced keys, so a fresh device
  // immediately shows the pulled-down data instead of stale empty state.
  try { if (typeof renderPortfolio === 'function') renderPortfolio(); } catch (_) {}
  try { if (typeof renderWatchlist === 'function') renderWatchlist(); } catch (_) {}
  try { if (typeof renderMyListings === 'function') renderMyListings(); } catch (_) {}
  try { if (typeof renderPromotedCards === 'function') renderPromotedCards(); } catch (_) {}
  try { if (typeof refreshRainbowPageFromSync === 'function') refreshRainbowPageFromSync(); } catch (_) {}
}

async function enableUserSync() {
  const token = (typeof getSessionToken === 'function') ? getSessionToken() : null;
  if (!token) return;
  _userSyncEnabled = false; // hold ongoing push off until pull resolves
  try {
    const res = await fetch('/api/user/data', { headers: { Authorization: `Bearer ${token}` } });
    if (res.ok) {
      const result = await res.json();
      const server = result && result.data;
      if (_userSyncHasContent(server)) {
        // Server wins on a device with no local data, or whenever the server
        // already has something for this account. Last-write-wins per key.
        _userSyncApply(server);
        _userSyncRerender();
      } else if (_userSyncHasContent(_userSyncPayload())) {
        // Fresh account on the server but the user already has local data
        // (e.g. logged in for the first time after using anon on this device).
        // Push it up so they don't lose it switching devices.
        _userSyncEnabled = true;
        await pushUserDataNow();
        return;
      }
    }
  } catch (err) {
    console.warn('[sync] pull failed:', err && err.message);
  } finally {
    _userSyncEnabled = true;
  }
}

function disableUserSync() {
  _userSyncEnabled = false;
  if (_userSyncTimer) { clearTimeout(_userSyncTimer); _userSyncTimer = null; }
}

// ---- Collection & Portfolio (localStorage) ----
function getCollection() {
  try { return JSON.parse(localStorage.getItem('cardHuddleCollection') || '[]'); }
  catch { return []; }
}
function saveCollection(coll) {
  localStorage.setItem('cardHuddleCollection', JSON.stringify(coll));
  schedulePushUserData();
}

function initCollectionView() {
  const gate = document.getElementById('collection-gate');
  const content = document.getElementById('collection-content');
  if (gate) gate.classList.add('hidden');
  if (content) content.classList.remove('hidden');
  renderPortfolio();
}

function switchCollectionTab(tab) {
  document.querySelectorAll('.coll-tab').forEach(t => t.classList.toggle('active', t.dataset.coll === tab));
  document.querySelectorAll('.coll-panel').forEach(p => p.classList.add('hidden'));

  // The Tracked Cards UI still lives in its standalone #tracked-view
  // div for layout reasons; from the user's perspective it's a tab
  // inside My Cards, so swap which top-level container is visible.
  if (tab === 'tracked') {
    collectionView.classList.add('hidden');
    trackedView.classList.remove('hidden');
    initTrackedView();
    return;
  }
  // Anything else means we're back inside the collection container.
  trackedView.classList.add('hidden');
  collectionView.classList.remove('hidden');
  const panel = document.getElementById(`coll-${tab}`);
  if (panel) panel.classList.remove('hidden');
  if (tab === 'portfolio') renderPortfolio();
  if (tab === 'watchlist') renderWatchlist();
}

function switchChecklistSubtab(tab) {
  document.querySelectorAll('.checklist-subtab').forEach(b => b.classList.toggle('active', b.dataset.cltab === tab));
  document.getElementById('checklist-pane-browse').classList.toggle('hidden', tab !== 'browse');
  document.getElementById('checklist-pane-completion').classList.toggle('hidden', tab !== 'completion');
  if (tab === 'completion') loadCompletionProducts();
}

function renderPortfolio() {
  const coll = getCollection();
  document.getElementById('portfolio-total-cards').textContent = coll.length;
  const totalCost = coll.reduce((s, c) => s + (c.purchasePrice || 0), 0);
  const totalValue = coll.reduce((s, c) => s + (c.estValue || c.purchasePrice || 0), 0);
  const gainLoss = totalValue - totalCost;
  document.getElementById('portfolio-total-cost').textContent = `$${totalCost.toFixed(2)}`;
  document.getElementById('portfolio-total-value').textContent = `$${totalValue.toFixed(2)}`;
  const glEl = document.getElementById('portfolio-gain-loss');
  glEl.textContent = `${gainLoss >= 0 ? '+' : ''}$${gainLoss.toFixed(2)}`;
  glEl.className = `portfolio-stat-value ${gainLoss >= 0 ? 'gain' : 'loss'}`;
  const roiEl = document.getElementById('portfolio-roi');
  if (roiEl) {
    if (totalCost > 0) {
      const roi = ((totalValue - totalCost) / totalCost) * 100;
      roiEl.textContent = `${roi >= 0 ? '+' : ''}${roi.toFixed(1)}%`;
      roiEl.className = `portfolio-stat-value ${roi >= 0 ? 'gain' : 'loss'}`;
    } else {
      roiEl.textContent = '—';
      roiEl.className = 'portfolio-stat-value';
    }
  }

  // Log today's value for the Pro value-over-time chart, then render analytics.
  if (totalValue > 0) recordPortfolioSnapshot(totalValue);
  renderPortfolioAnalytics(coll, totalValue);

  const listEl = document.getElementById('portfolio-list');
  if (coll.length === 0) {
    listEl.innerHTML = `<div class="pf-empty">
      <div class="pf-empty-icon">&#127183;</div>
      <h3>No cards yet</h3>
      <p>Add a card to get started — then hit <strong>Refresh Values</strong> to pull live sold prices.</p>
      <div class="pf-empty-steps">
        <span><strong>1.</strong> Add by Photo, Checklist, or Manual</span>
        <span><strong>2.</strong> Refresh Values for live sold prices</span>
        <span><strong>3.</strong> Tap any value to see the comps used</span>
      </div>
    </div>`;
    return;
  }

  // Valuation summary — how many cards are valued from live comps + freshness.
  const valuedCount = coll.filter(c => (c.comps && c.comps.length) || c.isEstimate).length;
  const lastValued = coll.map(c => c.valuedAt).filter(Boolean).sort().pop();
  const windowLabel = _compsUseAllTime() ? 'all-time comps' : 'last 2 months (free)';
  let html = `<div class="portfolio-valued-summary">${valuedCount} of ${coll.length} card${coll.length !== 1 ? 's' : ''} valued from ${windowLabel}${lastValued ? ` &middot; updated ${timeAgo(lastValued)}` : ''} &middot; <span class="pf-summary-hint">tap any market value to see the comps used</span></div>`;

  // One unified card layout for every entry (checklist, photo, manual), newest
  // first. Each card: identity + tags, Paid / Market (click for comps) / Gain,
  // plus a per-card refresh and remove.
  const entries = coll.map((c, i) => ({ c, i })).reverse();
  html += '<div class="pf-cards">' + entries.map(({ c, i }) => _pfCardHtml(c, i)).join('') + '</div>';

  listEl.innerHTML = html;
}

// ---- Collection Analytics (Pro) ----
// Value-over-time history: one snapshot per day in localStorage, synced across
// devices via USER_SYNC_KEYS. Cheap to keep (≤365 points).
function getPortfolioHistory() {
  try { return JSON.parse(localStorage.getItem('cardHuddlePortfolioHistory') || '[]'); }
  catch { return []; }
}
function recordPortfolioSnapshot(totalValue) {
  if (!(totalValue > 0)) return;
  const today = new Date().toISOString().slice(0, 10);
  let hist = getPortfolioHistory();
  const last = hist[hist.length - 1];
  const rounded = Math.round(totalValue * 100) / 100;
  let newDay = false;
  if (last && last.d === today) {
    last.v = rounded;            // keep today's value current
  } else {
    hist.push({ d: today, v: rounded });
    newDay = true;
  }
  if (hist.length > 365) hist = hist.slice(-365);
  try { localStorage.setItem('cardHuddlePortfolioHistory', JSON.stringify(hist)); } catch {}
  // Only push to the server when a new day is logged, to avoid chatty syncs on
  // every render. Same-day value updates ride along on the next natural push.
  if (newDay) schedulePushUserData();
}

let _pfChart = null;
function renderPortfolioAnalytics(coll, totalValue) {
  const el = document.getElementById('portfolio-analytics');
  if (!el) return;
  if (!coll || coll.length === 0) { el.innerHTML = ''; return; }

  // Biggest movers (need both a paid price and a market value to compute).
  const movers = coll
    .filter(c => (c.purchasePrice || 0) > 0 && (c.estValue || 0) > 0)
    .map(c => {
      const gl = (c.estValue || 0) - (c.purchasePrice || 0);
      return { c, gl, pct: (gl / (c.purchasePrice || 1)) * 100 };
    })
    .sort((a, b) => b.gl - a.gl);
  const gainers = movers.filter(m => m.gl > 0).slice(0, 3);
  const losers = movers.filter(m => m.gl < 0).slice(-3).reverse();

  const moverRow = (m) => {
    const name = escHtml(m.c.player || m.c.name || 'Card');
    const cls = m.gl >= 0 ? 'gain' : 'loss';
    return `<div class="pf-mover"><span class="pf-mover-name">${name}</span>`
      + `<span class="pf-mover-val ${cls}">${m.gl >= 0 ? '+' : ''}$${m.gl.toFixed(2)} (${m.pct >= 0 ? '+' : ''}${m.pct.toFixed(0)}%)</span></div>`;
  };

  const hist = getPortfolioHistory();
  el.innerHTML = `
    <div class="pf-analytics">
      <div class="pf-an-head"><h4>&#128202; Collection Analytics</h4></div>
      <div class="pf-an-chart-wrap">
        ${hist.length >= 2
          ? '<canvas id="pf-value-chart" height="130"></canvas>'
          : '<p class="pf-an-empty">Your value-over-time chart builds as you refresh values day to day — check back tomorrow.</p>'}
      </div>
      <div class="pf-an-movers">
        <div class="pf-an-col"><h5>Top Gainers</h5>${gainers.length ? gainers.map(moverRow).join('') : '<p class="pf-an-empty">Add what you paid + refresh values to see movers.</p>'}</div>
        <div class="pf-an-col"><h5>Top Losers</h5>${losers.length ? losers.map(moverRow).join('') : '<p class="pf-an-empty">No losers right now.</p>'}</div>
      </div>
    </div>`;

  if (hist.length >= 2 && typeof Chart !== 'undefined') {
    const ctx = document.getElementById('pf-value-chart');
    if (ctx) {
      if (_pfChart) { try { _pfChart.destroy(); } catch {} }
      _pfChart = new Chart(ctx, {
        type: 'line',
        data: {
          labels: hist.map(h => h.d.slice(5)),
          datasets: [{ data: hist.map(h => h.v), borderColor: '#5ece99', backgroundColor: 'rgba(94,206,153,0.12)', fill: true, tension: 0.25, pointRadius: 0, borderWidth: 2 }],
        },
        options: {
          plugins: { legend: { display: false } },
          scales: { x: { display: false }, y: { ticks: { callback: (v) => '$' + v } } },
          maintainAspectRatio: false,
        },
      });
    }
  }
}

const _PF_CATEGORY_BADGE = {
  autograph: '<span class="checklist-badge auto">AUTO</span>',
  memorabilia: '<span class="checklist-badge memo">MEMO</span>',
  insert: '<span class="checklist-badge insert">INSERT</span>',
  base: '<span class="checklist-badge base">BASE</span>',
};

// Build one portfolio card tile. `idx` is the real collection index.
function _pfCardHtml(c, idx) {
  const paid = c.purchasePrice || 0;
  const mkt = c.estValue || 0;
  const gl = mkt - paid;
  const roi = paid > 0 ? ((mkt - paid) / paid) * 100 : null;
  const glClass = gl >= 0 ? 'gain' : 'loss';

  const title = c.player ? escHtml(c.player) : escHtml(c.name || 'Card');
  const subParts = c.player
    ? [c.year, c.brand, c.setName].filter(Boolean).map(escHtml)
    : [];
  const sub = subParts.join(' ');

  const tags = [];
  if (c.player && c.category && _PF_CATEGORY_BADGE[c.category]) tags.push(_PF_CATEGORY_BADGE[c.category]);
  if (c.scanned) tags.push('<span class="portfolio-scanned-tag">&#128247; Scanned</span>');
  if (c.cardNumber) tags.push(`<span class="pf-tag pf-tag-num">#${escHtml(c.cardNumber)}</span>`);
  if (c.parallel) tags.push(`<span class="portfolio-parallel-tag">${escHtml(c.parallel)}</span>`);
  if (c.printRun) tags.push(`<span class="cl-printrun-inline ${parseInt(c.printRun) <= 25 ? 'cl-pr-rare' : parseInt(c.printRun) <= 99 ? 'cl-pr-low' : ''}">/${escHtml(c.printRun)}</span>`);
  if (c.condition) tags.push(`<span class="portfolio-cond-tag">${escHtml(c.condition)}</span>`);
  if (c.team) tags.push(`<span class="pf-tag pf-tag-team">${escHtml(c.team)}</span>`);

  const mktInner = mkt > 0
    ? `<span class="pf-money-val">${c.isEstimate ? '~' : ''}$${mkt.toFixed(2)}</span>${_cardValueMetaInline(c)}`
    : '<span class="pf-money-val pf-value-link">Value &rsaquo;</span>';

  return `<div class="pf-card">
    <div class="pf-card-main">
      <div class="pf-card-title">${title}</div>
      ${sub ? `<div class="pf-card-sub">${sub}</div>` : ''}
      ${tags.length ? `<div class="pf-card-tags">${tags.join('')}</div>` : ''}
    </div>
    <div class="pf-card-money">
      <div class="pf-money-col">
        <span class="pf-money-label">Paid</span>
        <span class="pf-money-val pf-money-muted">$${paid.toFixed(2)}</span>
      </div>
      <div class="pf-money-col pf-money-mkt" onclick="openCardComps(${idx})" title="View the comps used">
        <span class="pf-money-label">Market &rsaquo;</span>
        ${mktInner}
      </div>
      <div class="pf-money-col">
        <span class="pf-money-label">Gain</span>
        <span class="pf-money-val ${mkt > 0 ? glClass : 'pf-money-muted'}">${mkt > 0 ? `${gl >= 0 ? '+' : ''}$${gl.toFixed(2)}` : '—'}${roi !== null && mkt > 0 ? ` <span class="pf-roi ${glClass}">${roi >= 0 ? '+' : ''}${roi.toFixed(0)}%</span>` : ''}</span>
      </div>
    </div>
    <div class="pf-card-actions">
      <button class="pf-icon-btn pf-refresh-btn" onclick="refreshSingleCard(${idx}, this)" title="Refresh this card's value" ${c.locked ? 'disabled' : ''}>&#8635;</button>
      <button class="pf-icon-btn pf-edit-btn" onclick="openEditCard(${idx})" title="Edit card">&#9998;</button>
      <button class="pf-icon-btn pf-remove-btn" onclick="removeFromCollection(${idx})" title="Remove">&times;</button>
    </div>
  </div>`;
}

// ---- Edit a saved collection card ----
let _editCardIdx = null;

function openEditCard(idx) {
  const coll = getCollection();
  const c = coll[idx];
  if (!c) return;
  _editCardIdx = idx;
  const structured = !!c.player;
  const v = s => escHtml(s == null ? '' : String(s));
  const body = document.getElementById('edit-card-body');
  body.innerHTML = `
    <form id="edit-card-form" onsubmit="return saveEditCard(event)">
      ${structured ? '' : `<label class="ec-label ec-wide">Card name<input id="ec-name" value="${v(c.name)}" placeholder="e.g. Patrick Mahomes 2017 Prizm Silver" /></label>`}
      <div class="ec-grid">
        <label class="ec-label">Player<input id="ec-player" value="${v(c.player)}" placeholder="${structured ? '' : 'optional'}" /></label>
        <label class="ec-label">Year<input id="ec-year" value="${v(c.year)}" /></label>
        <label class="ec-label">Brand / Product<input id="ec-brand" value="${v(c.brand)}" placeholder="e.g. Panini Prizm" /></label>
        <label class="ec-label">Set<input id="ec-set" value="${v(c.setName)}" /></label>
        <label class="ec-label">Parallel<input id="ec-parallel" value="${v(c.parallel)}" /></label>
        <label class="ec-label">Print run /<input id="ec-printrun" value="${v(c.printRun)}" inputmode="numeric" placeholder="e.g. 25" /></label>
        <label class="ec-label">Card #<input id="ec-cardnum" value="${v(c.cardNumber)}" /></label>
        <label class="ec-label">Condition / Grade<input id="ec-cond" value="${v(c.condition)}" placeholder="PSA 10, Raw" /></label>
        <label class="ec-label">Paid $<input id="ec-paid" type="number" step="0.01" min="0" value="${c.purchasePrice != null ? c.purchasePrice : ''}" /></label>
      </div>
      <label class="ec-label ec-wide">Notes<input id="ec-notes" value="${v(c.notes)}" /></label>
      <label class="ec-check"><input type="checkbox" id="ec-revalue" checked /> Re-price from sold comps after saving</label>
      <button type="submit" class="pp-btn">Save changes</button>
    </form>`;
  document.getElementById('edit-card-modal').classList.remove('hidden');
}

function closeEditCard() {
  document.getElementById('edit-card-modal').classList.add('hidden');
  _editCardIdx = null;
}

function saveEditCard(e) {
  e.preventDefault();
  const idx = _editCardIdx;
  const coll = getCollection();
  const c = coll[idx];
  if (!c) { closeEditCard(); return false; }
  const val = id => { const el = document.getElementById(id); return el ? el.value.trim() : ''; };

  const player = val('ec-player');
  if (player) {
    c.player = player;
    c.year = val('ec-year');
    c.brand = val('ec-brand');
    c.setName = val('ec-set');
    c.parallel = val('ec-parallel');
    c.cardNumber = val('ec-cardnum');
    c.printRun = val('ec-printrun').replace(/[^\d]/g, '');
    delete c.name; // now identified structurally
  } else {
    // Manual card: keep it a free-text name.
    const nameEl = document.getElementById('ec-name');
    c.name = nameEl ? nameEl.value.trim() : (c.name || '');
  }
  c.condition = val('ec-cond');
  c.purchasePrice = parseFloat(val('ec-paid')) || 0;
  c.notes = val('ec-notes');

  const revalue = document.getElementById('ec-revalue')?.checked;
  if (revalue) {
    // Identity may have changed — drop stale comps/estimate so the value
    // reflects the edited card, then re-price.
    c.comps = [];
    c.estimate = null;
    c.isEstimate = false;
    c.excludedComps = [];
  }
  saveCollection(coll);
  closeEditCard();
  renderPortfolio();
  if (revalue && buildCardSoldQuery(c)) setTimeout(() => valueCardAt(idx, { silent: true }), 50);
  return false;
}

function showAddCardModal() {
  document.getElementById('add-card-modal').classList.remove('hidden');
}
function closeAddCardModal() {
  document.getElementById('add-card-modal').classList.add('hidden');
  _pendingScannedSoldValue = null;
}

function handleAddCard(e) {
  e.preventDefault();
  const name = document.getElementById('add-card-name').value.trim();
  const price = parseFloat(document.getElementById('add-card-price').value) || 0;
  const condition = document.getElementById('add-card-condition').value.trim();
  const notes = document.getElementById('add-card-notes').value.trim();
  if (!name) return false;

  const coll = getCollection();
  if (!checkCapLimit(coll.length, FREE_LIMITS.collection, 'cards in your collection')) return false;
  const card = { name, purchasePrice: price, condition, notes, addedAt: new Date().toISOString() };
  if (_pendingScannedSoldValue != null) {
    // Camera-scanned card: record the sold value as its own field and seed
    // the market value with it, so the portfolio shows Paid / Sold / Mkt.
    card.scanned = true;
    card.soldValue = _pendingScannedSoldValue;
    card.estValue = _pendingScannedSoldValue;
  } else {
    card.estValue = price;
  }
  coll.push(card);
  saveCollection(coll);
  const newIdx = coll.length - 1;
  _pendingScannedSoldValue = null;
  closeAddCardModal();
  document.getElementById('add-card-form').reset();
  renderPortfolio();
  // Auto-value the new card from live sold comps (non-blocking).
  setTimeout(() => valueCardAt(newIdx, { silent: true }), 50);
  return false;
}

function addToCollectionFromChecklist(player, year, brand, setName, parallel, printRun, cardNumber, team, category) {
  const coll = getCollection();
  if (!checkCapLimit(coll.length, FREE_LIMITS.collection, 'cards in your collection')) return false;
  const name = `${player} ${year} ${brand} ${setName}${parallel ? ' ' + parallel : ''}`;
  coll.push({
    name, purchasePrice: 0, estValue: 0, condition: '', notes: printRun ? `/${printRun}` : '',
    player: player || '', team: team || '', cardNumber: cardNumber || '', setName: setName || '',
    year: year || '', brand: brand || '', parallel: parallel || '', printRun: printRun || '',
    category: category || 'base',
    addedAt: new Date().toISOString()
  });
  saveCollection(coll);
  // Auto-value the new card from live sold comps (non-blocking).
  const newIdx = coll.length - 1;
  setTimeout(() => valueCardAt(newIdx, { silent: true }), 50);
  return true;
}

function removeFromCollection(idx) {
  const coll = getCollection();
  coll.splice(idx, 1);
  saveCollection(coll);
  renderPortfolio();
}

// ---- Collection valuation engine ----
// Builds an accurate sold-comp query per card (including print run + grade),
// pulls the filtered Sold comps, and tracks the comps so the value is
// transparent and editable.
function _cardGradeToken(condition) {
  if (!condition) return '';
  const m = String(condition).match(/\b(PSA|BGS|SGC|CGC|HGA|CSG)\s*(\d+(?:\.\d+)?)\b/i);
  return m ? `${m[1].toUpperCase()} ${m[2]}` : '';
}

function buildCardSoldQuery(c) {
  const grade = _cardGradeToken(c.condition);
  if (c.player) {
    const parts = [c.player, c.year, c.brand];
    // Skip generic "Base Set" set names — the word "set" almost never appears
    // in listing titles and poisons the match. Keep real insert/auto set names.
    if (c.setName && !/^base/i.test(c.setName) && !/base set/i.test(c.setName)) parts.push(c.setName);
    if (c.parallel) parts.push(c.parallel);
    let q = parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    if (c.printRun) q += ` /${c.printRun}`;
    if (grade) q += ` ${grade}`;
    return q.trim();
  }
  let q = c.name || '';
  if (grade && !new RegExp(grade.replace(/\s/g, '\\s*'), 'i').test(q)) q += ` ${grade}`;
  return q.trim();
}

// ---- Strict comp matching (spotless comps) ----
// Only count eBay sold listings whose title matches ALL of the card's key
// terms — player, year, set, exact parallel/color, exact print run, grade —
// and exclude mismatches (other colors, numbered when ours is unnumbered,
// graded when ours is raw). This is what keeps random comps out.
const _PARALLEL_COLORS = ['silver', 'gold', 'blue', 'green', 'red', 'purple', 'orange',
  'pink', 'black', 'white', 'aqua', 'teal', 'emerald', 'ruby', 'sapphire', 'copper',
  'bronze', 'yellow', 'neon', 'lime', 'maroon'];

function _cardSetKeyword(card) {
  const hay = `${card.brand || ''} ${card.setName || ''} ${card.name || ''}`.toLowerCase();
  return SCAN_KEY_SETS.find(s => hay.includes(s)) || '';
}

function _compMatchesCard(card, title) {
  const orig = String(title || '');
  const lower = ' ' + orig.toLowerCase().replace(/\s+/g, ' ') + ' ';

  // Player last name must appear.
  const player = card.player || _extractPlayer(card.name || '');
  if (player) {
    const toks = _normName(player).split(' ').filter(w => w.length > 2);
    const last = toks[toks.length - 1];
    if (last && !lower.includes(last)) return false;
  }
  // Year.
  if (card.year && !lower.includes(String(card.year))) return false;
  // Set / product line.
  const setKw = _cardSetKeyword(card);
  if (setKw && !lower.includes(setKw)) return false;
  // Parallel / color exclusivity.
  const par = String(card.parallel || '').toLowerCase();
  if (par) {
    const generic = new Set(['refractor', 'refractors', 'parallel', 'prizm', 'prizms', 'hobby', 'only', 'variation', 'variations', 'ssp', 'sp', 'the']);
    const pwords = par.split(/\s+/).map(w => w.replace(/[^a-z]/g, '')).filter(w => w.length > 2 && !generic.has(w));
    if (pwords.length && !pwords.every(w => lower.includes(w))) return false;
    const parColor = _PARALLEL_COLORS.find(col => new RegExp('\\b' + col + '\\b').test(par));
    if (parColor && _PARALLEL_COLORS.some(col => col !== parColor && new RegExp('\\b' + col + '\\b').test(lower))) return false;
  } else if (_PARALLEL_COLORS.some(col => new RegExp('\\b' + col + '\\b').test(lower))) {
    return false; // base/no-parallel card: drop colored parallels
  }
  // Print run exactness.
  if (card.printRun) {
    if (!new RegExp('/\\s*' + card.printRun + '(?![0-9])').test(lower)) return false;
  } else if (/\/\s*\d{1,4}\b/.test(lower)) {
    return false; // unnumbered card: drop numbered listings
  }
  // Grade.
  const grade = _cardGradeToken(card.condition);
  if (grade) {
    if (!new RegExp(grade.replace(/\s+/g, '\\s*'), 'i').test(orig)) return false;
  } else if (/\b(psa|bgs|sgc|cgc|hga|csg)\s*\d/i.test(orig)) {
    return false; // raw card: drop graded listings
  }
  return true;
}

// Derive a pseudo-card (key terms) from a free-text/scanned query string so
// the same strict matcher can clean scanner results.
function _cardFromQuery(q) {
  const lower = String(q).toLowerCase();
  let parallel = '';
  for (const p of SCAN_KEY_PARALLEL_PHRASES) if (lower.includes(p)) { parallel = p; break; }
  if (!parallel) for (const w of lower.split(/\s+/)) { const c = w.replace(/[^a-z]/g, ''); if (SCAN_KEY_PARALLEL_WORDS.has(c)) { parallel = c; break; } }
  const g = detectGrade(q);
  const pr = parsePrintRun(q);
  return {
    player: _extractPlayer(q),
    year: (String(q).match(/\b(19|20)\d{2}\b/) || [])[0] || '',
    brand: SCAN_KEY_SETS.find(s => lower.includes(s)) || '',
    parallel,
    printRun: pr ? String(pr) : '',
    condition: g !== 'Raw / Ungraded' ? g : '',
  };
}

function _medianOf(prices) {
  const s = [...prices].sort((a, b) => a - b);
  const n = s.length;
  if (!n) return null;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

const _compKey = comp => comp.url || comp.title;

// Recompute a card's market value from its stored comps minus any the user
// excluded. Returns the comp count used.
function recomputeCardValue(c) {
  const ex = new Set(c.excludedComps || []);
  const prices = (c.comps || []).filter(x => !ex.has(_compKey(x))).map(x => x.price).filter(p => p > 0);
  c.compCount = prices.length;
  if (c.estimate && c.estimate.value > 0) {
    // No exact sale was found — the sold search returned an alternate estimate
    // built from the same player's similar cards, adjusted for print run and
    // set. Use THAT, not the raw median of those differently-numbered comps.
    c.estValue = Math.round(c.estimate.value * 100) / 100;
    c.isEstimate = true;
  } else if (prices.length) {
    // Exact sold comps — straight median of the matching sales.
    c.estValue = Math.round(_medianOf(prices) * 100) / 100;
    c.isEstimate = false;
  } else {
    c.isEstimate = false;
  }
  return prices.length;
}

function _cardConfidence(c) {
  if (!c.comps || !c.comps.length) return null;
  const n = c.compCount != null ? c.compCount : c.comps.length;
  if (c.broadened || n < 3) return 'low';
  if (n < 6) return 'medium';
  return 'high';
}

// Tiny inline meta shown next to a card's market value: confidence dot +
// comp count, and a lock glyph when the value is locked/overridden.
function _cardValueMetaInline(c) {
  const parts = [];
  if (c.isEstimate && c.estimate) {
    const n = c.estimate.sampleSize || (c.estimate.comps || []).length;
    parts.push(`<span class="pf-est-badge" title="Estimated from ${n} similar sale${n !== 1 ? 's' : ''} — no exact sold listing found">EST</span>`);
  } else {
    const conf = _cardConfidence(c);
    const colors = { high: '#4ade80', medium: '#fbbf24', low: '#f87171' };
    if (conf) parts.push(`<span class="pf-conf-dot" style="color:${colors[conf]}">&#9679;</span>${c.compCount || 0}`);
  }
  if (c.locked) parts.push('&#128274;');
  return parts.length ? `<span class="pf-val-meta">${parts.join(' ')}</span>` : '';
}

// Fetch fresh sold comps for one card (authenticated — needs the scrape.do key).
// Comp time window: Pro members value off all-time comps; Free members are
// All-time comp depth is free for everyone now.
const COMP_WINDOW_DAYS_FREE = 60;
// All-time comps are free for everyone now.
function _compsUseAllTime() { return true; }

async function _fetchCardComps(c) {
  const q = buildCardSoldQuery(c);
  if (!q) return null;
  const res = await authFetch(`/api/search?mode=sold&q=${encodeURIComponent(q)}&limit=25`);
  const data = await res.json();
  if (!res.ok) return { error: data.error || `Error ${res.status}`, noKey: data.noKey };
  // Trust the server's keyword engine (matchSoldListings): it already extracts
  // the card's keywords, keeps the listings sharing the most of them, and trims
  // price outliers. So the comps it returns ARE the comps used — we no longer
  // re-filter them client-side (that older strict pass dropped good comps and
  // left cards unvalued).
  let rows = (Array.isArray(data.results) ? data.results : [])
    .map(r => ({
      title: String(r.title || '').slice(0, 90),
      price: parseFloat(r.price),
      url: r.itemUrl || r.url || r.link || '',
      imageUrl: r.imageUrl || r.thumbnailUrl || '',
      soldDate: r.soldDate || '',
    }))
    .filter(x => x.price > 0)
    .slice(0, 20);
  // Free members: only count comps from the last 2 months (keep undated ones
  // so a card never ends up with zero comps just for missing dates).
  let windowed = false;
  if (!_compsUseAllTime()) {
    const cutoff = Date.now() - COMP_WINDOW_DAYS_FREE * 86400000;
    const recent = rows.filter(x => { const t = Date.parse(x.soldDate); return isNaN(t) || t >= cutoff; });
    if (recent.length) { rows = recent; windowed = true; }
  }
  rows.sort((a, b) => a.price - b.price);
  return {
    comps: rows,
    estimate: data.estimate || null,
    broadened: data.searchType === 'broadened',
    relaxed: data.searchType === 'relaxed',
    matchNote: data.relaxedNote || null,
    query: q,
    windowed,
  };
}

// Value a single card by collection index and persist (skips locked cards).
async function valueCardAt(idx, { silent = false } = {}) {
  const coll = getCollection();
  const c = coll[idx];
  if (!c || c.locked) return;
  const r = await _fetchCardComps(c);
  if (!r || r.error) {
    if (!silent && r && r.noKey) showPortfolioToast('Add your scrape.do API key in Settings to value cards.');
    return;
  }
  c.comps = r.comps;
  c.estimate = r.estimate || null;
  c.broadened = r.broadened;
  c.relaxed = r.relaxed;
  c.matchNote = r.matchNote;
  c.valueQuery = r.query;
  c.valuedAt = new Date().toISOString();
  c.excludedComps = (c.excludedComps || []).filter(k => c.comps.some(x => _compKey(x) === k));
  recomputeCardValue(c);
  saveCollection(coll);
  renderPortfolio();
}

// Re-value one card from the portfolio list (per-card refresh button).
async function refreshSingleCard(idx, btnEl) {
  if (btnEl) { btnEl.disabled = true; btnEl.classList.add('pf-refreshing'); }
  await valueCardAt(idx);
  // renderPortfolio() inside valueCardAt rebuilds the list, so no need to
  // restore the button — but guard in case the card was already valued/locked.
  if (btnEl && document.body.contains(btnEl)) { btnEl.disabled = false; btnEl.classList.remove('pf-refreshing'); }
}

async function refreshPortfolioValues() {
  const btn = document.getElementById('refresh-market-btn');
  const origHTML = btn ? btn.innerHTML : '';
  const coll = getCollection();
  const targets = coll.filter(c => !c.locked && buildCardSoldQuery(c));
  if (!targets.length) { showPortfolioToast('No cards to value, or all are locked.'); return; }

  let done = 0, refreshed = 0, noKey = false;
  for (const c of coll) {
    if (c.locked || !buildCardSoldQuery(c)) continue;
    if (btn) { btn.disabled = true; btn.innerHTML = `&#8635; Valuing ${++done}/${targets.length}…`; }
    const r = await _fetchCardComps(c);
    if (r && r.noKey) { noKey = true; break; }
    if (r && !r.error) {
      c.comps = r.comps;
      c.estimate = r.estimate || null;
      c.broadened = r.broadened;
      c.relaxed = r.relaxed;
      c.matchNote = r.matchNote;
      c.valueQuery = r.query;
      c.valuedAt = new Date().toISOString();
      c.excludedComps = (c.excludedComps || []).filter(k => c.comps.some(x => _compKey(x) === k));
      recomputeCardValue(c);
      // Count it as valued whether from exact comps OR the alternate estimate.
      if (c.estValue > 0) refreshed++;
    }
  }
  saveCollection(coll);
  renderPortfolio();
  if (btn) { btn.disabled = false; btn.innerHTML = origHTML; }
  showPortfolioToast(noKey
    ? 'Add your scrape.do API key in Settings to value cards.'
    : refreshed > 0
      ? `Valued ${refreshed} card${refreshed !== 1 ? 's' : ''} from live sold comps.`
      : 'No sold comps found. Try more specific card details.');
}

// ---- Per-card comps drilldown (modal) ----
let _compsModalIdx = null;

function openCardComps(idx) {
  const coll = getCollection();
  const c = coll[idx];
  if (!c) return;
  _compsModalIdx = idx;
  document.getElementById('card-comps-modal').classList.remove('hidden');
  renderCardCompsModal();
}

function closeCardComps() {
  document.getElementById('card-comps-modal').classList.add('hidden');
  _compsModalIdx = null;
}

function renderCardCompsModal() {
  const idx = _compsModalIdx;
  const coll = getCollection();
  const c = coll[idx];
  const body = document.getElementById('card-comps-body');
  if (!c || !body) return;
  const title = c.player ? buildCardSoldQuery(c) : (c.name || 'Card');
  const comps = c.comps || [];
  const med = c.estValue || 0;
  const conf = _cardConfidence(c);
  const confColors = { high: '#4ade80', medium: '#fbbf24', low: '#f87171' };

  let listHtml;
  if (c.isEstimate && c.estimate && (c.estimate.comps || []).length) {
    // Alternate (estimated) value — show the similar sales it was built from,
    // each crossed from its actual sold price to the adjusted price.
    const est = c.estimate;
    const adjLabel = est.targetPrintRun ? `/${est.targetPrintRun}` : (est.targetSet || 'this card');
    listHtml = `<div class="ccm-est-note">&#9878;&#65039; No exact sold listing — estimated from ${est.sampleSize} similar sale${est.sampleSize !== 1 ? 's' : ''}, each adjusted to ${escHtml(adjLabel)} for print run${est.adjustedForSet ? ' &amp; set value' : ''}.</div>`;
    listHtml += '<div class="gc-comp-list">' + (est.comps || []).map(x => {
      const img = x.imageUrl
        ? `<img class="gc-comp-img" src="${escHtml(x.imageUrl)}" alt="" loading="lazy" />`
        : '<div class="gc-comp-img gc-comp-noimg">&#127944;</div>';
      const when = _gradingCompDate(x.soldDate);
      const tags = [];
      if (x.printRun) tags.push(`/${x.printRun}`);
      if (x.setName && x.setName !== est.targetSet) tags.push(escHtml(x.setName));
      const titleHtml = x.itemUrl
        ? `<a class="gc-comp-title" href="${escHtml(epnUrl(x.itemUrl))}" target="_blank" rel="noopener">${escHtml(x.title)}</a>`
        : `<span class="gc-comp-title">${escHtml(x.title)}</span>`;
      return `<div class="gc-comp">
        ${img}
        <div class="gc-comp-main">
          ${titleHtml}
          <div class="gc-comp-meta">
            <span class="gc-comp-price gc-comp-strike">$${Number(x.soldPrice).toFixed(2)}</span>
            <span class="gc-comp-arrow">&rarr;</span>
            <span class="gc-comp-price gc-comp-adj">$${Number(x.adjustedPrice).toFixed(2)}</span>
            ${tags.length ? ` · ${tags.join(' · ')}` : ''}${when ? ` · ${escHtml(when)}` : ''}
          </div>
        </div>
      </div>`;
    }).join('') + '</div>';
  } else if (!comps.length) {
    listHtml = `<div class="gc-empty">No comps yet. Click <strong>Re-value from eBay</strong> to pull live sold listings${buildCardSoldQuery(c) ? '' : ' (add more card details first)'}.</div>`;
  } else {
    // Read-only list of the exact sold comps the value was built from.
    listHtml = '<div class="gc-comp-list">' + comps.map(x => {
      const img = x.imageUrl
        ? `<img class="gc-comp-img" src="${escHtml(x.imageUrl)}" alt="" loading="lazy" />`
        : '<div class="gc-comp-img gc-comp-noimg">&#127944;</div>';
      const when = _gradingCompDate(x.soldDate);
      const titleHtml = x.url
        ? `<a class="gc-comp-title" href="${escHtml(epnUrl(x.url))}" target="_blank" rel="noopener">${escHtml(x.title)}</a>`
        : `<span class="gc-comp-title">${escHtml(x.title)}</span>`;
      return `<div class="gc-comp">
        ${img}
        <div class="gc-comp-main">
          ${titleHtml}
          <div class="gc-comp-meta"><span class="gc-comp-price">$${x.price.toFixed(2)}</span>${when ? ` · ${escHtml(when)}` : ''}</div>
        </div>
      </div>`;
    }).join('') + '</div>';
  }

  const matchNote = c.broadened
    ? '<span class="ccm-match-note">&middot; similar items (no exact match)</span>'
    : (c.relaxed ? `<span class="ccm-match-note">&middot; ${escHtml(c.matchNote || 'closest matches')}</span>` : '');

  const isEst = c.isEstimate && c.estimate;
  const valueLabel = isEst ? 'estimated value' : 'market value (median)';
  const valueText = med > 0 ? `${isEst ? '~' : ''}$${med.toFixed(2)}` : '—';
  const metaText = isEst
    ? `${c.estimate.sampleSize || (c.estimate.comps || []).length} similar sale${(c.estimate.sampleSize || 0) !== 1 ? 's' : ''}${c.valuedAt ? ` &middot; ${timeAgo(c.valuedAt)}` : ''}`
    : `${c.compCount || 0} comps${c.valuedAt ? ` &middot; ${timeAgo(c.valuedAt)}` : ''} ${matchNote}`;

  body.innerHTML = `
    <div class="ccm-card-name">${escHtml(title)}</div>
    <div class="ccm-value-row">
      <div class="ccm-value">${valueText}<span class="ccm-value-label">${valueLabel}</span></div>
      ${isEst ? '<span class="ccm-conf pf-est-badge">EST</span>' : (conf ? `<span class="ccm-conf" style="color:${confColors[conf]}">&#9679; ${conf} confidence</span>` : '')}
      <span class="ccm-meta">${metaText}</span>
    </div>
    <div class="ccm-window">&#9989; Valued from <strong>all-time</strong> sold comps</div>
    <div class="ccm-actions">
      <button type="button" class="ap-mini-btn" id="ccm-revalue-btn" onclick="revalueCardFromModal()">&#8635; Re-value from eBay</button>
    </div>
    ${listHtml}`;
}

async function revalueCardFromModal() {
  const idx = _compsModalIdx;
  const btn = document.getElementById('ccm-revalue-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Valuing…'; }
  await valueCardAt(idx);
  if (_compsModalIdx === idx) renderCardCompsModal();
}

function showPortfolioToast(msg) {
  let t = document.getElementById('portfolio-toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'portfolio-toast';
    t.className = 'portfolio-toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add('visible');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('visible'), 3500);
}

// ---- Monthly Market Report PDF ----
function generateMarketReport() {
  if (!hasPro()) { showPricing(); return; }

  const coll = getCollection();
  const user = getCurrentUser() || 'Collector';
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

  const totalCost = coll.reduce((s, c) => s + (c.purchasePrice || 0), 0);
  const totalValue = coll.reduce((s, c) => s + (c.estValue || c.purchasePrice || 0), 0);
  const gainLoss = totalValue - totalCost;
  const roi = totalCost > 0 ? ((totalValue - totalCost) / totalCost) * 100 : null;
  const glSign = gainLoss >= 0 ? '+' : '';
  const glColor = gainLoss >= 0 ? '#10b981' : '#ef4444';
  const roiColor = roi === null ? '#888' : roi >= 0 ? '#10b981' : '#ef4444';

  const cardRows = coll.map(c => {
    const name = c.player ? `${c.player}${c.year ? ' ' + c.year : ''}${c.brand ? ' ' + c.brand : ''}${c.setName ? ' ' + c.setName : ''}${c.parallel ? ' ' + c.parallel : ''}` : c.name || '—';
    const paid = c.purchasePrice || 0;
    const mkt = c.estValue || 0;
    const gl = mkt - paid;
    const r = paid > 0 ? ((mkt - paid) / paid) * 100 : null;
    const glC = gl >= 0 ? '#10b981' : '#ef4444';
    return `<tr>
      <td style="padding:6px 10px;border-bottom:1px solid #2a2a3a;font-size:13px;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(name)}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #2a2a3a;text-align:right;font-size:13px">$${paid.toFixed(2)}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #2a2a3a;text-align:right;font-size:13px">${mkt > 0 ? '$' + mkt.toFixed(2) : '—'}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #2a2a3a;text-align:right;font-size:13px;color:${mkt > 0 ? glC : '#888'}">${mkt > 0 ? (gl >= 0 ? '+' : '') + '$' + gl.toFixed(2) : '—'}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #2a2a3a;text-align:right;font-size:13px;color:${r !== null ? glC : '#888'}">${r !== null ? (r >= 0 ? '+' : '') + r.toFixed(1) + '%' : '—'}</td>
    </tr>`;
  }).join('');

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8"/>
  <title>The Card Huddle — Market Report ${dateStr}</title>
  <style>
    @media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Helvetica Neue', Arial, sans-serif; background: #0f1117; color: #e2e8f0; padding: 32px; }
    .rpt-header { display: flex; align-items: center; justify-content: space-between; border-bottom: 2px solid #1db954; padding-bottom: 18px; margin-bottom: 24px; }
    .rpt-title { font-size: 22px; font-weight: 800; background: linear-gradient(135deg,#52b788,#38a169); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    .rpt-meta { font-size: 12px; color: #8d99ae; text-align: right; }
    .rpt-stats { display: grid; grid-template-columns: repeat(4,1fr); gap: 14px; margin-bottom: 28px; }
    .rpt-stat { background: #1a1f2e; border: 1px solid #2a2a3a; border-radius: 10px; padding: 14px 16px; }
    .rpt-stat-label { font-size: 11px; color: #8d99ae; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 6px; }
    .rpt-stat-value { font-size: 20px; font-weight: 700; }
    table { width: 100%; border-collapse: collapse; }
    thead th { background: #1a1f2e; padding: 8px 10px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: #8d99ae; text-align: left; }
    thead th:not(:first-child) { text-align: right; }
    .rpt-footer { margin-top: 24px; font-size: 11px; color: #4a5568; text-align: center; border-top: 1px solid #2a2a3a; padding-top: 14px; }
  </style>
</head>
<body>
  <div class="rpt-header">
    <div class="rpt-title">The Card Huddle</div>
    <div class="rpt-meta">Monthly Market Report<br/>${escHtml(user)} &middot; ${dateStr}</div>
  </div>
  <div class="rpt-stats">
    <div class="rpt-stat"><div class="rpt-stat-label">Total Cards</div><div class="rpt-stat-value">${coll.length}</div></div>
    <div class="rpt-stat"><div class="rpt-stat-label">Total Invested</div><div class="rpt-stat-value">$${totalCost.toFixed(2)}</div></div>
    <div class="rpt-stat"><div class="rpt-stat-label">Est. Value</div><div class="rpt-stat-value">$${totalValue.toFixed(2)}</div></div>
    <div class="rpt-stat"><div class="rpt-stat-label">Gain / Loss</div><div class="rpt-stat-value" style="color:${glColor}">${glSign}$${gainLoss.toFixed(2)}</div></div>
  </div>
  <table>
    <thead><tr>
      <th>Card</th><th style="text-align:right">Paid</th><th style="text-align:right">Mkt Value</th><th style="text-align:right">Gain/Loss</th><th style="text-align:right">ROI</th>
    </tr></thead>
    <tbody>${cardRows}</tbody>
  </table>
  <div class="rpt-footer">Generated by The Card Huddle &middot; thecardhuddle.com &middot; ${dateStr}</div>
  <script>window.onload = () => { window.print(); }<\/script>
</body>
</html>`;

  const win = window.open('', '_blank');
  if (win) {
    win.document.write(html);
    win.document.close();
  } else {
    showPortfolioToast('Allow popups to generate the report.');
  }
}

// ---- Player Watchlist ----
function getWatchlist() {
  try { return JSON.parse(localStorage.getItem('cardHuddleWatchlist') || '[]'); }
  catch { return []; }
}
function saveWatchlist(list) {
  localStorage.setItem('cardHuddleWatchlist', JSON.stringify(list));
  schedulePushUserData();
}

function renderWatchlist() {
  const list = getWatchlist();
  const el = document.getElementById('watchlist-list');
  if (!el) return;
  if (list.length === 0) {
    el.innerHTML = '<p class="watchlist-empty">No players on your watchlist yet. Add a card above to start tracking.</p>';
    return;
  }
  el.innerHTML = list.map((item, idx) => {
    const hasCurrent = item.currentPrice != null;
    const hasPrev = item.prevPrice != null;
    const change = hasCurrent && hasPrev ? item.currentPrice - item.prevPrice : null;
    const changePct = hasCurrent && hasPrev && item.prevPrice > 0 ? ((item.currentPrice - item.prevPrice) / item.prevPrice) * 100 : null;
    const changeClass = change === null ? '' : change >= 0 ? 'gain' : 'loss';
    return `<div class="watchlist-card" data-idx="${idx}">
      <div class="watchlist-card-info">
        <div class="watchlist-card-query">${escHtml(item.query)}</div>
        <div class="watchlist-card-meta">Added ${new Date(item.addedAt).toLocaleDateString()}${item.updatedAt ? ' · Updated ' + new Date(item.updatedAt).toLocaleDateString() : ''}</div>
      </div>
      <div class="watchlist-card-prices">
        ${hasCurrent
          ? `<span class="watchlist-price">$${item.currentPrice.toFixed(2)}</span>
             ${change !== null ? `<span class="watchlist-change ${changeClass}">${change >= 0 ? '▲' : '▼'} ${Math.abs(change).toFixed(2)} (${change >= 0 ? '+' : ''}${changePct.toFixed(1)}%)</span>` : ''}`
          : '<span class="watchlist-no-price">No price data</span>'}
      </div>
      <div class="watchlist-card-actions">
        <button class="watchlist-search-btn" onclick="searchFromWatchlist(${idx})" title="Search">&#128269;</button>
        <button class="watchlist-remove-btn" onclick="removeFromWatchlist(${idx})" title="Remove">&times;</button>
      </div>
    </div>`;
  }).join('');
}

function addToWatchlist() {
  const input = document.getElementById('watchlist-input');
  if (!input) return;
  const query = input.value.trim();
  if (!query) return;
  const list = getWatchlist();
  if (list.some(item => item.query.toLowerCase() === query.toLowerCase())) {
    showPortfolioToast('Already on your watchlist.');
    return;
  }
  if (!checkCapLimit(list.length, FREE_LIMITS.watchlist, 'watchlist entries')) return;
  list.push({ query, addedAt: new Date().toISOString(), currentPrice: null, prevPrice: null, updatedAt: null });
  saveWatchlist(list);
  input.value = '';
  renderWatchlist();
}

function removeFromWatchlist(idx) {
  const list = getWatchlist();
  list.splice(idx, 1);
  saveWatchlist(list);
  renderWatchlist();
}

function searchFromWatchlist(idx) {
  const list = getWatchlist();
  if (!list[idx]) return;
  const q = list[idx].query;
  const searchInput = document.getElementById('search-input');
  if (searchInput) {
    searchInput.value = q;
    switchView('search');
    performSearch();
  }
}

async function refreshWatchlistPrices() {
  const list = getWatchlist();
  if (list.length === 0) { showPortfolioToast('Nothing on your watchlist yet.'); return; }

  const btn = document.getElementById('watchlist-refresh-btn');
  const origHTML = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.innerHTML = '&#8635; Refreshing…'; }

  let updated = 0;
  for (const item of list) {
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(item.query)}&mode=sold`);
      const data = await res.json();
      let newPrice = null;
      if (data.approximateValue && data.approximateValue.medianPrice) {
        newPrice = data.approximateValue.medianPrice;
      } else if (data.results && data.results.length > 0) {
        const v = data.results.map(r => r.price).filter(p => p > 0).sort((a, b) => a - b);
        if (v.length) {
          const mid = Math.floor(v.length / 2);
          newPrice = v.length % 2 === 0 ? (v[mid - 1] + v[mid]) / 2 : v[mid];
        }
      }
      if (newPrice !== null) {
        item.prevPrice = item.currentPrice;
        item.currentPrice = newPrice;
        item.updatedAt = new Date().toISOString();
        updated++;
      }
    } catch { /* skip */ }
  }

  saveWatchlist(list);
  renderWatchlist();
  if (btn) { btn.disabled = false; btn.innerHTML = origHTML; }
  showPortfolioToast(updated > 0
    ? `Refreshed prices for ${updated} item${updated !== 1 ? 's' : ''}.`
    : 'No price data found.');
}

// ---- Set Completion Tracker ----
let completionData = null;
const rainbowMode = true;
let completionVariantFilters = {}; // { setIndex: { name, printRun } }

function getCompletionState() {
  try { return JSON.parse(localStorage.getItem('cardHuddleCompletion') || '{}'); }
  catch { return {}; }
}
function saveCompletionState(state) {
  localStorage.setItem('cardHuddleCompletion', JSON.stringify(state));
  schedulePushUserData();
}

async function loadCompletionProducts() {
  const select = document.getElementById('completion-product-select');
  if (select.options.length > 1) return; // already loaded
  try {
    const data = await fetchChecklistsList();
    data.products.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.id;
      // name already contains the year (e.g. "2025 Bowman Football") — don't prepend it again
      opt.textContent = p.name;
      select.appendChild(opt);
    });
    syncComboboxFromSelect(document.getElementById('cl-combo-product'));
  } catch (err) { console.error('Failed to load products for completion:', err); }
}

async function loadCompletionProduct() {
  const select = document.getElementById('completion-product-select');
  const productId = select.value;
  const setsEl = document.getElementById('completion-sets');
  const progressEl = document.getElementById('completion-progress');
  const subtabs = document.getElementById('completion-subtabs');
  if (!productId) {
    setsEl.innerHTML = ''; progressEl.classList.add('hidden');
    subtabs.style.display = 'none';
    document.getElementById('completion-player-panel').style.display = 'none';
    document.getElementById('completion-set-panel').style.display = '';
    return;
  }

  setsEl.innerHTML = '<div class="checklist-loading"><div class="spinner"></div><span>Loading...</span></div>';
  try {
    completionData = await fetchChecklistProduct(productId);
    progressEl.classList.remove('hidden');
    subtabs.style.display = '';
    switchCompletionSubtab('set');
    renderCompletionSets();
    populatePlayerSelect();
  } catch (err) {
    setsEl.innerHTML = `<p>Error loading product.</p>`;
  }
}

function toggleRainbowHelp(e) {
  if (e) e.stopPropagation();
  const pop = document.getElementById('rainbow-help-popover');
  const btn = document.querySelector('.rainbow-help-btn');
  if (!pop || !btn) return;
  const open = pop.classList.toggle('open');
  btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (open) {
    const dismiss = (ev) => {
      if (pop.contains(ev.target) || btn.contains(ev.target)) return;
      pop.classList.remove('open');
      btn.setAttribute('aria-expanded', 'false');
      document.removeEventListener('click', dismiss);
    };
    setTimeout(() => document.addEventListener('click', dismiss), 0);
  }
}

function toggleCompletionVariantFilter(si, variantName, printRun) {
  const current = completionVariantFilters[si];
  if (current && current.name === variantName) {
    delete completionVariantFilters[si];
  } else {
    completionVariantFilters[si] = { name: variantName, printRun: printRun || '' };
  }
  renderCompletionSets();
}

function renderCompletionSets() {
  if (!completionData) return;
  const state = getCompletionState();
  const productKey = completionData.id || completionData.name;
  const owned = state[productKey] || {};

  let totalCards = 0, ownedCount = 0;
  const setsEl = document.getElementById('completion-sets');

  let html = '';
  completionData.sets.forEach((set, si) => {
    const setKey = `s${si}`;
    const cards = set.cards || [];
    const allVariants = buildVariants(set);

    // Determine which variants to show based on filter
    const activeFilter = completionVariantFilters[si];
    const displayVariants = activeFilter
      ? allVariants.filter(v => v.name === activeFilter.name)
      : allVariants;
    // Find the variant index for the active filter (for checkbox keys)
    const activeVi = activeFilter
      ? allVariants.findIndex(v => v.name === activeFilter.name)
      : -1;

    let setTotal = 0, setOwned = 0;

    // Count totals across ALL variants (not just filtered)
    cards.forEach((c, ci) => {
      allVariants.forEach((v, vi) => {
        setTotal++;
        if (owned[`${setKey}_c${ci}_v${vi}`]) setOwned++;
      });
    });
    totalCards += setTotal;
    ownedCount += setOwned;

    const pct = setTotal > 0 ? Math.round((setOwned / setTotal) * 100) : 0;
    const isComplete = pct === 100;

    const categoryBadge = set.category === 'autograph' ? '<span class="checklist-badge auto">AUTO</span>'
      : set.category === 'memorabilia' ? '<span class="checklist-badge memo">MEMO</span>'
      : set.category === 'insert' ? '<span class="checklist-badge insert">INSERT</span>'
      : '<span class="checklist-badge base">BASE</span>';

    // Build parallel filter badges (like normal checklist)
    const parallelsList = allVariants.map(v => {
      const pr = v.printRun ? ` /${v.printRun}` : '';
      const isActive = activeFilter && activeFilter.name === v.name;
      const nameEsc = escHtml(v.name).replace(/'/g, "\\'");
      return `<span class="checklist-parallel ${isActive ? 'checklist-parallel-active' : ''}" onclick="event.stopPropagation(); toggleCompletionVariantFilter(${si}, '${nameEsc}', '${v.printRun || ''}')">${escHtml(v.name)}${pr}</span>`;
    }).join('');

    const filterLabel = activeFilter ? `<span class="checklist-variant-label">${escHtml(activeFilter.name)}${activeFilter.printRun ? ' /' + activeFilter.printRun : ''}</span>` : '';

    html += `<div class="completion-set ${isComplete ? 'complete' : ''}">
      <div class="completion-set-header" onclick="toggleCompletionSet(${si})">
        <div class="completion-set-title-row">
          ${categoryBadge}
          <span class="completion-set-name">${escHtml(set.name)}</span>
          <span class="completion-set-count">${setOwned}/${setTotal} (${pct}%)</span>
          ${filterLabel}
          <div class="completion-mini-bar"><div class="completion-mini-fill" style="width:${pct}%"></div></div>
        </div>
        <div class="checklist-parallels-row">${parallelsList}</div>
      </div>
      <div class="completion-set-cards hidden" id="completion-cards-${si}">
        <table class="checklist-table completion-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Player</th>
              <th>Team</th>
              <th>Variants</th>
            </tr>
          </thead>
          <tbody>`;

    cards.forEach((c, ci) => {
      const year = completionData.year || '2025';
      const brand = (completionData.brand || 'Bowman').replace(/'/g, "\\'");
      const setName = set.name.replace(/'/g, "\\'");
      const category = set.category || 'base';
      const playerEsc = escHtml(c.player || 'Unknown').replace(/'/g, "\\'");
      const cardNum = escHtml(c.number).replace(/'/g, "\\'");
      const printRun = c.printRun ? String(c.printRun) : '';

      const variantsToRender = activeFilter ? [{ v: displayVariants[0], vi: activeVi }] : allVariants.map((v, vi) => ({ v, vi }));

      // One row per card. All variants for that card render as inline chips.
      // Clicking the chip's LABEL TEXT opens an inline For Sale listings panel
      // for that exact variant; the checkbox still toggles owned state.
      const chipsHtml = variantsToRender.map(({ v, vi }) => {
        const key = `${setKey}_c${ci}_v${vi}`;
        const checked = owned[key] ? 'checked' : '';
        const isOwned = owned[key];
        const prDisplay = v.printRun ? ' /' + v.printRun : '';
        const variantName = (v.name || '').replace(/'/g, "\\'");
        const variantPr = v.printRun ? String(v.printRun) : '';
        return `<label class="completion-variant-check ${isOwned ? 'owned' : ''}">
          <input type="checkbox" ${checked} onchange="toggleCompletionCard('${productKey}','${key}',this)" />
          <span class="completion-variant-text" onclick="event.preventDefault(); event.stopPropagation(); openVariantListings(this, '${playerEsc}', '${year}', '${brand}', '${setName}', '${category}', '${cardNum}', '${variantName}', '${variantPr}')">${escHtml(v.name)}${prDisplay}</span>
        </label>`;
      }).join('');

      // A row is "owned" only when every visible variant on it is checked.
      const allOwned = variantsToRender.length > 0 && variantsToRender.every(({ vi }) => owned[`${setKey}_c${ci}_v${vi}`]);
      const firstVariant = variantsToRender[0]?.v || allVariants[0];
      // Rainbow-cost button — only meaningful when rainbow mode is on AND
      // there's more than one variant on the card. Stores enough data on
      // the button itself so calculateRainbowCost can read it without
      // re-deriving from the table.
      const rainbowBtn = (rainbowMode && allVariants.length > 1)
        ? `<button class="rainbow-cost-btn" onclick="calculateRainbowCost(this, '${productKey}','${setKey}_c${ci}','${playerEsc}','${year}','${brand}','${setName}','${category}','${cardNum}', ${ci})">Rainbow $?</button>`
        : '';
      const rainbowViewBtn = (allVariants.length > 1)
        ? `<button class="rainbow-view-btn" onclick="openRainbowGridForCard(${si}, ${ci})" title="Open rainbow grid">View Rainbow</button>`
        : '';

      html += `<tr class="${allOwned ? 'completion-row-owned' : ''}" data-card-idx="${ci}">
        <td class="cl-num">${escHtml(c.number)}</td>
        <td class="cl-player"><a href="#" class="cl-player-link" onclick="event.preventDefault(); toggleCompletionListings(this, '${playerEsc}', '${year}', '${brand}', '${setName}', '${category}', '${cardNum}', '${(firstVariant && firstVariant.printRun) || printRun}')">${escHtml(c.player || 'Unknown')}</a></td>
        <td class="cl-team">${escHtml(c.team || '')}</td>
        <td class="completion-variant-cell"><div class="completion-variants">${chipsHtml}${rainbowBtn}${rainbowViewBtn}</div></td>
      </tr>`;
    });

    html += `</tbody></table>
      </div></div>`;
  });

  setsEl.innerHTML = html;

  // Update overall progress
  const overallPct = totalCards > 0 ? Math.round((ownedCount / totalCards) * 100) : 0;
  document.getElementById('completion-bar').style.width = overallPct + '%';
  document.getElementById('completion-text').textContent = `${ownedCount} / ${totalCards} cards (${overallPct}%)`;
}

function toggleCompletionSet(idx) {
  const el = document.getElementById(`completion-cards-${idx}`);
  if (!el) return;
  const isHidden = el.classList.toggle('hidden');
  // Mirror open/closed state on the parent set so the chevron CSS can rotate.
  const setEl = el.closest('.completion-set');
  if (setEl) setEl.classList.toggle('expanded', !isHidden);
}

function toggleCompletionCard(productKey, cardKey, checkbox) {
  const state = getCompletionState();
  if (!state[productKey]) state[productKey] = {};
  if (checkbox.checked) {
    state[productKey][cardKey] = true;
  } else {
    delete state[productKey][cardKey];
  }
  saveCompletionState(state);

  // Update the label styling without re-rendering
  const label = checkbox.closest('.completion-variant-check');
  if (label) label.classList.toggle('owned', checkbox.checked);

  // Update counts in-place
  updateCompletionCounts();
}

function updateCompletionCounts() {
  if (!completionData) return;
  const state = getCompletionState();
  const productKey = completionData.id || completionData.name;
  const owned = state[productKey] || {};

  let totalCards = 0, ownedCount = 0;

  completionData.sets.forEach((set, si) => {
    const setKey = `s${si}`;
    const cards = set.cards || [];
    const variants = buildVariants(set);
    let setTotal = 0, setOwned = 0;

    cards.forEach((c, ci) => {
      variants.forEach((v, vi) => {
        setTotal++;
        if (owned[`${setKey}_c${ci}_v${vi}`]) setOwned++;
      });
    });
    totalCards += setTotal;
    ownedCount += setOwned;

    const pct = setTotal > 0 ? Math.round((setOwned / setTotal) * 100) : 0;

    // Update set header count and progress bar
    const setEl = document.querySelectorAll('.completion-set')[si];
    if (setEl) {
      const countEl = setEl.querySelector('.completion-set-count');
      if (countEl) countEl.textContent = `${setOwned}/${setTotal} (${pct}%)`;
      const fillEl = setEl.querySelector('.completion-mini-fill');
      if (fillEl) fillEl.style.width = pct + '%';
      setEl.classList.toggle('complete', pct === 100);
    }

    // Update player counts within this set
    const cardsContainer = document.getElementById(`completion-cards-${si}`);
    if (cardsContainer) {
      const playerGroups = {};
      cards.forEach((c, ci) => {
        const pName = c.player || 'Unknown';
        if (!playerGroups[pName]) playerGroups[pName] = [];
        playerGroups[pName].push({ ci });
      });

      const pctEls = cardsContainer.querySelectorAll('.completion-player-pct');
      let pIdx = 0;
      Object.keys(playerGroups).forEach(playerName => {
        const playerCards = playerGroups[playerName];
        let pOwned = 0, pTotal = 0;
        playerCards.forEach(c => {
          variants.forEach((v, vi) => {
            pTotal++;
            if (owned[`${setKey}_c${c.ci}_v${vi}`]) pOwned++;
          });
        });
        const pctEl = pctEls[pIdx];
        if (pctEl) {
          pctEl.textContent = `${pOwned}/${pTotal}`;
          pctEl.classList.toggle('complete', pOwned === pTotal && pTotal > 0);
        }
        pIdx++;
      });
    }
  });

  // Update overall progress
  const overallPct = totalCards > 0 ? Math.round((ownedCount / totalCards) * 100) : 0;
  const barEl = document.getElementById('completion-bar');
  const textEl = document.getElementById('completion-text');
  if (barEl) barEl.style.width = overallPct + '%';
  if (textEl) textEl.textContent = `${ownedCount} / ${totalCards} cards (${overallPct}%)`;
}

// Toggle inline for-sale listings in completion view
function toggleCompletionListings(linkEl, player, year, brand, setName, category, cardNum, printRun) {
  const group = linkEl.closest('.completion-player-group');
  const slot = group.querySelector('.completion-player-listings-slot');

  // If already open, close it
  if (slot.innerHTML) {
    slot.innerHTML = '';
    linkEl.classList.remove('cl-player-active');
    return;
  }

  linkEl.classList.add('cl-player-active');
  const query = buildChecklistQuery(player, year, brand, setName, category, printRun);

  slot.innerHTML = `
    <div class="cl-listings-panel completion-listings-panel">
      <div class="cl-listings-header">
        <div class="cl-listings-tabs">
          <button class="cl-listings-tab active" data-lmode="forsale">For Sale</button>
          <button class="cl-listings-tab" data-lmode="sold">Sold</button>
        </div>
        <button class="cl-listings-close" title="Close">&times;</button>
      </div>
      <div class="cl-listings-body">
        <div class="cl-listings-loading"><div class="spinner"></div><span>Searching eBay...</span></div>
      </div>
    </div>
  `;

  const tabs = slot.querySelectorAll('.cl-listings-tab');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      fetchPlayerListings(slot, query, tab.dataset.lmode);
    });
  });

  slot.querySelector('.cl-listings-close').addEventListener('click', () => {
    slot.innerHTML = '';
    linkEl.classList.remove('cl-player-active');
  });

  fetchPlayerListings(slot, query, 'forsale');
}

// Open an inline For Sale listings panel for one specific variant
// (e.g. clicking a "Mirror Purple /299" chip on Sauce Gardner's row).
// Works in both views:
//   - Set view: chips live inside a <table>, panel inserted as a new <tr>
//   - Player view: chips live in a div, panel inserted as a sibling div
// Results are filtered "extra strict" — title must include the variant
// name and (if present) the print run, so we don't show off-target hits.
function openVariantListings(spanEl, player, year, brand, setName, category, cardNum, variantName, printRun) {
  const inTable = !!spanEl.closest('tr');
  const variantsWrap = spanEl.closest('.completion-variants');
  const anchor = inTable ? spanEl.closest('tr') : variantsWrap;
  if (!anchor) return;

  // Close any panel currently open right after this anchor
  const existing = anchor.nextElementSibling;
  if (existing && (existing.classList.contains('cl-listings-row') || existing.classList.contains('cl-listings-block'))) {
    existing.remove();
    (variantsWrap || anchor).querySelectorAll('.completion-variant-active').forEach(s => s.classList.remove('completion-variant-active'));
    if (existing.dataset.variantKey === spanEl.dataset.variantKey) return;
  }

  // Mark this chip as active so we know which one is open
  spanEl.classList.add('completion-variant-active');
  const variantKey = `${cardNum}_${variantName}_${printRun}`;
  spanEl.dataset.variantKey = variantKey;

  const innerHtml = `
    <div class="cl-listings-panel completion-listings-panel">
      <div class="cl-listings-header">
        <span class="cl-listings-title">${escHtml(variantName || 'Variant')}${printRun ? ' /' + escHtml(printRun) : ''} — For Sale</span>
        <button class="cl-listings-close" title="Close">&times;</button>
      </div>
      <div class="cl-listings-body">
        <div class="cl-listings-loading"><div class="spinner"></div><span>Searching eBay...</span></div>
      </div>
    </div>`;

  let panel;
  if (inTable) {
    panel = document.createElement('tr');
    panel.className = 'cl-listings-row';
    const colCount = anchor.cells.length || 4;
    panel.innerHTML = `<td colspan="${colCount}">${innerHtml}</td>`;
  } else {
    panel = document.createElement('div');
    panel.className = 'cl-listings-block';
    panel.innerHTML = innerHtml;
  }
  panel.dataset.variantKey = variantKey;
  anchor.parentNode.insertBefore(panel, anchor.nextSibling);
  panel.querySelector('.cl-listings-close').addEventListener('click', () => {
    panel.remove();
    spanEl.classList.remove('completion-variant-active');
  });

  // Build a strict query: standard checklist query + variant name
  const baseQuery = buildChecklistQuery(player, year, brand, setName, category, printRun);
  const query = variantName ? `${baseQuery} ${variantName}` : baseQuery;
  fetchVariantListings(panel.querySelector('.cl-listings-body'), query, variantName, printRun);
}

// AUCTION | BUY_IT_NOW | BOTH (auction with BIN) | UNKNOWN
function classifyBuyingOption(item) {
  const opts = Array.isArray(item.buyingOptions) ? item.buyingOptions : [];
  const hasAuction = opts.includes('AUCTION');
  const hasFixed = opts.includes('FIXED_PRICE');
  if (hasAuction && hasFixed) return 'BOTH';
  if (hasAuction) return 'AUCTION';
  if (hasFixed) return 'BUY_IT_NOW';
  return 'UNKNOWN';
}

function buyingOptionBadgeHtml(item) {
  const kind = classifyBuyingOption(item);
  if (kind === 'AUCTION')    return '<span class="cl-buyopt cl-buyopt-auction">Auction</span>';
  if (kind === 'BUY_IT_NOW') return '<span class="cl-buyopt cl-buyopt-bin">Buy It Now</span>';
  if (kind === 'BOTH')       return '<span class="cl-buyopt cl-buyopt-both">Auction + BIN</span>';
  return '<span class="cl-buyopt cl-buyopt-bin">Buy It Now</span>';
}

function listingCardHtml(item) {
  return `
    <a class="cl-listing-item" href="${escHtml(epnUrl(item.itemUrl))}" target="_blank" rel="noopener noreferrer">
      ${item.imageUrl ? `<img class="cl-listing-img" src="${escHtml(item.imageUrl)}" alt="" loading="lazy" />` : '<div class="cl-listing-noimg">&#127183;</div>'}
      <div class="cl-listing-price">$${parseFloat(item.price).toFixed(2)}</div>
      ${buyingOptionBadgeHtml(item)}
      <div class="cl-listing-title">${escHtml(item.title)}</div>
    </a>`;
}

// Paginated variant listings — fetches 40 at a time, loads more when the
// sentinel at the bottom of the scrollable grid comes into view. If the
// strict filter wipes the first page, falls back to showing the unfiltered
// API results under a "Similar listings" header.
async function fetchVariantListings(container, query, variantName, printRun) {
  const state = {
    query, variantName, printRun,
    offset: 0, pageSize: 40,
    loading: false, hasMore: true,
    mode: 'strict',
    totalShown: 0,
    grid: null, sentinel: null, observer: null,
  };
  container._scrollState = state;
  container.innerHTML = '<div class="cl-listings-loading"><div class="spinner"></div><span>Searching eBay...</span></div>';
  await loadVariantPage(container);
}

async function loadVariantPage(container) {
  const s = container._scrollState;
  if (!s || s.loading || !s.hasMore) return;
  s.loading = true;
  if (s.loadMoreBtn) {
    s.loadMoreBtn.disabled = true;
    s.loadMoreBtn.textContent = 'Loading…';
  }
  try {
    const params = new URLSearchParams({ q: s.query, mode: 'forsale', limit: String(s.pageSize), offset: String(s.offset) });
    const res = await fetch(`/api/search?${params}`);
    const data = await safeJson(res);
    if (!res.ok) throw new Error(data.error || `Server error ${res.status}`);
    const raw = data.results || [];
    let items = (s.mode === 'strict' && s.variantName)
      ? filterStrictVariant(raw, s.variantName, s.printRun)
      : raw;
    if (s.offset === 0 && items.length === 0 && raw.length > 0 && s.mode === 'strict') {
      s.mode = 'similar';
      items = raw;
    }
    s.offset += s.pageSize;
    if (raw.length < s.pageSize) s.hasMore = false;
    renderVariantPage(container, items);
  } catch (err) {
    if (s.totalShown === 0) {
      container.innerHTML = `<div class="cl-listings-empty">Error: ${escHtml(err.message)}</div>`;
    }
  } finally {
    s.loading = false;
    if (s.loadMoreBtn && s.hasMore) {
      s.loadMoreBtn.disabled = false;
      s.loadMoreBtn.textContent = 'Load 40 more listings';
    }
  }
}

function renderVariantPage(container, items) {
  const s = container._scrollState;
  if (!s.grid) {
    if (items.length === 0) {
      container.innerHTML = '<div class="cl-listings-empty">No matching For Sale listings.</div>';
      return;
    }
    const header = s.mode === 'similar'
      ? '<div class="cl-similar-header">No exact matches — showing similar listings</div>'
      : '';
    container.innerHTML = `${header}<div class="cl-listings-grid"></div><div class="cl-load-more-wrap"></div>`;
    s.grid = container.querySelector('.cl-listings-grid');
    s.loadMoreWrap = container.querySelector('.cl-load-more-wrap');
    s.loadMoreBtn = document.createElement('button');
    s.loadMoreBtn.type = 'button';
    s.loadMoreBtn.className = 'cl-load-more-btn';
    s.loadMoreBtn.textContent = 'Load 40 more listings';
    s.loadMoreBtn.addEventListener('click', () => loadVariantPage(container));
    s.loadMoreWrap.appendChild(s.loadMoreBtn);
  }
  if (items.length > 0) {
    s.grid.insertAdjacentHTML('beforeend', items.map(listingCardHtml).join(''));
    s.totalShown += items.length;
  }
  if (!s.hasMore) {
    if (s.totalShown > 0) {
      s.loadMoreWrap.innerHTML = '<span class="cl-listings-end">— end of listings —</span>';
    } else {
      container.innerHTML = '<div class="cl-listings-empty">No matching For Sale listings.</div>';
    }
  }
}

// Strict filter: title must contain the variant name (case-insensitive) AND,
// if a print run is given, the literal "/<n>" must appear. Drops auto/relic
// hits when the variant isn't itself an auto/relic, and drops obviously
// wrong color parallels.
// Generic words in a parallel name that shouldn't be required in the title —
// they're filler ("Prizm", "Parallel") or the synthesized "Base" label.
const _RB_GENERIC_WORDS = new Set(['prizm', 'prizms', 'parallel', 'parallels', 'variation',
  'variations', 'rc', 'rookie', 'sp', 'ssp', 'the', 'of', 'to', 'and', 'card', 'cards',
  'numbered', 'insert', 'base', 'set']);

// Distinctive parallel "effect"/pattern names that denote a SEPARATE parallel,
// so a plain "Blue" should not match a "Blue Ice". Deliberately excludes
// ubiquitous finishes (refractor, holo, prizm, fractor) that are often dropped
// or added inconsistently in titles — gating on those would tank recall on
// Chrome/Bowman.
const _RB_EXCLUSIVE_EFFECTS = ['cracked ice', 'tie-dye', 'tie dye', 'snake skin', 'fast break',
  'ice', 'wave', 'disco', 'mojo', 'shimmer', 'velocity', 'genesis', 'reactive', 'flash',
  'pulsar', 'sparkle', 'hyper', 'cosmic', 'lava', 'tiger', 'snakeskin', 'galaxy', 'choice',
  'scope', 'atomic', 'dragon', 'butterfly', 'seismic', 'concourse', 'pandora', 'camo'];

// Which exclusive effects appear in a string (phrases by substring, single
// words on token boundaries so 'ice' doesn't match "price").
function _rbEffectsIn(s) {
  const found = new Set();
  for (const e of _RB_EXCLUSIVE_EFFECTS) {
    const hit = /[ -]/.test(e) ? s.includes(e) : new RegExp('\\b' + e + '\\b').test(s);
    if (hit) found.add(e);
  }
  return found;
}

// Filter For Sale results down to the ones that really are this parallel.
// Thorough but precise: handles the Base tier (exclude any parallel/numbering),
// color exclusivity (a Blue variant never matches a Green listing), multi-color
// parallels, bounded print runs (/25 != /250), and auto/relic exclusion.
function filterStrictVariant(items, variantName, printRun) {
  const v = (variantName || '').toLowerCase().trim();
  const isBase = !v || v === 'base';
  const wantsAuto = /\bauto/.test(v);
  const wantsRelic = /\b(patch|relic|jersey|memorabilia)\b/.test(v);

  // Distinctive words the title must contain (skip generic filler).
  const words = v.split(/\s+/)
    .map(w => w.replace(/[^a-z0-9]/g, ''))
    .filter(w => w.length > 2 && !_RB_GENERIC_WORDS.has(w));
  // Colors named in the variant — used for exclusivity (and to allow
  // multi-color parallels like "Red White Blue").
  const variantColors = _PARALLEL_COLORS.filter(c => new RegExp('\\b' + c + '\\b').test(v));
  const variantEffects = _rbEffectsIn(v);
  const prRe = printRun ? new RegExp('/\\s*' + printRun + '(?![0-9])') : null;

  return items.filter(item => {
    const title = String(item.title || '').toLowerCase();
    const tokens = new Set(title.split(/[^a-z0-9]+/).filter(Boolean));

    // Print run, bounded so /25 never matches /250.
    if (prRe && !prRe.test(title)) return false;

    if (isBase) {
      // Base = no parallel wording, no color, no serial numbering.
      if (_PARALLEL_COLORS.some(c => tokens.has(c))) return false;
      if (SCAN_KEY_PARALLEL_WORDS && [...SCAN_KEY_PARALLEL_WORDS].some(p => tokens.has(p))) return false;
      if (SCAN_KEY_PARALLEL_PHRASES.some(ph => title.includes(ph))) return false;
      if (!printRun && /\/\s*\d{1,4}\b/.test(title)) return false;
    } else {
      // Every distinctive word of the parallel must appear.
      for (const w of words) if (!title.includes(w)) return false;
      // Color exclusivity: drop listings that carry a color the variant doesn't.
      if (variantColors.length) {
        const bad = _PARALLEL_COLORS.filter(c => !variantColors.includes(c));
        if (bad.some(c => tokens.has(c))) return false;
      }
      // Effect exclusivity: a plain "Blue" shouldn't match a "Blue Ice" — drop
      // listings carrying a distinct parallel effect the variant doesn't name.
      for (const e of _rbEffectsIn(title)) {
        if (!variantEffects.has(e)) return false;
      }
    }

    if (!wantsAuto && /\bauto(graph)?\b/.test(title)) return false;
    if (!wantsRelic && /\b(patch|relic|jersey number|memorabilia|logoman)\b/.test(title)) return false;
    return true;
  });
}

// Rainbow cost — for the card's row, compute cheapest For Sale price for
// each variant, sum them, and render the result in place of the button.
// cardKey looks like 's<si>_c<ci>' so we can read both indices off it.
// Per-rainbow-result store, keyed by an id we put on the result span.
// Lets the user click the green pill to see all the cheapest listings used.
const _rainbowBreakdowns = {};

async function calculateRainbowCost(btn, productKey, cardKey, player, year, brand, setName, category, cardNum, ci) {
  if (!completionData) { btn.textContent = 'Rainbow: data missing'; return; }
  const m = String(cardKey).match(/^s(\d+)_c(\d+)$/);
  const si = m ? parseInt(m[1], 10) : -1;
  const targetSet = completionData.sets[si];
  if (!targetSet) { btn.textContent = 'Rainbow: set missing'; return; }
  const card = (targetSet.cards || [])[ci];
  if (!card) { btn.textContent = 'Rainbow: card missing'; return; }

  const variants = buildVariants(targetSet, { printRun: card.printRun || '' });

  btn.disabled = true;
  btn.textContent = `Pricing 0/${variants.length}…`;

  // Pre-size an array so writers from concurrent workers don't collide
  const perVariant = new Array(variants.length);
  let priced = 0;
  let unknown = 0;

  const CONCURRENCY = 4;
  let idx = 0;
  let done = 0;
  async function worker() {
    while (idx < variants.length) {
      const myIdx = idx++;
      const v = variants[myIdx];
      const baseQuery = buildChecklistQuery(player, year, brand, setName, category, v.printRun || '');
      const q = `${baseQuery} ${v.name}`.trim();
      try {
        // Pull a wider pool (50) so the cheapest true match isn't missed when
        // eBay returns lots of near-matches ahead of the right parallel.
        const res = await fetch(`/api/search?${new URLSearchParams({ q, mode: 'forsale', limit: '50' })}`);
        const data = await safeJson(res);
        const filtered = filterStrictVariant(data.results || [], v.name, v.printRun || '');
        const sorted = filtered.filter(r => parseFloat(r.price) > 0).sort((a, b) => parseFloat(a.price) - parseFloat(b.price));
        if (sorted.length > 0) {
          const cheapest = sorted[0];
          perVariant[myIdx] = { variant: v, listing: cheapest };
          priced++;
        } else {
          perVariant[myIdx] = { variant: v, listing: null };
          unknown++;
        }
      } catch (_) {
        perVariant[myIdx] = { variant: v, listing: null };
        unknown++;
      }
      done++;
      btn.textContent = `Pricing ${done}/${variants.length}…`;
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const total = perVariant.reduce((sum, x) => sum + (x && x.listing ? parseFloat(x.listing.price) : 0), 0);

  // Stash so the click handler can read back what we found
  const breakdownId = `rb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  _rainbowBreakdowns[breakdownId] = {
    cardLabel: `${player} #${card.number}`,
    perVariant,
    priced,
    unknown,
    total,
  };

  const tooltip = unknown > 0
    ? ` title="${unknown} variant${unknown !== 1 ? 's' : ''} had no listings — click for breakdown"`
    : ' title="Click to see the cheapest listing for each variant"';
  btn.outerHTML = `<button class="rainbow-cost-result" data-rb="${breakdownId}" onclick="showRainbowBreakdown(this)"${tooltip}>Rainbow: $${total.toFixed(2)}${unknown > 0 ? ` (${priced}/${variants.length})` : ''}</button>`;
}

// Click handler for the rainbow result pill — opens an inline panel that
// shows every variant and the cheapest listing the calculator picked.
function showRainbowBreakdown(btn) {
  const id = btn.dataset.rb;
  const data = _rainbowBreakdowns[id];
  if (!data) return;

  // Toggle: if a panel already sits right after the row/group, close it
  const inTable = !!btn.closest('tr');
  const anchor = inTable ? btn.closest('tr') : btn.closest('.completion-variants');
  if (!anchor) return;
  const existing = anchor.nextElementSibling;
  if (existing && (existing.classList.contains('cl-listings-row') || existing.classList.contains('cl-listings-block')) && existing.dataset.rbPanel === id) {
    existing.remove();
    btn.classList.remove('rainbow-cost-active');
    return;
  }

  btn.classList.add('rainbow-cost-active');

  const rows = data.perVariant.map(entry => {
    if (!entry) return '';
    const v = entry.variant;
    const pr = v.printRun ? ' /' + escHtml(v.printRun) : '';
    if (!entry.listing) {
      return `<div class="rainbow-breakdown-row missing">
        <span class="rainbow-breakdown-name">${escHtml(v.name)}${pr}</span>
        <span class="rainbow-breakdown-price">—</span>
      </div>`;
    }
    const item = entry.listing;
    return `<a class="rainbow-breakdown-row" href="${escHtml(epnUrl(item.itemUrl))}" target="_blank" rel="noopener noreferrer">
      ${item.imageUrl ? `<img class="rainbow-breakdown-img" src="${escHtml(item.imageUrl)}" alt="" loading="lazy" />` : '<div class="rainbow-breakdown-noimg">&#127183;</div>'}
      <div class="rainbow-breakdown-meta">
        <div class="rainbow-breakdown-name">${escHtml(v.name)}${pr}</div>
        <div class="rainbow-breakdown-title">${escHtml(item.title)}</div>
      </div>
      <div class="rainbow-breakdown-price">$${parseFloat(item.price).toFixed(2)}</div>
    </a>`;
  }).join('');

  const innerHtml = `
    <div class="cl-listings-panel rainbow-breakdown-panel">
      <div class="cl-listings-header">
        <span class="cl-listings-title">${escHtml(data.cardLabel)} — Rainbow breakdown · $${data.total.toFixed(2)}${data.unknown > 0 ? ` (${data.priced}/${data.perVariant.length})` : ''}</span>
        <button class="cl-listings-close" title="Close">&times;</button>
      </div>
      <div class="rainbow-breakdown-list">${rows}</div>
    </div>`;

  let panel;
  if (inTable) {
    panel = document.createElement('tr');
    panel.className = 'cl-listings-row';
    const colCount = anchor.cells.length || 4;
    panel.innerHTML = `<td colspan="${colCount}">${innerHtml}</td>`;
  } else {
    panel = document.createElement('div');
    panel.className = 'cl-listings-block';
    panel.innerHTML = innerHtml;
  }
  panel.dataset.rbPanel = id;
  anchor.parentNode.insertBefore(panel, anchor.nextSibling);
  panel.querySelector('.cl-listings-close').addEventListener('click', () => {
    panel.remove();
    btn.classList.remove('rainbow-cost-active');
  });
}

// ---- Completion Sub-tabs & Player Completion ----
function switchCompletionSubtab(tab) {
  document.querySelectorAll('.completion-subtab').forEach(b => b.classList.toggle('active', b.dataset.subtab === tab));
  document.getElementById('completion-set-panel').style.display = tab === 'set' ? '' : 'none';
  document.getElementById('completion-player-panel').style.display = tab === 'player' ? '' : 'none';
  const rb = document.getElementById('completion-rainbow-panel');
  if (rb) rb.style.display = tab === 'rainbow' ? '' : 'none';
  if (tab === 'player' && completionData) loadPlayerCompletion();
  if (tab === 'rainbow') renderRainbowView();
}

function populatePlayerSelect() {
  const select = document.getElementById('completion-player-select');
  // "All players" is the default — shows every player's chips across every set
  // in one scroll, so the click-to-listings + Rainbow cost features work for
  // anyone without re-selecting.
  select.innerHTML = '<option value="__ALL__">All players</option>';
  if (!completionData) return;

  const players = new Set();
  completionData.sets.forEach(set => {
    (set.cards || []).forEach(c => { if (c.player) players.add(c.player); });
  });

  [...players].sort().forEach(p => {
    const opt = document.createElement('option');
    opt.value = p;
    opt.textContent = p;
    select.appendChild(opt);
  });
  syncComboboxFromSelect(document.getElementById('cl-combo-player'));
}

// ---- Searchable Combobox ----
// Backs a hidden <select> so existing onchange handlers still fire.
// Used for both the product selector and the player selector under
// Set Completion.
function setupCombobox(comboEl) {
  if (!comboEl || comboEl._wired) return;
  comboEl._wired = true;
  const toggle = comboEl.querySelector('.cl-combo-toggle');
  const panel = comboEl.querySelector('.cl-combo-panel');
  const search = comboEl.querySelector('.cl-combo-search');
  const list = comboEl.querySelector('.cl-combo-list');
  const select = document.getElementById(comboEl.dataset.target);
  if (!select) return;

  function close() { panel.classList.add('hidden'); search.value = ''; renderList(''); }
  function open() {
    panel.classList.remove('hidden');
    renderList('');
    setTimeout(() => search.focus(), 0);
  }
  function renderList(filter) {
    const f = filter.toLowerCase().trim();
    const items = Array.from(select.options).filter(o => o.textContent.toLowerCase().includes(f));
    if (items.length === 0) {
      list.innerHTML = '<div class="cl-combo-empty">No matches</div>';
      return;
    }
    list.innerHTML = items.map(o =>
      `<button type="button" class="cl-combo-item${o.value === select.value ? ' active' : ''}" data-value="${escHtml(o.value)}">${escHtml(o.textContent)}</button>`
    ).join('');
    list.querySelectorAll('.cl-combo-item').forEach(btn => {
      btn.addEventListener('click', () => {
        select.value = btn.dataset.value;
        comboEl.querySelector('.cl-combo-value').textContent = btn.textContent;
        select.dispatchEvent(new Event('change'));
        close();
      });
    });
  }

  toggle.addEventListener('click', () => {
    if (panel.classList.contains('hidden')) open();
    else close();
  });
  search.addEventListener('input', () => renderList(search.value));
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { close(); toggle.focus(); }
    if (e.key === 'Enter') {
      const first = list.querySelector('.cl-combo-item');
      if (first) first.click();
    }
  });
  // Click outside closes
  document.addEventListener('click', (e) => {
    if (!comboEl.contains(e.target)) close();
  });
}

function syncComboboxFromSelect(comboEl) {
  if (!comboEl) return;
  setupCombobox(comboEl);
  const select = document.getElementById(comboEl.dataset.target);
  if (!select) return;
  const sel = select.options[select.selectedIndex];
  const label = comboEl.querySelector('.cl-combo-value');
  if (label) label.textContent = sel ? sel.textContent : (comboEl.dataset.placeholder || 'Select…');
}

// Wire both comboboxes once on load
document.addEventListener('DOMContentLoaded', () => {
  setupCombobox(document.getElementById('cl-combo-product'));
  setupCombobox(document.getElementById('cl-combo-player'));
});

function loadPlayerCompletion() {
  const selected = document.getElementById('completion-player-select').value;
  const setsEl = document.getElementById('player-completion-sets');
  const progressEl = document.getElementById('player-completion-progress');
  if (!selected || !completionData) { setsEl.innerHTML = ''; progressEl.classList.add('hidden'); return; }

  const allMode = selected === '__ALL__';
  const state = getCompletionState();
  const productKey = completionData.id || completionData.name;
  const owned = state[productKey] || {};
  const year = completionData.year || '2025';
  const brand = (completionData.brand || 'Bowman').replace(/'/g, "\\'");

  let totalCards = 0, ownedCount = 0;
  let html = '';

  completionData.sets.forEach((set, si) => {
    const setKey = `s${si}`;
    const allCards = (set.cards || []).map((c, ci) => ({ ...c, ci }));
    // In single-player mode, narrow to that player. In All mode, keep all.
    const cardsHere = allMode ? allCards : allCards.filter(c => c.player === selected);
    if (cardsHere.length === 0) return;

    // Always show all variants (rainbow) for player completion
    const variants = buildVariants(set);

    // Group this set's visible cards by player so each player gets their own
    // chip row inside the set's expandable body.
    const byPlayer = new Map();
    for (const c of cardsHere) {
      const p = c.player || 'Unknown';
      if (!byPlayer.has(p)) byPlayer.set(p, []);
      byPlayer.get(p).push(c);
    }

    let setTotal = 0, setOwned = 0;
    cardsHere.forEach(c => {
      variants.forEach((v, vi) => {
        setTotal++;
        const key = `${setKey}_c${c.ci}_v${vi}`;
        if (owned[key]) setOwned++;
      });
    });

    totalCards += setTotal;
    ownedCount += setOwned;
    const pct = setTotal > 0 ? Math.round((setOwned / setTotal) * 100) : 0;
    const isComplete = pct === 100;

    const categoryBadge = set.category === 'autograph' ? '<span class="checklist-badge auto">AUTO</span>'
      : set.category === 'memorabilia' ? '<span class="checklist-badge memo">MEMO</span>'
      : set.category === 'insert' ? '<span class="checklist-badge insert">INSERT</span>'
      : '<span class="checklist-badge base">BASE</span>';

    const setNameEsc = set.name.replace(/'/g, "\\'");
    const category = set.category || 'base';

    html += `<div class="completion-set ${isComplete ? 'complete' : ''}">
      <div class="completion-set-header" onclick="togglePlayerCompletionSet(${si})">
        ${categoryBadge}
        <span class="completion-set-name">${escHtml(set.name)}</span>
        <span class="completion-set-count">${setOwned}/${setTotal} (${pct}%)</span>
        <div class="completion-mini-bar"><div class="completion-mini-fill" style="width:${pct}%"></div></div>
      </div>
      <div class="completion-set-cards hidden" id="player-completion-cards-${si}">`;

    // One player-group per player in this set
    for (const [playerName, playerCards] of byPlayer.entries()) {
      const playerEsc = escHtml(playerName).replace(/'/g, "\\'");
      const firstCard = playerCards[0];
      const cardNum = escHtml(firstCard.number).replace(/'/g, "\\'");
      const printRun = firstCard.printRun ? String(firstCard.printRun) : '';

      let pTotal = 0, pOwned = 0;
      playerCards.forEach(c => variants.forEach((v, vi) => {
        pTotal++;
        if (owned[`${setKey}_c${c.ci}_v${vi}`]) pOwned++;
      }));
      const pPct = pTotal > 0 ? Math.round((pOwned / pTotal) * 100) : 0;

      html += `<div class="completion-player-group">
        <div class="completion-player-header">
          <span class="completion-player-num">${playerCards.map(c => '#' + escHtml(c.number)).join(', ')}</span>
          <a href="#" class="completion-player-name" onclick="event.preventDefault(); toggleCompletionListings(this, '${playerEsc}', '${year}', '${brand}', '${setNameEsc}', '${category}', '${cardNum}', '${printRun}')">${escHtml(playerName)}</a>
          <span class="completion-player-team">${escHtml(firstCard.team || '')}</span>
          <span class="completion-player-pct ${pPct === 100 ? 'complete' : ''}">${pOwned}/${pTotal}</span>
        </div>
        <div class="completion-variants">`;

      playerCards.forEach(c => {
        const cardNumEsc = escHtml(c.number).replace(/'/g, "\\'");
        variants.forEach((v, vi) => {
          const key = `${setKey}_c${c.ci}_v${vi}`;
          const checked = owned[key] ? 'checked' : '';
          const prDisplay = v.printRun ? ' /' + v.printRun : (c.printRun ? ' /' + c.printRun : '');
          const variantNameEsc = (v.name || '').replace(/'/g, "\\'");
          const variantPr = v.printRun ? String(v.printRun) : (c.printRun ? String(c.printRun) : '');
          html += `<label class="completion-variant-check ${owned[key] ? 'owned' : ''}">
            <input type="checkbox" ${checked} onchange="togglePlayerCompletionCard('${productKey}','${key}',this)" />
            <span class="completion-variant-text" onclick="event.preventDefault(); event.stopPropagation(); openVariantListings(this, '${playerEsc}', '${year}', '${brand}', '${setNameEsc}', '${category}', '${cardNumEsc}', '${variantNameEsc}', '${variantPr}')">${escHtml(v.name)}${prDisplay}</span>
          </label>`;
        });
        // Rainbow cost button per card row when Rainbow Mode is on
        if (rainbowMode && variants.length > 1) {
          html += `<button class="rainbow-cost-btn" onclick="calculateRainbowCost(this, '${productKey}','${setKey}_c${c.ci}','${playerEsc}','${year}','${brand}','${setNameEsc}','${category}','${cardNumEsc}', ${c.ci})">Rainbow $?</button>`;
        }
      });

      html += `</div>
        <div class="completion-player-listings-slot"></div>
      </div>`;
    }

    html += `</div></div>`;
  });

  if (!html) html = '<p style="color:var(--text-muted);font-size:0.85rem;text-align:center;padding:2rem;">No cards found for this selection.</p>';
  setsEl.innerHTML = html;
  progressEl.classList.remove('hidden');

  const overallPct = totalCards > 0 ? Math.round((ownedCount / totalCards) * 100) : 0;
  document.getElementById('player-completion-bar').style.width = overallPct + '%';
  document.getElementById('player-completion-text').textContent = `${ownedCount} / ${totalCards} cards (${overallPct}%)`;
}

function togglePlayerCompletionSet(idx) {
  const el = document.getElementById(`player-completion-cards-${idx}`);
  if (!el) return;
  const isHidden = el.classList.toggle('hidden');
  const setEl = el.closest('.completion-set');
  if (setEl) setEl.classList.toggle('expanded', !isHidden);
}

function togglePlayerCompletionCard(productKey, cardKey, checkbox) {
  const state = getCompletionState();
  if (!state[productKey]) state[productKey] = {};
  if (checkbox.checked) {
    state[productKey][cardKey] = true;
  } else {
    delete state[productKey][cardKey];
  }
  saveCompletionState(state);

  // Update label styling in-place — full re-render on every check was both
  // collapsing the expanded set the user was working in (terrible UX) and
  // making every click feel laggy (rebuilding 50+ player groups + the set
  // view from scratch).
  const label = checkbox.closest('.completion-variant-check');
  if (label) label.classList.toggle('owned', checkbox.checked);

  // Counts stay accurate without a re-render.
  updateCompletionCounts();
}

// ---- Hot/Cold Cards ----
function loadHotCold(days) {
  document.querySelectorAll('.hotcold-period-btn').forEach(b => b.classList.toggle('active', parseInt(b.dataset.days) === days));
  const listEl = document.getElementById('hotcold-list');
  // Use price history from localStorage
  const history = JSON.parse(localStorage.getItem('cardHuddlePriceHistory') || '{}');
  const movers = [];
  const now = Date.now();
  const cutoff = now - days * 86400000;

  for (const [query, entries] of Object.entries(history)) {
    if (entries.length < 2) continue;
    const recent = entries.filter(e => new Date(e.date).getTime() >= cutoff);
    if (recent.length < 1) continue;
    const oldest = entries[0];
    const newest = entries[entries.length - 1];
    const change = newest.avg - oldest.avg;
    const pctChange = oldest.avg > 0 ? (change / oldest.avg) * 100 : 0;
    movers.push({ query, oldAvg: oldest.avg, newAvg: newest.avg, change, pctChange });
  }

  movers.sort((a, b) => Math.abs(b.pctChange) - Math.abs(a.pctChange));

  if (movers.length === 0) {
    listEl.innerHTML = '<p class="hotcold-empty">Not enough price data yet. Search for cards to build price history.</p>';
    return;
  }

  listEl.innerHTML = movers.slice(0, 20).map(m => {
    const isHot = m.change > 0;
    return `<div class="hotcold-item ${isHot ? 'hot' : 'cold'}">
      <span class="hotcold-icon">${isHot ? '&#128293;' : '&#10052;'}</span>
      <span class="hotcold-query">${escHtml(m.query)}</span>
      <span class="hotcold-change ${isHot ? 'gain' : 'loss'}">${isHot ? '+' : ''}${m.pctChange.toFixed(1)}%</span>
      <span class="hotcold-prices">$${m.oldAvg.toFixed(2)} &rarr; $${m.newAvg.toFixed(2)}</span>
    </div>`;
  }).join('');
}

// ---- eBay Seller Section ----

// Seller sub-tab switching
// Legacy shim. The Sell tab is now the Showcase; the pricing/promote tools
// moved to their own Tools (proplus) tab. Old sub-tab names are routed to
// wherever those features live now so any remaining callers keep working.
function switchSellerTab(tab) {
  if (tab === 'autopricer' || tab === 'bulkpricer' || tab === 'promote') {
    switchView('proplus');
    switchProPlusTab(tab === 'bulkpricer' ? 'bulkprice' : tab === 'promote' ? 'promote' : 'autoprices');
    return;
  }
  switchView('seller');
}

// =====================================================================
// Showcase (Sell tab)
// A public-style "virtual table" of your cards. Each card can be marked
// for sale (hands off to an eBay listing/search) or for trade (hands off
// to Veriswap) — The Card Huddle is not part of the transaction.
// Stored client-side for now (synced via schedulePushUserData), the same
// way the collection and seller listings are.
// =====================================================================
const SHOWCASE_KEY = 'cardHuddleShowcase';
const SHOWCASE_SETTINGS_KEY = 'cardHuddleShowcaseSettings';

function getShowcase() {
  try { return JSON.parse(localStorage.getItem(SHOWCASE_KEY) || '[]'); }
  catch { return []; }
}
function saveShowcase(items) {
  localStorage.setItem(SHOWCASE_KEY, JSON.stringify(items));
  schedulePushUserData();
}
function getShowcaseSettings() {
  try { return JSON.parse(localStorage.getItem(SHOWCASE_SETTINGS_KEY) || '{}'); }
  catch { return {}; }
}
function saveShowcaseSettings() {
  const settings = {
    ebayStore: (document.getElementById('showcase-ebay-store')?.value || '').trim(),
    veriswap: (document.getElementById('showcase-veriswap')?.value || '').trim(),
  };
  localStorage.setItem(SHOWCASE_SETTINGS_KEY, JSON.stringify(settings));
  schedulePushUserData();
}

// Build a readable card name from a saved collection card.
function _scCollName(c) {
  if (c.player) {
    return [c.player, c.year, c.brand, c.setName, c.parallel].filter(Boolean).join(' ');
  }
  return c.name || 'Card';
}

// Normalize a Veriswap profile value into a link. Their public URL scheme
// isn't documented, so we make a best effort: full URLs are used as-is,
// "@handle"/"handle" map to veriswap.com/<handle>, otherwise we point at
// veriswap.com so the button always goes somewhere sensible.
function _veriswapLink(v) {
  v = (v || '').trim();
  if (!v) return 'https://veriswap.com';
  if (/^https?:\/\//i.test(v)) return v;
  if (v.startsWith('@')) return 'https://veriswap.com/' + encodeURIComponent(v.slice(1));
  if (v.includes('.') || v.includes('/')) return 'https://' + v.replace(/^\/+/, '');
  return 'https://veriswap.com/' + encodeURIComponent(v);
}

// Where a "For sale" card sends the buyer: its own eBay listing if given,
// otherwise an eBay search for the title (affiliate-wrapped via epnUrl).
function _showcaseEbayLink(entry) {
  const url = (entry.ebayUrl || '').trim();
  if (url) return epnUrl(/^https?:\/\//i.test(url) ? url : 'https://' + url);
  return epnUrl(`https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(entry.title || '')}`);
}

function _showcaseTradeLink(entry) {
  const settings = getShowcaseSettings();
  return _veriswapLink((entry.veriswapUrl || '').trim() || settings.veriswap || '');
}

function initShowcase() {
  const settings = getShowcaseSettings();
  const ebayEl = document.getElementById('showcase-ebay-store');
  const vsEl = document.getElementById('showcase-veriswap');
  if (ebayEl) ebayEl.value = settings.ebayStore || '';
  if (vsEl) vsEl.value = settings.veriswap || '';
  renderShowcase();
}

function renderShowcase() {
  const grid = document.getElementById('showcase-grid');
  if (!grid) return;
  const items = getShowcase();
  if (!items.length) {
    grid.innerHTML = `
      <div class="showcase-empty">
        <div class="showcase-empty-icon">&#127937;</div>
        <h3>Your showcase is empty</h3>
        <p>Build your virtual table in three steps:</p>
        <ol>
          <li>Add cards from <strong>My Cards</strong> (or add one manually).</li>
          <li>Mark each card <strong>For sale</strong> or <strong>For trade</strong>.</li>
          <li>Buyers tap through to <strong>eBay</strong>; traders tap through to <strong>Veriswap</strong>.</li>
        </ol>
      </div>`;
    return;
  }
  grid.innerHTML = items.map(it => {
    const img = it.imageUrl
      ? `<img class="sc-card-img" src="${escHtml(it.imageUrl)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'" />`
      : '<div class="sc-card-img sc-card-noimg">No Image</div>';
    const price = (typeof it.price === 'number' && it.price > 0)
      ? `<span class="sc-card-price">$${it.price.toFixed(2)}</span>` : '';
    const forSale = it.status === 'sale' || it.status === 'both';
    const forTrade = it.status === 'trade' || it.status === 'both';
    const badges = [];
    if (forSale) badges.push('<span class="sc-badge sc-badge-sale">For Sale</span>');
    if (forTrade) badges.push('<span class="sc-badge sc-badge-trade">For Trade</span>');
    if (!forSale && !forTrade) badges.push('<span class="sc-badge sc-badge-show">Showcase</span>');
    if (it.valueBox) badges.push('<span class="sc-badge sc-badge-value">Value Box</span>');
    const links = [];
    if (forSale) links.push(`<a class="sc-link sc-link-ebay" href="${escHtml(_showcaseEbayLink(it))}" target="_blank" rel="noopener noreferrer">Buy on eBay &#8599;</a>`);
    if (forTrade) links.push(`<a class="sc-link sc-link-trade" href="${escHtml(_showcaseTradeLink(it))}" target="_blank" rel="noopener noreferrer">Trade on Veriswap &#8599;</a>`);
    return `<div class="sc-card">
      ${img}
      <div class="sc-card-body">
        <div class="sc-card-badges">${badges.join('')}</div>
        <div class="sc-card-title">${escHtml(it.title || 'Card')}</div>
        ${it.note ? `<div class="sc-card-note">${escHtml(it.note)}</div>` : ''}
        ${price}
        <div class="sc-card-links">${links.join('')}</div>
        <div class="sc-card-actions">
          <button type="button" onclick="openShowcaseEdit('${it.id}')">Edit</button>
          <button type="button" class="sc-del-btn" onclick="removeShowcaseCard('${it.id}')">Remove</button>
        </div>
      </div>
    </div>`;
  }).join('');
}

function removeShowcaseCard(id) {
  saveShowcase(getShowcase().filter(it => it.id !== id));
  renderShowcase();
}

// --- Add from My Cards picker ---
function openShowcasePicker() {
  const modal = document.getElementById('showcase-picker-modal');
  const body = document.getElementById('showcase-picker-body');
  if (!modal || !body) return;
  const coll = getCollection();
  if (!coll.length) {
    body.innerHTML = `<p class="seller-empty">You don't have any cards in My Cards yet. Add some there first, or use <strong>+ Add Manually</strong>.</p>`;
  } else {
    body.innerHTML = `
      <div class="sc-picker-list">
        ${coll.map((c, i) => {
          const name = _scCollName(c);
          const img = c.imageUrl
            ? `<img src="${escHtml(c.imageUrl)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'" />`
            : '<span class="sc-picker-noimg"></span>';
          const val = (c.estValue > 0) ? `$${c.estValue.toFixed(2)}` : '';
          return `<label class="sc-picker-row">
            <input type="checkbox" class="sc-picker-check" value="${i}" />
            ${img}
            <span class="sc-picker-name">${escHtml(name)}</span>
            <span class="sc-picker-val">${val}</span>
          </label>`;
        }).join('')}
      </div>
      <button type="button" class="seller-save-btn" style="margin-top:0.75rem" onclick="addSelectedToShowcase()">Add selected</button>`;
  }
  modal.classList.remove('hidden');
}
function closeShowcasePicker() {
  document.getElementById('showcase-picker-modal')?.classList.add('hidden');
}
function addSelectedToShowcase() {
  const coll = getCollection();
  const items = getShowcase();
  const checks = document.querySelectorAll('.sc-picker-check:checked');
  let added = 0;
  checks.forEach(ch => {
    const c = coll[parseInt(ch.value, 10)];
    if (!c) return;
    items.push({
      id: 'sc_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      title: _scCollName(c),
      imageUrl: c.imageUrl || '',
      price: (typeof c.estValue === 'number' && c.estValue > 0) ? c.estValue : null,
      status: 'showcase',
      ebayUrl: '',
      veriswapUrl: '',
      note: '',
    });
    added++;
  });
  if (added) saveShowcase(items);
  closeShowcasePicker();
  renderShowcase();
}

// --- Add / edit a single showcase card ---
function openShowcaseManual() { openShowcaseEdit(null); }

function openShowcaseEdit(id) {
  const modal = document.getElementById('showcase-edit-modal');
  const body = document.getElementById('showcase-edit-body');
  const titleEl = document.getElementById('showcase-edit-title');
  if (!modal || !body) return;
  const entry = id ? getShowcase().find(it => it.id === id) : null;
  if (titleEl) titleEl.textContent = entry ? 'Edit Showcase Card' : 'Add to Showcase';
  const e = entry || { title: '', imageUrl: '', price: null, status: 'showcase', ebayUrl: '', veriswapUrl: '', note: '', valueBox: false };
  body.innerHTML = `
    <div class="sc-edit-grid">
      <label class="sc-edit-full">Card title
        <input type="text" id="sc-edit-title" value="${escHtml(e.title || '')}" placeholder="e.g. 2023 Prizm Justin Jefferson Silver /199" />
      </label>
      <label>Status
        <select id="sc-edit-status">
          <option value="showcase"${e.status === 'showcase' ? ' selected' : ''}>Showcase only</option>
          <option value="sale"${e.status === 'sale' ? ' selected' : ''}>For sale (eBay)</option>
          <option value="trade"${e.status === 'trade' ? ' selected' : ''}>For trade (Veriswap)</option>
          <option value="both"${e.status === 'both' ? ' selected' : ''}>Sale + trade</option>
        </select>
      </label>
      <label>Price ($)
        <input type="number" id="sc-edit-price" step="0.01" min="0" value="${(typeof e.price === 'number' && e.price > 0) ? e.price : ''}" placeholder="optional" />
      </label>
      <label class="sc-edit-full">Image URL <span class="sc-opt">(optional)</span>
        <input type="url" id="sc-edit-image" value="${escHtml(e.imageUrl || '')}" placeholder="https://i.ebayimg.com/..." />
      </label>
      <label class="sc-edit-full">eBay listing URL <span class="sc-opt">(optional — defaults to an eBay search)</span>
        <input type="url" id="sc-edit-ebay" value="${escHtml(e.ebayUrl || '')}" placeholder="https://www.ebay.com/itm/..." />
      </label>
      <label class="sc-edit-full">Veriswap profile <span class="sc-opt">(optional — defaults to your profile above)</span>
        <input type="text" id="sc-edit-veriswap" value="${escHtml(e.veriswapUrl || '')}" placeholder="veriswap.com/yourname" />
      </label>
      <label class="sc-edit-full">Note <span class="sc-opt">(optional)</span>
        <input type="text" id="sc-edit-note" value="${escHtml(e.note || '')}" placeholder="e.g. open to offers, mint corners" />
      </label>
      <label class="sc-edit-full sc-edit-check">
        <input type="checkbox" id="sc-edit-valuebox"${e.valueBox ? ' checked' : ''} />
        <span>Put in value box <span class="sc-opt">(dollar-box / bulk — shown in its own Value Box menu on The Floor)</span></span>
      </label>
    </div>
    <button type="button" class="seller-save-btn" style="margin-top:0.75rem" onclick="saveShowcaseCard('${id || ''}')">${entry ? 'Save changes' : 'Add to showcase'}</button>`;
  modal.classList.remove('hidden');
}
function closeShowcaseEdit() {
  document.getElementById('showcase-edit-modal')?.classList.add('hidden');
}
function saveShowcaseCard(id) {
  const title = (document.getElementById('sc-edit-title')?.value || '').trim();
  if (!title) { alert('Please enter a card title.'); return; }
  const priceRaw = parseFloat(document.getElementById('sc-edit-price')?.value);
  const data = {
    title,
    imageUrl: (document.getElementById('sc-edit-image')?.value || '').trim(),
    price: (!isNaN(priceRaw) && priceRaw > 0) ? priceRaw : null,
    status: document.getElementById('sc-edit-status')?.value || 'showcase',
    ebayUrl: (document.getElementById('sc-edit-ebay')?.value || '').trim(),
    veriswapUrl: (document.getElementById('sc-edit-veriswap')?.value || '').trim(),
    note: (document.getElementById('sc-edit-note')?.value || '').trim(),
    valueBox: !!document.getElementById('sc-edit-valuebox')?.checked,
  };
  const items = getShowcase();
  if (id) {
    const idx = items.findIndex(it => it.id === id);
    if (idx >= 0) items[idx] = { ...items[idx], ...data };
  } else {
    items.push({ id: 'sc_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7), ...data });
  }
  saveShowcase(items);
  closeShowcaseEdit();
  renderShowcase();
}

// ============================ Direct Messages ============================
// One-to-one chat so a buyer can DM a booth owner to negotiate a card. Opens
// from the Floor (HUD "Messages" and the per-card "Negotiate" button).
let _dmActiveUser = null;      // username of the open conversation
let _dmStagedCard = null;      // card being negotiated (attached to the next send)
let _dmPollTimer = null;

// Open the floor chat panel. mode = 'floor' (everyone) | 'direct' (DMs).
function openChat(mode) {
  if (!getCurrentUser()) { if (typeof openLoginModal === 'function') openLoginModal(); else alert('Sign in to use chat.'); return; }
  document.getElementById('chat-overlay')?.classList.remove('hidden');
  switchChatTab(mode || 'floor');
}
function closeChat() {
  document.getElementById('chat-overlay')?.classList.add('hidden');
  _dmStagedCard = null;
}
function switchChatTab(tab) {
  document.querySelectorAll('.chat-tab').forEach(b => b.classList.toggle('active', b.dataset.chatTab === tab));
  document.getElementById('chat-floor')?.classList.toggle('hidden', tab !== 'floor');
  document.getElementById('chat-direct')?.classList.toggle('hidden', tab !== 'direct');
  if (tab === 'floor') { if (typeof floorChatActivate === 'function') floorChatActivate(); }
  else loadDmThreads(!_dmActiveUser);
}
// Jump straight into a DM, optionally staging a card to negotiate.
function openDM(user, card) {
  if (!user) return;
  if (!getCurrentUser()) { if (typeof openLoginModal === 'function') openLoginModal(); else alert('Sign in to message collectors.'); return; }
  document.getElementById('floor-booth-modal')?.classList.add('hidden');
  document.getElementById('chat-overlay')?.classList.remove('hidden');
  switchChatTab('direct');
  _dmStagedCard = card && card.title ? card : null;
  openDmConvo(String(user).toLowerCase());
  loadDmThreads(false);
}

async function loadDmThreads(autoOpenFirst) {
  const wrap = document.getElementById('dm-threads');
  if (!wrap) return;
  try {
    const res = await authFetch('/api/dm/threads');
    const data = await res.json();
    const threads = Array.isArray(data.threads) ? data.threads : [];
    if (!threads.length) {
      wrap.innerHTML = '<p class="dm-empty">No messages yet. Visit a booth on The Floor and hit <strong>Negotiate</strong> on a card to start a chat.</p>';
    } else {
      wrap.innerHTML = threads.map(t => `
        <button type="button" class="dm-thread${t.user === _dmActiveUser ? ' active' : ''}" data-dm-open="${escHtml(t.user)}">
          <span class="dm-thread-name">${escHtml(t.user)}</span>
          ${t.unread ? `<span class="dm-thread-unread">${t.unread}</span>` : ''}
          <span class="dm-thread-last">${escHtml(t.lastMessage || '')}</span>
        </button>`).join('');
    }
    if (autoOpenFirst && !_dmActiveUser && threads.length) openDmConvo(threads[0].user);
    refreshDmUnread();
  } catch (_) { wrap.innerHTML = '<p class="dm-empty">Couldn’t load messages.</p>'; }
}

async function openDmConvo(user) {
  _dmActiveUser = user;
  const head = document.getElementById('dm-convo-head');
  const list = document.getElementById('dm-messages');
  const convo = document.getElementById('dm-convo');
  if (convo) convo.classList.add('open');
  if (head) head.innerHTML = `<button type="button" class="dm-back" onclick="dmBack()">&larr;</button><span class="dm-convo-name">${escHtml(user)}</span>`;
  if (list) list.innerHTML = '<p class="dm-empty">Loading…</p>';
  renderDmStagedCard();
  document.querySelectorAll('.dm-thread').forEach(el => el.classList.toggle('active', el.dataset.dmOpen === user));
  try {
    const res = await authFetch('/api/dm/with/' + encodeURIComponent(user));
    const data = await res.json();
    renderDmMessages(Array.isArray(data.messages) ? data.messages : []);
    refreshDmUnread();
  } catch (_) { if (list) list.innerHTML = '<p class="dm-empty">Couldn’t load this conversation.</p>'; }
}
function dmBack() { document.getElementById('dm-convo')?.classList.remove('open'); }

function renderDmMessages(messages) {
  const list = document.getElementById('dm-messages');
  if (!list) return;
  const me = (getCurrentUser() || '').toLowerCase();
  if (!messages.length) { list.innerHTML = '<p class="dm-empty">No messages yet — say hello and make an offer.</p>'; return; }
  list.innerHTML = messages.map(m => {
    const mine = m.from === me;
    const card = m.card ? `<div class="dm-msg-card">${m.card.imageUrl ? `<img src="${escHtml(m.card.imageUrl)}" alt="" onerror="this.remove()" />` : ''}<span>📇 ${escHtml(m.card.title)}${(typeof m.card.price === 'number' && m.card.price > 0) ? ` · $${m.card.price.toFixed(2)}` : ''}</span></div>` : '';
    const text = m.text ? `<div class="dm-msg-text">${escHtml(m.text)}</div>` : '';
    return `<div class="dm-msg ${mine ? 'mine' : 'theirs'}">${card}${text}<div class="dm-msg-time">${dmTime(m.at)}</div></div>`;
  }).join('');
  list.scrollTop = list.scrollHeight;
}
function renderDmStagedCard() {
  const el = document.getElementById('dm-card-stage');
  if (!el) return;
  if (_dmStagedCard && _dmStagedCard.title) {
    el.classList.remove('hidden');
    el.innerHTML = `<span class="dm-stage-label">Negotiating:</span> ${_dmStagedCard.imageUrl ? `<img src="${escHtml(_dmStagedCard.imageUrl)}" alt="" onerror="this.remove()" />` : ''}<span class="dm-stage-title">${escHtml(_dmStagedCard.title)}${(typeof _dmStagedCard.price === 'number' && _dmStagedCard.price > 0) ? ` · $${_dmStagedCard.price.toFixed(2)}` : ''}</span><button type="button" class="dm-stage-x" onclick="dmClearCard()">&times;</button>`;
  } else { el.classList.add('hidden'); el.innerHTML = ''; }
}
function dmClearCard() { _dmStagedCard = null; renderDmStagedCard(); }

async function dmSend(ev) {
  if (ev && ev.preventDefault) ev.preventDefault();
  const input = document.getElementById('dm-input');
  const text = (input?.value || '').trim();
  if (!_dmActiveUser) return false;
  if (!text && !_dmStagedCard) return false;
  try {
    const res = await authFetch('/api/dm/send', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: _dmActiveUser, text, card: _dmStagedCard }),
    });
    const data = await res.json();
    if (!res.ok) { alert(data.error || 'Couldn’t send that message.'); return false; }
    if (input) input.value = '';
    _dmStagedCard = null; renderDmStagedCard();
    await openDmConvo(_dmActiveUser);
    loadDmThreads(false);
  } catch (_) { alert('Couldn’t send that message.'); }
  return false;
}

function dmTime(iso) {
  try { const d = new Date(iso); return d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }
  catch (_) { return ''; }
}

async function refreshDmUnread() {
  if (!getCurrentUser()) { updateDmBadge(0); return; }
  try { const res = await authFetch('/api/dm/unread'); const data = await res.json(); updateDmBadge(data.unread || 0); }
  catch (_) { /* leave badge */ }
}
function updateDmBadge(n) {
  document.querySelectorAll('.floor-dm-badge').forEach(b => {
    if (n > 0) { b.textContent = n > 99 ? '99+' : String(n); b.classList.remove('hidden'); }
    else b.classList.add('hidden');
  });
}
function startDmPoller() {
  refreshDmUnread();
  connectDmSocket();
  if (_dmPollTimer) return;
  // a slow poll as a safety net behind the live socket (covers missed events)
  _dmPollTimer = setInterval(() => { if (!document.hidden && getCurrentUser()) refreshDmUnread(); }, 45000);
}

// ---- real-time delivery over the per-user inbox WebSocket ----
let _dmWs = null, _dmWsRetry = null;
function connectDmSocket() {
  if (_dmWs || typeof WebSocket === 'undefined') return;
  const token = (typeof getSessionToken === 'function') ? getSessionToken() : null;
  if (!token || !getCurrentUser()) return;
  let sock;
  try { const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'; sock = new WebSocket(`${proto}//${location.host}/api/dm/ws?token=${encodeURIComponent(token)}`); }
  catch (_) { return; }
  _dmWs = sock;
  sock.addEventListener('message', evt => {
    let msg; try { msg = JSON.parse(evt.data); } catch (_) { return; }
    if (msg && msg.t === 'dm') handleIncomingDm(msg);
  });
  const onClose = () => {
    if (_dmWs === sock) _dmWs = null;
    if (getCurrentUser() && !_dmWsRetry) _dmWsRetry = setTimeout(() => { _dmWsRetry = null; connectDmSocket(); }, 4000);
  };
  sock.addEventListener('close', onClose);
  sock.addEventListener('error', () => { try { sock.close(); } catch (_) {} });
}
function disconnectDmSocket() {
  if (_dmWsRetry) { clearTimeout(_dmWsRetry); _dmWsRetry = null; }
  if (_dmWs) { try { _dmWs.close(); } catch (_) {} _dmWs = null; }
}
function handleIncomingDm(msg) {
  const other = msg.with;
  const directOpen = !document.getElementById('chat-overlay')?.classList.contains('hidden')
    && !document.getElementById('chat-direct')?.classList.contains('hidden');
  if (directOpen) {
    loadDmThreads(false);
    if (_dmActiveUser && other === _dmActiveUser) openDmConvo(other);  // reloads + marks read
    else refreshDmUnread();
  } else {
    refreshDmUnread();
  }
}

// Delegated handlers for thread rows and the per-card "Negotiate" button.
document.addEventListener('click', e => {
  const open = e.target.closest('[data-dm-open]');
  if (open) { openDmConvo(open.dataset.dmOpen); return; }
  const neg = e.target.closest('.sc-link-dm');
  if (neg) {
    const d = neg.dataset;
    openDM(d.dmUser, { title: d.dmTitle || 'Card', imageUrl: d.dmImg || '', price: d.dmPrice ? parseFloat(d.dmPrice) : null });
  }
});
window.openChat = openChat;
window.closeChat = closeChat;
window.switchChatTab = switchChatTab;
window.openDM = openDM;
window.dmSend = dmSend;
window.dmBack = dmBack;
window.dmClearCard = dmClearCard;

// Title character counter
function updateTitleCount() {
  const input = document.getElementById('seller-listing-title');
  const counter = document.getElementById('listing-title-count');
  if (input && counter) counter.textContent = `${input.value.length}/80`;
}

// Toggle auction-specific fields
function toggleAuctionFields() {
  const format = document.getElementById('seller-format').value;
  const auctionFields = document.querySelectorAll('.seller-auction-field');
  const priceLabel = document.getElementById('seller-price-label');
  auctionFields.forEach(f => f.classList.toggle('hidden', format !== 'auction'));
  if (priceLabel) priceLabel.textContent = format === 'auction' ? 'Buy It Now Price ($) (optional)' : 'Buy It Now Price ($)';
  const priceInput = document.getElementById('seller-price');
  if (priceInput) priceInput.required = format !== 'auction';
}

// Toggle custom shipping field
document.addEventListener('change', e => {
  if (e.target && e.target.id === 'seller-shipping') {
    const customField = document.querySelector('.seller-custom-shipping');
    if (customField) customField.classList.toggle('hidden', e.target.value !== 'custom');
  }
});

// Get/save listings from localStorage
function getSellerListings() {
  try { return JSON.parse(localStorage.getItem('cardHuddleSellerListings') || '[]'); }
  catch { return []; }
}
function saveSellerListings(listings) {
  localStorage.setItem('cardHuddleSellerListings', JSON.stringify(listings));
  schedulePushUserData();
}

// Create listing handler
function handleCreateListing(e) {
  e.preventDefault();
  const title = document.getElementById('seller-listing-title').value.trim();
  const category = document.getElementById('seller-category').value;
  const condition = document.getElementById('seller-condition').value;
  const format = document.getElementById('seller-format').value;
  const price = parseFloat(document.getElementById('seller-price').value) || 0;
  const startBid = parseFloat(document.getElementById('seller-start-bid')?.value) || 0;
  const quantity = parseInt(document.getElementById('seller-quantity').value) || 1;
  const shipping = document.getElementById('seller-shipping').value;
  const shippingCost = parseFloat(document.getElementById('seller-shipping-cost')?.value) || 0;
  const description = document.getElementById('seller-description').value.trim();
  const listingUrl = document.getElementById('seller-listing-url').value.trim();
  const photoNotes = document.getElementById('seller-photo-notes').value.trim();

  if (!title) return;

  const listing = {
    id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
    title, category, condition, format, price, startBid, quantity,
    shipping, shippingCost, description, listingUrl, photoNotes,
    createdAt: new Date().toISOString(),
    status: 'draft'
  };

  const listings = getSellerListings();
  listings.unshift(listing);
  saveSellerListings(listings);
  clearListingForm();
  switchSellerTab('mylistings');
}

// Clear the listing form
function clearListingForm() {
  document.getElementById('create-listing-form').reset();
  updateTitleCount();
  toggleAuctionFields();
  document.querySelector('.seller-custom-shipping')?.classList.add('hidden');
}

// Render My Listings
function renderMyListings() {
  const listings = getSellerListings();
  const listEl = document.getElementById('seller-listings-list');
  const countEl = document.getElementById('seller-listing-count');
  const valueEl = document.getElementById('seller-total-value');

  // The Create Listing / My Listings UI was removed when the Sell tab
  // became the Showcase; bail if those elements aren't on the page.
  if (!listEl || !countEl || !valueEl) return;

  countEl.textContent = `${listings.length} listing${listings.length !== 1 ? 's' : ''}`;
  const totalVal = listings.reduce((s, l) => s + (l.price || l.startBid || 0) * (l.quantity || 1), 0);
  valueEl.textContent = `Est. Value: $${totalVal.toFixed(2)}`;

  if (listings.length === 0) {
    listEl.innerHTML = '<p class="seller-empty">No listing drafts yet. Create your first listing above!</p>';
    return;
  }

  const conditionLabels = {
    'ungraded-nm': 'Near Mint', 'ungraded-ex': 'Excellent', 'ungraded-vg': 'Very Good', 'ungraded-good': 'Good',
    'psa10': 'PSA 10', 'psa9': 'PSA 9', 'psa8': 'PSA 8', 'bgs10': 'BGS 10', 'bgs9.5': 'BGS 9.5', 'sgc10': 'SGC 10'
  };
  const shippingLabels = { 'free': 'Free Ship', 'standard': '$3.99 Ship', 'economy': '$2.49 Ship', 'priority': '$7.99 Ship', 'custom': 'Custom Ship' };

  listEl.innerHTML = listings.map(l => {
    const priceDisplay = l.format === 'auction'
      ? (l.startBid ? `$${l.startBid.toFixed(2)} start` : '$0.99 start') + (l.price ? ` / $${l.price.toFixed(2)} BIN` : '')
      : `$${l.price.toFixed(2)}`;
    const shipLabel = l.shipping === 'custom' ? `$${(l.shippingCost || 0).toFixed(2)} Ship` : (shippingLabels[l.shipping] || '');
    const date = new Date(l.createdAt).toLocaleDateString();
    return `<div class="seller-listing-card">
      <div class="seller-listing-info">
        <span class="seller-listing-title-text">${l.listingUrl ? `<a href="${escHtml(l.listingUrl)}" target="_blank" rel="noopener" style="color:inherit;text-decoration:underline">${escHtml(l.title)}</a>` : escHtml(l.title)}</span>
        <div class="seller-listing-meta">
          <span class="seller-listing-badge ${l.format}">${l.format === 'auction' ? 'Auction' : 'BIN'}</span>
          <span>${conditionLabels[l.condition] || l.condition}</span>
          <span>${shipLabel}</span>
          <span>Qty: ${l.quantity}</span>
          <span>${date}</span>
        </div>
      </div>
      <span class="seller-listing-price">${priceDisplay}</span>
      <div class="seller-listing-actions">
        <button onclick="editSellerListing('${l.id}')">Edit</button>
        <button onclick="copyListingToClipboard('${l.id}')">Copy</button>
        <button class="seller-delete-btn" onclick="deleteSellerListing('${l.id}')">Delete</button>
      </div>
    </div>`;
  }).join('');
}

// Delete a listing
function deleteSellerListing(id) {
  const listings = getSellerListings().filter(l => l.id !== id);
  saveSellerListings(listings);
  renderMyListings();
}

// Edit a listing — load it back into the form
function editSellerListing(id) {
  const listings = getSellerListings();
  const listing = listings.find(l => l.id === id);
  if (!listing) return;

  document.getElementById('seller-listing-title').value = listing.title;
  document.getElementById('seller-category').value = listing.category;
  document.getElementById('seller-condition').value = listing.condition;
  document.getElementById('seller-format').value = listing.format;
  document.getElementById('seller-price').value = listing.price || '';
  const startBidEl = document.getElementById('seller-start-bid');
  if (startBidEl) startBidEl.value = listing.startBid || '';
  document.getElementById('seller-quantity').value = listing.quantity || 1;
  document.getElementById('seller-shipping').value = listing.shipping;
  const shipCostEl = document.getElementById('seller-shipping-cost');
  if (shipCostEl) shipCostEl.value = listing.shippingCost || '';
  document.getElementById('seller-description').value = listing.description || '';
  document.getElementById('seller-listing-url').value = listing.listingUrl || '';
  document.getElementById('seller-photo-notes').value = listing.photoNotes || '';

  updateTitleCount();
  toggleAuctionFields();
  if (listing.shipping === 'custom') document.querySelector('.seller-custom-shipping')?.classList.remove('hidden');

  // Remove the old listing so saving creates an updated one
  deleteSellerListing(id);
  switchSellerTab('create');
}

// Copy listing details to clipboard
function copyListingToClipboard(id) {
  const listing = getSellerListings().find(l => l.id === id);
  if (!listing) return;
  const text = `Title: ${listing.title}\nPrice: $${(listing.price || 0).toFixed(2)}\nCondition: ${listing.condition}${listing.listingUrl ? `\nURL: ${listing.listingUrl}` : ''}\nDescription: ${listing.description || 'N/A'}`;
  navigator.clipboard.writeText(text);
}

// Export listings as CSV
function exportListingsCSV() {
  const listings = getSellerListings();
  if (listings.length === 0) return;
  const headers = ['Title', 'Category', 'Condition', 'Format', 'Price', 'Start Bid', 'Quantity', 'Shipping', 'Description', 'URL', 'Created'];
  const rows = listings.map(l => [
    `"${(l.title || '').replace(/"/g, '""')}"`, l.category, l.condition, l.format,
    l.price || '', l.startBid || '', l.quantity || 1, l.shipping,
    `"${(l.description || '').replace(/"/g, '""')}"`, `"${(l.listingUrl || '').replace(/"/g, '""')}"`, l.createdAt
  ]);
  const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'ebay-listings.csv'; a.click();
  URL.revokeObjectURL(url);
}

// Title Auto-Fill modal (searches checklist data)
function showTitleAutofill() {
  document.getElementById('title-autofill-modal').classList.remove('hidden');
  document.getElementById('autofill-search-input').focus();
}
function closeTitleAutofill() {
  document.getElementById('title-autofill-modal').classList.add('hidden');
}

// Search the static checklist data for cards matching a free-text query.
// Returns records shaped { year, brand, productName, setName, player, number,
// category, parallels } — replaces the never-implemented /api/player-search.
async function searchChecklistCards(query) {
  const lower = String(query).toLowerCase();
  const tokens = lower.split(/\s+/).filter(Boolean);
  const year = (lower.match(/\b(19|20)\d{2}\b/) || [])[0] || '';
  const setTerms = SCAN_KEY_SETS.filter(s => lower.includes(s));
  const stop = new Set([
    ...SCAN_KEY_SETS.join(' ').split(/\s+/), ...SCAN_KEY_PARALLEL_WORDS,
    'football', 'panini', 'topps', 'rc', 'rookie', 'auto', 'patch', 'base', 'card', 'the',
  ]);
  const playerTokens = tokens.filter(t => t.length > 1 && !/^\d{4}$/.test(t) && !stop.has(t));
  if (!playerTokens.length) return { cards: [], needPlayer: true };

  let index;
  try { index = await fetchChecklistsList(); } catch { return { cards: [] }; }
  let cands = (index.products || [])
    .map(p => {
      const hay = `${p.id} ${p.name} ${p.brand}`.toLowerCase();
      return { p, score: setTerms.reduce((s, t) => s + (hay.includes(t) ? 1 : 0), 0) };
    })
    .filter(x => (year ? String(x.p.year) === year : true) && (setTerms.length ? x.score > 0 : true))
    .sort((a, b) => b.score - a.score);
  const fileCap = (setTerms.length || year) ? 10 : 25;
  cands = cands.slice(0, fileCap).map(x => x.p);

  const datas = await Promise.all(cands.map(p => fetchChecklistProduct(p.id).catch(() => null)));
  const cards = [];
  for (const data of datas) {
    if (!data) continue;
    for (const set of data.sets || []) {
      for (const card of set.cards || []) {
        const pn = _normName(card.player);
        if (!playerTokens.every(t => pn.includes(t))) continue;
        cards.push({
          year: data.year, brand: data.brand, productName: data.name, setName: set.name,
          player: card.player, number: card.number || '', category: set.category || 'base',
          parallels: set.parallels || [],
        });
        if (cards.length >= 80) return { cards };
      }
    }
  }
  return { cards };
}

function _checklistTitleString(c, p) {
  const pr = p.printRun ? ` /${p.printRun}` : '';
  const pName = p.name ? ` ${p.name}` : '';
  const autoTag = c.category === 'autograph' ? ' AUTO' : '';
  const rcTag = /rookie|rated rookie|\brc\b/i.test(`${c.setName} ${c.category}`) ? ' RC' : '';
  let title = `${c.year} ${c.brand} ${c.player} #${c.number}${pName}${pr}${autoTag}${rcTag} Football`.replace(/\s+/g, ' ').trim();
  return title.length > 80 ? title.substring(0, 80).trim() : title;
}

// Build the title-row list shared by Auto-Fill ('use') and Generator ('copy').
function _renderTitleRows(cards, mode) {
  let html = '';
  const seen = new Set();
  for (const c of cards) {
    const variants = [{ name: '', printRun: '' }, ...(c.parallels || []).slice(0, 5)];
    for (const p of variants) {
      const title = _checklistTitleString(c, p);
      if (seen.has(title)) continue;
      seen.add(title);
      const esc = title.replace(/'/g, "\\'").replace(/"/g, '&quot;');
      const btn = mode === 'autofill'
        ? `<button class="listing-copy-btn" onclick="useAutofillTitle('${esc}')">Use</button>`
        : `<button class="listing-copy-btn" onclick="navigator.clipboard.writeText('${esc}');this.textContent='Copied!';setTimeout(()=>this.textContent='Copy',1500)">Copy</button>`;
      html += `<div class="listing-title-row">
        <span class="listing-title-text">${escHtml(title)}</span>
        <span class="listing-title-len">${title.length}/80</span>
        ${btn}
      </div>`;
      if (seen.size >= 60) return html;
    }
  }
  return html;
}

async function searchAutofillTitles() {
  const q = document.getElementById('autofill-search-input').value.trim();
  const resultsEl = document.getElementById('autofill-results');
  if (!q || q.length < 2) return;

  resultsEl.innerHTML = '<div class="checklist-loading"><div class="spinner"></div><span>Searching checklist…</span></div>';
  try {
    const { cards, needPlayer } = await searchChecklistCards(q);
    if (needPlayer) { resultsEl.innerHTML = '<p>Include a player name (e.g. "Mahomes Prizm" or "2023 Justin Jefferson").</p>'; return; }
    if (!cards.length) { resultsEl.innerHTML = '<p>No matching cards found. Try adding the set or year.</p>'; return; }
    resultsEl.innerHTML = _renderTitleRows(cards, 'autofill') || '<p>No titles generated. Try a different search.</p>';
  } catch (err) {
    resultsEl.innerHTML = `<p>Error: ${escHtml(err.message)}</p>`;
  }
}

// Use a generated title and fill the listing form
function useAutofillTitle(title) {
  document.getElementById('seller-listing-title').value = title;
  updateTitleCount();
  closeTitleAutofill();
}

// Title Generator tab (standalone — same as old listing helper)
async function generateListingTitles() {
  const q = document.getElementById('listing-helper-input').value.trim();
  const resultsEl = document.getElementById('listing-helper-results');
  if (!q || q.length < 2) return;

  resultsEl.innerHTML = '<div class="checklist-loading"><div class="spinner"></div><span>Searching checklist…</span></div>';
  try {
    const { cards, needPlayer } = await searchChecklistCards(q);
    if (needPlayer) { resultsEl.innerHTML = '<p>Include a player name (e.g. "Mahomes Prizm" or "2023 Justin Jefferson").</p>'; return; }
    if (!cards.length) { resultsEl.innerHTML = '<p>No matching cards found. Try adding the set or year.</p>'; return; }
    resultsEl.innerHTML = _renderTitleRows(cards, 'generate') || '<p>No titles generated. Try a different search.</p>';
  } catch (err) {
    resultsEl.innerHTML = `<p>Error: ${escHtml(err.message)}</p>`;
  }
}

// Begin polling for unread DMs once the page loads if already signed in.
document.addEventListener('DOMContentLoaded', () => { if (getCurrentUser()) startDmPoller(); });

// Enter key for listing helper & autofill
document.addEventListener('DOMContentLoaded', () => {
  const lhInput = document.getElementById('listing-helper-input');
  if (lhInput) lhInput.addEventListener('keydown', e => { if (e.key === 'Enter') generateListingTitles(); });
  const afInput = document.getElementById('autofill-search-input');
  if (afInput) afInput.addEventListener('keydown', e => { if (e.key === 'Enter') searchAutofillTitles(); });
});

// ---- Promoted Cards ----

function getPromotedCards() {
  try { return JSON.parse(localStorage.getItem('cardHuddlePromotedCards') || '[]'); }
  catch { return []; }
}

// Promoted cards from every seller across The Card Huddle. Cached in memory
// after the first GET so the Browse page and search injection can use it
// synchronously. Falls back to the local user's cards when the global feed
// hasn't loaded yet (first paint).
// `var` (not `let`) so these are hoisted and can never land in a temporal
// dead zone — any code path that reads them before this line just sees
// `undefined`, which the Array.isArray() guards below handle gracefully.
var _globalPromotedCache = null;
var _globalPromotedLoading = null;

function getGlobalPromotedCards() {
  if (Array.isArray(_globalPromotedCache)) return _globalPromotedCache;
  // Fire-and-forget warm-up so future calls have the global feed ready.
  fetchGlobalPromotedCards().catch(() => {});
  return getPromotedCards();
}

async function fetchGlobalPromotedCards(force) {
  if (!force && Array.isArray(_globalPromotedCache)) return _globalPromotedCache;
  if (_globalPromotedLoading) return _globalPromotedLoading;
  _globalPromotedLoading = (async () => {
    try {
      const res = await fetch('/api/promoted-cards/all');
      const data = await safeJson(res);
      _globalPromotedCache = Array.isArray(data && data.cards) ? data.cards : [];
    } catch (_) {
      _globalPromotedCache = _globalPromotedCache || [];
    } finally {
      _globalPromotedLoading = null;
    }
    return _globalPromotedCache;
  })();
  return _globalPromotedLoading;
}

// Warm the cache once the page is ready so the first search shows promoted
// cards from across the platform, not just this user's.
fetchGlobalPromotedCards().catch(() => {});

function savePromotedCards(cards) {
  localStorage.setItem('cardHuddlePromotedCards', JSON.stringify(cards));
  schedulePushUserData();
}

// Everyone gets 5 promoted-listing slots, free.
function getPromoteSlotCount() {
  return 5;
}

// Paid extra slots removed — inert.
function handleBuyExtraSlot() {}

// Shared "this is a Pro feature" gate panel. featureKey is passed to showUpgrade
// as the modal reason.
function _proGateHtml(title, desc) {
  const safeTitle = escHtml(title);
  return `
    <div class="pro-gate-box">
      <span class="pro-gate-badge">★ PRO</span>
      <h3>${safeTitle} is a Pro feature</h3>
      <p>${escHtml(desc)}</p>
      <button class="pro-btn" onclick="showUpgrade('${safeTitle.replace(/'/g, '')} is a Pro feature.')">★ Go Pro — $4.99/mo</button>
    </div>`;
}

function initPromoteTab() {
  const gate = document.getElementById('promote-pro-gate');
  const content = document.getElementById('promote-content');
  // Promote Cards is free for everyone.
  if (gate) gate.classList.add('hidden');
  if (content) content.classList.remove('hidden');
  populatePromoteAutofill();
  renderPromotedCards();
}

// Populate the autofill dropdown with current seller listings
function populatePromoteAutofill() {
  const select = document.getElementById('promote-autofill-select');
  if (!select) return;
  const listings = getSellerListings();
  select.innerHTML = '<option value="">-- Select a listing to autofill --</option>';
  listings.forEach(l => {
    const price = l.price ? ` - $${l.price.toFixed(2)}` : '';
    const opt = document.createElement('option');
    opt.value = l.id;
    opt.textContent = l.title + price;
    select.appendChild(opt);
  });
}

// Autofill the promote form from a seller listing
function autofillPromoteFromListing(listingId) {
  if (!listingId) return;
  const listing = getSellerListings().find(l => l.id === listingId);
  if (!listing) return;

  // Map seller condition values to promote condition values
  const conditionMap = {
    'ungraded-nm': 'Ungraded - Near Mint',
    'ungraded-ex': 'Ungraded - Excellent',
    'psa10': 'PSA 10',
    'psa9': 'PSA 9',
    'bgs10': 'BGS 10',
    'bgs9.5': 'BGS 9.5',
    'sgc10': 'SGC 10'
  };

  document.getElementById('promote-title').value = listing.title || '';
  document.getElementById('promote-price').value = listing.price || '';
  const mappedCondition = conditionMap[listing.condition] || 'Ungraded - Near Mint';
  document.getElementById('promote-condition').value = mappedCondition;

  // Reset the select back to placeholder
  document.getElementById('promote-autofill-select').value = '';
}

// Auto-fill promote form from an eBay listing URL
async function autoFillFromEbayUrl() {
  const urlInput = document.getElementById('promote-url');
  const url = urlInput.value.trim();
  if (!url.includes('ebay.com/itm/')) return;

  const titleEl = document.getElementById('promote-title');
  const priceEl = document.getElementById('promote-price');
  const imageEl = document.getElementById('promote-image');
  const conditionEl = document.getElementById('promote-condition');
  const submitBtn = document.getElementById('promote-submit-btn');

  // Show loading state
  const origText = submitBtn.textContent;
  submitBtn.textContent = 'Fetching listing...';
  submitBtn.disabled = true;

  try {
    const resp = await fetch(`/api/ebay-listing-details?url=${encodeURIComponent(url)}`);
    const data = await resp.json();

    if (data.title && !titleEl.value.trim()) titleEl.value = data.title;
    if (data.price && !priceEl.value) priceEl.value = data.price;
    if (data.imageUrl && !imageEl.value.trim()) imageEl.value = data.imageUrl;

    // Try to map eBay condition to our dropdown options
    if (data.condition) {
      const raw = data.condition.toLowerCase();
      const options = Array.from(conditionEl.options);
      const match = options.find(o => raw.includes(o.value.toLowerCase()) || o.value.toLowerCase().includes(raw));
      if (match) conditionEl.value = match.value;
    }
  } catch (err) {
    console.warn('Could not auto-fetch eBay listing details:', err);
  } finally {
    submitBtn.textContent = origText;
    submitBtn.disabled = false;
  }
}

// Read a File and downscale via canvas to keep localStorage payload small.
// Returns a JPEG data URL (~50–120KB at default quality).
function readImageFileAsDataUrl(file, maxDim = 800, quality = 0.82) {
  return new Promise((resolve, reject) => {
    if (!file || !file.type.startsWith('image/')) {
      reject(new Error('File is not an image'));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read file'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Could not decode image'));
      img.onload = () => {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        try {
          resolve(canvas.toDataURL('image/jpeg', quality));
        } catch (err) {
          reject(err);
        }
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

async function handlePromoteImageFile(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const status = document.getElementById('promote-image-status');
  status.textContent = 'Processing…';
  try {
    if (file.size > 8 * 1024 * 1024) throw new Error('Image is too large (max 8MB)');
    const dataUrl = await readImageFileAsDataUrl(file);
    document.getElementById('promote-image').value = dataUrl;
    const previewWrap = document.getElementById('promote-image-preview-wrap');
    const preview = document.getElementById('promote-image-preview');
    preview.src = dataUrl;
    previewWrap.classList.remove('hidden');
    const kb = Math.round(dataUrl.length * 0.75 / 1024);
    status.textContent = `${file.name} — ${kb}KB ready`;
  } catch (err) {
    status.textContent = err.message || 'Could not load image';
    e.target.value = '';
  }
}

function clearPromoteImage() {
  document.getElementById('promote-image').value = '';
  document.getElementById('promote-image-file').value = '';
  document.getElementById('promote-image-status').textContent = '';
  const wrap = document.getElementById('promote-image-preview-wrap');
  const preview = document.getElementById('promote-image-preview');
  preview.removeAttribute('src');
  wrap.classList.add('hidden');
}

async function handleAddPromotedCard(e) {
  e.preventDefault();
  if (!getCurrentUser()) { showLogin(); return false; }

  const cards = getPromotedCards();
  const maxSlots = getPromoteSlotCount();
  if (cards.length >= maxSlots) {
    alert(`You've used all ${maxSlots} promotion slots. Remove one to add another.`);
    return false;
  }

  const title = document.getElementById('promote-title').value.trim();
  const url = document.getElementById('promote-url').value.trim();
  const price = document.getElementById('promote-price').value;
  let imageUrl = document.getElementById('promote-image').value.trim();
  const condition = document.getElementById('promote-condition').value;

  if (!title || !url || !price) return false;

  // Last-resort: auto-fetch image if still empty at submission time
  if (!imageUrl && url.includes('ebay.com/itm/')) {
    try {
      const resp = await fetch(`/api/ebay-listing-details?url=${encodeURIComponent(url)}`);
      const data = await resp.json();
      if (data.imageUrl) imageUrl = data.imageUrl;
    } catch (err) {
      console.warn('Could not auto-fetch eBay listing image:', err);
    }
  }

  // If this card fills a slot beyond the base 5, mark it as using an extra slot
  const usedExtraSlot = cards.length >= 5;

  cards.push({
    id: Date.now().toString(),
    title,
    itemUrl: url,
    price: parseFloat(price),
    imageUrl: imageUrl || '',
    condition,
    usedExtraSlot,
    createdAt: new Date().toISOString()
  });

  savePromotedCards(cards);
  renderPromotedCards();

  // Reset form
  document.getElementById('promote-card-form').reset();
  clearPromoteImage();
  return false;
}

function removePromotedCard(id) {
  const cards = getPromotedCards().filter(c => c.id !== id);
  savePromotedCards(cards);
  renderPromotedCards();
}

function markPromotedCardSold(id) {
  const cards = getPromotedCards();
  const card = cards.find(c => c.id === id);
  if (!card) return;

  // If this card used an extra slot, expire that slot
  if (card.usedExtraSlot) {
    const user = getCurrentUser();
    if (user) {
      const users = getUsers();
      const key = user.toLowerCase();
      if (users[key] && (users[key].extraPromoteSlots || 0) > 0) {
        users[key].extraPromoteSlots -= 1;
        localStorage.setItem('cardHuddleUsers', JSON.stringify(users));
      }
    }
  }

  const remaining = cards.filter(c => c.id !== id);
  savePromotedCards(remaining);
  renderPromotedCards();
}

function renderPromotedCards() {
  const cards = getPromotedCards();
  const listEl = document.getElementById('promoted-cards-list');
  const countEl = document.getElementById('promote-card-count');
  const maxEl = document.getElementById('promote-max-count');
  const submitBtn = document.getElementById('promote-submit-btn');

  const maxSlots = getPromoteSlotCount();
  countEl.textContent = cards.length;
  if (maxEl) maxEl.textContent = maxSlots;
  submitBtn.disabled = cards.length >= maxSlots;

  if (cards.length === 0) {
    listEl.innerHTML = '<p class="seller-empty">No promoted cards yet. Add your first listing above!</p>';
    return;
  }

  listEl.innerHTML = cards.map(c => {
    const imgHtml = c.imageUrl
      ? `<img src="${escHtml(c.imageUrl)}" alt="" style="width:50px;height:50px;object-fit:cover;border-radius:6px;" />`
      : '<div style="width:50px;height:50px;background:var(--surface);border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:1.2rem;">&#127183;</div>';
    const extraBadge = c.usedExtraSlot ? '<span class="promote-extra-badge">Extra Slot</span>' : '';
    return `<div class="seller-listing-card" style="display:flex;align-items:center;gap:12px;">
      ${imgHtml}
      <div style="flex:1;min-width:0;">
        <p class="seller-listing-title" style="margin:0 0 4px;">${escHtml(c.title)} ${extraBadge}</p>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
          <span style="font-weight:600;color:var(--accent);">$${parseFloat(c.price).toFixed(2)}</span>
          <span style="font-size:0.75rem;opacity:0.7;">${escHtml(c.condition)}</span>
          <a href="${escHtml(epnUrl(c.itemUrl))}" target="_blank" rel="noopener noreferrer" style="font-size:0.75rem;color:var(--accent);">View on eBay &#8599;</a>
        </div>
      </div>
      <div style="display:flex;gap:6px;align-items:center;">
        <button class="promote-sold-btn" onclick="markPromotedCardSold('${c.id}')" title="Mark as Sold">Sold</button>
        <button class="seller-delete-btn" onclick="removePromotedCard('${c.id}')" title="Remove">&times;</button>
      </div>
    </div>`;
  }).join('');
}

// Build a promoted card element for injection into search results
function buildPromotedCard(promo) {
  const card = document.createElement('div');
  card.className = 'card promoted-card';

  const teamColor = getTeamColor(promo.title);
  card.style.setProperty('--team-color', teamColor);

  const price = `$${parseFloat(promo.price).toFixed(2)}`;

  const imageHtml = promo.imageUrl
    ? `<img src="${escHtml(promo.imageUrl)}" alt="${escHtml(promo.title)}" loading="lazy" />`
    : `<div class="no-image"><span class="no-image-icon">&#127183;</span><span>No image</span></div>`;

  const parsed = parseCardTitle(promo.title);
  const tagParts = [parsed.year, parsed.set, parsed.parallel].filter(Boolean);
  const cardTag = tagParts.length >= 2 ? tagParts.join(' ') : '';
  const cardTagHtml = cardTag ? `<p class="card-tag">${escHtml(cardTag)}</p>` : '';

  card.innerHTML = `
    <div class="card-accent"></div>
    <div class="promoted-badge">PROMOTED</div>
    <div class="card-image-wrap">${imageHtml}</div>
    <div class="card-body">
      ${cardTagHtml}
      <p class="card-title">${escHtml(promo.title)}</p>
      <p class="card-price">${price}</p>
      <div class="card-meta">
        <span class="card-condition">${escHtml(promo.condition)}</span>
      </div>
      <a class="card-link"
         href="${escHtml(epnUrl(promo.itemUrl))}"
         target="_blank"
         rel="noopener noreferrer">
        View on eBay &#8599;
      </a>
    </div>
  `;

  return card;
}

// Inject promoted cards into a results grid every ~10 cards. If a promoted
// slot falls past the last result we drop it — promoted cards aren't allowed
// to stack at the bottom of the grid when the search runs out.
function injectPromotedCards(grid) {
  const promos = getGlobalPromotedCards();
  if (promos.length === 0) return;

  const shuffled = [...promos].sort(() => Math.random() - 0.5);

  const existingCards = grid.querySelectorAll('.card:not(.promoted-card)');
  const count = existingCards.length;
  if (count < 2) return; // too few results to interleave

  const spacing = 10;

  shuffled.forEach((promo, i) => {
    const insertIndex = spacing * (i + 1);
    const refCards = grid.querySelectorAll('.card:not(.promoted-card)');
    if (insertIndex >= refCards.length) return; // results ran out; skip the rest
    const promoCard = buildPromotedCard(promo);
    promoCard.style.animationDelay = `${insertIndex * 0.05}s`;
    refCards[insertIndex].before(promoCard);
  });
}

// ---- Browse Cards View ----
// Public page that lists every promoted card on The Card Huddle. Pulls the
// aggregated feed from /api/promoted-cards/all and supports a quick text
// filter + price sort. No login required.
let _browseSearchWired = false;

function initBrowseView() {
  const grid = document.getElementById('browse-grid');
  const meta = document.getElementById('browse-meta');
  if (!grid) return;
  if (!_browseSearchWired) {
    const search = document.getElementById('browse-search');
    const sort = document.getElementById('browse-sort');
    if (search) search.addEventListener('input', () => renderBrowseCards());
    if (sort) sort.addEventListener('change', () => renderBrowseCards());
    _browseSearchWired = true;
  }
  if (!Array.isArray(_globalPromotedCache)) {
    grid.innerHTML = `
      <div class="browse-empty" style="grid-column:1/-1">
        <div class="browse-empty-icon">&#9203;</div>
        <h3>Loading promoted cards…</h3>
        <p>Pulling listings from sellers across The Card Huddle.</p>
      </div>`;
    if (meta) { meta.textContent = ''; meta.classList.add('hidden'); }
  }
  loadBrowseCards(false);
}

async function loadBrowseCards(force) {
  await fetchGlobalPromotedCards(!!force);
  renderBrowseCards();
}

function renderBrowseCards() {
  const grid = document.getElementById('browse-grid');
  const meta = document.getElementById('browse-meta');
  if (!grid) return;
  const cards = Array.isArray(_globalPromotedCache) ? _globalPromotedCache : [];
  const search = (document.getElementById('browse-search')?.value || '').toLowerCase().trim();
  const sort = document.getElementById('browse-sort')?.value || 'newest';

  let filtered = cards;
  if (search) {
    filtered = cards.filter(c => (c.title || '').toLowerCase().includes(search));
  }
  if (sort === 'price-low') {
    filtered = [...filtered].sort((a, b) => (a.price || 0) - (b.price || 0));
  } else if (sort === 'price-high') {
    filtered = [...filtered].sort((a, b) => (b.price || 0) - (a.price || 0));
  } else {
    filtered = [...filtered].sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  }

  // The empty-state card carries its own messaging; suppress the meta line so
  // it doesn't double up on "No promoted cards yet" copy.
  if (meta) {
    if (cards.length === 0) {
      meta.textContent = '';
      meta.classList.add('hidden');
    } else {
      meta.classList.remove('hidden');
      meta.textContent = `${filtered.length} of ${cards.length} card${cards.length !== 1 ? 's' : ''}${search ? ` matching “${search}”` : ''}`;
    }
  }

  grid.innerHTML = '';
  if (filtered.length === 0) {
    if (cards.length === 0) {
      grid.innerHTML = `
        <div class="browse-empty" style="grid-column:1/-1">
          <div class="browse-empty-icon">&#11088;</div>
          <h3>No promoted cards yet</h3>
          <p>Promoted listings added by sellers show up here. Be the first — head to <a href="#" onclick="switchView('proplus');switchProPlusTab('promote');return false;">Tools &rarr; Promote Cards</a>.</p>
        </div>`;
    } else {
      grid.innerHTML = `
        <div class="browse-empty" style="grid-column:1/-1">
          <div class="browse-empty-icon">&#128269;</div>
          <h3>No matches</h3>
          <p>Try a different player, set, or year.</p>
        </div>`;
    }
    return;
  }
  filtered.forEach((promo, i) => {
    const card = buildPromotedCard(promo);
    card.style.animationDelay = `${Math.min(i, 20) * 0.04}s`;
    grid.appendChild(card);
  });
}

// ---- Community Board (Browse Cards subtab) ----
// A shared feed where members post messages, card photos, and prices/links.
// Reads are public; posting requires a signed-in account (Bearer token).
let _communityImageDataUrl = null;
let _communityPostsCache = null;
let _communityWired = false;

function switchBrowseTab(sub) {
  document.querySelectorAll('.browse-subtab').forEach(b =>
    b.classList.toggle('active', b.dataset.browseSub === sub));
  const cardsPanel = document.getElementById('browse-panel-cards');
  const communityPanel = document.getElementById('browse-panel-community');
  if (cardsPanel) cardsPanel.classList.toggle('hidden', sub !== 'cards');
  if (communityPanel) communityPanel.classList.toggle('hidden', sub !== 'community');
  if (sub === 'community') initCommunityView();
}

function initCommunityView() {
  if (!_communityWired) {
    _communityWired = true;
  }
  syncCommunityComposerState();
  loadCommunityPosts(false);
}

// Logged-out members can read but not post — swap the composer for a prompt.
function syncCommunityComposerState() {
  const composer = document.getElementById('community-composer');
  if (!composer) return;
  const user = getCurrentUser();
  composer.classList.toggle('community-locked', !user);
  const btn = document.getElementById('community-post-btn');
  if (btn) {
    btn.textContent = user ? 'Post' : 'Sign in to post';
    btn.classList.toggle('community-post-btn-locked', !user);
  }
  const avatar = document.getElementById('community-composer-avatar');
  if (avatar) {
    if (user) {
      avatar.textContent = user.charAt(0).toUpperCase();
      avatar.style.background = communityAvatarGradient(user);
    } else {
      avatar.innerHTML = '&#128100;';
      avatar.style.background = '';
    }
  }
}

// Populate the hero counters from the loaded feed.
function updateCommunityStats(posts) {
  const list = Array.isArray(posts) ? posts : [];
  const postsEl = document.getElementById('community-stat-posts');
  const membersEl = document.getElementById('community-stat-members');
  if (postsEl) postsEl.textContent = list.length;
  if (membersEl) {
    const unique = new Set(list.map(p => (p.author || '').toLowerCase()).filter(Boolean));
    membersEl.textContent = unique.size;
  }
}

function updateCommunityCount() {
  const ta = document.getElementById('community-message');
  const count = document.getElementById('community-char-count');
  if (ta && count) count.textContent = `${ta.value.length}/1000`;
}

async function handleCommunityImage(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  if (!file.type.startsWith('image/')) { showCommunityError('Please choose an image file.'); return; }
  if (file.size > 10 * 1024 * 1024) { showCommunityError('That image is too large (max 10MB).'); return; }
  try {
    // Downscale to keep the stored data URL small enough for the shared feed.
    _communityImageDataUrl = await readImageFileAsDataUrl(file, 900, 0.8);
    const img = document.getElementById('community-image-preview');
    const wrap = document.getElementById('community-image-preview-wrap');
    if (img) img.src = _communityImageDataUrl;
    if (wrap) wrap.classList.remove('hidden');
    hideCommunityError();
  } catch (err) {
    showCommunityError('Could not load that image: ' + (err.message || 'unknown error'));
  }
}

function clearCommunityImage() {
  _communityImageDataUrl = null;
  const wrap = document.getElementById('community-image-preview-wrap');
  const input = document.getElementById('community-image-input');
  if (wrap) wrap.classList.add('hidden');
  if (input) input.value = '';
}

function showCommunityError(msg) {
  const el = document.getElementById('community-composer-error');
  if (el) { el.textContent = msg; el.classList.remove('hidden'); }
}
function hideCommunityError() {
  const el = document.getElementById('community-composer-error');
  if (el) el.classList.add('hidden');
}

async function submitCommunityPost() {
  const user = getCurrentUser();
  const token = getSessionToken();
  if (!user || !token) { showLogin(); return; }

  const message = (document.getElementById('community-message')?.value || '').trim();
  const title = (document.getElementById('community-title')?.value || '').trim();
  const link = (document.getElementById('community-link')?.value || '').trim();
  const priceRaw = (document.getElementById('community-price')?.value || '').trim();
  const price = priceRaw ? parseFloat(priceRaw) : null;

  if (!message && !_communityImageDataUrl) {
    showCommunityError('Add a message or a photo before posting.');
    return;
  }
  hideCommunityError();

  const btn = document.getElementById('community-post-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Posting…'; }

  try {
    const res = await fetch('/api/community/posts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ message, title, link, price, imageUrl: _communityImageDataUrl || '' }),
    });
    const data = await safeJson(res);
    if (!res.ok) { showCommunityError((data && data.error) || 'Could not post. Please try again.'); return; }

    // Reset the composer and prepend the new post.
    document.getElementById('community-message').value = '';
    document.getElementById('community-title').value = '';
    document.getElementById('community-link').value = '';
    document.getElementById('community-price').value = '';
    clearCommunityImage();
    updateCommunityCount();
    if (!Array.isArray(_communityPostsCache)) _communityPostsCache = [];
    if (data && data.post) _communityPostsCache.unshift(data.post);
    renderCommunityFeed();
  } catch (_) {
    showCommunityError('Network error — please try again.');
  } finally {
    if (btn) { btn.disabled = false; syncCommunityComposerState(); }
  }
}

async function loadCommunityPosts(force) {
  const feed = document.getElementById('community-feed');
  if (feed && !Array.isArray(_communityPostsCache)) {
    feed.innerHTML = `<div class="community-empty"><div class="community-empty-icon">&#9203;</div><p>Loading the community board…</p></div>`;
  }
  if (!force && Array.isArray(_communityPostsCache)) { renderCommunityFeed(); return; }
  try {
    const res = await fetch('/api/community/posts');
    const data = await safeJson(res);
    _communityPostsCache = Array.isArray(data && data.posts) ? data.posts : [];
  } catch (_) {
    _communityPostsCache = _communityPostsCache || [];
  }
  renderCommunityFeed();
}

function renderCommunityFeed() {
  const feed = document.getElementById('community-feed');
  if (!feed) return;
  const posts = Array.isArray(_communityPostsCache) ? _communityPostsCache : [];
  updateCommunityStats(posts);
  if (posts.length === 0) {
    feed.innerHTML = `
      <div class="community-empty">
        <div class="community-empty-icon">&#128172;</div>
        <h3>No posts yet</h3>
        <p>Be the first to share a card and kick off the conversation.</p>
      </div>`;
    return;
  }
  const me = (getCurrentUser() || '').toLowerCase();
  feed.innerHTML = '';
  posts.forEach((p, i) => {
    feed.appendChild(buildCommunityPost(p, me, i));
  });
}

function buildCommunityPost(p, me, i) {
  const el = document.createElement('div');
  el.className = 'community-post';
  el.style.animationDelay = `${Math.min(i, 20) * 0.04}s`;

  const author = escHtml(p.author || 'Collector');
  const initial = author.charAt(0).toUpperCase();
  const when = formatCommunityTime(p.createdAt);
  const isMine = (p.author || '').toLowerCase() === me && me;
  const avatarBg = communityAvatarGradient(p.author);

  let media = '';
  if (p.imageUrl) {
    media = `<div class="community-post-media"><img src="${escHtml(p.imageUrl)}" alt="${escHtml(p.title || 'Card photo')}" loading="lazy" /></div>`;
  }

  const metaBits = [];
  if (p.title) metaBits.push(`<span class="community-post-title">${escHtml(p.title)}</span>`);
  if (p.price != null && p.price > 0) metaBits.push(`<span class="community-post-price">$${Number(p.price).toFixed(2)}</span>`);
  let metaRow = metaBits.length ? `<div class="community-post-cardmeta">${metaBits.join('')}</div>` : '';

  let linkRow = '';
  if (p.link) {
    linkRow = `<a class="community-post-link" href="${escHtml(p.link)}" target="_blank" rel="noopener noreferrer">View listing &rarr;</a>`;
  }

  const msg = p.message ? `<p class="community-post-message">${escHtml(p.message).replace(/\n/g, '<br>')}</p>` : '';
  const del = isMine ? `<button class="community-post-delete" onclick="deleteCommunityPost('${escHtml(p.id)}')" title="Delete post">&times;</button>` : '';
  // Anyone but the author can report. Logged-out users get the same button; it
  // prompts them to sign in. Posts already reported by this user show a marker.
  const report = !isMine
    ? `<button class="community-post-report" onclick="reportCommunityPost('${escHtml(p.id)}', this)" title="Report this post">&#9873; Report</button>`
    : '';

  const comments = Array.isArray(p.comments) ? p.comments : [];
  const pid = escHtml(p.id);
  const countLabel = comments.length
    ? `${comments.length} ${comments.length === 1 ? 'reply' : 'replies'}`
    : 'Reply';

  el.innerHTML = `
    <div class="community-post-head">
      <div class="community-avatar" style="background:${avatarBg}">${escHtml(initial)}</div>
      <div class="community-post-byline">
        <span class="community-post-author">${author}</span>
        <span class="community-post-time">${escHtml(when)}</span>
      </div>
      <div class="community-post-actions">${report}${del}</div>
    </div>
    ${msg}
    ${metaRow}
    ${media}
    ${linkRow}
    <div class="community-post-footer">
      ${buildReactionBar(p, p.id, '')}
      <button class="community-comment-toggle" onclick="toggleComments('${pid}', this)">
        <span class="community-comment-ico">&#128172;</span>
        <span id="comment-count-${pid}">${escHtml(countLabel)}</span>
      </button>
    </div>
    <div class="community-comments hidden" id="comments-${pid}">
      <div class="community-comment-list" id="comment-list-${pid}"></div>
      ${buildCommentComposer(p.id, null)}
    </div>
  `;
  return el;
}

// ---- Reactions ----
// Must mirror COMMUNITY_REACTIONS on the server.
const REACTION_EMOJIS = ['\u{1F44D}', '❤️', '\u{1F525}', '\u{1F602}', '\u{1F62E}'];
function reactionKey(postId, commentId) { return commentId || postId; }

function buildReactionBar(target, postId, commentId) {
  const key = escHtml(reactionKey(postId, commentId));
  return `<div class="community-reactions" id="reactbar-${key}">${reactionBarInner(target, postId, commentId)}</div>`;
}

function reactionBarInner(target, postId, commentId) {
  const counts = (target && target.reactions) || {};
  const mine = (target && target.myReaction) || null;
  const pid = escHtml(postId);
  const cidArg = commentId ? `'${escHtml(commentId)}'` : `''`;
  let chips = '';
  REACTION_EMOJIS.forEach((em, idx) => {
    const n = counts[em] || 0;
    if (!n) return;
    chips += `<button class="community-react-chip${mine === em ? ' mine' : ''}" onclick="reactCommunity('${pid}', ${cidArg}, ${idx})">${em}<span>${n}</span></button>`;
  });
  const opts = REACTION_EMOJIS.map((em, idx) =>
    `<button class="community-react-opt${mine === em ? ' mine' : ''}" onclick="reactCommunity('${pid}', ${cidArg}, ${idx})">${em}</button>`
  ).join('');
  return `${chips}<div class="community-react-add">
    <button class="community-react-trigger${mine ? ' active' : ''}" onclick="toggleReactPicker(event, this)" title="React">☺️<span class="community-react-plus">+</span></button>
    <div class="community-react-picker">${opts}</div>
  </div>`;
}

function toggleReactPicker(ev, btn) {
  ev.stopPropagation();
  const picker = btn.nextElementSibling;
  if (!picker) return;
  const isOpen = picker.classList.contains('open');
  document.querySelectorAll('.community-react-picker.open').forEach(p => p.classList.remove('open'));
  if (!isOpen) {
    picker.classList.add('open');
    // Close on the next outside click.
    setTimeout(() => document.addEventListener('click', closeReactPickers, { once: true }), 0);
  }
}
function closeReactPickers() {
  document.querySelectorAll('.community-react-picker.open').forEach(p => p.classList.remove('open'));
}

function findCachedTarget(postId, commentId) {
  const post = findCachedPost(postId);
  if (!post) return null;
  if (!commentId) return post;
  return (Array.isArray(post.comments) ? post.comments : []).find(c => c.id === commentId) || null;
}

async function reactCommunity(postId, commentId, idx) {
  closeReactPickers();
  const token = getSessionToken();
  if (!token) { showLogin(); return; }
  const emoji = REACTION_EMOJIS[idx];
  if (!emoji) return;
  const target = findCachedTarget(postId, commentId);
  // Optimistic toggle for snappy feedback.
  if (target) {
    const prev = target.myReaction || null;
    const counts = Object.assign({}, target.reactions || {});
    if (prev) counts[prev] = Math.max(0, (counts[prev] || 1) - 1);
    let next = emoji;
    if (prev === emoji) { next = null; }
    else { counts[emoji] = (counts[emoji] || 0) + 1; }
    Object.keys(counts).forEach(k => { if (!counts[k]) delete counts[k]; });
    target.reactions = counts; target.myReaction = next;
    renderReactionBar(postId, commentId);
  }
  try {
    const path = commentId
      ? `/api/community/posts/${encodeURIComponent(postId)}/comments/${encodeURIComponent(commentId)}/react`
      : `/api/community/posts/${encodeURIComponent(postId)}/react`;
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ emoji }),
    });
    const data = await safeJson(res);
    if (res.ok && target) {
      target.reactions = (data && data.reactions) || {};
      target.myReaction = (data && data.myReaction) || null;
    }
  } catch (_) { /* keep optimistic state */ }
  renderReactionBar(postId, commentId);
}

function renderReactionBar(postId, commentId) {
  const bar = document.getElementById(`reactbar-${reactionKey(postId, commentId)}`);
  const target = findCachedTarget(postId, commentId);
  if (bar && target) bar.innerHTML = reactionBarInner(target, postId, commentId);
}

// ---- Reply composer (top-level and inline/threaded) ----
// composerKey is the parent comment id for inline replies, else the post id.
function buildCommentComposer(postId, parentId) {
  const user = getCurrentUser();
  const inline = !!parentId;
  if (!user) {
    return inline ? '' : `<div class="community-reply-locked">
      <a href="#" onclick="showLogin();return false;">Sign in</a> to join the conversation.
    </div>`;
  }
  const key = escHtml(parentId || postId);
  const pid = escHtml(postId);
  const par = parentId ? `'${escHtml(parentId)}'` : `''`;
  const bg = communityAvatarGradient(user);
  const initial = escHtml(user.charAt(0).toUpperCase());
  const cancel = inline
    ? `<button class="community-reply-cancel" onclick="closeInlineReply('${escHtml(parentId)}')">Cancel</button>`
    : '';
  return `
    <div class="community-reply${inline ? ' community-reply-inline' : ''}">
      <div class="community-avatar community-reply-avatar" style="background:${bg}">${initial}</div>
      <div class="community-reply-box">
        <textarea id="comment-input-${key}" class="community-reply-input" maxlength="500" rows="1" placeholder="${inline ? 'Write a reply…' : 'Write a reply…'}"></textarea>
        <div id="comment-image-wrap-${key}" class="community-reply-preview hidden">
          <img id="comment-image-${key}" alt="Reply photo" />
          <button type="button" class="community-image-remove" onclick="clearCommentImage('${key}')" title="Remove photo">&times;</button>
        </div>
        <div class="community-reply-actions">
          <label class="community-reply-photo" title="Attach a photo">
            <span>&#128247;</span>
            <input type="file" accept="image/*" class="hidden" id="comment-file-${key}" onchange="handleCommentImage('${key}', event)" />
          </label>
          ${cancel}
          <button class="community-reply-send" onclick="submitCommunityComment('${pid}', ${par}, this)">Reply</button>
        </div>
        <p id="comment-error-${key}" class="community-error hidden"></p>
      </div>
    </div>`;
}

// Per-composer pending image, keyed by composerKey (parent id or post id).
const _commentImages = {};

function toggleComments(postId, btn) {
  const wrap = document.getElementById(`comments-${postId}`);
  if (!wrap) return;
  const opening = wrap.classList.contains('hidden');
  wrap.classList.toggle('hidden');
  if (btn) btn.classList.toggle('active', opening);
  if (opening) {
    renderCommentList(postId);
    const ta = document.getElementById(`comment-input-${postId}`);
    if (ta) setTimeout(() => ta.focus(), 0);
  }
}

function findCachedPost(postId) {
  return (Array.isArray(_communityPostsCache) ? _communityPostsCache : []).find(p => p.id === postId);
}

// Build a parent->children tree from the flat comment list.
function buildCommentTree(comments) {
  const byId = {};
  comments.forEach(c => { byId[c.id] = Object.assign({}, c, { children: [] }); });
  const roots = [];
  comments.forEach(c => {
    const node = byId[c.id];
    if (c.parentId && byId[c.parentId]) byId[c.parentId].children.push(node);
    else roots.push(node);
  });
  const sortRec = (arr) => {
    arr.sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
    arr.forEach(n => sortRec(n.children));
  };
  sortRec(roots);
  return roots;
}

function renderCommentList(postId) {
  const list = document.getElementById(`comment-list-${postId}`);
  const post = findCachedPost(postId);
  if (!list || !post) return;
  const comments = Array.isArray(post.comments) ? post.comments : [];
  const me = (getCurrentUser() || '').toLowerCase();
  const postOwner = (post.author || '').toLowerCase() === me && me;
  if (comments.length === 0) {
    list.innerHTML = `<p class="community-comment-empty">No replies yet — be the first.</p>`;
    return;
  }
  const roots = buildCommentTree(comments);
  list.innerHTML = roots.map(n => buildCommentNode(n, postId, me, postOwner, 0)).join('');
}

const COMMUNITY_MAX_INDENT = 4;
function buildCommentNode(c, postId, me, postOwner, depth) {
  const author = escHtml(c.author || 'Collector');
  const initial = author.charAt(0).toUpperCase();
  const bg = communityAvatarGradient(c.author);
  const when = formatCommunityTime(c.createdAt);
  const loggedIn = !!getCurrentUser();
  const canDelete = ((c.author || '').toLowerCase() === me && me) || postOwner;
  const del = canDelete
    ? `<button class="community-comment-delete" onclick="deleteCommunityComment('${escHtml(postId)}','${escHtml(c.id)}')" title="Delete reply">&times;</button>`
    : '';
  const msg = c.message ? `<div class="community-comment-text">${escHtml(c.message).replace(/\n/g, '<br>')}</div>` : '';
  const img = c.imageUrl
    ? `<div class="community-comment-media"><img src="${escHtml(c.imageUrl)}" alt="Reply photo" loading="lazy" /></div>`
    : '';
  const replyBtn = loggedIn
    ? `<button class="community-comment-reply-btn" onclick="openInlineReply('${escHtml(postId)}','${escHtml(c.id)}')">Reply</button>`
    : '';
  const children = (c.children || []).map(ch =>
    buildCommentNode(ch, postId, me, postOwner, Math.min(depth + 1, COMMUNITY_MAX_INDENT))
  ).join('');
  const childWrap = children ? `<div class="community-comment-children">${children}</div>` : '';
  return `
    <div class="community-comment">
      <div class="community-avatar community-comment-avatar" style="background:${bg}">${escHtml(initial)}</div>
      <div class="community-comment-body">
        <div class="community-comment-head">
          <span class="community-comment-author">${author}</span>
          <span class="community-comment-time">${escHtml(when)}</span>
          ${del}
        </div>
        ${msg}
        ${img}
        <div class="community-comment-actions">
          ${buildReactionBar(c, postId, c.id)}
          ${replyBtn}
        </div>
        <div class="community-replybox" id="replybox-${escHtml(c.id)}"></div>
        ${childWrap}
      </div>
    </div>`;
}

function openInlineReply(postId, parentId) {
  if (!getCurrentUser()) { showLogin(); return; }
  const box = document.getElementById(`replybox-${parentId}`);
  if (!box) return;
  if (box.innerHTML.trim()) { closeInlineReply(parentId); return; } // toggle
  box.innerHTML = buildCommentComposer(postId, parentId);
  const ta = document.getElementById(`comment-input-${parentId}`);
  if (ta) setTimeout(() => ta.focus(), 0);
}
function closeInlineReply(parentId) {
  const box = document.getElementById(`replybox-${parentId}`);
  clearCommentImage(parentId);
  if (box) box.innerHTML = '';
}

async function handleCommentImage(key, e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  if (!file.type.startsWith('image/')) { return; }
  if (file.size > 10 * 1024 * 1024) { return; }
  try {
    _commentImages[key] = await readImageFileAsDataUrl(file, 900, 0.8);
    const img = document.getElementById(`comment-image-${key}`);
    const wrap = document.getElementById(`comment-image-wrap-${key}`);
    if (img) img.src = _commentImages[key];
    if (wrap) wrap.classList.remove('hidden');
  } catch (_) { /* ignore */ }
}

function clearCommentImage(key) {
  delete _commentImages[key];
  const wrap = document.getElementById(`comment-image-wrap-${key}`);
  const input = document.getElementById(`comment-file-${key}`);
  if (wrap) wrap.classList.add('hidden');
  if (input) input.value = '';
}

async function submitCommunityComment(postId, parentId, btn) {
  const user = getCurrentUser();
  const token = getSessionToken();
  if (!user || !token) { showLogin(); return; }
  const key = parentId || postId;
  const ta = document.getElementById(`comment-input-${key}`);
  const errEl = document.getElementById(`comment-error-${key}`);
  const message = (ta && ta.value || '').trim();
  const imageUrl = _commentImages[key] || '';
  if (!message && !imageUrl) {
    if (errEl) { errEl.textContent = 'Add a message or a photo to reply.'; errEl.classList.remove('hidden'); }
    return;
  }
  if (errEl) errEl.classList.add('hidden');
  if (btn) { btn.disabled = true; btn.textContent = 'Replying…'; }
  try {
    const res = await fetch(`/api/community/posts/${encodeURIComponent(postId)}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ message, imageUrl, parentId: parentId || '' }),
    });
    const data = await safeJson(res);
    if (!res.ok) {
      if (errEl) { errEl.textContent = (data && data.error) || 'Could not reply. Please try again.'; errEl.classList.remove('hidden'); }
      return;
    }
    const post = findCachedPost(postId);
    if (post) {
      if (!Array.isArray(post.comments)) post.comments = [];
      if (data && data.comment) post.comments.push(data.comment);
    }
    // Clear input + image. Inline composers get removed when the list re-renders.
    if (ta) ta.value = '';
    clearCommentImage(key);
    renderCommentList(postId);
    updateCommentCount(postId);
  } catch (_) {
    if (errEl) { errEl.textContent = 'Network error — please try again.'; errEl.classList.remove('hidden'); }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Reply'; }
  }
}

async function deleteCommunityComment(postId, commentId) {
  const token = getSessionToken();
  if (!token) { showLogin(); return; }
  if (!confirm('Delete this reply? Any replies to it will be removed too.')) return;
  try {
    const res = await fetch(`/api/community/posts/${encodeURIComponent(postId)}/comments/${encodeURIComponent(commentId)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await safeJson(res);
    if (res.ok) {
      const post = findCachedPost(postId);
      if (post && Array.isArray(post.comments)) {
        const removed = new Set((data && data.removed) || [commentId]);
        post.comments = post.comments.filter(c => !removed.has(c.id));
      }
      renderCommentList(postId);
      updateCommentCount(postId);
    }
  } catch (_) { /* ignore */ }
}

function updateCommentCount(postId) {
  const post = findCachedPost(postId);
  const el = document.getElementById(`comment-count-${postId}`);
  if (!post || !el) return;
  const n = Array.isArray(post.comments) ? post.comments.length : 0;
  el.textContent = n ? `${n} ${n === 1 ? 'reply' : 'replies'}` : 'Reply';
}

// Deterministic avatar gradient per username so each collector keeps a stable,
// recognisable colour across the feed.
const COMMUNITY_AVATAR_GRADIENTS = [
  ['#5ece99', '#2d8f60'], ['#60a5fa', '#2563eb'], ['#f472b6', '#db2777'],
  ['#fbbf24', '#d97706'], ['#a78bfa', '#7c3aed'], ['#f87171', '#dc2626'],
  ['#34d399', '#059669'], ['#22d3ee', '#0891b2'], ['#fb923c', '#ea580c'],
];
function communityAvatarGradient(name) {
  const s = String(name || '?');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  const [a, b] = COMMUNITY_AVATAR_GRADIENTS[h % COMMUNITY_AVATAR_GRADIENTS.length];
  return `linear-gradient(135deg, ${a}, ${b})`;
}

async function deleteCommunityPost(id) {
  const token = getSessionToken();
  if (!token) { showLogin(); return; }
  if (!confirm('Delete this post?')) return;
  try {
    const res = await fetch(`/api/community/posts/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      _communityPostsCache = (_communityPostsCache || []).filter(p => p.id !== id);
      renderCommunityFeed();
    }
  } catch (_) { /* ignore */ }
}

async function reportCommunityPost(id, btn) {
  const token = getSessionToken();
  if (!token) { showLogin(); return; }
  const reason = prompt('What’s wrong with this post? (optional)') ?? null;
  if (reason === null) return; // user cancelled
  if (btn) { btn.disabled = true; btn.textContent = 'Reporting…'; }
  try {
    const res = await fetch(`/api/community/posts/${encodeURIComponent(id)}/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ reason: reason.trim() }),
    });
    const data = await safeJson(res);
    if (!res.ok) {
      if (btn) { btn.disabled = false; btn.innerHTML = '&#9873; Report'; }
      alert((data && data.error) || 'Could not report this post.');
      return;
    }
    if (data && data.autoHidden) {
      // Enough reports — it's hidden now; drop it from this user's view too.
      _communityPostsCache = (_communityPostsCache || []).filter(p => p.id !== id);
      renderCommunityFeed();
    } else if (btn) {
      btn.innerHTML = '&#10003; Reported';
      btn.classList.add('community-post-reported');
    }
  } catch (_) {
    if (btn) { btn.disabled = false; btn.innerHTML = '&#9873; Report'; }
  }
}

function formatCommunityTime(iso) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const diff = Date.now() - then;
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

// ---- Marketplace (eBay Browse) ----
let marketplaceOffset = 0;
let marketplaceQuery = '';
let marketplaceSort = '';

async function searchMarketplace(loadMore) {
  const input = document.getElementById('marketplace-input');
  const sortEl = document.getElementById('marketplace-sort');
  const resultsEl = document.getElementById('marketplace-results');

  if (!loadMore) {
    marketplaceQuery = input.value.trim();
    marketplaceSort = sortEl.value;
    marketplaceOffset = 0;
  }

  if (!marketplaceQuery || marketplaceQuery.length < 2) return;

  if (!loadMore) {
    resultsEl.innerHTML = '<div class="checklist-loading"><div class="spinner"></div><span>Searching eBay...</span></div>';
  } else {
    const btn = document.getElementById('marketplace-load-more');
    if (btn) { btn.disabled = true; btn.textContent = 'Loading...'; }
  }

  try {
    const params = new URLSearchParams({ q: marketplaceQuery, offset: marketplaceOffset, limit: 24 });
    if (marketplaceSort) params.set('sort', marketplaceSort);
    const res = await fetch(`/api/marketplace?${params}`);
    const data = await res.json();

    if (data.error) {
      resultsEl.innerHTML = `<p class="marketplace-empty">Error: ${escHtml(data.detail || data.error)}</p>`;
      return;
    }

    if (!data.results || data.results.length === 0) {
      if (!loadMore) resultsEl.innerHTML = '<p class="marketplace-empty">No listings found. Try a different search.</p>';
      return;
    }

    let html = loadMore ? '' : `<p class="marketplace-count">${data.total.toLocaleString()} listings found</p><div class="marketplace-grid">`;

    data.results.forEach(item => {
      const shipping = item.shippingCost ? `+$${parseFloat(item.shippingCost).toFixed(2)} ship` : 'Free shipping';
      const buyNow = item.buyingOptions?.includes('FIXED_PRICE');
      const auction = item.buyingOptions?.includes('AUCTION');
      const badge = buyNow ? 'Buy It Now' : auction ? 'Auction' : '';

      html += `<a class="marketplace-card" href="${escHtml(epnUrl(item.itemUrl))}" target="_blank" rel="noopener noreferrer">
        ${item.imageUrl ? `<img class="marketplace-card-img" src="${escHtml(item.imageUrl)}" alt="" loading="lazy" />` : '<div class="marketplace-card-img marketplace-no-img">No Image</div>'}
        <div class="marketplace-card-body">
          <p class="marketplace-card-title">${escHtml(item.title)}</p>
          <div class="marketplace-card-meta">
            <span class="marketplace-card-price">$${parseFloat(item.price).toFixed(2)}</span>
            <span class="marketplace-card-shipping">${shipping}</span>
          </div>
          ${badge ? `<span class="marketplace-card-badge">${badge}</span>` : ''}
          <div class="marketplace-card-seller">
            <span>${escHtml(item.seller)}</span>
            ${item.sellerFeedback ? `<span class="marketplace-seller-fb">${item.sellerFeedback}% positive</span>` : ''}
          </div>
        </div>
      </a>`;
    });

    marketplaceOffset += data.results.length;
    const hasMore = marketplaceOffset < data.total;

    if (!loadMore) {
      html += `</div>`;
      if (hasMore) html += `<button class="marketplace-load-more" id="marketplace-load-more" onclick="searchMarketplace(true)">Load More</button>`;
      resultsEl.innerHTML = html;
    } else {
      const grid = resultsEl.querySelector('.marketplace-grid');
      if (grid) grid.insertAdjacentHTML('beforeend', html);
      const oldBtn = document.getElementById('marketplace-load-more');
      if (oldBtn) {
        if (hasMore) { oldBtn.disabled = false; oldBtn.textContent = 'Load More'; }
        else oldBtn.remove();
      }
    }
  } catch (err) {
    if (!loadMore) resultsEl.innerHTML = `<p class="marketplace-empty">Error: ${escHtml(err.message)}</p>`;
  }
}

// Enter key for marketplace search
document.addEventListener('DOMContentLoaded', () => {
  const mpInput = document.getElementById('marketplace-input');
  if (mpInput) mpInput.addEventListener('keydown', e => { if (e.key === 'Enter') searchMarketplace(); });
});

// Attach the shared "Pick from checklist" button to every feature that
// takes a single search input. Each call drops a styled button after
// the input and wires it to openChecklistPicker.
document.addEventListener('DOMContentLoaded', () => {
  // Pro Tools — Auto Pricer
  attachChecklistPickerButton('ap-input', {
    subtitle: 'Pick a card to auto-price.',
  });
  // Grading Advisor
  attachChecklistPickerButton('grading-input', {
    subtitle: 'Pick a card to compare grade premiums.',
  });
  // Title Generator
  attachChecklistPickerButton('listing-helper-input', {
    subtitle: 'Pick a card to generate listing titles for.',
    label: 'From checklist',
  });
  // eBay Seller — Create Listing title field. Picker fills the title
  // and also a few related fields if they're empty.
  const titleInput = document.getElementById('seller-listing-title');
  if (titleInput && !titleInput._clPickerWired) {
    titleInput._clPickerWired = true;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'seller-autofill-btn cl-pick-trigger';
    btn.textContent = 'From checklist';
    btn.addEventListener('click', () => {
      openChecklistPicker({
        subtitle: 'Pick a card to fill the listing title.',
        onPick: (ctx) => {
          // Build a typical eBay title: "<year> <brand> <player> #<num> <parallel> Football"
          const parts = [ctx.year, ctx.brand, ctx.player];
          if (ctx.cardNumber) parts.push(`#${ctx.cardNumber}`);
          if (ctx.parallel) parts.push(ctx.parallel);
          parts.push('Football');
          let title = parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
          if (title.length > 80) title = title.slice(0, 80).trim();
          titleInput.value = title;
          titleInput.dispatchEvent(new Event('input', { bubbles: true }));
        },
      });
    });
    const row = titleInput.closest('.seller-title-row');
    if (row) row.appendChild(btn);
  }
});

// ---- CSV Export ----
function exportCollectionCSV() {
  // CSV export stays free — an easy on-ramp tool.
  const coll = getCollection();
  if (coll.length === 0) { alert('No cards in your collection to export.'); return; }

  const headers = ['Name', 'Purchase Price', 'Est Value', 'Condition', 'Notes', 'Date Added'];
  const rows = coll.map(c => [
    `"${(c.name || '').replace(/"/g, '""')}"`,
    (c.purchasePrice || 0).toFixed(2),
    (c.estValue || 0).toFixed(2),
    `"${(c.condition || '').replace(/"/g, '""')}"`,
    `"${(c.notes || '').replace(/"/g, '""')}"`,
    c.addedAt || '',
  ]);

  const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'card-huddle-collection.csv'; a.click();
  URL.revokeObjectURL(url);
}

// ---- Price History Recording (auto-record after searches) ----
function recordPriceHistory(query, results) {
  if (!results || results.length === 0) return;
  const prices = results.map(r => parseFloat(r.price)).filter(p => !isNaN(p));
  if (prices.length < 2) return;

  const sorted = [...prices].sort((a, b) => a - b);
  const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
  const median = sorted[Math.floor(sorted.length / 2)];
  const today = new Date().toISOString().slice(0, 10);

  const history = JSON.parse(localStorage.getItem('cardHuddlePriceHistory') || '{}');
  const key = query.toLowerCase().trim();
  if (!history[key]) history[key] = [];

  // Don't record same day twice
  if (history[key].length > 0 && history[key][history[key].length - 1].date === today) return;

  history[key].push({ date: today, avg, median, high: Math.max(...prices), low: Math.min(...prices), n: prices.length });
  if (history[key].length > 90) history[key] = history[key].slice(-90);
  localStorage.setItem('cardHuddlePriceHistory', JSON.stringify(history));

  // Also send to server for persistence
  fetch('/api/price-history', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: key, avgPrice: avg, medianPrice: median, highPrice: Math.max(...prices), lowPrice: Math.min(...prices), sampleSize: prices.length }),
  }).catch(() => {});
}

// ---- Comp Analyzer (inline in checklist listings) ----
function buildCompAnalysis(results) {
  if (!results || results.length < 2) return '';
  const prices = results.map(r => parseFloat(r.price)).filter(p => !isNaN(p)).sort((a, b) => a - b);
  if (prices.length < 2) return '';
  const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
  const median = prices[Math.floor(prices.length / 2)];
  return `<div class="comp-analyzer">
    <span class="comp-label">Comp Analysis:</span>
    <span class="comp-stat">Avg: $${avg.toFixed(2)}</span>
    <span class="comp-stat">Med: $${median.toFixed(2)}</span>
    <span class="comp-stat">Hi: $${prices[prices.length - 1].toFixed(2)}</span>
    <span class="comp-stat">Lo: $${prices[0].toFixed(2)}</span>
  </div>`;
}

// Close modals on overlay click
document.addEventListener('click', function(e) {
  ['add-card-modal', 'title-autofill-modal', 'grading-comps-modal'].forEach(id => {
    const el = document.getElementById(id);
    if (e.target === el) el.classList.add('hidden');
  });
});

// ---- Layout Mode (auto-detect screen size, allow manual override) ----
(function initLayoutPicker() {
  const saved = localStorage.getItem('cardHuddleLayout');
  const mode = saved || (window.innerWidth <= 768 ? 'mobile' : 'desktop');
  document.documentElement.classList.toggle('mobile-layout', mode === 'mobile');
  const picker = document.getElementById('layout-picker');
  if (picker) picker.classList.add('hidden');
  updateLayoutButtons(mode);
  if (!saved) localStorage.setItem('cardHuddleLayout', mode);
})();

function setLayoutMode(mode) {
  localStorage.setItem('cardHuddleLayout', mode);
  document.documentElement.classList.toggle('mobile-layout', mode === 'mobile');
  // Hide the first-visit picker popup
  const picker = document.getElementById('layout-picker');
  if (picker) picker.classList.add('hidden');
  // Close settings overlay if open
  const settingsOverlay = document.getElementById('settings-overlay');
  if (settingsOverlay && !settingsOverlay.classList.contains('hidden')) {
    settingsOverlay.classList.add('hidden');
  }
  updateLayoutButtons(mode);
}

function updateLayoutButtons(mode) {
  const dBtn = document.getElementById('layout-btn-desktop');
  const mBtn = document.getElementById('layout-btn-mobile');
  if (dBtn) dBtn.classList.toggle('active', mode === 'desktop');
  if (mBtn) mBtn.classList.toggle('active', mode === 'mobile');
}

async function fetchPlayerListings(container, query, mode) {
  const body = container.querySelector('.cl-listings-body');
  body.innerHTML = '<div class="cl-listings-loading"><div class="spinner"></div><span>Searching eBay...</span></div>';

  // For Sale uses infinite scroll; Sold keeps a single fetch with stats.
  if (mode === 'forsale') {
    body._playerState = {
      query, mode,
      offset: 0, pageSize: 40,
      loading: false, hasMore: true,
      totalShown: 0, allPrices: [],
      statsEl: null, grid: null, sentinel: null, observer: null,
      isSimilar: false,
    };
    await loadPlayerPage(body);
    return;
  }

  try {
    const params = new URLSearchParams({ q: query, mode, limit: '50' });
    const response = await fetch(`/api/search?${params}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Server error ${response.status}`);

    const results = data.results || [];
    const serial = data.serial || null;
    const similarResults = data.similarResults || [];
    const searchType = data.searchType || 'exact';
    const approximateValue = data.approximateValue || null;

    if (results.length === 0) {
      let emptyHtml = `<div class="cl-listings-empty">No sold listings found${serial ? ` numbered /${serial}` : ''}.</div>`;
      if (similarResults.length > 0) {
        emptyHtml += `<div class="cl-similar-section">`;
        emptyHtml += `<div class="cl-similar-header">Similar Numbered Cards${serial ? ` (other than /${serial})` : ''}</div>`;
        emptyHtml += `<div class="cl-listings-grid">`;
        similarResults.slice(0, 8).forEach(item => { emptyHtml += buildClListingCard(item, mode); });
        emptyHtml += '</div></div>';
      }
      body.innerHTML = emptyHtml;
      return;
    }

    const prices = results.map(r => parseFloat(r.price)).filter(p => !isNaN(p));
    const avg = prices.length ? (prices.reduce((a, b) => a + b, 0) / prices.length) : 0;
    const low = prices.length ? Math.min(...prices) : 0;
    const high = prices.length ? Math.max(...prices) : 0;
    const mockBadge = data.mock ? '<span class="mock-badge" style="font-size:0.65rem;">DEMO</span>' : '';
    const reasoning = generateListingReasoning(results, true, serial);

    let html = '';
    if (searchType === 'broadened') {
      html += `<div class="cl-broadened-notice"><span class="cl-broadened-icon">&#128270;</span> No exact match found. Showing similar items`;
      if (approximateValue) {
        html += ` &mdash; estimated value <strong>~$${approximateValue.medianPrice.toFixed(2)}</strong>`;
        html += ` <span class="cl-broadened-detail">(based on ${approximateValue.sampleSize} ${approximateValue.sampleSize === 1 ? 'sale' : 'sales'} of ${escHtml(approximateValue.basedOn)})</span>`;
      }
      html += `</div>`;
    } else if (searchType === 'relaxed' && data.relaxedNote) {
      html += `<div class="cl-broadened-notice"><span class="cl-broadened-icon">&#128270;</span> No listing matched every keyword. ${escHtml(data.relaxedNote)}.</div>`;
    }
    html += `<div class="cl-listings-stats">
        <span>${results.length} sold${searchType === 'broadened' ? ' (similar)' : ''} ${mockBadge}</span>
        <span>Avg: $${avg.toFixed(2)}</span>
        <span>Low: $${low.toFixed(2)}</span>
        <span>High: $${high.toFixed(2)}</span>
      </div>`;
    if (reasoning) html += `<div class="cl-reasoning">${escHtml(reasoning)}</div>`;
    html += '<div class="cl-listings-grid">';
    results.forEach(item => { html += buildClListingCard(item, mode); });
    html += '</div>';
    if (serial && similarResults.length > 0) {
      html += `<div class="cl-similar-section">`;
      html += `<div class="cl-similar-header">Other Numbered Cards</div>`;
      html += `<div class="cl-listings-grid">`;
      similarResults.slice(0, 6).forEach(item => { html += buildClListingCard(item, mode); });
      html += '</div></div>';
    }
    body.innerHTML = html;
  } catch (err) {
    body.innerHTML = `<div class="cl-listings-empty">Error: ${escHtml(err.message)}</div>`;
  }
}

async function loadPlayerPage(body) {
  const s = body._playerState;
  if (!s || s.loading || !s.hasMore) return;
  s.loading = true;
  if (s.loadMoreBtn) {
    s.loadMoreBtn.disabled = true;
    s.loadMoreBtn.textContent = 'Loading…';
  }
  try {
    const params = new URLSearchParams({ q: s.query, mode: 'forsale', limit: String(s.pageSize), offset: String(s.offset) });
    const response = await fetch(`/api/search?${params}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Server error ${response.status}`);

    const raw = data.results || [];
    if (s.offset === 0 && data.searchType === 'broadened') s.isSimilar = true;
    s.offset += s.pageSize;
    if (raw.length < s.pageSize) s.hasMore = false;
    renderPlayerPage(body, raw, data);
  } catch (err) {
    if (s.totalShown === 0) {
      body.innerHTML = `<div class="cl-listings-empty">Error: ${escHtml(err.message)}</div>`;
    }
  } finally {
    s.loading = false;
    if (s.loadMoreBtn && s.hasMore) {
      s.loadMoreBtn.disabled = false;
      s.loadMoreBtn.textContent = 'Load 40 more listings';
    }
  }
}

function renderPlayerPage(body, items, data) {
  const s = body._playerState;
  if (!s.grid) {
    if (items.length === 0) {
      body.innerHTML = '<div class="cl-listings-empty">No For Sale listings found.</div>';
      return;
    }
    let header = '';
    if (s.isSimilar) {
      header = `<div class="cl-broadened-notice"><span class="cl-broadened-icon">&#128270;</span> No exact match found. Showing similar listings.</div>`;
    }
    body.innerHTML = `${header}<div class="cl-listings-stats" data-stats></div><div class="cl-listings-grid"></div><div class="cl-load-more-wrap"></div>`;
    s.statsEl = body.querySelector('[data-stats]');
    s.grid = body.querySelector('.cl-listings-grid');
    s.loadMoreWrap = body.querySelector('.cl-load-more-wrap');
    s.loadMoreBtn = document.createElement('button');
    s.loadMoreBtn.type = 'button';
    s.loadMoreBtn.className = 'cl-load-more-btn';
    s.loadMoreBtn.textContent = 'Load 40 more listings';
    s.loadMoreBtn.addEventListener('click', () => loadPlayerPage(body));
    s.loadMoreWrap.appendChild(s.loadMoreBtn);
  }
  if (items.length > 0) {
    s.grid.insertAdjacentHTML('beforeend', items.map(item => buildClListingCard(item, 'forsale')).join(''));
    s.totalShown += items.length;
    items.forEach(it => {
      const p = parseFloat(it.price);
      if (!isNaN(p)) s.allPrices.push(p);
    });
    updatePlayerStats(s);
  }
  if (!s.hasMore) {
    if (s.totalShown > 0) {
      s.loadMoreWrap.innerHTML = '<span class="cl-listings-end">— end of listings —</span>';
    } else {
      body.innerHTML = '<div class="cl-listings-empty">No For Sale listings found.</div>';
    }
  }
}

function updatePlayerStats(s) {
  if (!s.statsEl) return;
  const prices = s.allPrices;
  if (prices.length === 0) { s.statsEl.innerHTML = ''; return; }
  const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
  const low = Math.min(...prices);
  const high = Math.max(...prices);
  s.statsEl.innerHTML = `
    <span>${s.totalShown} listings${s.isSimilar ? ' (similar)' : ''}</span>
    <span>Avg: $${avg.toFixed(2)}</span>
    <span>Low: $${low.toFixed(2)}</span>
    <span>High: $${high.toFixed(2)}</span>`;
}

// ---- Feedback / Report Bug ----
function openFeedbackModal(type) {
  const modal = document.getElementById('feedback-modal');
  const title = document.getElementById('feedback-modal-title');
  const typeInput = document.getElementById('feedback-type');
  const msgEl = document.getElementById('feedback-message');
  const statusEl = document.getElementById('feedback-status');

  typeInput.value = type;
  title.textContent = type === 'bug' ? 'Report a Bug' : 'Send Feedback';
  msgEl.placeholder = type === 'bug'
    ? 'Describe the bug: what happened, what you expected, and steps to reproduce...'
    : 'Tell us what you think, suggest features, or share your experience...';
  statusEl.classList.add('hidden');
  modal.classList.remove('hidden');
}

function closeFeedbackModal() {
  document.getElementById('feedback-modal').classList.add('hidden');
  document.getElementById('feedback-form').reset();
  document.getElementById('feedback-status').classList.add('hidden');
}

async function submitFeedback(e) {
  e.preventDefault();
  const type = document.getElementById('feedback-type').value;
  const email = document.getElementById('feedback-email').value.trim();
  const message = document.getElementById('feedback-message').value.trim();
  const statusEl = document.getElementById('feedback-status');

  if (!message) return;

  try {
    const resp = await fetch('/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, email, message, timestamp: new Date().toISOString(), userAgent: navigator.userAgent }),
    });

    if (resp.ok) {
      statusEl.textContent = 'Thank you! Your ' + (type === 'bug' ? 'bug report' : 'feedback') + ' has been sent.';
      statusEl.className = 'feedback-status success';
      statusEl.classList.remove('hidden');
      setTimeout(closeFeedbackModal, 2000);
    } else {
      throw new Error('Server error');
    }
  } catch (err) {
    statusEl.textContent = 'Failed to send. Please try again.';
    statusEl.className = 'feedback-status error';
    statusEl.classList.remove('hidden');
  }
}

// ---- Rainbow Grid View ----
// State for the currently-open rainbow grid. _rainbowState.target is the
// {si, ci} of the card whose parallels are being shown. The grid renders
// every parallel as a card-shaped tile; single tap toggles owned, double
// tap (desktop) / long press (touch) opens recent sales for that parallel.
let _rainbowState = { target: null };

function openRainbowGridForCard(si, ci) {
  _rainbowState.target = { si, ci };
  switchCompletionSubtab('rainbow');
}

function closeRainbowView() {
  _rainbowState.target = null;
  switchCompletionSubtab('set');
}

// Order: non-numbered parallels first (preserving the data's order),
// then numbered parallels by print run descending (/199 -> /1).
function sortVariantsForRainbow(variants) {
  const nonNumbered = [];
  const numbered = [];
  variants.forEach((v, originalIdx) => {
    const pr = parseInt(v.printRun, 10);
    if (Number.isFinite(pr) && pr > 0) numbered.push({ v, vi: originalIdx, pr });
    else nonNumbered.push({ v, vi: originalIdx });
  });
  numbered.sort((a, b) => b.pr - a.pr);
  return [...nonNumbered, ...numbered];
}

function renderRainbowView() {
  const empty = document.getElementById('rainbow-empty');
  const view = document.getElementById('rainbow-view');
  if (!empty || !view) return;
  if (!completionData || !_rainbowState.target) {
    empty.classList.remove('hidden');
    view.classList.add('hidden');
    return;
  }
  const { si, ci } = _rainbowState.target;
  const set = completionData.sets[si];
  const card = set && set.cards && set.cards[ci];
  if (!set || !card) {
    empty.classList.remove('hidden');
    view.classList.add('hidden');
    return;
  }
  empty.classList.add('hidden');
  view.classList.remove('hidden');

  const allVariants = buildVariants(set, { printRun: card.printRun || '' });
  const ordered = sortVariantsForRainbow(allVariants);
  const productKey = completionData.id || completionData.name;
  const state = getCompletionState();
  const owned = state[productKey] || {};
  const setKey = `s${si}`;

  const ownedCount = ordered.reduce((n, { vi }) => n + (owned[`${setKey}_c${ci}_v${vi}`] ? 1 : 0), 0);
  document.getElementById('rainbow-card-player').textContent = card.player || 'Unknown';
  const cardNum = card.number ? `#${card.number}` : '';
  document.getElementById('rainbow-card-meta').textContent = [completionData.name, set.name, cardNum].filter(Boolean).join(' · ');
  document.getElementById('rainbow-progress-text').textContent = `${ownedCount} / ${ordered.length} owned`;

  const tilesHtml = ordered.map(({ v, vi }) => {
    const key = `${setKey}_c${ci}_v${vi}`;
    const isOwned = !!owned[key];
    const prDisplay = v.printRun ? ` /${escHtml(String(v.printRun))}` : '';
    const variantName = (v.name || '').replace(/'/g, "\\'");
    const printRun = v.printRun ? String(v.printRun) : '';
    return `<div class="rainbow-tile ${isOwned ? 'owned' : ''}" data-variant-idx="${vi}" data-variant-name="${escHtml(variantName)}" data-variant-pr="${escHtml(printRun)}" data-key="${escHtml(key)}">
      <div class="rainbow-tile-img-wrap" aria-hidden="true">
        <div class="rainbow-tile-img-placeholder"></div>
      </div>
      <div class="rainbow-check-badge" aria-hidden="true">&#10003;</div>
      <div class="rainbow-tile-name">${escHtml(v.name)}${prDisplay}</div>
    </div>`;
  }).join('');

  const grid = document.getElementById('rainbow-grid');
  grid.innerHTML = tilesHtml;
  document.getElementById('rainbow-listings-slot').innerHTML = '';

  grid.querySelectorAll('.rainbow-tile').forEach(tile => attachRainbowTileHandlers(tile, productKey, si, ci, card, set));
  loadRainbowTileImages(grid, productKey, si, ci, card, set);
}

function attachRainbowTileHandlers(tile, productKey, si, ci, card, set) {
  const vi = parseInt(tile.dataset.variantIdx, 10);
  const variantName = tile.dataset.variantName || '';
  const printRun = tile.dataset.variantPr || '';
  const key = tile.dataset.key;
  const setKey = `s${si}`;

  // Toggle helper — keeps localStorage + UI in sync. Returns the new state.
  const toggleOwned = (next) => {
    const state = getCompletionState();
    if (!state[productKey]) state[productKey] = {};
    const desired = (typeof next === 'boolean') ? next : !state[productKey][key];
    if (desired) state[productKey][key] = true;
    else delete state[productKey][key];
    saveCompletionState(state);
    tile.classList.toggle('owned', desired);
    refreshRainbowProgress(tile, productKey, si, ci, set);
    return desired;
  };

  // Long-press handling for touch. We start a 500ms timer on pointerdown;
  // if it fires before pointerup, the upcoming click is interpreted as a
  // "show recent sales" gesture rather than a toggle.
  let longPressTimer = null;
  let longPressFired = false;
  let pointerStart = null;

  tile.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return;
    longPressFired = false;
    pointerStart = { x: e.clientX, y: e.clientY };
    longPressTimer = setTimeout(() => {
      longPressFired = true;
      longPressTimer = null;
      if (navigator.vibrate) try { navigator.vibrate(15); } catch {}
    }, 500);
  });
  const cancelLongPress = () => {
    if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
  };
  tile.addEventListener('pointerup', cancelLongPress);
  tile.addEventListener('pointercancel', () => { cancelLongPress(); longPressFired = false; });
  tile.addEventListener('pointermove', (e) => {
    if (!pointerStart) return;
    const dx = e.clientX - pointerStart.x, dy = e.clientY - pointerStart.y;
    if (dx * dx + dy * dy > 100) cancelLongPress();
  });

  // Double-click detection for desktop: we toggle on each click immediately,
  // and on dblclick we DON'T undo (the two clicks already netted to no
  // change). We just open the listings drawer.
  let clickTimer = null;
  let suppressNextClick = false;
  tile.addEventListener('click', (e) => {
    e.preventDefault();
    if (suppressNextClick) { suppressNextClick = false; return; }
    if (longPressFired) {
      longPressFired = false;
      openRainbowListings(tile, card, set, variantName, printRun);
      return;
    }
    toggleOwned();
  });
  tile.addEventListener('dblclick', (e) => {
    e.preventDefault();
    openRainbowListings(tile, card, set, variantName, printRun);
  });
}

function refreshRainbowProgress(tile, productKey, si, ci, set) {
  const state = getCompletionState();
  const owned = state[productKey] || {};
  const card = set.cards[ci];
  const variants = buildVariants(set, { printRun: card.printRun || '' });
  const setKey = `s${si}`;
  const ownedCount = variants.reduce((n, _, vi) => n + (owned[`${setKey}_c${ci}_v${vi}`] ? 1 : 0), 0);
  // Update the progress text scoped to this card's section so multiple
  // rainbows on the page each track their own count.
  const section = tile && tile.closest ? tile.closest('.rainbow-card-section') : null;
  const el = (section && section.querySelector('.rainbow-progress-text'))
    || document.getElementById('rainbow-progress-text');
  if (el) el.textContent = `${ownedCount} / ${variants.length} owned`;
}

function openRainbowListings(tile, card, set, variantName, printRun) {
  // Each card section has its own listings slot; fall back to the legacy
  // global slot id if we're not inside a section.
  const section = tile && tile.closest ? tile.closest('.rainbow-card-section') : null;
  const slot = (section && section.querySelector('.rainbow-listings-slot'))
    || document.getElementById('rainbow-listings-slot');
  if (!slot) return;
  (section || document).querySelectorAll('.rainbow-tile.active').forEach(t => t.classList.remove('active'));

  // Clicking the same tile twice closes the drawer.
  if (slot.dataset.openKey === tile.dataset.key) {
    slot.innerHTML = '';
    slot.dataset.openKey = '';
    return;
  }
  slot.dataset.openKey = tile.dataset.key;
  tile.classList.add('active');

  const product = completionData;
  const player = card.player || '';
  const year = product.year || '';
  const brand = product.brand || '';
  const setName = set.name || '';
  const category = set.category || '';
  const baseQuery = buildChecklistQuery(player, year, brand, setName, category, printRun);

  const variantLabel = variantName + (printRun ? ' /' + printRun : '');
  slot.innerHTML = `
    <div class="cl-listings-panel rainbow-listings-panel">
      <div class="cl-listings-header">
        <div class="cl-listings-tabs">
          <button class="cl-listings-tab active" data-lmode="forsale">For Sale</button>
          <button class="cl-listings-tab" data-lmode="sold">Sold</button>
        </div>
        <span class="cl-listings-title">${escHtml(variantLabel)}</span>
        <button class="cl-listings-close" title="Close">&times;</button>
      </div>
      <div class="cl-listings-body">
        <div class="cl-listings-loading"><div class="spinner"></div><span>Searching eBay...</span></div>
      </div>
    </div>`;

  const tabs = slot.querySelectorAll('.cl-listings-tab');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const mode = tab.dataset.lmode;
      const body = slot.querySelector('.cl-listings-body');
      body.innerHTML = '<div class="cl-listings-loading"><div class="spinner"></div><span>Searching eBay...</span></div>';
      if (mode === 'sold') {
        fetchRainbowSoldListings(body, baseQuery, variantName, printRun);
      } else {
        const q = variantName ? `${baseQuery} ${variantName}` : baseQuery;
        fetchVariantListings(body, q, variantName, printRun);
      }
    });
  });

  slot.querySelector('.cl-listings-close').addEventListener('click', () => {
    slot.innerHTML = '';
    slot.dataset.openKey = '';
    tile.classList.remove('active');
  });

  const q = variantName ? `${baseQuery} ${variantName}` : baseQuery;
  fetchVariantListings(slot.querySelector('.cl-listings-body'), q, variantName, printRun);

  slot.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function fetchRainbowSoldListings(container, baseQuery, variantName, printRun) {
  const q = variantName ? `${baseQuery} ${variantName}` : baseQuery;
  try {
    const res = await fetch(`/api/search?${new URLSearchParams({ q, mode: 'sold', limit: '40' })}`);
    const data = await safeJson(res);
    const raw = data.results || [];
    let items = variantName ? filterStrictVariant(raw, variantName, printRun) : raw;
    if (items.length === 0 && raw.length > 0) items = raw;
    if (items.length === 0) {
      container.innerHTML = '<div class="cl-listings-empty">No sold listings found for this parallel.</div>';
      return;
    }
    container.innerHTML = `<div class="cl-listings-grid">${items.map(listingCardHtml).join('')}</div>`;
  } catch (err) {
    container.innerHTML = `<div class="cl-listings-empty">Error: ${escHtml(err.message)}</div>`;
  }
}

// For each tile, fetch the cheapest live listing for that parallel and use
// its thumbnail as the tile image — but ONLY if the listing title actually
// contains the parallel name (case-insensitive). This stops eBay's
// fuzzy-match from putting a Genesis card on the Blue Reactive tile.
async function loadRainbowTileImages(grid, productKey, si, ci, card, set) {
  const tiles = Array.from(grid.querySelectorAll('.rainbow-tile'));
  const player = card.player || '';
  const year = completionData.year || '';
  const brand = completionData.brand || '';
  const setName = set.name || '';
  const category = set.category || '';

  const CONCURRENCY = 3;
  let idx = 0;
  async function worker() {
    while (idx < tiles.length) {
      const myIdx = idx++;
      const tile = tiles[myIdx];
      const variantName = tile.dataset.variantName || '';
      const printRun = tile.dataset.variantPr || '';
      const baseQuery = buildChecklistQuery(player, year, brand, setName, category, printRun);
      const q = variantName ? `${baseQuery} ${variantName}` : baseQuery;
      try {
        const res = await fetch(`/api/search?${new URLSearchParams({ q, mode: 'forsale', limit: '12' })}`);
        const data = await safeJson(res);
        const raw = data.results || [];
        const strict = filterStrictVariant(raw, variantName, printRun);
        const verified = strict
          .filter(r => parseFloat(r.price) > 0 && r.imageUrl && titleContainsParallel(r.title, variantName))
          .sort((a, b) => parseFloat(a.price) - parseFloat(b.price));
        if (verified.length > 0) {
          applyTileImage(tile, verified[0].imageUrl);
        } else {
          tile.classList.add('no-image');
        }
      } catch (_) {
        tile.classList.add('no-image');
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
}

function titleContainsParallel(title, variantName) {
  if (!title || !variantName) return false;
  const t = String(title).toLowerCase();
  const v = String(variantName).toLowerCase().trim();
  if (!v || v === 'base') return true;
  // Strip the set name suffix from parallel names ("Camo Pink Mosaic" -> "Camo Pink")
  // so we look for the distinguishing token rather than the redundant set word.
  return t.includes(v);
}

function applyTileImage(tile, imageUrl) {
  const wrap = tile.querySelector('.rainbow-tile-img-wrap');
  if (!wrap) return;
  wrap.innerHTML = `<img class="rainbow-tile-img" src="${escHtml(imageUrl)}" alt="" loading="lazy" />`;
  tile.classList.add('has-image');
}

// ===== Standalone Rainbow tab =====
// Its own top-level tab: pick a product, then a player, and we render one
// rainbow block per card that player has in the product — the corresponding
// (base) card image alongside a grid of every parallel. Reuses the loaded
// product (the shared `completionData`) plus the same tile/listing/pricing
// helpers the old in-checklist rainbow used.
let _rainbowProductsLoaded = false;

function initRainbowPage() {
  setupCombobox(document.getElementById('rb-combo-product'));
  setupCombobox(document.getElementById('rb-combo-player'));
  loadRainbowProducts();
}

async function loadRainbowProducts() {
  const select = document.getElementById('rainbow-product-select');
  if (!select || _rainbowProductsLoaded) return;
  try {
    const data = await fetchChecklistsList();
    data.products.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.id;
      // name already contains the year (e.g. "2025 Bowman Football")
      opt.textContent = p.name;
      select.appendChild(opt);
    });
    _rainbowProductsLoaded = true;
    syncComboboxFromSelect(document.getElementById('rb-combo-product'));
  } catch (err) { console.error('Failed to load products for rainbow:', err); }
}

async function loadRainbowProduct() {
  const productId = document.getElementById('rainbow-product-select').value;
  const playerSelect = document.getElementById('rainbow-player-select');
  const cardsEl = document.getElementById('rainbow-page-cards');
  const empty = document.getElementById('rainbow-page-empty');
  cardsEl.innerHTML = '';
  playerSelect.innerHTML = '<option value="">Select a player...</option>';
  if (!productId) {
    completionData = null;
    syncComboboxFromSelect(document.getElementById('rb-combo-player'));
    empty.classList.remove('hidden');
    empty.innerHTML = '<p>Pick a <strong>product</strong>, then a <strong>player</strong> to see their rainbow.</p>';
    return;
  }
  empty.classList.remove('hidden');
  empty.innerHTML = '<p>Loading product…</p>';
  try {
    completionData = await fetchChecklistProduct(productId);
    populateRainbowPlayerSelect();
    empty.innerHTML = '<p>Now pick a <strong>player</strong> to see their rainbow.</p>';
  } catch (err) {
    empty.innerHTML = '<p>Error loading product.</p>';
  }
}

function populateRainbowPlayerSelect() {
  const select = document.getElementById('rainbow-player-select');
  select.innerHTML = '<option value="">Select a player...</option>';
  if (!completionData) return;
  const players = new Set();
  (completionData.sets || []).forEach(set => {
    (set.cards || []).forEach(c => { if (c.player) players.add(c.player); });
  });
  [...players].sort().forEach(p => {
    const opt = document.createElement('option');
    opt.value = p;
    opt.textContent = p;
    select.appendChild(opt);
  });
  syncComboboxFromSelect(document.getElementById('rb-combo-player'));
}

function loadRainbowPlayer() {
  const player = document.getElementById('rainbow-player-select').value;
  const cardsEl = document.getElementById('rainbow-page-cards');
  const empty = document.getElementById('rainbow-page-empty');
  cardsEl.innerHTML = '';
  if (!player || !completionData) {
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  renderRainbowPlayerCards(player);
}

function renderRainbowPlayerCards(player) {
  const cardsEl = document.getElementById('rainbow-page-cards');
  if (!completionData) return;
  const productKey = completionData.id || completionData.name;
  const state = getCompletionState();
  const owned = state[productKey] || {};
  const year = completionData.year || '';
  const brand = completionData.brand || '';

  // Every card this player appears on, across every set in the product.
  const matches = [];
  (completionData.sets || []).forEach((set, si) => {
    (set.cards || []).forEach((card, ci) => {
      if (card.player === player) matches.push({ set, si, card, ci });
    });
  });

  if (matches.length === 0) {
    cardsEl.innerHTML = '<div class="rainbow-empty"><p>No cards found for that player in this product.</p></div>';
    return;
  }

  cardsEl.innerHTML = matches.map(({ set, si, card, ci }) => {
    const setKey = `s${si}`;
    const allVariants = buildVariants(set, { printRun: card.printRun || '' });
    const ordered = sortVariantsForRainbow(allVariants);
    const ownedCount = ordered.reduce((n, { vi }) => n + (owned[`${setKey}_c${ci}_v${vi}`] ? 1 : 0), 0);
    const cardNumDisplay = card.number ? `#${String(card.number)}` : '';
    const meta = [completionData.name, set.name, cardNumDisplay].filter(Boolean).join(' · ');

    // onclick args follow the same escaping convention as renderCompletionSets:
    // escHtml (no quote escaping) then backslash-escape single quotes.
    const productKeyArg = escHtml(productKey).replace(/'/g, "\\'");
    const playerArg = escHtml(card.player || 'Unknown').replace(/'/g, "\\'");
    const yearArg = escHtml(String(year)).replace(/'/g, "\\'");
    const brandArg = escHtml(String(brand)).replace(/'/g, "\\'");
    const setNameArg = escHtml(String(set.name || '')).replace(/'/g, "\\'");
    const categoryArg = escHtml(String(set.category || 'base')).replace(/'/g, "\\'");
    const cardNumArg = escHtml(String(card.number || '')).replace(/'/g, "\\'");
    const cardKey = `${setKey}_c${ci}`;

    const tilesHtml = ordered.map(({ v, vi }) => {
      const key = `${setKey}_c${ci}_v${vi}`;
      const isOwned = !!owned[key];
      const prDisplay = v.printRun ? ` /${escHtml(String(v.printRun))}` : '';
      const variantName = (v.name || '').replace(/'/g, "\\'");
      const printRun = v.printRun ? String(v.printRun) : '';
      return `<div class="rainbow-tile ${isOwned ? 'owned' : ''}" data-variant-idx="${vi}" data-variant-name="${escHtml(variantName)}" data-variant-pr="${escHtml(printRun)}" data-key="${escHtml(key)}">
        <div class="rainbow-tile-img-wrap" aria-hidden="true"><div class="rainbow-tile-img-placeholder"></div></div>
        <div class="rainbow-check-badge" aria-hidden="true">&#10003;</div>
        <div class="rainbow-tile-name">${escHtml(v.name)}${prDisplay}</div>
      </div>`;
    }).join('');

    const rainbowBtn = allVariants.length > 1
      ? `<button class="rainbow-cost-btn" onclick="calculateRainbowCost(this, '${productKeyArg}','${cardKey}','${playerArg}','${yearArg}','${brandArg}','${setNameArg}','${categoryArg}','${cardNumArg}', ${ci})">Rainbow $?</button>`
      : '';

    return `<div class="rainbow-card-section" data-si="${si}" data-ci="${ci}">
      <div class="rainbow-card-top">
        <div class="rainbow-base-card">
          <div class="rainbow-base-img-wrap"><div class="rainbow-tile-img-placeholder"></div></div>
        </div>
        <div class="rainbow-card-info">
          <div class="rainbow-card-player">${escHtml(card.player || 'Unknown')}</div>
          <div class="rainbow-card-meta">${escHtml(meta)}</div>
          <div class="rainbow-progress"><span class="rainbow-progress-text">${ownedCount} / ${ordered.length} owned</span></div>
          <div class="completion-variants rainbow-cost-wrap">${rainbowBtn}</div>
        </div>
      </div>
      <div class="rainbow-grid">${tilesHtml}</div>
      <div class="rainbow-listings-slot"></div>
    </div>`;
  }).join('');

  // Wire tile handlers + lazy-load images for each section.
  matches.forEach(({ set, si, card, ci }) => {
    const section = cardsEl.querySelector(`.rainbow-card-section[data-si="${si}"][data-ci="${ci}"]`);
    if (!section) return;
    const grid = section.querySelector('.rainbow-grid');
    grid.querySelectorAll('.rainbow-tile').forEach(tile => attachRainbowTileHandlers(tile, productKey, si, ci, card, set));
    loadRainbowTileImages(grid, productKey, si, ci, card, set);
    const baseWrap = section.querySelector('.rainbow-base-img-wrap');
    if (baseWrap) loadRainbowBaseImage(baseWrap, card, set);
  });
}

// Fetch a representative image for the corresponding (base) card and show it
// next to the parallel grid. Uses the cheapest live listing that has an image.
async function loadRainbowBaseImage(wrap, card, set) {
  if (!completionData) return;
  const player = card.player || '';
  const year = completionData.year || '';
  const brand = completionData.brand || '';
  const setName = set.name || '';
  const category = set.category || '';
  const q = buildChecklistQuery(player, year, brand, setName, category, card.printRun || '');
  try {
    const res = await fetch(`/api/search?${new URLSearchParams({ q, mode: 'forsale', limit: '12' })}`);
    const data = await safeJson(res);
    const raw = data.results || [];
    const verified = raw
      .filter(r => r.imageUrl && parseFloat(r.price) > 0)
      .sort((a, b) => parseFloat(a.price) - parseFloat(b.price));
    if (verified.length > 0) {
      wrap.innerHTML = `<img class="rainbow-base-img" src="${escHtml(verified[0].imageUrl)}" alt="" loading="lazy" />`;
      wrap.classList.add('has-image');
    } else {
      wrap.classList.add('no-image');
    }
  } catch (_) {
    wrap.classList.add('no-image');
  }
}

// Re-render the open rainbow after a cross-device data sync so freshly pulled
// owned-state is reflected without a manual reselect.
function refreshRainbowPageFromSync() {
  if (!rainbowPage || rainbowPage.classList.contains('hidden')) return;
  const player = document.getElementById('rainbow-player-select');
  if (player && player.value && completionData) loadRainbowPlayer();
}
