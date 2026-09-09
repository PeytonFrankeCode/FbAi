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

// ---- asset cache keys ----
//
// index.html requests style.css and app.js with a ?v= query. That number was
// maintained by hand, and #550 changed style.css without bumping it — so
// returning visitors got the new HTML against a months-old stylesheet, and the
// homepage <h1> that commit added rendered as a giant green heading instead of
// being hidden by a .sr-only rule they did not have.
//
// It is computed from file content now. This check is what notices if the
// stamping stops running, which is the same silent failure one level up.
{
  const crypto = require('crypto');
  const hashOf = (rel) => crypto.createHash('sha256')
    .update(fs.readFileSync(path.join(ROOT, 'public', rel))).digest('hex').slice(0, 10);

  // privacy.html and terms.html are checked because a sweep found them still
  // on ?v=159 after index.html had moved on — and they are two of the pages an
  // AdSense reviewer opens first.
  const PAGES = {
    'index.html': ['style.css', 'app.js'],
    'privacy.html': ['style.css'],
    'terms.html': ['style.css'],
  };
  for (const [page, assets] of Object.entries(PAGES)) {
    const html = fs.readFileSync(path.join(ROOT, 'public', page), 'utf8');
    for (const asset of assets) {
      const m = html.match(new RegExp(`${asset.replace('.', '\\.')}\\?v=([A-Za-z0-9]+)`));
      check(`${page} requests ${asset} with a version`, !!m,
        m ? `?v=${m[1]}` : 'no ?v= — every deploy is invisible to a cached visitor');
      if (!m) continue;
      const want = hashOf(asset);
      check(`  ...and it matches the file's content hash`,
        m[1] === want,
        m[1] === want ? 'stamped' : `page says ${m[1]}, content hashes to ${want} — run npm run build:sw`);
    }
  }

  // The generated landing pages carry their own stylesheet, versioned inside
  // build-landing-pages.js rather than by the stamper. It went stale twice in
  // one day before this check existed: the price-block styles were added to
  // LANDING_CSS without touching a hard-coded ?v=3, which would have served
  // every returning visitor the new block with none of its styling.
  {
    const sample = path.join(ROOT, 'public', 'sets', '2025-panini-prizm-football', 'index.html');
    const cssFile = path.join(ROOT, 'public', 'sets', 'landing.css');
    if (!fs.existsSync(sample) || !fs.existsSync(cssFile)) {
      console.log('SKIP  landing.css version  — run `npm run build:pages` first (CI does)');
    } else {
      const m = fs.readFileSync(sample, 'utf8').match(/landing\.css\?v=([A-Za-z0-9]+)/);
      const want = crypto.createHash('sha256')
        .update(fs.readFileSync(cssFile)).digest('hex').slice(0, 10);
      check('landing pages version landing.css by its content',
        m && m[1] === want,
        m ? `page says ${m[1]}, css hashes to ${want}` : 'no ?v= on the landing stylesheet');
    }
  }

  // The sweep that found those. Any NEW hand-written ?v= on a stylesheet or
  // script is the same latent bug, so it has to be declared above or it fails
  // here rather than going unnoticed for months.
  {
    const known = new Set(['style.css', 'app.js', 'landing.css']);
    const suspicious = [];
    for (const page of ['index.html', 'privacy.html', 'terms.html']) {
      const html = fs.readFileSync(path.join(ROOT, 'public', page), 'utf8');
      for (const m of html.matchAll(/([A-Za-z0-9_./-]+\.(?:css|js))\?v=([A-Za-z0-9]+)/g)) {
        const base = m[1].split('/').pop();
        if (!known.has(base)) suspicious.push(`${page}: ${m[1]}?v=${m[2]}`);
      }
    }
    check('no stylesheet or script carries an unmanaged cache key',
      suspicious.length === 0,
      suspicious.join(' | ') || 'all versioned assets are content-stamped');
  }
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall bundle-weight checks passed');
process.exit(failures ? 1 : 0);
