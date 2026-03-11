require('dotenv').config();
const express = require('express');
const axios = require('axios');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const EBAY_APP_ID = process.env.EBAY_APP_ID;
const EBAY_CERT_ID = process.env.EBAY_CERT_ID; // Client secret for OAuth (Marketplace Insights)
const AUTH_CODE = process.env.AUTH_CODE;
const EBAY_VERIFICATION_TOKEN = process.env.EBAY_VERIFICATION_TOKEN;
const USE_MOCK = process.env.USE_MOCK_DATA === 'true' || !EBAY_APP_ID || EBAY_APP_ID === 'your-ebay-app-id-here';

// Which eBay API to use: 'finding' (legacy) or 'insights' (Marketplace Insights)
const EBAY_API_MODE = process.env.EBAY_API_MODE || 'finding';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---- Auth ----
const validTokens = new Set();

app.post('/api/auth', (req, res) => {
  const { code } = req.body || {};
  if (!AUTH_CODE || code !== AUTH_CODE) {
    return res.status(401).json({ error: 'Invalid access code' });
  }
  const token = crypto.randomUUID();
  validTokens.add(token);
  res.json({ token });
});

function requireAuth(req, res, next) {
  const auth = req.headers['authorization'];
  const token = auth && auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token || !validTokens.has(token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ---- In-memory cache (30 min TTL) to reduce eBay API calls ----
const ebayCache = new Map();
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

function getCached(key) {
  const entry = ebayCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) {
    ebayCache.delete(key);
    return null;
  }
  return entry.data;
}

function setCache(key, data) {
  ebayCache.set(key, { data, ts: Date.now() });
  if (ebayCache.size > 200) {
    const oldest = ebayCache.keys().next().value;
    ebayCache.delete(oldest);
  }
}

// ---- OAuth token management for Marketplace Insights API ----
let oauthToken = null;
let oauthExpiry = 0;

async function getOAuthToken() {
  if (oauthToken && Date.now() < oauthExpiry) return oauthToken;
  if (!EBAY_APP_ID || !EBAY_CERT_ID) {
    throw new Error('EBAY_APP_ID and EBAY_CERT_ID required for Marketplace Insights API');
  }
  const credentials = Buffer.from(`${EBAY_APP_ID}:${EBAY_CERT_ID}`).toString('base64');
  const res = await axios.post(
    'https://api.ebay.com/identity/v1/oauth2/token',
    'grant_type=client_credentials&scope=https://api.ebay.com/oauth/api_scope',
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${credentials}`,
      },
      timeout: 10000,
    }
  );
  oauthToken = res.data.access_token;
  // Expire 5 min early to be safe
  oauthExpiry = Date.now() + (res.data.expires_in - 300) * 1000;
  console.log('eBay OAuth token refreshed');
  return oauthToken;
}

// ---- Rate limit aware retry helper ----
async function withRetry(fn, maxRetries = 2) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isRateLimit = err.response?.status === 500 &&
        JSON.stringify(err.response?.data || '').includes('RateLimiter');
      if (isRateLimit && attempt < maxRetries) {
        const delay = (attempt + 1) * 3000; // 3s, 6s
        console.log(`Rate limited, retrying in ${delay / 1000}s (attempt ${attempt + 1}/${maxRetries})`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
}

// ---- Marketplace Insights API (sold items) ----
async function fetchViaInsightsAPI(keywords, limit) {
  const token = await getOAuthToken();
  const res = await axios.get(
    'https://api.ebay.com/buy/marketplace_insights/v1_beta/item_sales/search',
    {
      params: {
        q: keywords,
        category_ids: '261328',
        limit,
        sort: '-endDate',
      },
      headers: {
        'Authorization': `Bearer ${token}`,
        'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
      },
      timeout: 15000,
    }
  );

  const items = res.data?.itemSales || [];
  const results = items.map(item => ({
    itemId: item.itemId || '',
    title: item.title || '',
    price: item.lastSoldPrice?.value || '0',
    currency: item.lastSoldPrice?.currency || 'USD',
    soldDate: item.lastSoldDate || '',
    imageUrl: item.image?.imageUrl || null,
    itemUrl: item.itemWebUrl || '',
    condition: item.condition || 'Unknown',
  }));

  return { results, total: res.data?.total || results.length };
}

// ---- Browse API (active listings) ----
async function fetchViaBrowseAPI(keywords, limit) {
  console.log(`[Browse API] Searching for: "${keywords}", limit: ${limit}`);
  const token = await getOAuthToken();
  console.log('[Browse API] Got OAuth token, making search request...');
  const res = await axios.get(
    'https://api.ebay.com/buy/browse/v1/item_summary/search',
    {
      params: {
        q: keywords,
        category_ids: '261328',
        limit,
      },
      headers: {
        'Authorization': `Bearer ${token}`,
        'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
      },
      timeout: 15000,
    }
  );

  console.log(`[Browse API] Got ${res.data?.total || 0} total results`);
  const items = res.data?.itemSummaries || [];
  const results = items.map(item => ({
    itemId: item.itemId || '',
    title: item.title || '',
    price: item.price?.value || '0',
    currency: item.price?.currency || 'USD',
    soldDate: item.itemEndDate || '',
    imageUrl: item.thumbnailImages?.[0]?.imageUrl || item.image?.imageUrl || null,
    itemUrl: item.itemWebUrl || '',
    condition: item.condition || 'Unknown',
  }));

  return { results, total: res.data?.total || results.length };
}

// ---- Finding API (legacy, sold items) ----
async function fetchViaFindingAPI(keywords, limit) {
  let ebayResponse;
  try {
    ebayResponse = await axios.get(
      'https://svcs.ebay.com/services/search/FindingService/v1',
      {
        params: {
          'OPERATION-NAME': 'findCompletedItems',
          'SERVICE-VERSION': '1.0.0',
          'SECURITY-APPNAME': EBAY_APP_ID,
          'RESPONSE-DATA-FORMAT': 'JSON',
          'REST-PAYLOAD': '',
          'keywords': keywords,
          'categoryId': '261328',
          'itemFilter(0).name': 'SoldItemsOnly',
          'itemFilter(0).value': 'true',
          'sortOrder': 'EndTimeSoonest',
          'paginationInput.entriesPerPage': limit,
          'outputSelector(0)': 'PictureURLLarge',
          'outputSelector(1)': 'GalleryInfo',
        },
        timeout: 15000,
      }
    );
  } catch (axiosErr) {
    if (axiosErr.response) {
      console.error(`eBay HTTP ${axiosErr.response.status}:`, JSON.stringify(axiosErr.response.data).slice(0, 500));
    }
    throw axiosErr;
  }

  const raw = ebayResponse.data;
  const ack = raw?.findCompletedItemsResponse?.[0]?.ack?.[0];
  if (ack === 'Failure') {
    const ebayError = raw?.findCompletedItemsResponse?.[0]?.errorMessage?.[0]?.error?.[0]?.message?.[0] || 'eBay API returned a failure response';
    const err = new Error(ebayError);
    err.isEbayError = true;
    throw err;
  }

  const searchResult = raw?.findCompletedItemsResponse?.[0]?.searchResult?.[0];
  const items = searchResult?.item || [];

  const results = items.map(item => ({
    itemId: item.itemId?.[0],
    title: item.title?.[0],
    price: item.sellingStatus?.[0]?.currentPrice?.[0]?.['__value__'],
    currency: item.sellingStatus?.[0]?.currentPrice?.[0]?.['@currencyId'] || 'USD',
    soldDate: item.listingInfo?.[0]?.endTime?.[0],
    imageUrl: item.pictureURLLarge?.[0] || item.galleryURL?.[0] || null,
    itemUrl: item.viewItemURL?.[0],
    condition: item.condition?.[0]?.conditionDisplayName?.[0] || 'Unknown',
  }));

  return { results, total: parseInt(searchResult?.['@count'] || '0') };
}

// ---- Shared fetch function (routes to correct API + cache + retry) ----
// mode: 'forsale' (Browse API) or 'sold' (Finding API)
async function fetchEbayItems(keywords, limit = 20, mode = 'forsale') {
  const cacheKey = `${mode}|${keywords}|${limit}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const fetchFn = mode === 'sold'
    ? () => fetchViaFindingAPI(keywords, limit)
    : () => fetchViaBrowseAPI(keywords, limit);

  const response = await withRetry(fetchFn);
  setCache(cacheKey, response);
  return response;
}

// Legacy alias for backward compatibility
async function fetchEbaySoldItems(keywords, limit = 20) {
  return fetchEbayItems(keywords, limit, 'sold');
}

app.get('/api/search', async (req, res) => {
  const query = req.query.q;
  const limit = Math.min(parseInt(req.query.limit) || 20, 50);
  const mode = req.query.mode === 'sold' ? 'sold' : 'forsale';

  if (!query || query.trim().length < 2) {
    return res.status(400).json({ error: 'Query parameter "q" is required (min 2 chars)' });
  }

  if (USE_MOCK) {
    return res.json(getMockData(query));
  }

  try {
    const { results, total } = await fetchEbayItems(query, limit, mode);
    res.json({ results, total, mock: false, mode });
  } catch (err) {
    if (err.isEbayError) {
      console.error('eBay search ack failure:', err.message);
      return res.status(502).json({ error: 'eBay API error', detail: err.message });
    }
    console.error('eBay API error:', err.message);
    const ebayDetail = err.response?.data ? JSON.stringify(err.response.data).slice(0, 200) : err.message;
    const status = err.response?.status || 500;
    res.status(status).json({ error: 'Failed to fetch from eBay', detail: `HTTP ${status}: ${ebayDetail}` });
  }
});

// ---- Title parsing helpers ----
const KNOWN_SETS = ['Prizm', 'Select', 'Mosaic', 'Optic', 'Donruss', 'Bowman', 'Topps', 'Chronicles',
  'Contenders', 'Score', 'Immaculate', 'Spectra', 'Fleer', 'Hoops', 'Revolution', 'Absolute',
  'Certified', 'Playoff', 'National Treasures'];
const KNOWN_PARALLELS = ['Silver', 'Gold', 'Blue', 'Green', 'Red', 'Purple', 'Orange', 'Pink',
  'Holo', 'Shimmer', 'Hyper', 'Concourse', 'Rainbow', 'Scope', 'Disco', 'Neon', 'Wave', 'Camo',
  'Tie-Dye', 'Black', 'White', 'Aqua', 'Teal', 'Emerald', 'Ruby', 'Sapphire', 'Copper'];

function extractYear(title) {
  const match = title.match(/\b(201[5-9]|202[0-9])\b/);
  return match ? match[1] : '';
}

function extractSet(title) {
  for (const s of KNOWN_SETS) {
    if (title.toLowerCase().includes(s.toLowerCase())) return s;
  }
  return '';
}

function extractParallel(title) {
  for (const p of KNOWN_PARALLELS) {
    if (title.toLowerCase().includes(p.toLowerCase())) return p;
  }
  return '';
}

// ---- Query parsing helpers for direct search ----
const NOISE_WORDS = ['panini', 'psa', 'bgs', 'sgc', 'rc', 'rookie', 'base', 'card', 'football', 'nfl'];

function extractPlayerName(query) {
  let name = query;
  // Remove years
  name = name.replace(/\b(201[5-9]|202[0-9])\b/g, '');
  // Remove known sets (case-insensitive)
  for (const s of KNOWN_SETS) {
    name = name.replace(new RegExp('\\b' + s + '\\b', 'gi'), '');
  }
  // Remove known parallels
  for (const p of KNOWN_PARALLELS) {
    name = name.replace(new RegExp('\\b' + p + '\\b', 'gi'), '');
  }
  // Remove noise words
  for (const w of NOISE_WORDS) {
    name = name.replace(new RegExp('\\b' + w + '\\b', 'gi'), '');
  }
  // Remove grading numbers like "10", "9.5"
  name = name.replace(/\b\d+\.?\d*\b/g, '');
  // Remove special chars like #, /
  name = name.replace(/[#\/]/g, '');
  // Collapse whitespace
  return name.replace(/\s+/g, ' ').trim();
}

function parseCardQuery(query) {
  return {
    year: extractYear(query),
    set: extractSet(query),
    parallel: extractParallel(query),
    playerName: extractPlayerName(query),
  };
}

function buildBroadenedQueries(parsed) {
  const { year, set, parallel, playerName } = parsed;
  const queries = [];

  // Level 1: drop parallel (keep year + set + player)
  if (parallel && (year || set)) {
    const q = [year, set, playerName].filter(Boolean).join(' ');
    queries.push({ query: q, label: `${[year, set].filter(Boolean).join(' ')} ${playerName} (all parallels)`.trim() });
  }

  // Level 2: drop year (keep set + player)
  if (year && set) {
    const q = [set, playerName].filter(Boolean).join(' ');
    queries.push({ query: q, label: `${set} ${playerName} (all years)`.trim() });
  }

  // Level 3: player name only
  if (playerName) {
    queries.push({ query: playerName, label: `${playerName} (all cards)` });
  }

  return queries;
}

function computeApproxValue(results, label) {
  const prices = results.map(r => parseFloat(r.price)).filter(p => !isNaN(p) && p > 0);
  if (prices.length === 0) return null;

  prices.sort((a, b) => a - b);
  const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
  const median = prices.length % 2 === 0
    ? (prices[prices.length / 2 - 1] + prices[prices.length / 2]) / 2
    : prices[Math.floor(prices.length / 2)];

  return {
    avgPrice: avg,
    medianPrice: median,
    priceRange: { min: prices[0], max: prices[prices.length - 1] },
    sampleSize: prices.length,
    basedOn: label,
  };
}

// ---- /api/direct-search ----
app.get('/api/direct-search', async (req, res) => {
  const query = req.query.q;
  const mode = req.query.mode === 'sold' ? 'sold' : 'forsale';
  if (!query || query.trim().length < 2) {
    return res.status(400).json({ error: 'Query parameter "q" is required (min 2 chars)' });
  }

  if (USE_MOCK) {
    return res.json(getMockDirectSearch(query));
  }

  try {
    // Try exact search first
    const exact = await fetchEbayItems(query, 20, mode);
    if (exact.results.length > 0) {
      return res.json({ results: exact.results, total: exact.total, mock: false, searchType: 'exact', broadenedQuery: null, approximateValue: null, mode });
    }

    // No exact results — try broadening
    const parsed = parseCardQuery(query);
    const broader = buildBroadenedQueries(parsed);

    for (const level of broader) {
      const { results, total } = await fetchEbayItems(level.query, 20, mode);
      if (results.length > 0) {
        const approx = computeApproxValue(results, level.label);
        return res.json({ results, total, mock: false, searchType: 'broadened', broadenedQuery: level.query, approximateValue: approx, mode });
      }
    }

    // Nothing found at any level
    res.json({ results: [], total: 0, mock: false, searchType: 'exact', broadenedQuery: null, approximateValue: null, mode });

  } catch (err) {
    if (err.isEbayError) {
      console.error('eBay direct-search ack failure:', err.message);
      return res.status(502).json({ error: 'eBay API error', detail: err.message });
    }
    console.error('eBay direct-search error:', err.message);
    const ebayDetail = err.response?.data ? JSON.stringify(err.response.data).slice(0, 200) : err.message;
    const status = err.response?.status || 500;
    res.status(status).json({ error: 'Failed to fetch from eBay', detail: `HTTP ${status}: ${ebayDetail}` });
  }
});

// ---- /api/variants ----
app.get('/api/variants', async (req, res) => {
  const query = req.query.q;
  const mode = req.query.mode === 'sold' ? 'sold' : 'forsale';
  if (!query || query.trim().length < 2) {
    return res.status(400).json({ error: 'Query parameter "q" is required (min 2 chars)' });
  }

  if (USE_MOCK) {
    return res.json(getMockVariants(query));
  }

  try {
    const { results: rawResults } = await fetchEbayItems(query, 50, mode);

    const variantMap = {};
    rawResults.forEach(item => {
      const title = item.title || '';
      const year = extractYear(title);
      const set = extractSet(title);
      const parallel = extractParallel(title);

      if (!year && !set) return;

      const displayName = [year, set && `Panini ${set}`, parallel].filter(Boolean).join(' ').trim()
        || [year, set, parallel].filter(Boolean).join(' ').trim();
      const key = displayName.toLowerCase();
      if (!key) return;

      const price = parseFloat(item.price) || 0;

      if (!variantMap[key]) {
        variantMap[key] = { displayName, prices: [], imageUrl: null };
      }
      if (price > 0) variantMap[key].prices.push(price);
      if (!variantMap[key].imageUrl && item.imageUrl) variantMap[key].imageUrl = item.imageUrl;
    });

    const variants = Object.entries(variantMap)
      .map(([key, v]) => {
        const prices = v.prices;
        const avg = prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : 0;
        return {
          id: key.replace(/[^a-z0-9]+/g, '-'),
          displayName: v.displayName,
          searchQuery: `${query.split(' ').slice(0, 2).join(' ')} ${v.displayName}`,
          salesCount: prices.length,
          avgPrice: avg,
          priceRange: prices.length ? { min: Math.min(...prices), max: Math.max(...prices) } : null,
          imageUrl: v.imageUrl,
        };
      })
      .filter(v => v.displayName)
      .sort((a, b) => b.salesCount - a.salesCount)
      .slice(0, 12);

    res.json({ variants, mock: false, mode });

  } catch (err) {
    if (err.isEbayError) {
      console.error('eBay variants ack failure:', err.message);
      return res.status(502).json({ error: 'eBay API error', detail: err.message });
    }
    console.error('eBay variants API error:', err.message);
    const ebayDetail = err.response?.data ? JSON.stringify(err.response.data).slice(0, 200) : err.message;
    const status = err.response?.status || 500;
    res.status(status).json({ error: 'Failed to fetch variants from eBay', detail: `HTTP ${status}: ${ebayDetail}` });
  }
});

// ---- eBay Marketplace Account Deletion compliance ----
app.get('/api/ebay/account-deletion', (req, res) => {
  const challengeCode = req.query.challenge_code;
  if (!challengeCode) {
    return res.status(400).json({ error: 'Missing challenge_code' });
  }
  const endpointUrl = 'https://theaifbtracker.onrender.com/api/ebay/account-deletion';
  const hash = crypto.createHash('sha256')
    .update(challengeCode + EBAY_VERIFICATION_TOKEN + endpointUrl)
    .digest('hex');
  res.json({ challengeResponse: hash });
});

app.post('/api/ebay/account-deletion', (req, res) => {
  // Acknowledge account deletion notifications (no user data stored)
  res.sendStatus(200);
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`eBay mode: ${USE_MOCK ? 'MOCK DATA' : `LIVE API (${EBAY_API_MODE})`}`);
  console.log(`EBAY_APP_ID: ${EBAY_APP_ID ? EBAY_APP_ID.slice(0, 10) + '...' : 'NOT SET'}`);
  console.log(`EBAY_CERT_ID: ${EBAY_CERT_ID ? '***set***' : 'NOT SET'}`);
  if ((EBAY_API_MODE === 'insights' || EBAY_API_MODE === 'browse') && !EBAY_CERT_ID) {
    console.warn(`WARNING: EBAY_API_MODE is "${EBAY_API_MODE}" but EBAY_CERT_ID is not set. OAuth will fail.`);
  }
});

function getMockVariants(query) {
  // Extract first 2 words as player name for search queries
  const player = query.trim().split(/\s+/).slice(0, 2).join(' ');
  const mockSets = [
    { year: '2020', set: 'Panini Prizm', parallel: 'Silver', avg: 245.50, count: 12, min: 180, max: 320 },
    { year: '2021', set: 'Panini Select', parallel: 'Base Silver', avg: 89.00, count: 8, min: 65, max: 120 },
    { year: '2022', set: 'Panini Prizm', parallel: 'Silver', avg: 198.00, count: 6, min: 150, max: 260 },
    { year: '2021', set: 'Panini Mosaic', parallel: 'Silver', avg: 67.50, count: 5, min: 45, max: 95 },
    { year: '2023', set: 'Panini Optic', parallel: 'Silver', avg: 52.00, count: 4, min: 35, max: 78 },
    { year: '2022', set: 'Panini Chronicles', parallel: 'Silver', avg: 34.00, count: 3, min: 22, max: 49 },
  ];
  return {
    variants: mockSets.map(v => ({
      id: `${v.year}-${v.set.toLowerCase().replace(/\s+/g, '-')}-${v.parallel.toLowerCase().replace(/\s+/g, '-')}`,
      displayName: `${v.year} ${v.set} ${v.parallel}`,
      searchQuery: `${player} ${v.year} ${v.set} ${v.parallel}`,
      salesCount: v.count,
      avgPrice: v.avg,
      priceRange: { min: v.min, max: v.max },
      imageUrl: null,
    })),
    mock: true,
  };
}

function getMockDirectSearch(query) {
  const parsed = parseCardQuery(query);
  const hasSpecificCard = (parsed.parallel || parsed.set) && parsed.year;
  const today = new Date();
  const day = ms => new Date(today - ms).toISOString();

  if (hasSpecificCard) {
    // Simulate exact match
    return {
      results: [
        { itemId: 'ds001', title: `${query} PSA 10`, price: '285.00', currency: 'USD', soldDate: day(1 * 86400000), imageUrl: null, itemUrl: 'https://www.ebay.com/sch/i.html?_nkw=' + encodeURIComponent(query), condition: 'Graded - PSA 10' },
        { itemId: 'ds002', title: `${query} Raw`, price: '120.00', currency: 'USD', soldDate: day(3 * 86400000), imageUrl: null, itemUrl: 'https://www.ebay.com/sch/i.html?_nkw=' + encodeURIComponent(query), condition: 'Near Mint or Better' },
      ],
      total: 2, mock: true, searchType: 'exact', broadenedQuery: null, approximateValue: null,
    };
  }

  // Simulate broadened fallback
  return {
    results: [
      { itemId: 'ds010', title: `${parsed.playerName} 2020 Panini Prizm Silver`, price: '245.00', currency: 'USD', soldDate: day(1 * 86400000), imageUrl: null, itemUrl: 'https://www.ebay.com/sch/i.html?_nkw=' + encodeURIComponent(query), condition: 'Near Mint or Better' },
      { itemId: 'ds011', title: `${parsed.playerName} 2020 Panini Prizm Gold`, price: '310.00', currency: 'USD', soldDate: day(2 * 86400000), imageUrl: null, itemUrl: 'https://www.ebay.com/sch/i.html?_nkw=' + encodeURIComponent(query), condition: 'Graded - PSA 9' },
      { itemId: 'ds012', title: `${parsed.playerName} 2020 Panini Prizm Base`, price: '85.00', currency: 'USD', soldDate: day(4 * 86400000), imageUrl: null, itemUrl: 'https://www.ebay.com/sch/i.html?_nkw=' + encodeURIComponent(query), condition: 'Near Mint or Better' },
    ],
    total: 3, mock: true, searchType: 'broadened', broadenedQuery: `${parsed.playerName} Prizm`,
    approximateValue: { avgPrice: 213.33, medianPrice: 245.00, priceRange: { min: 85, max: 310 }, sampleSize: 3, basedOn: `Prizm ${parsed.playerName} (all parallels)` },
  };
}

function getMockData(query) {
  const today = new Date();
  const day = ms => new Date(today - ms).toISOString();
  return {
    results: [
      {
        itemId: '111111111001',
        title: `${query} - 2020 Panini Prizm PSA 10 Gem Mint`,
        price: '249.99',
        currency: 'USD',
        soldDate: day(1 * 86400000),
        imageUrl: null,
        itemUrl: 'https://www.ebay.com/sch/i.html?_nkw=' + encodeURIComponent(query),
        condition: 'Graded - PSA 10',
      },
      {
        itemId: '111111111002',
        title: `${query} - 2020 Panini Prizm Silver PSA 9`,
        price: '89.00',
        currency: 'USD',
        soldDate: day(2 * 86400000),
        imageUrl: null,
        itemUrl: 'https://www.ebay.com/sch/i.html?_nkw=' + encodeURIComponent(query),
        condition: 'Graded - PSA 9',
      },
      {
        itemId: '111111111003',
        title: `${query} - 2021 Donruss Optic Holo Rookie RC BGS 9.5`,
        price: '134.50',
        currency: 'USD',
        soldDate: day(3 * 86400000),
        imageUrl: null,
        itemUrl: 'https://www.ebay.com/sch/i.html?_nkw=' + encodeURIComponent(query),
        condition: 'Graded - BGS 9.5',
      },
      {
        itemId: '111111111004',
        title: `${query} - 2020 Panini Prizm Red White Blue /175 Ungraded NM-MT`,
        price: '45.00',
        currency: 'USD',
        soldDate: day(4 * 86400000),
        imageUrl: null,
        itemUrl: 'https://www.ebay.com/sch/i.html?_nkw=' + encodeURIComponent(query),
        condition: 'Near Mint or Better',
      },
      {
        itemId: '111111111005',
        title: `${query} - 2022 Topps Chrome Refractor Auto #/99`,
        price: '312.00',
        currency: 'USD',
        soldDate: day(5 * 86400000),
        imageUrl: null,
        itemUrl: 'https://www.ebay.com/sch/i.html?_nkw=' + encodeURIComponent(query),
        condition: 'Near Mint or Better',
      },
    ],
    total: 5,
    mock: true,
  };
}
