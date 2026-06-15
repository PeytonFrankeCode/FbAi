let serverInit = null;

// Last-line-of-defense traps. If anything inside the Worker rejects or
// throws asynchronously without being caught, Cloudflare otherwise serves
// its own HTML "Worker threw exception" error page — which the frontend
// can't parse and shows as "Server returned non-JSON (HTTP 500): <!DOCTYPE
// html>...". Both 'error' (sync throw in a microtask / setTimeout) and
// 'unhandledrejection' (rejected promise) need preventDefault() to keep
// Cloudflare from hijacking the response.
try {
  if (typeof addEventListener === 'function') {
    addEventListener('unhandledrejection', (event) => {
      console.error('[worker] unhandledrejection:', event.reason && event.reason.stack || event.reason);
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
    });
    addEventListener('error', (event) => {
      const err = event && (event.error || event.message);
      console.error('[worker] error event:', err && err.stack || err);
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
    });
  }
} catch (_) { /* preflight environment without addEventListener */ }

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
    // Forward declarations so the req.on shim can call into `fallback`
    // when body-parser's setTimeout-queued end callback throws.
    let fallbackRef = null;
    const req = {
      method: request.method,
      url: url.pathname + url.search,
      path: url.pathname,
      headers: reqHeaders,
      body: undefined,
      // raw-body (used by express.json) bails with "stream is not readable"
      // when `stream.readable` is defined and falsy. Without these flags our
      // shim inherits a falsy `readable` from the IncomingMessage prototype
      // that nodejs_compat layers on, so every POST body throws before
      // raw-body even tries to read it. Spelling out the stream-state flags
      // here keeps the shim looking like a fresh, readable request.
      readable: true,
      complete: false,
      readableEnded: false,
      destroyed: false,
      aborted: false,
      socket: { remoteAddress: reqHeaders['cf-connecting-ip'] || '127.0.0.1', encrypted: true },
      // Express's req.protocol getter reads connection.encrypted, not socket.
      // Marking it true here ensures Stripe success_url etc. resolve to https.
      connection: { remoteAddress: reqHeaders['cf-connecting-ip'] || '127.0.0.1', encrypted: true },
      httpVersion: '1.1',
      on(event, handler) {
        if (event === 'data' && bodyBuffer) {
          try { handler(bodyBuffer); }
          catch (e) { if (fallbackRef) fallbackRef(e, 'req.on data'); else throw e; }
        }
        if (event === 'end') {
          setTimeout(() => {
            // body-parser's end handler parses the body and calls next().
            // If JSON.parse / iconv decode / etc. throws synchronously
            // here, the error is outside any Express Layer call, so the
            // async-rejection patch in server.js can't catch it. Route
            // it through our fallback so we still respond with JSON.
            try { handler(); }
            catch (e) { if (fallbackRef) fallbackRef(e, 'req.on end'); else throw e; }
          }, 0);
        }
        return this;
      },
      resume() { return this; },
      pause() { return this; },
      pipe() { return this; },
      unpipe() { return this; },
      read() { return bodyBuffer || null; },
      // EventEmitter-shape methods. raw-body (used by express.json) calls
      // `stream.removeListener(...)` five times during cleanup. Without
      // these, that synchronously throws TypeError on every POST with a
      // body, and Cloudflare serves its own HTML 1101 page before any
      // user-land catch can fire. The shim discards all events anyway
      // since the only ones we synthesize are 'data' and 'end' above —
      // these methods just need to exist and not throw.
      removeListener() { return this; },
      removeAllListeners() { return this; },
      off() { return this; },
      once(event, handler) { return this.on(event, handler); },
      emit() { return true; },
      addListener(event, handler) { return this.on(event, handler); },
      listeners() { return []; },
      listenerCount() { return 0; },
      setMaxListeners() { return this; },
      eventNames() { return []; },
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
    // Now that fallback is defined, hand its reference to req.on so the
    // setTimeout-queued end callback can route errors back here.
    fallbackRef = fallback;

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

// ---------------------------------------------------------------------------
// FloorRoom — Durable Object for live presence on The Floor.
//
// One global instance (idFromName('global')) holds every connected client's
// WebSocket plus their last-known avatar position and profile, and relays
// position updates to everyone else. State is in-memory only: a relay needs
// no persistence (if the room hibernates, nobody's connected anyway).
//
// Wire protocol (JSON both ways):
//   client → server: { t:'join', name, emoji, color, username, x, y }
//                     { t:'move', x, y }
//   server → client: { t:'welcome', id, players:[{id,name,emoji,color,x,y}] }
//                     { t:'join',  player:{id,...} }
//                     { t:'move',  id, x, y }
//                     { t:'leave', id }
//
// Note: position broadcast is O(n²) per tick (fine for a modest floor). When
// the floor gets busy this is where to add interest management / rate caps.
// ---------------------------------------------------------------------------
export class FloorRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map(); // id -> { ws, id, profile, x, y }
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected a WebSocket upgrade', { status: 426 });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.accept(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  accept(ws) {
    ws.accept();
    const id = crypto.randomUUID();
    const session = { ws, id, profile: null, x: 480, y: 300 };
    this.sessions.set(id, session);

    ws.addEventListener('message', (evt) => {
      let msg;
      try { msg = JSON.parse(typeof evt.data === 'string' ? evt.data : ''); }
      catch (_) { return; }
      if (!msg || typeof msg !== 'object') return;

      if (msg.t === 'join') {
        session.profile = {
          name: String(msg.name || 'Collector').slice(0, 24),
          emoji: String(msg.emoji || '🙂').slice(0, 8),
          color: String(msg.color || '#5ece99').slice(0, 16),
          username: String(msg.username || '').slice(0, 32),
        };
        if (typeof msg.x === 'number') session.x = msg.x;
        if (typeof msg.y === 'number') session.y = msg.y;
        const players = [];
        for (const s of this.sessions.values()) {
          if (s.id !== id && s.profile) players.push({ id: s.id, ...s.profile, x: s.x, y: s.y });
        }
        this.sendTo(ws, { t: 'welcome', id, players });
        this.broadcast({ t: 'join', player: { id, ...session.profile, x: session.x, y: session.y } }, id);
      } else if (msg.t === 'move') {
        if (typeof msg.x === 'number') session.x = msg.x;
        if (typeof msg.y === 'number') session.y = msg.y;
        if (session.profile) this.broadcast({ t: 'move', id, x: session.x, y: session.y }, id);
      }
    });

    const drop = () => { if (this.sessions.delete(id)) this.broadcast({ t: 'leave', id }, id); };
    ws.addEventListener('close', drop);
    ws.addEventListener('error', drop);
  }

  sendTo(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch (_) { /* closing */ } }

  broadcast(obj, exceptId) {
    const str = JSON.stringify(obj);
    for (const s of this.sessions.values()) {
      if (s.id === exceptId) continue;
      try { s.ws.send(str); } catch (_) { /* closing */ }
    }
  }
}

export default {
  async fetch(request, env, ctx) {
    // Expose ctx.waitUntil to the DB layer so KV writes can extend the
    // request's lifetime past the response — Cloudflare Workers terminate
    // unawaited I/O when the response is sent, which was silently
    // dropping every register/saveData call and making accounts vanish
    // on the next cold start (or every deploy).
    if (ctx && typeof ctx.waitUntil === 'function') {
      globalThis.__kvWaitUntil = (promise) => {
        try { ctx.waitUntil(promise); } catch (_) { /* already finalized */ }
      };
    }
    try {
      const url = new URL(request.url);

      // Live presence WebSocket for The Floor — upgrade goes straight to the
      // single global FloorRoom Durable Object, bypassing the Express path
      // (Express can't speak the WebSocket upgrade protocol).
      if (url.pathname === '/api/floor/ws') {
        if (request.headers.get('Upgrade') !== 'websocket') {
          return new Response('Expected a WebSocket upgrade', { status: 426 });
        }
        if (!env.FLOOR_ROOM) {
          return new Response('Presence not available', { status: 503 });
        }
        const id = env.FLOOR_ROOM.idFromName('global');
        return env.FLOOR_ROOM.get(id).fetch(request);
      }

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
