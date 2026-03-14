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
