// ---- Theme ----
(function initTheme() {
  const saved = localStorage.getItem('cardHuddleTheme');
  if (saved === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
  }
})();

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
      return `
        <div class="tracked-card-item" data-id="${a.id}">
          <div class="tracked-card-icon">&#128276;</div>
          <div class="tracked-card-info">
            <div class="tracked-card-query">${escHtml(a.label)}</div>
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
          body: JSON.stringify({ username: user, email, query, label: query }),
        });
        const data = await res.json();
        if (!res.ok) {
          errEl.textContent = data.error || 'Failed to track card';
          errEl.classList.remove('hidden');
          return;
        }
        input.value = '';
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
let currentMode = 'forsale'; // 'forsale' or 'sold'
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
      if (isDirectCardSearch(query)) {
        fetchDirectSearch(query);
      } else {
        fetchVariants(query);
      }
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
    if (query) {
      if (currentSearchMode === 'direct') {
        fetchDirectSearch(query);
      } else if (currentSearchMode === 'variants' && !backBtn.classList.contains('hidden')) {
        // Viewing a variant's results — re-search with new mode
        performSearch(query);
      } else if (currentSearchMode === 'variants') {
        fetchVariants(currentVariantQuery || query);
      }
    }
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
  sorted.forEach((item, i) => {
    const card = buildCard(item);
    card.style.animationDelay = `${i * 0.05}s`;
    grid.appendChild(card);
  });
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
  if (isDirectCardSearch(query)) {
    await fetchDirectSearch(query);
  } else {
    await fetchVariants(query);
  }
});

// ---- Suggestion chips ----
document.querySelectorAll('.chip').forEach(chip => {
  chip.addEventListener('click', () => {
    const query = chip.dataset.query;
    input.value = query;
    suggestionsSection.classList.add('hidden');
    recentSection.classList.add('hidden');
    addRecentSearch(query);
    fetchVariants(query);
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
    const data = await response.json();

    if (response.status === 401) { showLogin(); return; }
    if (!response.ok) {
      const msg = data.detail ? `${data.error}: ${data.detail}` : (data.error || `Server error ${response.status}`);
      throw new Error(msg);
    }

    cachedVariants = data.variants;
    displayVariants(data.variants, query, data.mock, data.serial);

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
  if (cachedVariants) {
    displayVariants(cachedVariants, currentVariantQuery, false);
  } else {
    fetchVariants(currentVariantQuery);
  }
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
    const data = await response.json();

    if (response.status === 401) { showLogin(); return; }
    if (!response.ok) {
      const msg = data.detail ? `${data.error}: ${data.detail}` : (data.error || `Server error ${response.status}`);
      throw new Error(msg);
    }

    const { results, mock, searchType, approximateValue } = data;
    currentResults = results;
    recordPriceHistory(query, results);

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
      results.forEach((item, i) => {
        const card = buildCard(item);
        card.style.animationDelay = `${i * 0.05}s`;
        grid.appendChild(card);
      });
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
    const data = await response.json();

    if (response.status === 401) { showLogin(); return; }
    if (!response.ok) {
      const msg = data.detail ? `${data.error}: ${data.detail}` : (data.error || `Server error ${response.status}`);
      throw new Error(msg);
    }

    const { results, mock, serial, similarResults } = data;
    currentResults = results;
    recordPriceHistory(query, results);

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
      results.forEach((item, i) => {
        const card = buildCard(item);
        card.style.animationDelay = `${i * 0.05}s`;
        grid.appendChild(card);
      });
      if (isSold) updatePriceChart(results);

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

// ---- Price Chart ----
function updatePriceChart(results) {
  if (typeof Chart === 'undefined') return;

  const sorted = [...results]
    .filter(r => r.soldDate && r.price)
    .sort((a, b) => new Date(a.soldDate) - new Date(b.soldDate));

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

  const dateStr = item.soldDate
    ? new Date(item.soldDate).toLocaleDateString('en-US', {
        year: 'numeric', month: 'short', day: 'numeric',
      })
    : '';

  const dateHtml = isSold && dateStr
    ? `<span class="card-date">Sold: ${dateStr}</span>`
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
      <a class="card-link"
         href="${escHtml(item.itemUrl)}"
         target="_blank"
         rel="noopener noreferrer">
        View on eBay &#8599;
      </a>
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

  // eBay link
  cardModalLink.href = item.itemUrl || '#';

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
  dropdown = document.createElement('div');
  dropdown.className = 'auth-dropdown';
  dropdown.innerHTML = `
    <button onclick="closeAuthDropdown()">My Account</button>
    <button onclick="handleLogout()">Log Out</button>
  `;
  authBtn.parentElement.appendChild(dropdown);

  // Close on outside click
  setTimeout(() => {
    document.addEventListener('click', closeDropdownOutside, { once: true });
  }, 0);
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

function handleAuth(e) {
  e.preventDefault();
  const username = document.getElementById('auth-username').value.trim();
  const password = document.getElementById('auth-password').value;
  loginError.classList.add('hidden');

  if (authMode === 'signup') {
    const confirm = authConfirm.value;
    if (password !== confirm) {
      loginError.textContent = 'Passwords do not match';
      loginError.classList.remove('hidden');
      return false;
    }
    const users = getUsers();
    if (users[username.toLowerCase()]) {
      loginError.textContent = 'Username already taken';
      loginError.classList.remove('hidden');
      return false;
    }
    const email = document.getElementById('auth-email').value.trim();
    users[username.toLowerCase()] = { username, password, email, createdAt: new Date().toISOString() };
    localStorage.setItem('cardHuddleUsers', JSON.stringify(users));
    setCurrentUser(username);
    closeLogin();
  } else {
    const users = getUsers();
    const user = users[username.toLowerCase()];
    if (!user || user.password !== password) {
      loginError.textContent = 'Invalid username or password';
      loginError.classList.remove('hidden');
      return false;
    }
    setCurrentUser(user.username);
    closeLogin();
  }
  return false;
}

function handleLogout() {
  closeAuthDropdown();
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
  const priceEl = document.getElementById('pro-price');
  const freqEl = document.getElementById('pro-freq');
  if (period === 'yearly') {
    priceEl.textContent = '$39.99';
    freqEl.textContent = '/yr';
  } else {
    priceEl.textContent = '$4.99';
    freqEl.textContent = '/mo';
  }
}

function handleSubscribe(plan) {
  const user = getCurrentUser();
  if (!user) {
    closePricing();
    showLogin();
    return;
  }
  // Store subscription in localStorage
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
let checklistVariantFilters = {}; // { setIndex: { name, printRun } }

const trackedView = document.getElementById('tracked-view');

const collectionView = document.getElementById('collection-view');

function switchView(view) {
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
  const activeTab = document.querySelector(`.nav-tab[data-view="${view}"]`);
  if (activeTab) activeTab.classList.add('active');

  mainEl.classList.add('hidden');
  checklistView.classList.add('hidden');
  trackedView.classList.add('hidden');
  collectionView.classList.add('hidden');

  if (view === 'checklist') {
    checklistView.classList.remove('hidden');
    if (!checklistData) loadChecklistProducts();
  } else if (view === 'tracked') {
    trackedView.classList.remove('hidden');
    initTrackedView();
  } else if (view === 'collection') {
    collectionView.classList.remove('hidden');
    initCollectionView();
  } else {
    mainEl.classList.remove('hidden');
  }
}

async function loadChecklistProducts() {
  checklistProductGrid.innerHTML = '<div class="checklist-loading"><div class="spinner"></div><span>Loading checklists...</span></div>';
  try {
    const res = await fetch('/api/checklists');
    const data = await res.json();
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
    const res = await fetch(`/api/checklists/${productId}`);
    checklistData = await res.json();
    checklistProductName.textContent = checklistData.name;
    checklistFilter = 'all';
    checklistVariantFilters = {};
    checklistSearch.value = '';
    document.querySelectorAll('.checklist-cat-tab').forEach(t => t.classList.toggle('active', t.dataset.cat === 'all'));
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

    // Filter cards if searching
    let cards = set.cards;
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
      <div class="checklist-set-header" onclick="this.parentElement.classList.toggle('expanded')">
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
                <td class="cl-action">
                  <button class="cl-coll-btn" onclick="event.stopPropagation(); addToCollectionFromChecklist('${playerEsc}', '${year}', '${brand}', '${setName}', '${variantLabel}', '${variantPR || printRun}'); this.textContent='&#10003;'; this.classList.add('cl-coll-added')" title="Add to collection">+</button>
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
  fetchVariants(query);
}

function searchFromChecklist(player, year, brand, setName, category) {
  const query = buildChecklistQuery(player, year, brand, setName, category);
  input.value = query;
  switchView('search');
  addRecentSearch(query);
  fetchVariants(query);
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
    <a class="cl-listing-item" href="${escHtml(item.itemUrl)}" target="_blank" rel="noopener noreferrer">
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

  const listEl = document.getElementById('portfolio-list');
  if (coll.length === 0) {
    listEl.innerHTML = '<p class="portfolio-empty">No cards in your collection yet. Add cards from checklists or use the button above.</p>';
    return;
  }
  listEl.innerHTML = coll.map((c, i) => {
    const gl = (c.estValue || 0) - (c.purchasePrice || 0);
    const glClass = gl >= 0 ? 'gain' : 'loss';
    return `
      <div class="portfolio-card-item">
        <div class="portfolio-card-info">
          <div class="portfolio-card-name">${escHtml(c.name)}</div>
          <div class="portfolio-card-meta">${c.condition ? escHtml(c.condition) : ''}${c.notes ? ' &middot; ' + escHtml(c.notes) : ''}</div>
        </div>
        <div class="portfolio-card-prices">
          <span class="portfolio-card-cost">Paid: $${(c.purchasePrice || 0).toFixed(2)}</span>
          <span class="portfolio-card-value ${glClass}">${gl >= 0 ? '+' : ''}$${gl.toFixed(2)}</span>
        </div>
        <button class="portfolio-card-remove" onclick="removeFromCollection(${i})" title="Remove">&times;</button>
      </div>`;
  }).join('');
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

function addToCollectionFromChecklist(player, year, brand, setName, parallel, printRun) {
  const name = `${player} ${year} ${brand} ${setName}${parallel ? ' ' + parallel : ''}`;
  const coll = getCollection();
  coll.push({ name, purchasePrice: 0, estValue: 0, condition: '', notes: printRun ? `/${printRun}` : '', addedAt: new Date().toISOString() });
  saveCollection(coll);
}

function removeFromCollection(idx) {
  const coll = getCollection();
  coll.splice(idx, 1);
  saveCollection(coll);
  renderPortfolio();
}

// ---- Set Completion Tracker ----
let completionData = null;
let rainbowMode = false;

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
    const res = await fetch('/api/checklists');
    const data = await res.json();
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
    const res = await fetch(`/api/checklists/${productId}`);
    completionData = await res.json();
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
  if (completionData) renderCompletionSets();
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
    let setTotal = 0, setOwned = 0;

    if (rainbowMode && set.parallels && set.parallels.length > 0) {
      // Rainbow: each card x each parallel
      const variants = [{ name: 'Base', printRun: '' }, ...set.parallels];
      setTotal = cards.length * variants.length;
      cards.forEach((c, ci) => {
        variants.forEach((v, vi) => {
          const key = `${setKey}_c${ci}_v${vi}`;
          if (owned[key]) setOwned++;
        });
      });
    } else {
      setTotal = cards.length;
      cards.forEach((c, ci) => {
        const key = `${setKey}_c${ci}`;
        if (owned[key]) setOwned++;
      });
    }
    totalCards += setTotal;
    ownedCount += setOwned;

    const pct = setTotal > 0 ? Math.round((setOwned / setTotal) * 100) : 0;
    const isComplete = pct === 100;

    html += `<div class="completion-set ${isComplete ? 'complete' : ''}">
      <div class="completion-set-header" onclick="toggleCompletionSet(${si})">
        <span class="completion-set-name">${escHtml(set.name)}</span>
        <span class="completion-set-count">${setOwned}/${setTotal} (${pct}%)</span>
        <div class="completion-mini-bar"><div class="completion-mini-fill" style="width:${pct}%"></div></div>
      </div>
      <div class="completion-set-cards hidden" id="completion-cards-${si}">`;

    cards.forEach((c, ci) => {
      if (rainbowMode && set.parallels && set.parallels.length > 0) {
        const variants = [{ name: 'Base', printRun: '' }, ...set.parallels];
        html += `<div class="completion-card-row">
          <span class="completion-card-player">${escHtml(c.number)} ${escHtml(c.player)}</span>
          <div class="completion-variants">`;
        variants.forEach((v, vi) => {
          const key = `${setKey}_c${ci}_v${vi}`;
          const checked = owned[key] ? 'checked' : '';
          html += `<label class="completion-variant-check ${owned[key] ? 'owned' : ''}">
            <input type="checkbox" ${checked} onchange="toggleCompletionCard('${productKey}','${key}',this)" />
            <span>${escHtml(v.name)}${v.printRun ? ' /' + v.printRun : ''}</span>
          </label>`;
        });
        html += `</div></div>`;
      } else {
        const key = `${setKey}_c${ci}`;
        const checked = owned[key] ? 'checked' : '';
        html += `<label class="completion-card-row completion-check-row ${owned[key] ? 'owned' : ''}">
          <input type="checkbox" ${checked} onchange="toggleCompletionCard('${productKey}','${key}',this)" />
          <span>${escHtml(c.number)} ${escHtml(c.player)}${c.team ? ' — ' + escHtml(c.team) : ''}</span>
        </label>`;
      }
    });
    html += `</div></div>`;
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
  renderCompletionSets();
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

    let setTotal = 0, setOwned = 0;

    if (rainbowMode && set.parallels && set.parallels.length > 0) {
      const variants = [{ name: 'Base', printRun: '' }, ...set.parallels];
      setTotal = playerCards.length * variants.length;
      playerCards.forEach(c => {
        variants.forEach((v, vi) => {
          const key = `${setKey}_c${c.ci}_v${vi}`;
          if (owned[key]) setOwned++;
        });
      });
    } else {
      setTotal = playerCards.length;
      playerCards.forEach(c => {
        const key = `${setKey}_c${c.ci}`;
        if (owned[key]) setOwned++;
      });
    }

    totalCards += setTotal;
    ownedCount += setOwned;
    const pct = setTotal > 0 ? Math.round((setOwned / setTotal) * 100) : 0;
    const isComplete = pct === 100;

    html += `<div class="completion-set ${isComplete ? 'complete' : ''}">
      <div class="completion-set-header" onclick="togglePlayerCompletionSet(${si})">
        <span class="completion-set-name">${escHtml(set.name)}</span>
        <span class="completion-set-count">${setOwned}/${setTotal} (${pct}%)</span>
        <div class="completion-mini-bar"><div class="completion-mini-fill" style="width:${pct}%"></div></div>
      </div>
      <div class="completion-set-cards hidden" id="player-completion-cards-${si}">`;

    playerCards.forEach(c => {
      if (rainbowMode && set.parallels && set.parallels.length > 0) {
        const variants = [{ name: 'Base', printRun: '' }, ...set.parallels];
        html += `<div class="completion-card-row">
          <span class="completion-card-player">${escHtml(c.number)} ${escHtml(c.player)}</span>
          <div class="completion-variants">`;
        variants.forEach((v, vi) => {
          const key = `${setKey}_c${c.ci}_v${vi}`;
          const checked = owned[key] ? 'checked' : '';
          html += `<label class="completion-variant-check ${owned[key] ? 'owned' : ''}">
            <input type="checkbox" ${checked} onchange="togglePlayerCompletionCard('${productKey}','${key}',this)" />
            <span>${escHtml(v.name)}${v.printRun ? ' /' + v.printRun : ''}</span>
          </label>`;
        });
        html += `</div></div>`;
      } else {
        const key = `${setKey}_c${c.ci}`;
        const checked = owned[key] ? 'checked' : '';
        html += `<label class="completion-card-row completion-check-row ${owned[key] ? 'owned' : ''}">
          <input type="checkbox" ${checked} onchange="togglePlayerCompletionCard('${productKey}','${key}',this)" />
          <span>${escHtml(c.number)} ${escHtml(c.player)}${c.team ? ' — ' + escHtml(c.team) : ''}</span>
        </label>`;
      }
    });
    html += `</div></div>`;
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

// ---- eBay Listing Helper ----
function showEbayListingHelper() {
  document.getElementById('listing-helper-modal').classList.remove('hidden');
  document.getElementById('listing-helper-input').focus();
}
function closeEbayListingHelper() {
  document.getElementById('listing-helper-modal').classList.add('hidden');
}

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
        // Build title — eBay allows up to 80 chars
        let title = `${c.year} ${c.brand} ${c.productName} ${c.player} #${c.number}${pName}${pr}${autoTag}${rcTag} Football`.replace(/\s+/g, ' ').trim();
        // Truncate if over 80 chars
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

// Enter key for listing helper
document.addEventListener('DOMContentLoaded', () => {
  const lhInput = document.getElementById('listing-helper-input');
  if (lhInput) lhInput.addEventListener('keydown', e => { if (e.key === 'Enter') generateListingTitles(); });
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
  ['add-card-modal', 'listing-helper-modal'].forEach(id => {
    const el = document.getElementById(id);
    if (e.target === el) el.classList.add('hidden');
  });
});

// ---- Layout Mode (Computer vs Mobile) ----
(function initLayoutPicker() {
  const saved = localStorage.getItem('cardHuddleLayout');
  if (saved) {
    // Already chosen — apply immediately, hide picker
    document.documentElement.classList.toggle('mobile-layout', saved === 'mobile');
    const picker = document.getElementById('layout-picker');
    if (picker) picker.classList.add('hidden');
    updateLayoutButtons(saved);
  }
  // If no saved preference, the picker popup will show (it's visible by default)
})();

function setLayoutMode(mode) {
  localStorage.setItem('cardHuddleLayout', mode);
  document.documentElement.classList.toggle('mobile-layout', mode === 'mobile');
  // Hide the popup
  const picker = document.getElementById('layout-picker');
  if (picker) picker.classList.add('hidden');
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
