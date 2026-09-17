// The sale desk: one photo, looked at, outranking the text.
//
// WHY IT EXISTS. Every other desk here improves a reading of the TITLE, and
// each is worth hundreds of sales a click because the same words recur. This
// one is worth exactly one sale, and it exists because some titles are simply
// wrong. A seller who types "Refractor" on a Hyper writes a title that every
// reader in the world reads correctly and gets wrong. There is no phrase to fix
// and no checklist to extend; only a person looking at the card can settle it.
//
// WHAT THESE GUARD. The failure this codebase keeps meeting is a decision that
// reaches KV and nothing else — a screen that collects answers no page reads.
// It has happened with a cache key that was not bumped, and with a fix wired
// into one of two search endpoints. So the checks below do not stop at "the
// POST returned ok": they push a decision through and then assert that the
// BOARD groups by it and the CARD PAGE groups by it, which is the only claim
// anyone cares about.
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
db.exec(`CREATE TABLE sales (item_id TEXT, sold_date TEXT, title TEXT, price_cents INTEGER,
  currency TEXT, listing_format TEXT, grader TEXT, grade TEXT, player TEXT, parallel TEXT,
  year TEXT, set_name TEXT, card_number TEXT, confidence REAL, best_offer INTEGER,
  bids INTEGER, image_url TEXT)`);
db.exec(`CREATE TABLE daily (sold_date TEXT, sales INTEGER, priced INTEGER, total_cents INTEGER)`);

const iso = (o) => new Date(Date.now() + o * 86400000).toISOString().slice(0, 10);
const ins = db.prepare(`INSERT INTO sales (item_id, sold_date, title, price_cents, player,
  year, set_name, parallel, card_number, confidence, image_url) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);

// An anchor dated today. MARKET_EXCLUDE_TRAILING_DAYS drops the newest day, so
// without one the fixture's own rows are the ones cut.
ins.run('anchor', iso(0), '2025 Topps Chrome Anchor #1', 10000, 'Anchor',
        '2025', 'Topps Chrome', '', '1', 0.9, null);

// THE REPORTED CARD. Thirty sales of Jaxson Dart #306 whose titles say
// Refractor, plus one that is really a Hyper and whose title does not say so —
// the case no reader can reach. MOST_SOLD_MIN_GROUP is 25, so the honest
// Refractors clear the bar on their own and the board has a group to move.
let n = 0;
for (let i = 0; i < 30; i++) {
  ins.run('r' + n++, iso(-10 - (i % 8)),
          '2025 Topps Chrome Jaxson Dart #306 Refractor RC', 20000,
          'Jaxson Dart', '2025', 'Topps Chrome', '', '306', 0.9, 'https://img/r' + i + '.jpg');
}
// The liar. Same words, different card, and far dearer — which is exactly why
// leaving it in the Refractor group matters: it drags that average.
ins.run('LIAR', iso(-9), '2025 Topps Chrome Jaxson Dart #306 Refractor RC', 300000,
        'Jaxson Dart', '2025', 'Topps Chrome', '', '306', 0.9, 'https://img/liar.jpg');
// And one whose imported column is filled and also wrong, to prove the
// override outranks the column and not merely the reader.
ins.run('COLUMN', iso(-9), '2025 Topps Chrome Jaxson Dart #306 RC', 250000,
        'Jaxson Dart', '2025', 'Topps Chrome', 'Refractors', '306', 0.9, null);

for (let d = 0; d < 40; d++) {
  db.prepare('INSERT INTO daily (sold_date, sales, priced, total_cents) VALUES (?,?,?,?)')
    .run(iso(-d), 100, 90, 900000);
}

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

// Stubs before the require: server.js destructures these off db.js at load, so
// one installed afterwards is one it never sees.
const KV = new Map();
const CACHE = new Map();
const dbMod = require(path.join(ROOT, 'db.js'));
dbMod.getNflDb = () => d1;
dbMod.archiveGet = async (k) => (KV.has(k) ? KV.get(k) : null);
dbMod.archivePut = async (k, v) => { KV.set(k, v); };
dbMod.cacheGet = async (k) => (CACHE.has(k) ? CACHE.get(k) : null);
dbMod.cachePut = (k, v) => { CACHE.set(k, v); };
process.env.CF_WORKER = '1';
process.env.ADMIN_PASSWORD = 'test-key-for-the-sale-desk';

const srv = require(path.join(ROOT, 'server.js'));
const server = srv.app.listen(3226);

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};
const K = encodeURIComponent(process.env.ADMIN_PASSWORD);
const get = async (p) => (await fetch(`http://127.0.0.1:3226${p}`)).json();
const post = async (body) => {
  const r = await fetch(`http://127.0.0.1:3226/api/review/sales?key=${K}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
// The board is cached for 48 hours; without clearing it every check after the
// first would read the pre-decision copy and pass while proving nothing.
const board = async () => { CACHE.clear(); return get('/api/sold-stats?days=90'); };
const dartRows = (b) => (b.mostSold || []).filter(r => /Jaxson Dart/.test(r.name || ''));

(async () => {
  // ---- the door is shut --------------------------------------------------
  {
    const r = await fetch('http://127.0.0.1:3226/api/review/sales');
    check('the desk refuses an unauthenticated read', r.status === 403, `HTTP ${r.status}`);
    const w = await fetch('http://127.0.0.1:3226/api/review/sales', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ itemId: 'LIAR', parallel: 'Hyper' }),
    });
    check('  ...and an unauthenticated write', w.status === 403, `HTTP ${w.status}`);
  }

  // ---- finding a card ----------------------------------------------------
  {
    const f = await get(`/api/review/sales?key=${K}&q=jaxson`);
    check('a player search finds the card',
      f.available && (f.cards || []).some(c => c.cardNumber === '306' && c.sales >= 30),
      (f.cards || []).map(c => `${c.label} (${c.sales})`).join(' | ').slice(0, 110));
    check('  ...and says when it was built',
      Number.isFinite(Date.parse(f.generatedAt || '')), 'generatedAt=' + f.generatedAt);
  }

  // ---- the card's sales, with what they currently group as ---------------
  let before;
  {
    before = await get(`/api/review/sales?key=${K}&player=Jaxson%20Dart&cardNumber=306`);
    check('the card shows every sale of it',
      before.available && before.sales.length === 32,
      `${(before.sales || []).length} sales`);
    const liar = (before.sales || []).find(s => s.itemId === 'LIAR');
    check('  ...including the mislabelled one, read exactly as its title says',
      liar && /Refractor/i.test(liar.parallel || '') && liar.override === null,
      liar ? `${liar.parallel} (${liar.how})` : 'not found');
    check('  ...dearest first, so the ones that move an average are on screen',
      (before.sales || [])[0].price >= (before.sales || [])[1].price,
      `$${before.sales[0].price} then $${before.sales[1].price}`);
    check('  ...and offers the product\'s own parallels to pick from',
      (before.candidates || []).length > 10
      && before.candidates.some(c => /refractor/i.test(c)),
      `${(before.candidates || []).length} candidates`);
  }

  // ---- the state of the board BEFORE, so the change can be attributed ----
  //
  // Asserting the after-state alone would pass against a board that had always
  // been split, which is the shape of a check that proves nothing.
  var avgBefore = null;
  {
    const rows = dartRows(await board());
    check('before the decision the board has one Jaxson Dart row',
      rows.length === 1 && rows[0].sales === 32,
      rows.map(r => `${r.name} (${r.sales})`).join(' | ') || 'none');
    avgBefore = rows.length ? rows[0].avgPrice : null;
    // Thirty $200 Refractors plus a $3,000 and a $2,500 that are not
    // Refractors. The plain average of the honest thirty is $200.
    check('  ...and the two that do not belong are dragging its average up',
      avgBefore > 300, `avg $${avgBefore} against $200 for the real Refractors`);
  }

  // ---- one decision ------------------------------------------------------
  {
    const bad = await post({ itemId: 'LIAR', parallel: 'Not A Real Parallel' });
    check('a name no checklist has is refused',
      bad.status === 400 && /not a parallel/i.test(bad.body.error || ''),
      `HTTP ${bad.status}: ${bad.body.error || ''}`);
    check('  ...and nothing was stored for it',
      !(KV.get('saleoverrides:v1') || {}).LIAR, 'a refused write must not land');

    const ok = await post({ itemId: 'LIAR', parallel: 'Hyper' });
    check('a real parallel is accepted', ok.status === 200 && ok.body.ok === true,
      JSON.stringify(ok.body).slice(0, 100));
    check('  ...and stored against that one sale',
      ((KV.get('saleoverrides:v1') || {}).LIAR || {}).parallel === 'Hyper',
      JSON.stringify(KV.get('saleoverrides:v1')));
  }

  // ---- THE CLAIM: the board now groups by it -----------------------------
  {
    const rows = dartRows(await board());
    const ref = rows.find(r => /Refractor/i.test(r.name || ''));
    const hyp = rows.find(r => /Hyper/i.test(r.name || ''));
    check('the corrected sale leaves the group it was wrongly in',
      ref && ref.sales === 31, rows.map(r => `${r.name} (${r.sales})`).join(' | ') || 'none');
    check('  ...and appears as the card it actually is',
      hyp && hyp.sales === 1, rows.map(r => `${r.name} (${r.sales})`).join(' | ') || 'none');
    check('  ...and the average it was dragging comes down',
      ref && avgBefore != null && ref.avgPrice < avgBefore,
      ref ? `avg $${avgBefore} -> $${ref.avgPrice}` : 'no Refractor row');
  }

  // ---- and so does the card page -----------------------------------------
  //
  // A different code path from the board, and the one where a fix has silently
  // failed to land before.
  {
    const a = await get(`/api/card-analysis?itemId=LIAR`);
    check('the card page reads the corrected sale as its new parallel',
      a.available && /hyper/i.test(JSON.stringify(a.card || {})),
      a.available ? JSON.stringify(a.card).slice(0, 120) : `unavailable: ${a.reason}`);
  }

  // ---- the column is beaten too ------------------------------------------
  //
  // The imported parallel column is filled from the same title, so when the
  // title lies the column inherits the lie. A person looking at the card is
  // later evidence than a field copied from the text they disagree with.
  {
    const c0 = await get(`/api/review/sales?key=${K}&player=Jaxson%20Dart&cardNumber=306`);
    const col0 = c0.sales.find(s => s.itemId === 'COLUMN');
    check('a sale with a filled column reads from the column first',
      col0 && col0.how === 'column' && /Refractor/i.test(col0.parallel || ''),
      col0 ? `${col0.parallel} (${col0.how})` : 'not found');

    await post({ itemId: 'COLUMN', parallel: 'Hyper' });
    const c1 = await get(`/api/review/sales?key=${K}&player=Jaxson%20Dart&cardNumber=306`);
    const col1 = c1.sales.find(s => s.itemId === 'COLUMN');
    check('  ...and the decision outranks it',
      col1 && col1.how === 'sale-override' && col1.override === 'Hyper',
      col1 ? `${col1.parallel} (${col1.how})` : 'not found');

    const rows = dartRows(await board());
    const hyper = rows.find(r => /Hyper/i.test(r.name || ''));
    check('  ...on the board as well, not only on the desk',
      hyper && hyper.sales === 2,
      rows.map(r => `${r.name} (${r.sales})`).join(' | '));
  }

  // ---- base is an answer, not an absence ---------------------------------
  {
    const r = await post({ itemId: 'LIAR', parallel: '' });
    check('"it is the base card" is a decision that can be saved',
      r.status === 200 && ((KV.get('saleoverrides:v1') || {}).LIAR || {}).parallel === '',
      JSON.stringify((KV.get('saleoverrides:v1') || {}).LIAR));
    const s = (await get(`/api/review/sales?key=${K}&player=Jaxson%20Dart&cardNumber=306`))
      .sales.find(x => x.itemId === 'LIAR');
    check('  ...and reads back as base rather than as unanswered',
      s && s.override === 'Base' && s.how === 'base',
      s ? `override=${s.override} how=${s.how}` : 'not found');
  }

  // ---- and it can be taken back ------------------------------------------
  {
    await post({ itemId: 'LIAR' });
    check('a decision can be undone',
      !(KV.get('saleoverrides:v1') || {}).LIAR,
      JSON.stringify(Object.keys(KV.get('saleoverrides:v1') || {})));
    const rows = dartRows(await board());
    const ref = rows.find(r => !/Hyper/i.test(r.name || ''));
    check('  ...and the sale goes back where the title put it',
      ref && ref.sales === 31, rows.map(r => `${r.name} (${r.sales})`).join(' | '));
  }

  // ---- a bad KV write must not lose the sale -----------------------------
  //
  // An entry that is not the shape this expects has to be ignored, not thrown
  // on and not resolved to base. Losing a sale to a malformed write would be
  // worse than ignoring the write.
  {
    // `{ parallel: null }` is the one that matters, and a bare string is not a
    // substitute for it: a bare string has no .parallel at all, so a guard that
    // only checks the entry exists still comes back undefined and behaves
    // correctly by accident. A null .parallel is present and falsy, which a
    // weaker guard passes through — and a falsy parallel means BASE. That
    // would silently re-file the sale as a base card on the strength of a bad
    // KV write, which is worse than any reading of the title.
    KV.set('saleoverrides:v1', {
      LIAR: { parallel: null },
      COLUMN: 'Hyper',
      r0: { parallel: 7 },
    });
    const s = await get(`/api/review/sales?key=${K}&player=Jaxson%20Dart&cardNumber=306`);
    const liar = (s.sales || []).find(x => x.itemId === 'LIAR');
    const col = (s.sales || []).find(x => x.itemId === 'COLUMN');
    const num = (s.sales || []).find(x => x.itemId === 'r0');
    check('a null parallel is ignored, not read as "base"',
      s.available && liar && liar.override === null && /Refractor/i.test(liar.parallel || ''),
      liar ? `override=${liar.override} parallel=${liar.parallel}` : 'card failed to load');
    check('  ...as is an entry that is not an object at all',
      col && col.override === null && /Refractor/i.test(col.parallel || ''),
      col ? `override=${col.override} parallel=${col.parallel}` : 'not found');
    check('  ...and one whose parallel is not a string',
      num && num.override === null && /Refractor/i.test(num.parallel || ''),
      num ? `override=${num.override} parallel=${num.parallel}` : 'not found');
  }

  // ---- every grouping path goes through the one chain --------------------
  //
  // The repeated failure: /api/search was fixed while /api/direct-search fed
  // the same screen unfixed. A check naming one path would not catch the next
  // one, so this walks the source for anywhere that still builds the chain
  // itself.
  {
    const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    // Counting inline column reads was the first shape of this check, and it
    // was the wrong one: it reported "3" without saying whether the third was a
    // bug or a legitimate use, and the answer was legitimate. What actually
    // matters is that the READER is only ever reached through the chain — any
    // other caller is a path where a decision silently does not apply.
    const callers = (src.match(/resolveParallelAliased\(/g) || []).length;
    check('the reader is only reached through the one chain',
      callers === 3,
      `${callers} references: the definition, _saleParallel, and _identityOf — a fourth is a bypass`);
    check('  ...and the board asks for the overrides',
      /_groupMostSold\([\s\S]{0,200}?saleOverrides\(\)/.test(src),
      'a board built without them ignores every decision silently');
    check('  ...as does the card page',
      /const sOverrides = await saleOverrides\(\)/.test(src)
      && /_saleParallel\(row, pi, pAliases, sOverrides/.test(src),
      'card-analysis must pass them to the chain');
    check('  ...and search identity',
      /_identityOf\(r\.title, pi, player, pAliases, r\.itemId \|\| r\.item_id, sOverrides\)/.test(src),
      'a corrected sale must match the card a person said it is');
  }

  // ---- the screen can make these decisions -------------------------------
  {
    const html = fs.readFileSync(path.join(ROOT, 'public', 'sale-desk.html'), 'utf8');
    const script = (html.match(/<script>([\s\S]*)<\/script>/) || [])[1] || '';
    check('the sale desk page parses as JavaScript',
      (() => {
        try { new Function(script.replace(/const qs[\s\S]*?location\.search\);/, 'const qs=new Map();')); return true; }
        catch (e) { return false; }
      })(), 'a syntax error here is a blank screen, found by a person');
    check('  ...talks to the sale endpoint',
      /\/api\/review\/sales\?key=/.test(script), 'the endpoint must be wired');
    check('  ...sends the item id, because the unit is one sale',
      /const body = \{ itemId: s\.itemId \};/.test(script),
      'a decision keyed by anything else would move more than the sale looked at');
    check('  ...distinguishes cleared from base when saving',
      /if \(parallel !== undefined\) body\.parallel = parallel;/.test(script),
      "omitting the field undoes; '' says base — they must not collapse");
    check('  ...narrows the parallels as you type',
      /box\.oninput = \(\) => \{ typed = box\.value; cand = 0; render\(\); \};/.test(script)
      && /words\.every\(w => low\.includes\(w\)\)/.test(script),
      'typing must filter, or the rainbow is a memory test');
    check('  ...and keeps the caret where it was',
      /box\.setSelectionRange\(typed\.length, typed\.length\)/.test(script),
      're-rendering on each keystroke eats the second character otherwise');
    check('  ...marks a corrected sale apart from an unread one',
      /s\.override != null \? ' on' : ''/.test(script) && /' unread'/.test(script),
      'the point of the grid is seeing which one is not like the others');
  }

  server.close();
  console.log(failures ? `\n${failures} check(s) failed` : '\nall sale-desk checks passed');
  process.exit(failures ? 1 : 0);
})().catch(err => { console.error(err); server.close(); process.exit(1); });
