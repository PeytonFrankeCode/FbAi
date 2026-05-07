/**
 * Persistent storage module.
 *
 * Three backends, picked at runtime:
 *   - Cloudflare Workers + KV bound: reads/writes go to Cloudflare KV.
 *     KV is async, so we preload all known keys into an in-memory cache on
 *     first request (connectDB(env)). After that, reads are sync from cache
 *     and writes update the cache synchronously while firing async KV puts.
 *   - Cloudflare Workers without KV: in-memory cache only (data lost on
 *     cold start). Same shape as before — non-fatal, just non-persistent.
 *   - Node.js (local / VPS): JSON files on disk + in-memory cache.
 */

const path = require('path');

let fs = null;
try { fs = require('fs'); } catch (_) { /* Workers environment */ }

// Every storage key the server uses. connectDB preloads all of these from KV
// in parallel on first request so subsequent loadData calls are synchronous.
const KNOWN_KEYS = ['users', 'sessions', 'subscriptions', 'alerts', 'priceHistory', 'apiCallLog', 'feedback'];

const cache = {};
let kv = null;          // Cloudflare KV namespace binding (set by connectDB)
let kvReady = false;    // true after preload completes

async function connectDB(env) {
  // Stash the KV binding if present. env is only available on Workers.
  if (env && env.KV) {
    kv = env.KV;
    globalThis.__KV_BOUND = true;
    if (!kvReady) {
      try {
        const results = await Promise.all(
          KNOWN_KEYS.map(async (key) => {
            const value = await kv.get(key, 'json');
            return [key, value];
          })
        );
        for (const [key, value] of results) {
          if (value !== null && value !== undefined) cache[key] = value;
        }
        kvReady = true;
        console.log(`[DB] Loaded ${results.filter(r => r[1] !== null).length}/${KNOWN_KEYS.length} keys from Cloudflare KV`);
      } catch (err) {
        console.error('[DB] KV preload failed, falling back to in-memory only:', err && err.message);
        kv = null;
      }
    }
    return null;
  }

  if (fs) {
    console.log('[DB] file-based storage active');
  } else {
    console.log('[DB] in-memory cache only (no KV binding, no fs — data will not persist)');
  }
  return null;
}

function loadData(name, filePath, defaultValue) {
  if (cache[name] !== undefined) {
    return JSON.parse(JSON.stringify(cache[name]));
  }

  if (fs && filePath) {
    try {
      if (fs.existsSync(filePath)) {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        cache[name] = data;
        return data;
      }
    } catch (e) {
      console.error(`[DB] Error loading ${name} from file:`, e.message);
    }
  }

  return typeof defaultValue === 'function' ? defaultValue() : JSON.parse(JSON.stringify(defaultValue));
}

function saveData(name, filePath, data) {
  cache[name] = JSON.parse(JSON.stringify(data));

  if (fs && filePath) {
    try {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    } catch (e) {
      console.error(`[DB] Error saving ${name} to file:`, e.message);
    }
  }

  // Async-write to KV; we don't await — saves are fire-and-forget so route
  // handlers don't block. Failures are logged.
  if (kv) {
    kv.put(name, JSON.stringify(data)).catch(err =>
      console.error(`[DB] KV put ${name} failed:`, err && err.message)
    );
  }
}

module.exports = { connectDB, loadData, saveData };
