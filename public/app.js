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

function switchView(view) {
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
  document.querySelector(`.nav-tab[data-view="${view}"]`).classList.add('active');

  if (view === 'checklist') {
    mainEl.classList.add('hidden');
    checklistView.classList.remove('hidden');
    if (!checklistData) loadChecklistProducts();
  } else {
    mainEl.classList.remove('hidden');
    checklistView.classList.add('hidden');
  }
}

async function loadChecklistProducts() {
  checklistProductGrid.innerHTML = '<div class="checklist-loading"><div class="spinner"></div><span>Loading checklists...</span></div>';
  try {
    const res = await fetch('/api/checklists');
    const data = await res.json();
    checklistProductGrid.innerHTML = '';
    data.products.forEach(p => {
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
      checklistProductGrid.appendChild(card);
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

    // Parallels summary
    const parallelsList = set.parallels.map(p => {
      const pr = p.printRun ? ` /${p.printRun}` : '';
      return `<span class="checklist-parallel">${escHtml(p.name)}${pr}</span>`;
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
              ${hasPrintRuns ? `<th class="cl-pr-header" data-set-id="${escHtml(setId)}" onclick="sortChecklistByPrintRun(this)">Print Run <span class="cl-sort-arrow">&#9660;</span></th>` : ''}
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
              return `
              <tr data-print-run="${c.printRun || ''}" data-card-num="${c.number}">
                <td class="cl-num">${escHtml(c.number)}</td>
                <td class="cl-player"><a href="#" class="cl-player-link" onclick="event.preventDefault(); togglePlayerListings(this, '${playerEsc}', '${year}', '${brand}', '${setName}', '${category}', '${cardNum}', '${printRun}')">${escHtml(c.player)}</a></td>
                <td class="cl-team">${escHtml(c.team)}</td>
                ${hasPrintRuns ? `<td class="cl-printrun ${printRun && parseInt(printRun) <= 25 ? 'cl-pr-rare' : printRun && parseInt(printRun) <= 99 ? 'cl-pr-low' : ''}">${printRun ? '/' + printRun : ''}</td>` : ''}
                <td class="cl-action"><button class="cl-search-btn" onclick="searchFromChecklist('${playerEsc}', '${year}', '${brand}', '${setName}', '${category}')" title="Search eBay">&#128269;</button></td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    `;

    checklistSets.appendChild(setEl);
  });
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
