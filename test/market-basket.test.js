// The basket's card list: base cards only (checked against the checklist),
// and each card's move read so one bad day cannot drive it.
const path = require('path');
process.env.CF_WORKER = '1';
const S = require(path.join(__dirname, '..', 'server.js'));

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

(async () => {
  // ---- the move ----
  // Jaxson Dart's 2025 Topps Chrome #306: a $2-10 base card that read +1,226%
  // off averages, with parallels priced in on some days.
  const day = (d, cents) => `2026-09-${String(d).padStart(2, '0')}:${cents}`;
  const noisy = [day(2, 500), day(4, 450), day(6, 3000), day(9, 520), day(12, 480),
                 day(15, 9000), day(18, 510), day(21, 530)].join(',');
  const mv = S._basketMove(noisy, 1);
  check('a day priced like a parallel does not move a base card',
    mv && Math.abs(mv.changePct) < 15 && mv.outlierDays === 2, JSON.stringify(mv));
  check('  ...and the card is priced at its typical day, not its mean',
    mv && mv.typicalCents >= 450 && mv.typicalCents <= 530, String(mv && mv.typicalCents));
  const up = S._basketMove([day(1, 400), day(3, 420), day(10, 600), day(12, 640)].join(','), 1);
  check('a real move still reads', up && up.changePct > 40 && up.changePct < 60, JSON.stringify(up));
  check('  ...and too few days read none', S._basketMove([day(1, 400), day(3, 900)].join(','), 1).changePct === null);

  // ---- base cards only ----
  const row = (set_name, card_number) => ({ year: '2025', set_name, card_number, player: 'Jaxson Dart' });
  const rows = [
    row('Donruss Optic', '273'),      // his base Optic
    row('Donruss Optic', '11'),       // his Uptown case hit
    row('Topps Chrome', '306'),       // his base Chrome rookie
    row('Topps Cosmic Chrome', 'STN-2'),
    row('Topps Chrome', 'RR-5'),      // Radiating Rookies insert
  ];
  const kept = (await S._basketBaseOnly(rows)).map(r => `${r.set_name} #${r.card_number}`);
  check('the basket keeps a player\'s base cards and drops his inserts',
    kept.join(', ') === 'Donruss Optic #273, Topps Chrome #306', kept.join(', '));
  const unknown = await S._basketBaseOnly([
    { year: '2031', set_name: 'Nothing Real', card_number: '12', player: 'Someone' },
    { year: '2031', set_name: 'Nothing Real', card_number: 'AB-12', player: 'Someone' }]);
  check('  ...and where no checklist can say, a coded number is still an insert',
    unknown.length === 1 && unknown[0].card_number === '12');

  // ---- the player index: the Sep 2 spike ----
  // Jaxson Dart's 30-day number jumped to 420 in a day: his Uptown case hits
  // ($275-500) sold on thin days under Optic #11, as if a base card.
  {
    const iso = (d) => new Date(Date.UTC(2026, 7, 22) + d * 86400000).toISOString().slice(0, 10);
    const rows = [];
    const add = (card, d, dollars) => rows.push({ card, sold_date: iso(d), s: dollars * 100, c: 1 });
    // Two base cards trading flat at $5 and $8, one sale each every other day.
    for (let d = 0; d <= 38; d += 2) { add('2025|donruss optic|jaxson dart|273||', d, 5); add('2025|topps chrome|jaxson dart|306||', d + 1, 8); }
    // "#11": a few $5 days and, on two thin days, $300 Uptowns.
    for (const d of [3, 9, 15, 21, 27]) add('2025|donruss optic|jaxson dart|11||', d, 5);
    add('2025|donruss optic|jaxson dart|11||', 11, 300); add('2025|donruss optic|jaxson dart|11||', 12, 350);
    const out = S._playerTrendPayload(rows, iso(38), 30, 'Jaxson Dart');
    const peak = Math.max(...(out.series || []).map(p => p.score));
    check('a case hit sold under a base number does not spike the player',
      out.available && peak < 130, `peak ${peak}, change ${out.changePct}%`);
    const kept = new Set((await S._baseCardRowsOnly(rows)).map(r => r.card));
    check('  ...and the player index keeps only his base cards by the checklist',
      kept.has('2025|donruss optic|jaxson dart|273||') && kept.has('2025|topps chrome|jaxson dart|306||')
      && !kept.has('2025|donruss optic|jaxson dart|11||'), [...kept].join(' , '));
  }

  // ---- the checklist only ever takes a card OUT ----
  // Important cards live in products we hold no checklist for, and a
  // checklist can miss a player's base card. Only a number the checklist lists
  // for him as an insert / auto / relic, and not as base, is dropped.
  {
    const probe = [
      { card: 'k273', year: '2025', set_name: 'donruss optic', player: 'jaxson dart', card_number: '273' },
      { card: 'k11', year: '2025', set_name: 'donruss optic', player: 'jaxson dart', card_number: '11' },
      { card: 'k999', year: '2025', set_name: 'donruss optic', player: 'jaxson dart', card_number: '999' },
      { card: 'kX', year: '2031', set_name: 'nothing we hold', player: 'jaxson dart', card_number: '7' },
      { card: 'kNew', year: '2025', set_name: 'donruss optic', player: 'someone unlisted', card_number: '11' },
    ];
    const kept = (await S._basketBaseOnly(probe)).map(r => r.card).sort();
    check('only a number the checklist calls his insert is dropped; the unknown is kept',
      kept.join(',') === 'k273,k999,kNew,kX', kept.join(','));
    // The whole-market index gets the same answer through its deny list.
    const fakeDb = { prepare: () => ({ bind: () => ({ all: async () => ({ results: probe }) }) }) };
    const deny = await S._marketDenied(fakeDb, '2026-09-21', 30, false);
    check('  ...and the market index leaves out exactly those cards', JSON.stringify(deny) === '["k11"]', JSON.stringify(deny));
  }

  const src = require('fs').readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  check('the index itself leaves coded numbers out', /card_number NOT GLOB '\*\[A-Za-z\]\*'/.test(src));
  check('  ...and passes the checklist deny list into the index and basket queries',
    /_rsiQuery\(db, throughIso, days, '', \[\], 'player', useAlias, daily, deny\)/.test(src)
    && /FROM pick_keys k JOIN pick_players t ON t\.player_n = k\.player_n\$\{denySql\}/.test(src));

  console.log(failures ? `\n${failures} check(s) failed` : '\nall market-basket checks passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
