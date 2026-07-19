/*
 * The Card Huddle service worker.
 *
 * Goal: the app opens instantly and keeps working at a card show on bad or
 * no wifi. Strategy per request type:
 *   - HTML navigations : network-first (new deploys win), cached shell offline
 *   - checklist JSON   : stale-while-revalidate (instant, refreshes in bg)
 *   - JS/CSS/img/fonts : stale-while-revalidate (versioned URLs self-bust)
 *   - /api/* + pricing : never touched — always live (or fails, handled by app)
 *
 * Bump VERSION to force a clean cache swap on the next visit.
 */
const VERSION = 'v1';
const SHELL_CACHE = `chuddle-shell-${VERSION}`;
const DATA_CACHE = `chuddle-data-${VERSION}`;

// Minimum set to make a cold offline start possible. Best-effort — a missing
// entry never fails the install.
const CORE = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/logo.png',
  '/data/checklists/index.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    await Promise.all(CORE.map((u) => cache.add(u).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((k) => k.startsWith('chuddle-') && !k.endsWith(VERSION)).map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // never cache writes

  const url = new URL(req.url);

  // Only ever handle our OWN origin. Third-party resources (fonts, Chart.js,
  // analytics, eBay/scrape.do) are left to the browser — intercepting them
  // risks stalling the page when a blocking script is slow on bad venue wifi,
  // which is the exact opposite of what we want.
  if (url.origin !== self.location.origin) return;

  // Our API is always live.
  if (url.pathname.startsWith('/api/')) return;

  if (req.mode === 'navigate') {
    event.respondWith(networkFirst(req));
    return;
  }
  if (url.pathname.startsWith('/data/')) {
    event.respondWith(staleWhileRevalidate(req, DATA_CACHE));
    return;
  }
  event.respondWith(staleWhileRevalidate(req, SHELL_CACHE));
});

// Network with a short timeout, falling back to the cached shell — so on weak
// wifi the app still opens fast instead of hanging on a slow request.
async function networkFirst(req) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const res = await fetchWithTimeout(req, 4000);
    if (res && res.ok && res.type === 'basic') cache.put(req, res.clone());
    return res;
  } catch (_) {
    return (
      (await cache.match(req)) ||
      (await cache.match('/')) ||
      (await cache.match('/index.html')) ||
      Response.error()
    );
  }
}

function fetchWithTimeout(req, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    fetch(req).then((r) => { clearTimeout(t); resolve(r); }, (e) => { clearTimeout(t); reject(e); });
  });
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  const network = fetch(req)
    .then((res) => {
      if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
      return res;
    })
    .catch(() => null);
  return cached || (await network) || Response.error();
}

// ---- Messages from the page (offline download packs + update control) ----
self.addEventListener('message', (event) => {
  const data = event.data || {};
  const src = event.source;
  const reply = (msg) => { if (src && src.postMessage) src.postMessage(msg); };

  if (data.type === 'SKIP_WAITING') { self.skipWaiting(); return; }

  if (data.type === 'CACHE_URLS' && Array.isArray(data.urls)) {
    event.waitUntil((async () => {
      const cache = await caches.open(DATA_CACHE);
      const total = data.urls.length;
      let done = 0, ok = 0;
      for (const u of data.urls) {
        try {
          const r = await fetch(u, { cache: 'reload' });
          if (r && r.ok) { await cache.put(u, r.clone()); ok++; }
        } catch (_) {}
        done++;
        reply({ type: 'CACHE_PROGRESS', tag: data.tag, done, total, ok });
      }
      reply({ type: 'CACHE_DONE', tag: data.tag, total, ok });
    })());
    return;
  }

  if (data.type === 'UNCACHE_URLS' && Array.isArray(data.urls)) {
    event.waitUntil((async () => {
      const cache = await caches.open(DATA_CACHE);
      for (const u of data.urls) { try { await cache.delete(u); } catch (_) {} }
      reply({ type: 'UNCACHE_DONE', tag: data.tag });
    })());
    return;
  }

  if (data.type === 'CHECK_CACHED' && Array.isArray(data.urls)) {
    event.waitUntil((async () => {
      const cache = await caches.open(DATA_CACHE);
      let cached = 0;
      for (const u of data.urls) { if (await cache.match(u)) cached++; }
      reply({ type: 'CACHED_STATUS', tag: data.tag, cached, total: data.urls.length });
    })());
    return;
  }
});
