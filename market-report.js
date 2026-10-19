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

// The index moves a point or two a week; rounding that to a whole percent
// hides most of it.
const pct1 = (n) => `${n > 0 ? '+' : ''}${(Math.round(n * 10) / 10).toFixed(1)}%`;
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
// Weeks filed before movers were medians with a 5-sale floor (Oct 2026) keep
// their sales boards; their risers and fallers are withdrawn, not shown wrong.
const moversWithdrawn = (c) => !!c && c.moversCalc !== 'median' && !!(((c.risers || []).length) || ((c.fallers || []).length));
const shownMovers = (c) => (moversWithdrawn(c) ? { ...c, risers: [], fallers: [] } : c);
function reportSummary(c) {
  c = shownMovers(c);
  const bits = [`${(c.sales || 0).toLocaleString('en-US')} football card sales tracked, ${money(c.value)} changed hands`];
  const top = c.risers && c.risers[0];
  if (top) bits.push(`biggest riser ${top.name || top.player} ${pct(top.changePct)}`);
  const cold = c.fallers && c.fallers[0];
  if (cold) bits.push(`biggest drop ${cold.name || cold.player} ${pct(cold.changePct)}`);
  return bits.join('; ') + '.';
}

// The deeper lists the page shows when the week was filed with them (Oct
// 2026); weeks filed before that carry only the email's short lists.
const lists = (c) => {
  const m = (c && c.more) || {};
  const pick = (k) => (Array.isArray(m[k]) && m[k].length ? m[k] : (c && c[k]) || []);
  return { risers: pick('risers'), fallers: pick('fallers'), players: pick('players'),
           mostSold: pick('mostSold'), priciest: pick('priciest'), sets: pick('sets') };
};
const cardYear = (name) => { const m = /^(\d{4})\b/.exec(String(name || '').trim()); return m ? +m[1] : null; };
const change = (now, then) => (then > 0 && Number.isFinite(now) ? ((now - then) / then) * 100 : null);

// A few plain sentences a reader takes away, each built from a figure on the
// page below it. A line whose evidence is thin is left out, not padded.
function takeaways(c, prev, year) {
  const L = lists(c);
  const out = [];
  const mk = c.market || {};
  if (mk.d7 && Number.isFinite(mk.d7.changePct)) {
    const m30 = mk.d30 && Number.isFinite(mk.d30.changePct) ? ` (${pct1(mk.d30.changePct)} over 30 days)` : '';
    out.push(`The slab market index moved ${pct1(mk.d7.changePct)} this week${m30}.`);
  }
  if (prev && prev.sales > 0 && c.sales > 0) {
    const d = change(c.sales, prev.sales);
    if (d != null && Math.abs(d) >= 1) {
      out.push(`Sales were ${d > 0 ? 'up' : 'down'} ${Math.abs(Math.round(d))}% on last week: ${c.sales.toLocaleString('en-US')} against ${prev.sales.toLocaleString('en-US')}.`);
    }
  }
  const top = L.risers[0];
  if (top) {
    const span = top.older > 0 && top.recent > 0 ? `, from ${money(top.older)} to ${money(top.recent)}` : '';
    out.push(`${top.name || top.player} led the risers${span} (${pct(top.changePct)} on ${top.sales} sales).`);
  }
  if (year && L.mostSold.length >= 5) {
    const fresh = L.mostSold.filter(r => (cardYear(r.name) || 0) >= year - 1).length;
    if (fresh * 2 >= L.mostSold.length) {
      out.push(`${fresh} of the ${L.mostSold.length} most-traded cards are from ${year - 1} or ${year} sets.`);
    }
  }
  const graded = L.priciest.filter(r => r.grade && r.grade !== 'Raw');
  if (L.priciest.length >= 4) {
    const tens = graded.filter(r => /\b10\b/.test(r.grade)).length;
    if (tens >= 2) out.push(`Gem mint 10s were ${tens} of the ${L.priciest.length} biggest sales.`);
  }
  const set = L.sets[0];
  if (set && (set.sales || set.n)) {
    out.push(`${set.name || set.query} was the busiest set: ${(set.sales || set.n).toLocaleString('en-US')} sales${set.avgPrice ? ` at an average of ${money(set.avgPrice)}` : ''}.`);
  }
  return out.slice(0, 5);
}

// A small line of the index over the month, for the stats strip.
function sparkline(series) {
  const s = (series || []).filter(Number.isFinite);
  if (s.length < 3) return '';
  const w = 96, h = 28, lo = Math.min(...s), hi = Math.max(...s), span = hi - lo || 1;
  const pts = s.map((v, i) => `${(i * w / (s.length - 1)).toFixed(1)},${(h - 2 - (v - lo) * (h - 4) / span).toFixed(1)}`).join(' ');
  const up = s[s.length - 1] >= s[0];
  return `<svg class="mm-spark ${up ? 'up' : 'down'}" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true"><polyline fill="none" stroke-width="2" points="${pts}"/></svg>`;
}

// The page body (inside the site shell). `adUnit` is placed after the first
// section, once. `prev` is the week before's content, when one was filed.
function renderReportBody(c, { week, builtAt, site, adUnit = '', archive = [], prev = null }) {
  const withdrawn = moversWithdrawn(c);
  c = shownMovers(c);
  const P = prev ? shownMovers(prev) : null;
  const L = lists(c);
  const href = (q) => `${site}/?q=${encodeURIComponent(q)}&utm_source=report&utm_medium=web&utm_campaign=${encodeURIComponent(week)}`;
  const ended = weekEnding(week, builtAt);
  const year = ended ? ended.getUTCFullYear() : null;
  // On a list last week? Movers not on it are marked new.
  const lastWeek = new Set(P ? [...lists(P).risers, ...lists(P).fallers].map(r => r.name || r.player) : []);
  const isNew = (r) => !!P && !lastWeek.has(r.name || r.player);
  const row = (link, img, name, detail, right, cls, { ebay = false, rank = null, bar = null, badge = '' } = {}) => `
      <li class="mm-row"><a href="${esc(link)}"${ebay ? ' target="_blank" rel="noopener sponsored"' : ''}>
        ${rank != null ? `<span class="mm-rank">${rank}</span>` : ''}
        ${img ? `<img src="${esc(img)}" alt="" loading="lazy" width="44" height="60">` : '<span class="mm-noimg"></span>'}
        <span class="mm-text"><strong>${esc(name)}${badge}</strong><span>${esc(detail)}</span>${ebay ? '<span class="mm-ebay">View on eBay &#8599;</span>' : ''}${bar != null ? `<span class="mm-bar ${cls || ''}"><i style="width:${bar}%"></i></span>` : ''}</span>
        <span class="mm-right ${cls || ''}">${esc(right)}</span>
      </a></li>`;
  const barOf = (list) => { const max = Math.max(1, ...list.map(r => Math.abs(r.changePct) || 0)); return (r) => Math.max(4, Math.round(Math.abs(r.changePct) / max * 100)); };
  const span = (r) => (r.older > 0 && r.recent > 0 ? `${money(r.older)} → ${money(r.recent)} · ` : '');
  const NEW = '<em class="mm-new">New</em>';
  const riseBar = barOf(L.risers), fallBar = barOf(L.fallers), playerBar = barOf(L.players);
  const sections = [
    ['Biggest risers', 'Raw base cards from 1990 on: median sale at the start of the week against the end', L.risers.map((r, i) =>
      row(href(r.query), r.imageUrl, r.name || r.player, `${span(r)}${r.sales} sales`, pct(r.changePct), 'up',
        { rank: i + 1, bar: riseBar(r), badge: isNew(r) ? NEW : '' }))],
    ['Players on the move', 'Repeat sales of the same cards, last 30 days', L.players.map((r, i) =>
      row(href(r.query), null, r.player, `${r.resales || 0} repeat sales`, pct(r.changePct), 'up', { rank: i + 1, bar: playerBar(r) }))],
    ['Cooling off', 'Worth a look if you are buying', L.fallers.map((r, i) =>
      row(href(r.query), r.imageUrl, r.name || r.player, `${span(r)}${r.sales} sales`, pct(r.changePct), 'down',
        { rank: i + 1, bar: fallBar(r), badge: isNew(r) ? NEW : '' }))],
    ['Most sold', 'The cards everyone traded this week', L.mostSold.map((r, i) =>
      row(href(r.query), r.imageUrl, r.name, `${r.sales} sales · avg ${money(r.avgPrice)}`, `${money(r.topPrice)} top`, '', { rank: i + 1 }))],
    ['Biggest sales', 'The week’s priciest cards', L.priciest.map((r, i) => {
      const e = ebayLink(r.itemUrl);
      return row(e || site, r.imageUrl, r.title, r.grade && r.grade !== 'Raw' ? r.grade : 'Sold on eBay', money(r.price), '', { ebay: !!e, rank: i + 1 });
    })],
    ['Hottest sets', 'Most sales this week', L.sets.map((r, i) =>
      row(href(r.query), null, r.name || r.query, `${(r.sales || r.n || 0).toLocaleString('en-US')} sales${r.players ? ` · ${r.players} players` : ''}`, r.avgPrice ? `avg ${money(r.avgPrice)}` : '', '', { rank: i + 1 }))],
  ].filter(s => s[2].length);

  // Three cards to open on, with their photos: the week at a glance.
  const tile = (label, link, img, name, big, sub, cls, ebay) => `
      <a class="mm-tile" href="${esc(link)}"${ebay ? ' target="_blank" rel="noopener sponsored"' : ''}>
        ${img ? `<img src="${esc(img)}" alt="" loading="lazy" width="96" height="132">` : '<span class="mm-tile-noimg"></span>'}
        <span class="mm-tile-text"><span class="mm-tile-label">${esc(label)}</span><strong>${esc(name)}</strong>
          <span class="mm-tile-big ${cls || ''}">${esc(big)}</span><span class="mm-tile-sub">${esc(sub)}</span></span>
      </a>`;
  const r0 = L.risers[0], p0 = L.priciest[0], m0 = L.mostSold[0];
  const tiles = [
    r0 && tile('Biggest riser', href(r0.query), r0.imageUrl, r0.name || r0.player, pct(r0.changePct),
      r0.older > 0 && r0.recent > 0 ? `${money(r0.older)} → ${money(r0.recent)}` : `${r0.sales} sales`, 'up'),
    p0 && tile('Biggest sale', ebayLink(p0.itemUrl) || site, p0.imageUrl, p0.title, money(p0.price),
      p0.grade && p0.grade !== 'Raw' ? p0.grade : 'Sold on eBay', '', !!ebayLink(p0.itemUrl)),
    m0 && tile('Most traded', href(m0.query), m0.imageUrl, m0.name, `${m0.sales} sales`, `avg ${money(m0.avgPrice)}`),
  ].filter(Boolean);

  // The strip: this week's totals, against last week's where one was filed.
  const delta = (now, then) => {
    const d = change(now, then);
    if (d == null || Math.abs(d) < 1) return '';
    return ` <em class="mm-delta ${d > 0 ? 'up' : 'down'}">${d > 0 ? '▲' : '▼'} ${Math.abs(Math.round(d))}%</em>`;
  };
  const mk = (c.market && c.market.d7) || null;
  const stats = [
    `<span><strong>${esc((c.sales || 0).toLocaleString('en-US'))}</strong> sales${P ? delta(c.sales, P.sales) : ''}</span>`,
    `<span><strong>${esc(money(c.value))}</strong> changed hands${P ? delta(c.value, P.value) : ''}</span>`,
    `<span><strong>${esc(money(c.avg))}</strong> average sale</span>`,
    mk ? `<span class="mm-index"><strong class="${mk.changePct >= 0 ? 'up' : 'down'}">${esc(pct1(mk.changePct))}</strong> slab market index${sparkline(c.market.d30 && c.market.d30.series || mk.series)}</span>` : '',
  ].filter(Boolean).join('');
  const notes = takeaways(c, P, year);

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
    <p class="mm-stats">${stats}</p>
  </div>${tiles.length ? `
  <div class="mm-tiles">${tiles.join('')}</div>` : ''}${notes.length ? `
  <section class="mm-brief"><h2>The week in brief</h2><ul>${notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul></section>` : ''}${withdrawn ? '<p class="mm-method">This week’s risers and fallers were computed on averages, which one odd sale can swing, and have been withdrawn. Movers are now medians with at least 5 sales at each end.</p>' : ''}${body}
  <p class="mm-method">Every figure is from completed eBay sales we track, not asking prices. Movers compare raw base cards from 1990 on by median sale at each end of the week, with at least 5 sales at each end; players compare repeat sales of the same cards; the market index follows graded cards. <a href="/methodology.html">How prices work</a>. Tap any card for its full sale history and copies for sale now.</p>
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
  '.mm-delta{font-style:normal;font-size:12.5px;font-weight:700;margin-left:4px}',
  '.mm-delta.up,.mm-index .up{color:#1b873f}.mm-delta.down,.mm-index .down{color:#c62828}',
  '.mm-index{display:inline-flex;align-items:center;gap:6px}',
  '.mm-spark polyline{stroke:#1b873f}.mm-spark.down polyline{stroke:#c62828}',
  '.mm-tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;max-width:720px;margin:22px 0 6px}',
  '.mm-tile{display:flex;gap:12px;padding:12px;border:1px solid var(--line);border-radius:12px;color:var(--fg);text-decoration:none;background:rgba(94,206,153,.04)}',
  '.mm-tile:hover{border-color:#5ece99}',
  '.mm-tile img,.mm-tile-noimg{width:72px;height:100px;border-radius:6px;object-fit:cover;flex:none;background:rgba(127,127,127,.15)}',
  '.mm-tile-text{display:flex;flex-direction:column;gap:3px;min-width:0;font-size:13.5px}',
  '.mm-tile-text strong{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;line-height:1.3}',
  '.mm-tile-label{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--fg3);font-weight:700}',
  '.mm-tile-big{font-size:22px;font-weight:800}.mm-tile-big.up{color:#1b873f}',
  '.mm-tile-sub{font-size:12.5px;color:var(--fg3)}',
  '.mm-brief{max-width:720px;margin:24px 0;padding:14px 18px;border-left:4px solid #5ece99;background:rgba(94,206,153,.06);border-radius:0 10px 10px 0}',
  '.mm-brief h2{font-size:17px;margin:0 0 6px}',
  '.mm-brief ul{margin:0;padding-left:18px;font-size:14.5px;line-height:1.65}',
  '.mm-rank{width:20px;text-align:right;font-weight:800;color:var(--fg3);font-size:13px;flex:none}',
  '.mm-bar{display:block;height:4px;border-radius:2px;background:rgba(127,127,127,.15);margin-top:4px;max-width:220px}',
  '.mm-bar i{display:block;height:100%;border-radius:2px;background:#1b873f}.mm-bar.down i{background:#c62828}',
  '.mm-new{font-style:normal;font-size:10.5px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:#fff;background:#2d6a4f;border-radius:4px;padding:1px 5px;margin-left:6px;vertical-align:2px}',
  '.mm-ad{margin:24px 0;max-width:720px}',
  '.mm-ad-label{display:block;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--fg3);margin-bottom:4px}',
  '.mm-ad:has(ins[data-ad-status="unfilled"]){display:none}',
  '.ch-adfree .mm-ad{display:none}',
].join('\n');

module.exports = { takeaways, sparkline, moversWithdrawn, WEEK_RE, weekStart, weekEnding, reportTitle, reportSummary, renderReportBody, REPORT_CSS, ebayLink };
