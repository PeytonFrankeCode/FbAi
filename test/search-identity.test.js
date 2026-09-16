// Does the SEARCH screen know which card you asked for?
//
// It did not, and that is the bug four rounds of fixes kept missing. A search
// for "2025 Prizm Mahomes Silver" returned a Panini ASCC Asia Convention card,
// and every explanation offered — grade reading, the KV cache, the service
// worker — was about something else. The search screen matched keywords,
// grouped by grade, and drew whatever eBay sent. It never asked which CARD a
// listing was, so no amount of work on the identity engine could ever have
// shown up there.
//
// WHERE THE ERRORS MUST GO. On the card page an unreadable parallel is dropped,
// because a wrong sale corrupts a published median. Here nothing may be
// dropped: only a positive, confident disagreement moves a listing into the
// second section, and anything unreadable stays with the card. A search that
// silently hides a real comp teaches nobody anything — including me. Half the
// checks below exist to prove the unreadable cases are KEPT.
process.env.CF_WORKER = '1';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');

if (!fs.existsSync(path.join(ROOT, 'public', 'data', 'parallel-index.json'))) {
  console.log('SKIP  search-identity  — run `npm run build:pages` first (CI does)');
  process.exit(0);
}
const { tagSameCard } = require(path.join(ROOT, 'server.js'));

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

const tag = async (query, titles) => {
  const rows = titles.map((t, i) => ({ itemId: 'i' + i, title: t }));
  const identity = await tagSameCard(rows, query);
  return { identity, rows, other: rows.filter(r => r.sameCard === false).map(r => r.title) };
};

(async () => {
  // ---- the reported case, verbatim -------------------------------------
  {
    const { identity, rows } = await tag('2025 Prizm Mahomes Silver', [
      '2025 Panini Prizm Patrick Mahomes #1 Silver Prizm',            // 0 the card
      '2025 Panini ASCC Asia Convention Patrick Mahomes Gold /10',    // 1 different product
      '2025 Panini Prizm Patrick Mahomes #1 Red White Blue Prizm',    // 2 different parallel
      '2025 Panini Prizm Patrick Mahomes #1 Silver Prizm Auto',       // 3 different kind
      '2025 Panini Prizm Patrick Mahomes #1 Silver Prizm PSA10',      // 4 same card, in a slab
    ]);

    check('the query is read as a specific card',
      identity && identity.parallel === 'silver' && identity.kind === 'base',
      JSON.stringify(identity));

    check('  ...the Asia Convention card is not this card',
      rows[1].sameCard === false, `sameCard=${rows[1].sameCard}`);
    check('  ...nor is a Red White Blue',
      rows[2].sameCard === false, `sameCard=${rows[2].sameCard}`);
    check('  ...nor is the autograph',
      rows[3].sameCard === false, `sameCard=${rows[3].sameCard}`);

    check('  ...while the Silver itself is kept',
      rows[0].sameCard === true, `sameCard=${rows[0].sameCard}`);
    // A grade is not a card. Splitting on it here would tear one card's
    // listings apart on the very screen that groups them BY grade.
    check('  ...and so is a graded copy of it',
      rows[4].sameCard === true, `sameCard=${rows[4].sameCard}`);
  }

  // ---- print run and kind, where the columns are identical --------------
  {
    const { rows } = await tag('2025 Prizm Cam Ward Auto /5', [
      '2025 Panini Prizm Cam Ward #14 RC Auto /5',
      '2025 Panini Prizm Cam Ward #14 RC Auto /10',
      '2025 Panini Prizm Cam Ward #14 RC Silver',
    ]);
    check('a /5 and a /10 are different cards',
      rows[0].sameCard === true && rows[1].sameCard === false,
      `/5=${rows[0].sameCard} /10=${rows[1].sameCard}`);
    check('  ...and a base card is not the autograph',
      rows[2].sameCard === false, `sameCard=${rows[2].sameCard}`);
  }

  // ---- everything unreadable stays put ---------------------------------
  {
    // Too vague to name a card. The screen must render exactly as it did
    // before rather than growing an empty "other cards" heading.
    const vague = await tag('Mahomes', [
      '2025 Panini Prizm Patrick Mahomes #1 Silver Prizm',
      '2017 Prizm Mahomes #269 Gold /10',
    ]);
    check('a one-word search is not split at all',
      vague.identity === null && vague.rows.every(r => r.sameCard === undefined),
      `identity=${JSON.stringify(vague.identity)}`);

    // A title that names no parallel anywhere. Unreadable is NOT disagreement.
    const murky = await tag('2025 Prizm Mahomes Silver', [
      '2025 Panini Prizm Patrick Mahomes #1 Silver Prizm',
      'Patrick Mahomes football card nice condition look',
    ]);
    check('an unreadable listing is kept, not hidden',
      murky.rows[1].sameCard === true,
      `"${murky.rows[1].title}" -> sameCard=${murky.rows[1].sameCard}`);

    // Nothing to disagree with -> no split, so no heading.
    const agree = await tag('2025 Prizm Mahomes Silver', [
      '2025 Panini Prizm Patrick Mahomes #1 Silver Prizm',
      '2025 Panini Prizm Patrick Mahomes #1 Silver Prizm',
    ]);
    check('  ...and a list that all agrees produces no second section',
      agree.identity === null, JSON.stringify(agree.identity));
  }

  // ---- the product word must not be mistaken for the parallel -----------
  //
  // 'prizm' is in the parallel vocabulary AND is the product in this query. If
  // the reader picks it, the seed parallel becomes "prizm", every Silver Prizm
  // listing keys as "silver", and the ENTIRE result set moves to "other cards".
  // The failure is total and looks like the feature working.
  //
  // Word order decides whether the guard is even reached. With the parallel
  // last the rightmost-first scan finds "silver" before it ever considers
  // "prizm", so this case is written with the PRODUCT word last — the only
  // arrangement where skipping product-only windows is what saves it. Written
  // the other way round the check passed with the guard deleted.
  {
    for (const q of ['2025 Prizm Mahomes Silver',       // parallel last
                     '2025 Silver Mahomes Prizm',       // product last
                     '2025 Mahomes Silver Prizm']) {    // adjacent, longest wins
      const { identity } = await tag(q, [
        '2025 Panini Prizm Patrick Mahomes #1 Silver Prizm',
        '2025 Panini Prizm Patrick Mahomes #1 Gold Prizm',
      ]);
      check(`the set name is not read as the parallel — "${q}"`,
        identity && identity.parallel === 'silver',
        `read as "${identity && identity.parallel}" (must be silver, never prizm)`);
    }
  }

  // ---- the front end must default to KEEPING ---------------------------
  //
  // sameCard is absent on every path that does not tag — a page-2 fetch from
  // eBay, a mock, a for-sale search. If undefined ever reads as "different",
  // those screens hide every listing they have.
  {
    const src = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
    const start = src.indexOf('const _isOtherCard');
    const end = src.indexOf('function renderGradeGroups');
    check('the front-end predicate is where this check expects it',
      start > 0 && end > start, `start=${start} end=${end}`);

    const ctx = { console };
    vm.createContext(ctx);
    vm.runInContext(src.slice(start, end) + '\nthis.__isOther = _isOtherCard;', ctx);

    check('only an explicit false moves a listing out of the main list',
      ctx.__isOther({ sameCard: false }) === true
      && ctx.__isOther({ sameCard: true }) === false
      && ctx.__isOther({}) === false
      && ctx.__isOther({ sameCard: undefined }) === false
      && !ctx.__isOther(null),
      `false->${ctx.__isOther({ sameCard: false })} undefined->${ctx.__isOther({})}`);

    // The second section has to stay on the page. Deleting listings would look
    // tidier and would make every identity mistake invisible — to the person
    // searching and to whoever has to fix it.
    check('  ...and the other-cards section is rendered, not discarded',
      /function renderOtherCards\(/.test(src) && /other-cards-toggle/.test(src),
      'renderOtherCards must exist and be reachable');
    check('  ...with somewhere to click to see them',
      /\.other-cards-toggle\s*\{/.test(fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8')),
      'style.css must style .other-cards-toggle');
  }

  console.log(failures ? `\n${failures} check(s) failed` : '\nall search-identity checks passed');
  process.exit(failures ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
