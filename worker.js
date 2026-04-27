import { createServerAdapter } from '@whatwg-node/server';

let fetchHandler = null;

async function init(env) {
  if (fetchHandler) return;

  // Inject Cloudflare secrets/vars into process.env before server.js loads
  for (const [key, val] of Object.entries(env)) {
    if (typeof val === 'string') process.env[key] = val;
  }
  process.env.CF_WORKER = '1';

  // Dynamic import defers server.js execution until env vars are set
  const { app, connectDB } = await import('./server.js');
  await connectDB();
  fetchHandler = createServerAdapter(app);
}

export default {
  async fetch(request, env, ctx) {
    await init(env);
    return fetchHandler(request, env, ctx);
  },
};
