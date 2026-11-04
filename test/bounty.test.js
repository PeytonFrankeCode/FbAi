// Bounty Board (owner, Nov 2026): the rules (8% split 4/4, seller caps, card
// matching, the clock) and the whole deal through the real routes, with a
// stand-in for Stripe: post, claim with photos, pay, ship, confirm, payout;
// a dispute and its refund; an unpaid claim reopening; an unshipped card
// refunded; and the guards (own bounty, caps, payments off, the poster only).
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const B = require(path.join(ROOT, 'bounty-core.js'));

// ---- The rules ----
const f = B.fees(60);
check('8% in all: the buyer pays 4% on top, the seller gets 4% off', f.buyerPays === 6240 && f.sellerGets === 5760 && f.platform === 480, JSON.stringify(f));
check('new sellers start at $100 and earn room with finished sales', B.sellerCap(0) === 100 && B.sellerCap(3) === 500 && B.sellerCap(10) === 2500 && B.sellerCap(25) === B.MAX_PRICE);
check('grades read from text', B.readGrade('PSA 10').label === 'PSA 10' && B.readGrade('bgs 9.5').label === 'BGS 9.5' && B.readGrade('Raw').graded === false);
const want = { card: '2024 Prizm Bo Nix Silver', grade: 'Raw' };
check('an owned raw card with every word matches a raw bounty', B.cardMatches(want, '2024 Panini Prizm Bo Nix Silver Prizm RC #301'));
check('...a slab of it does not', !B.cardMatches(want, '2024 Prizm Bo Nix Silver PSA 10'));
check('...nor a card missing a word', !B.cardMatches(want, '2024 Prizm Bo Nix Base'));
check('a PSA 10 bounty matches only a PSA 10', B.cardMatches({ card: 'Bo Nix Silver Prizm', grade: 'PSA 10' }, '2024 Prizm Bo Nix Silver PSA 10') && !B.cardMatches({ card: 'Bo Nix Silver Prizm', grade: 'PSA 10' }, '2024 Prizm Bo Nix Silver PSA 9'));
check('a post needs a real card name and an offer of $5 to $25,000', !!B.validatePost({ card: 'Bo', price: 50 }).error && !!B.validatePost({ card: '2024 Prizm Bo Nix', price: 2 }).error && !B.validatePost({ card: '2024 Prizm Bo Nix', price: 50 }).error);
check('a bounty lasts at most 30 days', Date.parse(B.validatePost({ card: '2024 Prizm Bo Nix', price: 50, days: 90 }, { now: 0 }).expiresAt) === 30 * B.DAY);
const photo = (n) => `/bounty/img/${String(n).repeat(24).slice(0, 24)}.jpg`;
check('a claim needs front and back photos', !!B.validateClaim({ grade: 'Raw' }, { photos: [photo(1)] }).error && !B.validateClaim({ grade: 'Raw' }, { photos: [photo(1), photo(2)] }).error);
check('a slab claim needs its cert number', !!B.validateClaim({ grade: 'PSA 10' }, { photos: [photo(1), photo(2)] }).error && B.validateClaim({ grade: 'PSA 10' }, { photos: [photo(1), photo(2)], cert: '12345678' }).cert === '12345678');
check('photos must be ones uploaded here', !!B.validateClaim({ grade: 'Raw' }, { photos: ['https://evil.example/a.jpg', 'javascript:x'] }).error);
const t0 = Date.parse('2026-11-01T00:00:00Z');
check('the clock: expire, reopen an unpaid claim, refund an unshipped card, pay out a shipped one',
  B.due({ status: 'open', expiresAt: '2026-10-31T00:00:00Z' }, t0) === 'expire'
  && B.due({ status: 'claimed', claim: { at: new Date(t0 - 49 * 3600e3).toISOString() } }, t0) === 'reopen'
  && B.due({ status: 'claimed', claim: { at: new Date(t0 - 30 * 3600e3).toISOString() } }, t0) === null
  && B.due({ status: 'paid', claim: { paidAt: new Date(t0 - 6 * B.DAY).toISOString() } }, t0) === 'refund'
  && B.due({ status: 'shipped', claim: { shippedAt: new Date(t0 - 11 * B.DAY).toISOString() } }, t0) === 'release'
  && B.due({ status: 'shipped', claim: { shippedAt: new Date(t0 - 3 * B.DAY).toISOString() } }, t0) === null);
check('the PSA cert link goes to PSA', B.certUrl('PSA', '123') === 'https://www.psacard.com/cert/123');

// ---- The deal, through the routes ----
process.env.CF_WORKER = '1';
process.env.BOUNTY_PAYMENTS = 'on';
const S = require(path.join(ROOT, 'server.js'));
const calls = [];
const fake = {
  accounts: { create: async (o) => (calls.push(['acct', o]), { id: 'acct_test' }), retrieve: async () => ({ payouts_enabled: true, capabilities: { transfers: 'active' } }) },
  accountLinks: { create: async () => ({ url: 'https://connect.stripe.test/onboard' }) },
  checkout: { sessions: { create: async (o) => (calls.push(['checkout', o]), { id: 'cs_test', url: 'https://checkout.stripe.test/pay' }) } },
  paymentIntents: { retrieve: async () => ({ latest_charge: 'ch_test' }) },
  transfers: { create: async (o, opt) => (calls.push(['transfer', o, opt]), { id: 'tr_test' }) },
  refunds: { create: async (o, opt) => (calls.push(['refund', o, opt]), { id: 're_test' }) },
};
S._bountySetStripe(fake);
const PORT = 3301;
const server = S.app.listen(PORT);
const base = `http://127.0.0.1:${PORT}`;
let ip = 40;
const call = async (p, { method = 'GET', token, body } = {}) => {
  const r = await fetch(base + p, { method, body: body ? JSON.stringify(body) : undefined,
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': `198.51.100.${ip++}`, ...(token ? { authorization: `Bearer ${token}` } : {}) } });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const tag = Date.now().toString(36);
const reg = async (u) => (await call('/api/auth/register', { method: 'POST', body: { username: u, password: 'secret123' } })).body.token;
// A tiny real JPEG header, padded: what the photo route accepts.
const jpeg = 'data:image/jpeg;base64,' + Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(800, 7)]).toString('base64');

(async () => {
  try {
    const buyer = 'bb' + tag, seller = 'bs' + tag, other = 'bo' + tag;
    const tb = await reg(buyer), ts = await reg(seller), to = await reg(other);

    check('posting needs a sign-in', (await call('/api/bounties', { method: 'POST', body: { card: '2024 Prizm Bo Nix Silver', price: 60 } })).status === 401);
    const post = await call('/api/bounties', { method: 'POST', token: tb, body: { card: '2024 Prizm Bo Nix Silver', grade: 'Raw', price: 60, note: 'Centered please' } });
    const id = post.body && post.body.bounty && post.body.bounty.id;
    check('a collector posts a bounty', post.status === 200 && !!id && post.body.bounty.youPay === 62.4, JSON.stringify(post.body).slice(0, 160));
    const alerts = await call('/api/alerts', { token: tb });
    check('...and gets an eBay price alert for it at the offer', (alerts.body.alerts || []).some(a => a.priceThreshold === 60 && a.priceCondition === 'below' && /Bounty:/.test(a.label)));
    const board = await call('/api/bounties', { token: ts });
    check('the board lists it, with what a seller would get', board.body.open.some(b => b.id === id && b.youGet === 57.6) && board.body.payments === true);

    check('the poster cannot claim their own bounty', (await call(`/api/bounties/${id}/claim`, { method: 'POST', token: tb, body: {} })).status === 400);
    const up1 = await call('/api/bounties-photo', { method: 'POST', token: ts, body: { dataUrl: jpeg } });
    const up2 = await call('/api/bounties-photo', { method: 'POST', token: ts, body: { dataUrl: jpeg.replace('BwcH', 'CAgI') } });
    check('photos upload', /^\/bounty\/img\/[a-f0-9]{24}\.jpg$/.test(up1.body.url || ''), JSON.stringify(up1.body));
    check('a non-JPEG is refused', (await call('/api/bounties-photo', { method: 'POST', token: ts, body: { dataUrl: 'data:image/jpeg;base64,' + Buffer.from('<svg></svg>'.repeat(80)).toString('base64') } })).status === 400);
    const noConnect = await call(`/api/bounties/${id}/claim`, { method: 'POST', token: ts, body: { photos: [up1.body.url, up2.body.url] } });
    check('a seller without payouts is sent to set them up', noConnect.status === 400 && noConnect.body.connect === true);
    const conn = await call('/api/bounties-connect', { method: 'POST', token: ts });
    check('payout setup opens Stripe Connect onboarding', conn.body.url === 'https://connect.stripe.test/onboard' && calls.some(c => c[0] === 'acct' && c[1].type === 'express'));
    const claim = await call(`/api/bounties/${id}/claim`, { method: 'POST', token: ts, body: { photos: [up1.body.url, up1.body.url], note: 'Sleeved since pack' } });
    check('the seller claims it with photos', claim.status === 200 && claim.body.bounty.status === 'claimed', JSON.stringify(claim.body).slice(0, 200));
    check('a second seller cannot claim a claimed bounty', (await call(`/api/bounties/${id}/claim`, { method: 'POST', token: to, body: { photos: [up1.body.url, up1.body.url] } })).status >= 400);
    const seen = await call(`/api/bounties/${id}`, { token: tb });
    check('the buyer sees the photos before paying', seen.body.bounty.claim && seen.body.bounty.claim.photos.length === 2);
    const outsider = await call(`/api/bounties/${id}`, { token: to });
    check('an outsider does not see the claim', !outsider.body.bounty.claim);

    check('only the poster can pay', (await call(`/api/bounties/${id}/pay`, { method: 'POST', token: ts })).status === 409);
    const pay = await call(`/api/bounties/${id}/pay`, { method: 'POST', token: tb });
    const co = calls.find(c => c[0] === 'checkout');
    check('paying opens Checkout for the offer plus the buyer\'s 4%, with the address taken there', pay.body.url === 'https://checkout.stripe.test/pay'
      && co && co[1].line_items[0].price_data.unit_amount === 6240 && co[1].metadata.kind === 'bounty' && co[1].shipping_address_collection);
    await S._bountyPaid({ metadata: { kind: 'bounty', bountyId: id }, payment_intent: 'pi_test', amount_total: 6240,
      shipping_details: { name: 'Pat Buyer', address: { line1: '1 Main St', city: 'Denver', state: 'CO', postal_code: '80202' } } });
    const sv = await call(`/api/bounties/${id}`, { token: ts });
    check('once paid, the seller sees where to ship', sv.body.bounty.status === 'paid' && sv.body.bounty.claim.ship && sv.body.bounty.claim.ship.address.city === 'Denver');
    const bv = await call(`/api/bounties/${id}`, { token: tb });
    check('...the buyer\'s own view does not echo the address to anyone else', !outsider.body.bounty.claim && bv.body.bounty.status === 'paid');
    const alerts2 = await call('/api/alerts', { token: tb });
    check('the bounty\'s eBay alert goes once it is paid', !(alerts2.body.alerts || []).some(a => /Bounty:/.test(a.label)));

    check('shipping needs tracking', (await call(`/api/bounties/${id}/ship`, { method: 'POST', token: ts, body: { carrier: 'USPS', tracking: '12' } })).status === 400);
    const ship = await call(`/api/bounties/${id}/ship`, { method: 'POST', token: ts, body: { carrier: 'USPS', tracking: '9400 1000 0000 0000 0000 00' } });
    check('the seller marks it shipped', ship.body.bounty.status === 'shipped');
    const got = await call(`/api/bounties/${id}/received`, { method: 'POST', token: tb });
    const tr = calls.find(c => c[0] === 'transfer');
    check('it arrives: the seller is paid the offer minus 4%, from the buyer\'s charge, once', got.body.bounty.status === 'complete'
      && tr && tr[1].amount === 5760 && tr[1].destination === 'acct_test' && tr[1].source_transaction === 'ch_test' && tr[2].idempotencyKey === 'bounty-release-' + id);
    const rate = await call(`/api/bounties/${id}/rate`, { method: 'POST', token: tb, body: { stars: 5 } });
    check('the buyer rates the seller', rate.status === 200 && (await call(`/api/bounties/${id}/rate`, { method: 'POST', token: tb, body: { stars: 5 } })).status === 409);

    // A second deal: the cap, a dispute, the owner's refund.
    const big = await call('/api/bounties', { method: 'POST', token: tb, body: { card: '2023 Prizm CJ Stroud Silver Prizm', grade: 'PSA 10', price: 400 } });
    const capped = await call(`/api/bounties/${big.body.bounty.id}/claim`, { method: 'POST', token: ts, body: { photos: [up1.body.url, up1.body.url], cert: '87654321' } });
    check('a seller with one sale cannot take a $400 bounty yet', capped.status === 400 && /up to \$100/.test(capped.body.error), capped.body.error);
    const b2 = (await call('/api/bounties', { method: 'POST', token: tb, body: { card: '2024 Select Jayden Daniels Concourse', grade: 'Raw', price: 40 } })).body.bounty.id;
    await call(`/api/bounties/${b2}/claim`, { method: 'POST', token: ts, body: { photos: [up1.body.url, up1.body.url] } });
    await call(`/api/bounties/${b2}/pay`, { method: 'POST', token: tb });
    await S._bountyPaid({ metadata: { kind: 'bounty', bountyId: b2 }, payment_intent: 'pi_test2', amount_total: 4160 });
    await call(`/api/bounties/${b2}/ship`, { method: 'POST', token: ts, body: { carrier: 'USPS', tracking: '9400111111111111' } });
    const disp = await call(`/api/bounties/${b2}/dispute`, { method: 'POST', token: tb, body: { reason: 'The card arrived with a bent corner not in the photos.' } });
    check('the buyer opens a dispute and the payment is held', disp.body.bounty.status === 'disputed');
    check('the owner\'s desk is admin-only', (await call(`/api/admin/bounties/${b2}/resolve`, { method: 'POST', body: { action: 'refund' } })).status === 401);
    const before = calls.filter(c => c[0] === 'transfer').length;
    const tick = await S.bountyTick({ now: Date.now() + 30 * B.DAY, notify: false });
    check('the clock never pays out a disputed deal', calls.filter(c => c[0] === 'transfer').length === before, JSON.stringify(tick));

    // An unpaid claim lapses; an unshipped card is refunded.
    const b3 = (await call('/api/bounties', { method: 'POST', token: tb, body: { card: '2024 Mosaic Malik Nabers Genesis', grade: 'Raw', price: 30 } })).body.bounty.id;
    await call(`/api/bounties/${b3}/claim`, { method: 'POST', token: ts, body: { photos: [up1.body.url, up1.body.url] } });
    await S.bountyTick({ now: Date.now() + 49 * 3600e3, notify: false });
    check('a claim the buyer does not pay for reopens the bounty', (await S._bountyGet(b3)).status === 'open');
    const b4 = (await call('/api/bounties', { method: 'POST', token: tb, body: { card: '2024 Phoenix Brock Bowers Fire Burst', grade: 'Raw', price: 25 } })).body.bounty.id;
    await call(`/api/bounties/${b4}/claim`, { method: 'POST', token: ts, body: { photos: [up1.body.url, up1.body.url] } });
    await call(`/api/bounties/${b4}/pay`, { method: 'POST', token: tb });
    await S._bountyPaid({ metadata: { kind: 'bounty', bountyId: b4 }, payment_intent: 'pi_test4', amount_total: 2600 });
    await S.bountyTick({ now: Date.now() + 6 * B.DAY, notify: false });
    const r4 = calls.find(c => c[0] === 'refund' && c[1].payment_intent === 'pi_test4');
    check('a paid card not shipped in 5 days is refunded in full', (await S._bountyGet(b4)).status === 'refunded' && !!r4);
    const b5 = (await call('/api/bounties', { method: 'POST', token: tb, body: { card: '2025 Donruss Cam Ward Rated Rookie', grade: 'Raw', price: 12 } })).body.bounty.id;
    await S.bountyTick({ now: Date.now() + 31 * B.DAY, notify: false });
    check('an open bounty ends after its days', (await S._bountyGet(b5)).status === 'expired');
    const renew = await call(`/api/bounties/${b5}/renew`, { method: 'POST', token: tb });
    check('...and is posted again with one tap', renew.body.bounty && renew.body.bounty.status === 'open');
    check('only the poster can take one down', (await call(`/api/bounties/${b5}/cancel`, { method: 'POST', token: to })).status === 403);

    // Collectors holding the card hear about a new bounty.
    await S._userSyncSave(other, { cardHuddleInventory: { items: [{ id: 'h1', name: `2022 Prizm Brock Purdy Silver Prizm RC #307 lot${tag}`, qty: 1, value: 80 }] } }, null);
    const b6 = (await call('/api/bounties', { method: 'POST', token: tb, body: { card: `2022 Prizm Brock Purdy Silver lot${tag}`, grade: 'Raw', price: 90 } })).body.bounty.id;
    await S.bountyTick({ notify: true });
    const n6 = await S._bountyGet(b6);
    check('collectors with the card in Inventory are told about the bounty, once', n6.notified === true && n6.notifiedCount === 1, JSON.stringify({ n: n6.notified, c: n6.notifiedCount }));

    process.env.BOUNTY_PAYMENTS = '';
    const off = await call(`/api/bounties/${b5}/claim`, { method: 'POST', token: ts, body: { photos: [up1.body.url, up1.body.url] } });
    check('with payments off, the board runs but claiming waits', off.status === 503 && (await call('/api/bounties')).body.payments === false);
  } finally {
    server.close();
  }

  const srv = read('server.js'), w = read('worker.js'), html = read('public/index.html');
  check('the webhook takes bounty payments before plan logic, and holds chargebacks', /session\.metadata\?\.kind === 'bounty'\) \{ await _bountyPaid\(session\); break; \}/.test(srv) && /case 'charge\.dispute\.created'/.test(srv));
  check('the cron runs the bounty clock', /await bountyTick\(\{ notify: aliasTick \}\)/.test(w) && /env\.PHOTOS\.get\('bounty\/' \+ name\)/.test(w));
  check('the app has the Bounties tab and loads bounties.js', /data-view="bounties"/.test(html) && /<script src="bounties\.js\?v=[a-z0-9]+"><\/script>/.test(html) && /id="bounties-view"/.test(html));
  check('the admin page decides disputes', /function resolveBounty\(/.test(read('public/admin.html')));

  console.log(failures ? `\n${failures} bounty check(s) failed` : '\nall bounty checks passed');
  process.exit(failures ? 1 : 0);
})();
