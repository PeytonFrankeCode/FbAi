// Capping what one caller can spend.
//
// WHY THIS EXISTS. Every `rateLimited` path in server.js pointed outward —
// eBay telling us we had asked too often. Nothing capped what a single caller
// could ask of us, so /api/search (eBay quota per call) and /api/scan-card
// (an eBay image search per photo) could be run up at whatever rate a script
// managed. The client even carried a 402 `limitReached` branch for a
// server-side cap that no longer existed.
//
// The two ways a limiter like this silently becomes decorative: it stops
// refusing anything, or it starts refusing real people. Both are checked
// here, along with the failure mode that matters most — that a limiter must
// never be the thing that takes the site down.
const path = require('path');
const ROOT = path.join(__dirname, '..');

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

// KV stubbed before the require: server.js destructures these off db.js at load.
const KV = new Map();
const dbMod = require(path.join(ROOT, 'db.js'));
dbMod.cacheGet = async (k) => (KV.has(k) ? KV.get(k) : null);
dbMod.cachePut = (k, v) => { KV.set(k, v); };
process.env.ADMIN_PASSWORD = 'test-key-for-rate-limit';

const { app, rateLimitCheck, RL_TIERS } = require(path.join(ROOT, 'server.js'));

const req = (p, ip, headers = {}) => ({
  path: p,
  ip,
  headers: { 'cf-connecting-ip': ip, ...headers },
});

// Drive a path n times from one address and report how many were refused.
const burst = (p, ip, n, now = Date.now()) => {
  let refused = 0, first = null;
  for (let i = 0; i < n; i++) {
    const hit = rateLimitCheck(req(p, ip), now);
    if (hit) { refused++; if (!first) first = { at: i + 1, ...hit }; }
  }
  return { refused, first };
};

const tier = (name) => RL_TIERS.find(t => t.name === name);

// ---- It refuses at the budget, not before ----
{
  const t = tier('search');
  const r = burst('/api/search', '1.1.1.1', t.minute);
  check('a caller inside the search budget is never refused',
    r.refused === 0, `${t.minute} calls, ${r.refused} refused`);

  const over = rateLimitCheck(req('/api/search', '1.1.1.1'));
  check('  ...and the very next call is',
    !!over && over.scope === 'minute',
    over ? `refused at ${t.minute + 1}, retry in ${over.retryAfter}s` : 'not refused');
  check('  ...with a Retry-After a client can act on',
    !!over && over.retryAfter >= 1 && over.retryAfter <= 60, over && over.retryAfter + 's');
}

// ---- Budgets are per address ----
{
  const t = tier('search');
  burst('/api/search', '2.2.2.2', t.minute + 20);
  const other = rateLimitCheck(req('/api/search', '3.3.3.3'));
  check('one caller burning its budget does not refuse anybody else',
    other === null, 'a fresh address still passes');
}

// ---- The expensive endpoint is held tighter than the cheap one ----
{
  check('the scan budget is tighter than the search budget',
    tier('scan').minute < tier('search').minute,
    `scan ${tier('scan').minute}/min vs search ${tier('search').minute}/min`);
  check('  ...because each scan spends an eBay image search',
    tier('scan').hour < tier('search').hour,
    `scan ${tier('scan').hour}/hr vs search ${tier('search').hour}/hr`);

  const t = tier('scan');
  const r = burst('/api/scan-card', '4.4.4.4', t.minute + 1);
  check('  ...and scan refuses at its own budget, not the general one',
    r.first && r.first.tier === 'scan' && r.first.at === t.minute + 1,
    r.first ? `refused at ${r.first.at}` : 'never refused');
}

// ---- The hour window catches a caller pacing under the minute ----
{
  const t = tier('search');
  const ip = '5.5.5.5';
  let now = Date.now();
  let refused = null;
  // Spend the minute budget, jump a minute, repeat. Every burst is legal
  // minute-by-minute; only the hour budget can see the pattern.
  for (let m = 0; m < 20 && !refused; m++) {
    for (let i = 0; i < t.minute; i++) {
      const hit = rateLimitCheck(req('/api/search', ip), now);
      if (hit) { refused = { ...hit, minute: m }; break; }
    }
    now += 61000;
  }
  check('a caller pacing just under the minute is still caught by the hour',
    !!refused && refused.scope === 'hour',
    refused ? `refused in minute ${refused.minute} on the ${refused.scope} budget` : 'never refused');
}

// ---- Windows actually roll ----
{
  const t = tier('search');
  const ip = '6.6.6.6';
  const now = Date.now();
  burst('/api/search', ip, t.minute + 5, now);
  const afterWindow = rateLimitCheck(req('/api/search', ip), now + 61000);
  check('the budget comes back once the minute is over',
    afterWindow === null, 'same address passes again a minute later');
}

// ---- Scope: only /api, and only the priced parts of it ----
{
  check('page loads are never rate limited',
    rateLimitCheck(req('/players/caleb-williams', '7.7.7.7')) === null,
    'SEO pages must stay reachable — a challenged crawler is a deindexed page');
  check('static assets are never rate limited',
    rateLimitCheck(req('/app.js', '7.7.7.7')) === null);
}

// ---- Admin tooling is not the threat ----
{
  const t = tier('search');
  burst('/api/search', '8.8.8.8', t.minute + 5);
  check('an over-budget address is refused without the admin key',
    rateLimitCheck(req('/api/search', '8.8.8.8')) !== null);
}

// ---- It must never be the outage ----
{
  // A caller with no resolvable address still has to be served. The limiter
  // buckets them together rather than throwing.
  let threw = null;
  try { rateLimitCheck({ path: '/api/search', headers: {} }); }
  catch (err) { threw = err.message; }
  check('a request with no address does not throw', threw === null, threw || 'handled');

  let threw2 = null;
  try { rateLimitCheck({ headers: {} }); }
  catch (err) { threw2 = err.message; }
  check('  ...nor does one with no path at all', threw2 === null, threw2 || 'handled');
}

// ---- End to end, over a real socket ----
(async () => {
  const server = app.listen(3231);
  const base = 'http://127.0.0.1:3231';
  const t = tier('search');
  try {
    // A fresh address so the checks above do not spend this budget.
    const ip = '9.9.9.9';
    let status = 0, body = null, retryAfter = null;
    for (let i = 0; i < t.minute + 2; i++) {
      const r = await fetch(`${base}/api/search?q=test`, { headers: { 'cf-connecting-ip': ip } });
      if (r.status === 429) {
        status = 429;
        retryAfter = r.headers.get('retry-after');
        body = await r.json();
        break;
      }
    }
    check('an over-budget caller gets a real 429 over HTTP', status === 429,
      status ? `status ${status}` : 'never refused');
    check('  ...with a Retry-After header', !!retryAfter, 'Retry-After: ' + retryAfter);
    check('  ...and the rateLimited shape the client already understands',
      !!body && body.rateLimited === true && typeof body.rateLimitMessage === 'string',
      body ? JSON.stringify(body).slice(0, 90) : 'no body');

    const pageRes = await fetch(`${base}/api/debug/traffic?key=${encodeURIComponent(process.env.ADMIN_PASSWORD)}`,
      { headers: { 'cf-connecting-ip': ip } });
    const traffic = await pageRes.json();
    check('the refusals are counted where the traffic report can see them',
      traffic.available && traffic.sinceLastFlush && traffic.sinceLastFlush.limited > 0,
      traffic.sinceLastFlush ? `limited=${traffic.sinceLastFlush.limited} by ${JSON.stringify(traffic.sinceLastFlush.limitedBy)}` : 'no counter');
    check('  ...and the report states the budgets in force',
      Array.isArray(traffic.rateLimits) && traffic.rateLimits.some(r => r.tier === 'search'),
      JSON.stringify(traffic.rateLimits));
    check('  ...while the admin key itself was never rate limited',
      pageRes.status === 200, 'status ' + pageRes.status);
  } catch (err) {
    check('end-to-end checks ran', false, err && err.message);
  } finally {
    server.close();
  }

  console.log(failures ? `\n${failures} check(s) failed` : '\nall rate-limit checks passed');
  process.exit(failures ? 1 : 0);
})();
