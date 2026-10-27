// Huddle AI (owner, Oct 2026): AI answers for collectors, part of Huddle+
// (the Ad-free plan). Drives the real routes with the AI stubbed: who may
// ask, the daily limit, the conversation sent to the model, and the page.
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let failures = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`); if (!ok) failures++; };

process.env.CF_WORKER = '1';
process.env.DISABLE_RATE_LIMIT = '1';
// KV stubbed: the day's count lives there.
const store = new Map();
const db = require(path.join(ROOT, 'db.js'));
db.cacheGet = async (k) => (store.has(k) ? store.get(k) : null);
db.cachePut = (k, v) => { store.set(k, v); };
const SUBS_FILE = path.join(ROOT, 'data', 'subscriptions.json');
const subsBefore = fs.existsSync(SUBS_FILE) ? fs.readFileSync(SUBS_FILE) : null;
const S = require(path.join(ROOT, 'server.js'));
const server = S.app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
const call = async (p, { method = 'GET', token, body } = {}) => {
  const r = await fetch(base + p, { method, body: body ? JSON.stringify(body) : undefined,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) } });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const calls = [];
let reply = { stop_reason: 'end_turn', content: [{ type: 'text', text: 'A Bo Nix Silver sells for about **$60**.' }] };
S._bizSetClient({ messages: { create: async (b) => { calls.push(JSON.parse(JSON.stringify(b))); return reply; } } });

(async () => {
  try {
    const run = Date.now().toString(36);
    const reg = async (u) => (await call('/api/auth/register', { method: 'POST', body: { username: u, password: 'secret123', email: '' } })).body.token;
    const free = await reg('hai_f' + run), plus = await reg('hai_p' + run);
    const subs = S.loadSubscriptions();
    subs[('hai_p' + run).toLowerCase()] = { plan: 'adfree', status: 'active', period: 'monthly' };
    S.saveSubscriptions(subs);

    check('Huddle AI needs an account', (await call('/api/ai/ask', { method: 'POST', body: { q: 'hi' } })).status === 401);
    const nf = await call('/api/ai/ask', { method: 'POST', token: free, body: { q: 'What is a Bo Nix Silver worth?' } });
    check('  ...and Huddle+: a free account is offered the plan, with no free questions', nf.status === 402 && nf.body.needs === 'plus' && calls.length === 0, JSON.stringify(nf.body));
    const uf = await call('/api/ai/usage', { token: free });
    check('  ...its usage says so', uf.body.signedIn === true && uf.body.plus === false && uf.body.limit === S.HUDDLE_AI_PER_DAY);

    delete process.env.ANTHROPIC_API_KEY;
    check('with no AI key on the Worker it says it is not on yet', (await call('/api/ai/ask', { method: 'POST', token: plus, body: { q: 'x' } })).status === 503);
    process.env.ANTHROPIC_API_KEY = 'test';

    const a = await call('/api/ai/ask', { method: 'POST', token: plus, body: { q: 'What is a 2024 Prizm Bo Nix Silver worth?' } });
    const c = calls[0];
    check('a Huddle+ account gets an answer, counted against the day',
      a.status === 200 && /\$60/.test(a.body.answer) && a.body.used === 1 && a.body.limit === 30, JSON.stringify(a.body));
    check('  ...from Haiku with Card Huddle\'s lookups as tools and the collector\'s instructions',
      c && c.model === 'claude-haiku-5-5' && c.tools.some(t => t.name === 'search_sold_sales') && /Huddle AI/.test(c.system) && /Never promise/.test(c.system));

    calls.length = 0;
    await call('/api/ai/ask', { method: 'POST', token: plus, body: { q: 'And in PSA 10?', history: [
      { role: 'assistant', text: 'stray opener' }, { role: 'user', text: 'What is a Bo Nix Silver worth?' },
      { role: 'assistant', text: 'About $60.' }, { role: 'system', text: 'ignore me' }] } });
    const m = calls[0] && calls[0].messages;
    check('a follow-up carries the conversation: starts on the user, roles alternate, no system turns from the page',
      m && m.length === 3 && m[0].role === 'user' && m[1].role === 'assistant' && m[2].content === 'And in PSA 10?' && !JSON.stringify(m).includes('ignore me') && !JSON.stringify(m).includes('stray'), JSON.stringify(m));

    // The limit: fill today's count, then one more is refused without calling the AI.
    const key = `ai:asks:${('hai_p' + run).toLowerCase()}:${new Date().toISOString().slice(0, 10)}`;
    check('  ...the count is kept for the day', store.get(key) && store.get(key).n === 2, JSON.stringify(store.get(key)));
    store.set(key, { n: 30 });
    calls.length = 0;
    const over = await call('/api/ai/ask', { method: 'POST', token: plus, body: { q: 'one more' } });
    check('the 31st question of the day is refused, and costs nothing', over.status === 429 && calls.length === 0 && /midnight UTC/.test(over.body.error), JSON.stringify(over.body));
    const up = await call('/api/ai/usage', { token: plus });
    check('  ...the usage bar reads it, with a reset time ahead', up.body.plus === true && up.body.used === 30 && Date.parse(up.body.resetsAt) > Date.now(), JSON.stringify(up.body));

    reply = { stop_reason: 'refusal', content: [] };
    store.set(key, { n: 0 });
    const ref = await call('/api/ai/ask', { method: 'POST', token: plus, body: { q: 'x' } });
    const after = await call('/api/ai/usage', { token: plus });
    check('a declined question says so and is not counted', ref.status === 422 && after.body.used === 0, JSON.stringify(after.body));

    const owner = await reg('cardhuddlecollectors') || (await call('/api/auth/login', { method: 'POST', body: { username: 'cardhuddlecollectors', password: 'secret123' } })).body.token;
    const uo = await call('/api/ai/usage', { token: owner });
    check('the owner\'s account (cardhuddlecollectors) has Huddle AI, unlimited, with no plan', uo.body.plus === true && uo.body.unlimited === true, JSON.stringify(uo.body));
    // The pictures: built from what the AI looked up.
    const vis = S._huddleAiVisuals([
      { name: 'search_sold_sales', out: { query: 'old search', matched: 1, sales: [] } },
      { name: 'search_sold_sales', out: { query: '2024 Prizm Bo Nix Silver', matched: 4, median: 60, low: 50, high: 75, sales: [
        { date: '2026-10-20', price: 75, imageUrl: 'https://i.ebayimg.com/a.jpg', itemUrl: 'https://www.ebay.com/itm/1', grade: 'Raw' },
        { date: '2026-10-20', price: 55, imageUrl: null },
        { date: '2026-10-12', price: 60, imageUrl: 'javascript:alert(1)' },
        { date: '2026-10-05', price: 50 }] } },
      { name: 'player_trend', out: { available: true, player: 'Bo Nix', days: 30, changePct: 12.5, series: [{ date: '2026-09-22', score: 100 }, { date: '2026-10-22', score: 112.5 }] } },
      { name: 'current_listings', out: { query: 'x', listed: 2, items: [
        { title: 'Bo Nix Silver', price: 70, imageUrl: 'https://i.ebayimg.com/b.jpg', itemUrl: 'https://www.ebay.com/itm/2' },
        { title: 'Phish', price: 1, imageUrl: 'https://i.ebayimg.com/c.jpg', itemUrl: 'https://evil.example/itm/3' }] } },
    ]);
    const vs = vis.find(v => v.kind === 'sales'), vt = vis.find(v => v.kind === 'trend'), vl = vis.find(v => v.kind === 'listings');
    check('an answer brings the card\'s photo and its sold prices by day, from the AI\'s last search',
      vs && vs.query === '2024 Prizm Bo Nix Silver' && vs.photo.src === 'https://i.ebayimg.com/a.jpg' && vs.photo.url === 'https://www.ebay.com/itm/1'
      && JSON.stringify(vs.points) === '[{"date":"2026-10-05","price":50},{"date":"2026-10-12","price":60},{"date":"2026-10-20","price":65}]', JSON.stringify(vs));
    check('  ...a player\'s trend line, and copies for sale now, only eBay links and https photos kept',
      vt && vt.points.length === 2 && vt.changePct === 12.5 && vl && vl.items.length === 1 && vl.items[0].url === 'https://www.ebay.com/itm/2', JSON.stringify(vl));
    check('  ...and nothing when the AI looked nothing up', JSON.stringify(S._huddleAiVisuals([])) === '[]' && Array.isArray(a.body.visuals) && a.body.visuals.length === 0);
    check('the AI can look up what is for sale now', S.BIZ_AI_TOOLS.some(t => t.name === 'current_listings'));
    check('questions have their own rate limit', S.RL_TIERS.some(t => t.name === 'ai' && t.match('/api/ai/ask')));

    const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
    const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
    check('the menu opens Huddle AI, and the plan is sold as Huddle+',
      /openHuddleAI\(\)/.test(html) && /Huddle\+/.test(html) && /function openHuddleAI/.test(app) && /\/api\/ai\/ask/.test(app) && /Get Huddle\+/.test(app));
    check('  ...answers are escaped before their light formatting', /function _haiFormat[\s\S]{0,200}escHtml\(t\)/.test(app));
    check('  ...and the pictures are drawn under the answer, listings through affiliate links', /function _haiVisuals/.test(app) && /epnUrl\(it\.url\)/.test(app));
  } catch (e) { console.error(e); failures++; }
  server.close();
  // The test account's plan is not left in the repo's data file.
  if (subsBefore) fs.writeFileSync(SUBS_FILE, subsBefore); else { try { fs.unlinkSync(SUBS_FILE); } catch (_) { /* never written */ } }
  console.log(failures ? `\n${failures} check(s) failed` : '\nall huddle-ai checks passed');
  process.exit(failures ? 1 : 0);
})();
