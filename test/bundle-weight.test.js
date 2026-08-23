// Does the Worker still compile without the dictionaries?
//
// This guards a site-wide outage. The checklist artifacts are 1.26 MB of JSON,
// and a Worker compiles its ENTIRE script before it serves anything — so a
// megabyte reachable from server.js is a megabyte parsed on every cold isolate,
// for every request, including the ones that never look at a card name. That
// was error 1102 on thecardhuddle.com: not a slow endpoint, the whole site.
//
// Deferring the work inside the modules did not fix it, because the cost is
// compilation, not execution. The only fix is for the data not to be there. The
// Worker fetches it from the assets binding instead.
//
// The failure mode this catches is quiet: someone adds `require('./card-index')`
// to server.js for one lookup, everything passes, and the site goes down on
// deploy. So walk the require graph the bundler would walk and assert the JSON
// is not in it.
const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

// Static require() literals only — the same thing esbuild resolves at build
// time. A computed or eval'd require is invisible to the bundler, which is
// exactly why server.js loads the JSON through one.
const REQUIRE = /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g;

function walk(entry) {
  const seen = new Set();
  const queue = [path.resolve(entry)];
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    if (!/\.js$/.test(file)) continue;              // JSON is a leaf
    let src;
    try { src = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const m of src.matchAll(REQUIRE)) {
      const spec = m[1];
      if (!spec.startsWith('.')) continue;          // node_modules: not our concern
      let resolved;
      try {
        resolved = Module.createRequire(file).resolve(spec);
      } catch { continue; }                         // optional//missing: bundler's problem
      if (resolved.includes('node_modules')) continue;
      queue.push(resolved);
    }
  }
  return seen;
}

const graph = walk(path.join(ROOT, 'server.js'));

const HEAVY = ['public/data/card-index.json', 'public/data/parallel-index.json'];
const pulled = HEAVY.filter(rel => graph.has(path.join(ROOT, rel)));
check('server.js does not statically require the checklist dictionaries',
      pulled.length === 0,
      pulled.length
        ? `PULLED INTO THE BUNDLE: ${pulled.join(', ')} — this is what caused error 1102`
        : `${HEAVY.length} artifacts stay out of the compile`);

// The Node-side wrappers DO require them, on purpose. If server.js ever reaches
// one of those it inherits the whole payload, so they are named as forbidden
// too — the JSON check above would catch it, but this says why.
const WRAPPERS = ['card-index.js', 'parallel-index.js'];
const viaWrapper = WRAPPERS.filter(rel => graph.has(path.join(ROOT, rel)));
check('  ...nor the Node wrappers that would drag them in',
      viaWrapper.length === 0,
      viaWrapper.length
        ? `server.js requires ${viaWrapper.join(', ')} — use the -core modules instead`
        : 'server.js uses card-index-core / parallel-index-core');

// The image decoder is a devDependency and must stay one. The photo work runs
// in CI precisely BECAUSE a Worker cannot decode an image, and sharp could not
// run there anyway — it is a native binary. Requiring it from server.js would
// break the build rather than merely bloat it, which is the good case; the bad
// case is a pure-JS decoder like jpeg-js quietly compiling into every cold
// start to serve a job that does not run in the Worker at all.
{
  const bundled = new Set(Object.keys(require(path.join(ROOT, 'package.json')).dependencies || {}));
  const NODE_ONLY = ['sharp', 'jpeg-js'];
  const wrong = NODE_ONLY.filter(m => bundled.has(m));
  check('the image decoder stays a devDependency',
        wrong.length === 0,
        wrong.length ? `PROMOTED TO dependencies: ${wrong.join(', ')}` : 'image decoding is CI-only');

  // And nothing the Worker compiles may reach for it, however it got installed.
  const reaches = [...graph].filter(f => {
    if (!/\.js$/.test(f)) return false;
    try { return NODE_ONLY.some(m => new RegExp(`require\\(['"]${m}['"]\\)`).test(fs.readFileSync(f, 'utf8'))); }
    catch { return false; }
  });
  check('  ...and nothing in the Worker graph requires it',
        reaches.length === 0,
        reaches.length ? `REQUIRED BY: ${reaches.map(f => path.relative(ROOT, f)).join(', ')}`
                       : 'the decoder is unreachable from server.js');
}

// The core modules are the whole point of the split: logic without data. If one
// of them ever grows a require for its own JSON the split is undone silently.
for (const core of ['card-index-core.js', 'parallel-index-core.js']) {
  const src = fs.readFileSync(path.join(ROOT, core), 'utf8');
  const reqs = [...src.matchAll(REQUIRE)].map(m => m[1]);
  check(`  ...and ${core} requires nothing`,
        reqs.length === 0,
        reqs.length ? `requires ${reqs.join(', ')}` : 'pure logic, data injected by the caller');
}

// The artifacts have to actually be in public/ or the assets fetch 404s and the
// dictionaries are silently unavailable in production — which is the same
// outcome as the outage fix, just without anyone noticing.
for (const rel of HEAVY) {
  const p = path.join(ROOT, rel);
  let kb = 0, ok = false;
  try {
    kb = Math.round(fs.statSync(p).size / 1024);
    JSON.parse(fs.readFileSync(p, 'utf8'));
    ok = true;
  } catch (err) { ok = false; }
  check(`${rel} ships in the assets directory`, ok && kb > 100, `${kb} KB`);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall bundle-weight checks passed');
process.exit(failures ? 1 : 0);
