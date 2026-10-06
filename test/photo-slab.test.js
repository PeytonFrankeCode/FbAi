// A slab read from its photo, for the titles that never say (photo-slab-core.js).
//
// "1989 Score - 1989 Rookie Barry Sanders #257 (RC)" sold as a PSA 7 and was
// filed raw: the title reads the same either way, and a PSA 7 sells too close
// to raw for a price rule to catch. The photo shows the slab. A CI job scores
// the photos into D1; this pins how the site uses the scores, and that a
// missing score, or a missing table, changes nothing.
const fs = require('fs');
const path = require('path');
process.env.CF_WORKER = '1';
const { DatabaseSync } = require('node:sqlite');
const P = require('../photo-slab-core.js');
const { gradeBucket } = require('../grade-core.js');
const S = require(path.join(__dirname, '..', 'server.js'));

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};
const ROOT = path.join(__dirname, '..');
const SANDERS = '1989 Score - 1989 Rookie Barry Sanders #257 (RC)';

// ---- the head --------------------------------------------------------------
{
  const head = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'data', 'slab-head.json'), 'utf8'));
  check('the shipped head is a 512-weight layer over CLIP ViT-B/32',
    head.model === 'Xenova/clip-vit-base-patch32' && head.w.length === 512
    && head.w.every(Number.isFinite) && Number.isFinite(head.b));
  const zero = new Array(512).fill(0);
  check('slabScore is the logistic of the weighted sum',
    Math.abs(P.slabScore(zero, head) - 1 / (1 + Math.exp(-head.b))) < 1e-12
    && Math.abs(P.slabScore([1, 2], { w: [0.5, 0.25], b: -1 }) - 0.5) < 1e-12);
}

// ---- a slab on the photo alone ------------------------------------------
check('a score of 0.8 or more is a slab', P.photoSlabSure({ slab_score: 0.8 }) && !P.photoSlabSure({ slab_score: 0.79 }));
check('no score is no evidence', !P.photoSlabSure({}) && !P.photoSlabSure(null) && !P.photoSlabSure({ slab_score: null }));
check('the Sanders PSA 7 reads raw on its title', gradeBucket({ title: SANDERS }) === 'Raw');
check('  ...and as a slab with its photo', gradeBucket({ title: SANDERS, slab_score: 0.93 }) === P.PHOTO_SLAB_LABEL);
check('  ...but a photo in the toploader range does not move it alone',
  gradeBucket({ title: SANDERS, slab_score: 0.7 }) === 'Raw');
check('a title that says "raw" outranks the photo',
  gradeBucket({ title: '1989 Score Barry Sanders #257 RC raw', slab_score: 0.95 }) === 'Raw');
check('a title that names the grade keeps its own grade',
  gradeBucket({ title: '1989 Score Barry Sanders #257 PSA 7', slab_score: 0.95 }) === 'PSA 7'
  && gradeBucket({ title: SANDERS, grader: 'PSA', grade: 7, slab_score: 0.95 }) === 'PSA 7');

// ---- a slab because the photo leans and the price agrees ----------------
{
  const sale = (dollars, score) => ({ price_cents: Math.round(dollars * 100), ...(score != null ? { slab_score: score } : {}) });
  check('photo 0.5+ and 1.5x the others\' median and $10+: a slab',
    P.photoSlabPriced(sale(36, 0.6), 2200) && !P.photoSlabPriced(sale(32, 0.6), 2200));
  check('  ...not under $10, however the ratio reads', !P.photoSlabPriced(sale(9, 0.7), 300));
  check('  ...not under a 0.5 photo', !P.photoSlabPriced(sale(100, 0.49), 2000));
  check('  ...not with nothing to compare against', !P.photoSlabPriced(sale(100, 0.7), 0));

  const ids = (rows) => rows.map(r => r.price_cents / 100).join(',');
  const four = [sale(20), sale(22), sale(25), sale(40, 0.65)];
  check('photoPricedSlabs: the leaning photo at 1.8x the other three is held out', ids(P.photoPricedSlabs(four)) === '40');
  check('  ...a cheap sale with a leaning photo is not', ids(P.photoPricedSlabs([sale(20, 0.7), sale(22), sale(25)])) === '');
  check('  ...and two sales are too few to say', ids(P.photoPricedSlabs([sale(20), sale(40, 0.7)])) === '');
  check('  ...and with no scores at all nothing changes', ids(P.photoPricedSlabs([sale(20), sale(22), sale(80)])) === '');

  // The site's raw guard. Without the photo, $40 against $20-25 is under its
  // 4x line and stays in the raw price; with it, the slab comes out.
  const kept = (rows) => ids(S._holdOutRawOutliers(rows));
  check('the raw guard holds out a photo-and-price slab it could not catch on price',
    kept([sale(20), sale(22), sale(25), sale(40)]) === '20,22,25,40' && kept(four) === '20,22,25');

  const byGrade = new Map([['Raw', [sale(20), sale(22), sale(25), sale(40, 0.65)]]]);
  const n = S._flagSlabPricedRaw(byGrade);
  check('the card page shows it under the photo\'s own label, and counts it',
    n === 1 && ids(byGrade.get('Raw')) === '20,22,25' && ids(byGrade.get(P.PHOTO_SLAB_LABEL)) === '40');
}

// ---- reading the scores ------------------------------------------------
(async () => {
  const sqlite = new DatabaseSync(':memory:');
  // The shape of a D1 binding, over node:sqlite.
  let queries = 0;
  const d1 = {
    prepare(sql) {
      return { bind: (...b) => ({ all: async () => { queries++; return { results: sqlite.prepare(sql).all(...b), meta: { rows_read: 1 } }; } }) };
    },
  };
  const rows = () => [
    { item_id: '1001', title: SANDERS, price_cents: 3500 },
    { item_id: '1002', title: '1989 Score Barry Sanders #257 PSA 7', price_cents: 3800 },
    { item_id: '1005', title: SANDERS, price_cents: 4200, grader: 'PSA', grade: 7 },
    { item_id: '1003', title: SANDERS, price_cents: 500 },
    { item_id: '1004', title: SANDERS, price_cents: 1900 },
  ];

  const before = rows();
  await S._attachSlabScores(d1, before);
  check('no table yet: the rows are read exactly as before', before.every(r => r.slab_score === undefined));

  sqlite.exec(`CREATE TABLE ${P.PHOTO_SLAB_TABLE} (item_id TEXT PRIMARY KEY, score REAL, model TEXT NOT NULL, why TEXT, scored_at TEXT NOT NULL)`);
  const ins = sqlite.prepare(`INSERT INTO ${P.PHOTO_SLAB_TABLE} VALUES (?, ?, 'm', ?, 'now')`);
  ins.run('1001', 0.93, null); ins.run('1002', 0.97, null); ins.run('1003', 0.99, null); ins.run('1004', null, 'http-404');
  ins.run('1005', 0.99, null);
  queries = 0;
  const got = await S._attachSlabScores(d1, rows());
  check('one query for every row', queries === 1, `${queries} queries`);
  check('a raw-reading sale gets its score', got[0].slab_score === 0.93);
  check('  ...a sale its title grades keeps the title\'s grade, whatever the photo',
    gradeBucket(got[1]) === 'PSA 7');
  check('  ...a sale graded in its columns is not asked about', got[2].slab_score === undefined);
  check('  ...nor one under $10, which is never scored', got[3].slab_score === undefined);
  check('  ...and a photo that could not be read stays unscored', got[4].slab_score === undefined);

  const shown = got.map(S._mapNflDbSale);
  check('the sold list marks it for the browser, and stops calling it Ungraded',
    shown[0].photoGraded === true && shown[0].condition === 'Graded' && !shown[4].photoGraded && shown[4].condition === 'Ungraded'
    && !shown[1].photoGraded);

  // ---- the browser ----------------------------------------------------
  const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  check('the browser groups a photo slab with the slabs it cannot name',
    /function itemGrade\(item\)[\s\S]{0,200}item\.photoGraded \? 'Graded \(other\)'/.test(app));
  check('  ...in the grade groups, the raw price, the grade filter and the grade sort',
    /const grade = itemGrade\(item\)/.test(app) && /const isRaw = \(r\) => itemGrade\(r\) === 'Raw \/ Ungraded'/.test(app)
    && /results\.filter\(r => itemGrade\(r\) === currentGradeFilter\)/.test(app) && /gradeSortRank\(a\) - gradeSortRank\(b\)/.test(app));

  // ---- the job --------------------------------------------------------
  const wf = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'score-slab-photos.yml'), 'utf8');
  const runLines = wf.split('\n').filter(l => /^\s*run:/.test(l)).join('\n');
  check('the scoring job never pastes an input into a command line', !/github\.event/.test(runLines));
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  check('the image model stays out of package.json (and so out of the Worker)',
    !JSON.stringify(pkg).includes('@huggingface') && /npm install --no-save @huggingface\/transformers/.test(wf));
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  check('the Worker reads scores, never the head', !/slab-head/.test(server));

  if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
  console.log('\nall photo slab checks passed');
})();
