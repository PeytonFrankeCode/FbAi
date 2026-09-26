// The sales data, looked after: a collection alarm, sales reaching the right
// player page, and checklists drafted from sales for products we hold none for.
const fs = require('fs');
const path = require('path');
process.env.CF_WORKER = '1';
const { _collectionReport, _observedChecklist } = require(path.join(__dirname, '..', 'server.js'));
const { buildIndex, playerKeys, matchPlayer } = require(path.join(__dirname, '..', 'set-key.js'));
const { buildDraft } = require(path.join(__dirname, '..', 'scripts', 'draft-checklist.js'));

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};
const DAY = 86400000;
const iso = (base, off) => new Date(Date.parse(base) + off * DAY).toISOString().slice(0, 10);

// ---- Collection health ----
const TODAY = '2026-09-26';
// 30 days of ~11,000 sales, newest two days still filling, columns steady.
const day = (d, n, fill = {}) => ({ d, n, player: Math.round(n * (fill.player ?? 0.97)), year: Math.round(n * 0.96),
  set_name: Math.round(n * 0.94), card_number: Math.round(n * (fill.card_number ?? 0.78)), parallel: Math.round(n * 0.5) });
const healthy = [];
for (let o = -32; o <= -2; o++) healthy.push(day(iso(TODAY, o), o >= -3 ? 4000 : 11000 + (o % 5) * 200));
const ok = _collectionReport(healthy, TODAY);
check('a healthy month raises nothing', ok.status === 'ok' && ok.issues.length === 0, JSON.stringify(ok.issues));
check('  ...and the newest days, still filling, are not called a dip', ok.days.slice(-2).every(d => !d.settled));

const stalled = _collectionReport(healthy.slice(0, -6), TODAY);
check('a collector that stopped is reported as stalled', stalled.issues.some(i => /^stalled:/.test(i.id)),
  stalled.issues.map(i => i.text).join(' | '));

const gap = healthy.filter(r => r.d !== iso(TODAY, -12));
const g = _collectionReport(gap, TODAY);
check('a missing day is reported, with the date eBay stops showing it',
  g.issues.some(i => i.id === `missing:${iso(TODAY, -12)}` && i.text.includes(iso(TODAY, -12 + 90))),
  g.issues.map(i => i.text).join(' | '));

const dip = healthy.map(r => (r.d === iso(TODAY, -6) ? day(r.d, 3000) : r));
check('a settled day under half its norm is reported', _collectionReport(dip, TODAY).issues.some(i => i.id === `dip:${iso(TODAY, -6)}`));

const drift = healthy.map(r => (r.d >= iso(TODAY, -10) ? day(r.d, r.n, { card_number: 0.4 }) : r));
const dr = _collectionReport(drift, TODAY);
check('a parser that stopped reading a column is reported', dr.issues.some(i => i.id === 'drift:card_number'),
  JSON.stringify(dr.fill.card_number));
check('  ...and the others are not', !dr.issues.some(i => i.id === 'drift:player'));

// ---- Sales reaching the right player page ----
const pages = [
  { name: 'Amon-Ra St. Brown', slug: 'amon-ra-st-brown' }, { name: 'Jerry Rice', slug: 'jerry-rice' },
  { name: 'Earl Campbell', slug: 'earl-campbell' }, { name: 'Patrick Mahomes II', slug: 'patrick-mahomes-ii' },
  { name: 'Marvin Harrison', slug: 'marvin-harrison' }, { name: 'Marvin Harrison Jr.', slug: 'marvin-harrison-jr' },
  { name: 'Josh Allen', slug: 'josh-allen' }, { name: 'Josh Allen Jr.', slug: 'josh-allen-jr' },
];
const { index } = buildIndex(pages, playerKeys);
const at = (n) => (matchPlayer(index, n) || {}).slug || null;
check('a name cut short at "St." still reaches its page', at('amonra st') === 'amon-ra-st-brown');
check('a stuffed player field reaches the player', at('Jerry Rice / Set Break / Vg-Vgex Gmcards') === 'jerry-rice'
  && at('Earl Campbell / Houston Oilers') === 'earl-campbell');
check('  ...and the usual names still match', at('Patrick Mahomes') === 'patrick-mahomes-ii' && at('Jerry Rice') === 'jerry-rice');
check('two people sharing a name are never guessed between', at('marvin harrison') === null);
check('a cut-short name two pages could complete is not guessed', at('josh allen j') === null);
check('a single word is never completed', at('matthew') === null && at('amonra') === null);

// ---- Checklists drafted from sales ----
const rows = [
  { card_number: '161', player: 'Jerry Rice', n: 40 }, { card_number: '161', player: 'JERRY RICE', n: 5 },
  { card_number: '161', player: 'Joe Montana', n: 1 },
  { card_number: '255', player: 'Dan Marino / Set Break', n: 9 },
  { card_number: '9', player: 'Walter Payton', n: 2 },                                // too few
  { card_number: '12', player: 'Player A', n: 3 }, { card_number: '12', player: 'Player B', n: 3 }, // split
];
const obs = _observedChecklist(rows);
const byNo = Object.fromEntries(obs.map(c => [c.number, c]));
check('a number whose sales agree is confident, named by the usual spelling',
  byNo['161'].confident && byNo['161'].player === 'Jerry Rice' && byNo['161'].sales === 46, JSON.stringify(byNo['161']));
check('  ...without what a seller wrote after " / "', byNo['255'].player === 'Dan Marino' && byNo['255'].confident);
check('too few sales, or sales that disagree, are left for review', !byNo['9'].confident && !byNo['12'].confident);
check('numbers are in checklist order', obs.map(c => c.number).join(',') === '9,12,161,255');
const draft = buildDraft({ set: 'topps', cards: obs, parallelsSeen: [{ name: 'Tiffany', sales: 4 }] },
  { year: '1986', name: '1986 Topps Football', brand: 'Topps' });
check('the draft is a checklist document marked as a draft',
  draft.id === '1986-topps-football' && draft.draft === true && draft.sets[0].cards.length === 2
  && draft.review.uncertain.length === 2 && /not from the manufacturer/.test(draft.source));

// ---- Wiring ----
const worker = fs.readFileSync(path.join(__dirname, '..', 'worker.js'), 'utf8');
check('the cron runs the collection check', /checkCollectionHealth\(\)/.test(worker)
  && (worker.match(/checkCollectionHealth/g) || []).length >= 4);
const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
check('the checklist tally is admin only',
  /app\.get\('\/api\/debug\/observed-checklist', async \(req, res\) => \{\s*if \(!isAdminReq\(req\)\)/.test(srv));

console.log(failures ? `\n${failures} check(s) failed` : '\nall data-quality checks passed');
process.exit(failures ? 1 : 0);
