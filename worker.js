let serverInit = null;

async function init(env) {
  if (serverInit) return serverInit;

  for (const [key, val] of Object.entries(env)) {
    if (typeof val === 'string') process.env[key] = val;
  }
  process.env.CF_WORKER = '1';

  // server.js is CommonJS. When dynamically imported, esbuild/wrangler may
  // wrap module.exports under `.default`, so reach through both shapes.
  const mod = await import('./server.js');
  const exports = (mod && mod.default) ? mod.default : mod;
  const { app, connectDB } = exports;
  if (typeof connectDB !== 'function' || !app) {
    throw new Error('server.js did not export { app, connectDB } — got keys: ' + Object.keys(exports || {}).join(','));
  }
  // Pass the Cloudflare env in so connectDB can grab the KV binding for
  // persistent storage. KV is request-scoped, so this only works on the
  // first request — preload happens once, subsequent saves use the cached
  // binding stored inside db.js.
  await connectDB(env);
  serverInit = { app };
  return serverInit;
}

// Minimal stream-free Express adapter — no @whatwg-node/server needed.
// All API responses use res.json()/res.send()/res.end() which all funnel
// through write() + end(), so this covers the full API surface.
function expressToFetch(app, request, bodyBuffer) {
  const url = new URL(request.url);
  const reqHeaders = {};
  request.headers.forEach((v, k) => { reqHeaders[k] = v; });

  return new Promise((resolve) => {
    const req = {
      method: request.method,
      url: url.pathname + url.search,
      path: url.pathname,
      headers: reqHeaders,
      body: undefined,
      socket: { remoteAddress: reqHeaders['cf-connecting-ip'] || '127.0.0.1', encrypted: true },
      // Express's req.protocol getter reads connection.encrypted, not socket.
      // Marking it true here ensures Stripe success_url etc. resolve to https.
      connection: { remoteAddress: reqHeaders['cf-connecting-ip'] || '127.0.0.1', encrypted: true },
      httpVersion: '1.1',
      on(event, handler) {
        if (event === 'data' && bodyBuffer) handler(bodyBuffer);
        if (event === 'end') setTimeout(() => handler(), 0);
        return this;
      },
      resume() { return this; },
      pipe() { return this; },
      unpipe() { return this; },
      read() { return bodyBuffer || null; },
    };

    const resChunks = [];
    let statusCode = 200;
    const resHeaders = {};
    let finished = false;

    const res = {
      statusCode: 200,
      finished: false,
      locals: {},
      setHeader(name, value) {
        resHeaders[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
        return this;
      },
      getHeader(name) { return resHeaders[name.toLowerCase()]; },
      getHeaders() { return { ...resHeaders }; },
      hasHeader(name) { return name.toLowerCase() in resHeaders; },
      removeHeader(name) { delete resHeaders[name.toLowerCase()]; },
      writeHead(code, reasonOrHeaders, maybeHeaders) {
        statusCode = code;
        this.statusCode = code;
        const hdrs = (typeof reasonOrHeaders === 'object' && reasonOrHeaders) ? reasonOrHeaders : (maybeHeaders || {});
        Object.entries(hdrs).forEach(([k, v]) => { resHeaders[k.toLowerCase()] = String(v); });
        return this;
      },
      write(chunk, encoding) {
        if (typeof chunk === 'string') chunk = Buffer.from(chunk, encoding || 'utf8');
        resChunks.push(chunk);
        return true;
      },
      end(chunk, encoding) {
        if (finished) return;
        finished = true;
        this.finished = true;
        if (chunk) {
          if (typeof chunk === 'string') chunk = Buffer.from(chunk, encoding || 'utf8');
          resChunks.push(chunk);
        }
        const body = resChunks.length ? Buffer.concat(resChunks) : null;
        resolve(new Response(body, { status: statusCode, headers: resHeaders }));
      },
      on() { return this; },
      once() { return this; },
      emit() { return this; },
      off() { return this; },
      addListener() { return this; },
      removeListener() { return this; },
    };

    const fallback = (err, where) => {
      if (finished) return;
      finished = true;
      this && true; // no-op to keep finished closure happy under bundlers
      if (err) {
        console.error(`Express ${where} error:`, err && err.stack || err);
        resolve(new Response(
          JSON.stringify({ error: 'Server error', where, detail: String(err && err.message || err) }),
          { status: 500, headers: { 'content-type': 'application/json' } }
        ));
      } else {
        resolve(new Response(
          JSON.stringify({ error: 'Not Found' }),
          { status: 404, headers: { 'content-type': 'application/json' } }
        ));
      }
    };

    // Both sync throws and async rejections from app() need to land back here
    // as a JSON response — otherwise the Worker emits an unhandled rejection
    // and Cloudflare serves its own HTML 500 page, which the frontend can't
    // parse and shows as "Server returned non-JSON".
    try {
      const ret = app(req, res, (err) => fallback(err, 'next'));
      if (ret && typeof ret.then === 'function') {
        ret.catch(e => fallback(e, 'async'));
      }
    } catch (e) {
      fallback(e, 'sync');
    }
  });
}

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);

      // Static files and SPA fallback — served by Cloudflare ASSETS binding.
      // ANY non-/api request goes here, including bot scans like /wp-admin/*,
      // so we never let the Express init path run for them.
      if (!url.pathname.startsWith('/api/')) {
        if (env.ASSETS) {
          try {
            return await env.ASSETS.fetch(request);
          } catch (assetErr) {
            console.error('ASSETS.fetch failed:', assetErr && assetErr.stack || assetErr);
            return new Response('Static asset fetch failed: ' + String(assetErr && assetErr.message || assetErr), { status: 502 });
          }
        }
        // No ASSETS binding — diagnostic 500 with what env DID have, so we
        // don't ship a silent "Not Found" that looks like a routing bug.
        const envKeys = Object.keys(env || {}).join(', ') || '(none)';
        return new Response(
          'ASSETS binding missing on this worker. Available env keys: ' + envKeys +
          '. Check that wrangler.toml [assets] block deployed correctly.',
          { status: 500, headers: { 'content-type': 'text/plain' } }
        );
      }

      // API routes — handled by Express
      let app;
      try {
        ({ app } = await init(env));
      } catch (initErr) {
        console.error('Worker init failed:', initErr && initErr.stack || initErr);
        return new Response(
          JSON.stringify({ error: 'Server initialization failed', detail: String(initErr && initErr.message || initErr) }),
          { status: 500, headers: { 'content-type': 'application/json' } }
        );
      }

      const bodyBuffer = ['GET', 'HEAD'].includes(request.method)
        ? null
        : Buffer.from(await request.arrayBuffer());

      // Must `await` here — `return expressToFetch(...)` would hand the raw
      // promise back to Cloudflare, so any rejection from inside Express
      // would surface as Cloudflare's HTML "Worker threw exception" page
      // instead of landing in our JSON outerErr catch below.
      return await expressToFetch(app, request, bodyBuffer);
    } catch (outerErr) {
      console.error('Worker fetch crashed:', outerErr && outerErr.stack || outerErr);
      return new Response(
        JSON.stringify({ error: 'Worker exception', detail: String(outerErr && outerErr.message || outerErr) }),
        { status: 500, headers: { 'content-type': 'application/json' } }
      );
    }
  },
};
