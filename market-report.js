// The weekly Market Movers report, as a public page (owner, Oct 2026).
//
// AI can answer "how do I grade a card"; it cannot know what cards sold for
// last week. This page is that: the week's risers and fallers, the players
// moving, the most-traded and the dearest sales, all from our own sold data.
// The content is the weekly digest email's (market-digest.js digestContent),
// so the email and the page always agree; this renders it for the web.
//
// Each week is kept as it stood (server.js snapshots it), so
// /news/market-movers/2026-W42 always reads the same, and the archive grows a
// page a week rather than hundreds of filler pages at once.
'use strict';

const { money, pct, esc } = (() => {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (n) => {
    const v = Number(n) || 0;
    if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
    if (v >= 10000) return `$${Math.round(v / 1000)}K`;
    return `$${Math.round(v).toLocaleString('en-US')}`;
  };
  const pct = (n) => `${n > 0 ? '+' : ''}${Math.round(n)}%`;
  return { money, pct, esc };
})();

const WEEK_RE = /^(\d{4})-W(\d{2})$/;
const EPN_PARAMS = 'mkcid=1&mkrid=711-53200-19255-0&siteid=0&campid=5339145753&toolid=10001&mkevt=1';
// The eBay link from this page, labelled for the Partner Network report.
const ebayLink = (url) => (!url || !String(url).includes('ebay.com')) ? ''
  : url + (String(url).includes('?') ? '&' : '?') + EPN_PARAMS + '&customid=market-report';

// The Monday a week starts on (ISO weeks), as a Date at 00:00 UTC.
function weekStart(week) {
  const m = WEEK_RE.exec(String(week || ''));
  if (!m) return null;
  const y = +m[1], w = +m[2];
  const jan4 = new Date(Date.UTC(y, 0, 4));
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() || 7) - 1) + (w - 1) * 7);
  return monday;
}
const longDate = (d) => d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

// Named for the seven days the numbers cover, which end when the report was
// filed (`end`, the day before it was built: the boards are rebuilt overnight
// from sales up to the day before). "Week of October 19" for a report filed
// that Monday would name the week it did not cover.
function weekEnding(week, builtAt) {
  const b = builtAt ? new Date(builtAt) : null;
  if (b && !isNaN(b)) { const d = new Date(Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate() - 1)); return d; }
  const start = weekStart(week);
  return start ? new Date(start.getTime() - 86400000) : null;
}
function reportTitle(week, builtAt) {
  const d = weekEnding(week, builtAt);
  return `Football Card Market Movers: Week Ending ${d ? longDate(d) : week}`;
}

// One sentence a reader (or an AI answer quoting us) can take away.
function reportSummary(c) {
  const bits = [`${(c.sales || 0).toLocaleString('en-US')} football card sales tracked, ${money(c.value)} changed hands`];
  const top = c.risers && c.risers[0];
  if (top) bits.push(`biggest riser ${top.name || top.player} ${pct(top.changePct)}`);
  const cold = c.fallers && c.fallers[0];
  if (cold) bits.push(`biggest drop ${cold.name || cold.player} ${pct(cold.changePct)}`);
  return bits.join('; ') + '.';
}

// The page body (inside the site shell). `adUnit` is placed after the first
// section, once.
function renderReportBody(c, { week, builtAt, site, adUnit = '', archive = [] }) {
  const L = (q) => `${site}/?q=${encodeURIComponent(q)}&utm_source=report&utm_medium=web&utm_campaign=${encodeURIComponent(week)}`;
  const row = (href, img, name, detail, right, cls, ebay) => `
      <li class="mm-row"><a href="${esc(href)}"${ebay ? ' target="_blank" rel="noopener sponsored"' : ''}>
        ${img ? `<img src="${esc(img)}" alt="" loading="lazy" width="44" height="60">` : '<span class="mm-noimg"></span>'}
        <span class="mm-text"><strong>${esc(name)}</strong><span>${esc(detail)}</span>${ebay ? '<span class="mm-ebay">View on eBay &#8599;</span>' : ''}</span>
        <span class="mm-right ${cls || ''}">${esc(right)}</span>
      </a></li>`;
  const sections = [
    ['Biggest risers', 'Raw base cards, this week against last', (c.risers || []).map(r =>
      row(L(r.query), r.imageUrl, r.name || r.player, `${r.sales} sales`, pct(r.changePct), 'up'))],
    ['Players on the move', 'Repeat sales of the same cards, last 30 days', (c.players || []).map(r =>
      row(L(r.query), null, r.player, `${r.resales || 0} repeat sales`, pct(r.changePct), 'up'))],
    ['Cooling off', 'Worth a look if you are buying', (c.fallers || []).map(r =>
      row(L(r.query), r.imageUrl, r.name || r.player, `${r.sales} sales`, pct(r.changePct), 'down'))],
    ['Most sold', 'The cards everyone traded this week', (c.mostSold || []).map(r =>
      row(L(r.query), r.imageUrl, r.name, `${r.sales} sales · avg ${money(r.avgPrice)}`, `${money(r.topPrice)} top`))],
    ['Biggest sales', 'The week’s priciest cards', (c.priciest || []).map(r => {
      const e = ebayLink(r.itemUrl);
      return row(e || site, r.imageUrl, r.title, r.grade && r.grade !== 'Raw' ? r.grade : 'Sold on eBay', money(r.price), '', !!e);
    })],
    ['Hottest sets', 'Most sales this week', (c.sets || []).map(r =>
      row(L(r.query), null, r.name || r.query, `${r.sales || r.n || 0} sales`, r.avgPrice ? `avg ${money(r.avgPrice)}` : ''))],
  ].filter(s => s[2].length);
  let placed = false;
  const body = sections.map(([title, sub, rows], i) => {
    const html = `
    <section class="mm-section"><h2>${esc(title)}</h2><p class="mm-sub">${esc(sub)}</p><ul class="mm-list">${rows.join('')}</ul></section>`;
    if (!placed && adUnit && i === 0) { placed = true; return html + adUnit; }
    return html;
  }).join('');
  // archive: [{ week, builtAt }], newest first.
  const others = archive.filter(x => x.week !== week).slice(0, 8);
  return `
  <div class="mm-head"><span class="kicker">Market Movers</span>
    <h1>${esc(reportTitle(week, builtAt))}</h1>
    <p class="lede">${esc(reportSummary(c))}</p>
    <p class="mm-stats"><span><strong>${esc((c.sales || 0).toLocaleString('en-US'))}</strong> sales</span><span><strong>${esc(money(c.value))}</strong> changed hands</span><span><strong>${esc(money(c.avg))}</strong> average sale</span></p>
  </div>${body}
  <p class="mm-method">Every figure is from completed eBay sales we track, not asking prices. Movers compare raw base cards' average sale this week against last; players compare repeat sales of the same cards. <a href="/methodology.html">How prices work</a>. Tap any card for its full sale history and copies for sale now.</p>
  ${others.length ? `<section class="mm-section"><h2>Earlier weeks</h2><ul class="mm-archive">${others.map(x => `<li><a href="/news/market-movers/${esc(x.week)}">${esc(reportTitle(x.week, x.builtAt).replace('Football Card Market Movers: ', ''))}</a></li>`).join('')}</ul></section>` : ''}`;
}

const REPORT_CSS = [
  '.mm-head{padding:36px 0 8px}',
  '.mm-stats{display:flex;flex-wrap:wrap;gap:18px;font-size:14px;color:var(--fg2);margin:8px 0 0}',
  '.mm-stats strong{color:var(--fg);font-size:18px}',
  '.mm-section{margin:28px 0;max-width:720px}',
  '.mm-section h2{font-size:21px;margin:0}',
  '.mm-sub{margin:2px 0 10px;color:var(--fg3);font-size:13.5px}',
  '.mm-list{list-style:none;margin:0;padding:0;border-top:1px solid var(--line)}',
  '.mm-row a{display:flex;align-items:center;gap:12px;padding:10px 2px;border-bottom:1px solid var(--line);color:var(--fg);text-decoration:none}',
  '.mm-row a:hover{background:rgba(94,206,153,.05)}',
  '.mm-row img,.mm-noimg{width:44px;height:60px;border-radius:5px;object-fit:cover;flex:none;background:rgba(127,127,127,.15)}',
  '.mm-noimg{display:inline-block;width:6px;background:transparent}',
  '.mm-text{display:flex;flex-direction:column;gap:2px;flex:1;min-width:0;font-size:14.5px}',
  '.mm-text span{font-size:12.5px;color:var(--fg3)}',
  '.mm-text .mm-ebay{color:#2d6a4f;font-weight:700}',
  '.mm-right{font-weight:800;white-space:nowrap;font-size:15px}',
  '.mm-right.up{color:#1b873f}.mm-right.down{color:#c62828}',
  '.mm-method{max-width:720px;font-size:13px;color:var(--fg3);line-height:1.6}',
  '.mm-archive{list-style:none;padding:0;margin:0;display:flex;flex-wrap:wrap;gap:8px 18px;font-size:14px}',
  '.mm-ad{margin:24px 0;max-width:720px}',
  '.mm-ad-label{display:block;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--fg3);margin-bottom:4px}',
  '.mm-ad:has(ins[data-ad-status="unfilled"]){display:none}',
  '.ch-adfree .mm-ad{display:none}',
].join('\n');

module.exports = { WEEK_RE, weekStart, weekEnding, reportTitle, reportSummary, renderReportBody, REPORT_CSS, ebayLink };
