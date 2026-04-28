/**
 * Persistent storage module.
 *
 * Two backends, picked at runtime based on environment:
 *   - Node.js (local / VPS / Render): JSON files on disk, in-memory cache
 *   - Cloudflare Workers: in-memory cache only (no disk, no DB)
 *
 * The MongoDB driver was removed entirely — its transitive dependency on
 * Node streams broke the Cloudflare Workers bundle (`require_streams is
 * not a function`) regardless of whether we ever connected. If persistent
 * storage on Workers is needed later, swap this in-memory cache for a
 * Cloudflare KV namespace (drop-in replacement at the loadData/saveData
 * boundary — they're already key-by-name).
 */

const path = require('path');

// fs is unavailable on Cloudflare Workers; load it only when present.
let fs = null;
try { fs = require('fs'); } catch (_) { /* Workers environment */ }

const cache = {};

// connectDB is kept (and called from worker.js / server.js) for API stability,
// but on Workers it's a no-op and on Node it just preloads files lazily on read.
async function connectDB() {
  if (!fs) {
    console.log('[DB] in-memory cache only (no persistent storage in this runtime)');
  } else {
    console.log('[DB] file-based storage active');
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
}

module.exports = { connectDB, loadData, saveData };
