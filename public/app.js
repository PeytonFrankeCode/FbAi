// ---- Auth ----
const loginOverlay = document.getElementById('login-overlay');
const loginForm = document.getElementById('login-form');
const loginError = document.getElementById('login-error');
const loginBtn = document.getElementById('login-btn');
let authToken = sessionStorage.getItem('authToken');

function showLogin() {
  authToken = null;
  sessionStorage.removeItem('authToken');
  loginOverlay.classList.remove('hidden');
}

function hideLogin() {
  loginOverlay.classList.add('hidden');
}

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = document.getElementById('code-input').value.trim();
  loginBtn.disabled = true;
  loginBtn.textContent = 'Checking...';
  try {
    const res = await fetch('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Invalid code');
    authToken = data.token;
    sessionStorage.setItem('authToken', authToken);
    loginError.classList.add('hidden');
    hideLogin();
  } catch (_) {
    loginError.classList.remove('hidden');
    document.getElementById('code-input').value = '';
    document.getElementById('code-input').focus();
  } finally {
    loginBtn.disabled = false;
    loginBtn.textContent = 'Access';
  }
});

// Show login on load if no token
if (!authToken) {
  showLogin();
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
let priceChart = null;

// State
let cachedVariants = null;
let currentVariantQuery = '';
let currentSearchMode = 'variants'; // 'variants' or 'direct'
let currentMode = 'forsale'; // 'forsale' or 'sold'

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

// ---- Known sets/parallels for client-side detection ----
const CLIENT_KNOWN_SETS = ['Prizm', 'Select', 'Mosaic', 'Optic', 'Donruss', 'Bowman', 'Topps', 'Chronicles',
  'Contenders', 'Score', 'Immaculate', 'Spectra', 'Fleer', 'Hoops', 'Revolution', 'Absolute',
  'Certified', 'Playoff', 'National Treasures'];
const CLIENT_KNOWN_PARALLELS = ['Silver', 'Gold', 'Blue', 'Green', 'Red', 'Purple', 'Orange', 'Pink',
  'Holo', 'Shimmer', 'Hyper', 'Concourse', 'Rainbow', 'Scope', 'Disco', 'Neon', 'Wave', 'Camo',
  'Tie-Dye', 'Black', 'White', 'Aqua', 'Teal', 'Emerald', 'Ruby', 'Sapphire', 'Copper'];

function isDirectCardSearch(query) {
  const lower = query.toLowerCase();
  let matches = 0;
  if (/\b(201[5-9]|202[0-9])\b/.test(query)) matches++;
  if (CLIENT_KNOWN_SETS.some(s => lower.includes(s.toLowerCase()))) matches++;
  if (CLIENT_KNOWN_PARALLELS.some(p => lower.includes(p.toLowerCase()))) matches++;
  return matches >= 2;
}

// ---- Form submit ----
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const query = input.value.trim();
  if (!query) return;
  suggestionsSection.classList.add('hidden');
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

  // Reset UI
  variantsSection.classList.add('hidden');
  backBtn.classList.add('hidden');
  grid.innerHTML = '';
  meta.classList.add('hidden');
  chartSection.classList.add('hidden');
  errorMsg.classList.add('hidden');
  if (priceChart) { priceChart.destroy(); priceChart = null; }

  loadingText.textContent = currentMode === 'sold' ? 'Finding sold card variants...' : 'Finding card variants...';
  setLoading(true);

  try {
    const params = new URLSearchParams({ q: query, mode: currentMode });
    const response = await fetch(`/api/variants?${params}`, {
      headers: { 'Authorization': `Bearer ${authToken}` },
    });
    const data = await response.json();

    if (response.status === 401) { showLogin(); return; }
    if (!response.ok) {
      const msg = data.detail ? `${data.error}: ${data.detail}` : (data.error || `Server error ${response.status}`);
      throw new Error(msg);
    }

    cachedVariants = data.variants;
    displayVariants(data.variants, query, data.mock);

  } catch (err) {
    errorMsg.textContent = `Error: ${err.message}`;
    errorMsg.classList.remove('hidden');
  } finally {
    setLoading(false);
    loadingText.textContent = currentMode === 'sold' ? 'Searching eBay sold listings...' : 'Searching eBay listings...';
  }
}

// ---- Display Variants ----
function displayVariants(variants, query, mock) {
  variantsGrid.innerHTML = '';

  const mockBadge = mock ? ' <span class="mock-badge">DEMO DATA</span>' : '';
  variantsTitle.innerHTML = `Results for &ldquo;${escHtml(query)}&rdquo;${mockBadge}`;
  const subtitle = document.getElementById('variants-subtitle');
  subtitle.textContent = currentMode === 'sold' ? 'Select a card to view recent sold listings' : 'Select a card to view current listings';

  if (variants.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'no-results';
    empty.textContent = 'No card variants found. Try a broader search term.';
    variantsGrid.appendChild(empty);
  } else {
    variants.forEach(v => variantsGrid.appendChild(buildVariantCard(v)));
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
  input.value = variant.displayName;
  window.scrollTo({ top: 0, behavior: 'smooth' });
  performSearch(variant.searchQuery);
}

// ---- Go Back ----
function goBackToVariants() {
  backBtn.classList.add('hidden');
  approxSection.classList.add('hidden');
  grid.innerHTML = '';
  meta.classList.add('hidden');
  chartSection.classList.add('hidden');
  errorMsg.classList.add('hidden');
  if (priceChart) { priceChart.destroy(); priceChart = null; }

  if (currentSearchMode === 'direct') {
    // Return to search home
    currentSearchMode = 'variants';
    input.value = '';
    suggestionsSection.classList.remove('hidden');
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

  // Reset UI
  variantsSection.classList.add('hidden');
  backBtn.classList.add('hidden');
  approxSection.classList.add('hidden');
  grid.innerHTML = '';
  meta.classList.add('hidden');
  chartSection.classList.add('hidden');
  errorMsg.classList.add('hidden');
  if (priceChart) { priceChart.destroy(); priceChart = null; }

  const isSold = currentMode === 'sold';
  loadingText.textContent = isSold ? 'Searching eBay sold listings...' : 'Searching eBay listings...';
  setLoading(true);

  try {
    const params = new URLSearchParams({ q: query, mode: currentMode });
    const response = await fetch(`/api/direct-search?${params}`, {
      headers: { 'Authorization': `Bearer ${authToken}` },
    });
    const data = await response.json();

    if (response.status === 401) { showLogin(); return; }
    if (!response.ok) {
      const msg = data.detail ? `${data.error}: ${data.detail}` : (data.error || `Server error ${response.status}`);
      throw new Error(msg);
    }

    const { results, mock, searchType, approximateValue } = data;

    // Show approximate value section if broadened
    if (searchType === 'broadened' && approximateValue) {
      buildApproxValueSection(approximateValue, query);
      approxSection.classList.remove('hidden');
    }

    // Stats bar
    if (results.length > 0) {
      const prices = results.map(r => parseFloat(r.price)).filter(p => !isNaN(p));
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
      results.forEach(item => grid.appendChild(buildCard(item)));
      if (isSold) updatePriceChart(results);
    }

    backBtn.classList.remove('hidden');

  } catch (err) {
    errorMsg.textContent = `Error: ${err.message}`;
    errorMsg.classList.remove('hidden');
  } finally {
    setLoading(false);
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

// ---- Search (fetch individual sales for a specific variant) ----
async function performSearch(query) {
  setLoading(true);
  grid.innerHTML = '';
  errorMsg.classList.add('hidden');
  meta.classList.add('hidden');
  chartSection.classList.add('hidden');
  if (priceChart) {
    priceChart.destroy();
    priceChart = null;
  }

  const isSold = currentMode === 'sold';
  loadingText.textContent = isSold ? 'Searching eBay sold listings...' : 'Searching eBay listings...';

  try {
    const params = new URLSearchParams({ q: query, limit: '20', mode: currentMode });
    const response = await fetch(`/api/search?${params}`, {
      headers: { 'Authorization': `Bearer ${authToken}` },
    });
    const data = await response.json();

    if (response.status === 401) { showLogin(); return; }
    if (!response.ok) {
      const msg = data.detail ? `${data.error}: ${data.detail}` : (data.error || `Server error ${response.status}`);
      throw new Error(msg);
    }

    const { results, mock } = data;

    // Stats bar
    if (results.length > 0) {
      const prices = results.map(r => parseFloat(r.price)).filter(p => !isNaN(p));
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

    const mockBadge = mock ? ' <span class="mock-badge">DEMO DATA</span>' : '';
    const listingWord = isSold ? 'sold listing' : 'listing';
    meta.innerHTML = `${results.length} ${listingWord}${results.length !== 1 ? 's' : ''} for &ldquo;${escHtml(query)}&rdquo;${mockBadge}`;
    meta.classList.remove('hidden');

    if (results.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'no-results';
      empty.textContent = isSold ? 'No sold listings found. Try a broader search term.' : 'No listings found. Try a broader search term.';
      grid.appendChild(empty);
    } else {
      results.forEach(item => grid.appendChild(buildCard(item)));
      if (isSold) updatePriceChart(results);
    }

  } catch (err) {
    errorMsg.textContent = `Error: ${err.message}`;
    errorMsg.classList.remove('hidden');
  } finally {
    setLoading(false);
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
          ticks: { color: '#8d99ae', font: { size: 11 } }
        },
        y: {
          grid: { color: '#2d3748' },
          ticks: {
            color: '#8d99ae',
            font: { size: 11 },
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

  card.innerHTML = `
    <div class="card-accent"></div>
    ${badgeHtml}
    <div class="card-image-wrap">${imageHtml}</div>
    <div class="card-body">
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

  return card;
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
