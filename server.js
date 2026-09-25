require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const crypto = require('crypto');
const { connectDB, loadData, saveData, loadUserData, saveUserData, deleteUserData, loadUserPhoto, saveUserPhoto, deleteUserPhoto, cacheGet, cachePut: _rawCachePut, archiveGet, archivePut, getNflDb: _rawNflDb, getAssets, getPhotos } = require('./db');

// WHEN WAS THIS COMPUTED, AND HOW OLD IS IT.
//
// Eight endpoints return a cached payload straight from KV, and none of them
// said so. The Most Sold board is cached for 48 hours and warmed by cron; a
// card's analysis for 30 minutes. Reading one of those and asking "is this
// showing my change yet?" was unanswerable from the page, and got answered
// wrong twice in a day — once as "the fix did not work" when it had, and once
// as "it shipped" when the screen was still serving the old grouping.
//
// So every cached object is stamped on the way in, and every cache hit says how
// old it is on the way out. The stamp is applied in cachePut rather than at each
// call site, because a report that forgets it is exactly the one someone will
// later mistrust.
// The stamp goes on the object itself rather than on a copy. Every one of
// these call sites caches the payload and then hands the SAME object to
// res.json, so a stamp that only reached the stored copy would leave the
// person who paid to compute the report holding the one undated version of it
// — and everyone after them holding a dated one.
function _stamped(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v) || v.generatedAt) return v;
  const at = new Date().toISOString();
  try { v.generatedAt = at; } catch (_) { /* frozen — fall through to a copy */ }
  return v.generatedAt === at ? v : { ...v, generatedAt: at };
}

const cachePut = (key, value, ttl) => _rawCachePut(key, _stamped(value), ttl);

// A cache hit, labelled. ageMinutes is absent rather than guessed when the
// stored payload predates the stamp — an unknown age must not read as zero.
function _fromCache(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return v;
  const t = Date.parse(v.generatedAt || '');
  const out = { ...v, servedFromCache: true };
  if (Number.isFinite(t)) out.ageMinutes = Math.max(0, Math.round((Date.now() - t) / 60000));
  return out;
}
// Canonical player and parallel names from the checklists, derived from
// public/data/checklists at build time by scripts/build-card-index.js.
//
// Loaded on first use, NOT at module scope. Together the two artifacts are
// 1.26 MB of JSON, and requiring them at the top parses all of it during
// startup — on every cold isolate, for every request, including the ones that
// never touch the market. That is what tripped the Worker resource limit.
//
// Nothing on the request path needs them: the index reads canonical names from
// D1, which is the whole point of the alias table. Only the cron backfill and
// the two diagnostics do, and they can afford the parse once per isolate.
// NOT bundled into the Worker.
//
// Together they are 1.26 MB of JSON, and a Worker must compile its entire
// script before serving anything — so the cost is paid on every cold isolate
// whether or not a request touches them. It took the whole site down with
// error 1102 on every request, not just the market. Deferring the work inside
// the modules was not enough, because compilation happens regardless of when
// the code runs.
//
// Nothing user-facing needs them. The index groups on canonical names read from
// D1, which is what the alias table exists for; only the cron backfill and two
// diagnostics use the dictionaries directly, and those degrade to a clear
// message rather than taking the site with them.
//
// scripts/build-card-index.js still writes them, and they are still committed —
// they belong in the bundle again only once they are served from the assets
// binding and fetched on demand.
// Fetched from the assets binding on first use, never bundled. Only the logic
// is compiled into the Worker; the data arrives over a subrequest and is held
// for the life of the isolate.
//
// In Node there is no assets binding, so the committed files are read directly
// and the same resolvers are built from them — which is what the tests drive.
const { createCardIndex } = require('./card-index-core');
const { createParallelIndex, parallelKey: _parallelKey } = require('./parallel-index-core');
// Grade bucketing, split out so it can be tested directly. It decides the
// "Ungraded" badge on every sold tile AND which sales reach the Raw price
// series, and it was calling every PSA10/BGS9.5 slab raw — see grade-core.js.
const { gradeBucket: _gradeBucketCore, stripGrade: _stripGrade } = require('./grade-core');
// Base vs autograph vs relic — the largest single source of merged cards.
// See card-kind.js: autograph sets reuse the base set's numbering, and 65.5% of
// all ambiguous (player, number) keys in the catalogue are exactly that.
const { cardKind: _cardKind, printRun: _printRun, kindSql: _kindSql } = require('./card-kind');

// cardKind(), in SQL.
//
// The "Most sold" board groups every priced sale in a 30-day window — around
// half a million rows — so the kind has to be decided inside the query. Pulling
// the titles into the Worker to run the JS reader would not fit in memory.
//
// GENERATED from card-kind.js's word lists rather than transcribed, because a
// transcribed copy drifts and this codebase has paid for that twice in one day:
// two grade readers that disagreed about what a slab was, and two search
// endpoints where only one had the identity check wired in. card-kind.test.js
// runs a corpus through both readers and requires the same answer.
//

// How a kind is written on a tile. Base has no label — the overwhelming
// majority of cards are base, and stamping "Base" on most of the board adds
// noise to say nothing.
const _KIND_LABEL = { auto: 'Auto', relic: 'Relic', redemption: 'Redemption' };

// How many sales a (player, year, set, number) needs before its titles are
// worth reading, and the ceiling on how many rows come back.
//
// The board shows 50. Splitting one of those by parallel and kind can turn it
// into a handful of rows, so the shortlist is deliberately much longer than the
// board — but a card with under 25 sales in a month cannot reach a board whose
// entries trade in the hundreds, and excluding it in SQL is what keeps this
// affordable. The ceiling exists so a pathological month cannot return an
// unbounded result set; when it bites, the board says so rather than quietly
// showing a ranking computed on a truncated sample.
// Bounded by GROUPS, not by rows.
//
// The first live run bounded it by rows and came back truncated:true — 25,000
// sales was the binding limit, and a LIMIT with no ORDER BY takes whichever
// rows the engine reaches first. So the board was ranked on an arbitrary slice
// of qualifying sales rather than on the most-traded cards. The flag caught it
// on the first deploy that could report one; the design was wrong.
//
// Taking the largest groups explicitly is correct and cheaper. The board shows
// 50, and splitting one pre-split group by parallel and kind yields a handful
// of rows, so 150 groups is ample headroom for a 50-row board.
const MOST_SOLD_MIN_GROUP = 25;
const MOST_SOLD_MAX_GROUPS = 150;
// A safety valve, not a working limit. If this binds, the shape of the data has
// changed and the board reports truncated:true rather than presenting a partial
// ranking as a complete one.
const MOST_SOLD_MAX_ROWS = 60000;

// Group individual sales into CARDS, reading what the columns do not carry.
//
// The parallel column is filled on 48% of sales. For the rest the parallel is
// in the title, which is why this cannot be a GROUP BY: "2026 Topps Mendoza
// #301" covers a plain base rookie, a Refractor and a Gold /10, and averaging
// them produces a price that belongs to none of them.
//
// WHAT HAPPENS TO A PARALLEL THAT CANNOT BE READ, which took a failing test to
// get right. The first version dropped those sales, on the principle of being
// accurate about the cards we can name. That gutted the board: the reader works
// on the segment after the card number, and a base card's title very often ends
// in a team name — "Fernando Mendoza RC #301 Las Vegas Raiders" reads as
// unmatched, not as base, so the commonest card in the sample vanished.
//
// So an unreadable parallel joins the unnamed pile with the confident base
// reads. It is the honest position: parallels we CAN read get their own tile,
// and what is left is one group that does not claim to be anything. Separating
// it would put two tiles with identical names on the board.
//
// The count is reported, because that pile is where a Refractor can still hide
// next to a base card, and its size is the size of the remaining problem.
//
// ...and it was hiding there. The live board's "2026 Topps Fernando Mendoza
// #301" tile showed a $680 high and a photo of a foil parallel, because
// "#301 Orange Foilboard /99" and "Lava Refractor RC #301" read as unmatched
// or base and joined the base pile. So a sale only joins the unnamed pile when
// its title shows no sign of a parallel at all (see _PARALLEL_SIGNAL). One that
// plainly names a parallel the dictionary does not know is left off the board:
// a base tile that holds a /99 is wrong about the card, and a base title ending
// in a team name carries none of these words, so the board keeps its sample.

// Words that only turn up in a title when the card is not the plain base card.
// Colours and finishes, not the parallel dictionary itself: that vocabulary
// also holds "Rookie", "Football" and a few hundred player names.
const _PARALLEL_SIGNAL_WORDS = [
  'gold', 'golden', 'red', 'blue', 'black', 'green', 'purple', 'orange', 'pink',
  'yellow', 'silver', 'white', 'teal', 'aqua', 'bronze', 'platinum', 'emerald',
  'sapphire', 'ruby', 'lime', 'magenta', 'copper', 'maroon', 'onyx', 'cyan',
  'navy', 'fuchsia', 'turquoise', 'lavender', 'indigo', 'violet', 'amethyst',
  'citrine', 'jade', 'cobalt', 'neon',
  'refractor', 'refractors', 'xfractor', 'superfractor', 'prizm', 'prizms',
  'holo', 'foil', 'foilboard', 'shimmer', 'wave', 'mojo', 'sparkle', 'lava',
  'ice', 'disco', 'pulsar', 'shock', 'camo', 'mosaic', 'mirror', 'geometric',
  'hyper', 'sandglitter', 'diamante', 'rainbow', 'raywave', 'speckle', 'lazer',
  'laser', 'cracked', 'snakeskin', 'zebra', 'galactic', 'nebula', 'fluorescent',
  'velocity', 'scope', 'marble', 'aqueous', 'glitter', 'stained', 'fotl',
  'parallel', 'variation', 'var', 'sp', 'ssp', 'numbered', 'proof', 'plate',
];
const _PARALLEL_SIGNAL = new RegExp(`\\b(${_PARALLEL_SIGNAL_WORDS.join('|')})\\b`);
// A print run: "/99", "/ 25", "1/1". Base cards are not serial numbered.
const _SERIAL_RUN = /(^|\s|\d)\/\s*\d+\b|\b\d+\s*of\s*\d+\b/;
// Team names that carry a colour word and would otherwise read as a parallel.
const _SIGNAL_TEAM_PHRASES = /\bgreen bay\b|\bred ?sea\b/g;
// Matched "parallels" that are really what a seller types about a base card.
const _BASE_NAMES = new Set(['base', 'rookie', 'rc']);

// Does this title look like a parallel even though no parallel was read? The
// player and set names are removed first, so "A.J. Green", "Golden Tate",
// "Topps Chrome" and "Prizm" (the product) do not count against the base card.
function _looksLikeParallel(title, player, setName) {
  let t = ' ' + _stripGrade(String(title || '')).toLowerCase()
    .replace(/[^a-z0-9/ ]+/g, ' ') + ' ';
  if (_SERIAL_RUN.test(t)) return true;
  const drop = (s) => {
    for (const w of String(s || '').toLowerCase().split(/[^a-z0-9]+/)) {
      if (w) t = t.replace(new RegExp(`\\b${w}\\b`, 'g'), ' ');
    }
  };
  drop(player);
  drop(setName);
  t = t.replace(_SIGNAL_TEAM_PHRASES, ' ');
  return _PARALLEL_SIGNAL.test(t);
}

function _groupMostSold(rows, pi, pAliases, overrides) {
  const groups = new Map();
  let unreadable = 0, dropped = 0;
  for (const r of rows) {
    const title = String(r.title || '');
    // No card number is no card: "2026 Topps Fernando Mendoza" with a blank
    // number spans every card he has in the product. The query leaves these
    // out; this is the same rule for rows reaching here any other way.
    if (!String(r.card_number == null ? '' : r.card_number).trim()) { dropped++; continue; }
    const kind = _cardKind(title);

    // An override on this sale, then the column, then the title. One chain,
    // shared with the card page, so a decision cannot land on one and not the
    // other.
    const hit = _saleParallel(r, pi, pAliases, overrides, r.player);
    let name = '', key = '';
    if (hit && hit.parallel && !_BASE_NAMES.has(_parallelKey(hit.parallel))) {
      name = hit.parallel; key = _parallelKey(name);
    } else if (hit && hit.how === 'sale-override') {
      // A person looked at this sale and said base. That outranks any word in
      // the title.
    } else if (_looksLikeParallel(title, r.player, r.set_name)) {
      dropped++; continue;
    } else if (!(hit && (hit.how === 'base' || hit.parallel))) {
      unreadable++;
    }

    const id = [r.player, r.year, r.set_name, r.card_number, kind, key].join('\u0000');
    let g = groups.get(id);
    if (!g) {
      g = { player: r.player, year: r.year, set_name: r.set_name,
            card_number: r.card_number, kind, parallel: name,
            n: 0, total: 0, max: -1, rows: [] };
      groups.set(id, g);
    }
    g.n++;
    g.total += (r.price_cents || 0);
    g.max = Math.max(g.max, r.price_cents || 0);
    g.rows.push(r);
  }
  // The photo and link come from a typical sale, the one nearest the median
  // price, preferring one with a photo. The dearest sale was used before, and
  // the dearest sale in a pile is exactly the one most likely to be a stray
  // parallel, so the tile advertised the wrong card.
  const out = [...groups.values()];
  for (const g of out) {
    const byPrice = g.rows.slice().sort((a, b) => (a.price_cents || 0) - (b.price_cents || 0));
    const mid = byPrice.length >> 1;
    let best = mid;
    for (let i = 0; i < byPrice.length; i++) {
      if (byPrice[i].image_url &&
          (!byPrice[best].image_url || Math.abs(i - mid) < Math.abs(best - mid))) best = i;
    }
    g.top = byPrice[best] || null;
    delete g.rows;
  }
  return { groups: out.sort((a, b) => b.n - a.n), unreadable, dropped };
}
const {
  buildIndex: buildJoinIndex, matchSale, matchPlayer, playerKeys, saleKeys,
  norm: _setNorm,
} = require('./set-key');
const {
  summarise: priceSummarise, render: priceRender, median: priceMedian, keyFor: priceKeyFor,
} = require('./price-block-core');

const _dict = { card: null, parallel: null };
async function _loadJson(name) {
  const assets = getAssets();
  if (assets) {
    // The binding wants an absolute URL; the origin is not used for lookup.
    const resp = await assets.fetch(new Request(`https://assets.local/data/${name}`));
    if (!resp || !resp.ok) throw new Error(`assets.fetch /data/${name} -> ${resp && resp.status}`);
    // A 200 is not proof the file exists. not_found_handling is
    // single-page-application, so a missing asset comes back as index.html with
    // a 200 — and "unexpected token <" is a poor way to learn the artifact was
    // never uploaded. Check what actually arrived.
    const ct = resp.headers.get('content-type') || '';
    if (!/json/i.test(ct)) throw new Error(`/data/${name} served as ${ct || 'unknown'} — not uploaded?`);
    return await resp.json();
  }
  // Node only, and deliberately hidden from the bundler. A plain require here —
  // even with a computed path — is resolved by esbuild at build time, which put
  // the whole 1.26 MB back into the compiled script and undid the point of
  // this. Verified against the built bundle both ways.
  const nodeRequire = eval('require');
  return nodeRequire('./public/data/' + name);
}

async function cardIndex() {
  if (_dict.card === null) {
    try { _dict.card = createCardIndex(await _loadJson('card-index.json')); }
    catch (err) { console.error('[dict] card index unavailable:', err && err.message); _dict.card = false; }
  }
  return _dict.card || null;
}
async function parallelIndex() {
  if (_dict.parallel === null) {
    try {
      const ci = await cardIndex();
      _dict.parallel = createParallelIndex(
        await _loadJson('parallel-index.json'),
        ci ? ci.resolvePlayer : () => null);
    } catch (err) {
      console.error('[dict] parallel index unavailable:', err && err.message);
      _dict.parallel = false;
    }
  }
  return _dict.parallel || null;
}

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
// ---- WHO IS ACTUALLY ASKING ------------------------------------------------
//
// Google Analytics showed 918 users, 919 sessions, 907 views and ZERO seconds
// of average engagement in a day. That is not a shape people make: one session
// each, fewer views than sessions, and nobody's page staying open.
//
// But GA cannot settle it, because GA only ever sees clients that run its
// JavaScript. Every headless browser is counted and every plain scraper is
// invisible, so the one number in front of us is the one guaranteed to
// undercount the problem. Bot Fight Mode was ON through all of it and changed
// nothing, which fits: it scores known-bad signatures, and a real headless
// Chrome does not look like one.
//
// So count here instead. The Worker sees every request — JS or no JS, GA
// blocked or not — and this is the only vantage point that does.
//
// COSTS NOTHING TO SPEAK OF. Counters live in the isolate and are flushed to
// one KV key a day by the cron that already flushes D1 usage. No per-request
// write, no database, no third party.
const TRAFFIC_KEY = (d) => `traffic:v1:${d}`;
const TRAFFIC_TTL = 60 * 60 * 24 * 40;

// Self-declared, and that is the point.
//
// Honest crawlers say so and can simply be counted. Nothing here is a defence:
// a bot that lies is counted as a browser, which is exactly the population
// worth measuring — if `browserLike` is enormous and engagement is zero, the
// liars are the story.
const _BOT_UA = /bot|crawl|spider|slurp|bingpreview|headless|phantom|puppeteer|playwright|selenium|curl|wget|python-requests|httpclient|scrapy|axios|go-http|java\/|okhttp|libwww|feedfetcher|facebookexternalhit|embedly|semrush|ahrefs|mj12|dotbot|petalbot|dataforseo|bytespider|gptbot|claudebot|ccbot|perplexity/i;

const _traffic = { day: '', total: 0, declaredBot: 0, browserLike: 0, noUa: 0,
                   asset: 0, api: 0, page: 0, limited: 0, byUa: {}, byPath: {},
                   byLimited: {}, captcha: {} };

function _trafficDay() { return new Date().toISOString().slice(0, 10); }

function _noteRequest(req) {
  try {
    const day = _trafficDay();
    // A new day resets in place rather than accumulating across midnight, so a
    // long-lived isolate cannot smear one day's traffic into the next.
    if (_traffic.day !== day) {
      _traffic.day = day;
      _traffic.total = 0; _traffic.declaredBot = 0; _traffic.browserLike = 0;
      _traffic.noUa = 0; _traffic.asset = 0; _traffic.api = 0; _traffic.page = 0;
      _traffic.limited = 0;
      _traffic.byUa = {}; _traffic.byPath = {}; _traffic.byLimited = {};
      _traffic.captcha = {};
    }
    _traffic.total++;

    const ua = String(req.headers['user-agent'] || '');
    if (!ua) _traffic.noUa++;
    else if (_BOT_UA.test(ua)) _traffic.declaredBot++;
    else _traffic.browserLike++;

    const p = String(req.path || '/');
    if (p.startsWith('/api/')) _traffic.api++;
    else if (/\.[a-z0-9]{2,5}$/i.test(p)) _traffic.asset++;
    else _traffic.page++;

    // Bounded on purpose. An unbounded tally is a memory leak an attacker
    // controls: every distinct user agent and path would allocate a key, and
    // both are attacker-supplied.
    const uaKey = ua ? ua.slice(0, 60) : '(none)';
    if (_traffic.byUa[uaKey] !== undefined || Object.keys(_traffic.byUa).length < 60) {
      _traffic.byUa[uaKey] = (_traffic.byUa[uaKey] || 0) + 1;
    }
    if (_traffic.byPath[p] !== undefined || Object.keys(_traffic.byPath).length < 60) {
      _traffic.byPath[p] = (_traffic.byPath[p] || 0) + 1;
    }
  } catch (_) { /* counting must never break a request */ }
}

// Merged into the day's KV row by the cron. Same shape as flushD1Usage: add,
// then zero, so a missed tick loses one interval rather than double-counting.
async function flushTraffic() {
  if (!_traffic.total) return { ok: true, flushed: 0 };
  const day = _traffic.day || _trafficDay();
  try {
    const key = TRAFFIC_KEY(day);
    const prev = (await cacheGet(key)) || {};
    for (const k of ['total', 'declaredBot', 'browserLike', 'noUa', 'asset', 'api', 'page', 'limited']) {
      prev[k] = (prev[k] || 0) + _traffic[k];
      _traffic[k] = 0;
    }
    for (const bucket of ['byUa', 'byPath', 'byLimited', 'captcha']) {
      const acc = prev[bucket] || {};
      for (const [k, n] of Object.entries(_traffic[bucket])) acc[k] = (acc[k] || 0) + n;
      // Kept to the top 60 in KV too, or a month of long tails grows without end.
      prev[bucket] = Object.fromEntries(
        Object.entries(acc).sort((a, b) => b[1] - a[1]).slice(0, 60));
      _traffic[bucket] = {};
    }
    await cachePut(key, prev, TRAFFIC_TTL);
    return { ok: true, flushed: 1, day };
  } catch (err) {
    return { ok: false, reason: String(err && err.message) };
  }
}

// ---- Inbound rate limiting ----
//
// WHY THIS EXISTS. Every `rateLimited` path in this file until now pointed
// outward: eBay telling us we had asked too often. Nothing capped what one
// caller could ask of us. /api/search spends eBay quota per call and
// /api/scan-card spends an eBay image search per photo, so an unattended
// script could run up real money at whatever rate its network allowed.
//
// WHAT IT IS NOT. This is not bot protection and will not be mistaken for it.
// It does not care who is calling, it cannot tell a scraper from a person,
// and a caller spread over many addresses gets a fresh budget at each one.
// It caps what a single address can spend, which is the part that bills.
//
// APPROXIMATE ON PURPOSE. Counters live in the isolate, like the traffic
// tally above. Workers run many isolates, so a caller spread across colos
// holds a budget in each and the real ceiling is higher than the numbers
// below. The alternative is a KV or Durable Object write per request, which
// would cost more than the abuse it prevents. Undercounting is the accepted
// trade: the case this exists to stop is one client hammering one endpoint,
// and that it does see.
const RL_DISABLED = process.env.DISABLE_RATE_LIMIT === '1';

// Budgets sit where no person can reach them and a script trips immediately.
// A fast searcher might manage a query every few seconds; 60 a minute is an
// order of magnitude past that, and 600 an hour is past a whole session of it.
// The hour window is what stops a caller pacing itself just under the minute.
const RL_TIERS = [
  { name: 'scan', minute: 20, hour: 200, match: (p) => p === '/api/scan-card' },
  { name: 'search', minute: 60, hour: 600, match: (p) => p === '/api/search' },
  { name: 'api', minute: 300, hour: 5000, match: (p) => p.startsWith('/api/') },
];

// Bounded, for the same reason the traffic tally is: one key per source
// address is a memory leak a botnet controls. Past the cap we stop metering
// rather than stop serving — a rate limiter that takes the site down has
// done the attacker's job for them.
const RL_MAX_KEYS = 20000;
const _rlHits = new Map();

function _rlSweep(now) {
  for (const [k, e] of _rlHits) if (now >= e.h.until) _rlHits.delete(k);
}

// Behind Cloudflare, cf-connecting-ip is set by the edge and cannot be forged
// by the caller. x-forwarded-for can be, so it is only consulted off-Worker,
// where this is a development convenience rather than a control.
function _rlKey(req) {
  const cf = String(req.headers['cf-connecting-ip'] || '').trim();
  if (cf) return cf;
  if (process.env.CF_WORKER) return 'no-cf-ip';
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xff || req.ip || 'local';
}

// Returns null to allow, or { tier, scope, retryAfter } to refuse.
// Exported so the tests can drive it without standing up a socket.
function rateLimitCheck(req, now = Date.now()) {
  if (RL_DISABLED) return null;
  const p = String(req.path || '/');
  if (!p.startsWith('/api/')) return null;
  const tier = RL_TIERS.find(t => t.match(p));
  if (!tier) return null;

  const key = _rlKey(req);
  let e = _rlHits.get(key);
  if (!e) {
    if (_rlHits.size >= RL_MAX_KEYS) _rlSweep(now);
    if (_rlHits.size >= RL_MAX_KEYS) return null; // saturated: serve, don't meter
    e = { m: { n: 0, until: 0 }, h: { n: 0, until: 0 } };
    _rlHits.set(key, e);
  }
  if (now >= e.m.until) { e.m.n = 0; e.m.until = now + 60000; }
  if (now >= e.h.until) { e.h.n = 0; e.h.until = now + 3600000; }

  e.m.n++;
  e.h.n++;
  if (e.m.n > tier.minute) {
    return { tier: tier.name, scope: 'minute', retryAfter: Math.max(1, Math.ceil((e.m.until - now) / 1000)) };
  }
  if (e.h.n > tier.hour) {
    return { tier: tier.name, scope: 'hour', retryAfter: Math.max(1, Math.ceil((e.h.until - now) / 1000)) };
  }
  return null;
}

// Tier names are ours, not the caller's, so this needs no size bound.
function _noteLimited(tier) {
  try {
    _traffic.limited++;
    _traffic.byLimited[tier] = (_traffic.byLimited[tier] || 0) + 1;
  } catch (_) { /* counting must never break a request */ }
}

// ---- reCAPTCHA ----
//
// Guards the two endpoints that spend money per call — /api/search (eBay
// quota) and /api/scan-card (an eBay image search per photo). Nothing else,
// and deliberately nothing that renders a page: the generated /sets, /players
// and /teams pages are how this site is found, and a crawler handed a
// challenge is a page removed from the index.
//
// Google is asked about the token on each guarded call. That is a network
// round trip, not CPU, so it does not touch the Worker's CPU budget, and it
// sits in front of a search that was already going to take seconds.
//
// v2 and v3 are both handled. A v3 verification carries a `score` and is
// checked against RECAPTCHA_MIN_SCORE; a v2 one carries no score and only has
// to succeed. That way the key can be swapped without touching this code.
const RECAPTCHA_SECRET = process.env.Recaptcha_secret || process.env.RECAPTCHA_SECRET || '';
const RECAPTCHA_MIN_SCORE = Number(process.env.RECAPTCHA_MIN_SCORE || 0.5);
// A kill switch that needs no deploy. If this turns real people away, setting
// it to 0 in the dashboard stops the enforcement on the next request while
// the counters below keep reporting what it WOULD have done.
const RECAPTCHA_ENFORCE = process.env.RECAPTCHA_ENFORCE !== '0';
const RECAPTCHA_PATHS = ['/api/search', '/api/scan-card'];

// Verifications are counted the same way refusals are, so /api/debug/traffic
// answers the question this feature actually raises: how many people is it
// turning away? A silent gate is how you lose real users and never find out.
function _noteCaptcha(outcome) {
  try {
    _traffic.captcha[outcome] = (_traffic.captcha[outcome] || 0) + 1;
  } catch (_) { /* counting must never break a request */ }
}

async function verifyRecaptcha(token, ip) {
  if (!token) return { ok: false, why: 'missing' };
  try {
    const body = new URLSearchParams({ secret: RECAPTCHA_SECRET, response: token });
    if (ip) body.set('remoteip', ip);
    const r = await fetch('https://www.google.com/recaptcha/api/siteverify', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const d = await r.json();
    if (!d.success) {
      const codes = (d['error-codes'] || []).join(',');
      // A token is single-use and short-lived. Both of those read as an
      // ordinary stale retry, not as an attack.
      return { ok: false, why: codes || 'rejected' };
    }
    // v3 only. A v2 response has no score and success is the whole answer.
    if (typeof d.score === 'number' && d.score < RECAPTCHA_MIN_SCORE) {
      return { ok: false, why: 'low-score', score: d.score };
    }
    return { ok: true, score: typeof d.score === 'number' ? d.score : null };
  } catch (err) {
    // Google unreachable. Fail OPEN, and say so in the counters.
    //
    // The alternative is that an outage at Google takes search down here, which
    // is a worse day than letting some traffic through unverified — the rate
    // limiter is still underneath this, so the cost is still capped.
    console.error('[recaptcha] verify failed:', err && err.message);
    return { ok: true, degraded: true };
  }
}

app.use((req, res, next) => {
  _noteRequest(req);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// Runs before express.json for the same reason the rate limiter does: a
// refused scan must not first cost the parse of a 12mb body.
app.use(async (req, res, next) => {
  // No secret configured is not a failure — it is local development and every
  // test in this repo. The guard simply is not on.
  if (!RECAPTCHA_SECRET) return next();
  if (!RECAPTCHA_PATHS.includes(String(req.path || ''))) return next();
  if (isAdminReq(req)) return next();

  const token = String(req.headers['x-recaptcha-token'] || req.query.captcha || '');
  const ip = String(req.headers['cf-connecting-ip'] || '').trim();
  const v = await verifyRecaptcha(token, ip);

  if (v.degraded) { _noteCaptcha('degraded'); return next(); }
  if (v.ok) { _noteCaptcha('pass'); return next(); }

  _noteCaptcha(v.why === 'missing' ? 'missing' : 'fail');
  // Report-only mode still counts, so the damage can be measured before the
  // gate is trusted with real traffic.
  if (!RECAPTCHA_ENFORCE) return next();

  return res.status(403).json({
    error: "Couldn't verify this request came from a browser. Reload the page and try again.",
    captchaFailed: true,
    reason: v.why,
  });
});

// Ahead of express.json on purpose: a refused request must not first cost us
// the parse of a 12mb scan body.
app.use((req, res, next) => {
  // Admin tooling is not the threat, and spends no budget even when busy.
  if (isAdminReq(req)) return next();
  const hit = rateLimitCheck(req);
  if (!hit) return next();
  _noteLimited(hit.tier);
  res.setHeader('Retry-After', String(hit.retryAfter));
  // `rateLimited` / `rateLimitMessage` match the shape the client already
  // understands from the eBay path, so there is one way to say this.
  return res.status(429).json({
    error: `Too many requests — slow down and try again in ${hit.retryAfter}s.`,
    rateLimited: true,
    rateLimitMessage: `That's a lot of requests in a short time. This unlocks again in ${hit.retryAfter} seconds.`,
    retryAfter: hit.retryAfter,
  });
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

// Best-offer sales, kept out of every aggregate.
//
// Most of them never reach one: price_cents is NULL on the ~46% of rows where
// eBay published the seller's ask rather than what the buyer paid, and every
// query here already requires a price. What this is for is the remainder —
// rows that carry both a price and a best_offer flag.
//
// They are excluded because of what the number means, not because it is
// missing. An accepted best offer settled at some amount under an asking price
// nobody published, so two of them on the same card can sit far apart for
// reasons that have nothing to do with the market. In a median across hundreds
// of sales that is noise; in a chart of one card's history, or a set's top
// eight cards, it is a visible wobble that is not a price signal.
//
// THE SOLD SEARCH KEEPS THEM. There the sale is shown on its own, labelled by
// saleTypeOf() as an offer, and a reader can weigh it. It is aggregates that
// must not silently average it in.
//
// Column-gated, like every other optional column on this table: naming a
// column the schema does not have fails the whole query, which would take the
// market index down rather than merely widen it.
async function _noBestOfferSql(db) {
  if (!(await _nflHasSaleTypeColumns(db))) return '';
  // Two tests, because the column arrives in both shapes — the same spread
  // saleTypeOf() already handles on the JS side.
  //
  // The numeric one is NOT redundant with the text one. A string cast of a
  // numeric flag depends on how the value was stored: bound as a float it
  // casts to '1.0', not '1', and the first version of this let every such row
  // straight through. Comparing numerically catches the flag whether it landed
  // as INTEGER or REAL; the IN list then catches 'y'/'yes'/'true'.
  //
  // COALESCE on the comparison, not just the cast: `NULL = 1` is NULL, and
  // `NOT NULL` is NULL, so without it a row with no flag would be filtered out
  // rather than kept. An absent flag means unknown, and unknown is not an offer.
  return " AND NOT COALESCE(best_offer = 1, 0)"
       + " AND LOWER(COALESCE(CAST(best_offer AS TEXT), '')) NOT IN ('1', '1.0', 'y', 'yes', 'true')";
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

// ---- Pack listings: a chase pack is not the card on the photo ----
//
// "CHASE PACK", "Chaser Pack #12", "Mystery Pack — hit shown!": the listing
// shows a card but sells a pack that might contain it, so the price is the
// pack's, not the card's. Kept out of search, card history and the market.
//
// "Chase" is also a name — Ja'Marr Chase, Chase Brown, Chase Young — so a bare
// "chase" only counts when it is not a player's: not when the sale's own
// player is a Chase, and not when the title names one. "Mystery" alone stays:
// "Mystery Rookie" and "Mystery Autograph" are real checklist cards.
const _PACK_LISTING_RE = /\b(chasers?|chase\s+(packs?|box(es)?|breaks?|bags?)|mystery\s+(packs?|box(es)?|bags?|mailers?))\b/i;
const _CHASE_NAME_RE = /\bja['’]?\s*marr\s+chase\b|\bjamarr\s+chase\b|\bchase\s+(brown|young|claypool|daniel|edmonds|winovich|lucas|allen|mclaughlin|roullier|cota|stuart|hayden|wilson|jackson|davis|thomas|williams|smith|johnson|harrell|chandler)\b|\b(burrow|joe\s+burrow)\s*[&/+]\s*chase\b|\bchase\s*[&/+]\s*(burrow|higgins)\b/i;
function _isPackListing(title, player) {
  const t = String(title || '');
  if (_PACK_LISTING_RE.test(t)) return true;
  if (!/\bchase\b/i.test(t)) return false;
  if (/\bchase\b/i.test(String(player || ''))) return false;
  return !_CHASE_NAME_RE.test(t);
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

// D1 bills rows READ, and this query is the one that reads them.
//
// `title LIKE '%term%'` has a leading wildcard, so no index can serve it: every
// search walks the sales table. The ORDER BY sold_date DESC LIMIT n lets SQLite
// stop early once it has enough matches, which makes a common player cheap —
// and a rare term the opposite, because nothing matches and the walk runs to
// the end of the table.
//
// That is the whole cost problem, and it gets worse on its own: ~23,000 sales
// land per day, so the table this walks grows about 700k rows a month while
// traffic is meant to be growing too. Nothing here is a crisis today; the point
// is that the bill scales with the square of success unless the reads are cut.
//
// Three things below, cheapest first. None of them changes what a user sees.
const NFLDB_SEARCH_TTL = 3600;         // 1h — see the cache note in the body
// A floor on how far back a search may walk. Deliberately generous: three years
// covers essentially every comp anyone looks up, and the purpose here is to cap
// the worst case rather than to trim results. Tighten it once
// /api/debug/d1-usage shows what searches actually cost — with evidence, not a
// guess. Set to 0 to disable the bound entirely.
const NFLDB_SEARCH_WINDOW_DAYS = 1095;

// What the D1 reads actually cost, accumulated since the isolate started.
// D1 returns rows_read on every query's meta, so this is measured rather than
// modelled — and it is the number that decides whether the window above is too
// generous. Exposed at /api/debug/d1-usage.
const _d1Usage = { queries: 0, rowsRead: 0, cacheHits: 0, since: new Date().toISOString() };

// How LONG the sold search takes, as opposed to what it costs.
//
// rows_read above answers the billing question and has been answered for a
// while. It does not answer "why does this feel slow", and nothing on this
// path was timing itself, so the only available evidence was that it felt
// slow. Kept as a small sorted sample rather than a mean: a median next to a
// p95 says whether every search is slow or one in twenty is, and those have
// different causes and different fixes.
const _soldTimings = { n: 0, ms: [] };
const SOLD_TIMING_SAMPLE = 200;
function _noteSoldTiming(ms) {
  try {
    _soldTimings.n++;
    _soldTimings.ms.push(Math.round(ms));
    // Bounded: keep the most recent window, not every search since boot.
    if (_soldTimings.ms.length > SOLD_TIMING_SAMPLE) _soldTimings.ms.shift();
  } catch (_) { /* timing must never break a search */ }
}
function _soldTimingSummary() {
  const s = [..._soldTimings.ms].sort((a, b) => a - b);
  if (!s.length) return { samples: 0 };
  const at = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
  return { samples: s.length, totalSearches: _soldTimings.n,
           medianMs: at(0.5), p95Ms: at(0.95), maxMs: s[s.length - 1], minMs: s[0] };
}

// Terms that appear in a large share of card titles, and so reject almost
// nothing when tested.
//
// SQLite evaluates an AND chain left to right, and every term is a
// leading-wildcard LIKE that cannot use an index — so each one is a substring
// walk over the title. Testing "williams" before "panini" lets the chain give
// up on most rows at the first comparison instead of the fifth. Reordering an
// AND cannot change which rows match, so this is a pure cost change.
const NFLDB_COMMON_TERMS = new Set(['panini', 'topps', 'football', 'nfl', 'card', 'cards',
  'rookie', 'rc', 'prizm', 'donruss', 'optic', 'select', 'mosaic', 'chronicles',
  'score', 'contenders', 'bowman', 'chrome', 'base', 'the', 'and']);

// Rare terms first, then longer before shorter as a tiebreak. A four-digit
// year is common by construction and goes to the back with the brand words.
function _orderTermsBySelectivity(terms) {
  const rank = (t) => {
    const w = t.toLowerCase();
    if (/^(19|20)\d{2}$/.test(w)) return 2;
    if (NFLDB_COMMON_TERMS.has(w)) return 2;
    return 1;
  };
  return [...terms].sort((a, b) => rank(a) - rank(b) || b.length - a.length);
}

// ---- where the rows read actually go ----
//
// D1 reported two billion rows read in thirty days against traffic that cannot
// account for a fraction of it. There are 74 D1 call sites in this file and
// exactly two of them were counting, so the honest answer to "which one" was
// that nobody knew — and a guess would have optimised whichever query came to
// mind first.
//
// So the binding itself is wrapped, once, and every statement is counted no
// matter which of the 74 issued it. Attribution comes from a module-level
// label the scheduled jobs set around themselves: the cron runs them serially,
// so the label is unambiguous for exactly the work that runs unattended and
// therefore has nobody watching its bill.
//
// The honest limitation: D1's .first() returns the row and discards the meta
// that carries rows_read, so those queries are counted but their rows are not.
// The expensive jobs all use .all(), which does carry it.
let _d1Source = 'request';
const _d1By = Object.create(null);

function _d1Tally(res) {
  const src = _d1Source;
  const e = _d1By[src] || (_d1By[src] = { queries: 0, rowsRead: 0, unmeasured: 0 });
  e.queries++;
  const read = res && res.meta && Number(res.meta.rows_read);
  if (Number.isFinite(read)) e.rowsRead += read; else e.unmeasured++;
  return res;
}

// Runs fn with every D1 query inside it attributed to `name`. Restores the
// previous label in a finally, so a throwing job cannot leave the label stuck
// and mis-attribute everything that follows it.
async function _asD1Source(name, fn) {
  const prev = _d1Source;
  _d1Source = name;
  try { return await fn(); } finally { _d1Source = prev; }
}

function _countingStmt(stmt) {
  return {
    bind: (...a) => _countingStmt(stmt.bind(...a)),
    all: async (...a) => _d1Tally(await stmt.all(...a)),
    run: async (...a) => _d1Tally(await stmt.run(...a)),
    // .first() gives back the row itself — there is no meta to read, so this
    // counts the query and records that its rows could not be measured.
    first: async (...a) => { const r = await stmt.first(...a); _d1Tally(null); return r; },
    raw: async (...a) => stmt.raw(...a),
  };
}

function getNflDb() {
  const db = _rawNflDb();
  if (!db || db.__counted) return db;
  return {
    __counted: true,
    prepare: (sql) => _countingStmt(db.prepare(sql)),
    // Pass-throughs. batch() and exec() are used by the importer paths and are
    // deliberately not wrapped rather than half-wrapped.
    batch: (...a) => db.batch(...a),
    exec: (...a) => db.exec(...a),
    dump: (...a) => db.dump && db.dump(...a),
    withSession: (...a) => db.withSession && db.withSession(...a),
  };
}

// Turn a free-text card query into a LIKE-matched D1 lookup. Every term must
// appear somewhere in the title, which mirrors how the other providers behave
// and keeps the existing downstream filters meaningful.
async function fetchViaNflCardDb(keywords, limit = 50, source = 'unknown') {
  const db = getNflDb();
  if (!db) return { results: [], total: 0, unavailable: true, reason: 'no-d1-binding' };

  // Serial stamps are handled by the callers' print-run logic, not by matching
  // "/5" as a title substring.
  const cleaned = String(keywords).replace(/\/\d{1,4}(?![0-9])/g, ' ').replace(/\s+/g, ' ').trim();
  const terms = cleaned.split(/\s+/).filter(t => t.length > 1).slice(0, 8);
  if (terms.length === 0) return { results: [], total: 0 };

  // Cache on our own data, which is a different question from caching the paid
  // providers. fetchEbayItems deliberately does not cache those, because their
  // listings move minute to minute. These rows only change when the importer
  // runs, so an hour-old answer is the same answer.
  //
  // Empty results are cached too, and that is the case worth having: a search
  // matching nothing is exactly the search that walks the whole table, and
  // repeating it is pure waste. The cost is that a card added by the importer
  // stays invisible for up to an hour after it lands.
  const cacheKey = `nfldb:v1:${Math.min(limit, 500)}:${cleaned.toLowerCase()}`;
  // Callers asking the same question at once (the grading advisor's four
  // grades read one pool) share one query rather than racing four to D1.
  const inflight = _nflDbInflight.get(cacheKey);
  if (inflight) return inflight;
  const run = _fetchViaNflCardDbUncached(db, cleaned, terms, limit, source, cacheKey);
  _nflDbInflight.set(cacheKey, run);
  try { return await run; } finally { _nflDbInflight.delete(cacheKey); }
}
const _nflDbInflight = new Map();

async function _fetchViaNflCardDbUncached(db, cleaned, terms, limit, source, cacheKey) {
  const cached = await cacheGet(cacheKey);
  if (cached) {
    _d1Usage.cacheHits++;
    return cached;
  }

  // Ordered so the AND chain rejects a row on its rarest term first. The set
  // of matching rows is identical either way; only the work to find them changes.
  const ordered = _orderTermsBySelectivity(terms);
  const where = [
    'price_cents IS NOT NULL', // exclude best-offer rows — see note above
    'confidence >= ?',
    ...ordered.map(() => 'title LIKE ?'),
  ].join(' AND ');
  const binds = [NFLDB_MIN_CONFIDENCE, ...ordered.map(t => `%${t}%`)];

  // The floor on how far back the walk may go. This only pays off if sold_date
  // is indexed — without an index SQLite scans regardless and this just filters
  // — but it costs nothing either way, and with one it turns "walk every row we
  // have ever stored" into "walk three years".
  let windowClause = '';
  if (NFLDB_SEARCH_WINDOW_DAYS > 0) {
    const floor = new Date(Date.now() - NFLDB_SEARCH_WINDOW_DAYS * 86400000)
      .toISOString().slice(0, 10);
    windowClause = ' AND sold_date >= ?';
    binds.push(floor);
  }

  try {
    // `player` isn't displayed — it's how we know up front whether this row can
    // resolve to a card identity, so the UI can advertise the history rather
    // than making people click to discover it isn't there.
    const cols = 'item_id, sold_date, title, price_cents, currency, listing_format, grader, grade, player'
      + (await _nflHasSaleTypeColumns(db) ? ', best_offer, bids' : '')
      + (await _nflHasImageColumn(db) ? ', image_url' : '');
    const stmt = db.prepare(
      `SELECT ${cols}
       FROM sales WHERE ${where}${windowClause}
       ORDER BY sold_date DESC LIMIT ?`
    ).bind(...binds, Math.min(limit, 500));
    const t0 = Date.now();
    const out = await stmt.all();
    const elapsed = Date.now() - t0;
    _noteSoldTiming(elapsed);
    const rows = (out && Array.isArray(out.results)) ? out.results : [];

    // rows_read is what D1 charges for, and it is nothing like rows returned:
    // a search returning 3 sales can read millions on the way to finding them.
    // Logging both is what makes the difference visible.
    const read = (out && out.meta && Number(out.meta.rows_read)) || 0;
    _d1Usage.queries++;
    _d1Usage.rowsRead += read;
    console.log(`[NflCardDB] "${cleaned}" -> ${rows.length} sales, `
      + `${read.toLocaleString('en-US')} rows read, ${elapsed}ms (${source})`);

    const cards = rows.filter(r => !_isPackListing(r.title, r.player));
    const payload = { results: cards.map(mapNflDbSale), total: cards.length };
    cachePut(cacheKey, payload, NFLDB_SEARCH_TTL);
    return payload;
  } catch (err) {
    // A query failure must never take sold search down — fall through to the
    // paid providers instead.
    console.error('[NflCardDB] query failed:', err && err.message);
    return { results: [], total: 0, unavailable: true, reason: `query-failed: ${err && err.message}` };
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
    return (rec && Array.isArray(rec.sales)) ? rec.sales.filter(x => !_isPackListing(x && x.title)) : [];
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
function sendSoldUnavailable(res, reason) {
  // HTTP 200 (not an error status) so the frontend's graceful "sold unavailable"
  // handlers run — they read the body after an `if (!res.ok) throw` guard, the
  // same way the old rateLimited path was delivered.
  //
  // `reason` carries WHICH of the causes fired, separately from the sentence
  // shown to users. Three different faults reach this one message — the D1
  // binding missing, a query throwing, and the table being empty — and each has
  // a different fix. Collapsing them cost real time when the site reported
  // "sold unavailable" during a D1 incident and there was no way to tell from
  // the outside whether the two were related. It is not rendered; it is there
  // so a single curl can answer the question.
  return res.json({
    results: [], total: 0, soldUnavailable: true,
    error: SOLD_UNAVAILABLE_MSG,
    reason: reason || 'unspecified',
  });
}

// Every sold-backed feature shares two provider states: no usable key, and the
// daily row budget being spent. Responds and returns true when one applies, so
// callers can guard with a single `if (sendIfSoldBlocked(res, data)) return;`.
function sendIfSoldBlocked(res, ...responses) {
  const blocked = responses.find(r => r && (r.soldUnavailable || r.rateLimited));
  if (!blocked) return false;
  // Pass the specific cause through rather than discarding it here — this
  // helper is the only thing standing between the caller's diagnosis and the
  // user, and it used to drop it.
  if (blocked.soldUnavailable) { sendSoldUnavailable(res, blocked.reason || blocked.error); return true; }
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
// Grade filters ({ graded: false } or { grader, grade }) applied to our own
// sales, by the same bucket the card history uses. "Raw" is only a sale with
// no grade and nothing slab-like in its title; "PSA 10" is PSA and 10 exactly,
// so a BGS 10 or a PSA 9 never lands there.
const GRADE_POOL_LIMIT = 300;
function _hasGradeOpts(opts) {
  return !!opts && (opts.graded === false || !!(opts.grader && opts.grade != null));
}
function _matchesGradeOpts(item, opts) {
  const bucket = String(_gradeBucket(item) || '').toUpperCase();
  if (opts.graded === false) return bucket === 'RAW';
  const want = `${opts.grader} ${String(opts.grade).replace(/\.0$/, '')}`.toUpperCase();
  return bucket === want;
}

async function fetchEbayItems(keywords, limit = 20, mode = 'forsale', source = 'search', offset = 0, opts = {}) {
  if (mode === 'sold') {
    // Our own D1 dataset first — no key, no quota, no lookback window, no
    // network hop. Anything it answers costs nothing, so the paid providers
    // only ever see what it misses. Football-only, and absent until the D1
    // binding exists, so a miss here is the normal case rather than an error.
    if (SOLD_PROVIDER !== 'cardapi') {
      // Our rows carry the grade as data, not as a query filter, so a grade
      // request reads a wider pool and keeps the sales in that grade — the
      // same pool for every grade, which is why they must be split here.
      const gradeAsk = _hasGradeOpts(opts);
      const own = await fetchViaNflCardDb(keywords, gradeAsk ? Math.max(limit, GRADE_POOL_LIMIT) : limit, source);
      let ownResults = Array.isArray(own.results) ? filterJunkListings(own.results) : [];
      if (gradeAsk) ownResults = ownResults.filter(r => _matchesGradeOpts(r, opts)).slice(0, limit);
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
          return { results: [], total: 0, soldUnavailable: true, reason: own.reason || 'd1-unavailable',
                   error: 'The football sold-price database is not connected yet.' };
        }
        // The query worked but matched nothing. That reads identically whether
        // the card genuinely has no sales or the import never ran, so check
        // whether the table holds anything at all and say which it is.
        const empty = await _nflDbIsEmpty();
        if (empty) {
          return {
            results: [], total: 0, soldUnavailable: true, reason: 'sales-table-empty',
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

      // Which of these are actually the card that was asked for. Tags the rows
      // in place; null when the query names no card specific enough to split on.
      const cardIdentity = await tagSameCard(variantFiltered, query);

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
        cardIdentity,
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

// ---- Is this listing the same CARD the query asked for? -------------------
//
// THE GAP THIS CLOSES, which took four rounds of the wrong fix to find.
//
// A search for "2025 Prizm Mahomes Silver" came back with a Panini ASCC Asia
// Convention card in the list, and every explanation offered was about grade
// reading or caching. None of it was the problem. The search screen never asked
// which CARD a listing was. It matched keywords, grouped by grade, and drew the
// results — so anything eBay returned for the words in the query appeared,
// forever, no matter how good the identity engine got.
//
// The identity engine has been in /api/card-analysis all along, deciding which
// sales belong to one card. It simply was not wired to the screen people
// actually look at. This wires it.
//
// WHERE THE ERRORS GO, which is the whole design. On the card page an
// unreadable parallel is DROPPED, because a wrong sale corrupts a published
// median. Here nothing is dropped: an unreadable anything stays with the card,
// and only a positive, confident disagreement moves a listing to the second
// section. A search that hides a real comp teaches the user nothing and tells
// me nothing; one that shows a wrong comp in a labelled pile is visible, and
// visible is fixable.
// Words that ARE in the parallel vocabulary and are also in most card listings
// regardless of which card it is.
//
// The catalogue is enormous, so somewhere in 361 checklists there is a parallel
// called "Football" and one called "Rookie". Both are in half of eBay. Matching
// them would declare an ordinary listing a different card on the strength of a
// word that says nothing — a test caught exactly that on "Patrick Mahomes
// football card nice condition look", which names no parallel at all.
//
// This list guards the FALLBACK reader only. resolveParallel reads the segment
// after the card number and needs no such help; this scans loose words and is
// the weaker of the two, so it is the one that needs a floor. When a generic
// word starts splitting real searches, it belongs here.
const _PARALLEL_STOPWORDS = new Set([
  'rookie', 'rc', 'base', 'sp', 'ssp', 'lot', 'card', 'cards',
  'football', 'nfl', 'sport', 'sports', 'trading', 'player',
  'mint', 'condition', 'new', 'vintage', 'pack', 'box', 'case', 'hit',
]);

// The parallel, read out of text that has no card number in it.
//
// resolveParallel works on the segment AFTER the card number, which is right
// for a listing title and useless for a search box: "2025 Prizm Mahomes Silver"
// has no number, so it returns 'no-number' and reads nothing. Many eBay titles
// have no number either.
//
// So this falls back to the vocabulary: scan the text for the longest phrase
// the checklists know as a parallel. Two traps, both real:
//
//   'prizm' classifies as a parallel on its own, and it is also the PRODUCT in
//   the same query — so a window made only of set-name words is skipped, and
//   "silver" wins over "prizm" in "2025 Prizm Mahomes Silver".
//
//   longest wins, so "silver prizm" beats "silver" when both are present, and
//   _parallelKey strips the product word off either end so the two agree.
//
// Rightmost match at each length, because a parallel is named after the player
// far more often than before them.
function _parallelFromWords(text, pi) {
  if (!pi) return null;
  const raw = String(text || '').toLowerCase();
  const toks = raw.replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean);
  if (!toks.length) return null;
  const setsHere = CARD_SET_NAMES.filter(s => raw.includes(s));
  const isProductWord = (w) => setsHere.some(s => s.split(' ').includes(w));
  const skippable = (w) => isProductWord(w) || _PARALLEL_STOPWORDS.has(w) || /^\d+$/.test(w);

  const max = Math.min(pi.stats.longestName || 4, 6, toks.length);
  for (let n = max; n >= 1; n--) {
    for (let i = toks.length - n; i >= 0; i--) {
      const win = toks.slice(i, i + n);
      if (win.every(skippable)) continue;
      const cls = pi.classify(win.join(' '));
      if (cls !== 'parallel' && cls !== 'both') continue;
      const k = _parallelKey(win.join(' '));
      if (k) return k;
    }
  }
  return null;
}

// `itemId` and `overrides` are optional: the SEED is a query string and has no
// sale behind it, while every candidate is a row that does. Passing them for
// the candidates is what lets a corrected sale be matched to the card a person
// said it belongs to, rather than to the one its title claims.
function _identityOf(text, pi, player, _pAliasCache, itemId, overrides) {
  const clean = _stripGrade(String(text || ''));
  const ov = _overrideParallel(itemId, overrides);
  if (ov !== undefined) {
    return { parallel: ov ? _parallelKey(ov) : '',
             kind: _cardKind(clean), printRun: _printRun(clean) };
  }
  // null means "could not read", and is treated as agreement below. It must
  // never collapse into '' — that is the BASE card, a real and specific answer.
  let parallel = null;
  if (pi) {
    const hit = resolveParallelAliased(pi, clean, player ? { player } : {}, _pAliasCache);
    if (hit && hit.parallel) parallel = _parallelKey(hit.parallel);
    else if (hit && hit.how === 'base') parallel = '';
    else parallel = _parallelFromWords(clean, pi);
  }
  return { parallel, kind: _cardKind(clean), printRun: _printRun(clean) };
}

// Do we hold a checklist for the product this query names?
//
// This decides how strict the match below is allowed to be, so it is worth
// getting right rather than guessing. Cached because buildJoinIndex walks every
// product and this runs on the search path.
let _setIndexCache = null;
async function _cataloguedIndex() {
  if (_setIndexCache === null) {
    try {
      const idx = await _loadJson('checklists/index.json');
      // With aliases, or a product reachable only through one counts as
      // uncatalogued and its searches stay loose — the opposite of what the
      // alias was added to achieve.
      _setIndexCache = buildJoinIndex((idx && idx.products) || [],
                                      undefined, await setAliases()).index;
    } catch (err) {
      console.error('[same-card] checklist index unavailable:', err && err.message);
      _setIndexCache = false;
    }
  }
  return _setIndexCache || null;
}

async function _isCatalogued(query, year) {
  if (!year) return false;
  const index = await _cataloguedIndex();
  if (!index) return false;

  // Ask the CATALOGUE, not a hardcoded list of brand words.
  //
  // The first version of this matched the query against CARD_SET_NAMES, which
  // holds optic, prizm, donruss, select, absolute, contenders and so on — and
  // no topps, no chrome, no bowman. That list grew up alongside a catalogue
  // that is 330 Panini products to 25 Topps, so strict matching could never
  // fire for a Topps search no matter how complete its checklist was. The bias
  // in the data had quietly become a bias in the code.
  //
  // So every word window in the query is offered to the join instead, longest
  // first. The catalogue itself decides what a product name is, which means a
  // product added tomorrow works today, and an alias counts.
  const words = String(query).toLowerCase()
    .replace(/\b(?:19|20)\d{2}(?:-\d{2})?\b/g, ' ')   // the year is passed separately
    .replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean);
  for (let n = Math.min(5, words.length); n >= 1; n--) {
    for (let i = 0; i + n <= words.length; i++) {
      if (matchSale(index, year, words.slice(i, i + n).join(' '))) return true;
    }
  }
  return false;
}

// STRICT means: we hold the checklist for this product, so a listing has to
// PROVE it is this card to stay with it.
//
// This is the opposite of how the card page works, and it is deliberate. There,
// an unreadable sale is kept because dropping it costs sample. Here the ask is
// accuracy on the products we actually have an answer key for — so where we
// have one, "I could not read this" is not good enough, and the listing goes to
// the second section where it is still one click away.
//
// Outside the catalogue nothing changes. There is no answer key to be accurate
// against, so an unreadable listing stays with the card as before. Being strict
// there would just hide listings on the strength of nothing.
function _sameCard(seed, cand, strict) {
  // Kind is the one signal where absence is evidence: a seller does not leave
  // "auto" or "patch" off a title, because it is most of what the card is
  // worth. See card-kind.js — it is 65.5% of all ambiguous keys.
  if (seed.kind !== cand.kind) return false;
  // A /5 and a /10 are different cards. Only compared when BOTH are stated,
  // because an unstated print run is a silence, not a zero.
  if (seed.printRun != null && cand.printRun != null && seed.printRun !== cand.printRun) return false;
  // The search named no parallel, so every parallel is wanted. Splitting here
  // would break a deliberately broad search into pieces nobody asked for.
  if (seed.parallel == null) return true;
  if (cand.parallel == null) return !strict;
  return seed.parallel === cand.parallel;
}

// Tags each result with sameCard, and returns what the query was read as so the
// page can name the section. Returns null when the query is too vague to
// resolve a card at all, and the page then renders exactly as it did before —
// a search for "Mahomes" should not be split into anything.
async function tagSameCard(results, query) {
  if (!Array.isArray(results) || results.length === 0) return null;
  let pi = null;
  try { pi = await parallelIndex(); } catch (_) { pi = null; }
  const { player, year } = extractSearchKeywords(query);
  // The human decisions, fetched once for the whole result set.
  const pAliases = await parallelAliases().catch(() => ({}));
  const sOverrides = await saleOverrides().catch(() => ({}));
  const seed = _identityOf(query, pi, player, pAliases);
  const strict = await _isCatalogued(query, year);

  // Too vague to split on. With no parallel read AND no kind AND no print run,
  // every comparison below returns true and the second section would be empty
  // anyway — but saying so explicitly keeps the page from drawing an empty
  // "other cards" heading on a one-word search.
  if (seed.parallel === null && !seed.kind && seed.printRun == null) return null;

  // Counted apart because they mean different things to whoever reads this.
  // "A different card" is the engine working. "Could not tell" is the honest
  // size of what a checklist cannot settle, and it is the number worth watching
  // — if it climbs, the catalogue is missing something.
  let differing = 0, unconfirmed = 0;
  for (const r of results) {
    const cand = _identityOf(r.title, pi, player, pAliases, r.itemId || r.item_id, sOverrides);
    const same = _sameCard(seed, cand, strict);
    r.sameCard = same;
    if (!same) {
      differing++;
      if (cand.parallel == null && seed.kind === cand.kind) unconfirmed++;
    }
  }
  if (differing === 0) return null;

  return {
    parallel: seed.parallel === '' ? 'Base' : seed.parallel,
    kind: seed.kind || 'base',
    printRun: seed.printRun,
    // Whether we hold a checklist for this product, and therefore whether a
    // listing had to prove itself rather than merely not contradict.
    catalogued: strict,
    differing,
    unconfirmed,
  };
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
      // Which of these are actually the card that was asked for.
      //
      // This endpoint is the SECOND sold-search path and it is the one the
      // reported screen was using. Tagging /api/search alone fixed nothing a
      // user could see, twice, because this one renders through the same
      // grade-group view and arrived untagged. Any new sold path has to call
      // this too — search-identity.test asserts that every one of them does.
      const cardIdentity = await tagSameCard(variantFiltered, query);
      const approx = variantFiltered.length > 0 ? computeApproxValue(variantFiltered, query) : null;
      // No sale of the exact card? Estimate from the same player's similar
      // sales, adjusted for print run and set (see /api/search).
      const estimate = hasExactCardSales(query, searchData.results)
        ? null
        : buildSimilarCardEstimate(query, searchData.results);
      return res.json({
        results: variantFiltered, total: variantFiltered.length, mock: false,
        searchType: 'exact', broadenedQuery: null, approximateValue: approx,
        estimate, mode, serial: serial || null, similarResults: [], cardIdentity,
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
// ---------------------------------------------------------------------------
// Photo fingerprints.
//
// The titles have gone as far as they go: 4.4% of cards that carry a parallel
// still read as base, and what remains is increasingly cards absent from the
// checklists entirely. Photos carry the signal directly — a Gold Prizm is gold
// whatever the seller typed — and every sale has one.
//
// Two tables. photo_sig is one row per image URL, so an image is fetched once
// ever and a failure is remembered rather than retried forever. photo_ref is
// the reference: the average fingerprint of each (year, set, parallel) built
// from sales that already know their parallel.
const PHOTO_SIG_TABLE = 'photo_sig';
const PHOTO_REF_TABLE = 'photo_ref';
// A reference built from fewer photos than this is not a reference. The
// coverage probe found 5,921 parallels with a single photo, and matching
// against one example is guessing with extra steps.
const PHOTO_MIN_SAMPLES = 5;

let _photoTablesReady = null;
async function _photoEnsure(db) {
  if (_photoTablesReady !== null) return _photoTablesReady;
  try {
    await db.prepare(
      `CREATE TABLE IF NOT EXISTS ${PHOTO_SIG_TABLE} (
         url        TEXT PRIMARY KEY,
         sig        TEXT,
         ok         INTEGER NOT NULL DEFAULT 0,
         why        TEXT,
         updated_at TEXT
       )`).run();
    await db.prepare(
      `CREATE TABLE IF NOT EXISTS ${PHOTO_REF_TABLE} (
         card_key   TEXT PRIMARY KEY,
         parallel   TEXT NOT NULL,
         product    TEXT NOT NULL,
         centroid   TEXT NOT NULL,
         samples    INTEGER NOT NULL,
         updated_at TEXT
       )`).run();
    _photoTablesReady = true;
  } catch (err) {
    console.error('[photo] tables unavailable:', err && err.message);
    _photoTablesReady = false;
  }
  return _photoTablesReady;
}

const ALIAS_TABLE = 'player_alias';
// Variants resolved per cron run. Sized against D1's free-tier write budget,
// not against how fast the table could fill: the cron runs this hourly, so this
// number times 24 is the rows/day it costs, and cron-wiring.test.js fails the
// build if that product leaves the Worker more than a quarter of the 100,000/day
// allowance. The sales ingestion writes to the same database and needs the rest.
//
// It was 1200 on every 15-minute tick — 115,200 rows/day — which exceeded the
// whole daily allowance on its own and is what took the account over.
const ALIAS_BACKFILL_BATCH = 1000;
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
async function backfillPlayerAliases(opts) {
  return _asD1Source('alias-backfill', () => _backfillPlayerAliases(opts || {}));
}

// Caught up, and how long to take that for granted.
//
// The backfill reads 1.06 million rows per run — more than twice the table —
// because _normCol() wraps the player column so idx_sales_player cannot be
// used, and the NOT EXISTS runs as a correlated lookup for every row. Then it
// groups and sorts. That is the price of ASKING, and it is paid in full even
// when the answer is "nothing new", which is the answer almost every hour once
// the table has filled.
//
// Measured: 20,219,058 rows in 19 runs in one day, against 73,416 for the
// photo archive in 72 runs. It was not close.
//
// So when a run comes back with nothing left to do, the next 23 hours skip the
// query entirely. New sales arrive daily and bring new spellings with them, so
// a daily pass keeps up; the marker expires on its own, which means a quiet
// period cannot wedge it off permanently.
const ALIAS_CAUGHTUP_KEY = 'alias:caughtup:v1';
const ALIAS_CAUGHTUP_TTL = 60 * 60 * 23;

async function _backfillPlayerAliases({ limit = ALIAS_BACKFILL_BATCH, resolve = null } = {}) {
  const db = getNflDb();
  if (!db) return { ok: false, reason: 'no dataset' };
  if (!await _aliasEnsure(db)) return { ok: false, reason: 'table unavailable' };

  // Before the expensive part, and deliberately not after it: the whole point
  // is to avoid the scan, so a check that runs afterwards would save nothing.
  // A caller passing its own resolver is a test, and tests are never skipped.
  if (!resolve) {
    try {
      if (await cacheGet(ALIAS_CAUGHTUP_KEY)) {
        return { ok: true, skipped: 'caught up within the last day' };
      }
    } catch (_) { /* unreadable marker: do the work rather than skip wrongly */ }
  }

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
  if (!list.length) {
    // Nothing left. Record it so the next 23 hours cost one KV read instead of
    // another million rows.
    if (!resolve) {
      try { await cachePut(ALIAS_CAUGHTUP_KEY, { at: new Date().toISOString() }, ALIAS_CAUGHTUP_TTL); }
      catch (_) { /* worst case it runs again next hour, as it does today */ }
    }
    return { ok: true, done: true, inserted: 0 };
  }
  // Injected by the caller, because the dictionary is not in the Worker bundle.
  // Tests pass the real resolver so the whole path is still exercised; the cron
  // has none to give and says so rather than writing rows it cannot fill.
  const ci = resolve ? null : await cardIndex();
  const resolveOne = resolve || (ci && ci.resolvePlayer);
  if (!resolveOne) return { ok: false, reason: 'dictionary not in this build' };

  const now = new Date().toISOString();
  const stmts = [];
  let resolved = 0;
  for (const r of list) {
    const hit = resolveOne(r.v);
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

  // A short batch means the table is drained, and there is no need to spend
  // another scan proving it.
  //
  // The query asks for `limit` rows and got fewer, so it returned every
  // unaliased variant there was — and all of them now have a row, including the
  // ones that did not resolve (those are written mapped to themselves, which is
  // what stops them being re-read forever). The next run's query would
  // therefore match nothing. That is a certainty derived from the batch we just
  // wrote, not a guess, so take the marker now.
  //
  // Without this the daily shape is two expensive runs, not one: the first
  // finds the day's new spellings and writes them, and only the second gets an
  // empty result and sets the marker. A full batch is the other case — there
  // may be more behind it, so leave the marker unset and let the next hour
  // continue draining.
  //
  // Reaching here means every statement was written — a partial write returns
  // above — so the only question left is whether the query was capped.
  if (!resolve && list.length < limit) {
    try { await cachePut(ALIAS_CAUGHTUP_KEY, { at: now, drained: written }, ALIAS_CAUGHTUP_TTL); }
    catch (_) { /* worst case the next run scans, as it did before */ }
  }
  return { ok: true, inserted: written, resolved };
}

// Is the table filled enough to group on? Cached, because every index build
// would otherwise pay for the check.
async function _aliasReady(db) {
  // The threshold is part of the key. A cached decision must not outlive the
  // rule that produced it: changing the gate from 95% to 25% otherwise left a
  // stale "not ready" being served for five minutes after the deploy, which
  // reads exactly like the change not having shipped.
  const readyKey = `aliasready:v3:${ALIAS_MIN_COVERAGE}`;
  const cached = await cacheGet(readyKey);
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
  cachePut(readyKey, { ready, rows, covered, total }, ALIAS_READY_TTL);
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
      generatedAt: new Date().toISOString(),
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
// No parallel: the index holds base cards only (see RSI_BASE_CARD), where the
// column is blank, "Base" or "Rated Rookie" for the same card. The card
// NUMBER is what tells one base card from another — without it a player's
// base rookie and every insert of theirs in the product were one "card".
const RSI_KEY_COLS = ['year', 'set_name', 'player', 'card_number', 'grader', 'grade'];
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
// 'bvg' (Beckett Vintage Grading) added alongside grade-core's copy: the
// raw-filter diagnostic found 102 sales carrying it in the grader column, and
// it is as safe a substring as the rest — it occurs inside no ordinary word.
const RSI_GRADER_WORDS = ['psa', 'bgs', 'bvg', 'bccg', 'beckett', 'sgc', 'cgc', 'csg',
                          'hga', 'ksa', 'gma', 'rcg', 'mnt'];
const RSI_SLAB_WORDS = ['slab', 'encapsulated', 'cert'];
// The label's own grade wording with the grader's name left off (see
// grade-core.js LABEL_GRADE_RE). Substrings, and without the JS reader's
// "candidate"/"could be" exemption: here a dropped raw sale costs sample and an
// admitted slab costs the raw series, so the filter errs toward dropping.
// Grouped in their own bracket so they add one level to the OR chain, not seven.
const RSI_LABEL_WORDS = ['gem mt', 'mint 9', 'nm-mt', 'pristine 1', 'black label'];

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

// Titles that do not describe ONE identifiable card.
//
// The raw-filter diagnostic surfaced the reason to care: the single commonest
// title reaching the index was "SEE SCAN For The Exact Card Up For Auction!
// NFL READ FREE SHIPPING AutographDen", 247 sales, with the player parsed as
// "See". That is one seller's template, relisted, and it entered the basket as
// a player named See who traded 247 times. A price index is a comparison
// between sales of the same card; a title that names no card cannot be one
// side of that comparison, whatever price it carries.
//
// This is NOT the grade filter's job and is kept separate from it on purpose:
// these sales are not graded copies hiding in the raw pool, they are non-cards.
//
// Substrings, for the same cost reason as the grader list, so every phrase
// here has to be one that does not occur inside an ordinary card title. The
// tempting additions that are NOT here: "read" (appears in "Bread"), "digital"
// (Topps Digital is a real product line), and "1/1" or "plate" — a printing
// plate is a real card, filed by the checklists under the set whose number it
// shares, and excluding plates would drop genuine sales.
// KEPT SHORT ON PURPOSE. Every entry is another LIKE in a predicate that runs
// over every priced sale in the window, and this endpoint has a 2,000ms Worker
// budget that market-index.test enforces. A first pass at this list had 24
// entries and took /api/market-index?days=90 to 2,325ms — correct, and over
// the line. The test caught it, which is what it is for.
//
// So: substring matching means several of those entries were redundant
// anyway ('see scans' is already matched by 'see scan', 'mystery pack' by
// 'mystery'), and the rest are ordered by what the data showed. "see scan"
// alone was the single commonest title reaching the index at 247 sales.
// Adding more is a measurement, not a guess — junkByPattern on
// /api/debug/raw-filter reports what each one catches, and anything with a
// real count earns its place in the budget.
const RSI_JUNK_WORDS = [
  'see scan',      // the reported case, and the biggest single title
  'you pick', 'pick your', 'choose your',
  'case break', 'break spot',
  'lot of', 'repack', 'mystery',
  // A pack sold on a card's photo, not the card. Only "chaser": "chase pack" as
  // a substring also reads "Ja'Marr Chase pack fresh", a real card.
  'chaser',
  'reprint', 'custom made', 'aceo',   // fan art and reproductions, not cards
];

function _rsiJunkSql(T) {
  return RSI_JUNK_WORDS.map(w => `${T} LIKE '%${w}%'`).join(' OR ');
}

function _rsiRawOnlySql(titleCol = 'title') {
  // No LOWER(). SQLite's LIKE is already case-insensitive for ASCII, and every
  // token here is ASCII, so wrapping the title changed no answer — it just
  // lowercased the same title once per token, some twenty times a row. On a
  // live-sized sample (3.1M sales) dropping it took 2.5s off each pass of the
  // index query with byte-identical output. The grade-gap and best-offer
  // tests include upper-case slab titles, so a case-sensitive LIKE would fail
  // them rather than let slabs in quietly.
  const T = `COALESCE(${titleCol}, '')`;
  const any = (words) => words.map(w => `${T} LIKE '%${w}%'`).join(' OR ');
  return `
          AND ${_rsiUngradedCol('grade')}
          AND ${_rsiUngradedCol('grader')}
          AND NOT ( ${any(RSI_GRADER_WORDS)}
                 OR ${any(RSI_SLAB_WORDS)}
                 OR ( ${any(RSI_LABEL_WORDS)} )
                 -- "graded" minus the two words that contain it. Cheaper than
                 -- padding the title, and "ungraded" is a raw claim, not a slab.
                 OR ( ${T} LIKE '%graded%'
                      AND ${T} NOT LIKE '%ungraded%'
                      AND ${T} NOT LIKE '%upgraded%' ) )
`;
}

// Applied to the BASKET, not to the whole-window aggregate.
//
// Where junk actually shows is the card list: "SEE SCAN For The Exact Card Up
// For Auction!" entered the basket as a player named See who traded 247 times,
// which a reader sees. In the index SCORE those same sales are a rounding
// error inside a median of medians over hundreds of thousands.
//
// And the aggregate cannot afford them. /api/market-index?days=90 measures
// 1,857-1,934ms against the 2,000ms ceiling market-index.test enforces —
// BEFORE any of this — so the predicate that runs over every priced sale in
// the window has no room to spend on a cosmetic fix. The basket query runs
// over far less and can carry it.
const RSI_JUNK_ONLY = `
          AND NOT ( ${_rsiJunkSql("COALESCE(title, '')")} )`;
const RSI_RAW_ONLY = _rsiRawOnlySql();

// A sale can only be compared against another sale of the SAME card, and a card
// is not identified by its player alone. A blank parallel does not mean "base"
// — it means the collector could not read one — and because the parallel is
// part of the card key, every unreadable sale for a player collapses into a
// single bucket holding base cards, refractors, autos and patches together.
//
// That bucket then prices a $5 base against a $500 patch and calls the
// difference a price move. It is where "2025 Topps Chrome Jaxson Dart" with no
// parallel and a +7,127% move came from, and it is also why the same card
// appeared twice in the basket at $59 and $233.
//
// So a sale used to need a year, a set and a filled parallel column to be
// indexed at all (RSI_IDENTIFIED, now retired). It kept that bucket out, and it
// kept every base card out with it — see RSI_BASE_CARD below for the rule that
// replaced it, which admits the base card and nothing mixed in with it.

// The market index tracks BASE cards only: the plain base rookie, the Rated
// Rookie — never a parallel.
//
// It used to require the parallel column to be FILLED, for the reason above.
// But base cards are exactly the ones whose column is blank, so the basket was
// built entirely from parallels: the live "what's driving it" list read
// Refractor, Refractor, XFractor, Cosmic, Blue Hyper, with moves of -93.7% and
// +1500% (the cap). A parallel is the hardest thing in a title to read, and
// with no card number in the key, "Jaxson Dart Refractor" also pooled every
// Refractor he has in the product — the base card's with the inserts'.
//
// So the rule is inverted, and made safe the way the +7,127% bucket was not:
//   - the parallel column is blank or says base in so many words;
//   - the TITLE names no parallel either: no colour, finish or "refractor",
//     as whole words, after the player's and product's own names are removed
//     ("Jerry Rice" is not Ice, "Mosaic" the product is not the parallel);
//   - no print run ("/99", "1/1") — base cards are not numbered;
//   - not an autograph, relic or redemption (card-kind.js, in SQL);
//   - a card number, which is now part of the card key, so one card is one card.
// Anything uncertain is left out. That costs sample and cannot mix two cards.
const RSI_BASE_PARALLELS = ['', 'base', 'base set', 'base rookie', 'base rookies',
                            'rookie', 'rookies', 'rc', 'rated rookie', 'rated rookies'];
// Two-word finishes the whole-word test would miss. Hyphens become spaces
// when the title is cleaned, so "X-Fractor" arrives as two words — listed only
// as "xfractors" it slipped through, and Jaxson Dart's 2025 Topps Chrome #306
// X-Fractors (~$20-25 raw) were priced as his $2 base card: +1,226% on the list.
const RSI_BASE_SIGNAL_PHRASES = ['tie dye', 'press proof', 'green bay',
  'x fractor', 'x fractors', 'mini diamond', 'fast break', 'short print', 'case hit', 'die cut',
  // Inserts, named. They carry their own numbers, but where one matches a
  // base card's number the two would share a key; no base title says these.
  'color blast', 'my house', 'light it up', 'night moves', 'sunday best',
  'premier level', 'club level', 'field level'];
// Single words the shared parallel list lacks, found by running every
// parallel name the collector has seen (NflCardDB's cards.json, 303 names)
// through this filter. Packaging words ("retail", "blaster", "mega", "hobby")
// and loose ones ("stars", "fire", "mini") are left out on purpose: genuine
// base listings use them.
const RSI_BASE_SIGNAL_EXTRA = ['xfractor', 'pigskin', 'lava', 'sepia', 'negative', 'checkerboard',
  'tiger', 'atomic', 'kaleidoscope', 'vinyl', 'photon', 'glitch', 'genesis', 'choice', 'ssp', 'rwb',
  'downtown', 'uptown', 'kaboom', 'concourse', 'pandora', 'manga',
  // Sellers pluralise the set name: "Donruss Optic - Uptowns Jaxson Dart #11".
  'downtowns', 'uptowns',
  // A jumbo / oversized copy is a different card from the standard size.
  'jumbo', 'oversized', 'oversize'];
// Split in two for cost. The column tests are cheap and run in a WHERE. The
// title test needs the title cleaned into words — about fifty REPLACE calls —
// and SQLite does not reuse a repeated expression, so written inline it was
// rebuilt inside every one of ~110 word tests: 6,000 string operations a row,
// and the 90-day index went from ~1s to 14s on the test dataset. So the cleaned
// title is a COLUMN (RSI_BASE_TITLE_WORDS, computed once per row in a
// materialised step) and the word tests read that column.
// A card number with letters in it ("STN-2", "RI-5") is an insert's code,
// never a base card's. (No SQL comment for it: this clause is spliced into
// other lines, where "--" would swallow what follows.)
function _rsiBaseCardSql() {
  const inList = RSI_BASE_PARALLELS.map(v => `'${v}'`).join(', ');
  return `
          AND COALESCE(TRIM(year), '') <> ''
          AND COALESCE(TRIM(set_name), '') <> ''
          AND COALESCE(TRIM(card_number), '') <> ''
          AND card_number NOT GLOB '*[A-Za-z]*'
          AND LOWER(TRIM(COALESCE(parallel, ''))) IN (${inList})`;
}
// A print run in the title ("/99", "1/1"): base cards are not numbered.
const RSI_BASE_SERIAL = `
          AND NOT (COALESCE(title, '') GLOB '*/[0-9]*')`;
// The column tests only. The title tests — kind (card-kind.js in SQL) and the
// whole-word parallel test — are applied in _rsiBaseCtes, and only to the
// sales of the cards chosen for the basket; see there for why.
const RSI_BASE_CARD = _rsiBaseCardSql();

// The title as padded words, with the player's and product's own names removed
// — they are not evidence of a parallel ("Jerry Rice" is not Ice, "Mosaic" the
// product is not the Mosaic parallel) — and "Green Bay", a team, not a Green.
function _rsiBaseTitleWordsSql() {
  const words = (expr) => {
    let e = `LOWER(COALESCE(${expr}, ''))`;
    for (const c of ['-', '(', ')', ',', '.', '!', '#', ':', ';', '"', "'", '&', '+', '*', '[', ']', '|', '/'])
      e = `REPLACE(${e}, '${c.replace(/'/g, "''")}', ' ')`;
    return e;
  };
  let T = `(' ' || ${words('title')} || ' ')`;
  T = `REPLACE(${T}, ' ' || ${words('player')} || ' ', ' ')`;
  T = `REPLACE(${T}, ' ' || ${words('set_name')} || ' ', ' ')`;
  return `REPLACE(${T}, ' green bay ', ' ')`;
}
const RSI_BASE_TITLE_WORDS = _rsiBaseTitleWordsSql();
const RSI_BASE_SIGNALS = [...new Set([..._PARALLEL_SIGNAL_WORDS, 'cosmic', 'reactive', 'xfractors', 'superfractors',
                          ...RSI_BASE_SIGNAL_EXTRA, ...RSI_BASE_SIGNAL_PHRASES.filter(p => p !== 'green bay')])];
// Against the cleaned-title column, named `tw` where it is selected.
//
// Bracketed in groups of ten. SQLite nests a chain of ORs one level per term,
// and D1 caps expression depth at 100 (stock SQLite allows 1,000, which is why
// every local test passed): ~115 terms in one chain failed on D1 with
// "Expression tree is too large (maximum depth 100)" and took the market index
// off the site. Grouped, the same test is about twenty levels deep.
//
// And bracketed as a balanced tree, not a flat list of groups. Groups of ten
// joined in one chain still cost a level per group, and the depth adds up with
// the rest of the statement: adding ~40 signals took the chain from 12 groups
// to 16 and the whole-market index query over the cap again ("Expression tree
// is too large", found by replaying it on a local D1) while the smaller basket
// query survived. A tree of fan-out RSI_OR_FANOUT is ~log(n) deep — about 12
// levels for 150 terms — so the list can keep growing.
const RSI_OR_FANOUT = 6;
function _rsiOrTree(terms) {
  if (terms.length <= RSI_OR_FANOUT) return `(${terms.join(' OR ')})`;
  const size = Math.ceil(terms.length / RSI_OR_FANOUT);
  const parts = [];
  for (let i = 0; i < terms.length; i += size) parts.push(_rsiOrTree(terms.slice(i, i + size)));
  return `(${parts.join(' OR ')})`;
}
const RSI_BASE_TITLE_TEST = `NOT ${_rsiOrTree(RSI_BASE_SIGNALS.map(w => `tw LIKE '% ${w} %'`))}`;

// `daily` gives the whole-market index one point per day on the longer
// periods, where weekly steps drew four or five dots across a month. It is
// safe there because every comparison is already rescaled to a per-bucket rate
// over its own gap: a one-day step is the same rate raised to a smaller power,
// so the noise per step shrinks with the step and the headline over the period
// reads about the same. It is whole-market only — scoped to one player a day
// holds a handful of comparisons, which the tier gate would mostly refuse.
//
// From 7 days: a week drawn weekly is two dots and a straight line, which says
// nothing a single percentage doesn't. Seven daily steps are each clamped to a
// seventh of the weekly bound (_rsiBucketBounds), thin days are drawn as
// estimates, and a week too quiet to chain daily falls back to the weekly line.
const RSI_DAILY_MIN_DAYS = 7;
function _rsiGeometry(days, daily = false) {
  if (daily && days >= RSI_DAILY_MIN_DAYS) return { bucketDays: 1, points: days, spanDays: days + 1 };
  const bucketDays = Math.max(RSI_MIN_BUCKET_DAYS, Math.round(days / RSI_TARGET_POINTS));
  const points = Math.max(1, Math.round(days / bucketDays));
  return { bucketDays, points, spanDays: (points + 1) * bucketDays };
}

// The per-bucket clamp was set for a week. Scaled by the bucket width, a day
// may move at most a seventh of that (as a power), so seven daily steps are
// bounded exactly as one weekly step is.
function _rsiBucketBounds(bucketDays) {
  const k = bucketDays / RSI_MIN_BUCKET_DAYS;
  return { lo: Math.pow(RSI_BUCKET_MOVE_FLOOR, k), hi: Math.pow(RSI_BUCKET_MOVE_CEIL, k) };
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

// A fingerprint of everything that changes the answer, folded into the cache
// key. The index is cached for an hour, and the key used to name only the
// period — so a deploy that corrected the arithmetic kept serving the old
// arithmetic until the hour was up, which reads exactly like the fix not
// working. Every correction today was invisible for up to an hour after it
// shipped.
//
// Listing the inputs by hand would rot; this hashes the actual values, so
// changing a clamp, a filter, the basket size or the card key retires the old
// entries by itself.
const MARKET_CALC_SIG = (() => {
  const parts = [
    MARKET_TOP_PLAYERS, MARKET_CARDS_PER_PLAYER, MARKET_MIN_OBS_PER_PLAYER,
    MARKET_EXCLUDE_TRAILING_DAYS, RSI_TARGET_POINTS, RSI_MIN_BUCKET_DAYS,
    RSI_MAX_GAP_DAYS, RSI_RATIO_FLOOR, RSI_RATIO_CEIL,
    RSI_BUCKET_MOVE_FLOOR, RSI_BUCKET_MOVE_CEIL, RSI_DAILY_MIN_DAYS,
    RSI_KEY_COLS.join(','), RSI_RAW_ONLY, RSI_BASE_CARD, RSI_BASE_SERIAL, RSI_BASE_TITLE_WORDS, RSI_BASE_TITLE_TEST,
    _kindSql('s.title'),
    JSON.stringify(RSI_TIERS), JSON.stringify(RSI_TIERS_PLAYER),
  ].join('|');
  let h = 2166136261;                       // FNV-1a, enough to separate builds
  for (let i = 0; i < parts.length; i++) {
    h ^= parts.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
})();

// One query builds the whole basket and returns one row per player per bucket:
// their median price ratio and the median gap it was measured over. That is
// about 125 x 11 rows whatever the dataset size, so the Worker does arithmetic
// on a small table rather than grouping hundreds of thousands of sales.
// `unit` is what one contributor to a bucket is. For the whole market that is
// a player, so no single name can speak for the market however many of their
// cards traded. Scoped to one player there is only ever one player, so the
// contributor is a card instead — otherwise every bucket has a sample of one
// and the index can never report.
// async so the best-offer clause is resolved HERE rather than at each call
// site. Four places build these queries; a rule that has to be remembered at
// four places is not a rule.
// The first two steps of both market queries, shared so the index and its
// basket read exactly the same population.
//
// WHY IT IS SHAPED LIKE THIS. At live scale the old single `base` CTE was the
// whole cost. Measured on 3.1M synthetic sales shaped like the real table:
//
//   reading the rows                       89ms
//   filters + cleaned card key per sale  ~12s
//   ...and SQLite ran that step once per reference to `base` — three times in
//   the index, four in the basket — so 38s and 65s, past D1's CPU limit. That
//   is the "D1 DB exceeded its CPU time limit and was reset" the live site
//   returned for every period.
//
// Now:
//   raw   filters, cheapest and most selective first, then collapses identical
//         sales of a day into one row carrying SUM(price) and COUNT. MATERIALIZED
//         so it is computed once.
//   base  the cleaned player and card keys, built once per raw GROUP rather than
//         once per sale — a busy card sells many times a day with identical
//         columns. Also MATERIALIZED.
//
// Downstream, COUNT(*) becomes SUM(c) and AVG(price) becomes SUM(s)/SUM(c).
// Those are the same numbers, not approximations: the average of a day's sales
// is their total over their count however they are grouped first. The index
// was compared row for row against the old query on the same data.
//
// The comment on the index's daily CTE records that adding MATERIALIZED once
// moved a flat market from -0.9% to -67.5%. That was row order leaking into
// which same-day sale got paired; the daily averaging added since makes the
// result independent of row order, which is what makes materialising safe now.
// `junk` adds the junk-title filter; `labels` carries the display columns the
// basket prints. The index needs neither.
// Prefix the sales columns in a WHERE fragment with a table alias, for a join
// where another table shares the column names. Only bare identifiers are
// touched: anything already qualified, quoted or inside a string literal is
// left alone.
const _RSI_SALES_COLS = ['item_id', 'sold_date', 'title', 'price_cents', 'currency', 'listing_format',
  'grader', 'grade', 'player', 'parallel', 'year', 'set_name', 'card_number', 'confidence',
  'best_offer', 'bids', 'image_url'];
function _rsiQualify(sql, alias) {
  const re = new RegExp(`('(?:[^']|'')*')|(?<![\\w.])(${_RSI_SALES_COLS.join('|')})(?![\\w(])`, 'g');
  return sql.replace(re, (m, str, col) => str ? str : `${alias}.${col}`);
}

// The parameters _rsiBaseCtes consumes, in the order its SQL uses them:
// choosing the basket (the period), ranking the pre-period days (look-back to
// period start), then reading the chosen cards' sales (look-back to the end of
// the period, with the period start once more for the pre-period test).
function _rsiBaseBinds({ periodIso, sinceIso, throughIso, extraBinds = [] }) {
  return [periodIso, throughIso, ...extraBinds,
          sinceIso, periodIso, ...extraBinds,
          sinceIso, throughIso, ...extraBinds, periodIso];
}

function _rsiBaseCtes({ PLAYER, CARD, P, JOIN, ALIAS_FILTER, noOffer, extraWhere,
                        junk = false, labels = false, hasImage = false, useAlias = false, deny = [] }) {
  // Cards the checklists name as NOT base (_marketDenied), taken out before
  // each player's busiest ten are chosen, so the next card takes the slot.
  const denySql = deny.length
    ? ` WHERE k.card NOT IN (${deny.map(k => `'${String(k).replace(/'/g, "''")}'`).join(', ')})` : '';
  // The column tests, which are cheap. Applied twice — once to choose the
  // basket, once to the sales of the cards chosen — because the second pass
  // re-reads `sales` and must admit exactly what the first one counted.
  // Cheap column tests, and the per-sale tests that read the title as a
  // substring (print run, best offer, slab words, junk). Both passes use both;
  // pricing computes the title ones as a column:
  // SQLite runs a WHERE term that mentions only `sales` before the join, so
  // written there they ran on every sale in the window rather than on the
  // chosen cards' sales alone.
  const colTests = `price_cents IS NOT NULL AND price_cents > 0
          AND sold_date > ? AND sold_date <= ?${RSI_BASE_CARD}${extraWhere}`;
  const saleTests = `${RSI_BASE_SERIAL}${noOffer}${RSI_RAW_ONLY}${junk ? RSI_JUNK_ONLY : ''}`;
  const columns = `${colTests}${saleTests}`;
  // The same key columns join the two passes. Player by `=`, which lets SQLite
  // build a lookup index on the chosen list; the rest by `IS`, because grader
  // and grade are NULL on most raw rows and NULL = NULL is not true.
  // (player is never NULL here — see the player_n <> '' test.)
  const tupleCols = ['player', 'year', 'set_name', 'card_number', 'grader', 'grade'];
  const tupleJoin = ['s.player = k.player',
    ...tupleCols.filter(c => c !== 'player').map(c => `s.${c} IS k.${c}`)].join(' AND ');
  // TWO PASSES, for cost.
  //
  // The base-card rule has to read the title — a blank parallel column is the
  // norm for base cards and also for a Refractor whose parallel the collector
  // did not parse — and reading titles is the one thing D1 cannot afford at
  // this volume: ~140 word tests over the ~750,000 sales that pass the column
  // tests measured at 45-63s on a live-sized table, over the limit.
  //
  // But only the basket is priced, and the basket is 600 players x 10 cards.
  // So the basket is CHOSEN on the column tests alone (counts), and the titles
  // are read only for the sales of the cards chosen. A card's volume may
  // include a few mislabelled parallel sales when it is chosen; its PRICES
  // never do, because those sales are removed before anything is averaged.
  // The basket is chosen from the PERIOD's sales (its own date bounds, bound
  // first); the second pass reads the period plus the look-back, because a
  // sale early in the period still needs its previous sale to be priced. The
  // look-back has nothing to say about who is most traded now, and for a
  // 7-day view it was 180 of the 194 days the first pass read.
  //
  // Chosen with the substring title tests too, not the column tests alone:
  // tried, and without them unparsed slabs are chosen, fill basket slots, and
  // are then rejected wholesale at pricing — slower, and fewer real cards.
  return `pick_raw AS MATERIALIZED (
       SELECT ${tupleCols.join(', ')}, COUNT(*) AS c
         FROM sales
        WHERE ${columns}
        GROUP BY ${tupleCols.join(', ')}
     ),
     pick_keys AS MATERIALIZED (
       SELECT ${tupleCols.join(', ')}, c, ${PLAYER} AS player_n, ${CARD} AS card,
              ${useAlias ? 'COALESCE(al.display, player)' : 'player'} AS display
         FROM pick_raw ${JOIN}
        WHERE ${P} <> ''${ALIAS_FILTER}
     ),
     pick_players AS (
       SELECT player_n FROM pick_keys GROUP BY player_n
        ORDER BY SUM(c) DESC, player_n LIMIT ${MARKET_TOP_PLAYERS}
     ),
     pick_cards AS (
       SELECT card FROM (
         SELECT k.card, ROW_NUMBER() OVER (PARTITION BY k.player_n ORDER BY SUM(k.c) DESC, k.card) AS rn
           FROM pick_keys k JOIN pick_players t ON t.player_n = k.player_n${denySql}
          GROUP BY k.player_n, k.card)
        WHERE rn <= ${MARKET_CARDS_PER_PLAYER}
     ),
     pick_tuples AS MATERIALIZED (
       SELECT k.* FROM pick_keys k JOIN pick_cards pc ON pc.card = k.card
     ),
     -- Before the period, only each card's LAST few trading days matter.
     --
     -- Pricing pairs a card's consecutive days, and only pairs landing in the
     -- period are used, so the one pre-period day that counts is the latest
     -- clean one: it prices the card's first day in the period. Every earlier
     -- day was read, title-checked and thrown away — for a 90-day view, 180 of
     -- the 279 days the second pass read. The last THREE days are kept, not one,
     -- so a latest day made entirely of mislabelled parallels still leaves a
     -- clean day to pair with. (If all three are dirty the card simply starts
     -- pairing inside the period.) Chosen on the column tests alone, so no
     -- title is read to rank them.
     pre_days AS MATERIALIZED (
       SELECT card, sold_date FROM (
         SELECT k.card, s.sold_date,
                DENSE_RANK() OVER (PARTITION BY k.card ORDER BY s.sold_date DESC) AS dr
           FROM sales s CROSS JOIN pick_tuples k ON ${tupleJoin}
          WHERE ${_rsiQualify(colTests, 's')})
        WHERE dr <= 3
        GROUP BY card, sold_date
     ),
     -- The sales of the chosen cards only — in the period, plus those last
     -- pre-period days — each title cleaned into words ONCE.
     cand AS MATERIALIZED (
       SELECT s.sold_date, s.price_cents, k.player_n, k.card, k.display,
              s.year, s.set_name, s.card_number, s.parallel, s.grader, s.grade${hasImage ? ', s.image_url' : ''},
              ${RSI_BASE_TITLE_WORDS.replace(/\b(title|player|set_name)\b/g, 's.$1')} AS tw,
              ${_kindSql('s.title')} AS kind,
              CASE WHEN 1 = 1 ${_rsiQualify(saleTests, 's')} THEN 1 ELSE 0 END AS ok
         -- CROSS JOIN fixes the loop order: sales read ONCE by date, each probing
         -- the small chosen-card list. Left to itself SQLite looped over the
         -- 6,000 chosen tuples and used the player index, fetching a player's
         -- whole history once per card of theirs — 51s against 14s measured on
         -- a live-sized table, identical rows either way.
         FROM sales s CROSS JOIN pick_tuples k ON ${tupleJoin}
        WHERE ${_rsiQualify(colTests, 's')}
          AND (s.sold_date > ? OR (k.card, s.sold_date) IN (SELECT card, sold_date FROM pre_days))
     ),
     base AS MATERIALIZED (
       SELECT sold_date, SUM(price_cents) AS s, COUNT(*) AS c, player_n, card${labels ? `,
              MAX(display) AS player, MAX(year) AS year, MAX(set_name) AS set_name,
              MAX(card_number) AS card_number, MAX(parallel) AS parallel, MAX(grader) AS grader,
              MAX(grade) AS grade${hasImage ? `,
              MAX(CASE WHEN image_url IS NOT NULL AND image_url <> ''
                       THEN sold_date || '|' || image_url END) AS dated_image` : ''}` : ''}
         FROM cand
        WHERE ok = 1 AND kind = '' AND ${RSI_BASE_TITLE_TEST}
        GROUP BY sold_date, player_n, card
     )`;
}

async function _rsiQuery(db, throughIso, days, extraWhere = '', extraBinds = [], unit = 'player', useAlias = false, daily = false, deny = []) {
  const noOffer = await _noBestOfferSql(db);
  const { bucketDays, spanDays } = _rsiGeometry(days, daily);
  // Reach back beyond the window so a sale early in it still has a prior.
  const sinceIso = _mkIso(_mkDay(throughIso) - spanDays - RSI_MAX_GAP_DAYS);
  // The period itself, which the basket is chosen from.
  const periodIso = _mkIso(_mkDay(throughIso) - spanDays);
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
    `WITH ${_rsiBaseCtes({ PLAYER, CARD, P, JOIN, ALIAS_FILTER, noOffer, extraWhere, deny })},
     top_players AS (
       SELECT player_n FROM base GROUP BY player_n
        ORDER BY SUM(c) DESC, player_n LIMIT ${MARKET_TOP_PLAYERS}
     ),
     card_counts AS (
       SELECT b.player_n, b.card, SUM(b.c) AS sales,
              ROW_NUMBER() OVER (PARTITION BY b.player_n ORDER BY SUM(b.c) DESC, b.card) AS rn
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
              SUM(b.s) * 1.0 / SUM(b.c) AS price
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
            -- The two middle ratios (the same row when cnt is odd), combined in
            -- JavaScript as a geometric mean. Averaging them here was an
            -- arithmetic mean of price ratios, which always reads high: 0.8
            -- and 1.25 average to +2.5% where the market did nothing. Rare
            -- across a week, it is the common case across one day — a player
            -- with two comparisons — and read a flat market at +5% a month.
            MIN(CASE WHEN rr IN ((cnt + 1) / 2, (cnt + 2) / 2) THEN ratio END) AS med_lo,
            MAX(CASE WHEN rr IN ((cnt + 1) / 2, (cnt + 2) / 2) THEN ratio END) AS med_hi,
            AVG(CASE WHEN rg IN ((cnt + 1) / 2, (cnt + 2) / 2) THEN gap   END) AS med_gap
       FROM ranked
      WHERE cnt >= ${MARKET_MIN_OBS_PER_PLAYER}
      GROUP BY bucket, p, cnt
      ORDER BY bucket, p`
    // Bind order follows the order the placeholders appear in the statement:
    // the base CTE's date range, then any scope filter appended to it, then the
    // bucket arithmetic further down. Passing extraBinds last silently fed the
    // player name into the julianday() slot and returned nothing.
  ).bind(..._rsiBaseBinds({ periodIso, sinceIso, throughIso, extraBinds }), throughIso, bucketDays);
}

// The basket, itemised. Same selection as the index — busiest players, their
// most-traded cards — but returned card by card with the move each one made,
// computed the same way the index computes it. This is what the number is
// actually built from, so it can be read rather than taken on trust.
//
// A representative raw spelling of each field is carried through with MAX(),
// because grouping happens on the normalised form and the normalised form is
// lower-cased and stripped of punctuation — no use as a label.
async function _rsiBasketQuery(db, throughIso, days, limit = 24, extraWhere = '', extraBinds = [], hasImage = false, useAlias = false, deny = []) {
  const noOffer = await _noBestOfferSql(db);
  const { bucketDays, spanDays } = _rsiGeometry(days);
  const sinceIso = _mkIso(_mkDay(throughIso) - spanDays - RSI_MAX_GAP_DAYS);
  const periodIso = _mkIso(_mkDay(throughIso) - spanDays);
  // The period as the page states it, for each card's own move.
  const startIso = _mkIso(_mkDay(throughIso) - days);
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
  // dated_image is already the per-group maximum (see _rsiBaseCtes), and the
  // maximum of maxima is the maximum.
  const imgLabel = hasImage ? 'MAX(b.dated_image)' : 'NULL';
  return db.prepare(
    `WITH ${_rsiBaseCtes({ PLAYER, CARD, P, JOIN, ALIAS_FILTER, noOffer, extraWhere,
                          junk: true, labels: true, hasImage, useAlias, deny })},
     top_players AS (
       SELECT player_n FROM base GROUP BY player_n
        ORDER BY SUM(c) DESC, player_n LIMIT ${MARKET_TOP_PLAYERS}
     ),
     card_counts AS (
       SELECT b.player_n, b.card, SUM(b.c) AS sales,
              ROW_NUMBER() OVER (PARTITION BY b.player_n ORDER BY SUM(b.c) DESC, b.card) AS rn
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
       SELECT b.card, b.sold_date, SUM(b.s) * 1.0 / SUM(b.c) AS price
         FROM base b JOIN shortlist k ON k.card = b.card
        GROUP BY b.card, b.sold_date
     ),
     -- Each card's move: its average daily price over its LATER trading days in
     -- the period against its EARLIER ones — the card's own trading days split
     -- in half, not the calendar.
     --
     -- Not the index's pair arithmetic. That converts each day-to-day price
     -- ratio to a per-bucket rate by raising it to (bucket / gap), which is
     -- sound across ~300 players, where the noise cancels, and useless for one
     -- card: a base card selling every day has a one-day gap, so ordinary +/-10%
     -- day-to-day noise was raised to the 7th power per week and compounded, and
     -- nearly every card on the live list sat at the clamp (-93.7%, +1500%).
     --
     -- Not the calendar halves either, which were tried: the collector runs
     -- days behind, so on the 7-day view the second half of the week held no
     -- sales yet and every card read "no move". Splitting the days the card
     -- actually traded keeps both sides populated whatever the lag.
     moves AS (
       SELECT card,
              SUM(CASE WHEN rn * 2 >  cnt THEN 1 ELSE 0 END) AS days_recent,
              SUM(CASE WHEN rn * 2 <= cnt THEN 1 ELSE 0 END) AS days_older,
              AVG(CASE WHEN rn * 2 >  cnt THEN price END) AS recent_c,
              AVG(CASE WHEN rn * 2 <= cnt THEN price END) AS older_c,
              -- Each trading day's price, for the robust move in _basketMove.
              GROUP_CONCAT(sold_date || ':' || CAST(ROUND(price) AS INTEGER), ',') AS day_prices
         FROM (SELECT card, price, sold_date,
                      ROW_NUMBER() OVER (PARTITION BY card ORDER BY sold_date) AS rn,
                      COUNT(*) OVER (PARTITION BY card) AS cnt
                 FROM daily WHERE sold_date > ?)
        GROUP BY card
     ),
     labels AS (
       SELECT b.card,
              MAX(b.player) AS player, MAX(b.year) AS year, MAX(b.set_name) AS set_name,
              MAX(b.parallel) AS parallel, MAX(b.card_number) AS card_number,
              MAX(b.grader) AS grader, MAX(b.grade) AS grade,
              SUM(b.c) AS sales,
              SUM(b.s) * 1.0 / SUM(b.c) AS avg_cents,
              ${imgLabel} AS dated_image
         FROM base b JOIN shortlist k ON k.card = b.card
        GROUP BY b.card
     )
     SELECT l.player, l.year, l.set_name, l.parallel, l.card_number, l.grader, l.grade,
            l.sales, l.avg_cents, l.dated_image,
            m.days_recent, m.days_older, m.recent_c, m.older_c, m.day_prices
       FROM labels l
       LEFT JOIN moves m ON m.card = l.card
      ORDER BY l.sales DESC`
  ).bind(..._rsiBaseBinds({ periodIso, sinceIso, throughIso, extraBinds }), startIso);
}

// A card's own move over the period, read so one bad day cannot drive it.
//
// "+1,226%" on a $2 base card came from averages: a few parallels or junk
// sales priced as the base card on some days, averaged in. So each trading
// day's price is first compared with the card's typical day (the median): a
// day over 3x or under a third of it is not this card's price and is set
// aside. The card's later trading days are then compared with its earlier ones
// by MEDIAN, needing two days a side, and bounded as before.
const BASKET_OUTLIER_X = 3;
function _basketMove(dayPrices, points) {
  const days = String(dayPrices || '').split(',').map(x => {
    const [d, p] = x.split(':');
    return { d, p: Number(p) };
  }).filter(x => x.d && x.p > 0).sort((a, b) => a.d.localeCompare(b.d));
  if (!days.length) return null;
  const med = (xs) => { const a = xs.slice().sort((x, y) => x - y); const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
  const typical = med(days.map(x => x.p));
  const kept = days.filter(x => x.p <= typical * BASKET_OUTLIER_X && x.p >= typical / BASKET_OUTLIER_X);
  const out = { typicalCents: med(kept.map(x => x.p)), changePct: null, outlierDays: days.length - kept.length };
  const half = kept.length >> 1;
  if (half < 2 || kept.length - half < 2) return out;
  const older = med(kept.slice(0, half).map(x => x.p));
  const recent = med(kept.slice(half).map(x => x.p));
  if (!(older > 0) || !(recent > 0)) return out;
  const lo = Math.pow(RSI_BUCKET_MOVE_FLOOR, points), hi = Math.pow(RSI_BUCKET_MOVE_CEIL, points);
  const ratio = Math.min(hi, Math.max(lo, recent / older));
  out.changePct = Math.round((ratio - 1) * 1000) / 10;
  return out;
}

// Turn basket rows into something displayable: a label, how much it traded,
// its typical price, and its own move over the period.
function _rsiBasketRows(rows, days, bucketDays, points) {
  const out = [];
  for (const r of (rows || [])) {
    const parts = [r.year, r.set_name, r.player].filter(Boolean).map(String);
    if (r.card_number) parts.push(`#${String(r.card_number).replace(/^#/, '')}`);
    // Every card here is a base card, so "Base" says nothing; a Rated Rookie
    // is worth naming, since that is how collectors know the card.
    const par = String(r.parallel || '').trim();
    const extras = [/^(base|base set)$/i.test(par) ? '' : par, [r.grader, r.grade].filter(Boolean).join(' ')]
      .map(x => String(x || '').trim()).filter(Boolean);
    // Later trading days against earlier ones (see the basket query's moves
    // CTE), needing two trading days on each side, and bounded as the
    // index bounds a period: at most halving or doubling per bucket.
    const mv = _basketMove(r.day_prices, points);
    const changePct = mv ? mv.changePct : null;
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
      // Trading days behind the move, across both halves.
      pairs: (Number(r.days_recent) || 0) + (Number(r.days_older) || 0),
      // The card's typical day, not its mean: one stray sale moves a mean.
      avgPrice: mv && mv.typicalCents ? Math.round(mv.typicalCents) / 100
        : r.avg_cents != null ? Math.round(Number(r.avg_cents)) / 100 : null,
      changePct,
      imageUrl,
    });
  }
  return out;
}

function _buildRepeatSalesPayload(rows, throughIso, days, extra = {}, tiers = RSI_TIERS, daily = false) {
  const { bucketDays, points } = _rsiGeometry(days, daily);
  const bounds = _rsiBucketBounds(bucketDays);
  // bucket -> [{ growth, n }] — one entry per player in that bucket.
  const byBucket = new Map();
  const players = new Set();
  for (const r of rows) {
    const b = Number(r.bucket);
    const ratio = Math.sqrt(Number(r.med_lo) * Number(r.med_hi));
    const gap = Number(r.med_gap);
    if (!Number.isInteger(b) || b < 0 || !(ratio > 0) || !(gap > 0)) continue;
    let growth = Math.pow(ratio, bucketDays / gap);
    if (!Number.isFinite(growth) || growth <= 0) continue;
    growth = Math.min(bounds.hi, Math.max(bounds.lo, growth));
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
      // An unmeasured step carries the typical move (see above): an estimate,
      // and the chart draws it as one.
      ...(s.thin ? { estimated: true } : {}),
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
  const ci = await cardIndex();
  if (!ci) return res.json({ available: false, reason: 'player dictionary unavailable' });
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
      const hit = ci.resolvePlayer(r.player);
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
      generatedAt: new Date().toISOString(),
      window: { since: sinceIso, through: newest.d },
      dictionary: ci.stats,
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

// How much of the missing parallel is recoverable from the title.
//
// 48.4% of priced sales have a parallel; 38.9% have a full card identity. That
// is the ceiling on the index, and the titles suggest most of the rest is
// readable — "2025 Panini Prizm - Rookies Jaxson Dart #332 Silver Prizm (RC)"
// names the parallel plainly while the column is blank.
//
// Two questions, and the second matters more. How many blank parallels can be
// filled? And where the column DOES have a value, does the title agree with it?
// A reader that recovers a lot and agrees with nothing is reading the wrong
// thing.
// How many identifications would actually have to be bought?
//
// One per SALE, and there is no way around it. The tempting answer is one per
// distinct card, on the reasoning that a card's identity never changes — but
// that is exactly backwards here. Two sales of 2025 Prizm Jaxson Dart #332 can
// be a Silver and a Gold: the parallel is the thing that VARIES between sales
// of the same card, which is why it is the thing being asked about. There is
// nothing to cache.
//
// What can be cut is which sales are worth asking about. The index runs on 600
// players, and a card that sold once all month moves nothing in it. So the
// question for a vendor is not "can we afford 190,000 calls" but "how far down
// the tail do we need to go before the answer stops mattering" — and the tiers
// below price exactly that.
app.get('/api/debug/id-volume', async (req, res) => {
  const db = getNflDb();
  if (!db) return res.json({ available: false, reason: 'no dataset' });
  try {
    const newest = await db.prepare(
      'SELECT MAX(sold_date) AS d FROM sales WHERE price_cents IS NOT NULL').first();
    if (!newest || !newest.d) return res.json({ available: false, reason: 'no data in range' });
    const through = _mkIso(_mkDay(newest.d) - MARKET_EXCLUDE_TRAILING_DAYS);
    const since = _mkIso(_mkDay(through) - 30);

    // Grouped by card, but only to rank which cards matter. The cost is
    // measured in sales, because every sale needs its own identification.
    const CARD = `${_normCol('year')} || '|' || ${_normCol('set_name')} || '|' || ${_normCol('player')}`;
    const WINDOW = `price_cents IS NOT NULL AND price_cents > 0
                      AND sold_date > ? AND sold_date <= ?
                      AND COALESCE(TRIM(parallel), '') = ''`;

    const r = await db.prepare(
      `WITH blank AS (
         SELECT ${CARD} AS card, COUNT(*) AS n
           FROM sales WHERE ${WINDOW} GROUP BY ${CARD})
       SELECT COUNT(*) AS cards, SUM(n) AS sales,
              SUM(CASE WHEN n >= 2  THEN 1 ELSE 0 END) AS cards2,
              SUM(CASE WHEN n >= 2  THEN n ELSE 0 END) AS sales2,
              SUM(CASE WHEN n >= 5  THEN 1 ELSE 0 END) AS cards5,
              SUM(CASE WHEN n >= 5  THEN n ELSE 0 END) AS sales5,
              SUM(CASE WHEN n >= 10 THEN 1 ELSE 0 END) AS cards10,
              SUM(CASE WHEN n >= 10 THEN n ELSE 0 END) AS sales10
         FROM blank`).bind(since, through).first();

    const sales = Number(r.sales) || 0;
    const pct = (a) => (sales ? Math.round((Number(a) / sales) * 1000) / 10 + '%' : null);
    const tier = (cards, covered) => ({
      // The number to quote a vendor. One call per sale — there is no reuse.
      callsPerMonth: Number(covered) || 0,
      callsPerDay: Math.round((Number(covered) || 0) / 30),
      // Context only: how many distinct cards those sales cover.
      distinctCards: Number(cards) || 0,
      shareOfBlankSalesFixed: pct(covered),
    });

    res.json({
      available: true,
      generatedAt: new Date().toISOString(),
      window: { since, through },
      blankParallelSales: sales,
      // Every blank sale, i.e. the full bill.
      everything: tier(r.cards, sales),
      // Cutting the tail. A card that sold once in a month cannot move an index
      // built on repeat sales, so these are the tiers actually worth pricing.
      cardsThatSold2OrMore: tier(r.cards2, r.sales2),
      cardsThatSold5OrMore: tier(r.cards5, r.sales5),
      cardsThatSold10OrMore: tier(r.cards10, r.sales10),
      note: 'one identification per SALE — the parallel is what differs between '
          + 'sales of the same card, so nothing can be cached and reused',
    });
  } catch (err) {
    console.error('[id-volume]', err && err.stack || err);
    res.json({ available: false, error: err && err.message });
  }
});

// Does eBay already know the parallel, on the sales where our column is blank?
//
// A question worth settling before spending anything on image recognition. The
// parallel column is filled on 48% of sales and that data came from eBay's item
// specifics — the structured field a seller picks when listing. If it survives
// on the other 52%, the answer is free and authoritative and nothing needs to
// look at a picture.
//
// Asked through the API, not by reading listing pages. Scraping them from CI
// returned 403 on all 150 attempts, which is eBay saying no to datacenter
// traffic; the API is the sanctioned route and the credentials for it already
// live here.
//
// The likely answer is that Browse cannot see ended items at all — it is an
// active-listings API. That is worth knowing precisely rather than assuming,
// because "sold data has no aspects" and "we are asking the wrong endpoint"
// call for completely different next steps.
app.get('/api/debug/ebay-aspects', async (req, res) => {
  const db = getNflDb();
  if (!db) return res.json({ available: false, reason: 'no dataset' });
  const limit = Math.min(20, Math.max(1, parseInt(req.query.limit, 10) || 8));
  try {
    const r = await db.prepare(
      `SELECT item_id, title FROM sales
        WHERE item_id IS NOT NULL AND item_id <> ''
          AND price_cents IS NOT NULL AND price_cents > 0
          AND COALESCE(TRIM(parallel), '') = ''
        ORDER BY sold_date DESC LIMIT ?`).bind(limit).all();
    const rows = (r && r.results) || [];
    if (!rows.length) return res.json({ available: false, reason: 'no blank-parallel sales with an item_id' });

    let token;
    try { token = await getOAuthToken(); }
    catch (err) { return res.json({ available: false, reason: `no eBay token: ${err && err.message}` }); }

    const out = [];
    for (const row of rows) {
      const id = String(row.item_id).startsWith('v1|') ? row.item_id : `v1|${row.item_id}|0`;
      try {
        const resp = await axios.get(
          `https://api.ebay.com/buy/browse/v1/item/${encodeURIComponent(id)}`,
          { headers: { Authorization: `Bearer ${token}` }, timeout: 8000, validateStatus: () => true });
        if (resp.status !== 200) {
          out.push({ itemId: row.item_id, status: resp.status,
                     error: (resp.data && resp.data.errors && resp.data.errors[0] &&
                             resp.data.errors[0].message) || null });
          continue;
        }
        const aspects = {};
        for (const grp of (resp.data.localizedAspects || [])) {
          if (grp && grp.name) aspects[grp.name] = grp.value;
        }
        out.push({
          itemId: row.item_id, status: 200,
          title: String(row.title || '').slice(0, 70),
          aspectCount: Object.keys(aspects).length,
          // The one that matters, under whichever label eBay used.
          parallelAspect: aspects['Parallel/Variety'] || aspects['Parallel'] ||
                          aspects['Variety'] || aspects['Features'] || null,
          aspects,
        });
      } catch (err) {
        out.push({ itemId: row.item_id, error: String(err && err.message).slice(0, 80) });
      }
    }

    const ok = out.filter(x => x.status === 200);
    const withParallel = ok.filter(x => x.parallelAspect);
    res.json({
      available: true,
      generatedAt: new Date().toISOString(),
      sampled: out.length,
      // If this is 0, Browse cannot see ended listings and the question needs
      // eBay's Marketplace Insights API (restricted, application required)
      // rather than a different parse.
      reachable: ok.length,
      carryingAParallelAspect: withParallel.length,
      verdict: !ok.length
        ? 'Browse cannot see these items — sold listings need Marketplace Insights'
        : withParallel.length
          ? 'eBay HAS the parallel for blank rows — recoverable without any image work'
          : 'reachable, but no parallel aspect — sellers did not fill it in',
      items: out,
    });
  } catch (err) {
    console.error('[ebay-aspects]', err && err.stack || err);
    res.json({ available: false, error: err && err.message });
  }
});

// How far along is the fingerprint library, and is the pipeline even working?
//
// The one thing that cannot be verified from a laptop is whether Cloudflare's
// image resizer is enabled on this zone. Without it the fetch returns the
// original JPEG, which cannot be decoded here, and every row would fail with
// the same reason — so the failure breakdown is the first thing to read, not
// the progress count.
//
// The Worker does not fill this table. It cannot: there is no JPEG decoder
// here, and the attempt to have Cloudflare's image service supply a PNG
// instead failed on every row in production because the resizer is a paid zone
// feature. The fingerprinting runs in CI, where Node is complete; this endpoint
// only reads what that job has written.
app.get('/api/debug/photo-status', async (req, res) => {
  const db = getNflDb();
  if (!db) return res.json({ available: false, reason: 'no dataset' });
  try {
    if (!await _photoEnsure(db)) return res.json({ available: false, reason: 'tables unavailable' });
    const tot = await db.prepare(
      `SELECT COUNT(*) AS rows_,
              SUM(CASE WHEN ok = 1 THEN 1 ELSE 0 END) AS decoded
         FROM ${PHOTO_SIG_TABLE}`).first();
    // Grouped, because one dominant reason is diagnostic in a way a count is
    // not: all-"not-resized" means the zone feature is off, all-"http-404"
    // means the URLs have expired, a spread means ordinary attrition.
    const why = await db.prepare(
      `SELECT why, COUNT(*) AS n FROM ${PHOTO_SIG_TABLE}
        WHERE ok = 0 AND why IS NOT NULL
        GROUP BY why ORDER BY n DESC LIMIT 8`).all();
    const remaining = await db.prepare(
      `SELECT COUNT(*) AS n FROM (
         SELECT DISTINCT image_url FROM sales
          WHERE image_url IS NOT NULL AND image_url <> ''
            AND price_cents IS NOT NULL AND price_cents > 0
            AND COALESCE(TRIM(parallel), '') <> ''
            AND COALESCE(TRIM(year), '') <> '' AND COALESCE(TRIM(set_name), '') <> ''
            AND NOT EXISTS (SELECT 1 FROM ${PHOTO_SIG_TABLE} s WHERE s.url = sales.image_url))`
    ).first();

    const rows = Number(tot && tot.rows_) || 0;
    const decoded = Number(tot && tot.decoded) || 0;
    res.json({
      available: true,
      generatedAt: new Date().toISOString(),
      fingerprints: {
        stored: rows, decoded,
        decodeRate: rows ? Math.round((decoded / rows) * 1000) / 10 + '%' : null,
        referencePhotosLeft: Number(remaining && remaining.n) || 0,
      },
      // Read this before the progress numbers.
      failures: ((why && why.results) || []).map(r => ({ why: r.why, n: r.n })),
      minSamplesForReference: PHOTO_MIN_SAMPLES,
      filledBy: 'the "Fingerprint card photos" GitHub Action, not the Worker cron',
    });
  } catch (err) {
    console.error('[photo-status]', err && err.stack || err);
    res.json({ available: false, error: err && err.message });
  }
});

// Could photos do what the titles cannot?
//
// A parallel is a visual thing by definition — Silver, Gold and Red Prizm are
// the same card printed in different foil — so a photo carries the signal the
// text keeps losing. But matching photos only works if two conditions hold, and
// neither is obvious from the outside:
//
//   1. The sales we want to identify actually carry a photo.
//   2. The sales we would match them AGAINST carry one too, and there are
//      enough per parallel to be a reference rather than a coin flip. A
//      parallel known from two photos is not a reference.
//
// This measures both before anything is built. It reads no images — it only
// counts what exists, which is the cheap question that decides whether the
// expensive one is worth asking.
// ---- /api/debug/d1-schema ----
//
// Which indexes exist, and what the expensive queries actually do.
//
// The photo archive reads the sales table 96 times a day ordered by
// (sold_date, item_id). If those columns are indexed that is a range seek over
// a few hundred rows; if they are not, it is a full scan AND a sort of the
// whole table, every tick. Those two differ by a factor of about a thousand,
// and nothing anywhere said which one was happening.
//
// EXPLAIN QUERY PLAN settles it rather than inferring it from the query shape.
// SQLite says "SCAN sales" or "SEARCH sales USING INDEX ..." in so many words.
//
// Costs nothing: sqlite_master is a handful of rows, and EXPLAIN plans a query
// without running it.
app.get('/api/debug/d1-schema', async (req, res) => {
  const db = getNflDb();
  if (!db) return res.json({ available: false, reason: 'no D1 binding' });

  try {
    const schema = await db.prepare(
      `SELECT type, name, sql FROM sqlite_master
        WHERE tbl_name = 'sales' ORDER BY type DESC, name`).all();
    const rows = (schema && schema.results) || [];

    const Y = _normCol('year'), S = _normCol('set_name'), P = _normCol('player');
    // Mirrors the price-block job's WHERE exactly, best-offer clause included.
    // The point of this endpoint is to plan "the exact shapes the scheduled
    // jobs run, not simplified stand-ins" — a plan for a query the job no
    // longer issues would be worse than no plan.
    const WHERE = `price_cents IS NOT NULL AND price_cents > 0 AND confidence >= ${NFLDB_MIN_CONFIDENCE}`
      + (await _noBestOfferSql(db));

    // The exact shapes the scheduled jobs run, not simplified stand-ins — a
    // plan for a query nobody issues answers the wrong question.
    const probes = {
      'photo-archive walk': {
        sql: `SELECT item_id, sold_date, image_url FROM sales
               WHERE image_url IS NOT NULL AND image_url <> ''
                 AND (sold_date > ? OR (sold_date = ? AND item_id > ?))
               ORDER BY sold_date ASC, item_id ASC LIMIT 400`,
        bind: ['2026-01-01', '2026-01-01', ''],
      },
      'price-blocks per-card': {
        sql: `SELECT ${Y} AS g, COUNT(*) AS n FROM sales
               WHERE ${WHERE} AND sold_date >= ? GROUP BY g`,
        bind: ['2026-01-01'],
      },
      'sold search by title': {
        sql: `SELECT item_id FROM sales WHERE title LIKE ? LIMIT 50`,
        bind: ['%mahomes%'],
      },
    };

    const plans = {};
    for (const [label, q] of Object.entries(probes)) {
      try {
        const p = await db.prepare(`EXPLAIN QUERY PLAN ${q.sql}`).bind(...q.bind).all();
        const steps = ((p && p.results) || []).map(r => r.detail || JSON.stringify(r));
        plans[label] = {
          steps,
          // The word that decides whether this is cheap. SQLite writes "SCAN"
          // for a full table read and "SEARCH ... USING INDEX" for a seek.
          verdict: steps.some(d => /USING (COVERING )?INDEX/i.test(d))
            ? 'uses an index'
            : steps.some(d => /^SCAN/i.test(d))
              ? 'FULL TABLE SCAN'
              : 'unclear',
          sorts: steps.some(d => /USE TEMP B-TREE/i.test(d)),
        };
      } catch (err) {
        plans[label] = { error: String(err && err.message) };
      }
    }

    res.json({
      available: true,
      generatedAt: new Date().toISOString(),
      table: (rows.find(r => r.type === 'table') || {}).sql || null,
      indexes: rows.filter(r => r.type === 'index')
        .map(r => ({ name: r.name, sql: r.sql || '(implicit — from a UNIQUE or PRIMARY KEY)' })),
      indexCount: rows.filter(r => r.type === 'index').length,
      queryPlans: plans,
      reading: 'A plan saying FULL TABLE SCAN on the photo-archive walk means that job '
        + 'reads every row in sales, 96 times a day. "sorts: true" on top of that means '
        + 'it also sorts the whole table each time.',
    });
  } catch (err) {
    console.error('[d1-schema]', err && err.message);
    res.json({ available: false, error: String(err && err.message) });
  }
});

// ---- /api/debug/photo-archive ----
//
// Is the R2 copy job actually moving?
//
// archiveListingPhotos() walks the sales table oldest-first behind a
// (sold_date, item_id) cursor in KV, and that cursor deliberately STOPS at a
// transient failure so the photo is retried rather than lost. The failure mode
// that creates: if a row fails transiently and never succeeds, every tick
// re-reads the same 400 rows forever, stores nothing, and reports no error.
//
// From outside, that is indistinguishable from a job correctly finding that
// most old listings have already had their images purged — both look like
// "lots of reads, few writes" on the R2 dashboard.
//
// The cursor's position against the table tells them apart, and until now
// nothing exposed it. Shipping a job that can stall silently without also
// shipping the thing that shows whether it has is the gap this closes.
//
// The WHERE clause below is copied from the job's own query rather than
// written afresh: a diagnostic that measures a different set of rows than the
// job walks would give a confident answer about the wrong thing.
const PHOTO_ARCHIVE_TTL = 300;
// ---- /api/debug/price-blocks ----
//
// Why are the landing pages still showing no prices?
//
// The block only appears if three things all happened: the cron ran the build,
// the build wrote a map to KV, and the Worker injected it. When it does not
// appear, every one of those looks identical from outside — a page with no
// price block. This says which.
//
// Reads KV only, so it costs nothing and can be hit freely. `?build=1` runs
// the build synchronously and returns its result, which is the fast way to see
// the actual error rather than waiting up to six hours for the next attempt.
// That does cost two full aggregate scans, so it says so in the response.
app.get('/api/debug/price-blocks', async (req, res) => {
  let ran = null;
  if (req.query.build === '1') {
    ran = await buildPriceBlocks().catch(err => ({ ok: false, reason: `threw: ${err && err.message}` }));
  }

  let map = null, attempt = null;
  try { map = await cacheGet(PRICE_BLOCKS_KEY); } catch (_) { /* reported below */ }
  try { attempt = await cacheGet(PRICE_BLOCKS_ATTEMPT_KEY); } catch (_) { /* reported below */ }

  const pages = (map && map.pages) || {};
  const keys = Object.keys(pages);
  const kinds = { set: 0, player: 0, subset: 0 };
  for (const k of keys) {
    const kind = k.slice(0, k.indexOf(':'));
    if (kinds[kind] !== undefined) kinds[kind]++;
  }

  // How many of these pages Google actually sees.
  //
  // The page count on its own overstates the reach: 3,201 player pages exist
  // and only 1,228 are in the sitemap, so a priced page can easily be one
  // carrying noindex. For the low-value-content question the only figure that
  // matters is priced AND indexable, against the 2,173 URLs in the sitemap.
  //
  // Sets are all indexable (every product clears the card minimum), and the
  // subset attribution map is built only from subsets that clear it too — so
  // players are the side that needs looking up.
  let indexed = null;
  try {
    const pidx = await _loadJson('players/index.json');
    const byslug = new Map(((pidx && pidx.players) || []).map(p => [p.slug, p]));
    let players = 0, hidden = 0;
    for (const k of keys) {
      if (!k.startsWith('player:')) continue;
      const p = byslug.get(k.slice(7));
      if (p && p.indexable) players++; else hidden++;
    }
    const total = kinds.set + kinds.subset + players;
    indexed = {
      indexableUrls: INDEXABLE_URLS,
      pricedAndIndexable: total,
      share: Math.round((100 * total) / INDEXABLE_URLS) + '%',
      breakdown: { sets: kinds.set, players, subsets: kinds.subset },
      pricedButNoindexed: hidden,
      stillWithoutPrices: INDEXABLE_URLS - total,
    };
  } catch (err) {
    indexed = { error: String(err && err.message) };
  }

  res.json({
    available: true,
    ranNow: ran,
    map: map ? {
      built: map.built, window: `${map.from}..${map.to}`,
      pages: keys.length, byKind: kinds,
      sample: keys.slice(0, 3),
    } : null,
    lastAttempt: attempt,
    indexedReach: indexed,
    // The reading, so the numbers do not have to be re-derived each time.
    //
    // ranNow comes first when present, and that ordering is not cosmetic. KV
    // reads are eventually consistent, so reading the marker straight after
    // this request's own build returns the 'started' value written at its
    // beginning — and the first version of this reported "started and never
    // finished" about a build that had just succeeded in the same request. A
    // diagnostic confidently describing the opposite of what happened is worse
    // than no diagnostic.
    reading: ran
      ? (ran.ok
        ? `A build just ran here and succeeded: ${ran.pages} pages. If a page still shows no block, the fault is in the injection, not the build.`
        : `A build just ran here and failed: ${ran.reason}`)
      : keys.length
        ? 'The map exists and has pages. If a page still shows no block, the fault is in the injection, not the build.'
        : !attempt
          ? 'The cron has never tried. Check that buildPriceBlocks is wired through init().'
          : attempt.state === 'started'
            ? 'A build started and never finished — a timeout or a crash, not a query error.'
            : attempt.state === 'failed'
              ? `The build ran and failed: ${attempt.reason}`
              : 'A build reported success but stored no pages — every page fell below the sales threshold.',
    staleMarkerNote: ran
      ? 'lastAttempt may lag this request: KV reads are eventually consistent.'
      : undefined,
    note: req.query.build === '1'
      ? 'A build was run for this request: two full aggregate passes over sales.'
      : 'Add ?build=1 to run the build now and see its error directly.',
  });
});

app.get('/api/debug/photo-archive', async (req, res) => {
  const db = getNflDb();
  if (!db) return res.json({ available: false, reason: 'no D1 binding' });
  if (!getPhotos()) return res.json({ available: false, reason: 'no R2 binding' });

  const cached = await cacheGet('photoarchive:status:v1');
  if (cached && !req.query.fresh) return res.json(_fromCache(cached));

  try {
    if (!(await _nflHasImageColumn(db))) {
      return res.json({ available: false, reason: 'sales has no image_url column' });
    }
    let cursor = null;
    try { cursor = await cacheGet(PHOTO_CURSOR_KEY); } catch (_) { /* never run */ }
    const from = (cursor && cursor.soldDate) || '0000-00-00';
    const fromId = (cursor && cursor.itemId) || '';

    const HAS = `image_url IS NOT NULL AND image_url <> ''`;
    const [span, ahead] = await Promise.all([
      db.prepare(`SELECT COUNT(*) AS n, MIN(sold_date) AS first, MAX(sold_date) AS last
                    FROM sales WHERE ${HAS}`).first(),
      db.prepare(`SELECT COUNT(*) AS n FROM sales
                   WHERE ${HAS} AND (sold_date > ? OR (sold_date = ? AND item_id > ?))`)
        .bind(from, from, fromId).first(),
    ]);

    const total = (span && Number(span.n)) || 0;
    const left = (ahead && Number(ahead.n)) || 0;
    const done = Math.max(0, total - left);

    const payload = {
      available: true,
      generatedAt: new Date().toISOString(),
      rowsWithAPhoto: total,
      cursor: cursor || null,
      walked: done,
      remaining: left,
      progress: total ? Math.round((100 * done) / total) + '%' : 'n/a',
      oldestSale: span && span.first,
      newestSale: span && span.last,
      batchPerTick: PHOTO_ARCHIVE_BATCH,
      // What to make of it, stated here rather than left to be re-derived.
      reading: !cursor
        ? 'The job has never stored a batch — check the cron logs for [photos].'
        : left === 0
          ? 'Caught up. It is now keeping pace with new sales.'
          : `At ${PHOTO_ARCHIVE_BATCH} per tick and 96 ticks a day, the remainder is about ` +
            `${Math.ceil(left / (PHOTO_ARCHIVE_BATCH * 96))} day(s) of work — IF the cursor is moving. ` +
            'Load this again in an hour: if `walked` has not changed, it is stalled on a row it cannot fetch.',
    };
    cachePut('photoarchive:status:v1', payload, PHOTO_ARCHIVE_TTL);
    res.json(payload);
  } catch (err) {
    console.error('[photo-archive]', err && err.message);
    res.json({ available: false, error: String(err && err.message) });
  }
});

app.get('/api/debug/photo-coverage', async (req, res) => {
  const db = getNflDb();
  if (!db) return res.json({ available: false, reason: 'no dataset' });
  try {
    if (!(await _nflHasImageColumn(db))) {
      return res.json({ available: false, reason: 'this deployment has no image_url column' });
    }
    const newest = await db.prepare(
      'SELECT MAX(sold_date) AS d FROM sales WHERE price_cents IS NOT NULL'
    ).first();
    if (!newest || !newest.d) return res.json({ available: false, reason: 'no data in range' });
    const through = _mkIso(_mkDay(newest.d) - MARKET_EXCLUDE_TRAILING_DAYS);
    const since = _mkIso(_mkDay(through) - 30);

    const HASPIC = `image_url IS NOT NULL AND image_url <> ''`;
    const WINDOW = `price_cents IS NOT NULL AND price_cents > 0
                      AND sold_date > ? AND sold_date <= ?`;
    const HASPAR = `COALESCE(TRIM(parallel), '') <> ''`;

    // How much of each side carries a photo at all.
    const cov = await db.prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN ${HASPIC} THEN 1 ELSE 0 END) AS withPhoto,
         SUM(CASE WHEN ${HASPAR} THEN 1 ELSE 0 END) AS withParallel,
         SUM(CASE WHEN ${HASPAR} AND ${HASPIC} THEN 1 ELSE 0 END) AS referenceable,
         SUM(CASE WHEN NOT (${HASPAR}) AND ${HASPIC} THEN 1 ELSE 0 END) AS matchable
       FROM sales WHERE ${WINDOW}`
    ).bind(since, through).first();

    // The part that actually decides it: how many distinct reference photos
    // exist per (product, set, parallel). A group with one or two photos cannot
    // anchor a match no matter how good the comparison is.
    const groups = await db.prepare(
      `SELECT year, set_name, parallel, COUNT(DISTINCT image_url) AS photos
         FROM sales
        WHERE ${WINDOW} AND ${HASPAR} AND ${HASPIC}
          AND COALESCE(TRIM(year), '') <> '' AND COALESCE(TRIM(set_name), '') <> ''
        GROUP BY LOWER(TRIM(year)), LOWER(TRIM(set_name)), LOWER(TRIM(parallel))`
    ).bind(since, through).all();
    const g = (groups && groups.results) || [];
    const buckets = { '1': 0, '2-4': 0, '5-9': 0, '10+': 0 };
    let usable = 0;
    for (const r of g) {
      const p = Number(r.photos) || 0;
      if (p >= 10) { buckets['10+']++; usable += p; }
      else if (p >= 5) { buckets['5-9']++; usable += p; }
      else if (p >= 2) buckets['2-4']++;
      else buckets['1']++;
    }

    const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 + '%' : null);
    res.json({
      available: true,
      generatedAt: new Date().toISOString(),
      window: { since, through },
      photos: {
        sales: cov.total,
        withPhoto: cov.withPhoto, withPhotoShare: pct(cov.withPhoto, cov.total),
        // The two sides of the idea.
        referenceSet: cov.referenceable,   // known parallel + photo: what we match against
        toIdentify: cov.matchable,         // blank parallel + photo: what we could fix
        toIdentifyShare: pct(cov.matchable, cov.total),
      },
      // A reference group needs several photos to be a reference at all. If
      // most groups sit in the 1 bucket, photo matching cannot work here however
      // good the comparison is, and that is worth knowing before building it.
      referenceGroups: {
        distinct: g.length,
        byPhotoCount: buckets,
        anchored: buckets['5-9'] + buckets['10+'],
        anchoredShare: pct(buckets['5-9'] + buckets['10+'], g.length),
        photosInAnchoredGroups: usable,
      },
      note: 'counts only — no images are fetched or compared here',
    });
  } catch (err) {
    console.error('[photo-coverage]', err && err.stack || err);
    res.json({ available: false, error: err && err.message });
  }
});

app.get('/api/debug/parallel-resolve', async (req, res) => {
  const db = getNflDb();
  if (!db) return res.json({ available: false, reason: 'no dataset' });
  const limit = Math.min(5000, Math.max(100, parseInt(req.query.limit, 10) || 3000));
  const pi = await parallelIndex();
  if (!pi) return res.json({ available: false, reason: 'parallel dictionary unavailable' });
  try {
    const newest = await db.prepare(
      'SELECT MAX(sold_date) AS d FROM sales WHERE price_cents IS NOT NULL'
    ).first();
    if (!newest || !newest.d) return res.json({ available: false, reason: 'no data in range' });
    const throughIso = _mkIso(_mkDay(newest.d) - MARKET_EXCLUDE_TRAILING_DAYS);
    const sinceIso = _mkIso(_mkDay(throughIso) - 30);

    const sample = async (blank) => {
      const r = await db.prepare(
        `SELECT title, parallel, COUNT(*) AS n
           FROM sales
          WHERE price_cents IS NOT NULL AND price_cents > 0
            AND sold_date > ? AND sold_date <= ?
            AND title IS NOT NULL AND title <> ''
            AND COALESCE(TRIM(parallel), '') ${blank ? '=' : '<>'} ''
          GROUP BY title ORDER BY n DESC LIMIT ?`
      ).bind(sinceIso, throughIso, limit).all();
      return (r && r.results) || [];
    };

    // 1. What can be filled in.
    const blanks = await sample(true);
    const by = { matched: 0, base: 0, unmatched: 0, 'no-number': 0 };
    const bySales = { matched: 0, base: 0, unmatched: 0, 'no-number': 0 };
    const unmatched = [];
    let blankSales = 0;
    for (const r of blanks) {
      const hit = pi.resolveParallel(r.title);
      by[hit.how]++; bySales[hit.how] += r.n; blankSales += r.n;
      if (hit.how === 'unmatched') unmatched.push({ segment: hit.segment, sales: r.n, title: r.title });
    }

    // 2. Where the column already has a value, does the title agree?
    const filled = await sample(false);
    let agree = 0, agreeStrict = 0, disagree = 0, noRead = 0;
    // Every row in this sample HAS a parallel, so the reader calling one of
    // them "base" is a known-wrong answer — and the only one of its mistakes
    // that is actionable downstream, which makes it the dangerous one. Reading
    // nothing costs sample; reading base merges a $400 parallel into a $3 card.
    // Lumping it into a single noRead count hid exactly the rate that decides
    // whether the base verdict can be trusted at all.
    const noReadBy = { base: 0, unmatched: 0, 'no-number': 0 };
    const noReadSalesBy = { base: 0, unmatched: 0, 'no-number': 0 };
    let filledSales = 0;
    const falseBaseByKind = {};
    const falseBaseBy = {};
    const falseBaseSalesBy = {};
    const conflicts = [];
    for (const r of filled) {
      const hit = pi.resolveParallel(r.title);
      filledSales += r.n;
      if (hit.how !== 'matched') {
        noRead++;
        if (noReadBy[hit.how] !== undefined) { noReadBy[hit.how]++; noReadSalesBy[hit.how] += r.n; }
        if (hit.how === 'base') {
          // Split by what the column actually holds. "Downtown" is catalogued
          // as an insert SET, not a parallel, so the reader calling that card
          // base is right about parallels and the column is being loose — a
          // different defect from missing a real parallel, and the two need
          // opposite fixes. Without this split the false-base rate cannot be
          // acted on, only worried about.
          const kind = pi.classify(r.parallel);
          falseBaseBy[kind] = (falseBaseBy[kind] || 0) + 1;
          falseBaseSalesBy[kind] = (falseBaseSalesBy[kind] || 0) + r.n;
          // Keep a few of EACH kind. One kind swamps the list otherwise —
          // Downtown alone filled all 15 slots — which hides the only bucket
          // worth acting on behind the one that is already explained.
          const bucket = falseBaseByKind[kind] || (falseBaseByKind[kind] = []);
          if (bucket.length < 8) bucket.push({ column: r.parallel, sales: r.n, title: r.title });
        }
        continue;
      }
      // Two comparisons, because the strict one lies. The column writes "Lazer"
      // where the checklist writes "Lazer Prizms" — the same parallel, counted
      // as a disagreement, which dragged the measured rate down and hid which
      // conflicts were real. Both are reported so neither number can flatter.
      const tidy = (v) => String(v || '').toLowerCase()
        .replace(/[.,&]/g, ' ')
        .replace(/\b(prizms?|refractors?|parallels?|and)\b/g, ' ')
        .replace(/s\b/g, '').replace(/\s+/g, ' ').trim();
      const strictEq = String(hit.parallel).toLowerCase().replace(/s$/, '')
                    === String(r.parallel).toLowerCase().replace(/s$/, '');
      const sameParallel = tidy(hit.parallel) === tidy(r.parallel);
      if (strictEq) agreeStrict++;
      if (sameParallel) agree++;
      else { disagree++; if (conflicts.length < 15) conflicts.push({ column: r.parallel, fromTitle: hit.parallel, sales: r.n, title: r.title }); }
    }

    const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 + '%' : null);
    res.json({
      available: true,
      generatedAt: new Date().toISOString(),
      window: { since: sinceIso, through: throughIso },
      vocabulary: pi.stats,
      blankParallels: {
        titlesSampled: blanks.length, salesCovered: blankSales,
        recoverable: by.matched, recoverableSales: bySales.matched,
        recoverableSalesShare: pct(bySales.matched, blankSales),
        looksLikeBase: by.base, looksLikeBaseSales: bySales.base,
        looksLikeBaseSalesShare: pct(bySales.base, blankSales),
        unreadable: by.unmatched, unreadableSales: bySales.unmatched,
        noCardNumber: by['no-number'], noCardNumberSales: bySales['no-number'],
      },
      // The validation. Reading a lot while agreeing with nothing would mean
      // the segment rule is picking up the wrong part of the title.
      agreementWhereColumnIsSet: {
        titlesSampled: filled.length,
        agree, disagree, titleCouldNotRead: noRead,
        // The one the wiring decision turns on: same parallel, allowing for the
        // product word the column drops.
        agreementRate: pct(agree, agree + disagree),
        // Character-identical, which no one should expect and which is here
        // only so the lenient number cannot quietly become the flattering one.
        exactSpellingRate: pct(agreeStrict, agree + disagree),
        // Why the rest could not be read. Every row here has a parallel, so
        // "base" is the reader being confidently wrong, and its share is the
        // number that decides whether the 46% of blank sales it calls base can
        // be believed. The other two are honest refusals.
        couldNotReadBecause: noReadBy,
        couldNotReadSalesBecause: noReadSalesBy,
        // The one to judge on: of sales that definitely carry a parallel, how
        // often does the reader claim base? Wiring base in writes this rate as
        // wrong labels straight into the index.
        falseBaseSalesShare: pct(noReadSalesBy.base, filledSales),
        // What the column held on those. 'subset' means the column named an
        // insert set, which belongs in set_name — the reader is right that
        // there is no parallel, and the fix is to capture the set. 'parallel'
        // means it named a real parallel the reader missed, which is the only
        // bucket that is a reader defect.
        falseBaseColumnWas: falseBaseBy,
        falseBaseSalesColumnWas: falseBaseSalesBy,
        falseBaseFromRealParallelShare: pct(falseBaseSalesBy.parallel || 0, filledSales),
      },
      // Concrete examples of that mistake, worth more than the rate alone —
      // they show whether it is one broken title shape or a scattering.
      falseBaseExamples: falseBaseByKind,
      conflicts,
      topUnreadable: unmatched.sort((a, b) => b.sales - a.sales).slice(0, 20),
    });
  } catch (err) {
    console.error('[parallel-resolve]', err && err.stack || err);
    res.json({ available: false, error: err && err.message });
  }
});

// ---- the sorting desk ----
//
// Human answers for the cases no rule reaches, at the unit of work where one
// answer is worth the most.
//
// THE ARITHMETIC THAT DECIDES THE UNIT. A month's sample holds 15,917 sales
// across 4,000 distinct titles — so a decision made about one TITLE is worth
// about four sales, and there are ~200,000 titles. That is not a system, it is
// a lifetime. A decision made about one (year, set name) is worth every sale
// ever filed under that spelling, and the unmatched ones cluster hard: 3,385
// sales matched no product at all, and the top twenty spellings carry most of
// them. Tens of decisions against thousands of sales.
//
// So the desk works on SET SPELLINGS, sorted by how many sales each one is
// holding up. It is not a general-purpose card editor and should not become
// one until the same arithmetic says so for another unit.
const SET_ALIAS_KEY = 'setaliases:v1';

async function setAliases() {
  // Two sources, and the order matters.
  //
  // public/data/set-aliases.json holds NAMING FACTS — "topps signature" is what
  // a collector writes for Topps Signature Class. Those belong in the repo:
  // they ship with the deploy, survive a KV wipe, are visible in review and are
  // covered by a test. The desk's KV aliases are one-off human decisions and
  // WIN over the static list, because a person looking at the photos knows
  // something the file does not.
  let base = {};
  try {
    const doc = await _loadJson('set-aliases.json');
    for (const [k, v] of Object.entries(doc || {})) {
      if (!k.startsWith('_') && typeof v === 'string') base[k] = v;
    }
  } catch (err) {
    console.error('[set-aliases] static list unavailable:', err && err.message);
  }
  // archiveGet, not cacheGet: these are written without an expiry because they
  // are decisions, not a cache, and reading them through the cache path would
  // work today only by accident of both using the same namespace.
  try { return { ...base, ...((await archiveGet(SET_ALIAS_KEY)) || {}) }; }
  catch (_) { return base; }
}

// The queue. Every spelling that matched no product, with what it is costing
// and the catalogue's best guesses beside it.
app.get('/api/review/sets', async (req, res) => {
  if (!isAdminReq(req)) return res.status(403).json({ error: 'Forbidden' });
  const db = getNflDb();
  if (!db) return res.json({ available: false, reason: 'no dataset' });
  const days = Math.min(365, Math.max(7, parseInt(req.query.days, 10) || 90));

  try {
    const idx = await _loadJson('checklists/index.json');
    const products = (idx && idx.products) || [];
    const aliases = await setAliases();
    const { index: setIndex } = buildJoinIndex(products, undefined, aliases);

    const newest = await db.prepare(
      'SELECT MAX(sold_date) AS d FROM sales WHERE price_cents IS NOT NULL').first();
    if (!newest || !newest.d) return res.json({ available: false, reason: 'no data in range' });
    const through = _mkIso(_mkDay(newest.d) - MARKET_EXCLUDE_TRAILING_DAYS);
    const since = _mkIso(_mkDay(through) - days);

    // Grouped in SQL, so this reads one row per spelling rather than per sale.
    const Y = _normCol('year'), S = _normCol('set_name');
    const rows = await db.prepare(
      `SELECT ${Y} AS y, ${S} AS s, COUNT(*) AS n,
              SUM(COALESCE(price_cents, 0)) AS cents,
              MAX(title) AS sample
         FROM sales
        WHERE price_cents IS NOT NULL AND price_cents > 0
          AND sold_date > ? AND sold_date <= ?
        GROUP BY y, s
        ORDER BY n DESC LIMIT 400`
    ).bind(since, through).all();

    // Photos, because the card is what you are actually identifying.
    //
    // A spelling is not one card — the blank row alone covered 14,204 sales of
    // many different products — so ONE photo chosen arbitrarily would mislead
    // rather than help. This takes the four most recent per spelling, which is
    // enough to see whether a group is one product or a pile of unrelated ones.
    //
    // One extra query, bounded by the window function, on an admin endpoint
    // nobody hits in a loop. Failure here must not take the desk down: a photo
    // is an aid to the decision, not the decision.
    const photos = new Map();
    if (await _nflHasImageColumn(db)) {
      try {
        const pr = await db.prepare(
          `WITH ranked AS (
             SELECT ${Y} AS y, ${S} AS s, image_url, title,
                    ROW_NUMBER() OVER (PARTITION BY ${Y}, ${S} ORDER BY sold_date DESC) AS rn
               FROM sales
              WHERE price_cents IS NOT NULL AND price_cents > 0
                AND sold_date > ? AND sold_date <= ?
                AND image_url IS NOT NULL AND image_url <> ''
           )
           SELECT y, s, image_url, title FROM ranked WHERE rn <= 4`
        ).bind(since, through).all();
        for (const p of (pr && pr.results) || []) {
          const k = `${p.y}|${p.s}`;
          if (!photos.has(k)) photos.set(k, []);
          photos.get(k).push({ url: p.image_url, title: String(p.title || '').slice(0, 110) });
        }
      } catch (err) {
        console.error('[review/sets] photos unavailable:', err && err.message);
      }
    }

    const open = [];
    let resolvedSales = 0, openSales = 0, unaliasableSales = 0;
    const unaliasable = [];
    for (const r of (rows && rows.results) || []) {
      const n = Number(r.n || 0);
      if (matchSale(setIndex, r.y, r.s)) { resolvedSales += n; continue; }

      // A spelling the join has NO key for cannot be fixed here, and offering it
      // would be worse than useless.
      //
      // saleKeys('', '') returns an empty list — variants() has nothing to build
      // a key from — so matchSale never looks anything up for a sale with no set
      // name. An alias stored against it would sit in KV and never once be
      // consulted, while the desk reported the sales as resolved and nothing
      // changed. That row was the TOP of the live queue at 14,204 sales, so it
      // is the first thing anyone would have tried and the first thing that
      // would have silently done nothing.
      //
      // Still worth reporting: a sale with no set name at all is an ingestion
      // problem, not a spelling problem, and it is fixed in the collector rather
      // than here.
      const keys = saleKeys(r.y, r.s);
      if (!keys.length) {
        unaliasableSales += n;
        if (unaliasable.length < 10) {
          unaliasable.push({ year: r.y || null, setName: r.s || null, sales: n,
                             sample: String(r.sample || '').slice(0, 120) });
        }
        continue;
      }

      openSales += n;
      open.push({
        photos: (photos.get(`${r.y}|${r.s}`) || []).slice(0, 4),
        // Built by saleKeys(), never by hand.
        //
        // The join does not look a sale up by "<year>|<set name>" — variants()
        // strips the year, the sport suffix and a leading maker first, so
        // "2025 Prizm" is looked up as "2025|prizm". An alias keyed the obvious
        // way would sit in KV forever and never be consulted, with nothing
        // thrown to say so. Taking the first key the join itself would try is
        // the only way to be sure the answer lands where the question is asked.
        key: keys[0],
        year: r.y, setName: r.s, sales: n,
        value: Math.round(Number(r.cents || 0) / 100),
        sample: String(r.sample || '').slice(0, 120),
        // The catalogue's nearest names, so the common answer is one keystroke
        // rather than a search. Scored on shared words, which is crude and is
        // meant to be: the human is the judge, this only orders the options.
        suggestions: _nearestProducts(products, r.y, r.s).slice(0, 5),
      });
    }

    res.json({
      available: true,
      generatedAt: new Date().toISOString(),
      window: { since, through, days },
      // The leverage, stated so it can be checked rather than believed.
      // If this ratio is not large the desk is not worth anyone's evening.
      openSpellings: open.length,
      salesHeldUp: openSales,
      // Sales this desk CANNOT help: no set name at all, so the join has no key
      // to alias. Reported rather than queued, so it is visible as an upstream
      // problem instead of sitting at the top looking actionable.
      unaliasableSales,
      unaliasable,
      salesPerDecision: open.length ? Math.round(openSales / open.length) : 0,
      resolvedSales,
      aliasesInPlace: Object.keys(aliases).length,
      queue: open.slice(0, 100),
    });
  } catch (err) {
    console.error('[review/sets]', err && err.stack || err);
    res.json({ available: false, error: err && err.message });
  }
});

// Nearest catalogue products to a spelling, by shared words. Deliberately
// simple: it orders the choices, it does not make them.
function _nearestProducts(products, year, setName) {
  const want = new Set(_setNorm(setName).split(' ').filter(Boolean));
  const y = String(_setNorm(year) || '');
  const scored = [];
  for (const p of products) {
    const name = _setNorm(p.name);
    const words = new Set(name.split(' ').filter(Boolean));
    let shared = 0;
    for (const w of want) if (words.has(w)) shared++;
    // Same year is worth a lot: products are year-scoped and a seller's year
    // column is one of the more reliable things on the row.
    const sameYear = String(_setNorm(p.year)) === y;
    const score = shared * 2 + (sameYear ? 3 : 0);
    if (score > 0) scored.push({ id: p.id, name: p.name, year: p.year, score });
  }
  return scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

// One decision. `productId` null removes an alias rather than storing a null,
// so a mistake is undoable without a deploy.
// ---- the parallel desk -----------------------------------------------------
//
// The manual system that is actually worth someone's evening.
//
// Per-sale curation does not scale. A month's sample holds ~16,700 sales across
// ~4,000 distinct titles, so deciding one sale at a time is worth about four
// sales a click, and nobody clears a backlog at four a click.
//
// The leverage is one layer down, in the PHRASE. When the parallel reader
// fails it does not merely return null — it hands back the exact segment it
// could not match. Rank those segments by the sales they hold up and each
// decision is worth hundreds, because the same phrase recurs across every
// listing of that card and every listing of it next month.
//
// Two answers, and both are useful:
//   "aqua wave speckle" -> a real parallel missing from a checklist
//   "las vegas raiders" -> not a parallel at all; the card is base
//
// The second is the one a purely automatic system can never settle, and it is
// the commonest: a base card's title very often ends in a team name.
const PARALLEL_ALIAS_KEY = 'parallelaliases:v1';

// How close two parallel names read, for ordering the suggestions.
//
// Deliberately crude. This ranks a list a person is about to look at, so it has
// to be roughly right and cost nothing; being cleverer would not change which
// name gets picked. Shared words first, because "gold refractors" and "gold
// interstellar refractors" are neighbours in a way no character-level measure
// captures, then length as a tie-break so the plainer name leads.
function _nameDistance(a, b) {
  const A = new Set(String(a || '').split(' ').filter(Boolean));
  const B = new Set(String(b || '').split(' ').filter(Boolean));
  if (!A.size || !B.size) return 99;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  // Negative so more shared words sorts first; ties broken by how much extra
  // the candidate carries.
  return -shared * 10 + Math.abs(A.size - B.size);
}

async function parallelAliases() {
  // archiveGet, not cacheGet: decisions, not a cache. See setAliases().
  try { return (await archiveGet(PARALLEL_ALIAS_KEY)) || {}; }
  catch (_) { return {}; }
}

// resolveParallel, with the human decisions applied.
//
// Every caller goes through this rather than the reader directly, or a decision
// would improve one screen and not the others — which is precisely how this
// codebase has lost a day twice: two grade readers that disagreed, and two
// search endpoints where only one had the identity check wired in.
//
// A stored '' means "that phrase is not a parallel", which resolves the card as
// BASE. That is a real answer, not an absence, and it must not be confused with
// having read nothing.
// A decision can be SCOPED to one product, because a phrase does not mean the
// same thing everywhere.
//
// Found on the live desk: "signatures" came up holding 45 sales across 2025
// Rookies & Stars AND 2025 Absolute. One global answer would force both to mean
// the same parallel, and there is no reason they should. The word is common —
// so are "premier", "prime", "rookie", "ice" — and each product names its own
// things.
//
// So a decision is stored either globally or under one product, and the lookup
// prefers the specific one. That keeps the leverage where a phrase really does
// mean one thing everywhere (one decision, every product) without forcing it
// where it does not.
//
// Scoped on the sale's own year and set_name rather than a resolved product id:
// it is what the desk displays, it is present at every call site, and it needs
// no join index to compute.
// THE PRINT RUN IS PART OF THE SCOPE, and that is the harder half.
//
// The product split alone is not enough. Inside ONE product the same phrase can
// name different parallels, told apart only by how many were made: a Signatures
// auto and a Signatures /25 carry identical words. The phrase cannot answer it,
// and neither can the product.
//
// So a decision is stored at whichever level the person could actually tell,
// and the lookup takes the most specific one that exists:
//
//   2025|rookies stars|/25|signatures   this product, this print run
//   2025|rookies stars|signatures       this product, any print run
//   signatures                          everywhere
//
// Most specific wins, because a narrower statement is the later thought: a
// global answer is what someone chose as the default, a scoped one is someone
// saying "not here", and "not at this print run" is someone saying it again
// with the card in front of them.
function parallelScope(year, setName) {
  const y = String(year == null ? '' : year).trim().toLowerCase();
  const s = String(setName == null ? '' : setName).trim().toLowerCase().replace(/\s+/g, ' ');
  return (y || s) ? `${y}|${s}` : '';
}

// The keys to try, narrowest first. Exported shape, because the desk has to
// write exactly the key the reader will later look for — a desk that stored a
// key nothing reads is the failure this codebase keeps meeting.
function parallelAliasKeys(seg, year, setName, run) {
  const prod = parallelScope(year, setName);
  const keys = [];
  if (prod && run != null) keys.push(`${prod}|/${run}|${seg}`);
  if (prod) keys.push(`${prod}|${seg}`);
  keys.push(seg);
  return keys;
}

function resolveParallelAliased(pi, text, opts, aliases) {
  const o = opts || {};
  const hit = pi.resolveParallel(text, o);
  if (hit && hit.how === 'unmatched' && aliases) {
    const seg = pi.norm(hit.segment || '');
    if (seg) {
      // The print run is read from the title rather than taken from a column,
      // because the column is blank far more often than the title is silent.
      const run = o.printRun !== undefined ? o.printRun : _printRun(String(text || ''));
      for (const k of parallelAliasKeys(seg, o.year, o.setName, run)) {
        if (Object.prototype.hasOwnProperty.call(aliases, k)) {
          const name = aliases[k];
          return name
            ? { parallel: name, how: 'alias', segment: hit.segment }
            : { parallel: null, how: 'base', segment: hit.segment };
        }
      }
    }
  }
  return hit;
}

// ---- one sale, decided by eye ---------------------------------------------
//
// WHAT THIS IS FOR, AND WHY NOTHING ELSE HERE CAN DO IT.
//
// Every other decision in this file is about TEXT. The set desk says what a
// product name means, the parallel desk says what a phrase means, the insert
// desk says which set a card number belongs to. All three improve a reading of
// the title, and all three are worth hundreds of sales a click because the same
// words recur.
//
// This one is worth exactly one sale, and it exists because some titles are
// simply wrong. A seller who types "Refractor" on a Hyper writes a title that
// every reader in the world will read correctly and get wrong. There is no
// phrase to fix, no checklist to extend and no alias that helps — the words say
// Refractor and the card is not one. The difference is in the foil, and the
// only thing that can settle it is a person looking at the photo.
//
// So the unit is the item_id, and the answer outranks everything: the phrase
// aliases, the reader, and the collector's own parallel column. That last one
// is deliberate and is the part worth arguing with. The column is filled at
// import from the same title, so when the title lies the column inherits the
// lie; a person looking at the card is later and better evidence than a field
// copied from the text they are disagreeing with.
const SALE_OVERRIDE_KEY = 'saleoverrides:v1';

// One card's sales, bounded. A heavily traded rookie can carry thousands, and
// nobody is scrolling past a few hundred photos — the dearest are both the ones
// worth correcting and the ones a mis-grouping distorts most, so the cap sorts
// by price rather than truncating an arbitrary slice.
const SALE_DESK_MAX_SALES = 300;

// How much of the window the queue reads, and how many answers it offers.
// Grouped by title in SQL, so the scan is titles rather than sales; the cap on
// the queue itself is about a screen a person can work through, not a limit on
// what is wrong.
const SALE_QUEUE_SCAN = 4000;
const SALE_QUEUE_MAX = 120;

// A ceiling on how far one title answer reaches. A popular base card can carry
// hundreds of sales, and a single click writing an unbounded number of
// overrides is a click nobody can undo by hand — the response says when it bit.
const SALE_TITLE_MAX_APPLY = 500;

async function saleOverrides() {
  // archiveGet, not cacheGet: these are decisions, not a cache. A cache may be
  // evicted at any time and these must not be.
  try { return (await archiveGet(SALE_OVERRIDE_KEY)) || {}; }
  catch (_) { return {}; }
}

// The stored answer for one sale, or undefined when there is none.
//
// '' is an answer — the card is base — and must never read as "nothing stored".
// A malformed entry returns undefined rather than throwing or resolving to
// base, because losing a sale to a bad KV write would be worse than ignoring
// the write.
function _overrideParallel(itemId, overrides) {
  if (itemId == null || !overrides) return undefined;
  const e = overrides[String(itemId)];
  if (!e || typeof e.parallel !== 'string') return undefined;
  return e.parallel;
}

// What parallel is this ONE sale, with every human decision applied.
//
// The precedence, and the order is the whole point:
//
//   1. an override on this item_id   someone looked at THIS photo
//   2. the parallel column           the collector typed it on import
//   3. a phrase alias                someone decided what this phrase means
//   4. the reader                    the title, read
//
// Every caller goes through this rather than assembling the chain itself.
// Three places grouped sales by parallel and each built that chain inline; a
// decision wired into two of them would be a fix that worked on the board and
// not the card page, which is this codebase's most repeated failure and is
// silent every time.
function _saleParallel(row, pi, pAliases, overrides, player) {
  const r = row || {};
  const ov = _overrideParallel(r.item_id, overrides);
  if (ov !== undefined) {
    return ov ? { parallel: ov, how: 'sale-override', segment: '' }
              : { parallel: null, how: 'base', segment: '' };
  }
  const col = String(r.parallel == null ? '' : r.parallel).trim();
  if (col) return { parallel: col, how: 'column', segment: '' };
  if (!pi) return { parallel: null, how: 'no-reader', segment: '' };
  return resolveParallelAliased(pi, _stripGrade(String(r.title || '')),
                                player ? { player } : {}, pAliases);
}

// ---- the insert desk -------------------------------------------------------
//
// The same idea as the parallel desk, but the unit had to change.
//
// resolveParallel hands back the exact segment it could not place, which is
// what makes a phrase queue possible. resolveSubset does not: it searches the
// whole title for any catalogued set name, so when it fails there is no
// specific phrase to blame. The residue is the entire title.
//
// So the unit here is the CARD — one (product, player, number) that the
// catalogue says belongs to more than one set. 2017 Prizm lists Dalvin Cook #8
// in both Prizm Premier Jerseys and Stained Glass Prizm, and a sale whose title
// names neither is genuinely undecidable from text. But the candidates are
// short and concrete, the photo settles it in a second, and every sale of that
// card shares the answer.
//
// A decision can bind the whole card, or one title under it, for the reason the
// parallel desk needed scopes: sales sharing a key are not always the same
// card, and a person looking at the photos can see which.
const INSERT_ALIAS_KEY = 'insertaliases:v1';

async function insertAliases() {
  try { return (await archiveGet(INSERT_ALIAS_KEY)) || {}; }
  catch (_) { return {}; }
}

function insertAliasKeys(productId, player, cardNumber, title, pi) {
  const base = `${productId}|${pi ? pi.norm(player || '') : String(player || '').toLowerCase()}` +
               `|${String(cardNumber == null ? '' : cardNumber).trim().toLowerCase()}`;
  const keys = [];
  if (title) keys.push(`${base}|${pi ? pi.norm(title) : String(title).toLowerCase()}`);
  keys.push(base);
  return keys;
}

// A jumbo / oversized version: "Jumbo", "Oversized", "Oversize", "Box Topper".
const _OVERSIZE_RE = /\b(jumbos?|oversized?|over-sized?|box[\s-]?toppers?)\b/i;
function _isOversize(title) {
  return _OVERSIZE_RE.test(String(title || ''));
}

// An insert's name for comparing, not showing: "Downtown!" and "Downtown" are
// one set, and the reader returns whichever spelling the title used.
function _subsetKey(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// resolveSubset, with the human decisions applied. Every production caller goes
// through this, or a decision would improve one screen and not the others.
function resolveSubsetAliased(pi, title, ctx, aliases) {
  const hit = pi.resolveSubset(String(title || ''));
  if (hit && hit.subset) return hit;
  if (aliases && ctx && ctx.productId) {
    for (const k of insertAliasKeys(ctx.productId, ctx.player, ctx.cardNumber, title, pi)) {
      if (Object.prototype.hasOwnProperty.call(aliases, k)) {
        const name = aliases[k];
        // '' is a decision that the card is NOT in an insert set — it is the
        // base card — which is a real answer and must not read as "unresolved".
        return name ? { subset: name, how: 'alias' } : { subset: '', how: 'base' };
      }
    }
  }
  return hit;
}

app.get('/api/review/inserts', async (req, res) => {
  if (!isAdminReq(req)) return res.status(403).json({ error: 'Forbidden' });
  const db = getNflDb();
  if (!db) return res.json({ available: false, reason: 'no dataset' });
  const days = Math.min(365, Math.max(7, parseInt(req.query.days, 10) || 90));
  const limit = Math.min(8000, Math.max(200, parseInt(req.query.limit, 10) || 4000));

  try {
    const pi = await parallelIndex();
    if (!pi) return res.json({ available: false, reason: 'parallel dictionary unavailable' });
    const aliases = await insertAliases();
    const ambiguous = await _loadJson('subsets/ambiguous.json');
    const idx = await _loadJson('checklists/index.json');
    const products = (idx && idx.products) || [];
    const setIndex = buildJoinIndex(products, undefined, await setAliases()).index;

    // Arrays in the artifact, Sets here — looked up once per sale.
    const ambByProduct = new Map();
    for (const [pid, byKind] of Object.entries(ambiguous || {})) {
      const all = new Set();
      for (const list of Object.values(byKind || {})) for (const k of list) all.add(k);
      ambByProduct.set(pid, all);
    }

    const newest = await db.prepare(
      'SELECT MAX(sold_date) AS d FROM sales WHERE price_cents IS NOT NULL').first();
    if (!newest || !newest.d) return res.json({ available: false, reason: 'no data in range' });
    const through = _mkIso(_mkDay(newest.d) - MARKET_EXCLUDE_TRAILING_DAYS);
    const since = _mkIso(_mkDay(through) - days);

    const img = await _nflHasImageColumn(db);
    const Y = _normCol('year'), S = _normCol('set_name');
    const P = _normCol('player'), CN = _normCol('card_number');
    const rows = await db.prepare(
      `SELECT title, COUNT(*) AS n, SUM(COALESCE(price_cents, 0)) AS cents,
              ${Y} AS y, ${S} AS s, ${P} AS p, ${CN} AS cn,
              MAX(player) AS player, MAX(card_number) AS card_number
              ${img ? ', MAX(image_url) AS image_url' : ''}
         FROM sales
        WHERE price_cents IS NOT NULL AND price_cents > 0
          AND sold_date > ? AND sold_date <= ?
          AND title IS NOT NULL AND title <> ''
        GROUP BY title ORDER BY n DESC LIMIT ?`
    ).bind(since, through, limit).all();

    const cards = new Map();
    let salesScanned = 0, alreadyDecided = 0, resolvedByTitle = 0;
    for (const r of ((rows && rows.results) || [])) {
      const n = r.n || 0;
      salesScanned += n;
      if (!r.p || !r.cn) continue;
      const product = matchSale(setIndex, r.y, r.s);
      const pid = product && (typeof product === 'string' ? product : product.id);
      if (!pid) continue;
      const key = `${r.p}|${r.cn}`;
      const amb = ambByProduct.get(pid);
      if (!amb || !amb.has(key)) continue;            // only cards that really are ambiguous

      // The title already names the set — nothing for a person to decide.
      if (pi.resolveSubset(String(r.title || '')).subset) { resolvedByTitle += n; continue; }

      if (insertAliasKeys(pid, r.player, r.card_number, r.title, pi)
            .some(k => Object.prototype.hasOwnProperty.call(aliases, k))) {
        alreadyDecided += n;
        continue;
      }

      const id = `${pid}\u0000${key}`;
      let g = cards.get(id);
      if (!g) {
        g = { productId: pid, key, player: r.player, cardNumber: r.card_number,
              sales: 0, value: 0, photos: [], splits: new Map() };
        cards.set(id, g);
      }
      g.sales += n;
      g.value += Math.round((r.cents || 0) / 100);
      if (r.image_url && g.photos.length < 4) g.photos.push(r.image_url);

      const t = String(r.title || '');
      let sp = g.splits.get(t);
      if (!sp) { sp = { title: t, sales: 0, photos: [] }; g.splits.set(t, sp); }
      sp.sales += n;
      if (r.image_url && sp.photos.length < 3) sp.photos.push(r.image_url);
    }

    const top = [...cards.values()].sort((a, b) => b.sales - a.sales).slice(0, 40);

    // The candidate sets, read from the product's own checklist. Only for the
    // rows about to be shown — one file per product, and only for the products
    // that reached the top of the queue.
    const fileCache = new Map();
    for (const g of top) {
      let doc = fileCache.get(g.productId);
      if (doc === undefined) {
        try { doc = await _loadJson(`checklists/${g.productId}.json`); }
        catch (_) { doc = null; }
        fileCache.set(g.productId, doc);
      }
      const [pl, num] = g.key.split('|');
      const seen = new Set();
      g.candidates = [];
      for (const st of ((doc && doc.sets) || [])) {
        for (const c of (st.cards || [])) {
          if (pi.norm(c.player || '') !== pl) continue;
          if (String(c.number == null ? '' : c.number).trim().toLowerCase() !== num) continue;
          if (seen.has(st.id)) break;
          seen.add(st.id);
          g.candidates.push({ id: st.id, name: st.name, category: st.category });
          break;
        }
      }
    }

    const held = top.reduce((n, g) => n + g.sales, 0);
    res.json({
      available: true,
      generatedAt: new Date().toISOString(),
      window: { since, through, days },
      salesScanned,
      // Sales whose title already names the set. The reader's share of the work,
      // reported so the desk's own contribution is visible next to it.
      resolvedByTitle,
      openCards: cards.size,
      salesHeldUp: held,
      salesPerDecision: top.length ? Math.round(held / top.length) : 0,
      decisionsInPlace: Object.keys(aliases).length,
      salesAlreadyFixed: alreadyDecided,
      queue: top.map(g => ({
        productId: g.productId,
        player: g.player,
        cardNumber: g.cardNumber,
        label: `${g.player} #${g.cardNumber}`,
        sales: g.sales,
        value: g.value,
        photos: g.photos,
        candidates: g.candidates || [],
        splits: [...g.splits.values()].sort((a, b) => b.sales - a.sales).slice(0, 8)
          .map(sp => ({ label: sp.title.slice(0, 110), title: sp.title,
                        sales: sp.sales, photos: sp.photos, samples: [sp.title.slice(0, 110)] })),
      })),
    });
  } catch (err) {
    console.error('[review/inserts]', err && err.stack || err);
    res.json({ available: false, error: err && err.message });
  }
});

// One decision: this card (or one title of it) belongs to this set. An empty
// setId means it is the base card, not an insert; omitting it undoes.
app.post('/api/review/inserts', async (req, res) => {
  if (!isAdminReq(req)) return res.status(403).json({ error: 'Forbidden' });
  const { productId, player, cardNumber, setId, title } = req.body || {};
  if (!productId || !player) return res.status(400).json({ error: 'productId and player required' });

  try {
    const pi = await parallelIndex();
    const aliases = await insertAliases();
    const key = insertAliasKeys(productId, player, cardNumber, title || null, pi)[0];

    if (setId === undefined || setId === null) {
      delete aliases[key];
    } else if (setId === '') {
      aliases[key] = '';
    } else {
      // Refuse a set the product does not have. A typo would sit in KV looking
      // like an answer and resolving nothing.
      let doc = null;
      try { doc = await _loadJson(`checklists/${productId}.json`); } catch (_) {}
      const st = ((doc && doc.sets) || []).find(x => x.id === setId || x.name === setId);
      if (!st) return res.status(400).json({ error: `${productId} has no set "${setId}"` });
      aliases[key] = st.name;
    }
    await archivePut(INSERT_ALIAS_KEY, aliases);
    res.json({ ok: true, key, set: aliases[key] === undefined ? null : aliases[key],
               total: Object.keys(aliases).length });
  } catch (err) {
    console.error('[review/inserts:post]', err && err.stack || err);
    res.status(500).json({ error: err && err.message });
  }
});

// The queue: phrases the reader cannot place, most costly first.
app.get('/api/review/parallels', async (req, res) => {
  if (!isAdminReq(req)) return res.status(403).json({ error: 'Forbidden' });
  const db = getNflDb();
  if (!db) return res.json({ available: false, reason: 'no dataset' });
  const days = Math.min(365, Math.max(7, parseInt(req.query.days, 10) || 90));
  const limit = Math.min(8000, Math.max(200, parseInt(req.query.limit, 10) || 4000));

  try {
    const pi = await parallelIndex();
    if (!pi) return res.json({ available: false, reason: 'parallel dictionary unavailable' });
    const aliases = await parallelAliases();

    // The rainbow: every parallel the catalogue lists for a product.
    //
    // Without it the only way to answer is to already know the exact catalogue
    // spelling, and a wrong guess is refused — which turns the screen into a
    // memory test. With it the answer is usually already on the page.
    let parallelsByProduct = {}, setIndex = null;
    try {
      parallelsByProduct = (await _loadJson('parallel-index.json')).parallelsByProduct || {};
      const idx = await _loadJson('checklists/index.json');
      setIndex = buildJoinIndex((idx && idx.products) || [], undefined, await setAliases()).index;
    } catch (err) {
      console.error('[review/parallels] rainbow unavailable:', err && err.message);
    }
    const productOf = (year, setName) => {
      if (!setIndex) return null;
      const hit = matchSale(setIndex, String(year || ''), String(setName || ''));
      return hit ? (typeof hit === 'string' ? hit : hit.id) : null;
    };

    const newest = await db.prepare(
      'SELECT MAX(sold_date) AS d FROM sales WHERE price_cents IS NOT NULL').first();
    if (!newest || !newest.d) return res.json({ available: false, reason: 'no data in range' });
    const through = _mkIso(_mkDay(newest.d) - MARKET_EXCLUDE_TRAILING_DAYS);
    const since = _mkIso(_mkDay(through) - days);

    const img = await _nflHasImageColumn(db);
    // Grouped by title, so this reads one row per spelling rather than per sale
    // and a popular listing does not dominate the scan.
    const rows = await db.prepare(
      `SELECT title, COUNT(*) AS n, SUM(COALESCE(price_cents, 0)) AS cents,
              MAX(player) AS player, MAX(year) AS year, MAX(set_name) AS set_name
              ${img ? ', MAX(image_url) AS image_url' : ''}
         FROM sales
        WHERE price_cents IS NOT NULL AND price_cents > 0
          AND sold_date > ? AND sold_date <= ?
          AND title IS NOT NULL AND title <> ''
          AND COALESCE(TRIM(parallel), '') = ''
        GROUP BY title ORDER BY n DESC LIMIT ?`
    ).bind(since, through, limit).all();

    const seen = new Map();
    let salesScanned = 0, alreadyDecided = 0;
    for (const r of ((rows && rows.results) || [])) {
      const n = r.n || 0;
      salesScanned += n;
      const hit = pi.resolveParallel(_stripGrade(String(r.title || '')), { player: r.player });
      if (!hit || hit.how !== 'unmatched') continue;
      const key = pi.norm(hit.segment || '');
      if (!key) continue;
      // Already settled at ANY level that covers this sale — global, this
      // product, or this product at this print run. Checking only the global
      // key would keep handing back rows a person had already answered.
      const run = _printRun(String(r.title || ''));
      if (parallelAliasKeys(key, r.year, r.set_name, run)
            .some(k => Object.prototype.hasOwnProperty.call(aliases, k))) {
        alreadyDecided += n;
        continue;
      }

      let g = seen.get(key);
      if (!g) {
        g = { phrase: key, sales: 0, value: 0, titles: [], photos: [], splits: new Map() };
        seen.set(key, g);
      }
      g.sales += n;
      g.value += Math.round((r.cents || 0) / 100);
      if (g.titles.length < 4) g.titles.push(String(r.title).slice(0, 110));
      if (r.image_url && g.photos.length < 4) g.photos.push(r.image_url);

      // WHERE THE PHRASE COULD MEAN DIFFERENT THINGS.
      //
      // Broken out by product AND by print run, because both can change the
      // answer: "signatures" spans 2025 Rookies & Stars and 2025 Absolute, and
      // inside one product a Signatures auto and a Signatures /25 are different
      // cards carrying identical words. The desk cannot decide that; it can put
      // the split in front of someone who can.
      const sk = `${r.year || ''}\u0000${r.set_name || ''}\u0000${run == null ? '' : run}`;
      let sp = g.splits.get(sk);
      if (!sp) {
        sp = { year: r.year || '', setName: r.set_name || '', printRun: run,
               sales: 0, titles: [], photos: [] };
        g.splits.set(sk, sp);
      }
      sp.sales += n;
      if (sp.titles.length < 3) sp.titles.push(String(r.title).slice(0, 110));
      if (r.image_url && sp.photos.length < 3) sp.photos.push(r.image_url);
    }

    const queue = [...seen.values()].sort((a, b) => b.sales - a.sales).slice(0, 60)
      .map(g => ({
        phrase: g.phrase,
        sales: g.sales,
        value: g.value,
        samples: g.titles,
        photos: g.photos,
        // What the catalogue already thinks this phrase is. "subset" means it
        // is an insert SET name rather than a parallel — "Stars In The Night"
        // is a Cosmic Chrome insert, and its parallel is base. Saying so stops
        // the screen inviting a guess it will then refuse.
        knownAs: pi.classify(g.phrase),
        // Every parallel listed for the products this phrase turns up in,
        // nearest spelling first, so the answer can be picked rather than
        // remembered.
        candidates: (() => {
          const names = new Set();
          for (const sp of g.splits.values()) {
            const pid = productOf(sp.year, sp.setName);
            for (const nm of (parallelsByProduct[pid] || [])) names.add(nm);
          }
          const want = g.phrase;
          return [...names]
            .map(nm => ({ nm, d: _nameDistance(pi.norm(nm), want) }))
            .sort((a, b) => a.d - b.d || a.nm.localeCompare(b.nm))
            .slice(0, 40).map(x => x.nm);
        })(),
        // Every (product, print run) this phrase turns up in, biggest first.
        // One row means the phrase means one thing and a single decision covers
        // it; several mean a person has to look before answering.
        splits: [...g.splits.values()].sort((x, y) => y.sales - x.sales).slice(0, 8)
          .map(sp => ({
            year: sp.year, setName: sp.setName, printRun: sp.printRun,
            label: [sp.year, sp.setName].filter(Boolean).join(' ')
                 + (sp.printRun == null ? '' : ` /${sp.printRun}`),
            sales: sp.sales, samples: sp.titles, photos: sp.photos,
          })),
      }));

    const held = queue.reduce((n, g) => n + g.sales, 0);
    res.json({
      available: true,
      generatedAt: new Date().toISOString(),
      window: { since, through, days },
      salesScanned,
      openPhrases: seen.size,
      salesHeldUp: held,
      // The number that says whether this is worth an evening. The set desk
      // runs at ~835 sales per decision; if this ever drops to single figures
      // the leverage has gone and the screen should be retired.
      salesPerDecision: queue.length ? Math.round(held / queue.length) : 0,
      decisionsInPlace: Object.keys(aliases).length,
      salesAlreadyFixed: alreadyDecided,
      queue,
    });
  } catch (err) {
    console.error('[review/parallels]', err && err.stack || err);
    res.json({ available: false, error: err && err.message });
  }
});

// ---- the sale desk ---------------------------------------------------------
//
// One card, every sale of it, as photos. Rainbow mode with an eraser.
//
// The queue-shaped desks cannot serve this. They surface what the reader could
// NOT read, and the case here is the opposite: a title the reader read
// confidently and got wrong. Nothing marks it, nothing queues it, and the only
// way it is ever found is a person looking at a card and seeing that one of
// these is not like the others.
//
// So this desk is driven by the person, not by a queue. Name a card, see its
// sales, fix the ones that are wrong. One sale per decision, which is terrible
// leverage and exactly right for the job: it is the last resort for the sales
// no amount of reading can place, and those are usually the expensive ones,
// where a single mis-grouped sale moves an average that people trade on.
app.get('/api/review/sales', async (req, res) => {
  if (!isAdminReq(req)) return res.status(403).json({ error: 'Forbidden' });
  try {
    const db = getNflDb();
    if (!db) return res.json({ available: false, reason: 'no database' });

    const mode = String(req.query.mode || '').trim();
    const q = String(req.query.q || '').trim();
    const player = String(req.query.player || '').trim();
    const cardNumber = String(req.query.cardNumber || '').trim();
    const year = String(req.query.year || '').trim();
    const setName = String(req.query.setName || '').trim();
    const img = await _nflHasImageColumn(db);
    const overrides = await saleOverrides();

    // ---- the queue: sales nothing can read -------------------------------
    //
    // WHY THIS IS NOT THE PARALLEL DESK AGAIN.
    //
    // The parallel desk queues the PHRASE it could not place, and drops any
    // sale whose unreadable segment normalises to nothing:
    //
    //   if (!key) continue;
    //
    // Those sales are not deferred, they are invisible. No phrase to blame
    // means no queue entry, so a title the reader gave up on with nothing to
    // show for it is seen by no screen at all. This is where they go.
    //
    // Grouped by exact title, because an answer about a title is worth every
    // sale that carries it. One decision covering forty sales is the
    // difference between this screen being worth an evening and not.
    //
    // Ranked by money rather than by count. The point is not to empty the pile
    // — at 7,428 unread sales nobody is emptying it — but to fix the ones
    // whose mis-grouping moves a price people trade on.
    if (mode === 'queue') {
      const days = Math.min(Math.max(parseInt(req.query.days, 10) || 90, 1), 400);
      const newest = await db.prepare(
        'SELECT MAX(sold_date) AS d FROM sales WHERE price_cents IS NOT NULL').first();
      if (!newest || !newest.d) return res.json({ available: false, reason: 'no data in range' });
      const through = _mkIso(_mkDay(newest.d) - MARKET_EXCLUDE_TRAILING_DAYS);
      const since = _mkIso(_mkDay(through) - days);

      const rows = await db.prepare(
        `SELECT title, COUNT(*) AS n, SUM(COALESCE(price_cents, 0)) AS cents,
                MAX(player) AS player, MAX(year) AS year, MAX(set_name) AS set_name,
                MAX(card_number) AS card_number, MIN(confidence) AS conf,
                MAX(parallel) AS parallel, MAX(item_id) AS item_id
                ${img ? ', MAX(image_url) AS image_url' : ''}
           FROM sales
          WHERE price_cents IS NOT NULL AND price_cents > 0
            AND sold_date > ? AND sold_date <= ?
            AND title IS NOT NULL AND title <> ''
          GROUP BY title
          ORDER BY SUM(COALESCE(price_cents, 0)) DESC
          LIMIT ?`).bind(since, through, SALE_QUEUE_SCAN).all();

      const pi = await parallelIndex().catch(() => null);
      const pAliases = await parallelAliases().catch(() => ({}));

      // The rainbow, per product, memoised by (year|set) because the queue is
      // long and the same product recurs constantly. Without this the picker
      // has nothing to filter and the screen becomes a spelling test — the
      // exact failure the parallel desk's candidate list was added to fix.
      let byProduct = {}, setIndex = null;
      try {
        byProduct = (await _loadJson('parallel-index.json')).parallelsByProduct || {};
        const cidx = await _loadJson('checklists/index.json');
        setIndex = buildJoinIndex((cidx && cidx.products) || [], undefined, await setAliases()).index;
      } catch (err) {
        console.error('[review/sales] rainbow unavailable:', err && err.message);
      }
      const _rainbow = new Map();
      const rainbowFor = (year, setName) => {
        const k = `${year || ''}|${setName || ''}`;
        if (_rainbow.has(k)) return _rainbow.get(k);
        let names = [];
        try {
          const hit = setIndex && matchSale(setIndex, String(year || ''), String(setName || ''));
          const pid = hit ? (typeof hit === 'string' ? hit : hit.id) : null;
          names = (byProduct[pid] || []).slice().sort((a, b) => a.localeCompare(b));
        } catch (_) { names = []; }
        _rainbow.set(k, names);
        return names;
      };

      const queue = [];
      let scanned = 0, unread = 0, lowConf = 0, lowConfCents = 0, decided = 0;

      for (const r of ((rows && rows.results) || [])) {
        const n = r.n || 0;
        scanned += n;
        const title = String(r.title || '');

        // Below the confidence gate the sale is excluded from every board and
        // every card page by SQL, long before any of this runs. Counted and
        // reported rather than queued: answering the parallel on one would
        // change nothing anyone can see, and offering the work anyway would be
        // the worst kind of busy screen.
        const low = (r.conf != null && r.conf < NFLDB_MIN_CONFIDENCE);
        if (low) { lowConf += n; lowConfCents += (r.cents || 0); continue; }

        // The whole chain, so a title already settled by a phrase alias or by a
        // decision does not come back. Passing the overrides was not optional:
        // without them an answered title stayed in the queue for ever, which is
        // the most demoralising thing a queue can do.
        //
        // One representative item_id is enough. A title answer writes an
        // override for every sale carrying the title, so if one has it they all
        // do — and grouping by title leaves no other id to check.
        const hit = _saleParallel({ title, parallel: r.parallel, item_id: r.item_id },
                                  pi, pAliases, overrides, r.player);
        if (hit && (hit.parallel || hit.how === 'base')) continue;
        unread += n;

        queue.push({
          title: title.slice(0, 140),
          sales: n,
          value: Math.round((r.cents || 0) / 100),
          player: r.player, year: r.year, setName: r.set_name,
          cardNumber: r.card_number,
          photo: img ? (r.image_url || null) : null,
          // What the reader managed before giving up, so the answer can be
          // judged against the same words it choked on.
          segment: (hit && hit.segment) || '',
          how: (hit && hit.how) || 'unread',
          // This product's own parallels, so the answer is picked rather than
          // remembered — and so a typo cannot be saved as one.
          candidates: rainbowFor(r.year, r.set_name),
        });
        if (queue.length >= SALE_QUEUE_MAX) break;
      }

      decided = Object.keys(overrides).length;

      return res.json({
        available: true,
        generatedAt: new Date().toISOString(),
        mode: 'queue',
        window: { since, through, days },
        salesScanned: scanned,
        unreadSales: unread,
        // The number that says whether this screen is worth an evening.
        salesPerDecision: queue.length ? Math.round(unread / queue.length) : 0,
        decisionsInPlace: decided,
        // NOT QUEUED, AND SAID OUT LOUD.
        //
        // These sit below confidence >= 0.5 and are filtered out by SQL in
        // every board, page and desk — so they are invisible rather than
        // merely unread, and a parallel answer on one would change nothing
        // visible. Reported so the size of that hidden pile is known before
        // anyone decides whether it is worth a mechanism of its own.
        lowConfidence: {
          sales: lowConf,
          value: Math.round(lowConfCents / 100),
          threshold: NFLDB_MIN_CONFIDENCE,
          note: 'Excluded by SQL from every board and card page. Answering the '
              + 'parallel on these would not make them appear — they need the '
              + 'confidence gate to admit a human decision, which does not '
              + 'exist yet.',
        },
        queue,
      });
    }
    // ---- find the card -----------------------------------------------------
    //
    // Nothing named yet, so answer with cards rather than sales. Grouped and
    // ranked by how much of it traded: a person opening this screen is looking
    // for a card they have in mind, and the ones worth correcting are the ones
    // with money in them.
    if (!player || !cardNumber) {
      if (!q) return res.json({ available: true, mode: 'find', cards: [],
                                reason: 'name a player, or pick a card' });
      const like = `%${q.toLowerCase()}%`;
      const rows = await db.prepare(
        `SELECT player, year, set_name, card_number, COUNT(*) AS n,
                SUM(price_cents) AS total
           FROM sales
          WHERE price_cents IS NOT NULL AND player IS NOT NULL AND player != ''
            AND (LOWER(player) LIKE ? OR LOWER(title) LIKE ?)
          GROUP BY player, year, set_name, card_number
          ORDER BY SUM(price_cents) DESC
          LIMIT 40`).bind(like, like).all();
      return res.json({
        available: true,
        generatedAt: new Date().toISOString(),
        mode: 'find',
        cards: ((rows && rows.results) || []).map(r => ({
          player: r.player, year: r.year, setName: r.set_name,
          cardNumber: r.card_number, sales: r.n,
          value: Math.round((r.total || 0) / 100),
          label: [r.year, r.set_name, r.player,
                  r.card_number ? `#${r.card_number}` : ''].filter(Boolean).join(' '),
        })),
      });
    }

    // ---- one card, every sale ---------------------------------------------
    const where = ['price_cents IS NOT NULL', 'player = ?', 'card_number = ?'];
    const args = [player, cardNumber];
    if (year) { where.push('year = ?'); args.push(year); }
    if (setName) { where.push('set_name = ?'); args.push(setName); }
    const rows = await db.prepare(
      `SELECT item_id, title, price_cents, sold_date, player, year, set_name,
              parallel, card_number${img ? ', image_url' : ''}
         FROM sales WHERE ${where.join(' AND ')}
        ORDER BY price_cents DESC LIMIT ${SALE_DESK_MAX_SALES}`).bind(...args).all();

    const pi = await parallelIndex().catch(() => null);
    const pAliases = await parallelAliases().catch(() => ({}));
    const list = (rows && rows.results) || [];

    // The rainbow for this product, so the right name is picked rather than
    // remembered — and so a typo cannot be saved as an answer.
    let candidates = [];
    try {
      const byProduct = (await _loadJson('parallel-index.json')).parallelsByProduct || {};
      const idx = await _loadJson('checklists/index.json');
      const setIndex = buildJoinIndex((idx && idx.products) || [], undefined, await setAliases()).index;
      const seen = new Set();
      for (const r of list) {
        const hit = setIndex && matchSale(setIndex, String(r.year || ''), String(r.set_name || ''));
        const pid = hit ? (typeof hit === 'string' ? hit : hit.id) : null;
        for (const nm of (byProduct[pid] || [])) seen.add(nm);
      }
      candidates = [...seen].sort((a, b) => a.localeCompare(b));
    } catch (err) {
      console.error('[review/sales] rainbow unavailable:', err && err.message);
    }

    const sales = list.map(r => {
      const hit = _saleParallel(r, pi, pAliases, overrides, r.player) || {};
      const ov = _overrideParallel(r.item_id, overrides);
      return {
        itemId: String(r.item_id),
        title: r.title,
        price: Math.round((r.price_cents || 0) / 100),
        soldDate: r.sold_date,
        photo: img ? (r.image_url || null) : null,
        // What it currently groups as, and where that came from — so a wrong
        // one can be told from a merely unread one at a glance.
        parallel: hit.parallel || (hit.how === 'base' ? 'Base' : null),
        how: hit.how || 'unread',
        // Whether a person has already answered this sale, and what they said.
        override: ov === undefined ? null : (ov || 'Base'),
        column: String(r.parallel == null ? '' : r.parallel).trim() || null,
      };
    });

    res.json({
      available: true,
      generatedAt: new Date().toISOString(),
      mode: 'card',
      card: { player, cardNumber, year: year || null, setName: setName || null,
              label: [year, setName, player, `#${cardNumber}`].filter(Boolean).join(' ') },
      salesShown: sales.length,
      truncated: sales.length >= SALE_DESK_MAX_SALES,
      decisionsInPlace: Object.keys(overrides).length,
      candidates,
      sales,
    });
  } catch (err) {
    console.error('[review/sales]', err && err.stack || err);
    res.json({ available: false, error: err && err.message });
  }
});

// One sale, decided. `parallel` names it; '' means the card is base; omitting
// it undoes the decision and hands the sale back to the reader.
app.post('/api/review/sales', async (req, res) => {
  if (!isAdminReq(req)) return res.status(403).json({ error: 'Forbidden' });
  const { itemId, parallel, title } = req.body || {};

  // ONE ANSWER, EVERY SALE THAT CARRIES THE TITLE.
  //
  // The desk's first unit was one sale, which is right when someone is looking
  // at one photo that disagrees with its words. It is hopeless as a queue: the
  // unread pile runs to thousands and nobody clicks through it one at a time.
  //
  // So a decision can name a TITLE instead, and applies to every sale with
  // exactly that title in the window. Exactly — not a prefix, not a normalised
  // form — because two titles differing by one word are routinely two
  // different cards, and a loose match here would spread one answer across
  // them silently.
  //
  // It still writes one override per item_id rather than a title rule, so
  // everything downstream keeps reading the same map, and a later sale with the
  // same title is NOT retroactively covered. That is deliberate: it keeps the
  // decision about sales a person's answer was actually based on.
  if (title !== undefined) {
    if (typeof title !== 'string' || !title.trim()) {
      return res.status(400).json({ error: 'title must be a non-empty string' });
    }
    if (parallel !== undefined && parallel !== null && typeof parallel !== 'string') {
      return res.status(400).json({ error: 'parallel must be a string' });
    }
    if (parallel) {
      const pi = await parallelIndex().catch(() => null);
      if (pi && pi.classify(parallel) === 'unknown') {
        return res.status(400).json({ error: `"${parallel}" is not a parallel in any checklist` });
      }
    }
    try {
      const db = getNflDb();
      if (!db) return res.status(503).json({ error: 'no database' });
      const rows = await db.prepare(
        'SELECT item_id FROM sales WHERE title = ? LIMIT ?')
        .bind(title, SALE_TITLE_MAX_APPLY).all();
      const ids = ((rows && rows.results) || []).map(r => String(r.item_id)).filter(Boolean);
      if (!ids.length) return res.status(404).json({ error: 'no sales carry that title' });

      const overrides = await saleOverrides();
      const at = new Date().toISOString();
      for (const id of ids) {
        if (parallel === undefined || parallel === null) delete overrides[id];
        else overrides[id] = { parallel, at };
      }
      await archivePut(SALE_OVERRIDE_KEY, overrides);
      return res.json({ ok: true, title, applied: ids.length,
                        parallel: parallel === undefined ? null : parallel,
                        truncated: ids.length >= SALE_TITLE_MAX_APPLY,
                        total: Object.keys(overrides).length });
    } catch (err) {
      console.error('[review/sales:title]', err && err.stack || err);
      return res.status(500).json({ error: err && err.message });
    }
  }

  if (!itemId || typeof itemId !== 'string') {
    return res.status(400).json({ error: 'itemId or title required' });
  }

  try {
    const overrides = await saleOverrides();
    if (parallel === undefined || parallel === null) {
      delete overrides[itemId];
    } else if (typeof parallel !== 'string') {
      return res.status(400).json({ error: 'parallel must be a string' });
    } else if (parallel === '') {
      // "This one is the base card." A real answer, stored rather than deleted:
      // the absence of a decision and a decision that it is base are different
      // states and only one of them should keep looking wrong.
      overrides[itemId] = { parallel: '', at: new Date().toISOString() };
    } else {
      // Refuse a name no checklist has. A typo would otherwise sit in KV
      // looking like an answer while grouping the sale into a card that does
      // not exist — which is the mis-grouping this screen exists to undo.
      const pi = await parallelIndex().catch(() => null);
      if (pi && pi.classify(parallel) === 'unknown') {
        return res.status(400).json({ error: `"${parallel}" is not a parallel in any checklist` });
      }
      overrides[itemId] = { parallel, at: new Date().toISOString() };
    }
    await archivePut(SALE_OVERRIDE_KEY, overrides);
    res.json({ ok: true, itemId,
               parallel: overrides[itemId] === undefined ? null : overrides[itemId].parallel,
               total: Object.keys(overrides).length });
  } catch (err) {
    console.error('[review/sales:post]', err && err.stack || err);
    res.status(500).json({ error: err && err.message });
  }
});

// One decision. `parallel` names it; an empty string means "not a parallel",
// which reads the card as base; omitting it entirely undoes the decision.
app.post('/api/review/parallels', async (req, res) => {
  if (!isAdminReq(req)) return res.status(403).json({ error: 'Forbidden' });
  const { phrase, parallel, scope } = req.body || {};
  if (!phrase || typeof phrase !== 'string') return res.status(400).json({ error: 'phrase required' });

  try {
    const pi = await parallelIndex();
    const seg = pi ? pi.norm(phrase) : String(phrase).toLowerCase().trim();
    if (!seg) return res.status(400).json({ error: 'phrase normalises to nothing' });

    // How far the decision reaches. No scope means everywhere; a scope pins it
    // to one product, and a print run inside that scope pins it further.
    //
    // The key is built by the SAME function the reader looks up with, rather
    // than assembled here to match. A desk that writes a key nothing reads is
    // the exact failure this codebase keeps meeting, and it is silent.
    const sc = scope && typeof scope === 'object' ? scope : null;
    const run = sc && sc.printRun != null && sc.printRun !== '' ? Number(sc.printRun) : null;
    if (run != null && !Number.isFinite(run)) {
      return res.status(400).json({ error: 'printRun must be a number or null' });
    }
    const key = sc
      ? parallelAliasKeys(seg, sc.year, sc.setName, run)[0]
      : seg;

    const aliases = await parallelAliases();
    if (parallel === undefined || parallel === null) {
      delete aliases[key];
    } else if (parallel === '') {
      // "Not a parallel." Stored, not deleted — the absence of a decision and a
      // decision that the phrase means nothing are different states, and only
      // one of them should keep coming back to the queue.
      aliases[key] = '';
    } else {
      if (typeof parallel !== 'string') return res.status(400).json({ error: 'parallel must be a string' });
      // Refuse a name the catalogue has never heard of. A typo would otherwise
      // sit in KV looking like an answer while resolving nothing.
      if (pi && pi.classify(parallel) === 'unknown') {
        return res.status(400).json({ error: `"${parallel}" is not a parallel in any checklist` });
      }
      aliases[key] = parallel;
    }
    await archivePut(PARALLEL_ALIAS_KEY, aliases);
    res.json({ ok: true, phrase: seg, key,
               scope: sc ? { year: sc.year || '', setName: sc.setName || '', printRun: run } : null,
               parallel: aliases[key] === undefined ? null : aliases[key],
               total: Object.keys(aliases).length });
  } catch (err) {
    console.error('[review/parallels:post]', err && err.stack || err);
    res.status(500).json({ error: err && err.message });
  }
});

app.post('/api/review/sets', async (req, res) => {
  if (!isAdminReq(req)) return res.status(403).json({ error: 'Forbidden' });
  const { key, productId } = req.body || {};
  if (!key || typeof key !== 'string') return res.status(400).json({ error: 'key required' });

  try {
    const aliases = await setAliases();
    if (productId) {
      const idx = await _loadJson('checklists/index.json');
      const products = (idx && idx.products) || [];
      // Refuse an id the catalogue does not have. A typo would otherwise sit in
      // KV looking like an answer and resolving nothing, which is the failure
      // shape this whole session keeps running into.
      if (!products.some(p => String(p.id) === String(productId))) {
        return res.status(400).json({ error: `no product with id ${productId}` });
      }
      aliases[key] = String(productId);
    } else {
      delete aliases[key];
    }
    // No TTL: these are decisions, not a cache. cachePut always attaches an
    // expiry, so this uses the archive writer that does not.
    await archivePut(SET_ALIAS_KEY, aliases);
    res.json({ ok: true, key, productId: productId || null, total: Object.keys(aliases).length });
  } catch (err) {
    console.error('[review/sets POST]', err && err.message);
    res.status(500).json({ error: err && err.message });
  }
});

// ---- /api/debug/identity-gap ----
// Where card identity actually breaks, and what each available signal would fix.
//
// This exists to settle a question rather than to monitor one: is it worth
// reading photos to tell a base card from an insert? The case for it is real —
// a product is not one list of cards. 2017 Panini Prizm is a 300-card base set
// plus fourteen inserts, and EVERY insert restarts numbering at #1. The sales
// table has a single `set_name` column holding the PRODUCT, so a base #8, an
// Instant Impact #8 and an NFL MVP #8 are all "Prizm #8".
//
// But the checklists already answer most of that, and cheaply. Against 2017
// Prizm's own catalogue, only 13 of 687 (player, number) pairs belong to more
// than one set — 1.9%. Patrick Mahomes has nine cards in that product and every
// one carries a different number. So for the overwhelming majority the number
// IS the answer, and no photo is needed.
//
// What no local check can measure is how often the number is missing from the
// data entirely. That is what this reports, over real sales, so the decision
// rests on a measurement instead of on either of our intuitions.
//
// Costed like the other diagnostics: one grouped, limited scan, not a walk of
// the table.
// Is this unmatched row a missing vintage set, or a modern throwback?
//
// Panini and Topps both reissue old designs — a 2024 Donruss insert built on
// the 1989 Score look, a Topps Chrome anniversary set on the 1986 layout. The
// collector reads the design year off the front of the card and files the sale
// under it, so "1989 | score" can mean a checklist we never wrote OR a 2024
// card that will never need one.
//
// The tell is that the modern product names BOTH years and the real one is
// larger. A genuine 1984 Topps listing says 1984 and nothing later. Tolerant of
// a season span by one year, so "2023-24" does not read as disagreement.
function _yearDisagrees(yearAndSet, title) {
  const rowYear = parseInt(String(yearAndSet).split('|')[0].trim(), 10);
  if (!Number.isFinite(rowYear)) return false;
  const years = String(title || '').match(/\b(?:19|20)\d{2}\b/g) || [];
  return years.some(y => parseInt(y, 10) > rowYear + 1);
}

app.get('/api/debug/identity-gap', async (req, res) => {
  const db = getNflDb();
  if (!db) return res.json({ available: false, reason: 'no dataset' });
  const limit = Math.min(6000, Math.max(200, parseInt(req.query.limit, 10) || 4000));
  const pi = await parallelIndex();
  if (!pi) return res.json({ available: false, reason: 'parallel dictionary unavailable' });

  try {
    const newest = await db.prepare(
      'SELECT MAX(sold_date) AS d FROM sales WHERE price_cents IS NOT NULL'
    ).first();
    if (!newest || !newest.d) return res.json({ available: false, reason: 'no data in range' });
    const throughIso = _mkIso(_mkDay(newest.d) - MARKET_EXCLUDE_TRAILING_DAYS);
    const sinceIso = _mkIso(_mkDay(throughIso) - 30);

    // year/set_name/player come back normalised by SQL, because the ambiguity
    // map is keyed with the JS norm() and the two have to agree exactly. This
    // is the failure mode subset-attribution.test.js was written for: if the
    // normalisers drift by so much as a hyphen every lookup misses, nothing is
    // thrown, and the answer is a confident zero.
    const Y = _normCol('year'), S = _normCol('set_name');
    const P = _normCol('player'), CN = _normCol('card_number');
    const rows = await db.prepare(
      `SELECT title, card_number, parallel, set_name, COUNT(*) AS n,
              ${Y} AS y, ${S} AS s, ${P} AS p, ${CN} AS cn
         FROM sales
        WHERE price_cents IS NOT NULL AND price_cents > 0
          AND sold_date > ? AND sold_date <= ?
          AND title IS NOT NULL AND title <> ''
        GROUP BY title ORDER BY n DESC LIMIT ?`
    ).bind(sinceIso, throughIso, limit).all();

    const list = (rows && rows.results) || [];

    // How many of these sales land on a card whose identity is genuinely
    // uncertain — a (player, number) that belongs to more than one set in its
    // product, so the sales row cannot say which card it is.
    //
    // Loaded lazily and tolerated when absent: an old deploy has no artifact,
    // and a diagnostic that 500s because an optional map is missing is worse
    // than one that reports what it can.
    let ambiguous = null, products = null, setIndex = null;
    try {
      ambiguous = await _loadJson('subsets/ambiguous.json');
      const idx = await _loadJson('checklists/index.json');
      products = (idx && idx.products) || [];
      // WITH aliases, because the pricing join uses them and a diagnostic that
      // disagrees with production is worse than none.
      //
      // Without this, a spelling someone has already fixed — on the desk, or in
      // set-aliases.json — stays in topUnmatchedSets forever. The queue then
      // sends the next person to solve a solved problem, and no amount of work
      // ever visibly reduces it. That is exactly how a tool stops being used.
      setIndex = buildJoinIndex(products, undefined, await setAliases()).index;
    } catch (err) {
      console.error('[identity-gap] ambiguity map unavailable:', err && err.message);
    }
    // Arrays in the artifact, Sets here — this is looked up once per row.
    // Keyed by product then kind, because which KIND of collision a sale sits
    // on decides what could fix it and the totals alone pointed at the wrong
    // work entirely.
    const ambSets = new Map();
    if (ambiguous) {
      for (const [pid, byKind] of Object.entries(ambiguous)) {
        const m = new Map();
        for (const [kind, keys] of Object.entries(byKind || {})) m.set(kind, new Set(keys));
        ambSets.set(pid, m);
      }
    }
    const HAS_NUM = /#\s*[A-Za-z0-9-]+/;

    let sales = 0;
    const numbered = { column: 0, title: 0, either: 0, neither: 0 };
    const salesBy = { numberEither: 0, numberNeither: 0, subsetNamed: 0,
                      rescuable: 0, stillUnidentified: 0 };
    // The measurement this endpoint was extended for.
    const amb = { matchedProduct: 0, onAmbiguousKey: 0, ambiguousAndNamed: 0,
                  ambiguousUnnamed: 0, noProduct: 0, byKind: {}, resolvable: {} };
    const ambiguousExamples = [];
    const noProductBy = new Map();
    const unidentifiedExamples = [];
    const rescuableExamples = [];
    const subsetsSeen = new Map();

    for (const r of list) {
      const n = r.n || 0;
      sales += n;
      const hasCol = !!String(r.card_number == null ? '' : r.card_number).trim();
      const hasTitle = HAS_NUM.test(String(r.title || ''));
      if (hasCol) numbered.column++;
      if (hasTitle) numbered.title++;

      const sub = pi.resolveSubset(String(r.title || ''));
      if (sub.subset) {
        subsetsSeen.set(sub.subset, (subsetsSeen.get(sub.subset) || 0) + n);
        salesBy.subsetNamed += n;
      }

      // Does this sale sit on a key that names more than one card?
      //
      // Only answerable when the sale resolves to a product, so the unresolved
      // ones are counted separately rather than folded into "not ambiguous" —
      // which would read as reassurance and would be nothing of the kind.
      if (setIndex && r.p && r.cn) {
        const product = matchSale(setIndex, r.y, r.s);
        if (!product) {
          amb.noProduct += n;
          // WHICH year and set fail to match, not just how many.
          //
          // A fifth of sampled sales resolve to no product at all, and that is
          // a bigger hole than any of the identity fixes — a sale outside the
          // catalogue cannot be helped by reading its parallel, its kind or its
          // insert, because there is nothing to read it against. The number
          // alone cannot say whether that is a missing checklist, a set name
          // the join cannot spell, or something that is not an NFL card.
          //
          // A TITLE comes with it, because the year and set name alone cannot
          // be trusted to mean what they look like. Modern products ship
          // throwback and anniversary designs, and a collector reading "1989
          // Score" off a 2024 Donruss insert files it under 1989 — so a row
          // reading "1989 | score" may be a missing vintage checklist or may be
          // a modern card wearing an old jacket. Those need opposite work, and
          // one sample title separates them at a glance.
          const ys = `${r.y || '?'} | ${r.s || '?'}`;
          const prev = noProductBy.get(ys);
          if (prev) { prev.sales += n; if (n > prev.top) { prev.top = n; prev.sample = r.title; } }
          else noProductBy.set(ys, { sales: n, top: n, sample: r.title });
        } else {
          amb.matchedProduct += n;
          const byKind = ambSets.get(product.id);
          const key = `${r.p}|${r.cn}`;
          let kind = null;
          if (byKind) {
            for (const [k, set] of byKind) if (set.has(key)) { kind = k; break; }
          }
          if (kind) {
            amb.onAmbiguousKey += n;
            amb.byKind[kind] = (amb.byKind[kind] || 0) + n;

            // What would actually resolve this sale, by kind. These are
            // different signals and conflating them is what made the flat
            // number misleading.
            //
            //   auto      the title says "auto"/"patch"/"relic" — sellers never
            //             leave it off, it is most of the price
            //   insert    the title names the insert — what resolveSubset reads
            //   variation neither; an Etch against an Image variation of one
            //             base card is not distinguishable from a title
            const t = String(r.title || '');
            const saysAuto = /\b(auto|autograph|autographed|signed|patch|relic|jersey|mem)\b/i.test(t);
            if (kind === 'auto') {
              if (saysAuto) amb.resolvable[kind] = (amb.resolvable[kind] || 0) + n;
            } else if (kind === 'insert') {
              if (sub.subset) amb.resolvable[kind] = (amb.resolvable[kind] || 0) + n;
            }

            const resolved = kind === 'auto' ? saysAuto : kind === 'insert' ? !!sub.subset : false;
            if (resolved) amb.ambiguousAndNamed += n;
            else {
              amb.ambiguousUnnamed += n;
              if (ambiguousExamples.length < 12) {
                ambiguousExamples.push({ product: product.id, key, kind,
                                         sales: n, title: r.title });
              }
            }
          }
        }
      }

      if (hasCol || hasTitle) {
        numbered.either++;
        salesBy.numberEither += n;
        continue;
      }
      // No number anywhere. This is the population a photo would have to serve.
      numbered.neither++;
      salesBy.numberNeither += n;
      if (sub.subset) {
        // The title names a catalogued insert, so the SET is known even though
        // the card is not — which is most of what a photo was going to tell us,
        // available from text for nothing.
        salesBy.rescuable += n;
        if (rescuableExamples.length < 12) {
          rescuableExamples.push({ subset: sub.subset, sales: n, title: r.title });
        }
      } else {
        salesBy.stillUnidentified += n;
        if (unidentifiedExamples.length < 15) {
          unidentifiedExamples.push({ sales: n, title: r.title });
        }
      }
    }

    const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 + '%' : null);
    res.json({
      available: true,
      generatedAt: new Date().toISOString(),
      window: { since: sinceIso, through: throughIso },
      titlesSampled: list.length,
      salesCovered: sales,

      // The first question: is the card number there at all?
      cardNumber: {
        titlesWithColumn: numbered.column,
        titlesWithNumberInTitle: numbered.title,
        titlesWithEither: numbered.either,
        titlesWithNeither: numbered.neither,
        salesWithANumber: salesBy.numberEither,
        salesWithNoNumber: salesBy.numberNeither,
        salesWithNoNumberShare: pct(salesBy.numberNeither, sales),
      },

      // The second: for the numberless ones, does the title name the set?
      //
      // This is the whole photo question in one number. A sale with no card
      // number but a named insert is one text can place; a sale with neither is
      // the only population a photo could help, and it is the honest ceiling on
      // what photo matching could ever be worth here.
      subsetFromTitle: {
        salesNamingASubset: salesBy.subsetNamed,
        salesNamingASubsetShare: pct(salesBy.subsetNamed, sales),
        numberlessRescuedBySubset: salesBy.rescuable,
        numberlessRescuedShare: pct(salesBy.rescuable, salesBy.numberNeither),
        ceilingForPhotoMatching: salesBy.stillUnidentified,
        ceilingForPhotoMatchingShare: pct(salesBy.stillUnidentified, sales),
        topSubsets: [...subsetsSeen.entries()]
          .sort((a, b) => b[1] - a[1]).slice(0, 15)
          .map(([name, n]) => ({ subset: name, sales: n })),
      },

      // ---- the number the decision rests on ----
      //
      // A key that belongs to more than one set in its product is a sale whose
      // card cannot be determined from the columns alone: every insert restarts
      // numbering at #1 and `set_name` holds the PRODUCT, so those sales are
      // currently grouped together whether or not they are the same card.
      //
      // `named` is the share of those the title already resolves, because it
      // names the insert. That is what reading subsets would recover. `unnamed`
      // is what would be left — and the honest thing to do with those is mark
      // them unresolved, not merge them.
      ambiguity: ambiguous ? {
        salesResolvedToAProduct: amb.matchedProduct,
        salesOnAnAmbiguousKey: amb.onAmbiguousKey,
        salesOnAnAmbiguousKeyShare: pct(amb.onAmbiguousKey, amb.matchedProduct),
        ofThoseTitleNamesTheInsert: amb.ambiguousAndNamed,
        resolvableByReadingTheSubset: pct(amb.ambiguousAndNamed, amb.onAmbiguousKey),
        wouldRemainUnresolved: amb.ambiguousUnnamed,
        // The breakdown that changed the recommendation. A flat total said a
        // third of sales were unidentifiable; two thirds of that turned out to
        // be a base card against its own autograph, which one word in the title
        // settles. Only the `insert` row is what reading insert names is for.
        byKind: amb.byKind,
        resolvableByKind: amb.resolvable,
        kindShares: Object.fromEntries(Object.entries(amb.byKind)
          .map(([k, v]) => [k, pct(v, amb.onAmbiguousKey)])),
        // Not folded into "unambiguous": a sale we could not match to a product
        // has an unknown answer, not a reassuring one.
        salesWithNoProductMatch: amb.noProduct,
        // The year and set names carrying the most unmatched sales. This is
        // the list to act on: each line is either a checklist that does not
        // exist, a spelling the join cannot reach, or a sport this site does
        // not cover.
        topUnmatchedSets: [...noProductBy.entries()]
          .sort((x, y) => y[1].sales - x[1].sales).slice(0, 20)
          .map(([ys, v]) => ({
            yearAndSet: ys,
            sales: v.sales,
            // The commonest title filed under this spelling. If its own year
            // disagrees with the row's year, the row is a throwback design and
            // no vintage checklist will fix it.
            sample: String(v.sample || '').slice(0, 90),
            looksLikeAThrowback: _yearDisagrees(ys, v.sample),
          })),
        catalogueKeysAmbiguous: Object.values(ambiguous).reduce(
          (n, byKind) => n + Object.values(byKind || {}).reduce((m, l) => m + l.length, 0), 0),
      } : { unavailable: 'subsets/ambiguous.json not deployed' },

      // Worth more than the rates: whether the leftovers are one broken title
      // shape or a genuine scattering.
      ambiguousExamples,
      rescuableExamples,
      unidentifiedExamples,

      // Stated here so the number above is read against something. Colour
      // fingerprinting was built, run over real photos and measured at 37%
      // accuracy on the cards it committed to, against 95.6% for reading the
      // title. It is disabled in .github/workflows/fingerprint.yml, and the
      // post-mortem there names the reason: averaging a photo down to sixteen
      // bins of colour throws away pattern and texture, which is exactly what
      // separates one silver card from another.
      priorAttempt: {
        method: 'colour-only photo signature',
        accuracyOnCommitted: '37%',
        titleBaseline: '95.6%',
        status: 'disabled',
      },
    });
  } catch (err) {
    console.error('[identity-gap]', err && err.stack || err);
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
                        AND ${titleClean} THEN 1 ELSE 0 END) AS before_junk,
              SUM(CASE WHEN ${_rsiUngradedCol('grade')} AND ${_rsiUngradedCol('grader')}
                        AND ${titleClean} AND NOT ( ${_rsiJunkSql(T)} )
                       THEN 1 ELSE 0 END) AS raw_final,
              SUM(CASE WHEN title IS NULL OR title = '' THEN 1 ELSE 0 END) AS no_title,
              SUM(CASE WHEN COALESCE(TRIM(year), '') <> '' THEN 1 ELSE 0 END) AS has_year,
              SUM(CASE WHEN COALESCE(TRIM(set_name), '') <> '' THEN 1 ELSE 0 END) AS has_set,
              SUM(CASE WHEN COALESCE(TRIM(parallel), '') <> '' THEN 1 ELSE 0 END) AS has_parallel,
              SUM(CASE WHEN COALESCE(TRIM(year), '') <> '' AND COALESCE(TRIM(set_name), '') <> ''
                        AND COALESCE(TRIM(parallel), '') <> '' THEN 1 ELSE 0 END) AS identified
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
          AND NOT ( ${_rsiJunkSql(T)} )
        GROUP BY title ORDER BY n DESC LIMIT 5`
    ).bind(sinceIso, throughIso).all();

    // ---- what a grade-word rule WOULD cost, before anyone writes one ----
    //
    // The tempting next fix is to read "GEM MT 10" as a slab. grade-core
    // refuses to, on purpose: a seller calling a loose card "gem mint" is
    // describing its corners, not saying it is in a holder, and catching that
    // would invent grades for raw cards — the same corruption as missing a
    // slab, pointing the other way.
    //
    // Which way that trade falls is a number, not an opinion, and nobody has
    // had the number. So this counts how many sales the rule would actually
    // move, per phrasing, among the rows that survive as Raw today. Reading
    // them against sampleRawTitles says whether they are slabs or sellers.
    const gradeWordProbe = async () => {
      const pats = {
        'gem mt <n>': ["%gem mt 10%", "%gem mt10%", "%gem mt 9%"],
        'gem mint <n>': ["%gem mint 10%", "%gem mint10%", "%gem mint 9%"],
        'mint <n>, no "gem"': ["%mint 9%", "%mint 10%"],
        'pristine/black label': ["%pristine 10%", "%black label%"],
      };
      const out = {};
      for (const [label, likes] of Object.entries(pats)) {
        const any = likes.map(() => `${T} LIKE ?`).join(' OR ');
        const r = await db.prepare(
          `SELECT COUNT(*) AS n FROM sales
            WHERE price_cents IS NOT NULL AND price_cents > 0
              AND sold_date > ? AND sold_date <= ?
              AND ${_rsiUngradedCol('grade')} AND ${_rsiUngradedCol('grader')}
              AND ${titleClean} AND ( ${any} )`
        ).bind(sinceIso, throughIso, ...likes).first();
        out[label] = (r && r.n) || 0;
      }
      return out;
    };

    // Counted per phrase, over the rows the grade stages already passed, so a
    // phrase that is quietly eating real cards is visible rather than inferred.
    const junkProbe = async () => {
      const out = {};
      for (const w of RSI_JUNK_WORDS) {
        const r = await db.prepare(
          `SELECT COUNT(*) AS n FROM sales
            WHERE price_cents IS NOT NULL AND price_cents > 0
              AND sold_date > ? AND sold_date <= ?
              AND ${_rsiUngradedCol('grade')} AND ${_rsiUngradedCol('grader')}
              AND ${titleClean} AND ${T} LIKE ?`
        ).bind(sinceIso, throughIso, `%${w}%`).first();
        const n = (r && r.n) || 0;
        if (n > 0) out[w] = n;
      }
      return out;
    };

    const p = funnel || {};
    const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 + '%' : null);
    res.json({
      available: true,
      generatedAt: new Date().toISOString(),
      window: { since: sinceIso, through: throughIso },
      funnel: {
        pricedSales: p.priced,
        afterGradeCheck: p.grade_ok, afterGradeCheckShare: pct(p.grade_ok, p.priced),
        afterGraderCheck: p.grader_ok, afterGraderCheckShare: pct(p.grader_ok, p.priced),
        afterTitleCheck: p.before_junk, afterTitleCheckShare: pct(p.before_junk, p.priced),
        // Titles that name no single card — seller templates, lots, break
        // spots. Removed last so the grade stages above read unchanged.
        junkTitlesRemoved: (p.before_junk || 0) - (p.raw_final || 0),
        rawFinal: p.raw_final, rawFinalShare: pct(p.raw_final, p.priced),
        salesWithNoTitle: p.no_title,
      },
      // What the card-identity rule costs. A sale needs all three to be
      // indexable, because a blank parallel is not "base" — it is unreadable,
      // and pooling unreadable sales prices a base against a patch.
      cardIdentity: {
        hasYear: p.has_year, hasYearShare: pct(p.has_year, p.priced),
        hasSet: p.has_set, hasSetShare: pct(p.has_set, p.priced),
        hasParallel: p.has_parallel, hasParallelShare: pct(p.has_parallel, p.priced),
        fullyIdentified: p.identified, fullyIdentifiedShare: pct(p.identified, p.priced),
      },
      // If the biggest loss is at a column stage, the values below say why.
      graderValues: await top('grader'),
      gradeValues: await top('grade'),
      sampleRawTitles: ((survivors && survivors.results) || [])
        .map(r => ({ title: r.title, player: r.player, sales: r.n })),
      // Sales still counted as Raw whose titles carry grading language that
      // grade-core deliberately does not act on. These are candidates, not
      // errors: the count is what a rule would move, and the decision to
      // write one needs this number next to sampleRawTitles.
      gradeWordCandidates: await gradeWordProbe(),
      // What the junk filter actually removed, per phrase. A phrase with a
      // surprising count is one to look at: every entry here is a substring,
      // and a substring that matches a real card title is a silent loss of
      // real sales rather than a visible error.
      junkByPattern: await junkProbe(),
      ungradedTreatedAs: RSI_UNGRADED_VALUES.map(v => v === '' ? '(empty)' : v),
    });
  } catch (err) {
    console.error('[raw-filter]', err && err.stack || err);
    res.json({ available: false, error: err && err.message });
  }
});

// ---- /api/debug/grade-gap ----
// Is a card's grade ever ONLY in the photo? The question that decides whether
// reading slab labels with image recognition is worth building.
//
// A 2025 Prizm Mahomes Silver came back with a PSA slab and a CGC slab sitting
// in its Raw list. The obvious reading is that the grade is printed on the slab
// and nowhere else, and therefore that OCR is the fix. OCR is a real build —
// a vendor API or a model, a per-image cost, a backfill over ~340,000 stored
// photos and a pipeline to keep it fed — and the last image-recognition attempt
// in this repo scored 37% where reading the title scored 95.6%. So the premise
// gets measured before anything is built.
//
// WHY THIS CAN BE ANSWERED WITHOUT LOOKING AT A SINGLE PHOTO.
//
// Some sales already carry eBay's structured grader/grade fields, filled in by
// the seller from a fixed list. Those rows are a labelled set: we know they are
// slabs without reading anything. So ask how often a KNOWN slab's title fails
// to mention it. That share is the rate at which the text loses a grade we can
// prove was there — and it is the only honest evidence available for how much
// grade is hiding in the rows where the columns are empty too.
//
// Three outcomes, three different fixes, which is the whole reason to measure:
//
//   known slab, title names the grader  -> the text carries it; if such a sale
//                                          is in a Raw list, gradeBucket has a
//                                          bug and OCR would fix nothing
//   known slab, title silent            -> text genuinely loses grades, and the
//                                          size of this is the case for OCR
//   columns empty, title names a grader -> already caught; a control that
//                                          proves the title reader runs at all
//
// THE LIMIT, stated because a number this load-bearing must not be read as more
// than it is: sales with populated columns are not a random sample of all
// sales. A seller who fills in eBay's grading fields is likelier to write the
// grade in the title as well, so this UNDERSTATES how often grade is missing
// from the silent rows. It bounds the decision, it does not settle it.
//
// Costed like its neighbours: one aggregate pass over the window plus two small
// grouped samples, not a walk of the table.
app.get('/api/debug/grade-gap', async (req, res) => {
  const db = getNflDb();
  if (!db) return res.json({ available: false, reason: 'no dataset' });
  try {
    const newest = await db.prepare(
      'SELECT MAX(sold_date) AS d FROM sales WHERE price_cents IS NOT NULL'
    ).first();
    if (!newest || !newest.d) return res.json({ available: false, reason: 'no data in range' });
    const throughIso = _mkIso(_mkDay(newest.d) - MARKET_EXCLUDE_TRAILING_DAYS);
    const sinceIso = _mkIso(_mkDay(throughIso) - 30);

    // Substring LIKEs over one LOWER(), for the reason given on RSI_GRADER_WORDS
    // — the word-boundary version of this predicate took the market index from
    // 950ms to 1,972ms against a 2,000ms budget. The tokens in that list are
    // chosen so they cannot occur inside an ordinary word, and the graders that
    // CAN ('isa' in "Isaiah", 'tag' in "vintage", 'ags' in "flags") are absent
    // from it deliberately.
    const T = "LOWER(COALESCE(title, ''))";
    const anyWord = (words) => words.map(w => `${T} LIKE '%${w}%'`).join(' OR ');
    const namesGrader = `( ${anyWord(RSI_GRADER_WORDS)} )`;
    // "graded" minus the two words that contain it. "ungraded" is a raw claim,
    // not a slab, and counting it as slab language here would manufacture the
    // very population this endpoint exists to size.
    const slabWords = `( ${anyWord(RSI_SLAB_WORDS)}
                      OR ( ${T} LIKE '%graded%'
                           AND ${T} NOT LIKE '%ungraded%'
                           AND ${T} NOT LIKE '%upgraded%' ) )`;
    const titleSilent = `NOT ${namesGrader} AND NOT ${slabWords}`;
    // At least one column says something other than "not graded". Either alone
    // is enough: eBay's grader field is filled far more often than its grade
    // field, and requiring both would discard most of the labelled set.
    const colGraded = `NOT ( ${_rsiUngradedCol('grade')} AND ${_rsiUngradedCol('grader')} )`;

    const f = await db.prepare(
      `SELECT COUNT(*) AS priced,
              SUM(CASE WHEN ${colGraded} THEN 1 ELSE 0 END) AS known_slab,
              SUM(CASE WHEN ${colGraded} AND ${namesGrader} THEN 1 ELSE 0 END) AS known_title_names,
              SUM(CASE WHEN ${colGraded} AND NOT ${namesGrader} AND ${slabWords}
                       THEN 1 ELSE 0 END) AS known_title_hints,
              SUM(CASE WHEN ${colGraded} AND ${titleSilent} THEN 1 ELSE 0 END) AS known_title_silent,
              SUM(CASE WHEN NOT ${colGraded} THEN 1 ELSE 0 END) AS cols_empty,
              SUM(CASE WHEN NOT ${colGraded} AND ${namesGrader}
                       THEN 1 ELSE 0 END) AS empty_title_names,
              SUM(CASE WHEN NOT ${colGraded} AND ${titleSilent}
                       THEN 1 ELSE 0 END) AS empty_title_silent
         FROM sales
        WHERE price_cents IS NOT NULL AND price_cents > 0
          AND sold_date > ? AND sold_date <= ?`
    ).bind(sinceIso, throughIso).first();

    const sample = async (where, n) => {
      const r = await db.prepare(
        `SELECT title, grader, grade, COUNT(*) AS c
           FROM sales
          WHERE price_cents IS NOT NULL AND price_cents > 0
            AND sold_date > ? AND sold_date <= ? AND ${where}
          GROUP BY title ORDER BY c DESC LIMIT ?`
      ).bind(sinceIso, throughIso, n).all();
      return ((r && r.results) || []).map(x => ({
        title: x.title, grader: x.grader || null, grade: x.grade || null, sales: x.c,
      }));
    };

    const p = f || {};
    const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
    const silentShare = pct(p.known_title_silent, p.known_slab);

    res.json({
      available: true,
      generatedAt: new Date().toISOString(),
      window: { since: sinceIso, through: throughIso, days: 30 },
      pricedSales: p.priced,

      // The labelled set: sales eBay's own fields say are slabs.
      knownSlabs: {
        sales: p.known_slab,
        shareOfAllSales: pct(p.known_slab, p.priced),
        titleNamesTheGrader: p.known_title_names,
        titleSaysSlabButNotWho: p.known_title_hints,
        titleSaysNothing: p.known_title_silent,
      },

      // The population the site can only guess at.
      columnsEmpty: {
        sales: p.cols_empty,
        rescuedByTheTitle: p.empty_title_names,
        titleSaysNothingEither: p.empty_title_silent,
      },

      // The one number this was built to produce.
      verdict: {
        gradeLostByTitleShare: silentShare,
        // Applying the labelled set's miss rate to the unlabelled one. An
        // estimate, and flagged as such — see the LIMIT note above. It is a
        // floor, not a count.
        estimatedSlabsSittingInRaw: silentShare == null ? null
          : Math.round((p.empty_title_silent || 0) * (silentShare / 100)),
        reading: silentShare == null ? 'no labelled sales in the window'
          : silentShare < 2
            ? 'Titles carry the grade. A slab in a Raw list is a bug in the reader, not missing data — OCR would fix nothing.'
            : silentShare < 10
              ? 'Titles carry the grade on the large majority of slabs. Worth fixing the reader before considering photos.'
              : 'Titles lose the grade often enough that the photo is the only remaining source. This is the case for OCR.',
      },

      // What a lost grade actually looks like. Five of these say instantly
      // whether there is a readable pattern being missed or genuinely no text.
      knownSlabsWithSilentTitles: await sample(`${colGraded} AND ${titleSilent}`, 8),
      // The control. If this is empty the title reader is not running at all,
      // and every figure above is describing the wrong thing.
      titleCaughtWhatTheColumnsMissed: await sample(`NOT ${colGraded} AND ${namesGrader}`, 5),
    });
  } catch (err) {
    console.error('[grade-gap]', err && err.stack || err);
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
      generatedAt: new Date().toISOString(),
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
  _marketCacheHeaders(res);
  res.json(await _marketCached(_marketBasketKey(days, player),
    () => _computeMarketBasket(db, days, player)));
});

// v3: each card's move is second half vs first half. MARKET_CALC_SIG only
// changes with the INDEX maths, so a change to the basket alone needs its own
// bump — without it the corrected list waited behind an hour of cached v2
// answers (and was kept for two days as a stale fallback).
// v4: the move splits the card's own trading days, not the calendar.
// v5: checklist deny list and robust per-card moves (#658/#659), not in the sig.
const _marketBasketKey = (days, player) =>
  `marketbasket:v5:${MARKET_CALC_SIG}:${days}:${String(player || '').toLowerCase()}`;

async function _computeMarketBasket(db, days, player) {
  try {
    const newest = player
      ? await db.prepare(
          'SELECT MAX(sold_date) AS d FROM sales WHERE player = ? AND confidence >= ? AND price_cents IS NOT NULL'
        ).bind(player, NFLDB_MIN_CONFIDENCE).first()
      : await db.prepare('SELECT MAX(sold_date) AS d FROM sales WHERE price_cents IS NOT NULL').first();
    if (!newest || !newest.d) return { available: false, days, reason: 'no data in range' };

    const throughIso = _mkIso(_mkDay(newest.d) - MARKET_EXCLUDE_TRAILING_DAYS);
    const g = _rsiGeometry(days);
    // Probed, never assumed: naming a column the table lacks fails the whole
    // query, and image_url arrived late enough that not every deployment has it.
    const hasImage = await _nflHasImageColumn(db);
    const useAlias = await _aliasReady(db);
    // Twice the cards shown are read, because some are set aside below.
    const show = player ? 12 : 24;
    const rows = player
      ? await (await _rsiBasketQuery(db, throughIso, days, show * 2,
          ' AND player = ? AND confidence >= ?', [player, NFLDB_MIN_CONFIDENCE], hasImage, useAlias)).all()
      : await (await _rsiBasketQuery(db, throughIso, days, show * 2, '', [], hasImage, useAlias,
          await _marketDenied(db, throughIso, days, useAlias))).all();
    const base = await _basketBaseOnly((rows && rows.results) || []);

    return {
      available: true, days, player: player || null, through: throughIso,
      cards: _rsiBasketRows(base.slice(0, show), days, g.bucketDays, g.points),
    };
  } catch (err) {
    console.error('[MarketBasket]', err && err.message);
    return { available: false, days, reason: 'basket unavailable', transient: true, error: err && err.message };
  }
}

// ---- Base cards only: the checklist can only take a card OUT ----
//
// A card here is a player, a product and a card number, and nothing in the
// sales says the number is his BASE card. Jaxson Dart's 2025 Optic #11 is his
// Uptown case hit ($275-500), filed as a base card because its titles said
// "Uptowns"; on thin days it quadrupled his player number overnight.
//
// The checklist is used as a denylist, never an allowlist: many important
// cards are in products we hold no checklist for, and a checklist can be
// missing a player's base card (2023 Prizm lacked #301-350 until repaired). So
// a card is dropped ONLY when its product's checklist lists that exact number
// for that player in an insert, autograph or relic set, and not in a base set.
// A product we do not hold, a player it does not list, or a number it does
// not know is kept exactly as before. The one rule that needs no checklist: a
// number with letters in it ("STN-2") is an insert code — the index's SQL
// already leaves those out.
const _BASE_SET_NAME_RE = /^(base( set)?|rookies?|rated rookies?|veterans?|legends?|retired( players)?|base (rookies|veterans))$/i;
const _basketChecklists = new Map();
async function _basketChecklist(id) {
  if (!_basketChecklists.has(id)) {
    _basketChecklists.set(id, _loadJson(`checklists/${id}.json`).catch(() => null));
  }
  return _basketChecklists.get(id);
}
const _basketName = (s) => String(s || '').toLowerCase()
  .replace(/[^a-z0-9 ]+/g, '').replace(/\s+(ii|iii|iv|jr|sr)$/, '').replace(/\s+/g, ' ').trim();
const _basketNum = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '').replace(/^0+(?=\d)/, '');
async function _basketBaseOnly(rows) {
  let sIdx = null;
  try {
    const cIdx = await _loadJson('checklists/index.json');
    sIdx = buildJoinIndex((cIdx && cIdx.products) || [], undefined, await setAliases()).index;
  } catch (err) {
    console.error('[MarketBasket] checklist lookup unavailable:', err && err.message);
  }
  const out = [];
  for (const r of rows) {
    const num = _basketNum(r.card_number);
    const coded = /[a-z]/.test(num);
    let verdict = coded ? 'drop' : 'keep';
    try {
      const hit = sIdx && matchSale(sIdx, String(r.year || ''), String(r.set_name || ''));
      const id = hit ? (typeof hit === 'string' ? hit : hit.id) : null;
      const doc = id ? await _basketChecklist(id) : null;
      if (doc && Array.isArray(doc.sets)) {
        const who = _basketName(r.player);
        const baseNums = new Set(), otherNums = new Set();
        for (const set of doc.sets) {
          // By name: the category marks inserts like "Rookie Kings" as base.
          const nm = String(set.name || '').trim();
          const isBase = /^base\b/i.test(nm) || _BASE_SET_NAME_RE.test(nm);
          for (const c of set.cards || []) {
            if (_basketName(c.player) !== who) continue;
            (isBase ? baseNums : otherNums).add(_basketNum(c.number));
          }
        }
        if (otherNums.has(num) && !baseNums.has(num)) verdict = 'drop';
      }
    } catch (err) {
      console.error('[MarketBasket] checklist check failed:', err && err.message);
    }
    if (verdict === 'keep') out.push(r);
  }
  return out;
}

// ---- The market index: which of the busiest cards the checklists rule out ----
//
// The index is computed in SQL, where a checklist cannot be read. So its
// candidate cards — each top player's twenty busiest, twice the ten the index
// keeps — are listed by a light query over the same population, checked in JS
// by _basketBaseOnly, and the keys it rules out are passed back into the index
// and basket queries (_rsiBaseCtes `deny`), which drop them before the ten are
// chosen. Kept for half a day: the basket's make-up moves slowly, and this
// costs a second pass over the period's sales.
const MARKET_DENY_TTL = 60 * 60 * 12;
async function _marketDenied(db, throughIso, days, useAlias) {
  const key = `marketdeny:v1:${MARKET_CALC_SIG}:${days}:${throughIso}:${useAlias ? 1 : 0}`;
  const hit = await cacheGet(key);
  if (Array.isArray(hit)) return hit;
  try {
    const noOffer = await _noBestOfferSql(db);
    const { spanDays } = _rsiGeometry(days);
    const sinceIso = _mkIso(_mkDay(throughIso) - spanDays - RSI_MAX_GAP_DAYS);
    const periodIso = _mkIso(_mkDay(throughIso) - spanDays);
    const P = _normCol('player');
    const PLAYER = useAlias ? `COALESCE(al.canonical, ${P})` : P;
    const JOIN = useAlias ? `LEFT JOIN ${ALIAS_TABLE} al ON al.variant = ${P}` : '';
    const ALIAS_FILTER = useAlias ? ' AND (al.variant IS NULL OR al.resolved = 1)' : '';
    const CARD = _cardKeySql(PLAYER);
    const rows = await db.prepare(
      `WITH ${_rsiBaseCtes({ PLAYER, CARD, P, JOIN, ALIAS_FILTER, noOffer, extraWhere: '' })},
       ranked AS (
         SELECT k.card, MAX(k.year) AS year, MAX(k.set_name) AS set_name, MAX(k.player) AS player,
                MAX(k.card_number) AS card_number,
                ROW_NUMBER() OVER (PARTITION BY k.player_n ORDER BY SUM(k.c) DESC, k.card) AS rn
           FROM pick_keys k JOIN pick_players t ON t.player_n = k.player_n
          GROUP BY k.player_n, k.card)
       SELECT card, year, set_name, player, card_number FROM ranked WHERE rn <= ${MARKET_CARDS_PER_PLAYER * 2}`
    ).bind(..._rsiBaseBinds({ periodIso, sinceIso, throughIso, extraBinds: [] })).all();
    const list = (rows && rows.results) || [];
    const kept = new Set((await _basketBaseOnly(list)).map(r => r.card));
    const deny = list.filter(r => !kept.has(r.card)).map(r => r.card);
    cachePut(key, deny, MARKET_DENY_TTL);
    return deny;
  } catch (err) {
    // Without the list the index runs as it did before this existed.
    console.error('[MarketIndex] checklist deny list unavailable:', err && err.message);
    return [];
  }
}

// The same check for rows keyed by card (RSI_KEY_COLS joined by '|').
async function _baseCardRowsOnly(rows) {
  const keys = [...new Set(rows.map(r => r.card))];
  const at = (k, col) => String(k || '').split('|')[RSI_KEY_COLS.indexOf(col)] || '';
  const probe = keys.map(k => ({ key: k, year: at(k, 'year'), set_name: at(k, 'set_name'),
                                 player: at(k, 'player'), card_number: at(k, 'card_number') }));
  const kept = new Set((await _basketBaseOnly(probe)).map(r => r.key));
  return rows.filter(r => kept.has(r.card));
}

// ---- Market caching: nobody waits for a recompute they did not ask for ----
//
// The index and the basket are the heaviest reads a visitor can trigger — a
// window-function pass over months of sales — and they sat behind a plain
// one-hour TTL. So every hour, for every period and every player someone
// looked at, the next visitor waited for the full query, and switching period
// or player was exactly the action most likely to land on an expired key.
//
// Now an entry is FRESH for MARKET_TTL, as before, but KEPT for
// MARKET_KEEP_TTL. A stale hit is served at once and rebuilt in the background
// (waitUntil on Workers), so the only request that waits is the first one ever
// for that key. The numbers are daily — the newest trailing days are excluded
// by design — so an answer an hour or two old is the same answer.
//
// What is kept, and for how long:
//   available answers        MARKET_KEEP_TTL, refreshed in the background
//   a settled "no" (a thin
//   player, short history)   MARKET_NO_TTL — it can change as data arrives,
//                            but recomputing it on every click proved nothing
//   a failure (transient)    never, so a D1 hiccup is not remembered
const MARKET_KEEP_TTL = 60 * 60 * 48;
const MARKET_NO_TTL = 60 * 30;

function _marketTtl(v) {
  if (!v || v.transient) return 0;
  return v.available ? MARKET_KEEP_TTL : MARKET_NO_TTL;
}

// Stores what is worth keeping and returns the payload without its internal
// `transient` flag and error text, which are bookkeeping, not the answer.
function _marketStore(key, v) {
  const { transient, error, ...clean } = v || {};
  const ttl = _marketTtl(v);
  if (ttl) cachePut(key, clean, ttl);
  return clean;
}

// ---- the breaker: stop hitting a database that is already over its limit ----
//
// D1 answers an over-budget query with "D1 DB exceeded its CPU time limit and
// was reset", after about 30 seconds, and a reset also fails every other query
// in flight. Retrying straight away is how one slow query becomes an outage:
// each visitor, each period prefetch and each cron tick sent another one, and
// the live Market tab waited ~39s for every period to answer "unavailable".
//
// So after an overload failure, heavy market queries stop for a few minutes.
// A cached answer, however old, is served instead; with none, the visitor is
// told the market is busy straight away rather than after half a minute.
// Recorded in KV so every isolate honours it, and in memory so this one does
// without waiting on a KV read.
const MARKET_BREAKER_KEY = 'marketbreaker:v1';
const MARKET_BREAKER_TTL = 300;
let _marketBreakerUntil = 0;

function _isD1Overload(msg) {
  return /exceeded its CPU time limit|was reset|timed? ?out|too many requests|overloaded|D1_ERROR.*(CPU|limit)/i
    .test(String(msg || ''));
}

async function _marketBreakerOpen() {
  if (Date.now() < _marketBreakerUntil) return true;
  const until = await cacheGet(MARKET_BREAKER_KEY).then(v => v && v.until).catch(() => 0);
  if (until && Date.now() < until) { _marketBreakerUntil = until; return true; }
  return false;
}

function _marketTrip(v) {
  if (!v || !v.transient || !_isD1Overload(v.error)) return;
  _marketBreakerUntil = Date.now() + MARKET_BREAKER_TTL * 1000;
  cachePut(MARKET_BREAKER_KEY, { until: _marketBreakerUntil, why: String(v.error).slice(0, 200) }, MARKET_BREAKER_TTL);
  console.error('[MarketCache] database overloaded — pausing market queries', MARKET_BREAKER_TTL + 's');
}

// One computation per key per isolate, shared by everyone who asks while it
// runs — ten visitors opening the same cold view cost one query, not ten.
const _marketInFlight = new Map();
function _marketCompute(key, compute) {
  if (_marketInFlight.has(key)) return _marketInFlight.get(key);
  const p = Promise.resolve().then(compute)
    .then(v => { _marketTrip(v); return _marketStore(key, v); })
    .finally(() => _marketInFlight.delete(key));
  _marketInFlight.set(key, p);
  return p;
}

async function _marketCached(key, compute) {
  const hit = await cacheGet(key);
  const breaker = await _marketBreakerOpen();
  if (hit) {
    const age = (Date.now() - Date.parse(hit.generatedAt || '')) / 1000;
    const freshFor = hit.available ? MARKET_TTL : MARKET_NO_TTL;
    // No stamp means no known age — treat it as stale, never as fresh.
    if (Number.isFinite(age) && age <= freshFor) return _fromCache(hit);
    // Stale: serve it, and rebuild behind the visitor unless the database is
    // resting, in which case an old answer is exactly what should be served.
    if (!breaker && !_marketInFlight.has(key)) {
      const p = _marketCompute(key, compute)
        .catch(err => console.error('[MarketCache] refresh failed', key, err && err.message));
      if (typeof globalThis.__kvWaitUntil === 'function') globalThis.__kvWaitUntil(p);
    }
    return { ..._fromCache(hit), refreshing: !breaker };
  }
  if (breaker) return { available: false, reason: 'market busy', retryAfter: MARKET_BREAKER_TTL };
  return _marketCompute(key, compute);
}

// The browser may reuse an answer for a few minutes: going 7d -> 30d -> 7d, or
// back to a player just viewed, should not be a network round trip at all.
// Private, because the /api/* default is no-store for good reasons elsewhere.
function _marketCacheHeaders(res) {
  res.setHeader('Cache-Control', 'private, max-age=300');
}

// Build the whole-market index and basket for every period, for the cron.
//
// Only what is MISSING, so an ordinary tick costs six KV reads and no queries.
// Without this the first visitor after a deploy — a change to the index maths
// changes MARKET_CALC_SIG, which changes every key — or after an eviction pays
// for the full query. Stale entries are deliberately left to the visitor-side
// background refresh: rebuilding them here every hour would read far more of
// D1 than visitors ever cause, on an account that has hit its limits before.
async function warmMarket() {
  return _asD1Source('market-warm', () => _warmMarket());
}

async function _warmMarket() {
  const db = getNflDb();
  if (!db) return { ok: false, reason: 'no dataset' };
  const done = [];
  const jobs = [];
  for (const days of MARKET_PERIODS) {
    jobs.push([`index:${days}d`, _marketIndexKey(days), () => _computeMarketIndex(db, days)]);
    jobs.push([`basket:${days}d`, _marketBasketKey(days, ''), () => _computeMarketBasket(db, days, '')]);
  }
  for (const [label, key, compute] of jobs) {
    if (await cacheGet(key)) { done.push(`${label}:cached`); continue; }
    // A tick that finds the database resting builds nothing, and one whose
    // build overloads it stops there: six heavy queries in a row against a
    // database already over its limit is how the last outage was sustained.
    if (await _marketBreakerOpen()) { done.push(`${label}:paused`); continue; }
    const v = await compute();
    _marketTrip(v);
    // A failed build never replaces a good entry; a good entry simply ages on.
    if (!v || !v.available) { done.push(`${label}:skipped`); continue; }
    _marketStore(key, v);
    done.push(`${label}:built`);
  }
  console.log(`[Market] warm ${done.join(' ')}`);
  return { ok: true, periods: done };
}

// Flush the per-source tally into a daily KV bucket.
//
// The in-memory counters die with the isolate, and an isolate lives minutes.
// That is precisely how a job quietly reading tens of millions of rows a day
// stays invisible: every time anyone looks, the counter has just been reset.
//
// Called from the cron, so the cost is one KV write per tick rather than one
// per query, and the bucket is a day so a month of history is 30 keys.
const D1_USAGE_KEY = (d) => `d1usage:${d}`;
const D1_USAGE_TTL = 60 * 60 * 24 * 40;   // a bit over a month

async function flushD1Usage() {
  const today = new Date().toISOString().slice(0, 10);
  const sources = Object.keys(_d1By);
  if (!sources.length) return { ok: true, flushed: 0 };
  try {
    const key = D1_USAGE_KEY(today);
    const prev = (await cacheGet(key)) || {};
    for (const src of sources) {
      const mine = _d1By[src];
      const acc = prev[src] || { queries: 0, rowsRead: 0, unmeasured: 0 };
      acc.queries += mine.queries;
      acc.rowsRead += mine.rowsRead;
      acc.unmeasured += mine.unmeasured;
      prev[src] = acc;
      // Zeroed rather than deleted: the next flush adds to a clean slate, and
      // double-counting a tick would be worse than losing one.
      mine.queries = 0; mine.rowsRead = 0; mine.unmeasured = 0;
    }
    await cachePut(key, prev, D1_USAGE_TTL);
    return { ok: true, flushed: sources.length, day: today };
  } catch (err) {
    return { ok: false, reason: String(err && err.message) };
  }
}

// ---- /api/debug/traffic ----
// What the Worker saw, as opposed to what Google Analytics saw.
//
// Gated, unlike the d1-usage endpoint next door: user agents are close enough
// to visitor detail that they should not be public, and a traffic profile is
// exactly what someone probing the site would like to read.
app.get('/api/debug/traffic', async (req, res) => {
  if (!isAdminReq(req)) return res.status(403).json({ error: 'Forbidden' });
  try {
    const days = [];
    for (let i = 0; i < 14; i++) {
      const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      const row = await cacheGet(TRAFFIC_KEY(d));
      if (!row) continue;
      days.push({
        day: d,
        requests: row.total || 0,
        // Self-declared crawlers. Honest, countable, and usually not the
        // problem — they say who they are.
        declaredBot: row.declaredBot || 0,
        // Everything claiming to be a browser. A headless Chrome lives here,
        // and so does every real person: the number is only meaningful next to
        // how the traffic behaves.
        browserLike: row.browserLike || 0,
        noUserAgent: row.noUa || 0,
        pages: row.page || 0,
        assets: row.asset || 0,
        api: row.api || 0,
        // THE TELL. A person who opens a page pulls its CSS, its JS and some
        // images with it, so assets-per-page runs to several. A client that
        // fetches the HTML and leaves sits near zero, whatever its user agent
        // claims — which is the one thing a headless browser cannot fake while
        // still being cheap to run at scale.
        assetsPerPage: row.page ? Math.round(((row.asset || 0) / row.page) * 10) / 10 : null,
        // Requests refused for asking too fast, and which budget refused them.
        // Zero here with high `api` means the load is spread across addresses,
        // which is worth knowing before reaching for a bigger hammer.
        limited: row.limited || 0,
        limitedBy: row.byLimited || {},
        // reCAPTCHA outcomes. `missing` and `fail` are people (or bots) being
        // turned away; a `missing` count that tracks real traffic means the
        // script is not loading for them, which is a problem with the gate,
        // not with them.
        captcha: row.captcha || {},
      });
    }

    // Merge the newest KV row with what this isolate holds but has not
    // flushed, or the most recent hour — the one being asked about — is
    // missing from exactly the report someone opened to look at it.
    const newest = (await cacheGet(TRAFFIC_KEY(_trafficDay()))) || {};
    const merge = (a, b) => {
      const out = { ...(a || {}) };
      for (const [k, n] of Object.entries(b || {})) out[k] = (out[k] || 0) + n;
      return Object.entries(out).sort((x, y) => y[1] - x[1]).slice(0, 15)
        .map(([name, hits]) => ({ name, hits }));
    };
    const topUa = merge(newest.byUa, _traffic.byUa);
    const topPaths = merge(newest.byPath, _traffic.byPath);

    res.json({
      available: true,
      generatedAt: new Date().toISOString(),
      // Said plainly, because the whole reason this exists is that the other
      // number was not comparable.
      note: 'Counted in the Worker, so this includes clients that never run '
          + 'JavaScript and are therefore invisible to Google Analytics. '
          + 'Expect it to be HIGHER than GA, not equal to it.',
      today: _trafficDay(),
      // Not yet flushed to KV — the cron writes once an hour, so the newest
      // traffic is here rather than in the day rows above.
      sinceLastFlush: {
        requests: _traffic.total, declaredBot: _traffic.declaredBot,
        browserLike: _traffic.browserLike, pages: _traffic.page,
        assets: _traffic.asset, api: _traffic.api,
        limited: _traffic.limited, limitedBy: { ..._traffic.byLimited },
        captcha: { ..._traffic.captcha },
      },
      // The budgets in force, so a reading of `limited` can be judged against
      // what it took to trip them without reading the source.
      rateLimits: RL_DISABLED ? 'disabled' : RL_TIERS.map(t =>
        ({ tier: t.name, perMinute: t.minute, perHour: t.hour })),
      recaptcha: !RECAPTCHA_SECRET ? 'not configured' : {
        enforcing: RECAPTCHA_ENFORCE,
        minScore: RECAPTCHA_MIN_SCORE,
        paths: RECAPTCHA_PATHS,
      },
      days,
      // Who, by name, biggest first. The answer to "what the heck is this"
      // is usually just legible here: one user agent carrying most of the day.
      topUserAgents: topUa,
      topPaths: topPaths,
    });
  } catch (err) {
    console.error('[debug/traffic]', err && err.stack || err);
    res.json({ available: false, error: err && err.message });
  }
});

// ---- /api/debug/d1-usage ----
// What the sold-search path is actually costing in D1 rows read.
//
// The Workers Paid plan includes 25 billion rows read a month and bills beyond
// it, and the sold search is the one query that can run away: a leading-wildcard
// LIKE walks the sales table, so a search returning three rows can read
// millions. Modelling that is guesswork; D1 reports rows_read on every query,
// so this reports the real figure.
//
// Counters are per isolate and reset when Cloudflare recycles it, which makes
// this a rate check rather than a monthly total — the useful number is rows per
// query, and whether the cache is absorbing the repeats.
app.get('/api/debug/d1-usage', async (req, res) => {
  // The durable half: which job has been reading how much, per day.
  //
  // This is the view that answers "two billion rows in thirty days — from
  // where", which the per-isolate counters below cannot, because they reset
  // every few minutes.
  const days = [];
  try {
    for (let i = 0; i < 7; i++) {
      const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      const row = await cacheGet(D1_USAGE_KEY(d));
      if (!row) continue;
      const total = Object.values(row).reduce((n, e) => n + (e.rowsRead || 0), 0);
      days.push({
        day: d, rowsRead: total,
        bySource: Object.fromEntries(Object.entries(row)
          .sort((a, b) => (b[1].rowsRead || 0) - (a[1].rowsRead || 0))
          .map(([k, v]) => [k, { rowsRead: v.rowsRead, queries: v.queries, unmeasured: v.unmeasured }])),
      });
    }
  } catch (_) { /* reported as an empty history rather than an error */ }
  const worst = days[0] && Object.entries(days[0].bySource)[0];

  // Is the alias backfill actually skipping, right now?
  //
  // The daily buckets above only answer that tomorrow — a full day has to pass
  // before the query count is comparable. This reads the marker itself, so the
  // fix can be confirmed within an hour of the run that sets it instead of
  // waiting for the next day's total.
  //
  // Absent is not a failure on its own: the marker lasts 23 hours and is taken
  // by the first run that drains the table, so a fresh deploy legitimately
  // shows "not set" until that run happens. What would be wrong is today's
  // alias-backfill query count still climbing past a couple while this says
  // it is set.
  let aliasSkip;
  try {
    const mark = await cacheGet(ALIAS_CAUGHTUP_KEY);
    aliasSkip = mark
      ? { caughtUp: true, at: mark.at, drained: mark.drained,
          meaning: 'the hourly backfill is skipping its 1.06M-row scan until this expires' }
      : { caughtUp: false,
          meaning: 'no marker — the next alias tick (minute <15 of an hour) will scan, and will set this if it drains the table' };
  } catch (_) {
    aliasSkip = { caughtUp: null, meaning: 'marker unreadable' };
  }

  res.locals.d1Daily = {
    days,
    aliasBackfill: aliasSkip,
    // 25 billion a month is the included allowance; a day's share of it is the
    // line a sustained rate should be judged against.
    dailyShareOfIncluded: Math.round(25e9 / 30).toLocaleString('en-US'),
    biggestConsumerToday: worst ? `${worst[0]} — ${worst[1].rowsRead.toLocaleString('en-US')} rows` : 'nothing recorded yet',
    note: 'Written by the cron every 15 minutes. A job absent here has not run since the last deploy.',
  };
  return _d1UsageBody(req, res);
});

function _d1UsageBody(req, res) {
  const served = _d1Usage.queries + _d1Usage.cacheHits;
  const perQuery = _d1Usage.queries ? Math.round(_d1Usage.rowsRead / _d1Usage.queries) : 0;
  // 25 billion a month, spread evenly, is the budget a sustained rate is
  // measured against.
  const MONTHLY_INCLUDED = 25e9;
  res.json({
    daily: res.locals.d1Daily,
    since: _d1Usage.since,
    searchesServed: served,
    fromCache: _d1Usage.cacheHits,
    cacheHitRate: served ? Math.round((100 * _d1Usage.cacheHits) / served) + '%' : 'n/a',
    d1Queries: _d1Usage.queries,
    rowsRead: _d1Usage.rowsRead,
    // How long the sold search actually takes. rows_read says what it costs;
    // this says why it feels slow, which is a different question.
    soldSearchMs: _soldTimingSummary(),
    rowsPerQuery: perQuery,
    // The number that decides whether this is a problem: at this cost per
    // query, how many searches fit in a month's included reads?
    searchesPerMonthWithinIncluded: perQuery ? Math.floor(MONTHLY_INCLUDED / perQuery) : null,
    searchWindowDays: NFLDB_SEARCH_WINDOW_DAYS || 'unbounded',
    cacheTtlSeconds: NFLDB_SEARCH_TTL,
    note: 'Counters are per isolate and reset on recycle. rowsPerQuery is the figure to act on.',
  });
}

// ---- /api/debug/price-coverage ----
//
// Can the landing pages actually show prices?
//
// 2,173 pages are titled "Checklist & Prices" and carry none. Putting real
// numbers on them means joining the sold-sales table to the checklists, and
// whether that is worth building depends on a figure nobody has measured: how
// many products have enough sales behind them to show anything.
//
// scripts/probe-price-coverage.js answers the same question from CI, but needs
// a token with D1 on it. This needs nothing: the Worker already holds the D1
// binding, so loading one URL answers it. That the script came first was an
// oversight worth naming — the access was here the whole time.
//
// Read-only, and cached, because it is a decision aid rather than a page.
const PRICE_COVERAGE_TTL = 3600;
// The sitemap's own count, checked by test/set-key.test.js so it
// cannot drift silently away from what build-landing-pages.js emits.
const INDEXABLE_URLS = 2205;
app.get('/api/debug/price-coverage', async (req, res) => {
  const db = getNflDb();
  if (!db) return res.json({ available: false, reason: 'no D1 binding' });

  const cached = await cacheGet('pricecoverage:v3');
  if (cached && !req.query.fresh) return res.json(_fromCache(cached));

  // A set must clear both bars before a price block is worth rendering on its
  // page. Reported against rather than enforced — the point is to find out
  // whether these are the right numbers.
  const WANT_SALES = 20, WANT_CARDS = 10;

  try {
    const Y = _normCol('year'), S = _normCol('set_name');
    const CARD = `${_normCol('player')} || '|' || ${_normCol('card_number')}`;
    const WHERE = `price_cents IS NOT NULL AND confidence >= ${NFLDB_MIN_CONFIDENCE}`;

    const P = _normCol('player');
    // Three scans of the same table rather than one. Each aggregate groups by
    // something different, so they cannot be merged, and at ~473k rows this
    // costs about 1.4M rows read per uncached call — fractions of a cent, and
    // the result is cached for an hour. Worth stating rather than discovering.
    const [totals, bySet, byPlayer] = await Promise.all([
      db.prepare(`SELECT COUNT(*) AS n, MIN(sold_date) AS first, MAX(sold_date) AS last
                  FROM sales WHERE ${WHERE}`).first(),
      // One row per set name — a few thousand at most, not one query per page.
      db.prepare(`SELECT ${Y} AS y, ${S} AS s, COUNT(*) AS n, COUNT(DISTINCT ${CARD}) AS cards
                  FROM sales WHERE ${WHERE} AND ${S} <> ''
                  GROUP BY y, s ORDER BY n DESC`).all(),
      db.prepare(`SELECT ${P} AS p, COUNT(*) AS n, COUNT(DISTINCT ${CARD}) AS cards
                  FROM sales WHERE ${WHERE} AND ${P} <> ''
                  GROUP BY p ORDER BY n DESC`).all(),
    ]);

    // The checklist side. index.json carries id/name/year for all 361 products
    // in 82 KB — enough to build the key without loading a single checklist.
    const idx = await _loadJson('checklists/index.json');
    const products = (idx && idx.products) || [];

    // The join lives in set-key.js, which is where the reasoning and the tests
    // are. The short version: this used to key on year + brand, which sent 37%
    // of priced sales to no product at all and gave three different Donruss
    // sets identical figures. It keys on the product name now.
    const rows = (bySet && bySet.results) || [];
    // Same aliases the price build uses, or this report would show orphans the
    // site has already been told how to resolve.
    const { index: setIndex, ambiguous } = buildJoinIndex(products, undefined, await setAliases());

    // Several sale groups can reach one product — "prizm" and "panini prizm"
    // are the same set written two ways — so this accumulates rather than
    // looks up.
    const agg = new Map();
    const orphans = [];
    for (const r of rows) {
      const p = matchSale(setIndex, r.y, r.s);
      if (!p) { orphans.push(r); continue; }
      let a = agg.get(p.id);
      if (!a) { a = { p, n: 0, cardsFloor: 0, cardsCeil: 0, groups: 0 }; agg.set(p.id, a); }
      a.n += Number(r.n || 0);
      a.groups++;
      // Sales add up exactly. Distinct cards do not: a card that sold under
      // both spellings is counted twice by the sum and once by the largest
      // group, so the true figure sits between them. The threshold is applied
      // to the floor, because overstating coverage is the failure this whole
      // endpoint exists to avoid.
      const c = Number(r.cards || 0);
      a.cardsCeil += c;
      if (c > a.cardsFloor) a.cardsFloor = c;
    }

    const matched = [...agg.values()];
    const clears = matched.filter(a => a.n >= WANT_SALES && a.cardsFloor >= WANT_CARDS);
    const orphanSales = orphans.reduce((n, r) => n + Number(r.n || 0), 0);

    const share = products.length ? Math.round((100 * clears.length) / products.length) : 0;

    // ---- the player pages ----
    //
    // Product pages are 371 of the 2,173 indexable URLs. Player pages are
    // 1,228 — more than half the site — so "would a price block fill the
    // pages" is mostly a question about these, and answering it only for sets
    // would have answered the smaller half while sounding like the whole.
    //
    // Same join discipline: variants on both sides, ambiguity dropped rather
    // than guessed, orphans reported. The hazard here is the generational
    // suffix instead of the manufacturer prefix.
    let playerPages = { available: false, reason: 'players/index.json not built' };
    try {
      const pidx = await _loadJson('players/index.json');
      const pages = (pidx && pidx.players) || [];
      const { index: playerIndex, ambiguous: pAmbiguous } = buildJoinIndex(pages, playerKeys);

      const pAgg = new Map();
      const pOrphans = [];
      for (const r of (byPlayer && byPlayer.results) || []) {
        const hit = matchPlayer(playerIndex, r.p);
        if (!hit) { pOrphans.push(r); continue; }
        let a = pAgg.get(hit.slug);
        if (!a) { a = { p: hit, n: 0, cardsFloor: 0, cardsCeil: 0, spellings: 0 }; pAgg.set(hit.slug, a); }
        a.n += Number(r.n || 0);
        a.spellings++;
        const c = Number(r.cards || 0);
        a.cardsCeil += c;
        if (c > a.cardsFloor) a.cardsFloor = c;
      }

      // Indexable pages are the ones in the sitemap and so the ones a reviewer
      // or a crawler actually sees. The rest are built but carry noindex, and
      // filling them changes nothing anyone looks at.
      const indexable = pages.filter(p => p.indexable);
      const pClears = [...pAgg.values()]
        .filter(a => a.p.indexable && a.n >= WANT_SALES && a.cardsFloor >= WANT_CARDS);
      const pOrphanSales = pOrphans.reduce((n, r) => n + Number(r.n || 0), 0);

      playerPages = {
        available: true,
        pages: pages.length,
        indexablePages: indexable.length,
        matchedToSales: pAgg.size,
        indexableClearingThreshold: pClears.length,
        shareOfIndexablePagesWithUsablePrices: indexable.length
          ? Math.round((100 * pClears.length) / indexable.length) + '%' : 'n/a',
        salesUnderUnmatchedPlayers: {
          sales: pOrphanSales,
          share: (totals && totals.n) ? Math.round((100 * pOrphanSales) / totals.n) + '%' : 'n/a',
          examples: pOrphans.slice(0, 10).map(r => ({ player: r.p, sales: r.n })),
        },
        // Two pages answering to one name. Some are real father/son pairs the
        // suffix strip collapses and the join is right to refuse; some are the
        // same player catalogued twice under different punctuation, which is a
        // duplicate page rather than a join problem.
        ambiguousNames: pAmbiguous.length,
        ambiguousExamples: pAmbiguous.slice(0, 8),
      };
    } catch (err) {
      playerPages = { available: false, reason: String(err && err.message) };
    }
    const payload = {
      available: true,
      generatedAt: new Date().toISOString(),
      dataset: {
        pricedSales: (totals && totals.n) || 0,
        from: totals && totals.first, to: totals && totals.last,
        distinctSetNames: rows.length,
      },
      thresholds: { minSales: WANT_SALES, minDistinctCards: WANT_CARDS },
      products: products.length,
      matchedToSales: matched.length,
      clearingThreshold: clears.length,
      shareOfProductsWithUsablePrices: share + '%',
      // A large figure here means the join key is wrong rather than the data
      // being absent, and that is worth knowing before anything is built on it.
      // It was 37% on the year+brand key; that is what sent it back.
      salesUnderUnclaimedSetNames: {
        sales: orphanSales,
        share: (totals && totals.n) ? Math.round((100 * orphanSales) / totals.n) + '%' : 'n/a',
        examples: orphans.slice()
          .sort((a, b) => Number(b.n || 0) - Number(a.n || 0)).slice(0, 10)
          .map(r => ({ year: r.y, set: r.s, sales: r.n })),
      },
      // Expected to be empty. A key two products both answer to is dropped
      // rather than given to one of them, so anything listed here is a page
      // that will show no prices until the catalogue names it distinctly.
      ambiguousKeys: ambiguous.slice(0, 10),
      playerPages,
      best: matched.slice().sort((a, b) => b.n - a.n).slice(0, 15)
        .map(a => ({
          product: a.p.name, sales: a.n,
          soldCards: a.cardsFloor, soldCardsUpperBound: a.cardsCeil,
          spellings: a.groups, catalogued: a.p.totalCards,
        })),
      // The decision is about PAGES, not products, and those are not the same
      // number: 361 product pages sit alongside 1,228 player pages, 538 subset
      // pages and 32 team pages in a 2,173-URL sitemap. A product-only share
      // answers a sixth of the site while sounding like the whole of it, which
      // is how the first version of this endpoint managed to be confidently
      // wrong. So the verdict counts pages that would actually carry numbers.
      //
      // Subset and team pages are NOT counted. They would need their own join
      // — set name plus subset name — which has not been measured, and
      // guessing it here would repeat the mistake this endpoint just caught.
      // The figure is therefore a floor.
      pagesFilled: (() => {
        const pp = playerPages.available ? playerPages.indexableClearingThreshold : 0;
        const filled = clears.length + pp;
        return {
          indexableUrls: INDEXABLE_URLS,
          productPages: clears.length,
          playerPages: pp,
          subsetAndTeamPages: 'not measured — needs a subset-level join',
          atLeast: filled,
          share: Math.round((100 * filled) / INDEXABLE_URLS) + '%',
        };
      })(),
      verdict: (() => {
        const pp = playerPages.available ? playerPages.indexableClearingThreshold : 0;
        const pageShare = (100 * (clears.length + pp)) / INDEXABLE_URLS;
        if (!playerPages.available) return 'Incomplete — the player side did not load, and it is the larger half.';
        if (pageShare >= 40) return 'Build it — most indexable pages would carry real numbers.';
        if (pageShare >= 15) return 'Build it for the qualifying pages only, and leave the rest with no price block rather than an empty one.';
        return 'Not yet — a price block would render empty on most pages, which is worse than showing none.';
      })(),
    };
    cachePut('pricecoverage:v3', payload, PRICE_COVERAGE_TTL);
    res.json(payload);
  } catch (err) {
    console.error('[price-coverage]', err && err.message);
    res.json({ available: false, error: String(err && err.message) });
  }
});

// ---- How accurate is the market? ----
//
// A number is only as good as what it predicts. The question a collector asks
// the index is "this card last sold for $X on day A — what is it worth now?",
// so that is what this measures, on real sales: for every pair of consecutive
// trading days of a base card, how far the later price was from
//   last comp        the earlier price as it stood,
//   + market         the earlier price moved by the market index since,
//   + player         the earlier price moved by the player's own index since.
// Each index is read as of the day BEFORE the later sale, so it never sees the
// sale it is predicting. Reported as the median error, the share within 10%
// and 25%, and by how long the card had gone unsold. A change to the index is
// judged by whether these numbers improve.
//
// Heavy (one query per player), so it goes through the market cache: a day's
// answer is kept and rebuilt in the background.
const ACCURACY_PLAYERS = 20;
async function _computeMarketAccuracy(db, days) {
  try {
    const roster = (await _playerRoster(db)).slice(0, ACCURACY_PLAYERS).map(p => p.player);
    const market = await _marketCached(_marketIndexKey(days), () => _computeMarketIndex(db, days));
    const levelMap = (series) => {
      const pts = (series || []).map(p => ({ day: _mkDay(p.date), score: Number(p.score) }))
        .filter(p => Number.isFinite(p.day) && p.score > 0).sort((a, b) => a.day - b.day);
      return (day) => { let at = null; for (const p of pts) { if (p.day <= day) at = p; else break; } return at && at.score; };
    };
    const marketAt = market && market.available ? levelMap(market.series) : null;
    const errs = { last: [], market: [], player: [] };
    const byGap = {};
    let pairs = 0, players = 0;
    for (const player of roster) {
      const newest = await db.prepare(
        'SELECT MAX(sold_date) AS d FROM sales WHERE player = ? AND confidence >= ? AND price_cents IS NOT NULL'
      ).bind(player, NFLDB_MIN_CONFIDENCE).first();
      if (!newest || !newest.d) continue;
      const throughIso = _mkIso(_mkDay(newest.d) - MARKET_EXCLUDE_TRAILING_DAYS);
      const rows = await _baseCardRowsOnly(((await (await _playerTrendQuery(db, throughIso, days, player)).all()) || {}).results || []);
      const pl = _playerTrendPayload(rows, throughIso, days, player);
      if (!pl || !pl.available) continue;
      const playerAt = levelMap(pl.series);
      players++;
      const byCard = new Map();
      for (const r of rows) {
        const day = _mkDay(r.sold_date), n = Number(r.c), sum = Number(r.s);
        if (!Number.isFinite(day) || !(n > 0) || !(sum > 0)) continue;
        if (!byCard.has(r.card)) byCard.set(r.card, new Map());
        const m = byCard.get(r.card);
        const d = m.get(day) || { s: 0, c: 0 };
        d.s += sum; d.c += n; m.set(day, d);
      }
      const start = _mkDay(throughIso) - days;
      for (const m of byCard.values()) {
        const ds = [...m.entries()].map(([day, v]) => ({ day, p: v.s / v.c })).sort((a, b) => a.day - b.day);
        for (let i = 1; i < ds.length; i++) {
          const a = ds[i - 1], b = ds[i];
          if (b.day <= start) continue;
          const mA = marketAt && marketAt(a.day), mB = marketAt && marketAt(b.day - 1);
          const pA = playerAt(a.day), pB = playerAt(b.day - 1);
          if (!(mA && mB && pA && pB)) continue;          // score all three on the same pairs
          const err = (pred) => Math.abs(Math.log(b.p / pred));
          const e = { last: err(a.p), market: err(a.p * mB / mA), player: err(a.p * pB / pA) };
          const gap = b.day - a.day;
          const g = gap <= 3 ? '1-3 days' : gap <= 7 ? '4-7 days' : gap <= 30 ? '8-30 days' : '31+ days';
          if (!byGap[g]) byGap[g] = { last: [], market: [], player: [] };
          for (const k of Object.keys(errs)) { errs[k].push(e[k]); byGap[g][k].push(e[k]); }
          pairs++;
        }
      }
    }
    if (!pairs) return { available: false, days, reason: 'no comparable sales' };
    const summarise = (xs) => {
      const s = xs.slice().sort((x, y) => x - y);
      const med = s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
      const pct = (x) => Math.round((Math.exp(x) - 1) * 1000) / 10;
      return { medianErrorPct: pct(med),
               within10Pct: Math.round(1000 * s.filter(x => x <= Math.log(1.1)).length / s.length) / 10,
               within25Pct: Math.round(1000 * s.filter(x => x <= Math.log(1.25)).length / s.length) / 10 };
    };
    const table = (e) => ({ lastComp: summarise(e.last), withMarket: summarise(e.market), withPlayer: summarise(e.player), pairs: e.last.length });
    const gaps = {};
    for (const g of ['1-3 days', '4-7 days', '8-30 days', '31+ days']) if (byGap[g]) gaps[g] = table(byGap[g]);
    return { available: true, days, players, ...table(errs), byGap: gaps };
  } catch (err) {
    console.error('[MarketAccuracy]', err && err.message);
    return { available: false, days, reason: 'accuracy unavailable', transient: true, error: err && err.message };
  }
}

app.get('/api/debug/market-accuracy', async (req, res) => {
  const days = MARKET_PERIODS.includes(parseInt(req.query.days, 10)) ? parseInt(req.query.days, 10) : 90;
  const db = getNflDb();
  if (!db) return res.json({ available: false, days, reason: 'no dataset' });
  res.json(await _marketCached(`marketaccuracy:v1:${MARKET_CALC_SIG}:${days}`, () => _computeMarketAccuracy(db, days)));
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
  _marketCacheHeaders(res);
  res.json(await _marketCached(_marketIndexKey(days), () => _computeMarketIndex(db, days)));
});

// v3: grouping moved into SQL. v2 keys are left behind deliberately — they
// hold payloads from the build that tripped the Worker CPU limit.
// v5: unmeasured steps carry `estimated: true` in the series, for the chart.
// v6: the checklist deny list (_marketDenied) is not in MARKET_CALC_SIG.
const _marketIndexKey = (days) => `marketindex:v6:${MARKET_CALC_SIG}:${days}`;

// The whole-market index, computed. Returns the payload rather than writing a
// response so the cron can build it too — see warmMarket.
async function _computeMarketIndex(db, days) {
  try {
    // Anchor to the newest day we hold, not to today: if the collector paused,
    // counting back from today walks off the end of the data and reads as a
    // crash that never happened.
    //
    // "We haven't been collecting long enough" is not the same as "cards don't
    // resell", and only one of them resolves on its own. Check it explicitly so
    // the page can say which, rather than blaming the data density. Both ends
    // are read at once: they are independent, and serially they were two round
    // trips before the real query could start.
    const [newest, oldest] = await Promise.all([
      db.prepare('SELECT MAX(sold_date) AS d FROM sales WHERE price_cents IS NOT NULL').first(),
      db.prepare('SELECT MIN(sold_date) AS d FROM sales WHERE price_cents IS NOT NULL').first(),
    ]);
    if (!newest || !newest.d) return { available: false, days, reason: 'no data in range' };

    const throughIso = _mkIso(_mkDay(newest.d) - MARKET_EXCLUDE_TRAILING_DAYS);

    // The gate is where the oldest bucket STARTS, not where it ends. A period
    // whose last bucket is only partly covered still scores fine off the sales
    // it does have; one whose last bucket is entirely before the first sale we
    // hold has nothing to compare against and would report zero matched cards
    // as if cards never resold.
    const { bucketDays, points, spanDays } = _rsiGeometry(days);
    const haveDays = oldest && oldest.d ? _mkDay(throughIso) - _mkDay(oldest.d) + 1 : 0;
    if (haveDays < points * bucketDays) {
      return {
        available: false, days, reason: 'not enough history yet',
        daysOfHistory: haveDays, daysNeeded: points * bucketDays, fullSpanDays: spanDays,
        through: throughIso, method: 'repeat-sales',
      };
    }

    // Only groups on canonical names once the table is actually filled.
    const useAlias = await _aliasReady(db);
    // Daily points where the period is long enough to want them. If more than
    // half the days went unmeasured the daily chain cannot be drawn, and the
    // weekly one — the same sales, pooled seven days at a time — usually can,
    // so a quiet stretch costs the chart its detail rather than the whole index.
    // The history gate above stays on the weekly geometry for the same reason.
    const daily = _rsiGeometry(days, true).bucketDays !== bucketDays;
    const deny = await _marketDenied(db, throughIso, days, useAlias);
    const rows = await (await _rsiQuery(db, throughIso, days, '', [], 'player', useAlias, daily, deny)).all();
    const list = (rows && rows.results) || [];
    if (list.length === 0) return { available: false, days, reason: 'no data in range' };

    const out = _buildRepeatSalesPayload(list, throughIso, days, {}, RSI_TIERS, daily);
    if (out.available || !daily) return out;
    const weekly = await (await _rsiQuery(db, throughIso, days, '', [], 'player', useAlias, false, deny)).all();
    return _buildRepeatSalesPayload((weekly && weekly.results) || [], throughIso, days);
  } catch (err) {
    console.error('[MarketIndex]', err && err.message);
    return { available: false, days, reason: 'index unavailable', transient: true, error: err && err.message };
  }
}

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
    // The whole roster, once, so the page can filter as you type without a
    // round trip per keystroke. It is at most PLAYER_LIST_MAX names and changes
    // every few hours, so the browser may keep it for a while.
    if (req.query.all === '1') {
      res.setHeader('Cache-Control', 'private, max-age=3600');
      return res.json({ available: true, players: roster });
    }
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
  _marketCacheHeaders(res);
  // v4: carries MARKET_CALC_SIG like the market keys. Entries are now kept for
  // two days and served stale while they rebuild, so a key that survived a
  // change to the maths would keep showing the old answer. v5: daily points;
  // v6: a price-level trend instead of the chained index; v7: estimated
  // points. None of them changes MARKET_CALC_SIG, so each needs its own bump.
  res.json(await _playerIndexCached(db, days, player));
});

// The player index through the same cache the Market tab reads, so a card page
// adjusting a stale price by it sees the very number the tab shows.
async function _playerIndexCached(db, days, player) {
  // v8: base cards by checklist, outlier card-days set aside.
  return await _marketCached(`playerindex:v8:${MARKET_CALC_SIG}:${days}:${String(player).toLowerCase()}`,
    () => _computePlayerIndex(db, days, player));
}

// ---- A stale card's price, moved by its player's market ----
//
// A card that has not sold in over a week is priced at what it last sold for,
// moved by how its player's market has moved since: the player index level on
// the day of that last sale against its latest level. The 30-day index covers
// a sale up to a month back, the 90-day index anything older (from its first
// level, when the sale is older still). The move is capped like the old trend
// adjustment, since a player's number is a median over all their cards.
const MARKET_ADJ_AFTER_DAYS = 7;
async function _playerMarketAdjuster(db, player, nowDay, oldestFromDay) {
  if (!player || !(nowDay - oldestFromDay > MARKET_ADJ_AFTER_DAYS)) return null;
  const idx30 = await _playerIndexCached(db, 30, player);
  // The 90-day index for a sale older than a month, and for a player the
  // 30-day index gives no reading for.
  const idx90 = nowDay - oldestFromDay > 30 || !(idx30 && idx30.available)
    ? await _playerIndexCached(db, 90, player) : null;
  return (fromDay) => {
    const use90 = idx90 && idx90.available && (nowDay - fromDay > 30 || !(idx30 && idx30.available));
    const idx = use90 ? idx90 : idx30;
    return idx && idx.available ? _marketRatioFrom(idx.series, fromDay) : null;
  };
}

// The player index's move from `fromDay` (the level on or before it, or its
// first level when the day predates the series) to its latest level, capped.
function _marketRatioFrom(series, fromDay) {
  if (!Array.isArray(series) || !series.length) return null;
  let at = series[0];
  for (const pt of series) { if (_mkDay(pt.date) <= fromDay) at = pt; else break; }
  const end = series[series.length - 1];
  if (!(at.score > 0) || !(end.score > 0)) return null;
  const raw = end.score / at.score;
  const lo = 1 - PRICE_TREND_MAX_ADJ, hi = 1 + PRICE_TREND_MAX_ADJ;
  const ratio = Math.min(hi, Math.max(lo, raw));
  return { ratio, pct: Math.round((ratio - 1) * 1000) / 10, clamped: raw < lo || raw > hi,
           fromDate: at.date, throughDate: end.date };
}

// ---- A player's number: their own cards' prices, first week against last ----
//
// The whole-market index chains per-step moves across ~600 players, and the
// average across them is what makes the chain steady. Scoped to one player it
// had one player's handful of cards per step, and on the live data that read
// Fernando Mendoza at -53% over 30 days while his main card (157 sales) was
// down 12%. Two things compounded: two or three cards cannot pin down a day's
// move, and every unmeasured day (collection gaps, 14 of 30 at the time)
// inherited the typical measured move, repeating its error. On a flat market
// the chained player number wandered +-10 to 30%, weekly or daily alike.
//
// So a player is measured the way a collector reads their comps. Every
// card-day price is taken relative to that card's own typical price over the
// period (a card fixed effect, so a $10 base and a $200 rookie can share a
// line), and the level on a day is the median of those relative prices over
// the trailing window. Nothing is chained: a noisy day moves one window's
// median and nothing after it, and a day with no sales simply has no point.
// The headline compares the last window with the first.
//
// And a player without enough sales at both ends gets no number rather than a
// shaky one — option (1) of the same fix.
//
// Measured on the flat-market fixture (true prices never move), see
// test/market-accuracy.test.js for the figures this was tuned against.
const PLAYER_TREND_OUTLIER_X = 3;         // a card-day this far off the card's typical day is set aside
const PLAYER_TREND_MIN_CARD_DAYS = 3;     // a card must trade on this many days to say anything
function _playerTrendWindow(days) { return days >= 90 ? 14 : days >= 30 ? 7 : 3; }
const PLAYER_TREND_MIN_WINDOW = 8;        // card-days needed in a window for it to count
// ESTIMATED POINTS. Collection gaps leave whole days with no sales, and at the
// end of the data (the collector's lag plus any uncollected days) a player's
// last few days are routinely empty — which made every 7-day player view say
// "not enough sales". Two relaxations, both flagged `estimated` so the page
// can draw them as estimates rather than measurements:
//  - a window short of sales reaches back further, up to this many times its
//    width, for the sales it needs;
//  - the period may end up to two window-widths earlier than the newest data,
//    on the last day that had sales and can be measured (the page shows
//    `through`).
// What is never done is compare a window with itself: if the first and last
// windows would overlap, there is no trend to read and the player gets none.
const PLAYER_TREND_MAX_WIDEN = 2;

// Read far enough back for the first window to widen and the period to shift.
function _playerTrendLookback(days) { return days + _playerTrendWindow(days) * (PLAYER_TREND_MAX_WIDEN + 1); }

async function _playerTrendQuery(db, throughIso, days, player) {
  const noOffer = await _noBestOfferSql(db);
  // Only this span is read: nothing here pairs a sale with an earlier one.
  // Passing the span start as the look-back empties the pre-period pass.
  const periodIso = _mkIso(_mkDay(throughIso) - _playerTrendLookback(days));
  const P = _normCol('player');
  return db.prepare(
    `WITH ${_rsiBaseCtes({ PLAYER: P, CARD: _cardKeySql(P), P, JOIN: '', ALIAS_FILTER: '', noOffer,
                          extraWhere: ' AND player = ? AND confidence >= ?' })}
     SELECT card, sold_date, s, c FROM base WHERE sold_date > ? ORDER BY sold_date`
  ).bind(..._rsiBaseBinds({ periodIso, sinceIso: periodIso, throughIso,
                            extraBinds: [player, NFLDB_MIN_CONFIDENCE] }), periodIso);
}

function _playerTrendPayload(rows, throughIso, days, player) {
  const round1 = (n) => Math.round(n * 10) / 10;
  const W = _playerTrendWindow(days);
  const maxW = W * PLAYER_TREND_MAX_WIDEN;
  const newest = _mkDay(throughIso);

  // card -> [{ day, logp, n }], one entry per card-day (same-day sales averaged).
  const byCard = new Map();
  for (const r of rows || []) {
    const n = Number(r.c), sum = Number(r.s);
    if (!(n > 0) || !(sum > 0)) continue;
    const day = _mkDay(r.sold_date);
    if (!Number.isFinite(day)) continue;
    if (!byCard.has(r.card)) byCard.set(r.card, []);
    byCard.get(r.card).push({ day, logp: Math.log(sum / n), n });
  }
  const median = (xs) => {
    const a = xs.slice().sort((x, y) => x - y);
    const m = a.length >> 1;
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  };
  // Each card-day relative to that card's own median day price.
  const entries = [];
  let cards = 0, sales = 0;
  // A card-day priced over 3x or under a third of that card's typical day is
  // not this card's price — a parallel or an insert that reached it under the
  // same number — and one of them on a thin day moved the whole player.
  const OUT = Math.log(PLAYER_TREND_OUTLIER_X);
  for (const all of byCard.values()) {
    if (all.length < PLAYER_TREND_MIN_CARD_DAYS) continue;
    const typical = median(all.map(x => x.logp));
    const list = all.filter(x => Math.abs(x.logp - typical) <= OUT);
    if (list.length < PLAYER_TREND_MIN_CARD_DAYS) continue;
    const ref = median(list.map(x => x.logp));
    cards++;
    for (const x of list) { entries.push({ day: x.day, rel: x.logp - ref }); sales += x.n; }
  }
  const inWin = (from, to) => entries.filter(e => e.day >= from && e.day <= to);
  // The level on `endDay`: the trailing W days, reaching further back (never
  // before `floor`) until it holds enough to read.
  const levelAt = (endDay, floor = -Infinity) => {
    for (let w = W; w <= maxW; w++) {
      const from = endDay - w + 1;
      if (from < floor) break;
      const win = inWin(from, endDay);
      if (win.length >= PLAYER_TREND_MIN_WINDOW) {
        return { level: median(win.map(e => e.rel)), n: win.length, from, estimated: w > W };
      }
    }
    return null;
  };

  // The period ends on the newest day that can be measured, trying earlier
  // ends up to two windows back. For each end, the period keeps its start if
  // it can (it just gets shorter) or moves back whole. The last window may
  // reach back for sales but never into the first, which ends W-1 days after
  // the period starts; the first may reach back before the period, which the
  // query read for it.
  let through = null, last = null, first = null, start = null;
  for (let d = newest; d >= newest - 2 * W && !last; d--) {
    for (const st of new Set([newest - days + 1, d - days + 1])) {
      const firstEnd = st + W - 1;
      const l = levelAt(d, firstEnd + 1);
      const f = l && levelAt(firstEnd);
      if (l && f) { through = d; last = l; first = f; start = st; break; }
    }
  }
  if (!last) {
    const count = (endDay) => inWin(endDay - W + 1, endDay).length;
    return {
      available: false, days, player, reason: 'not enough sales for a reliable reading',
      method: 'player-trend', windowDays: W, needed: PLAYER_TREND_MIN_WINDOW,
      firstWindow: count(newest - days + W), lastWindow: count(newest), through: throughIso,
    };
  }

  // A point per day from the first window to the last, estimated where its
  // window had to reach back; a day nothing can be read for is left out.
  const series = [];
  let estimatedPoints = 0;
  for (let d = start + W - 1; d <= through; d++) {
    const at = d === through ? last : levelAt(d);
    if (!at) continue;
    if (at.estimated) estimatedPoints++;
    series.push({ date: _mkIso(d), score: round1(100 * Math.exp(at.level - first.level)),
                  matched: at.n, ...(at.estimated ? { estimated: true } : {}) });
  }
  const score = round1(100 * Math.exp(last.level - first.level));
  const shiftedDays = newest - through;
  return {
    available: true,
    days,
    player,
    unit: 'card',
    method: 'player-trend',
    through: _mkIso(through),
    dataLagDays: Math.max(0, _mkDay(new Date().toISOString()) - through),
    score: Math.round(score),
    rawScore: score,
    changePct: round1(score - 100),
    windowDays: W,
    // Set when the headline leans on a reached-back window or an earlier end.
    estimated: !!(first.estimated || last.estimated || shiftedDays > 0),
    estimatedPoints,
    shiftedDays,
    matchedCards: cards,
    cardsPerPlayer: MARKET_CARDS_PER_PLAYER,
    totalObservations: sales,
    series,
  };
}

async function _computePlayerIndex(db, days, player) {
  try {
    // Anchored to this player's newest sale rather than the market's, so a
    // player who stopped selling three weeks ago says so instead of being
    // scored against windows that are empty for them.
    const newest = await db.prepare(
      'SELECT MAX(sold_date) AS d FROM sales WHERE player = ? AND confidence >= ? AND price_cents IS NOT NULL'
    ).bind(player, NFLDB_MIN_CONFIDENCE).first();
    if (!newest || !newest.d) {
      return { available: false, days, player, reason: 'no sales for this player' };
    }

    const throughIso = _mkIso(_mkDay(newest.d) - MARKET_EXCLUDE_TRAILING_DAYS);
    // The same cards as the market's basket for this player (base, raw, no
    // best offers, their busiest ten), measured as a price level rather than
    // a chain of moves — see _playerTrendPayload for why.
    const rows = await (await _playerTrendQuery(db, throughIso, days, player)).all();
    // Only the player's base cards, by the checklist (see _basketBaseOnly):
    // Jaxson Dart's Optic #11 is his Uptown case hit, and its $300-500 sales
    // on thin days read as his whole market quadrupling overnight.
    const list = await _baseCardRowsOnly((rows && rows.results) || []);
    if (list.length === 0) return { available: false, days, player, reason: 'no sales for this player' };
    return _playerTrendPayload(list, throughIso, days, player);
  } catch (err) {
    console.error('[PlayerIndex]', err && err.message);
    return { available: false, days, player, reason: 'index unavailable', transient: true, error: err && err.message };
  }
}

// ---- /api/sold-stats ----
// Market snapshot for the strip under the search bar. Reads our own D1 dataset
// only — no paid provider, no quota — and is football-only because the dataset
// is, which the UI says plainly rather than implying whole-hobby coverage.
//
// Period totals come from the pre-aggregated `daily` table (at most ~90 rows)
// rather than scanning millions of sales. Only the headline lookups touch
// `sales`, and those ride the sold_date / player indexes.
// Rebuilt daily by the cron; this is the safety net, not the schedule.
//
// It is deliberately LONGER than a day. If the TTL expired exactly when the
// boards were due to be rebuilt, then any gap between the two — a missed cron
// tick, a slow run, a deploy landing at the wrong minute — would leave the home
// page computing on demand again, which is the slow load this is meant to
// remove. Two days means a missed run degrades to yesterday's numbers instead,
// and on a 7-to-365-day board that is a difference nobody can see.
const SOLD_STATS_TTL = 60 * 60 * 48;
const SOLD_STATS_PERIODS = [7, 30, 90, 365];
// The home strip shows three of each; the full leaderboard shows fifty. Both
// are served from the SAME cached payload — it is computed at fifty and sliced
// for the strip, so opening the leaderboard costs no extra query and the two
// views can never disagree about what is top.
const SOLD_STATS_TOP = 50;

// --- Movers: what makes this list trustworthy rather than merely computable ---
//
// "Biggest increase" is the single easiest statistic on this site to get wrong,
// and it has already been got wrong once: an earlier grouping produced "2025
// Topps Chrome Jaxson Dart" at +7,127% because sales whose parallel could not
// be read all collapsed into one bucket, pricing a $5 base against a $500
// patch and calling the difference a price move.
//
// Ranking by percentage change makes that worse, not better, because the top of
// such a list is exactly where the noisiest estimates land. A card with two
// sales either side can post +400% from one lucky copy, and it will outrank
// every real mover. So the ranking is constrained before it is sorted:
//
//   raw only        RSI_RAW_ONLY — a PSA 10 among raw copies is not a price
//                   move, it is a different market. Reuses the index's filter.
//   base cards      RSI_BASE_CARD — the market index's rule: a base card with
//                   a year, a set and a number, no parallel in the column or
//                   the title, no print run, not an auto, relic or redemption.
//                   The Jaxson Dart case was a blank-parallel bucket holding all
//                   of those at once; this admits only the one of them that is
//                   the base card, and keys it by number.
//   both halves     at least MOVERS_MIN_HALF sales in each half of the window,
//                   so a ratio rests on real samples on both sides.
//   worth reporting a floor price, so a $1 -> $4 common cannot lead the board.
//
// What survives is a smaller list than a naive query returns. That is the point.
const MOVERS_MIN_HALF = 5;       // sales required in EACH half of the window
const MOVERS_MIN_CENTS = 500;    // $5 — below this, percentages stop meaning much
const MOVERS_MAX_GROUPS = 4000;  // ceiling on rows pulled back for the JS pass
const MOVERS_MIN_CARDS_PER_PLAYER = 3;

// Player-level movement is NOT the average of a player's sales.
//
// A player's mean price moves when their expensive cards happen to trade more
// often, which is a change in what sold, not a change in what things cost. The
// index avoids this by comparing a card only against itself, and the same rule
// applies here: each of the player's cards gets its own change, and the player's
// figure is the MEDIAN of those. A player needs several qualifying cards before
// they can appear at all, so one hot card cannot carry a whole name onto the
// board.
function _median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// v3: gained top sets and both mover boards, and the lists grew from 3 to 50,
// so the key changes rather than serving the old shape to the new UI from a
// warm cache.
// v4: Most Sold groups by KIND, so v3 entries hold base cards, autographs and
// redemption vouchers averaged into one tile. This cache lives for 48 hours and
// is warmed by cron, so without the bump the corrected board would not appear
// for two days — the same mistake that made the grade fix look like it had
// never shipped.
// v5: Most Sold keeps unread parallels out of the base tile, drops cards with
// no number, and takes the photo from a typical sale rather than the dearest.
// v6: the movers board splits autographs, relics and redemptions from the base
// card that shares their number.
// v7: the movers boards take base cards only, keyed by card number.
// v8: the base-card filter recognises X-Fractors and ~35 more parallel and
// insert names, which the movers boards share.
const SOLD_STATS_KEY = (days) => `soldstats:v8:${days}`;

// The boards, computed. Lifted out of the request handler so the cron can call
// it too — see warmSoldStats below. Returns the payload rather than writing a
// response, and never throws: a stats widget must not break the page it sits
// on, and must not fail a cron run either.
async function _computeSoldStats(db, days) {
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  // The split point for "before and after". Half the window each side, so both
  // halves cover the same span and a ratio between them is comparing like with
  // like.
  const mid = new Date(Date.now() - (days / 2) * 86400000).toISOString().slice(0, 10);
  const img = await _nflHasImageColumn(db);
  const imgCol = img ? ', image_url' : '';
  // Boards are aggregates too — biggest sellers, movers, top sets. See
  // _noBestOfferSql: an accepted offer settled under an ask nobody published.
  const noOffer = await _noBestOfferSql(db);

  // The movers board's filters, split as the index splits them: cheap column
  // tests in the WHERE, title-substring tests (print run, best offer, slab
  // words) computed only on the chosen cards' sales. Best offers are excluded
  // here as on every other price board: eBay publishes the ask, not what was
  // paid, and a move computed from asks is not a move in price.
  const moverColTests = `price_cents IS NOT NULL AND sold_date >= ?
                       AND confidence >= ?
                       AND COALESCE(TRIM(player), '') <> ''${RSI_BASE_CARD}`;
  const moverSaleTests = `${RSI_BASE_SERIAL}${noOffer}${RSI_RAW_ONLY}`;

  try {
    const [totals, priciest, mostSold, topSets, movers] = await Promise.all([
      // Pre-aggregated: cheap regardless of how many sales the period holds.
      db.prepare('SELECT SUM(sales) AS sales, SUM(priced) AS priced, SUM(total_cents) AS total FROM daily WHERE sold_date >= ?')
        .bind(since).first(),

      // Priciest individual sales in the window.
      db.prepare(`SELECT item_id, title, price_cents, sold_date, grader, grade${imgCol}
                  FROM sales WHERE price_cents IS NOT NULL${noOffer} AND sold_date >= ?
                  ORDER BY price_cents DESC LIMIT ?`).bind(since, SOLD_STATS_TOP).all(),

      // The most-traded CARDS, and this one deliberately does NOT group in SQL.
      //
      // The parallel column is filled on only 48% of sales; on the rest the
      // parallel is in the title and nowhere else. So a SQL GROUP BY puts a
      // plain base rookie, a Refractor and a Gold /10 in one row and averages
      // them — the same failure as mixing in the autographs, one layer down.
      //
      // Reading titles needs the parallel dictionary, which is JS, so the rows
      // have to come back individually. The reason that is affordable: the
      // board only shows cards that sold a lot, so anything below
      // MOST_SOLD_MIN_GROUP can be discarded in SQL before a single title is
      // read. The inner query does that, and measured at 0.0027ms per title the
      // JS pass over what survives costs ~100ms for 40,000 rows.
      //
      // I built a SQL twin of the kind reader for this an hour ago on the
      // assumption that titles could not be read in bulk. I had not measured
      // it. They can, so it is gone and there is one reader again.
      //
      // Coarse on purpose — no parallel, no kind in the inner grouping — so a
      // card whose autographs are numerous still reaches the JS pass even if
      // each of its parallels alone would not.
      db.prepare(`SELECT s.title, s.price_cents, s.player, s.year, s.set_name,
                         s.parallel, s.card_number, s.item_id, s.sold_date,
                         s.grader, s.grade${img ? ', s.image_url' : ''}
                    FROM sales s
                    JOIN (SELECT player, year, set_name, card_number
                            FROM sales
                           WHERE price_cents IS NOT NULL${noOffer} AND sold_date >= ?
                             AND confidence >= ? AND player IS NOT NULL AND player != ''
                             AND COALESCE(TRIM(card_number), '') <> ''
                           GROUP BY player, year, set_name, card_number
                          HAVING COUNT(*) >= ?
                           ORDER BY COUNT(*) DESC
                           LIMIT ?) g
                      ON s.player = g.player AND s.year IS g.year
                     AND s.set_name IS g.set_name AND s.card_number IS g.card_number
                   WHERE s.price_cents IS NOT NULL AND s.sold_date >= ?
                     AND s.confidence >= ?
                   LIMIT ?`)
        .bind(since, NFLDB_MIN_CONFIDENCE, MOST_SOLD_MIN_GROUP, MOST_SOLD_MAX_GROUPS,
              since, NFLDB_MIN_CONFIDENCE, MOST_SOLD_MAX_ROWS).all(),

      // Highest demand by set: how many cards of it actually changed hands.
      // Deliberately a count, not a price — "demand" is how much of it the
      // market is absorbing, and a set of cheap cards trading constantly is in
      // higher demand than a set of expensive ones that barely move. Both
      // figures are returned so the tile can say which kind of set it is.
      db.prepare(`SELECT year, set_name, COUNT(*) AS n,
                         AVG(price_cents) AS avg_cents, SUM(price_cents) AS total_cents,
                         COUNT(DISTINCT player) AS players
                  FROM sales
                  WHERE price_cents IS NOT NULL AND sold_date >= ?
                    AND confidence >= ? AND COALESCE(TRIM(set_name), '') <> ''
                  GROUP BY year, set_name
                  ORDER BY n DESC LIMIT ?`).bind(since, NFLDB_MIN_CONFIDENCE, SOLD_STATS_TOP).all(),

      // Every card that qualifies for the mover boards, not just the winners.
      // The player board needs the median across a player's cards, so it needs
      // that player's flat and falling cards too — pulling only the top gainers
      // would compute each player's median from their best cards alone and put
      // every name on the board in the green.
      //
      // BASE CARDS ONLY, by the market index's rule (RSI_BASE_CARD and the
      // title test beside it), keyed by card number. The board was built from
      // parallels — it required the parallel column to be filled, which is
      // exactly what base cards leave blank — and a parallel is the hardest
      // thing in a title to read, so its moves were the least trustworthy
      // numbers on the page. Autographs, relics and numbered cards are out too.
      //
      // Two passes, as in the index, because reading titles is what costs:
      //   m_pick   cards with enough sales in BOTH halves, on the cheap column
      //            tests — a necessary condition, re-checked after cleaning;
      //   m_rows   those cards' sales only, each title cleaned once;
      // then the whole-word test, the kind test, and the thresholds for real.
      db.prepare(`WITH m_pick AS MATERIALIZED (
                    SELECT player, year, set_name, card_number
                      FROM sales
                     WHERE ${moverColTests}${moverSaleTests}
                     GROUP BY player, year, set_name, card_number
                    HAVING SUM(CASE WHEN sold_date >= ? THEN 1 ELSE 0 END) >= ?
                       AND SUM(CASE WHEN sold_date <  ? THEN 1 ELSE 0 END) >= ?
                  ),
                  m_rows AS MATERIALIZED (
                    SELECT s.player, s.year, s.set_name, s.card_number, s.parallel,
                           s.sold_date, s.price_cents, s.title, s.item_id${img ? ', s.image_url' : ''},
                           ${RSI_BASE_TITLE_WORDS.replace(/\b(title|player|set_name)\b/g, 's.$1')} AS tw,
                           ${_kindSql('s.title')} AS kind,
                           CASE WHEN 1 = 1 ${_rsiQualify(moverSaleTests, 's')} THEN 1 ELSE 0 END AS ok
                      FROM sales s CROSS JOIN m_pick g
                        ON s.player = g.player AND s.year IS g.year
                       AND s.set_name IS g.set_name AND s.card_number IS g.card_number
                     WHERE ${_rsiQualify(moverColTests, 's')}
                  )
                  SELECT player, year, set_name, card_number,
                         -- "Rated Rookie" sorts above "Base" and blank, so a card
                         -- that is a Rated Rookie is named as one.
                         MAX(parallel) AS parallel,
                         COUNT(*) AS n,
                         SUM(CASE WHEN sold_date >= ? THEN 1 ELSE 0 END) AS n_recent,
                         SUM(CASE WHEN sold_date <  ? THEN 1 ELSE 0 END) AS n_older,
                         AVG(CASE WHEN sold_date >= ? THEN price_cents END) AS recent_cents,
                         AVG(CASE WHEN sold_date <  ? THEN price_cents END) AS older_cents,
                         title, item_id${imgCol}
                    FROM m_rows
                   WHERE ok = 1 AND kind = '' AND ${RSI_BASE_TITLE_TEST}
                   GROUP BY player, year, set_name, card_number
                  HAVING n_recent >= ? AND n_older >= ? AND older_cents >= ?
                   ORDER BY n DESC LIMIT ?`)
        .bind(since, NFLDB_MIN_CONFIDENCE, mid, MOVERS_MIN_HALF, mid, MOVERS_MIN_HALF,
              since, NFLDB_MIN_CONFIDENCE,
              mid, mid, mid, mid,
              MOVERS_MIN_HALF, MOVERS_MIN_HALF, MOVERS_MIN_CENTS, MOVERS_MAX_GROUPS).all(),
    ]);

    const gradeOf = (r) => r.grade != null
      ? `${r.grader || ''} ${String(r.grade).replace(/\.0$/, '')}`.trim()
      : null;
    const linkOf = (r) => r.item_id ? `https://www.ebay.com/itm/${encodeURIComponent(r.item_id)}` : '';

    // The Most Sold board, grouped in JS because the parallel is in the title
    // on half of these sales and the dictionary that reads it is not SQL.
    // Tolerated missing: if the dictionary fails to load the board still
    // builds, using the parallel column alone, rather than the page losing its
    // most prominent panel over an optional artifact.
    const _mostSoldRaw = (mostSold && mostSold.results) || [];
    const { groups: _mostSoldRows, unreadable: _mostSoldUnreadable,
            dropped: _mostSoldDropped } =
      _groupMostSold(_mostSoldRaw, await parallelIndex().catch(() => null),
                     await parallelAliases().catch(() => ({})),
                     await saleOverrides().catch(() => ({})));

    const priced = (totals && totals.priced) || 0;
    const totalCents = (totals && totals.total) || 0;

    // One change per card, from the halves the query already counted.
    // Every mover is a base card. "Base" on each row would say nothing; a Rated
    // Rookie is worth naming, since that is how collectors know the card.
    const _moverPar = (p) => (/rated rookie/i.test(String(p || '')) ? 'Rated Rookie' : '');
    const moverRows = ((movers && movers.results) || []).map(r => ({
      player: r.player,
      name: [r.year, r.set_name, r.player, _moverPar(r.parallel), r.card_number ? `#${r.card_number}` : '']
        .filter(Boolean).join(' ').trim() || r.title,
      kind: 'base',
      sales: r.n,
      recent: Math.round((r.recent_cents || 0) / 100),
      older: Math.round((r.older_cents || 0) / 100),
      changePct: Math.round(((r.recent_cents - r.older_cents) / r.older_cents) * 1000) / 10,
      imageUrl: r.image_url || null,
      itemUrl: linkOf(r),
      query: [r.year, r.set_name, r.player, _moverPar(r.parallel)]
        .filter(Boolean).join(' ').trim() || r.title,
    })).filter(m => Number.isFinite(m.changePct));

    const byChange = (a, b) => b.changePct - a.changePct;

    // Player board: median of that player's card changes, and only for players
    // with enough qualifying cards that the median means something.
    const byPlayer = new Map();
    for (const m of moverRows) {
      if (!byPlayer.has(m.player)) byPlayer.set(m.player, []);
      byPlayer.get(m.player).push(m);
    }
    const playerMovers = [...byPlayer.entries()]
      .filter(([, cards]) => cards.length >= MOVERS_MIN_CARDS_PER_PLAYER)
      .map(([player, cards]) => ({
        player,
        // The median card, not the mean of the cards: one runaway card should
        // move a player up the board, not define their number.
        changePct: Math.round(_median(cards.map(c => c.changePct)) * 10) / 10,
        cards: cards.length,
        sales: cards.reduce((n, c) => n + c.sales, 0),
        // The card carrying them, so the tile can show what actually moved.
        topCard: cards.slice().sort(byChange)[0],
        query: player,
      }))
      .sort(byChange);

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

      mostSold: _mostSoldRows.slice(0, SOLD_STATS_TOP).map(g => {
        const r = g.top || {};
        return {
          // The kind and the parallel are both named. A tile reading only
          // "2026 Topps Fernando Mendoza #301" while holding redemption
          // vouchers, or only "#1" while holding Golds, is not wrong about the
          // price so much as wrong about the card.
          name: [g.year, g.set_name, g.player, g.parallel,
                 g.card_number ? `#${g.card_number}` : '', _KIND_LABEL[g.kind] || '']
            .filter(Boolean).join(' ').trim() || r.title,
          kind: g.kind || 'base',
          parallel: g.parallel || 'Base',
          sales: g.n,
          avgPrice: Math.round(g.total / g.n / 100),
          topPrice: Math.round((g.max || 0) / 100),
          imageUrl: r.image_url || null,
          itemUrl: linkOf(r),
          // What to run when the tile is clicked. Carries the parallel and the
          // kind, or clicking a row labelled Gold Auto runs a search that
          // returns base cards.
          query: [g.year, g.set_name, g.player, g.parallel, _KIND_LABEL[g.kind] || '']
            .filter(Boolean).join(' ').trim() || r.title,
        };
      }),

      // What the board could not name, stated rather than hidden. A sale whose
      // parallel cannot be read is left off rather than pooled with the base
      // card; if this number climbs, the dictionary is missing something.
      mostSoldBasis: {
        salesRead: _mostSoldRaw.length,
        cardsFound: _mostSoldRows.length,
        // Sales whose parallel could not be read, sitting in the unnamed pile
        // with the confident base reads. This is where a Refractor can still
        // hide next to a base card, so its size is the size of what is left.
        unnamedParallelSales: _mostSoldUnreadable,
        // Sales left off because the title names a parallel the dictionary
        // could not read, or the sale has no card number. Kept off rather than
        // pooled with base, so a base tile holds only base cards.
        unplacedParallelSales: _mostSoldDropped,
        minGroupSize: MOST_SOLD_MIN_GROUP,
        // True when the row ceiling bit, so a truncated ranking is never
        // presented as a complete one.
        truncated: _mostSoldRaw.length >= MOST_SOLD_MAX_ROWS,
      },


      topSets: ((topSets && topSets.results) || []).map(r => ({
        name: [r.year, r.set_name].filter(Boolean).join(' ').trim(),
        sales: r.n,
        players: r.players,
        avgPrice: Math.round((r.avg_cents || 0) / 100),
        totalValue: Math.round((r.total_cents || 0) / 100),
        query: [r.year, r.set_name].filter(Boolean).join(' ').trim(),
      })),

      cardMovers: moverRows.slice().sort(byChange).slice(0, SOLD_STATS_TOP),
      playerMovers: playerMovers.slice(0, SOLD_STATS_TOP),

      // What the mover boards were allowed to consider, so the page can say so
      // rather than presenting a filtered ranking as the whole market.
      moversBasis: {
        cardsConsidered: moverRows.length,
        playersConsidered: playerMovers.length,
        minSalesPerHalf: MOVERS_MIN_HALF,
        minPrice: MOVERS_MIN_CENTS / 100,
        minCardsPerPlayer: MOVERS_MIN_CARDS_PER_PLAYER,
        splitDate: mid,
        rawOnly: true,
      },
    };

    return payload;
  } catch (err) {
    // A stats widget must never break the page it sits on.
    console.error('[SoldStats]', err && err.message);
    return { available: false, days, error: 'stats unavailable' };
  }
}

app.get('/api/sold-stats', async (req, res) => {
  const days = SOLD_STATS_PERIODS.includes(parseInt(req.query.days, 10))
    ? parseInt(req.query.days, 10)
    : 30;
  const db = getNflDb();
  if (!db) return res.json({ available: false, days });

  const cached = await cacheGet(SOLD_STATS_KEY(days));
  if (cached) return res.json(_fromCache(cached));

  // Cold cache. This is the slow path the daily warm exists to avoid, and it
  // stays here on purpose: a fresh deploy, an evicted key or a missed cron must
  // still produce boards rather than an empty home page. It self-limits,
  // because the first caller to pay for it fills the cache for everyone else.
  const payload = await _computeSoldStats(db, days);
  if (payload.available) cachePut(SOLD_STATS_KEY(days), payload, SOLD_STATS_TTL);
  res.json(payload);
});

// Build every period's boards and store them, once a day, from the cron.
//
// WHY THIS EXISTS. The boards were computed on demand behind a one-hour TTL,
// which means that every hour some visitor paid the full cost — several passes
// over `sales` plus a JS reduction over up to 4,000 groups — and waited while
// the home page sat empty. Whoever that was experienced the site as slow, and
// with four periods each on their own key it could be four people an hour.
//
// Lengthening the TTL alone would not fix that. It would make the slow load
// rarer, not rarer AND unowned: somebody still eats it, and the longer the TTL
// the more likely that somebody is the first real visitor of the day.
//
// So the cron pays it instead, at a time nobody is waiting, and every visitor
// gets a KV read. The TTL is deliberately longer than the refresh interval —
// see SOLD_STATS_TTL — so a missed run shows yesterday's numbers rather than an
// empty page, which for a 30-day board is a difference nobody can see.
//
// This also costs LESS in D1 than what it replaces: four computations a day,
// against up to twenty-four per period under the old TTL.
async function warmSoldStats() {
  return _asD1Source('sold-stats-warm', () => _warmSoldStats());
}

async function _warmSoldStats() {
  const db = getNflDb();
  if (!db) return { ok: false, reason: 'no dataset' };
  const done = [];
  for (const days of SOLD_STATS_PERIODS) {
    const payload = await _computeSoldStats(db, days);
    if (!payload.available) {
      // Do not overwrite a good cached payload with an unavailable one. A
      // transient D1 failure would otherwise replace working boards with an
      // error for a whole day.
      done.push(`${days}d:skipped`);
      continue;
    }
    await cachePut(SOLD_STATS_KEY(days), payload, SOLD_STATS_TTL);
    done.push(`${days}d:${(payload.cardMovers || []).length}`);
  }
  console.log(`[SoldStats] warmed ${done.join(' ')}`);
  return { ok: true, periods: done };
}

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

// The cached grouping's version, and a fingerprint of the code that decides it.
//
// WHY THE FINGERPRINT EXISTS. Every previous change to card identity bumped
// this version by hand, and the one after those forgot to. The grouping fix
// deployed, the test suite passed, the site kept serving the old answer out of
// KV for half an hour, and the person who reported the bug saw nothing change
// and reasonably concluded the work had not happened.
//
// A convention that has to be remembered will eventually not be. So the three
// modules that decide how sales are grouped are hashed, and card-analysis.test
// compares that hash against the constant below: change any of them without
// bumping the version and the suite fails, naming the fix. Recompute with
//   node -e "..." (the test prints the exact command when it fails)
// v11: the card page checks each sale's parallel against its own title, reads
// "rookie"/"rc" as base, and no longer lumps every parallel together when the
// seed's own parallel is unreadable. Grouping changed in server.js, which the
// fingerprint below does not cover, so the bump is by hand.
// v12: grade-core reads the label's grade wording ("Mint 9", "GEM MT 10") as a
// slab, and the Raw series sheds sales priced like slabs.
// v13: rows are fetched with the parallel, player and card-number columns the
// seed is read with, so v12 entries hold "no sales" for inserts that have them.
// v14: a jumbo / oversized version is its own card, so v13 entries hold
// case-hit jumbos averaged in with the standard size.
// v15: a grade unsold for over a week is priced off its player's market move,
// so v14 entries carry the old estimate.
// v16: prices read off the last comp, or the average of comps within three
// days of it, instead of a median; v15 entries carry the median.
// v17: chase / mystery pack listings are left out, so v16 entries carry them.
const CARD_IDENTITY_VERSION = 'cardanalysis:v17';
const CARD_IDENTITY_MODULES = ['grade-core.js', 'card-kind.js', 'parallel-index-core.js'];
// Re-fingerprinted at v8 without bumping the version: the only change since it
// was set was removing unused exports from card-kind.js, which cannot alter a
// grouping. The guard cannot tell a cosmetic edit from a behavioural one, and
// should not try — it exists to force this judgement, not to make it. Bumping
// here would throw away every cached analysis to no effect.
// Re-fingerprinted again at v10 for the same reason: card-kind.js gained
// kindSql() and exported its word lists, and cardKind() itself is unchanged.
// And again: kindSql()'s substring pre-check dropped a redundant LOWER().
// cardKind() is untouched, so no cached analysis groups differently.
const CARD_IDENTITY_FINGERPRINT = '723e3ea3f1ae';

// A "raw" sale priced like a slab, moved out of the Raw series.
//
// Some slabs never say so in text — no grader, no label wording, just the
// photo — and they sit in a card's Raw list at slab money. A raw median is what
// people price their own loose copy against, so one PSA 10 in it is the worst
// kind of wrong. Where the text has nothing, the price still does: among one
// card's raw sales (one card, one parallel — the grouping above), a sale at
// SLAB_PRICE_X times the raw median is far likelier a slab than a raw copy.
//
// Only with enough raw sales to have a median worth trusting, and at a stricter
// multiple when the card's own slabs do not actually sell above raw (then a
// high "raw" price is weaker evidence). The sales are not deleted: they move to
// a series of their own, named for what they are suspected of, so the reader
// can still see them and the raw line no longer carries them.
const SLAB_PRICE_MIN_RAW = 5;
const SLAB_PRICE_X = 3;
const SLAB_PRICE_X_NO_SLAB_EVIDENCE = 5;
const SUSPECTED_SLAB_LABEL = 'Likely graded (priced like a slab)';
function _flagSlabPricedRaw(byGrade) {
  const raw = byGrade.get('Raw') || [];
  if (raw.length < SLAB_PRICE_MIN_RAW) return 0;
  const cents = (r) => r.price_cents || 0;
  const med = (xs) => { const a = xs.slice().sort((x, y) => x - y); const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
  const rawMed = med(raw.map(cents).filter(c => c > 0));
  if (!(rawMed > 0)) return 0;
  // Do this card's high-grade slabs sell for clearly more than a raw copy?
  let slabsPricier = false;
  for (const [label, list] of byGrade) {
    const m = /\b(9(?:\.5)?|10)$/.exec(label);
    if (!m || list.length < 2) continue;
    if (med(list.map(cents).filter(c => c > 0)) > 1.5 * rawMed) { slabsPricier = true; break; }
  }
  const cut = rawMed * (slabsPricier ? SLAB_PRICE_X : SLAB_PRICE_X_NO_SLAB_EVIDENCE);
  const keep = [], moved = [];
  for (const r of raw) (cents(r) >= cut ? moved : keep).push(r);
  if (!moved.length) return 0;
  byGrade.set('Raw', keep);
  byGrade.set(SUSPECTED_SLAB_LABEL, (byGrade.get(SUSPECTED_SLAB_LABEL) || []).concat(moved));
  return moved.length;
}

// How far one card's prices may spread before a trend across them is refused.
//
// Within ONE parallel at ONE grade, a 40x range is already generous — it covers
// a beaten copy against a clean one, an auction that ended at 3am against a
// patient BIN. Beyond it the bucket is not describing a single card, and the
// honest output is no percentage rather than a confident one.
const PRICE_SPREAD_MAX = 40;

// Which price series a sale belongs to. See grade-core.js — it lives there so
// it can be tested directly, which is how the PSA10 hole was found: the old
// test here was /\b(PSA|BGS|...)\b/, and \b cannot match between "PSA" and
// "10" because both sides are word characters. Every slab listed with the
// grader hard against its number — one of the commonest spellings on eBay —
// was being called Raw, both in this chart and on the sold tiles.
const _gradeBucket = _gradeBucketCore;

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

// What a card is worth off its comps, the way collectors read them: the last
// sale, unless several sold close together — then their average. "Close" is
// within COMP_RECENT_DAYS of that last sale, so three copies that sold the same
// day a week ago still average, and the market move handles how old it is.
// `priced` is newest first: [{ day, price }].
const COMP_RECENT_DAYS = 3;
function _compValue(priced) {
  if (!priced || !priced.length) return null;
  const lastDay = priced[0].day;
  const recent = priced.filter(r => lastDay - r.day <= COMP_RECENT_DAYS);
  if (recent.length >= 2) {
    return { price: recent.reduce((a, r) => a + r.price, 0) / recent.length, count: recent.length, basis: 'recent-average' };
  }
  return { price: priced[0].price, count: 1, basis: 'last-comp' };
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
    const comp = _compValue(fresh);
    return {
      price: round2(comp.price),
      method: 'recent-sales',
      compBasis: comp.basis,
      compCount: comp.count,
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

  // Nothing fresh: the comp value at the last sale (_compValue), then moved
  // by the player's price trend since. The cluster around it is the range.
  const newestDay = priced[0].day;
  const cluster = priced.filter(r => newestDay - r.day <= PRICE_STALE_CLUSTER);
  const ps = cluster.map(r => r.price).sort((a, b) => a - b);
  const base = _compValue(priced).price;
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

// A grade that has not sold in over MARKET_ADJ_AFTER_DAYS: its comp value at
// the last sale (_compValue) moved by the player's market
// change since its last sale. null when it sold recently or the player has no
// market number, and the older estimate applies instead.
function _marketEstimate(list, nowDay, adj) {
  if (!adj) return null;
  const priced = list
    .map(r => ({ day: _mkDay(r.sold_date), price: (r.price_cents || 0) / 100 }))
    .filter(r => Number.isFinite(r.day) && r.price > 0)
    .sort((a, b) => b.day - a.day);
  if (!priced.length) return null;
  const newest = priced[0].day;
  const staleDays = nowDay - newest;
  if (!(staleDays > MARKET_ADJ_AFTER_DAYS)) return null;
  const m = adj(newest);
  if (!m) return null;
  // Its comp value at the last sale (_compValue); the month before it is the range.
  const ps = priced.filter(r => newest - r.day <= 30).map(r => r.price).sort((a, b) => a - b);
  const comp = _compValue(priced);
  const base = comp && comp.price;
  if (!base) return null;
  const round2 = (n) => Math.round(n * 100) / 100;
  return {
    price: round2(base * m.ratio),
    method: 'market-adjusted',
    compBasis: comp.basis,
    compCount: comp.count,
    confidence: staleDays > 90 ? 'low' : 'medium',
    basedOn: ps.length,
    unadjustedPrice: round2(base),
    marketPct: m.pct,
    marketClamped: m.clamped,
    marketFrom: m.fromDate,
    marketThrough: m.throughDate,
    low: round2(ps[0] * m.ratio), high: round2(ps[ps.length - 1] * m.ratio),
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
  //
  // v3: the GROUPING changed, not just the shape. Entries written by v2 hold
  // the old identity — 1/1 autos merged into base cards, one card's sales split
  // across spellings, slabs counted as raw — and they would keep being served
  // for the full TTL after this deploys, which is indistinguishable from the
  // fix not having shipped.
  // v4: identity now separates a base card from its own autograph and relic
  // versions, so v3 entries hold groupings that merged them.
  // v5: identity now also separates a base card from the inserts that share
  // its number, so v4 entries hold groupings that merged them.
  // v6: identity now separates numbered parallels by print run, so v5 entries
  // hold groupings that averaged a /5 with a /10.
  // v7: a laundry tag is no longer read as the grading company TAG, and the
  // grade columns are no longer trusted when it was, so v6 entries hold patch
  // cards filed under a grade nobody issued.
  // v8: a redemption voucher is its own kind, so v7 entries hold "you are due
  // to receive" slips averaged in with the card they promise.
  // v10: BVG joins the grader list, so a title reading "BVG 9.5" with empty
  // columns is a slab rather than a raw card. That MOVES SALES between price
  // series, so v9 entries hold a Raw line with Beckett Vintage money in it.
  // v9: the payload now carries `parallels`, the other parallels of this card
  // and the item id that opens each. The GROUPING is unchanged — this is the
  // v2 case, a shape change — but a warm v8 entry has no such list, so the
  // switcher would be missing for the TTL on exactly the cards people look at
  // most. That is indistinguishable from the feature not having shipped, which
  // is the mistake this comment block exists to stop repeating.
  const cacheKey = `${CARD_IDENTITY_VERSION}:${itemId}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return res.json(_fromCache(cached));

  try {
    const seed = await db.prepare(
      // item_id is selected back out deliberately: the sale desk's decisions are
      // keyed by it, and without it on the row the seed is the one sale whose
      // correction cannot be found — so opening a card by clicking the very
      // sale you just fixed would show it as the card you moved it out of.
      `SELECT item_id, player, year, set_name, parallel, card_number, confidence, title
       FROM sales WHERE item_id = ?`
    ).bind(itemId).first();

    // Not our row, or parsed too loosely to group on — either way there's no
    // trustworthy card identity to gather sales under.
    if (!seed || !seed.player || (seed.confidence || 0) < NFLDB_MIN_CONFIDENCE) {
      const out = { available: false, reason: seed ? 'low-confidence' : 'unknown-item' };
      return res.json(out);
    }

    // NULL-safe matching: `card_number IS NULL` is an ordinary state
    // (unnumbered cards), and `= NULL` never matches.
    //
    // PARALLEL IS DELIBERATELY NOT IN THIS WHERE CLAUSE ANY MORE.
    //
    // It used to be, and matching on it broke the grouping in both directions
    // at once. Only 48.4% of priced sales carry a parallel in the column, so
    // `parallel IS NULL OR parallel = ''` was not the base card — it was the
    // base card PLUS every card whose parallel the collector failed to parse.
    // A 1/1 Gold Vinyl auto landed in the same bucket as a $3 base card, and
    // the "trend" across that bucket read as a 44,446,000% rise. Meanwhile a
    // card whose parallel WAS parsed could not match its own other sales where
    // it was not, so one card with five sales showed two.
    //
    // The rest of the identity is selective enough on its own — one player, one
    // year, one set, one card number — so the parallel is resolved per row
    // below, from the column where it exists and from the title where it does
    // not, and the grouping happens in JS where a title can actually be read.
    const eq = (col, val) => val == null || val === '' ? `${col} IS NULL OR ${col} = ''` : `${col} = ?`;
    const where = [
      'price_cents IS NOT NULL',
      `confidence >= ?`,
      'player = ?',
      `(${eq('year', seed.year)})`,
      `(${eq('set_name', seed.set_name)})`,
      `(${eq('card_number', seed.card_number)})`,
    ].join(' AND ');
    const binds = [NFLDB_MIN_CONFIDENCE, seed.player];
    for (const v of [seed.year, seed.set_name, seed.card_number]) {
      if (v != null && v !== '') binds.push(v);
    }

    const img = await _nflHasImageColumn(db);
    // A card's price chart is the clearest place an accepted offer misleads:
    // one point well under the line, with no way to see the ask it settled
    // against. The sold list below is where those belong.
    const noOffer = await _noBestOfferSql(db);
    const rows = await db.prepare(
      // Every column the seed is read with, the rows are read with too. They
      // used to come back without parallel, player or card_number: the seed's
      // insert read "Downtown" off its column while its OWN row, fetched here,
      // read as base — so an insert's page matched nothing, itself included,
      // and showed "no sales" for a card with 27 of them.
      `SELECT item_id, sold_date, title, price_cents, grader, grade, player, year, set_name,
              parallel, card_number, confidence${img ? ', image_url' : ''}
       FROM sales WHERE ${where}${noOffer}
       ORDER BY sold_date DESC LIMIT 2000`
    ).bind(...binds).all();

    // Now decide which of those rows are actually THIS card.
    //
    // Each row's parallel comes from the column when it has one, and from the
    // title when it does not — the same reader the market index diagnostics
    // use. Three outcomes, and keeping them apart is the entire point:
    //
    //   known parallel  -> compare keys; same key, same card
    //   positively base -> nothing after the card number and nothing before it
    //                      either, which in a feed this structured is evidence
    //                      of a base card rather than of a failed read
    //   unreadable      -> NOT base, and not silently grouped with anything
    //
    // That last line is the fix. Treating an unreadable parallel as base is
    // what merged the 1/1 auto into the base card, and it is the one mistake
    // here that corrupts a price rather than merely costing sample.
    const pi = await parallelIndex().catch(() => null);
    // The parallel desk's decisions, so a phrase settled by a person reads
    // the same here as it does on the boards and in search.
    const pAliases = await parallelAliases().catch(() => ({}));
    // The sale desk's decisions: one photo, looked at, outranking the text.
    const sOverrides = await saleOverrides().catch(() => ({}));
    // The insert desk's decisions, and the product they are keyed by.
    const iAliases = await insertAliases().catch(() => ({}));
    let seedProductId = null;
    try {
      const cIdx = await _loadJson('checklists/index.json');
      const sIdx = buildJoinIndex((cIdx && cIdx.products) || [], undefined, await setAliases()).index;
      const hit = matchSale(sIdx, String(seed.year || ''), String(seed.set_name || ''));
      seedProductId = hit ? (typeof hit === 'string' ? hit : hit.id) : null;
    } catch (err) {
      console.error('[card-analysis] product lookup unavailable:', err && err.message);
    }
    // The parallel words a title uses once the player's and product's own
    // names are removed ("Green" in A.J. Green, "Prizm" the product) — minus
    // the generic suffixes every parallel shares — and whether it is numbered.
    // "SP", "SSP" and "case hit" are how rare a card is, not which parallel:
    // read as parallel words they split one Downtown into three cards.
    const GENERIC_PAR = new Set(['prizm', 'prizms', 'refractor', 'refractors', 'holo', 'parallel', 'sp', 'ssp', 'case', 'hit']);
    const parWords = (row) => {
      let t = ' ' + _stripGrade(String(row.title || '')).toLowerCase().replace(/[^a-z0-9/ ]+/g, ' ') + ' ';
      for (const src of [seed.player, row.set_name || seed.set_name]) {
        for (const w of String(src || '').toLowerCase().split(/[^a-z0-9]+/)) {
          if (w) t = t.replace(new RegExp(`\\b${w}\\b`, 'g'), ' ');
        }
      }
      t = t.replace(_SIGNAL_TEAM_PHRASES, ' ');
      const words = new Set();
      for (const m of t.matchAll(new RegExp(_PARALLEL_SIGNAL.source, 'g'))) {
        if (!GENERIC_PAR.has(m[1])) words.add(m[1]);
      }
      return { words, serial: _SERIAL_RUN.test(t) };
    };
    const keyOf = (row) => {
      // An override first, then the column, then the title — the same chain the
      // board groups by. Grade is stripped inside it: the reader gives up on an
      // unknown token, and "PSA10" is one, so a slab's parallel read as
      // unmatched and the sale was dropped from its own card rather than merely
      // mis-bucketed.
      //
      // Then checked against the title. The reader alone let whole parallels
      // into the wrong card: on 2018 Prizm Josh Allen #205 it read "Red White &
      // Blue" as Blue, "Rookie Card" as a parallel called Rookie, and "Rookie
      // Green Prizm" as base. So a read of "base"/"rookie"/"rc" is the base
      // card; a read is trusted only if the title names no parallel beyond it;
      // and an unreadable title naming no parallel and carrying no print run is
      // the base card, as the Most Sold board already reads it.
      const hit = _saleParallel(row, pi, pAliases, sOverrides, seed.player);
      const { words, serial } = parWords(row);
      let key = null, from = hit.how;
      if (hit.parallel) key = _BASE_NAMES.has(_parallelKey(hit.parallel)) ? '' : _parallelKey(hit.parallel);
      else if (hit.how === 'base') key = '';
      else if (!words.size && !serial) { key = ''; from = 'no-parallel-words'; }
      if (key == null) return { key: null, known: false, from };
      const named = new Set(String(key).split(/[^a-z0-9]+/).filter(Boolean));
      const extra = [...words].filter(w => !named.has(w));
      if (extra.length) return { key: null, known: false, from: `title also says ${extra.join(' ')}` };
      return { key, known: true, from };
    };
    // What an unreadable sale's title says, as a comparable signature: the
    // parallel words it uses, and whether it is numbered.
    const signatureOf = (row) => {
      const { words, serial } = parWords(row);
      return [...words].sort().join(' ') + (serial ? ' #numbered' : '');
    };

    // Base, autograph or relic — the other half of the identity, and the bigger
    // half.
    //
    // A product's autograph sets REUSE the base set's card numbers. 2025 Prizm
    // lists Tyler Shough at #327 in the Base Set, again in Base Autographs and
    // again in Rookie Prizm Choice Auto, and `set_name` holds only the product,
    // so all three grouped together: a $12 base rookie averaged with a $300
    // on-card auto. Across the catalogue this is 65.5% of all ambiguous
    // (player, number) keys — 41,529 of 63,417 — against 28.2% for inserts,
    // which is the problem that looked obvious.
    //
    // Unlike a parallel, absence really is evidence here, and that asymmetry is
    // deliberate rather than careless. A seller does not leave "auto" or
    // "patch" off a title: it is most of what the card is worth. The catalogue
    // agrees — "autograph", "signature", "relic" and "mem" appear in no base set
    // name across 361 checklists.
    //
    // The failure it can still have is a false SPLIT: an auto whose title
    // forgets to say so joins the base group. That is exactly where those sales
    // sit today, so it is not a regression — and it is the safe direction,
    // because the opposite puts autograph money in a base card's median.
    const seedKind = _cardKind(String(seed.title || ''));

    // ?explain=1 — why is this sale in this card's list?
    //
    // The grouping runs on database columns plus four title reads, and when the
    // answer looks wrong from outside there is no way to tell WHICH of those
    // said yes. A slab in the Raw list could be an empty grade column, a title
    // that never names the grade, or the bucket rule; a foreign product in the
    // group could be a collector parse error in set_name or a reader mistake.
    // Those need opposite fixes and guessing between them wastes a day.
    //
    // So this reports, per candidate, every signal that was read and the first
    // rule that excluded it. It answers with evidence instead of a verdict.
    const explain = String(req.query.explain || '') === '1';
    const trace = [];
    const note = (r, verdict, why) => {
      if (!explain || trace.length >= 60) return;
      trace.push({
        itemId: r.item_id, verdict, why,
        price: (r.price_cents || 0) / 100,
        title: String(r.title || '').slice(0, 120),
        columns: {
          player: r.player, year: r.year, set_name: r.set_name,
          card_number: r.card_number, parallel: r.parallel,
          grader: r.grader, grade: r.grade,
        },
        read: {
          kind: _cardKind(String(r.title || '')) || 'base',
          printRun: _printRun(String(r.title || '')),
          gradeBucket: _gradeBucket(r),
        },
      });
    };

    const seedKey = keyOf(seed);
    // The NAME to show, as opposed to the key to group by.
    //
    // The page used to print seed.parallel — the imported column — which is
    // blank whenever the parallel was read from the title, and simply wrong
    // whenever a person has corrected the sale. It grouped by one value and
    // displayed another, so a corrected sale moved to the right card and went
    // on announcing itself as the card it had been moved out of.
    const seedName = (_saleParallel(seed, pi, pAliases, sOverrides, seed.player) || {}).parallel
                     || String(seed.parallel == null ? '' : seed.parallel).trim();
    // Pack listings are not this card, whatever the photo shows (_isPackListing).
    const candidates = ((rows && rows.results) || []).filter(r => !_isPackListing(r.title, r.player));
    // The same base card in its OTHER parallels, bucketed as they are excluded.
    // These rows were already read and identified; throwing them away wastes
    // the only expensive part of this request, and they are precisely what
    // somebody looking at one parallel's price wants to compare against.
    const siblingRows = new Map();
    let all, unreadable = 0, excludedOtherParallel = 0, excludedOtherKind = 0;
    if (seedKey.known) {
      all = [];
      for (const r of candidates) {
        const k = keyOf(r);
        if (!k.known) { unreadable++; note(r, 'dropped', `parallel unreadable (${k.from})`); continue; }
        if (k.key !== seedKey.key) {
          excludedOtherParallel++;
          let bucket = siblingRows.get(k.key);
          if (!bucket) {
            // Named once per bucket, from the same reader the grouping used,
            // so a corrected sale announces the parallel it was moved into.
            const nm = (_saleParallel(r, pi, pAliases, sOverrides, seed.player) || {}).parallel;
            siblingRows.set(k.key, bucket = { name: k.key === '' ? 'Base' : (nm || k.key), rows: [] });
          }
          bucket.rows.push(r);
          note(r, 'dropped', `different parallel: "${k.key}" vs "${seedKey.key}"`); continue;
        }
        if (_cardKind(String(r.title || '')) !== seedKind) {
          excludedOtherKind++;
          note(r, 'dropped', `different kind: ${_cardKind(String(r.title || '')) || 'base'} vs ${seedKind || 'base'}`);
          continue;
        }
        all.push(r);
      }
    } else {
      // The clicked sale's own parallel could not be read, so there is no key
      // to group on. Falling back to the old column match is the honest move:
      // it is what the page did before, its limits are stated in the payload,
      // and inventing a grouping from a title we could not parse would be a
      // guess presented as an identity.
      // The KIND still applies here. It is read from the title, not from the
      // parallel, so an unreadable parallel says nothing about whether the card
      // is an autograph — and leaving autos in this bucket is the very merge
      // this is meant to stop, on the path where the data is already weakest.
      //
      // But the column alone is blank on most rows, so this path lumped every
      // parallel of the card together — a Neon Green Pulsar and a Hyper /275 in
      // the list and chart of a raw base Josh Allen #205. What is not a guess is
      // the words the title uses: keep only sales whose titles use the SAME
      // parallel words (and the same numbering) as the clicked one, and none
      // whose own parallel reads as something definite.
      const col = String(seed.parallel == null ? '' : seed.parallel).trim();
      const sig = signatureOf(seed);
      const before = candidates.filter(r => {
        if (String(r.parallel == null ? '' : r.parallel).trim() !== col) return false;
        if (keyOf(r).known) { note(r, 'dropped', 'a readable parallel; the seed is not'); return false; }
        if (signatureOf(r) !== sig) { note(r, 'dropped', `different parallel words: "${signatureOf(r)}" vs "${sig}"`); return false; }
        return true;
      });
      excludedOtherParallel = candidates.length - before.length;
      all = before.filter(r => _cardKind(String(r.title || '')) === seedKind);
      excludedOtherKind = before.length - all.length;
    }

    // ---- the insert, last of all ----
    //
    // A product's inserts reuse the base set's numbering too: 2017 Prizm has a
    // base #8 and an Instant Impact #8 and eight more, and `set_name` holds only
    // the product. That is 28.2% of ambiguous (player, number) keys — the second
    // largest kind after autographs, which the filter above already took out.
    //
    // Applied to the SURVIVORS rather than to every candidate, and that is a
    // cost decision, not a stylistic one. resolveSubset() walks a title against
    // a 4,522-name vocabulary at 0.028ms a call, measured — so the 2,000-row
    // candidate list costs 57ms, on a user-facing request whose whole CPU budget
    // is around 50ms. What reaches here after the parallel and kind filters is
    // usually a handful: 0.3ms for the same answer.
    //
    // Absence is treated as "no insert", the same asymmetry the kind filter
    // makes and for the same reason: a seller names the insert because it is
    // what the card is. The residual failure is a false SPLIT — an insert whose
    // title omits its name joins the base group — which is exactly where those
    // sales sit today, so it is not a regression, and it is the safe direction:
    // the opposite puts a Downtown's price into a base card's median.
    // ---- the print run ----
    //
    // A Cam Ward auto /5 and a Cam Ward auto /10 are different cards with very
    // different prices, and every column in the sales table is identical for
    // both: same player, year, set, number, and the same "auto" kind. Only the
    // title separates them.
    //
    // The rule here is STRICTER than the one for kind, and deliberately so. For
    // an autograph, absence of the word is evidence — sellers do not omit
    // "auto" because it is most of the price. For a print run that is weaker: a
    // /199 goes unstated often enough that treating silence as "unnumbered"
    // would split real cards apart.
    //
    // So this only ever separates when BOTH sides state a run and the runs
    // differ. An unstated run merges, which is exactly where those sales sit
    // today — no regression, and no new false splits.
    let excludedOtherPrintRun = 0;
    {
      const seedRun = _printRun(String(seed.title || ''));
      // An unnumbered card has no numbered copies: a /275 is a different card
      // however the rest of its title reads.
      const kept = all.filter(r => {
        const run = _printRun(String(r.title || ''));
        return seedRun != null ? (run == null || run === seedRun) : run == null;
      });
      excludedOtherPrintRun = all.length - kept.length;
      all = kept;
    }

    // ---- the size ----
    //
    // A jumbo or oversized Downtown is not the Downtown: a different card, sold
    // one to a box as a case hit, at a different price ($25 against $470 on
    // the same day for Cam Ward #12). Every column is identical for both, so
    // only the title separates them — and sellers always say it, because the
    // size is what the buyer is paying for. Split both ways, like the kind.
    let excludedOtherSize = 0;
    {
      const seedJumbo = _isOversize(seed.title);
      const kept = all.filter(r => _isOversize(r.title) === seedJumbo);
      excludedOtherSize = all.length - kept.length;
      all = kept;
    }

    let excludedOtherSubset = 0;
    // Carried out of the block below so the parallel pass can reuse the answer
    // instead of resolving the seed's insert a second time. The declaration
    // inside stays as it is: insert-desk.test asserts on that exact line, to
    // guarantee the card page reads desk decisions through the shared reader.
    let seedSubsetResolved = '';
    if (pi) {
      // Through the aliased reader, so a decision made on the insert desk
      // reaches the card page. Wiring it into one screen and not the others is
      // how this codebase has lost a day twice.
      const ctx = { productId: seedProductId, player: seed.player, cardNumber: seed.card_number };
      const seedSubset = resolveSubsetAliased(pi, seed.title, ctx, iAliases).subset;
      // Compared without punctuation: "Downtown!" and "Downtown" are one insert.
      seedSubsetResolved = _subsetKey(seedSubset);
      const kept = all.filter(r =>
        _subsetKey(resolveSubsetAliased(pi, r.title,
          { productId: seedProductId, player: r.player, cardNumber: r.card_number },
          iAliases).subset) === seedSubsetResolved);
      excludedOtherSubset = all.length - kept.length;
      all = kept;
    }

    // ---- the other parallels, as somewhere to switch to ----
    //
    // Everything above narrows to ONE parallel. This turns the rows it set
    // aside into options, so a Silver can be compared against the Base and the
    // Gold without going back to the search box and retyping the card.
    //
    // Each option carries a representative item id rather than an encoded
    // identity. Switching is then another call to this same endpoint, which
    // keeps the definition of "same card" in exactly one place — the last
    // attempt at this feature re-ran a text SEARCH per parallel and inherited
    // every ambiguity the search box has.
    //
    // The kind and print-run filters are applied here too: offering "Gold" and
    // landing the reader on an autograph would be worse than not offering it.
    // The insert filter is budgeted, because resolveSubset is the expensive
    // read on this path (0.028ms a call against a 4,522-name vocabulary) and
    // the request's whole CPU budget is around 50ms. A count here is a
    // preview; switching re-derives it exactly through the pipeline above.
    const parallels = [];
    {
      const seedRun = _printRun(String(seed.title || ''));
      let subsetBudget = 400;
      const ranked = [...siblingRows.entries()]
        .sort((a, b) => b[1].rows.length - a[1].rows.length)
        .slice(0, 12);
      for (const [key, bucket] of ranked) {
        const seedJumbo = _isOversize(seed.title);
        let kept = bucket.rows.filter(r => _cardKind(String(r.title || '')) === seedKind
          && _isOversize(r.title) === seedJumbo);
        if (seedRun != null) {
          kept = kept.filter(r => {
            const run = _printRun(String(r.title || ''));
            return run == null || run === seedRun;
          });
        }
        if (pi && kept.length <= subsetBudget) {
          subsetBudget -= kept.length;
          kept = kept.filter(r =>
            _subsetKey(resolveSubsetAliased(pi, r.title,
              { productId: seedProductId, player: r.player, cardNumber: r.card_number },
              iAliases).subset) === seedSubsetResolved);
        }
        const prices = kept.map(r => (r.price_cents || 0) / 100)
          .filter(p => p > 0).sort((a, b) => a - b);
        if (!prices.length) continue;
        const mid = Math.floor(prices.length / 2);
        // The newest sale stands for the parallel: it is the likeliest to still
        // parse the way the rest of this pipeline expects when it is reopened.
        const rep = kept.reduce((best, r) =>
          String(r.sold_date || '') > String(best.sold_date || '') ? r : best, kept[0]);
        parallels.push({
          key, name: bucket.name, sales: kept.length, itemId: rep.item_id,
          median: Math.round(prices.length % 2 ? prices[mid] : (prices[mid - 1] + prices[mid]) / 2),
        });
      }
      // Base first, then by how much actually traded.
      parallels.sort((a, b) =>
        (a.key === '' ? -1 : b.key === '' ? 1 : 0) || b.sales - a.sales);
    }

    if (all.length === 0) {
      // This exact card has never sold. It can still be priced off its
      // siblings, so the modal has something useful to show rather than a
      // dead end — flagged as an estimate from other cards, not this one.
      const similar = await _similarVariantEstimate(db, seed);
      const out = similar
        ? { available: false, reason: 'no-sales', estimate: similar }
        : { available: false, reason: 'no-sales' };
      // "No sales" for a card that plainly has them is the answer most worth
      // explaining, so ?explain=1 carries the trace here too — uncached, like
      // the full payload's.
      if (explain) return res.json({ ...out, explain: { seed: { title: seed.title, parallel: seed.parallel, set_name: seed.set_name, card_number: seed.card_number, key: seedKey }, trace } });
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

    // A grade that has not sold in over a week is priced off its player's
    // market move since its last sale (_playerMarketAdjuster). "Now" is the
    // player's newest sale rather than this card's, so a card that simply went
    // quiet while the player kept trading is the one that gets moved.
    let marketNowDay = newestDay, marketAdj = null;
    try {
      const pn = await db.prepare(
        'SELECT MAX(sold_date) AS d FROM sales WHERE player = ? AND confidence >= ? AND price_cents IS NOT NULL'
      ).bind(seed.player, NFLDB_MIN_CONFIDENCE).first();
      if (pn && pn.d && Number.isFinite(_mkDay(pn.d))) marketNowDay = Math.max(newestDay, _mkDay(pn.d));
      const gradeNewest = Array.from(new Set(all.map(r => _gradeBucket(r)))).map(k =>
        Math.max(...all.filter(r => _gradeBucket(r) === k).map(r => _mkDay(r.sold_date)).filter(Number.isFinite)));
      const oldestGradeNewest = Math.min(...gradeNewest.filter(Number.isFinite));
      if (Number.isFinite(oldestGradeNewest)) {
        marketAdj = await _playerMarketAdjuster(db, seed.player, marketNowDay, oldestGradeNewest);
      }
    } catch (err) {
      console.error('[card-analysis] player market unavailable:', err && err.message);
    }

    // Split into per-grade series, then reduce each to one point per day so a
    // busy day doesn't outweigh a quiet one on the chart.
    const byGrade = new Map();
    for (const r of all) {
      const k = _gradeBucket(r);
      if (!byGrade.has(k)) byGrade.set(k, []);
      byGrade.get(k).push(r);
    }
    const suspectedSlabs = _flagSlabPricedRaw(byGrade);

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
      //
      // Suppressed when the bucket's own prices span more than PRICE_SPREAD_MAX.
      // A percentage change only means anything if both sides are samples of
      // the same thing, and one card in one parallel at one grade does not
      // trade from $3 to $900 — a spread that wide is the bucket telling you it
      // holds more than one card, not the market telling you it moved. This is
      // the second line of defence behind the grouping fix above: that stops
      // the merge happening, and this stops a merge that slips through being
      // published as a 44,446,000% rise, which is how the problem was reported.
      let changePct = null;
      let trendSuppressed = null;
      if (points.length >= 2) {
        const prior = points.slice(0, -1).map(p => p.median).sort((a, b) => a - b);
        const base = _median(prior);
        const last = points[points.length - 1].median;
        const lo = prices[0], hi = prices[prices.length - 1];
        if (lo > 0 && hi / lo > PRICE_SPREAD_MAX) {
          trendSuppressed = 'prices in this group span too wide a range to be one card';
        } else if (base > 0) {
          changePct = Math.round(((last - base) / base) * 1000) / 10;
        }
      }

      // Trend is anchored to THIS grade's own last sale, not the card's, so a
      // grade that stopped selling long ago isn't adjusted by the wrong span.
      const gradeNewest = Math.max(...list.map(r => _mkDay(r.sold_date)).filter(Number.isFinite));
      const gradeTrend = (trend && Number.isFinite(gradeNewest)) ? trend : null;

      return {
        label,
        sales: list.length,
        estimate: _marketEstimate(list, marketNowDay, marketAdj) || _estimateGrade(list, newestDay, gradeTrend),
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
        trendSuppressed,
        points,
      };
    }).sort((a, b) => b.sales - a.sales);

    if (explain) for (const r of all) note(r, 'kept', 'matched on every rule');

    const dates = all.map(r => r.sold_date).filter(Boolean).sort();
    const payload = {
      available: true,
      generatedAt: new Date().toISOString(),
      card: {
        name: [seed.year, seed.set_name, seed.player, seedName, seed.card_number ? `#${seed.card_number}` : '']
          .filter(Boolean).join(' ').trim() || seed.title,
        player: seed.player, year: seed.year, set: seed.set_name,
        parallel: seedName, cardNumber: seed.card_number,
        imageUrl: (all.find(r => r.image_url) || {}).image_url || null,
      },
      totalSales: all.length,
      firstSale: dates[0] || null,
      lastSale: dates[dates.length - 1] || null,
      grades,
      // How the identity was decided, and what it cost.
      //
      // Reported rather than hidden because both numbers are claims a reader
      // can check. `otherParallels` is sales of this same base card in a
      // different parallel, correctly kept out — that count used to be zero
      // because they were all being let in. `unreadable` is sales whose
      // parallel could not be determined from either the column or the title;
      // they are neither included nor called base, and saying so is better than
      // a total that quietly omits them.
      // The same base card in its other parallels, each with the item id that
      // reopens this endpoint on it. Empty when nothing else of this card sold,
      // and when the clicked sale's own parallel could not be read at all —
      // there is no key to be "other" than.
      parallels,
      identity: {
        parallel: seedKey.known
          ? (seedKey.key === '' ? 'Base' : (seedName || null))
          : null,
        resolvedFrom: seedKey.from,
        // base, auto or relic. Empty means a plain base card.
        kind: seedKind || 'base',
        grouped: all.length,
        // "Raw" sales priced like slabs, moved to their own series.
        suspectedSlabs,
        otherParallels: excludedOtherParallel,
        // Sales of this same number in this same product that are a different
        // KIND — the autograph or relic version. Previously grouped in.
        otherKinds: excludedOtherKind,
        // Sales of this same number in this same product belonging to a
        // different insert. Previously grouped in.
        otherSubsets: excludedOtherSubset,
        // The print run this card is, and how many sales of the same card at a
        // DIFFERENT run were kept out. null means no run was stated.
        printRun: _printRun(String(seed.title || '')),
        otherPrintRuns: excludedOtherPrintRun,
        // Jumbo / oversized: whether this card is one, and how many sales of
        // the other size were kept out.
        oversize: _isOversize(seed.title),
        otherSizes: excludedOtherSize,
        unreadable,
      },
    };

    if (explain) {
      // Never cached: a trace is a question about right now, and a stale one
      // would be answering about a grouping that no longer exists.
      return res.json({
        explain: true,
        seed: {
          itemId, title: seed.title,
          columns: {
            player: seed.player, year: seed.year, set_name: seed.set_name,
            card_number: seed.card_number, parallel: seed.parallel,
            confidence: seed.confidence,
          },
          read: {
            parallelKey: seedKey.key, parallelFrom: seedKey.from,
            kind: seedKind || 'base',
            printRun: _printRun(String(seed.title || '')),
          },
        },
        identity: payload.identity,
        candidatesSeen: candidates.length,
        grouped: all.length,
        trace,
      });
    }
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
  if (cached) return res.json(_fromCache(cached));

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
      generatedAt: new Date().toISOString(),
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
  if (cached) return res.json(_fromCache(cached));

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
  if (cached) return res.json(_fromCache(cached));

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
// The admin gate.
//
// FAILS CLOSED when ADMIN_PASSWORD is unset, and that is the entire point of
// this rewrite. It used to fall back to a literal `'cardhuddle-admin'`, in a
// PUBLIC repository — so anyone who read server.js had the live admin password
// unless the secret happened to be set. Admin here is not cosmetic: it deletes
// news and community posts, runs the scan-lead email drip, reads lead stats and
// writes set aliases into the pricing join.
//
// A missing secret must mean "nobody is an admin", never "everybody is". The
// cost of that choice is that forgetting to set it locks the owner out, which
// is a loud, obvious failure — the opposite of the silent one it replaces.
//
// Compared in constant time. The comparison happens on every admin request and
// a short-circuiting === leaks the password's length and prefix to anyone
// willing to time it. crypto.timingSafeEqual is not reliably present on
// Workers, so this is done by hand: fixed number of iterations, no early exit.
function _safeEqual(a, b) {
  const x = String(a == null ? '' : a);
  const y = String(b == null ? '' : b);
  // Length is compared without branching on it, then folded into the result, so
  // a wrong-length guess costs the same as a wrong-character one.
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) {
    diff |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
  }
  return diff === 0;
}

function isAdminReq(req) {
  const adminPass = process.env.ADMIN_PASSWORD;
  if (!adminPass) return false;
  const key = (req.query && req.query.key) || req.headers['x-admin-key'];
  if (!key) return false;
  return _safeEqual(key, adminPass);
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

// ---- Attached photos: screened, or not published ----
//
// moderateImage() reports honestly and refuses to decide policy — with no
// provider configured it returns { allowed: true, verified: false }, meaning
// "nobody looked at this". Both call sites used to publish on that, leaving
// the report/auto-hide net as the only screen. That net needs
// COMMUNITY_AUTOHIDE_REPORTS distinct people to report a post, which on a
// small feed can take days or never happen.
//
// The photo lands on the same URL as the ad tag, because the community feed is
// a panel inside the app shell. An unscreened image beside ads is the kind of
// thing that costs an AdSense account rather than an application, and the
// asymmetry is stark: refusing a photo annoys one person for a minute, while
// publishing the wrong one is not reversible by noticing it later.
//
// So an image nobody screened does not publish. Text posts are unaffected, so
// the feed still works with photos off, and wiring IMAGE_MODERATION_URL +
// IMAGE_MODERATION_KEY turns them straight back on. Setting
// COMMUNITY_ALLOW_UNVERIFIED_IMAGES=1 restores the old behaviour deliberately,
// which is a different thing from arriving at it by not having configured
// anything.
const COMMUNITY_ALLOW_UNVERIFIED_IMAGES = process.env.COMMUNITY_ALLOW_UNVERIFIED_IMAGES === '1';

// Returns null to publish, or an { status, body } refusal for the caller to send.
async function screenCommunityImage(imageUrl) {
  if (!imageUrl) return null;
  let check;
  try {
    check = await moderateImage(imageUrl);
  } catch (_) {
    // The screen itself failed. That is "nobody looked at this" too.
    check = { allowed: true, verified: false };
  }
  if (!check.allowed) {
    return { status: 422, body: {
      error: 'That image didn’t pass our content check. Please choose a different photo.',
      reason: 'image',
    } };
  }
  if (!check.verified && !COMMUNITY_ALLOW_UNVERIFIED_IMAGES) {
    return { status: 503, body: {
      error: 'Photo uploads are paused — we can’t screen images right now. Please post without a photo and try adding it later.',
      reason: 'image-screening-unavailable',
    } };
  }
  return null;
}

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
  // Image: screened, or not published. See screenCommunityImage.
  const imgRefusal = await screenCommunityImage(imageUrl);
  if (imgRefusal) return res.status(imgRefusal.status).json(imgRefusal.body);
  // Anything that reaches here was either screened clean or deliberately
  // allowed through by COMMUNITY_ALLOW_UNVERIFIED_IMAGES.
  const imageVerified = !imageUrl ? true : !COMMUNITY_ALLOW_UNVERIFIED_IMAGES;

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
  // Same rule as a post: an image nobody screened does not publish.
  const imgRefusal = await screenCommunityImage(imageUrl);
  if (imgRefusal) return res.status(imgRefusal.status).json(imgRefusal.body);
  const imageVerified = !imageUrl ? true : !COMMUNITY_ALLOW_UNVERIFIED_IMAGES;

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
  // Was its own copy of the gate, with its own copy of the hardcoded fallback.
  // One gate, so a fix to it cannot miss a route.
  if (!isAdminReq(req)) return res.status(401).json({ error: 'Unauthorized' });
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
// ---------------------------------------------------------------------------
// News / articles
//
// Server-rendered, not SPA-rendered. That is the entire reason the section
// exists: articles are a bet on holding attention long enough for an ad to be
// worth something, and an article delivered as an empty <div id="app"> ranks
// for nothing and holds no one. Every route here returns finished markup.
const NEWS_FILE = path.join(APP_ROOT, 'data', 'news.json');
const NEWS = require('./news');
const NEWS_SITE = process.env.SITE_URL || 'https://thecardhuddle.com';

function loadNews() {
  const list = loadData('news', NEWS_FILE, []);
  return Array.isArray(list) ? list : [];
}
function saveNews(list) { saveData('news', NEWS_FILE, list); }

function newsPublished() {
  const now = Date.now();
  return loadNews()
    .filter(a => NEWS.isPublished(a, now))
    .sort((a, b) => String(b.publishedAt || '').localeCompare(String(a.publishedAt || '')));
}

// Resolve {{sold-table}} blocks before rendering. The renderer's shortcode hook
// is synchronous and the sales query is not, so the shortcodes are found and
// resolved first, then handed over as a ready map. The other order would mean
// either blocking the renderer or shipping a half-built page.
async function newsResolveShortcodes(body) {
  const found = [...String(body || '').matchAll(/\{\{\s*sold-table([^}]*)\}\}/gi)];
  const map = new Map();
  if (!found.length) return map;
  const db = getNflDb();
  for (const m of found) {
    const args = NEWS.parseArgs(m[1]);
    map.set(m[0], db ? await newsSoldTable(db, args) : null);
  }
  return map;
}

// The table an article is written around: what a card actually sold for, by
// parallel, over a window. Raw only and grouped the way the index groups, so a
// number quoted in an article is the same number the rest of the site shows.
async function newsSoldTable(db, args) {
  const player = String(args.player || '').trim();
  if (!player) return null;
  const days = Math.min(365, Math.max(7, parseInt(args.days, 10) || 30));
  try {
    const newest = await db.prepare(
      'SELECT MAX(sold_date) AS d FROM sales WHERE price_cents IS NOT NULL').first();
    if (!newest || !newest.d) return null;
    const through = _mkIso(_mkDay(newest.d) - MARKET_EXCLUDE_TRAILING_DAYS);
    const since = _mkIso(_mkDay(through) - days);
    const setFilter = args.set ? ' AND ' + _normCol('set_name') + ' = ?' : '';
    const binds = [player.toLowerCase().replace(/\s+/g, ' ').trim(), since, through];
    if (args.set) binds.push(String(args.set).toLowerCase().replace(/\s+/g, ' ').trim());
    const r = await db.prepare(
      'SELECT COALESCE(NULLIF(TRIM(parallel), \'\'), \'Base\') AS par,'
      + ' COUNT(*) AS n, AVG(price_cents) AS avg_cents'
      + ' FROM sales'
      + ' WHERE ' + _normCol('player') + ' = ?'
      + '   AND sold_date > ? AND sold_date <= ?'
      + '   AND price_cents IS NOT NULL AND price_cents > 0'
      + '   AND ' + _rsiRawOnlySql()
      + setFilter
      + ' GROUP BY par HAVING n >= 2'
      + ' ORDER BY avg_cents DESC LIMIT 12').bind(...binds).all();
    const rows = (r && r.results) || [];
    if (!rows.length) return null;
    const money = (c) => '$' + Math.round(Number(c) / 100).toLocaleString('en-US');
    const body = rows.map(x => '<tr><td>' + NEWS.esc(x.par) + '</td>'
      + '<td class="num">' + money(x.avg_cents) + '</td>'
      + '<td class="num">' + x.n + '</td></tr>').join('');
    return '<figure class="sold-table"><table><thead><tr><th>Parallel</th>'
      + '<th class="num">Avg sold</th><th class="num">Sales</th></tr></thead>'
      + '<tbody>' + body + '</tbody></table>'
      + '<figcaption>' + NEWS.esc(player) + (args.set ? ' &middot; ' + NEWS.esc(args.set) : '')
      + ' &middot; raw sales, ' + days + ' days to ' + through
      + '. Live from The Card Huddle.</figcaption></figure>';
  } catch (err) {
    // An article must never fail to render because a table could not be built.
    console.error('[news] sold-table failed:', err && err.message);
    return null;
  }
}

const NEWS_CSS = [
  ':root{--bg:#0c0e14;--card:#1a2133;--card2:#111827;--line:#232d42;--fg:#edf0f7;--fg2:#94a3b8;--fg3:#475569;--ac:#5ece99}',
  '*{box-sizing:border-box}',
  'body{margin:0;background:var(--bg);color:var(--fg);font-family:Inter,"Segoe UI",system-ui,-apple-system,sans-serif;line-height:1.6}',
  'a{color:var(--ac);text-decoration:none}a:hover{color:#7edcb0}',
  '.wrap{max-width:1200px;margin:0 auto;padding:0 24px}',
  'header.site{background:linear-gradient(135deg,#131827 0%,#151d33 50%,#141a2d 100%);border-bottom:1px solid var(--line)}',
  'header.site .wrap{display:flex;align-items:center;gap:24px;padding-top:18px;padding-bottom:18px;flex-wrap:wrap}',
  '.brand{font-size:15px;font-weight:800;letter-spacing:-.01em;color:var(--fg)}',
  'nav.site{display:flex;gap:4px;flex-wrap:wrap}',
  'nav.site a{font-size:12.8px;font-weight:500;color:var(--fg2);padding:7px 14px;border-radius:10px}',
  'nav.site a.on{color:var(--fg);background:rgba(94,206,153,.1);border:1px solid rgba(94,206,153,.22)}',
  'h1{font-size:40px;font-weight:800;line-height:1.15;letter-spacing:-.025em;margin:0;text-wrap:pretty}',
  '.lede{font-size:18px;line-height:1.55;color:var(--fg2);margin:16px 0 0;text-wrap:pretty}',
  '.meta{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:12.8px;color:var(--fg3);padding:14px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line);margin:20px 0 28px}',
  '.kicker{font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--ac)}',
  'article{max-width:680px;font-size:17px;color:#cbd5e1}',
  'article h2{font-size:24px;font-weight:700;letter-spacing:-.015em;color:var(--fg);margin:36px 0 0}',
  'article h3{font-size:19px;font-weight:700;color:var(--fg);margin:28px 0 0}',
  'article p{margin:20px 0}',
  'article strong{color:var(--fg);font-weight:700}',
  'article blockquote{border-left:3px solid var(--ac);margin:28px 0;padding:4px 0 4px 20px;font-size:20px;line-height:1.5;color:var(--fg);font-weight:500}',
  'article ul{padding-left:22px}article li{margin:8px 0}',
  'article code{background:#111624;border:1px solid var(--line);border-radius:4px;padding:1px 5px;font-size:14px}',
  '.sold-table{margin:28px 0;background:linear-gradient(160deg,var(--card) 0%,var(--card2) 100%);border:1px solid var(--line);border-radius:14px;overflow:hidden}',
  '.sold-table table{width:100%;border-collapse:collapse;font-size:14px}',
  '.sold-table th{font-size:11px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--fg2);text-align:left;padding:12px 18px;background:rgba(94,206,153,.04);border-bottom:1px solid var(--line)}',
  '.sold-table td{padding:13px 18px;border-bottom:1px solid var(--line);color:var(--fg)}',
  '.sold-table tr:last-child td{border-bottom:0}',
  '.sold-table .num{text-align:right}',
  '.sold-table figcaption{padding:12px 18px;font-size:12.4px;color:var(--fg3);border-top:1px solid var(--line)}',
  '.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:20px;margin:28px 0 56px}',
  '.card{background:linear-gradient(160deg,var(--card) 0%,var(--card2) 100%);border:1px solid var(--line);border-radius:14px;padding:18px;display:flex;flex-direction:column;gap:10px}',
  '.card h2{margin:0;font-size:17px;font-weight:700;line-height:1.35;letter-spacing:-.01em}',
  '.card h2 a{color:var(--fg)}',
  '.card p{margin:0;font-size:13.6px;line-height:1.55;color:var(--fg2);flex-grow:1}',
  '.card .foot{display:flex;gap:8px;font-size:12.4px;color:var(--fg3);padding-top:4px;border-top:1px solid var(--line)}',
  '.ad{border:1px dashed #2d6a4f;border-radius:10px;background:rgba(94,206,153,.03);min-height:96px;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#2d6a4f;margin:32px 0;max-width:680px}',
  'footer.site{border-top:1px solid var(--line);margin-top:48px;padding:24px 0;font-size:12.8px;color:var(--fg3)}',
  '@media(max-width:640px){h1{font-size:30px}article{font-size:16px}}',
].join('\n');

function newsShell(opts) {
  const jsonLd = opts.jsonLd
    ? '<script type="application/ld+json">' + opts.jsonLd + '</script>' : '';
  return '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">'
    + '<title>' + NEWS.esc(opts.title) + '</title>'
    + '<meta name="description" content="' + NEWS.esc(opts.description) + '">'
    + '<link rel="canonical" href="' + NEWS.esc(opts.canonical) + '">'
    + '<meta property="og:title" content="' + NEWS.esc(opts.title) + '">'
    + '<meta property="og:description" content="' + NEWS.esc(opts.description) + '">'
    + '<meta property="og:type" content="article">'
    + '<meta property="og:url" content="' + NEWS.esc(opts.canonical) + '">'
    + '<link rel="preconnect" href="https://fonts.googleapis.com">'
    + '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>'
    + '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">'
    + '<style>' + NEWS_CSS + '</style>' + jsonLd
    + '</head><body>'
    + '<header class="site"><div class="wrap">'
    + '<a class="brand" href="/">The Card Huddle</a>'
    + '<nav class="site"><a href="/">Search</a><a href="/sets/">Checklists</a>'
    + '<a href="/">Market</a><a class="on" href="/news">News</a></nav>'
    + '</div></header><main class="wrap">' + opts.body + '</main>'
    + '<footer class="site"><div class="wrap">&copy; ' + new Date().getFullYear()
    + ' The Card Huddle &middot; <a href="/news">News</a> &middot; <a href="/">Prices</a>'
    + '</div></footer></body></html>';
}

app.get('/news', (req, res) => {
  const list = newsPublished();
  const cards = list.map(a => '<div class="card">'
    + '<span class="kicker">' + NEWS.esc(a.category || 'News') + '</span>'
    + '<h2><a href="/news/' + NEWS.esc(a.slug) + '">' + NEWS.esc(a.title) + '</a></h2>'
    + '<p>' + NEWS.esc(NEWS.excerpt(a, 140)) + '</p>'
    + '<div class="foot"><span>' + NEWS.esc(String(a.publishedAt || '').slice(0, 10)) + '</span>'
    + '<span>&middot;</span><span>' + NEWS.readingMinutes(a.body) + ' min</span></div>'
    + '</div>').join('');
  const body = '<div style="padding:36px 0 0"><h1>News &amp; Analysis</h1>'
    + '<p class="lede">Written from our own sold data &mdash; what actually changed hands, '
    + 'and what it means for what you hold.</p></div>'
    + (list.length ? '<div class="grid">' + cards + '</div>'
                   : '<p class="lede" style="margin:32px 0 56px">No articles yet.</p>');
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=300');
  res.send(newsShell({
    title: 'News & Analysis · The Card Huddle',
    description: 'Football card market analysis built from real sold data.',
    canonical: NEWS_SITE + '/news', body: body,
  }));
});

app.get('/news/:slug', async (req, res) => {
  const slug = String(req.params.slug || '').toLowerCase();
  const a = newsPublished().find(x => x.slug === slug);
  if (!a) {
    res.status(404).set('Content-Type', 'text/html; charset=utf-8');
    return res.send(newsShell({
      title: 'Not found · The Card Huddle',
      description: 'That article does not exist.',
      canonical: NEWS_SITE + '/news',
      body: '<div style="padding:56px 0"><h1>Not found</h1>'
          + '<p class="lede">That article does not exist. <a href="/news">Back to news</a>.</p></div>',
    }));
  }
  let resolved = new Map();
  try { resolved = await newsResolveShortcodes(a.body); } catch (_) { /* render without it */ }
  const html = NEWS.renderMarkdown(a.body, (name, args) => {
    if (name !== 'sold-table') return null;
    for (const [raw, out] of resolved) {
      if (!args.player || raw.indexOf(args.player) >= 0) return out;
    }
    return null;
  });
  const desc = NEWS.excerpt(a);
  const jsonLd = JSON.stringify({
    '@context': 'https://schema.org', '@type': 'NewsArticle',
    headline: a.title, description: desc,
    datePublished: a.publishedAt, dateModified: a.updatedAt || a.publishedAt,
    author: { '@type': 'Person', name: a.author || 'The Card Huddle' },
    publisher: { '@type': 'Organization', name: 'The Card Huddle' },
    mainEntityOfPage: NEWS_SITE + '/news/' + a.slug,
  });
  const body = '<div style="padding:28px 0 0">'
    + '<span class="kicker">' + NEWS.esc(a.category || 'News') + '</span>'
    + '<h1>' + NEWS.esc(a.title) + '</h1>'
    + (a.standfirst ? '<p class="lede">' + NEWS.esc(a.standfirst) + '</p>' : '')
    + '<div class="meta"><span>' + NEWS.esc(a.author || 'The Card Huddle') + '</span>'
    + '<span>&middot;</span><span>' + NEWS.esc(String(a.publishedAt || '').slice(0, 10)) + '</span>'
    + '<span>&middot;</span><span>' + NEWS.readingMinutes(a.body) + ' min read</span></div>'
    + '<article>' + html + '</article>'
    + '<div class="ad">Ad slot</div></div>';
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=300');
  res.send(newsShell({ title: a.title + ' · The Card Huddle', description: desc,
                       canonical: NEWS_SITE + '/news/' + a.slug, body: body, jsonLd: jsonLd }));
});

// Its own sitemap, because articles appear between deploys while the main
// sitemap is generated at build time from the checklists.
app.get('/sitemap-news.xml', (req, res) => {
  const urls = newsPublished().map(a =>
    '  <url><loc>' + NEWS_SITE + '/news/' + NEWS.esc(a.slug) + '</loc>'
    + '<lastmod>' + NEWS.esc(String(a.updatedAt || a.publishedAt || '').slice(0, 10)) + '</lastmod>'
    + '<changefreq>monthly</changefreq><priority>0.7</priority></url>').join('\n');
  res.set('Content-Type', 'application/xml; charset=utf-8');
  res.send('<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    + '  <url><loc>' + NEWS_SITE + '/news</loc><changefreq>daily</changefreq>'
    + '<priority>0.8</priority></url>\n' + urls + '\n</urlset>\n');
});

// ---- Authoring API (admin key, same scheme as /api/feedback) ---------------
app.get('/api/news', (req, res) => {
  // Admins see drafts too; everyone else sees only what is live.
  res.json(isAdminReq(req) ? loadNews() : newsPublished());
});

app.post('/api/admin/news', (req, res) => {
  if (!isAdminReq(req)) return res.status(401).json({ error: 'Unauthorized' });
  const b = req.body || {};
  const title = String(b.title || '').trim();
  if (!title) return res.status(400).json({ error: 'title required' });
  const slug = NEWS.slugify(b.slug || title);
  if (!slug) return res.status(400).json({ error: 'could not build a slug from that title' });

  const list = loadNews();
  const i = list.findIndex(x => x.slug === (b.originalSlug || slug));
  const now = new Date().toISOString();
  // A slug is a permanent URL. Quietly reusing one would point an existing
  // link at different writing, so a collision is refused rather than resolved.
  if (i < 0 && list.some(x => x.slug === slug)) {
    return res.status(409).json({ error: 'an article already uses /news/' + slug });
  }
  const article = {
    slug: slug,
    title: title,
    standfirst: String(b.standfirst || '').trim(),
    category: NEWS.CATEGORIES.indexOf(b.category) >= 0 ? b.category : 'Market Moves',
    body: String(b.body || ''),
    author: String(b.author || 'The Card Huddle').trim(),
    status: b.status === 'published' ? 'published' : 'draft',
    publishedAt: b.publishedAt || (i >= 0 ? list[i].publishedAt : null) || now,
    createdAt: i >= 0 ? list[i].createdAt : now,
    updatedAt: now,
  };
  if (i >= 0) list[i] = article; else list.unshift(article);
  saveNews(list);
  res.json({ ok: true, article: article, url: '/news/' + slug });
});

app.delete('/api/admin/news/:slug', (req, res) => {
  if (!isAdminReq(req)) return res.status(401).json({ error: 'Unauthorized' });
  const slug = String(req.params.slug || '').toLowerCase();
  const list = loadNews();
  const next = list.filter(x => x.slug !== slug);
  if (next.length === list.length) return res.status(404).json({ error: 'not found' });
  saveNews(next);
  res.json({ ok: true, removed: slug });
});


// ---- Photo archive ----
//
// eBay purges images for long-ended listings, so an image_url on an old sale
// eventually resolves to nothing. The dataset holds about 42 days of sales and
// eBay keeps images roughly 90, so the first losses are around seven weeks out.
// This copies them into R2 before that happens.
//
// It runs on the cron rather than in GitHub Actions on purpose. The Worker
// already holds the R2 binding, so nothing new has to be issued or stored;
// doing it from Actions would mean creating a separate R2 access key and
// keeping another long-lived secret in the repo. The cost is throughput —
// bounded by subrequests per invocation rather than by how fast a runner can
// go — and at these batch sizes it still clears the backlog well inside the
// window.
const {
  sizedUrl, keyForUrl, isPermanent: photoFailPermanent, nextCursor, summarise,
} = require('./photo-archive-core');

const PHOTO_ARCHIVE_BATCH = 400;      // images per cron tick; see the note below
const PHOTO_ARCHIVE_CONCURRENCY = 12; // parallel fetches inside a batch
const PHOTO_CURSOR_KEY = 'photoarchive:cursor:v1';
const PHOTO_FETCH_TIMEOUT_MS = 8000;

// Oldest first, always. The whole point is to reach a photo before eBay drops
// it, so the sale closest to expiry is the one that matters most — and once the
// backlog is cleared this same order keeps pace with new arrivals.
//
// The cursor is (sold_date, item_id) rather than sold_date alone because many
// sales share a date; a date-only cursor would either re-do a whole day every
// tick or skip the rest of one.
// ---- the price block map ----
//
// Every checklist and player page's price summary, computed once and stored as
// a single KV value.
//
// The alternative was a D1 query per page view behind a cache. This is cheaper
// by a wide margin and simpler to reason about: the cron does two aggregate
// passes a day, and a page view costs one KV read that is itself cached in
// module scope for the life of the isolate. Marginal D1 cost per visitor is
// zero, which matters because the whole point is to put this on 900+ pages.
//
// One value rather than one key per page for the same reason: ~950 pages at a
// few hundred bytes each is a few hundred KB, well inside KV's 25 MB limit,
// and it makes the map atomic — a page can never read a summary written
// against a different day's window than its neighbour.
const PRICE_BLOCKS_KEY = 'priceblocks:v1';
const PRICE_BLOCKS_TTL = 172800;   // two days: survives a missed cron
const PRICE_BLOCK_WINDOW_DAYS = 45;

// Records that a build was tried, separately from whether it worked.
//
// This exists because the first version of the "build immediately if there is
// no map" rule was a cost bug, and a bad one. It asked only whether the map
// existed. A build that FAILED left no map, so the answer stayed no, so it
// tried again on the next tick — every fifteen minutes, ninety-six times a
// day, each one two full aggregate passes over the sales table. A job designed
// to scan twice a day would have scanned two hundred times, and nothing about
// the failure would have been visible except the D1 bill.
//
// So the marker is written BEFORE the work starts and survives a crash. Six
// hours means a genuinely broken build costs four attempts a day rather than
// ninety-six, while a deploy still fills the pages within a tick.
const PRICE_BLOCKS_ATTEMPT_KEY = 'priceblocks:attempt:v1';
const PRICE_BLOCKS_RETRY_SECONDS = 21600;

// Should the cron build the map right now, outside the daily schedule?
//
// Only when there is no usable map AND nothing has tried recently. The daily
// 04:xx run does not consult this at all — it is scheduled, not reactive.
async function priceBlocksMissing() {
  try {
    const cur = await cacheGet(PRICE_BLOCKS_KEY);
    if (cur && cur.pages && Object.keys(cur.pages).length) return false;
    // No map. Has something already tried and failed inside the window?
    const tried = await cacheGet(PRICE_BLOCKS_ATTEMPT_KEY);
    if (tried) return false;
    return true;
  } catch (_) {
    // Unreadable is not the same as absent, and rebuilding on a transient KV
    // error would run two full table scans for nothing. Assume it is there.
    return false;
  }
}

async function buildPriceBlocks() {
  return _asD1Source('price-blocks', () => _buildPriceBlocks());
}

async function _buildPriceBlocks() {
  const db = getNflDb();
  if (!db) return { ok: false, reason: 'no D1 binding' };

  // Before anything expensive, and deliberately not in a finally: a crash
  // partway through must still count as an attempt, or the crash itself
  // becomes the retry loop.
  //
  // It records the OUTCOME too, because the first time this failed in
  // production there was no way to ask why. The cron logs the reason and
  // Worker logs are not where anyone looks first; a marker that survives in KV
  // can be read from a URL. A marker still saying 'started' when the next one
  // is due means the build did not return at all — a timeout or a crash,
  // which is a different fix from a query error.
  const mark = async (state, extra) => {
    try {
      await cachePut(PRICE_BLOCKS_ATTEMPT_KEY,
        { at: new Date().toISOString(), state, ...(extra || {}) },
        PRICE_BLOCKS_RETRY_SECONDS);
    } catch (_) { /* a marker we cannot write is not worth failing the build for */ }
  };
  await mark('started');
  const failed = async (reason) => { await mark('failed', { reason }); return { ok: false, reason }; };

  const Y = _normCol('year'), S = _normCol('set_name'), P = _normCol('player');
  const CARDNO = _normCol('card_number');
  // Medians printed onto public pages — an aggregate, so offers are out.
  const WHERE = `price_cents IS NOT NULL AND price_cents > 0 AND confidence >= ${NFLDB_MIN_CONFIDENCE}`
    + (await _noBestOfferSql(db));

  // The window is a floor on sold_date rather than "all of it". Prices from
  // three months ago are not this month's prices, and a median that silently
  // widens as the table grows is a number that means something different every
  // week without ever saying so.
  const since = new Date(Date.now() - PRICE_BLOCK_WINDOW_DAYS * 86400000)
    .toISOString().slice(0, 10);

  let products = [], players = [];
  try {
    const idx = await _loadJson('checklists/index.json');
    products = (idx && idx.products) || [];
    const pidx = await _loadJson('players/index.json');
    players = (pidx && pidx.players) || [];
  } catch (err) {
    return failed(`page indexes unavailable: ${err && err.message}`);
  }

  // Human set aliases apply HERE, which is what makes the sorting desk worth
  // sitting at: this is the join that decides which product page a sale prices.
  // An alias added at the desk changes the next daily build, with no deploy.
  const _setAliases = await setAliases();
  const { index: setIndex } = buildJoinIndex(products, undefined, _setAliases);
  const { index: playerIndex } = buildJoinIndex(players, playerKeys);

  // Per (set, card) and per (player, card). SQLite computes the median for us
  // via a window function rather than shipping every row here — 473k rows
  // would not fit in a Worker's memory, and paging them would take longer than
  // the cron is allowed to run.
  //
  // median_price is the middle row of each group by ordinal, which is the same
  // definition price-block-core.js uses on the small arrays it handles.
  // The photo comes from the same row the median does.
  //
  // Not "any photo of this card" — the median row's. That row is a real sale
  // at that price, so the picture and the number describe the same thing.
  // Picking a different row's image would show a raw card beside a PSA 10's
  // price, or vice versa.
  //
  // The column is optional: the sales schema has grown over time and this
  // deployment may predate it. Absent, the map simply carries no photos and
  // the block renders exactly as it does today.
  const hasImg = await _nflHasImageColumn(db).catch(() => false);
  const IMG = hasImg ? ', image_url' : '';
  const IMGSEL = hasImg ? ', image_url AS img' : '';

  const cardAgg = (groupCols, labelCols) => `
    WITH base AS (
      SELECT ${groupCols} AS g, ${labelCols} AS label, price_cents${IMG},
             ROW_NUMBER() OVER (PARTITION BY ${groupCols}, ${labelCols} ORDER BY price_cents) AS rn,
             COUNT(*)   OVER (PARTITION BY ${groupCols}, ${labelCols}) AS n
        FROM sales
       WHERE ${WHERE} AND sold_date >= ? AND ${groupCols} <> '' AND ${labelCols} <> ''
    )
    SELECT g, label, n AS sales, price_cents AS median${IMGSEL}
      FROM base WHERE rn = (n + 1) / 2`;

  let setCards, playerCards, span;
  try {
    [setCards, playerCards, span] = await Promise.all([
      db.prepare(cardAgg(`${Y} || '|' || ${S}`, `${P} || ' #' || ${CARDNO}`)).bind(since).all(),
      db.prepare(cardAgg(P, `${Y} || ' ' || ${S} || ' #' || ${CARDNO}`)).bind(since).all(),
      db.prepare(`SELECT MIN(sold_date) AS first, MAX(sold_date) AS last
                    FROM sales WHERE ${WHERE} AND sold_date >= ?`).bind(since).first(),
    ]);
  } catch (err) {
    return failed(`query-failed: ${err && err.message}`);
  }

  // Fold the card rows onto the pages they belong to. A page can collect rows
  // from several spellings — the join already knows that — so this accumulates
  // rather than assigns.
  const pages = new Map();
  const collect = (rows, resolve, kind) => {
    for (const r of (rows && rows.results) || []) {
      const page = resolve(r.g);
      if (!page) continue;
      const id = kind === 'set' ? page.id : page.slug;
      const key = priceKeyFor(kind, id);
      let p = pages.get(key);
      if (!p) { p = { kind, page, sales: 0, prices: [], cards: [] }; pages.set(key, p); }
      const sales = Number(r.sales || 0), med = Number(r.median || 0);
      p.sales += sales;
      p.cards.push({ label: r.label, sales, median: med, img: r.img || null });
      // The page-wide median is over CARDS, not over sales: weighting by sale
      // count would let one heavily-traded base card decide the figure for the
      // whole set, which is the opposite of what a reader is asking.
      p.prices.push(med);
    }
  };
  collect(setCards, g => {
    const i = String(g || '').indexOf('|');
    return i === -1 ? null : matchSale(setIndex, String(g).slice(0, i), String(g).slice(i + 1));
  }, 'set');
  collect(playerCards, g => matchPlayer(playerIndex, g), 'player');

  // ---- subset pages ----
  //
  // 572 of the indexable URLs are subsets of a product — "2025 Panini Prizm /
  // Rookie Revolution" — and they cannot be joined the way the other two are,
  // because `sales` has no subset column. A subset IS a list of (player, card
  // number) pairs though, and a sale carries both, so the join goes through
  // membership instead. build-landing-pages.js emits the map.
  //
  // Ambiguous cards are absent from that map by construction: inserts reuse
  // the base numbering, so 28.5% of keys belong to more than one subset and
  // are omitted rather than guessed. A page therefore prices the cards it can
  // prove are its own, and MIN_CARDS still decides whether that is enough to
  // print anything.
  try {
    const attribution = await _loadJson('subsets/attribution.json');
    for (const r of (setCards && setCards.results) || []) {
      const i = String(r.g || '').indexOf('|');
      if (i === -1) continue;
      const product = matchSale(setIndex, String(r.g).slice(0, i), String(r.g).slice(i + 1));
      if (!product) continue;
      const map = attribution[product.id];
      if (!map) continue;
      // The label is `player #number`; the map is keyed `player|number`. Split
      // on the LAST ' #' so a player whose name contains one still resolves.
      const label = String(r.label || '');
      const at = label.lastIndexOf(' #');
      if (at === -1) continue;
      // Both halves arrive already normalised — the SQL label is built from
      // _normCol(player) and _normCol(card_number), and the map was keyed with
      // the JS norm(). test/subset-attribution.test.js asserts those two agree;
      // if they ever drift, every lookup here misses and the subset pages just
      // stay empty, with nothing thrown to say why.
      const slug = map[`${label.slice(0, at)}|${label.slice(at + 2)}`];
      if (!slug) continue;
      const key = priceKeyFor('subset', `${product.id}/${slug}`);
      let p = pages.get(key);
      if (!p) {
        p = { kind: 'subset', page: { id: `${product.id}/${slug}`, name: product.name, slug },
              sales: 0, prices: [], cards: [] };
        pages.set(key, p);
      }
      const sales = Number(r.sales || 0), med = Number(r.median || 0);
      p.sales += sales;
      p.cards.push({ label: r.label, sales, median: med, img: r.img || null });
      p.prices.push(med);
    }
  } catch (err) {
    // No attribution artifact means no subset blocks, which is the same as a
    // subset with too little data: the slot stays empty. Not worth failing the
    // whole build for.
    console.error('[prices] subset attribution unavailable:', err && err.message);
  }

  const out = {};
  let kept = 0;
  for (const [key, p] of pages) {
    p.cards.sort((a, b) => b.sales - a.sales || a.label.localeCompare(b.label));
    const prices = p.prices.slice().sort((a, b) => a - b);
    const summary = priceSummarise({
      sales: p.sales,
      cards: p.cards.length,
      median: priceMedian(prices),
      low: prices[0], high: prices[prices.length - 1],
    }, p.cards);
    if (!summary) continue;
    summary.noun = p.kind === 'set' ? p.page.name : p.page.name;
    out[key] = summary;
    kept++;
  }

  const payload = {
    built: new Date().toISOString(),
    from: (span && span.first) || since,
    to: (span && span.last) || '',
    pages: out,
  };
  try {
    await cachePut(PRICE_BLOCKS_KEY, payload, PRICE_BLOCKS_TTL);
  } catch (err) {
    return failed(`kv-write-failed: ${err && err.message}`);
  }
  const bytes = JSON.stringify(payload).length;
  console.log(`[prices] ${kept} pages priced, ${(bytes / 1024).toFixed(0)} KB, window ${payload.from}..${payload.to}`);
  await mark('ok', { pages: kept, bytes, groups: pages.size });
  return { ok: true, pages: kept, bytes, from: payload.from, to: payload.to };
}

async function archiveListingPhotos(opts) {
  return _asD1Source('photo-archive', () => _archiveListingPhotos(opts || {}));
}

async function _archiveListingPhotos({ limit = PHOTO_ARCHIVE_BATCH } = {}) {
  const db = getNflDb();
  const bucket = getPhotos();
  if (!db) return { ok: false, reason: 'no D1 binding' };
  if (!bucket) return { ok: false, reason: 'no R2 binding' };
  if (!(await _nflHasImageColumn(db))) return { ok: false, reason: 'sales has no image_url' };

  let cursor = null;
  try { cursor = await cacheGet(PHOTO_CURSOR_KEY); } catch (_) { /* start from the beginning */ }
  const from = (cursor && cursor.soldDate) || '0000-00-00';
  const fromId = (cursor && cursor.itemId) || '';

  let rows;
  try {
    const out = await db.prepare(
      `SELECT item_id, sold_date, image_url
         FROM sales
        WHERE image_url IS NOT NULL AND image_url <> ''
          AND (sold_date > ? OR (sold_date = ? AND item_id > ?))
        ORDER BY sold_date ASC, item_id ASC
        LIMIT ?`
    ).bind(from, from, fromId, Math.max(1, Math.min(limit, 1000))).all();
    rows = (out && out.results) || [];
    const read = (out && out.meta && Number(out.meta.rows_read)) || 0;
    _d1Usage.rowsRead += read;
    _d1Usage.queries++;
  } catch (err) {
    console.error('[photos] query failed:', err && err.message);
    return { ok: false, reason: 'query failed' };
  }

  if (!rows.length) return { ok: true, done: true, ...summarise([]) };

  const subtle = (globalThis.crypto && globalThis.crypto.subtle) || null;
  if (!subtle) return { ok: false, reason: 'no crypto.subtle for key hashing' };

  async function one(row) {
    const base = { itemId: row.item_id, soldDate: row.sold_date };
    let key;
    try { key = await keyForUrl(row.image_url, subtle); }
    catch (_) { return { ...base, ok: false, permanent: true }; }

    // head() rather than get(): we only need to know whether it is there, and
    // pulling the bytes back to discard them would double the egress for every
    // row already done.
    try {
      if (await bucket.head(key)) return { ...base, ok: false, alreadyStored: true };
    } catch (_) { /* treat a head failure as a miss and re-store */ }

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), PHOTO_FETCH_TIMEOUT_MS);
    try {
      const resp = await fetch(sizedUrl(row.image_url), {
        signal: ctl.signal,
        headers: {
          'user-agent': 'thecardhuddle-photo-archive/1.0 (+https://thecardhuddle.com)',
          accept: 'image/jpeg,image/webp,image/png,image/*;q=0.8',
        },
      });
      if (!resp.ok) return { ...base, ok: false, permanent: photoFailPermanent(resp.status), status: resp.status };
      const body = await resp.arrayBuffer();
      // A "purged" eBay image is often a tiny placeholder rather than a 404,
      // and storing those is worse than storing nothing: it looks like success.
      if (body.byteLength < 900) return { ...base, ok: false, permanent: true, status: 'placeholder' };
      await bucket.put(key, body, {
        httpMetadata: { contentType: resp.headers.get('content-type') || 'image/jpeg' },
        customMetadata: { src: String(row.image_url).slice(0, 900), sold: row.sold_date || '' },
      });
      return { ...base, ok: true, bytes: body.byteLength };
    } catch (_) {
      return { ...base, ok: false, permanent: false };   // transient: retry later
    } finally {
      clearTimeout(timer);
    }
  }

  // Results are kept in the row order the cursor depends on, not the order
  // they happen to finish in.
  const results = new Array(rows.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(PHOTO_ARCHIVE_CONCURRENCY, rows.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= rows.length) return;
      results[i] = await one(rows[i]);
    }
  }));

  const moved = nextCursor(cursor, results);
  if (moved && (!cursor || moved.itemId !== cursor.itemId || moved.soldDate !== cursor.soldDate)) {
    cachePut(PHOTO_CURSOR_KEY, moved, 60 * 60 * 24 * 365);
  }

  const sum = summarise(results);
  console.log(`[photos] ${sum.stored} stored, ${sum.skipped} already there, `
    + `${sum.permanent} gone for good, ${sum.retry} to retry, `
    + `${(sum.bytes / 1048576).toFixed(1)} MB, through ${moved && moved.soldDate}`);
  return { ok: true, done: false, cursor: moved, ...sum };
}

// The base-card rule's SQL, for test/base-card.test.js to run as the index does.
function _rsiBaseSql() {
  return { RSI_BASE_CARD, RSI_BASE_SERIAL, RSI_BASE_TITLE_WORDS, RSI_BASE_TITLE_TEST, kind: _kindSql('title') };
}

module.exports = { app, connectDB, _marketDenied, _playerTrendPayload, _baseCardRowsOnly, _basketMove, _basketBaseOnly, _isPackListing, _matchesGradeOpts, _compValue, _estimateGrade, _marketEstimate, _marketRatioFrom, MARKET_ADJ_AFTER_DAYS, warmMarket, _rsiBaseSql, backfillPlayerAliases, flushD1Usage, flushTraffic, rateLimitCheck, RL_TIERS, RSI_JUNK_WORDS, _rsiRawOnlySql, RSI_JUNK_ONLY, _noBestOfferSql, screenCommunityImage, _orderTermsBySelectivity, _soldTimingSummary, _noteSoldTiming, archiveListingPhotos, buildPriceBlocks, warmSoldStats, priceBlocksMissing, PRICE_BLOCKS_KEY, cacheGet, _yearDisagrees, resolveParallelAliased, parallelAliases, parallelIndex, resolveSubsetAliased, insertAliases, insertAliasKeys, CARD_IDENTITY_VERSION, CARD_IDENTITY_MODULES, CARD_IDENTITY_FINGERPRINT, tagSameCard, renderPriceBlock: priceRender, getSessionUserByToken, extractSearchKeywords, matchSoldListings, classifyCardType, buildSimilarCardEstimate, hasExactCardSales, parsePrintRunFromTitle, detectSetTier, getEffectiveSubscription, PRO_GRANT_USERS, checkAlerts, processScanLeadDrip };

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
