// The weekly Market Movers email: what it says, who gets it, and that it goes
// once a week to confirmed addresses only.
const path = require('path');
const ROOT = path.join(__dirname, '..');

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

const d = require(path.join(ROOT, 'market-digest.js'));

// ---- the pure parts -------------------------------------------------------
check('addresses: sensible ones pass, junk does not',
  d.validEmail(' Fan@Example.com ') && d.validEmail('a.b+cards@mail.co.uk')
  && !d.validEmail('nope') && !d.validEmail('a@b') && !d.validEmail('x@y.com, z@w.com') && !d.validEmail('<a@b.com>'));
check('  ...and are stored lower-case and trimmed', d.normEmail(' Fan@Example.COM ') === 'fan@example.com');
check('ISO weeks', d.weekId(new Date('2026-09-28T15:00:00Z')) === '2026-W40' && d.weekId(new Date('2027-01-01T00:00:00Z')) === '2026-W53');
check('sends Mondays from 14:00 UTC only',
  d.inSendWindow(new Date('2026-09-28T14:00:00Z')) && d.inSendWindow(new Date('2026-09-28T23:45:00Z'))
  && !d.inSendWindow(new Date('2026-09-28T13:59:00Z')) && !d.inSendWindow(new Date('2026-09-29T15:00:00Z')));

const week7 = {
  available: true, pricedSales: 94358, totalValue: 11267436, avgPrice: 119.41,
  cardMovers: [
    { player: 'Dan Marino', name: '1984 Topps Dan Marino #123', sales: 22, changePct: 19.1, query: '1984 Topps Dan Marino', imageUrl: 'https://i.ebayimg.com/x.webp' },
    { player: 'Bo Jackson', name: '1990 Score Bo Jackson #697', sales: 30, changePct: 12, query: '1990 Score Bo Jackson' },
    { player: 'Joe Montana', name: '1981 Topps Joe Montana #216', sales: 18, changePct: -9, query: '1981 Topps Joe Montana' },
    { player: '<script>', name: '<script>alert(1)</script>', sales: 5, changePct: 4, query: 'x"><script>' },
  ],
  mostSold: [{ name: '1986 Topps Jerry Rice #161', sales: 96, avgPrice: 336, topPrice: 13200, query: '1986 Topps Jerry Rice' }],
  priciest: [{ title: 'Playoff 2000 Contenders Tom Brady #144', price: 49100, grade: 'BGS 8.5', itemUrl: 'https://www.ebay.com/itm/1' }],
  topSets: [{ name: '2026 Topps', sales: 6604, avgPrice: 90, totalValue: 593360, query: '2026 Topps' }],
};
const month30 = { available: true, playerMovers: [{ player: 'Brett Favre', changePct: 22.4, resales: 40, query: 'Brett Favre' }, { player: 'Terry Bradshaw', changePct: -3, query: 'Terry Bradshaw' }] };
const c = d.digestContent(week7, month30);
check('content: risers up and sorted, fallers down, players rising only',
  c && c.risers[0].player === 'Dan Marino' && c.risers.every(r => r.changePct > 0)
  && c.fallers.length === 1 && c.fallers[0].changePct < 0 && c.players.length === 1 && c.players[0].player === 'Brett Favre');
check('  ...and no email from empty boards', d.digestContent({ available: true }, null) === null && d.digestContent(null, null) === null);

const m = d.renderDigest(c, { week: '2026-W40', unsubUrl: 'https://thecardhuddle.com/api/digest/unsubscribe?id=abc&t=tok' });
check('the subject leads with the top mover', /^Dan Marino \+19% this week/.test(m.subject), m.subject);
check('every item links back into its search, tagged for Analytics',
  m.html.includes('https://thecardhuddle.com/?q=1984%20Topps%20Dan%20Marino&amp;utm_source=digest&amp;utm_medium=email&amp;utm_campaign=2026-W40')
  && m.text.includes('/?q=Brett%20Favre&utm_source=digest'));
check('  ...with the reader’s own unsubscribe link, in HTML and text',
  m.html.includes('unsubscribe?id=abc&amp;t=tok') && m.text.includes('unsubscribe?id=abc&t=tok'));
check('  ...and listing titles cannot inject markup', !m.html.includes('<script>') && m.html.includes('&lt;script&gt;'));

// ---- the flow, against the real app ---------------------------------------
const boards = { 'soldstats:v10:7': week7, 'soldstats:v10:30': month30 };
const dbMod = require(path.join(ROOT, 'db.js'));
dbMod.cacheGet = async (k) => boards[k] || null;
process.env.CF_WORKER = '1';
process.env.RESEND_API_KEY = 'test-key';
process.env.ADMIN_PASSWORD = 'digest-admin';
const sent = [];   // every email "sent": { to, subject, html, headers, batch }
const axios = require('axios');
axios.post = async (url, body, opts) => {
  if (url.endsWith('/emails/batch')) {
    for (const b of body) sent.push({ ...b, to: b.to[0], batch: true, idem: opts.headers['Idempotency-Key'] });
    return { data: { data: body.map((_, i) => ({ id: String(i) })) } };
  }
  if (url.endsWith('/emails')) { sent.push({ ...body, to: body.to[0] }); return { data: { id: 'x' } }; }
  throw new Error('unexpected ' + url);
};

const { app, sendMarketDigest } = require(path.join(ROOT, 'server.js'));
const PORT = 3237;
const server = app.listen(PORT);
const base = `http://127.0.0.1:${PORT}`;
const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const linkFrom = (html, route) => {
  const m = html.match(new RegExp(`https?://[^"']*${route}\\?id=([0-9a-f]+)&(?:amp;)?t=([0-9a-f]+)`));
  return m ? `/api/digest/${route.split('/').pop()}?id=${m[1]}&t=${m[2]}` : null;
};

(async () => {
  const bad = await post('/api/digest/subscribe', { email: 'nope' });
  check('a bad address is refused', bad.status === 400);

  const r1 = await (await post('/api/digest/subscribe', { email: 'Fan@Example.com' })).json();
  const confirmMail = sent.find(s => s.to === 'fan@example.com');
  check('signing up sends a confirmation email, not the digest', r1.status === 'pending' && confirmMail && /Confirm/.test(confirmMail.subject));
  await post('/api/digest/subscribe', { email: 'fan@example.com' });
  check('  ...and asking again straight away does not send another', sent.filter(s => s.to === 'fan@example.com').length === 1);

  const fourth = await post('/api/digest/subscribe', { email: 'never-confirms@example.com' });
  check('  ...and a fourth signup from one address in a minute is rate limited', fourth.status === 429);
  const confirmPath = linkFrom(confirmMail.html, 'api/digest/confirm');
  check('  ...a forged confirm link does nothing',
    (await fetch(base + confirmPath.replace(/t=[0-9a-f]+/, 't=' + '0'.repeat(32)))).status === 400);
  const conf = await fetch(base + confirmPath);
  check('  ...the real one confirms', conf.status === 200 && /You're in/.test(await conf.text()));

  sent.length = 0;
  const off = await sendMarketDigest({ now: new Date('2026-09-29T15:00:00Z') });
  check('outside the Monday window nothing is sent', off.skipped === 'not send time' && sent.length === 0);

  const monday = new Date('2026-09-28T14:05:00Z');
  const r = await sendMarketDigest({ now: monday });
  const got = sent.filter(s => s.batch);
  check('on Monday the digest goes to confirmed subscribers only',
    r.ok && got.length === 1 && got[0].to === 'fan@example.com', got.map(s => s.to).join(','));
  check('  ...with one-click unsubscribe headers',
    got[0] && /^<https:\/\/.*\/api\/digest\/unsubscribe\?id=/.test(got[0].headers['List-Unsubscribe'])
    && got[0].headers['List-Unsubscribe-Post'] === 'List-Unsubscribe=One-Click');
  check('  ...and an idempotency key, so a retried batch is not mailed twice', /^digest-2026-W40-/.test(got[0] && got[0].idem || ''));
  await sendMarketDigest({ now: new Date('2026-09-28T14:20:00Z') });
  check('  ...once a week: the next tick sends nothing', sent.filter(s => s.batch).length === 1);

  const unsubPath = linkFrom(got[0].html, 'api/digest/unsubscribe');
  const u = await fetch(base + unsubPath, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' });
  check('one-click unsubscribe works', u.status === 200);
  sent.length = 0;
  await sendMarketDigest({ now: new Date('2026-10-05T14:05:00Z') });
  check('  ...and the next week they get nothing', sent.length === 0);

  const st = await (await fetch(base + '/api/debug/digest?key=digest-admin')).json();
  check('admin report counts subscribers', st.subscribers && st.subscribers.unsubscribed === 1 && st.subscribers.pending === 0 && st.subscribers.active === 0, JSON.stringify(st.subscribers));
  check('  ...and is admin only', (await fetch(base + '/api/debug/digest')).status === 403);

  server.close();
  console.log(failures ? `\n${failures} check(s) failed` : '\nall market-digest checks passed');
  process.exit(failures ? 1 : 0);
})().catch(err => { console.error(err); server.close(); process.exit(1); });
