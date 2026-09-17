// The parallel desk: the manual system, and whether one decision is worth making.
//
// WHY THIS SHAPE. Per-sale curation does not scale. A month's sample holds
// ~16,700 sales across ~4,000 distinct titles, so deciding one sale at a time
// is worth about four sales a click and nobody clears a backlog at that rate.
//
// The leverage is one layer down, in the PHRASE. When the parallel reader fails
// it hands back the exact segment it could not match, and the same phrase
// recurs across every listing of that card — and every listing of it next
// month. So the queue is phrases, ranked by the sales they hold up.
//
// Two answers are useful, and the second is the one no automatic system can
// settle: a phrase can be a real parallel missing from a checklist, or it can
// be not a parallel at all. A base card's title very often ends in a team name.
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

if (!fs.existsSync(path.join(ROOT, 'public', 'data', 'parallel-index.json'))) {
  console.log('SKIP  parallel-desk  — run `npm run build:card-index` first (CI does)');
  process.exit(0);
}

const db = new DatabaseSync(':memory:');
db.exec(`CREATE TABLE sales (item_id TEXT, sold_date TEXT, title TEXT, price_cents INTEGER,
  currency TEXT, listing_format TEXT, grader TEXT, grade TEXT, player TEXT, parallel TEXT,
  year TEXT, set_name TEXT, card_number TEXT, confidence REAL, best_offer INTEGER,
  bids INTEGER, image_url TEXT)`);

const iso = (o) => new Date(Date.now() + o * 86400000).toISOString().slice(0, 10);
const ins = db.prepare(`INSERT INTO sales (item_id, sold_date, title, price_cents, player,
  year, set_name, parallel, card_number, confidence, image_url) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
let n = 0;
// An anchor at today, so the trailing-day exclusion cuts it and not the fixture.
ins.run('anchor', iso(0), '2017 Panini Prizm Anchor #1', 10000, 'Anchor',
        '2017', 'Prizm', '', '1', 0.9, null);
const add = (title, times, player, year, set) => {
  for (let i = 0; i < times; i++) {
    ins.run('i' + n++, iso(-10 - (i % 8)), title, 5000, player || 'Patrick Mahomes II',
            year || '2017', set || 'Prizm', '', '269', 0.9, 'https://img/' + n + '.jpg');
  }
};

// The two shapes the desk exists to separate. Counts differ so the ranking is
// checked, not just the membership.
add('2017 Panini Prizm Patrick Mahomes II #269 Aqua Wave Speckle', 9);
add('2017 Panini Prizm Patrick Mahomes II #269 Aqua Wave Speckle RC', 5);
add('2017 Panini Prizm Patrick Mahomes II #269 Kansas City Chiefs', 7);
// Already readable — must never reach the queue.
add('2017 Panini Prizm Patrick Mahomes II #269 Silver Prizm', 20);

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

// The decision store, in memory. The real one is KV.
//
// Installed BEFORE server.js is required, because server.js destructures these
// off db.js at require time — reassigning them afterwards leaves it holding the
// originals, which is a trap this suite has already been caught by once.
const KV = new Map();
const dbMod = require(path.join(ROOT, 'db.js'));
dbMod.getNflDb = () => d1;
dbMod.archiveGet = async (k) => (KV.has(k) ? KV.get(k) : null);
dbMod.archivePut = async (k, v) => { KV.set(k, v); };
process.env.CF_WORKER = '1';
process.env.ADMIN_PASSWORD = 'test-key-for-the-desk';

const srv = require(path.join(ROOT, 'server.js'));
const { app } = srv;
const PORT = 3222;
const server = app.listen(PORT);

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};
const KEY = encodeURIComponent(process.env.ADMIN_PASSWORD);
const get = async (p) => (await fetch(`http://127.0.0.1:${PORT}${p}`)).json();
const post = async (p, body) => {
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

(async () => {
  // ---- the queue is gated, like every other admin screen ------------------
  {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/review/parallels`);
    check('the queue refuses an unauthenticated request', r.status === 403, `HTTP ${r.status}`);
  }

  const q = await get(`/api/review/parallels?key=${KEY}&days=90`);
  check('the queue answers', q.available === true, q.reason || q.error || '');
  if (!q.available) { server.close(); process.exit(1); }

  const phrases = (q.queue || []).map(g => g.phrase);

  // ---- what belongs in it, and what must not -----------------------------
  check('an unreadable phrase reaches the queue',
    phrases.includes('aqua wave speckle'), phrases.join(' | ') || 'empty');
  check('  ...and so does a team name, which is the commonest case',
    phrases.includes('kansas city chiefs'), phrases.join(' | '));
  // THE LIMIT OF THE LEVERAGE, asserted so it is not overclaimed.
  //
  // The reader gives up on the WHOLE trailing segment, so "Aqua Wave Speckle"
  // and "Aqua Wave Speckle RC" are two phrases and take two decisions. A
  // decision is worth every sale sharing its exact spelling, forever — not
  // every sale of the card.
  //
  // Matching on "contains" instead would collapse them, and would also let a
  // decision about "Gold" swallow "Gold Rush Rose Gold". Exact is the safe
  // reading, and the queue puts the near-spellings next to each other anyway.
  {
    const aqua = (q.queue || []).find(g => g.phrase === 'aqua wave speckle');
    const aquaRc = (q.queue || []).find(g => g.phrase === 'aqua wave speckle rc');
    check('a decision covers one spelling, and the near-spelling is its own row',
      !!aqua && aqua.sales === 9 && !!aquaRc && aquaRc.sales === 5,
      `${aqua ? aqua.sales : '-'} + ${aquaRc ? aquaRc.sales : '-'}`);
  }
  check('a phrase the reader already handles never appears',
    !phrases.some(p => /silver/.test(p)), phrases.join(' | '));

  // Ranked by cost, or the evening is spent on the wrong end of the list.
  check('the queue is ordered by the sales each phrase holds up',
    phrases[0] === 'aqua wave speckle', `first: ${phrases[0]}`);

  // The number that decides whether the screen is worth opening at all.
  check('the queue reports its own leverage',
    q.salesPerDecision >= 7 && q.salesHeldUp === 21,
    `${q.salesPerDecision} sales per decision, ${q.salesHeldUp} held up`);

  // Photos, because a person settles this by looking at the card.
  {
    const g = (q.queue || [])[0];
    check('  ...and shows the card, not just the words',
      !!g && Array.isArray(g.photos) && g.photos.length > 0,
      g ? `${g.photos.length} photo(s), ${g.samples.length} sample title(s)` : '');
  }

  // ---- a decision has to be refused when it is wrong ----------------------
  {
    const bad = await post(`/api/review/parallels?key=${KEY}`,
      { phrase: 'aqua wave speckle', parallel: 'Nonexistent Sparkle Foil' });
    check('a parallel no checklist has ever heard of is refused',
      bad.status === 400 && /not a parallel/.test(bad.body.error || ''),
      `HTTP ${bad.status} ${bad.body.error || ''}`);
  }

  // ---- and applied everywhere once it is right ---------------------------
  //
  // THE CHECK THAT MATTERS. A decision made here must change how the phrase
  // reads on the boards, in search and on the card page. Wiring it into one
  // screen and not the others is exactly how this codebase has lost a day
  // twice — two grade readers that disagreed, and two search endpoints where
  // only one had the identity check.
  {
    const ok = await post(`/api/review/parallels?key=${KEY}`,
      { phrase: 'kansas city chiefs', parallel: '' });
    check('"not a parallel" is a decision the desk accepts',
      ok.status === 200 && ok.body.parallel === '',
      `HTTP ${ok.status} ${JSON.stringify(ok.body)}`);

    const { resolveParallelAliased } = srv;
    const pi = await srv.parallelIndex();
    const aliases = await srv.parallelAliases();
    const title = '2017 Panini Prizm Patrick Mahomes II #269 Kansas City Chiefs';

    const before = pi.resolveParallel(title, {});
    const after = resolveParallelAliased(pi, title, {}, aliases);
    check('  ...and it changes how the phrase reads',
      before.how === 'unmatched' && after.how === 'base',
      `${before.how} -> ${after.how}`);
    // 'base' is a real answer — the card IS the base card. It must not come
    // back as "could not read", which is a different state entirely.
    check('  ...as BASE, not as unreadable',
      after.parallel === null && after.how === 'base', JSON.stringify(after));
  }

  // A decided phrase must leave the queue, or the list never shrinks and
  // nobody believes it.
  {
    const q2 = await get(`/api/review/parallels?key=${KEY}&days=90`);
    const still = (q2.queue || []).map(g => g.phrase);
    check('a decided phrase drops out of the queue',
      !still.includes('kansas city chiefs'), still.join(' | ') || 'empty');
    check('  ...and is counted as work already done',
      q2.salesAlreadyFixed === 7 && q2.decisionsInPlace === 1,
      `${q2.salesAlreadyFixed} sales fixed, ${q2.decisionsInPlace} decision(s)`);
  }

  // ---- and a decision can be taken back ----------------------------------
  {
    await post(`/api/review/parallels?key=${KEY}`, { phrase: 'kansas city chiefs' });
    const q3 = await get(`/api/review/parallels?key=${KEY}&days=90`);
    check('a decision can be undone',
      (q3.queue || []).map(g => g.phrase).includes('kansas city chiefs'),
      `${q3.decisionsInPlace} decision(s) left`);
  }

  server.close();
  console.log(failures ? `\n${failures} check(s) failed` : '\nall parallel-desk checks passed');
  process.exit(failures ? 1 : 0);
})().catch(err => { console.error(err); server.close(); process.exit(1); });
