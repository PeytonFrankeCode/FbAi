require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const crypto = require('crypto');
const { connectDB, loadData, saveData, loadUserData, saveUserData, deleteUserData, loadUserPhoto, saveUserPhoto, deleteUserPhoto, cacheGet, cachePut, archiveGet, archivePut, getNflDb } = require('./db');
// Canonical player names from the checklists. Bundled rather than fetched: it
// is derived from public/data/checklists at build time by
// scripts/build-card-index.js, so it changes only when the catalogue does.
const { resolvePlayer, stats: cardIndexStats } = require('./card-index');

// How long to cache an eBay For-Sale (Browse API) response in KV. Light by
// design: long enough to absorb a traffic spike (a viral card searched 100x in
// the window costs 1 eBay call, not 100), short enough that listings stay fresh.
const FORSALE_CACHE_TTL = 1800; // 30 minutes

const { moderateText, moderateImage, stripBidi } = require('./moderation');

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
// Sold prices come from The Card API (thecardapi.com) — a licensed sold-price
// feed covering eBay plus the major auction houses. eBay's own sold data is not
// available to us (Marketplace Insights is partner-gated), so this is the
// supported path. For Sale still uses eBay's Browse API directly.
//
// Set the key with: wrangler secret put CARD_API_KEY
// Without it, sold searches degrade to the "unavailable" state rather than error.
const CARD_API_KEY = process.env.CARD_API_KEY;
const CARD_API_BASE = 'https://thecardapi.com/api/v1/market';

// Which sold provider(s) to use. A switch rather than a code change so it can
// be flipped from a secret and flipped straight back:
//   auto      (default) NflCardDB, then The Card API
//   nflcarddb our own D1 dataset only — no paid provider is called
//   cardapi   The Card API only
// TEMPORARY: default flipped to 'nflcarddb' to test our own dataset in
// isolation — the paid provider is not called at all while this stands.
// Revert this default to 'auto' to restore the fallback chain, or set the
// SOLD_PROVIDER secret to 'auto', which overrides it without a code change.
const SOLD_PROVIDER = (() => {
  const v = String(process.env.SOLD_PROVIDER || 'nflcarddb').trim().toLowerCase();
  return ['auto', 'cardapi', 'nflcarddb'].includes(v) ? v : 'auto';
})();

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

// Checkout kill switch — set env CHECKOUT_ENABLED=false to pause all paid
// checkout (every checkout/buy endpoint returns 503 and the frontend hides
// the Go Pro CTA). Enabled by default. Cancellation via the billing portal
// stays available either way so existing subscribers aren't trapped.
const CHECKOUT_ENABLED = process.env.CHECKOUT_ENABLED === 'false' ? false : true;
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

      // Donations were removed. Any such event now is a historical webhook
      // replay, so acknowledge and ignore rather than treating it as a plan.
      if (session.metadata?.type === 'donation' || session.metadata?.type === 'supporter') break;

      const username = session.metadata?.username;
      if (!username) break;

      if (session.subscription) {
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
app.use(express.json({ limit: '12mb' })); // card scans post base64 images (front + optional back)
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
      sold: {
        // Sold prices come from The Card API, not eBay (Marketplace Insights
        // is partner-gated). Hit this after deploying to confirm the secret
        // landed — false here means sold search will show "unavailable".
        configured: !!CARD_API_KEY,
        provider: 'thecardapi.com',
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

function emptyDay() {
  return { total: 0, finding: 0, browse: 0, insights: 0, soldCacheHits: 0, forsaleCacheHits: 0 };
}

// Cache hits are the common case, so we DON'T write one KV entry per hit — we
// buffer them in memory and flush in batches (and ride along on the next API
// write via trackApiCall). Approximate by design; good enough for a usage gauge.
let pendingSoldHits = 0;
let pendingForsaleHits = 0;
function trackCacheHit(kind) {
  if (kind === 'sold') pendingSoldHits++; else pendingForsaleHits++;
  if (pendingSoldHits + pendingForsaleHits >= 10) flushCacheHits();
}
function flushCacheHits() {
  if (pendingSoldHits + pendingForsaleHits <= 0) return;
  const log = loadApiCallLog();
  const today = new Date().toISOString().slice(0, 10);
  if (!log.daily[today]) log.daily[today] = emptyDay();
  log.daily[today].soldCacheHits = (log.daily[today].soldCacheHits || 0) + pendingSoldHits;
  log.daily[today].forsaleCacheHits = (log.daily[today].forsaleCacheHits || 0) + pendingForsaleHits;
  pendingSoldHits = 0; pendingForsaleHits = 0;
  saveApiCallLog(log);
}

function trackApiCall(apiName, endpoint, keywords, source) {
  const log = loadApiCallLog();
  const now = new Date();
  const today = now.toISOString().slice(0, 10);

  if (!log.daily[today]) log.daily[today] = emptyDay();
  log.daily[today].total++;
  if (apiName === 'finding') log.daily[today].finding++;
  else if (apiName === 'browse') log.daily[today].browse++;
  else if (apiName === 'insights') log.daily[today].insights++;
  // Free ride: fold any buffered cache hits into this write.
  if (pendingSoldHits + pendingForsaleHits > 0) {
    log.daily[today].soldCacheHits = (log.daily[today].soldCacheHits || 0) + pendingSoldHits;
    log.daily[today].forsaleCacheHits = (log.daily[today].forsaleCacheHits || 0) + pendingForsaleHits;
    pendingSoldHits = 0; pendingForsaleHits = 0;
  }

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
  const base = log.daily[today] || emptyDay();
  // Fold this isolate's not-yet-flushed cache hits in so a live read isn't understated.
  const todayStats = {
    ...emptyDay(), ...base,
    soldCacheHits: (base.soldCacheHits || 0) + pendingSoldHits,
    forsaleCacheHits: (base.forsaleCacheHits || 0) + pendingForsaleHits,
  };

  const rate = (h, m) => (h + m) > 0 ? Math.round((h / (h + m)) * 100) : null;

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
    recentCalls: (log.calls || []).slice(-20),
    forsale: {
      callsToday: todayStats.browse || 0,
      cacheHitsToday: todayStats.forsaleCacheHits || 0,
      cacheHitRatePct: rate(todayStats.forsaleCacheHits || 0, todayStats.browse || 0),
    },
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
  // KV cache: shared across isolates so a launch-day spike on a popular card
  // doesn't burn one eBay Browse call per request. Keyed by the exact params
  // that determine eBay's response.
  const cacheKey = `browse:v1:${limit}:${offset}:${String(keywords).toLowerCase().trim()}`;
  const cached = await cacheGet(cacheKey);
  if (cached && Array.isArray(cached.results)) {
    console.log(`[Browse API] KV cache hit for "${keywords}" (${cached.results.length} items)`);
    trackCacheHit('forsale');
    return cached;
  }

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

  const out = { results, total: res.data?.total || results.length };
  cachePut(cacheKey, out, FORSALE_CACHE_TTL); // best-effort, fire-and-forget
  return out;
}



// ---- NflCardDB (sold prices, own D1 database) ----
// Our own dataset: eBay sold football-card listings collected daily and parsed
// into structured columns. Same Cloudflare account, so it's a direct D1 query —
// no HTTP hop, no key, no quota, no lookback window. That makes it the first
// source we try; the paid providers only cover what it misses.
//
// Two things the dataset's own brief flags, both enforced below:
//   1. price_cents is NULL on ~46% of rows and that is CORRECT — those are
//      best-offer sales where eBay publishes the seller's ask, not what the
//      buyer paid. Averaging an ask into a comp would silently inflate it, so
//      unpriced rows are excluded outright.
//   2. Titles are seller-written, so `confidence` (0-1) is how much of a title
//      the parser explained. Below ~0.5 the player field may be wrong, so
//      player-driven filtering uses that floor.
// `team` is populated opportunistically and often NULL — never filtered on.
const NFLDB_MIN_CONFIDENCE = 0.5;

// The schema has no listing URL, but item_id is the eBay item id so the link
// is reconstructable. Images aren't collected today — the renderer falls back
// to a placeholder — but the collector has them at capture time, so this reads
// an `image_url` column opportunistically. Add it upstream and photos start
// appearing here with no change needed on this side.
//
// Probed once rather than assumed: selecting a column that doesn't exist makes
// D1 throw, which would take the whole provider down.
// Same probe as image_url below: the sales schema has grown over time, and a
// SELECT naming a column the table doesn't have fails the whole query, so a
// missing sale-type column would take sold search down with it.
let _nflSaleTypeCols = null;
async function _nflHasSaleTypeColumns(db) {
  if (_nflSaleTypeCols !== null) return _nflSaleTypeCols;
  try {
    await db.prepare('SELECT best_offer, bids FROM sales LIMIT 1').first();
    _nflSaleTypeCols = true;
    console.log('[NflCardDB] best_offer/bids present — labelling how each sale closed');
  } catch (_) {
    _nflSaleTypeCols = false;
  }
  return _nflSaleTypeCols;
}

let _nflImageCol = null; // null = not yet determined
async function _nflHasImageColumn(db) {
  if (_nflImageCol !== null) return _nflImageCol;
  try {
    await db.prepare('SELECT image_url FROM sales LIMIT 1').first();
    _nflImageCol = true;
    console.log('[NflCardDB] image_url column present — serving photos');
  } catch (_) {
    _nflImageCol = false;
  }
  return _nflImageCol;
}

// How a sale actually closed. eBay settles a listing three ways and they mean
// very different things to someone reading a comp: an auction result is what
// the market bid on the day, a fixed-price sale is the seller's number met in
// full, and an accepted best offer is under an asking price we cannot see.
// Returns null when the source doesn't say — better to show nothing than to
// label a sale wrongly.
function saleTypeOf({ bestOffer, listingFormat }) {
  if (bestOffer === 1 || bestOffer === true || /^(1|y|yes|true)$/i.test(String(bestOffer || ''))) return 'offer';
  const fmt = String(listingFormat || '').toLowerCase();
  if (!fmt) return null;
  if (fmt.includes('auction')) return 'auction';
  return 'fixed';
}

function mapNflDbSale(r) {
  // Same rule as the analysis buckets: an unparsed grade isn't proof a card
  // was raw, so don't label a likely slab "Ungraded".
  const bucket = _gradeBucket(r);
  const grade = r.grade != null
    ? `${r.grader || ''} ${r.grade}`.replace(/\.0$/, '').trim()
    : (bucket === 'Raw' ? null : 'Graded');
  return {
    itemId: String(r.item_id || ''),
    title: r.title || '',
    price: String((Number(r.price_cents) || 0) / 100),
    currency: r.currency || 'USD',
    soldDate: r.sold_date || '',
    imageUrl: r.image_url || null, // absent until the collector stores one
    itemUrl: r.item_id ? `https://www.ebay.com/itm/${encodeURIComponent(r.item_id)}` : '',
    condition: grade || 'Ungraded',
    buyingOptions: r.listing_format === 'auction' ? ['AUCTION'] : ['FIXED_PRICE'],
    saleType: saleTypeOf({ bestOffer: r.best_offer, listingFormat: r.listing_format }),
    bids: Number.isFinite(Number(r.bids)) && Number(r.bids) > 0 ? Number(r.bids) : null,
    // No print_run column — callers fall back to parsing it out of the title.
    printRun: null,
    grader: r.grader || null,
    grade: r.grade != null ? String(r.grade).replace(/\.0$/, '') : null,
    platform: 'eBay',
    source: 'nflcarddb',
    // The query already enforces the confidence floor, so a player name is the
    // only remaining condition for /api/card-analysis to return something.
    hasAnalysis: !!r.player,
  };
}

// Turn a free-text card query into a LIKE-matched D1 lookup. Every term must
// appear somewhere in the title, which mirrors how the other providers behave
// and keeps the existing downstream filters meaningful.
async function fetchViaNflCardDb(keywords, limit = 50, source = 'unknown') {
  const db = getNflDb();
  if (!db) return { results: [], total: 0, unavailable: true };

  // Serial stamps are handled by the callers' print-run logic, not by matching
  // "/5" as a title substring.
  const cleaned = String(keywords).replace(/\/\d{1,4}(?![0-9])/g, ' ').replace(/\s+/g, ' ').trim();
  const terms = cleaned.split(/\s+/).filter(t => t.length > 1).slice(0, 8);
  if (terms.length === 0) return { results: [], total: 0 };

  const where = [
    'price_cents IS NOT NULL', // exclude best-offer rows — see note above
    'confidence >= ?',
    ...terms.map(() => 'title LIKE ?'),
  ].join(' AND ');
  const binds = [NFLDB_MIN_CONFIDENCE, ...terms.map(t => `%${t}%`)];

  try {
    // `player` isn't displayed — it's how we know up front whether this row can
    // resolve to a card identity, so the UI can advertise the history rather
    // than making people click to discover it isn't there.
    const cols = 'item_id, sold_date, title, price_cents, currency, listing_format, grader, grade, player'
      + (await _nflHasSaleTypeColumns(db) ? ', best_offer, bids' : '')
      + (await _nflHasImageColumn(db) ? ', image_url' : '');
    const stmt = db.prepare(
      `SELECT ${cols}
       FROM sales WHERE ${where}
       ORDER BY sold_date DESC LIMIT ?`
    ).bind(...binds, Math.min(limit, 500));
    const out = await stmt.all();
    const rows = (out && Array.isArray(out.results)) ? out.results : [];
    console.log(`[NflCardDB] "${cleaned}" -> ${rows.length} sales (${source})`);
    return { results: rows.map(mapNflDbSale), total: rows.length };
  } catch (err) {
    // A query failure must never take sold search down — fall through to the
    // paid providers instead.
    console.error('[NflCardDB] query failed:', err && err.message);
    return { results: [], total: 0, unavailable: true };
  }
}

// True when the sales table exists but holds no priced rows — i.e. the import
// hasn't run. Cached for a minute so a run of misses doesn't re-count on every
// search. Returns false on any error so an unrelated fault never gets reported
// to users as "the database is empty".
let _nflEmptyCheck = { at: 0, empty: false };
async function _nflDbIsEmpty() {
  const db = getNflDb();
  if (!db) return false;
  if (Date.now() - _nflEmptyCheck.at < 60000) return _nflEmptyCheck.empty;
  try {
    const row = await db.prepare('SELECT 1 AS n FROM sales WHERE price_cents IS NOT NULL LIMIT 1').first();
    _nflEmptyCheck = { at: Date.now(), empty: !row };
    return !row;
  } catch (_) {
    return false;
  }
}

// ---- The Card API (sold prices) ----
// Free tier is 5,000 sale rows/day with a 3-day lookback, and CSV + API draw
// from the same pool — so every row we pull is scarce. Cache hard: the lookback
// window barely moves within a day, and a cached comp is as good as a fresh one.
// 24h. The feed's lookback is measured in days, so a comp set barely moves
// within one — and a longer TTL is the single cheapest way to cut row spend.
const SOLD_API_CACHE_TTL = 24 * 3600;

// Cache key for a sold lookup. Deliberately NOT keyed on the request limit —
// see the reuse check in fetchViaCardApi, which slices a larger cached result
// down for a smaller caller.
//
// Tokens are sorted because `q` is full-text over the listing title, so word
// order doesn't change what comes back — but it does change a naive key.
// "Patrick Mahomes 2017 Prizm", "2017 Prizm Patrick Mahomes" and "prizm
// mahomes 2017" are one card typed three ways, and without this they'd be
// three separate paid lookups.
function _soldCacheKey(cleaned, filterKey) {
  return `soldapi:v2:${filterKey}:${_soldNormalize(cleaned)}`;
}

function _soldNormalize(cleaned) {
  return String(cleaned).toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/).filter(Boolean).sort().join(' ');
}

// ==================== Sold-sale archive ====================
// The provider's lookback is a rolling window — 3 days on the free tier — so
// any sale older than that becomes unreachable, permanently. Every lookup we
// pay for is therefore written to KV and kept, which turns a 3-day window into
// history that deepens by a day per day at no extra cost.
//
// Keyed by the same normalised query as the cache, so all phrasings of a card
// accumulate into one archive. Sales dedupe on the provider's sale id, so
// re-fetching overlapping windows never double-counts.
const SOLD_ARCHIVE_MAX = 5000; // per card; ~1.5MB, well inside KV's 25MB limit
// 0 = keep forever. Set SOLD_ARCHIVE_RETENTION_DAYS if the provider's terms
// ever cap retention — no code change needed, just the secret.
const SOLD_ARCHIVE_RETENTION_DAYS = parseInt(process.env.SOLD_ARCHIVE_RETENTION_DAYS, 10) || 0;

function _soldArchiveKey(cleaned, filterKey) {
  return `soldarch:v1:${filterKey}:${_soldNormalize(cleaned)}`;
}

// Merge freshly-fetched sales into the stored history for a card.
// Best-effort by design: an archive failure must never break a live search.
async function _archiveSales(archiveKey, sales) {
  if (!Array.isArray(sales) || sales.length === 0) return null;
  try {
    const prior = await archiveGet(archiveKey);
    const existing = (prior && Array.isArray(prior.sales)) ? prior.sales : [];

    // Dedupe on sale id; a re-fetch of an overlapping window is the normal case.
    const byId = new Map();
    for (const s of existing) if (s && s.itemId) byId.set(s.itemId, s);
    let added = 0;
    for (const s of sales) {
      if (!s || !s.itemId || byId.has(s.itemId)) continue;
      byId.set(s.itemId, s);
      added++;
    }
    if (added === 0) return prior; // nothing new — skip the write entirely

    let merged = Array.from(byId.values())
      .sort((a, b) => new Date(b.soldDate || 0) - new Date(a.soldDate || 0));

    if (SOLD_ARCHIVE_RETENTION_DAYS > 0) {
      const cutoff = Date.now() - SOLD_ARCHIVE_RETENTION_DAYS * 86400000;
      merged = merged.filter(s => {
        const t = new Date(s.soldDate || 0).getTime();
        return !isFinite(t) || t >= cutoff;
      });
    }
    if (merged.length > SOLD_ARCHIVE_MAX) merged = merged.slice(0, SOLD_ARCHIVE_MAX);

    const record = { sales: merged, updatedAt: new Date().toISOString(), count: merged.length };
    await archivePut(archiveKey, record);
    console.log(`[Archive] +${added} new sales for "${archiveKey}" (${merged.length} total)`);
    return record;
  } catch (err) {
    console.error('[Archive] write failed:', err && err.message);
    return null;
  }
}

// Stored history for a card, newest first. Returns [] when nothing is archived.
async function getArchivedSales(keywords, opts = {}) {
  const cleaned = String(keywords).replace(/\/\d{1,4}(?![0-9])/g, ' ').replace(/\s+/g, ' ').trim();
  const filterKey = [opts.grader || '', opts.grade || '', opts.graded == null ? '' : String(opts.graded)].join('|');
  try {
    const rec = await archiveGet(_soldArchiveKey(cleaned, filterKey));
    return (rec && Array.isArray(rec.sales)) ? rec.sales : [];
  } catch (_) {
    return [];
  }
}

// Summary of a card's archived history — the shape a value-over-time chart
// wants, without shipping thousands of rows to the browser.
function summarizeArchive(sales) {
  const priced = (sales || [])
    .map(s => ({ price: parseFloat(s.price), date: String(s.soldDate || '').slice(0, 10) }))
    .filter(s => s.price > 0 && s.date);
  if (!priced.length) return null;

  // One point per day: the median of that day's sales, so a single outlier
  // doesn't put a spike in the line.
  const byDay = new Map();
  for (const p of priced) {
    if (!byDay.has(p.date)) byDay.set(p.date, []);
    byDay.get(p.date).push(p.price);
  }
  const points = Array.from(byDay.entries())
    .map(([date, prices]) => {
      prices.sort((a, b) => a - b);
      const mid = Math.floor(prices.length / 2);
      const median = prices.length % 2 ? prices[mid] : (prices[mid - 1] + prices[mid]) / 2;
      return { date, median: Math.round(median * 100) / 100, sales: prices.length };
    })
    .sort((a, b) => a.date.localeCompare(b.date));

  return {
    totalSales: priced.length,
    days: points.length,
    firstSale: points[0].date,
    lastSale: points[points.length - 1].date,
    points,
  };
}

// Requests currently in flight, keyed the same way as the cache. The KV cache
// only dedupes calls that are sequential — two identical lookups fired in
// parallel both miss it and both get billed. Sharing the in-flight promise
// makes concurrent duplicates cost one request instead of N.
const _soldInFlight = new Map();

// Map a Card API sale record onto the internal listing shape the rest of the
// app already speaks (same fields fetchViaBrowseAPI emits), so every existing
// filter, stats bar, chart, and card renderer works unchanged. Extra structured
// fields the API gives us — print run, grader/grade — ride along for callers
// that want them instead of re-parsing the title.
function mapCardApiSale(s) {
  const grade = s.grade ? `${s.grader || ''} ${s.grade}`.trim() : null;
  return {
    itemId: String(s.id || ''),
    title: s.title || '',
    price: String(s.price != null ? s.price : '0'),
    currency: s.currency || 'USD',
    soldDate: s.sold_at || s.sale_date || '',
    imageUrl: s.thumbnail_url || s.image_url || null,
    itemUrl: s.listing_url || '',
    condition: grade || s.condition || 'Ungraded',
    buyingOptions: s.listing_type === 'auction' ? ['AUCTION'] : ['FIXED_PRICE'],
    saleType: saleTypeOf({ bestOffer: s.best_offer, listingFormat: s.listing_type }),
    bids: Number.isFinite(Number(s.bids)) && Number(s.bids) > 0 ? Number(s.bids) : null,
    // Structured extras (no title regex needed)
    printRun: Number.isFinite(s.print_run) ? s.print_run : null,
    grader: s.grader || null,
    grade: s.grade || null,
    listingType: s.listing_type || null,
    platform: s.platform || null,
  };
}

// Search sold sales. Returns { results, total } on success, or a flagged object
// ({ soldUnavailable } / { rateLimited }) that callers surface to the user —
// never throws for an expected provider state.
// `opts` maps onto the API's structured filters — notably grader/grade, which
// are far more reliable than hoping "PSA 10" appears in the listing title.
async function fetchViaCardApi(keywords, limit = 50, source = 'unknown', opts = {}) {
  if (!CARD_API_KEY) {
    return { results: [], total: 0, soldUnavailable: true, error: SOLD_UNAVAILABLE_MSG };
  }

  // The API's `q` is full-text over the listing title, so a "/5" serial stamp
  // is noise there — strip it and let the caller's print-run logic do that job.
  // The negative terms drop obvious junk upstream so it never costs us a row.
  const cleaned = String(keywords).replace(/\/\d{1,4}(?![0-9])/g, ' ').replace(/\s+/g, ' ').trim();
  const params = { q: `${cleaned} -(lot,reprint,digital)`, limit: Math.min(limit, 1000), sort: 'date_desc' };
  if (opts.grader) params.grader = opts.grader;
  if (opts.grade) params.grade = opts.grade;
  if (opts.graded != null) params.graded = opts.graded;

  // Filters must be part of the cache key or a graded lookup would serve the
  // raw result set (or vice versa) for the same query text.
  const filterKey = [opts.grader || '', opts.grade || '', opts.graded == null ? '' : String(opts.graded)].join('|');
  const cacheKey = _soldCacheKey(cleaned, filterKey);
  const cached = await cacheGet(cacheKey);
  // A cached entry satisfies this request when it already holds enough rows,
  // or when it wasn't truncated (fewer rows came back than were asked for, so
  // that IS the whole result set). Lets a 50-row search serve a later 25-row
  // inventory valuation of the same card for free.
  if (cached && Array.isArray(cached.results)
      && (cached.results.length >= limit || cached.results.length < (cached.fetchedLimit || 0))) {
    console.log(`[Card API] KV cache hit for "${cleaned}" (${cached.results.length} sales, need ${limit})`);
    trackCacheHit('sold');
    return { ...cached, results: cached.results.slice(0, limit) };
  }

  // An identical lookup already on the wire? Ride along on it instead of
  // paying for the same rows twice.
  const pending = _soldInFlight.get(cacheKey);
  if (pending) {
    console.log(`[Card API] joining in-flight request for "${cleaned}"`);
    trackCacheHit('sold');
    return pending;
  }

  trackApiCall('insights', 'cardapi/sales', keywords, source);
  const work = (async () => {
    try {
      const res = await axios.get(`${CARD_API_BASE}/sales`, {
        params,
        headers: { 'x-market-api-key': CARD_API_KEY },
        timeout: 15000,
      });

      const remaining = res.headers?.['x-ratelimit-remaining'];
      if (remaining != null) console.log(`[Card API] ${remaining} sale rows left today`);

      const rows = Array.isArray(res.data?.data) ? res.data.data : [];
      const out = {
        results: rows.map(mapCardApiSale),
        total: res.data?.pagination?.total || rows.length,
        fetchedLimit: params.limit, // lets a later smaller request reuse this
      };
      cachePut(cacheKey, out, SOLD_API_CACHE_TTL); // best-effort, fire-and-forget
      // Keep every sale we just paid for. Not awaited — the archive must never
      // add latency to a search, and a failed write is logged, not fatal.
      _archiveSales(_soldArchiveKey(cleaned, filterKey), out.results);
      return out;
    } catch (err) {
      const status = err.response?.status;
      if (status === 429) {
        // Daily row budget spent — resets 00:00 UTC. The frontend already has a
        // graceful path for `rateLimited`, so reuse it rather than erroring out.
        console.warn('[Card API] daily sale-row limit reached');
        return {
          results: [], total: 0, rateLimited: true,
          rateLimitMessage: "Sold search has hit today's data limit. It resets at midnight UTC — try again then, or use For Sale mode in the meantime.",
        };
      }
      if (status === 401 || status === 403) {
        console.error(`[Card API] auth/plan error ${status} — check CARD_API_KEY`);
        return { results: [], total: 0, soldUnavailable: true, error: SOLD_UNAVAILABLE_MSG };
      }
      console.error('[Card API] request failed:', err.message);
      return { results: [], total: 0, soldUnavailable: true, error: SOLD_UNAVAILABLE_MSG };
    } finally {
      // Always clear, or a failed request would pin its rejection forever.
      _soldInFlight.delete(cacheKey);
    }
  })();

  _soldInFlight.set(cacheKey, work);
  return work;
}

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

// Same matcher as classInner but returns the element's RAW inner HTML (tags
// intact) so the price parser can see eBay's separate dollars/cents nodes.
function classInnerRaw(block, cls) {
  const c = cls.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    '<([a-zA-Z][\\w-]*)\\b[^>]*\\bclass\\s*=\\s*' +
      '(?:"[^"]*' + c + '[^"]*"|\'[^\']*' + c + '[^\']*\'|[^\\s"\'>]*' + c + '[^\\s"\'>]*)' +
      '[^>]*>([\\s\\S]*?)<\\/\\1>',
    'i'
  );
  const m = block.match(re);
  return m ? m[2] : '';
}

// Parse a sold price (number) from a price element's RAW inner HTML. Robust to:
//  • eBay rendering cents in a separate node with no literal decimal point
//    ("$152" <sup>10</sup>), which a naive digit-strip reads as 15210;
//  • thousands separators ("$1,250.00");
//  • more than one price in the element (a struck "was" price beside the sold
//    price) — takes the first well-formed value.
function parsePriceHtml(rawHtml) {
  if (!rawHtml) return 0;
  const raw = String(rawHtml);
  const flat = raw.replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/gi, ' ');

  // 1) First well-formed money value WITH cents (1,234.56 or 50.00).
  const cents = flat.match(/\d{1,3}(?:,\d{3})+(?:\.\d{2})?|\d+\.\d{2}/);
  if (cents) {
    const n = parseFloat(cents[0].replace(/,/g, ''));
    if (isFinite(n) && n > 0) return n;
  }

  // 2) Cents rendered in a separate node, no literal decimal: "$152<sup>10</sup>"
  //    → 152.10. Dollars, then tag(s), then exactly two cents digits.
  const split = raw.match(/\$\s*([\d,]+)\s*(?:<[^>]+>\s*)+(\d{2})(?!\d)/);
  if (split) {
    const dollars = parseInt(split[1].replace(/,/g, ''), 10);
    if (isFinite(dollars)) return dollars + parseInt(split[2], 10) / 100;
  }

  // 3) Whole-dollar listing (no cents anywhere): first integer value.
  const intMatch = flat.match(/\$?\s*([\d,]{1,9})(?!\d)/);
  if (intMatch) {
    const n = parseFloat(intMatch[1].replace(/,/g, ''));
    if (isFinite(n) && n > 0) return n;
  }
  return 0;
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

  // Price: parse from the price element's RAW HTML so split dollars/cents nodes
  // and thousands commas don't get mangled into a giant number. Fall back to the
  // first dollars-and-cents value anywhere in the card.
  const rawPrice =
    classInnerRaw(block, 's-card__price') ||
    classInnerRaw(block, 's-item__price') ||
    classInnerRaw(block, 'price');
  let priceNum = parsePriceHtml(rawPrice);
  if (!priceNum) {
    const dollar = block.match(/\$\s?[\d,]+(?:\.\d{2})?/);
    if (dollar) priceNum = parsePriceHtml(dollar[0]);
  }
  const priceStr = priceNum ? priceNum.toFixed(2) : '';

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

// unlimited alerts, unlimited sold search, all-time comps).
function isProUser(username) {
  if (!username) return false;
  const sub = getEffectiveSubscription(username);
  return !!(sub && sub.status === 'active' && (sub.plan === 'pro' || sub.plan === 'proplus'));
}

// Sold price data is retired pending eBay's official Marketplace Insights API.
// Every sold-based endpoint funnels through this single helper so the app
// degrades gracefully — no crashes, one consistent message — instead of
// pretending sold search still works.
const SOLD_UNAVAILABLE_MSG = 'Sold price data is temporarily unavailable. Use For Sale mode for live listings in the meantime.';
function sendSoldUnavailable(res) {
  // HTTP 200 (not an error status) so the frontend's graceful "sold unavailable"
  // handlers run — they read the body after an `if (!res.ok) throw` guard, the
  // same way the old rateLimited path was delivered.
  return res.json({ results: [], total: 0, soldUnavailable: true, error: SOLD_UNAVAILABLE_MSG });
}

// Every sold-backed feature shares two provider states: no usable key, and the
// daily row budget being spent. Responds and returns true when one applies, so
// callers can guard with a single `if (sendIfSoldBlocked(res, data)) return;`.
function sendIfSoldBlocked(res, ...responses) {
  const blocked = responses.find(r => r && (r.soldUnavailable || r.rateLimited));
  if (!blocked) return false;
  if (blocked.soldUnavailable) { sendSoldUnavailable(res); return true; }
  res.json({
    results: [], total: 0, rateLimited: true,
    error: blocked.rateLimitMessage,
    rateLimitMessage: blocked.rateLimitMessage,
  });
  return true;
}

// ---- Shared fetch function ----
// mode: 'forsale' (eBay Browse API) or 'sold' (The Card API)
// Cache disabled for both modes per user request — every search hits the
// upstream APIs fresh so users always see current listings/prices. The
// in-memory ebayCache + getCached/setCache helpers stay in the file for
// the unrelated marketplace endpoint to use.
async function fetchEbayItems(keywords, limit = 20, mode = 'forsale', source = 'search', offset = 0, opts = {}) {
  if (mode === 'sold') {
    // Our own D1 dataset first — no key, no quota, no lookback window, no
    // network hop. Anything it answers costs nothing, so the paid providers
    // only ever see what it misses. Football-only, and absent until the D1
    // binding exists, so a miss here is the normal case rather than an error.
    if (SOLD_PROVIDER !== 'cardapi') {
      const own = await fetchViaNflCardDb(keywords, limit, source);
      const ownResults = Array.isArray(own.results) ? filterJunkListings(own.results) : [];
      if (ownResults.length > 0) {
        // Archive these too: they're ours, but the archive is what survives if
        // the dataset is ever rebuilt, and it dedupes on the same item ids.
        const c = String(keywords).replace(/\/\d{1,4}(?![0-9])/g, ' ').replace(/\s+/g, ' ').trim();
        const fk = [opts.grader || '', opts.grade || '', opts.graded == null ? '' : String(opts.graded)].join('|');
        _archiveSales(_soldArchiveKey(c, fk), ownResults);
        return { ...own, results: ownResults, provider: 'nflcarddb' };
      }
      // Pinned to our own dataset: stop here rather than silently spending a
      // paid provider's quota on the miss.
      if (SOLD_PROVIDER === 'nflcarddb') {
        if (own.unavailable) {
          return { results: [], total: 0, soldUnavailable: true, error: 'The football sold-price database is not connected yet.' };
        }
        // The query worked but matched nothing. That reads identically whether
        // the card genuinely has no sales or the import never ran, so check
        // whether the table holds anything at all and say which it is.
        const empty = await _nflDbIsEmpty();
        if (empty) {
          return {
            results: [], total: 0, soldUnavailable: true,
            error: 'The football sold-price database is connected but has no rows yet — run the import.',
          };
        }
        return { results: [], total: 0, provider: 'nflcarddb' };
      }
    }

    // The Card API is next: it's the licensed feed, and because billing is per
    // row RETURNED, a search that finds nothing costs ~nothing.
    const response = await fetchViaCardApi(keywords, limit, source, opts);
    const primary = Array.isArray(response.results) ? filterJunkListings(response.results) : [];
    if (primary.length > 0) return { ...response, results: primary, provider: 'cardapi' };

    // No fallback available or it also came up empty. Return the primary
    // response untouched so its soldUnavailable / rateLimited flags survive
    // and callers surface the right state instead of a bare empty list.
    return { ...response, results: primary };
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

  if (mode === 'sold' ? USE_MOCK_SOLD : USE_MOCK_FORSALE) {
    return res.json(getMockData(query, mode));
  }

  try {
    const serial = extractSerial(query);

    // ---- Sold mode (The Card API) ----
    if (mode === 'sold') {
      const searchData = await fetchEbayItems(query, limit, mode, 'search', 0);
      if (searchData.soldUnavailable) return sendSoldUnavailable(res);
      if (searchData.rateLimited) {
        return res.json({
          results: [], total: 0, mock: false, mode, serial: serial || null, similarResults: [],
          searchType: 'exact', broadenedQuery: null, approximateValue: null,
          rateLimited: true, rateLimitMessage: searchData.rateLimitMessage,
        });
      }
      // Keyword match: keep the listings sharing the most keywords with the
      // query (all → all-but-one → all-but-two …), then trim price outliers.
      const matched = matchSoldListings(searchData.results, query);
      const variantFiltered = filterPriceOutliers(matched.results);
      const exactExists = hasExactCardSales(query, searchData.results);

      // Serial requested but nothing sold AT that print run? The nearest print
      // runs are already in hand: the provider query has the serial stripped
      // before it's sent, so this one response covers every print run of the
      // card. A second "broad" call would re-request byte-identical data and
      // be billed for it, so pull the similar runs out of what we have.
      let similarResults = [];
      const estimatePool = searchData.results;
      if (serial && !exactExists && estimatePool.length) {
        const baseQuery = query.replace(/\/\d{1,4}/, '').replace(/\s+/g, ' ').trim();
        // Keep the same card at OTHER print runs, sorted by how close each print
        // run is to the one requested. Prefer the API's structured print_run and
        // fall back to the serial stamped in the title.
        const reqSerial = parseInt(serial, 10);
        const numberedRe = /\/(\d{1,4})(?![0-9])/;
        const runOf = (r) => {
          if (Number.isFinite(r.printRun)) return r.printRun;
          const m = String(r.title || '').match(numberedRe);
          return m ? parseInt(m[1], 10) : null;
        };
        const shownIds = new Set(variantFiltered.map(r => r.itemId));
        similarResults = matchSoldListings(estimatePool, baseQuery).results
          .filter(r => {
            const run = runOf(r);
            return !shownIds.has(r.itemId) && run != null && run !== reqSerial;
          })
          .sort((a, b) => {
            const an = runOf(a), bn = runOf(b);
            return (Math.abs(an - reqSerial) - Math.abs(bn - reqSerial)) || (an - bn);
          })
          .slice(0, 20);
      }

      const approx = variantFiltered.length > 0 ? computeApproxValue(variantFiltered, query) : null;
      const relaxedNote = matched.relaxedBy > 0 && matched.searchType === 'relaxed'
        ? `Matched ${matched.keywordsMatched} of ${matched.keywordsTotal} keywords`
        : null;
      // No sale of the exact card (e.g. a /5, or this set)? Estimate its value
      // from the same player's similar sales, adjusted for print run and set.
      const estimate = exactExists ? null : buildSimilarCardEstimate(query, estimatePool);
      return res.json({
        results: variantFiltered,
        total: variantFiltered.length,
        mock: false,
        mode,
        serial: serial || null,
        similarResults,
        searchType: matched.searchType,
        broadenedQuery: null,
        approximateValue: approx,
        estimate,
        keywordsTotal: matched.keywordsTotal,
        keywordsMatched: matched.keywordsMatched,
        relaxedBy: matched.relaxedBy,
        relaxedNote,
      });
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

// ---- Set desirability tiers (for cross-set value balancing) ----
// A curated, hobby-informed ranking of how much a set's cards command relative
// to each other, used ONLY to normalize comps from a different set than the one
// searched (e.g. there are no National Treasures sales, so a Score sale is
// scaled up toward NT). The numbers are RELATIVE weights, not dollar values; a
// comp from set B is scaled toward target set A by tier(A)/tier(B), clamped.
// Tweak freely — higher = more premium. Ambiguous names that double as a color
// or parallel (e.g. "black", "elite", "one") are intentionally omitted so they
// don't false-match inside titles.
const SET_VALUE_TIERS = {
  // Tier 1 — ultra high-end
  'national treasures': 8, 'flawless': 8, 'immaculate': 6, 'impeccable': 6,
  // Tier 2 — high-end
  'spectra': 4, 'obsidian': 4, 'noir': 4, 'encased': 3.5, 'limited': 3.5,
  'gold standard': 3.5, 'majestic': 3.5, 'origins': 3, 'contenders': 3,
  // Tier 3 — mid
  'prizm': 2.5, 'select': 2.5, 'mosaic': 2, 'optic': 2, 'phoenix': 2,
  'certified': 2, 'absolute': 2, 'zenith': 2, 'elements': 2,
  'luminance': 1.8, 'illusions': 1.8, 'chronicles': 1.8, 'photogenic': 1.8,
  'prestige': 1.5,
  // Tier 4 — base / entry
  'donruss': 1.2, 'score': 1, 'hoops': 1,
};

// Find the most specific known set named in a title and return { name, tier }.
// Prefers the longest matching name so "national treasures" beats nothing and
// multi-word sets win over substrings.
function detectSetTier(text) {
  const t = ' ' + String(text || '').toLowerCase().replace(/\s+/g, ' ') + ' ';
  let best = null;
  for (const name of Object.keys(SET_VALUE_TIERS)) {
    const re = new RegExp('(^| )' + escapeRegexLiteral(name) + '( |$)');
    if (re.test(t) && (!best || name.length > best.name.length)) {
      best = { name, tier: SET_VALUE_TIERS[name] };
    }
  }
  return best;
}

function clampNum(n, lo, hi) { return Math.min(Math.max(n, lo), hi); }


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

// ---- Keyword-based sold matching ----
// New sold-search model: extract the meaningful keywords from the query
// (player, year, set, parallel/color, print run, auto/mem intent, plus any
// leftover terms), then keep the sold listings whose titles match the MOST
// keywords. We require every keyword first; if nothing matches all of them we
// relax to "all but one", then "all but two", and so on — so a thin card still
// returns its closest comps instead of a blank chart.

function escapeRegexLiteral(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Synonym groups so intent matches real-world title wording.
const AUTO_TITLE_KEYWORDS = ['autograph', 'autographs', 'auto', 'signed', 'signature', 'sig', 'rpa'];
const MEM_TITLE_KEYWORDS = ['patch', 'relic', 'jersey', 'memorabilia', 'swatch', 'material', 'logoman', 'rpa'];

function titleHasAuto(title) {
  return AUTO_TITLE_KEYWORDS.some(w => new RegExp('\\b' + w + '\\b').test(title));
}
function titleHasMem(title) {
  return MEM_TITLE_KEYWORDS.some(w => new RegExp('\\b' + w + '\\b').test(title));
}

// Set words that double as a parallel finish ("Zebra Prizm" on a Select card)
// — useful as a positive match but never as grounds to exclude another set.
const NON_EXCLUSIVE_SETS = new Set(['prizm']);

// Brand families whose members share titles (Donruss Optic is one product),
// so finding one shouldn't exclude another in the same family.
const SET_FAMILIES = [['donruss', 'optic']];
function setFamilyOf(set) {
  const fam = SET_FAMILIES.find(f => f.includes(set));
  return fam || [set];
}

// Words that can never be a player's surname — used to keep the player
// predicate from latching onto a trailing keyword like "auto" or "silver".
const NON_NAME_WORDS = new Set(
  [...AUTO_TITLE_KEYWORDS, ...MEM_TITLE_KEYWORDS, ...PARALLEL_KEYWORDS, ...PARALLEL_COLORS,
   ...CARD_SET_NAMES, 'base', 'rc', 'rookie', 'sp', 'ssp', 'refractor', 'holo']
    .flatMap(w => w.split(/\s+/))
);

// Classify the search intent for autograph / memorabilia content.
// Returns 'both' | 'auto' | 'mem' | 'none'.
function classifyCardType(qLower) {
  const a = titleHasAuto(qLower);
  const m = titleHasMem(qLower);
  if (a && m) return 'both';
  if (a) return 'auto';
  if (m) return 'mem';
  return 'none';
}

// Break a query into structured keyword predicates. Each predicate is a
// { label, kind, test(title) } where `title` is a space-padded lowercase
// title. A listing "matches" the keyword when test() returns true.
function extractSearchKeywords(query) {
  const qLower = ' ' + String(query).toLowerCase().replace(/\s+/g, ' ').trim() + ' ';
  const predicates = [];

  // Print run (e.g. /50). Bounded so /50 never matches /500 or /150.
  const serial = extractSerial(query);
  if (serial) {
    const re = new RegExp('/\\s*' + serial + '(?![0-9])');
    predicates.push({ label: `/${serial}`, kind: 'printRun', test: t => re.test(t) });
  }

  // Grade (e.g. PSA 10, BGS 9.5). When graded, comps must carry the same grade.
  const gradeMatch = qLower.match(/\b(psa|bgs|sgc|cgc|hga|csg)\s*(\d+(?:\.\d+)?)\b/);
  let gradeCompany = '', gradeNum = '';
  if (gradeMatch) {
    gradeCompany = gradeMatch[1];
    gradeNum = gradeMatch[2];
    const gradeRe = new RegExp('\\b' + gradeCompany + '\\s*' + escapeRegexLiteral(gradeNum) + '\\b');
    predicates.push({ label: `${gradeCompany} ${gradeNum}`, kind: 'grade', test: t => gradeRe.test(t) });
  }

  // Year — substring match also catches "2017-18" style spans.
  const year = extractYear(query);
  if (year) predicates.push({ label: year, kind: 'year', test: t => t.includes(year) });

  // Set name (+ exclusivity: a Prizm search shouldn't return Optic). Two
  // brands in the same family (e.g. Donruss Optic) don't exclude each other,
  // and "weak" set words that double as a parallel finish (Prizm appears on
  // Select/Mosaic cards) never exclude anything.
  const queriedSets = CARD_SET_NAMES.filter(s => qLower.includes(s));
  if (queriedSets.length > 0) {
    const queriedFamily = new Set(queriedSets.flatMap(setFamilyOf));
    const excludedSets = CARD_SET_NAMES.filter(s =>
      !queriedSets.includes(s) && !NON_EXCLUSIVE_SETS.has(s) && !queriedFamily.has(s)
    );
    predicates.push({
      label: queriedSets.join('/'),
      kind: 'set',
      test: t => queriedSets.some(s => t.includes(s)) && !excludedSets.some(s => t.includes(s)),
    });
  }

  // Parallels / colors. A color carries exclusivity (silver ≠ gold); other
  // parallel effects are plain "must contain" keywords.
  const searchedColor = PARALLEL_COLORS.find(c => qLower.includes(c));
  const searchedParallels = PARALLEL_KEYWORDS.filter(p => qLower.includes(p));
  for (const p of searchedParallels) {
    if (p === searchedColor) continue; // handled by the color predicate below
    predicates.push({ label: p, kind: 'parallel', test: t => t.includes(p) });
  }
  if (searchedColor) {
    const otherColors = PARALLEL_COLORS.filter(c => c !== searchedColor);
    predicates.push({
      label: searchedColor,
      kind: 'color',
      test: t => t.includes(searchedColor) && !otherColors.some(c => t.includes(c)),
    });
  }

  // Explicit base search — exclude any parallel wording.
  const isBaseSearch = / base /.test(qLower);
  if (isBaseSearch && searchedParallels.length === 0) {
    predicates.push({ label: 'base', kind: 'base', test: t => !PARALLEL_KEYWORDS.some(p => t.includes(p)) });
  }

  // Auto / memorabilia intent.
  const cardType = classifyCardType(qLower);
  if (cardType === 'auto') {
    predicates.push({ label: 'auto', kind: 'type', test: t => titleHasAuto(t) });
  } else if (cardType === 'mem') {
    predicates.push({ label: 'mem', kind: 'type', test: t => titleHasMem(t) });
  } else if (cardType === 'both') {
    predicates.push({ label: 'auto+mem', kind: 'type', test: t => titleHasAuto(t) && titleHasMem(t) });
  } else {
    predicates.push({ label: 'no auto/mem', kind: 'type', test: t => !titleHasAuto(t) && !titleHasMem(t) });
  }

  // Player — match on the last name, the most stable token (robust to first
  // name spellings like "Ja'Marr" vs "Jamarr"). Strip trailing non-name words
  // (auto/patch/colors/parallels/sets) so the surname isn't mistaken for them.
  const player = extractPlayerName(query);
  const rawPlayerToks = player ? player.toLowerCase().split(' ').filter(w => w.length > 1) : [];
  const playerToks = rawPlayerToks.filter(w => !NON_NAME_WORDS.has(w));
  if (playerToks.length > 0) {
    const last = playerToks[playerToks.length - 1];
    predicates.push({ label: playerToks.join(' '), kind: 'player', test: t => t.includes(last) });
  }

  // Leftover meaningful tokens — anything the structured fields didn't consume
  // (e.g. a card number variant, an insert name) still has to be present.
  let leftover = qLower;
  if (serial) leftover = leftover.replace(/\/\s*\d{1,4}/g, ' ');
  if (gradeMatch) leftover = leftover.replace(/\b(psa|bgs|sgc|cgc|hga|csg)\s*\d+(?:\.\d+)?\b/g, ' ');
  if (year) leftover = leftover.replace(new RegExp('\\b' + year + '\\b', 'g'), ' ');
  for (const s of queriedSets) leftover = leftover.replace(new RegExp(escapeRegexLiteral(s), 'g'), ' ');
  for (const p of searchedParallels) leftover = leftover.replace(new RegExp('\\b' + escapeRegexLiteral(p) + '\\b', 'g'), ' ');
  leftover = leftover.replace(/\b(autograph|autographs|auto|signed|signature|sig|rpa|patch|relic|jersey|memorabilia|swatch|material|logoman|base)\b/g, ' ');
  for (const w of playerToks) leftover = leftover.replace(new RegExp('\\b' + escapeRegexLiteral(w) + '\\b', 'g'), ' ');
  const leftoverToks = leftover.split(/\s+/).filter(t => t.length > 1 && !VARIANT_STOP_WORDS.has(t));
  for (const tok of [...new Set(leftoverToks)]) {
    predicates.push({ label: tok, kind: 'token', test: t => t.includes(tok) });
  }

  return { predicates, cardType, serial, year, player };
}

// A "no auto/mem" or "base" keyword is a negative signal almost every listing
// satisfies — never keep a comp on one of those alone.
function isNegativeKeyword(p) {
  return (p.kind === 'type' && p.label === 'no auto/mem') || p.kind === 'base';
}

// Keep the sold listings that share the most keywords with the query.
// Returns { results, keywordsTotal, keywordsMatched, relaxedBy, searchType }.
//  - searchType 'exact'     : every keyword matched
//  - searchType 'relaxed'   : best tier was missing 1+ keywords
//  - searchType 'broadened' : couldn't even pin the player (eBay's own list)
//
// The player is an anchor: a comp for a different player is never useful, so we
// never relax it away. Everything else relaxes all-at-once-fewer: all → all but
// one → all but two …, and a listing is never kept on a negative keyword alone.
function matchSoldListings(results, query) {
  const { predicates } = extractSearchKeywords(query);
  const total = predicates.length;
  if (total === 0 || results.length === 0) {
    return { results, keywordsTotal: total, keywordsMatched: total, relaxedBy: 0, searchType: 'exact' };
  }

  const playerPred = predicates.find(p => p.kind === 'player');
  const rest = predicates.filter(p => p !== playerPred);
  const restTotal = rest.length;

  const scored = results.map(r => {
    const title = ' ' + String(r.title || '').toLowerCase().replace(/\s+/g, ' ') + ' ';
    const restMatched = rest.reduce((n, p) => n + (p.test(title) ? 1 : 0), 0);
    const restPositive = rest.reduce((n, p) => n + (!isNegativeKeyword(p) && p.test(title) ? 1 : 0), 0);
    const playerOk = playerPred ? playerPred.test(title) : true;
    return { r, restMatched, restPositive, playerOk };
  });

  // With a player keyword, every comp must be that player. Without one, we
  // require at least one positive (non-negative) keyword to match.
  const pool = scored.filter(s => s.playerOk);
  if (pool.length === 0) {
    return { results, keywordsTotal: total, keywordsMatched: 0, relaxedBy: total, searchType: 'broadened' };
  }

  const floor = playerPred ? 0 : 1;
  for (let k = restTotal; k >= floor; k--) {
    const keep = pool
      .filter(s => s.restMatched >= k && (playerPred || s.restPositive >= 1))
      .map(s => s.r);
    if (keep.length > 0) {
      const keywordsMatched = (playerPred ? 1 : 0) + k;
      const relaxedBy = total - keywordsMatched;
      return {
        results: keep,
        keywordsTotal: total,
        keywordsMatched,
        relaxedBy,
        searchType: relaxedBy <= 0 ? 'exact' : 'relaxed',
      };
    }
  }

  // Couldn't pin anything down — fall back to eBay's own results.
  return { results, keywordsTotal: total, keywordsMatched: 0, relaxedBy: total, searchType: 'broadened' };
}

// ---- Similar-card price estimate (print-run adjusted) ----
// Power-law scarcity exponent. Matches AP_SCARCITY_ALPHA (0.65) in app.js and
// the checklist value estimator, so the whole app values scarcity the same
// way: a scarcer print run is worth more, but sub-linearly (a /25 ≈ 2x a /99,
// not 4x).
const ESTIMATE_SCARCITY_ALPHA = 0.65;

// Effective print run assigned to UNNUMBERED cards (base / no serial) so the
// same power law produces a real multiplier between numbered and unnumbered
// comps instead of treating them as equal. Higher = unnumbered treated as more
// common (bigger gap to a numbered card). At 250, a /25 ≈ (250/25)^0.65 ≈ 4.5×
// an unnumbered copy. Tweak to taste.
const UNNUMBERED_EFFECTIVE_PR = 250;

// Neutralizer strength (0 = off → scale each comp independently like before;
// 1 = collapse every comp onto the group consensus). Comps rarely agree (a
// rarer /25 can sell for less than a /50 on a bad day); this pulls each comp's
// implied value toward the consensus of all the comps before scaling, so one
// off sale can't swing the estimate. 0.45 = a moderate pull.
const ESTIMATE_NEUTRALIZER = 0.45;

function medianOf(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return null;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

// The print run to value a comp/target at — its serial, or the unnumbered
// effective run when it isn't numbered.
function effectivePrintRun(pr) { return pr && pr > 0 ? pr : UNNUMBERED_EFFECTIVE_PR; }

// Parse the print-run denominator out of a listing title (server mirror of the
// frontend parsePrintRun). Handles "/99", "12/99" serial stamps, "1/1",
// "one of one", "numbered to 99". Skips season ranges like "2020/21".
function parsePrintRunFromTitle(title) {
  if (!title) return null;
  const s = String(title);
  const t = s.toLowerCase();
  if (/\b1\s*\/\s*1\b/.test(s) || /\b1\s*of\s*1\b/.test(t) || /\bone[-\s]of[-\s]one\b/.test(t)) return 1;
  const frac = s.match(/\b(\d{1,4})\s*\/\s*(\d{1,4})\b/);
  if (frac) {
    const num = parseInt(frac[1], 10), denom = parseInt(frac[2], 10);
    const looksLikeSeason = num >= 1900 && num <= 2099;
    if (!looksLikeSeason && denom >= 1 && denom <= 5000) return denom;
  }
  const m = s.match(/(?:numbered\s*(?:to\s*)?\/?|#\s*\/|\/)\s*(\d{1,4})\b/i);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n >= 1 && n <= 5000) return n;
  }
  return null;
}

// When a sold search finds NO sale of the exact card, estimate its value from
// sales of the SAME PLAYER's similar cards, adjusting each comp for the two
// things that move value most:
//   • print run — scaled by (compPR / targetPR)^0.65 (e.g. a /10 estimated
//     from a /25), and
//   • set       — scaled by tier(targetSet)/tier(compSet) so an unnumbered or
//     cross-set comp from a cheaper set (Score) is lifted toward a pricier one
//     (National Treasures), and vice-versa.
// The player is always the anchor — a comp for a different player is never used,
// honoring "only include it if it has the same name as the search". Uses the
// 3–5 comps needing the smallest adjustment (closest to the target). Returns
// null when there's no player to anchor on or no usable comps.
function buildSimilarCardEstimate(query, results) {
  if (!Array.isArray(results) || results.length === 0) return null;

  const pad = r => ' ' + String(r.title || '').toLowerCase().replace(/\s+/g, ' ') + ' ';
  const { predicates } = extractSearchKeywords(query);
  const playerPred = predicates.find(p => p.kind === 'player');
  if (!playerPred) return null; // no name to anchor → don't estimate from noise

  // Prefer comps that match the whole card except the print run (same set,
  // parallel, grade…). If that's empty, relax to the player anchor so we can
  // still estimate across print runs / sets. Never relax past the player.
  const nonPR = predicates.filter(p => p.kind !== 'printRun' && !isNegativeKeyword(p));
  let pool = results.filter(r => { const t = pad(r); return nonPR.every(p => p.test(t)); });
  let crossCard = false;
  if (pool.length === 0) { pool = results.filter(r => playerPred.test(pad(r))); crossCard = true; }
  if (pool.length === 0) return null;

  const serial = extractSerial(query);
  const targetPR = parseInt(serial, 10) > 0 ? parseInt(serial, 10) : null;
  const targetEffPR = effectivePrintRun(targetPR);
  const targetSet = detectSetTier(query);

  // Score each comp: bring its price onto the target SET's value level, note its
  // (effective) print run, and measure how much adjusting it would take so the
  // closest comps sort first.
  const scored = pool.map(r => {
    const price = parseFloat(r.price);
    if (!(price > 0)) return null;
    const compPR = parsePrintRunFromTitle(r.title);
    const compSet = detectSetTier(r.title);
    const compEffPR = effectivePrintRun(compPR);

    let setMult = 1;
    if (targetSet && compSet && compSet.name !== targetSet.name) {
      setMult = clampNum(targetSet.tier / compSet.tier, 0.2, 5);
    }
    // Raw scarcity multiplier (pre-neutralizer), clamped, for sorting + display.
    const prMult = clampNum(Math.pow(compEffPR / targetEffPR, ESTIMATE_SCARCITY_ALPHA), 0.1, 15);
    const setPrice = price * setMult;                  // price at the target set's level
    const scale = setPrice * Math.pow(compEffPR, ESTIMATE_SCARCITY_ALPHA); // implied "price @ /1"
    return { r, price, compPR, compSet, compEffPR, setMult, prMult, setPrice, scale, dist: Math.abs(Math.log(prMult * setMult)) };
  }).filter(Boolean);
  if (scored.length === 0) return null;

  scored.sort((a, b) => a.dist - b.dist);
  const chosen = scored.slice(0, 5);

  // Neutralizer: derive a consensus price level from all chosen comps and pull
  // each comp's implied scale toward it (geometric blend) before valuing at the
  // target print run. This stops a single low/high sale (e.g. a /25 that sold
  // under a /50) from dictating the estimate.
  const consensusScale = medianOf(chosen.map(c => c.scale));
  const s = ESTIMATE_NEUTRALIZER;
  const targetFactor = Math.pow(targetEffPR, ESTIMATE_SCARCITY_ALPHA);

  const comps = chosen.map(c => {
    const neutralizedScale = Math.pow(consensusScale, s) * Math.pow(c.scale, 1 - s);
    const adjustedPrice = neutralizedScale / targetFactor;
    return {
      title: c.r.title,
      soldPrice: c.price,
      printRun: c.compPR,
      setName: c.compSet ? c.compSet.name : null,
      prMultiplier: c.prMult,
      setMultiplier: c.setMult,
      multiplier: adjustedPrice / c.price,
      adjustedPrice,
      rarer: (targetPR && c.compPR) ? c.compPR > targetPR : null,
      soldDate: c.r.soldDate,
      imageUrl: c.r.imageUrl,
      itemUrl: c.r.itemUrl,
      condition: c.r.condition,
    };
  });

  const adj = comps.map(c => c.adjustedPrice).sort((a, b) => a - b);
  const median = medianOf(adj);

  return {
    value: median,
    low: adj[0],
    high: adj[adj.length - 1],
    targetPrintRun: targetPR,
    targetSet: targetSet ? targetSet.name : null,
    sampleSize: comps.length,
    alpha: ESTIMATE_SCARCITY_ALPHA,
    neutralized: s > 0 && comps.length > 1,
    crossCard,
    adjustedForPrintRun: comps.some(c => Math.abs(c.prMultiplier - 1) > 0.01),
    adjustedForSet: comps.some(c => Math.abs(c.setMultiplier - 1) > 0.01),
    comps,
  };
}

// Whether a result set contains a sale of the EXACT card searched — a listing
// that matches every positive keyword (player, year, set, parallel, print run,
// grade, …). When false, the caller falls back to a similar-card estimate.
function hasExactCardSales(query, results) {
  const { predicates } = extractSearchKeywords(query);
  const positive = predicates.filter(p => !isNegativeKeyword(p));
  if (positive.length === 0) return true;
  return (results || []).some(r => {
    const t = ' ' + String(r.title || '').toLowerCase().replace(/\s+/g, ' ') + ' ';
    return positive.every(p => p.test(t));
  });
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

  const GRADING_COST = { economy: 25, express: 50 };

  try {
    const baseQ = query.trim();
    // Grade comes from the provider's structured grader/grade filters rather
    // than hoping "PSA 10" shows up in the listing title — and `graded: false`
    // gives a genuinely raw pool instead of "the query minus a grade word".
    const [rawData, psa8Data, psa9Data, psa10Data] = await Promise.all([
      fetchEbayItems(baseQ, 20, 'sold', 'grading-raw',   0, { graded: false }),
      fetchEbayItems(baseQ, 20, 'sold', 'grading-psa8',  0, { grader: 'PSA', grade: '8' }),
      fetchEbayItems(baseQ, 20, 'sold', 'grading-psa9',  0, { grader: 'PSA', grade: '9' }),
      fetchEbayItems(baseQ, 20, 'sold', 'grading-psa10', 0, { grader: 'PSA', grade: '10' }),
    ]);
    if (sendIfSoldBlocked(res, rawData, psa8Data, psa9Data, psa10Data)) return;

    // Variant-strict filter so each grade's comps reflect the actual card
    // searched (excludes wrong colors, wrong sets, autos/relics not asked for).
    const filterFor = (items) => filterPriceOutliers(filterByVariant(items, baseQ));
    const rawItems   = filterFor(rawData.results);
    const psa8Items  = filterFor(psa8Data.results);
    const psa9Items  = filterFor(psa9Data.results);
    const psa10Items = filterFor(psa10Data.results);

    const summarize = (items, label) => {
      const v = computeApproxValue(items, label);
      return v ? { avg: v.avgPrice, median: v.medianPrice, min: v.priceRange.min, max: v.priceRange.max, sales: v.sampleSize } : null;
    };

    const raw   = summarize(rawItems,   'Raw');
    const psa8  = summarize(psa8Items,  'PSA 8');
    const psa9  = summarize(psa9Items,  'PSA 9');
    const psa10 = summarize(psa10Items, 'PSA 10');

    // Grade premium over the raw median, net of grading cost.
    const calcPremium = (graded, rawVal) => {
      if (!graded || !rawVal) return null;
      const net = graded.median - rawVal.median - GRADING_COST.economy;
      return { gross: graded.median - rawVal.median, net, worthIt: net > 0 };
    };

    // Return the comps behind each grade so the UI can show exactly which sold
    // listings drove the recommendation. Trimmed to keep the payload small.
    const trimComps = (items) => (items || []).slice(0, 24).map(it => ({
      title: it.title,
      price: it.price,
      itemUrl: it.itemUrl,
      imageUrl: it.imageUrl,
      soldDate: it.soldDate,
      condition: it.condition,
    }));

    res.json({
      query: baseQ,
      grades: { raw, psa8, psa9, psa10 },
      premiums: {
        psa8:  calcPremium(psa8,  raw),
        psa9:  calcPremium(psa9,  raw),
        psa10: calcPremium(psa10, raw),
      },
      gradingCost: GRADING_COST,
      comps: {
        raw:   trimComps(rawItems),
        psa8:  trimComps(psa8Items),
        psa9:  trimComps(psa9Items),
        psa10: trimComps(psa10Items),
      },
    });
  } catch (err) {
    console.error('Grading advisor error:', err.message);
    res.status(500).json({ error: 'Failed to fetch grading data', detail: err.message });
  }
});

// ---- /api/direct-search ----
// Primary search endpoint for the main Search button. For Sale mode runs live
// off the eBay Browse API; Sold mode runs off The Card API.
app.get('/api/direct-search', async (req, res) => {
  const query = req.query.q;
  const mode = req.query.mode === 'sold' ? 'sold' : 'forsale';
  const minPrice = parseFloat(req.query.minPrice);
  const maxPrice = parseFloat(req.query.maxPrice);
  const applyPriceFilter = (items) => filterByPriceRange(items, minPrice, maxPrice);
  // Mirror /api/search: For Sale results get the strict variant filter so the
  // user only sees listings that actually match the searched card.
  const applyVariantFilter = (items) => filterByVariant(items, query, { strict: true });
  if (!query || query.trim().length < 2) {
    return res.status(400).json({ error: 'Query parameter "q" is required (min 2 chars)' });
  }

  if (mode === 'sold' ? USE_MOCK_SOLD : USE_MOCK_FORSALE) {
    return res.json(getMockDirectSearch(query, mode));
  }

  try {
    const serial = extractSerial(query);

    // ---- Sold mode (The Card API) ----
    if (mode === 'sold') {
      const searchData = await fetchEbayItems(query, 50, mode, 'direct-search', 0);
      if (searchData.soldUnavailable) return sendSoldUnavailable(res);
      if (searchData.rateLimited) {
        return res.json({
          results: [], total: 0, mock: false, mode, serial: serial || null, similarResults: [],
          searchType: 'exact', broadenedQuery: null, approximateValue: null,
          rateLimited: true, rateLimitMessage: searchData.rateLimitMessage,
        });
      }
      const variantFiltered = filterPriceOutliers(filterByVariant(searchData.results, query));
      const approx = variantFiltered.length > 0 ? computeApproxValue(variantFiltered, query) : null;
      // No sale of the exact card? Estimate from the same player's similar
      // sales, adjusted for print run and set (see /api/search).
      const estimate = hasExactCardSales(query, searchData.results)
        ? null
        : buildSimilarCardEstimate(query, searchData.results);
      return res.json({
        results: variantFiltered, total: variantFiltered.length, mock: false,
        searchType: 'exact', broadenedQuery: null, approximateValue: approx,
        estimate, mode, serial: serial || null, similarResults: [],
      });
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

      // Return exact matches first, then similar (price + strict variant filter applied)
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
// The main Search button hits this to group listings into card variants.
// For Sale mode runs live off the eBay Browse API; Sold mode runs off
// The Card API. The variant grouping itself is identical for both.
app.get('/api/variants', async (req, res) => {
  const query = req.query.q;
  const mode = req.query.mode === 'sold' ? 'sold' : 'forsale';
  const minPrice = parseFloat(req.query.minPrice);
  const maxPrice = parseFloat(req.query.maxPrice);
  if (!query || query.trim().length < 2) {
    return res.status(400).json({ error: 'Query parameter "q" is required (min 2 chars)' });
  }

  if (mode === 'sold' ? USE_MOCK_SOLD : USE_MOCK_FORSALE) {
    return res.json(getMockVariants(query, mode));
  }

  try {
    // Extract serial number (e.g. /5 = print run of 5)
    const serial = extractSerial(query);
    const baseQuery = serial ? query.replace(/\/\d{1,4}/, '').replace(/\s+/g, ' ').trim() : query;

    let rawResults;
    // Sold: one call covers it. The provider strips the serial before querying,
    // so the targeted and broad legs below would send identical requests — and
    // in parallel neither warms the cache for the other, so both get billed.
    if (serial && mode === 'sold') {
      const one = await fetchEbayItems(baseQuery, 50, mode, 'variants-serial', 0);
      if (sendIfSoldBlocked(res, one)) return;
      rawResults = one.results;
    } else if (serial) {
      // Dual search when serial present: targeted + broad for better coverage
      const [targeted, broad] = await Promise.all([
        fetchEbayItems(`${baseQuery} /${serial}`, 50, mode, 'direct-search-serial'),
        fetchEbayItems(baseQuery, 50, mode, 'direct-search-serial-broad'),
      ]);
      // Either leg may come back flagged (no key / daily cap) instead of with
      // results — surface that rather than rendering an empty variant grid.
      const flagged = [targeted, broad].find(r => r.soldUnavailable || r.rateLimited);
      if (flagged) {
        if (flagged.soldUnavailable) return sendSoldUnavailable(res);
        return res.json({ variants: [], mock: false, mode, serial: serial || null, rateLimited: true, rateLimitMessage: flagged.rateLimitMessage });
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
      if (result.soldUnavailable) return sendSoldUnavailable(res);
      if (result.rateLimited) {
        return res.json({ variants: [], mock: false, mode, serial: null, rateLimited: true, rateLimitMessage: result.rateLimitMessage });
      }
      rawResults = result.results;
    }
    // Drop listings outside the user's price range before grouping into variants
    rawResults = filterByPriceRange(rawResults, minPrice, maxPrice);
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



// ---- /api/market-index ----
// A single number for "how is the football-card market doing right now",
// built from the two things the dataset can measure honestly: how much money
// changed hands, and how many cards changed hands.
//
// The score is an INDEX, not an absolute rating: 100 means the window matches
// the equivalent window immediately before it. 115 means the market moved 15%
// above its own recent pace. An absolute 0-100 rating would need a fixed
// anchor, and any anchor we picked would drift as the dataset grows — an index
// re-bases itself every day and can't be inflated by simply collecting more.
//
//   score = 100 * (Wd * (dollars_now / dollars_prev) + Wu * (units_now / units_prev))
//
// Weights are deliberate. Dollars carry more (0.6) because "the market" in a
// collector's sense is where money moves, but they're heavy-tailed — one
// six-figure sale can swing a day — so unit count acts as ballast (0.4): it
// tracks participation, which moves slowly and is hard to distort. Both
// components are returned so a move can always be attributed to one or other
// rather than taken on faith.
//
// Reads the pre-aggregated `daily` table only (one row per day), so this stays
// cheap no matter how many millions of sales sit behind it.
const MARKET_PERIODS = [7, 30, 90];
const MARKET_TTL = 3600; // 1h — identical for every visitor
// The most recent day in the table is usually still being collected, and a
// half-collected day reads as a crash. Anchor one day back so every window is
// made of complete days.
const MARKET_EXCLUDE_TRAILING_DAYS = 1;

// Whole days since epoch — integer day arithmetic, no timezone drift.
function _mkDay(iso) { return Math.floor(Date.parse(String(iso).slice(0, 10) + 'T00:00:00Z') / 86400000); }
function _mkIso(day) { return new Date(day * 86400000).toISOString().slice(0, 10); }

// ---- Paired-sales price index -----------------------------------------------
// Card Ladder's published equation is: sum every card's last sold price,
// divide by the number of cards, normalise to 1000. Their good idea is
// carry-forward — a card that has ever sold has a value, so every sale becomes
// a usable observation and the index does not need a card to sell twice inside
// the window. That matters here: only 13% of cards in this dataset resell
// within 30 days.
//
// Four things in that equation are wrong for this data, and this fixes each:
//
//   1. PRICE-WEIGHTED. Summing dollars means a $50,000 card counts ten
//      thousand times a $5 card, so the index is really tracking a handful of
//      expensive cards. Here every observation counts once, so the number is a
//      typical card's move, not the top card's move.
//
//   2. TIME MIS-ATTRIBUTED. Their index applies the whole change since a card
//      last sold on the day it resells. A card quiet for 200 days that comes
//      back 50% higher is not a 50% market move that day. Each observation is
//      converted to a per-day rate over its own gap and rescaled to the bucket,
//      which is why the raw ratios below converge once normalised.
//
//   3. MEAN, AND A SAMPLE OF ONE. They average a card's same-day sales, so one
//      shill or fat-fingered sale sets its value until it next trades. Medians
//      throughout, and ratios outside a sane band are dropped before the median
//      is taken.
//
//   4. UNBOUNDED STALENESS. Nothing stops a years-old price being carried as
//      though current. Priors older than the lookback are ignored.
//
// Card Ladder can afford (1) and (3) because a research team vets their sales
// by hand. These inputs are unvetted listing parses, so the robustness has to
// be in the maths.
//
// COST OF THE COMPUTATION. The median is taken in SQL and one row comes back
// per bucket — about a dozen rows, whatever the dataset size. An earlier
// version shipped raw sales to the Worker and grouped them in JavaScript,
// which tripped the CPU limit; this cannot.
// Chart points across the period, and the floor on how wide a bucket may be.
const RSI_TARGET_POINTS = 10;
const RSI_MIN_BUCKET_DAYS = 7;
// A prior sale older than this is too stale to compare against, even after
// time-normalising: the card may be a different thing by then (re-grade,
// re-slab, market regime change).
const RSI_MAX_GAP_DAYS = 180;
// Ratios outside this band are mis-keyed rows, not price moves.
const RSI_RATIO_FLOOR = 0.25;
const RSI_RATIO_CEIL = 4;
// Guard against a single observation whose gap is so short that rescaling it
// to a bucket explodes it. One day of gap rescaled to a 7-day bucket is a
// seventh power; clamp what any one bucket may contribute.
const RSI_BUCKET_MOVE_FLOOR = 0.5;
const RSI_BUCKET_MOVE_CEIL = 2;

// How many of the 125 basket players must report in a bucket for that step to
// count. Relaxed in turn so a quiet week degrades rather than disappears.
const RSI_TIERS = [
  { label: 'strict', minPlayers: 30 },
  { label: 'wider',  minPlayers: 15 },
  { label: 'widest', minPlayers: 6  },
];
// Scoped to one player the contributors are that player's cards, of which
// there are at most MARKET_CARDS_PER_PLAYER, so the market's gates would never
// be met however healthy the data.
const RSI_TIERS_PLAYER = [
  { label: 'strict', minPlayers: 5 },
  { label: 'wider',  minPlayers: 3 },
  { label: 'widest', minPlayers: 2 },
];

// Normalise a key column inside SQL, so the grouping that builds the index
// treats spelling variants of one card as that card.
//
// The player column carries 96,445 distinct values across 297,027 sales, about
// fifteen times the number of footballers who appear on cards, because it is
// parsed out of listing titles. Every variant splits one real card into several
// that can never pair, which is the largest constraint on the index's sample.
//
// This is deliberately mechanical — case, punctuation and whitespace only. It
// cannot repair a value that is not a name at all; that needs a roster match,
// which is a separate change.
//
// Generational suffixes are NOT stripped. Removing them would merge Marvin
// Harrison Jr with Marvin Harrison Sr, and Odell Beckham Jr with his father —
// different players with separate markets. Dropping punctuation already folds
// "Jr." and "JR" onto "jr", which is the variance worth collapsing; the suffix
// itself is identity.
function _normCol(col) {
  // COALESCE first, and it is load-bearing. REPLACE(NULL, ...) is NULL in
  // SQLite, and the card key concatenates six of these — so one NULL column
  // makes the whole key NULL, and NULL = NULL is false, so every join on it
  // matches nothing. It took the market index off the site: raw cards are
  // exactly the rows where grader and grade are NULL, so the moment the index
  // stopped looking at slabs, every surviving row had a NULL key.
  let e = `COALESCE(${col}, '')`;
  for (const ch of ["''", '.', ',', '"', '`', '’', '-']) e = `REPLACE(${e}, '${ch}', '')`;
  e = `LOWER(TRIM(${e}))`;
  for (let i = 0; i < 4; i++) e = `REPLACE(${e}, '  ', ' ')`;
  return `TRIM(${e})`;
}

// ---- Canonical player names, applied in SQL ----
//
// The dictionary in card-index.js can merge 80 spellings of Tom Brady into one
// player, but the index groups inside SQL over hundreds of thousands of rows,
// and a resolver written in JavaScript cannot reach in there. So the mapping is
// materialised: one small table, variant string in, canonical name out, joined
// on the same normalised key the index already computes.
//
// This is the only thing in this app that writes to NFLDB. It is strictly
// additive — it creates its own table and never touches `sales`.
//
// The safety property that matters: an EMPTY alias table must not take the
// index down. That is exactly how the NULL-key bug played out, and an inner
// join against a table the backfill has not filled yet would reproduce it
// precisely. So the index asks whether the table is populated first and keeps
// its old behaviour until it is. The table earns its way in.
const ALIAS_TABLE = 'player_alias';
const ALIAS_BACKFILL_BATCH = 1200;  // variants resolved per cron run
// Coverage, not a row count. The join is an inner one, so a name with no alias
// row drops out of the index entirely — grouping on a half-filled table would
// not break the index, it would quietly shrink the market to whatever had been
// processed so far, which is worse because nothing looks wrong.
//
// Measured over SALES, not distinct names, and now only a "is this worth
// joining against" gate rather than a correctness threshold.
//
// It was 95% when the join was an inner one, because anything less silently
// shrank the market. Two corrections later: counting distinct names was wrong
// (106,074 of them, nearly all junk that traded once), and then sales-weighting
// turned out not to help much either, because 95% of sales is deep enough into
// a tail averaging 1.4 sales per name that it converges with name coverage — 20
// hours either way. The fix was the join, not the measure. With a fallback to
// the raw name, any coverage at all is an improvement, so this just avoids
// paying for a join that would do almost nothing.
const ALIAS_MIN_COVERAGE = 0.25;
const ALIAS_MIN_ROWS = 25;          // guards the degenerate 0-of-0 case
const ALIAS_WINDOW_DAYS = 400;      // how far back to look for names to resolve
const ALIAS_READY_TTL = 300;        // 5 min — the readiness check is cached

let _aliasTableReady = null;        // null = unknown, false = cannot write
async function _aliasEnsure(db) {
  if (_aliasTableReady !== null) return _aliasTableReady;
  try {
    await db.prepare(
      `CREATE TABLE IF NOT EXISTS ${ALIAS_TABLE} (
         variant   TEXT PRIMARY KEY,
         canonical TEXT NOT NULL,
         display   TEXT NOT NULL,
         how       TEXT,
         resolved  INTEGER NOT NULL DEFAULT 1,
         n         INTEGER,
         updated_at TEXT
       )`).run();
    _aliasTableReady = true;
  } catch (err) {
    // A read-only binding, or a database we may not alter. Say so once and
    // leave the index on its old path rather than failing every request.
    console.error('[alias] table unavailable, index will not use it:', err && err.message);
    _aliasTableReady = false;
  }
  return _aliasTableReady;
}

// Resolve the busiest player strings that have no alias row yet, and record
// them — including the ones that resolve to nothing, so they are not
// reconsidered on every run. Time-boxed by row count, not by clock: the cron
// fires every 15 minutes and the head of the distribution is covered in the
// first few passes.
async function backfillPlayerAliases({ limit = ALIAS_BACKFILL_BATCH } = {}) {
  const db = getNflDb();
  if (!db) return { ok: false, reason: 'no dataset' };
  if (!await _aliasEnsure(db)) return { ok: false, reason: 'table unavailable' };

  const P = _normCol('player');
  const since = _mkIso(_mkDay(new Date().toISOString()) - ALIAS_WINDOW_DAYS);
  let rows;
  try {
    rows = await db.prepare(
      `SELECT ${P} AS v, COUNT(*) AS n
         FROM sales s
        WHERE s.player IS NOT NULL AND s.player <> '' AND ${P} <> ''
          AND s.sold_date > ?
          AND NOT EXISTS (SELECT 1 FROM ${ALIAS_TABLE} a WHERE a.variant = ${P})
        GROUP BY v
        ORDER BY n DESC
        LIMIT ?`
    ).bind(since, limit).all();
  } catch (err) {
    console.error('[alias] backfill query failed:', err && err.message);
    return { ok: false, reason: 'query failed' };
  }

  const list = (rows && rows.results) || [];
  if (!list.length) return { ok: true, done: true, inserted: 0 };

  const now = new Date().toISOString();
  const stmts = [];
  let resolved = 0;
  for (const r of list) {
    const hit = resolvePlayer(r.v);
    // Unresolved variants are still recorded, mapped to themselves. Without a
    // row they would be re-resolved every run forever, and the index needs to
    // be able to tell "no player in this string" from "not looked at yet".
    const ok = !!(hit && hit.confident);
    if (ok) resolved++;
    stmts.push(db.prepare(
      `INSERT OR REPLACE INTO ${ALIAS_TABLE}
         (variant, canonical, display, how, resolved, n, updated_at)
       VALUES (?,?,?,?,?,?,?)`
    ).bind(r.v, ok ? hit.key : r.v, ok ? hit.canonical : r.v,
           hit ? hit.how : 'none', ok ? 1 : 0, r.n, now));
  }

  // Chunked. D1 caps how much one batch may carry, and a single oversized call
  // fails whole rather than partially — which would mean the table never fills
  // and the index never switches, with one log line to show for it.
  const CHUNK = 50;
  let written = 0;
  try {
    for (let i = 0; i < stmts.length; i += CHUNK) {
      const slice = stmts.slice(i, i + CHUNK);
      if (typeof db.batch === 'function') await db.batch(slice);
      else for (const st of slice) await st.run();
      written += slice.length;
    }
  } catch (err) {
    // Partial progress is kept: every chunk already written stays, and the next
    // run picks up from there because the query skips variants that have a row.
    console.error(`[alias] write failed after ${written}/${stmts.length}:`, err && err.message);
    return { ok: false, reason: 'write failed', written };
  }
  console.log(`[alias] +${written} variants (${resolved} resolved)`);
  return { ok: true, inserted: written, resolved };
}

// Is the table filled enough to group on? Cached, because every index build
// would otherwise pay for the check.
async function _aliasReady(db) {
  const cached = await cacheGet('aliasready:v2');
  if (cached && typeof cached.ready === 'boolean') return cached.ready;
  if (_aliasTableReady === false) return false;
  const P = _normCol('player');
  const since = _mkIso(_mkDay(new Date().toISOString()) - ALIAS_WINDOW_DAYS);
  let ready = false, rows = 0, covered = 0, total = 0;
  try {
    const r = await db.prepare(
      `SELECT (SELECT COUNT(*) FROM ${ALIAS_TABLE})   AS rows_,
              (SELECT COALESCE(SUM(n), 0) FROM ${ALIAS_TABLE}) AS covered,
              (SELECT COUNT(*) FROM sales
                WHERE player IS NOT NULL AND player <> '' AND sold_date > ?) AS total`
    ).bind(since).first();
    rows = (r && r.rows_) || 0;
    covered = (r && r.covered) || 0;
    total = (r && r.total) || 0;
    ready = rows >= ALIAS_MIN_ROWS && total > 0 && (covered / total) >= ALIAS_MIN_COVERAGE;
  } catch (_) {
    ready = false;   // table not created yet — old path, no error to the reader
  }
  cachePut('aliasready:v2', { ready, rows, covered, total }, ALIAS_READY_TTL);
  return ready;
}

// Progress and effect of the alias table, for watching the backfill ramp and
// for confirming the index actually switched over.
app.get('/api/debug/alias-status', async (req, res) => {
  const db = getNflDb();
  if (!db) return res.json({ available: false, reason: 'no dataset' });
  const P = _normCol('player');
  const since = _mkIso(_mkDay(new Date().toISOString()) - ALIAS_WINDOW_DAYS);

  // Create the table here too. Querying a table that may not exist yet made
  // this endpoint report a raw SQL error, which reads as "the write was
  // refused" when the real answer was "the cron has not run". Creating it is
  // idempotent, so the diagnostic can answer the question it was built for.
  const canWrite = await _aliasEnsure(db);
  if (!canWrite) {
    return res.json({
      available: false,
      reason: 'cannot create the alias table — the D1 binding may be read-only',
      indexIsUsingIt: false,
    });
  }
  // ?run=1 fills a batch on demand rather than waiting for the next cron tick.
  let ran = null;
  const wantRun = req.query.run != null && !['0', 'false', ''].includes(String(req.query.run));
  if (wantRun) ran = await backfillPlayerAliases({ limit: ALIAS_BACKFILL_BATCH });

  try {
    const cov = await db.prepare(
      `SELECT (SELECT COUNT(*) FROM ${ALIAS_TABLE}) AS have,
              (SELECT COUNT(*) FROM ${ALIAS_TABLE} WHERE resolved = 1) AS resolved,
              (SELECT COALESCE(SUM(n), 0) FROM ${ALIAS_TABLE}) AS covered,
              (SELECT COUNT(*) FROM sales
                WHERE player IS NOT NULL AND player <> '' AND sold_date > ?) AS total,
              (SELECT COUNT(DISTINCT ${P}) FROM sales
                WHERE player IS NOT NULL AND player <> '' AND sold_date > ?) AS want`
    ).bind(since, since).first();
    const top = await db.prepare(
      `SELECT display, COUNT(*) AS spellings, SUM(n) AS sales
         FROM ${ALIAS_TABLE} WHERE resolved = 1
        GROUP BY canonical ORDER BY spellings DESC LIMIT 15`).all();
    const have = (cov && cov.have) || 0, want = (cov && cov.want) || 0;
    const covered = (cov && cov.covered) || 0, total = (cov && cov.total) || 0;
    const share = total ? covered / total : 0;
    res.json({
      available: true,
      state: have === 0 ? 'table created, empty — run with ?run=1 or wait for the cron'
           : share < ALIAS_MIN_COVERAGE ? 'filling — index still on raw names'
           : 'in use, still filling — merges apply as names are reached',
      requestedRun: req.query.run == null ? null : String(req.query.run),
      ranNow: ran,
      coverage: {
        // What the switchover is judged on: the share of SALES whose name has
        // an alias row. Names are reported too, but only for context — most of
        // the 100k+ distinct strings are junk that traded once.
        salesCovered: covered, salesInWindow: total,
        share: total ? Math.round(share * 1000) / 10 + '%' : null,
        neededToStart: Math.round(ALIAS_MIN_COVERAGE * 100) + '%',
        aliasRows: have, resolvedRows: (cov && cov.resolved) || 0,
        distinctNamesInWindow: want,
      },
      indexIsUsingIt: await _aliasReady(db),
      biggestMerges: ((top && top.results) || [])
        .map(r => ({ player: r.display, spellings: r.spellings, sales: r.sales })),
    });
  } catch (err) {
    res.json({ available: false, error: err && err.message });
  }
});

// The card identity used by every index query. Normalised so that grouping is
// done on the cleaned form rather than the raw text.
const RSI_KEY_COLS = ['year', 'set_name', 'player', 'parallel', 'grader', 'grade'];
const RSI_KEY_SQL = RSI_KEY_COLS.map(_normCol).join(', ');
// The card key, with the player component swappable. When the alias table is
// in play the canonical name goes in that slot, which is the whole point: two
// spellings of one player stop being two different cards.
function _cardKeySql(playerExpr) {
  return RSI_KEY_COLS
    .map(c => (c === 'player' ? playerExpr : _normCol(c)))
    .join(" || '|' || ");
}

// The index measures raw (ungraded) cards only.
//
// The trap, already documented on _gradeBucket: an empty grade column does NOT
// mean raw. It means the collector's parser found no grade, which happens for
// genuinely raw cards AND for slabs whose titles it couldn't read. Filtering on
// `grade IS NULL` alone would therefore leave slab money in the raw series —
// precisely what this filter exists to keep out — so the title is checked for
// grader and slab language too. This mirrors _gradeBucket exactly, including
// that an explicit "raw"/"ungraded" claim outranks a stray grader mention
// ("raw, PSA 10 candidate"), so the index agrees with the grade breakdown the
// rest of the site shows.
// This predicate runs on every priced sale in the window, so it is built from
// plain substring LIKEs over one LOWER() and nothing else. A first version did
// proper word matching — separators flattened and the title padded so '% psa %'
// could not match inside a word — and it took the 90-day index from 950ms to
// 1,972ms against a 2,000ms Worker budget. Correct, and unshippable.
//
// What makes substring matching safe here is the choice of tokens: every one
// below is a string that does not occur inside an ordinary word in a card
// title. The graders that DO collide are deliberately absent — 'isa' sits
// inside "Isaiah", 'tag' inside "vintage", 'ags' inside "flags" — because
// matching those would throw away real raw sales of real players, and ISA, TAG
// and AGS together slab a rounding error of the football market.
const RSI_GRADER_WORDS = ['psa', 'bgs', 'bccg', 'beckett', 'sgc', 'cgc', 'csg',
                          'hga', 'ksa', 'gma', 'rcg', 'mnt'];
const RSI_SLAB_WORDS = ['slab', 'encapsulated', 'cert'];

// Where the errors land is a deliberate choice. Dropping a genuinely raw sale
// costs a little sample out of thousands; admitting one slab puts graded money
// in a raw series, which is the whole thing being avoided. So the filter is
// conservative: _gradeBucket's rule that an explicit "raw" claim outranks a
// grader mention is NOT reproduced here, and a listing reading "raw, PSA 10
// candidate" is excluded rather than trusted.
// What a grader or grade column looks like when the card was never graded.
// Empty is the convention this was first written against, but a collector can
// just as reasonably write "Raw" or "None", and assuming one convention means
// matching NOTHING under the other — which does not degrade the index, it takes
// it off the page entirely. Accepting both costs nothing: no value here can
// belong to a slab.
const RSI_UNGRADED_VALUES = ['', 'raw', 'none', 'ungraded', 'not graded', 'n/a', 'na', '-', '--'];
function _rsiUngradedCol(col) {
  const v = `LOWER(COALESCE(TRIM(${col}), ''))`;
  return `${v} IN (${RSI_UNGRADED_VALUES.map(x => `'${x}'`).join(', ')})`;
}

function _rsiRawOnlySql(titleCol = 'title') {
  const T = `LOWER(COALESCE(${titleCol}, ''))`;
  const any = (words) => words.map(w => `${T} LIKE '%${w}%'`).join(' OR ');
  return `
          AND ${_rsiUngradedCol('grade')}
          AND ${_rsiUngradedCol('grader')}
          AND NOT ( ${any(RSI_GRADER_WORDS)}
                 OR ${any(RSI_SLAB_WORDS)}
                 -- "graded" minus the two words that contain it. Cheaper than
                 -- padding the title, and "ungraded" is a raw claim, not a slab.
                 OR ( ${T} LIKE '%graded%'
                      AND ${T} NOT LIKE '%ungraded%'
                      AND ${T} NOT LIKE '%upgraded%' ) )`;
}
const RSI_RAW_ONLY = _rsiRawOnlySql();

function _rsiGeometry(days) {
  const bucketDays = Math.max(RSI_MIN_BUCKET_DAYS, Math.round(days / RSI_TARGET_POINTS));
  const points = Math.max(1, Math.round(days / bucketDays));
  return { bucketDays, points, spanDays: (points + 1) * bucketDays };
}

// Every sale paired with that card's previous sale at ANY earlier date, then
// reduced to one row per bucket: the median price ratio, the median gap those
// ratios were measured over, and how many observations stand behind them.
//
// The median is computed by ranking and taking the middle row(s), because
// SQLite has no percentile function. Only arithmetic, julianday and window
// functions are used — no math extensions, which may not be present on D1.
// The exponentiation happens in JavaScript on a dozen rows.
// The basket. Rather than every card that ever traded, the index tracks the
// cards that actually carry the market: the busiest players, and within each,
// the handful of cards of theirs that trade most — in practice their base
// rookie, the Prizm/Silver, and a few close variants. Both lists are chosen by
// sales volume rather than hand-picked, so the basket maintains itself as
// players rise and fade, and the pick can never reflect an opinion.
//
// This replaces an index computed over every card in the dataset. That version
// was dominated by the long tail: 200,115 distinct cards from 297,027 sales,
// most of them commons that trade once. Their prices are noisy and nobody
// tracks them, so they added variance without adding signal.
// 600 players, not 125, and the number was measured rather than picked. Against
// a flat market — true prices that never move, sales priced with lognormal noise
// because raw comps carry real condition variance — the index should read 0%.
// What it actually reads is its noise floor, and widening the basket lowers it:
//
//   125 players   21,174 comparisons   sd 5.76pp   worst reading  8.6%
//   400 players   41,906 comparisons   sd 1.80pp   worst reading  3.1%
//   600 players   50,127 comparisons   sd 1.06pp   worst reading  2.5%
//   900 players   58,181 comparisons   sd 1.59pp   worst reading  4.8%
//
// 600 is an optimum, not a ceiling reached for lack of trying. Past it the
// players being added trade too thinly to steady anything, and since every
// player casts an equal vote they bring more noise than the wider average
// removes — 900 is measurably worse than 600.
//
// Cards per player stays at 10 because raising it does nothing: at 250 players,
// 10 -> 20 moved the noise floor from 2.31pp to 2.38pp. A player's 11th-to-20th
// busiest cards barely trade, so they add comparisons without adding an
// independent read on that player. Depth is spent on players, not on cards.
const MARKET_TOP_PLAYERS = 600;
const MARKET_CARDS_PER_PLAYER = 10;
// A player needs this many priced comparisons inside a bucket to contribute.
// One is enough: that player then casts a single vote among the basket, and
// the robustness comes from the tier gate on how many players report, not from
// insisting each has several sales. Requiring two silently emptied the index
// wherever players hold few cards — a player with one card can never have two
// comparisons in the same bucket.
const MARKET_MIN_OBS_PER_PLAYER = 1;

// One query builds the whole basket and returns one row per player per bucket:
// their median price ratio and the median gap it was measured over. That is
// about 125 x 11 rows whatever the dataset size, so the Worker does arithmetic
// on a small table rather than grouping hundreds of thousands of sales.
// `unit` is what one contributor to a bucket is. For the whole market that is
// a player, so no single name can speak for the market however many of their
// cards traded. Scoped to one player there is only ever one player, so the
// contributor is a card instead — otherwise every bucket has a sample of one
// and the index can never report.
function _rsiQuery(db, throughIso, days, extraWhere = '', extraBinds = [], unit = 'player', useAlias = false) {
  const { bucketDays, spanDays } = _rsiGeometry(days);
  // Reach back beyond the window so a sale early in it still has a prior.
  const sinceIso = _mkIso(_mkDay(throughIso) - spanDays - RSI_MAX_GAP_DAYS);
  const P = _normCol('player');
  // With aliases the player is the canonical name and the join doubles as a
  // filter: a variant marked unresolved carries no player we could identify —
  // "Cdt All", "Signature Class", "Complete Your Set" — and those strings
  // currently outrank real players, because a parse failure stays whole while
  // Tom Brady is split eighty ways.
  // LEFT, not INNER. An inner join drops every sale whose name has no alias row
  // yet, which made the table all-or-nothing: it could only be used once nearly
  // every name was covered, and the tail is 103,674 names averaging 1.4 sales
  // apiece, so that was twenty hours of waiting for a result that improves
  // monotonically anyway.
  //
  // Falling back to the raw name makes every level of coverage strictly better
  // than none: aliased names merge, names not yet reached behave exactly as
  // they did before, and a variant known to contain no player is dropped. The
  // junk that matters is high-volume by definition, so it is aliased first.
  const PLAYER = useAlias ? `COALESCE(al.canonical, ${P})` : P;
  const JOIN = useAlias ? `LEFT JOIN ${ALIAS_TABLE} al ON al.variant = ${P}` : '';
  const ALIAS_FILTER = useAlias ? ' AND (al.variant IS NULL OR al.resolved = 1)' : '';
  const CARD = _cardKeySql(PLAYER);
  return db.prepare(
    `WITH base AS (
       SELECT sold_date, price_cents, ${PLAYER} AS player_n, ${CARD} AS card
         FROM sales ${JOIN}
        WHERE price_cents IS NOT NULL AND price_cents > 0
          AND sold_date > ? AND sold_date <= ?
          AND ${P} <> ''${ALIAS_FILTER}${RSI_RAW_ONLY}${extraWhere}
     ),
     top_players AS (
       SELECT player_n FROM base GROUP BY player_n
        ORDER BY COUNT(*) DESC LIMIT ${MARKET_TOP_PLAYERS}
     ),
     card_counts AS (
       SELECT b.player_n, b.card, COUNT(*) AS sales,
              ROW_NUMBER() OVER (PARTITION BY b.player_n ORDER BY COUNT(*) DESC, b.card) AS rn
         FROM base b JOIN top_players t ON t.player_n = b.player_n
        GROUP BY b.player_n, b.card
     ),
     picked AS (SELECT player_n, card FROM card_counts WHERE rn <= ${MARKET_CARDS_PER_PLAYER}),
     -- One price per card per day before anything is paired.
     --
     -- Without this the window function below orders sales by date alone, and
     -- sales sharing a date have no defined order. That would not matter if
     -- same-day pairs were used, but they are dropped for gap < 1, so which
     -- same-day sale survives to pair across a date boundary is decided by
     -- whatever order the rows happen to arrive in. On a busy card that is most
     -- of the pairs. It is not hypothetical: adding MATERIALIZED to the CTE
     -- above, which changes row order and nothing else, moved a flat market's
     -- reading from -0.9% to -67.5%.
     --
     -- Averaging the day also does what it does for Card Ladder — several comps
     -- on one day are several reads on one price, and using their mean instead
     -- of an arbitrary one of them is both steadier and better evidence.
     daily AS (
       SELECT b.card, MAX(b.player_n) AS player_n, b.sold_date,
              AVG(b.price_cents) AS price
         FROM base b JOIN picked k ON k.card = b.card
        GROUP BY b.card, b.sold_date
     ),
     paired AS (
       SELECT ${unit === 'card' ? 'd.card' : 'd.player_n'} AS p,
              CAST((julianday(?) - julianday(d.sold_date)) / ? AS INTEGER) AS bucket,
              d.price AS now_c,
              LAG(d.price) OVER w AS prev_c,
              julianday(d.sold_date) - julianday(LAG(d.sold_date) OVER w) AS gap
         FROM daily d
       WINDOW w AS (PARTITION BY d.card ORDER BY d.sold_date)
     ),
     usable AS (
       SELECT p, bucket, (now_c * 1.0) / prev_c AS ratio, gap
         FROM paired
        WHERE prev_c IS NOT NULL AND prev_c > 0 AND bucket >= 0
          AND gap >= 1 AND gap <= ${RSI_MAX_GAP_DAYS}
          AND (now_c * 1.0) / prev_c BETWEEN ${RSI_RATIO_FLOOR} AND ${RSI_RATIO_CEIL}
     ),
     ranked AS (
       SELECT p, bucket, ratio, gap,
              ROW_NUMBER() OVER (PARTITION BY p, bucket ORDER BY ratio) AS rr,
              ROW_NUMBER() OVER (PARTITION BY p, bucket ORDER BY gap)   AS rg,
              COUNT(*)     OVER (PARTITION BY p, bucket)                AS cnt
         FROM usable
     )
     SELECT bucket, p, cnt AS n,
            AVG(CASE WHEN rr IN ((cnt + 1) / 2, (cnt + 2) / 2) THEN ratio END) AS med_ratio,
            AVG(CASE WHEN rg IN ((cnt + 1) / 2, (cnt + 2) / 2) THEN gap   END) AS med_gap
       FROM ranked
      WHERE cnt >= ${MARKET_MIN_OBS_PER_PLAYER}
      GROUP BY bucket, p, cnt
      ORDER BY bucket, p`
    // Bind order follows the order the placeholders appear in the statement:
    // the base CTE's date range, then any scope filter appended to it, then the
    // bucket arithmetic further down. Passing extraBinds last silently fed the
    // player name into the julianday() slot and returned nothing.
  ).bind(sinceIso, throughIso, ...extraBinds, throughIso, bucketDays);
}

// The basket, itemised. Same selection as the index — busiest players, their
// most-traded cards — but returned card by card with the move each one made,
// computed the same way the index computes it. This is what the number is
// actually built from, so it can be read rather than taken on trust.
//
// A representative raw spelling of each field is carried through with MAX(),
// because grouping happens on the normalised form and the normalised form is
// lower-cased and stripped of punctuation — no use as a label.
function _rsiBasketQuery(db, throughIso, days, limit = 24, extraWhere = '', extraBinds = [], hasImage = false, useAlias = false) {
  const { bucketDays, spanDays } = _rsiGeometry(days);
  const sinceIso = _mkIso(_mkDay(throughIso) - spanDays - RSI_MAX_GAP_DAYS);
  const P = _normCol('player');
  // Same substitution as the index. The basket has to select from exactly the
  // same population or the list stops explaining the number above it.
  const PLAYER = useAlias ? `COALESCE(al.canonical, ${P})` : P;
  const JOIN = useAlias ? `LEFT JOIN ${ALIAS_TABLE} al ON al.variant = ${P}` : '';
  const ALIAS_FILTER = useAlias ? ' AND (al.variant IS NULL OR al.resolved = 1)' : '';
  const CARD = _cardKeySql(PLAYER);
  // The photo comes from the newest sale of that card that carried one. Dates
  // are ISO, so their lexical maximum is also their chronological one — the
  // date is glued on only to rank by, and stripped off again on the way out.
  const imgLabel = hasImage
    ? `MAX(CASE WHEN b.image_url IS NOT NULL AND b.image_url <> ''
                THEN b.sold_date || '|' || b.image_url END)`
    : 'NULL';
  return db.prepare(
    `WITH base AS (
       SELECT sold_date, price_cents, ${PLAYER} AS player_n, ${CARD} AS card,
              ${useAlias ? 'COALESCE(al.display, player)' : 'player'} AS player,
              year, set_name, parallel, grader, grade${hasImage ? ', image_url' : ''}
         FROM sales ${JOIN}
        WHERE price_cents IS NOT NULL AND price_cents > 0
          AND sold_date > ? AND sold_date <= ?
          AND ${P} <> ''${ALIAS_FILTER}${RSI_RAW_ONLY}${extraWhere}
     ),
     top_players AS (
       SELECT player_n FROM base GROUP BY player_n
        ORDER BY COUNT(*) DESC LIMIT ${MARKET_TOP_PLAYERS}
     ),
     card_counts AS (
       SELECT b.player_n, b.card, COUNT(*) AS sales,
              ROW_NUMBER() OVER (PARTITION BY b.player_n ORDER BY COUNT(*) DESC, b.card) AS rn
         FROM base b JOIN top_players t ON t.player_n = b.player_n
        GROUP BY b.player_n, b.card
     ),
     picked AS (SELECT player_n, card, sales FROM card_counts WHERE rn <= ${MARKET_CARDS_PER_PLAYER}),
     -- Shortlist BEFORE pairing. The basket holds thousands of cards and only
     -- the busiest few are shown, so pairing all of them and discarding the
     -- rest doubled the cost of building the index — 2.4s against a 2s budget
     -- on the test dataset. Narrowing here does the window function over a few
     -- dozen cards instead.
     shortlist AS (
       SELECT card FROM picked ORDER BY sales DESC, card LIMIT ${limit}
     ),
     -- One price per card per day, for the reason given on the index query's
     -- own daily CTE: sales sharing a date have no defined order, and pairs are
     -- dropped at gap < 1, so without this the surviving pairs depend on row
     -- order. A card's move here must be computed exactly as the index computes
     -- it or the list stops reconciling with the number above it.
     daily AS (
       SELECT b.card, b.sold_date, AVG(b.price_cents) AS price
         FROM base b JOIN shortlist k ON k.card = b.card
        GROUP BY b.card, b.sold_date
     ),
     paired AS (
       SELECT d.card, d.price AS now_c,
              LAG(d.price) OVER w AS prev_c,
              julianday(d.sold_date) - julianday(LAG(d.sold_date) OVER w) AS gap
         FROM daily d
       WINDOW w AS (PARTITION BY d.card ORDER BY d.sold_date)
     ),
     usable AS (
       SELECT card, (now_c * 1.0) / prev_c AS ratio, gap FROM paired
        WHERE prev_c IS NOT NULL AND prev_c > 0 AND gap >= 1 AND gap <= ${RSI_MAX_GAP_DAYS}
          AND (now_c * 1.0) / prev_c BETWEEN ${RSI_RATIO_FLOOR} AND ${RSI_RATIO_CEIL}
     ),
     ranked AS (
       SELECT card, ratio, gap,
              ROW_NUMBER() OVER (PARTITION BY card ORDER BY ratio) AS rr,
              ROW_NUMBER() OVER (PARTITION BY card ORDER BY gap)   AS rg,
              COUNT(*)     OVER (PARTITION BY card)                AS cnt
         FROM usable
     ),
     moves AS (
       SELECT card, cnt AS pairs,
              AVG(CASE WHEN rr IN ((cnt + 1) / 2, (cnt + 2) / 2) THEN ratio END) AS med_ratio,
              AVG(CASE WHEN rg IN ((cnt + 1) / 2, (cnt + 2) / 2) THEN gap   END) AS med_gap
         FROM ranked GROUP BY card, cnt
     ),
     labels AS (
       SELECT b.card,
              MAX(b.player) AS player, MAX(b.year) AS year, MAX(b.set_name) AS set_name,
              MAX(b.parallel) AS parallel, MAX(b.grader) AS grader, MAX(b.grade) AS grade,
              COUNT(*) AS sales,
              AVG(b.price_cents) AS avg_cents,
              ${imgLabel} AS dated_image
         FROM base b JOIN shortlist k ON k.card = b.card
        GROUP BY b.card
     )
     SELECT l.player, l.year, l.set_name, l.parallel, l.grader, l.grade,
            l.sales, l.avg_cents, l.dated_image, m.pairs, m.med_ratio, m.med_gap
       FROM labels l
       LEFT JOIN moves m ON m.card = l.card
      ORDER BY l.sales DESC`
  ).bind(sinceIso, throughIso, ...extraBinds);
}

// Turn basket rows into something displayable: a label, how much it traded,
// its typical price, and the move over the period on the same time-normalised
// footing the index uses, so a card's number and the index's agree.
function _rsiBasketRows(rows, days, bucketDays, points) {
  const out = [];
  for (const r of (rows || [])) {
    const parts = [r.year, r.set_name, r.player].filter(Boolean).map(String);
    const extras = [r.parallel, [r.grader, r.grade].filter(Boolean).join(' ')]
      .map(x => String(x || '').trim()).filter(Boolean);
    let changePct = null;
    const ratio = Number(r.med_ratio), gap = Number(r.med_gap);
    if (ratio > 0 && gap > 0) {
      const perBucket = Math.pow(ratio, bucketDays / gap);
      const overPeriod = Math.pow(perBucket, points);
      if (Number.isFinite(overPeriod)) changePct = Math.round((overPeriod - 1) * 1000) / 10;
    }
    // Drop the sort-key date the query prefixed to the photo URL.
    let imageUrl = null;
    if (r.dated_image) {
      const bar = String(r.dated_image).indexOf('|');
      if (bar >= 0) imageUrl = String(r.dated_image).slice(bar + 1) || null;
    }
    out.push({
      label: parts.join(' ') || 'Unknown card',
      detail: extras.join(' · '),
      sales: Number(r.sales) || 0,
      pairs: Number(r.pairs) || 0,
      avgPrice: r.avg_cents != null ? Math.round(Number(r.avg_cents)) / 100 : null,
      changePct,
      imageUrl,
    });
  }
  return out;
}

function _buildRepeatSalesPayload(rows, throughIso, days, extra = {}, tiers = RSI_TIERS) {
  const { bucketDays, points } = _rsiGeometry(days);
  // bucket -> [{ growth, n }] — one entry per player in that bucket.
  const byBucket = new Map();
  const players = new Set();
  for (const r of rows) {
    const b = Number(r.bucket);
    const ratio = Number(r.med_ratio);
    const gap = Number(r.med_gap);
    if (!Number.isInteger(b) || b < 0 || !(ratio > 0) || !(gap > 0)) continue;
    let growth = Math.pow(ratio, bucketDays / gap);
    if (!Number.isFinite(growth) || growth <= 0) continue;
    growth = Math.min(RSI_BUCKET_MOVE_CEIL, Math.max(RSI_BUCKET_MOVE_FLOOR, growth));
    if (!byBucket.has(b)) byBucket.set(b, []);
    byBucket.get(b).push({ growth, n: Number(r.n) || 0, gap });
    players.add(r.p);
  }
  let last = null;
  for (const tier of tiers) {
    const out = _rsiPayloadAt(byBucket, throughIso, days, bucketDays, points, tier,
      { basketPlayers: players.size, ...extra });
    if (out.available) return out;
    last = out;
  }
  return last;
}

function _rsiPayloadAt(byBucket, throughIso, days, bucketDays, points, tier, extra = {}) {
  const round1 = (n) => Math.round(n * 10) / 10;
  const through = _mkDay(throughIso);

  const steps = [];
  for (let b = points - 1; b >= 0; b--) {
    const list = byBucket.get(b) || [];
    if (list.length < tier.minPlayers) {
      steps.push({ bucket: b, growth: 1, players: list.length, obs: 0, thin: true });
      continue;
    }
    // Geometric mean across players, not arithmetic. Averaging growth FACTORS
    // arithmetically overstates compound growth — 0.5 and 2.0 average to 1.25
    // where the honest answer is 1.0 — so the mean is taken over their logs.
    // Each player counts once however many of their cards traded, which stops
    // a heavily-printed name from speaking for the market.
    const growth = Math.exp(list.reduce((a, x) => a + Math.log(x.growth), 0) / list.length);
    steps.push({
      bucket: b,
      growth: Number.isFinite(growth) ? growth : 1,
      players: list.length,
      obs: list.reduce((a, x) => a + x.n, 0),
      gaps: list.map(x => x.gap),
      thin: false,
    });
  }

  const solid = steps.filter(s => !s.thin);
  // A bucket nobody reported in is unmeasured, not flat. Holding it at 1.0
  // asserts the market stood still, which drags the whole chain toward zero
  // wherever trading is sparse — the same drift read 3.6 points lower when
  // cards resold every 20 days instead of every 4. An unmeasured bucket now
  // inherits the typical growth of the buckets that did report, so gaps in
  // coverage neither invent movement nor suppress it.
  if (solid.length > 0) {
    const rates = solid.map(x => x.growth).sort((a, b) => a - b);
    const typical = rates[Math.floor(rates.length / 2)];
    for (const st of steps) if (st.thin) st.growth = typical;
  }

  if (solid.length === 0 || solid.length * 2 < steps.length) {
    return {
      available: false, days, reason: 'not enough paired sales yet',
      minPlayers: tier.minPlayers,
      playersInBestStep: Math.max(0, ...steps.map(s => s.players)),
      tier: tier.label, bucketDays, through: throughIso, method: 'player-basket', ...extra,
    };
  }

  const series = [{ date: _mkIso(through - points * bucketDays), score: 100 }];
  let level = 100;
  for (const s of steps) {
    level *= s.growth;
    series.push({
      date: _mkIso(through - s.bucket * bucketDays),
      score: round1(level),
      matched: s.players,
    });
  }

  const score = round1(level);
  const counts = solid.map(s => s.players).sort((a, b) => a - b);
  // How far apart the compared sales typically were. A large number means the
  // reading leans on older prices even after they are time-normalised.
  const allGaps = solid.flatMap(s => s.gaps || []).sort((a, b) => a - b);
  return {
    available: true,
    days,
    method: 'player-basket',
    tier: tier.label,
    through: throughIso,
    dataLagDays: Math.max(0, _mkDay(new Date().toISOString()) - through),
    score: Math.round(score),
    rawScore: score,
    changePct: round1(score - 100),
    // Players standing behind a typical point, and behind the weakest one.
    matchedCards: counts[Math.floor(counts.length / 2)],
    minMatchedInAnyStep: counts[0],
    totalObservations: steps.reduce((a, s) => a + s.obs, 0),
    topPlayers: MARKET_TOP_PLAYERS,
    cardsPerPlayer: MARKET_CARDS_PER_PLAYER,
    minPlayers: tier.minPlayers,
    typicalGapDays: allGaps.length ? Math.round(allGaps[Math.floor(allGaps.length / 2)]) : null,
    bucketDays,
    thinSteps: steps.length - solid.length,
    series,
    ...extra,
  };
}

// ---- Player field quality ---------------------------------------------------
// 96,445 distinct player values across 297,027 sales is roughly fifteen times
// the number of real footballers who appear on cards, which means the field is
// carrying junk parsed out of listing titles. Every junk value splits one real
// card into several that can never match as repeats, so this is the single
// biggest lever on how many cards the index can pair.
//
// The fix has to be written against what the data actually contains — case
// variants, trailing noise, whole-lot listings and multi-player cards all look
// the same from outside and need different handling. So this samples the field
// rather than guessing. Aggregates plus two small samples; no heavy work.
// How much of the player-name mess the checklist dictionary can actually clean
// up, measured on live data rather than on my fixtures.
//
// The sales table holds ~96,000 distinct values in a column that should hold
// about 16,000. This takes the busiest of those strings, runs them through the
// resolver, and reports two numbers that mean different things: the share of
// distinct STRINGS it can place, and the share of SALES those strings carry.
// The second is the one that matters — resolving the head is most of the value,
// and the tail is long by definition.
app.get('/api/debug/player-resolve', async (req, res) => {
  const db = getNflDb();
  if (!db) return res.json({ available: false, reason: 'no dataset' });
  const limit = Math.min(5000, Math.max(100, parseInt(req.query.limit, 10) || 3000));
  try {
    const newest = await db.prepare(
      'SELECT MAX(sold_date) AS d FROM sales WHERE price_cents IS NOT NULL'
    ).first();
    if (!newest || !newest.d) return res.json({ available: false, reason: 'no data in range' });
    const sinceIso = _mkIso(_mkDay(newest.d) - 30);

    const rows = await db.prepare(
      `SELECT player, COUNT(*) AS n
         FROM sales
        WHERE price_cents IS NOT NULL AND price_cents > 0
          AND player IS NOT NULL AND player <> ''
          AND sold_date > ?
        GROUP BY player ORDER BY n DESC LIMIT ?`
    ).bind(sinceIso, limit).all();
    const list = (rows && rows.results) || [];

    const byCanonical = new Map();
    const unresolved = [];
    let strings = 0, sales = 0, resolvedStrings = 0, resolvedSales = 0, lowConfidence = 0;
    for (const r of list) {
      strings++; sales += r.n;
      const hit = resolvePlayer(r.player);
      if (!hit || !hit.confident) {
        if (hit) lowConfidence++;
        unresolved.push({ player: r.player, sales: r.n, nearest: hit ? hit.canonical : null });
        continue;
      }
      resolvedStrings++; resolvedSales += r.n;
      if (!byCanonical.has(hit.key)) byCanonical.set(hit.key, { canonical: hit.canonical, variants: 0, sales: 0 });
      const e = byCanonical.get(hit.key);
      e.variants++; e.sales += r.n;
    }

    const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 + '%' : null);
    const merged = [...byCanonical.values()].filter(e => e.variants > 1)
      .sort((a, b) => b.variants - a.variants).slice(0, 15);

    res.json({
      available: true,
      window: { since: sinceIso, through: newest.d },
      dictionary: cardIndexStats,
      sample: { distinctStrings: strings, salesCovered: sales, cappedAt: limit },
      resolved: {
        strings: resolvedStrings, stringShare: pct(resolvedStrings, strings),
        sales: resolvedSales, salesShare: pct(resolvedSales, sales),
        canonicalPlayers: byCanonical.size,
        // The headline: how many names the mess collapses to.
        collapseRatio: byCanonical.size ? Math.round((resolvedStrings / byCanonical.size) * 100) / 100 : null,
        declinedButNearlyMatched: lowConfidence,
      },
      // Where the win is: one player, many spellings, now one group.
      biggestMerges: merged.map(e => ({ player: e.canonical, spellings: e.variants, sales: e.sales })),
      // Where the dictionary still fails. This is the to-do list.
      topUnresolved: unresolved.sort((a, b) => b.sales - a.sales).slice(0, 25),
    });
  } catch (err) {
    console.error('[player-resolve]', err && err.stack || err);
    res.json({ available: false, error: err && err.message });
  }
});

// Where the raw-only filter loses rows, one stage at a time.
//
// The filter reads two columns and a title, and any one of the three can empty
// the index on its own — a grader column using a sentinel this doesn't know
// about takes every row, silently, and the page just says the market is
// unavailable. This says which stage did it, and shows the column values it
// actually found so a wrong assumption is visible rather than inferred.
app.get('/api/debug/raw-filter', async (req, res) => {
  const db = getNflDb();
  if (!db) return res.json({ available: false, reason: 'no dataset' });
  try {
    const newest = await db.prepare(
      'SELECT MAX(sold_date) AS d FROM sales WHERE price_cents IS NOT NULL'
    ).first();
    if (!newest || !newest.d) return res.json({ available: false, reason: 'no data in range' });
    const throughIso = _mkIso(_mkDay(newest.d) - MARKET_EXCLUDE_TRAILING_DAYS);
    const sinceIso = _mkIso(_mkDay(throughIso) - 30);
    const T = "LOWER(COALESCE(title, ''))";
    const anyWord = (words) => words.map(w => `${T} LIKE '%${w}%'`).join(' OR ');
    const titleClean =
      `NOT ( ${anyWord(RSI_GRADER_WORDS)} OR ${anyWord(RSI_SLAB_WORDS)}
          OR ( ${T} LIKE '%graded%' AND ${T} NOT LIKE '%ungraded%'
               AND ${T} NOT LIKE '%upgraded%' ) )`;

    const funnel = await db.prepare(
      `SELECT COUNT(*) AS priced,
              SUM(CASE WHEN ${_rsiUngradedCol('grade')} THEN 1 ELSE 0 END) AS grade_ok,
              SUM(CASE WHEN ${_rsiUngradedCol('grade')} AND ${_rsiUngradedCol('grader')}
                       THEN 1 ELSE 0 END) AS grader_ok,
              SUM(CASE WHEN ${_rsiUngradedCol('grade')} AND ${_rsiUngradedCol('grader')}
                        AND ${titleClean} THEN 1 ELSE 0 END) AS raw_final,
              SUM(CASE WHEN title IS NULL OR title = '' THEN 1 ELSE 0 END) AS no_title
         FROM sales
        WHERE price_cents IS NOT NULL AND price_cents > 0
          AND sold_date > ? AND sold_date <= ?`
    ).bind(sinceIso, throughIso).first();

    const top = async (col) => {
      const r = await db.prepare(
        `SELECT LOWER(COALESCE(TRIM(${col}), '')) AS v, COUNT(*) AS n
           FROM sales
          WHERE price_cents IS NOT NULL AND sold_date > ? AND sold_date <= ?
          GROUP BY v ORDER BY n DESC LIMIT 12`
      ).bind(sinceIso, throughIso).all();
      return ((r && r.results) || []).map(x => ({ value: x.v === '' ? '(empty)' : x.v, sales: x.n }));
    };

    const survivors = await db.prepare(
      `SELECT title, player, COUNT(*) AS n
         FROM sales
        WHERE price_cents IS NOT NULL AND price_cents > 0
          AND sold_date > ? AND sold_date <= ?
          AND ${_rsiUngradedCol('grade')} AND ${_rsiUngradedCol('grader')} AND ${titleClean}
        GROUP BY title ORDER BY n DESC LIMIT 5`
    ).bind(sinceIso, throughIso).all();

    const p = funnel || {};
    const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 + '%' : null);
    res.json({
      available: true,
      window: { since: sinceIso, through: throughIso },
      funnel: {
        pricedSales: p.priced,
        afterGradeCheck: p.grade_ok, afterGradeCheckShare: pct(p.grade_ok, p.priced),
        afterGraderCheck: p.grader_ok, afterGraderCheckShare: pct(p.grader_ok, p.priced),
        rawFinal: p.raw_final, rawFinalShare: pct(p.raw_final, p.priced),
        salesWithNoTitle: p.no_title,
      },
      // If the biggest loss is at a column stage, the values below say why.
      graderValues: await top('grader'),
      gradeValues: await top('grade'),
      sampleRawTitles: ((survivors && survivors.results) || [])
        .map(r => ({ title: r.title, player: r.player, sales: r.n })),
      ungradedTreatedAs: RSI_UNGRADED_VALUES.map(v => v === '' ? '(empty)' : v),
    });
  } catch (err) {
    console.error('[raw-filter]', err && err.stack || err);
    res.json({ available: false, error: err && err.message });
  }
});

app.get('/api/debug/player-quality', async (req, res) => {
  const db = getNflDb();
  if (!db) return res.json({ available: false, reason: 'no dataset' });
  try {
    const shape = await db.prepare(
      `SELECT COUNT(*) AS players,
              SUM(CASE WHEN n = 1 THEN 1 ELSE 0 END) AS once,
              SUM(CASE WHEN n BETWEEN 2 AND 3 THEN 1 ELSE 0 END) AS few,
              SUM(CASE WHEN n BETWEEN 4 AND 20 THEN 1 ELSE 0 END) AS some,
              SUM(CASE WHEN n > 20 THEN 1 ELSE 0 END) AS many
         FROM (SELECT player, COUNT(*) AS n FROM sales
                WHERE price_cents IS NOT NULL AND player IS NOT NULL AND player <> ''
                GROUP BY player)`
    ).first();

    // The busiest values should be recognisable footballers. If they are not,
    // the parser is failing on common listings rather than on odd ones.
    const top = await db.prepare(
      `SELECT player, COUNT(*) AS sales FROM sales
        WHERE price_cents IS NOT NULL AND player IS NOT NULL AND player <> ''
        GROUP BY player ORDER BY sales DESC LIMIT 40`
    ).all();

    // The long tail is where the junk lives. Ordering by a hash of the rowid
    // spreads the sample across the table instead of returning sixty values
    // that all start with the same letter — and unlike a modulus filter it
    // always returns rows, however the ids happen to fall.
    const tail = await db.prepare(
      `SELECT player FROM (
         SELECT player, COUNT(*) AS n, MIN(rowid) AS r FROM sales
          WHERE price_cents IS NOT NULL AND player IS NOT NULL AND player <> ''
          GROUP BY player HAVING n = 1
       ) ORDER BY (r * 2654435761) % 1000003 LIMIT 60`
    ).all();

    // Cheap structural tests. Each points at a different repair.
    const shapes = await db.prepare(
      `SELECT
         SUM(CASE WHEN player LIKE '% / %' OR player LIKE '%/%' THEN 1 ELSE 0 END) AS has_slash,
         SUM(CASE WHEN player LIKE '%  %' THEN 1 ELSE 0 END) AS double_space,
         SUM(CASE WHEN player <> TRIM(player) THEN 1 ELSE 0 END) AS untrimmed,
         SUM(CASE WHEN player <> UPPER(SUBSTR(player,1,1)) || SUBSTR(player,2) THEN 1 ELSE 0 END) AS lower_first,
         SUM(CASE WHEN LENGTH(player) > 40 THEN 1 ELSE 0 END) AS very_long,
         SUM(CASE WHEN LENGTH(player) < 4 THEN 1 ELSE 0 END) AS very_short,
         SUM(CASE WHEN player GLOB '*[0-9]*' THEN 1 ELSE 0 END) AS has_digit,
         COUNT(*) AS of
       FROM (SELECT DISTINCT player FROM sales
              WHERE price_cents IS NOT NULL AND player IS NOT NULL AND player <> '')`
    ).first();

    // What the normalisation actually buys on this dataset. Raw distinct
    // values against normalised ones, for the player column and for the whole
    // card key — the second is the number that decides how many cards can pair.
    const collapse = await db.prepare(
      `SELECT
         COUNT(DISTINCT player) AS raw_players,
         COUNT(DISTINCT ${_normCol('player')}) AS norm_players,
         COUNT(DISTINCT year || '|' || set_name || '|' || player || '|' || parallel || '|' || grader || '|' || grade) AS raw_cards,
         COUNT(DISTINCT ${RSI_KEY_COLS.map(c => _normCol(c)).join(" || '|' || ")}) AS norm_cards
       FROM sales WHERE price_cents IS NOT NULL`
    ).first();

    res.json({
      available: true,
      distinctPlayers: shape ? shape.players : null,
      normalisation: collapse ? {
        players: { raw: collapse.raw_players, normalised: collapse.norm_players,
                   merged: collapse.raw_players - collapse.norm_players },
        cardKeys: { raw: collapse.raw_cards, normalised: collapse.norm_cards,
                    merged: collapse.raw_cards - collapse.norm_cards },
        note: 'Case, punctuation and whitespace only. Values that are not names at all still need a roster match.',
      } : null,
      salesPerPlayer: shape ? {
        exactlyOnce: shape.once, twoOrThree: shape.few, fourToTwenty: shape.some, over20: shape.many,
      } : null,
      distinctValueShapes: shapes,
      topBySales: ((top && top.results) || []).map(r => `${r.player}  (${r.sales})`),
      longTailSample: ((tail && tail.results) || []).map(r => r.player),
    });
  } catch (err) {
    console.error('[player-quality]', err && err.stack || err);
    res.json({ available: false, error: err && err.message });
  }
});

// The basket behind the index, itemised. A separate endpoint rather than part
// of the index payload: both queries scan and normalise the same sales, and
// running them in one request took the build to 2.2s against a 2s budget. The
// page shows the number as soon as it has it and fills the card list in after.
app.get('/api/market-basket', async (req, res) => {
  const days = MARKET_PERIODS.includes(parseInt(req.query.days, 10))
    ? parseInt(req.query.days, 10)
    : 30;
  const player = String(req.query.player || '').trim();
  const db = getNflDb();
  if (!db) return res.json({ available: false, days, reason: 'no dataset' });

  const cacheKey = `marketbasket:v1:${days}:${player.toLowerCase()}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return res.json(cached);

  try {
    const newest = player
      ? await db.prepare(
          'SELECT MAX(sold_date) AS d FROM sales WHERE player = ? AND confidence >= ? AND price_cents IS NOT NULL'
        ).bind(player, NFLDB_MIN_CONFIDENCE).first()
      : await db.prepare('SELECT MAX(sold_date) AS d FROM sales WHERE price_cents IS NOT NULL').first();
    if (!newest || !newest.d) return res.json({ available: false, days, reason: 'no data in range' });

    const throughIso = _mkIso(_mkDay(newest.d) - MARKET_EXCLUDE_TRAILING_DAYS);
    const g = _rsiGeometry(days);
    // Probed, never assumed: naming a column the table lacks fails the whole
    // query, and image_url arrived late enough that not every deployment has it.
    const hasImage = await _nflHasImageColumn(db);
    const useAlias = await _aliasReady(db);
    const rows = player
      ? await _rsiBasketQuery(db, throughIso, days, 12,
          ' AND player = ? AND confidence >= ?', [player, NFLDB_MIN_CONFIDENCE], hasImage, useAlias).all()
      : await _rsiBasketQuery(db, throughIso, days, 24, '', [], hasImage, useAlias).all();

    const payload = {
      available: true, days, player: player || null, through: throughIso,
      cards: _rsiBasketRows((rows && rows.results) || [], days, g.bucketDays, g.points),
    };
    cachePut(cacheKey, payload, MARKET_TTL);
    res.json(payload);
  } catch (err) {
    console.error('[MarketBasket]', err && err.message);
    res.json({ available: false, days, reason: 'basket unavailable' });
  }
});

app.get('/api/debug/index-health', async (req, res) => {
  const db = getNflDb();
  if (!db) return res.json({ available: false, reason: 'no dataset' });
  try {
    const span = await db.prepare(
      `SELECT COUNT(*) AS priced, MIN(sold_date) AS first, MAX(sold_date) AS last
         FROM sales WHERE price_cents IS NOT NULL`
    ).first();
    if (!span || !span.last) return res.json({ available: false, reason: 'no priced sales' });

    const all = await db.prepare('SELECT COUNT(*) AS n FROM sales').first();
    const maxDay = _mkDay(span.last);
    const daysHeld = maxDay - _mkDay(span.first) + 1;

    // How often each key column is populated, and how many distinct values it
    // holds. A column with far more distinct values than there are real cards
    // is the fingerprint of fragmentation.
    const fill = await db.prepare(
      `SELECT
         SUM(CASE WHEN year     IS NULL OR year     = '' THEN 0 ELSE 1 END) AS year_set,
         SUM(CASE WHEN set_name IS NULL OR set_name = '' THEN 0 ELSE 1 END) AS set_set,
         SUM(CASE WHEN player   IS NULL OR player   = '' THEN 0 ELSE 1 END) AS player_set,
         SUM(CASE WHEN parallel IS NULL OR parallel = '' THEN 0 ELSE 1 END) AS parallel_set,
         SUM(CASE WHEN grader   IS NULL OR grader   = '' THEN 0 ELSE 1 END) AS grader_set,
         SUM(CASE WHEN grade    IS NULL OR grade    = '' THEN 0 ELSE 1 END) AS grade_set,
         COUNT(DISTINCT set_name) AS distinct_sets,
         COUNT(DISTINCT player)   AS distinct_players,
         COUNT(DISTINCT parallel) AS distinct_parallels,
         COUNT(*) AS n
       FROM sales WHERE price_cents IS NOT NULL`
    ).first();

    // Repeat-sale density on the strict key over the last 180 days.
    const since = _mkIso(maxDay - 180);
    const totals = await db.prepare(
      `SELECT COUNT(*) AS keys,
              SUM(CASE WHEN n >= 2 THEN 1 ELSE 0 END) AS repeat_keys,
              SUM(CASE WHEN n >= 4 THEN 1 ELSE 0 END) AS frequent_keys
         FROM (SELECT COUNT(*) AS n FROM sales
                WHERE price_cents IS NOT NULL AND sold_date >= ?
                GROUP BY year, set_name, player, parallel, grader, grade)`
    ).bind(since).first();

    // The number that actually decides whether the index works: how many cards
    // traded in BOTH halves of each period. One INTERSECT per period, no
    // index build.
    const throughIso = _mkIso(maxDay - MARKET_EXCLUDE_TRAILING_DAYS);
    const periods = {};
    for (const days of MARKET_PERIODS) {
      const g = _rsiGeometry(days);
      // Exactly the two buckets the headline compares: the newest, and the one
      // `points` steps back. An earlier version measured the whole span behind
      // the recent bucket, which reported thousands of matched cards for a
      // period the index could not score at all.
      const t = _mkDay(throughIso);
      const recentFrom = _mkIso(t - g.bucketDays);
      const priorTo    = _mkIso(t - g.bucketDays * g.points);
      const priorFrom  = _mkIso(t - g.bucketDays * (g.points + 1));
      const row = await db.prepare(
        `SELECT COUNT(*) AS matched FROM (
           SELECT year, set_name, player, parallel, grader, grade FROM sales
            WHERE price_cents IS NOT NULL AND sold_date > ? AND sold_date <= ?
           INTERSECT
           SELECT year, set_name, player, parallel, grader, grade FROM sales
            WHERE price_cents IS NOT NULL AND sold_date > ? AND sold_date <= ?)`
      ).bind(recentFrom, throughIso, priorFrom, priorTo).first();
      periods[days] = {
        bucketDays: g.bucketDays,
        points: g.points,
        spanNeededDays: g.spanDays,
        historyCovers: daysHeld >= g.spanDays,
        matchedCards: row ? row.matched : null,
        needsForStrict: RSI_TIERS[0].minMatched,
        wouldWork: !!(row && row.matched >= RSI_TIERS[RSI_TIERS.length - 1].minMatched),
      };
    }

    res.json({
      available: true,
      generatedAt: new Date().toISOString(),
      dataset: {
        totalRows: all ? all.n : null,
        pricedSales: span.priced,
        pricedShare: all && all.n ? Math.round((span.priced / all.n) * 100) + '%' : null,
        firstSale: span.first, lastSale: span.last,
        daysOfHistory: daysHeld,
        dataLagDays: Math.max(0, _mkDay(new Date().toISOString()) - maxDay),
      },
      keyColumns: fill ? {
        populated: {
          year: fill.year_set, set_name: fill.set_set, player: fill.player_set,
          parallel: fill.parallel_set, grader: fill.grader_set, grade: fill.grade_set,
          of: fill.n,
        },
        distinct: {
          setNames: fill.distinct_sets,
          players: fill.distinct_players,
          parallels: fill.distinct_parallels,
        },
      } : null,
      repeatSales180d: totals ? {
        distinctCards: totals.keys,
        soldTwiceOrMore: totals.repeat_keys,
        soldFourOrMore: totals.frequent_keys,
        repeatShare: totals.keys ? Math.round((totals.repeat_keys / totals.keys) * 100) + '%' : null,
      } : null,
      periods,
    });
  } catch (err) {
    console.error('[index-health]', err && err.stack || err);
    res.json({ available: false, error: err && err.message });
  }
});

app.get('/api/market-index', async (req, res) => {
  const days = MARKET_PERIODS.includes(parseInt(req.query.days, 10))
    ? parseInt(req.query.days, 10)
    : 30;
  const db = getNflDb();
  if (!db) return res.json({ available: false, days, reason: 'no dataset' });

  // v3: grouping moved into SQL. v2 keys are left behind deliberately — they
  // hold payloads from the build that tripped the Worker CPU limit.
  const cacheKey = `marketindex:v3:${days}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return res.json(cached);

  try {
    // Anchor to the newest day we hold, not to today: if the collector paused,
    // counting back from today walks off the end of the data and reads as a
    // crash that never happened.
    const newest = await db.prepare(
      'SELECT MAX(sold_date) AS d FROM sales WHERE price_cents IS NOT NULL'
    ).first();
    if (!newest || !newest.d) return res.json({ available: false, days, reason: 'no data in range' });

    const throughIso = _mkIso(_mkDay(newest.d) - MARKET_EXCLUDE_TRAILING_DAYS);

    // "We haven't been collecting long enough" is not the same as "cards don't
    // resell", and only one of them resolves on its own. Check it explicitly so
    // the page can say which, rather than blaming the data density.
    const oldest = await db.prepare(
      'SELECT MIN(sold_date) AS d FROM sales WHERE price_cents IS NOT NULL'
    ).first();
    // The gate is where the oldest bucket STARTS, not where it ends. A period
    // whose last bucket is only partly covered still scores fine off the sales
    // it does have; one whose last bucket is entirely before the first sale we
    // hold has nothing to compare against and would report zero matched cards
    // as if cards never resold.
    const { bucketDays, points, spanDays } = _rsiGeometry(days);
    const haveDays = oldest && oldest.d ? _mkDay(throughIso) - _mkDay(oldest.d) + 1 : 0;
    if (haveDays < points * bucketDays) {
      return res.json({
        available: false, days, reason: 'not enough history yet',
        daysOfHistory: haveDays, daysNeeded: points * bucketDays, fullSpanDays: spanDays,
        through: throughIso, method: 'repeat-sales',
      });
    }

    // Only groups on canonical names once the table is actually filled.
    const useAlias = await _aliasReady(db);
    const rows = await _rsiQuery(db, throughIso, days, '', [], 'player', useAlias).all();
    const list = (rows && rows.results) || [];
    if (list.length === 0) return res.json({ available: false, days, reason: 'no data in range' });

    const payload = _buildRepeatSalesPayload(list, throughIso, days);
    if (payload.available) cachePut(cacheKey, payload, MARKET_TTL);
    res.json(payload);
  } catch (err) {
    console.error('[MarketIndex]', err && err.message);
    res.json({ available: false, days, reason: 'index unavailable' });
  }
});

// ---- Player market index ----
// The same index as /api/market-index, scoped to one player. Identical maths
// and identical payload shape, so a player's number can be read against the
// market's — that comparison is the whole point, and it only holds if both
// sides are computed the same way.
//
// Two things differ, both forced by scale:
//
//  - There's no pre-aggregated table per player, so the daily rollup is done
//    in SQL against `sales`, filtered on the player index.
//  - The sample gate is lower. One player is a small slice of the market;
//    holding them to the whole-market threshold would refuse to score all but
//    a handful of names. It's still a gate — thin players are declined rather
//    than given a number built on four sales.
const PLAYER_MIN_SALES = 8;
const PLAYER_INDEX_TTL = 3600;      // 1h, same as the market index
const PLAYER_LIST_TTL = 6 * 3600;   // 6h — the roster of active players barely moves
// Cap on the cached roster. Players outside it are, by definition, ones with
// too few sales to clear the gate anyway, so this isn't a coverage limit.
const PLAYER_LIST_MAX = 1000;
const PLAYER_LIST_WINDOW_DAYS = 220;

// Cached roster of players with enough recent activity to be worth offering.
// Built once per PLAYER_LIST_TTL and filtered in JS, so typing in the search
// box never runs a LIKE scan over the sales table.
async function _playerRoster(db) {
  const cached = await cacheGet('playerroster:v1');
  if (cached) return cached;
  const since = _mkIso(_mkDay(new Date().toISOString()) - PLAYER_LIST_WINDOW_DAYS);
  const rows = await db.prepare(
    `SELECT player, COUNT(*) AS n
       FROM sales
      WHERE player IS NOT NULL AND player != ''
        AND confidence >= ? AND sold_date >= ?
      GROUP BY player
      ORDER BY n DESC
      LIMIT ?`
  ).bind(NFLDB_MIN_CONFIDENCE, since, PLAYER_LIST_MAX).all();
  const list = ((rows && rows.results) || []).map(r => ({ player: r.player, sales: r.n }));
  if (list.length) cachePut('playerroster:v1', list, PLAYER_LIST_TTL);
  return list;
}

// Typeahead for the Market tab's player search.
app.get('/api/player-search', async (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  const db = getNflDb();
  if (!db) return res.json({ available: false, players: [] });
  try {
    const roster = await _playerRoster(db);
    // Substring, not prefix — people search "Nix" as often as "Bo".
    // Names that START with the query rank first, since that's the stronger
    // match, and sale count breaks ties.
    const hits = q ? roster.filter(p => p.player.toLowerCase().includes(q)) : roster.slice(0, 12);
    hits.sort((a, b) => {
      const ap = a.player.toLowerCase().startsWith(q) ? 0 : 1;
      const bp = b.player.toLowerCase().startsWith(q) ? 0 : 1;
      return ap !== bp ? ap - bp : b.sales - a.sales;
    });
    res.json({ available: true, players: hits.slice(0, 12) });
  } catch (err) {
    console.error('[PlayerSearch]', err && err.message);
    res.json({ available: false, players: [] });
  }
});

app.get('/api/player-index', async (req, res) => {
  const days = MARKET_PERIODS.includes(parseInt(req.query.days, 10))
    ? parseInt(req.query.days, 10)
    : 30;
  const player = String(req.query.player || '').trim();
  if (!player) return res.json({ available: false, days, reason: 'no player' });

  const db = getNflDb();
  if (!db) return res.json({ available: false, days, player, reason: 'no dataset' });

  const cacheKey = `playerindex:v3:${days}:${player.toLowerCase()}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return res.json(cached);

  try {
    // Anchored to this player's newest sale rather than the market's, so a
    // player who stopped selling three weeks ago says so instead of being
    // scored against windows that are empty for them.
    const newest = await db.prepare(
      'SELECT MAX(sold_date) AS d FROM sales WHERE player = ? AND confidence >= ? AND price_cents IS NOT NULL'
    ).bind(player, NFLDB_MIN_CONFIDENCE).first();
    if (!newest || !newest.d) {
      return res.json({ available: false, days, player, reason: 'no sales for this player' });
    }

    const throughIso = _mkIso(_mkDay(newest.d) - MARKET_EXCLUDE_TRAILING_DAYS);
    // Identical maths to the market index on purpose: a player's number is only
    // worth showing beside the market's if the two are the same measurement.
    const rows = await _rsiQuery(db, throughIso, days,
      ' AND player = ? AND confidence >= ?', [player, NFLDB_MIN_CONFIDENCE], 'card').all();
    const list = (rows && rows.results) || [];
    if (list.length === 0) return res.json({ available: false, days, player, reason: 'no sales for this player' });

    const payload = _buildRepeatSalesPayload(list, throughIso, days, { player, unit: 'card' }, RSI_TIERS_PLAYER);
    if (payload.available) cachePut(cacheKey, payload, MARKET_TTL);
    res.json(payload);
  } catch (err) {
    console.error('[PlayerIndex]', err && err.message);
    res.json({ available: false, days, player, reason: 'index unavailable' });
  }
});

// ---- /api/sold-stats ----
// Market snapshot for the strip under the search bar. Reads our own D1 dataset
// only — no paid provider, no quota — and is football-only because the dataset
// is, which the UI says plainly rather than implying whole-hobby coverage.
//
// Period totals come from the pre-aggregated `daily` table (at most ~90 rows)
// rather than scanning millions of sales. Only the headline lookups touch
// `sales`, and those ride the sold_date / player indexes.
const SOLD_STATS_TTL = 3600; // 1h — this is identical for every visitor
const SOLD_STATS_PERIODS = [7, 30, 90, 365];

app.get('/api/sold-stats', async (req, res) => {
  const days = SOLD_STATS_PERIODS.includes(parseInt(req.query.days, 10))
    ? parseInt(req.query.days, 10)
    : 30;
  const db = getNflDb();
  if (!db) return res.json({ available: false, days });

  // v2: shape changed from player lists to card lists, so the key changes too
  // rather than serving the old shape to the new UI from a warm cache.
  const cacheKey = `soldstats:v2:${days}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return res.json(cached);

  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const img = await _nflHasImageColumn(db);
  const imgCol = img ? ', image_url' : '';

  try {
    const [totals, priciest, mostSold] = await Promise.all([
      // Pre-aggregated: cheap regardless of how many sales the period holds.
      db.prepare('SELECT SUM(sales) AS sales, SUM(priced) AS priced, SUM(total_cents) AS total FROM daily WHERE sold_date >= ?')
        .bind(since).first(),

      // Three priciest individual sales in the window.
      db.prepare(`SELECT item_id, title, price_cents, sold_date, grader, grade${imgCol}
                  FROM sales WHERE price_cents IS NOT NULL AND sold_date >= ?
                  ORDER BY price_cents DESC LIMIT 3`).bind(since).all(),

      // Three most-traded CARDS — grouped by card identity, not by player, so
      // "Mahomes" doesn't win by aggregating hundreds of different cards.
      //
      // The bare title/item_id/image_url columns come from the MAX(price_cents)
      // row: SQLite resolves bare columns in an aggregate query against the row
      // that produced the min/max, which gives a representative listing (and
      // its photo) rather than an arbitrary one.
      //
      // Confidence floor applies — the grouping columns are parsed out of
      // seller-written titles and are unreliable below it.
      db.prepare(`SELECT player, year, set_name, parallel, card_number,
                         COUNT(*) AS n, AVG(price_cents) AS avg_cents,
                         MAX(price_cents) AS max_cents,
                         title, item_id, sold_date, grader, grade${imgCol}
                  FROM sales
                  WHERE price_cents IS NOT NULL AND sold_date >= ?
                    AND confidence >= ? AND player IS NOT NULL AND player != ''
                  GROUP BY player, year, set_name, parallel, card_number
                  ORDER BY n DESC LIMIT 3`).bind(since, NFLDB_MIN_CONFIDENCE).all(),
    ]);

    const gradeOf = (r) => r.grade != null
      ? `${r.grader || ''} ${String(r.grade).replace(/\.0$/, '')}`.trim()
      : null;
    const linkOf = (r) => r.item_id ? `https://www.ebay.com/itm/${encodeURIComponent(r.item_id)}` : '';

    const priced = (totals && totals.priced) || 0;
    const totalCents = (totals && totals.total) || 0;

    const payload = {
      available: priced > 0,
      days,
      since,
      hasPhotos: img,
      // `sales` counts every tracked sale; `priced` excludes best-offer rows,
      // where eBay publishes the ask rather than what was actually paid.
      totalSales: (totals && totals.sales) || 0,
      pricedSales: priced,
      totalValue: Math.round(totalCents / 100),
      avgPrice: priced > 0 ? Math.round(totalCents / priced) / 100 : null,

      priciest: ((priciest && priciest.results) || []).map(r => ({
        title: r.title,
        price: (r.price_cents || 0) / 100,
        soldDate: r.sold_date,
        grade: gradeOf(r),
        imageUrl: r.image_url || null,
        itemUrl: linkOf(r),
      })),

      mostSold: ((mostSold && mostSold.results) || []).map(r => ({
        // A readable card name built from the parsed columns, falling back to
        // the raw title when the parse was thin.
        name: [r.year, r.set_name, r.player, r.parallel, r.card_number ? `#${r.card_number}` : '']
          .filter(Boolean).join(' ').trim() || r.title,
        sales: r.n,
        avgPrice: Math.round((r.avg_cents || 0) / 100),
        topPrice: Math.round((r.max_cents || 0) / 100),
        imageUrl: r.image_url || null,
        itemUrl: linkOf(r),
        // What to run when the tile is clicked.
        query: [r.year, r.set_name, r.player, r.parallel].filter(Boolean).join(' ').trim() || r.title,
      })),
    };

    if (payload.available) cachePut(cacheKey, payload, SOLD_STATS_TTL);
    res.json(payload);
  } catch (err) {
    // A stats widget must never break the page it sits on.
    console.error('[SoldStats]', err && err.message);
    res.json({ available: false, days, error: 'stats unavailable' });
  }
});

// ---- /api/card-analysis ----
// Everything we hold on ONE card, reached by clicking a sold result. Identity
// is derived server-side from the clicked sale so the client only passes an
// item id — no key encoding to get wrong, and the definition of "same card"
// lives in one place.
//
// Grade is a separate series rather than a filter: a PSA 10 and a raw copy are
// the same card but different markets, often an order of magnitude apart.
// Averaging them produces a line that mostly tracks which copies happened to
// sell that week, so each grade gets its own series and its own stats.
const CARD_ANALYSIS_TTL = 1800; // 30m

// Grading companies, as they appear in listing titles. Word-bounded so
// "PSA" can't match inside another word.
const GRADER_RE = /\b(PSA|BGS|BCCG|BECKETT|SGC|CGC|CSG|HGA|TAG|ISA|GMA|KSA|AGS|RCG|MNT)\b/i;
// Phrases that only appear on encapsulated cards. Deliberately excludes bare
// "mint" and "gem mint", which raw listings use constantly as condition claims.
const SLAB_RE = /\b(slab(bed)?|graded|encapsulated|pop\s*\d|cert(ification|ificate|ified)?\s*#?\s*\d)/i;
// An explicit raw claim outranks a grader mention, so "raw, PSA 10 candidate"
// and "ungraded — would grade BGS 9.5" stay where they belong.
const RAW_RE = /\b(raw|ungraded|not\s+graded|no\s+grade)\b/i;

// Which price series a sale belongs to.
//
// A null grade does NOT mean raw — it means the collector's parser didn't
// extract one, which happens both for genuinely raw cards and for slabs whose
// titles it couldn't read. Treating the whole null set as "Raw" drags slab
// prices into the raw median, which is exactly the failure this guards
// against: graded buckets stay clean because they only ever contain
// successfully parsed rows, so every miss lands in Raw.
function _gradeBucket(r) {
  if (r.grade != null && r.grade !== '') {
    const g = String(r.grade).replace(/\.0$/, '');
    return `${(r.grader || '').toUpperCase()} ${g}`.trim();
  }
  const title = String(r.title || '');
  if (RAW_RE.test(title)) return 'Raw';
  // A grader column with no grade is still unambiguously a slab.
  if (r.grader || GRADER_RE.test(title) || SLAB_RE.test(title)) return 'Graded (ungraded number)';
  return 'Raw';
}

function _median(sorted) {
  if (!sorted.length) return null;
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
}

// ---- Auto-pricer ----
// A recommended price for a card, from three sources in order of how much we
// trust them. Which one was used is always returned, because a price built on
// two-year-old comps and one built on last week's are not the same claim and
// shouldn't look the same.
//
//   1. recent-sales   Comps for this exact card, recent enough to stand alone.
//   2. trend-adjusted Older comps for this exact card, moved by how this
//                     player's prices have shifted since.
//   3. similar-cards  No comps at all, so other parallels of the same base
//                     card, reported as a range rather than a point.
//
// Everything uses medians, never means: card sales are heavy-tailed and one
// autographed variant in the wrong bucket would drag an average badly.
const PRICE_FRESH_DAYS = 60;      // a comp this recent needs no adjustment
const PRICE_STALE_CLUSTER = 120;  // window around the last sale to median over
const PRICE_TREND_MIN_SALES = 12; // per side, before a player trend is usable
// Cap on how far a player trend may move a stale comp. The trend is a median
// over ALL that player's cards, so a shift in which of their cards are selling
// moves it without any single card changing value. Clamping keeps that error
// bounded instead of letting it produce a confident-looking absurdity.
const PRICE_TREND_MAX_ADJ = 0.5;  // +/- 50%

// Median sale price for a player inside a date range. Returns null rather than
// a guess when the sample is too thin to be a median of anything.
function _playerMedianIn(prices) {
  if (!prices || prices.length < PRICE_TREND_MIN_SALES) return null;
  const s = prices.slice().sort((a, b) => a - b);
  return _median(s);
}

// How this player's prices have moved between two windows, as a multiplier.
// NOTE: deliberately NOT the market index. That index measures volume — money
// and cards moving — and a market can double in volume with completely flat
// prices. Adjusting a stale comp needs a price level, so this is a median of
// prices, not of activity.
function _playerTrendRatio(rows, fromDay, toDay) {
  const half = Math.max(30, Math.round((toDay - fromDay) / 2));
  const oldPrices = [], newPrices = [];
  for (const r of rows) {
    const d = _mkDay(r.sold_date);
    if (!Number.isFinite(d)) continue;
    const p = (r.price_cents || 0) / 100;
    if (p <= 0) continue;
    if (d >= fromDay - half && d <= fromDay + half) oldPrices.push(p);
    if (d >= toDay - half) newPrices.push(p);
  }
  const before = _playerMedianIn(oldPrices);
  const after = _playerMedianIn(newPrices);
  if (!before || !after || before <= 0) return null;
  const raw = after / before;
  const lo = 1 - PRICE_TREND_MAX_ADJ, hi = 1 + PRICE_TREND_MAX_ADJ;
  return {
    ratio: Math.min(hi, Math.max(lo, raw)),
    rawRatio: Math.round(raw * 1000) / 1000,
    clamped: raw < lo || raw > hi,
    sampleBefore: oldPrices.length,
    sampleAfter: newPrices.length,
  };
}

// Estimate for one grade of one card.
// `list` is that grade's sales, newest first. `todayDay` anchors "recent".
function _estimateGrade(list, todayDay, trend) {
  const priced = list
    .map(r => ({ day: _mkDay(r.sold_date), price: (r.price_cents || 0) / 100 }))
    .filter(r => Number.isFinite(r.day) && r.price > 0)
    .sort((a, b) => b.day - a.day);
  if (!priced.length) return null;

  const fresh = priced.filter(r => todayDay - r.day <= PRICE_FRESH_DAYS);
  const round2 = (n) => Math.round(n * 100) / 100;

  if (fresh.length) {
    const ps = fresh.map(r => r.price).sort((a, b) => a - b);
    return {
      price: round2(_median(ps)),
      method: 'recent-sales',
      // Three comps is where a median starts describing a market rather than
      // an accident. Below that it's still the best number available, just not
      // one to lean on.
      confidence: fresh.length >= 5 ? 'high' : fresh.length >= 3 ? 'medium' : 'low',
      basedOn: fresh.length,
      low: round2(ps[0]),
      high: round2(ps[ps.length - 1]),
      newestSaleDays: todayDay - priced[0].day,
    };
  }

  // Nothing fresh: median the cluster around the last sale, then move it by
  // the player's price trend since.
  const newestDay = priced[0].day;
  const cluster = priced.filter(r => newestDay - r.day <= PRICE_STALE_CLUSTER);
  const ps = cluster.map(r => r.price).sort((a, b) => a - b);
  const base = _median(ps);
  if (!base) return null;

  const staleDays = todayDay - newestDay;
  if (!trend) {
    // No usable player trend, so the old price is reported as-is rather than
    // adjusted by a number we don't have.
    return {
      price: round2(base),
      method: 'stale-sales',
      confidence: 'low',
      basedOn: cluster.length,
      low: round2(ps[0]), high: round2(ps[ps.length - 1]),
      newestSaleDays: staleDays,
    };
  }
  return {
    price: round2(base * trend.ratio),
    method: 'trend-adjusted',
    confidence: staleDays > 365 ? 'low' : 'medium',
    basedOn: cluster.length,
    unadjustedPrice: round2(base),
    trendPct: Math.round((trend.ratio - 1) * 1000) / 10,
    trendClamped: !!trend.clamped,
    low: round2(ps[0] * trend.ratio), high: round2(ps[ps.length - 1] * trend.ratio),
    newestSaleDays: staleDays,
  };
}

// Tier 3: this exact card has never sold, so price it off its siblings — the
// same base card in other parallels. Returns a RANGE, not a point: parallels
// of one card can differ by two orders of magnitude, and a single number here
// would imply a precision that doesn't exist.
async function _similarVariantEstimate(db, seed) {
  const eq = (col, val) => val == null || val === '' ? `(${col} IS NULL OR ${col} = '')` : `${col} = ?`;
  const binds = [NFLDB_MIN_CONFIDENCE, seed.player];
  const parts = ['price_cents IS NOT NULL', 'confidence >= ?', 'player = ?'];
  for (const [col, val] of [['year', seed.year], ['set_name', seed.set_name], ['card_number', seed.card_number]]) {
    parts.push(eq(col, val));
    if (val != null && val !== '') binds.push(val);
  }
  const rows = await db.prepare(
    `SELECT price_cents, parallel, sold_date FROM sales
      WHERE ${parts.join(' AND ')}
      ORDER BY sold_date DESC LIMIT 400`
  ).bind(...binds).all();

  const list = ((rows && rows.results) || []).filter(r => (r.price_cents || 0) > 0);
  if (list.length < 3) return null;

  const ps = list.map(r => r.price_cents / 100).sort((a, b) => a - b);
  const q = (f) => ps[Math.min(ps.length - 1, Math.max(0, Math.floor(f * (ps.length - 1))))];
  const round2 = (n) => Math.round(n * 100) / 100;
  const variants = new Set(list.map(r => r.parallel || 'Base'));
  return {
    price: round2(_median(ps)),
    method: 'similar-cards',
    // Never above low. It's a different card by definition.
    confidence: 'low',
    basedOn: list.length,
    variantCount: variants.size,
    // Interquartile range: the outer parallels of a set are exactly the ones
    // that would make a min/max meaningless.
    low: round2(q(0.25)),
    high: round2(q(0.75)),
  };
}

app.get('/api/card-analysis', async (req, res) => {
  const itemId = String(req.query.itemId || '').trim();
  if (!itemId) return res.status(400).json({ error: 'itemId is required' });

  const db = getNflDb();
  if (!db) return res.json({ available: false, reason: 'no-dataset' });

  // v2: the payload now carries price estimates, so a warm v1 entry
    // would serve the new UI a shape with no estimate in it.
    const cacheKey = `cardanalysis:v2:${itemId}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return res.json(cached);

  try {
    const seed = await db.prepare(
      `SELECT player, year, set_name, parallel, card_number, confidence, title
       FROM sales WHERE item_id = ?`
    ).bind(itemId).first();

    // Not our row, or parsed too loosely to group on — either way there's no
    // trustworthy card identity to gather sales under.
    if (!seed || !seed.player || (seed.confidence || 0) < NFLDB_MIN_CONFIDENCE) {
      const out = { available: false, reason: seed ? 'low-confidence' : 'unknown-item' };
      return res.json(out);
    }

    // NULL-safe matching: `parallel IS NULL` and `card_number IS NULL` are
    // ordinary states (base cards, unnumbered), and `= NULL` never matches.
    const eq = (col, val) => val == null || val === '' ? `${col} IS NULL OR ${col} = ''` : `${col} = ?`;
    const where = [
      'price_cents IS NOT NULL',
      `confidence >= ?`,
      'player = ?',
      `(${eq('year', seed.year)})`,
      `(${eq('set_name', seed.set_name)})`,
      `(${eq('parallel', seed.parallel)})`,
      `(${eq('card_number', seed.card_number)})`,
    ].join(' AND ');
    const binds = [NFLDB_MIN_CONFIDENCE, seed.player];
    for (const v of [seed.year, seed.set_name, seed.parallel, seed.card_number]) {
      if (v != null && v !== '') binds.push(v);
    }

    const img = await _nflHasImageColumn(db);
    const rows = await db.prepare(
      `SELECT item_id, sold_date, title, price_cents, grader, grade${img ? ', image_url' : ''}
       FROM sales WHERE ${where}
       ORDER BY sold_date DESC LIMIT 2000`
    ).bind(...binds).all();

    const all = (rows && rows.results) || [];
    if (all.length === 0) {
      // This exact card has never sold. It can still be priced off its
      // siblings, so the modal has something useful to show rather than a
      // dead end — flagged as an estimate from other cards, not this one.
      const similar = await _similarVariantEstimate(db, seed);
      const out = similar
        ? { available: false, reason: 'no-sales', estimate: similar }
        : { available: false, reason: 'no-sales' };
      if (similar) cachePut(cacheKey, out, CARD_ANALYSIS_TTL);
      return res.json(out);
    }

    // The dataset's own "now" — using the wall clock would make every card
    // look stale whenever the collector falls behind.
    const newestDay = _mkDay(all.map(r => r.sold_date).filter(Boolean).sort().slice(-1)[0]);

    // One read of the player's price history, reused for every grade that
    // needs trend-adjusting. Skipped entirely when every grade has fresh
    // comps, which is the common case.
    let trend = null;
    const oldestNeeded = Math.min(...all.map(r => _mkDay(r.sold_date)).filter(Number.isFinite));
    const anyStale = Array.from(new Set(all.map(r => _gradeBucket(r)))).some(k => {
      const newest = Math.max(...all.filter(r => _gradeBucket(r) === k)
        .map(r => _mkDay(r.sold_date)).filter(Number.isFinite));
      return Number.isFinite(newest) && (newestDay - newest) > PRICE_FRESH_DAYS;
    });
    if (anyStale) {
      const trendRows = await db.prepare(
        `SELECT sold_date, price_cents FROM sales
          WHERE player = ? AND confidence >= ? AND price_cents IS NOT NULL
            AND sold_date >= ?
          ORDER BY sold_date DESC LIMIT 4000`
      ).bind(seed.player, NFLDB_MIN_CONFIDENCE, _mkIso(oldestNeeded - 180)).all();
      trend = _playerTrendRatio((trendRows && trendRows.results) || [], oldestNeeded, newestDay);
    }

    // Split into per-grade series, then reduce each to one point per day so a
    // busy day doesn't outweigh a quiet one on the chart.
    const byGrade = new Map();
    for (const r of all) {
      const k = _gradeBucket(r);
      if (!byGrade.has(k)) byGrade.set(k, []);
      byGrade.get(k).push(r);
    }

    const grades = Array.from(byGrade.entries()).map(([label, list]) => {
      const prices = list.map(r => (r.price_cents || 0) / 100).filter(p => p > 0).sort((a, b) => a - b);
      const byDay = new Map();
      for (const r of list) {
        const d = String(r.sold_date || '').slice(0, 10);
        const p = (r.price_cents || 0) / 100;
        if (!d || p <= 0) continue;
        if (!byDay.has(d)) byDay.set(d, []);
        byDay.get(d).push(p);
      }
      const points = Array.from(byDay.entries())
        .map(([date, ps]) => { ps.sort((a, b) => a - b); return { date, median: Math.round(_median(ps) * 100) / 100, sales: ps.length }; })
        .sort((a, b) => a.date.localeCompare(b.date));

      // Trend: latest point against the median of everything before it, which
      // is steadier on thin data than comparing two fixed windows.
      let changePct = null;
      if (points.length >= 2) {
        const prior = points.slice(0, -1).map(p => p.median).sort((a, b) => a - b);
        const base = _median(prior);
        const last = points[points.length - 1].median;
        if (base > 0) changePct = Math.round(((last - base) / base) * 1000) / 10;
      }

      // Trend is anchored to THIS grade's own last sale, not the card's, so a
      // grade that stopped selling long ago isn't adjusted by the wrong span.
      const gradeNewest = Math.max(...list.map(r => _mkDay(r.sold_date)).filter(Number.isFinite));
      const gradeTrend = (trend && Number.isFinite(gradeNewest)) ? trend : null;

      return {
        label,
        sales: list.length,
        estimate: _estimateGrade(list, newestDay, gradeTrend),
        // The individual sales behind the figure. Capped because a busy grade
        // can run to hundreds and the whole payload is cached in KV.
        recent: list.slice(0, 25).map(r => ({
          title: String(r.title || '').slice(0, 110),
          price: (r.price_cents || 0) / 100,
          soldDate: r.sold_date,
          imageUrl: r.image_url || null,
          itemUrl: r.item_id ? `https://www.ebay.com/itm/${encodeURIComponent(r.item_id)}` : '',
        })),
        median: Math.round(_median(prices) * 100) / 100,
        low: prices[0] ?? null,
        high: prices[prices.length - 1] ?? null,
        lastSale: list[0] ? { price: (list[0].price_cents || 0) / 100, date: list[0].sold_date } : null,
        changePct,
        points,
      };
    }).sort((a, b) => b.sales - a.sales);

    const dates = all.map(r => r.sold_date).filter(Boolean).sort();
    const payload = {
      available: true,
      card: {
        name: [seed.year, seed.set_name, seed.player, seed.parallel, seed.card_number ? `#${seed.card_number}` : '']
          .filter(Boolean).join(' ').trim() || seed.title,
        player: seed.player, year: seed.year, set: seed.set_name,
        parallel: seed.parallel, cardNumber: seed.card_number,
        imageUrl: (all.find(r => r.image_url) || {}).image_url || null,
      },
      totalSales: all.length,
      firstSale: dates[0] || null,
      lastSale: dates[dates.length - 1] || null,
      grades,
    };

    cachePut(cacheKey, payload, CARD_ANALYSIS_TTL);
    res.json(payload);
  } catch (err) {
    console.error('[CardAnalysis]', err && err.message);
    res.json({ available: false, reason: 'error' });
  }
});

// ---- /api/price-estimate ----
// Price a card from a search query rather than from a sold row we already
// hold. This is the "I searched and nothing came up" path: no comps to click
// means no card modal, which means the auto-pricer never ran — even when we
// hold plenty of sales that could answer the question.
//
// Works down a ladder, widening only as far as it has to and always saying
// how far it went:
//
//   1. title      every search term appears in a sale title
//   2. player+year   that player's cards from that year
//   3. player     anything of that player's
//
// Each rung is a weaker claim than the one above, so `matchedOn` comes back
// with the estimate and the UI states it rather than implying an exact comp.
const PRICE_ESTIMATE_TTL = 3600;
const PRICE_ESTIMATE_MIN_ROWS = 3;

// Longest roster name contained in the query. Longest wins so "Marvin
// Harrison Jr" beats "Marvin Harrison" when both are real players.
function _playerFromQuery(roster, q) {
  const hay = ` ${String(q).toLowerCase()} `;
  let best = null;
  for (const p of roster) {
    const name = String(p.player || '').toLowerCase();
    if (name.length < 4) continue;
    if (hay.includes(` ${name} `) || hay.includes(name)) {
      if (!best || name.length > best.length) best = p.player;
    }
  }
  return best;
}

function _yearFromQuery(q) {
  const m = String(q).match(/\b(19[5-9]\d|20[0-4]\d)\b/);
  return m ? m[1] : null;
}

app.get('/api/price-estimate', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q || q.length < 3) return res.json({ available: false, reason: 'no query' });

  const db = getNflDb();
  if (!db) return res.json({ available: false, reason: 'no dataset' });

  const cacheKey = `priceest:v1:${q.toLowerCase().replace(/\s+/g, ' ').slice(0, 120)}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return res.json(cached);

  const fail = (reason) => res.json({ available: false, reason, query: q });

  try {
    const newest = await db.prepare('SELECT MAX(sold_date) AS d FROM sales').first();
    if (!newest || !newest.d) return fail('no sales data');
    const todayDay = _mkDay(newest.d);

    const cols = 'sold_date, price_cents, title, grader, grade';
    let rows = null;
    let matchedOn = null;
    let player = null, year = null;

    // 1. Every term in the title. Same shape as the sold search, so a query
    //    that returns nothing there can still land here when the terms are
    //    present but the sale is outside the search's window or grouping.
    const terms = q.split(/\s+/).map(t => t.trim()).filter(t => t.length > 1).slice(0, 8);
    if (terms.length) {
      const where = ['price_cents IS NOT NULL', ...terms.map(() => 'title LIKE ?')].join(' AND ');
      const r = await db.prepare(
        `SELECT ${cols} FROM sales WHERE ${where} ORDER BY sold_date DESC LIMIT 400`
      ).bind(...terms.map(t => `%${t}%`)).all();
      const list = ((r && r.results) || []).filter(x => (x.price_cents || 0) > 0);
      if (list.length >= PRICE_ESTIMATE_MIN_ROWS) { rows = list; matchedOn = 'title'; }
    }

    // 2/3. Fall back to the player, narrowed by year when the query names one.
    if (!rows) {
      const roster = await _playerRoster(db);
      player = _playerFromQuery(roster, q);
      if (!player) return fail('no match');
      year = _yearFromQuery(q);

      if (year) {
        const r = await db.prepare(
          `SELECT ${cols} FROM sales
            WHERE price_cents IS NOT NULL AND confidence >= ? AND player = ? AND year = ?
            ORDER BY sold_date DESC LIMIT 400`
        ).bind(NFLDB_MIN_CONFIDENCE, player, year).all();
        const list = ((r && r.results) || []).filter(x => (x.price_cents || 0) > 0);
        if (list.length >= PRICE_ESTIMATE_MIN_ROWS) { rows = list; matchedOn = 'player-year'; }
      }

      if (!rows) {
        const r = await db.prepare(
          `SELECT ${cols} FROM sales
            WHERE price_cents IS NOT NULL AND confidence >= ? AND player = ?
            ORDER BY sold_date DESC LIMIT 400`
        ).bind(NFLDB_MIN_CONFIDENCE, player).all();
        const list = ((r && r.results) || []).filter(x => (x.price_cents || 0) > 0);
        if (list.length >= PRICE_ESTIMATE_MIN_ROWS) { rows = list; matchedOn = 'player'; year = null; }
      }
    }

    if (!rows) return fail('no match');

    // Price the grade bucket the query actually asked about when it named one
    // ("psa 10"), otherwise the best-supported bucket. Mixing raw and slabbed
    // sales into one median would describe neither.
    const buckets = new Map();
    for (const r of rows) {
      const k = _gradeBucket(r);
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(r);
    }
    const asked = _gradeBucket({ grade: null, grader: null, title: q });
    const askedExplicit = /\b(psa|bgs|sgc|cgc|beckett)\s*\d/i.test(q);
    let label = null;
    if (askedExplicit) {
      const m = q.match(/\b(psa|bgs|sgc|cgc)\s*(\d+(?:\.\d)?)/i);
      if (m) {
        const want = `${m[1].toUpperCase()} ${m[2].replace(/\.0$/, '')}`;
        if (buckets.has(want)) label = want;
      }
    } else if (asked === 'Raw' && buckets.has('Raw')) {
      label = 'Raw';
    }
    if (!label) {
      label = Array.from(buckets.entries()).sort((a, b) => b[1].length - a[1].length)[0][0];
    }
    const list = buckets.get(label);

    // A title match is the same card, so the full ladder applies. A player
    // match is explicitly other cards, so it's a range and never better than
    // low confidence — the same treatment tier 3 gets in the card modal.
    let estimate;
    if (matchedOn === 'title') {
      let trend = null;
      const gradeNewest = Math.max(...list.map(r => _mkDay(r.sold_date)).filter(Number.isFinite));
      if (Number.isFinite(gradeNewest) && (todayDay - gradeNewest) > PRICE_FRESH_DAYS) {
        const roster = await _playerRoster(db);
        const p = _playerFromQuery(roster, q);
        if (p) {
          const tr = await db.prepare(
            `SELECT sold_date, price_cents FROM sales
              WHERE player = ? AND confidence >= ? AND price_cents IS NOT NULL AND sold_date >= ?
              ORDER BY sold_date DESC LIMIT 4000`
          ).bind(p, NFLDB_MIN_CONFIDENCE, _mkIso(gradeNewest - 180)).all();
          trend = _playerTrendRatio((tr && tr.results) || [], gradeNewest, todayDay);
        }
      }
      estimate = _estimateGrade(list, todayDay, trend);
    } else {
      const ps = list.map(r => r.price_cents / 100).sort((a, b) => a - b);
      const pick = (f) => ps[Math.min(ps.length - 1, Math.max(0, Math.floor(f * (ps.length - 1))))];
      const round2 = (n) => Math.round(n * 100) / 100;
      estimate = {
        price: round2(_median(ps)),
        method: 'similar-cards',
        confidence: 'low',
        basedOn: ps.length,
        low: round2(pick(0.25)),
        high: round2(pick(0.75)),
      };
    }
    if (!estimate) return fail('no match');

    const payload = {
      available: true,
      query: q,
      estimate,
      grade: label,
      matchedOn,
      player: player || null,
      year: year || null,
      // Every bucket we saw, so the UI can say what else exists rather than
      // implying the one we priced is all there is.
      grades: Array.from(buckets.entries())
        .map(([l, v]) => ({ label: l, sales: v.length }))
        .sort((a, b) => b.sales - a.sales).slice(0, 6),
    };
    cachePut(cacheKey, payload, PRICE_ESTIMATE_TTL);
    res.json(payload);
  } catch (err) {
    console.error('[PriceEstimate]', err && err.message);
    return fail('estimate unavailable');
  }
});

// ---- /api/card-forsale ----
// Active listings for the same card, resolved from a sold row's identity.
// Deliberately its own endpoint: this is an eBay round-trip, while
// /api/card-analysis is a local D1 read, and one shouldn't wait on the other.
const CARD_FORSALE_TTL = 1800; // 30m

app.get('/api/card-forsale', async (req, res) => {
  const itemId = String(req.query.itemId || '').trim();
  if (!itemId) return res.status(400).json({ error: 'itemId is required' });

  const db = getNflDb();
  if (!db) return res.json({ available: false, results: [] });

  const cacheKey = `cardforsale:v1:${itemId}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return res.json(cached);

  try {
    const seed = await db.prepare(
      `SELECT player, year, set_name, parallel, card_number, confidence
       FROM sales WHERE item_id = ?`
    ).bind(itemId).first();
    if (!seed || !seed.player || (seed.confidence || 0) < NFLDB_MIN_CONFIDENCE) {
      return res.json({ available: false, results: [] });
    }

    // Card number is left out of the search text: sellers write it
    // inconsistently ("#12", "12", omitted), and including it costs more
    // matches than it buys. The variant filter below does the tightening.
    const query = [seed.year, seed.set_name, seed.player, seed.parallel]
      .filter(Boolean).join(' ').trim();
    if (!query) return res.json({ available: false, results: [] });

    const data = await fetchEbayItems(query, 24, 'forsale', 'card-forsale');
    const results = filterByVariant(data.results || [], query, { strict: true })
      .slice(0, 12)
      .map(r => ({
        title: r.title, price: r.price, imageUrl: r.imageUrl,
        itemUrl: r.itemUrl, condition: r.condition,
      }));

    const payload = { available: results.length > 0, query, results };
    cachePut(cacheKey, payload, CARD_FORSALE_TTL);
    res.json(payload);
  } catch (err) {
    // Live listings are a bonus on top of the history — never an error state.
    console.error('[CardForSale]', err && err.message);
    res.json({ available: false, results: [] });
  }
});

// ---- /api/sold-history ----
// A card's accumulated sale history from our own archive. Reads only what we
// already stored — never calls the provider, so it costs nothing and works
// past the plan's lookback window. Empty until searches have built it up.
app.get('/api/sold-history', async (req, res) => {
  const query = req.query.q;
  if (!query || query.trim().length < 2) {
    return res.status(400).json({ error: 'Query parameter "q" is required (min 2 chars)' });
  }
  const opts = {};
  if (req.query.grader) opts.grader = req.query.grader;
  if (req.query.grade) opts.grade = req.query.grade;
  try {
    const sales = await getArchivedSales(query, opts);
    const summary = summarizeArchive(sales);
    if (!summary) {
      return res.json({ query, totalSales: 0, days: 0, points: [], sales: [] });
    }
    // Raw sales are capped in the response; the summary carries the shape a
    // chart needs without shipping thousands of rows to the browser.
    res.json({
      query,
      ...summary,
      sales: sales.slice(0, 100).map(s => ({
        title: s.title, price: s.price, soldDate: s.soldDate,
        itemUrl: s.itemUrl, imageUrl: s.imageUrl, condition: s.condition,
        printRun: s.printRun, platform: s.platform,
      })),
    });
  } catch (err) {
    console.error('[SoldHistory]', err.message);
    res.status(500).json({ error: 'Failed to read sold history' });
  }
});

// ---- Health check for Render ----
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ---- Debug endpoint: test the sold-price provider ----
// Sold search failing looks identical from the outside whether the secret is
// missing, the key is rejected, or the daily budget is spent. This says which,
// bypassing the cache so it always reflects the live state. Never echoes the
// key itself — only whether one is present and how long it is.
app.get('/api/debug/sold-test', async (req, res) => {
  const q = req.query.q || 'patrick mahomes prizm';
  const out = {
    query: q,
    soldProvider: SOLD_PROVIDER, // auto | nflcarddb | cardapi
    // Our own D1 dataset — reported first because it's the first source tried.
    nflCardDb: await (async () => {
      const db = getNflDb();
      if (!db) return { bound: false, note: 'No NFLDB binding — create the D1 database and uncomment the block in wrangler.toml.' };
      try {
        const r = await db.prepare(
          'SELECT COUNT(*) AS n, MIN(sold_date) AS first, MAX(sold_date) AS last FROM sales WHERE price_cents IS NOT NULL'
        ).first();
        return { bound: true, pricedSales: r ? r.n : 0, firstSale: r ? r.first : null, lastSale: r ? r.last : null };
      } catch (err) {
        return { bound: true, error: err && err.message, note: 'Binding exists but the query failed — has schema.sql been applied?' };
      }
    })(),
    keyPresent: !!CARD_API_KEY,
    keyLength: CARD_API_KEY ? String(CARD_API_KEY).length : 0,
  };
  if (!CARD_API_KEY) {
    out.status = 'NO_KEY';
    out.fix = 'Run: wrangler secret put CARD_API_KEY — then redeploy.';
    return res.json(out);
  }
  try {
    const r = await axios.get(`${CARD_API_BASE}/sales`, {
      params: { q, limit: 3, sort: 'date_desc' },
      headers: { 'x-market-api-key': CARD_API_KEY },
      timeout: 15000,
    });
    const rows = Array.isArray(r.data?.data) ? r.data.data : [];
    out.status = 'OK';
    out.httpStatus = r.status;
    out.rowsReturned = rows.length;
    out.totalMatching = r.data?.pagination?.total ?? null;
    out.rowsLeftToday = r.headers?.['x-ratelimit-remaining'] ?? null;
    out.dailyLimit = r.headers?.['x-ratelimit-limit'] ?? null;
    out.coverage = r.data?.meta || null; // lookback window the plan actually grants
    out.sample = rows[0] ? { title: rows[0].title, price: rows[0].price, sale_date: rows[0].sale_date } : null;
    // How much history we've accumulated for this query beyond the plan window.
    const archived = await getArchivedSales(q);
    const summary = summarizeArchive(archived);
    out.archive = summary
      ? { totalSales: summary.totalSales, days: summary.days, firstSale: summary.firstSale, lastSale: summary.lastSale }
      : { totalSales: 0, days: 0, note: 'Nothing archived yet for this query — it fills as searches run.' };
  } catch (err) {
    const status = err.response?.status || null;
    out.status = status === 429 ? 'DAILY_LIMIT_REACHED' : status === 401 ? 'KEY_REJECTED' : 'FAILED';
    out.httpStatus = status;
    out.error = err.message;
    out.detail = err.response?.data ? JSON.stringify(err.response.data).slice(0, 300) : null;
    if (status === 401) out.fix = 'The key was rejected. Re-check it and re-run: wrangler secret put CARD_API_KEY';
    if (status === 429) out.fix = 'Daily sale-row budget spent. Resets 00:00 UTC.';
  }
  res.json(out);
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
      forsale: stats.forsale,     // browse calls today + cache-hit rate
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
  // Price alerts are free for everyone — capped at 25/account to keep the cron
  // check bounded.
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

// ---- /api/scan-lead ----
// Lightweight email capture from the free Grade My Card scanner. Anyone (no
// account needed) can ask to be emailed when their scanned card's a good time
// to sell. Stored as a lead so it can be converted later — this is top-of-funnel
// for Pro, not a full price alert.
const SCAN_LEADS_FILE = path.join(APP_ROOT, 'data', 'scan-leads.json');
function loadScanLeads() { return loadData('scan-leads', SCAN_LEADS_FILE, { leads: [] }); }
function saveScanLeads(data) { saveData('scan-leads', SCAN_LEADS_FILE, data); }

app.post('/api/scan-lead', (req, res) => {
  const { email, card, grade } = req.body || {};
  if (!email || !email.match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)) {
    return res.status(400).json({ error: 'A valid email is required' });
  }
  const data = loadScanLeads();
  const norm = email.trim().toLowerCase();
  const cardStr = (card || '').toString().slice(0, 160);
  // De-dupe on email+card so repeat scans of the same card don't pile up.
  const dup = data.leads.find(l => l.email === norm && (l.card || '') === cardStr);
  if (!dup) {
    data.leads.push({
      id: crypto.randomUUID(),
      email: norm,
      card: cardStr,
      grade: Number.isFinite(+grade) ? +grade : null,
      source: 'grade-scanner',
      createdAt: new Date().toISOString(),
      // Drip nurture state — the sequence that converts the lead to Pro.
      unsubToken: crypto.randomUUID(),
      dripStage: 0,         // how many drip emails have been sent
      lastDripAt: null,
      unsubscribed: false,
      dripDone: false,
    });
    saveScanLeads(data);
    // Kick the drip soon so the welcome email goes out within seconds, not
    // on the next interval. The in-flight lock prevents a double-send if the
    // scheduled run overlaps.
    setTimeout(() => { processScanLeadDrip().catch(() => {}); }, 1500);
  }
  res.json({ ok: true });
});

// ---- Lead → email drip (converts captured scanner emails to Pro) ----
// A short nurture sequence: welcome + value → "is it worth grading?" → sell-window
// urgency. Each email carries a Pro/free-trial CTA and a one-click unsubscribe.
// Reuses the same provider-agnostic sendEmail() the price alerts use.
const DRIP_ORIGIN = (process.env.SITE_URL || 'https://thecardhuddle.com').replace(/\/$/, '');
const _DAY = 24 * 60 * 60 * 1000;

function _dripUnsubUrl(lead) {
  return `${DRIP_ORIGIN}/api/scan-lead/unsubscribe?id=${encodeURIComponent(lead.id)}&t=${encodeURIComponent(lead.unsubToken || '')}`;
}
function _dripCta(label, query) {
  const url = query
    ? `${DRIP_ORIGIN}/?utm_source=drip&utm_medium=email&prefill=${encodeURIComponent(query)}`
    : `${DRIP_ORIGIN}/?utm_source=drip&utm_medium=email`;
  return `<a href="${url}" style="display:inline-block;background:#2d6a4f;color:#fff;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:8px;">${label}</a>`;
}
function _dripShell(lead, bodyHtml) {
  const card = lead.card || 'your card';
  return `
    <div style="font-family:Inter,Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#1a1a1a;">
      <p style="font-size:13px;letter-spacing:0.06em;color:#2d6a4f;font-weight:700;margin:0 0 18px;">THE CARD HUDDLE</p>
      ${bodyHtml}
      <p style="color:#999;font-size:12px;margin-top:28px;border-top:1px solid #eee;padding-top:14px;">
        You're getting this because you asked us to email sell-time tips for ${_esc(card)} on The Card Huddle.
        <br><a href="${_dripUnsubUrl(lead)}" style="color:#999;">Unsubscribe</a>
      </p>
    </div>`;
}
function _esc(s) {
  return String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

const DRIP_STEPS = [
  {
    key: 'welcome',
    delayMs: 0,
    subject: (l) => `What your ${l.card || 'card'} could be worth graded`,
    body: (l) => {
      const g = Number.isFinite(l.grade) ? l.grade : null;
      const gradeLine = g != null
        ? `Your scan came back around <strong>${g}/10</strong>. `
        : '';
      return _dripShell(l, `
        <h2 style="margin:0 0 10px;font-size:22px;">Thanks for grading ${_esc(l.card || 'your card')} 👋</h2>
        <p style="line-height:1.6;color:#333;">${gradeLine}Here's the thing most collectors miss: a clean copy that grades a 9 or 10 routinely sells for <strong>several times</strong> its raw price. That gap is your upside — but only if it's actually worth the grading fee.</p>
        <p style="line-height:1.6;color:#333;">Pull the live eBay sold prices for ${_esc(l.card || 'your card')} — raw vs graded — and see the exact swing before you spend a dime:</p>
        <p style="margin:22px 0;">${_dripCta('See live sold values', l.card)}</p>
      `);
    },
  },
  {
    key: 'worth-grading',
    delayMs: 2 * _DAY,
    subject: (l) => `Is your ${l.card || 'card'} actually worth grading?`,
    body: (l) => _dripShell(l, `
      <h2 style="margin:0 0 10px;font-size:22px;">The grading math, in 30 seconds</h2>
      <p style="line-height:1.6;color:#333;">Grading runs ~$25 and a few weeks. It only pays off when the graded premium clears that. Some cards triple in value at a PSA 10 — others barely move. Guessing wrong costs you money either way.</p>
      <p style="line-height:1.6;color:#333;">The Card Huddle shows the <strong>raw-vs-graded swing</strong> for ${_esc(l.card || 'your card')} from real sold comps, so you only grade the ones that pay. Track it free and we'll keep an eye on the price for you.</p>
      <p style="margin:22px 0;">${_dripCta('Run the numbers on my card', l.card)}</p>
    `),
  },
  {
    key: 'sell-window',
    delayMs: 5 * _DAY,
    subject: (l) => `Don't miss the sell window on your ${l.card || 'card'}`,
    body: (l) => _dripShell(l, `
      <h2 style="margin:0 0 10px;font-size:22px;">Prices move fast. Get the alert.</h2>
      <p style="line-height:1.6;color:#333;">Playoff runs, breakouts, injuries — card values can swing 20–40% in a week. Miss the spike and you leave real money on the table.</p>
      <p style="line-height:1.6;color:#333;">Set a free price alert on ${_esc(l.card || 'your card')} and we'll email you the moment the market moves. Start a <strong>free 7-day Pro trial</strong> to turn on sell-time alerts:</p>
      <p style="margin:22px 0;">${_dripCta('Start my free trial', l.card)}</p>
    `),
  },
];

async function sendDripEmail(lead, stepIndex) {
  const step = DRIP_STEPS[stepIndex];
  if (!step) return false;
  if (!useResend && !emailTransporter) {
    console.log(`[Drip] email not configured — would send "${step.key}" to ${lead.email}`);
    return false;
  }
  return sendEmail({ to: lead.email, subject: step.subject(lead), html: step.body(lead) });
}

// Backfill drip fields on any older lead that predates this feature.
function _ensureDripFields(lead) {
  if (!lead.unsubToken) lead.unsubToken = crypto.randomUUID();
  if (typeof lead.dripStage !== 'number') lead.dripStage = 0;
  if (typeof lead.unsubscribed !== 'boolean') lead.unsubscribed = false;
  if (typeof lead.dripDone !== 'boolean') lead.dripDone = false;
  if (!('lastDripAt' in lead)) lead.lastDripAt = null;
}

// Which step (if any) is due for this lead right now.
function _dripDue(lead, now) {
  if (lead.unsubscribed || lead.dripDone) return -1;
  const stage = lead.dripStage || 0;
  if (stage >= DRIP_STEPS.length) return -1;
  const created = Date.parse(lead.createdAt) || now;
  if (now - created < DRIP_STEPS[stage].delayMs) return -1;
  // Safety throttle: never two drip emails to the same lead within 12h.
  if (lead.lastDripAt && now - Date.parse(lead.lastDripAt) < 12 * 60 * 60 * 1000) return -1;
  return stage;
}

let _dripRunning = false;
async function processScanLeadDrip() {
  if (_dripRunning) return;
  _dripRunning = true;
  try {
    const data = loadScanLeads();
    if (!data.leads || !data.leads.length) return;
    const now = Date.now();
    let changed = false;
    let sent = 0;
    for (const lead of data.leads) {
      _ensureDripFields(lead);
      const step = _dripDue(lead, now);
      if (step < 0) continue;
      const ok = await sendDripEmail(lead, step);
      // Advance regardless of send success (best-effort) so a bad address
      // can't wedge the sequence; log failures for visibility.
      lead.dripStage = (lead.dripStage || 0) + 1;
      lead.lastDripAt = new Date().toISOString();
      if (lead.dripStage >= DRIP_STEPS.length) lead.dripDone = true;
      changed = true;
      sent++;
      console.log(`[Drip] step "${DRIP_STEPS[step].key}" -> ${lead.email} (${ok ? 'sent' : 'send failed/unconfigured'})`);
      await new Promise(r => setTimeout(r, 1500)); // gentle pacing
    }
    if (changed) saveScanLeads(data);
    if (sent) console.log(`[Drip] processed ${sent} email(s).`);
  } catch (err) {
    console.error('[Drip] processing error:', err.message);
  } finally {
    _dripRunning = false;
  }
}

// One-click unsubscribe (no auth — guarded by the per-lead token).
app.get('/api/scan-lead/unsubscribe', (req, res) => {
  const { id, t } = req.query;
  const page = (ok) => `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
    <div style="font-family:system-ui,sans-serif;max-width:480px;margin:80px auto;text-align:center;padding:0 20px;">
      <h2 style="color:#2d6a4f;">${ok ? "You're unsubscribed" : 'Link expired'}</h2>
      <p style="color:#555;">${ok ? "You won't get any more sell-time emails for this card." : "We couldn't process that unsubscribe link."}</p>
      <p><a href="${DRIP_ORIGIN}" style="color:#2d6a4f;">Back to The Card Huddle</a></p>
    </div>`;
  const data = loadScanLeads();
  const lead = data.leads.find(l => l.id === id);
  if (lead && lead.unsubToken && t === lead.unsubToken) {
    if (!lead.unsubscribed) { lead.unsubscribed = true; lead.unsubscribedAt = new Date().toISOString(); saveScanLeads(data); }
    return res.send(page(true));
  }
  res.status(400).send(page(false));
});

// Admin: drip funnel stats (counts only).
app.get('/api/scan-lead/stats', (req, res) => {
  if (!isAdminReq(req)) return res.status(403).json({ error: 'Forbidden' });
  const data = loadScanLeads();
  const leads = data.leads || [];
  const byStage = {};
  for (const l of leads) { const s = l.dripStage || 0; byStage[s] = (byStage[s] || 0) + 1; }
  res.json({
    total: leads.length,
    unsubscribed: leads.filter(l => l.unsubscribed).length,
    completed: leads.filter(l => l.dripDone).length,
    byStage,
  });
});

// Admin: manually trigger a drip pass (for an external cron on Workers, where
// setInterval doesn't persist between requests).
app.post('/api/scan-lead/run-drip', async (req, res) => {
  if (!isAdminReq(req)) return res.status(403).json({ error: 'Forbidden' });
  await processScanLeadDrip();
  res.json({ ok: true });
});

// Start the drip loop. Hourly is plenty — the day-based delays pace the
// sequence; the per-capture kick handles the welcome promptly. On Workers the
// Cron Trigger drives processScanLeadDrip() instead (setInterval is unreliable
// across request-scoped isolates).
const DRIP_INTERVAL = 60 * 60 * 1000;
if (process.env.CF_WORKER !== '1') {
  setInterval(() => { processScanLeadDrip().catch(() => {}); }, DRIP_INTERVAL);
  setTimeout(() => { processScanLeadDrip().catch(() => {}); }, 45000);
}

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
      // Sold data source retired — price alerts pause until eBay's official
      // sold-data API is connected. With no results, alerts simply never fire
      // (the loop below is a no-op) rather than failing the whole run.
      let searchResult = USE_MOCK ? getMockData(alert.query, 'sold') : { results: [] };

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

  // Merge rather than overwrite. This loop is long-running and awaits between
  // alerts, so alerts can be deleted while it works — by the owner, or by an
  // account deletion. Writing back the snapshot we loaded at the top would
  // resurrect them, which for account deletion means undoing an erasure we
  // told the user was permanent. Re-read, and only carry over the check state
  // for alerts that still exist.
  const fresh = loadAlerts();
  const checked = new Map(data.alerts.map(a => [a.id, a]));
  for (const a of fresh.alerts) {
    const c = checked.get(a.id);
    if (!c) continue;
    a.lastChecked = c.lastChecked;
    a.lastSeenIds = c.lastSeenIds;
  }
  saveAlerts(fresh);
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

// Start alert checker loop. On Node (local/VPS) we self-schedule; on Cloudflare
// Workers, setInterval doesn't survive between requests, so a Cron Trigger calls
// checkAlerts() via the worker's scheduled() handler instead.
if (process.env.CF_WORKER !== '1') {
  setInterval(checkAlerts, ALERT_CHECK_INTERVAL);
  // Run first check 30 seconds after startup
  setTimeout(checkAlerts, 30000);
}

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

// Accounts granted a permanent, no-charge Pro plan (staff / owner / brand
// accounts). These are treated as an active 'pro' subscription everywhere the
// app reads subscription status, without a Stripe record. Usernames are
// compared lowercased. Add or remove names here to grant/revoke.
const PRO_GRANT_USERS = new Set(['thecardhuddle']);

// Returns the subscription record for a user, layering in a permanent Pro grant
// for allowlisted accounts. Any real Stripe fields already on the record are
// preserved; the grant only guarantees an active 'pro' plan.
function getEffectiveSubscription(username) {
  const key = String(username || '').toLowerCase();
  const subs = loadSubscriptions();
  const existing = subs[key] || null;
  if (PRO_GRANT_USERS.has(key)) {
    return {
      ...(existing || {}),
      plan: 'pro',
      status: 'active',
      permanent: true,
      period: existing?.period || 'lifetime',
      subscribedAt: existing?.subscribedAt || new Date().toISOString(),
    };
  }
  return existing;
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

// Lookup a username from a bare session token (no req). Used by the Worker to
// authenticate the per-user DM inbox WebSocket before routing it to that
// user's UserInbox Durable Object.
function getSessionUserByToken(token) {
  if (!token) return null;
  const s = loadSessions()[token];
  if (!s || Date.now() > s.expiresAt) return null;
  return String(s.username).toLowerCase();
}

// True when the request carries the shared admin password (same scheme the
// feedback/admin panel uses): ?key=... or an x-admin-key header.
function isAdminReq(req) {
  const key = (req.query && req.query.key) || req.headers['x-admin-key'];
  const adminPass = process.env.ADMIN_PASSWORD || 'cardhuddle-admin';
  return !!key && key === adminPass;
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
  res.json({ username, email: user.email || '', subscription: getEffectiveSubscription(username) });
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


// Per-user data sync — single JSON blob per user containing the things that
// used to live in localStorage only (collection, watchlist, completion,
// seller listings). Client pulls on login and pushes
// (debounced) on every change so the account is portable across devices.
const USER_DATA_MAX_BYTES = 1024 * 1024; // 1MB — generous; rejects runaway payloads.

// ---- Account export + deletion (GDPR / CCPA self-serve) --------------------
// The privacy policy promises access and erasure. Doing that only by email put
// the burden on a human replying; these two routes let the person do it
// themselves, which is also what "as easy to withdraw as to give" means.

// Everything we hold that is keyed to a username, gathered in one place so
// export and delete can never drift apart: if a store is added here it is both
// returned by the export and removed by the delete.
async function collectAccountData(username) {
  const key = String(username).toLowerCase();
  const users = loadServerUsers();
  const account = users[key] ? { ...users[key] } : null;
  if (account) delete account.passwordHash; // never hand back the hash
  // Legacy field on old records; never hand back a stored credential.
  if (account) { delete account.scrapeDoKeys; delete account.scrapeDoKey; }

  const posts = loadCommunityPosts();
  const dms = loadDMs();
  const myConvos = {};
  for (const [ck, convo] of Object.entries(dms.convos || {})) {
    if (ck.split('|').includes(key)) myConvos[ck] = convo;
  }

  return {
    account,
    subscription: loadSubscriptions()[key] || null,
    syncedData: await loadUserData(key),
    alerts: (loadAlerts().alerts || []).filter(a => String(a.username || '').toLowerCase() === key),
    communityPosts: posts.filter(p => String(p.author || '').toLowerCase() === key),
    communityComments: posts.flatMap(p => (p.comments || [])
      .filter(c => String(c.author || '').toLowerCase() === key)
      .map(c => ({ ...c, postId: p.id }))),
    directMessages: myConvos,
    booth: loadGlobalFloorIndex()[key] || null,
    feedback: loadData('feedback', FEEDBACK_FILE, [])
      .filter(f => String(f.author || f.username || '').toLowerCase() === key),
  };
}

// GET /api/account/export — everything we hold, as a JSON download.
app.get('/api/account/export', async (req, res) => {
  const username = getSessionUser(req);
  if (!username) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const payload = await collectAccountData(username);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition',
      `attachment; filename="cardhuddle-${username}-${new Date().toISOString().slice(0, 10)}.json"`);
    res.send(JSON.stringify({
      exportedAt: new Date().toISOString(),
      username,
      note: 'Everything The Card Huddle holds for this account. Passwords are '
          + 'stored only as a hash and are deliberately not included.',
      ...payload,
    }, null, 2));
  } catch (err) {
    console.error('[account/export]', err && err.stack || err);
    res.status(500).json({ error: 'Could not build export' });
  }
});

// POST /api/account/delete — irreversible. Requires the password again, so a
// stolen or borrowed session cannot nuke someone's collection.
app.post('/api/account/delete', async (req, res) => {
  const username = getSessionUser(req);
  if (!username) return res.status(401).json({ error: 'Not authenticated' });
  const key = String(username).toLowerCase();
  const { password, confirm } = req.body || {};
  if (confirm !== 'DELETE') {
    return res.status(400).json({ error: 'Type DELETE to confirm' });
  }
  try {
    const users = loadServerUsers();
    const user = users[key];
    if (!user) return res.status(404).json({ error: 'Account not found' });

    // OAuth accounts have no password to check; the live session is the proof.
    if (user.passwordHash) {
      if (!password) return res.status(400).json({ error: 'Password required' });
      if (!(await verifyPassword(password, user.passwordHash))) {
        return res.status(403).json({ error: 'Incorrect password' });
      }
    }

    const removed = [];

    // 1. Synced collection / inventory / watchlist blob, and its photos. Read
    //    the inventory first — once the blob is gone the photo ids are lost.
    const synced = await loadUserData(key);
    const photoIds = new Set();
    for (const item of (Array.isArray(synced.cardHuddleInventory) ? synced.cardHuddleInventory : [])) {
      for (const pid of (Array.isArray(item && item.photoIds) ? item.photoIds : [])) photoIds.add(pid);
      if (item && item.photoId) photoIds.add(item.photoId);
    }
    for (const pid of photoIds) { try { await deleteUserPhoto(key, pid); } catch {} }
    await deleteUserData(key);
    removed.push('collection, inventory, watchlist and portfolio history', `${photoIds.size} card photos`);

    // 2. Community posts, plus this user's comments, reactions and reports on
    //    everyone else's posts.
    const posts = loadCommunityPosts();
    const before = posts.length;
    let kept = posts.filter(p => String(p.author || '').toLowerCase() !== key);
    for (const p of kept) {
      if (Array.isArray(p.comments)) p.comments = p.comments.filter(c => String(c.author || '').toLowerCase() !== key);
      if (Array.isArray(p.reports)) p.reports = p.reports.filter(r => String(r.by || '').toLowerCase() !== key);
      if (p.reactions && typeof p.reactions === 'object') {
        for (const emoji of Object.keys(p.reactions)) {
          if (Array.isArray(p.reactions[emoji])) {
            p.reactions[emoji] = p.reactions[emoji].filter(u => String(u || '').toLowerCase() !== key);
          }
        }
      }
    }
    saveCommunityPosts(kept);
    removed.push(`${before - kept.length} community posts and all comments, reactions and reports`);

    // 3. Direct messages — both sides of every conversation this user was in.
    const dms = loadDMs();
    let convoCount = 0;
    for (const ck of Object.keys(dms.convos || {})) {
      if (ck.split('|').includes(key)) { delete dms.convos[ck]; convoCount++; }
    }
    saveDMs(dms);
    removed.push(`${convoCount} message threads`);

    // 4. Alerts.
    const alertData = loadAlerts();
    const alertsBefore = (alertData.alerts || []).length;
    alertData.alerts = (alertData.alerts || []).filter(a => String(a.username || '').toLowerCase() !== key);
    saveAlerts(alertData);
    removed.push(`${alertsBefore - alertData.alerts.length} card alerts`);

    // 5. Public indexes this user appears in.
    const floor = loadGlobalFloorIndex();
    if (floor[key]) { delete floor[key]; saveData('floorIndex', FLOOR_INDEX_FILE, floor); }
    removed.push('show booth');

    // 6. Subscription record. Stripe keeps its own billing records, which we
    //    cannot and should not delete — they are required for tax and
    //    accounting. This only removes our copy of the link.
    const subs = loadSubscriptions();
    if (subs[key]) { delete subs[key]; saveSubscriptions(subs); removed.push('subscription record'); }

    // 7. Every session, so the account is signed out everywhere at once.
    const sessions = loadSessions();
    for (const [tok, sess] of Object.entries(sessions)) {
      if (String(sess && sess.username || '').toLowerCase() === key) delete sessions[tok];
    }
    saveSessions(sessions);

    // 8. The account itself. Last, so a failure above leaves it recoverable.
    delete users[key];
    saveServerUsers(users);
    removed.push('username, email and password hash');

    console.log(`[account/delete] ${key} deleted`);
    res.json({ ok: true, removed });
  } catch (err) {
    console.error('[account/delete]', err && err.stack || err);
    res.status(500).json({ error: 'Could not delete account' });
  }
});

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
    // Mirror this user's booth (character + showcase) into the global floor
    // index so other collectors can visit it on The Floor.
    updateGlobalFloorIndex(username, data);
    res.json({ ok: true });
  } catch (err) {
    console.error('[user/data PUT]', err && err.message);
    res.status(500).json({ error: 'Failed to save user data' });
  }
});

// ---- Inventory photos (per-user, cross-device) ----
// Card photos are stored one-per-KV-key (see db.js) so they don't bloat the
// 1MB userdata blob. Ids are the client-generated item ids (inv_...). The
// inventory metadata (which syncs in the userdata blob) carries a hasPhoto
// flag, so a fresh device knows to pull each photo it doesn't have locally.
const INV_PHOTO_MAX_BYTES = 500 * 1024; // ~500KB — a 600px JPEG is well under this.
const INV_PHOTO_ID_RE = /^[a-z0-9_.-]{1,64}$/i;

// GET /api/inventory/photo/:id → { dataUrl } (404 if none)
app.get('/api/inventory/photo/:id', async (req, res) => {
  const username = getSessionUser(req);
  if (!username) return res.status(401).json({ error: 'Not authenticated' });
  const id = String(req.params.id || '');
  if (!INV_PHOTO_ID_RE.test(id)) return res.status(400).json({ error: 'Bad photo id' });
  try {
    const dataUrl = await loadUserPhoto(username, id);
    if (!dataUrl) return res.status(404).json({ error: 'No photo' });
    res.json({ dataUrl });
  } catch (err) {
    console.error('[inventory/photo GET]', err && err.message);
    res.status(500).json({ error: 'Failed to load photo' });
  }
});

// PUT /api/inventory/photo/:id  { dataUrl } — store/replace this card's photo
app.put('/api/inventory/photo/:id', async (req, res) => {
  const username = getSessionUser(req);
  if (!username) return res.status(401).json({ error: 'Not authenticated' });
  const id = String(req.params.id || '');
  if (!INV_PHOTO_ID_RE.test(id)) return res.status(400).json({ error: 'Bad photo id' });
  const { dataUrl } = req.body || {};
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
    return res.status(400).json({ error: 'Expected { dataUrl: "data:image/..." }' });
  }
  if (dataUrl.length > INV_PHOTO_MAX_BYTES) {
    return res.status(413).json({ error: `Photo exceeds ${INV_PHOTO_MAX_BYTES} bytes` });
  }
  try {
    await saveUserPhoto(username, id, dataUrl);
    res.json({ ok: true });
  } catch (err) {
    console.error('[inventory/photo PUT]', err && err.message);
    res.status(500).json({ error: 'Failed to save photo' });
  }
});

// DELETE /api/inventory/photo/:id
app.delete('/api/inventory/photo/:id', async (req, res) => {
  const username = getSessionUser(req);
  if (!username) return res.status(401).json({ error: 'Not authenticated' });
  const id = String(req.params.id || '');
  if (!INV_PHOTO_ID_RE.test(id)) return res.status(400).json({ error: 'Bad photo id' });
  try {
    await deleteUserPhoto(username, id);
    res.json({ ok: true });
  } catch (err) {
    console.error('[inventory/photo DELETE]', err && err.message);
    res.status(500).json({ error: 'Failed to delete photo' });
  }
});

// ---- Global Floor (Showcase booths) Index ----
// Mirrors each user's public booth — their collector character plus the
// showcase cards they've put out — into a single KV map { username: booth }
// so The Floor can render everyone's table. Updated whenever a user PUTs
// their data blob; read by GET /api/floor/booths. Same loadData/saveData
// (Cloudflare KV) pipeline as the other global indexes.
const FLOOR_INDEX_FILE = path.join(APP_ROOT, 'data', 'floor-index.json');
const FLOOR_MAX_BOOTHS = 60;       // bound the public list (and the KV blob)
const FLOOR_MAX_CARDS = 24;        // cards shown per booth

function loadGlobalFloorIndex() {
  return loadData('floorIndex', FLOOR_INDEX_FILE, {});
}

function sanitizeBoothCard(c) {
  const allowed = ['showcase', 'sale', 'trade', 'both'];
  const price = parseFloat(c && c.price);
  return {
    title: String((c && c.title) || '').slice(0, 160),
    imageUrl: String((c && c.imageUrl) || '').slice(0, 600),
    price: (!isNaN(price) && price > 0) ? price : null,
    status: allowed.includes(c && c.status) ? c.status : 'showcase',
    ebayUrl: String((c && c.ebayUrl) || '').slice(0, 600),
    veriswapUrl: String((c && c.veriswapUrl) || '').slice(0, 120),
    note: String((c && c.note) || '').slice(0, 140),
    valueBox: !!(c && c.valueBox),
  };
}

// Pull the eBay seller username out of the "eBay store / seller URL" the user
// already enters in Sell settings: ebay.com/usr/<name> URLs and bare
// usernames/@handles work; store URLs (/str/) don't map to a username, so
// they're skipped rather than guessed.
function ebaySellerFromStore(v) {
  v = String(v || '').trim();
  if (!v) return '';
  const m = v.match(/ebay\.[a-z.]+\/usr\/([^/?#]+)/i);
  let name = m ? m[1] : ((!v.includes('/') && !v.includes('.')) ? v.replace(/^@/, '') : '');
  try { name = decodeURIComponent(name); } catch (_) {}
  return name.replace(/[^\w.\-*]/g, '').slice(0, 64);
}

// A linked seller's active card listings, mapped to booth-card shape and
// KV-cached so The Floor costs ~2 Browse calls per seller per hour, no matter
// how many visitors walk it. Public data via the app OAuth token — the vendor
// never has to link their eBay account, just name it.
const FLOOR_SELLER_TTL = 1800;    // 30 min
async function fetchFloorSellerCards(seller) {
  const cacheKey = `floorSeller:v1:${seller.toLowerCase()}`;
  const cached = await cacheGet(cacheKey);
  if (cached && Array.isArray(cached.cards)) return cached.cards;
  try {
    trackApiCall('browse', 'browse/seller', seller, 'floor');
    const token = await getOAuthToken();
    const r = await axios.get('https://api.ebay.com/buy/browse/v1/item_summary/search', {
      params: {
        category_ids: '261328',              // same card category the For Sale search uses
        filter: `sellers:{${seller}}`,
        sort: 'newlyListed',
        limit: FLOOR_MAX_CARDS,
      },
      headers: { 'Authorization': `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US' },
      timeout: 8000,
    });
    const items = (r.data && r.data.itemSummaries) || [];
    // image: ONLY the listing's primary (first) photo — `image` is eBay's
    // primary listing image; thumbnailImages are resized copies of that same
    // photo. additionalImages (the rest of the gallery) are never used.
    const cards = items.map(item => Object.assign(sanitizeBoothCard({
      title: item.title,
      imageUrl: (item.image && item.image.imageUrl) || (item.thumbnailImages && item.thumbnailImages[0] && item.thumbnailImages[0].imageUrl) || '',
      price: item.price && item.price.value,
      status: 'sale',
      ebayUrl: item.itemWebUrl || '',
    }), { source: 'ebay' })).filter(c => c.title);
    cachePut(cacheKey, { cards }, FLOOR_SELLER_TTL);
    return cards;
  } catch (err) {
    console.error(`[Floor] eBay seller fetch failed for "${seller}":`, err && err.message);
    // negative-cache briefly so a broken seller name / eBay outage doesn't
    // cost a Browse call on every single /api/floor/booths request
    cachePut(cacheKey, { cards: [] }, 300);
    return [];
  }
}

// Hidden-card keys from the booth editor (listing URL for eBay-synced cards,
// title|image for manual ones). Bounded so the KV blob stays small.
function sanitizeHiddenCards(arr) {
  if (!Array.isArray(arr) || !arr.length) return undefined;
  const out = arr.filter(v => typeof v === 'string' && v).map(v => v.slice(0, 700)).slice(0, 100);
  return out.length ? out : undefined;
}

// The booth's fixture layout: an ordered list of placement spots, each one of
// a small allowed set. Bounded length so the KV blob stays small.
const FLOOR_LAYOUT_SLOTS = 5;
const FLOOR_FIXTURES = ['showcase', 'stand', 'valuebox', 'empty'];
function sanitizeBoothLayout(arr) {
  if (!Array.isArray(arr)) return null;
  const out = arr.slice(0, FLOOR_LAYOUT_SLOTS)
    .map(v => (FLOOR_FIXTURES.includes(v) ? v : 'empty'));
  return out.length ? out : null;
}

function updateGlobalFloorIndex(username, data) {
  if (!username) return;
  const key = String(username).toLowerCase();
  const index = loadGlobalFloorIndex();
  const character = data && data.cardHuddleCharacter;
  const showcase = Array.isArray(data && data.cardHuddleShowcase) ? data.cardHuddleShowcase : [];
  const settings = (data && data.cardHuddleShowcaseSettings) || {};
  const layout = sanitizeBoothLayout(data && data.cardHuddleBoothLayout);
  // A booth only exists once the user has created a collector character.
  // No character → remove them from the floor.
  if (!character || !character.name) {
    if (index[key]) { delete index[key]; saveData('floorIndex', FLOOR_INDEX_FILE, index); }
    return;
  }
  index[key] = {
    username: key,
    name: String(character.name || '').slice(0, 24),
    emoji: String(character.emoji || '🙂').slice(0, 8),
    color: String(character.color || '#5ece99').slice(0, 16),
    veriswap: String(settings.veriswap || '').slice(0, 120),
    ebaySeller: ebaySellerFromStore(settings.ebayStore) || undefined,
    // hide-from-table card keys chosen in the booth editor. Kept on the public
    // booth (not filtered server-side) so the owner's editor can list hidden
    // cards for re-enabling; visitors' clients filter them out at render.
    hidden: sanitizeHiddenCards(data && data.cardHuddleBoothHidden),
    cards: showcase.slice(0, FLOOR_MAX_CARDS).map(sanitizeBoothCard).filter(c => c.title),
    layout: layout || undefined,
    updatedAt: new Date().toISOString(),
  };
  saveData('floorIndex', FLOOR_INDEX_FILE, index);
}

// GET /api/floor/booths — public list of every collector's booth (newest
// activity first). No auth required; this is the shared show floor.
// Booths with a linked eBay seller get their active card listings merged in
// after the hand-picked showcase cards (KV-cached; failures just mean the
// booth shows its manual cards).
app.get('/api/floor/booths', async (req, res) => {
  const index = loadGlobalFloorIndex();     // deep copy — safe to mutate
  const booths = Object.values(index)
    .filter(b => b && b.name)
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
    .slice(0, FLOOR_MAX_BOOTHS);
  await Promise.all(booths.filter(b => b.ebaySeller).map(async (b) => {
    const listed = await fetchFloorSellerCards(b.ebaySeller);
    if (!listed.length) return;
    const manual = Array.isArray(b.cards) ? b.cards : [];
    // manual cards keep priority; skip listings the vendor already showcased
    const have = new Set(manual.map(c => (c.ebayUrl || '').split('?')[0]).filter(Boolean));
    b.cards = manual.concat(listed.filter(c => !have.has((c.ebayUrl || '').split('?')[0]))).slice(0, FLOOR_MAX_CARDS);
  }));
  res.json({ booths });
});

// ---- Direct Messages (negotiate) ----
// One-to-one chat so a buyer can DM a booth owner about a card. Stored as a
// single 'dms' blob: { convos: { "userA|userB": { users, messages[], read{} } } }
// via the same loadData/saveData (Cloudflare KV) pipeline as the rest.
const DM_FILE = path.join(APP_ROOT, 'data', 'dms.json');
const DM_MAX_MSG_LEN = 1000;          // chars per message
const DM_MAX_PER_CONVO = 300;         // keep each conversation (and the blob) bounded

function loadDMs() { return loadData('dms', DM_FILE, { convos: {} }); }
function saveDMs(d) { saveData('dms', DM_FILE, d); }
function convoKey(a, b) { return [a, b].sort().join('|'); }
function dmUserExists(username) { return !!loadServerUsers()[String(username).toLowerCase()]; }
function sanitizeDmCard(card) {
  if (!card || typeof card !== 'object') return null;
  const title = String(card.title || '').slice(0, 160);
  if (!title) return null;
  const price = parseFloat(card.price);
  return { title, imageUrl: String(card.imageUrl || '').slice(0, 600), price: (!isNaN(price) && price > 0) ? price : null };
}
function publicDmMessage(m) { return { id: m.id, from: m.from, text: m.text, card: m.card || null, at: m.at }; }
function dmUnreadCount(convo, me) {
  const readAt = convo.read[me] || '';
  return convo.messages.filter(m => m.from !== me && m.at > readAt).length;
}

// POST /api/dm/send — send a DM (optionally about a specific card).
app.post('/api/dm/send', (req, res) => {
  const me = getSessionUser(req);
  if (!me) return res.status(401).json({ error: 'Sign in to send messages.' });
  const body = req.body || {};
  const to = String(body.to || '').trim().toLowerCase();
  const text = stripBidi(body.text).trim();
  const card = sanitizeDmCard(body.card);
  if (!to) return res.status(400).json({ error: 'No recipient.' });
  if (to === me) return res.status(400).json({ error: "You can't message yourself." });
  if (!dmUserExists(to)) return res.status(404).json({ error: 'That collector no longer exists.' });
  if (!text && !card) return res.status(400).json({ error: 'Write a message first.' });
  if (text.length > DM_MAX_MSG_LEN) return res.status(400).json({ error: `Message is too long (max ${DM_MAX_MSG_LEN}).` });
  if (text) {
    const check = moderateText(text);
    if (!check.allowed) return res.status(422).json({ error: check.reason === 'spam' ? 'That looks like spam. Please drop the extra links/contact info.' : 'Your message contains language that isn’t allowed. Please revise it.', reason: check.reason });
  }
  const data = loadDMs();
  const key = convoKey(me, to);
  const convo = data.convos[key] || (data.convos[key] = { users: [me, to].sort(), messages: [], read: {} });
  const msg = { id: 'dm_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), from: me, text: text.slice(0, DM_MAX_MSG_LEN), card: card || null, at: new Date().toISOString() };
  convo.messages.push(msg);
  if (convo.messages.length > DM_MAX_PER_CONVO) convo.messages = convo.messages.slice(-DM_MAX_PER_CONVO);
  convo.read[me] = msg.at;           // the sender has, by definition, seen up to here
  saveDMs(data);
  res.json({ ok: true, message: publicDmMessage(msg) });
});

// GET /api/dm/threads — my conversations, newest first, with unread counts.
app.get('/api/dm/threads', (req, res) => {
  const me = getSessionUser(req);
  if (!me) return res.status(401).json({ error: 'Sign in to view messages.' });
  const data = loadDMs();
  const threads = [];
  for (const c of Object.values(data.convos)) {
    if (!c.users.includes(me)) continue;
    const other = c.users.find(u => u !== me);
    const last = c.messages[c.messages.length - 1] || null;
    const preview = last ? (last.text || (last.card ? '📇 ' + last.card.title : '')) : '';
    threads.push({ user: other, lastMessage: preview, lastAt: last ? last.at : '', unread: dmUnreadCount(c, me) });
  }
  threads.sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt)));
  res.json({ threads });
});

// GET /api/dm/with/:user — the conversation with one collector (marks it read).
app.get('/api/dm/with/:user', (req, res) => {
  const me = getSessionUser(req);
  if (!me) return res.status(401).json({ error: 'Sign in to view messages.' });
  const other = String(req.params.user || '').toLowerCase();
  const data = loadDMs();
  const c = data.convos[convoKey(me, other)];
  const messages = c ? c.messages.map(publicDmMessage) : [];
  if (c) { c.read[me] = new Date().toISOString(); saveDMs(data); }
  res.json({ user: other, messages });
});

// GET /api/dm/unread — total unread across all my conversations (for a badge).
app.get('/api/dm/unread', (req, res) => {
  const me = getSessionUser(req);
  if (!me) return res.json({ unread: 0 });
  const data = loadDMs();
  let unread = 0;
  for (const c of Object.values(data.convos)) { if (c.users.includes(me)) unread += dmUnreadCount(c, me); }
  res.json({ unread });
});

// ---- Community Board ----
// A shared feed under Browse Cards where any signed-in member can post a
// message, optional card photo, and optional price/link. Stored as a single
// global array under the 'community' key via the same loadData/saveData
// pipeline as the other global indexes, so it persists on Cloudflare KV.
const COMMUNITY_FILE = path.join(APP_ROOT, 'data', 'community.json');
const COMMUNITY_MAX_POSTS = 300;          // keep the feed (and the KV blob) bounded
const COMMUNITY_MAX_MESSAGE = 1000;       // chars
const COMMUNITY_MAX_TITLE = 140;          // chars
const COMMUNITY_MAX_IMAGE_BYTES = 700 * 1024; // ~700KB cap on an attached data URL
const COMMUNITY_AUTOHIDE_REPORTS = 3;     // unique reports that auto-hide a post
const COMMENT_MAX_MESSAGE = 500;          // chars
const COMMENT_MAX_PER_POST = 200;         // bound the per-post comment list
const COMMUNITY_REACTIONS = ['👍', '❤️', '🔥', '😂', '😮']; // allowed reaction emoji

function loadCommunityPosts() {
  const data = loadData('community', COMMUNITY_FILE, { posts: [] });
  return Array.isArray(data.posts) ? data.posts : [];
}

function saveCommunityPosts(posts) {
  saveData('community', COMMUNITY_FILE, { posts });
}

// Aggregate a { username: emoji } reaction map into { counts, mine } for the
// given viewer, so the public payload never leaks the full reactor list.
function shapeReactions(reactions, viewer) {
  const counts = {};
  let mine = null;
  if (reactions && typeof reactions === 'object') {
    for (const [user, emoji] of Object.entries(reactions)) {
      if (!COMMUNITY_REACTIONS.includes(emoji)) continue;
      counts[emoji] = (counts[emoji] || 0) + 1;
      if (viewer && user === viewer) mine = emoji;
    }
  }
  return { counts, mine };
}

// Public shape for a comment — drops any internal moderation fields.
function publicComment(c, viewer) {
  const { counts, mine } = shapeReactions(c.reactions, viewer);
  return {
    id: c.id, author: c.author, message: c.message,
    imageUrl: c.imageUrl, createdAt: c.createdAt,
    parentId: c.parentId || null,
    reactions: counts, myReaction: mine,
  };
}

// Strip moderation bookkeeping the public feed shouldn't see (reporter names,
// internal flags). Admins get the raw post via the admin endpoint.
function publicPost(p, viewer) {
  const { counts, mine } = shapeReactions(p.reactions, viewer);
  return {
    id: p.id, author: p.author, message: p.message, title: p.title,
    imageUrl: p.imageUrl, price: p.price, link: p.link, createdAt: p.createdAt,
    reportCount: p.reports ? p.reports.length : 0,
    reactions: counts, myReaction: mine,
    comments: Array.isArray(p.comments) ? p.comments.map(c => publicComment(c, viewer)) : [],
  };
}

// Public — anyone can read the board. Hidden (auto-moderated / admin-hidden)
// posts are excluded unless the caller is an admin.
app.get('/api/community/posts', (req, res) => {
  const admin = isAdminReq(req);
  const viewer = getSessionUser(req); // null when logged out — fine
  const posts = loadCommunityPosts();
  const visible = admin ? posts : posts.filter(p => !p.hidden);
  res.json({ posts: visible.map(admin ? (p => p) : (p => publicPost(p, viewer))), total: visible.length });
});

// Auth required — post to the board.
app.post('/api/community/posts', async (req, res) => {
  const username = getSessionUser(req);
  if (!username) return res.status(401).json({ error: 'Sign in to post to the community.' });

  const body = req.body || {};
  const message = stripBidi(body.message).trim();
  const title = stripBidi(body.title).trim().slice(0, COMMUNITY_MAX_TITLE);
  let imageUrl = String(body.imageUrl || '').trim();
  let link = String(body.link || '').trim();
  const priceNum = parseFloat(body.price);
  const price = Number.isFinite(priceNum) && priceNum > 0 ? Math.round(priceNum * 100) / 100 : null;

  if (!message && !imageUrl) {
    return res.status(400).json({ error: 'Add a message or a photo before posting.' });
  }
  if (message.length > COMMUNITY_MAX_MESSAGE) {
    return res.status(400).json({ error: `Message is too long (max ${COMMUNITY_MAX_MESSAGE} characters).` });
  }
  // Accept either an uploaded image (data URL) or a hosted image URL.
  if (imageUrl) {
    const isData = imageUrl.startsWith('data:image/');
    const isHttp = /^https?:\/\//i.test(imageUrl);
    if (!isData && !isHttp) return res.status(400).json({ error: 'Image must be an uploaded photo or an http(s) URL.' });
    if (isData && imageUrl.length > COMMUNITY_MAX_IMAGE_BYTES) {
      return res.status(413).json({ error: 'Photo is too large. Please use a smaller image.' });
    }
  }
  // Only allow http(s) links; drop anything else (e.g. javascript:).
  if (link && !/^https?:\/\//i.test(link)) {
    return res.status(400).json({ error: 'Link must start with http:// or https://' });
  }

  // --- Auto-moderation -------------------------------------------------
  // Text: profanity / slurs / spam are rejected outright with a clear reason.
  const textCheck = moderateText(`${message} ${title}`);
  if (!textCheck.allowed) {
    const msg = textCheck.reason === 'spam'
      ? 'That looks like spam. Please drop the extra links/contact info.'
      : 'Your post contains language that isn’t allowed. Please revise it.';
    return res.status(422).json({ error: msg, reason: textCheck.reason });
  }
  // Image: blocked only when a configured provider scores it NSFW; otherwise
  // it passes through marked unverified (reports/auto-hide remain the net).
  let imageVerified = true;
  if (imageUrl) {
    try {
      const imgCheck = await moderateImage(imageUrl);
      if (!imgCheck.allowed) {
        return res.status(422).json({ error: 'That image didn’t pass our content check. Please choose a different photo.', reason: 'image' });
      }
      imageVerified = !!imgCheck.verified;
    } catch (_) { imageVerified = false; }
  }

  const post = {
    id: 'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    author: username,
    message: message.slice(0, COMMUNITY_MAX_MESSAGE),
    title: title || '',
    imageUrl: imageUrl || '',
    price,
    link: link || '',
    createdAt: new Date().toISOString(),
    reports: [],
    imageVerified,
  };

  const posts = loadCommunityPosts();
  posts.unshift(post);
  if (posts.length > COMMUNITY_MAX_POSTS) posts.length = COMMUNITY_MAX_POSTS;
  saveCommunityPosts(posts);
  res.json({ ok: true, post: publicPost(post) });
});

// Auth required — report a post. Dedupes by reporter; auto-hides once a post
// crosses COMMUNITY_AUTOHIDE_REPORTS so bad content disappears before an admin
// gets to it. Admins still see hidden posts for review.
app.post('/api/community/posts/:id/report', (req, res) => {
  const username = getSessionUser(req);
  if (!username) return res.status(401).json({ error: 'Sign in to report a post.' });
  const id = String(req.params.id || '');
  const reason = String((req.body && req.body.reason) || '').trim().slice(0, 200);

  const posts = loadCommunityPosts();
  const post = posts.find(p => p.id === id);
  if (!post) return res.status(404).json({ error: 'Post not found.' });
  if (post.author === username) return res.status(400).json({ error: 'You can’t report your own post.' });

  if (!Array.isArray(post.reports)) post.reports = [];
  if (post.reports.some(r => r.by === username)) {
    return res.json({ ok: true, alreadyReported: true });
  }
  post.reports.push({ by: username, reason, at: new Date().toISOString() });
  if (post.reports.length >= COMMUNITY_AUTOHIDE_REPORTS) post.hidden = true;
  saveCommunityPosts(posts);
  res.json({ ok: true, autoHidden: !!post.hidden });
});

// Delete a post. Allowed for the post's author OR an admin (delete-any).
app.delete('/api/community/posts/:id', (req, res) => {
  const admin = isAdminReq(req);
  const username = getSessionUser(req);
  if (!admin && !username) return res.status(401).json({ error: 'Sign in required.' });
  const id = String(req.params.id || '');
  const posts = loadCommunityPosts();
  const idx = posts.findIndex(p => p.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Post not found.' });
  if (!admin && posts[idx].author !== username) {
    return res.status(403).json({ error: 'You can only delete your own posts.' });
  }
  posts.splice(idx, 1);
  saveCommunityPosts(posts);
  res.json({ ok: true });
});

// Admin — hide / unhide a post without deleting it.
app.post('/api/community/posts/:id/hide', (req, res) => {
  if (!isAdminReq(req)) return res.status(401).json({ error: 'Unauthorized' });
  const id = String(req.params.id || '');
  const hidden = !(req.body && req.body.unhide);
  const posts = loadCommunityPosts();
  const post = posts.find(p => p.id === id);
  if (!post) return res.status(404).json({ error: 'Post not found.' });
  post.hidden = hidden;
  saveCommunityPosts(posts);
  res.json({ ok: true, hidden });
});

// Auth required — reply to a post with a comment (message and/or photo).
// Runs the same auto-moderation as posts.
app.post('/api/community/posts/:id/comments', async (req, res) => {
  const username = getSessionUser(req);
  if (!username) return res.status(401).json({ error: 'Sign in to reply.' });

  const id = String(req.params.id || '');
  const body = req.body || {};
  const message = stripBidi(body.message).trim();
  let imageUrl = String(body.imageUrl || '').trim();

  if (!message && !imageUrl) {
    return res.status(400).json({ error: 'Add a message or a photo to reply.' });
  }
  if (message.length > COMMENT_MAX_MESSAGE) {
    return res.status(400).json({ error: `Reply is too long (max ${COMMENT_MAX_MESSAGE} characters).` });
  }
  if (imageUrl) {
    const isData = imageUrl.startsWith('data:image/');
    const isHttp = /^https?:\/\//i.test(imageUrl);
    if (!isData && !isHttp) return res.status(400).json({ error: 'Image must be an uploaded photo or an http(s) URL.' });
    if (isData && imageUrl.length > COMMUNITY_MAX_IMAGE_BYTES) {
      return res.status(413).json({ error: 'Photo is too large. Please use a smaller image.' });
    }
  }

  // Auto-moderation, mirroring posts.
  const textCheck = moderateText(message);
  if (!textCheck.allowed) {
    const msg = textCheck.reason === 'spam'
      ? 'That looks like spam. Please drop the extra links/contact info.'
      : 'Your reply contains language that isn’t allowed. Please revise it.';
    return res.status(422).json({ error: msg, reason: textCheck.reason });
  }
  let imageVerified = true;
  if (imageUrl) {
    try {
      const imgCheck = await moderateImage(imageUrl);
      if (!imgCheck.allowed) {
        return res.status(422).json({ error: 'That image didn’t pass our content check. Please choose a different photo.', reason: 'image' });
      }
      imageVerified = !!imgCheck.verified;
    } catch (_) { imageVerified = false; }
  }

  const posts = loadCommunityPosts();
  const post = posts.find(p => p.id === id);
  if (!post) return res.status(404).json({ error: 'Post not found.' });
  if (post.hidden) return res.status(403).json({ error: 'This post is no longer available.' });

  if (!Array.isArray(post.comments)) post.comments = [];
  if (post.comments.length >= COMMENT_MAX_PER_POST) {
    return res.status(409).json({ error: 'This thread has reached its reply limit.' });
  }
  // Optional parent for threaded replies — must reference a real comment here.
  let parentId = String(body.parentId || '').trim() || null;
  if (parentId && !post.comments.some(c => c.id === parentId)) {
    return res.status(400).json({ error: 'The reply you’re responding to no longer exists.' });
  }
  const comment = {
    id: 'cc_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    author: username,
    message: message.slice(0, COMMENT_MAX_MESSAGE),
    imageUrl: imageUrl || '',
    createdAt: new Date().toISOString(),
    imageVerified,
    parentId,
  };
  post.comments.push(comment);
  saveCommunityPosts(posts);
  res.json({ ok: true, comment: publicComment(comment, username) });
});

// Delete a comment. Allowed for the comment's author, the post's author
// (thread owner), or an admin.
app.delete('/api/community/posts/:id/comments/:commentId', (req, res) => {
  const admin = isAdminReq(req);
  const username = getSessionUser(req);
  if (!admin && !username) return res.status(401).json({ error: 'Sign in required.' });
  const id = String(req.params.id || '');
  const commentId = String(req.params.commentId || '');
  const posts = loadCommunityPosts();
  const post = posts.find(p => p.id === id);
  if (!post || !Array.isArray(post.comments)) return res.status(404).json({ error: 'Not found.' });
  const idx = post.comments.findIndex(c => c.id === commentId);
  if (idx === -1) return res.status(404).json({ error: 'Comment not found.' });
  const canDelete = admin || post.comments[idx].author === username || post.author === username;
  if (!canDelete) return res.status(403).json({ error: 'You can’t delete this reply.' });
  // Cascade: remove this comment and any replies nested beneath it.
  const toRemove = new Set([commentId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const c of post.comments) {
      if (c.parentId && toRemove.has(c.parentId) && !toRemove.has(c.id)) { toRemove.add(c.id); grew = true; }
    }
  }
  post.comments = post.comments.filter(c => !toRemove.has(c.id));
  saveCommunityPosts(posts);
  res.json({ ok: true, removed: [...toRemove] });
});

// Auth required — set/toggle the viewer's reaction on a post or a comment.
// emoji must be one of COMMUNITY_REACTIONS; sending the current emoji (or an
// empty value) removes the reaction. One reaction per user per item.
function applyReaction(target, username, emoji) {
  if (!target.reactions || typeof target.reactions !== 'object') target.reactions = {};
  const current = target.reactions[username];
  if (!emoji || emoji === current) {
    delete target.reactions[username];           // toggle off
    return null;
  }
  target.reactions[username] = emoji;            // set / switch
  return emoji;
}

app.post('/api/community/posts/:id/react', (req, res) => {
  const username = getSessionUser(req);
  if (!username) return res.status(401).json({ error: 'Sign in to react.' });
  const emoji = String((req.body && req.body.emoji) || '').trim();
  if (emoji && !COMMUNITY_REACTIONS.includes(emoji)) return res.status(400).json({ error: 'Invalid reaction.' });
  const posts = loadCommunityPosts();
  const post = posts.find(p => p.id === String(req.params.id || ''));
  if (!post) return res.status(404).json({ error: 'Post not found.' });
  const mine = applyReaction(post, username, emoji);
  saveCommunityPosts(posts);
  res.json({ ok: true, reactions: shapeReactions(post.reactions, username).counts, myReaction: mine });
});

app.post('/api/community/posts/:id/comments/:commentId/react', (req, res) => {
  const username = getSessionUser(req);
  if (!username) return res.status(401).json({ error: 'Sign in to react.' });
  const emoji = String((req.body && req.body.emoji) || '').trim();
  if (emoji && !COMMUNITY_REACTIONS.includes(emoji)) return res.status(400).json({ error: 'Invalid reaction.' });
  const posts = loadCommunityPosts();
  const post = posts.find(p => p.id === String(req.params.id || ''));
  if (!post || !Array.isArray(post.comments)) return res.status(404).json({ error: 'Not found.' });
  const comment = post.comments.find(c => c.id === String(req.params.commentId || ''));
  if (!comment) return res.status(404).json({ error: 'Comment not found.' });
  const mine = applyReaction(comment, username, emoji);
  saveCommunityPosts(posts);
  res.json({ ok: true, reactions: shapeReactions(comment.reactions, username).counts, myReaction: mine });
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
    checkoutEnabled: !!CHECKOUT_ENABLED,
  });
});

app.post('/api/stripe/create-checkout', async (req, res) => {
  if (!CHECKOUT_ENABLED) return res.status(503).json({ error: CHECKOUT_PAUSED_MSG });
  if (!stripeEnabled) return res.status(503).json({ error: 'Stripe is not configured. Add your Stripe keys to .env' });

  const { username, period } = req.body;
  if (!username) return res.status(400).json({ error: 'Username required' });

  // Opt-in 7-day free trial. Stripe collects the card now and only charges
  // after the trial ends, so the entitlement is real and self-expiring.
  const wantsTrial = req.body.trial === true || req.body.trial === 'true';

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
      ...(wantsTrial ? { subscription_data: { trial_period_days: 7 } } : {}),
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

  try {
    const [soldData, forsaleData] = await Promise.all([
      fetchEbayItems(query, 50, 'sold', 'flip-finder'),
      fetchEbayItems(query, 50, 'forsale', 'flip-finder'),
    ]);
    if (sendIfSoldBlocked(res, soldData)) return;

    const soldPrices = (soldData.results || []).map(i => parseFloat(i.price)).filter(p => p > 0);
    if (soldPrices.length < 3) return res.json({ results: [], message: 'Not enough recent sold data for this query' });

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
  if (!query || query.trim().length < 2) return res.status(400).json({ error: 'Query required' });

  try {
    const soldData = await fetchEbayItems(query, 50, 'sold', 'market-movers');
    if (sendIfSoldBlocked(res, soldData)) return;
    const items = (soldData.results || [])
      .map(i => ({ price: parseFloat(i.price), date: i.soldDate ? new Date(i.soldDate) : null, title: i.title, imageUrl: i.imageUrl }))
      .filter(i => i.price > 0 && i.date && !isNaN(i.date));

    if (items.length < 6) return res.json({ results: [], message: 'Not enough recent sold data to detect a trend' });

    items.sort((a, b) => b.date - a.date);
    // Split at the midpoint of the data we actually have rather than a fixed
    // 7-day cutoff: the sold feed's lookback window depends on the plan (as
    // little as 3 days), and a hardcoded cutoff would leave the "older" bucket
    // permanently empty and report "insufficient data" forever.
    const newest = items[0].date.getTime();
    const oldest = items[items.length - 1].date.getTime();
    const spanDays = Math.max(1, Math.round((newest - oldest) / 86400000));
    const cutoff = new Date((newest + oldest) / 2);
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
      // How much history this verdict actually rests on — a swing measured
      // across 3 days means something very different from one across 30.
      windowDays: spanDays,
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
  try {
    let soldData = await fetchEbayItems(query, 24, 'sold', 'ap-search');
    if (sendIfSoldBlocked(res, soldData)) return;

    // Progressively drop trailing words until we get results
    if (!soldData.results || soldData.results.length === 0) {
      const words = query.trim().split(/\s+/);
      for (let len = words.length - 1; len >= 2; len--) {
        soldData = await fetchEbayItems(words.slice(0, len).join(' '), 24, 'sold', 'ap-search-fallback');
        if (sendIfSoldBlocked(res, soldData)) return;
        if (soldData.results && soldData.results.length > 0) break;
      }
    }

    // Only keep sold listings for the SAME player as the search — the
    // progressive word-dropping fallback above can otherwise pull in other
    // players, polluting the comps. Anchor on the surname (the most stable
    // token). If the surname can't be found, leave the pool untouched.
    let pool = soldData.results || [];
    const playerName = extractPlayerName(query);
    const nameToks = playerName
      ? playerName.toLowerCase().split(' ').filter(w => w.length > 1 && !NON_NAME_WORDS.has(w))
      : [];
    const surname = nameToks[nameToks.length - 1];
    if (surname) {
      pool = pool.filter(i => (' ' + String(i.title || '').toLowerCase() + ' ').includes(surname));
    }

    const items = pool
      .map(i => ({
        title: i.title,
        price: parseFloat(i.price),
        image: i.imageUrl || '',
        soldDate: i.soldDate,
        url: i.itemUrl || '',
      }))
      .filter(i => i.price > 0)
      .slice(0, 10); // cap the comps shown in the Auto-Pricer at 10
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
      soldData = await fetchEbayItems(attempts[i], 30, 'sold', 'auto-price');
      if (sendIfSoldBlocked(res, soldData)) return;
      const prices = (soldData.results || []).map(r => parseFloat(r.price)).filter(p => p > 0);
      if (prices.length >= 3) { usedQuery = attempts[i]; attemptIndex = i; break; }
      if (i === attempts.length - 1) { usedQuery = attempts[i]; attemptIndex = i; }
    }

    const rawPrices = (soldData.results || []).map(r => parseFloat(r.price)).filter(p => p > 0);
    const cleanPrices = removeOutliers(rawPrices);
    const finalPrices = (cleanPrices.length >= 2 ? cleanPrices : rawPrices).sort((a, b) => a - b);

    if (finalPrices.length < 2) {
      return res.json({ error: 'Not enough recent sold data found. Try selecting a different comp card.', soldCount: rawPrices.length });
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

  const results = [];
  for (const q of queries) {
    try {
      const query = q.trim();
      const response = await fetchEbayItems(query, 25, 'sold', 'bulk-price');
      // A blocked provider won't recover mid-run, so stop rather than grinding
      // through the rest of the batch returning nulls.
      if (response.soldUnavailable) return sendSoldUnavailable(res);
      if (response.rateLimited) {
        return res.json({ results, rateLimited: true, error: response.rateLimitMessage, rateLimitMessage: response.rateLimitMessage });
      }
      // Same pipeline as the main Sold search so the comps actually match the
      // card: variant filter (right player/set/parallel, exclude autos/relics/
      // wrong colors) then drop mis-listed price outliers.
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

app.get('/api/stripe/subscription', async (req, res) => {
  const username = req.query.username;
  if (!username) return res.status(400).json({ error: 'Username required' });

  const userSub = getEffectiveSubscription(username);

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
// Run eBay's visual search for one image. Returns up to `limit` listing
// summaries (title + thumbnail + url). Throws on API/auth failure.
async function ebayImageSearch(base64, limit = 8) {
  const token = await getOAuthToken();
  const ebayRes = await axios.post(
    'https://api.ebay.com/buy/browse/v1/item_summary/search_by_image',
    { image: base64 },
    {
      params: { category_ids: '261328', limit },
      headers: {
        'Authorization': `Bearer ${token}`,
        'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
        'Content-Type': 'application/json',
      },
      timeout: 20000,
    }
  );
  const items = ebayRes.data?.itemSummaries || [];
  return items.slice(0, limit).map(item => ({
    title: item.title || '',
    imageUrl: item.thumbnailImages?.[0]?.imageUrl || item.image?.imageUrl || null,
    itemUrl: item.itemWebUrl || null,
  }));
}

function _cleanImageBase64(imageData) {
  if (!imageData || typeof imageData !== 'string') return null;
  const base64 = imageData.replace(/^data:image\/[\w+]+;base64,/, '');
  return (!base64 || base64.length < 100) ? null : base64;
}

app.post('/api/scan-card', async (req, res) => {
  const { imageData, backImageData } = req.body;
  const frontB64 = _cleanImageBase64(imageData);
  if (!frontB64) {
    return res.status(400).json({ error: 'imageData required' });
  }
  // Back photo is optional — used to re-rank the front matches by identity
  // (player/year/set/card number), which the glare-prone front can get wrong.
  const backB64 = _cleanImageBase64(backImageData);

  if (USE_MOCK_FORSALE) {
    return res.json({
      matches: [
        { title: '2020 Panini Prizm Patrick Mahomes Silver #269', imageUrl: null, itemUrl: '#' },
        { title: '2020 Panini Prizm Patrick Mahomes Base #269', imageUrl: null, itemUrl: '#' },
        { title: '2020 Panini Prizm Patrick Mahomes Gold #269 /10', imageUrl: null, itemUrl: '#' },
      ],
      backMatches: backB64 ? [
        { title: '2020 Panini Prizm Patrick Mahomes #269', imageUrl: null, itemUrl: '#' },
      ] : [],
    });
  }

  try {
    // Front is required; back runs alongside it and never fails the scan.
    const [matches, backMatches] = await Promise.all([
      ebayImageSearch(frontB64, 8),
      backB64 ? ebayImageSearch(backB64, 8).catch(err => {
        console.error('[scan-card] back image search failed:', err.response?.data?.errors?.[0]?.message || err.message);
        return [];
      }) : Promise.resolve([]),
    ]);

    res.json({ matches, backMatches });
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

// Admin-only account stats. Gated by the shared admin key (?key=… or the
// x-admin-key header), same scheme as /api/feedback. Returns counts only — no
// usernames, emails, or other PII — so it's safe to glance at from a browser.
app.get('/api/admin/stats', (req, res) => {
  if (!isAdminReq(req)) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const users = loadServerUsers();
    const subs = loadSubscriptions();
    const usernames = Object.keys(users);
    const activePro = usernames.filter(u => {
      const s = getEffectiveSubscription(u);
      return s && s.status === 'active' && s.plan === 'pro';
    }).length;
    const withOAuth = usernames.filter(u => users[u] && users[u].oauth).length;
    res.json({
      totalAccounts: usernames.length,
      activeProAccounts: activePro,
      oauthAccounts: withOAuth,
      subscriptionRecords: Object.keys(subs).length,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Error in /api/admin/stats:', err.message);
    res.status(500).json({ error: 'Failed to load stats' });
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
module.exports = { app, connectDB, backfillPlayerAliases, getSessionUserByToken, extractSearchKeywords, matchSoldListings, classifyCardType, buildSimilarCardEstimate, hasExactCardSales, parsePrintRunFromTitle, detectSetTier, getEffectiveSubscription, PRO_GRANT_USERS, checkAlerts, processScanLeadDrip };

// Node.js (local / Render): connect to DB then bind to a port as usual.
// In Cloudflare Workers, worker.js handles startup via the fetch adapter.
if (!process.env.CF_WORKER) {
  connectDB().then(() => {
    app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
      console.log(`For-sale mode: ${USE_MOCK_FORSALE ? 'MOCK' : 'LIVE (eBay Browse API)'}`);
      console.log(`Sold mode: ${USE_MOCK_SOLD ? 'MOCK' : 'RETIRED (awaiting official eBay sold-data API)'}`);
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
