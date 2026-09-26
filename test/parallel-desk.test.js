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
add('2017 Panini Prizm Patrick Mahomes II #269 Chiefs Kingdom', 7);
// A full team name is read past on its own now (parallel-index-core.js), so
// it never needs a decision.
add('2017 Panini Prizm Patrick Mahomes II #269 Kansas City Chiefs', 3);
// Already readable — must never reach the queue.
add('2017 Panini Prizm Patrick Mahomes II #269 Silver Prizm', 20);

// THE CASE THAT BROKE THE FIRST DESIGN, in both its forms.
//
// "signatures" came up on the live desk holding 45 sales across 2025 Rookies &
// Stars AND 2025 Absolute. One global answer would force both products to mean
// the same parallel, and there is no reason they should.
//
// Worse, inside ONE product the same word can be two cards told apart only by
// how many were made: a Signatures auto and a Signatures /25 carry identical
// words. Neither the phrase nor the product can settle that.
// The print run is placed BEFORE the card number on purpose. When it trails
// the number it lands inside the segment and the reader splits the phrase by
// itself — "signatures" and "signatures 25" become separate rows with no scope
// needed, which the first run of this test discovered. The scope exists for the
// other arrangement, where the words are identical and only the count differs.
add('2025 Panini Rookies & Stars - Rookies Ashton Jeanty #106 Signatures', 11,
    'Ashton Jeanty', '2025', 'Rookies & Stars');
add('2025 Panini Rookies & Stars /25 Jalen Milroe #132 Signatures', 6,
    'Jalen Milroe', '2025', 'Rookies & Stars');
add('2025 Panini Absolute - Rookies Shedeur Sanders #177 Signatures', 8,
    'Shedeur Sanders', '2025', 'Absolute');

// A phrase the catalogue knows as an insert SET, not a parallel. Taken from the
// live desk: "stars in the night" is a Topps Cosmic Chrome insert, so these are
// base cards OF that insert and "not a parallel" is the right answer. The screen
// has to say so, or it invites a guess it will then refuse — which is what it
// did, and the guess typed into it was "202".
add('2025 Topps Cosmic Chrome - Tetairoa McMillan #STN-6 Stars In The Night', 4,
    'Tetairoa McMillan', '2025', 'Cosmic Chrome');

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
  check('  ...and so does a seller phrase the reader does not know',
    phrases.includes('chiefs kingdom'), phrases.join(' | '));
  check('  ...but a full team name no longer does: the reader reads past it',
    !phrases.includes('kansas city chiefs'), phrases.join(' | '));
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
  //
  // Asserted as an ordering rather than by naming the phrase that happens to
  // lead: the first version pinned "aqua wave speckle" and broke the moment the
  // fixture grew a bigger phrase, which is a test describing today's data
  // rather than the rule.
  {
    const counts = (q.queue || []).map(g => g.sales);
    const descending = counts.every((c, i) => i === 0 || counts[i - 1] >= c);
    check('the queue is ordered by the sales each phrase holds up',
      descending && counts.length > 1, counts.join(' >= '));
  }

  // The number that decides whether the screen is worth opening at all.
  check('the queue reports its own leverage',
    q.salesPerDecision >= 7 && q.salesHeldUp === 50,
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
      { phrase: 'chiefs kingdom', parallel: '' });
    check('"not a parallel" is a decision the desk accepts',
      ok.status === 200 && ok.body.parallel === '',
      `HTTP ${ok.status} ${JSON.stringify(ok.body)}`);

    const { resolveParallelAliased } = srv;
    const pi = await srv.parallelIndex();
    const aliases = await srv.parallelAliases();
    const title = '2017 Panini Prizm Patrick Mahomes II #269 Chiefs Kingdom';

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
      !still.includes('chiefs kingdom'), still.join(' | ') || 'empty');
    check('  ...and is counted as work already done',
      q2.salesAlreadyFixed === 7 && q2.decisionsInPlace === 1,
      `${q2.salesAlreadyFixed} sales fixed, ${q2.decisionsInPlace} decision(s)`);
  }

  // ---- one phrase, several meanings --------------------------------------
  //
  // The correction that reshaped this: a phrase does not mean one thing. It can
  // differ by PRODUCT, and — harder — by PRINT RUN inside a single product,
  // where the words are identical and only the count differs.
  //
  // The desk cannot decide that. What it must do is show the split and let a
  // decision be made at the level the person could actually tell.
  {
    const q = await get(`/api/review/parallels?key=${KEY}&days=90`);
    const sig = (q.queue || []).find(g => g.phrase === 'signatures');
    check('a phrase that spans products is shown broken up, not as one lump',
      !!sig && sig.splits.length === 3,
      sig ? sig.splits.map(s => `${s.label}:${s.sales}`).join(' | ') : 'signatures missing');

    check('  ...split by product',
      !!sig && sig.splits.some(s => /Rookies & Stars/.test(s.label))
            && sig.splits.some(s => /Absolute/.test(s.label)),
      sig ? sig.splits.map(s => s.label).join(' | ') : '');
    // The half the product split alone cannot reach.
    check('  ...and by print run inside one product',
      !!sig && sig.splits.some(s => s.setName === 'Rookies & Stars' && s.printRun === 25)
            && sig.splits.some(s => s.setName === 'Rookies & Stars' && s.printRun === null),
      sig ? sig.splits.filter(s => /Rookies/.test(s.label)).map(s => s.label).join(' | ') : '');
    check('  ...each carrying its own photos to judge by',
      !!sig && sig.splits.every(s => Array.isArray(s.photos)),
      sig ? sig.splits.map(s => `${s.label}:${s.photos.length}`).join(' | ') : '');
  }

  // A scoped decision must bind ONLY its scope.
  {
    const { resolveParallelAliased } = srv;
    const pi = await srv.parallelIndex();
    const T = {
      rsPlain: '2025 Panini Rookies & Stars - Rookies Ashton Jeanty #106 Signatures',
      rs25:    '2025 Panini Rookies & Stars /25 Jalen Milroe #132 Signatures',
      abs:     '2025 Panini Absolute - Rookies Shedeur Sanders #177 Signatures',
    };
    const read = async (title, year, setName) => {
      const a = await srv.parallelAliases();
      return resolveParallelAliased(pi, title, { year, setName }, a);
    };

    // Narrowest first: this product, this print run.
    const r1 = await post(`/api/review/parallels?key=${KEY}`, {
      phrase: 'signatures', parallel: '',
      scope: { year: '2025', setName: 'Rookies & Stars', printRun: 25 },
    });
    check('a decision can be pinned to one product at one print run',
      r1.status === 200 && /\/25\|signatures$/.test(r1.body.key || ''),
      `${r1.status} ${r1.body.key}`);

    check('  ...and binds only that print run',
      (await read(T.rs25, '2025', 'Rookies & Stars')).how === 'base'
      && (await read(T.rsPlain, '2025', 'Rookies & Stars')).how === 'unmatched',
      `/25 -> ${(await read(T.rs25, '2025', 'Rookies & Stars')).how}, `
      + `plain -> ${(await read(T.rsPlain, '2025', 'Rookies & Stars')).how}`);

    check('  ...and does not touch the other product',
      (await read(T.abs, '2025', 'Absolute')).how === 'unmatched',
      (await read(T.abs, '2025', 'Absolute')).how);

    // Then the whole product.
    await post(`/api/review/parallels?key=${KEY}`, {
      phrase: 'signatures', parallel: '',
      scope: { year: '2025', setName: 'Rookies & Stars' },
    });
    check('a product-wide decision covers the rest of that product',
      (await read(T.rsPlain, '2025', 'Rookies & Stars')).how === 'base'
      && (await read(T.abs, '2025', 'Absolute')).how === 'unmatched',
      `plain -> ${(await read(T.rsPlain, '2025', 'Rookies & Stars')).how}, `
      + `absolute -> ${(await read(T.abs, '2025', 'Absolute')).how}`);

    // And a scoped answer must outrank a global one, or the narrower statement
    // — the later thought, made with the card in hand — would be ignored.
    await post(`/api/review/parallels?key=${KEY}`, { phrase: 'signatures', parallel: 'Signatures' });
    const scoped = await read(T.rsPlain, '2025', 'Rookies & Stars');
    const global_ = await read(T.abs, '2025', 'Absolute');
    check('the narrower decision wins over the global one',
      scoped.how === 'base' && global_.how === 'alias' && global_.parallel === 'Signatures',
      `scoped -> ${scoped.how}, global -> ${global_.how}/${global_.parallel}`);

    // Clean up so the undo check below starts from a known state.
    for (const sc of [{ year: '2025', setName: 'Rookies & Stars', printRun: 25 },
                      { year: '2025', setName: 'Rookies & Stars' }, null]) {
      await post(`/api/review/parallels?key=${KEY}`, sc ? { phrase: 'signatures', scope: sc }
                                                        : { phrase: 'signatures' });
    }
  }

  // ---- and a decision can be taken back ----------------------------------
  {
    await post(`/api/review/parallels?key=${KEY}`, { phrase: 'chiefs kingdom' });
    const q3 = await get(`/api/review/parallels?key=${KEY}&days=90`);
    check('a decision can be undone',
      (q3.queue || []).map(g => g.phrase).includes('chiefs kingdom'),
      `${q3.decisionsInPlace} decision(s) left`);
  }

  // ---- the rainbow: offer the answer instead of demanding it -------------
  //
  // Without the product's parallel list the only way to answer is to already
  // know the exact catalogue spelling, and a wrong guess is refused — which
  // makes the screen a memory test. Watched someone type "202" into it.
  {
    const q = await get(`/api/review/parallels?key=${KEY}&days=90`);
    const aqua = (q.queue || []).find(g => g.phrase === 'aqua wave speckle');
    check('a phrase is offered the parallels its product actually has',
      !!aqua && Array.isArray(aqua.candidates) && aqua.candidates.length > 0,
      aqua ? `${(aqua.candidates || []).length} candidates: ${(aqua.candidates || []).slice(0, 4).join(', ')}` : 'missing');

    // 2017 Prizm really does list Silver Prizm. If the suggestions do not
    // include the product's own parallels they are coming from the wrong place.
    check('  ...taken from THAT product, not from the whole catalogue',
      !!aqua && aqua.candidates.some(n => /Silver Prizm/i.test(n)),
      aqua ? aqua.candidates.slice(0, 8).join(' | ') : '');

    // And the phrase that is really an insert SET must say so, or the screen
    // invites a guess it will then refuse. "Stars In The Night" is a Cosmic
    // Chrome insert whose parallel is base — X is the answer.
    // The check that matters, on the phrase it was written for. "unknown" on an
    // arbitrary phrase would pass a version of this that never looked anything
    // up, so it is asserted on one the catalogue definitely knows.
    const stn = (q.queue || []).find(g => g.phrase === 'stars in the night');
    check('  ...and a phrase the catalogue knows as an insert SET says so',
      !!stn && stn.knownAs === 'subset',
      stn ? `knownAs=${stn.knownAs}` : 'stars in the night missing from the queue');
    check('  ...while a phrase it has never seen is not labelled as one',
      !!aqua && aqua.knownAs === 'unknown', aqua ? `knownAs=${aqua.knownAs}` : '');
  }

  // ---- the page has to be able to ask for a scope ------------------------
  //
  // The server can accept a scoped decision and the screen can still have no
  // way to make one — which is the same as not having built it. Checked against
  // the page rather than assumed, and by executing its script rather than
  // reading it, so a syntax error in the desk is a failing test and not a blank
  // screen discovered by a person.
  {
    const html = fs.readFileSync(path.join(ROOT, 'public', 'parallel-desk.html'), 'utf8');
    const script = (html.match(/<script>([\s\S]*)<\/script>/) || [])[1] || '';
    check('the desk page parses as JavaScript',
      (() => {
        try { new Function(script.replace(/const qs[\s\S]*?location\.search\);/, 'const qs=new Map();')); return true; }
        catch (e) { return false; }
      })(), 'a syntax error here is a blank screen, found by a person');

    check('  ...sends the scope it was given, not just the phrase',
      /scope: sp \?/.test(script) && /printRun: sp\.printRun/.test(script),
      'decide() must pass the selected split through to the server');

    // ONE AT A TIME, SEVERAL, OR ALL — the three things asked for.
    //
    // Number keys TOGGLE rather than switch, so places can be picked in any
    // combination: the same phrase often means one parallel in two products and
    // something else in a third, and answering those one at a time would work
    // and would be tedious.
    check('  ...lets places be picked in any combination, not one at a time',
      /if \(picked\.has\(i\)\) \{\s*picked\.delete\(i\)/.test(script)
      && /picked\.add\(i\)/.test(script),
      'number keys must toggle, so several places can be answered together');
    check('  ...with one key for every place at once',
      /toggle\(-2\)/.test(script) && /splits\.forEach\(\(_, k\) => picked\.add\(k\)\)/.test(script),
      'A must pick every place');
    check('  ...and applies the answer to each picked place',
      /const jobs = chosen\.length \? chosen\.map\(i => splits\[i\]\) : \[null\];/.test(script),
      'decide() must send one decision per picked place');

    // Nothing picked is NOT the same as everything picked, and the difference
    // is the whole reason both exist: one writes a global decision covering
    // products not on the list, the other writes one decision per place and
    // says nothing about anywhere else.
    check('  ...while answering with none picked still means everywhere',
      /: \[null\]/.test(script) && /scope: sp \?/.test(script),
      'an empty selection must send no scope at all');

    // An answered place leaves the phrase; the rest keep it open. Advancing
    // while splits are undecided would silently abandon them.
    check('  ...and stays on the phrase until every place is answered',
      /item\.splits = splits\.filter\(\(_, i\) => !doneSet\.has\(i\)\)/.test(script)
      && /if \(item\.splits\.length === 0\) \{ at\+\+; \}/.test(script),
      'a scoped decision must not skip the undecided splits');

    // A refusal must not read as success. If the typed name is in no checklist
    // every job fails, and "+0 sales" would look like the work was done.
    check('  ...and a refusal is not reported as a save',
      /if \(!okCount\) \{ flash\(firstError/.test(script),
      'zero successes must flash the error, not a total');

    // ---- the picker has to narrow as you type ----------------------------
    //
    // The suggestions are only useful if typing filters them: a product can
    // list forty parallels and nobody scrolls that with the keyboard. Checked
    // by name because a mutation that removed the input handler slipped past
    // every other check here — the list still rendered, it just stopped
    // responding, which is invisible to a test that only reads the markup.
    check('  ...narrows the suggestions as you type',
      /box\.oninput = \(\) => \{ typed = box\.value;/.test(script)
      && /words\.every\(w => low\.includes\(w\)\)/.test(script),
      'typing must filter the candidate list');
    check('  ...on every word, so "gold ref" finds "Gold Interstellar Refractors"',
      /typed\.toLowerCase\(\)\.split\(\/\\s\+\/\)\.filter\(Boolean\)/.test(script),
      'the filter must match each typed word separately');
    check('  ...and Enter takes the highlighted suggestion over the raw text',
      /const hit = list\[cand\];/.test(script) && /if \(hit\) \{ decide\(hit\.textContent\); \}/.test(script),
      'a fragment like "gold ref" must not be saved as a parallel name');
    // Re-rendering on every keystroke blurs the box unless focus is restored,
    // which would silently eat the second character of everything typed.
    check('  ...while keeping the caret where it was',
      /box\.focus\(\); box\.setSelectionRange\(typed\.length, typed\.length\);/.test(script),
      'focus must survive the re-render');
  }

  server.close();
  console.log(failures ? `\n${failures} check(s) failed` : '\nall parallel-desk checks passed');
  process.exit(failures ? 1 : 0);
})().catch(err => { console.error(err); server.close(); process.exit(1); });
