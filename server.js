require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const crypto = require('crypto');
const { connectDB, loadData, saveData, loadUserData, saveUserData, loadUserPhoto, saveUserPhoto, deleteUserPhoto, cacheGet, cachePut } = require('./db');

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
// Sold data is retired pending eBay's official Marketplace Insights API. Sold
// searches return a clear "unavailable" state; For Sale uses the Browse API.

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

      // Donations / monthly supporters grant NO perks — record them toward the
      // monthly funding goal and stop, so a supporter is never mislabeled as a
      // paid plan.
      if (session.metadata?.type === 'donation' || session.metadata?.type === 'supporter') {
        const isRecurring = session.metadata.type === 'supporter';
        recordDonation(session.amount_total, isRecurring);
        const amt = (session.amount_total != null) ? `$${(session.amount_total / 100).toFixed(2)}` : 'unknown';
        console.log(`[fund] ${session.metadata.type} received: ${amt} (${session.metadata.username || 'anon'})`);
        break;
      }

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
    case 'invoice.payment_succeeded': {
      // Count recurring monthly-Supporter renewals toward the funding goal. The
      // first invoice (billing_reason 'subscription_create') is already counted
      // at checkout, so only count subsequent cycles to avoid double-counting.
      const invoice = event.data.object;
      if (invoice.billing_reason === 'subscription_cycle') {
        recordDonation(invoice.amount_paid, false);
        console.log(`[fund] supporter renewal: $${((invoice.amount_paid || 0) / 100).toFixed(2)}`);
      }
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
      ebaySold: {
        // Per-user keys now — server doesn't hold a sold-data secret.
        configured: true,
        provider: 'retired (awaiting official eBay sold-data API)',
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



// True when a user has an active paid plan (Pro / Pro+) or a permanent grant.
// The single source of truth for every Pro feature gate (bulk pricer, promote,
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
const SOLD_UNAVAILABLE_MSG = 'Sold price data is temporarily unavailable while we connect eBay’s official sold-data API. Use For Sale mode for live listings in the meantime.';
function sendSoldUnavailable(res) {
  // HTTP 200 (not an error status) so the frontend's graceful "sold unavailable"
  // handlers run — they read the body after an `if (!res.ok) throw` guard, the
  // same way the old rateLimited path was delivered.
  return res.json({ results: [], total: 0, soldUnavailable: true, error: SOLD_UNAVAILABLE_MSG });
}

// ---- Shared fetch function ----
// mode: 'forsale' (eBay Browse API) or 'sold' (retired — returns unavailable)
// Cache disabled for both modes per user request — every search hits the
// upstream APIs fresh so users always see current listings/prices. The
// in-memory ebayCache + getCached/setCache helpers stay in the file for
// the unrelated marketplace endpoint to use.
async function fetchEbayItems(keywords, limit = 20, mode = 'forsale', source = 'search', offset = 0) {
  if (mode === 'sold') {
    // Sold data source retired. Sold-based features return a clear "unavailable"
    // state until eBay's official sold-data (Marketplace Insights) API is wired in.
    return { results: [], total: 0, soldUnavailable: true };
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

  // Sold data is retired pending eBay's official Marketplace Insights API.
  // Bail early with a clear unavailable state; For Sale (Browse API) continues.
  if (mode === 'sold') return sendSoldUnavailable(res);

  if (USE_MOCK_FORSALE) {
    return res.json(getMockData(query, mode));
  }

  try {
    const serial = extractSerial(query);

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
  return sendSoldUnavailable(res);
});

// ---- /api/direct-search ----
app.get('/api/direct-search', async (req, res) => {
  return sendSoldUnavailable(res);
});

// ---- /api/variants ----
app.get('/api/variants', async (req, res) => {
  return sendSoldUnavailable(res);
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
    // Mirror this user's promoted cards into the global index so the Browse
    // Cards page and search injection can show cards from everyone — free for all.
    const promos = Array.isArray(data.cardHuddlePromotedCards)
      ? data.cardHuddlePromotedCards : [];
    updateGlobalPromotedIndex(username, promos);
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

// ---- Global Floor (Showcase booths) Index ----
// Mirrors each user's public booth — their collector character plus the
// showcase cards they've put out — into a single KV map { username: booth }
// so The Floor can render everyone's table. Updated whenever a user PUTs
// their data blob; read by GET /api/floor/booths. Same loadData/saveData
// (Cloudflare KV) pipeline as the promoted index.
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
// pipeline as the promoted index, so it persists on Cloudflare KV.
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
    // Whether donations ("Fund the Card Huddle") can be collected right now.
    checkoutEnabled: !!CHECKOUT_ENABLED,
  });
});

// ---- Fund the Card Huddle: monthly goal + progress ----
// The visible "$X of $Y this month" bar. Goal is configurable via env; raised
// is accumulated by the Stripe webhook as donations come in, bucketed by
// calendar month so it resets cleanly on the 1st. Persisted via the normal
// loadData/saveData (KV) pipeline — 'fundStats' is in KNOWN_KEYS so it survives
// cold starts instead of being overwritten.
const FUND_GOAL_MONTHLY = parseFloat(process.env.FUND_GOAL_MONTHLY) || 50;
const FUND_STATS_FILE = path.join(APP_ROOT, 'data', 'fund-stats.json');
function _fundMonth() { return new Date().toISOString().slice(0, 7); } // YYYY-MM
function loadFundStats() {
  const s = loadData('fundStats', FUND_STATS_FILE, { month: _fundMonth(), raised: 0, supporters: 0, allTime: 0 });
  // Roll over to a fresh bucket when the calendar month changes.
  if (s.month !== _fundMonth()) {
    return { month: _fundMonth(), raised: 0, supporters: 0, allTime: s.allTime || 0 };
  }
  return s;
}
function recordDonation(amountCents, isRecurring) {
  const dollars = (amountCents || 0) / 100;
  if (dollars <= 0) return;
  const s = loadFundStats();
  s.raised = Math.round((s.raised + dollars) * 100) / 100;
  s.allTime = Math.round(((s.allTime || 0) + dollars) * 100) / 100;
  if (isRecurring) s.supporters = (s.supporters || 0) + 1;
  saveData('fundStats', FUND_STATS_FILE, s);
}

// GET /api/fund-goal — drives the progress bar. Public, cache-light.
app.get('/api/fund-goal', (req, res) => {
  const s = loadFundStats();
  const goal = FUND_GOAL_MONTHLY;
  res.json({
    goal,
    raised: s.raised || 0,
    supporters: s.supporters || 0,
    month: s.month,
    pct: goal > 0 ? Math.min(100, Math.round(((s.raised || 0) / goal) * 100)) : 0,
    currency: 'usd',
  });
});

// ---- Fund the Card Huddle (donations) ----
// The Card Huddle is free for everyone and community-funded. This creates a
// Stripe Checkout session for either a one-time donation (mode: payment) or a
// recurring monthly "Supporter" (mode: subscription). Donations grant NO perks
// — every feature is free regardless. Ad-hoc price_data so no pre-created
// product/price IDs are needed.
app.post('/api/stripe/create-donation', async (req, res) => {
  if (!stripeEnabled) return res.status(503).json({ error: 'Donations are not configured on this server yet.' });
  const { amount, recurring } = req.body || {};
  const dollars = parseFloat(amount);
  if (!dollars || isNaN(dollars)) return res.status(400).json({ error: 'Please choose an amount.' });
  const cents = Math.round(dollars * 100);
  if (cents < 100 || cents > 100000) return res.status(400).json({ error: 'Amount must be between $1 and $1000.' });
  const username = getSessionUser(req) || '';
  const isRecurring = !!recurring;
  try {
    const priceData = isRecurring
      ? { currency: 'usd', unit_amount: cents, recurring: { interval: 'month' }, product_data: { name: 'The Card Huddle — Monthly Supporter' } }
      : { currency: 'usd', unit_amount: cents, product_data: { name: 'The Card Huddle — Donation' } };
    const session = await stripe.checkout.sessions.create({
      mode: isRecurring ? 'subscription' : 'payment',
      line_items: [{ price_data: priceData, quantity: 1 }],
      metadata: { type: isRecurring ? 'supporter' : 'donation', username: username.toLowerCase() },
      success_url: `${siteOrigin(req)}/?funded=${isRecurring ? 'monthly' : 'once'}`,
      cancel_url: `${siteOrigin(req)}/?funded=cancel`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe donation error:', err);
    res.status(500).json({ error: 'Could not start the donation checkout.', detail: String(err && err.message || err) });
  }
});

// Create checkout session for Pro subscription
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
  return sendSoldUnavailable(res);
});

// ---- Market Movers (Pro+) ----
// Identifies cards with prices trending up significantly in recent sales.
app.get('/api/market-movers', requirePlan('pro'), async (req, res) => {
  return sendSoldUnavailable(res);
});

// ---- Auto-Pricer: Comp Search (Pro+) ----
// Returns raw sold listings for the user to pick the closest match before pricing.
app.get('/api/auto-price/search', async (req, res) => {
  return sendSoldUnavailable(res);
});

// ---- Auto-Pricer (Pro+) ----
// Smart pricing: tries exact query first, falls back to progressively broader queries.
// Handles missing year/card# by using what's available. Returns confidence level.
app.get('/api/auto-price', async (req, res) => {
  return sendSoldUnavailable(res);
});

// ---- Bulk Price (Pro+) ----
// Prices up to 20 cards at once, returning median sold price for each.
app.post('/api/bulk-price', async (req, res) => {
  return sendSoldUnavailable(res);
});

// Create checkout session for extra promote slot
app.post('/api/stripe/buy-slot', async (req, res) => {
  if (!CHECKOUT_ENABLED) return res.status(503).json({ error: CHECKOUT_PAUSED_MSG });
  if (!stripeEnabled) return res.status(503).json({ error: 'Stripe is not configured. Add your Stripe keys to .env' });

  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'Username required' });

  const userSub = getEffectiveSubscription(username);
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
module.exports = { app, connectDB, getSessionUserByToken, extractSearchKeywords, matchSoldListings, classifyCardType, buildSimilarCardEstimate, hasExactCardSales, parsePrintRunFromTitle, detectSetTier, getEffectiveSubscription, PRO_GRANT_USERS, checkAlerts, processScanLeadDrip };

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
