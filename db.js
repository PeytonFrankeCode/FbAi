/**
 * Persistent storage module — MongoDB Atlas with file-based fallback.
 *
 * When MONGODB_URI is set, data is loaded from MongoDB on startup into an
 * in-memory cache. All reads come from cache (synchronous), and writes go
 * to both file and MongoDB (async, fire-and-forget). If MongoDB is not
 * configured, everything works exactly as before with JSON files.
 */

const { MongoClient } = require('mongodb');
const path = require('path');

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
  if (!MONGODB_URI) {
    console.log('[DB] No MONGODB_URI set — using file-based storage (data will NOT persist across deploys)');
    return null;
  }

  try {
    const client = new MongoClient(MONGODB_URI, {
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 5000,
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
    console.error('[DB] MongoDB connection failed, falling back to file storage:', err.message);
    db = null;
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
