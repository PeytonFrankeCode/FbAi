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
const KNOWN_KEYS = ['users', 'sessions', 'subscriptions', 'alerts', 'priceHistory', 'apiCallLog', 'feedback', 'promotedIndex', 'promotedDemo', 'community', 'floorIndex'];

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

  // Async-write to KV. Route handlers still don't block, but we hand the
  // promise to ctx.waitUntil so Cloudflare doesn't kill the write when the
  // response is sent. Without this, every register/saveData "succeeded"
  // but the data never actually persisted, so accounts disappeared on
  // every cold start / deploy.
  if (kv) {
    const promise = kv.put(name, JSON.stringify(data)).catch(err =>
      console.error(`[DB] KV put ${name} failed:`, err && err.message)
    );
    if (typeof globalThis.__kvWaitUntil === 'function') {
      globalThis.__kvWaitUntil(promise);
    }
  }
}

// Per-user data blobs. Keyed `userdata:<username>` in KV. Async because we
// don't preload these on startup (could be thousands of users); each request
// hits KV directly. For local file mode each user gets their own JSON file
// under data/userdata/<username>.json so the on-disk layout stays sane.
// `__dirname` is undefined in Cloudflare Workers, so resolve lazily and only
// when a filesystem-backed code path actually runs (it never does on CF).
function _userDataDir() {
  const base = (typeof __dirname !== 'undefined') ? __dirname : '.';
  return path.join(base, 'data', 'userdata');
}

async function loadUserData(username) {
  if (!username) return {};
  const safe = String(username).toLowerCase();
  if (!/^[a-z0-9_.-]+$/.test(safe)) return {};
  const key = `userdata:${safe}`;
  if (kv) {
    try {
      const value = await kv.get(key, 'json');
      return value || {};
    } catch (err) {
      console.error(`[DB] KV get ${key} failed:`, err && err.message);
      return {};
    }
  }
  if (fs) {
    const dir = _userDataDir();
    const filePath = path.join(dir, `${safe}.json`);
    try {
      if (fs.existsSync(filePath)) {
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      }
    } catch (e) {
      console.error(`[DB] Error loading ${key} from file:`, e.message);
    }
  }
  return {};
}

async function saveUserData(username, data) {
  if (!username) return;
  const safe = String(username).toLowerCase();
  if (!/^[a-z0-9_.-]+$/.test(safe)) return;
  const key = `userdata:${safe}`;
  if (kv) {
    try {
      await kv.put(key, JSON.stringify(data));
    } catch (err) {
      console.error(`[DB] KV put ${key} failed:`, err && err.message);
    }
  }
  if (fs) {
    const dir = _userDataDir();
    const filePath = path.join(dir, `${safe}.json`);
    try {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    } catch (e) {
      console.error(`[DB] Error saving ${key} to file:`, e.message);
    }
  }
}

module.exports = { connectDB, loadData, saveData, loadUserData, saveUserData };
