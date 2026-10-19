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

  // ---- The page's depth and its week-at-a-glance (Oct 2026: it read thin) ----
  {
    const mv = (n, c, i) => ({ name: n, player: n, query: n, changePct: c, sales: 6 + i, older: 20, recent: Math.round(20 * (1 + c / 100)) });
    const w = { available: true, pricedSales: 63412, totalValue: 4521900, avgPrice: 71,
      cardMovers: Array.from({ length: 14 }, (_, i) => mv(`2025 Prizm Card ${i}`, 60 - i * 6, i)),
      mostSold: Array.from({ length: 12 }, (_, i) => ({ name: `${i < 7 ? 2025 : 2018} Prizm Seller ${i}`, query: `q${i}`, sales: 300 - i, avgPrice: 12, topPrice: 90 })),
      priciest: Array.from({ length: 9 }, (_, i) => ({ title: `Big Card ${i}`, price: 9000 - i, grade: i < 3 ? 'PSA 10' : 'BGS 9.5', itemUrl: 'https://www.ebay.com/itm/1' })),
      topSets: Array.from({ length: 7 }, (_, i) => ({ name: `Set ${i}`, query: `Set ${i}`, sales: 900 - i, avgPrice: 20 })) };
    const c = { ...digest.digestContent(w, month30), moversCalc: 'median',
      market: { d7: { changePct: 2.44, series: [100, 101, 100.5, 102] }, d30: { changePct: 6.1, series: [98, 99, 101, 102] } } };
    check('the email keeps its short lists', c.risers.length === 5 && c.mostSold.length === 3 && c.priciest.length === 3);
    check('  ...while the page gets the deeper ones', c.more.risers.length === 10 && c.more.mostSold.length === 10
      && c.more.priciest.length === 8 && c.more.sets.length === 6 && c.more.fallers.length <= 6);
    const prev = { ...digest.digestContent({ ...w, pricedSales: 57110, totalValue: 4012000, cardMovers: w.cardMovers.slice(2) }, month30), moversCalc: 'median' };
    const html = mreport.renderReportBody(c, { week: '2026-W43', builtAt: '2026-10-19T12:00:00Z', site: 'https://thecardhuddle.com', prev });
    check('three headliner tiles open the page: biggest riser, biggest sale, most traded',
      (html.match(/class="mm-tile"/g) || []).length === 3 && /Biggest riser/.test(html) && /Biggest sale/.test(html) && /Most traded/.test(html));
    check('  ...the riser shown with its prices at each end', /\$20 → \$32/.test(html));
    check('sales and dollars are compared with last week', /63,412<\/strong> sales <em class="mm-delta up">▲ 11%<\/em>/.test(html)
      && /changed hands <em class="mm-delta up">▲ 13%<\/em>/.test(html));
    check('  ...and a mover missing from last week\'s lists is marked new, one that was there is not',
      /2025 Prizm Card 0<em class="mm-new">New<\/em>/.test(html) && !/2025 Prizm Card 3<em class="mm-new">/.test(html));
    check('the slab market index is in the strip, to a tenth, with its line', /\+2\.4%<\/strong> slab market index<svg class="mm-spark up"/.test(html));
    const brief = (html.match(/<section class="mm-brief">([\s\S]*?)<\/section>/) || [])[1] || '';
    check('the week in brief says what the figures below it show',
      /slab market index moved \+2\.4% this week \(\+6\.1% over 30 days\)/.test(brief)
      && /Sales were up 11% on last week: 63,412 against 57,110\./.test(brief)
      && /7 of the 10 most-traded cards are from 2025 or 2026 sets\./.test(brief)
      && /Gem mint 10s were 3 of the 8 biggest sales\./.test(brief), brief.replace(/<[^>]+>/g, ' | '));
    check('  ...and leaves out a line the week cannot support',
      !/most-traded cards are from/.test(mreport.renderReportBody({ ...c, more: { ...c.more, mostSold: c.more.mostSold.map(r => ({ ...r, name: '2018 ' + r.name.slice(5) })) } },
        { week: '2026-W43', builtAt: '2026-10-19T12:00:00Z', site: 'x' })));
    check('movers carry their rank and a bar sized by the move', /<span class="mm-rank">10<\/span>/.test(html)
      && /<span class="mm-bar up"><i style="width:100%"><\/i><\/span>/.test(html));
    // A week filed before any of this: the short lists, no prev, no index.
    const old = mreport.renderReportBody({ ...c, more: undefined, market: undefined }, { week: '2026-W42', builtAt: '2026-10-12T12:00:00Z', site: 'x' });
    check('a week filed before the deeper lists still renders, from the short ones',
      /<span class="mm-rank">5<\/span>/.test(old) && !/<span class="mm-rank">6<\/span>/.test(old)
        && !/mm-delta/.test(old) && !/slab market index/.test(old) && !/class="mm-new"/.test(old));
  }

  server.close();
  console.log(failures ? `\n${failures} check(s) failed` : '\nall market-report checks passed');
  process.exit(failures ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
