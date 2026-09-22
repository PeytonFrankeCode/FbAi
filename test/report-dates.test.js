// How old is what I am looking at.
//
// Eight endpoints returned a cached payload with no indication that it was
// cached, and most reports carried the window of sales they covered but never
// said when they were computed. Those are different questions and both were
// unanswerable from the page. Twice in one day the answer was guessed wrong —
// once reading a 48-hour board as proof a fix had not shipped when it had, and
// once reading it as proof one had.
//
// The guards:
//
//   every object put into KV is stamped with generatedAt on the way in;
//   every cache hit is labelled servedFromCache with an ageMinutes on the way
//   out — absent, not zero, when the stored payload predates the stamp;
//   every report payload carries generatedAt of its own.
//
// The checks below break each of those and confirm the break is visible,
// because a date field is exactly the kind of thing that can be present,
// wrong, and never noticed.
let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (err) {
  console.error('FAIL  node:sqlite unavailable on ' + process.version +
                ' — this test needs Node 22.5+. Update the runtime, do not skip it.');
  process.exit(1);
}
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const db = new DatabaseSync(':memory:');
db.exec(`CREATE TABLE sales (
  item_id TEXT, sold_date TEXT, title TEXT, price_cents INTEGER, currency TEXT,
  listing_format TEXT, grader TEXT, grade TEXT, player TEXT, parallel TEXT,
  year TEXT, set_name TEXT, card_number TEXT, confidence REAL,
  best_offer INTEGER, bids INTEGER, image_url TEXT
)`);
db.exec(`CREATE TABLE daily (sold_date TEXT, sales INTEGER, priced INTEGER, total_cents INTEGER)`);

const DAY = 86400000;
const iso = (off) => new Date(Date.now() + off * DAY).toISOString().slice(0, 10);
const ins = db.prepare(
  `INSERT INTO sales (item_id, sold_date, title, price_cents, player, year, set_name,
                      parallel, card_number, grader, grade, confidence, image_url)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);

let n = 0;
for (let c = 1; c <= 8; c++) {
  const player = `Player ${c}`;
  for (const [day, price, count] of [[-25, 100, 8], [-5, 160, 8]]) {
    for (let k = 0; k < count; k++) {
      ins.run(`i${n++}`, iso(day + (k % 3)),
              `2023 Prizm ${player} Silver #${c}`, price * 100,
              player, '2023', 'Prizm', 'Silver', String(c), '', '', 0.9, null);
    }
  }
}
for (let d = 0; d < 40; d++) {
  db.prepare('INSERT INTO daily (sold_date, sales, priced, total_cents) VALUES (?,?,?,?)')
    .run(iso(-d), 100, 90, 900000);
}

const d1 = {
  prepare(sql) {
    const st = db.prepare(sql);
    return {
      bind(...a) {
        return {
          all: async () => ({ results: st.all(...a) }),
          first: async () => st.get(...a) || null,
        };
      },
      all: async () => ({ results: st.all() }),
      first: async () => st.get() || null,
    };
  },
};

// The stubs have to be in place before server.js is required: it destructures
// its helpers off db.js at require time, so a stub installed afterwards is one
// the server never sees.
const store = new Map();
const dbMod = require(path.join(ROOT, 'db.js'));
dbMod.getNflDb = () => d1;
dbMod.cacheGet = async (k) => (store.has(k) ? store.get(k) : null);
dbMod.cachePut = (k, v) => { store.set(k, v); };
process.env.CF_WORKER = '1';

const { app } = require(path.join(ROOT, 'server.js'));
const PORT = 3219;
const server = app.listen(PORT);
const call = async (u) => (await fetch(`http://127.0.0.1:${PORT}${u}`)).json();

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

const server_js = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

(async () => {
  // ---- a freshly computed payload says when it was computed ---------------
  store.clear();
  const fresh = await call('/api/sold-stats?days=30');
  const builtAt = Date.parse(fresh.generatedAt || '');
  check('a report says when it was built',
    Number.isFinite(builtAt),
    'generatedAt=' + JSON.stringify(fresh.generatedAt));
  check('  ...as a time that has actually just happened',
    Number.isFinite(builtAt) && Math.abs(Date.now() - builtAt) < 60000,
    Number.isFinite(builtAt) ? Math.round((Date.now() - builtAt) / 1000) + 's ago' : 'unparseable');
  check('  ...and does not claim to be from cache when it was just computed',
    fresh.servedFromCache !== true,
    'the first caller computed this one');

  // ---- and the next caller is told they got a copy ------------------------
  const hit = await call('/api/sold-stats?days=30');
  check('a cache hit says so',
    hit.servedFromCache === true, 'servedFromCache=' + hit.servedFromCache);
  check('  ...with an age in minutes',
    Number.isFinite(hit.ageMinutes), 'ageMinutes=' + JSON.stringify(hit.ageMinutes));
  check('  ...and keeps the stamp of when it was built, not when it was served',
    hit.generatedAt === fresh.generatedAt,
    `${hit.generatedAt} vs ${fresh.generatedAt}`);

  // ---- the age is read off the payload, not hardcoded ---------------------
  //
  // A cache hit a second old and one two days old both report a number. Only
  // backdating the stored copy tells them apart, and an ageMinutes wired to 0
  // — or to a fresh Date.now() — passes every check above.
  const key = [...store.keys()].find(k => k.includes('soldstats'));
  const stored = store.get(key);
  store.set(key, { ...stored, generatedAt: new Date(Date.now() - 150 * 60000).toISOString() });
  const old = await call('/api/sold-stats?days=30');
  check('the age is measured from the stamp, not invented',
    old.ageMinutes >= 149 && old.ageMinutes <= 151,
    'a copy stamped 150 minutes ago reported ' + old.ageMinutes);

  // ---- an unknown age reads as unknown ------------------------------------
  //
  // Payloads cached before this change carry no stamp. Reporting them as zero
  // minutes old would be a confident wrong answer, which is worse than the
  // silence it replaced.
  store.set(key, { available: true, stats: (stored && stored.stats) || {} });
  const legacy = await call('/api/sold-stats?days=30');
  check('an unstamped copy is still flagged as a copy',
    legacy.servedFromCache === true, 'servedFromCache=' + legacy.servedFromCache);
  check('  ...but reports no age rather than an age of zero',
    !('ageMinutes' in legacy),
    'ageMinutes=' + JSON.stringify(legacy.ageMinutes));

  // ---- the stamp is applied centrally, so a new endpoint cannot skip it ---
  //
  // Stamping at each call site would work until the next endpoint, which is
  // the one that would go unstamped and be trusted anyway.
  store.clear();
  await call('/api/sold-stats?days=7');
  const put = [...store.values()].filter(v => v && typeof v === 'object' && !Array.isArray(v));
  check('everything cached is stamped on the way in',
    put.length > 0 && put.every(v => Number.isFinite(Date.parse(v.generatedAt || ''))),
    `${put.filter(v => !v.generatedAt).length} of ${put.length} unstamped`);

  check('  ...by cachePut itself, with the raw helper aliased away',
    /cachePut: _rawCachePut/.test(server_js)
    && /const cachePut = \(key, value, ttl\) => _rawCachePut\(key, _stamped\(value\), ttl\)/.test(server_js),
    'the export must be shadowed, or call sites keep reaching the unstamped one');
  check('  ...and nothing else calls the raw one',
    (server_js.match(/_rawCachePut/g) || []).length === 2,
    'one in the import, one in the wrapper — a third is a bypass');

  // ---- every cache hit goes through the label -----------------------------
  //
  // The failure this repeats: /api/search was tagged and /api/direct-search fed
  // the same screen untagged, so the fix looked like it had not shipped. A
  // check naming one endpoint would not have caught that, so this walks them.
  {
    const bare = [];
    const re = /\bif \(cached[^)]*\) return res\.json\(([^)]*)\)/g;
    let m, sites = 0;
    while ((m = re.exec(server_js))) {
      sites++;
      if (!/_fromCache\(/.test(m[1])) bare.push(m[0]);
    }
    // The Market endpoints return through one shared stale-while-revalidate
    // helper instead. Each call counts as a site, and the helper must label
    // both of its hit paths — fresh and stale — or every one of them is bare.
    const helper = (server_js.match(/async function _marketCached[\s\S]*?\n}\n/) || [''])[0];
    const helperSites = (server_js.match(/await _marketCached\(/g) || []).length;
    sites += helperSites;
    if (helperSites && (helper.match(/_fromCache\(hit\)/g) || []).length < 2) {
      bare.push('_marketCached returns a hit without _fromCache');
    }
    check('every endpoint that returns a cached payload labels it',
      sites >= 10 && bare.length === 0,
      bare.length ? bare.join(' | ') : `${sites} sites, all labelled`);
  }

  // ---- reports carry their own stamp, and their window -------------------
  //
  // generatedAt and the sales window are different facts. A queue rebuilt a
  // minute ago over sales that stop five days back is stale, and the build
  // time on its own says the opposite.
  {
    const bodies = server_js.split(/available: true,/).slice(1);
    const unstamped = bodies.filter(b => !/^\s*\n?\s*generatedAt:/.test(b)).length;
    check('report payloads are stamped where they are built',
      bodies.length - unstamped >= 18,
      `${bodies.length - unstamped} of ${bodies.length} available:true payloads stamped`);
  }

  // ---- the desks show both clocks ----------------------------------------
  //
  // Running asOf rather than reading it: a formatter that throws on a missing
  // field takes the header down, and the source looks fine either way.
  for (const page of ['parallel-desk.html', 'insert-desk.html']) {
    const html = fs.readFileSync(path.join(ROOT, 'public', page), 'utf8');
    const src = html.slice(html.indexOf('function asOf(d) {'),
                           html.indexOf('function flash('));
    check(`${page} has an as-of line`,
      src.length > 50 && /\$\('s-as-of'\)\.textContent = asOf\(d\)/.test(html),
      'the helper must be wired to the header, not just defined');
    if (!src) continue;
    let asOf;
    try { asOf = new Function(src + '; return asOf;')(); } catch (e) {
      check(`  ...${page} asOf parses`, false, String(e.message));
      continue;
    }
    const through = iso(-3);
    const out = asOf({ window: { through }, generatedAt: new Date(Date.now() - 7200000).toISOString() });
    check(`  ...${page} names the last sale it covers`,
      out.includes(through) && /3d ago/.test(out), out);
    check(`  ...${page} names when it was built, separately`,
      /2h ago/.test(out), out);
    // In a try, because the failure being guarded against IS a throw, and an
    // uncaught one here would end the run without ever printing this line.
    try {
      check(`  ...${page} survives a report with neither`,
        asOf({}) === '' && asOf(null) === '' && asOf({ window: {}, generatedAt: 'nonsense' }) === '',
        'a missing date must not blank the header');
    } catch (e) {
      check(`  ...${page} survives a report with neither`, false, 'threw: ' + e.message);
    }
  }

  // ---- and the file stays readable ----------------------------------------
  //
  // server.js held one literal NUL byte inside a join separator, which made
  // git and grep treat 579KB of JavaScript as binary — every diff of it on a
  // pull request read "Binary file not shown".
  check('server.js is text, so its diffs can be read',
    !fs.readFileSync(path.join(ROOT, 'server.js')).includes(0),
    'one NUL byte is enough to make the whole file binary to git and grep');

  server.close();
  console.log(failures ? `\n${failures} check(s) failed` : '\nall report-dates checks passed');
  process.exit(failures ? 1 : 0);
})().catch(err => { console.error(err); server.close(); process.exit(1); });
