// A card that has not sold in over a week is priced at its recent price,
// moved by its player's market since its last sale — on the card page, and
// on the sold-search version cards, which read the same player index.
const path = require('path');
const fs = require('fs');
process.env.CF_WORKER = '1';
const S = require(path.join(__dirname, '..', 'server.js'));

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};
const DAY = 86400000;
const iso = (d) => new Date(Date.UTC(2026, 8, 1) + d * DAY).toISOString().slice(0, 10);
const dayOf = (s) => Math.floor(Date.parse(s + 'T00:00:00Z') / DAY);

// A player index that rose 10% across September.
const series = [];
for (let d = 0; d <= 20; d++) series.push({ date: iso(d), score: 100 + d * 0.5 });

const r = S._marketRatioFrom(series, dayOf(iso(10)));
check('the move runs from the level on the last sale to the latest level',
  r && Math.abs(r.ratio - 110 / 105) < 1e-9 && r.fromDate === iso(10), JSON.stringify(r));
const before = S._marketRatioFrom(series, dayOf(iso(-40)));
check('  ...from the first level when the sale predates the series',
  before && before.fromDate === iso(0) && Math.abs(before.ratio - 1.1) < 1e-9, JSON.stringify(before));
const wild = S._marketRatioFrom([{ date: iso(0), score: 100 }, { date: iso(5), score: 400 }], dayOf(iso(0)));
check('  ...capped, like the old trend adjustment', wild && wild.ratio === 1.5 && wild.clamped, JSON.stringify(wild));

// One grade's sales: last sold on day 5 at $100 and $110, the player's
// market since then read off the series above.
const adj = (fromDay) => S._marketRatioFrom(series, fromDay);
const sale = (d, p) => ({ sold_date: iso(d), price_cents: p * 100 });
const now = dayOf(iso(20));
const stale = S._marketEstimate([sale(5, 100), sale(4, 110), sale(-60, 40)], now, adj);
check('a card unsold for over a week is its recent price moved by the market',
  stale && stale.method === 'market-adjusted' && stale.unadjustedPrice === 105
  && Math.abs(stale.price - 105 * (110 / 102.5)) < 0.01 && stale.newestSaleDays === 15,
  JSON.stringify(stale));
check('  ...its recent price leaves out sales from long before its last one',
  stale && stale.basedOn === 2);
const fresh = S._marketEstimate([sale(16, 100)], now, adj);
check('a card that sold this week keeps its sales price', fresh === null, JSON.stringify(fresh));
check('  ...and without a player market there is nothing to move it by',
  S._marketEstimate([sale(5, 100)], now, null) === null);

// ---- the comp value: the last sale, or an average of close-together ones ----
{
  const day = (d, p) => ({ day: dayOf(iso(d)), price: p });
  const one = S._compValue([day(10, 300), day(2, 200), day(1, 100)]);
  check('one recent sale is the price, whatever sold before it',
    one && one.price === 300 && one.basis === 'last-comp', JSON.stringify(one));
  const three = S._compValue([day(10, 300), day(9, 330), day(7, 360), day(2, 100)]);
  check('  ...several within three days of it are averaged',
    three && three.price === 330 && three.count === 3 && three.basis === 'recent-average', JSON.stringify(three));
  const g = S._estimateGrade([sale(19, 120), sale(12, 80), sale(11, 90)], now, null);
  check('the card page prices a recently sold card off its last comp, not a median',
    g && g.method === 'recent-sales' && g.price === 120 && g.compBasis === 'last-comp', JSON.stringify(g));
}

// The page wiring: the sold-search version cards use the same rule.
const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
check('the version cards headline the comp value',
  /const comp = _compOf\(priced\);/.test(src) && /function _compOf\(/.test(src) && /const COMP_RECENT_DAYS = 3;/.test(src));
check('the card page explains a market-adjusted price',
  /'market-adjusted': \{ label: 'Estimated'/.test(src));
check('the version cards price a stale version off the player index',
  /\/api\/player-index\?/.test(src.slice(src.indexOf("function _versionMarket"), src.indexOf("function _versionMarket") + 3000)) && /_versionMarketPrice\(card, priced, v\)/.test(src));

console.log(failures ? `\n${failures} check(s) failed` : '\nall market-estimate checks passed');
process.exit(failures ? 1 : 0);
