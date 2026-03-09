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
  suggestionsSection.classList.add('hidden');
  await performSearch(query);
});

// ---- Suggestion chips ----
document.querySelectorAll('.chip').forEach(chip => {
  chip.addEventListener('click', () => {
    const query = chip.dataset.query;
    input.value = query;
    suggestionsSection.classList.add('hidden');
    performSearch(query);
  });
});

// ---- Search ----
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

  try {
    const params = new URLSearchParams({ q: query, limit: '20' });
    const response = await fetch(`/api/search?${params}`);
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || `Server error ${response.status}`);
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
          <span class="stat-label">Avg Sale</span>
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
    meta.innerHTML = `${results.length} sold listing${results.length !== 1 ? 's' : ''} for &ldquo;${escHtml(query)}&rdquo;${mockBadge}`;
    meta.classList.remove('hidden');

    if (results.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'no-results';
      empty.textContent = 'No sold listings found. Try a broader search term.';
      grid.appendChild(empty);
    } else {
      results.forEach(item => grid.appendChild(buildCard(item)));
      updatePriceChart(results);
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

// ---- Build Card ----
function buildCard(item) {
  const card = document.createElement('div');
  card.className = 'card';

  const teamColor = getTeamColor(item.title);
  card.style.setProperty('--team-color', teamColor);

  const price = item.price
    ? `$${parseFloat(item.price).toFixed(2)}`
    : 'Price N/A';

  const date = item.soldDate
    ? new Date(item.soldDate).toLocaleDateString('en-US', {
        year: 'numeric', month: 'short', day: 'numeric',
      })
    : 'Date N/A';

  const imageHtml = item.imageUrl
    ? `<img src="${escHtml(item.imageUrl)}" alt="${escHtml(item.title)}" loading="lazy" />`
    : `<div class="no-image">
         <span class="no-image-icon">&#127183;</span>
         <span>No image</span>
       </div>`;

  card.innerHTML = `
    <div class="card-accent"></div>
    <div class="sold-badge">SOLD</div>
    <div class="card-image-wrap">${imageHtml}</div>
    <div class="card-body">
      <p class="card-title">${escHtml(item.title)}</p>
      <p class="card-price">${price}</p>
      <div class="card-meta">
        <span class="card-date">Sold: ${date}</span>
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
