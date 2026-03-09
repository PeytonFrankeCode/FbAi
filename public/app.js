const form = document.getElementById('search-form');
const input = document.getElementById('search-input');
const btn = document.getElementById('search-btn');
const loading = document.getElementById('loading');
const errorMsg = document.getElementById('error-message');
const grid = document.getElementById('results-grid');
const meta = document.getElementById('search-meta');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const query = input.value.trim();
  if (!query) return;
  await performSearch(query);
});

async function performSearch(query) {
  setLoading(true);
  grid.innerHTML = '';
  errorMsg.classList.add('hidden');
  meta.classList.add('hidden');

  try {
    const params = new URLSearchParams({ q: query, limit: '20' });
    const response = await fetch(`/api/search?${params}`);
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || `Server error ${response.status}`);
    }

    const { results, total, mock } = data;

    // Stats bar
    if (results.length > 0) {
      const prices = results
        .map(r => parseFloat(r.price))
        .filter(p => !isNaN(p));

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
          <span class="stat-label">Avg Sale Price</span>
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

    // Meta text
    const mockBadge = mock
      ? ' <span class="mock-badge">DEMO DATA</span>'
      : '';
    meta.innerHTML = `${results.length} sold listing${results.length !== 1 ? 's' : ''} for &ldquo;${escHtml(query)}&rdquo;${mockBadge}`;
    meta.classList.remove('hidden');

    if (results.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'no-results';
      empty.textContent = 'No sold listings found. Try a broader search term.';
      grid.appendChild(empty);
    } else {
      results.forEach(item => grid.appendChild(buildCard(item)));
    }

  } catch (err) {
    errorMsg.textContent = `Error: ${err.message}`;
    errorMsg.classList.remove('hidden');
  } finally {
    setLoading(false);
  }
}

function buildCard(item) {
  const card = document.createElement('div');
  card.className = 'card';

  const price = item.price
    ? `$${parseFloat(item.price).toFixed(2)}`
    : 'Price N/A';

  const date = item.soldDate
    ? new Date(item.soldDate).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      })
    : 'Date N/A';

  const imageHtml = item.imageUrl
    ? `<img src="${escHtml(item.imageUrl)}" alt="${escHtml(item.title)}" loading="lazy" />`
    : `<div class="no-image">
         <span class="no-image-icon">&#127183;</span>
         <span>No image</span>
       </div>`;

  card.innerHTML = `
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
