// Does an error actually reach the client as an error?
//
// The Worker runs Express through a hand-written adapter, and that adapter
// swallowed every non-200 status for as long as it has existed. `res.status(401)`
// assigns `this.statusCode`; only `writeHead()` updated the closure variable the
// adapter answered with, and `res.send()` / `res.json()` never call writeHead.
// So the whole API answered HTTP 200 with the failure merely described in the
// body. Measured against a live worker before the fix:
//
//   /api/feedback    (no key) -> 200, want 401
//   /api/admin/stats (no key) -> 200, want 401
//   /news/<missing>           -> 200, want 404
//
// Both consequences are the quiet kind. A browser doing `if (!r.ok)` treats an
// unauthorized response as success and renders whatever came back; a crawler
// treats a "Not found" page as an ordinary article and indexes it.
//
// This is a source-level check, like test/cron-wiring.test.js, because the
// adapter is a closure inside an ESM worker entrypoint with no seam to call
// into. It asserts the shape of the fix rather than its behaviour — the
// behaviour was verified against a running worker on both paths, and this
// exists to notice if someone rewrites end() back to the closure-only form.
const fs = require('fs');
const path = require('path');

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

const src = fs.readFileSync(path.join(__dirname, '..', 'worker.js'), 'utf8');

// The body of end(), from its signature to the resolve() that answers —
// with comments stripped.
//
// Stripping them is not tidiness. The first version of this test scanned the
// raw slice, and the explanatory comment above the fix contains the words
// `this.statusCode`; so the check passed against deliberately broken code that
// no longer read the property at all. A guard that matches its own
// documentation guards nothing.
const endBody = (() => {
  const at = src.indexOf('end(chunk, encoding) {');
  if (at < 0) return null;
  const stop = src.indexOf('resolve(new Response(', at);
  if (stop < 0) return null;
  return src.slice(at, src.indexOf('\n', stop))
    .split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
})();

check('the response adapter still has an end() that resolves a Response',
      !!endBody, endBody ? 'found' : 'end() not found — this test needs updating with it');

if (endBody) {
  check('  ...and it reads the status from the response object',
        /this\.statusCode/.test(endBody),
        /this\.statusCode/.test(endBody)
          ? 'reads this.statusCode'
          : 'ONLY reads the closure — every res.status(...) will answer 200');

  // The closure is still the right fallback for writeHead callers, so this
  // checks that the fix ADDED a source rather than swapping one blind spot
  // for another.
  check('  ...while still honouring writeHead()',
        /\bstatusCode\b/.test(endBody.replace(/this\.statusCode/g, '')),
        'closure status retained as the fallback');
}

// Express's own status helper has to survive too: the adapter must not define
// a `status` method that shadows it and drops the value.
{
  const shadowed = /^\s*status\s*\(/m.test(src);
  check('the adapter does not shadow res.status()',
        !shadowed,
        shadowed ? 'defines its own status() — Express assigns statusCode, check it propagates' : 'left to Express');
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall worker-status checks passed');
process.exit(failures ? 1 : 0);
