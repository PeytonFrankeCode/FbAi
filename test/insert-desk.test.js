// The insert desk, and why its unit is not the parallel desk's.
//
// resolveParallel hands back the exact segment it could not place, which is
// what makes a phrase queue possible. resolveSubset does not: it searches the
// whole title for any catalogued set name, so when it fails there is no
// specific phrase to blame — the residue is the entire title.
//
// So the unit here is the CARD. 2017 Prizm lists Dalvin Cook #8 in both Prizm
// Premier Jerseys and Stained Glass Prizm, and a sale whose title names neither
// is genuinely undecidable from text. But the candidates are short, the photo
// settles it, and every sale of that card shares the answer.
//
// The failure this guards against is the one the whole session keeps meeting: a
// screen that collects decisions nothing reads.
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

const ambPath = path.join(ROOT, 'public', 'data', 'subsets', 'ambiguous.json');
if (!fs.existsSync(ambPath)) {
  console.log('SKIP  insert-desk  — run `npm run build:pages` first (CI does)');
  process.exit(0);
}

// The fixture's premise, taken from the artifact rather than assumed. If the
// catalogue ever stops calling this key ambiguous, every check below becomes
// meaningless while still passing.
const AMB = JSON.parse(fs.readFileSync(ambPath, 'utf8'));
const PRODUCT = '2017-panini-prizm-football';
const KEY = 'dalvin cook|8';

const db = new DatabaseSync(':memory:');
db.exec(`CREATE TABLE sales (item_id TEXT, sold_date TEXT, title TEXT, price_cents INTEGER,
  currency TEXT, listing_format TEXT, grader TEXT, grade TEXT, player TEXT, parallel TEXT,
  year TEXT, set_name TEXT, card_number TEXT, confidence REAL, best_offer INTEGER,
  bids INTEGER, image_url TEXT)`);

const iso = (o) => new Date(Date.now() + o * 86400000).toISOString().slice(0, 10);
const ins = db.prepare(`INSERT INTO sales (item_id, sold_date, title, price_cents, player,
  year, set_name, parallel, card_number, confidence, image_url) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
let n = 0;
ins.run('anchor', iso(0), '2017 Panini Prizm Anchor #1', 10000, 'Anchor',
        '2017', 'Prizm', '', '1', 0.9, null);
const add = (title, times, player, num) => {
  for (let i = 0; i < times; i++) {
    ins.run('i' + n++, iso(-10 - (i % 8)), title, 5000, player, '2017', 'Prizm', '',
            num, 0.9, 'https://img/' + n + '.jpg');
  }
};

// The ambiguous card, with a title that names NEITHER candidate set. This is
// the whole population of the desk.
add('2017 Panini Prizm Dalvin Cook #8', 9, 'Dalvin Cook', '8');
add('2017 Panini Prizm Dalvin Cook #8 Vikings RC', 5, 'Dalvin Cook', '8');
// Same card, but the title names the set — the reader already has this and it
// must never reach the queue.
add('2017 Panini Prizm Stained Glass Prizm Dalvin Cook #8', 7, 'Dalvin Cook', '8');
// A card that is NOT ambiguous. Mahomes #269 belongs to one set only.
add('2017 Panini Prizm Patrick Mahomes II #269', 12, 'Patrick Mahomes II', '269');

const d1 = {
  prepare(sql) {
    const st = db.prepare(sql);
    return {
      bind: (...a) => ({ all: async () => ({ results: st.all(...a) }),
                         first: async () => st.get(...a) || null }),
      all: async () => ({ results: st.all() }),
      first: async () => st.get() || null,
    };
  },
};

// Installed BEFORE server.js is required — it destructures these off db.js at
// require time, and reassigning afterwards leaves it holding the originals.
const KV = new Map();
const dbMod = require(path.join(ROOT, 'db.js'));
dbMod.getNflDb = () => d1;
dbMod.archiveGet = async (k) => (KV.has(k) ? KV.get(k) : null);
dbMod.archivePut = async (k, v) => { KV.set(k, v); };
process.env.CF_WORKER = '1';
process.env.ADMIN_PASSWORD = 'test-key-for-the-insert-desk';

const srv = require(path.join(ROOT, 'server.js'));
const server = srv.app.listen(3223);

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};
const K = encodeURIComponent(process.env.ADMIN_PASSWORD);
const get = async (p) => (await fetch(`http://127.0.0.1:3223${p}`)).json();
const post = async (p, body) => {
  const r = await fetch(`http://127.0.0.1:3223${p}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

(async () => {
  // The premise, asserted rather than assumed.
  {
    const kinds = Object.entries(AMB[PRODUCT] || {})
      .filter(([, list]) => list.includes(KEY)).map(([k]) => k);
    check('the fixture card really is ambiguous in the catalogue',
      kinds.length > 0, `${KEY} in ${PRODUCT} as ${kinds.join(',') || 'nothing'}`);
  }

  {
    const r = await fetch('http://127.0.0.1:3223/api/review/inserts');
    check('the queue refuses an unauthenticated request', r.status === 403, `HTTP ${r.status}`);
  }

  const q = await get(`/api/review/inserts?key=${K}&days=90`);
  check('the queue answers', q.available === true, q.reason || q.error || '');
  if (!q.available) { server.close(); process.exit(1); }

  const cook = (q.queue || []).find(g => /Dalvin Cook/.test(g.label || ''));

  // ---- what belongs in it, and what must not -----------------------------
  check('an ambiguous card with a silent title reaches the queue',
    !!cook, (q.queue || []).map(g => g.label).join(' | ') || 'empty');
  check('  ...and an unambiguous card never does',
    !(q.queue || []).some(g => /Mahomes/.test(g.label || '')),
    (q.queue || []).map(g => g.label).join(' | '));
  // The reader's own work must not be re-presented as a person's.
  check('  ...nor a title that already names its set',
    !!cook && cook.sales === 14 && q.resolvedByTitle >= 7,
    cook ? `${cook.sales} queued, ${q.resolvedByTitle} resolved by the reader` : '');

  // ---- the candidates come from the product's own checklist --------------
  check('the card is offered the sets it could actually be',
    !!cook && cook.candidates.length >= 2
    && cook.candidates.some(c => /Stained Glass/i.test(c.name))
    && cook.candidates.some(c => /Premier Jerseys/i.test(c.name)),
    cook ? cook.candidates.map(c => c.name).join(' | ') : '');
  check('  ...with the photos to tell them apart',
    !!cook && cook.photos.length > 0, cook ? `${cook.photos.length} photo(s)` : '');
  // Titles differ under one key, and they are not always the same card, so the
  // desk offers the same split mechanism the parallel desk needed.
  check('  ...and broken into its distinct titles, answerable separately',
    !!cook && cook.splits.length === 2,
    cook ? cook.splits.map(s => `${s.sales}`).join(' | ') : '');

  // ---- a wrong answer is refused -----------------------------------------
  {
    const bad = await post(`/api/review/inserts?key=${K}`,
      { productId: PRODUCT, player: 'Dalvin Cook', cardNumber: '8', setId: 'no-such-set' });
    check('a set the product does not have is refused',
      bad.status === 400 && /has no set/.test(bad.body.error || ''),
      `HTTP ${bad.status} ${bad.body.error || ''}`);
  }

  // ---- THE CHECK THAT MATTERS: the decision has to reach the card page ----
  //
  // A desk that collects answers nothing reads is the failure this session has
  // met twice. So this asserts the shared reader's ANSWER changes, not that a
  // KV write happened.
  {
    const ok = await post(`/api/review/inserts?key=${K}`,
      { productId: PRODUCT, player: 'Dalvin Cook', cardNumber: '8', setId: 'stained-glass-prizm' });
    check('a decision is accepted and stored under the card',
      ok.status === 200 && /stained glass/i.test(String(ok.body.set || '')),
      `HTTP ${ok.status} ${JSON.stringify(ok.body)}`);

    const { resolveSubsetAliased, insertAliases } = srv;
    const pi = await srv.parallelIndex();
    const a = await insertAliases();
    const ctx = { productId: PRODUCT, player: 'Dalvin Cook', cardNumber: '8' };
    const title = '2017 Panini Prizm Dalvin Cook #8';

    const before = pi.resolveSubset(title);
    const after = resolveSubsetAliased(pi, title, ctx, a);
    check('  ...and it changes how the card reads',
      !before.subset && /stained glass/i.test(String(after.subset || '')),
      `${before.subset || 'unresolved'} -> ${after.subset}`);

    // And it must NOT leak onto a different card that happens to share nothing
    // but the product.
    const other = resolveSubsetAliased(pi, '2017 Panini Prizm Patrick Mahomes II #269',
      { productId: PRODUCT, player: 'Patrick Mahomes II', cardNumber: '269' }, a);
    check('  ...only for the card it was made about',
      !other.subset, String(other.subset));
  }

  // The card page has to consult it, not just the test.
  {
    const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    check('the card page reads insert decisions through the shared reader',
      /const seedSubset = resolveSubsetAliased\(pi, seed\.title, ctx, iAliases\)/.test(src)
      && /resolveSubsetAliased\(pi, r\.title,/.test(src),
      'card-analysis must use resolveSubsetAliased for both seed and candidates');
  }

  // ---- the page has to be able to make these decisions -------------------
  //
  // The server accepting a decision and the screen being able to make one are
  // different things, and the difference is invisible until someone opens it.
  // Executed rather than read, so a syntax error is a failing test and not a
  // blank page found by a person.
  {
    const html = fs.readFileSync(path.join(ROOT, 'public', 'insert-desk.html'), 'utf8');
    const script = (html.match(/<script>([\s\S]*)<\/script>/) || [])[1] || '';
    check('the insert desk page parses as JavaScript',
      (() => {
        try { new Function(script.replace(/const qs[\s\S]*?location\.search\);/, 'const qs=new Map();')); return true; }
        catch (e) { return false; }
      })(), 'a syntax error here is a blank screen, found by a person');

    check('  ...talks to the insert endpoint, not the parallel one',
      /\/api\/review\/inserts\?key=/.test(script) && !/review\/parallels/.test(script),
      'copied from the parallel desk — the endpoint must be swapped');
    check('  ...identifies the card it is deciding',
      /productId: item\.productId/.test(script) && /cardNumber: item\.cardNumber/.test(script),
      'the POST must name the card, not a phrase');
    // The candidate list holds set ids behind display names. Sending the
    // visible text would be refused, since the name is not the id.
    check('  ...sends the picked set’s id, not its label',
      /decide\(hit\.dataset\.c\)/.test(script) && /decide\(el\.dataset\.c\)/.test(script),
      'clicking or Entering a set must send its id');
    // A title scopes the answer; no title covers the whole card.
    check('  ...and scopes to one title when one is picked',
      /title: sp \? sp\.title : undefined/.test(script),
      'a picked split must narrow the decision to that title');
  }

  // A decided card leaves the queue, or the list never shrinks.
  {
    const q2 = await get(`/api/review/inserts?key=${K}&days=90`);
    check('a decided card drops out of the queue',
      !(q2.queue || []).some(g => /Dalvin Cook/.test(g.label || '')),
      (q2.queue || []).map(g => g.label).join(' | ') || 'empty');
    check('  ...and is counted as work already done',
      q2.salesAlreadyFixed === 14 && q2.decisionsInPlace === 1,
      `${q2.salesAlreadyFixed} sales fixed, ${q2.decisionsInPlace} decision(s)`);
  }

  // ---- and it can be taken back ------------------------------------------
  {
    await post(`/api/review/inserts?key=${K}`,
      { productId: PRODUCT, player: 'Dalvin Cook', cardNumber: '8' });
    const q3 = await get(`/api/review/inserts?key=${K}&days=90`);
    check('a decision can be undone',
      (q3.queue || []).some(g => /Dalvin Cook/.test(g.label || '')),
      `${q3.decisionsInPlace} decision(s) left`);
  }

  server.close();
  console.log(failures ? `\n${failures} check(s) failed` : '\nall insert-desk checks passed');
  process.exit(failures ? 1 : 0);
})().catch(err => { console.error(err); server.close(); process.exit(1); });
