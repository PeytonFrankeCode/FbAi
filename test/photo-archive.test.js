// The photo archive, and specifically the cursor.
//
// The job copies eBay listing photos into R2 before eBay purges them, walking
// the sales table oldest-first behind a (sold_date, item_id) cursor stored in
// KV. Everything hangs off how far that cursor is allowed to move.
//
// Move it too far and a photo is lost permanently and silently: the row is
// behind the cursor, so it is never looked at again, and the only symptom is a
// broken image months later. Move it too little and the job re-reads the same
// rows forever and never reaches the backlog it exists to clear.
//
// Neither failure shows up as an error, which is why this file leans on that
// one function harder than on anything else.
const path = require('path');
const {
  sizedUrl, keyForUrl, isPermanent, nextCursor, summarise, PHOTO_SIZE,
} = require(path.join(__dirname, '..', 'photo-archive-core.js'));

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

// ---- size ----
{
  const from1600 = sizedUrl('https://i.ebayimg.com/images/g/abc/s-l1600.jpg');
  const from64 = sizedUrl('https://i.ebayimg.com/images/g/abc/s-l64.jpg');
  check('the stored size is rewritten whatever the row happened to hold',
    from1600 === `https://i.ebayimg.com/images/g/abc/s-l${PHOTO_SIZE}.jpg` && from1600 === from64,
    from1600);
  check('  ...and a URL with no size marker is left alone',
    sizedUrl('https://example.com/pic.jpg') === 'https://example.com/pic.jpg');
  check('  ...and an empty url does not become the string "undefined"',
    sizedUrl(null) === '' && sizedUrl(undefined) === '');
}

// ---- key ----
(async () => {
  const subtle = globalThis.crypto.subtle;
  const url = 'https://i.ebayimg.com/images/g/abc/s-l1600.jpg';
  const a = await keyForUrl(url, subtle);
  const b = await keyForUrl(url, subtle);
  check('the key is derived from the url alone, so serving needs no lookup',
    a === b && /^p\/[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{32}$/.test(a), a);
  const other = await keyForUrl(url + 'x', subtle);
  check('  ...and two urls do not collide', a !== other);

  // The size is normalised BEFORE hashing in the job, so the same photo
  // requested at a different size must not land under a second key — that
  // would store the same image twice and bill for both.
  const k1 = await keyForUrl(sizedUrl('https://i.ebayimg.com/images/g/abc/s-l64.jpg'), subtle);
  const k2 = await keyForUrl(sizedUrl('https://i.ebayimg.com/images/g/abc/s-l1600.jpg'), subtle);
  check('  ...and one photo stored at one size has exactly one key', k1 === k2, k1);

  // ---- permanence ----
  check('a 404 is permanent — eBay has purged it and no retry helps', isPermanent(404));
  check('  ...as is a 410', isPermanent(410));
  check('  ...but a 500 is not', !isPermanent(500));
  check('  ...nor a timeout, which arrives as no status at all', !isPermanent(undefined));

  // ---- the cursor: the part that loses data when wrong ----
  const row = (id, ok, permanent) => ({ itemId: id, soldDate: '2026-08-0' + id, ok, permanent });

  check('the cursor advances over rows that were stored',
    nextCursor(null, [row(1, true), row(2, true), row(3, true)]).itemId === '3'
      || nextCursor(null, [row(1, true), row(2, true), row(3, true)]).itemId === 3,
    JSON.stringify(nextCursor(null, [row(1, true), row(2, true), row(3, true)])));

  // The one that matters most.
  const stopped = nextCursor(null, [row(1, true), row(2, false, false), row(3, true)]);
  check('  ...but STOPS at a transient failure, so that photo is retried',
    stopped && String(stopped.itemId) === '1',
    stopped ? `held at ${stopped.itemId}` : 'null');
  check('  ...and does not skip past it to the later successes',
    !stopped || String(stopped.itemId) !== '3',
    'skipping would lose row 2 permanently and silently');

  // A permanently-gone photo must not block forever.
  const past = nextCursor(null, [row(1, true), row(2, false, true), row(3, true)]);
  check('  ...while a permanently-gone photo does not stall the walk',
    past && String(past.itemId) === '3',
    past ? `advanced to ${past.itemId}` : 'null');

  check('  ...and an empty batch leaves the cursor untouched',
    nextCursor({ soldDate: 'x', itemId: 'y' }, []).itemId === 'y');

  const priorHeld = nextCursor({ soldDate: 'a', itemId: 'keep' }, [row(1, false, false)]);
  check('  ...and a batch that fails immediately keeps the previous position',
    priorHeld && priorHeld.itemId === 'keep', JSON.stringify(priorHeld));

  // ---- accounting ----
  const sum = summarise([
    row(1, true), row(2, true),
    { itemId: 3, ok: false, alreadyStored: true },
    { itemId: 4, ok: false, permanent: true },
    { itemId: 5, ok: false, permanent: false },
  ]);
  check('the summary separates stored, already-there, gone and retry',
    sum.stored === 2 && sum.skipped === 1 && sum.permanent === 1 && sum.retry === 1,
    JSON.stringify(sum));

  // ---- the diagnostic has to measure what the job walks ----
  //
  // /api/debug/photo-archive answers "is the cursor moving?" by counting rows
  // ahead of it. If its WHERE clause drifts from the job's, it counts a
  // different set and gives a confident answer about the wrong thing — which
  // is worse than no diagnostic, because it would be believed.
  //
  // This exists because the job shipped with a cursor that can stall silently
  // and nothing at all to show whether it had.
  {
    const fs = require('fs');
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

    const jobAt = src.indexOf('async function archiveListingPhotos');
    const job = jobAt === -1 ? '' : src.slice(jobAt, jobAt + 2500);
    const diagAt = src.indexOf("app.get('/api/debug/photo-archive'");
    const diag = diagAt === -1 ? '' : src.slice(diagAt, diagAt + 2500);

    check('the archive diagnostic exists at all', diagAt !== -1,
      'a job that can stall silently needs something that shows whether it has');

    // Both must gate on a non-empty image_url, or the totals disagree.
    check('  ...and filters on a photo the same way the job does',
      /image_url IS NOT NULL AND image_url <> ''/.test(job)
        && /image_url IS NOT NULL AND image_url <> ''/.test(diag),
      'otherwise "remaining" counts rows the job never looks at');

    // Both must use the same composite cursor comparison. Comparing on
    // sold_date alone would re-count a whole day, or skip the rest of one.
    const cursorCmp = /sold_date > \? OR \(sold_date = \? AND item_id > \?\)/;
    check('  ...and advances on the same (sold_date, item_id) comparison',
      cursorCmp.test(job) && cursorCmp.test(diag),
      'date alone would double-count or skip within a day');

    // And it must read the cursor the job writes, not a key of its own.
    check('  ...and reads the very key the job stores',
      /PHOTO_CURSOR_KEY/.test(diag),
      'a second key would always report "never run"');
  }

  console.log(failures ? `\n${failures} check(s) failed` : '\nall photo-archive checks passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('THREW:', e && e.stack || e); process.exit(1); });
