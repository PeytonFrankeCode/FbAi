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

// Read a fetch Response as JSON, tolerating empty bodies and HTML error pages.
// Throws an informative Error if the body isn't parseable so the caller's
// catch block can render a useful message instead of a cryptic engine error.
async function safeJson(response) {
  const text = await response.text();
  if (!text) {
    if (response.ok) return {};
    throw new Error(`Server returned an empty response (HTTP ${response.status})`);
  }
  try {
    return JSON.parse(text);
  } catch (_) {
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
  document.getElementById('settings-overlay').classList.remove('hidden');
}

function updateSettingsSubscription() {
  const desc = document.getElementById('settings-sub-desc');
  const action = document.getElementById('settings-sub-action');
  const user = typeof getCurrentUser === 'function' ? getCurrentUser() : null;

  if (!user) {
    desc.textContent = 'Log in to manage your plan';
    action.innerHTML = `<button class="settings-sub-btn" onclick="closeSettings(); showLogin();">Log In</button>`;
    return;
  }

  const sub = typeof getUserSubscription === 'function' ? getUserSubscription() : null;

  if (!sub) {
    desc.textContent = 'You\'re on the Free plan';
    action.innerHTML = `<button class="settings-sub-btn settings-sub-upgrade" onclick="closeSettings(); showPricing();">Upgrade</button>`;
  } else {
    const period = sub.period === 'yearly' ? 'Yearly' : 'Monthly';
    const date = new Date(sub.subscribedAt);
    const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    desc.innerHTML = `<strong>Pro</strong> &middot; ${period} &middot; Since ${dateStr}`;
    action.innerHTML = `<button class="settings-sub-btn settings-sub-cancel" onclick="cancelSubscription()">Cancel</button>`;
  }
}

function cancelSubscription() {
  const user = getCurrentUser();
  if (!user) return;
  const users = getUsers();
  const key = user.toLowerCase();
  if (users[key] && users[key].subscription) {
    delete users[key].subscription;
    localStorage.setItem('cardHuddleUsers', JSON.stringify(users));
    updateProButton();
    updateSettingsSubscription();
  }
}

function closeSettings() {
  document.getElementById('settings-overlay').classList.add('hidden');
}

// Close settings on overlay click
document.addEventListener('click', function(e) {
  const overlay = document.getElementById('settings-overlay');
  if (e.target === overlay) closeSettings();
});

// ---- Tracked Cards / Card Alerts (Pro Feature) ----

function initTrackedView() {
  const user = getCurrentUser();
  const sub = user ? getUserSubscription() : null;
  const gate = document.getElementById('tracked-gate');
  const content = document.getElementById('tracked-content');
  const upgradeBtn = document.getElementById('tracked-upgrade-btn');

  if (!user) {
    gate.classList.remove('hidden');
    content.classList.add('hidden');
    gate.querySelector('h3').textContent = 'Log in Required';
    gate.querySelector('p').textContent = 'Log in or sign up to track cards and receive email alerts.';
    upgradeBtn.textContent = 'Log In';
    upgradeBtn.onclick = () => showLogin();
    return;
  }

  if (!sub) {
    gate.classList.remove('hidden');
    content.classList.add('hidden');
    gate.querySelector('h3').textContent = 'Pro Feature';
    gate.querySelector('p').textContent = 'Card tracking with email alerts is an exclusive Pro feature. Upgrade to never miss a listing.';
    upgradeBtn.textContent = 'Upgrade to Pro';
    upgradeBtn.onclick = () => showPricing();
    return;
  }

  gate.classList.add('hidden');
  content.classList.remove('hidden');
  loadTrackedCards();
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
  const sub = getUserSubscription();
  if (!sub) { showPricing(); return; }
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
document.querySelectorAll('.mode-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    const newMode = tab.dataset.mode;
    if (newMode === currentMode) return;
    currentMode = newMode;
    document.querySelectorAll('.mode-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    cachedVariants = null; // clear cached variants since mode changed
    // Re-run current search if there's an active query
    const query = input.value.trim();
    if (query) fetchDirectSearch(query);
  });
});

// ---- Sort Controls ----
document.querySelectorAll('.sort-btn').forEach(sortBtn => {
  sortBtn.addEventListener('click', () => {
    document.querySelectorAll('.sort-btn').forEach(b => b.classList.remove('active'));
    sortBtn.classList.add('active');
    applySortToResults(sortBtn.dataset.sort);
  });
});

function applySortToResults(sortType) {
  if (!currentResults.length) return;

  let sorted = [...currentResults];
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
    default: // 'default' — keep original order
      sorted = [...currentResults];
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
    const response = await fetch(`/api/variants?${params}`, {
      headers: {},
    });
    const data = await safeJson(response);

    if (response.status === 401) { showLogin(); return; }
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
    const response = await fetch(`/api/direct-search?${params}`, {
      headers: {},
    });
    const data = await safeJson(response);

    if (response.status === 401) { showLogin(); return; }
    if (!response.ok) {
      const msg = data.detail ? `${data.error}: ${data.detail}` : (data.error || `Server error ${response.status}`);
      throw new Error(msg);
    }

    const { mock, searchType, approximateValue } = data;
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

    // Show approximate value section if broadened
    if (searchType === 'broadened' && approximateValue) {
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
    const typeLabel = searchType === 'broadened' ? ' (similar cards)' : '';
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
      }
      injectPromotedCards(grid);
      if (isSold) updatePriceChart(results);
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
}

// ---- Search (fetch individual sales for a specific variant) ----
async function performSearch(query) {
  setLoading(true);
  showSkeleton();
  grid.innerHTML = '';
  errorMsg.classList.add('hidden');
  meta.classList.add('hidden');
  chartSection.classList.add('hidden');
  sortControls.classList.add('hidden');
  similarSection.classList.add('hidden');
  similarGrid.innerHTML = '';
  document.getElementById('grade-panel').classList.add('hidden');
  currentResults = [];
  if (priceChart) {
    priceChart.destroy();
    priceChart = null;
  }

  const isSold = currentMode === 'sold';
  loadingText.textContent = isSold ? 'Searching eBay sold listings...' : 'Searching eBay listings...';

  try {
    const params = new URLSearchParams({ q: query, limit: '20', mode: currentMode });
    const response = await fetch(`/api/search?${params}`, {
      headers: {},
    });
    const data = await safeJson(response);

    if (response.status === 401) { showLogin(); return; }
    if (response.status === 503 && currentMode === 'sold') {
      setLoading(false);
      const msg = document.createElement('div');
      msg.className = 'no-listings-box';
      msg.innerHTML = '<div class="no-listings-icon">&#9888;&#65039;</div><h3>Sold Data Unavailable</h3><p>' + (data.error || 'The sold listings service is not configured on this server.') + '</p>';
      grid.appendChild(msg);
      return;
    }
    if (!response.ok) {
      const msg = data.detail ? `${data.error}: ${data.detail}` : (data.error || `Server error ${response.status}`);
      throw new Error(msg);
    }

    const { mock, serial, similarResults } = data;
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
      return;
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
      }
      injectPromotedCards(grid);
      if (isSold) {
        updatePriceChart(results);
        loadGradePanel(query);
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
    const res  = await fetch(`/api/grading-advisor?q=${encodeURIComponent(query)}`);
    const data = await res.json();
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

  const sub = getUserSubscription();
  const isPro = !!sub;
  const cutoffDays = isPro ? 365 : 30;
  const cutoffDate = new Date(Date.now() - cutoffDays * 24 * 60 * 60 * 1000);

  const allSorted = [...results]
    .filter(r => r.soldDate && r.price)
    .sort((a, b) => new Date(a.soldDate) - new Date(b.soldDate));

  const sorted = allSorted.filter(r => new Date(r.soldDate) >= cutoffDate);
  const hiddenCount = allSorted.length - sorted.length;

  // Show depth notice
  let depthEl = document.getElementById('chart-depth-notice');
  if (!depthEl) {
    depthEl = document.createElement('div');
    depthEl.id = 'chart-depth-notice';
    depthEl.className = 'chart-depth-notice';
    chartSection.appendChild(depthEl);
  }
  if (!isPro && hiddenCount > 0) {
    depthEl.innerHTML = `Last 30 days shown &middot; <a href="#" onclick="showPricing();return false;" class="chart-depth-upgrade">${hiddenCount} older sale${hiddenCount !== 1 ? 's' : ''} hidden — Upgrade to Pro for full history</a>`;
    depthEl.classList.remove('hidden');
  } else if (isPro && allSorted.length > 0) {
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

function updateLoadMoreButton(grid) {
  let wrap = grid.querySelector('.load-more-wrap');
  const hasMore = _gradeGroups.some(g => (_gradeShown[g.grade] || 0) < g.items.length);

  if (!hasMore) { if (wrap) wrap.remove(); return; }

  if (!wrap) {
    wrap = document.createElement('div');
    wrap.className = 'load-more-wrap';
    const btn = document.createElement('button');
    btn.className = 'load-more-btn';
    btn.textContent = 'Load 20 More';
    btn.addEventListener('click', () => loadMoreCards(grid));
    wrap.appendChild(btn);
    grid.appendChild(wrap);
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
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, email })
      });
      const data = await res.json();
      if (!res.ok) {
        loginError.textContent = data.error || 'Registration failed';
        loginError.classList.remove('hidden');
        return false;
      }
      setSessionToken(data.token);
      setCurrentUser(data.username);
      closeLogin();
      await syncSubscriptionStatus();
    } else {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      const data = await res.json();
      if (!res.ok) {
        // Fallback: check local accounts (for users created before server-side auth)
        const users = getUsers();
        const localUser = users[username.toLowerCase()];
        if (localUser && localUser.password === password) {
          setCurrentUser(localUser.username);
          closeLogin();
          await syncSubscriptionStatus();
          return false;
        }
        loginError.textContent = data.error || 'Login failed';
        loginError.classList.remove('hidden');
        return false;
      }
      setSessionToken(data.token);
      setCurrentUser(data.username);
      // Persist email in local users store for display
      if (data.email) {
        const users = getUsers();
        const key = data.username.toLowerCase();
        if (!users[key]) users[key] = {};
        users[key].email = data.email;
        localStorage.setItem('cardHuddleUsers', JSON.stringify(users));
      }
      closeLogin();
      await syncSubscriptionStatus();
    }
  } finally {
    if (authSubmitBtn) authSubmitBtn.disabled = false;
  }
  return false;
}

function handleLogout() {
  closeAuthDropdown();
  const token = getSessionToken();
  if (token) fetch('/api/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
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

// ---- Subscription / Pricing ----
const pricingOverlay = document.getElementById('pricing-overlay');
const proBtn = document.getElementById('pro-btn');
const proBtnText = document.getElementById('pro-btn-text');
let pricingPeriod = 'monthly';

function showPricing() {
  pricingOverlay.classList.remove('hidden');
}

function closePricing() {
  pricingOverlay.classList.add('hidden');
}

function setPricingPeriod(period) {
  pricingPeriod = period;
  document.querySelectorAll('.pricing-period').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.period === period);
  });
  const yearly = period === 'yearly';
  const priceEl = document.getElementById('pro-price');
  const freqEl = document.getElementById('pro-freq');
  if (priceEl) { priceEl.textContent = yearly ? '$39.99' : '$4.99'; freqEl.textContent = yearly ? '/yr' : '/mo'; }
  const ppEl = document.getElementById('proplus-price');
  const ppFreqEl = document.getElementById('proplus-freq');
  if (ppEl) { ppEl.textContent = yearly ? '$199.99' : '$19.99'; ppFreqEl.textContent = yearly ? '/yr' : '/mo'; }
}

async function handleSubscribe(plan) {
  const user = getCurrentUser();
  if (!user) {
    closePricing();
    showLogin();
    return;
  }

  // Check if Stripe is enabled
  try {
    const configRes = await fetch('/api/stripe/config');
    const config = await configRes.json();

    if (config.enabled) {
      const endpoint = plan === 'proplus' ? '/api/stripe/create-checkout-proplus' : '/api/stripe/create-checkout';
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: user, period: pricingPeriod })
      });
      const data = await res.json();
      if (data.url) {
        window.location.href = data.url;
        return;
      } else {
        alert(data.error || 'Failed to start checkout');
        return;
      }
    }
  } catch (err) {
    console.log('Stripe not available, using local subscription:', err);
  }

  // Fallback: local subscription (when Stripe not configured)
  const users = getUsers();
  const key = user.toLowerCase();
  if (users[key]) {
    users[key].subscription = { plan, period: pricingPeriod, subscribedAt: new Date().toISOString() };
    localStorage.setItem('cardHuddleUsers', JSON.stringify(users));
  }
  updateProButton();
  closePricing();
}

function getUserSubscription() {
  const user = getCurrentUser();
  if (!user) return null;
  const users = getUsers();
  return users[user.toLowerCase()]?.subscription || null;
}

function isProPlus() {
  const sub = getUserSubscription();
  return sub?.plan === 'proplus' && sub?.status === 'active';
}

function isProOrPlus() {
  const sub = getUserSubscription();
  return (sub?.plan === 'pro' || sub?.plan === 'proplus') && sub?.status === 'active';
}

// Sync subscription status from server (called on login and page load)
async function syncSubscriptionStatus() {
  const user = getCurrentUser();
  if (!user) return;
  try {
    const token = getSessionToken();
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const res = await fetch(`/api/stripe/subscription?username=${encodeURIComponent(user)}`, { headers });
    const data = await res.json();
    if (data.subscription && data.subscription.status === 'active') {
      const users = getUsers();
      const key = user.toLowerCase();
      if (!users[key]) users[key] = {};
      users[key].subscription = { plan: data.subscription.plan, period: data.subscription.period, subscribedAt: data.subscription.subscribedAt, status: data.subscription.status || 'active' };
      if (data.subscription.extraPromoteSlots) {
        users[key].extraPromoteSlots = data.subscription.extraPromoteSlots;
      }
      localStorage.setItem('cardHuddleUsers', JSON.stringify(users));
      updateProButton();
    }
  } catch (err) { /* server unavailable, use local data */ }
}

// Check for payment success/cancel in URL params
function checkPaymentReturn() {
  const params = new URLSearchParams(window.location.search);
  const payment = params.get('payment');
  if (payment === 'success') {
    const type = params.get('type');
    if (type === 'slot') {
      alert('Extra promote slot purchased successfully!');
    } else {
      const plan = params.get('plan');
      alert(plan === 'proplus' ? 'Pro+ activated! Welcome to Card Huddle Pro+.' : 'Pro subscription activated! Welcome to Card Huddle Pro.');
    }
    // Sync from server and clean URL
    syncSubscriptionStatus();
    window.history.replaceState({}, '', window.location.pathname);
  } else if (payment === 'cancelled') {
    window.history.replaceState({}, '', window.location.pathname);
  }
}

function updateProButton() {
  const sub = getUserSubscription();
  if (sub) {
    proBtnText.textContent = 'Pro';
    proBtn.classList.add('subscribed');
  } else {
    proBtnText.textContent = 'Go Pro';
    proBtn.classList.remove('subscribed');
  }
}

// Close pricing on overlay click
pricingOverlay.addEventListener('click', (e) => {
  if (e.target === pricingOverlay) closePricing();
});

// Close pricing on Escape
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !pricingOverlay.classList.contains('hidden')) {
    closePricing();
  }
});

// Init pro button state
updateProButton();
// Sync Stripe subscription status and check for payment return
syncSubscriptionStatus();
checkPaymentReturn();

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

function switchView(view) {
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
  const activeTab = document.querySelector(`.nav-tab[data-view="${view}"]`);
  if (activeTab) activeTab.classList.add('active');

  const proplusView = document.getElementById('proplus-view');
  mainEl.classList.add('hidden');
  checklistView.classList.add('hidden');
  trackedView.classList.add('hidden');
  collectionView.classList.add('hidden');
  sellerView.classList.add('hidden');
  gradingView.classList.add('hidden');
  if (proplusView) proplusView.classList.add('hidden');

  if (view === 'checklist') {
    checklistView.classList.remove('hidden');
    if (!checklistData) loadChecklistProducts();
  } else if (view === 'tracked') {
    trackedView.classList.remove('hidden');
    initTrackedView();
  } else if (view === 'collection') {
    collectionView.classList.remove('hidden');
    initCollectionView();
  } else if (view === 'seller') {
    sellerView.classList.remove('hidden');
    renderMyListings();
  } else if (view === 'grading') {
    gradingView.classList.remove('hidden');
  } else if (view === 'proplus') {
    if (proplusView) { proplusView.classList.remove('hidden'); initProPlusView(); }
  } else {
    mainEl.classList.remove('hidden');
  }
}

// ---- Pro+ Tools ----
function initProPlusView() {
  const gate = document.getElementById('proplus-gate');
  const content = document.getElementById('proplus-content');
  if (!gate || !content) return;
  if (isProPlus()) {
    gate.classList.add('hidden');
    content.classList.remove('hidden');
  } else {
    gate.classList.remove('hidden');
    content.classList.add('hidden');
  }
}

function switchProPlusTab(tab) {
  document.querySelectorAll('.proplus-tab').forEach(t => t.classList.toggle('active', t.dataset.pptab === tab));
  document.querySelectorAll('.pptab-panel').forEach(p => p.classList.toggle('hidden', p.id !== `pptab-${tab}`));
}

async function runFlipFinder() {
  const q = document.getElementById('ff-input').value.trim();
  const minDiscount = document.getElementById('ff-discount').value;
  const minProfit = document.getElementById('ff-minprofit').value || 10;
  const out = document.getElementById('ff-results');
  if (!q) { out.innerHTML = '<p class="pp-error">Enter a card to search.</p>'; return; }
  out.innerHTML = '<div class="pp-loading">&#128269; Scanning eBay for underpriced listings&hellip;</div>';
  try {
    const res = await fetch(`/api/flip-finder?${new URLSearchParams({ q, minDiscount, minProfit, limit: 20 })}`);
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
    const res = await fetch(`/api/market-movers?q=${encodeURIComponent(q)}`);
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

let _apComps = [];

async function runAutoPricer() {
  const q = document.getElementById('ap-input').value.trim();
  const out = document.getElementById('ap-results');
  if (!q) { out.innerHTML = '<p class="pp-error">Enter a card to price.</p>'; return; }
  out.innerHTML = '<div class="pp-loading">&#128269; Finding sold comps&hellip;</div>';
  try {
    const res = await fetch(`/api/auto-price/search?q=${encodeURIComponent(q)}`);
    const data = await res.json();
    if (!res.ok || data.error) { out.innerHTML = `<p class="pp-error">${data.error}</p>`; return; }
    if (!data.items || !data.items.length) { out.innerHTML = '<p class="pp-error">No sold listings found for this card.</p>'; return; }
    _apComps = data.items;
    renderApComps(out, data.items);
  } catch (e) { out.innerHTML = `<p class="pp-error">Error: ${e.message}</p>`; }
}

function renderApComps(out, items) {
  out.innerHTML = `
    <div class="ap-pick-header">
      <div class="ap-pick-title">Pick the closest match to your card</div>
      <div class="ap-pick-sub">We'll calculate pricing recommendations based on your selection</div>
    </div>
    <div class="ap-comp-grid">
      ${items.map((item, i) => `
        <div class="ap-comp-card" onclick="selectApComp(${i})">
          <div class="ap-comp-img-wrap">
            <img class="ap-comp-img" src="${escHtml(item.image)}" onerror="this.parentElement.classList.add('no-img')" alt="" loading="lazy" />
          </div>
          <div class="ap-comp-info">
            <div class="ap-comp-name">${escHtml(item.title)}</div>
            <div class="ap-comp-bottom">
              <span class="ap-comp-price">$${item.price.toFixed(2)}</span>
              <span class="ap-comp-date">${timeAgo(item.soldDate)}</span>
            </div>
          </div>
        </div>`).join('')}
    </div>`;
}

async function selectApComp(idx) {
  const item = _apComps[idx];
  if (!item) return;

  document.querySelectorAll('.ap-comp-card').forEach((el, i) => el.classList.toggle('ap-comp-selected', i === idx));

  const out = document.getElementById('ap-results');
  let recSection = out.querySelector('.ap-rec-section');
  if (recSection) recSection.remove();

  recSection = document.createElement('div');
  recSection.className = 'ap-rec-section';
  recSection.innerHTML = '<div class="pp-loading">&#127991;&#65039; Calculating prices&hellip;</div>';
  out.appendChild(recSection);
  recSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  const refinedQuery = item.title.split(' ').slice(0, 8).join(' ');
  try {
    const res = await fetch(`/api/auto-price?q=${encodeURIComponent(refinedQuery)}`);
    const data = await res.json();
    if (!res.ok || data.error) {
      recSection.innerHTML = `<p class="pp-error">${data.error || 'Not enough comps found for this card.'}</p>`;
      return;
    }
    const recs = data.recommendations;
    const confidenceColors = { high: '#4ade80', medium: '#fbbf24', low: '#f87171' };
    const confidenceColor = confidenceColors[data.confidence] || '#94a3b8';
    recSection.innerHTML = `
      <div class="ap-selected-label">&#10003; Priced from: <em>${escHtml(item.title)}</em></div>
      ${data.fallbackNote ? `<div class="ap-fallback-note">&#128270; ${escHtml(data.fallbackNote)}</div>` : ''}
      <div class="ap-context">
        <span class="ap-confidence" style="color:${confidenceColor}">&#9679; ${data.confidence?.charAt(0).toUpperCase() + data.confidence?.slice(1)} confidence</span>
        &nbsp;&middot;&nbsp; Based on <strong>${data.soldCount} sold</strong> &nbsp;&middot;&nbsp;
        Median <strong>$${data.soldMedian}</strong> &nbsp;&middot;&nbsp;
        Range $${data.soldLow} &ndash; $${data.soldHigh}
        ${data.competitionLow ? ` &nbsp;&middot;&nbsp; Lowest listed <strong>$${data.competitionLow}</strong>` : ''}
      </div>
      <div class="ap-recs">
        ${Object.values(recs).map(r => `
          <div class="ap-rec">
            <div class="ap-rec-label">${r.label}</div>
            <div class="ap-rec-price">$${r.price.toFixed(2)}</div>
            <div class="ap-rec-desc">${r.description}</div>
          </div>`).join('')}
      </div>
      <button class="ap-repick-btn" onclick="document.querySelectorAll('.ap-comp-card').forEach(el=>el.classList.remove('ap-comp-selected')); document.querySelector('.ap-rec-section').remove()">&#8592; Pick a different card</button>`;
  } catch (e) {
    recSection.innerHTML = `<p class="pp-error">Error: ${e.message}</p>`;
  }
}

let bulkPriceResults = [];
async function runBulkPricer() {
  const raw = document.getElementById('bulk-input').value.trim();
  const out = document.getElementById('bulk-results');
  if (!raw) { out.innerHTML = '<p class="pp-error">Enter at least one card.</p>'; return; }
  const queries = raw.split('\n').map(l => l.trim()).filter(Boolean).slice(0, 20);
  out.innerHTML = `<div class="pp-loading">Pricing ${queries.length} card${queries.length !== 1 ? 's' : ''}&hellip;</div>`;
  try {
    const res = await fetch('/api/bulk-price', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ queries }) });
    const data = await res.json();
    if (!res.ok) { out.innerHTML = `<p class="pp-error">${data.error}</p>`; return; }
    bulkPriceResults = data.results;
    out.innerHTML = `
      <table class="bulk-table">
        <thead><tr><th>Card</th><th>Median Sold</th><th>Low</th><th>High</th><th># Sales</th></tr></thead>
        <tbody>
          ${data.results.map(r => `
            <tr class="${r.median ? '' : 'bulk-row-na'}">
              <td class="bulk-query">${escHtml(r.query)}</td>
              <td class="bulk-median">${r.median ? `$${r.median.toFixed(2)}` : '—'}</td>
              <td>${r.low ? `$${r.low.toFixed(2)}` : '—'}</td>
              <td>${r.high ? `$${r.high.toFixed(2)}` : '—'}</td>
              <td>${r.count}</td>
            </tr>`).join('')}
        </tbody>
      </table>`;
  } catch (e) { out.innerHTML = `<p class="pp-error">Error: ${e.message}</p>`; }
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
    const res  = await fetch(`/api/grading-advisor?q=${encodeURIComponent(query)}`);
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

function renderGradingResults(data) {
  const { grades, premiums, query } = data;
  const tbody  = document.getElementById('grading-tbody');
  const recBox = document.getElementById('grading-recommendation');
  const results = document.getElementById('grading-results');

  const fmt = v => v != null ? `$${v.toFixed(2)}` : '—';
  const fmtNet = net => {
    if (net == null) return '—';
    const cls = net > 0 ? 'grading-positive' : 'grading-negative';
    return `<span class="${cls}">${net > 0 ? '+' : ''}$${net.toFixed(2)}</span>`;
  };

  const rows = [
    { label: 'Raw', stats: grades.raw,   premium: null },
    { label: 'PSA 8',  stats: grades.psa8,  premium: premiums.psa8  },
    { label: 'PSA 9',  stats: grades.psa9,  premium: premiums.psa9  },
    { label: 'PSA 10', stats: grades.psa10, premium: premiums.psa10 },
  ];

  tbody.innerHTML = rows.map(({ label, stats, premium }) => {
    if (!stats) return `<tr class="grading-no-data"><td>${label}</td><td colspan="6" style="color:var(--text-muted);font-style:italic">No recent sold data found</td></tr>`;
    const gross = premium ? fmt(premium.gross) : '—';
    const net   = premium ? fmtNet(premium.net) : '—';
    const isRaw = label === 'Raw';
    return `<tr class="${isRaw ? 'grading-raw-row' : ''}">
      <td><strong>${label}</strong></td>
      <td>${fmt(stats.avg)}</td>
      <td>${fmt(stats.median)}</td>
      <td>${fmt(stats.min)} – ${fmt(stats.max)}</td>
      <td>${stats.sales}</td>
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
  const imgHtml = item.imageUrl
    ? `<img src="${escHtml(item.imageUrl)}" alt="" loading="lazy" />`
    : `<div class="cl-item-noimg">&#127944;</div>`;
  return `
    <a class="cl-listing-item" href="${escHtml(epnUrl(item.itemUrl))}" target="_blank" rel="noopener noreferrer">
      <div class="cl-item-img">${imgHtml}</div>
      <div class="cl-item-info">
        <span class="cl-item-price">${price}</span>
        ${badge}
        ${dateStr ? `<span class="cl-item-date">${dateStr}</span>` : ''}
      </div>
    </a>
  `;
}

// ---- Collection & Portfolio (localStorage) ----
function getCollection() {
  try { return JSON.parse(localStorage.getItem('cardHuddleCollection') || '[]'); }
  catch { return []; }
}
function saveCollection(coll) {
  localStorage.setItem('cardHuddleCollection', JSON.stringify(coll));
}

function initCollectionView() {
  const user = getCurrentUser();
  const sub = user ? getUserSubscription() : null;
  const gate = document.getElementById('collection-gate');
  const content = document.getElementById('collection-content');
  const upgradeBtn = document.getElementById('collection-upgrade-btn');

  if (!user) {
    gate.classList.remove('hidden');
    content.classList.add('hidden');
    gate.querySelector('h3').textContent = 'Log In Required';
    gate.querySelector('p').textContent = 'Log in or sign up to access your collection and portfolio.';
    upgradeBtn.textContent = 'Log In';
    upgradeBtn.onclick = () => showLogin();
    return;
  }

  gate.classList.add('hidden');
  content.classList.remove('hidden');
  renderPortfolio();
  loadCompletionProducts();
}

function switchCollectionTab(tab) {
  document.querySelectorAll('.coll-tab').forEach(t => t.classList.toggle('active', t.dataset.coll === tab));
  document.querySelectorAll('.coll-panel').forEach(p => p.classList.add('hidden'));
  const panel = document.getElementById(`coll-${tab}`);
  if (panel) panel.classList.remove('hidden');
  if (tab === 'portfolio') renderPortfolio();
  if (tab === 'completion') loadCompletionProducts();
  if (tab === 'watchlist') renderWatchlist();
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

  const listEl = document.getElementById('portfolio-list');
  if (coll.length === 0) {
    listEl.innerHTML = '<p class="portfolio-empty">No cards in your collection yet. Add cards from checklists or use the button above.</p>';
    return;
  }

  // Separate checklist cards (have player field) from manually added cards
  const checklistCards = [];
  const manualCards = [];
  coll.forEach((c, i) => {
    if (c.player) {
      checklistCards.push({ ...c, _idx: i });
    } else {
      manualCards.push({ ...c, _idx: i });
    }
  });

  let html = '';

  // Group checklist cards by set (year + brand + setName)
  if (checklistCards.length > 0) {
    const groups = {};
    checklistCards.forEach(c => {
      const key = `${c.year || ''} ${c.brand || ''} ${c.setName || ''}`.trim() || 'Unknown Set';
      if (!groups[key]) groups[key] = { category: c.category || 'base', cards: [] };
      groups[key].cards.push(c);
    });

    const categoryBadgeMap = {
      'autograph': '<span class="checklist-badge auto">AUTO</span>',
      'memorabilia': '<span class="checklist-badge memo">MEMO</span>',
      'insert': '<span class="checklist-badge insert">INSERT</span>',
      'base': '<span class="checklist-badge base">BASE</span>'
    };

    Object.keys(groups).forEach(setKey => {
      const group = groups[setKey];
      const badge = categoryBadgeMap[group.category] || categoryBadgeMap['base'];
      html += `<div class="checklist-set portfolio-set expanded">
        <div class="checklist-set-header" onclick="this.parentElement.classList.toggle('expanded')">
          <div class="checklist-set-title-row">
            ${badge}
            <h3 class="checklist-set-name">${escHtml(setKey)}</h3>
            <span class="checklist-set-count">${group.cards.length} card${group.cards.length !== 1 ? 's' : ''}</span>
            <span class="checklist-set-toggle">&#9660;</span>
          </div>
        </div>
        <div class="checklist-set-body">
          <table class="checklist-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Player</th>
                <th>Team</th>
                <th>Details</th>
                <th>Paid</th>
                <th>Mkt Value</th>
                <th>ROI</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              ${group.cards.map(c => {
                const paid = c.purchasePrice || 0;
                const mkt = c.estValue || 0;
                const gl = mkt - paid;
                const roi = paid > 0 ? ((mkt - paid) / paid) * 100 : null;
                const glClass = gl >= 0 ? 'gain' : 'loss';
                const roiClass = roi === null ? '' : roi >= 0 ? 'gain' : 'loss';
                const parallelTag = c.parallel ? `<span class="portfolio-parallel-tag">${escHtml(c.parallel)}</span>` : '';
                const prTag = c.printRun ? `<span class="cl-printrun-inline ${parseInt(c.printRun) <= 25 ? 'cl-pr-rare' : parseInt(c.printRun) <= 99 ? 'cl-pr-low' : ''}">${'/' + c.printRun}</span>` : '';
                const condTag = c.condition ? `<span class="portfolio-cond-tag">${escHtml(c.condition)}</span>` : '';
                return `<tr>
                  <td class="cl-num">${escHtml(c.cardNumber || '')}</td>
                  <td class="cl-player">${escHtml(c.player)}</td>
                  <td class="cl-team">${escHtml(c.team || '')}</td>
                  <td class="portfolio-detail-cell">${parallelTag}${prTag}${condTag}</td>
                  <td class="portfolio-price-cell"><span class="portfolio-card-cost">$${paid.toFixed(2)}</span></td>
                  <td class="portfolio-price-cell">
                    ${mkt > 0 ? `<span class="portfolio-card-cost">$${mkt.toFixed(2)}</span>${gl !== 0 ? `<span class="portfolio-card-value ${glClass}"> ${gl >= 0 ? '+' : ''}$${gl.toFixed(2)}</span>` : ''}` : '<span class="portfolio-no-value">—</span>'}
                  </td>
                  <td class="portfolio-roi-cell ${roiClass}">
                    ${roi !== null ? `${roi >= 0 ? '+' : ''}${roi.toFixed(1)}%` : '—'}
                  </td>
                  <td class="cl-action"><button class="portfolio-card-remove" onclick="removeFromCollection(${c._idx})" title="Remove">&times;</button></td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>`;
    });
  }

  // Render manually added cards in the original simple format
  if (manualCards.length > 0) {
    if (checklistCards.length > 0) {
      html += '<div class="portfolio-manual-header">Manually Added</div>';
    }
    html += manualCards.map(c => {
      const paid = c.purchasePrice || 0;
      const mkt = c.estValue || 0;
      const gl = mkt - paid;
      const roi = paid > 0 ? ((mkt - paid) / paid) * 100 : null;
      const glClass = gl >= 0 ? 'gain' : 'loss';
      const roiClass = roi === null ? '' : roi >= 0 ? 'gain' : 'loss';
      return `
        <div class="portfolio-card-item">
          <div class="portfolio-card-info">
            <div class="portfolio-card-name">${escHtml(c.name)}</div>
            <div class="portfolio-card-meta">${c.condition ? escHtml(c.condition) : ''}${c.notes ? ' &middot; ' + escHtml(c.notes) : ''}</div>
          </div>
          <div class="portfolio-card-prices">
            <span class="portfolio-card-cost">Paid: $${paid.toFixed(2)}</span>
            ${mkt > 0 ? `<span class="portfolio-card-cost"> Mkt: $${mkt.toFixed(2)}</span>` : ''}
            ${gl !== 0 ? `<span class="portfolio-card-value ${glClass}">${gl >= 0 ? '+' : ''}$${gl.toFixed(2)}</span>` : ''}
            ${roi !== null ? `<span class="portfolio-roi-inline ${roiClass}">${roi >= 0 ? '+' : ''}${roi.toFixed(1)}% ROI</span>` : ''}
          </div>
          <button class="portfolio-card-remove" onclick="removeFromCollection(${c._idx})" title="Remove">&times;</button>
        </div>`;
    }).join('');
  }

  listEl.innerHTML = html;
}

function showAddCardModal() {
  document.getElementById('add-card-modal').classList.remove('hidden');
}
function closeAddCardModal() {
  document.getElementById('add-card-modal').classList.add('hidden');
}

function handleAddCard(e) {
  e.preventDefault();
  const name = document.getElementById('add-card-name').value.trim();
  const price = parseFloat(document.getElementById('add-card-price').value) || 0;
  const condition = document.getElementById('add-card-condition').value.trim();
  const notes = document.getElementById('add-card-notes').value.trim();
  if (!name) return false;

  const coll = getCollection();
  coll.push({ name, purchasePrice: price, estValue: price, condition, notes, addedAt: new Date().toISOString() });
  saveCollection(coll);
  closeAddCardModal();
  document.getElementById('add-card-form').reset();
  renderPortfolio();
  return false;
}

function addToCollectionFromChecklist(player, year, brand, setName, parallel, printRun, cardNumber, team, category) {
  const name = `${player} ${year} ${brand} ${setName}${parallel ? ' ' + parallel : ''}`;
  const coll = getCollection();
  coll.push({
    name, purchasePrice: 0, estValue: 0, condition: '', notes: printRun ? `/${printRun}` : '',
    player: player || '', team: team || '', cardNumber: cardNumber || '', setName: setName || '',
    year: year || '', brand: brand || '', parallel: parallel || '', printRun: printRun || '',
    category: category || 'base',
    addedAt: new Date().toISOString()
  });
  saveCollection(coll);
}

function removeFromCollection(idx) {
  const coll = getCollection();
  coll.splice(idx, 1);
  saveCollection(coll);
  renderPortfolio();
}

async function refreshPortfolioValues() {
  const sub = getUserSubscription();
  if (!sub) { showPricing(); return; }

  const btn = document.getElementById('refresh-market-btn');
  const origHTML = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.innerHTML = '&#8635; Refreshing… <span class="pro-badge-inline">PRO</span>'; }

  const coll = getCollection();
  const updates = [];
  for (const c of coll) {
    const query = c.player
      ? `${c.player} ${c.year || ''} ${c.brand || ''} ${c.setName || ''} ${c.parallel || ''}`.replace(/\s+/g, ' ').trim()
      : c.name || '';
    if (!query) { updates.push(null); continue; }
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(query)}&mode=sold`);
      const data = await res.json();
      if (data.approximateValue && data.approximateValue.medianPrice) {
        updates.push(data.approximateValue.medianPrice);
      } else if (data.results && data.results.length > 0) {
        const v = data.results.map(r => r.price).filter(p => p > 0).sort((a, b) => a - b);
        if (v.length) {
          const mid = Math.floor(v.length / 2);
          updates.push(v.length % 2 === 0 ? (v[mid - 1] + v[mid]) / 2 : v[mid]);
        } else updates.push(null);
      } else updates.push(null);
    } catch { updates.push(null); }
  }

  let refreshed = 0;
  coll.forEach((c, i) => {
    if (updates[i] !== null) { c.estValue = updates[i]; refreshed++; }
  });
  saveCollection(coll);
  renderPortfolio();

  if (btn) { btn.disabled = false; btn.innerHTML = origHTML; }
  showPortfolioToast(refreshed > 0
    ? `Updated market values for ${refreshed} card${refreshed !== 1 ? 's' : ''}.`
    : 'No market data found. Try cards with more specific names.');
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
  const sub = getUserSubscription();
  if (!sub) { showPricing(); return; }

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
let rainbowMode = false;
let completionVariantFilters = {}; // { setIndex: { name, printRun } }

function getCompletionState() {
  try { return JSON.parse(localStorage.getItem('cardHuddleCompletion') || '{}'); }
  catch { return {}; }
}
function saveCompletionState(state) {
  localStorage.setItem('cardHuddleCompletion', JSON.stringify(state));
}

async function loadCompletionProducts() {
  const select = document.getElementById('completion-product-select');
  if (select.options.length > 1) return; // already loaded
  try {
    const data = await fetchChecklistsList();
    data.products.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = `${p.year} ${p.name}`;
      select.appendChild(opt);
    });
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

function toggleRainbowMode() {
  rainbowMode = document.getElementById('rainbow-mode').checked;
  // Pop animation on the toggle label
  const label = document.querySelector('.rainbow-toggle');
  if (label) {
    label.classList.remove('rainbow-pop');
    // Force reflow so re-adding the class triggers the animation fresh
    void label.offsetWidth;
    label.classList.add('rainbow-pop');
    label.addEventListener('animationend', () => label.classList.remove('rainbow-pop'), { once: true });
  }
  if (completionData) renderCompletionSets();
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
    const allVariants = (set.parallels && set.parallels.length > 0)
      ? [{ name: 'Base', printRun: '' }, ...set.parallels]
      : [{ name: 'Base', printRun: '' }];

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
              ${!activeFilter ? '<th>Variant</th>' : ''}
              <th class="completion-check-col">Owned</th>
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

      variantsToRender.forEach(({ v, vi }, idx) => {
        const key = `${setKey}_c${ci}_v${vi}`;
        const checked = owned[key] ? 'checked' : '';
        const isOwned = owned[key];
        const prDisplay = v.printRun ? ' /' + v.printRun : '';
        const showPlayer = idx === 0; // Only show player name on first variant row

        html += `<tr class="${isOwned ? 'completion-row-owned' : ''}">
          <td class="cl-num">${showPlayer ? escHtml(c.number) : ''}</td>
          <td class="cl-player">${showPlayer ? `<a href="#" class="cl-player-link" onclick="event.preventDefault(); toggleCompletionListings(this, '${playerEsc}', '${year}', '${brand}', '${setName}', '${category}', '${cardNum}', '${v.printRun || printRun}')">${escHtml(c.player || 'Unknown')}</a>` : ''}</td>
          <td class="cl-team">${showPlayer ? escHtml(c.team || '') : ''}</td>
          ${!activeFilter ? `<td class="completion-variant-name">${escHtml(v.name)}${prDisplay}</td>` : ''}
          <td class="completion-check-cell">
            <label class="completion-variant-check ${isOwned ? 'owned' : ''}">
              <input type="checkbox" ${checked} onchange="toggleCompletionCard('${productKey}','${key}',this)" />
            </label>
          </td>
        </tr>`;
      });
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
  if (el) el.classList.toggle('hidden');
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
    const variants = (set.parallels && set.parallels.length > 0)
      ? [{ name: 'Base', printRun: '' }, ...set.parallels]
      : [{ name: 'Base', printRun: '' }];
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

// ---- Completion Sub-tabs & Player Completion ----
function switchCompletionSubtab(tab) {
  document.querySelectorAll('.completion-subtab').forEach(b => b.classList.toggle('active', b.dataset.subtab === tab));
  document.getElementById('completion-set-panel').style.display = tab === 'set' ? '' : 'none';
  document.getElementById('completion-player-panel').style.display = tab === 'player' ? '' : 'none';
  if (tab === 'player' && completionData) loadPlayerCompletion();
}

function populatePlayerSelect() {
  const select = document.getElementById('completion-player-select');
  select.innerHTML = '<option value="">Select a player...</option>';
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
}

function loadPlayerCompletion() {
  const player = document.getElementById('completion-player-select').value;
  const setsEl = document.getElementById('player-completion-sets');
  const progressEl = document.getElementById('player-completion-progress');
  if (!player || !completionData) { setsEl.innerHTML = ''; progressEl.classList.add('hidden'); return; }

  const state = getCompletionState();
  const productKey = completionData.id || completionData.name;
  const owned = state[productKey] || {};

  let totalCards = 0, ownedCount = 0;
  let html = '';

  completionData.sets.forEach((set, si) => {
    const setKey = `s${si}`;
    const playerCards = (set.cards || []).map((c, ci) => ({ ...c, ci })).filter(c => c.player === player);
    if (playerCards.length === 0) return;

    // Always show all variants (rainbow) for player completion
    const variants = (set.parallels && set.parallels.length > 0)
      ? [{ name: 'Base', printRun: '' }, ...set.parallels]
      : [{ name: 'Base', printRun: '' }];

    let setTotal = 0, setOwned = 0;
    playerCards.forEach(c => {
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

    const year = completionData.year || '2025';
    const brand = (completionData.brand || 'Bowman').replace(/'/g, "\\'");
    const setNameEsc = set.name.replace(/'/g, "\\'");
    const category = set.category || 'base';
    const playerEsc = escHtml(player).replace(/'/g, "\\'");
    const firstCard = playerCards[0];
    const cardNum = escHtml(firstCard.number).replace(/'/g, "\\'");
    const printRun = firstCard.printRun ? String(firstCard.printRun) : '';

    html += `<div class="completion-set ${isComplete ? 'complete' : ''}">
      <div class="completion-set-header" onclick="togglePlayerCompletionSet(${si})">
        ${categoryBadge}
        <span class="completion-set-name">${escHtml(set.name)}</span>
        <span class="completion-set-count">${setOwned}/${setTotal} (${pct}%)</span>
        <div class="completion-mini-bar"><div class="completion-mini-fill" style="width:${pct}%"></div></div>
      </div>
      <div class="completion-set-cards hidden" id="player-completion-cards-${si}">
        <div class="completion-player-group">
          <div class="completion-player-header">
            <span class="completion-player-num">${playerCards.map(c => '#' + escHtml(c.number)).join(', ')}</span>
            <a href="#" class="completion-player-name" onclick="event.preventDefault(); toggleCompletionListings(this, '${playerEsc}', '${year}', '${brand}', '${setNameEsc}', '${category}', '${cardNum}', '${printRun}')">${escHtml(player)}</a>
            <span class="completion-player-team">${escHtml(firstCard.team || '')}</span>
            <span class="completion-player-pct ${pct === 100 ? 'complete' : ''}">${setOwned}/${setTotal}</span>
          </div>
          <div class="completion-variants">`;

    playerCards.forEach(c => {
      variants.forEach((v, vi) => {
        const key = `${setKey}_c${c.ci}_v${vi}`;
        const checked = owned[key] ? 'checked' : '';
        const prDisplay = v.printRun ? ' /' + v.printRun : (c.printRun ? ' /' + c.printRun : '');
        html += `<label class="completion-variant-check ${owned[key] ? 'owned' : ''}">
          <input type="checkbox" ${checked} onchange="togglePlayerCompletionCard('${productKey}','${key}',this)" />
          <span>${escHtml(v.name)}${prDisplay}</span>
        </label>`;
      });
    });

    html += `</div>
          <div class="completion-player-listings-slot" id="player-completion-listings-${si}"></div>
        </div>
      </div>
    </div>`;
  });

  if (!html) html = '<p style="color:var(--text-muted);font-size:0.85rem;text-align:center;padding:2rem;">No cards found for this player in this product.</p>';
  setsEl.innerHTML = html;
  progressEl.classList.remove('hidden');

  const overallPct = totalCards > 0 ? Math.round((ownedCount / totalCards) * 100) : 0;
  document.getElementById('player-completion-bar').style.width = overallPct + '%';
  document.getElementById('player-completion-text').textContent = `${ownedCount} / ${totalCards} cards (${overallPct}%)`;
}

function togglePlayerCompletionSet(idx) {
  const el = document.getElementById(`player-completion-cards-${idx}`);
  if (el) el.classList.toggle('hidden');
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
  loadPlayerCompletion();
  // Also refresh set view so counts stay in sync
  renderCompletionSets();
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
function switchSellerTab(tab) {
  document.querySelectorAll('.seller-subtab').forEach(b => b.classList.toggle('active', b.dataset.seller === tab));
  document.querySelectorAll('.seller-panel').forEach(p => p.classList.add('hidden'));
  const panel = document.getElementById(`seller-${tab}`);
  if (panel) panel.classList.remove('hidden');
  if (tab === 'mylistings') renderMyListings();
  if (tab === 'promote') initPromoteTab();
}

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

async function searchAutofillTitles() {
  const q = document.getElementById('autofill-search-input').value.trim();
  const resultsEl = document.getElementById('autofill-results');
  if (!q || q.length < 2) return;

  resultsEl.innerHTML = '<div class="checklist-loading"><div class="spinner"></div><span>Searching...</span></div>';
  try {
    const res = await fetch(`/api/player-search?q=${encodeURIComponent(q)}`);
    const data = await res.json();
    if (!data.results || data.results.length === 0) {
      resultsEl.innerHTML = '<p>No matching cards found.</p>';
      return;
    }

    let html = '';
    const seen = new Set();
    data.results.slice(0, 50).forEach(c => {
      const parallels = c.parallels || [];
      const allVariants = [{ name: '', printRun: '' }, ...parallels.slice(0, 5)];
      allVariants.forEach(p => {
        const pr = p.printRun ? ` /${p.printRun}` : '';
        const pName = p.name ? ` ${p.name}` : '';
        const autoTag = c.category === 'autograph' ? ' AUTO' : '';
        const rcTag = (c.category === 'base' && c.note && /rc|rookie/i.test(c.note)) ? ' RC' : '';
        let title = `${c.year} ${c.brand} ${c.productName} ${c.player} #${c.number}${pName}${pr}${autoTag}${rcTag} Football`.replace(/\s+/g, ' ').trim();
        if (title.length > 80) title = title.substring(0, 80).trim();
        if (!seen.has(title)) {
          seen.add(title);
          const titleEsc = title.replace(/'/g, "\\'").replace(/"/g, '&quot;');
          html += `<div class="listing-title-row">
            <span class="listing-title-text">${escHtml(title)}</span>
            <span class="listing-title-len">${title.length}/80</span>
            <button class="listing-copy-btn" onclick="useAutofillTitle('${titleEsc}')">Use</button>
          </div>`;
        }
      });
    });
    resultsEl.innerHTML = html || '<p>No titles generated. Try a different search.</p>';
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

  resultsEl.innerHTML = '<div class="checklist-loading"><div class="spinner"></div><span>Searching...</span></div>';
  try {
    const res = await fetch(`/api/player-search?q=${encodeURIComponent(q)}`);
    const data = await res.json();
    if (!data.results || data.results.length === 0) {
      resultsEl.innerHTML = '<p>No matching cards found.</p>';
      return;
    }

    let html = '';
    const seen = new Set();
    data.results.slice(0, 50).forEach(c => {
      const parallels = c.parallels || [];
      const allVariants = [{ name: '', printRun: '' }, ...parallels.slice(0, 5)];
      allVariants.forEach(p => {
        const pr = p.printRun ? ` /${p.printRun}` : '';
        const pName = p.name ? ` ${p.name}` : '';
        const autoTag = c.category === 'autograph' ? ' AUTO' : '';
        const rcTag = (c.category === 'base' && c.note && /rc|rookie/i.test(c.note)) ? ' RC' : '';
        let title = `${c.year} ${c.brand} ${c.productName} ${c.player} #${c.number}${pName}${pr}${autoTag}${rcTag} Football`.replace(/\s+/g, ' ').trim();
        if (title.length > 80) title = title.substring(0, 80).trim();
        if (!seen.has(title)) {
          seen.add(title);
          const titleEsc = title.replace(/'/g, "\\'").replace(/"/g, '&quot;');
          html += `<div class="listing-title-row">
            <span class="listing-title-text">${escHtml(title)}</span>
            <span class="listing-title-len">${title.length}/80</span>
            <button class="listing-copy-btn" onclick="navigator.clipboard.writeText('${titleEsc}');this.textContent='Copied!';setTimeout(()=>this.textContent='Copy',1500)">Copy</button>
          </div>`;
        }
      });
    });
    resultsEl.innerHTML = html || '<p>No titles generated. Try a different search.</p>';
  } catch (err) {
    resultsEl.innerHTML = `<p>Error: ${escHtml(err.message)}</p>`;
  }
}

// Enter key for listing helper & autofill
document.addEventListener('DOMContentLoaded', () => {
  const lhInput = document.getElementById('listing-helper-input');
  if (lhInput) lhInput.addEventListener('keydown', e => { if (e.key === 'Enter') generateListingTitles(); });
  const afInput = document.getElementById('autofill-search-input');
  if (afInput) afInput.addEventListener('keydown', e => { if (e.key === 'Enter') searchAutofillTitles(); });
});

// ---- Promoted Cards (Pro Feature) ----

function getPromotedCards() {
  try { return JSON.parse(localStorage.getItem('cardHuddlePromotedCards') || '[]'); }
  catch { return []; }
}

function savePromotedCards(cards) {
  localStorage.setItem('cardHuddlePromotedCards', JSON.stringify(cards));
}

// Extra promotion slots — default 5 + purchased extras
function getPromoteSlotCount() {
  const user = getCurrentUser();
  if (!user) return 5;
  const users = getUsers();
  const extra = users[user.toLowerCase()]?.extraPromoteSlots || 0;
  return 5 + extra;
}

async function handleBuyExtraSlot() {
  const user = getCurrentUser();
  if (!user) { showLogin(); return; }
  const sub = getUserSubscription();
  if (!sub) { showPricing(); return; }

  const users = getUsers();
  const key = user.toLowerCase();
  const currentExtra = users[key]?.extraPromoteSlots || 0;

  if (currentExtra >= 10) {
    alert('You\'ve reached the maximum of 10 extra slots (15 total).');
    return;
  }

  const currentMax = getPromoteSlotCount();
  if (!confirm(`Add 1 extra promotion slot for $2.99?\nYou'll go from ${currentMax} to ${currentMax + 1} slots.`)) return;

  // Try Stripe checkout
  try {
    const configRes = await fetch('/api/stripe/config');
    const config = await configRes.json();

    if (config.enabled) {
      const res = await fetch('/api/stripe/buy-slot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: user })
      });
      const data = await res.json();
      if (data.url) {
        window.location.href = data.url;
        return;
      } else {
        alert(data.error || 'Failed to start checkout');
        return;
      }
    }
  } catch (err) {
    console.log('Stripe not available, using local purchase:', err);
  }

  // Fallback: local (when Stripe not configured)
  if (users[key]) {
    users[key].extraPromoteSlots = currentExtra + 1;
    localStorage.setItem('cardHuddleUsers', JSON.stringify(users));
  }
  renderPromotedCards();
}

function initPromoteTab() {
  const sub = getUserSubscription();
  const gate = document.getElementById('promote-pro-gate');
  const content = document.getElementById('promote-content');
  if (!sub) {
    gate.classList.remove('hidden');
    content.classList.add('hidden');
  } else {
    gate.classList.add('hidden');
    content.classList.remove('hidden');
    populatePromoteAutofill();
    renderPromotedCards();
  }
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
  const sub = getUserSubscription();
  if (!sub) { showPricing(); return false; }

  const cards = getPromotedCards();
  const maxSlots = getPromoteSlotCount();
  if (cards.length >= maxSlots) {
    alert(`You've used all ${maxSlots} promotion slots. Remove one or buy an extra slot.`);
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
  const buySlotWrap = document.getElementById('promote-buy-slot-wrap');

  const maxSlots = getPromoteSlotCount();
  countEl.textContent = cards.length;
  if (maxEl) maxEl.textContent = maxSlots;
  submitBtn.disabled = cards.length >= maxSlots;

  // Show/hide buy extra slot button
  if (buySlotWrap) {
    buySlotWrap.classList.toggle('hidden', cards.length < maxSlots);
    const user = getCurrentUser();
    const users = user ? getUsers() : {};
    const extraUsed = user ? (users[user.toLowerCase()]?.extraPromoteSlots || 0) : 0;
    const capInfo = document.getElementById('promote-extra-cap-info');
    const buyBtn = buySlotWrap.querySelector('.promote-buy-slot-btn');
    if (capInfo) capInfo.textContent = `Extra slots: ${extraUsed} / 10 purchased`;
    if (buyBtn) buyBtn.disabled = extraUsed >= 10;
  }

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

// Inject promoted cards into a results grid at evenly spaced positions
function injectPromotedCards(grid) {
  const promos = getPromotedCards();
  if (promos.length === 0) return;

  // Shuffle so it's not always the same order
  const shuffled = [...promos].sort(() => Math.random() - 0.5);

  const existingCards = grid.querySelectorAll('.card:not(.promoted-card)');
  const count = existingCards.length;
  if (count < 2) return; // Don't inject if too few results

  // Show a promoted card every 10 results
  const spacing = 10;

  shuffled.forEach((promo, i) => {
    const insertIndex = spacing * (i + 1);
    const refCards = grid.querySelectorAll('.card:not(.promoted-card)');
    if (insertIndex < refCards.length) {
      const promoCard = buildPromotedCard(promo);
      promoCard.style.animationDelay = `${insertIndex * 0.05}s`;
      refCards[insertIndex].before(promoCard);
    } else {
      // Append at end
      const promoCard = buildPromotedCard(promo);
      grid.appendChild(promoCard);
    }
  });
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

// ---- CSV Export ----
function exportCollectionCSV() {
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
  ['add-card-modal', 'title-autofill-modal'].forEach(id => {
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

  try {
    const params = new URLSearchParams({ q: query, mode: mode, limit: '12' });
    const response = await fetch(`/api/search?${params}`);
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || `Server error ${response.status}`);
    }

    const results = data.results || [];
    const serial = data.serial || null;
    const similarResults = data.similarResults || [];
    const searchType = data.searchType || 'exact';
    const broadenedQuery = data.broadenedQuery || null;
    const approximateValue = data.approximateValue || null;

    if (results.length === 0) {
      // No results at all — show similar numbered cards if available, otherwise empty message
      let emptyHtml = `<div class="cl-listings-empty">No ${mode === 'sold' ? 'sold listings' : 'listings'} found${serial ? ` numbered /${serial}` : ''}.</div>`;

      if (similarResults.length > 0) {
        emptyHtml += `<div class="cl-similar-section">`;
        emptyHtml += `<div class="cl-similar-header">Similar Numbered Cards${serial ? ` (other than /${serial})` : ''}</div>`;
        emptyHtml += `<div class="cl-listings-grid">`;
        similarResults.slice(0, 8).forEach(item => {
          emptyHtml += buildClListingCard(item, mode);
        });
        emptyHtml += '</div></div>';
      }

      body.innerHTML = emptyHtml;
      return;
    }

    // Stats
    const prices = results.map(r => parseFloat(r.price)).filter(p => !isNaN(p));
    const avg = prices.length ? (prices.reduce((a, b) => a + b, 0) / prices.length) : 0;
    const low = prices.length ? Math.min(...prices) : 0;
    const high = prices.length ? Math.max(...prices) : 0;

    const isSold = mode === 'sold';
    const mockBadge = data.mock ? '<span class="mock-badge" style="font-size:0.65rem;">DEMO</span>' : '';

    // Generate reasoning
    const reasoning = generateListingReasoning(results, isSold, serial);

    let html = '';

    // If broadened, show a notice about similar items being displayed
    if (searchType === 'broadened') {
      html += `<div class="cl-broadened-notice">`;
      html += `<span class="cl-broadened-icon">&#128270;</span> `;
      html += `No exact match found. Showing similar items`;
      if (approximateValue) {
        html += ` &mdash; estimated value <strong>~$${approximateValue.medianPrice.toFixed(2)}</strong>`;
        html += ` <span class="cl-broadened-detail">(based on ${approximateValue.sampleSize} ${approximateValue.sampleSize === 1 ? 'sale' : 'sales'} of ${escHtml(approximateValue.basedOn)})</span>`;
      }
      html += `</div>`;
    }

    html += `
      <div class="cl-listings-stats">
        <span>${results.length} ${isSold ? 'sold' : 'listings'}${searchType === 'broadened' ? ' (similar)' : ''} ${mockBadge}</span>
        <span>Avg: $${avg.toFixed(2)}</span>
        <span>Low: $${low.toFixed(2)}</span>
        <span>High: $${high.toFixed(2)}</span>
      </div>
    `;

    if (reasoning) {
      html += `<div class="cl-reasoning">${escHtml(reasoning)}</div>`;
    }

    html += '<div class="cl-listings-grid">';

    results.forEach(item => {
      html += buildClListingCard(item, mode);
    });

    html += '</div>';

    // Show similar numbered cards below exact results if serial search
    if (serial && similarResults.length > 0) {
      html += `<div class="cl-similar-section">`;
      html += `<div class="cl-similar-header">Other Numbered Cards</div>`;
      html += `<div class="cl-listings-grid">`;
      similarResults.slice(0, 6).forEach(item => {
        html += buildClListingCard(item, mode);
      });
      html += '</div></div>';
    }

    body.innerHTML = html;

  } catch (err) {
    body.innerHTML = `<div class="cl-listings-empty">Error: ${escHtml(err.message)}</div>`;
  }
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
