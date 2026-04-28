/**
 * Persistent storage module — MongoDB Atlas with file-based fallback.
 *
 * When MONGODB_URI is set, data is loaded from MongoDB on startup into an
 * in-memory cache. All reads come from cache (synchronous), and writes go
 * to both file and MongoDB (async, fire-and-forget). If MongoDB is not
 * configured, everything works exactly as before with JSON files.
 */

const path = require('path');

// `mongodb` is a pure-Node package that pulls in `streams` deep in its tree.
// Cloudflare Workers' nodejs_compat polyfill doesn't fully implement `streams`,
// so just *bundling* mongodb breaks the worker with `require_streams is not a
// function` — even when MONGODB_URI isn't set and we never connect.
//
// Loading via a runtime-computed string keeps esbuild from statically
// resolving and bundling it. In Node, this works the same as `require('mongodb')`.
// In Workers, it throws and we silently fall through to cache-only mode.
let MongoClient = null;
try {
  const _mongoMod = 'mongodb';
  ({ MongoClient } = require(_mongoMod));
} catch (_) { /* Workers environment — mongodb intentionally not bundled */ }

// Cloudflare Workers have no file system — load fs only when available.
let fs = null;
try { fs = require('fs'); } catch (_) { /* Workers environment */ }

const MONGODB_URI = process.env.MONGODB_URI;
let db = null;
const cache = {};

/**
 * Connect to MongoDB and preload all stored data into memory.
 * Returns the db instance or null if unavailable.
 */
async function connectDB() {
  if (!MongoClient) {
    console.log('[DB] mongodb driver not available in this runtime — using in-memory cache (data will NOT persist across cold starts)');
    return null;
  }
  if (!MONGODB_URI) {
    console.log('[DB] No MONGODB_URI set — using file-based storage (data will NOT persist across deploys)');
    return null;
  }

  // Quick URI sanity check before we try to connect
  if (!/^mongodb(\+srv)?:\/\//.test(MONGODB_URI)) {
    console.error('[DB] MONGODB_URI is malformed. Expected it to start with "mongodb://" or "mongodb+srv://".');
    return null;
  }

  try {
    const client = new MongoClient(MONGODB_URI, {
      serverSelectionTimeoutMS: 15000,
      connectTimeoutMS: 15000,
    });
    await client.connect();
    db = client.db('cardhuddle');

    // Preload all stored documents into memory cache
    const docs = await db.collection('storage').find({}).toArray();
    for (const doc of docs) {
      cache[doc._id] = doc.data;
    }
    console.log(`[DB] Connected to MongoDB — loaded ${docs.length} collections. Data will persist across deploys.`);
    return db;
  } catch (err) {
    db = null;
    const msg = String(err && err.message || err);
    console.error('[DB] MongoDB connection failed, falling back to file storage.');
    console.error(`[DB] Error: ${msg}`);

    // Surface the most common root causes so the user knows what to fix
    if (/Authentication failed|bad auth|SCRAM/i.test(msg)) {
      console.error('[DB] Hint: username/password is wrong, or special characters in the password were not URL-encoded.');
      console.error('[DB] Try percent-encoding the password (e.g. "@" -> "%40", "/" -> "%2F", ":" -> "%3A").');
    } else if (/IP that isn't whitelisted|not authorized|whitelist|connection .* closed|ECONNRESET|ETIMEDOUT|server selection|connection timed out/i.test(msg)) {
      console.error('[DB] Hint: this almost always means the deploy host\'s IP is not in the MongoDB Atlas Network Access list.');
      console.error('[DB] Render uses dynamic egress IPs — in Atlas, add "0.0.0.0/0" to Network Access (or the specific Render egress IPs if you have a paid plan).');
    } else if (/ENOTFOUND|querySrv|getaddrinfo|DNS|EAI_AGAIN/i.test(msg)) {
      console.error('[DB] Hint: DNS lookup failed. The cluster hostname in MONGODB_URI is wrong, the cluster was deleted, or the host has no DNS access.');
    } else if (/MongoParseError|Invalid scheme|invalid connection string/i.test(msg)) {
      console.error('[DB] Hint: MONGODB_URI is malformed. Copy a fresh connection string from Atlas → Connect → Drivers.');
    }
    return null;
  }
}

/**
 * Load data synchronously. Checks memory cache first (populated from
 * MongoDB on startup), then falls back to file, then returns defaultValue.
 */
function loadData(name, filePath, defaultValue) {
  // Prefer in-memory cache (which was seeded from MongoDB on startup)
  if (cache[name] !== undefined) {
    return JSON.parse(JSON.stringify(cache[name])); // deep clone to prevent mutation
  }

  // Fall back to file (skipped in Cloudflare Workers where fs is unavailable)
  if (fs) {
    try {
      if (fs.existsSync(filePath)) {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        cache[name] = data; // populate cache for next read
        return data;
      }
    } catch (e) {
      console.error(`[DB] Error loading ${name} from file:`, e.message);
    }
  }

  return typeof defaultValue === 'function' ? defaultValue() : JSON.parse(JSON.stringify(defaultValue));
}

/**
 * Save data synchronously to file and asynchronously to MongoDB.
 */
function saveData(name, filePath, data) {
  // Update in-memory cache
  cache[name] = JSON.parse(JSON.stringify(data)); // deep clone

  // Save to file (local dev only — skipped in Cloudflare Workers)
  if (fs) {
    try {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    } catch (e) {
      console.error(`[DB] Error saving ${name} to file:`, e.message);
    }
  }

  // Save to MongoDB (async, fire-and-forget)
  if (db) {
    db.collection('storage').replaceOne(
      { _id: name },
      { _id: name, data, updatedAt: new Date() },
      { upsert: true }
    ).catch(err => console.error(`[DB] Error saving ${name} to MongoDB:`, err.message));
  }
}

module.exports = { connectDB, loadData, saveData };
