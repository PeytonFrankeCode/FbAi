#!/usr/bin/env node
/**
 * build-landing-pages.js
 *
 * Generates static, crawlable SEO landing pages — one per football set —
 * from the checklist JSON in public/data/checklists/. Each page is a real
 * HTML file (served directly by Cloudflare ASSETS) targeting long-tail
 * searches like "2023 panini prizm football checklist" and "<player> <set>
 * card value", with deep links into the live tool (?prefill=...) so visitors
 * land straight in a sold-price search.
 *
 * Output:
 *   public/sets/index.html                 — hub, grouped by year
 *   public/sets/<set-id>/index.html        — one page per set
 *   public/sets/landing.css                — shared lightweight stylesheet
 *   public/sitemap.xml                     — regenerated to include all pages
 *
 * Re-run any time the checklists change:  npm run build:pages
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CHECKLIST_DIR = path.join(ROOT, 'public', 'data', 'checklists');
const SETS_DIR = path.join(ROOT, 'public', 'sets');
const SITE = 'https://thecardhuddle.com';
const TODAY = new Date().toISOString().slice(0, 10);

// Bound page weight: render at most this many cards per page; the rest are
// reachable via the "search all in the app" CTA. Keeps the biggest sets
// (3000+ cards) from producing monster HTML.
const CARD_CAP = 1000;
const PARALLEL_CAP = 40;
const JSONLD_ITEM_CAP = 50;

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
// For text placed inside JSON-LD string values.
function jsonText(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}
function prefillHref(q) {
  return '/?prefill=' + encodeURIComponent(jsonText(q));
}

// ---- Load checklists ------------------------------------------------------
function loadChecklists() {
  const files = fs.readdirSync(CHECKLIST_DIR).filter(f => f.endsWith('.json'));
  const list = [];
  for (const f of files) {
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(CHECKLIST_DIR, f), 'utf8')); }
    catch (e) { console.warn('  ! skip (bad JSON):', f, e.message); continue; }
    const sets = Array.isArray(j.sets) ? j.sets : [];
    const cardCount = sets.reduce((n, s) => n + (Array.isArray(s.cards) ? s.cards.length : 0), 0);
    if (!j.id || cardCount === 0) continue; // skip empty/placeholder checklists
    const parallelCount = sets.reduce((n, s) => n + (Array.isArray(s.parallels) ? s.parallels.length : 0), 0);
    list.push({
      id: j.id,
      name: j.name || ([j.year, j.brand].filter(Boolean).join(' ') + ' Football'),
      year: Number.isFinite(j.year) ? j.year : null,
      brand: j.brand || '',
      sport: j.sport || 'Football',
      sets, cardCount, parallelCount,
    });
  }
  // Newest first, then alphabetical.
  list.sort((a, b) => (b.year || 0) - (a.year || 0) || a.name.localeCompare(b.name));
  return list;
}

// ---- Shared chrome --------------------------------------------------------
function head({ title, description, canonical, extraJsonLd }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(description)}" />
  <meta name="robots" content="index, follow" />
  <meta name="theme-color" content="#5ece99" />
  <link rel="canonical" href="${esc(canonical)}" />

  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="The Card Huddle" />
  <meta property="og:title" content="${esc(title)}" />
  <meta property="og:description" content="${esc(description)}" />
  <meta property="og:url" content="${esc(canonical)}" />
  <meta property="og:image" content="${SITE}/og-image.png" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${esc(title)}" />
  <meta name="twitter:description" content="${esc(description)}" />
  <meta name="twitter:image" content="${SITE}/og-image.png" />

  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="/sets/landing.css?v=1" />
${extraJsonLd || ''}
</head>
<body>
  <header class="lp-header">
    <a class="lp-brand" href="/"><img src="/logo.png" alt="The Card Huddle" /></a>
    <a class="lp-cta-top" href="/">Search Card Prices &rarr;</a>
  </header>`;
}

function footer() {
  return `
  <footer class="lp-footer">
    <p><a href="/">The Card Huddle</a> &mdash; real eBay sold prices for football cards, broken down by grade.</p>
    <p class="lp-muted">Data sourced from eBay &bull; Prices in USD &bull; Not affiliated with eBay Inc.</p>
  </footer>
</body>
</html>`;
}

function breadcrumb(items) {
  const parts = items.map((it, i) =>
    it.href
      ? `<a href="${esc(it.href)}">${esc(it.label)}</a>`
      : `<span aria-current="page">${esc(it.label)}</span>`
  );
  return `<nav class="lp-crumbs" aria-label="Breadcrumb">${parts.join('<span class="sep">/</span>')}</nav>`;
}

function breadcrumbJsonLd(items) {
  const el = items.map((it, i) => ({
    '@type': 'ListItem', position: i + 1, name: jsonText(it.label),
    ...(it.absUrl ? { item: it.absUrl } : {}),
  }));
  return ldScript({ '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: el });
}

function ldScript(obj) {
  return `  <script type="application/ld+json">\n${JSON.stringify(obj)}\n  </script>\n`;
}

// ---- Per-set page ---------------------------------------------------------
function buildSetPage(cl, related) {
  const title = `${cl.name} Checklist & Card Prices | The Card Huddle`;
  const canonical = `${SITE}/sets/${cl.id}/`;
  const setLabel = cl.name.replace(/\s+Football$/i, '');
  const description =
    `Full ${cl.name} checklist — ${cl.cardCount.toLocaleString()} cards across ` +
    `${cl.sets.length} sets with ${cl.parallelCount} parallels. Check real eBay sold ` +
    `prices by grade (Raw, PSA 10, PSA 9) for every card. Free.`;

  // Structured data: breadcrumb + a CollectionPage with a sample ItemList.
  const crumbs = [
    { label: 'Home', href: '/', absUrl: SITE + '/' },
    { label: 'Checklists', href: '/sets/', absUrl: SITE + '/sets/' },
    { label: setLabel, absUrl: canonical },
  ];
  const sampleCards = [];
  for (const s of cl.sets) {
    for (const c of (s.cards || [])) {
      if (sampleCards.length >= JSONLD_ITEM_CAP) break;
      if (c.player) sampleCards.push(c.player);
    }
    if (sampleCards.length >= JSONLD_ITEM_CAP) break;
  }
  const collectionLd = ldScript({
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: jsonText(cl.name + ' Checklist'),
    url: canonical,
    description: jsonText(description),
    isPartOf: { '@type': 'WebSite', name: 'The Card Huddle', url: SITE + '/' },
    mainEntity: {
      '@type': 'ItemList',
      numberOfItems: cl.cardCount,
      itemListElement: sampleCards.map((p, i) => ({
        '@type': 'ListItem', position: i + 1, name: jsonText(p + ' — ' + setLabel),
      })),
    },
  });
  const extraJsonLd = breadcrumbJsonLd(crumbs) + collectionLd;

  let html = head({ title, description, canonical, extraJsonLd });

  html += `
  <main class="lp-main">
    ${breadcrumb(crumbs)}
    <h1>${esc(cl.name)} Checklist &amp; Prices</h1>
    <p class="lp-lede">The complete <strong>${esc(cl.name)}</strong> checklist — ${cl.cardCount.toLocaleString()} cards across ${cl.sets.length} ${cl.sets.length === 1 ? 'set' : 'sets'} with ${cl.parallelCount} parallels. Tap any card to see what it's actually selling for on eBay right now, broken down by grade (Raw, PSA 10, PSA 9 and more).</p>
    <p class="lp-cta-row">
      <a class="lp-btn" href="${prefillHref(((cl.year ? cl.year + ' ' : '') + cl.brand).trim() || cl.name)}">&#128270; Check live prices for this set</a>
    </p>
`;

  // Subset sections (cap total rendered cards across the page).
  let rendered = 0;
  let truncated = false;
  for (const s of cl.sets) {
    const cards = Array.isArray(s.cards) ? s.cards : [];
    if (!cards.length) continue;
    const subName = s.name || 'Set';
    const parallels = Array.isArray(s.parallels) ? s.parallels : [];

    html += `    <section class="lp-subset">\n`;
    html += `      <h2>${esc(subName)} <span class="lp-count">${cards.length} ${cards.length === 1 ? 'card' : 'cards'}</span></h2>\n`;

    if (parallels.length) {
      const shown = parallels.slice(0, PARALLEL_CAP).map(p => {
        const pr = (p && p.printRun) ? ` /${p.printRun}` : '';
        return esc((p && p.name ? p.name : '').replace(/\s+/g, ' ').trim()) + pr;
      }).filter(Boolean);
      const more = parallels.length > PARALLEL_CAP ? ` <span class="lp-muted">+${parallels.length - PARALLEL_CAP} more</span>` : '';
      html += `      <p class="lp-parallels"><strong>Parallels:</strong> ${shown.join(' &bull; ')}${more}</p>\n`;
    }

    html += `      <ul class="lp-cards">\n`;
    for (const c of cards) {
      if (rendered >= CARD_CAP) { truncated = true; break; }
      const player = (c.player || '').toString().trim();
      if (!player) continue;
      const num = c.number != null ? `#${esc(c.number)} ` : '';
      const team = c.team ? ` <span class="lp-team">${esc(c.team)}</span>` : '';
      const q = [player, cl.year, cl.brand].filter(Boolean).join(' ');
      html += `        <li><a href="${prefillHref(q)}">${num}${esc(player)}${team}</a></li>\n`;
      rendered++;
    }
    html += `      </ul>\n    </section>\n`;
    if (truncated) break;
  }

  if (truncated) {
    const remaining = cl.cardCount - rendered;
    html += `    <p class="lp-truncate">Showing the first ${rendered.toLocaleString()} cards. <a href="${prefillHref(((cl.year ? cl.year + ' ' : '') + cl.brand).trim())}">Search all ${cl.cardCount.toLocaleString()} cards in the live tool &rarr;</a></p>\n`;
  }

  // Related sets — internal linking.
  if (related && related.length) {
    html += `    <section class="lp-related">\n      <h2>More checklists</h2>\n      <ul class="lp-related-list">\n`;
    for (const r of related) {
      html += `        <li><a href="/sets/${r.id}/">${esc(r.name)}</a></li>\n`;
    }
    html += `      </ul>\n      <p><a href="/sets/">&larr; Browse all football card checklists</a></p>\n    </section>\n`;
  }

  html += `  </main>\n`;
  html += footer();
  return html;
}

// ---- Hub page -------------------------------------------------------------
function buildHubPage(list) {
  const title = 'Football Card Checklists & Price Guides | The Card Huddle';
  const canonical = `${SITE}/sets/`;
  const description =
    `Browse complete football card checklists for ${list.length} sets — Panini Prizm, ` +
    `Select, Mosaic, Optic, Donruss and more. See real eBay sold prices by grade for ` +
    `every card. 100% free.`;

  const crumbs = [
    { label: 'Home', href: '/', absUrl: SITE + '/' },
    { label: 'Checklists', absUrl: canonical },
  ];

  // Group by year.
  const byYear = new Map();
  for (const cl of list) {
    const y = cl.year || 'Other';
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y).push(cl);
  }
  const years = [...byYear.keys()].sort((a, b) => {
    if (a === 'Other') return 1; if (b === 'Other') return -1;
    return b - a;
  });

  const itemListLd = ldScript({
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: 'Football Card Checklists & Price Guides',
    url: canonical,
    description: jsonText(description),
    isPartOf: { '@type': 'WebSite', name: 'The Card Huddle', url: SITE + '/' },
    mainEntity: {
      '@type': 'ItemList',
      numberOfItems: list.length,
      itemListElement: list.slice(0, 100).map((cl, i) => ({
        '@type': 'ListItem', position: i + 1, name: jsonText(cl.name),
        url: `${SITE}/sets/${cl.id}/`,
      })),
    },
  });

  let html = head({ title, description, canonical, extraJsonLd: breadcrumbJsonLd(crumbs) + itemListLd });

  html += `
  <main class="lp-main">
    ${breadcrumb(crumbs)}
    <h1>Football Card Checklists &amp; Price Guides</h1>
    <p class="lp-lede">Complete checklists for <strong>${list.length} football sets</strong> — every base card, insert and parallel. Tap into any set to see what cards are actually selling for on eBay, broken down by grade. Always free.</p>
`;

  for (const y of years) {
    const group = byYear.get(y);
    html += `    <section class="lp-year">\n      <h2>${esc(String(y))} Football Sets <span class="lp-count">${group.length}</span></h2>\n      <ul class="lp-set-list">\n`;
    for (const cl of group) {
      html += `        <li><a href="/sets/${cl.id}/"><span class="lp-set-name">${esc(cl.name.replace(/\s+Football$/i, ''))}</span><span class="lp-set-meta">${cl.cardCount.toLocaleString()} cards</span></a></li>\n`;
    }
    html += `      </ul>\n    </section>\n`;
  }

  html += `  </main>\n`;
  html += footer();
  return html;
}

// ---- Stylesheet -----------------------------------------------------------
const LANDING_CSS = `/* Lightweight stylesheet for SEO landing pages. Brand-matched, self-contained. */
:root{
  --bg:#0c0e14;--card:#161b28;--text:#edf0f7;--muted:#9aa3b2;--accent:#5ece99;
  --accent-2:#3fae7d;--border:#2a3142;--amber:#f59e0b;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font-family:'Inter',system-ui,Segoe UI,Roboto,sans-serif;line-height:1.55;-webkit-font-smoothing:antialiased}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
.lp-header{display:flex;align-items:center;justify-content:space-between;gap:1rem;padding:1rem 1.25rem;border-bottom:1px solid var(--border);position:sticky;top:0;background:rgba(12,14,20,.92);backdrop-filter:blur(8px);z-index:5}
.lp-brand img{height:38px;width:auto;display:block}
.lp-cta-top{font-weight:600;border:1px solid var(--accent);color:var(--accent);padding:.45rem .9rem;border-radius:8px;font-size:.9rem}
.lp-cta-top:hover{background:rgba(94,206,153,.12);text-decoration:none}
.lp-main{max-width:920px;margin:0 auto;padding:1.5rem 1.25rem 3rem}
.lp-crumbs{font-size:.85rem;color:var(--muted);margin:.5rem 0 1.25rem}
.lp-crumbs .sep{margin:0 .5rem;opacity:.5}
.lp-crumbs span[aria-current]{color:var(--text)}
h1{font-size:2rem;line-height:1.2;font-weight:800;margin:.25rem 0 .75rem}
h2{font-size:1.25rem;font-weight:700;margin:1.75rem 0 .6rem;display:flex;align-items:baseline;gap:.6rem;flex-wrap:wrap}
.lp-lede{color:#c8cedb;font-size:1.05rem;margin:0 0 1.25rem}
.lp-count{font-size:.8rem;font-weight:600;color:var(--muted);background:var(--card);border:1px solid var(--border);padding:.1rem .5rem;border-radius:999px}
.lp-cta-row{margin:0 0 1.5rem}
.lp-btn{display:inline-block;background:var(--accent);color:#06231a;font-weight:700;padding:.7rem 1.15rem;border-radius:10px;font-size:.98rem}
.lp-btn:hover{background:var(--accent-2);text-decoration:none}
.lp-subset{border-top:1px solid var(--border);padding-top:.5rem;margin-top:1.5rem}
.lp-parallels{font-size:.85rem;color:var(--muted);margin:.25rem 0 .9rem}
.lp-parallels strong{color:#c8cedb}
.lp-cards{list-style:none;padding:0;margin:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:.25rem .9rem}
.lp-cards li{margin:0}
.lp-cards a{display:block;padding:.3rem .5rem;border-radius:6px;color:var(--text);font-size:.92rem}
.lp-cards a:hover{background:var(--card);text-decoration:none}
.lp-team{color:var(--muted);font-size:.82rem}
.lp-truncate{margin:1.5rem 0;padding:.9rem 1rem;background:var(--card);border:1px solid var(--border);border-radius:10px;font-size:.95rem}
.lp-related{border-top:1px solid var(--border);margin-top:2.25rem;padding-top:1rem}
.lp-related-list{list-style:none;padding:0;margin:0 0 1rem;display:flex;flex-wrap:wrap;gap:.5rem}
.lp-related-list a{display:inline-block;background:var(--card);border:1px solid var(--border);padding:.4rem .75rem;border-radius:8px;font-size:.88rem;color:#c8cedb}
.lp-related-list a:hover{border-color:var(--accent);color:var(--accent);text-decoration:none}
.lp-year{border-top:1px solid var(--border);margin-top:1.75rem;padding-top:.5rem}
.lp-set-list{list-style:none;padding:0;margin:.5rem 0 0;display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:.5rem}
.lp-set-list a{display:flex;align-items:center;justify-content:space-between;gap:.75rem;background:var(--card);border:1px solid var(--border);border-radius:10px;padding:.7rem .9rem;color:var(--text)}
.lp-set-list a:hover{border-color:var(--accent);text-decoration:none}
.lp-set-name{font-weight:600;font-size:.95rem}
.lp-set-meta{color:var(--muted);font-size:.8rem;white-space:nowrap}
.lp-muted{color:var(--muted)}
.lp-footer{border-top:1px solid var(--border);padding:1.75rem 1.25rem;text-align:center;color:var(--muted);font-size:.9rem}
.lp-footer a{color:var(--accent)}
@media(max-width:600px){h1{font-size:1.6rem}.lp-main{padding:1rem .9rem 2.5rem}}
`;

// ---- Sitemap --------------------------------------------------------------
function buildSitemap(list) {
  const urls = [];
  const push = (loc, priority, changefreq) =>
    urls.push(`  <url>\n    <loc>${loc}</loc>\n    <lastmod>${TODAY}</lastmod>\n    <changefreq>${changefreq}</changefreq>\n    <priority>${priority}</priority>\n  </url>`);
  push(`${SITE}/`, '1.0', 'daily');
  push(`${SITE}/sets/`, '0.9', 'weekly');
  for (const cl of list) push(`${SITE}/sets/${cl.id}/`, '0.7', 'weekly');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
}

// ---- Run ------------------------------------------------------------------
function relatedFor(cl, all) {
  // Prefer same year (different sets), then same brand other years. Up to 8.
  const sameYear = all.filter(x => x.id !== cl.id && x.year === cl.year).slice(0, 6);
  const sameBrand = all.filter(x => x.id !== cl.id && x.brand === cl.brand && x.year !== cl.year).slice(0, 4);
  const seen = new Set([cl.id]);
  const out = [];
  for (const r of [...sameBrand, ...sameYear]) {
    if (seen.has(r.id)) continue;
    seen.add(r.id); out.push(r);
    if (out.length >= 8) break;
  }
  return out;
}

function main() {
  console.log('Building landing pages from', path.relative(ROOT, CHECKLIST_DIR));
  const list = loadChecklists();
  console.log(`  loaded ${list.length} sets (${list.reduce((n, c) => n + c.cardCount, 0).toLocaleString()} cards)`);

  fs.mkdirSync(SETS_DIR, { recursive: true });
  fs.writeFileSync(path.join(SETS_DIR, 'landing.css'), LANDING_CSS);

  let bytes = 0;
  for (const cl of list) {
    const dir = path.join(SETS_DIR, cl.id);
    fs.mkdirSync(dir, { recursive: true });
    const html = buildSetPage(cl, relatedFor(cl, list));
    fs.writeFileSync(path.join(dir, 'index.html'), html);
    bytes += Buffer.byteLength(html);
  }

  const hub = buildHubPage(list);
  fs.writeFileSync(path.join(SETS_DIR, 'index.html'), hub);

  const sitemap = buildSitemap(list);
  fs.writeFileSync(path.join(ROOT, 'public', 'sitemap.xml'), sitemap);

  console.log(`  wrote ${list.length} set pages + hub + sitemap`);
  console.log(`  total set-page HTML: ${(bytes / 1024 / 1024).toFixed(1)} MB`);
  console.log('  done.');
}

main();
