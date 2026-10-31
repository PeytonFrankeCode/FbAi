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
const app0 = () => fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const calls = [];
let reply = { stop_reason: 'end_turn', usage: { input_tokens: 20000, output_tokens: 2000 }, content: [{ type: 'text', text: 'A Bo Nix Silver sells for about **$60**.' }] };
S._bizSetClient({ messages: { create: async (b) => { calls.push(JSON.parse(JSON.stringify(b))); return typeof reply === 'function' ? reply(b) : reply; } } });

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
    check('  ...its usage says so, with the plans it could choose', uf.body.signedIn === true && uf.body.plus === false && uf.body.plans.length === 4 && uf.body.plans[1].answers > 0);

    const mf = await call('/api/auth/me', { token: free });
    check('  ...and the account endpoint agrees, so the page offers the plan instead of "You\'re on Huddle+"',
      mf.body.huddlePlus === false && mf.body.owner === false, JSON.stringify(mf.body));
    const mp = await call('/api/auth/me', { token: plus });
    check('  ...while a paying account reads as on', mp.body.huddlePlus === true && mp.body.owner === false);
    const own = await reg('hai_o' + run);
    await call('/api/auth/email', { method: 'PUT', token: own, body: { email: 'CardHuddleOffical@gmail.com' } });
    const mo = await call('/api/auth/me', { token: own });
    const uow = await call('/api/ai/usage', { token: own });
    check('the owner\'s address unlocks Huddle AI on any account name, as the page already assumes',
      mo.body.owner === true && mo.body.huddlePlus === true && uow.body.plus === true && uow.body.unlimited === true, JSON.stringify(mo.body));
    const src = app0();
    check('the page drops a device\'s owner mark when the server says this account has no plan',
      /typeof d\.adFree === 'boolean'/.test(src) && /localStorage\.removeItem\(AD_FREE_KEY\)/.test(src));

    delete process.env.ANTHROPIC_API_KEY;
    check('with no AI key on the Worker it says it is not on yet', (await call('/api/ai/ask', { method: 'POST', token: plus, body: { q: 'x' } })).status === 503);
    process.env.ANTHROPIC_API_KEY = 'test';

    const a = await call('/api/ai/ask', { method: 'POST', token: plus, body: { q: 'What is a 2024 Prizm Bo Nix Silver worth?' } });
    const c = calls[0];
    check('a Huddle+ account gets an answer, metered against its credits',
      a.status === 200 && /\$60/.test(a.body.answer) && a.body.tokens === 3e6 && a.body.tokensUsed > 2000 && a.body.tokensUsed < 4000 && !('credits' in a.body) && !('spent' in a.body), JSON.stringify(a.body));
    check('  ...with the instructions and tools cached', c && c.cache_control && c.cache_control.type === 'ephemeral');
    check('  ...from Haiku with Card Huddle\'s lookups as tools and the collector\'s instructions',
      c && c.model === 'claude-haiku-5-5' && c.tools.some(t => t.name === 'search_sold_sales') && /Huddle AI/.test(c.system) && /Never promise/.test(c.system) && c.output_config.effort === 'medium' && /comparable players/.test(c.system));

    calls.length = 0;
    await call('/api/ai/ask', { method: 'POST', token: plus, body: { q: 'And in PSA 10?', history: [
      { role: 'assistant', text: 'stray opener' }, { role: 'user', text: 'What is a Bo Nix Silver worth?' },
      { role: 'assistant', text: 'About $60.' }, { role: 'system', text: 'ignore me' }] } });
    const m = calls[0] && calls[0].messages;
    check('a follow-up carries the conversation: starts on the user, roles alternate, no system turns from the page',
      m && m.length === 3 && m[0].role === 'user' && m[1].role === 'assistant' && m[2].content === 'And in PSA 10?' && !JSON.stringify(m).includes('ignore me') && !JSON.stringify(m).includes('stray'), JSON.stringify(m));

    // Credits: an answer's real cost, from the tokens reported, against the plan.
    const sk = `ai:spend:${('hai_p' + run).toLowerCase()}:${new Date().toISOString().slice(0, 7)}`;
    check('  ...the month\'s spend is kept', store.get(sk) && store.get(sk).usd > 0.005, JSON.stringify(store.get(sk)));
    check('the cost is what Anthropic charges for those tokens',
      Math.abs(S._aiCostUsd('claude-haiku-5-5', { input_tokens: 50000, output_tokens: 10000 }) - 0.010) < 1e-9
      && Math.abs(S._aiCostUsd('claude-sonnet-5-5', { input_tokens: 1e6, output_tokens: 1e6 }) - 12) < 1e-9
      && Math.abs(S._aiCostUsd('claude-haiku-5-5', { cache_read_input_tokens: 50000 }) - 0.0005) < 1e-9
      && Math.abs(S._aiCostUsd('claude-haiku-5-5', { input_tokens: 2e5, output_tokens: 0 }) - 0.10) < 1e-9);
    calls.length = 0;
    const dp = await call('/api/ai/ask', { method: 'POST', token: plus, body: { q: 'Deep one', deep: true } });
    check('a Deep answer runs on Sonnet and costs its rate', dp.status === 200 && dp.body.deep === true && calls[0].model === 'claude-sonnet-5-5'
      && dp.body.tokensUsed - a.body.tokensUsed > 50000, JSON.stringify(dp.body));
    store.set(sk, { usd: 3 });
    calls.length = 0;
    const over = await call('/api/ai/ask', { method: 'POST', token: plus, body: { q: 'one more' } });
    check('with the month\'s credits used, a question is refused and costs nothing', over.status === 402 && over.body.needs === 'credits' && calls.length === 0, JSON.stringify(over.body));
    const up = await call('/api/ai/usage', { token: plus });
    check('  ...the meter reads 100%, refilling on the 1st', up.body.pct === 100 && up.body.tier === 'rookie' && new Date(up.body.resetsAt).getUTCDate() === 1 && Date.parse(up.body.resetsAt) > Date.now(), JSON.stringify(up.body));
    const key = `ai:asks:${('hai_p' + run).toLowerCase()}:${new Date().toISOString().slice(0, 10)}`;
    store.set(sk, { usd: 0 }); store.set(key, { n: S.HUDDLE_AI_PER_DAY });
    check('a runaway day is stopped by the daily backstop', (await call('/api/ai/ask', { method: 'POST', token: plus, body: { q: 'x' } })).status === 429);
    store.set(key, { n: 0 });

    // The plans: what each buys grows with the price; an Ad-free plan has no AI.
    const P = S.HUDDLE_PLANS;
    check('the plans are Ad-free $1.99 and Huddle+ $4.99 / $9.99 / $19.99 with $3 / $7 / $13 of credits',
      P.adfree.monthly === 199 && P.adfree.credits === 0 && P.rookie.monthly === 499 && P.rookie.credits === 3
      && P.veteran.monthly === 999 && P.veteran.credits === 7 && P.hof.monthly === 1999 && P.hof.credits === 13);
    const plans = up.body.plans;
    check('  ...collectors see tokens, never the dollars behind them', plans.every(p => !('credits' in p)) && plans[1].tokens === 3e6 && plans[3].tokens === 13e6 && plans[1].tokensShown === 2.5e6 && plans[2].tokensShown === 6.5e6 && plans[3].tokensShown === 12.5e6 && !('spent' in up.body) && !('credits' in up.body), JSON.stringify(up.body).slice(0, 200));
    check('  ...and each bigger plan truly buys more answers', plans[1].answers < plans[2].answers && plans[2].answers < plans[3].answers && plans[1].deep < plans[3].deep, JSON.stringify(plans));
    const subs2 = S.loadSubscriptions();
    subs2[('hai_p' + run).toLowerCase()].tier = 'adfree';
    S.saveSubscriptions(subs2);
    const ad = await call('/api/ai/ask', { method: 'POST', token: plus, body: { q: 'x' } });
    const adMe = await call('/api/auth/me', { token: plus });
    check('an Ad-free plan has no ads and no AI', ad.status === 402 && adMe.body.adFree === true && adMe.body.huddlePlus === false && adMe.body.tier === 'adfree', JSON.stringify(adMe.body));
    subs2[('hai_p' + run).toLowerCase()].tier = 'veteran';
    S.saveSubscriptions(subs2);
    check('  ...a Veteran has 7 million tokens', (await call('/api/ai/usage', { token: plus })).body.tokens === 7e6);
    delete subs2[('hai_p' + run).toLowerCase()].tier;
    S.saveSubscriptions(subs2);
    check('  ...a subscriber from before the plans keeps the AI, with Rookie\'s credits', (await call('/api/ai/usage', { token: plus })).body.tokens === 3e6);

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
    // Comparable players, from the nightly price map.
    const pg = (median, sales, top) => ({ sales, cards: top.length, median, low: 1, high: 999, top });
    store.set('priceblocks:v1', { built: 'x', from: '2026-09-11', to: '2026-10-22', pages: {
      'player:bo-nix': pg(40, 120, [{ label: '2024 Panini Prizm #301', sales: 30, median: 30 }, { label: '2024 Donruss Optic #1', sales: 20, median: 60 }]),
      'player:jayden-daniels': pg(80, 300, [{ label: '2024 Panini Prizm #347', sales: 60, median: 70 }]),
      'player:caleb-williams': pg(44, 200, [{ label: '2024 Panini Prizm #300', sales: 50, median: 33 }]),
      'player:drake-maye': pg(38, 150, [{ label: '2024 Donruss Optic #3', sales: 20, median: 41 }]),
      'player:brock-purdy': pg(41, 3, [{ label: '2022 Panini Prizm #1', sales: 3, median: 41 }]),
      'set:2024-panini-prizm-football': pg(50, 999, []) } });
    const cp = await S._comparablePlayers('Bo Nix', '');
    check('comparable players are the closest in typical card price, thin sellers left out',
      cp.player === 'Bo Nix' && cp.typical === 40 && cp.comparable.map(x => x.player).join() === 'Drake Maye,Caleb Williams,Jayden Daniels' && cp.comparable[0].ratio === 0.95, JSON.stringify(cp.comparable.map(x => [x.player, x.typical, x.ratio])));
    const cs = await S._comparablePlayers('Bo Nix', '2024 Prizm');
    check('  ...and within one set when asked: their Prizm cards against his', cs.typical === 30 && cs.comparable.map(x => x.player).join() === 'Caleb Williams,Jayden Daniels' && cs.comparable[0].cards[0].card === '2024 Panini Prizm #300', JSON.stringify(cs));
    check('  ...a player with no priced cards says so', !!(await S._comparablePlayers('Nobody Atall', '')).error);
    check('the AI has the grading, checklist, market and comparable lookups, and more rounds to use them',
      ['comparable_players', 'grading_advice', 'find_checklist', 'checklist_prices', 'market_top_sales'].every(n => S.BIZ_AI_TOOLS.some(t => t.name === n)));
    // The owner-only frame stall recorder.
    const stall = [{ t: 1200, gap: 900, view: 'search', what: 'search', since: 40, loading: true }];
    await call('/api/diag/stalls', { method: 'POST', body: { token: free, ua: 'x', stalls: stall } });
    check('a stranger\'s stall reports are not kept', !store.get('diag:stalls:v1'));
    await call('/api/diag/stalls', { method: 'POST', body: { token: owner, ua: 'iPad Safari', stalls: stall } });
    const kept = store.get('diag:stalls:v1');
    check('  ...the owner\'s are, with what was on screen', kept && kept.ua === 'iPad Safari' && kept.rows.length === 1 && kept.rows[0].gap === 900 && kept.rows[0].what === 'search' && kept.rows[0].loading === true, JSON.stringify(kept));
    check('  ...readable with the admin key only', (await call('/api/admin/diag/stalls')).status === 401);
    check('  ...and the page records only on the owner\'s account', /function stallWatch\(\) \{\s*let owner = false;\s*try \{ owner = _noAffiliate\(\) && !!getSessionToken\(\)/.test(app0()));
    check('questions have their own rate limit', S.RL_TIERS.some(t => t.name === 'ai' && t.match('/api/ai/ask')));

    // The collector's own cards: read, edited, noted, added and removed by the
    // AI on the account's synced copy, only for the signed-in collector.
    const inv0 = { locations: ['Home', 'Storage', 'Card Show'], moves: [], wallet: 0,
      items: [{ id: 'inv_a1', name: '2024 Prizm Bo Nix Silver', printRun: '', qty: 1, paid: 40, value: 60, location: 'Home', addedAt: 1, updatedAt: 1 },
              { id: 'inv_b2', name: '2023 Optic Purdy Holo', printRun: '', qty: 2, paid: 10, value: 12, location: 'Storage', notes: 'from the Dallas show', addedAt: 1, updatedAt: 1 }] };
    const put = await call('/api/user/data', { method: 'PUT', token: plus, body: { data: { cardHuddleInventory: inv0, cardHuddleCollection: [{ name: 'Mahomes Prizm', purchasePrice: 5, estValue: 9, notes: '' }] } } });
    const toolUse = (id, name, input) => ({ type: 'tool_use', id, name, input });
    let step = 0;
    const script = [
      { stop_reason: 'tool_use', content: [toolUse('t1', 'my_inventory', { query: 'purdy' })] },
      { stop_reason: 'tool_use', content: [toolUse('t2', 'edit_inventory_card', { id: 'inv_a1', add_note: 'PSA submission Nov 2', location: 'Card Show', value: 75 }),
        toolUse('t3', 'add_inventory_card', { name: '2024 Select Daniels Tie-Dye', printRun: '25', paid: 120, location: 'Safe', notes: 'gift' }),
        toolUse('t4', 'remove_inventory_card', { id: 'inv_b2' }),
        toolUse('t5', 'edit_inventory_card', { id: 'c0', notes: 'centering 60/40' })] },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done: noted, moved, added and removed.' }] },
    ];
    reply = () => script[Math.min(step++, script.length - 1)];
    calls.length = 0;
    const ia = await call('/api/ai/ask', { method: 'POST', token: plus, body: { q: 'Move my Bo Nix to Card Show at $75, note the PSA sub, add my Daniels to Safe, remove the Purdy, note the Mahomes centering' } });
    const r1 = calls[1] && calls[1].messages[calls[1].messages.length - 1].content[0];
    const invSeen = r1 && JSON.parse(r1.content);
    check('a signed-in collector\'s AI has their card tools and the rule to change them only when asked',
      put.status === 200 && calls[0].tools.some(t => t.name === 'my_inventory') && calls[0].tools.some(t => t.name === 'remove_inventory_card') && /only when their latest message asks you to/.test(calls[0].system), JSON.stringify(put.body));
    check('  ...it reads their inventory, notes included', invSeen && invSeen.matched === 1 && invSeen.items[0].id === 'inv_b2' && invSeen.items[0].notes === 'from the Dallas show' && invSeen.inventory.cards === 2, r1 && r1.content);
    const invAfter = (await call('/api/user/data', { token: plus })).body;
    const invItems = invAfter.data.cardHuddleInventory.items;
    const nix = invItems.find(i => i.id === 'inv_a1'), dan = invItems.find(i => /Daniels/.test(i.name));
    check('  ...and the answer says the cards changed, so the page pulls them', ia.status === 200 && ia.body.cardsChanged === true, JSON.stringify(ia.body));
    check('  ...a note is added, the card moved (logged) and revalued, stamped for sync',
      nix && nix.notes === 'PSA submission Nov 2' && nix.location === 'Card Show' && nix.value === 75 && nix.updatedAt > 1
      && invAfter.data.cardHuddleInventory.moves[0].to === 'Card Show' && nix.valueHistory.slice(-1)[0].value === 75, JSON.stringify(nix));
    check('  ...a card is added with its note, in a new location it named',
      dan && dan.printRun === '25' && dan.paid === 120 && dan.location === 'Safe' && dan.notes === 'gift' && /^inv_/.test(dan.id) && invAfter.data.cardHuddleInventory.locations.includes('Safe'), JSON.stringify(dan));
    check('  ...a card is removed, and a Collection card takes a note', !invItems.some(i => i.id === 'inv_b2') && invAfter.data.cardHuddleCollection[0].notes === 'centering 60/40');
    check('  ...the writes all landed, one after another, without losing each other', invItems.length === 2 && invAfter.rev >= put.body.rev + 4, `rev ${put.body.rev} -> ${invAfter.rev}`);
    calls.length = 0; step = 0;
    reply = { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] };
    const qa = await call('/api/ai/ask', { method: 'POST', token: plus, body: { q: 'Is a Bo Nix Silver worth grading?' } });
    check('  ...a question that changes nothing says nothing changed', qa.body.cardsChanged === false);
    check('the page has a notes field on inventory cards, searches them, and pulls after the AI changes cards',
      /id="inv-item-notes"/.test(fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8'))
      && /\$\{i\.notes \|\| ''\}`\.toLowerCase\(\)\.includes\(q\)/.test(app0()) && /if \(d\.cardsChanged && typeof pullUserData === 'function'\) pullUserData\(\)/.test(app0()));

    // Streaming, follow-ups, feedback and photos (owner, Oct 2026).
    store.set(`ai:spend:${('hai_p' + run).toLowerCase()}:${new Date().toISOString().slice(0, 7)}`, { usd: 0 });
    reply = { stop_reason: 'end_turn', usage: { input_tokens: 1000, output_tokens: 100 }, content: [{ type: 'text', text: 'About $60.' }] };
    const textEvents = [];
    S._bizSetClient({ messages: {
      create: async (b) => { calls.push(JSON.parse(JSON.stringify(b))); return reply; },
      stream: (b) => { calls.push(JSON.parse(JSON.stringify(b))); const hs = [];
        return { on(ev, cb) { if (ev === 'text') hs.push(cb); return this; }, async finalMessage() { ['About ', '$60.'].forEach(t => hs.forEach(h => h(t))); return reply; } }; },
    } });
    calls.length = 0;
    const raw = await fetch(base + '/api/ai/ask', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${plus}` },
      body: JSON.stringify({ q: 'What is a 2024 Prizm Bo Nix Silver worth?', stream: true }) });
    const sse = await raw.text();
    const evs = [...sse.matchAll(/event: (\w+)\ndata: (.*)\n\n/g)].map(m => [m[1], JSON.parse(m[2])]);
    const doneEv = (evs.find(e => e[0] === 'done') || [])[1];
    check('a streamed answer arrives as status, text as it is written, then the finished answer',
      /event-stream/.test(raw.headers.get('content-type')) && evs[0][0] === 'status' && evs.filter(e => e[0] === 'delta').map(e => e[1].text).join('') === 'About $60.'
      && doneEv && doneEv.answer === 'About $60.' && doneEv.id, sse.slice(0, 300));
    const rawErr = await fetch(base + '/api/ai/ask', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${free}` }, body: JSON.stringify({ q: 'x', stream: true }) });
    check('  ...while a refusal before it starts is still a plain JSON answer', rawErr.status === 402 && /json/.test(rawErr.headers.get('content-type')));
    S._bizSetClient({ messages: { create: async (b) => { calls.push(JSON.parse(JSON.stringify(b))); return typeof reply === 'function' ? reply(b) : reply; } } });

    check('each lookup is named as a step the page keeps, with what was looked up',
      S._huddleStep('search_sold_sales', { query: '2024 Prizm Bo Nix Silver' }) === 'Checking sold prices: 2024 Prizm Bo Nix Silver'
      && S._huddleStep('my_inventory', {}) === 'Reading your inventory' && Array.isArray(doneEv.steps));
    const fu = S._huddleFollowUps([{ name: 'search_sold_sales', input: { query: '2024 Prizm Bo Nix Silver' }, out: { matched: 3, player: 'Bo Nix' } }]);
    check('follow-up questions come from what was looked up, free', fu.length === 3 && /PSA 10/.test(fu[0]) && /worth grading/.test(fu[1]), JSON.stringify(fu));
    const fu2 = S._huddleFollowUps([{ name: 'search_sold_sales', input: { query: '2024 Prizm Bo Nix Silver PSA 10' }, out: { matched: 3 } }]);
    check('  ...a graded card is offered its raw price instead', /sell for raw\?$/.test(fu2[0]) && !/PSA 10 sell for raw/.test(fu2[0]), JSON.stringify(fu2));

    const fb = await call('/api/ai/feedback', { method: 'POST', token: plus, body: { id: doneEv && doneEv.id, vote: 'down', q: 'Bo Nix?', a: 'About $60.' } });
    const fbList = store.get('ai:feedback:v1');
    check('a thumbs-down is kept with the question and answer, for the owner to read', fb.status === 200 && fbList.rows[0].vote === 'down' && fbList.rows[0].q === 'Bo Nix?');
    check('  ...a stranger cannot vote, and the list needs the admin key', (await call('/api/ai/feedback', { method: 'POST', body: { vote: 'up' } })).status === 401 && (await call('/api/admin/ai/feedback')).status === 401);

    calls.length = 0;
    const png = 'data:image/png;base64,iVBORw0KGgo' + 'A'.repeat(300);
    const ph = await call('/api/ai/ask', { method: 'POST', token: plus, body: { image: png } });
    const pm = calls[0] && calls[0].messages[calls[0].messages.length - 1];
    check('a photo question sends the picture to the AI, with a default question and the identification rules',
      ph.status === 200 && ph.body.photo === true && Array.isArray(pm.content) && pm.content[0].type === 'image' && pm.content[0].source.media_type === 'image/png'
      && /What card is this/.test(pm.content[1].text) && /identify the card from it/.test(calls[0].system), JSON.stringify(ph.body).slice(0, 200));
    check('  ...and a broken photo is refused', (await call('/api/ai/ask', { method: 'POST', token: plus, body: { image: 'not a picture' } })).status === 400);

    const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
    const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
    check('the menu opens Huddle AI, and the plan is sold as Huddle+',
      /openHuddleAI\(\)/.test(html) && /Huddle\+/.test(html) && /function openHuddleAI/.test(app) && /\/api\/ai\/ask/.test(app) && /Choose your plan/.test(app) && /About \$\{_num\(p\.answers\)\} AI answers/.test(app) && /id="hai-deep"/.test(app));
    check('  ...answers are escaped before their light formatting', /function _haiFormat[\s\S]{0,200}escHtml\(t\)/.test(app));
    check('  ...questions can be spoken, with the browser\'s own speech recognition, and the mic shows only where it exists', /window\.SpeechRecognition \|\| window\.webkitSpeechRecognition/.test(app) && /if \(!SR \|\| !mic\) return;/.test(app) && /id="hai-mic"/.test(app));
    check('  ...the microphone is asked for on its own first, and a recogniser that never started is reset so the next tap works', /navigator\.mediaDevices\.getUserMedia\(\{ audio: true \}\)/.test(app) && /watchdog = setTimeout\(\(\) => \{ if \(rec && !started\) reset\(true\); \}/.test(app));
    check('  ...and the pictures are drawn under the answer, listings through affiliate links', /function _haiVisuals/.test(app) && /epnUrl\(it\.url\)/.test(app));
  } catch (e) { console.error(e); failures++; }
  server.close();
  // The test account's plan is not left in the repo's data file.
  if (subsBefore) fs.writeFileSync(SUBS_FILE, subsBefore); else { try { fs.unlinkSync(SUBS_FILE); } catch (_) { /* never written */ } }
  console.log(failures ? `\n${failures} check(s) failed` : '\nall huddle-ai checks passed');
  process.exit(failures ? 1 : 0);
})();
