// The home page's stats strip never waits on a cold cache.
//
// The strip vanished for visitors whose request landed while the boards were
// being rebuilt — after every deploy that changed the cache key, a 7-45s build
// on the live table, and the page hid the strip on the first failure. Now the
// last good boards are served at once and the new ones built behind them; the
// cron fills a missing period within the quarter hour; and Players on the
// move borrows the longest period the market has history for.
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const db = new DatabaseSync(':memory:');
db.exec(`CREATE TABLE sales (item_id TEXT, sold_date TEXT, title TEXT, price_cents INTEGER, currency TEXT,
  listing_format TEXT, grader TEXT, grade TEXT, player TEXT, parallel TEXT, year TEXT, set_name TEXT,
  card_number TEXT, confidence REAL, best_offer INTEGER, bids INTEGER, image_url TEXT)`);
db.exec(`CREATE TABLE daily (sold_date TEXT, sales INTEGER, priced INTEGER, total_cents INTEGER)`);
const DAY = 86400000;
const iso = (o) => new Date(Date.now() + o * DAY).toISOString().slice(0, 10);
const ins = db.prepare(`INSERT INTO sales (item_id, sold_date, title, price_cents, player, year, set_name, parallel,
  card_number, grader, grade, confidence, best_offer) VALUES (?,?,?,?,?,'2023','Prizm','',?,'','',0.9,0)`);
let n = 0;
// Thirty-five days of history: enough for a 30-day market, not a 90-day one.
// A seller who writes the team (or their shop) into the player field.
for (const [player, perDay] of [['Steady Climber', 0.01], ['Slow Fader', -0.005], ['Earl Campbell / Houston Oilers', 0.012]]) {
  for (let c = 1; c <= 4; c++) {
    for (let d = -35; d <= -1; d++) {
      ins.run(`s${n++}`, iso(d), `2023 Prizm ${player} #${c}`, Math.round(4000 * Math.pow(1 + perDay, d + 35)), player, String(c));
    }
  }
}
// A minority spelling of a player, which sorts last alphabetically: the
// label must be the spelling most of their sales use, not MAX().
for (let d = -30; d <= -2; d += 7) ins.run(`m${n++}`, iso(d), '2023 Prizm Steady Climber #1', 4000, 'steady CLIMBER.', '1');
db.exec(`INSERT INTO daily SELECT sold_date, COUNT(*), COUNT(price_cents), SUM(price_cents) FROM sales GROUP BY sold_date`);

let d1Queries = 0;
const d1 = { prepare(sql) {
  let b = [];
  const api = { bind(...a) { b = a; return api; },
    async all() { d1Queries++; return { results: db.prepare(sql).all(...b) }; },
    async first() { d1Queries++; return db.prepare(sql).get(...b) || null; },
    async run() { d1Queries++; return { success: true, meta: db.prepare(sql).run(...b) }; } };
  return api;
} };
const store = new Map();
const dbMod = require(path.join(__dirname, '..', 'db.js'));
dbMod.getNflDb = () => d1;
dbMod.cacheGet = async (k) => (store.has(k) ? JSON.parse(store.get(k)) : null);
dbMod.cachePut = async (k, v) => { store.set(k, JSON.stringify(v)); };
process.env.CF_WORKER = '1';
const { app, warmSoldStats } = require(path.join(__dirname, '..', 'server.js'));
const PORT = 3253;
const server = app.listen(PORT);
const call = async (url) => (await fetch(`http://127.0.0.1:${PORT}${url}`)).json();

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};
const currentKey = (days) => [...store.keys()].find(k => new RegExp(`^soldstats:v\\d+:${days}$`).test(k) && k !== `soldstats:v9:${days}`);
const waitFor = async (fn, ms = 20000) => { const t = Date.now(); while (!fn() && Date.now() - t < ms) await new Promise(r => setTimeout(r, 50)); return fn(); };

(async () => {
  // ---- a cold key with last-good boards: served at once, rebuilt behind ----
  store.set('soldstats:last:30', JSON.stringify({ available: true, days: 30, marker: 'yesterday', generatedAt: new Date().toISOString() }));
  const t0 = Date.now();
  const r = await call('/api/sold-stats?days=30');
  check('a cold key serves the last good boards at once', r.available === true && r.marker === 'yesterday' && r.refreshing === true,
    `${Date.now() - t0}ms, marker=${r.marker}`);
  await waitFor(() => currentKey(30));
  const built = currentKey(30) && JSON.parse(store.get(currentKey(30)));
  check('  ...and the current boards are built behind the visitor', !!built && built.available === true && !built.marker,
    currentKey(30) || 'not built');
  check('  ...and become the new last good copy', !JSON.parse(store.get('soldstats:last:30')).marker);
  const r2 = await call('/api/sold-stats?days=30');
  check('the next visitor gets the new boards', r2.available === true && !r2.marker && !r2.refreshing);

  // ---- a key change: the previous version's boards stand in ----
  store.delete('soldstats:last:30'); store.delete(currentKey(30));
  store.set('soldstats:v9:30', JSON.stringify({ available: true, days: 30, marker: 'previous version', generatedAt: new Date().toISOString() }));
  const rp = await call('/api/sold-stats?days=30');
  check('after a key change, the previous version is served while the new one builds', rp.marker === 'previous version' && rp.refreshing === true);
  await waitFor(() => currentKey(30) && store.has('soldstats:last:30'));
  store.delete('soldstats:v9:30');

  // ---- nothing at all: built inline, both copies stored ----
  const r7 = await call('/api/sold-stats?days=7');
  check('with no copy at all, the first request builds the boards', r7.available === true && !!currentKey(7) && store.has('soldstats:last:7'));

  // ---- the cron fills gaps only ----
  store.delete('soldstats:last:30');
  const before = d1Queries;
  const w = await warmSoldStats({ onlyMissing: true });
  const built90 = w.periods.find(p => p.startsWith('90d'));
  check('the gap warm builds only missing periods', w.periods.includes('30d:cached') && w.periods.includes('7d:cached')
    && !/cached/.test(built90), w.periods.join(' '));
  check('  ...and seeds a last good copy from boards built before it existed', store.has('soldstats:last:30'));
  const qBefore = d1Queries;
  await warmSoldStats({ onlyMissing: true });
  check('  ...and reads no D1 when nothing is missing', d1Queries === qBefore, `${d1Queries - qBefore} queries`);
  void before;

  // ---- Players on the move borrows the longest period the market has ----
  const s90 = await call('/api/sold-stats?days=90');
  const b = s90.playerMovesBasis;
  check('a period the market lacks history for uses the longest one it has', !!b && b.days === 30
    && (s90.playerMovers || []).some(p => p.player === 'Steady Climber'),
    JSON.stringify(b && { days: b.days, considered: b.playersConsidered }));
  const s30 = await call('/api/sold-stats?days=30');
  check('  ...while a period it has uses its own', s30.playerMovesBasis && s30.playerMovesBasis.days === 30);

  // ---- names as the boards show them ----
  const pNames = (s30.playerMovers || []).map(p => p.player);
  check('a player is named by the spelling most of their sales use', pNames.includes('Steady Climber') && !pNames.some(x => /CLIMBER/.test(x)),
    pNames.join(' | '));
  check('  ...without what a seller wrote after " / "', pNames.includes('Earl Campbell') && !pNames.some(x => / \/ /.test(x)),
    pNames.join(' | '));
  const cNames = (s30.cardMovers || []).map(c => c.name);
  check('card names drop it too', cNames.some(x => /Earl Campbell #/.test(x)) && !cNames.some(x => /Oilers/.test(x)),
    cNames.filter(x => /Campbell/.test(x)).join(' | ') || cNames.slice(0, 3).join(' | '));
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
  check('board names wrap inside their column on iPhones (button text does not wrap in Safari)',
    /\.st-name \{[^}]*white-space: normal/.test(css) && /\.mp-row-name \{[^}]*white-space: normal/.test(css));

  // ---- the page retries rather than hiding on the first failure ----
  const app_js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  check('the strip retries a failed load before hiding',
    /MP_RETRY_MS\s*=\s*\[/.test(app_js) && /setTimeout\(\(\) => loadMarketPulse\(period, attempt \+ 1\)/.test(app_js));
  const worker = fs.readFileSync(path.join(__dirname, '..', 'worker.js'), 'utf8');
  check('the cron runs the gap warm every tick', /warmSoldStats\(\{ onlyMissing: true \}\)/.test(worker));

  server.close();
  console.log(failures ? `\n${failures} check(s) failed` : '\nall sold-stats-cold checks passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); server.close(); process.exit(1); });
