require('dotenv').config();
const express = require('express');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const EBAY_APP_ID = process.env.EBAY_APP_ID;
const USE_MOCK = process.env.USE_MOCK_DATA === 'true' || !EBAY_APP_ID || EBAY_APP_ID === 'your-ebay-app-id-here';

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/search', async (req, res) => {
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
        timeout: 10000,
      }
    );

    const raw = ebayResponse.data;
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

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`eBay mode: ${USE_MOCK ? 'MOCK DATA (add EBAY_APP_ID to .env for live data)' : 'LIVE API'}`);
});

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
