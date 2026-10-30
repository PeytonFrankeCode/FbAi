// Huddle AI streams its answers (owner, Oct 2026): the Worker's Express
// adapter must send a text/event-stream response as it is written, not hold
// it until end(). The adapter is a closure inside the ESM worker entrypoint,
// so this lifts its source out and runs it against a small route.
'use strict';
const fs = require('fs');
const path = require('path');
let failures = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`); if (!ok) failures++; };

const src = fs.readFileSync(path.join(__dirname, '..', 'worker.js'), 'utf8');
const start = src.indexOf('function expressToFetch(');
const end = src.indexOf('\n}\n', start) + 2;
// eslint-disable-next-line no-new-func
const expressToFetch = new Function('Buffer', `${src.slice(start, end)}; return expressToFetch;`)(Buffer);

(async () => {
  try {
    const t0 = Date.now();
    const streamApp = (req, res) => {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.write('event: status\ndata: {"text":"Thinking"}\n\n');
      setTimeout(() => { res.write('event: delta\ndata: {"text":"About $60."}\n\n'); res.end(); }, 300);
    };
    const resp = await expressToFetch(streamApp, new Request('https://x/api/ai/ask', { method: 'POST' }), Buffer.from('{}'));
    const firstAt = Date.now() - t0;
    const body = await resp.text();
    check('a streamed answer is sent before the route finishes', firstAt < 250 && /event-stream/.test(resp.headers.get('content-type')), `response after ${firstAt}ms`);
    check('  ...and every part of it arrives, then the stream closes', /Thinking/.test(body) && /About \$60/.test(body), body);

    const jsonApp = (req, res) => { res.statusCode = 402; res.setHeader('Content-Type', 'application/json'); res.write('{"a":'); res.end('1}'); };
    const j = await expressToFetch(jsonApp, new Request('https://x/api/ai/ask', { method: 'POST' }), Buffer.from('{}'));
    check('an ordinary JSON answer is still sent whole, with its status', j.status === 402 && (await j.text()) === '{"a":1}');
  } catch (e) { console.error(e); failures++; }
  console.log(failures ? `\n${failures} check(s) failed` : '\nall worker-stream checks passed');
  process.exit(failures ? 1 : 0);
})();
