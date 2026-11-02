// "Your collection this week" (owner, Nov 2026): every Monday each collector's
// top cards are priced from that week's sales and compared with last week's,
// then pushed and emailed (with a one-click off), and the Inventory tab shows
// the figures. Pricing, push and email are stubbed here.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

process.env.CF_WORKER = '1';
const S = require(path.join(ROOT, 'server.js'));
const PORT = 3297;
const server = S.app.listen(PORT);
const base = `http://127.0.0.1:${PORT}`;
let ip = 20;
const call = (p, { method = 'GET', token, body } = {}) => fetch(base + p, {
  method, body: body ? JSON.stringify(body) : undefined,
  headers: { 'content-type': 'application/json', 'cf-connecting-ip': `198.51.100.${ip++}`, ...(token ? { authorization: `Bearer ${token}` } : {}) },
});

(async () => {
  try {
    // ---- which cards get priced ----
    const items = Array.from({ length: 30 }, (_, k) => ({ id: 'i' + k, name: 'Card ' + k, qty: 1, value: k }));
    items.push({ id: 'zero', name: 'Sold out', qty: 0, value: 999 });
    const picked = S._collWeekCards({ cardHuddleInventory: { items }, cardHuddleCollection: [{ year: 2024, brand: 'Prizm', player: 'Bo Nix', estValue: 500 }] });
    check('the 25 dearest cards are priced, Collection included, empty rows skipped',
      picked.cards.length === 25 && picked.cards[0].id === 'c0' && picked.cards[0].name === '2024 Prizm Bo Nix' && !picked.cards.some(c => c.id === 'zero') && picked.total === 31,
      picked.cards.slice(0, 3).map(c => c.id).join(','));

    // ---- the week's summary and message ----
    const first = S._collWeekSummary(null, { total: 120, items: { a: { name: 'A', qty: 1, price: 100 }, b: { name: 'B', qty: 2, price: 10 } }, cards: 2 });
    check('first week: no change yet, just the worth', first.change == null && first.total === 120);
    check('first week message says next Monday shows the move', /about \$120/.test(S._collWeekMessage(first).body) && /Next Monday/.test(S._collWeekMessage(first).body));
    const prev = { items: { a: { price: 100 }, b: { price: 10 } } };
    const cur = { total: 160, cards: 3, items: { a: { name: '2024 Prizm Bo Nix Silver', qty: 1, price: 118 }, b: { name: 'B', qty: 2, price: 9 }, c: { name: 'New', qty: 1, price: 24 } } };
    const s = S._collWeekSummary(prev, cur);
    check('change counts only cards priced both weeks (a new card is not a gain)', s.change === 16 && s.pct === 13.3, `${s.change} ${s.pct}`);
    check('the card that moved most leads', s.top && s.top.name === '2024 Prizm Bo Nix Silver' && s.top.change === 18);
    const m = S._collWeekMessage(s);
    check('message: up 13.3% ($16), with the leader', m.title === 'Your collection is up 13.3%' && /up 13\.3% \(\$16\) this week/.test(m.body) && /Bo Nix Silver led, \+\$18/.test(m.body), m.body);
    const down = S._collWeekMessage(S._collWeekSummary({ items: { a: { price: 100 } } }, { total: 80, cards: 1, items: { a: { name: 'A', qty: 1, price: 80 } } }));
    check('a fall reads as down, with the slipping card', /down 20%/.test(down.body) && /A slipped, -\$20/.test(down.body), down.body);

    // ---- the Monday run, end to end ----
    const u1 = 'cw' + Date.now().toString(36), u2 = u1 + 'b';
    const r1 = await (await call('/api/auth/register', { method: 'POST', body: { username: u1, password: 'secret123', email: u1 + '@example.com' } })).json();
    await call('/api/auth/register', { method: 'POST', body: { username: u2, password: 'secret123' } });
    await S._userSyncSave(u1, { cardHuddleInventory: { items: [
      { id: 'x1', name: '2024 Prizm Bo Nix Silver', qty: 1, value: 50 },
      { id: 'x2', name: '2023 Donruss CJ Stroud Rated Rookie PSA 10', qty: 2, value: 40 },
      { id: 'x3', name: 'Mystery card nobody sells', qty: 1, value: 5 },
    ] } }, null);
    let prices = { '2024 Prizm Bo Nix Silver': 100, '2023 Donruss CJ Stroud Rated Rookie PSA 10': 30 };
    const price = async (it) => ({ market: prices[it.title] || null });
    const pushes = [], mails = [];
    const push = async (u, msg) => { pushes.push({ u, msg }); return 1; };
    const mail = async (m) => { mails.push(m); };
    // The run is spread over ticks (a card budget each); run it to the end.
    const runAll = async (now) => { let r; for (let k = 0; k < 200; k++) { r = await S.collectionWeekly({ now, force: true, push, mail, price }); if (!r.run || r.run.done) break; } return r; };
    const wk = new Date(Date.UTC(2040 + Math.floor(Math.random() * 200), 0, 1 + 7 * Math.floor(Math.random() * 40), 16));
    wk.setUTCDate(wk.getUTCDate() + ((8 - wk.getUTCDay()) % 7));   // a Monday, 16:00 UTC, in a week no earlier run used
    const out1 = await runAll(wk);
    const p1 = pushes.find(p => p.u === u1);
    check('week one: the collector is priced and pushed their worth', out1.ok && p1 && /about \$160/.test(p1.msg.body), p1 && p1.msg.body);
    check('a collector with no cards gets nothing', !pushes.some(p => p.u === u2) && !mails.some(x => x.to.startsWith(u2)));
    const m1 = mails.find(x => x.to === u1 + '@example.com');
    check('the email lists the cards and a working off link', m1 && /Bo Nix Silver/.test(m1.html) && /\/api\/collection-week\/off\?u=/.test(m1.html));
    const again = await runAll(wk);
    check('the same week never sends twice', again.skipped === 'already sent' && pushes.filter(p => p.u === u1).length === 1, JSON.stringify(again).slice(0, 120));

    prices = { '2024 Prizm Bo Nix Silver': 125, '2023 Donruss CJ Stroud Rated Rookie PSA 10': 30 };
    await runAll(new Date(wk.getTime() + 7 * 86400000));
    const p2 = pushes.filter(p => p.u === u1)[1];
    check('week two: the move since last week, led by the card that moved', p2 && /up 15\.6% \(\$25\)/.test(p2.msg.body) && /Bo Nix Silver led, \+\$25/.test(p2.msg.body), p2 && p2.msg.body);

    const banner = await (await call('/api/collection-week', { token: r1.token })).json();
    check('the Inventory banner gets the latest figures', banner.available && banner.total === 185 && banner.pct === 15.6 && /up 15\.6%/.test(banner.text), JSON.stringify(banner).slice(0, 160));
    check('the banner needs a sign-in', (await call('/api/collection-week')).status === 401);

    // ---- the off switch ----
    const bad = await (await call(`/api/collection-week/off?u=${u1}&t=nope`)).text();
    check('a forged off link does nothing', /did not work/.test(bad));
    const good = await (await call(`/api/collection-week/off?u=${u1}&t=${S._collWeekToken(u1)}`)).text();
    check('the real off link stops the emails', /Done/.test(good));
    const before = mails.length;
    await runAll(new Date(wk.getTime() + 14 * 86400000));
    check('after turning it off: still a push, no email', mails.length === before && pushes.filter(p => p.u === u1).length === 3);

    const notTime = await S.collectionWeekly({ now: new Date(Date.UTC(2040, 0, 4, 16)) });
    check('outside Monday 15:00+ UTC it does nothing', notTime.skipped === 'not send time');
  } finally {
    server.close();
  }

  const w = read('worker.js');
  check('the cron runs it every tick', /await collectionWeekly\(\)\.catch/.test(w) && (w.match(/collectionWeekly/g) || []).length >= 4);
  const app = read('public/app.js');
  check('Inventory loads and paints the week', /_invWeekLoad\(inv\.items\.length > 0\);/.test(app) && /'\/api\/collection-week'/.test(app) && /id="inv-week"/.test(read('public/index.html')));

  console.log(failures ? `\n${failures} collection-week check(s) failed` : '\nall collection-week checks passed');
  process.exit(failures ? 1 : 0);
})();
