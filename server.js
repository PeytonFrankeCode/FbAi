require('dotenv').config();
const express = require('express');
const axios = require('axios');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const EBAY_APP_ID = process.env.EBAY_APP_ID;
const AUTH_CODE = process.env.AUTH_CODE;
const EBAY_VERIFICATION_TOKEN = process.env.EBAY_VERIFICATION_TOKEN;
const USE_MOCK = process.env.USE_MOCK_DATA === 'true' || !EBAY_APP_ID || EBAY_APP_ID === 'your-ebay-app-id-here';

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

app.get('/api/search', requireAuth, async (req, res) => {
  const query = req.query.q;
  const limit = Math.min(parseInt(req.query.limit) || 20, 50);

  if (!query || query.trim().length < 2) {
    return res.status(400).json({ error: 'Query parameter "q" is required (min 2 chars)' });
  }

  if (USE_MOCK) {
    return res.json(getMockData(query));
  }

  try {
    const ebayResponse = await axios.get(
      'https://svcs.ebay.com/services/search/FindingService/v1',
      {
        params: {
          'OPERATION-NAME': 'findCompletedItems',
          'SERVICE-VERSION': '1.0.0',
          'SECURITY-APPNAME': EBAY_APP_ID,
          'RESPONSE-DATA-FORMAT': 'JSON',
          'REST-PAYLOAD': '',
          'keywords': query,
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

    const raw = ebayResponse.data;

    // Check for eBay-level errors (HTTP 200 but ack: Failure)
    const ack = raw?.findCompletedItemsResponse?.[0]?.ack?.[0];
    if (ack === 'Failure') {
      const ebayError = raw?.findCompletedItemsResponse?.[0]?.errorMessage?.[0]?.error?.[0]?.message?.[0] || 'eBay API returned a failure response';
      console.error('eBay search ack failure:', ebayError);
      return res.status(502).json({ error: 'eBay API error', detail: ebayError });
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

    res.json({ results, total: parseInt(searchResult?.['@count'] || '0'), mock: false });

  } catch (err) {
    console.error('eBay API error:', err.message);
    const status = err.response?.status || 500;
    res.status(status).json({ error: 'Failed to fetch from eBay', detail: err.message });
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

// ---- /api/variants ----
app.get('/api/variants', requireAuth, async (req, res) => {
  const query = req.query.q;
  if (!query || query.trim().length < 2) {
    return res.status(400).json({ error: 'Query parameter "q" is required (min 2 chars)' });
  }

  if (USE_MOCK) {
    return res.json(getMockVariants(query));
  }

  try {
    const ebayResponse = await axios.get(
      'https://svcs.ebay.com/services/search/FindingService/v1',
      {
        params: {
          'OPERATION-NAME': 'findCompletedItems',
          'SERVICE-VERSION': '1.0.0',
          'SECURITY-APPNAME': EBAY_APP_ID,
          'RESPONSE-DATA-FORMAT': 'JSON',
          'REST-PAYLOAD': '',
          'keywords': query,
          'categoryId': '261328',
          'itemFilter(0).name': 'SoldItemsOnly',
          'itemFilter(0).value': 'true',
          'sortOrder': 'EndTimeSoonest',
          'paginationInput.entriesPerPage': '50',
          'outputSelector(0)': 'PictureURLLarge',
          'outputSelector(1)': 'GalleryInfo',
        },
        timeout: 15000,
      }
    );

    const raw = ebayResponse.data;

    // Check for eBay-level errors (HTTP 200 but ack: Failure)
    const ack = raw?.findCompletedItemsResponse?.[0]?.ack?.[0];
    if (ack === 'Failure') {
      const ebayError = raw?.findCompletedItemsResponse?.[0]?.errorMessage?.[0]?.error?.[0]?.message?.[0] || 'eBay API returned a failure response';
      console.error('eBay variants ack failure:', ebayError);
      return res.status(502).json({ error: 'eBay API error', detail: ebayError });
    }

    const items = raw?.findCompletedItemsResponse?.[0]?.searchResult?.[0]?.item || [];

    const variantMap = {};
    items.forEach(item => {
      const title = item.title?.[0] || '';
      const year = extractYear(title);
      const set = extractSet(title);
      const parallel = extractParallel(title);

      if (!year && !set) return; // skip if we can't identify any variant info

      const displayName = [year, set && `Panini ${set}`, parallel].filter(Boolean).join(' ').trim()
        || [year, set, parallel].filter(Boolean).join(' ').trim();
      const key = displayName.toLowerCase();
      if (!key) return;

      const price = parseFloat(item.sellingStatus?.[0]?.currentPrice?.[0]?.['__value__']) || 0;
      const imgUrl = item.pictureURLLarge?.[0] || item.galleryURL?.[0] || null;

      if (!variantMap[key]) {
        variantMap[key] = { displayName, prices: [], imageUrl: null };
      }
      if (price > 0) variantMap[key].prices.push(price);
      if (!variantMap[key].imageUrl && imgUrl) variantMap[key].imageUrl = imgUrl;
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

    res.json({ variants, mock: false });

  } catch (err) {
    console.error('eBay variants API error:', err.message);
    const status = err.response?.status || 500;
    res.status(status).json({ error: 'Failed to fetch variants from eBay', detail: err.message });
  }
});

// ---- eBay API connectivity test (no auth required) ----
app.get('/api/test-ebay', async (req, res) => {
  try {
    const start = Date.now();
    const ebayResponse = await axios.get(
      'https://svcs.ebay.com/services/search/FindingService/v1',
      {
        params: {
          'OPERATION-NAME': 'findItemsByKeywords',
          'SERVICE-VERSION': '1.0.0',
          'SECURITY-APPNAME': EBAY_APP_ID || 'NOT_SET',
          'RESPONSE-DATA-FORMAT': 'JSON',
          'keywords': 'test',
          'paginationInput.entriesPerPage': '1',
        },
        timeout: 15000,
      }
    );
    const elapsed = Date.now() - start;
    const raw = ebayResponse.data;
    const ack = raw?.findItemsByKeywordsResponse?.[0]?.ack?.[0];
    const errorMsg = raw?.findItemsByKeywordsResponse?.[0]?.errorMessage?.[0]?.error?.[0]?.message?.[0];
    res.json({
      status: 'reachable',
      httpStatus: ebayResponse.status,
      ack,
      ebayError: errorMsg || null,
      elapsedMs: elapsed,
      appIdConfigured: !!EBAY_APP_ID,
      useMock: USE_MOCK,
    });
  } catch (err) {
    res.status(500).json({
      status: 'unreachable',
      error: err.message,
      code: err.code,
      httpStatus: err.response?.status || null,
      appIdConfigured: !!EBAY_APP_ID,
      useMock: USE_MOCK,
    });
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
  console.log(`eBay mode: ${USE_MOCK ? 'MOCK DATA (add EBAY_APP_ID to .env for live data)' : 'LIVE API'}`);
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
