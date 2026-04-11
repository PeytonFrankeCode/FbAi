require('dotenv').config();
const express = require('express');
const cors = require('cors');
const compression = require('compression');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { connectDB, loadData, saveData } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const EBAY_APP_ID = process.env.EBAY_APP_ID;
const EBAY_CERT_ID = process.env.EBAY_CERT_ID; // Client secret for OAuth (Marketplace Insights)

const EBAY_VERIFICATION_TOKEN = process.env.EBAY_VERIFICATION_TOKEN;
const USE_MOCK = process.env.USE_MOCK_DATA === 'true' || !EBAY_APP_ID || EBAY_APP_ID === 'your-ebay-app-id-here';

// Which eBay API to use: 'finding' (legacy) or 'insights' (Marketplace Insights)
const EBAY_API_MODE = process.env.EBAY_API_MODE || 'finding';

// ---- SportsCardsPro / PriceCharting API Setup ----
const SPORTSCARDSPRO_API_KEY = process.env.SPORTSCARDSPRO_API_KEY;
const SPORTSCARDSPRO_ENABLED = SPORTSCARDSPRO_API_KEY && !SPORTSCARDSPRO_API_KEY.includes('your-api-key');

// ---- Stripe Setup ----
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_PUBLISHABLE_KEY = process.env.STRIPE_PUBLISHABLE_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const stripeEnabled = STRIPE_SECRET_KEY && !STRIPE_SECRET_KEY.includes('REPLACE');
let stripe = null;
if (stripeEnabled) {
  stripe = require('stripe')(STRIPE_SECRET_KEY);
}

// Stripe webhook needs raw body — must be before express.json()
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  if (!stripeEnabled) return res.status(503).json({ error: 'Stripe not configured' });

  let event;
  try {
    if (STRIPE_WEBHOOK_SECRET && !STRIPE_WEBHOOK_SECRET.includes('REPLACE')) {
      event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET);
    } else {
      event = JSON.parse(req.body);
    }
  } catch (err) {
    console.error('Stripe webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const subs = loadSubscriptions();

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      const username = session.metadata?.username;
      if (!username) break;

      if (session.metadata?.type === 'extra_slot') {
        // One-time purchase for extra promote slot
        if (!subs[username]) subs[username] = {};
        subs[username].extraPromoteSlots = (subs[username].extraPromoteSlots || 0) + 1;
        subs[username].lastPayment = { type: 'extra_slot', amount: 299, date: new Date().toISOString(), sessionId: session.id };
      } else if (session.subscription) {
        // Pro subscription started
        if (!subs[username]) subs[username] = {};
        subs[username].plan = 'pro';
        subs[username].period = session.metadata?.period || 'monthly';
        subs[username].stripeCustomerId = session.customer;
        subs[username].stripeSubscriptionId = session.subscription;
        subs[username].subscribedAt = new Date().toISOString();
        subs[username].status = 'active';
      }
      saveSubscriptions(subs);
      break;
    }
    case 'customer.subscription.deleted': {
      const sub = event.data.object;
      // Find user by stripe customer ID
      for (const [user, data] of Object.entries(subs)) {
        if (data.stripeCustomerId === sub.customer) {
          data.status = 'cancelled';
          data.cancelledAt = new Date().toISOString();
          break;
        }
      }
      saveSubscriptions(subs);
      break;
    }
    case 'customer.subscription.updated': {
      const sub = event.data.object;
      for (const [user, data] of Object.entries(subs)) {
        if (data.stripeCustomerId === sub.customer) {
          data.status = sub.status === 'active' ? 'active' : sub.status;
          break;
        }
      }
      saveSubscriptions(subs);
      break;
    }
  }

  res.json({ received: true });
});

app.use(cors({
  origin: [
    'https://thecardhuddle.com',
    'https://www.thecardhuddle.com',
    /\.thecardhuddle\.com$/
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  credentials: true
}));

// Security headers for Cloudflare deployment
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

app.use(compression());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));


// ---- Finding API throttle (serialize calls to avoid per-second rate limits) ----
let lastFindingCallTime = 0;
const FINDING_API_MIN_INTERVAL = 1500; // 1.5 seconds between Finding API calls

async function throttleFindingAPI() {
  const now = Date.now();
  const elapsed = now - lastFindingCallTime;
  if (elapsed < FINDING_API_MIN_INTERVAL) {
    const wait = FINDING_API_MIN_INTERVAL - elapsed;
    console.log(`[Finding API] Throttling: waiting ${wait}ms before next call`);
    await new Promise(r => setTimeout(r, wait));
  }
  lastFindingCallTime = Date.now();
}

// ---- eBay Finding API Call Tracker ----
const API_CALLS_FILE = path.join(__dirname, 'data', 'api-call-log.json');

function loadApiCallLog() {
  return loadData('apiCallLog', API_CALLS_FILE, { daily: {}, calls: [] });
}

function saveApiCallLog(log) {
  // Keep only last 7 days of detailed calls to prevent file bloat
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  log.calls = (log.calls || []).filter(c => new Date(c.time).getTime() > cutoff);
  // Keep daily totals for 30 days
  const dayCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  for (const day of Object.keys(log.daily)) {
    if (day < dayCutoff) delete log.daily[day];
  }
  saveData('apiCallLog', API_CALLS_FILE, log);
}

function trackApiCall(apiName, endpoint, keywords, source) {
  const log = loadApiCallLog();
  const now = new Date();
  const today = now.toISOString().slice(0, 10);

  if (!log.daily[today]) log.daily[today] = { total: 0, finding: 0, browse: 0, insights: 0 };
  log.daily[today].total++;
  if (apiName === 'finding') log.daily[today].finding++;
  else if (apiName === 'browse') log.daily[today].browse++;
  else if (apiName === 'insights') log.daily[today].insights++;

  log.calls.push({
    time: now.toISOString(),
    api: apiName,
    keywords: keywords,
    source: source,
    endpoint: endpoint
  });

  saveApiCallLog(log);
  const dayStats = log.daily[today];
  console.log(`[API Tracker] ${apiName.toUpperCase()} call #${dayStats.total} today (finding: ${dayStats.finding}, browse: ${dayStats.browse}) | source: ${source} | query: "${keywords}"`);
  return dayStats;
}

function getApiCallStats() {
  const log = loadApiCallLog();
  const today = new Date().toISOString().slice(0, 10);
  const todayStats = log.daily[today] || { total: 0, finding: 0, browse: 0, insights: 0 };

  // Last 24h calls grouped by source
  const cutoff24h = Date.now() - 24 * 60 * 60 * 1000;
  const recent = (log.calls || []).filter(c => new Date(c.time).getTime() > cutoff24h);
  const bySource = {};
  for (const c of recent) {
    bySource[c.source] = (bySource[c.source] || 0) + 1;
  }

  return {
    today: todayStats,
    daily: log.daily,
    last24hBySource: bySource,
    last24hTotal: recent.length,
    recentCalls: (log.calls || []).slice(-20)
  };
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

// ---- Retry helper (network errors only, NOT rate limits) ----
async function withRetry(fn, maxRetries = 1) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await fn();
      // If the function returned a rateLimited response, don't retry
      if (result && result.rateLimited) return result;
      return result;
    } catch (err) {
      // eBay API errors should not be retried
      if (err.isEbayError) throw err;
      // Only retry on network/timeout errors, not HTTP errors
      const isNetworkError = !err.response && (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || err.code === 'ENOTFOUND');
      if (isNetworkError && attempt < maxRetries) {
        const delay = (attempt + 1) * 2000;
        console.log(`Network error, retrying in ${delay / 1000}s (attempt ${attempt + 1}/${maxRetries})`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
}

// ---- Marketplace Insights API (sold items via OAuth) ----
async function fetchViaInsightsAPI(keywords, limit, source = 'unknown') {
  trackApiCall('insights', 'marketplace_insights/search', keywords, source);
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
async function fetchViaBrowseAPI(keywords, limit, source = 'unknown') {
  trackApiCall('browse', 'browse/search', keywords, source);
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
async function fetchViaFindingAPI(keywords, limit, source = 'unknown') {
  await throttleFindingAPI();
  trackApiCall('finding', 'findCompletedItems', keywords, source);
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
    const status = axiosErr.response?.status;
    const respData = axiosErr.response?.data;
    console.error(`[Finding API] HTTP error ${status || 'NETWORK'}:`, JSON.stringify(respData || axiosErr.message).slice(0, 500));

    // If eBay returned an HTTP error with a JSON body, try to parse it
    if (respData?.findCompletedItemsResponse) {
      const ack = respData.findCompletedItemsResponse[0]?.ack?.[0];
      const ebayErrors = respData.findCompletedItemsResponse[0]?.errorMessage?.[0]?.error || [];
      const errorMsg = ebayErrors[0]?.message?.[0] || `eBay HTTP ${status}`;
      console.error(`[Finding API] Error in HTTP ${status} body: ack=${ack}, msg=${errorMsg}`);
      return { results: [], total: 0, rateLimited: true, errorMessage: errorMsg };
    }

    // Network error or non-JSON response — return gracefully
    return { results: [], total: 0, rateLimited: true, errorMessage: `eBay API unavailable (HTTP ${status || 'timeout'})` };
  }

  const raw = ebayResponse.data;

  // Safety check: eBay sometimes returns non-JSON or unexpected structure
  if (!raw || !raw.findCompletedItemsResponse) {
    console.error('[Finding API] Unexpected response structure:', JSON.stringify(raw).slice(0, 500));
    return { results: [], total: 0, rateLimited: true, errorMessage: 'eBay returned an unexpected response' };
  }

  const ack = raw.findCompletedItemsResponse[0]?.ack?.[0];
  const ebayErrors = raw.findCompletedItemsResponse[0]?.errorMessage?.[0]?.error || [];

  if (ebayErrors.length > 0) {
    const errorId = ebayErrors[0]?.errorId?.[0];
    const errorMsg = ebayErrors[0]?.message?.[0] || 'Unknown eBay error';
    console.error(`[Finding API] ack=${ack}, errorId=${errorId}, message: ${errorMsg}`);
    console.error(`[Finding API] Full error response:`, JSON.stringify(ebayErrors).slice(0, 500));
  }

  if (ack === 'Failure') {
    // Return gracefully for ALL failures — don't throw, let the caller decide
    const errorId = ebayErrors[0]?.errorId?.[0];
    const errorMsg = ebayErrors[0]?.message?.[0] || 'eBay API returned a failure response';
    console.error(`[Finding API] FAILURE (errorId=${errorId}): ${errorMsg}`);
    return { results: [], total: 0, rateLimited: true, errorMessage: errorMsg };
  }

  const searchResult = raw.findCompletedItemsResponse[0]?.searchResult?.[0];
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
// mode: 'forsale' (Browse API) or 'sold' (Insights API → Finding API fallback)
async function fetchEbayItems(keywords, limit = 20, mode = 'forsale', source = 'search') {
  const cacheKey = `${mode}|${keywords}|${limit}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  let response;
  if (mode === 'sold') {
    // Primary: Marketplace Insights API (OAuth, separate rate limit pool)
    try {
      response = await fetchViaInsightsAPI(keywords, limit, source);
      if (response.results.length > 0) {
        setCache(cacheKey, response);
        return response;
      }
      console.log(`[Sold] Insights API returned 0 results for "${keywords}", trying Finding API...`);
    } catch (insightsErr) {
      console.log(`[Sold] Insights API failed: ${insightsErr.message}, trying Finding API...`);
    }

    // Fallback: Finding API (may be rate limited by eBay)
    response = await withRetry(() => fetchViaFindingAPI(keywords, limit, source));
    if (!response.rateLimited && response.results.length > 0) {
      setCache(cacheKey, response);
    }
    return response;
  }

  // For sale mode — just use Browse API
  response = await withRetry(() => fetchViaBrowseAPI(keywords, limit, source));
  if (response && !response.rateLimited) {
    setCache(cacheKey, response);
  }
  return response;
}

// Legacy alias for backward compatibility
async function fetchEbaySoldItems(keywords, limit = 20) {
  return fetchEbayItems(keywords, limit, 'sold');
}

// Extract print run serial like /4, /25, /99 from a query
function extractSerial(text) {
  const match = text.match(/\/(\d{1,4})(?![0-9])/);
  return match ? match[1] : '';
}

app.get('/api/search', async (req, res) => {
  const query = req.query.q;
  const limit = Math.min(parseInt(req.query.limit) || 20, 50);
  const mode = req.query.mode === 'sold' ? 'sold' : 'forsale';

  if (!query || query.trim().length < 2) {
    return res.status(400).json({ error: 'Query parameter "q" is required (min 2 chars)' });
  }

  if (USE_MOCK) {
    return res.json(getMockData(query, mode));
  }

  try {
    const serial = extractSerial(query);

    if (!serial) {
      // No serial number in query — standard search
      const searchData = await fetchEbayItems(query, limit, mode, 'search');
      if (searchData.rateLimited) {
        return res.json({ results: [], total: 0, mock: false, mode, serial: null, similarResults: [], searchType: 'exact', broadenedQuery: null, approximateValue: null, rateLimited: true, rateLimitMessage: 'eBay sold search is temporarily unavailable. Please try again later.' });
      }
      if (searchData.results.length > 0) {
        return res.json({ results: searchData.results, total: searchData.total, mock: false, mode, serial: null, similarResults: [], searchType: 'exact', broadenedQuery: null, approximateValue: null });
      }

      // No results — try broadened search (same as main search)
      const parsed = parseCardQuery(query);
      const broader = buildBroadenedQueries(parsed);

      for (const level of broader) {
        const broadened = await fetchEbayItems(level.query, limit, mode, 'search-broadened');
        if (broadened.rateLimited) {
          return res.json({ results: [], total: 0, mock: false, mode, serial: null, similarResults: [], searchType: 'exact', broadenedQuery: null, approximateValue: null, rateLimited: true, rateLimitMessage: 'eBay sold search is temporarily unavailable. Please try again later.' });
        }
        if (broadened.results.length > 0) {
          const approx = computeApproxValue(broadened.results, level.label);
          return res.json({ results: broadened.results, total: broadened.total, mock: false, mode, serial: null, similarResults: [], searchType: 'broadened', broadenedQuery: level.query, approximateValue: approx });
        }
      }

      return res.json({ results: [], total: 0, mock: false, mode, serial: null, similarResults: [], searchType: 'exact', broadenedQuery: null, approximateValue: null });
    }

    // Has serial number (e.g. /5 means print run of 5)
    // Run two searches: one with the serial to get targeted results from eBay,
    // and one without to catch cards that might not have /5 in the title format
    const baseQuery = query.replace(/\/\d{1,4}/, '').replace(/\s+/g, ' ').trim();
    const [targetedResults, broadResults] = await Promise.all([
      fetchEbayItems(`${baseQuery} /${serial}`, 50, mode, 'search-serial'),
      fetchEbayItems(baseQuery, 50, mode, 'search-serial-broad'),
    ]);

    // Merge results, dedup by itemId
    const seen = new Set();
    const allResults = [];
    for (const item of [...targetedResults.results, ...broadResults.results]) {
      if (!seen.has(item.itemId)) {
        seen.add(item.itemId);
        allResults.push(item);
      }
    }

    // Exact matches: title contains a print run of the requested serial
    // /5 means "printed to 5" — matches "/5", "1/5", "3/5" but NOT "/50", "/125", "5/125"
    const printRunPattern = new RegExp(`\\/${serial}(?![0-9])`);
    const exact = allResults.filter(item => printRunPattern.test(item.title || ''));

    // Similar: other numbered cards from same search (exclude exact matches)
    // Sort by print run proximity (closest print run first)
    const numberedPattern = /\/(\d{1,4})(?![0-9])/;
    const requestedSerial = parseInt(serial, 10);
    const exactIds = new Set(exact.map(r => r.itemId));
    const similar = allResults
      .filter(item => !exactIds.has(item.itemId) && numberedPattern.test(item.title || ''))
      .sort((a, b) => {
        const aMatch = a.title.match(numberedPattern);
        const bMatch = b.title.match(numberedPattern);
        const aNum = aMatch ? parseInt(aMatch[1], 10) : 9999;
        const bNum = bMatch ? parseInt(bMatch[1], 10) : 9999;
        const aDiff = Math.abs(aNum - requestedSerial);
        const bDiff = Math.abs(bNum - requestedSerial);
        return aDiff !== bDiff ? aDiff - bDiff : aNum - bNum;
      });

    res.json({
      results: exact,
      total: exact.length,
      mock: false,
      mode,
      serial,
      similarResults: similar.slice(0, 20),
    });
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
const NOISE_WORDS = ['panini', 'psa', 'bgs', 'sgc', 'rc', 'rookie', 'card', 'football', 'nfl'];

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
    return res.json(getMockDirectSearch(query, mode));
  }

  try {
    const serial = extractSerial(query);

    if (serial) {
      // Serial search (e.g. /5 = print run of 5)
      // Dual search: targeted with serial + broad without, then filter
      const baseQuery = query.replace(/\/\d{1,4}/, '').replace(/\s+/g, ' ').trim();
      const [targetedResults, broadResults] = await Promise.all([
        fetchEbayItems(query, 50, mode, 'variants-serial'),
        fetchEbayItems(baseQuery, 50, mode, 'variants-serial-broad'),
      ]);

      if (targetedResults.rateLimited || broadResults.rateLimited) {
        return res.json({ results: [], total: 0, mock: false, searchType: 'exact', broadenedQuery: null, approximateValue: null, mode, serial, similarResults: [], rateLimited: true, rateLimitMessage: 'eBay sold search is temporarily unavailable. Please try again later.' });
      }

      // Merge and dedup
      const seen = new Set();
      const allResults = [];
      for (const item of [...targetedResults.results, ...broadResults.results]) {
        if (!seen.has(item.itemId)) {
          seen.add(item.itemId);
          allResults.push(item);
        }
      }

      // Exact: print run matches (e.g. /5, 1/5, 3/5 but not /50 or 5/125)
      const printRunPattern = new RegExp(`\\/${serial}(?![0-9])`);
      const exactMatches = allResults.filter(item => printRunPattern.test(item.title || ''));

      // Similar: other numbered cards sorted by print run proximity
      const numberedPattern = /\/(\d{1,4})(?![0-9])/;
      const requestedSerial = parseInt(serial, 10);
      const exactIds = new Set(exactMatches.map(r => r.itemId));
      const similarMatches = allResults
        .filter(item => !exactIds.has(item.itemId) && numberedPattern.test(item.title || ''))
        .sort((a, b) => {
          const aNum = parseInt((a.title.match(numberedPattern) || [])[1], 10) || 9999;
          const bNum = parseInt((b.title.match(numberedPattern) || [])[1], 10) || 9999;
          const aDiff = Math.abs(aNum - requestedSerial);
          const bDiff = Math.abs(bNum - requestedSerial);
          return aDiff !== bDiff ? aDiff - bDiff : aNum - bNum;
        });

      // Return exact matches first, then similar
      const combined = [...exactMatches, ...similarMatches];
      if (combined.length > 0) {
        const approx = computeApproxValue(exactMatches.length > 0 ? exactMatches : combined.slice(0, 10), 'serial');
        return res.json({ results: combined.slice(0, 40), total: combined.length, mock: false, searchType: 'exact', broadenedQuery: null, approximateValue: approx, mode, serial, similarResults: similarMatches.slice(0, 20) });
      }

      return res.json({ results: [], total: 0, mock: false, searchType: 'exact', broadenedQuery: null, approximateValue: null, mode, serial, similarResults: [] });
    }

    // No serial — standard search: try exact first
    const exact = await fetchEbayItems(query, 20, mode, 'variants');
    if (exact.rateLimited) {
      return res.json({ results: [], total: 0, mock: false, searchType: 'exact', broadenedQuery: null, approximateValue: null, mode, rateLimited: true, rateLimitMessage: 'eBay sold search is temporarily unavailable. Please try again later.' });
    }
    if (exact.results.length > 0) {
      return res.json({ results: exact.results, total: exact.total, mock: false, searchType: 'exact', broadenedQuery: null, approximateValue: null, mode });
    }

    // No exact results — try broadening
    const parsed = parseCardQuery(query);
    const broader = buildBroadenedQueries(parsed);

    for (const level of broader) {
      const broadResult = await fetchEbayItems(level.query, 20, mode, 'variants-broadened');
      if (broadResult.rateLimited) {
        return res.json({ results: [], total: 0, mock: false, searchType: 'exact', broadenedQuery: null, approximateValue: null, mode, rateLimited: true, rateLimitMessage: 'eBay sold search is temporarily unavailable. Please try again later.' });
      }
      if (broadResult.results.length > 0) {
        const approx = computeApproxValue(broadResult.results, level.label);
        return res.json({ results: broadResult.results, total: broadResult.total, mock: false, searchType: 'broadened', broadenedQuery: level.query, approximateValue: approx, mode });
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
    return res.json(getMockVariants(query, mode));
  }

  try {
    // Extract serial number (e.g. /5 = print run of 5)
    const serial = extractSerial(query);
    const baseQuery = serial ? query.replace(/\/\d{1,4}/, '').replace(/\s+/g, ' ').trim() : query;

    // Dual search when serial present: targeted + broad for better coverage
    let rawResults;
    if (serial) {
      const [targeted, broad] = await Promise.all([
        fetchEbayItems(`${baseQuery} /${serial}`, 50, mode, 'direct-search-serial'),
        fetchEbayItems(baseQuery, 50, mode, 'direct-search-serial-broad'),
      ]);
      if (targeted.rateLimited || broad.rateLimited) {
        return res.json({ variants: [], mock: false, serial, rateLimited: true, rateLimitMessage: 'eBay sold search is temporarily unavailable. Please try again later.' });
      }
      const seen = new Set();
      rawResults = [];
      for (const item of [...targeted.results, ...broad.results]) {
        if (!seen.has(item.itemId)) {
          seen.add(item.itemId);
          rawResults.push(item);
        }
      }
    } else {
      const result = await fetchEbayItems(baseQuery, 50, mode, 'direct-search');
      if (result.rateLimited) {
        return res.json({ variants: [], mock: false, serial: null, rateLimited: true, rateLimitMessage: 'eBay sold search is temporarily unavailable. Please try again later.' });
      }
      rawResults = result.results;
    }
    const playerName = extractPlayerName(query);

    const variantMap = {};
    rawResults.forEach(item => {
      const title = item.title || '';
      const year = extractYear(title);
      const set = extractSet(title);
      const parallel = extractParallel(title) || 'Base';

      if (!year && !set) return;

      const displayName = [year, set && `Panini ${set}`, parallel].filter(Boolean).join(' ').trim()
        || [year, set, parallel].filter(Boolean).join(' ').trim();
      const key = displayName.toLowerCase();
      if (!key) return;

      const price = parseFloat(item.price) || 0;

      if (!variantMap[key]) {
        variantMap[key] = { displayName, year, set, parallel, prices: [], imageUrl: null };
      }
      if (price > 0) variantMap[key].prices.push(price);
      if (!variantMap[key].imageUrl && item.imageUrl) variantMap[key].imageUrl = item.imageUrl;
    });

    const variants = Object.entries(variantMap)
      .map(([key, v]) => {
        const prices = v.prices;
        const avg = prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : 0;
        // Build a specific search query using player name + variant's actual year/set/parallel
        // Append serial number (e.g. /4) so it flows through to /api/search for filtering
        const searchParts = [playerName, v.year, v.set, v.parallel].filter(Boolean);
        if (serial) searchParts.push(`/${serial}`);
        return {
          id: key.replace(/[^a-z0-9]+/g, '-'),
          displayName: v.displayName,
          searchQuery: searchParts.join(' '),
          salesCount: prices.length,
          avgPrice: avg,
          priceRange: prices.length ? { min: Math.min(...prices), max: Math.max(...prices) } : null,
          imageUrl: v.imageUrl,
        };
      })
      .filter(v => v.displayName)
      .sort((a, b) => b.salesCount - a.salesCount)
      .slice(0, 12);

    res.json({ variants, mock: false, mode, serial: serial || null });

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

// ---- Health check for Render ----
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ---- Debug endpoint: raw eBay Finding API response ----
app.get('/api/debug/sold-test', async (req, res) => {
  const q = req.query.q || 'mahomes prizm';
  if (USE_MOCK) return res.json({ debug: 'MOCK MODE — no real API call', query: q });

  const results = { query: q, appId: EBAY_APP_ID ? EBAY_APP_ID.slice(0, 10) + '...' : 'NOT SET' };

  // Test 1: Marketplace Insights API (OAuth)
  try {
    const token = await getOAuthToken();
    const insightsRes = await axios.get(
      'https://api.ebay.com/buy/marketplace_insights/v1_beta/item_sales/search',
      { params: { q, category_ids: '261328', limit: 3 }, headers: { 'Authorization': `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US' }, timeout: 15000 }
    );
    const items = insightsRes.data?.itemSales || [];
    results.insightsAPI = { status: 'OK', httpStatus: insightsRes.status, itemCount: items.length, total: insightsRes.data?.total || 0, firstItem: items[0] ? { title: items[0].title, price: items[0].lastSoldPrice?.value } : null };
  } catch (err) {
    results.insightsAPI = { status: 'FAILED', error: err.message, httpStatus: err.response?.status || null, responseData: err.response?.data ? JSON.stringify(err.response.data).slice(0, 500) : null };
  }

  // Test 2: Finding API (legacy)
  try {
    await throttleFindingAPI();
    const findingRes = await axios.get('https://svcs.ebay.com/services/search/FindingService/v1', {
      params: { 'OPERATION-NAME': 'findCompletedItems', 'SERVICE-VERSION': '1.0.0', 'SECURITY-APPNAME': EBAY_APP_ID, 'RESPONSE-DATA-FORMAT': 'JSON', 'REST-PAYLOAD': '', 'keywords': q, 'categoryId': '261328', 'itemFilter(0).name': 'SoldItemsOnly', 'itemFilter(0).value': 'true', 'paginationInput.entriesPerPage': 3 },
      timeout: 15000,
    });
    const raw = findingRes.data;
    const ack = raw?.findCompletedItemsResponse?.[0]?.ack?.[0];
    const errors = raw?.findCompletedItemsResponse?.[0]?.errorMessage?.[0]?.error || [];
    const items = raw?.findCompletedItemsResponse?.[0]?.searchResult?.[0]?.item || [];
    results.findingAPI = { status: ack === 'Success' ? 'OK' : ack, httpStatus: findingRes.status, ack, itemCount: items.length, errors: errors.map(e => ({ errorId: e.errorId?.[0], message: e.message?.[0] })), firstItem: items[0] ? { title: items[0].title?.[0], price: items[0].sellingStatus?.[0]?.currentPrice?.[0]?.['__value__'] } : null };
  } catch (err) {
    results.findingAPI = { status: 'FAILED', error: err.message, httpStatus: err.response?.status || null, responseData: err.response?.data ? JSON.stringify(err.response.data).slice(0, 500) : null };
  }

  // Test 3: Browse API (active listings, as reference)
  try {
    const token = await getOAuthToken();
    const browseRes = await axios.get('https://api.ebay.com/buy/browse/v1/item_summary/search', {
      params: { q, category_ids: '261328', limit: 3 },
      headers: { 'Authorization': `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US' }, timeout: 15000,
    });
    const items = browseRes.data?.itemSummaries || [];
    results.browseAPI = { status: 'OK', httpStatus: browseRes.status, itemCount: items.length, total: browseRes.data?.total || 0, firstItem: items[0] ? { title: items[0].title, price: items[0].price?.value } : null };
  } catch (err) {
    results.browseAPI = { status: 'FAILED', error: err.message, httpStatus: err.response?.status || null };
  }

  res.json(results);
});

// ---- API Call Stats (monitor eBay API usage) ----
app.get('/api/stats/api-calls', (req, res) => {
  try {
    const stats = getApiCallStats();
    const today = stats.today;
    res.json({
      today: {
        ...today,
        findingRemaining: Math.max(0, 5000 - today.finding),
        browseRemaining: null, // Browse API uses OAuth, different limits
      },
      daily: stats.daily,
      last24h: {
        total: stats.last24hTotal,
        bySource: stats.last24hBySource,
      },
      recentCalls: stats.recentCalls,
    });
  } catch (err) {
    console.error('Error in /api/stats/api-calls:', err.message);
    res.json({
      today: { total: 0, finding: 0, browse: 0, insights: 0, findingRemaining: 5000, browseRemaining: null },
      daily: {},
      last24h: { total: 0, bySource: {} },
      recentCalls: [],
      error: err.message,
    });
  }
});

// ---- eBay API connectivity test (no auth required) ----
app.get('/api/test-ebay', async (req, res) => {
  try {
    await throttleFindingAPI();
    trackApiCall('finding', 'findItemsByKeywords', 'test', 'test-ebay');
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
  const endpointUrl = (process.env.SITE_URL || 'https://thecardhuddle.com') + '/api/ebay/account-deletion';
  const hash = crypto.createHash('sha256')
    .update(challengeCode + EBAY_VERIFICATION_TOKEN + endpointUrl)
    .digest('hex');
  res.json({ challengeResponse: hash });
});

app.post('/api/ebay/account-deletion', (req, res) => {
  // Acknowledge account deletion notifications (no user data stored)
  res.sendStatus(200);
});

// ---- Fetch listing details from an eBay listing URL ----
app.get('/api/ebay-listing-details', async (req, res) => {
  const { url } = req.query;
  if (!url || !url.includes('ebay.com/itm/')) {
    return res.status(400).json({ error: 'Invalid eBay listing URL' });
  }
  try {
    const response = await axios.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      timeout: 8000,
    });
    const html = response.data;

    // Extract og:image
    const imgMatch = html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i)
                  || html.match(/<meta\s+content=["']([^"']+)["']\s+property=["']og:image["']/i);
    const imageUrl = imgMatch ? imgMatch[1] : null;

    // Extract og:title (eBay sets this to the listing title)
    const titleMatch = html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i)
                    || html.match(/<meta\s+content=["']([^"']+)["']\s+property=["']og:title["']/i);
    let title = titleMatch ? titleMatch[1].replace(/\s*\|\s*eBay$/i, '').trim() : null;

    // Extract price from structured data or meta tags
    const priceMatch = html.match(/"price"\s*:\s*"?([\d.]+)"?/i)
                    || html.match(/<span[^>]*class="[^"]*ux-textspans[^"]*"[^>]*>US \$([\d,.]+)<\/span>/i)
                    || html.match(/itemprop=["']price["']\s+content=["']([\d.]+)["']/i);
    const price = priceMatch ? parseFloat(priceMatch[1].replace(/,/g, '')) : null;

    // Extract condition
    const condMatch = html.match(/"conditionDisplayName"\s*:\s*"([^"]+)"/i)
                   || html.match(/itemprop=["']itemCondition["'][^>]*content=["']([^"']+)["']/i)
                   || html.match(/<span[^>]*class="[^"]*ux-icon-text[^"]*"[^>]*>([^<]*(?:New|Used|Ungraded|PSA|BGS|SGC|Mint|Near Mint)[^<]*)<\/span>/i);
    const condition = condMatch ? condMatch[1].trim() : null;

    res.json({ title, price, imageUrl, condition });
  } catch (err) {
    console.error('eBay listing details fetch error:', err.message);
    res.json({ title: null, price: null, imageUrl: null, condition: null });
  }
});

// Backward compat alias
app.get('/api/ebay-listing-image', async (req, res) => {
  const { url } = req.query;
  if (!url || !url.includes('ebay.com/itm/')) {
    return res.status(400).json({ error: 'Invalid eBay listing URL' });
  }
  try {
    const resp = await axios.get(`http://localhost:${PORT}/api/ebay-listing-details?url=${encodeURIComponent(url)}`);
    res.json({ imageUrl: resp.data.imageUrl });
  } catch (err) {
    res.json({ imageUrl: null });
  }
});

// ---- Checklist Data API ----
const checklistData = JSON.parse(require('fs').readFileSync(path.join(__dirname, 'data', 'checklists.json'), 'utf8'));

// GET /api/checklists — list all products
app.get('/api/checklists', (req, res) => {
  const products = checklistData.products.map(p => ({
    id: p.id,
    name: p.name,
    year: p.year,
    brand: p.brand,
    sport: p.sport,
    setCount: p.sets.length,
    totalCards: p.sets.reduce((sum, s) => sum + s.totalCards, 0),
  }));
  res.json({ products });
});

// GET /api/checklists/:productId — get full product with all sets
app.get('/api/checklists/:productId', (req, res) => {
  const product = checklistData.products.find(p => p.id === req.params.productId);
  if (!product) return res.status(404).json({ error: 'Product not found' });
  res.json(product);
});

// GET /api/checklists/:productId/search?q=player — search cards within a product
app.get('/api/checklists/:productId/search', (req, res) => {
  const product = checklistData.products.find(p => p.id === req.params.productId);
  if (!product) return res.status(404).json({ error: 'Product not found' });

  const q = (req.query.q || '').toLowerCase().trim();
  if (!q) return res.json({ results: [] });

  const results = [];
  for (const set of product.sets) {
    for (const card of set.cards) {
      if (card.player.toLowerCase().includes(q) || card.team.toLowerCase().includes(q) || card.number.toLowerCase().includes(q)) {
        results.push({
          ...card,
          setId: set.id,
          setName: set.name,
          category: set.category,
          parallels: set.parallels,
        });
      }
    }
  }
  res.json({ results, query: q });
});

// ---- Card Alerts System (Pro Feature) ----
const ALERTS_FILE = path.join(__dirname, 'data', 'alerts.json');

function loadAlerts() {
  return loadData('alerts', ALERTS_FILE, { alerts: [] });
}

function saveAlerts(data) {
  saveData('alerts', ALERTS_FILE, data);
}

// Email transporter (configured via env vars)
const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = process.env.SMTP_PORT || 587;
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const SMTP_FROM = process.env.SMTP_FROM || 'alerts@thecardhuddle.com';

let emailTransporter = null;
if (SMTP_HOST && SMTP_USER && SMTP_PASS) {
  emailTransporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT),
    secure: Number(SMTP_PORT) === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  console.log(`Email configured: ${SMTP_HOST}:${SMTP_PORT}`);
} else {
  console.log('Email not configured (set SMTP_HOST, SMTP_USER, SMTP_PASS to enable)');
}

// Create alert
app.post('/api/alerts', (req, res) => {
  const { username, email, query, label, priceThreshold, priceCondition } = req.body;
  if (!username || !email || !query) {
    return res.status(400).json({ error: 'username, email, and query are required' });
  }
  if (!email.match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)) {
    return res.status(400).json({ error: 'Invalid email address' });
  }

  const data = loadAlerts();
  // Limit per user
  const userAlerts = data.alerts.filter(a => a.username.toLowerCase() === username.toLowerCase());
  if (userAlerts.length >= 25) {
    return res.status(400).json({ error: 'Maximum 25 alerts per account' });
  }
  // No duplicate queries for same user
  if (userAlerts.some(a => a.query.toLowerCase() === query.toLowerCase() && !a.priceThreshold)) {
    return res.status(400).json({ error: 'You already have an alert for this card' });
  }

  const alert = {
    id: crypto.randomUUID(),
    username: username.toLowerCase(),
    email,
    query,
    label: label || query,
    priceThreshold: priceThreshold ? parseFloat(priceThreshold) : null,
    priceCondition: priceCondition || null, // 'below' or 'above'
    createdAt: new Date().toISOString(),
    lastChecked: null,
    lastSeenIds: [],
  };

  data.alerts.push(alert);
  saveAlerts(data);
  res.json({ alert: { id: alert.id, query: alert.query, label: alert.label, createdAt: alert.createdAt, priceThreshold: alert.priceThreshold, priceCondition: alert.priceCondition } });
});

// List alerts for a user
app.get('/api/alerts', (req, res) => {
  const { username } = req.query;
  if (!username) return res.status(400).json({ error: 'username is required' });

  const data = loadAlerts();
  const userAlerts = data.alerts
    .filter(a => a.username === username.toLowerCase())
    .map(a => ({ id: a.id, query: a.query, label: a.label, createdAt: a.createdAt, priceThreshold: a.priceThreshold || null, priceCondition: a.priceCondition || null }));

  res.json({ alerts: userAlerts });
});

// Delete alert
app.delete('/api/alerts/:id', (req, res) => {
  const { username } = req.query;
  if (!username) return res.status(400).json({ error: 'username is required' });

  const data = loadAlerts();
  const idx = data.alerts.findIndex(a => a.id === req.params.id && a.username === username.toLowerCase());
  if (idx === -1) return res.status(404).json({ error: 'Alert not found' });

  data.alerts.splice(idx, 1);
  saveAlerts(data);
  res.json({ ok: true });
});

// ---- Background Alert Checker ----
const ALERT_CHECK_INTERVAL = 15 * 60 * 1000; // 15 minutes

async function checkAlerts() {
  const data = loadAlerts();
  if (!data.alerts.length) return;

  console.log(`[Alerts] Checking ${data.alerts.length} alerts...`);

  for (const alert of data.alerts) {
    try {
      let searchResult;
      if (USE_MOCK) {
        searchResult = getMockData(alert.query, 'sold');
      } else if (EBAY_API_MODE === 'browse') {
        searchResult = await withRetry(() => fetchViaBrowseAPI(alert.query, 10, 'alerts'));
      } else {
        searchResult = await withRetry(() => fetchViaFindingAPI(alert.query, 10, 'alerts'));
      }

      const currentIds = searchResult.results.map(r => r.itemId);
      const previousIds = new Set(alert.lastSeenIds || []);
      let newListings = searchResult.results.filter(r => !previousIds.has(r.itemId));

      // Apply price threshold filter if set
      if (alert.priceThreshold && alert.priceCondition && newListings.length > 0) {
        newListings = newListings.filter(r => {
          const price = parseFloat(r.price);
          if (isNaN(price)) return false;
          return alert.priceCondition === 'below' ? price <= alert.priceThreshold : price >= alert.priceThreshold;
        });
      }

      alert.lastChecked = new Date().toISOString();
      alert.lastSeenIds = currentIds;

      if (newListings.length > 0 && previousIds.size > 0) {
        console.log(`[Alerts] ${newListings.length} new listing(s) for "${alert.query}"${alert.priceThreshold ? ` (${alert.priceCondition} $${alert.priceThreshold})` : ''} -> ${alert.email}`);
        await sendAlertEmail(alert, newListings);
      }

      // Small delay between checks to avoid rate limits
      await new Promise(r => setTimeout(r, 2000));
    } catch (err) {
      console.error(`[Alerts] Error checking "${alert.query}":`, err.message);
    }
  }

  saveAlerts(data);
  console.log('[Alerts] Check complete.');
}

async function sendAlertEmail(alert, newListings) {
  if (!emailTransporter) {
    console.log(`[Alerts] Email not configured, would notify ${alert.email} about ${newListings.length} new listing(s) for "${alert.query}"`);
    return;
  }

  const listingsHtml = newListings.map(item => `
    <tr>
      <td style="padding:8px;border-bottom:1px solid #eee;">
        <a href="${item.itemUrl}" style="color:#2d6a4f;font-weight:600;">${item.title}</a>
      </td>
      <td style="padding:8px;border-bottom:1px solid #eee;font-weight:700;color:#2d6a4f;">
        $${item.price}
      </td>
    </tr>
  `).join('');

  const html = `
    <div style="font-family:Inter,Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
      <h2 style="color:#2d6a4f;margin-bottom:4px;">New Listing Alert</h2>
      <p style="color:#666;margin-bottom:16px;">
        ${newListings.length} new listing${newListings.length > 1 ? 's' : ''} found for <strong>${alert.label}</strong>
      </p>
      <table style="width:100%;border-collapse:collapse;">
        <thead>
          <tr style="background:#f5f7fa;">
            <th style="text-align:left;padding:8px;font-size:0.85rem;color:#666;">Card</th>
            <th style="text-align:left;padding:8px;font-size:0.85rem;color:#666;">Price</th>
          </tr>
        </thead>
        <tbody>${listingsHtml}</tbody>
      </table>
      <p style="color:#999;font-size:0.8rem;margin-top:20px;">
        You're receiving this because you set up a card alert on The Card Huddle.
      </p>
    </div>
  `;

  try {
    await emailTransporter.sendMail({
      from: SMTP_FROM,
      to: alert.email,
      subject: `New listing: ${alert.label}`,
      html,
    });
  } catch (err) {
    console.error(`[Alerts] Failed to send email to ${alert.email}:`, err.message);
  }
}

// Start alert checker loop
setInterval(checkAlerts, ALERT_CHECK_INTERVAL);
// Run first check 30 seconds after startup
setTimeout(checkAlerts, 30000);

// ---- Marketplace: Browse active eBay listings ----
app.get('/api/marketplace', async (req, res) => {
  const q = (req.query.q || '').trim();
  const sort = req.query.sort || '';
  const offset = parseInt(req.query.offset) || 0;
  const limit = Math.min(parseInt(req.query.limit) || 24, 50);

  if (!q || q.length < 2) return res.json({ results: [], total: 0 });

  if (USE_MOCK) {
    return res.json({ results: [], total: 0, mock: true });
  }

  const cacheKey = `marketplace:${q}:${sort}:${offset}:${limit}`;
  const cached = getCached(cacheKey);
  if (cached) return res.json(cached);

  try {
    const token = await getOAuthToken();
    const params = {
      q,
      category_ids: '261328',
      limit,
      offset,
    };
    if (sort) params.sort = sort;

    const response = await axios.get(
      'https://api.ebay.com/buy/browse/v1/item_summary/search',
      {
        params,
        headers: {
          'Authorization': `Bearer ${token}`,
          'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
        },
        timeout: 15000,
      }
    );

    const items = (response.data?.itemSummaries || []).map(item => ({
      itemId: item.itemId || '',
      title: item.title || '',
      price: item.price?.value || '0',
      currency: item.price?.currency || 'USD',
      imageUrl: item.thumbnailImages?.[0]?.imageUrl || item.image?.imageUrl || null,
      itemUrl: item.itemWebUrl || '',
      condition: item.condition || 'Unknown',
      seller: item.seller?.username || '',
      sellerFeedback: item.seller?.feedbackPercentage || '',
      shippingCost: item.shippingOptions?.[0]?.shippingCost?.value || null,
      listingDate: item.itemCreationDate || '',
      buyingOptions: item.buyingOptions || [],
    }));

    const result = { results: items, total: response.data?.total || items.length, offset, limit };
    setCached(cacheKey, result);
    res.json(result);
  } catch (err) {
    console.error('Marketplace API error:', err.message);
    res.status(502).json({ error: 'eBay API error', detail: err.message });
  }
});

// ---- Marketplace Insights (built from Finding API sold data) ----
app.get('/api/marketplace-insights', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q || q.length < 2) return res.status(400).json({ error: 'Query required (min 2 chars)' });

  const cacheKey = `insights:${q}`;
  const cached = getCached(cacheKey);
  if (cached) return res.json(cached);

  if (USE_MOCK) {
    const mock = buildMockInsights(q);
    setCache(cacheKey, mock);
    return res.json(mock);
  }

  try {
    // Fetch up to 50 sold items via Finding API
    const { results } = await withRetry(() => fetchViaFindingAPI(q, 50, 'marketplace-insights'));

    if (results.length === 0) {
      return res.json({ query: q, totalSold: 0, insights: null });
    }

    const prices = results.map(r => parseFloat(r.price)).filter(p => !isNaN(p) && p > 0);
    prices.sort((a, b) => a - b);

    const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
    const median = prices.length % 2 === 0
      ? (prices[prices.length / 2 - 1] + prices[prices.length / 2]) / 2
      : prices[Math.floor(prices.length / 2)];

    // Price distribution buckets
    const buckets = {};
    prices.forEach(p => {
      let label;
      if (p < 5) label = 'Under $5';
      else if (p < 10) label = '$5-$10';
      else if (p < 25) label = '$10-$25';
      else if (p < 50) label = '$25-$50';
      else if (p < 100) label = '$50-$100';
      else if (p < 250) label = '$100-$250';
      else if (p < 500) label = '$250-$500';
      else label = '$500+';
      buckets[label] = (buckets[label] || 0) + 1;
    });

    // Sales timeline (group by date)
    const timeline = {};
    results.forEach(r => {
      if (!r.soldDate) return;
      const date = r.soldDate.slice(0, 10);
      if (!timeline[date]) timeline[date] = { count: 0, total: 0, prices: [] };
      const p = parseFloat(r.price);
      if (!isNaN(p) && p > 0) {
        timeline[date].count++;
        timeline[date].total += p;
        timeline[date].prices.push(p);
      }
    });

    const salesByDate = Object.entries(timeline)
      .map(([date, d]) => ({
        date,
        count: d.count,
        avgPrice: d.count > 0 ? d.total / d.count : 0,
        totalVolume: d.total,
      }))
      .sort((a, b) => a.date.localeCompare(b.date));

    // Condition breakdown
    const conditionMap = {};
    results.forEach(r => {
      const cond = r.condition || 'Unknown';
      if (!conditionMap[cond]) conditionMap[cond] = { count: 0, prices: [] };
      conditionMap[cond].count++;
      const p = parseFloat(r.price);
      if (!isNaN(p) && p > 0) conditionMap[cond].prices.push(p);
    });

    const conditionBreakdown = Object.entries(conditionMap).map(([cond, d]) => ({
      condition: cond,
      count: d.count,
      avgPrice: d.prices.length > 0 ? d.prices.reduce((a, b) => a + b, 0) / d.prices.length : 0,
    })).sort((a, b) => b.count - a.count);

    // Top sales
    const topSales = [...results]
      .filter(r => parseFloat(r.price) > 0)
      .sort((a, b) => parseFloat(b.price) - parseFloat(a.price))
      .slice(0, 5)
      .map(r => ({ title: r.title, price: parseFloat(r.price), date: r.soldDate?.slice(0, 10), url: r.itemUrl, imageUrl: r.imageUrl }));

    // Price trend (compare first half vs second half of results by date)
    let trend = 'stable';
    if (salesByDate.length >= 2) {
      const mid = Math.floor(salesByDate.length / 2);
      const olderAvg = salesByDate.slice(0, mid).reduce((s, d) => s + d.avgPrice, 0) / mid;
      const newerAvg = salesByDate.slice(mid).reduce((s, d) => s + d.avgPrice, 0) / (salesByDate.length - mid);
      const pctChange = olderAvg > 0 ? ((newerAvg - olderAvg) / olderAvg) * 100 : 0;
      if (pctChange > 10) trend = 'rising';
      else if (pctChange < -10) trend = 'falling';
    }

    const result = {
      query: q,
      totalSold: results.length,
      insights: {
        avgPrice: Math.round(avg * 100) / 100,
        medianPrice: Math.round(median * 100) / 100,
        minPrice: prices[0],
        maxPrice: prices[prices.length - 1],
        priceSpread: Math.round((prices[prices.length - 1] - prices[0]) * 100) / 100,
        trend,
        salesByDate,
        priceDistribution: buckets,
        conditionBreakdown,
        topSales,
        sampleSize: prices.length,
      },
    };

    setCache(cacheKey, result);
    res.json(result);
  } catch (err) {
    console.error('Marketplace insights error:', err.message);
    const status = err.response?.status || 500;
    res.status(status).json({ error: 'Failed to generate insights', detail: err.message });
  }
});

function buildMockInsights(query) {
  const player = query.trim().split(/\s+/).slice(0, 2).join(' ');
  let hash = 0;
  for (let i = 0; i < query.length; i++) hash = ((hash << 5) - hash + query.charCodeAt(i)) | 0;
  const seed = Math.abs(hash);
  const basePrice = 5 + (seed % 50);

  const salesByDate = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const count = 1 + (seed + i) % 5;
    const avg = basePrice + ((seed * (i + 1)) % 20) - 10;
    salesByDate.push({ date: d.toISOString().slice(0, 10), count, avgPrice: Math.max(1, Math.round(avg * 100) / 100), totalVolume: Math.round(avg * count * 100) / 100 });
  }

  return {
    query,
    totalSold: 30 + (seed % 20),
    mock: true,
    insights: {
      avgPrice: basePrice,
      medianPrice: basePrice - 2,
      minPrice: Math.max(1, basePrice - 15),
      maxPrice: basePrice + 30,
      priceSpread: 45,
      trend: ['rising', 'falling', 'stable'][seed % 3],
      salesByDate,
      priceDistribution: { 'Under $5': 3, '$5-$10': 8, '$10-$25': 12, '$25-$50': 5, '$50-$100': 2 },
      conditionBreakdown: [
        { condition: 'Ungraded', count: 20, avgPrice: basePrice - 3 },
        { condition: 'PSA 10', count: 5, avgPrice: basePrice + 25 },
        { condition: 'PSA 9', count: 3, avgPrice: basePrice + 10 },
      ],
      topSales: [
        { title: `${player} 2024 Prizm Silver`, price: basePrice + 30, date: salesByDate[0].date, url: '#', imageUrl: null },
        { title: `${player} 2024 Prizm Gold /10`, price: basePrice + 50, date: salesByDate[1].date, url: '#', imageUrl: null },
      ],
      sampleSize: 30,
    },
  };
}

// ---- Price History Storage ----
const PRICE_HISTORY_FILE = path.join(__dirname, 'data', 'price-history.json');

function loadPriceHistory() {
  return loadData('priceHistory', PRICE_HISTORY_FILE, {});
}

function savePriceHistory(data) {
  saveData('priceHistory', PRICE_HISTORY_FILE, data);
}

// Record a price data point (called after searches)
app.post('/api/price-history', (req, res) => {
  const { query, avgPrice, medianPrice, highPrice, lowPrice, sampleSize } = req.body;
  if (!query || avgPrice == null) return res.status(400).json({ error: 'query and avgPrice required' });

  const history = loadPriceHistory();
  const key = query.toLowerCase().trim();
  if (!history[key]) history[key] = [];

  history[key].push({
    date: new Date().toISOString().slice(0, 10),
    avg: parseFloat(avgPrice),
    median: medianPrice ? parseFloat(medianPrice) : null,
    high: highPrice ? parseFloat(highPrice) : null,
    low: lowPrice ? parseFloat(lowPrice) : null,
    n: sampleSize || 0,
  });

  // Keep only last 90 days
  if (history[key].length > 90) history[key] = history[key].slice(-90);

  savePriceHistory(history);
  res.json({ ok: true });
});

// Get price history for a query
app.get('/api/price-history', (req, res) => {
  const q = (req.query.q || '').toLowerCase().trim();
  if (!q) return res.json({ history: [] });

  const history = loadPriceHistory();
  res.json({ history: history[q] || [], query: q });
});

// ---- Stripe Subscription Storage ----
const SUBS_FILE = path.join(__dirname, 'data', 'subscriptions.json');

function loadSubscriptions() {
  return loadData('subscriptions', SUBS_FILE, {});
}

function saveSubscriptions(subs) {
  saveData('subscriptions', SUBS_FILE, subs);
}

// ---- Stripe API Routes ----

// Get Stripe publishable key
app.get('/api/stripe/config', (req, res) => {
  res.json({
    publishableKey: stripeEnabled ? STRIPE_PUBLISHABLE_KEY : null,
    enabled: stripeEnabled
  });
});

// Create checkout session for Pro subscription
app.post('/api/stripe/create-checkout', async (req, res) => {
  if (!stripeEnabled) return res.status(503).json({ error: 'Stripe is not configured. Add your Stripe keys to .env' });

  const { username, period } = req.body;
  if (!username) return res.status(400).json({ error: 'Username required' });

  try {
    const priceData = period === 'yearly'
      ? { unit_amount: 3999, recurring: { interval: 'year' } }
      : { unit_amount: 499, recurring: { interval: 'month' } };

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: `Card Huddle Pro (${period === 'yearly' ? 'Yearly' : 'Monthly'})` },
          ...priceData
        },
        quantity: 1
      }],
      metadata: { username: username.toLowerCase(), period: period || 'monthly' },
      success_url: `${req.protocol}://${req.get('host')}/?payment=success&plan=pro`,
      cancel_url: `${req.protocol}://${req.get('host')}/?payment=cancelled`
    });

    res.json({ url: session.url, sessionId: session.id });
  } catch (err) {
    console.error('Stripe checkout error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Create checkout session for extra promote slot
app.post('/api/stripe/buy-slot', async (req, res) => {
  if (!stripeEnabled) return res.status(503).json({ error: 'Stripe is not configured. Add your Stripe keys to .env' });

  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'Username required' });

  const subs = loadSubscriptions();
  const userSub = subs[username.toLowerCase()];
  if (!userSub || userSub.status !== 'active') {
    return res.status(403).json({ error: 'Pro subscription required' });
  }

  const currentExtra = userSub.extraPromoteSlots || 0;
  if (currentExtra >= 10) {
    return res.status(400).json({ error: 'Maximum extra slots reached (10)' });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: 'Extra Promote Slot' },
          unit_amount: 299
        },
        quantity: 1
      }],
      metadata: { username: username.toLowerCase(), type: 'extra_slot' },
      success_url: `${req.protocol}://${req.get('host')}/?payment=success&type=slot`,
      cancel_url: `${req.protocol}://${req.get('host')}/?payment=cancelled`
    });

    res.json({ url: session.url, sessionId: session.id });
  } catch (err) {
    console.error('Stripe slot purchase error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get subscription status for a user
app.get('/api/stripe/subscription', (req, res) => {
  const username = req.query.username;
  if (!username) return res.status(400).json({ error: 'Username required' });

  const subs = loadSubscriptions();
  const userSub = subs[username.toLowerCase()] || null;
  res.json({ subscription: userSub, stripeEnabled });
});

// ---- SportsCardsPro / PriceCharting API ----
async function fetchSportsCardsProPrices(query) {
  const cacheKey = `scp:${query.toLowerCase()}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const token = SPORTSCARDSPRO_API_KEY;
  // Search for the product by name
  const searchRes = await axios.get('https://www.pricecharting.com/api/products', {
    params: { t: token, q: query, type: 'prices', category: 'football-cards' },
    timeout: 10000,
  });

  const products = searchRes.data?.products || [];
  if (products.length === 0) return { products: [], source: 'sportscardspro' };

  // Get detailed prices for first few results (limit to 5 to avoid rate limits)
  const detailed = products.slice(0, 5).map(p => ({
    id: p.id,
    name: p['product-name'] || p.name || '',
    consoleName: p['console-name'] || '',
    ungraded: p['ungraded-price'] ? (p['ungraded-price'] / 100).toFixed(2) : null,
    psa9: p['graded-price'] ? (p['graded-price'] / 100).toFixed(2) : null,
    psa10: p['manual-only-price'] ? (p['manual-only-price'] / 100).toFixed(2) : null,
    boxOnly: p['box-only-price'] ? (p['box-only-price'] / 100).toFixed(2) : null,
  }));

  const result = { products: detailed, source: 'sportscardspro' };
  setCache(cacheKey, result);
  return result;
}

function getMockSportsCardsProPrices(query) {
  // Extract player name by removing years, known sets, and noise words
  const playerName = extractPlayerName(query) || query.trim().split(/\s+/).slice(0, 2).join(' ') || 'Player';
  const year = extractYear(query) || '2024';
  let hash = 0;
  for (let i = 0; i < query.length; i++) hash = ((hash << 5) - hash + query.charCodeAt(i)) | 0;
  const seed = Math.abs(hash);

  const sets = ['Prizm Base', 'Prizm Silver', 'Select Concourse', 'Donruss Rated Rookie', 'Mosaic Base'];
  const products = [];
  const count = Math.min(3 + (seed % 3), 5);

  for (let i = 0; i < count; i++) {
    const basePrice = (5 + ((seed * (i + 1)) % 200));
    products.push({
      id: `mock-${seed}-${i}`,
      name: `${year} ${sets[i % sets.length]} ${playerName}`,
      consoleName: 'Football Cards',
      ungraded: (basePrice * 0.6).toFixed(2),
      psa9: (basePrice * 1.2).toFixed(2),
      psa10: (basePrice * 3.5).toFixed(2),
      boxOnly: null,
    });
  }

  return { products, source: 'sportscardspro-mock' };
}

app.get('/api/card-prices', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q || q.length < 2) return res.status(400).json({ error: 'Query required (min 2 chars)' });

  if (!SPORTSCARDSPRO_ENABLED) {
    // Return mock data when API key not configured
    return res.json(getMockSportsCardsProPrices(q));
  }

  try {
    const data = await withRetry(() => fetchSportsCardsProPrices(q), 1);
    res.json(data);
  } catch (err) {
    console.error('SportsCardsPro API error:', err.message);
    // Fall back to mock on error
    res.json(getMockSportsCardsProPrices(q));
  }
});

// ---- Feedback / Bug Reports ----
const FEEDBACK_FILE = path.join(__dirname, 'data', 'feedback.json');

app.post('/api/feedback', (req, res) => {
  const { type, email, message, timestamp, userAgent } = req.body;
  if (!message || !message.trim()) {
    return res.status(400).json({ error: 'Message is required' });
  }

  try {
    const feedback = loadData('feedback', FEEDBACK_FILE, []);

    feedback.push({
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      type: type || 'feedback',
      email: email || '',
      message: message.trim(),
      timestamp: timestamp || new Date().toISOString(),
      userAgent: userAgent || '',
    });

    saveData('feedback', FEEDBACK_FILE, feedback);
    console.log(`[Feedback] New ${type || 'feedback'} received${email ? ' from ' + email : ''}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('Error saving feedback:', err.message);
    res.status(500).json({ error: 'Failed to save feedback' });
  }
});

app.get('/api/feedback', (req, res) => {
  try {
    res.json(loadData('feedback', FEEDBACK_FILE, []));
  } catch (err) {
    res.json([]);
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Connect to MongoDB (if configured) then start server
connectDB().then(() => {
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`eBay mode: ${USE_MOCK ? 'MOCK DATA' : `LIVE API (${EBAY_API_MODE})`}`);
    console.log(`EBAY_APP_ID: ${EBAY_APP_ID ? EBAY_APP_ID.slice(0, 10) + '...' : 'NOT SET'}`);
    console.log(`EBAY_CERT_ID: ${EBAY_CERT_ID ? '***set***' : 'NOT SET'}`);
    console.log(`Stripe: ${stripeEnabled ? 'ENABLED (test mode)' : 'NOT CONFIGURED — add keys to .env'}`);
    console.log(`SportsCardsPro: ${SPORTSCARDSPRO_ENABLED ? 'ENABLED' : 'NOT CONFIGURED (using mock data) — add SPORTSCARDSPRO_API_KEY to .env'}`);
    if ((EBAY_API_MODE === 'insights' || EBAY_API_MODE === 'browse') && !EBAY_CERT_ID) {
      console.warn(`WARNING: EBAY_API_MODE is "${EBAY_API_MODE}" but EBAY_CERT_ID is not set. OAuth will fail.`);
    }
  });
});

function getMockVariants(query, mode) {
  const player = query.trim().split(/\s+/).slice(0, 2).join(' ');
  // Seed from query for varied but deterministic data
  let hash = 0;
  for (let i = 0; i < query.length; i++) hash = ((hash << 5) - hash + query.charCodeAt(i)) | 0;
  const seed = Math.abs(hash);

  const setPool = [
    { year: '2024', set: 'Panini Prizm', parallels: ['Base', 'Silver', 'Red White Blue /175', 'Blue /199', 'Green /75', 'Gold /10'] },
    { year: '2024', set: 'Panini Select', parallels: ['Base Concourse', 'Silver Concourse', 'Premier Level', 'Club Level Blue /149'] },
    { year: '2024', set: 'Panini Mosaic', parallels: ['Base', 'Silver', 'Green /99', 'Gold /10'] },
    { year: '2024', set: 'Donruss Optic', parallels: ['Base', 'Holo', 'Purple /75', 'Gold /10'] },
    { year: '2025', set: 'Panini Prizm', parallels: ['Base', 'Silver', 'Shimmer', 'Teal /199'] },
    { year: '2025', set: 'Bowman', parallels: ['Base', 'Refractor', 'Blue Refractor /199', 'Gold Refractor /50'] },
    { year: '2024', set: 'Panini Certified', parallels: ['Base', 'Mirror Red /299', 'Mirror Blue /75'] },
    { year: '2024', set: 'Panini Phoenix', parallels: ['Base', 'Fire Burst', 'Green /199'] },
  ];

  // Pick 5-7 variants seeded by query
  const count = 5 + (seed % 3);
  const variants = [];
  for (let i = 0; i < count && i < setPool.length; i++) {
    const idx = (seed + i * 3) % setPool.length;
    const s = setPool[idx];
    const parallelIdx = (seed + i) % s.parallels.length;
    const parallel = s.parallels[parallelIdx];
    const baseAvg = 15 + (seed % 150) + (i * 12);
    const salesCount = 3 + ((seed + i) % 10);
    const min = Math.round(baseAvg * 0.6);
    const max = Math.round(baseAvg * 1.5);

    variants.push({
      id: `${s.year}-${s.set.toLowerCase().replace(/\s+/g, '-')}-${parallel.toLowerCase().replace(/[\s/]+/g, '-')}`,
      displayName: `${s.year} ${s.set} ${parallel}`,
      searchQuery: `${player} ${s.year} ${s.set} ${parallel}`,
      salesCount,
      avgPrice: baseAvg,
      priceRange: { min, max },
      imageUrl: null,
    });
  }

  return { variants, mock: true };
}

function getMockDirectSearch(query, mode) {
  const parsed = parseCardQuery(query);
  const hasSpecificCard = (parsed.parallel || parsed.set) && parsed.year;
  const today = new Date();
  const day = ms => new Date(today - ms).toISOString();
  const ebayUrl = 'https://www.ebay.com/sch/i.html?_nkw=' + encodeURIComponent(query);

  let hash = 0;
  for (let i = 0; i < query.length; i++) hash = ((hash << 5) - hash + query.charCodeAt(i)) | 0;
  const seed = Math.abs(hash);
  const basePrice = 20 + (seed % 250);

  const isSold = mode === 'sold';
  const conditions = ['Near Mint', 'Mint', 'Near Mint or Better', 'Excellent'];
  const gradedConditions = ['PSA 10 Gem Mint', 'PSA 9 Mint', 'BGS 9.5 Gem Mint', 'SGC 10 Pristine'];

  if (hasSpecificCard) {
    const count = 3 + (seed % 4);
    const results = [];
    for (let i = 0; i < count; i++) {
      const variance = 0.65 + (((seed + i * 7) % 70) / 100);
      const price = (basePrice * variance).toFixed(2);
      const isGraded = i < 2;
      const cond = isGraded ? gradedConditions[(seed + i) % gradedConditions.length] : conditions[(seed + i) % conditions.length];
      results.push({
        itemId: `ds-${seed}-${i}`,
        title: `${query} ${isGraded ? cond.split(' ').slice(0, 2).join(' ') : 'Raw'}`,
        price,
        currency: 'USD',
        soldDate: isSold ? day((1 + i * 2) * 86400000) : null,
        imageUrl: null,
        itemUrl: ebayUrl,
        condition: cond,
      });
    }
    return {
      results, total: results.length, mock: true, mode, searchType: 'exact',
      broadenedQuery: null, approximateValue: null,
    };
  }

  // Broadened fallback
  const parallels = ['Silver', 'Gold /10', 'Base', 'Blue /199', 'Red /149'];
  const count = 4 + (seed % 3);
  const results = [];
  for (let i = 0; i < count; i++) {
    const variance = 0.5 + (((seed + i * 11) % 100) / 100);
    const price = (basePrice * variance).toFixed(2);
    const parallel = parallels[(seed + i) % parallels.length];
    results.push({
      itemId: `ds-b-${seed}-${i}`,
      title: `${parsed.playerName || query} 2024 Panini Prizm ${parallel}`,
      price,
      currency: 'USD',
      soldDate: isSold ? day((1 + i * 3) * 86400000) : null,
      imageUrl: null,
      itemUrl: ebayUrl,
      condition: conditions[(seed + i) % conditions.length],
    });
  }

  const prices = results.map(r => parseFloat(r.price)).sort((a, b) => a - b);
  const median = prices[Math.floor(prices.length / 2)];
  const avg = prices.reduce((a, b) => a + b, 0) / prices.length;

  return {
    results, total: results.length, mock: true, mode, searchType: 'broadened',
    broadenedQuery: `${parsed.playerName || query} Prizm`,
    approximateValue: {
      avgPrice: parseFloat(avg.toFixed(2)),
      medianPrice: parseFloat(median.toFixed(2)),
      priceRange: { min: prices[0], max: prices[prices.length - 1] },
      sampleSize: prices.length,
      basedOn: `Prizm ${parsed.playerName || query} (all parallels)`,
    },
  };
}

function getMockData(query, mode) {
  const today = new Date();
  const day = ms => new Date(today - ms).toISOString();
  const ebayUrl = 'https://www.ebay.com/sch/i.html?_nkw=' + encodeURIComponent(query);

  // Seed a simple hash from the query for deterministic but varied pricing
  let hash = 0;
  for (let i = 0; i < query.length; i++) hash = ((hash << 5) - hash + query.charCodeAt(i)) | 0;
  const seed = Math.abs(hash);
  const basePrice = 5 + (seed % 200); // $5-$204 range based on query

  // Detect context from the query
  const isAuto = /auto|signature|signed/i.test(query);
  const isNumbered = /\/\d{1,4}/.test(query);
  const isRookie = /rookie|rc\b/i.test(query);
  const multiplier = (isAuto ? 2.5 : 1) * (isNumbered ? 1.8 : 1) * (isRookie ? 1.4 : 1);

  const parallels = ['Base', 'Silver', 'Blue /199', 'Red /149', 'Green /75', 'Gold /10', 'Black 1/1'];
  const conditions = ['Near Mint', 'Mint', 'Excellent', 'Near Mint or Better'];
  const gradedConditions = ['PSA 10 Gem Mint', 'PSA 9 Mint', 'BGS 9.5 Gem Mint', 'BGS 10 Pristine', 'SGC 10 Pristine'];

  if (mode === 'sold') {
    // Sold listings: 6-10 results with dates spread over the last 30 days
    const count = 6 + (seed % 5);
    const results = [];
    for (let i = 0; i < count; i++) {
      const daysAgo = 1 + (((seed + i * 7) % 28));
      const priceVariance = 0.6 + (((seed + i * 13) % 80) / 100); // 0.60 - 1.39x
      const price = (basePrice * multiplier * priceVariance).toFixed(2);
      const isGraded = i < 3; // first few are graded
      const parallel = parallels[(seed + i) % parallels.length];
      const cond = isGraded
        ? gradedConditions[(seed + i) % gradedConditions.length]
        : conditions[(seed + i) % conditions.length];

      results.push({
        itemId: `mock-sold-${seed}-${i}`,
        title: `${query} ${parallel !== 'Base' ? parallel : ''} ${isGraded ? cond.split(' ')[0] + ' ' + cond.split(' ')[1] : ''}`.replace(/\s+/g, ' ').trim(),
        price,
        currency: 'USD',
        soldDate: day(daysAgo * 86400000),
        imageUrl: null,
        itemUrl: ebayUrl,
        condition: cond,
      });
    }
    // Sort by date descending (most recent first)
    results.sort((a, b) => new Date(b.soldDate) - new Date(a.soldDate));
    return { results, total: results.length, mock: true, mode: 'sold', serial: null, similarResults: [], searchType: 'exact', broadenedQuery: null, approximateValue: null };
  }

  // For-sale listings: 4-8 results, no soldDate
  const count = 4 + (seed % 5);
  const results = [];
  for (let i = 0; i < count; i++) {
    const priceVariance = 0.7 + (((seed + i * 11) % 90) / 100); // 0.70 - 1.59x
    const price = (basePrice * multiplier * priceVariance).toFixed(2);
    const isGraded = i < 2;
    const parallel = parallels[(seed + i * 3) % parallels.length];
    const cond = isGraded
      ? gradedConditions[(seed + i) % gradedConditions.length]
      : conditions[(seed + i) % conditions.length];
    const daysAgo = ((seed + i * 5) % 14); // listed 0-13 days ago

    results.push({
      itemId: `mock-sale-${seed}-${i}`,
      title: `${query} ${parallel !== 'Base' ? parallel : ''} ${isGraded ? cond.split(' ')[0] + ' ' + cond.split(' ')[1] : ''}`.replace(/\s+/g, ' ').trim(),
      price,
      currency: 'USD',
      soldDate: null,
      listDate: day(daysAgo * 86400000),
      imageUrl: null,
      itemUrl: ebayUrl,
      condition: cond,
    });
  }
  // Sort by price ascending (cheapest first)
  results.sort((a, b) => parseFloat(a.price) - parseFloat(b.price));
  return { results, total: results.length, mock: true, mode: 'forsale', serial: null, similarResults: [], searchType: 'exact', broadenedQuery: null, approximateValue: null };
}
