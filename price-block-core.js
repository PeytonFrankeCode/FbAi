// The price block that goes on the checklist and player pages, as pure logic.
//
// 2,173 pages are titled "Checklist & Prices". They carry a checklist and no
// prices, and the lede on each one says "tap any card to see what it's
// actually selling for" — a promise the page itself does not keep. This is
// what keeps it.
//
// Everything here is free of bindings: no D1, no KV, no HTMLRewriter. The
// caller runs the queries and does the writing. What lives here is the part
// that is easy to get quietly wrong — which average to use, what to do with
// too little data, and how to say what the number actually means.
'use strict';

// A page needs this much behind it before a number is worth printing.
//
// Below it the median is noise: three sales of a common base card say nothing
// about the fourth, and a page that prints "median $4.00" from three sales is
// worse than a page that prints nothing, because it looks authoritative. The
// thresholds match the ones /api/debug/price-coverage measured against, so the
// coverage figure and what actually renders cannot disagree.
const MIN_SALES = 20;
const MIN_CARDS = 10;

// How many cards get their own row.
//
// Eight is a block a reader takes in at a glance. It is also short enough that
// the whole map for ~950 pages stays a few hundred KB, which is what lets it
// live in one KV value instead of one per page.
const TOP_CARDS = 8;

// Median, not mean.
//
// A set's sales run from a $2 base card to a $900 one-of-one patch auto, and
// the mean of that is a number no card actually sold for. The median is what a
// typical card in the set trades at, which is the question a reader has.
function median(values) {
  const xs = values.filter(v => typeof v === 'number' && isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = xs.length >> 1;
  return xs.length % 2 ? xs[mid] : Math.round((xs[mid - 1] + xs[mid]) / 2);
}

function money(cents) {
  if (cents == null || !isFinite(cents)) return null;
  const d = cents / 100;
  // Whole dollars above $100: "$1,284" reads better than "$1,284.00", and the
  // cents are false precision on a median anyway.
  return d >= 100
    ? '$' + Math.round(d).toLocaleString('en-US')
    : '$' + d.toFixed(2);
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Turn one page's rows into the thing that gets stored.
//
// `rows` are per-card aggregates for a single page: { label, sales, median }.
// `totals` is the page-wide { sales, cards, median, low, high }.
//
// Returns null when the page does not clear the bar. Null means "render
// nothing at all" — never an empty widget with dashes in it, which is how a
// page ends up looking broken rather than looking quiet.
function summarise(totals, rows) {
  if (!totals) return null;
  const sales = Number(totals.sales || 0);
  const cards = Number(totals.cards || 0);
  if (sales < MIN_SALES || cards < MIN_CARDS) return null;
  if (totals.median == null) return null;

  return {
    sales, cards,
    median: totals.median,
    low: totals.low == null ? null : totals.low,
    high: totals.high == null ? null : totals.high,
    top: (rows || [])
      .filter(r => r && r.label && r.sales > 0 && r.median != null)
      .slice(0, TOP_CARDS)
      .map(r => ({ label: String(r.label), sales: Number(r.sales), median: Number(r.median) })),
  };
}

// The markup.
//
// Plain semantic HTML, no scripts, no classes the landing-page CSS does not
// already define. It is injected into a static page that a crawler reads
// without running JavaScript, so anything that needs JS to appear would be
// invisible to exactly the audience this exists for.
//
// `window` is the date range the numbers come from, and it is not decoration:
// a price with no date on it is a claim about the present that quietly rots.
function render(summary, opts) {
  if (!summary) return '';
  const o = opts || {};
  const noun = o.noun || 'this set';
  const from = o.from || '';
  const to = o.to || '';

  const range = (summary.low != null && summary.high != null && summary.low !== summary.high)
    ? ` <span class="lp-muted">(${esc(money(summary.low))}&ndash;${esc(money(summary.high))})</span>`
    : '';

  const dates = (from && to)
    ? `${esc(from)} to ${esc(to)}`
    : 'the recent sales window';

  let html = '';
  html += `<section class="lp-prices" id="sold-prices">\n`;
  html += `  <h2>Recent eBay sold prices</h2>\n`;
  html += `  <p class="lp-price-lede">`;
  html += `<strong>${summary.sales.toLocaleString('en-US')}</strong> completed sales `;
  html += `across <strong>${summary.cards.toLocaleString('en-US')}</strong> different cards in ${esc(noun)}, `;
  html += `${dates}. Median sale <strong>${esc(money(summary.median))}</strong>${range}.`;
  html += `</p>\n`;

  if (summary.top.length) {
    html += `  <table class="lp-price-table">\n`;
    html += `    <caption class="lp-muted">Most-traded cards, by number of completed sales</caption>\n`;
    html += `    <thead><tr><th scope="col">Card</th><th scope="col">Sales</th><th scope="col">Median</th></tr></thead>\n`;
    html += `    <tbody>\n`;
    for (const r of summary.top) {
      html += `      <tr><td>${esc(r.label)}</td><td>${r.sales.toLocaleString('en-US')}</td><td>${esc(money(r.median))}</td></tr>\n`;
    }
    html += `    </tbody>\n  </table>\n`;
  }

  // The honesty line. These are mixed conditions — a raw base card and a PSA
  // 10 of the same card are both in here — and saying so is the difference
  // between a price guide and a misleading one.
  html += `  <p class="lp-muted lp-price-note">Figures are medians of actual completed eBay sales in the period shown, `;
  html += `across all conditions and grades. They are sale records, not appraisals.</p>\n`;
  html += `</section>`;
  return html;
}

// The key a page looks itself up by. Kept here so the builder and the injector
// cannot disagree about it — they are in different files and one of them
// running with a stale idea of the format would simply render nothing, which
// is the kind of failure that goes unnoticed for weeks.
const keyFor = (kind, id) => `${kind}:${id}`;

module.exports = { MIN_SALES, MIN_CARDS, TOP_CARDS, median, money, esc, summarise, render, keyFor };
