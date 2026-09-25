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

  const src = require('fs').readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  check('the index itself leaves coded numbers out', /card_number NOT GLOB '\*\[A-Za-z\]\*'/.test(src));

  console.log(failures ? `\n${failures} check(s) failed` : '\nall market-basket checks passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
