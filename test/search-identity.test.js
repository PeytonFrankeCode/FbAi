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

    // A title that names no parallel anywhere, on a product we hold no
    // checklist for. There is no answer key to be accurate against, so
    // unreadable is not disagreement and the listing stays.
    //
    // Inside the catalogue this case goes the OTHER way now — see the strict
    // block below. That is the whole point of the split, so the two cases are
    // asserted separately rather than one rule being assumed to cover both.
    const murky = await tag('2025 Panini ASCC Mahomes Silver', [
      '2025 Panini ASCC Asia Convention Patrick Mahomes Silver',
      '2025 Panini ASCC Asia Convention Patrick Mahomes Gold',
      'Patrick Mahomes ASCC card nice look',
    ]);
    check('outside the catalogue, an unreadable listing is kept, not hidden',
      murky.rows[2].sameCard === true,
      `"${murky.rows[2].title}" -> sameCard=${murky.rows[2].sameCard}`);
    check('  ...while a positively different parallel still moves',
      murky.rows[1].sameCard === false, `sameCard=${murky.rows[1].sameCard}`);

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

  // ---- accurate where we hold the answer key, quiet where we do not -------
  //
  // The ask, in the user's words: "we don't need to group all the cards but I
  // would like the ones that we have checklists for to be accurate."
  //
  // So the rule changes with coverage. Inside the catalogue a listing must
  // PROVE it is this card; "I could not read this" is not good enough and it
  // goes to the second section. Outside the catalogue there is no answer key to
  // be accurate against, so nothing changes — being strict there would hide
  // listings on the strength of nothing at all.
  {
    // 2017 Panini Prizm is in the catalogue, so this is the strict path.
    const inside = await tag('2017 Panini Prizm Mahomes Silver', [
      '2017 Panini Prizm Patrick Mahomes II #269 Silver Prizm',
      '2017 Panini Prizm Patrick Mahomes II #269 Red White Blue',
      'Patrick Mahomes 2017 Prizm rookie card nice look',          // names no parallel
      '2017 Panini Prizm Patrick Mahomes II #269 Silver Prizm PSA 10',
    ]);
    check('a product we hold a checklist for is matched strictly',
      inside.identity && inside.identity.catalogued === true,
      JSON.stringify(inside.identity));
    check('  ...so a listing that cannot be read is NOT kept as this card',
      inside.rows[2].sameCard === false, `sameCard=${inside.rows[2].sameCard}`);
    check('  ...and it is counted as unconfirmed, not as a different card',
      inside.identity.unconfirmed === 1,
      `unconfirmed=${inside.identity.unconfirmed} differing=${inside.identity.differing}`);
    check('  ...while the readable ones are unaffected',
      inside.rows[0].sameCard === true && inside.rows[1].sameCard === false
      && inside.rows[3].sameCard === true,
      inside.rows.map(r => r.sameCard).join(','));

    // A TOPPS product, which could not be strict at all until the coverage test
    // stopped asking a hardcoded brand list.
    //
    // CARD_SET_NAMES holds optic, prizm, donruss, select, absolute, contenders
    // — and no topps, no chrome, no bowman. It grew up beside a catalogue that
    // is 330 Panini products to 25 Topps, so the bias in the data had become a
    // bias in the code: a Topps search could never match strictly however
    // complete its checklist was. This one also only resolves through an alias,
    // so it covers both.
    const topps = await tag('2025 Topps Signature Ashton Jeanty Silver', [
      '2025 Topps Signature Class Ashton Jeanty #102 Silver',
      '2025 Topps Signature Class Ashton Jeanty #102 Gold',
    ]);
    check('a Topps product is matched strictly too, not just Panini',
      topps.identity && topps.identity.catalogued === true,
      JSON.stringify(topps.identity));

    // The product name does not have to sit at the front of the query.
    const reordered = await tag('Mahomes 2017 Prizm Silver', [
      '2017 Panini Prizm Patrick Mahomes II #269 Silver Prizm',
      '2017 Panini Prizm Patrick Mahomes II #269 Gold Prizm',
    ]);
    check('  ...and the product is found wherever it sits in the query',
      reordered.identity && reordered.identity.catalogued === true,
      JSON.stringify(reordered.identity));

    // ASCC is a real product we have no checklist for — the one in the report.
    const outside = await tag('2025 Panini ASCC Mahomes Silver', [
      '2025 Panini ASCC Asia Convention Patrick Mahomes Silver',
      'Patrick Mahomes ASCC card nice look',
    ]);
    check('a product we have no checklist for is left alone',
      outside.identity === null && outside.rows.every(r => r.sameCard !== false),
      JSON.stringify(outside.identity));

    // Strictness must not turn a deliberately broad search into pieces.
    const broad = await tag('2017 Panini Prizm Mahomes', [
      '2017 Panini Prizm Patrick Mahomes II #269 Silver Prizm',
      '2017 Panini Prizm Patrick Mahomes II #269 Gold Prizm /10',
      'Patrick Mahomes 2017 Prizm rookie card nice look',
    ]);
    check('  ...and a search naming no parallel still returns every parallel',
      broad.identity === null && broad.rows.every(r => r.sameCard !== false),
      JSON.stringify(broad.identity));
  }

  // ---- EVERY sold search path has to tag, not just the one I looked at ----
  //
  // THE FAILURE THIS PREVENTS, which already burned two deploys. There are two
  // endpoints that return sold listings into the same grade-group view:
  // /api/search and /api/direct-search. I wired the identity check into the
  // first, shipped it, and reported it fixed. The screen being complained about
  // was served by the second, so nothing changed and it looked once again like
  // the work had not happened.
  //
  // A third one added later would fail exactly the same way and for exactly the
  // same reason, so this refuses to let that happen quietly: every sold branch
  // that returns listings must call tagSameCard.
  {
    const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    const lines = src.split('\n');
    const bad = [];
    let checked = 0;
    lines.forEach((line, i) => {
      if (!/^\s*if \(mode === 'sold'\) \{\s*$/.test(line)) return;
      // Walk to the matching close brace so the block is the real block, not a
      // fixed window that could miss the call or borrow one from the next.
      let depth = 0, end = i;
      for (let j = i; j < lines.length; j++) {
        depth += (lines[j].match(/\{/g) || []).length;
        depth -= (lines[j].match(/\}/g) || []).length;
        if (depth === 0) { end = j; break; }
      }
      const block = lines.slice(i, end + 1).join('\n');
      // Only branches that hand listings back to a page. fetchEbayItems' own
      // sold branch fetches them and is not a response.
      if (!/res\.json\(\{[\s\S]*?results:/.test(block)) return;
      checked++;
      if (!/tagSameCard\(/.test(block)) bad.push(`server.js:${i + 1}`);
    });

    check('every sold search branch that returns listings tags them',
      checked >= 2 && bad.length === 0,
      bad.length
        ? `${bad.join(', ')} returns sold listings without calling tagSameCard — `
          + `that screen renders them in grade groups and will show other cards as this card`
        : `${checked} branches checked`);
  }

  console.log(failures ? `\n${failures} check(s) failed` : '\nall search-identity checks passed');
  process.exit(failures ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
