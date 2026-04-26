'use strict';

/**
 * Cloudflare Workers entry point.
 *
 * Flow:
 *   1. On the first request, inject Cloudflare secrets into process.env,
 *      import the Express app, and connect to MongoDB.
 *   2. On every request, use @whatwg-node/server to convert the Workers
 *      Fetch API Request into a Node.js-style request that Express can handle,
 *      then convert the response back.
 *
 * Local dev is unchanged — `npm start` or `npm run dev` still uses server.js
 * directly (CF_WORKER is not set, so server.js calls app.listen() as usual).
 */

const { createServerAdapter } = require('@whatwg-node/server');

let fetchHandler = null;

async function init(env) {
  if (fetchHandler) return;

  // Inject Cloudflare bindings (secrets + vars) into process.env so the
  // existing process.env.XXX references throughout server.js keep working.
  for (const [key, val] of Object.entries(env)) {
    if (typeof val === 'string') process.env[key] = val;
  }

  // Signal server.js to export the app instead of calling app.listen().
  process.env.CF_WORKER = '1';

  const { app, connectDB } = require('./server.js');
  await connectDB();

  fetchHandler = createServerAdapter(app);
}

module.exports = {
  async fetch(request, env, ctx) {
    await init(env);
    return fetchHandler(request, env, ctx);
  },
};
