require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const crypto = require('crypto');
const { connectDB, loadData, saveData, loadUserData, saveUserData } = require('./db');

// __dirname is supplied by Node's CJS module wrapper but NOT by Cloudflare
// Workers' bundled-CJS shim. Bare references would throw ReferenceError at
// module init in strict mode. typeof never throws on undeclared identifiers,
// so this is the safe way to capture it. APP_ROOT is only consumed by the
// file-backed code paths in db.js, which are no-ops on Workers anyway.
const APP_ROOT = (typeof __dirname !== 'undefined') ? __dirname : '/';

const app = express();
const PORT = process.env.PORT || 3000;
const EBAY_APP_ID = process.env.EBAY_APP_ID;
const EBAY_CERT_ID = process.env.EBAY_CERT_ID; // Client secret for eBay OAuth (Browse API)

const EBAY_VERIFICATION_TOKEN = process.env.EBAY_VERIFICATION_TOKEN;

// ---- Sold-listings provider ----
// Sold data now comes from scrape.do using each user's own API key (stored
// on their account). There is no server-wide sold provider — sold searches
// require a logged-in user with a key, and return { noKey: true } otherwise.
const SCRAPE_DO_BASE = 'https://api.scrape.do';

const USE_MOCK_FORSALE = process.env.USE_MOCK_DATA === 'true' || !EBAY_APP_ID || EBAY_APP_ID === 'your-ebay-app-id-here';
const USE_MOCK_SOLD = process.env.USE_MOCK_DATA === 'true';
const USE_MOCK = USE_MOCK_FORSALE && USE_MOCK_SOLD;

// ---- Stripe Setup ----
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_PUBLISHABLE_KEY = process.env.STRIPE_PUBLISHABLE_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const STRIPE_PRODUCT_PRO = 'prod_UKcw8SMnNESbuE';
const STRIPE_PRODUCT_SLOT = 'prod_UKczmqAaEo7wa9';
const STRIPE_PRODUCT_PROPLUS = 'prod_ULtSajiX8Hszzy';

// TEMPORARY KILL SWITCH — all paid checkout is paused while we finalize tax
// setup. While false, every checkout/buy endpoint returns 503 and the
// frontend hides the Go Pro CTA. Flip back to true (or set env
// CHECKOUT_ENABLED=true) to re-open sales. Cancellation via the billing
// portal stays available so existing subscribers aren't trapped.
const CHECKOUT_ENABLED = process.env.CHECKOUT_ENABLED === 'true' ? true : false;
const CHECKOUT_PAUSED_MSG = 'Subscriptions are temporarily paused while we finalize tax setup. Please check back soon.';

const stripeEnabled = STRIPE_SECRET_KEY && !STRIPE_SECRET_KEY.includes('REPLACE');
let stripe = null;
if (stripeEnabled) {
  const Stripe = require('stripe');
  // Cloudflare Workers can't use the default node:http transport. When running
  // on a Worker, swap to Stripe's fetch-based client so checkout requests
  // actually leave the worker. CF_WORKER is set by worker.js on cold start.
  const stripeOpts = process.env.CF_WORKER
    ? { httpClient: Stripe.createFetchHttpClient() }
    : {};
  stripe = Stripe(STRIPE_SECRET_KEY, stripeOpts);
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
        // Pro or Pro+ subscription started
        if (!subs[username]) subs[username] = {};
        subs[username].plan = session.metadata?.plan || 'pro';
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
      for (const [user, data] of Object.entries(subs)) {
        if (data.stripeCustomerId === sub.customer && !data.permanent) {
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
        if (data.stripeCustomerId === sub.customer && !data.permanent) {
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

// Cloudflare's edge handles compression automatically; only use locally.
// Dynamic require keeps the package out of the Workers bundle (it pulls in
// Node streams which the Workers polyfill doesn't fully implement).
if (!process.env.CF_WORKER) {
  try {
    const _compMod = 'compression';
    const compression = require(_compMod);
    app.use(compression());
  } catch (_) { /* compression not bundled — that's fine */ }
}
app.use(express.json());
// Disable caching for JS/CSS so deploys take effect immediately, and for
// every /api/* response so a stale answer (e.g. `enabled:false` cached
// from before secrets were set) can never linger in a browser.
app.use((req, res, next) => {
  if (/\.(js|css)(\?.*)?$/.test(req.path) || req.path.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  }
  next();
});
// In Cloudflare Workers, static files are served via the ASSETS binding
if (!process.env.CF_WORKER) {
  app.use(express.static(path.join(APP_ROOT, 'public')));
}

// ---- Async route safety net ----
// Express 4 does not catch rejections from async route handlers. On a
// Cloudflare Worker an unhandled rejection bypasses our error middleware
// and surfaces as Cloudflare's HTML 500 page, which the frontend can't
// parse ("Server returned non-JSON (HTTP 500): <!DOCTYPE html>...").
// Patch Layer.handle_request to forward async rejections to next(err)
// so they hit our JSON error responder below.
try {
  const Layer = require('express/lib/router/layer');
  const original = Layer.prototype.handle_request;
  Layer.prototype.handle_request = function patchedHandleRequest(req, res, next) {
    const fn = this.handle;
    if (!fn || fn.length > 3) return original.call(this, req, res, next);
    try {
      const ret = fn.call(this, req, res, next);
      if (ret && typeof ret.catch === 'function') ret.catch(next);
    } catch (err) {
      next(err);
    }
  };
} catch (patchErr) {
  console.warn('[express] async-rejection patch skipped:', patchErr && patchErr.message);
}

// ---- Diagnostic: which integrations are configured ----
// Reports presence (not values) of secrets so you can spot what's missing.
// Returns booleans only (no secret values), but we still gate it behind a
// shared secret so the diagnostic surface isn't public on a marketing site.
// Set HEALTH_KEY in Cloudflare and hit /api/health?key=<value>.
// Cheap, always-on, no-auth ping. If this returns JSON, the worker is
// up. If it returns HTML, Cloudflare is serving its own error page —
// meaning the worker isn't deployed (or failed to init) and every
// other /api/* route is doomed too. Hit /api/ping directly in the
// browser to confirm a deploy worked.
app.get('/api/ping', (req, res) => {
  res.json({
    ok: true,
    runtime: process.env.CF_WORKER ? 'cloudflare-worker' : 'node',
    kvBound: globalThis.__KV_BOUND === true,
    stripeEnabled: !!stripeEnabled,
    // Version markers — if these don't match what we shipped in the
    // latest commit, the deploy didn't land. pbkdf2Iterations should be
    // 25000 after PR #214; build is bumped on every diagnostic change.
    pbkdf2Iterations: PBKDF2_ITERATIONS,
    build: 'ping-v11',
    waitUntilBound: typeof globalThis.__kvWaitUntil === 'function',
    socialAuth: {
      google: !!process.env.GOOGLE_CLIENT_ID,
      apple: !!process.env.APPLE_CLIENT_ID,
    },
    now: new Date().toISOString(),
  });
});

// POST mirror of /api/ping — same JSON pipeline as auth, but with no
// route logic. If this returns JSON, body-parser is fine and the bug is
// inside the auth route. If it returns Cloudflare's HTML page, body
// parsing or the JSON middleware itself is the culprit.
app.post('/api/ping', (req, res) => {
  res.json({
    ok: true,
    method: 'POST',
    hasBody: !!req.body,
    bodyKeys: req.body ? Object.keys(req.body) : [],
    contentType: req.get('content-type') || null,
    now: new Date().toISOString(),
  });
});

// Step-by-step isolation of /api/auth/register. Each ?step= runs one
// more piece of the registration flow and reports which step passed.
// If step=N returns ok but step=N+1 returns HTML, the bug is in step N+1.
// All routes are GET so they can be tested from a browser address bar.
app.get('/api/auth/diag', async (req, res) => {
  const step = parseInt(req.query.step, 10) || 0;
  const trace = [];
  const log = (label, value) => { trace.push({ step: trace.length + 1, label, value }); };
  try {
    log('start', { step, now: new Date().toISOString() });

    if (step >= 1) {
      log('crypto.randomBytes', typeof crypto.randomBytes);
    }
    if (step >= 2) {
      const t = generateToken();
      log('generateToken', { length: t.length, prefix: t.slice(0, 8) });
    }
    if (step >= 3) {
      log('webCrypto.subtle', !!(globalThis.crypto && globalThis.crypto.subtle));
    }
    if (step >= 4) {
      const start = Date.now();
      const hash = await hashPassword('diagtestpass');
      log('hashPassword', { ms: Date.now() - start, prefix: hash.slice(0, 16) });
    }
    if (step >= 5) {
      const users = loadServerUsers();
      log('loadServerUsers', { count: Object.keys(users).length });
    }
    if (step >= 6) {
      // Test write — uses a sentinel key so we don't pollute real users.
      const users = loadServerUsers();
      const k = '__diag_' + Date.now();
      users[k] = { test: true };
      saveServerUsers(users);
      delete users[k];
      saveServerUsers(users);
      log('saveServerUsers', 'ok');
    }
    if (step >= 7) {
      const sessions = loadSessions();
      log('loadSessions', { count: Object.keys(sessions).length });
    }
    if (step >= 8) {
      const sessions = loadSessions();
      const k = '__diag_' + Date.now();
      sessions[k] = { test: true };
      saveSessions(sessions);
      delete sessions[k];
      saveSessions(sessions);
      log('saveSessions', 'ok');
    }

    res.json({ ok: true, step, trace });
  } catch (err) {
    res.status(500).json({
      ok: false,
      step,
      trace,
      failedAt: trace.length + 1,
      error: String(err && err.message || err),
      stack: String(err && err.stack || '').split('\n').slice(0, 5),
    });
  }
});

// POST mirror of /api/auth/diag that runs the FULL register pipeline
// (body-parser -> CORS -> auth route) with a throwaway username so we
// can pinpoint the failure on a POST request specifically. Body should
// be {"username":"...","password":"..."}; no email needed.
app.post('/api/auth/diag', async (req, res) => {
  const trace = [];
  const log = (label, value) => { trace.push({ step: trace.length + 1, label, value }); };
  try {
    log('body-received', { hasBody: !!req.body, keys: req.body ? Object.keys(req.body) : [] });
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ ok: false, trace, error: 'username and password required in JSON body' });
    }
    log('extract', { usernameLen: username.length, passwordLen: password.length });
    const key = String(username).toLowerCase() + '_diag_' + Date.now();
    log('lowercase', { key });
    const users = loadServerUsers();
    log('loadServerUsers', { existing: !!users[key] });
    const hashStart = Date.now();
    const passwordHash = await hashPassword(password);
    log('hashPassword', { ms: Date.now() - hashStart, prefix: passwordHash.slice(0, 14) });
    users[key] = { username, email: '', passwordHash, createdAt: new Date().toISOString() };
    log('assign-user', 'ok');
    saveServerUsers(users);
    log('saveServerUsers', 'ok');
    const token = generateToken();
    log('generateToken', { length: token.length });
    const sessions = loadSessions();
    log('loadSessions', 'ok');
    sessions[token] = { username: key, expiresAt: Date.now() + SESSION_TTL };
    log('assign-session', 'ok');
    saveSessions(sessions);
    log('saveSessions', 'ok');
    // Clean up so we don't pollute real KV with diag users
    delete users[key];
    saveServerUsers(users);
    delete sessions[token];
    saveSessions(sessions);
    log('cleanup', 'ok');
    res.json({ ok: true, trace });
  } catch (err) {
    res.status(500).json({
      ok: false,
      trace,
      failedAt: trace.length + 1,
      error: String(err && err.message || err),
      stack: String(err && err.stack || '').split('\n').slice(0, 6),
    });
  }
});

app.get('/api/health', (req, res) => {
  const expected = process.env.HEALTH_KEY;
  if (expected && req.query.key !== expected) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.json({
    runtime: process.env.CF_WORKER ? 'cloudflare-worker' : 'node',
    integrations: {
      ebayBrowse: {
        configured: !!EBAY_APP_ID && !!process.env.EBAY_CERT_ID,
        hasAppId: !!EBAY_APP_ID,
        hasCertId: !!process.env.EBAY_CERT_ID,
      },
      ebaySold: {
        // Per-user keys now — server doesn't hold a sold-data secret.
        configured: true,
        provider: 'scrape.do (per-user key)',
      },
      stripe: {
        configured: !!stripeEnabled,
        hasSecretKey: !!STRIPE_SECRET_KEY,
        hasPublishableKey: !!STRIPE_PUBLISHABLE_KEY,
        hasWebhookSecret: !!STRIPE_WEBHOOK_SECRET && !STRIPE_WEBHOOK_SECRET.includes('REPLACE'),
      },
      mongo: { configured: !!process.env.MONGODB_URI },
      kv: { configured: globalThis.__KV_BOUND === true },
      email: {
        configured: !!process.env.RESEND_API_KEY || (!!process.env.SMTP_HOST && !!process.env.SMTP_USER),
        provider: process.env.RESEND_API_KEY ? 'resend' : (process.env.SMTP_HOST ? 'smtp' : null),
      },
    },
    forceMock: {
      forSale: USE_MOCK_FORSALE,
      sold: USE_MOCK_SOLD,
    },
  });
});



// ---- API Call Tracker ----
const API_CALLS_FILE = path.join(APP_ROOT, 'data', 'api-call-log.json');

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

// ---- In-memory cache to reduce eBay API calls ----
const ebayCache = new Map();
const CACHE_TTL = 30 * 60 * 1000;      // 30 min for active listings
const SOLD_CACHE_TTL = 30 * 60 * 1000; // 30 min for sold data

function getCached(key) {
  const entry = ebayCache.get(key);
  if (!entry) return null;
  const ttl = key.startsWith('sold|') ? SOLD_CACHE_TTL : CACHE_TTL;
  if (Date.now() - entry.ts > ttl) {
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

// ---- OAuth token management for eBay Browse API ----
let oauthToken = null;
let oauthExpiry = 0;

async function getOAuthToken() {
  if (oauthToken && Date.now() < oauthExpiry) return oauthToken;
  if (!EBAY_APP_ID || !EBAY_CERT_ID) {
    throw new Error('EBAY_APP_ID and EBAY_CERT_ID required for eBay OAuth');
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

// ---- Browse API (active listings) ----
async function fetchViaBrowseAPI(keywords, limit, source = 'unknown', offset = 0) {
  trackApiCall('browse', 'browse/search', keywords, source);
  console.log(`[Browse API] Searching for: "${keywords}", limit: ${limit}, offset: ${offset}`);
  const token = await getOAuthToken();
  console.log('[Browse API] Got OAuth token, making search request...');
  const res = await axios.get(
    'https://api.ebay.com/buy/browse/v1/item_summary/search',
    {
      params: {
        q: keywords,
        category_ids: '261328',
        limit,
        offset,
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
    buyingOptions: Array.isArray(item.buyingOptions) ? item.buyingOptions : [],
  }));

  return { results, total: res.data?.total || results.length };
}


// ---- scrape.do (sold listings, per-user API keys) ----
// Targets eBay's hosted sold-search HTML and parses the listings out of
// the response. Each user supplies one or more scrape.do tokens (so they
// can combine the monthly quotas of multiple scrape.do accounts). We
// round-robin across the user's keys and fall back to the next key when
// scrape.do reports a quota or rate-limit failure.
async function fetchViaScrapeDo(keywords, apiKey, limit = 20, source = 'unknown', opts = {}) {
  trackApiCall('scrapedo', 'ebay-sold', keywords, source);
  // eBay's sold-listings URL. The _from=R40 token + Showsold=1 mirror what
  // a normal browser sends and seem to be needed for scrape.do's data-
  // center proxies to actually land on the sold page (without them, eBay
  // bounces us to the active-listings page silently).
  const ebayUrl = `https://www.ebay.com/sch/i.html?_from=R40&_nkw=${encodeURIComponent(keywords)}&_sacat=0&LH_Sold=1&LH_Complete=1&_ipg=120&_sop=13`;
  // scrape.do params:
  //   render=true        run JS so eBay's React shell hydrates and the
  //                      listings markup actually exists in the response
  //   super=true         residential proxies — eBay blocks datacenter IPs
  //                      with a "Pardon Our Interruption" page
  //   geoCode=us         stay on US eBay; otherwise eBay redirects to
  //                      the visitor's local site (.co.uk etc.)
  const params = new URLSearchParams({
    token: apiKey,
    url: ebayUrl,
    render: 'true',
    super: 'true',
    geoCode: 'us',
  });
  const scrapeUrl = `${SCRAPE_DO_BASE}/?${params.toString()}`;
  console.log(`[scrape.do] Searching sold: "${keywords}"`);
  try {
    const res = await axios.get(scrapeUrl, { timeout: 60000, responseType: 'text', transformResponse: [x => x] });
    const html = typeof res.data === 'string' ? res.data : String(res.data || '');
    const items = parseEbaySoldHtml(html);
    console.log(`[scrape.do] parsed ${items.length} items (response was ${html.length} bytes)`);
    const out = { results: items.slice(0, limit), total: items.length };
    if (opts.includeDebug) {
      const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
      const canonicalMatch = html.match(/<link[^>]+rel=["']?canonical["']?[^>]+href=["']([^"']+)["']/i);
      // Grab the first matched container block (whichever layout
      // matches) so the frontend can show us the actual markup
      // structure when our extractor returns nothing.
      let firstBlock = null;
      const sample = splitBlocks(html, CARD_CONTAINER_RE());
      if (sample.length > 0) firstBlock = sample[0].slice(0, 8000);
      out._debug = {
        httpStatus: res.status,
        contentType: (res.headers && (res.headers['content-type'] || res.headers['Content-Type'])) || null,
        bytes: html.length,
        title: titleMatch ? decodeHtmlEntities(titleMatch[1]).trim() : null,
        canonical: canonicalMatch ? canonicalMatch[1] : null,
        looksLikeSoldPage: /Sold\s+items|LH_Sold=1/i.test(html) && /sold/i.test(titleMatch ? titleMatch[1] : ''),
        classCounts: {
          sItem: (html.match(/class="[^"]*\bs-item\b[^"]*"/g) || []).length,
          sCard: (html.match(/class="[^"]*\bs-card\b[^"]*"/g) || []).length,
          srpItem: (html.match(/class="[^"]*\bsrp-results__item\b[^"]*"/g) || []).length,
          srpRiver: (html.match(/class="[^"]*\bsrp-river\b[^"]*"/g) || []).length,
        },
        looksLikeJson: /^\s*[{[]/.test(html),
        looksLikeBlock: /Pardon Our Interruption|Are you a robot|Access to this page has been denied|Just a moment/i.test(html),
        snippet: html.slice(0, 4000),
        firstBlock,
        firstCardExtract: debugFirstCard(firstBlock),
        targetUrl: ebayUrl,
      };
    }
    return out;
  } catch (err) {
    const status = err.response && err.response.status;
    console.error(`[scrape.do] Error${status ? ` HTTP ${status}` : ''}: ${err.message}`);
    const errBody = err.response && err.response.data ? String(err.response.data).slice(0, 600) : null;
    // 401/403 = bad token. 402/429 = quota or rate-limit on this key.
    // Surface both distinctly so the rotation layer can fall back instead
    // of giving up.
    if (status === 401 || status === 403) {
      return { results: [], total: 0, error: 'scrape.do rejected your API key (HTTP ' + status + '). Update it in Settings.', badKey: true, status, _debug: opts.includeDebug ? { httpStatus: status, errBody } : undefined };
    }
    if (status === 402 || status === 429) {
      return { results: [], total: 0, error: 'scrape.do quota/rate-limit hit (HTTP ' + status + ') for this key.', quotaExceeded: true, status, _debug: opts.includeDebug ? { httpStatus: status, errBody } : undefined };
    }
    return { results: [], total: 0, error: err.message, status, _debug: opts.includeDebug ? { httpStatus: status || null, errBody, exception: err.message } : undefined };
  }
}

// In-memory round-robin index per (username|anon). Resets on cold start;
// that's fine — the rotation just picks up from the top.
const _scrapeDoRotation = new Map();

// Drive a sold search through up to N user keys: pick a starting key via
// per-user round-robin, then walk in order. Any key that returns badKey
// (bogus token) or quotaExceeded (HTTP 402/429) is skipped to the next
// one. Bubbles up the last error if every key fails.
async function fetchViaScrapeDoRotated(keywords, keys, limit, source, rotationKey) {
  if (!keys || keys.length === 0) {
    return { results: [], total: 0, error: 'no scrape.do keys configured', noProvider: true, noKey: true };
  }
  const start = ((_scrapeDoRotation.get(rotationKey) || 0)) % keys.length;
  _scrapeDoRotation.set(rotationKey, start + 1);
  let lastErr = null;
  const badKeyLabels = [];
  for (let i = 0; i < keys.length; i++) {
    const idx = (start + i) % keys.length;
    const k = keys[idx];
    const r = await fetchViaScrapeDo(keywords, k.key, limit, source);
    if (!r.badKey && !r.quotaExceeded) return r;
    lastErr = r;
    if (r.badKey) badKeyLabels.push(k.label || `Key ${idx + 1}`);
    console.log(`[scrape.do rotation] key "${k.label || idx + 1}" failed (${r.badKey ? 'bad key' : 'quota'}), trying next`);
  }
  // All keys exhausted. If every failure was a bad key, surface that;
  // otherwise surface the quota-exhaustion message.
  if (lastErr && lastErr.badKey && badKeyLabels.length === keys.length) {
    return { results: [], total: 0, error: 'All your scrape.do keys were rejected. Check them in Settings.', badKey: true };
  }
  return lastErr || { results: [], total: 0, error: 'All scrape.do keys failed for this request.' };
}

// Normalize whatever the legacy users record holds into a clean array of
// `{ key, label }`. Supports both the old single-string `scrapeDoKey`
// field and the new `scrapeDoKeys` array — so the migration is implicit
// and a user record only needs to be rewritten when the user changes
// their keys.
function getUserScrapeDoKeys(userRec) {
  if (!userRec) return [];
  if (Array.isArray(userRec.scrapeDoKeys) && userRec.scrapeDoKeys.length > 0) {
    return userRec.scrapeDoKeys
      .filter(k => k && typeof k.key === 'string' && k.key.length > 0)
      .map((k, i) => ({ key: k.key, label: k.label || `Key ${i + 1}`, addedAt: k.addedAt || null }));
  }
  if (typeof userRec.scrapeDoKey === 'string' && userRec.scrapeDoKey.length > 0) {
    return [{ key: userRec.scrapeDoKey, label: 'Default', addedAt: null }];
  }
  return [];
}

// Lightweight eBay-search HTML parser. eBay's been A/B-testing three
// layouts in 2024-25:
//   1. legacy `<li class="s-item s-item__pl-on-bottom">` (older Browse)
//   2. `<li class="srp-results__item">` (newer SRP)
//   3. `<div class="s-card ...">` (newest card-grid rollout)
// We try each container shape and a per-shape field extractor.
function parseEbaySoldHtml(html) {
  if (!html || html.length < 500) return [];
  const items = [];
  const seen = new Set();
  const push = (it) => {
    if (!it) return;
    const k = it.itemUrl || `${it.title}|${it.price}`;
    if (seen.has(k)) return;
    seen.add(k);
    items.push(it);
  };

  // Layout 1: legacy <li class="s-item">
  const reLegacy = /<li[^>]*class="[^"]*\bs-item\b[^"]*"[\s\S]*?<\/li>/gi;
  let m;
  while ((m = reLegacy.exec(html)) !== null) push(extractLegacySItem(m[0]));

  // Layout 2/3: newer s-card / srp-results__item — eBay no longer
  // wraps each card in a simple <li>...</li>. Slice between
  // consecutive container-opening positions instead of trying to
  // match nested </div> closers. We split ONLY on the top-level card
  // containers (s-card / srp-results__item); the inner
  // `su-card-container` wrapper appears once *inside* every card, so
  // splitting on it would fragment each card right after its opening
  // tag and strip away the title/price/link.
  for (const block of splitBlocks(html, CARD_CONTAINER_RE())) {
    push(extractCardLayout(block));
  }

  // Fallback for older A/B variants that wrap each result directly in
  // <div class="su-card-container"> with no enclosing s-card. Only try
  // this if the primary split produced nothing.
  if (items.length === 0) {
    for (const block of splitBlocks(html, /<(?:li|div)[^>]*class="[^"]*\bsu-card-container\b[^"]*"/gi)) {
      push(extractCardLayout(block));
    }
  }

  return items;
}

// Fresh RegExp per call — these carry the /g flag and a mutable lastIndex,
// so sharing one instance across splitBlocks calls would skip matches.
function CARD_CONTAINER_RE() {
  return /<(?:li|div)[^>]*class="[^"]*\b(?:s-card|srp-results__item)\b[^"]*"/gi;
}

// Slice `html` into blocks where each block runs from the start of a
// container match to the start of the next match (or end of document).
// Robust against arbitrary nesting depth inside each card — we don't
// have to guess where the closing tag is.
function splitBlocks(html, openerRe) {
  const starts = [];
  let m;
  openerRe.lastIndex = 0;
  while ((m = openerRe.exec(html)) !== null) starts.push(m.index);
  const blocks = [];
  for (let i = 0; i < starts.length; i++) {
    const s = starts[i];
    const e = i + 1 < starts.length ? starts[i + 1] : Math.min(html.length, s + 8000);
    blocks.push(html.slice(s, e));
  }
  return blocks;
}

// Strip tags from a captured HTML fragment and return clean text. eBay's
// newer cards nest the real text one or two <span>s deep, so a naive
// `>([^<]+)` capture grabs an empty string — pull the fragment and flatten it.
function stripTags(s) {
  if (s == null) return '';
  return decodeHtmlEntities(String(s).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

// eBay mixes quoted AND unquoted HTML attributes in the same tag — e.g.
// `<a class=s-card__link ... href=https://ebay.com/itm/123?...>`. These
// helpers match attribute values regardless of quoting style, which is the
// crux of parsing the current card markup (selectors that assumed `href="…"`
// or `class="…"` silently matched nothing).

// Return the value of attribute `attr` from the first tag in `block` that has
// it. If `mustContain` is given, skip values that don't include that substring.
function getAttr(block, attr, mustContain) {
  const re = new RegExp(
    '\\b' + attr + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s"\'>]+))',
    'gi'
  );
  let m;
  while ((m = re.exec(block)) !== null) {
    const v = m[1] != null ? m[1] : (m[2] != null ? m[2] : m[3]);
    if (v && (!mustContain || v.indexOf(mustContain) !== -1)) return v;
  }
  return null;
}

// Inner text of the first element whose class contains `cls`, quoting-agnostic.
// Uses a tag-name backreference so we close on the right tag.
function classInner(block, cls) {
  const c = cls.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    '<([a-zA-Z][\\w-]*)\\b[^>]*\\bclass\\s*=\\s*' +
      '(?:"[^"]*' + c + '[^"]*"|\'[^\']*' + c + '[^\']*\'|[^\\s"\'>]*' + c + '[^\\s"\'>]*)' +
      '[^>]*>([\\s\\S]*?)<\\/\\1>',
    'i'
  );
  const m = block.match(re);
  return m ? stripTags(m[2]) : '';
}

// Pick the best image URL in a card, tolerating unquoted attrs and lazy-load
// placeholders. eBay defers the real image via data-defer-load and shows a
// gray ebaystatic placeholder in src; prefer the real i.ebayimg.com asset.
function pickImage(block) {
  const urls = [];
  const re = /(?:src|data-defer-load|data-src)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s"'>]+))/gi;
  let m;
  while ((m = re.exec(block)) !== null) {
    const v = m[1] || m[2] || m[3];
    if (v && /^https?:/i.test(v)) urls.push(v);
  }
  return urls.find(u => /i\.ebayimg\.com/i.test(u)) ||
         urls.find(u => !/ebaystatic\.com/i.test(u)) ||
         urls[0] || null;
}

function extractLegacySItem(block) {
  if (/s-item--placeholder/i.test(block)) return null;
  return assembleListing(resolveCard(block));
}

// Field extractor for eBay's card layouts (s-card / srp-results__item) and the
// older s-item layout. Class names and quoting keep shifting, so we lean on
// structural signals — any /itm/ link, the title element's text, any element
// whose class mentions "price" — all matched quote-agnostically.
function resolveCard(block) {
  // Link: any /itm/ href, quoted or bare.
  const link = getAttr(block, 'href', '/itm/');

  // Title: the card/item title element, else any heading element, else the
  // thumbnail alt text (eBay mirrors the listing title into alt).
  let title =
    classInner(block, 's-card__title') ||
    classInner(block, 's-item__title');
  if (!title) {
    const h = block.match(/<([a-zA-Z][\w-]*)\b[^>]*\brole\s*=\s*["']?heading["']?[^>]*>([\s\S]*?)<\/\1>/i);
    if (h) title = stripTags(h[2]);
  }
  if (!title) title = (getAttr(block, 'alt') || '').trim();

  // Price: a price-classed element, else the first dollar-and-cents value.
  let priceStr =
    classInner(block, 's-card__price') ||
    classInner(block, 's-item__price') ||
    classInner(block, 'price');
  if (!/\d/.test(priceStr)) {
    const dollar = block.match(/\$\s?[\d,]+\.\d{2}/);
    priceStr = dollar ? dollar[0] : '';
  }

  const img = pickImage(block);
  const dateMatch = block.match(/Sold\s+(?:on\s+)?([A-Za-z]+\.?\s+\d{1,2},?\s+\d{4})/i);
  const cond =
    classInner(block, 's-card__subtitle') ||
    classInner(block, 'SECONDARY_INFO') ||
    '';

  return {
    link: link || null,
    title,
    priceStr,
    img,
    date: dateMatch ? dateMatch[1] : null,
    cond: cond || null,
  };
}

function extractCardLayout(block) {
  // Promo "Shop on eBay" placeholder cards resolve to that title and are
  // dropped by assembleListing, so no special-casing needed here.
  return assembleListing(resolveCard(block));
}

// Compact per-field report for the FIRST matched card, surfaced in the debug
// endpoint so we can see exactly which field extraction fails (and on what
// markup) without pasting the whole multi-KB block.
function debugFirstCard(block) {
  if (!block) return null;
  const r = resolveCard(block);
  const classes = (block.match(/class="([^"]*)"/gi) || [])
    .map(c => c.replace(/^class="/i, '').replace(/"$/, ''))
    .join(' ')
    .split(/\s+/)
    .filter(Boolean);
  const uniqClasses = [...new Set(classes)].slice(0, 40);
  return {
    link: r.link ? r.link.slice(0, 120) : null,
    title: r.title ? r.title.slice(0, 120) : null,
    price: r.priceStr || null,
    hasImg: !!r.img,
    soldDate: r.date || null,
    classes: uniqClasses,
  };
}

function assembleListing({ link, title, priceStr, img, date, cond }) {
  if (!title || !priceStr || !link) return null;
  title = decodeHtmlEntities(title).trim();
  if (!title || /shop on ebay/i.test(title)) return null;
  const price = parseFloat(String(priceStr).replace(/[^0-9.]/g, '')) || 0;
  if (!price) return null;
  const itemUrl = link.split('?')[0];
  const itemIdMatch = itemUrl.match(/\/itm\/(?:[^/]+\/)?(\d{8,})/);
  let soldDate = '';
  if (date) {
    const raw = String(date).trim();
    const parsed = new Date(raw);
    soldDate = isNaN(parsed.getTime()) ? raw : parsed.toISOString();
  }
  return {
    itemId: itemIdMatch ? itemIdMatch[1] : `sdo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title,
    price: String(price),
    currency: 'USD',
    soldDate,
    imageUrl: img || null,
    itemUrl,
    condition: cond ? decodeHtmlEntities(cond).trim() : 'Unknown',
  };
}

function decodeHtmlEntities(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

// Look up the current request's user and pull every scrape.do key off
// their record. Returns `{ username, keys: Array<{key,label}> }` so the
// rotation layer below can scope its round-robin per user.
function getScrapeDoKeysForRequest(req) {
  const username = getSessionUser(req);
  if (!username) return { username: null, keys: [] };
  const users = loadServerUsers();
  return { username, keys: getUserScrapeDoKeys(users[username]) };
}

// ---- Shared fetch function ----
// mode: 'forsale' (eBay Browse API) or 'sold' (scrape.do, per-user key)
// Cache disabled for both modes per user request — every search hits the
// upstream APIs fresh so users always see current listings/prices. The
// in-memory ebayCache + getCached/setCache helpers stay in the file for
// the unrelated marketplace endpoint to use.
async function fetchEbayItems(keywords, limit = 20, mode = 'forsale', source = 'search', offset = 0, scrapeDoCtx = null) {
  if (mode === 'sold') {
    // Backward compat: accept either the new {keys,username} context or a
    // raw single key string (legacy callers like the alert worker).
    let keys = [], rotationKey = 'anon';
    if (scrapeDoCtx && Array.isArray(scrapeDoCtx.keys)) {
      keys = scrapeDoCtx.keys;
      rotationKey = scrapeDoCtx.username || 'anon';
    } else if (typeof scrapeDoCtx === 'string' && scrapeDoCtx.length > 0) {
      keys = [{ key: scrapeDoCtx, label: 'legacy' }];
    }
    if (keys.length === 0) {
      return { results: [], total: 0, noProvider: true, noKey: true };
    }
    const response = await fetchViaScrapeDoRotated(keywords, keys, limit, source, rotationKey);
    const filtered = { ...response, results: filterJunkListings(response.results) };
    filtered.total = filtered.results.length;
    return filtered;
  }

  // For sale mode — eBay Browse API. Apply the same junk filter the sold path
  // uses (reprints, customs, proxies, lots, bundles, fakes) so For Sale
  // listings come back as clean as Sold listings already are.
  const response = await withRetry(() => fetchViaBrowseAPI(keywords, limit, source, offset));
  return { ...response, results: filterJunkListings(response.results || []) };
}

// Extract print run serial like /4, /25, /99 from a query
function extractSerial(text) {
  const match = text.match(/\/(\d{1,4})(?![0-9])/);
  return match ? match[1] : '';
}

app.get('/api/search', async (req, res) => {
  const query = req.query.q;
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  const offset = Math.max(0, Math.min(parseInt(req.query.offset) || 0, 500));
  const mode = req.query.mode === 'sold' ? 'sold' : 'forsale';
  // Price range filter — only applied in forsale mode (the UI only shows it
  // there). Bounds are inclusive; anything outside the range is dropped.
  const minPrice = parseFloat(req.query.minPrice);
  const maxPrice = parseFloat(req.query.maxPrice);
  const applyPriceFilter = (items) => mode === 'forsale'
    ? filterByPriceRange(items, minPrice, maxPrice)
    : items;
  // For Sale mode applies the same strict variant filter as Sold, but without
  // the silent fallback — users want listings that actually match their query,
  // not "similar" junk. Sold-mode keeps the fallback so the chart isn't blank.
  const applyVariantFilter = (items) => mode === 'forsale'
    ? filterByVariant(items, query, { strict: true })
    : items;

  if (!query || query.trim().length < 2) {
    return res.status(400).json({ error: 'Query parameter "q" is required (min 2 chars)' });
  }

  // Sold mode needs the requesting user's scrape.do API key. Bail with a
  // distinctive error code the frontend can recognize so it can prompt the
  // user to add the key in Settings instead of showing a generic failure.
  const scrapeDoCtx = (mode === 'sold') ? getScrapeDoKeysForRequest(req) : { username: null, keys: [] };
  if (mode === 'sold' && scrapeDoCtx.keys.length === 0) {
    return res.status(401).json({
      error: 'Sold searches need your scrape.do API key. Add one in Settings → scrape.do API key.',
      noKey: true,
    });
  }

  if (mode === 'sold' ? USE_MOCK_SOLD : USE_MOCK_FORSALE) {
    return res.json(getMockData(query, mode));
  }

  try {
    const serial = extractSerial(query);

    // Sold mode — scrape.do (per-user key)
    if (mode === 'sold') {
      const searchData = await fetchEbayItems(query, limit, mode, 'search', 0, scrapeDoCtx);
      if (searchData.badKey) return res.status(401).json({ error: searchData.error, badKey: true });
      const variantFiltered = filterPriceOutliers(filterByVariant(searchData.results, query));
      const approx = variantFiltered.length > 0 ? computeApproxValue(variantFiltered, query) : null;
      return res.json({ results: variantFiltered, total: variantFiltered.length, mock: false, mode, serial: serial || null, similarResults: [], searchType: 'exact', broadenedQuery: null, approximateValue: approx });
    }

    if (!serial || offset > 0) {
      // No serial, OR a paginated request — standard search.
      // Paginated requests skip the serial-aware exact/similar split since
      // that path doesn't support offset. The client still filters by print
      // run, so subsequent pages stay relevant.
      const searchData = await fetchEbayItems(query, limit, mode, 'search', offset);
      if (searchData.rateLimited) {
        return res.json({ results: [], total: 0, mock: false, mode, serial: null, similarResults: [], searchType: 'exact', broadenedQuery: null, approximateValue: null, rateLimited: true, rateLimitMessage: 'eBay sold search is temporarily unavailable. Please try again later.' });
      }
      if (searchData.results.length > 0) {
        // Variant + price-range filter only. We deliberately DON'T trim price
        // outliers here the way Sold does: For Sale is a list of asking prices
        // that legitimately mixes raw and graded copies, so a pricier graded
        // listing is a real result, not noise. The junk filter (applied in
        // fetchEbayItems) already removes reprints/lots/customs.
        const filtered = applyVariantFilter(applyPriceFilter(searchData.results));
        return res.json({ results: filtered, total: filtered.length, mock: false, mode, serial: null, similarResults: [], searchType: 'exact', broadenedQuery: null, approximateValue: null, offset, hasMore: searchData.results.length >= limit });
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
          // Broadened queries are intentionally looser — skip strict variant
          // filter and just keep the price range applied.
          const filtered = applyPriceFilter(broadened.results);
          const approx = computeApproxValue(filtered, level.label);
          return res.json({ results: filtered, total: filtered.length, mock: false, mode, serial: null, similarResults: [], searchType: 'broadened', broadenedQuery: level.query, approximateValue: approx });
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

    // Forsale results get the same strict variant filter as the non-serial
    // path (no outlier trimming — see note above; asking prices vary widely).
    const exactOut = mode === 'forsale' ? applyVariantFilter(exact) : exact;
    const similarOut = mode === 'forsale' ? applyVariantFilter(similar) : similar;

    res.json({
      results: exactOut,
      total: exactOut.length,
      mock: false,
      mode,
      serial,
      similarResults: similarOut.slice(0, 20),
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

const JUNK_KEYWORDS = ['reprint', 'custom', 'proxy', 'read desc', 'read description', 'lot of', ' lot ', 'bundle', 'fake', 'reproduction'];

// Filter results to a [min, max] price range. Both bounds are optional;
// pass NaN/undefined to skip either side. Items with no parseable price
// are dropped when either bound is provided so they don't sneak through.
function filterByPriceRange(results, minPrice, maxPrice) {
  const hasMin = Number.isFinite(minPrice) && minPrice > 0;
  const hasMax = Number.isFinite(maxPrice) && maxPrice > 0;
  if (!hasMin && !hasMax) return results;
  return results.filter(r => {
    const p = parseFloat(r.price);
    if (!Number.isFinite(p) || p <= 0) return false;
    if (hasMin && p < minPrice) return false;
    if (hasMax && p > maxPrice) return false;
    return true;
  });
}

function filterJunkListings(results) {
  return results.filter(r => {
    const title = (r.title || '').toLowerCase();
    return !JUNK_KEYWORDS.some(kw => title.includes(kw));
  });
}

// Known parallel colors — used for color exclusivity in variant filtering
const PARALLEL_COLORS = [
  'silver', 'gold', 'orange', 'red', 'blue', 'green', 'pink',
  'purple', 'teal', 'black', 'white', 'aqua', 'yellow', 'bronze',
  'copper', 'ruby', 'emerald', 'sapphire'
];

// Known parallel/color keywords — used to enforce strict variant matching
const PARALLEL_KEYWORDS = [
  ...PARALLEL_COLORS,
  'hyper', 'mojo', 'cosmic', 'disco', 'lava', 'ice', 'shimmer',
  'neon', 'camo', 'wave', 'tiger', 'snake', 'cracked ice', 'scope',
  'galaxy', 'choice', 'power', 'fast break', 'pulsar', 'sparkle',
  'holo', 'prizmatic', 'laser', 'lazer', 'diamonds'
];

// Card set/brand names — used for set exclusivity
const CARD_SET_NAMES = [
  'optic', 'prizm', 'donruss', 'select', 'mosaic', 'chronicles',
  'prestige', 'certified', 'absolute', 'contenders', 'luminance',
  'illusions', 'spectra', 'origins', 'majestic', 'phoenix', 'hoops',
  'flawless', 'immaculate', 'score', 'national treasures'
];

// Auto/memorabilia keywords — excluded from results unless user specifically searched for them
const SPECIAL_CARD_KEYWORDS = ['autograph', 'patch', 'rpa', 'relic', 'jersey', 'memorabilia', 'logoman'];

function titleHasSpecialCard(title) {
  if (SPECIAL_CARD_KEYWORDS.some(kw => title.includes(kw))) return true;
  if (/\bauto\b/.test(title)) return true; // 'auto' as a standalone word
  return false;
}

const VARIANT_STOP_WORDS = new Set(['a', 'an', 'the', 'of', 'in', 'for', 'card', 'cards', '&', 'rc', 'sp']);

// Filters results to only those matching the searched variant.
// - Requires ALL query tokens in title
// - Auto/memorabilia exclusion: excluded unless the query asks for them
// - Set exclusivity: if query has a set name, excludes other set names from results
// - Color exclusivity: if query has a color, excludes other colors from results
// - Base search: excludes all known parallel keywords
// Pass { strict: true } to disable the "no matches -> fall back to unfiltered"
// behavior — used for For Sale results where the user wants only real matches.
function filterByVariant(results, query, opts) {
  const strict = !!(opts && opts.strict);
  const qLower = query.toLowerCase().trim();
  const isBaseSearch = qLower.includes('base');
  const searchedParallel = PARALLEL_KEYWORDS.find(p => qLower.includes(p));
  const searchedColor = PARALLEL_COLORS.find(c => qLower.includes(c));
  const queriedSets = CARD_SET_NAMES.filter(s => qLower.includes(s));
  const excludedSets = queriedSets.length > 0
    ? CARD_SET_NAMES.filter(s => !queriedSets.includes(s))
    : [];
  const queryHasSpecial = titleHasSpecialCard(qLower);

  const qTokens = qLower.split(/\s+/).filter(t =>
    t.length > 1 && !VARIANT_STOP_WORDS.has(t) && !(isBaseSearch && t === 'base')
  );

  if (qTokens.length === 0) return results;

  const filtered = results.filter(r => {
    const title = (r.title || '').toLowerCase();

    // All meaningful search tokens must appear in title
    if (!qTokens.every(t => title.includes(t))) return false;

    // Auto/memorabilia exclusion: if user didn't search for them, exclude them
    if (!queryHasSpecial && titleHasSpecialCard(title)) return false;

    // Set exclusivity: if searching a specific set, exclude other sets
    if (excludedSets.some(s => title.includes(s))) return false;

    // Base search: exclude all parallel keywords
    if (isBaseSearch && !searchedParallel) {
      return !PARALLEL_KEYWORDS.some(p => title.includes(p));
    }

    // Color exclusivity: if searching a specific color, exclude other colors
    if (searchedColor) {
      if (PARALLEL_COLORS.filter(c => c !== searchedColor).some(c => title.includes(c))) return false;
    }

    return true;
  });

  if (strict) return filtered;
  // Non-strict: fall back to unfiltered when the strict pass removed everything.
  return filtered.length > 0 ? filtered : results;
}

function removeOutliers(prices) {
  if (prices.length < 4) return prices;
  const sorted = [...prices].sort((a, b) => a - b);
  const q1 = sorted[Math.floor(sorted.length * 0.25)];
  const q3 = sorted[Math.floor(sorted.length * 0.75)];
  const iqr = q3 - q1;
  const lower = q1 - 1.5 * iqr;
  const upper = q3 + 1.5 * iqr;
  return prices.filter(p => p >= lower && p <= upper);
}

// Removes listings priced more than 5x the median — catches mis-listed cards
function filterPriceOutliers(results) {
  if (results.length < 3) return results;
  const prices = results.map(r => parseFloat(r.price)).filter(p => p > 0).sort((a, b) => a - b);
  if (prices.length < 3) return results;
  const median = prices.length % 2 === 0
    ? (prices[prices.length / 2 - 1] + prices[prices.length / 2]) / 2
    : prices[Math.floor(prices.length / 2)];
  const ceiling = median * 5;
  return results.filter(r => {
    const p = parseFloat(r.price);
    return isNaN(p) || p <= ceiling;
  });
}

function computeApproxValue(results, label) {
  const rawPrices = results.map(r => parseFloat(r.price)).filter(p => !isNaN(p) && p > 0);
  if (rawPrices.length === 0) return null;

  const prices = removeOutliers(rawPrices);
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

// ---- /api/grading-advisor ----
// Returns sold price stats for raw, PSA 8, PSA 9, PSA 10 for a given card query.
app.get('/api/grading-advisor', async (req, res) => {
  const query = req.query.q;
  if (!query || query.trim().length < 2) {
    return res.status(400).json({ error: 'Query parameter "q" is required' });
  }

  const scrapeDoCtx = getScrapeDoKeysForRequest(req);
  if (scrapeDoCtx.keys.length === 0) {
    return res.status(401).json({
      error: 'Grading Advisor needs your scrape.do API key. Add one in Settings → scrape.do API key.',
      noKey: true,
    });
  }

  const GRADING_COST = { economy: 25, express: 50 };

  try {
    const baseQ = query.trim();
    const [rawData, psa8Data, psa9Data, psa10Data] = await Promise.all([
      fetchEbayItems(baseQ, 20, 'sold', 'grading-raw', 0, scrapeDoCtx),
      fetchEbayItems(`${baseQ} PSA 8`, 20, 'sold', 'grading-psa8', 0, scrapeDoCtx),
      fetchEbayItems(`${baseQ} PSA 9`, 20, 'sold', 'grading-psa9', 0, scrapeDoCtx),
      fetchEbayItems(`${baseQ} PSA 10`, 20, 'sold', 'grading-psa10', 0, scrapeDoCtx),
    ]);
    if (rawData.badKey || psa8Data.badKey || psa9Data.badKey || psa10Data.badKey) {
      return res.status(401).json({ error: 'scrape.do rejected your API key. Update it in Settings.', badKey: true });
    }

    // Apply the same variant-strict filter used elsewhere so each grade's
    // sold comps reflect the actual card searched (excludes wrong colors,
    // wrong sets, auto/relic when the user didn't ask for one).
    const filterFor = (items, q) => filterPriceOutliers(filterByVariant(items, q));
    const rawItems   = filterFor(rawData.results,   baseQ);
    const psa8Items  = filterFor(psa8Data.results,  `${baseQ} PSA 8`);
    const psa9Items  = filterFor(psa9Data.results,  `${baseQ} PSA 9`);
    const psa10Items = filterFor(psa10Data.results, `${baseQ} PSA 10`);

    const summarize = (items, label) => {
      const v = computeApproxValue(items, label);
      return v ? { avg: v.avgPrice, median: v.medianPrice, min: v.priceRange.min, max: v.priceRange.max, sales: v.sampleSize } : null;
    };

    const raw   = summarize(rawItems,   'Raw');
    const psa8  = summarize(psa8Items,  'PSA 8');
    const psa9  = summarize(psa9Items,  'PSA 9');
    const psa10 = summarize(psa10Items, 'PSA 10');

    // Calculate grade premiums over raw median
    const calcPremium = (graded, rawVal) => {
      if (!graded || !rawVal) return null;
      const net = graded.median - rawVal.median - GRADING_COST.economy;
      return { gross: graded.median - rawVal.median, net, worthIt: net > 0 };
    };

    res.json({
      query: query.trim(),
      grades: { raw, psa8, psa9, psa10 },
      premiums: {
        psa8:  calcPremium(psa8,  raw),
        psa9:  calcPremium(psa9,  raw),
        psa10: calcPremium(psa10, raw),
      },
      gradingCost: GRADING_COST,
    });
  } catch (err) {
    console.error('Grading advisor error:', err.message);
    res.status(500).json({ error: 'Failed to fetch grading data', detail: err.message });
  }
});

// ---- /api/direct-search ----
app.get('/api/direct-search', async (req, res) => {
  const query = req.query.q;
  const mode = req.query.mode === 'sold' ? 'sold' : 'forsale';
  const minPrice = parseFloat(req.query.minPrice);
  const maxPrice = parseFloat(req.query.maxPrice);
  const applyPriceFilter = (items) => mode === 'forsale'
    ? filterByPriceRange(items, minPrice, maxPrice)
    : items;
  // Mirror /api/search: For Sale results get the strict variant filter so the
  // user only sees listings that actually match the searched card.
  const applyVariantFilter = (items) => mode === 'forsale'
    ? filterByVariant(items, query, { strict: true })
    : items;
  if (!query || query.trim().length < 2) {
    return res.status(400).json({ error: 'Query parameter "q" is required (min 2 chars)' });
  }

  const scrapeDoCtx = (mode === 'sold') ? getScrapeDoKeysForRequest(req) : { username: null, keys: [] };
  if (mode === 'sold' && scrapeDoCtx.keys.length === 0) {
    return res.status(401).json({
      error: 'Sold searches need your scrape.do API key. Add one in Settings → scrape.do API key.',
      noKey: true,
    });
  }

  if (mode === 'sold' ? USE_MOCK_SOLD : USE_MOCK_FORSALE) {
    return res.json(getMockDirectSearch(query, mode));
  }

  try {
    const serial = extractSerial(query);

    // Sold mode — scrape.do (per-user key)
    if (mode === 'sold') {
      const searchData = await fetchEbayItems(query, 20, mode, 'direct-search', 0, scrapeDoCtx);
      if (searchData.badKey) return res.status(401).json({ error: searchData.error, badKey: true });
      const variantFiltered = filterPriceOutliers(filterByVariant(searchData.results, query));
      const approx = variantFiltered.length > 0 ? computeApproxValue(variantFiltered, query) : null;
      return res.json({ results: variantFiltered, total: variantFiltered.length, mock: false, searchType: 'exact', broadenedQuery: null, approximateValue: approx, mode, serial: serial || null, similarResults: [] });
    }

    if (serial) {
      // Serial search (e.g. /5 = print run of 5)
      // Dual search: targeted with serial + broad without, then filter
      const baseQuery = query.replace(/\/\d{1,4}/, '').replace(/\s+/g, ' ').trim();
      const [targetedResults, broadResults] = await Promise.all([
        fetchEbayItems(query, 50, mode, 'variants-serial'),
        fetchEbayItems(baseQuery, 50, mode, 'variants-serial-broad'),
      ]);

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

      // Return exact matches first, then similar (price + strict variant filter applied in forsale)
      const combined = applyVariantFilter(applyPriceFilter([...exactMatches, ...similarMatches]));
      if (combined.length > 0) {
        const approx = computeApproxValue(exactMatches.length > 0 ? exactMatches : combined.slice(0, 10), 'serial');
        return res.json({ results: combined.slice(0, 40), total: combined.length, mock: false, searchType: 'exact', broadenedQuery: null, approximateValue: approx, mode, serial, similarResults: applyVariantFilter(applyPriceFilter(similarMatches)).slice(0, 20) });
      }

      return res.json({ results: [], total: 0, mock: false, searchType: 'exact', broadenedQuery: null, approximateValue: null, mode, serial, similarResults: [] });
    }

    // No serial — standard search: try exact first
    const exact = await fetchEbayItems(query, 20, mode, 'variants');
    if (exact.results.length > 0) {
      const filtered = applyVariantFilter(applyPriceFilter(exact.results));
      return res.json({ results: filtered, total: filtered.length, mock: false, searchType: 'exact', broadenedQuery: null, approximateValue: null, mode });
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
        const filtered = applyPriceFilter(broadResult.results);
        const approx = computeApproxValue(filtered, level.label);
        return res.json({ results: filtered, total: filtered.length, mock: false, searchType: 'broadened', broadenedQuery: level.query, approximateValue: approx, mode });
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
  const minPrice = parseFloat(req.query.minPrice);
  const maxPrice = parseFloat(req.query.maxPrice);
  if (!query || query.trim().length < 2) {
    return res.status(400).json({ error: 'Query parameter "q" is required (min 2 chars)' });
  }

  const scrapeDoCtx = (mode === 'sold') ? getScrapeDoKeysForRequest(req) : { username: null, keys: [] };
  if (mode === 'sold' && scrapeDoCtx.keys.length === 0) {
    return res.status(401).json({
      error: 'Sold searches need your scrape.do API key. Add one in Settings → scrape.do API key.',
      noKey: true,
    });
  }

  if (mode === 'sold' ? USE_MOCK_SOLD : USE_MOCK_FORSALE) {
    return res.json(getMockVariants(query, mode));
  }

  try {
    // Extract serial number (e.g. /5 = print run of 5)
    const serial = extractSerial(query);
    const baseQuery = serial ? query.replace(/\/\d{1,4}/, '').replace(/\s+/g, ' ').trim() : query;

    let rawResults;
    let upstreamError = null;

    // Sold mode
    if (mode === 'sold') {
      const result = await fetchEbayItems(query, 50, mode, 'variants', 0, scrapeDoCtx);
      if (result.badKey) return res.status(401).json({ error: result.error, badKey: true });
      rawResults = result.results;
      if (result.error) upstreamError = result.error;
    } else if (serial) {
      // Dual search when serial present: targeted + broad for better coverage
      const [targeted, broad] = await Promise.all([
        fetchEbayItems(`${baseQuery} /${serial}`, 50, mode, 'direct-search-serial'),
        fetchEbayItems(baseQuery, 50, mode, 'direct-search-serial-broad'),
      ]);
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
      rawResults = result.results;
    }
    // Drop listings outside the user's price range before grouping into variants
    if (mode === 'forsale') {
      rawResults = filterByPriceRange(rawResults, minPrice, maxPrice);
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

    // If sold's upstream errored AND we got nothing, return 502 with detail
    // so the frontend renders a real message instead of "no results".
    if (upstreamError && variants.length === 0) {
      return res.status(502).json({
        error: 'Sold listings provider returned no data',
        detail: upstreamError,
      });
    }
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

// ---- Sold provider debug endpoint ----
// Tests the current user's scrape.do keys with a small sold-search. With
// no ?label= specified, tests every saved key in parallel and reports
// per-key status (✓ count or ✗ reason) so users can see which of their
// keys are healthy. With ?label=X, only tests that key.
app.get('/api/debug/sold', async (req, res) => {
  const q = req.query.q || 'Patrick Mahomes 2017 Prizm';
  const label = (req.query.label || '').toString();
  const ctx = getScrapeDoKeysForRequest(req);
  if (ctx.keys.length === 0) return res.status(401).json({ error: 'No scrape.do key on file for this user', noKey: true });
  const targets = label ? ctx.keys.filter(k => k.label === label) : ctx.keys;
  if (label && targets.length === 0) {
    return res.status(404).json({ error: `No key with label "${label}"` });
  }
  try {
    const perKey = await Promise.all(targets.map(async k => {
      const r = await fetchViaScrapeDo(q, k.key, 5, 'debug', { includeDebug: true });
      return {
        label: k.label,
        itemCount: r.results.length,
        firstItem: r.results[0] || null,
        error: r.error || null,
        badKey: !!r.badKey,
        quotaExceeded: !!r.quotaExceeded,
        debug: r._debug || null,
      };
    }));
    res.json({ provider: 'scrape.do', query: q, perKey });
  } catch (err) {
    res.json({ provider: 'scrape.do', error: err.message });
  }
});

// ---- Health check for Render ----
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ---- Debug endpoint: test eBay Browse API ----
app.get('/api/debug/browse-test', async (req, res) => {
  const q = req.query.q || 'mahomes prizm';
  if (USE_MOCK) return res.json({ debug: 'MOCK MODE — no real API call', query: q });

  const results = { query: q };
  try {
    const token = await getOAuthToken();
    const browseRes = await axios.get('https://api.ebay.com/buy/browse/v1/item_summary/search', {
      params: { q, category_ids: '261328', limit: 3 },
      headers: { 'Authorization': `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US' },
      timeout: 15000,
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

// ---- API connectivity test ----
app.get('/api/test-ebay', async (req, res) => {
  const results = { ebayConfigured: !!EBAY_APP_ID, useMock: USE_MOCK };
  try {
    const start = Date.now();
    const token = await getOAuthToken();
    await axios.get('https://api.ebay.com/buy/browse/v1/item_summary/search', {
      params: { q: 'test', category_ids: '261328', limit: 1 },
      headers: { 'Authorization': `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US' },
      timeout: 10000,
    });
    results.ebayBrowse = { status: 'reachable', elapsedMs: Date.now() - start };
  } catch (err) {
    results.ebayBrowse = { status: 'unreachable', error: err.message, httpStatus: err.response?.status || null };
  }
  res.json(results);
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

// ---- Checklist Data ----
// The 12MB checklists.json now lives in public/data/ so Cloudflare's ASSETS
// binding serves it. The frontend fetches it directly (cacheable, edge-served)
// and filters client-side. The server-side /api/checklists* endpoints were
// removed because they required reading the JSON at module init via fs, which
// (a) doesn't work on Workers and (b) would blow the 1MB bundle limit.

// ---- Card Alerts System (Pro Feature) ----
const ALERTS_FILE = path.join(APP_ROOT, 'data', 'alerts.json');

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

// Two email backends:
//   - RESEND_API_KEY set → Resend (HTTP API, works on Cloudflare Workers)
//   - SMTP_* set         → nodemailer (Node-only fallback, doesn't bundle on Workers)
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM = process.env.RESEND_FROM || SMTP_FROM;

let emailTransporter = null;
const useResend = !!RESEND_API_KEY;

if (!useResend && SMTP_HOST && SMTP_USER && SMTP_PASS) {
  // Dynamic require — nodemailer is Node-only; bundling it crashes the worker.
  try {
    const _nmMod = 'nodemailer';
    const nodemailer = require(_nmMod);
    emailTransporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: Number(SMTP_PORT),
      secure: Number(SMTP_PORT) === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    });
  } catch (err) {
    console.error('[Email] nodemailer unavailable:', err.message);
  }
  console.log(`Email configured (SMTP): ${SMTP_HOST}:${SMTP_PORT}`);
} else if (useResend) {
  console.log('Email configured (Resend HTTP API)');
} else {
  console.log('Email not configured (set RESEND_API_KEY for Workers, or SMTP_* for Node)');
}

// Send an email via whichever backend is configured. Returns true on success.
async function sendEmail({ to, subject, html, from }) {
  if (useResend) {
    try {
      const res = await axios.post('https://api.resend.com/emails', {
        from: from || RESEND_FROM,
        to: Array.isArray(to) ? to : [to],
        subject,
        html,
      }, {
        headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        timeout: 10000,
      });
      return !!res.data?.id;
    } catch (err) {
      const detail = err.response?.data ? JSON.stringify(err.response.data).slice(0, 200) : err.message;
      console.error('[Email] Resend send failed:', detail);
      return false;
    }
  }
  if (emailTransporter) {
    try {
      await emailTransporter.sendMail({ from: from || SMTP_FROM, to, subject, html });
      return true;
    } catch (err) {
      console.error('[Email] SMTP send failed:', err.message);
      return false;
    }
  }
  return false;
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

  const usersTable = loadServerUsers();
  for (const alert of data.alerts) {
    try {
      let searchResult;
      if (USE_MOCK) {
        searchResult = getMockData(alert.query, 'sold');
      } else {
        // Each alert is owned by a user; use that user's scrape.do keys
        // (round-robin across however many they've saved). Skip if they
        // haven't set any rather than failing the whole alerts run.
        const owner = (alert.username || '').toLowerCase();
        const keys = getUserScrapeDoKeys(owner && usersTable[owner]);
        if (keys.length === 0) {
          console.log(`[Alerts] skipping ${owner || '(no user)'} alert — no scrape.do key on file`);
          continue;
        }
        searchResult = await fetchEbayItems(alert.query, 10, 'sold', 'alerts', 0, { username: owner, keys });
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
  if (!useResend && !emailTransporter) {
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

  await sendEmail({
    to: alert.email,
    subject: `New listing: ${alert.label}`,
    html,
  });
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

// ---- Price History Storage ----
const PRICE_HISTORY_FILE = path.join(APP_ROOT, 'data', 'price-history.json');

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
const SUBS_FILE = path.join(APP_ROOT, 'data', 'subscriptions.json');

function loadSubscriptions() {
  return loadData('subscriptions', SUBS_FILE, {});
}

function saveSubscriptions(subs) {
  saveData('subscriptions', SUBS_FILE, subs);
}

// ---- Global User Accounts ----
const USERS_FILE = path.join(APP_ROOT, 'data', 'users.json');
const SESSIONS_FILE = path.join(APP_ROOT, 'data', 'sessions.json');

function loadServerUsers() { return loadData('users', USERS_FILE, {}); }
function saveServerUsers(u) { saveData('users', USERS_FILE, u); }
function loadSessions() { return loadData('sessions', SESSIONS_FILE, {}); }
function saveSessions(s) { saveData('sessions', SESSIONS_FILE, s); }

// Password hashing via Web Crypto PBKDF2 — works on both Node 16+ and
// Cloudflare Workers. The previous scrypt-based impl crashed every login on
// Workers because nodejs_compat doesn't polyfill crypto.scrypt.
//
// Important: use globalThis.crypto, not the local `const crypto = require('crypto')`.
// The Node module shadows the global; on Workers its polyfill doesn't expose
// `subtle` or `getRandomValues`, so the request crashed silently. The Web Crypto
// global exists in both Node 16+ and Workers.
// Reduced from 100000 -> 25000 so registration fits inside Cloudflare
// Workers' Free-plan 10ms CPU budget. Existing passwords stored at higher
// iteration counts still verify — verifyPassword parses the count out of
// the stored `pbkdf2:<iters>:<salt>:<hash>` prefix.
const PBKDF2_ITERATIONS = 25000;
const webCrypto = globalThis.crypto;

async function hashPassword(password) {
  const salt = webCrypto.getRandomValues(new Uint8Array(16));
  const keyBits = await deriveBits(password, salt);
  return `pbkdf2:${PBKDF2_ITERATIONS}:${bufToHex(salt)}:${bufToHex(keyBits)}`;
}

async function verifyPassword(password, stored) {
  if (!stored) return false;
  if (!stored.startsWith('pbkdf2:')) return false;
  const [, iterStr, saltHex, keyHex] = stored.split(':');
  const iterations = parseInt(iterStr, 10) || PBKDF2_ITERATIONS;
  const salt = hexToBuf(saltHex);
  const expected = hexToBuf(keyHex);
  const derived = new Uint8Array(await deriveBits(password, salt, iterations));
  if (derived.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < derived.length; i++) diff |= derived[i] ^ expected[i];
  return diff === 0;
}

async function deriveBits(password, salt, iterations = PBKDF2_ITERATIONS) {
  const enc = new TextEncoder();
  const key = await webCrypto.subtle.importKey('raw', enc.encode(password), { name: 'PBKDF2' }, false, ['deriveBits']);
  return webCrypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, 256);
}

function bufToHex(buf) {
  const arr = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

function hexToBuf(hex) {
  const arr = new Uint8Array(hex.length / 2);
  for (let i = 0; i < arr.length; i++) arr[i] = parseInt(hex.substr(i * 2, 2), 16);
  return arr;
}

function generateToken() {
  // Prefer Node's randomBytes when available; fall back to Web Crypto so
  // Cloudflare Workers (where nodejs_compat may not polyfill randomBytes
  // in every configuration) still get a token instead of a crash.
  if (crypto && typeof crypto.randomBytes === 'function') {
    return crypto.randomBytes(32).toString('hex');
  }
  const arr = webCrypto.getRandomValues(new Uint8Array(32));
  return bufToHex(arr);
}
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days

function getSessionUser(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : req.query._token;
  if (!token) return null;
  const sessions = loadSessions();
  const s = sessions[token];
  if (!s) return null;
  if (Date.now() > s.expiresAt) { delete sessions[token]; saveSessions(sessions); return null; }
  return s.username.toLowerCase();
}

// Middleware factory: previously gated routes on a Pro subscription. Pro Tools
// are open access now, so this just requires a logged-in user. The plan name
// is still accepted so callers don't have to change; flip the body back to a
// subscription check when Pro is re-gated.
function requirePlan(_minPlan) {
  return (req, res, next) => {
    const user = getSessionUser(req);
    if (!user) return res.status(401).json({ error: 'Sign in required' });
    req.user = user;
    next();
  };
}

// POST /api/auth/register
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, password, email } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    if (username.length < 3) return res.status(400).json({ error: 'Username must be at least 3 characters' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    const key = username.toLowerCase();
    const users = loadServerUsers();
    if (users[key]) return res.status(409).json({ error: 'Username already taken' });
    users[key] = { username, email: email || '', passwordHash: await hashPassword(password), createdAt: new Date().toISOString() };
    saveServerUsers(users);
    const token = generateToken();
    const sessions = loadSessions();
    sessions[token] = { username: key, expiresAt: Date.now() + SESSION_TTL };
    saveSessions(sessions);
    res.json({ token, username: key });
  } catch (err) {
    console.error('[auth/register]', err && err.stack || err);
    res.status(500).json({ error: 'Could not create account', detail: String(err && err.message || err) });
  }
});

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    const key = username.toLowerCase();
    const users = loadServerUsers();
    const user = users[key];
    if (!user) return res.status(401).json({ error: 'Invalid username or password' });
    const valid = await verifyPassword(password, user.passwordHash);
    if (!valid) return res.status(401).json({ error: 'Invalid username or password' });
    const token = generateToken();
    const sessions = loadSessions();
    sessions[token] = { username: key, expiresAt: Date.now() + SESSION_TTL };
    saveSessions(sessions);
    res.json({ token, username: key, email: user.email || '' });
  } catch (err) {
    console.error('[auth/login]', err && err.stack || err);
    res.status(500).json({ error: 'Could not sign in', detail: String(err && err.message || err) });
  }
});

// POST /api/auth/logout
app.post('/api/auth/logout', (req, res) => {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (token) { const s = loadSessions(); delete s[token]; saveSessions(s); }
  res.json({ ok: true });
});

// ---- Social Login ----
// Sign-In with Google / Apple. The frontend uses the provider's JS SDK
// to get a signed ID token (a JWT), then POSTs it here. We verify the
// JWT, find or create a user keyed off the provider + provider's user id,
// and hand back our own session token. Existing email-based accounts get
// linked automatically if the OAuth email matches.
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const APPLE_CLIENT_ID = process.env.APPLE_CLIENT_ID || '';

// Verify a Google ID token via Google's tokeninfo endpoint. Returns the
// decoded claims on success or null. Using the endpoint (vs verifying
// the JWT signature locally) keeps the worker lightweight — no need to
// pull in a JOSE library or fetch JWKs ourselves.
async function verifyGoogleIdToken(idToken) {
  if (!idToken || !GOOGLE_CLIENT_ID) return null;
  try {
    const resp = await axios.get('https://oauth2.googleapis.com/tokeninfo', {
      params: { id_token: idToken },
      timeout: 8000,
    });
    const claims = resp.data || {};
    if (claims.aud !== GOOGLE_CLIENT_ID) return null;
    if (!claims.sub) return null;
    return {
      sub: claims.sub,
      email: (claims.email || '').toLowerCase(),
      emailVerified: claims.email_verified === 'true' || claims.email_verified === true,
      name: claims.name || claims.given_name || '',
    };
  } catch (err) {
    console.error('[auth/google] verify failed:', err && err.message);
    return null;
  }
}

// Verify an Apple ID token. Apple signs JWTs with RS256 and publishes
// public keys at https://appleid.apple.com/auth/keys. We fetch the JWKS,
// pick the key matching the token's kid, and verify the signature.
async function verifyAppleIdToken(idToken) {
  if (!idToken || !APPLE_CLIENT_ID) return null;
  try {
    const parts = String(idToken).split('.');
    if (parts.length !== 3) return null;
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (payload.iss !== 'https://appleid.apple.com') return null;
    if (payload.aud !== APPLE_CLIENT_ID) return null;
    if (typeof payload.exp === 'number' && payload.exp * 1000 < Date.now()) return null;
    const jwks = (await axios.get('https://appleid.apple.com/auth/keys', { timeout: 8000 })).data;
    const jwk = (jwks.keys || []).find(k => k.kid === header.kid);
    if (!jwk) return null;
    const key = await webCrypto.subtle.importKey(
      'jwk', jwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false, ['verify']
    );
    const sig = new Uint8Array(Buffer.from(parts[2], 'base64url'));
    const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    const valid = await webCrypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sig, data);
    if (!valid) return null;
    return {
      sub: payload.sub,
      email: (payload.email || '').toLowerCase(),
      emailVerified: payload.email_verified === 'true' || payload.email_verified === true,
    };
  } catch (err) {
    console.error('[auth/apple] verify failed:', err && err.message);
    return null;
  }
}

// Build/find an account for a verified social-login identity.
// - If a user already exists with the OAuth email, link the provider id to it.
// - Otherwise create a fresh account using a username derived from email/sub.
function loginOrCreateOAuthUser(provider, identity) {
  const users = loadServerUsers();
  // Look for an existing link first
  const linkKey = `${provider}:${identity.sub}`;
  let key = Object.keys(users).find(k => users[k]?.oauth && users[k].oauth[provider] === identity.sub);
  if (!key && identity.email) {
    key = Object.keys(users).find(k => (users[k]?.email || '').toLowerCase() === identity.email);
  }
  if (!key) {
    const base = (identity.email ? identity.email.split('@')[0] : provider + identity.sub.slice(0, 8))
      .replace(/[^a-z0-9_.-]/gi, '').toLowerCase() || (provider + identity.sub.slice(0, 8));
    key = base;
    let i = 1;
    while (users[key]) { key = `${base}${i++}`; }
    users[key] = {
      username: key,
      email: identity.email || '',
      passwordHash: null,
      createdAt: new Date().toISOString(),
      oauth: {},
    };
  }
  if (!users[key].oauth) users[key].oauth = {};
  users[key].oauth[provider] = identity.sub;
  if (identity.email && !users[key].email) users[key].email = identity.email;
  saveServerUsers(users);
  return key;
}

function issueSession(username) {
  const token = generateToken();
  const sessions = loadSessions();
  sessions[token] = { username, expiresAt: Date.now() + SESSION_TTL };
  saveSessions(sessions);
  return token;
}

// POST /api/auth/google { credential: '<google-id-token>' }
app.post('/api/auth/google', async (req, res) => {
  try {
    if (!GOOGLE_CLIENT_ID) return res.status(503).json({ error: 'Google Sign-In not configured. Set GOOGLE_CLIENT_ID.' });
    const credential = req.body && req.body.credential;
    if (!credential) return res.status(400).json({ error: 'Missing credential' });
    const identity = await verifyGoogleIdToken(credential);
    if (!identity) return res.status(401).json({ error: 'Invalid Google token' });
    const username = loginOrCreateOAuthUser('google', identity);
    const token = issueSession(username);
    const users = loadServerUsers();
    res.json({ token, username, email: users[username]?.email || '' });
  } catch (err) {
    console.error('[auth/google]', err && err.stack || err);
    res.status(500).json({ error: 'Google sign-in failed', detail: String(err && err.message || err) });
  }
});

// POST /api/auth/apple { id_token: '<apple-id-token>', user: {...} }
app.post('/api/auth/apple', async (req, res) => {
  try {
    if (!APPLE_CLIENT_ID) return res.status(503).json({ error: 'Apple Sign-In not configured. Set APPLE_CLIENT_ID (your Service ID).' });
    const idToken = req.body && (req.body.id_token || req.body.idToken || req.body.credential);
    if (!idToken) return res.status(400).json({ error: 'Missing id_token' });
    const identity = await verifyAppleIdToken(idToken);
    if (!identity) return res.status(401).json({ error: 'Invalid Apple token' });
    const username = loginOrCreateOAuthUser('apple', identity);
    const token = issueSession(username);
    const users = loadServerUsers();
    res.json({ token, username, email: users[username]?.email || '' });
  } catch (err) {
    console.error('[auth/apple]', err && err.stack || err);
    res.status(500).json({ error: 'Apple sign-in failed', detail: String(err && err.message || err) });
  }
});

// GET /api/auth/providers — which social providers are configured server-side
app.get('/api/auth/providers', (req, res) => {
  res.json({
    google: { enabled: !!GOOGLE_CLIENT_ID, clientId: GOOGLE_CLIENT_ID || null },
    apple:  { enabled: !!APPLE_CLIENT_ID,  clientId: APPLE_CLIENT_ID  || null },
  });
});

// GET /api/auth/me
app.get('/api/auth/me', (req, res) => {
  const username = getSessionUser(req);
  if (!username) return res.status(401).json({ error: 'Not authenticated' });
  const users = loadServerUsers();
  const user = users[username] || {};
  const subs = loadSubscriptions();
  res.json({ username, email: user.email || '', subscription: subs[username] || null });
});

// PUT /api/auth/email
app.put('/api/auth/email', async (req, res) => {
  const username = getSessionUser(req);
  if (!username) return res.status(401).json({ error: 'Not authenticated' });
  const { email } = req.body;
  const users = loadServerUsers();
  if (users[username]) { users[username].email = email || ''; saveServerUsers(users); }
  res.json({ ok: true });
});

// ---- Per-user scrape.do API keys (multiple allowed) ----
// Stored on the user record (server-side only — never returned to the
// client in full, only `{ label, hint, addedAt }` per key). Users can
// register multiple keys to combine the monthly quotas of multiple
// scrape.do accounts; the sold-search path rotates across them and
// falls back on quota-exhausted errors.
const MAX_KEYS_PER_USER = 10;

function maskKey(key) {
  if (!key) return '';
  const last4 = key.slice(-4);
  return '••••••••' + last4;
}

// Read the user record and return both the storage form (array) and the
// safe public view (no raw keys). Migrates legacy single-string field on
// first write — never silently rewrites without an explicit user action.
function readKeysFromRecord(rec) {
  const list = getUserScrapeDoKeys(rec || {});
  return list.map((k, i) => ({
    label: k.label || `Key ${i + 1}`,
    hint: maskKey(k.key),
    addedAt: k.addedAt || null,
  }));
}

app.get('/api/user/scrape-do-key', (req, res) => {
  const username = getSessionUser(req);
  if (!username) return res.status(401).json({ error: 'Not authenticated' });
  const users = loadServerUsers();
  const keys = readKeysFromRecord(users[username]);
  res.json({ configured: keys.length > 0, count: keys.length, keys });
});

// POST adds a key (preferred). PUT also calls into this path so the
// previous single-key clients keep working — the PUT just replaces the
// whole list with a single key.
function addKeyHandler(req, res, { replace = false } = {}) {
  const username = getSessionUser(req);
  if (!username) return res.status(401).json({ error: 'Not authenticated' });
  const { apiKey, label } = req.body || {};
  if (typeof apiKey !== 'string' || apiKey.trim().length < 8) {
    return res.status(400).json({ error: 'apiKey must be at least 8 characters' });
  }
  const trimmedKey = apiKey.trim();
  if (trimmedKey.length > 200) return res.status(400).json({ error: 'apiKey too long' });
  const cleanLabel = typeof label === 'string' ? label.trim().slice(0, 60) : '';

  const users = loadServerUsers();
  if (!users[username]) return res.status(404).json({ error: 'User record missing' });

  const existing = replace ? [] : getUserScrapeDoKeys(users[username]);
  if (existing.length >= MAX_KEYS_PER_USER) {
    return res.status(409).json({ error: `Max ${MAX_KEYS_PER_USER} keys per account` });
  }
  if (existing.some(k => k.key === trimmedKey)) {
    return res.status(409).json({ error: 'You already have this key on file' });
  }
  const next = existing.concat({
    key: trimmedKey,
    label: cleanLabel || `Key ${existing.length + 1}`,
    addedAt: new Date().toISOString(),
  });

  users[username].scrapeDoKeys = next.map(k => ({ key: k.key, label: k.label, addedAt: k.addedAt }));
  // Clear the legacy field so we have a single source of truth going forward.
  delete users[username].scrapeDoKey;
  saveServerUsers(users);
  res.json({ ok: true, configured: true, count: next.length, keys: readKeysFromRecord(users[username]) });
}

app.post('/api/user/scrape-do-key', (req, res) => addKeyHandler(req, res, { replace: false }));
app.put('/api/user/scrape-do-key', (req, res) => addKeyHandler(req, res, { replace: true }));

// DELETE removes by label. Without `?label=` it clears everything
// (preserves the historical "clear my key" behavior of the old endpoint).
app.delete('/api/user/scrape-do-key', (req, res) => {
  const username = getSessionUser(req);
  if (!username) return res.status(401).json({ error: 'Not authenticated' });
  const label = (req.query.label || '').toString();
  const users = loadServerUsers();
  if (!users[username]) return res.json({ ok: true, configured: false, count: 0 });
  const existing = getUserScrapeDoKeys(users[username]);
  let next;
  if (label) {
    next = existing.filter(k => k.label !== label);
  } else {
    next = [];
  }
  users[username].scrapeDoKeys = next.map(k => ({ key: k.key, label: k.label, addedAt: k.addedAt }));
  delete users[username].scrapeDoKey;
  saveServerUsers(users);
  res.json({ ok: true, configured: next.length > 0, count: next.length, keys: readKeysFromRecord(users[username]) });
});

// Per-user data sync — single JSON blob per user containing the things that
// used to live in localStorage only (collection, watchlist, completion,
// seller listings, promoted cards). Client pulls on login and pushes
// (debounced) on every change so the account is portable across devices.
const USER_DATA_MAX_BYTES = 1024 * 1024; // 1MB — generous; rejects runaway payloads.

// GET /api/user/data
app.get('/api/user/data', async (req, res) => {
  const username = getSessionUser(req);
  if (!username) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const data = await loadUserData(username);
    res.json({ data: data || {} });
  } catch (err) {
    console.error('[user/data GET]', err && err.message);
    res.status(500).json({ error: 'Failed to load user data' });
  }
});

// PUT /api/user/data
app.put('/api/user/data', async (req, res) => {
  const username = getSessionUser(req);
  if (!username) return res.status(401).json({ error: 'Not authenticated' });
  const { data } = req.body || {};
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return res.status(400).json({ error: 'Expected { data: {...} }' });
  }
  const json = JSON.stringify(data);
  if (json.length > USER_DATA_MAX_BYTES) {
    return res.status(413).json({ error: `Payload exceeds ${USER_DATA_MAX_BYTES} bytes` });
  }
  try {
    await saveUserData(username, data);
    // Mirror this user's promoted cards into the global index so the
    // Browse Cards page and search injection can show cards from everyone.
    const promos = Array.isArray(data.cardHuddlePromotedCards) ? data.cardHuddlePromotedCards : [];
    updateGlobalPromotedIndex(username, promos);
    res.json({ ok: true });
  } catch (err) {
    console.error('[user/data PUT]', err && err.message);
    res.status(500).json({ error: 'Failed to save user data' });
  }
});

// ---- Global Promoted Cards Index ----
// Single KV-backed map { username: [card, ...] }. Read by /api/promoted-cards/all
// and updated whenever a user PUTs their data blob. Stored under the existing
// loadData/saveData pipeline so it persists on Cloudflare KV the same way
// subscriptions/users/etc. do.
const PROMOTED_INDEX_FILE = path.join(APP_ROOT, 'data', 'promoted-index.json');

function loadGlobalPromotedIndex() {
  return loadData('promotedIndex', PROMOTED_INDEX_FILE, {});
}

function updateGlobalPromotedIndex(username, cards) {
  if (!username) return;
  const key = String(username).toLowerCase();
  const index = loadGlobalPromotedIndex();
  if (!Array.isArray(cards) || cards.length === 0) {
    if (index[key]) {
      delete index[key];
      saveData('promotedIndex', PROMOTED_INDEX_FILE, index);
    }
    return;
  }
  // Strip any local-only fields so the public feed never leaks raw IDs etc.
  index[key] = cards.map(c => ({
    id: String(c.id || ''),
    title: String(c.title || ''),
    itemUrl: String(c.itemUrl || ''),
    price: parseFloat(c.price) || 0,
    imageUrl: String(c.imageUrl || ''),
    condition: String(c.condition || 'Used'),
    promotedBy: key,
    createdAt: c.createdAt || new Date().toISOString(),
  })).filter(c => c.title && c.itemUrl);
  saveData('promotedIndex', PROMOTED_INDEX_FILE, index);
}

// ---- Demo seed for Browse Cards ----
// While the global promoted feed is still small, top it up with curated
// for-sale listings pulled live from the eBay Browse API. Keeps the Browse
// Cards page populated so the empty state never greets a first-time visitor.
// Cached in KV under 'promotedDemo' with a TTL so we don't hit eBay every
// request. Real promoted cards always rank first; demo is filler.
const PROMOTED_DEMO_FILE = path.join(APP_ROOT, 'data', 'promoted-demo.json');
const PROMOTED_DEMO_TTL_MS = 12 * 60 * 60 * 1000;   // 12h
const PROMOTED_DEMO_MIN_FEED = 12;                  // top up below this size
const PROMOTED_DEMO_QUERIES = [
  'Patrick Mahomes Prizm',
  'Caleb Williams Prizm Rookie',
  'Jayden Daniels Prizm Rookie',
  'Joe Burrow Prizm',
  'Josh Allen Optic',
  'Bijan Robinson Mosaic',
  'Marvin Harrison Jr Prizm Rookie',
  'CJ Stroud Prizm Rookie',
  'Justin Jefferson Prizm',
  'Lamar Jackson Select',
  'Drake Maye Prizm Rookie',
  'Brock Bowers Prizm Rookie',
];
let _demoPromotedInFlight = null;

async function getDemoPromotedCards() {
  // KV-cached: return immediately while fresh.
  const cached = loadData('promotedDemo', PROMOTED_DEMO_FILE, null);
  const fresh = cached && cached.cachedAt && (Date.now() - cached.cachedAt) < PROMOTED_DEMO_TTL_MS;
  if (fresh && Array.isArray(cached.cards) && cached.cards.length > 0) {
    return cached.cards;
  }
  // No upstream available — return whatever we last had (possibly nothing).
  if (USE_MOCK_FORSALE || !EBAY_APP_ID) {
    return (cached && Array.isArray(cached.cards)) ? cached.cards : [];
  }
  // Coalesce concurrent first-request refreshes so we don't fire the eBay
  // Browse API a dozen times in parallel from cold start.
  if (_demoPromotedInFlight) return _demoPromotedInFlight;

  _demoPromotedInFlight = (async () => {
    const settled = await Promise.allSettled(
      PROMOTED_DEMO_QUERIES.map(q => fetchViaBrowseAPI(q, 2, 'promoted-demo'))
    );
    const out = [];
    settled.forEach((s, qi) => {
      if (s.status !== 'fulfilled') return;
      const results = (s.value && s.value.results) || [];
      for (const r of results.slice(0, 2)) {
        if (!r.title || !r.itemUrl || !r.imageUrl) continue;
        out.push({
          id: 'demo-' + (r.itemId || `${qi}-${out.length}`),
          title: r.title,
          itemUrl: r.itemUrl,
          price: parseFloat(r.price) || 0,
          imageUrl: r.imageUrl,
          condition: r.condition || 'Used',
          promotedBy: 'demo',
          isDemo: true,
          createdAt: new Date().toISOString(),
        });
      }
    });
    if (out.length > 0) {
      saveData('promotedDemo', PROMOTED_DEMO_FILE, { cachedAt: Date.now(), cards: out });
      return out;
    }
    return (cached && Array.isArray(cached.cards)) ? cached.cards : [];
  })().finally(() => { _demoPromotedInFlight = null; });

  return _demoPromotedInFlight;
}

// Public endpoint — anyone can fetch the global promoted card feed.
app.get('/api/promoted-cards/all', async (req, res) => {
  const index = loadGlobalPromotedIndex();
  const real = [];
  for (const [user, cards] of Object.entries(index)) {
    if (!Array.isArray(cards)) continue;
    for (const c of cards) real.push({ ...c, promotedBy: user });
  }
  real.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));

  let demo = [];
  if (real.length < PROMOTED_DEMO_MIN_FEED) {
    try { demo = await getDemoPromotedCards(); }
    catch (err) { console.error('[promoted-cards] demo top-up failed:', err && err.message); }
  }
  // De-dupe by itemUrl in case a real seller already listed something we pulled
  // for the demo seed — real listings always win.
  const seen = new Set(real.map(c => c.itemUrl));
  const filler = demo.filter(c => !seen.has(c.itemUrl));
  const all = real.concat(filler);
  res.json({ cards: all, total: all.length, real: real.length, demo: filler.length });
});

// ---- Stripe API Routes ----

// Build a usable origin (scheme + host) for Stripe success/cancel URLs.
// req.protocol relies on req.connection.encrypted, which the Worker shim
// doesn't set, so it returns "http" on Cloudflare. SITE_URL in wrangler.toml
// is the canonical fallback; the Host header is the runtime fallback.
function siteOrigin(req) {
  if (process.env.SITE_URL) return process.env.SITE_URL.replace(/\/+$/, '');
  const host = req.get('host');
  if (!host) return '';
  const proto = (req.get('x-forwarded-proto') || req.protocol || 'https').split(',')[0].trim();
  return `${proto || 'https'}://${host}`;
}

// Get Stripe publishable key
app.get('/api/stripe/config', (req, res) => {
  res.json({
    publishableKey: stripeEnabled ? STRIPE_PUBLISHABLE_KEY : null,
    enabled: stripeEnabled,
    // Paid checkout temporarily paused (tax setup). Frontend hides the
    // Go Pro CTA and short-circuits handleSubscribe when this is false.
    checkoutEnabled: !!CHECKOUT_ENABLED,
  });
});

// Create checkout session for Pro subscription
app.post('/api/stripe/create-checkout', async (req, res) => {
  if (!CHECKOUT_ENABLED) return res.status(503).json({ error: CHECKOUT_PAUSED_MSG });
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
          product: STRIPE_PRODUCT_PRO,
          ...priceData
        },
        quantity: 1
      }],
      // Surfaces Stripe's built-in "Add promotion code" field on Checkout so
      // codes like PRODUCTHUNTLAUNCH (created in Stripe Dashboard -> Coupons)
      // can be redeemed. Coupon definitions live entirely in Stripe so we
      // never need a code deploy to change them.
      allow_promotion_codes: true,
      metadata: { username: username.toLowerCase(), period: period || 'monthly', plan: 'pro' },
      success_url: `${siteOrigin(req)}/?payment=success&plan=pro`,
      cancel_url: `${siteOrigin(req)}/?payment=cancelled`
    });

    res.json({ url: session.url, sessionId: session.id });
  } catch (err) {
    console.error('Stripe checkout error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Create checkout session for Pro+ subscription
app.post('/api/stripe/create-checkout-proplus', async (req, res) => {
  if (!CHECKOUT_ENABLED) return res.status(503).json({ error: CHECKOUT_PAUSED_MSG });
  if (!stripeEnabled) return res.status(503).json({ error: 'Stripe is not configured.' });
  const { username, period } = req.body;
  if (!username) return res.status(400).json({ error: 'Username required' });
  try {
    const priceData = period === 'yearly'
      ? { unit_amount: 19999, recurring: { interval: 'year' } }
      : { unit_amount: 1999, recurring: { interval: 'month' } };
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price_data: { currency: 'usd', product: STRIPE_PRODUCT_PROPLUS, ...priceData }, quantity: 1 }],
      allow_promotion_codes: true,
      metadata: { username: username.toLowerCase(), period: period || 'monthly', plan: 'proplus' },
      success_url: `${siteOrigin(req)}/?payment=success&plan=proplus`,
      cancel_url: `${siteOrigin(req)}/?payment=cancelled`
    });
    res.json({ url: session.url, sessionId: session.id });
  } catch (err) {
    console.error('Stripe Pro+ checkout error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---- Flip Finder (Pro+) ----
// Finds live eBay listings priced significantly below their recent sold median.
app.get('/api/flip-finder', requirePlan('pro'), async (req, res) => {
  const query = req.query.q;
  const minDiscount = Math.max(10, Math.min(50, parseInt(req.query.minDiscount) || 30));
  const minProfit = parseFloat(req.query.minProfit) || 10;
  const limit = Math.min(parseInt(req.query.limit) || 20, 40);
  if (!query || query.trim().length < 2) return res.status(400).json({ error: 'Query required' });
  const scrapeDoCtx = getScrapeDoKeysForRequest(req);
  if (scrapeDoCtx.keys.length === 0) {
    return res.status(401).json({ error: 'Flip Finder needs your scrape.do API key. Add one in Settings → scrape.do API key.', noKey: true });
  }

  try {
    const [soldData, forsaleData] = await Promise.all([
      fetchViaScrapeDoRotated(query, scrapeDoCtx.keys, 50, 'flip-finder', scrapeDoCtx.username),
      fetchEbayItems(query, 50, 'forsale', 'flip-finder'),
    ]);
    if (soldData.badKey) return res.status(401).json({ error: soldData.error, badKey: true });

    const soldPrices = (soldData.results || []).map(i => parseFloat(i.price)).filter(p => p > 0);
    if (soldPrices.length < 3) return res.json({ results: [], message: 'Not enough sold data for this query' });

    const sorted = [...soldPrices].sort((a, b) => a - b);
    const soldMedian = sorted.length % 2 ? sorted[Math.floor(sorted.length / 2)] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
    const threshold = soldMedian * (1 - minDiscount / 100);

    const opportunities = (forsaleData.results || [])
      .map(item => {
        const price = parseFloat(item.price) || 0;
        if (!price || price >= threshold) return null;
        const profit = soldMedian - price;
        if (profit < minProfit) return null;
        return {
          title: item.title,
          listingPrice: price,
          soldMedian: Math.round(soldMedian * 100) / 100,
          potentialProfit: Math.round(profit * 100) / 100,
          discountPct: Math.round((1 - price / soldMedian) * 100),
          itemUrl: item.itemUrl || '',
          imageUrl: item.imageUrl || null,
          condition: item.condition || 'Unknown',
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.potentialProfit - a.potentialProfit)
      .slice(0, limit);

    res.json({ results: opportunities, soldMedian: Math.round(soldMedian * 100) / 100, soldSampleSize: soldPrices.length });
  } catch (err) {
    console.error('[FlipFinder]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---- Market Movers (Pro+) ----
// Identifies cards with prices trending up significantly in recent sales.
app.get('/api/market-movers', requirePlan('pro'), async (req, res) => {
  const query = req.query.q;
  const limit = Math.min(parseInt(req.query.limit) || 10, 20);
  if (!query || query.trim().length < 2) return res.status(400).json({ error: 'Query required' });
  const scrapeDoCtx = getScrapeDoKeysForRequest(req);
  if (scrapeDoCtx.keys.length === 0) {
    return res.status(401).json({ error: 'Market Movers needs your scrape.do API key. Add one in Settings → scrape.do API key.', noKey: true });
  }

  try {
    const soldData = await fetchViaScrapeDoRotated(query, scrapeDoCtx.keys, 50, 'market-movers', scrapeDoCtx.username);
    if (soldData.badKey) return res.status(401).json({ error: soldData.error, badKey: true });
    const items = (soldData.results || [])
      .map(i => ({ price: parseFloat(i.price), date: i.soldDate ? new Date(i.soldDate) : null, title: i.title, imageUrl: i.imageUrl }))
      .filter(i => i.price > 0 && i.date && !isNaN(i.date));

    if (items.length < 6) return res.json({ results: [], message: 'Not enough data' });

    items.sort((a, b) => b.date - a.date);
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const recent = items.filter(i => i.date >= cutoff).map(i => i.price);
    const older = items.filter(i => i.date < cutoff).map(i => i.price);

    if (recent.length < 2 || older.length < 2) return res.json({ results: [], message: 'Insufficient data to detect trend' });

    const avg = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
    const recentAvg = avg(recent);
    const olderAvg = avg(older);
    const changePct = ((recentAvg - olderAvg) / olderAvg) * 100;

    res.json({
      query,
      recentAvg: Math.round(recentAvg * 100) / 100,
      olderAvg: Math.round(olderAvg * 100) / 100,
      changePct: Math.round(changePct * 10) / 10,
      trending: changePct >= 10 ? 'up' : changePct <= -10 ? 'down' : 'stable',
      recentSales: recent.length,
      olderSales: older.length,
      recentItems: items.filter(i => i.date >= cutoff).slice(0, 5).map(i => ({ price: i.price, date: i.date.toISOString().slice(0, 10), title: i.title, imageUrl: i.imageUrl })),
    });
  } catch (err) {
    console.error('[MarketMovers]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---- Auto-Pricer: Comp Search (Pro+) ----
// Returns raw sold listings for the user to pick the closest match before pricing.
app.get('/api/auto-price/search', async (req, res) => {
  const query = req.query.q;
  if (!query || query.trim().length < 2) return res.status(400).json({ error: 'Query required' });
  const scrapeDoCtx = getScrapeDoKeysForRequest(req);
  if (scrapeDoCtx.keys.length === 0) {
    return res.status(401).json({ error: 'Auto-Pricer needs your scrape.do API key. Add one in Settings → scrape.do API key.', noKey: true });
  }
  try {
    let soldData = await fetchViaScrapeDoRotated(query, scrapeDoCtx.keys, 24, 'ap-search', scrapeDoCtx.username);
    if (soldData.badKey) return res.status(401).json({ error: soldData.error, badKey: true });

    // Progressively drop trailing words until we get results
    if (!soldData.results || soldData.results.length === 0) {
      const words = query.trim().split(/\s+/);
      for (let len = words.length - 1; len >= 2; len--) {
        soldData = await fetchViaScrapeDoRotated(words.slice(0, len).join(' '), scrapeDoCtx.keys, 24, 'ap-search-fallback', scrapeDoCtx.username);
        if (soldData.badKey) return res.status(401).json({ error: soldData.error, badKey: true });
        if (soldData.results && soldData.results.length > 0) break;
      }
    }

    const items = (soldData.results || [])
      .map(i => ({
        title: i.title,
        price: parseFloat(i.price),
        image: i.imageUrl || '',
        soldDate: i.soldDate,
        url: i.itemUrl || '',
      }))
      .filter(i => i.price > 0)
      .slice(0, 20);
    res.json({ items });
  } catch (err) {
    console.error('[APSearch]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---- Auto-Pricer (Pro+) ----
// Smart pricing: tries exact query first, falls back to progressively broader queries.
// Handles missing year/card# by using what's available. Returns confidence level.
app.get('/api/auto-price', async (req, res) => {
  const query = req.query.q;
  if (!query || query.trim().length < 2) return res.status(400).json({ error: 'Query required' });
  const scrapeDoCtx = getScrapeDoKeysForRequest(req);
  if (scrapeDoCtx.keys.length === 0) {
    return res.status(401).json({ error: 'Auto-Pricer needs your scrape.do API key. Add one in Settings → scrape.do API key.', noKey: true });
  }

  const med = arr => arr.length % 2 ? arr[Math.floor(arr.length / 2)] : (arr[arr.length / 2 - 1] + arr[arr.length / 2]) / 2;

  try {
    // Build a list of queries to try: exact first, then drop one word at a time from the end
    const words = query.trim().split(/\s+/);
    const attempts = [query];
    for (let len = words.length - 1; len >= 2; len--) {
      attempts.push(words.slice(0, len).join(' '));
    }

    let soldData, usedQuery = query, attemptIndex = 0;
    for (let i = 0; i < attempts.length; i++) {
      soldData = await fetchViaScrapeDoRotated(attempts[i], scrapeDoCtx.keys, 30, 'auto-price', scrapeDoCtx.username);
      if (soldData.badKey) return res.status(401).json({ error: soldData.error, badKey: true });
      const prices = (soldData.results || []).map(r => parseFloat(r.price)).filter(p => p > 0);
      if (prices.length >= 3) { usedQuery = attempts[i]; attemptIndex = i; break; }
      if (i === attempts.length - 1) { usedQuery = attempts[i]; attemptIndex = i; }
    }

    const rawPrices = (soldData.results || []).map(r => parseFloat(r.price)).filter(p => p > 0);
    const cleanPrices = removeOutliers(rawPrices);
    const finalPrices = (cleanPrices.length >= 2 ? cleanPrices : rawPrices).sort((a, b) => a - b);

    if (finalPrices.length < 2) {
      return res.json({ error: 'Not enough sold data found. Try selecting a different comp card.', soldCount: rawPrices.length });
    }

    // Confidence: high = 5+ exact sales, medium = 3-4 or minor fallback, low = significant fallback
    let confidence, fallbackNote = null;
    if (attemptIndex === 0) {
      confidence = finalPrices.length >= 5 ? 'high' : 'medium';
    } else if (attemptIndex <= 2) {
      confidence = 'medium';
      fallbackNote = `Priced using similar cards: "${usedQuery}"`;
    } else {
      confidence = 'low';
      fallbackNote = `Limited exact data — broadened to: "${usedQuery}"`;
    }

    const soldMedian = med(finalPrices);
    const soldLow = finalPrices[0];
    const soldHigh = finalPrices[finalPrices.length - 1];
    const soldAvg = finalPrices.reduce((a, b) => a + b, 0) / finalPrices.length;

    const forsaleData = await fetchEbayItems(usedQuery, 20, 'forsale', 'auto-price');
    const forsalePrices = (forsaleData.results || []).map(i => parseFloat(i.price)).filter(p => p > 0).sort((a, b) => a - b);
    const competitionLow = forsalePrices[0] || null;

    const aggressive = competitionLow ? Math.max(soldLow, competitionLow * 0.95) : soldLow * 1.05;
    const optimal = soldMedian * 0.95;
    const premium = soldMedian * 1.10;

    res.json({
      soldMedian: Math.round(soldMedian * 100) / 100,
      soldAvg: Math.round(soldAvg * 100) / 100,
      soldLow: Math.round(soldLow * 100) / 100,
      soldHigh: Math.round(soldHigh * 100) / 100,
      soldCount: finalPrices.length,
      confidence,
      fallbackNote,
      usedQuery,
      competitionLow: competitionLow ? Math.round(competitionLow * 100) / 100 : null,
      competitionCount: forsalePrices.length,
      recommendations: {
        aggressive: { price: Math.round(aggressive * 100) / 100, label: 'Fast Sale', description: 'Price to sell quickly — slightly below competition' },
        optimal:    { price: Math.round(optimal * 100) / 100,    label: 'Optimal',   description: 'Best balance of speed and return — just below sold median' },
        premium:    { price: Math.round(premium * 100) / 100,    label: 'Premium',   description: 'Max return — 10% above median for patient sellers' },
      }
    });
  } catch (err) {
    console.error('[AutoPrice]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---- Bulk Price (Pro+) ----
// Prices up to 20 cards at once, returning median sold price for each.
app.post('/api/bulk-price', async (req, res) => {
  const { queries } = req.body;
  if (!Array.isArray(queries) || queries.length === 0) return res.status(400).json({ error: 'queries array required' });
  if (queries.length > 20) return res.status(400).json({ error: 'Maximum 20 cards per bulk request' });

  const scrapeDoCtx = getScrapeDoKeysForRequest(req);
  if (scrapeDoCtx.keys.length === 0) {
    return res.status(401).json({
      error: 'Bulk Pricer needs your scrape.do API key. Add one in Settings → scrape.do API key.',
      noKey: true,
    });
  }

  const results = [];
  for (const q of queries) {
    try {
      const query = q.trim();
      const response = await fetchEbayItems(query, 25, 'sold', 'bulk-price', 0, scrapeDoCtx);
      if (response.badKey) {
        return res.status(401).json({ error: response.error, badKey: true });
      }
      // Use the same pipeline as the main Sold search so the comps actually
      // match the card: variant filter (right player/set/parallel, exclude
      // autos/relics/wrong colors) then drop mis-listed price outliers.
      const matched = filterPriceOutliers(filterByVariant(response.results, query));
      const prices = matched.map(r => parseFloat(r.price)).filter(p => p > 0);
      prices.sort((a, b) => a - b);
      const median = prices.length ? (prices.length % 2 ? prices[Math.floor(prices.length / 2)] : (prices[prices.length / 2 - 1] + prices[prices.length / 2]) / 2) : null;
      // Return the matched comps (highest first) so the UI can show them and
      // let the user exclude the random high ones.
      const comps = matched
        .map(r => ({ title: r.title || '', price: parseFloat(r.price), url: r.itemUrl || '', soldDate: r.soldDate || '', image: r.imageUrl || '' }))
        .filter(c => c.price > 0)
        .sort((a, b) => b.price - a.price);
      results.push({ query: q, median: median ? Math.round(median * 100) / 100 : null, count: prices.length, low: prices[0] || null, high: prices[prices.length - 1] || null, comps });
    } catch {
      results.push({ query: q, median: null, count: 0, error: 'Failed' });
    }
    await new Promise(r => setTimeout(r, 300));
  }
  res.json({ results });
});

// Create checkout session for extra promote slot
app.post('/api/stripe/buy-slot', async (req, res) => {
  if (!CHECKOUT_ENABLED) return res.status(503).json({ error: CHECKOUT_PAUSED_MSG });
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
          product: STRIPE_PRODUCT_SLOT,
          unit_amount: 299
        },
        quantity: 1
      }],
      metadata: { username: username.toLowerCase(), type: 'extra_slot' },
      success_url: `${siteOrigin(req)}/?payment=success&type=slot`,
      cancel_url: `${siteOrigin(req)}/?payment=cancelled`
    });

    res.json({ url: session.url, sessionId: session.id });
  } catch (err) {
    console.error('Stripe slot purchase error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get subscription status for a user. Also pulls live billing details from
// Stripe (next-bill date, amount, cancel-at-period-end) when the user has a
// real Stripe-backed subscription, so Settings can render a "Next bill" line
// without needing the Customer Portal round-trip. Falls back gracefully if
// Stripe is unreachable or the subscription is legacy/permanent.
app.get('/api/stripe/subscription', async (req, res) => {
  const username = req.query.username;
  if (!username) return res.status(400).json({ error: 'Username required' });

  const subs = loadSubscriptions();
  const userSub = subs[username.toLowerCase()] || null;

  let billing = null;
  if (userSub && userSub.stripeSubscriptionId && stripeEnabled) {
    try {
      const s = await stripe.subscriptions.retrieve(userSub.stripeSubscriptionId);
      const item = s.items && s.items.data && s.items.data[0];
      const price = item && item.price;
      billing = {
        status: s.status,
        cancelAtPeriodEnd: !!s.cancel_at_period_end,
        currentPeriodEnd: s.current_period_end ? s.current_period_end * 1000 : null,
        cancelAt: s.cancel_at ? s.cancel_at * 1000 : null,
        unitAmount: price && typeof price.unit_amount === 'number' ? price.unit_amount : null,
        currency: price && price.currency ? price.currency.toLowerCase() : 'usd',
        interval: price && price.recurring && price.recurring.interval ? price.recurring.interval : null,
      };
    } catch (err) {
      console.warn('[stripe] subscription retrieve failed:', err && err.message);
    }
  }

  res.json({ subscription: userSub, billing, stripeEnabled });
});

// Open a Stripe-hosted Billing Portal session so the user can cancel, switch
// plans, update payment method, or download invoices. Cancellation events
// flow back to us via the existing customer.subscription.deleted /
// customer.subscription.updated webhook handlers, so the KV-backed
// subscription record stays in sync automatically.
app.post('/api/stripe/create-portal-session', async (req, res) => {
  if (!stripeEnabled) return res.status(503).json({ error: 'Stripe is not configured.' });

  const { username } = req.body || {};
  if (!username) return res.status(400).json({ error: 'Username required' });

  const subs = loadSubscriptions();
  const userSub = subs[String(username).toLowerCase()];
  if (!userSub || !userSub.stripeCustomerId) {
    // Legacy/manual subscription (e.g. 'permanent: true' lifetime grants and
    // anything created before Stripe was wired in) has no Stripe customer to
    // link to — surface that distinctly so the UI can show a useful message.
    return res.status(404).json({ error: 'No Stripe customer on file for this account. Contact support to make changes.' });
  }

  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: userSub.stripeCustomerId,
      return_url: `${siteOrigin(req)}/?billing=managed`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe portal error:', err);
    res.status(500).json({ error: err.message });
  }
});


// ---- Card Scanner — eBay image search ----
// POSTs a base64 card photo to eBay's visual search endpoint and returns
// the top matching listings. Uses the existing Browse API OAuth token —
// no extra cost or API key needed.
app.post('/api/scan-card', async (req, res) => {
  const { imageData } = req.body;
  if (!imageData || typeof imageData !== 'string') {
    return res.status(400).json({ error: 'imageData required' });
  }
  const base64 = imageData.replace(/^data:image\/[\w+]+;base64,/, '');
  if (!base64 || base64.length < 100) {
    return res.status(400).json({ error: 'Invalid image data' });
  }

  if (USE_MOCK_FORSALE) {
    return res.json({
      matches: [
        { title: '2020 Panini Prizm Patrick Mahomes Silver #269', imageUrl: null, itemUrl: '#' },
        { title: '2020 Panini Prizm Patrick Mahomes Base #269', imageUrl: null, itemUrl: '#' },
        { title: '2020 Panini Prizm Patrick Mahomes Gold #269 /10', imageUrl: null, itemUrl: '#' },
      ],
    });
  }

  try {
    const token = await getOAuthToken();
    const ebayRes = await axios.post(
      'https://api.ebay.com/buy/browse/v1/item_summary/search_by_image',
      { image: base64 },
      {
        params: { category_ids: '261328', limit: 6 },
        headers: {
          'Authorization': `Bearer ${token}`,
          'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
          'Content-Type': 'application/json',
        },
        timeout: 20000,
      }
    );

    const items = ebayRes.data?.itemSummaries || [];
    const matches = items.slice(0, 6).map(item => ({
      title: item.title || '',
      imageUrl: item.thumbnailImages?.[0]?.imageUrl || item.image?.imageUrl || null,
      itemUrl: item.itemWebUrl || null,
    }));

    res.json({ matches });
  } catch (err) {
    const status = err.response?.status;
    const ebayMsg = err.response?.data?.errors?.[0]?.message;
    console.error('[scan-card]', ebayMsg || err.message);
    if (status === 401 || status === 403) return res.status(503).json({ error: 'eBay API not configured or token expired.' });
    res.status(500).json({ error: ebayMsg || 'Image search failed. Try a clearer photo.' });
  }
});

// ---- Feedback / Bug Reports ----
const FEEDBACK_FILE = path.join(APP_ROOT, 'data', 'feedback.json');

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
  const key = req.query.key || req.headers['x-admin-key'];
  const adminPass = process.env.ADMIN_PASSWORD || 'cardhuddle-admin';
  if (key !== adminPass) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const items = loadData('feedback', FEEDBACK_FILE, []);
    res.json(items.slice().reverse()); // newest first
  } catch (err) {
    res.json([]);
  }
});

// In Cloudflare Workers the ASSETS binding handles the SPA fallback
if (!process.env.CF_WORKER) {
  app.get('*', (req, res) => {
    res.sendFile(path.join(APP_ROOT, 'public', 'index.html'));
  });
}

// Global error handler — runs when any route throws or calls next(err).
// Without this, Express's default handler returns an HTML stack trace page,
// which the frontend then tries to JSON.parse and reports as
// "Unexpected token '<', '<!DOCTYPE'" — that's how the auth crash surfaced
// to the user before. For API paths we always return JSON.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(`[Express error] ${req.method} ${req.path}:`, err && err.stack || err);
  if (res.headersSent) return next(err);
  if (req.path && req.path.startsWith('/api/')) {
    return res.status(500).json({
      error: 'Server error',
      detail: String(err && err.message || err),
    });
  }
  res.status(500).type('text/plain').send('Server error');
});

// Always export at module top-level so wrangler's bundler can statically
// detect named exports when worker.js does `await import('./server.js')`.
// Putting this inside the `if (CF_WORKER)` block hid the names from esbuild
// and surfaced as "connectDB is not a function" at runtime.
module.exports = { app, connectDB };

// Node.js (local / Render): connect to DB then bind to a port as usual.
// In Cloudflare Workers, worker.js handles startup via the fetch adapter.
if (!process.env.CF_WORKER) {
  connectDB().then(() => {
    app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
      console.log(`For-sale mode: ${USE_MOCK_FORSALE ? 'MOCK' : 'LIVE (eBay Browse API)'}`);
      console.log(`Sold mode: ${USE_MOCK_SOLD ? 'MOCK' : 'LIVE (scrape.do, per-user keys)'}`);
      console.log(`EBAY_APP_ID: ${EBAY_APP_ID ? EBAY_APP_ID.slice(0, 10) + '...' : 'NOT SET'}`);
      console.log(`EBAY_CERT_ID: ${EBAY_CERT_ID ? '***set***' : 'NOT SET (Browse API will fail)'}`);
      console.log(`Stripe: ${stripeEnabled ? 'ENABLED' : 'NOT CONFIGURED — add keys to .env'}`);
    });
  });
}

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
