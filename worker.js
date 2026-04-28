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
  await connectDB();
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
      connection: { remoteAddress: reqHeaders['cf-connecting-ip'] || '127.0.0.1' },
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

    app(req, res, (err) => {
      if (!finished) {
        resolve(new Response(err ? 'Internal Server Error' : 'Not Found', { status: err ? 500 : 404 }));
      }
    });
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Static files and SPA fallback — served by Cloudflare ASSETS binding
    if (!url.pathname.startsWith('/api/')) {
      if (env.ASSETS) return env.ASSETS.fetch(request);
    }

    // API routes — handled by Express
    const { app } = await init(env);
    const bodyBuffer = ['GET', 'HEAD'].includes(request.method)
      ? null
      : Buffer.from(await request.arrayBuffer());

    return expressToFetch(app, request, bodyBuffer);
  },
};
