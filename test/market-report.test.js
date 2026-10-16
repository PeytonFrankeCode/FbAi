// The weekly Market Movers report page (owner, Oct 2026): our own sold data,
// the one kind of article AI cannot write, as a page a week, kept as it stood.
const path = require('path');

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

const store = new Map();
const dbMod = require(path.join(__dirname, '..', 'db.js'));
dbMod.cacheGet = async (k) => (store.has(k) ? JSON.parse(store.get(k)) : null);
dbMod.cachePut = async (k, v) => { store.set(k, JSON.stringify(v)); };
dbMod.getNflDb = () => null;
process.env.CF_WORKER = '1';
const mreport = require(path.join(__dirname, '..', 'market-report.js'));
const digest = require(path.join(__dirname, '..', 'market-digest.js'));
const S = require(path.join(__dirname, '..', 'server.js'));
const server = S.app.listen(0);
const port = server.address().port;
const get = async (p) => { const r = await fetch(`http://127.0.0.1:${port}${p}`); return { status: r.status, text: await r.text() }; };

const mover = (name, change, i) => ({ name, player: name.split(' ').slice(-2).join(' '), query: name, changePct: change, sales: 10 + i, imageUrl: 'https://i.ebayimg.com/images/g/x/s-l500.jpg' });
const week7 = {
  available: true, pricedSales: 21345, totalValue: 1234567, avgPrice: 58,
  cardMovers: [mover('2024 Prizm Bo Nix #309', 42, 1), mover('2024 Prizm Caleb Williams #301', 18, 2), mover('2023 Prizm C.J. Stroud #339', -22, 3), mover('2024 Donruss Jayden Daniels #389', 9, 4)],
  mostSold: [{ name: '2024 Prizm Jayden Daniels #326', query: '2024 Prizm Jayden Daniels', sales: 210, avgPrice: 31, topPrice: 400 }],
  priciest: [{ title: '2017 Prizm Patrick Mahomes II #269 Gold /10 PSA 10', price: 48000, grade: 'PSA 10', itemUrl: 'https://www.ebay.com/itm/123456789' }],
  topSets: [{ name: '2024 Prizm', query: '2024 Prizm', sales: 3021, avgPrice: 22 }],
};
const month30 = { available: true, playerMovers: [{ player: 'Bo Nix', query: 'Bo Nix', changePct: 12, resales: 80 }] };
store.set('soldstats:last:7', JSON.stringify(week7));
store.set('soldstats:last:30', JSON.stringify(month30));

(async () => {
  check('a week id is read back to its Monday', mreport.weekStart('2026-W42').toISOString().slice(0, 10) === '2026-10-12');
  check('  ...and the title names the days the numbers cover: the week ending the day before it was filed',
    mreport.reportTitle('2026-W43', '2026-10-19T14:00:00Z') === 'Football Card Market Movers: Week Ending October 18, 2026'
    && mreport.reportTitle('2026-W43') === 'Football Card Market Movers: Week Ending October 18, 2026');

  const week = digest.weekId(new Date());
  const r = await get('/news/market-movers');
  const isMondayEarly = new Date().getUTCDay() === 1 && new Date().getUTCHours() < 6;
  if (isMondayEarly) {
    check('before the Monday board rebuild, nothing is filed under the new week', r.status === 404);
  } else {
    check('the report page is served from the week\'s boards', r.status === 200 && /Football Card Market Movers: Week Ending/.test(r.text), String(r.status));
    check('  ...with a one-line summary a reader (or an AI answer) can quote',
      /21,345 football card sales tracked, \$1\.2M changed hands; biggest riser 2024 Prizm Bo Nix #309 \+42%; biggest drop 2023 Prizm C\.J\. Stroud #339 -22%\./.test(r.text));
    check('  ...risers, players, fallers, most sold, biggest sales and sets',
      ['Biggest risers', 'Players on the move', 'Cooling off', 'Most sold', 'Biggest sales', 'Hottest sets'].every(h => r.text.includes('<h2>' + h + '</h2>')));
    check('  ...each card linking to its search, the big sales to eBay labelled for the report',
      /href="https:\/\/thecardhuddle\.com\/\?q=2024%20Prizm%20Bo%20Nix%20%23309&amp;utm_source=report/.test(r.text)
      && /ebay\.com\/itm\/123456789\?[^"]*campid=5339145753[^"]*customid=market-report/.test(r.text) && /View on eBay/.test(r.text));
    check('  ...indexable, with Article structured data and one labelled ad unit',
      /<meta name="robots" content="index, follow">/.test(r.text) && /"@type":"Article"/.test(r.text)
      && (r.text.match(/data-ad-slot="4442737418"/g) || []).length === 1 && /pagead2\.googlesyndication\.com\/pagead\/js\/adsbygoogle\.js/.test(r.text));

    // Kept as it stood: next week's boards change, this week's page does not.
    store.set('soldstats:last:7', JSON.stringify({ ...week7, pricedSales: 1 }));
    const again = await get(`/news/market-movers/${week}`);
    check('a week is kept as it stood once filed', again.status === 200 && /21,345 football card sales/.test(again.text));
    const idx = await get('/news');
    check('the Guides page leads with the report', /Market Movers &middot; weekly/.test(idx.text) && /href="\/news\/market-movers"/.test(idx.text));
    const sm = await get('/sitemap-news.xml');
    check('the sitemap lists the report and its week', sm.text.includes('/news/market-movers</loc>') && sm.text.includes(`/news/market-movers/${week}</loc>`));
  }
  // A week filed without risers or fallers (the boards had none: sales a few
  // days behind) is filed again once they exist; a full week never is.
  if (!isMondayEarly) {
    store.delete(`mmreport:v1:${week}`);
    store.set('mmreport:index', JSON.stringify([]));
    const ms = (i) => ({ name: '2024 Prizm Card ' + i, query: '2024 Prizm Card ' + i, sales: 100 - i, avgPrice: 20, topPrice: 90 });
    store.set('soldstats:last:7', JSON.stringify({ ...week7, cardMovers: [], mostSold: [ms(1), ms(2), ms(3)] }));
    const thin = await get('/news/market-movers');
    check('a week with no movers is filed, marked partial', thin.status === 200 && !thin.text.includes('<h2>Biggest risers</h2>')
      && JSON.parse(store.get(`mmreport:v1:${week}`)).partial === true);
    store.set('soldstats:last:7', JSON.stringify(week7));
    const full = await get('/news/market-movers');
    check('  ...and filed again, whole, once the movers are in', full.text.includes('<h2>Biggest risers</h2>')
      && JSON.parse(store.get(`mmreport:v1:${week}`)).partial === false);
    // A week filed before the partial mark existed, with no movers, is
    // treated as partial too.
    const legacy = JSON.parse(store.get(`mmreport:v1:${week}`));
    store.set(`mmreport:v1:${week}`, JSON.stringify({ week, content: { ...legacy.content, risers: [], fallers: [] }, builtAt: legacy.builtAt }));
    const relegacy = await get('/news/market-movers');
    check('  ...including a week filed before the mark existed', relegacy.text.includes('<h2>Biggest risers</h2>'));
    store.set('soldstats:last:7', JSON.stringify({ ...week7, cardMovers: [mover('2020 Prizm Someone Else #1', 99, 9)] }));
    const kept = await get('/news/market-movers');
    check('  ...after which it is kept as it stood', kept.text.includes('2024 Prizm Bo Nix #309') && !kept.text.includes('Someone Else'));
  }
  // How people find it: the email, the home page and the Market tab.
  const mail = digest.renderDigest(digest.digestContent(week7, month30), { week: '2026-W42', unsubUrl: 'https://x/u', now: Date.parse('2027-01-01') });
  check('the Monday email links to that week\'s report page',
    /href="https:\/\/thecardhuddle\.com\/news\/market-movers\/2026-W42\?utm_source=digest/.test(mail.html) && /Read the full report/.test(mail.html)
    && /Read the full report: https:\/\/thecardhuddle\.com\/news\/market-movers\/2026-W42/.test(mail.text));
  const home = require('fs').readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  check('  ...and so do the home page and the Market tab',
    /class="mm-report-link" href="\/news\/market-movers\?utm_source=app&amp;utm_medium=home"/.test(home)
    && /class="mm-report-inline" href="\/news\/market-movers\?utm_source=app&amp;utm_medium=market"/.test(home));
  const missing = await get('/news/market-movers/2001-W01');
  check('a week never filed is a 404, not an empty page', missing.status === 404 && /noindex/.test(missing.text));
  const bad = await get('/news/market-movers/not-a-week');
  check('  ...and so is anything that is not a week', bad.status === 404);

  server.close();
  console.log(failures ? `\n${failures} check(s) failed` : '\nall market-report checks passed');
  process.exit(failures ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
