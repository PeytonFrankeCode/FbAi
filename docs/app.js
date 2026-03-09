// ---- Element refs ----
const form = document.getElementById('search-form');
const input = document.getElementById('search-input');
const btn = document.getElementById('search-btn');
const loading = document.getElementById('loading');
const errorMsg = document.getElementById('error-message');
const grid = document.getElementById('results-grid');
const meta = document.getElementById('search-meta');
const suggestionsSection = document.getElementById('suggestions-section');
const chartSection = document.getElementById('chart-section');
const chartCanvas = document.getElementById('price-chart');
let priceChart = null;

// ---- Form submit ----
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const query = input.value.trim();
  if (!query) return;
  await performSearch(query);
});

// ---- Suggestion chips ----
document.querySelectorAll('.chip').forEach(chip => {
  chip.addEventListener('click', () => {
    const query = chip.dataset.query;
    input.value = query;
    performSearch(query);
  });
});

// ---- Mock Data ----
const CARD_IMAGES = {
  mahomes: 'https://upload.wikimedia.org/wikipedia/commons/thumb/6/6d/Patrick_Mahomes_%2852093826121%29_%28cropped%29.jpg/220px-Patrick_Mahomes_%2852093826121%29_%28cropped%29.jpg',
  brady: 'https://upload.wikimedia.org/wikipedia/commons/thumb/b/b4/Tom_Brady%2C_2017.jpg/220px-Tom_Brady%2C_2017.jpg',
  jefferson: 'https://upload.wikimedia.org/wikipedia/commons/thumb/b/b8/Justin_Jefferson_%2852736182289%29_%28cropped%29.jpg/220px-Justin_Jefferson_%2852736182289%29_%28cropped%29.jpg',
  allen: 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/ef/Josh_Allen_%2852093827427%29_%28cropped%29.jpg/220px-Josh_Allen_%2852093827427%29_%28cropped%29.jpg',
  chase: 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/8c/Ja%27Marr_Chase_%2852828834491%29_%28cropped%29.jpg/220px-Ja%27Marr_Chase_%2852828834491%29_%28cropped%29.jpg',
  lamb: 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/8c/CeeDee_Lamb_2022_%28cropped%29.jpg/220px-CeeDee_Lamb_2022_%28cropped%29.jpg',
};

function getPlayerImage(query) {
  const q = query.toLowerCase();
  if (q.includes('mahomes')) return CARD_IMAGES.mahomes;
  if (q.includes('brady')) return CARD_IMAGES.brady;
  if (q.includes('jefferson')) return CARD_IMAGES.jefferson;
  if (q.includes('allen')) return CARD_IMAGES.allen;
  if (q.includes('chase')) return CARD_IMAGES.chase;
  if (q.includes('lamb') || q.includes('ceedee')) return CARD_IMAGES.lamb;
  return null;
}

function getMockData(query) {
  const today = new Date();
  const img = getPlayerImage(query);
  const items = [
    { price: 249.99, condition: 'Graded – PSA 10', daysAgo: 1,  suffix: '2020 Panini Prizm Silver PSA 10 Gem Mint' },
    { price:  89.00, condition: 'Graded – PSA 9',  daysAgo: 2,  suffix: '2020 Panini Prizm PSA 9' },
    { price: 134.50, condition: 'Graded – BGS 9.5',daysAgo: 3,  suffix: '2021 Donruss Optic Holo RC BGS 9.5' },
    { price:  45.00, condition: 'Near Mint+',       daysAgo: 4,  suffix: '2020 Panini Prizm Red White Blue /175' },
    { price: 312.00, condition: 'Graded – PSA 10',  daysAgo: 6,  suffix: '2022 Topps Chrome Refractor Auto #/99' },
    { price: 178.00, condition: 'Near Mint+',       daysAgo: 8,  suffix: '2021 Select Concourse RC' },
    { price:  67.50, condition: 'Graded – PSA 9',   daysAgo: 11, suffix: '2020 Mosaic Silver Prizm PSA 9' },
    { price: 220.00, condition: 'Graded – PSA 10',  daysAgo: 14, suffix: '2022 Prizm Silver Holo PSA 10' },
  ];
  return {
    results: items.map((item, i) => ({
      itemId: `demo-${i}`,
      title: `${query} – ${item.suffix}`,
      price: String(item.price),
      currency: 'USD',
      soldDate: new Date(today - item.daysAgo * 86400000).toISOString(),
      imageUrl: img,
      itemUrl: `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(query)}&LH_Sold=1&LH_Complete=1`,
      condition: item.condition,
    })),
    mock: true,
  };
}

// ---- Search ----
async function performSearch(query) {
  setLoading(true);
  grid.innerHTML = '';
  errorMsg.classList.add('hidden');
  meta.classList.add('hidden');
  chartSection.classList.add('hidden');
  suggestionsSection.classList.add('hidden');
  if (priceChart) { priceChart.destroy(); priceChart = null; }

  await new Promise(r => setTimeout(r, 500));

  const { results, mock } = getMockData(query);
  const prices = results.map(r => parseFloat(r.price));
  const avg  = prices.reduce((a, b) => a + b, 0) / prices.length;
  const minP = Math.min(...prices);
  const maxP = Math.max(...prices);

  // Stats bar
  const statsEl = document.createElement('div');
  statsEl.className = 'stats-bar';
  statsEl.innerHTML = `
    <div class="stat-item"><span class="stat-label">Results</span><span class="stat-value">${results.length}</span></div>
    <div class="stat-item"><span class="stat-label">Avg Sale</span><span class="stat-value">$${avg.toFixed(2)}</span></div>
    <div class="stat-item"><span class="stat-label">Low</span><span class="stat-value">$${minP.toFixed(2)}</span></div>
    <div class="stat-item"><span class="stat-label">High</span><span class="stat-value">$${maxP.toFixed(2)}</span></div>
  `;
  grid.appendChild(statsEl);

  const mockNote = mock ? ' <span class="mock-badge">DEMO DATA — connect eBay API for live results</span>' : '';
  meta.innerHTML = `Showing ${results.length} sold listings for &ldquo;${escHtml(query)}&rdquo;${mockNote}`;
  meta.classList.remove('hidden');

  results.forEach(item => grid.appendChild(buildCard(item)));
  updatePriceChart(results);
  setLoading(false);
}

// ---- Price Chart ----
function updatePriceChart(results) {
  if (typeof Chart === 'undefined') return;
  const sorted = [...results]
    .filter(r => r.soldDate && r.price)
    .sort((a, b) => new Date(a.soldDate) - new Date(b.soldDate));
  if (sorted.length < 2) { chartSection.classList.add('hidden'); return; }

  const labels = sorted.map(r =>
    new Date(r.soldDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  );
  const data = sorted.map(r => parseFloat(r.price));

  if (priceChart) { priceChart.destroy(); priceChart = null; }
  priceChart = new Chart(chartCanvas, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Sale Price (USD)',
        data,
        borderColor: '#52b788',
        backgroundColor: 'rgba(82,183,136,0.08)',
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
          callbacks: { label: ctx => ` $${ctx.parsed.y.toFixed(2)}` }
        }
      },
      scales: {
        x: { grid: { color: '#1a2030' }, ticks: { color: '#8d99ae', font: { size: 11 } } },
        y: { grid: { color: '#2d3748' }, ticks: { color: '#8d99ae', font: { size: 11 }, callback: v => `$${v}` }, beginAtZero: false }
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
  burrow: '#FB4F14', bengals: '#FB4F14', chase: '#FB4F14',
  lamb: '#003594', cowboys: '#003594', ceedee: '#003594',
  jackson: '#241773', ravens: '#241773',
  purdy: '#AA0000', niners: '#AA0000',
  eagles: '#004C54', hurts: '#004C54',
  stroud: '#03202F', texans: '#03202F',
};
function getTeamColor(title) {
  const low = (title || '').toLowerCase();
  for (const [key, color] of Object.entries(TEAM_COLORS)) {
    if (low.includes(key)) return color;
  }
  return '#52b788';
}

// ---- Build Card ----
function buildCard(item) {
  const card = document.createElement('div');
  card.className = 'card';
  card.style.setProperty('--team-color', getTeamColor(item.title));

  const price = item.price ? `$${parseFloat(item.price).toFixed(2)}` : 'N/A';
  const date  = item.soldDate
    ? new Date(item.soldDate).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
    : '—';

  const imageHtml = item.imageUrl
    ? `<img src="${escHtml(item.imageUrl)}" alt="${escHtml(item.title)}" loading="lazy" />`
    : `<div class="no-image"><span class="no-image-icon">🏈</span><span>No image</span></div>`;

  card.innerHTML = `
    <div class="card-accent"></div>
    <div class="sold-badge">SOLD</div>
    <div class="card-image-wrap">${imageHtml}</div>
    <div class="card-body">
      <p class="card-title">${escHtml(item.title)}</p>
      <p class="card-price">${price}</p>
      <div class="card-meta">
        <span class="card-date">📅 ${date}</span>
        <span class="card-condition">${escHtml(item.condition)}</span>
      </div>
      <a class="card-link" href="${escHtml(item.itemUrl)}" target="_blank" rel="noopener noreferrer">
        Search eBay ↗
      </a>
    </div>
  `;
  return card;
}

// ---- Helpers ----
function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function setLoading(on) {
  btn.disabled = on;
  loading.classList.toggle('hidden', !on);
}

// ---- Auto-load on page open ----
window.addEventListener('DOMContentLoaded', () => {
  const defaultQuery = 'Patrick Mahomes Prizm';
  input.value = defaultQuery;
  performSearch(defaultQuery);
});
