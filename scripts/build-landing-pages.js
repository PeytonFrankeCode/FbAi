#!/usr/bin/env node
/**
 * build-landing-pages.js
 *
 * Generates static, crawlable SEO landing pages from the checklist JSON in
 * public/data/checklists/. Two page types, cross-linked for internal-link
 * equity:
 *
 *   1. Per-set pages   — full checklists, target "<year> <brand> football
 *                        checklist" searches.
 *   2. Per-player pages — a player's cards aggregated across every set, target
 *                        the high-intent "what's my <player> card worth"
 *                        searches. Only generated for players with enough cards
 *                        to make a substantive page (>= MIN_CARDS in >= MIN_SETS
 *                        sets) so we never ship thin/doorway pages.
 *
 * Every card/player click deep-links into the live tool via the existing
 * ?prefill= handler, landing the visitor in a sold-price search.
 *
 * Output:
 *   public/sets/index.html                 — sets hub, grouped by year
 *   public/sets/<set-id>/index.html        — one page per set
 *   public/players/index.html              — players hub, A–Z
 *   public/players/<slug>/index.html       — one page per eligible player
 *   public/sets/landing.css                — shared lightweight stylesheet
 *   public/sitemap.xml                     — regenerated to include all pages
 *
 * Re-run any time the checklists change:  npm run build:pages
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CHECKLIST_DIR = path.join(ROOT, 'public', 'data', 'checklists');
const PUBLIC_DIR = path.join(ROOT, 'public');
const SETS_DIR = path.join(PUBLIC_DIR, 'sets');
const PLAYERS_DIR = path.join(PUBLIC_DIR, 'players');
const SITE = 'https://thecardhuddle.com';
const TODAY = new Date().toISOString().slice(0, 10);

// Bound page weight: render at most this many cards per page; the rest are
// reachable via the "search all in the app" CTA.
const CARD_CAP = 1000;          // set pages
const PLAYER_CARD_CAP = 300;    // player pages
const PARALLEL_CAP = 40;
const JSONLD_ITEM_CAP = 50;

// Quality gate for player pages — keeps thin one-card players out.
const MIN_CARDS = 5;
const MIN_SETS = 2;

// ---- Small helpers --------------------------------------------------------
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function jsonText(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }
function prefillHref(q) { return '/?prefill=' + encodeURIComponent(jsonText(q)); }
function slugify(s) {
  return String(s).toLowerCase()
    .replace(/['’.]/g, '')          // drop apostrophes & periods (A.J. -> aj)
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')    // everything else -> hyphen
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

// ---- Load + index ---------------------------------------------------------
function loadChecklists() {
  const files = fs.readdirSync(CHECKLIST_DIR).filter(f => f.endsWith('.json'));
  const list = [];
  for (const f of files) {
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(CHECKLIST_DIR, f), 'utf8')); }
    catch (e) { console.warn('  ! skip (bad JSON):', f, e.message); continue; }
    const sets = Array.isArray(j.sets) ? j.sets : [];
    const cardCount = sets.reduce((n, s) => n + (Array.isArray(s.cards) ? s.cards.length : 0), 0);
    if (!j.id || cardCount === 0) continue;
    const parallelCount = sets.reduce((n, s) => n + (Array.isArray(s.parallels) ? s.parallels.length : 0), 0);
    list.push({
      id: j.id,
      name: j.name || ([j.year, j.brand].filter(Boolean).join(' ') + ' Football'),
      year: Number.isFinite(j.year) ? j.year : null,
      brand: j.brand || '',
      sets, cardCount, parallelCount,
    });
  }
  list.sort((a, b) => (b.year || 0) - (a.year || 0) || a.name.localeCompare(b.name));
  return list;
}

// Build per-player index from all checklists.
function buildPlayerIndex(checklists) {
  const players = new Map(); // name -> { name, cards:[], setIds:Set, years:Set, teams:Set }
  for (const cl of checklists) {
    for (const s of cl.sets) {
      const parallelCount = Array.isArray(s.parallels) ? s.parallels.length : 0;
      for (const c of (s.cards || [])) {
        const name = (c.player || '').trim();
        if (!name) continue;
        let p = players.get(name);
        if (!p) { p = { name, cards: [], setIds: new Set(), years: new Set(), teams: new Set() }; players.set(name, p); }
        p.cards.push({
          setId: cl.id, setName: cl.name, year: cl.year, brand: cl.brand,
          subset: s.name || 'Set', number: c.number, team: c.team || '', parallels: parallelCount,
        });
        p.setIds.add(cl.id);
        if (cl.year) p.years.add(cl.year);
        if (c.team) p.teams.add(c.team);
      }
    }
  }
  return players;
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
  <link rel="stylesheet" href="/sets/landing.css?v=2" />
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
    <p class="lp-muted"><a href="/sets/">All Checklists</a> &bull; <a href="/players/">Player Price Guides</a> &bull; Data sourced from eBay &bull; Not affiliated with eBay Inc.</p>
  </footer>
</body>
</html>`;
}

function breadcrumb(items) {
  const parts = items.map(it =>
    it.href ? `<a href="${esc(it.href)}">${esc(it.label)}</a>` : `<span aria-current="page">${esc(it.label)}</span>`);
  return `<nav class="lp-crumbs" aria-label="Breadcrumb">${parts.join('<span class="sep">/</span>')}</nav>`;
}
function ldScript(obj) { return `  <script type="application/ld+json">\n${JSON.stringify(obj)}\n  </script>\n`; }
function breadcrumbJsonLd(items) {
  return ldScript({
    '@context': 'https://schema.org', '@type': 'BreadcrumbList',
    itemListElement: items.map((it, i) => ({
      '@type': 'ListItem', position: i + 1, name: jsonText(it.label), ...(it.absUrl ? { item: it.absUrl } : {}),
    })),
  });
}

// ---- Per-set page ---------------------------------------------------------
function buildSetPage(cl, related, playerSlug) {
  const title = `${cl.name} Checklist & Card Prices | The Card Huddle`;
  const canonical = `${SITE}/sets/${cl.id}/`;
  const setLabel = cl.name.replace(/\s+Football$/i, '');
  const description =
    `Full ${cl.name} checklist — ${cl.cardCount.toLocaleString()} cards across ` +
    `${cl.sets.length} sets with ${cl.parallelCount} parallels. Check real eBay sold ` +
    `prices by grade (Raw, PSA 10, PSA 9) for every card. Free.`;

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
    '@context': 'https://schema.org', '@type': 'CollectionPage',
    name: jsonText(cl.name + ' Checklist'), url: canonical, description: jsonText(description),
    isPartOf: { '@type': 'WebSite', name: 'The Card Huddle', url: SITE + '/' },
    mainEntity: {
      '@type': 'ItemList', numberOfItems: cl.cardCount,
      itemListElement: sampleCards.map((p, i) => ({ '@type': 'ListItem', position: i + 1, name: jsonText(p + ' — ' + setLabel) })),
    },
  });

  let html = head({ title, description, canonical, extraJsonLd: breadcrumbJsonLd(crumbs) + collectionLd });
  html += `
  <main class="lp-main">
    ${breadcrumb(crumbs)}
    <h1>${esc(cl.name)} Checklist &amp; Prices</h1>
    <p class="lp-lede">The complete <strong>${esc(cl.name)}</strong> checklist — ${cl.cardCount.toLocaleString()} cards across ${cl.sets.length} ${cl.sets.length === 1 ? 'set' : 'sets'} with ${cl.parallelCount} parallels. Tap any card to see what it's actually selling for on eBay right now, broken down by grade (Raw, PSA 10, PSA 9 and more).</p>
    <p class="lp-cta-row">
      <a class="lp-btn" href="${prefillHref(((cl.year ? cl.year + ' ' : '') + cl.brand).trim() || cl.name)}">&#128270; Check live prices for this set</a>
    </p>
`;

  let rendered = 0, truncated = false;
  for (const s of cl.sets) {
    const cards = Array.isArray(s.cards) ? s.cards : [];
    if (!cards.length) continue;
    const parallels = Array.isArray(s.parallels) ? s.parallels : [];
    html += `    <section class="lp-subset">\n`;
    html += `      <h2>${esc(s.name || 'Set')} <span class="lp-count">${cards.length} ${cards.length === 1 ? 'card' : 'cards'}</span></h2>\n`;
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
      // Cross-link to the player's page when one exists; otherwise deep-link
      // straight into a price search.
      const slug = playerSlug.get(player);
      const href = slug ? `/players/${slug}/` : prefillHref([player, cl.year, cl.brand].filter(Boolean).join(' '));
      html += `        <li><a href="${href}">${num}${esc(player)}${team}</a></li>\n`;
      rendered++;
    }
    html += `      </ul>\n    </section>\n`;
    if (truncated) break;
  }
  if (truncated) {
    html += `    <p class="lp-truncate">Showing the first ${rendered.toLocaleString()} cards. <a href="${prefillHref(((cl.year ? cl.year + ' ' : '') + cl.brand).trim())}">Search all ${cl.cardCount.toLocaleString()} cards in the live tool &rarr;</a></p>\n`;
  }
  if (related && related.length) {
    html += `    <section class="lp-related">\n      <h2>More checklists</h2>\n      <ul class="lp-related-list">\n`;
    for (const r of related) html += `        <li><a href="/sets/${r.id}/">${esc(r.name)}</a></li>\n`;
    html += `      </ul>\n      <p><a href="/sets/">&larr; Browse all football card checklists</a></p>\n    </section>\n`;
  }
  html += `  </main>\n` + footer();
  return html;
}

// ---- Per-player page ------------------------------------------------------
function buildPlayerPage(p, related) {
  const title = `${p.name} Football Cards — Values & Checklist | The Card Huddle`;
  const canonical = `${SITE}/players/${p.slug}/`;
  const years = [...p.years].sort((a, b) => a - b);
  const yearRange = years.length ? (years[0] === years[years.length - 1] ? `${years[0]}` : `${years[0]}–${years[years.length - 1]}`) : '';
  const teams = [...p.teams].slice(0, 2);
  const teamClause = teams.length ? `, including ${teams.join(' and ')} cards` : '';
  const description =
    `${p.name} football card price guide — see real eBay sold prices by grade ` +
    `(Raw, PSA 10, PSA 9) for all ${p.cards.length} of his cards across ${p.setIds.size} sets` +
    `${yearRange ? ` (${yearRange})` : ''}. Rookies, parallels, autos & more. Free.`;

  const crumbs = [
    { label: 'Home', href: '/', absUrl: SITE + '/' },
    { label: 'Players', href: '/players/', absUrl: SITE + '/players/' },
    { label: p.name, absUrl: canonical },
  ];
  const collectionLd = ldScript({
    '@context': 'https://schema.org', '@type': 'CollectionPage',
    name: jsonText(p.name + ' Football Cards'), url: canonical, description: jsonText(description),
    about: { '@type': 'Person', name: jsonText(p.name) },
    isPartOf: { '@type': 'WebSite', name: 'The Card Huddle', url: SITE + '/' },
    mainEntity: {
      '@type': 'ItemList', numberOfItems: p.cards.length,
      itemListElement: p.cards.slice(0, JSONLD_ITEM_CAP).map((c, i) => ({
        '@type': 'ListItem', position: i + 1,
        name: jsonText(`${p.name} ${c.setName}${c.number != null ? ' #' + c.number : ''}`),
      })),
    },
  });

  // Group cards by year (desc) then set.
  const byYear = new Map();
  for (const c of p.cards) {
    const y = c.year || 0;
    if (!byYear.has(y)) byYear.set(y, new Map());
    const setsMap = byYear.get(y);
    if (!setsMap.has(c.setId)) setsMap.set(c.setId, { name: c.setName, brand: c.brand, year: c.year, cards: [] });
    setsMap.get(c.setId).cards.push(c);
  }
  const sortedYears = [...byYear.keys()].sort((a, b) => b - a);

  let html = head({ title, description, canonical, extraJsonLd: breadcrumbJsonLd(crumbs) + collectionLd });
  html += `
  <main class="lp-main">
    ${breadcrumb(crumbs)}
    <h1>${esc(p.name)} Football Card Values</h1>
    <p class="lp-lede"><strong>${esc(p.name)}</strong> appears on ${p.cards.length} cards across ${p.setIds.size} sets${yearRange ? ` (${yearRange})` : ''}${esc(teamClause)}. Tap any card to see real eBay sold prices by grade — Raw, PSA 10, PSA 9 and more.</p>
    <p class="lp-cta-row">
      <a class="lp-btn" href="${prefillHref(p.name)}">&#128270; See all ${esc(p.name)} prices now</a>
    </p>
`;

  let rendered = 0, truncated = false;
  for (const y of sortedYears) {
    if (truncated) break;
    const setsMap = byYear.get(y);
    const setList = [...setsMap.values()].sort((a, b) => a.name.localeCompare(b.name));
    html += `    <section class="lp-subset">\n      <h2>${y ? esc(String(y)) + ' ' : ''}${esc(p.name)} Cards</h2>\n`;
    for (const set of setList) {
      if (truncated) break;
      html += `      <h3 class="lp-setrow"><a href="/sets/${set.cards[0].setId}/">${esc(set.name)}</a> <span class="lp-count">${set.cards.length}</span></h3>\n      <ul class="lp-cards">\n`;
      for (const c of set.cards) {
        if (rendered >= PLAYER_CARD_CAP) { truncated = true; break; }
        const num = c.number != null ? `#${esc(c.number)} ` : '';
        const par = c.parallels ? ` <span class="lp-team">${c.parallels} parallels</span>` : '';
        const q = [p.name, c.year, c.brand].filter(Boolean).join(' ');
        html += `        <li><a href="${prefillHref(q)}">${num}${esc(c.subset)}${par}</a></li>\n`;
        rendered++;
      }
      html += `      </ul>\n`;
    }
    html += `    </section>\n`;
  }
  if (truncated) {
    html += `    <p class="lp-truncate">Showing ${rendered.toLocaleString()} of ${p.cards.length.toLocaleString()} cards. <a href="${prefillHref(p.name)}">Search all ${esc(p.name)} cards in the live tool &rarr;</a></p>\n`;
  }
  if (related && related.length) {
    html += `    <section class="lp-related">\n      <h2>Related players</h2>\n      <ul class="lp-related-list">\n`;
    for (const r of related) html += `        <li><a href="/players/${r.slug}/">${esc(r.name)}</a></li>\n`;
    html += `      </ul>\n      <p><a href="/players/">&larr; Browse all player price guides</a></p>\n    </section>\n`;
  }
  html += `  </main>\n` + footer();
  return html;
}

// ---- Hubs -----------------------------------------------------------------
function buildSetsHub(list) {
  const title = 'Football Card Checklists & Price Guides | The Card Huddle';
  const canonical = `${SITE}/sets/`;
  const description =
    `Browse complete football card checklists for ${list.length} sets — Panini Prizm, ` +
    `Select, Mosaic, Optic, Donruss and more. See real eBay sold prices by grade for ` +
    `every card. 100% free.`;
  const crumbs = [{ label: 'Home', href: '/', absUrl: SITE + '/' }, { label: 'Checklists', absUrl: canonical }];
  const byYear = new Map();
  for (const cl of list) { const y = cl.year || 'Other'; if (!byYear.has(y)) byYear.set(y, []); byYear.get(y).push(cl); }
  const years = [...byYear.keys()].sort((a, b) => (a === 'Other' ? 1 : b === 'Other' ? -1 : b - a));
  const itemListLd = ldScript({
    '@context': 'https://schema.org', '@type': 'CollectionPage',
    name: 'Football Card Checklists & Price Guides', url: canonical, description: jsonText(description),
    isPartOf: { '@type': 'WebSite', name: 'The Card Huddle', url: SITE + '/' },
    mainEntity: {
      '@type': 'ItemList', numberOfItems: list.length,
      itemListElement: list.slice(0, 100).map((cl, i) => ({ '@type': 'ListItem', position: i + 1, name: jsonText(cl.name), url: `${SITE}/sets/${cl.id}/` })),
    },
  });
  let html = head({ title, description, canonical, extraJsonLd: breadcrumbJsonLd(crumbs) + itemListLd });
  html += `
  <main class="lp-main">
    ${breadcrumb(crumbs)}
    <h1>Football Card Checklists &amp; Price Guides</h1>
    <p class="lp-lede">Complete checklists for <strong>${list.length} football sets</strong> — every base card, insert and parallel. Tap into any set to see what cards are actually selling for on eBay, broken down by grade. Always free.</p>
    <p class="lp-cta-row"><a class="lp-btn" href="/players/">&#127944; Browse player price guides &rarr;</a></p>
`;
  for (const y of years) {
    const group = byYear.get(y);
    html += `    <section class="lp-year">\n      <h2>${esc(String(y))} Football Sets <span class="lp-count">${group.length}</span></h2>\n      <ul class="lp-set-list">\n`;
    for (const cl of group)
      html += `        <li><a href="/sets/${cl.id}/"><span class="lp-set-name">${esc(cl.name.replace(/\s+Football$/i, ''))}</span><span class="lp-set-meta">${cl.cardCount.toLocaleString()} cards</span></a></li>\n`;
    html += `      </ul>\n    </section>\n`;
  }
  html += `  </main>\n` + footer();
  return html;
}

function buildPlayersHub(players) {
  const title = 'Football Card Player Price Guides | The Card Huddle';
  const canonical = `${SITE}/players/`;
  const description =
    `Look up football card values by player — ${players.length} price guides covering ` +
    `Mahomes, Allen, rookies and more. Real eBay sold prices by grade for every card. Free.`;
  const crumbs = [{ label: 'Home', href: '/', absUrl: SITE + '/' }, { label: 'Players', absUrl: canonical }];

  const popular = [...players].sort((a, b) => b.cards.length - a.cards.length).slice(0, 60);
  const alpha = [...players].sort((a, b) => a.name.localeCompare(b.name));
  const groups = new Map();
  for (const p of alpha) {
    const ch = (p.name[0] || '#').toUpperCase();
    const key = /[A-Z]/.test(ch) ? ch : '#';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  const letters = [...groups.keys()].sort();
  const itemListLd = ldScript({
    '@context': 'https://schema.org', '@type': 'CollectionPage',
    name: 'Football Card Player Price Guides', url: canonical, description: jsonText(description),
    isPartOf: { '@type': 'WebSite', name: 'The Card Huddle', url: SITE + '/' },
    mainEntity: {
      '@type': 'ItemList', numberOfItems: players.length,
      itemListElement: popular.map((p, i) => ({ '@type': 'ListItem', position: i + 1, name: jsonText(p.name), url: `${SITE}/players/${p.slug}/` })),
    },
  });
  let html = head({ title, description, canonical, extraJsonLd: breadcrumbJsonLd(crumbs) + itemListLd });
  html += `
  <main class="lp-main">
    ${breadcrumb(crumbs)}
    <h1>Football Card Player Price Guides</h1>
    <p class="lp-lede">Look up what any player's cards are worth — <strong>${players.length} price guides</strong> covering every card a player appears on, across all sets. Tap a name to see real eBay sold prices by grade.</p>
    <p class="lp-cta-row"><a class="lp-btn" href="/sets/">&#128203; Browse by set checklist &rarr;</a></p>
    <section class="lp-subset">
      <h2>Most-searched players</h2>
      <ul class="lp-related-list">
`;
  for (const p of popular) html += `        <li><a href="/players/${p.slug}/">${esc(p.name)}</a></li>\n`;
  html += `      </ul>\n    </section>\n`;
  html += `    <nav class="lp-aznav" aria-label="Jump to letter">${letters.map(l => `<a href="#l-${l}">${l}</a>`).join('')}</nav>\n`;
  for (const l of letters) {
    html += `    <section class="lp-year" id="l-${l}">\n      <h2>${l}</h2>\n      <ul class="lp-set-list">\n`;
    for (const p of groups.get(l))
      html += `        <li><a href="/players/${p.slug}/"><span class="lp-set-name">${esc(p.name)}</span><span class="lp-set-meta">${p.cards.length} cards</span></a></li>\n`;
    html += `      </ul>\n    </section>\n`;
  }
  html += `  </main>\n` + footer();
  return html;
}

// ---- Stylesheet -----------------------------------------------------------
const LANDING_CSS = `/* Lightweight stylesheet for SEO landing pages. Brand-matched, self-contained. */
:root{--bg:#0c0e14;--card:#161b28;--text:#edf0f7;--muted:#9aa3b2;--accent:#5ece99;--accent-2:#3fae7d;--border:#2a3142;--amber:#f59e0b}
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
h3.lp-setrow{font-size:1.02rem;font-weight:600;margin:1.1rem 0 .4rem;display:flex;align-items:baseline;gap:.5rem;flex-wrap:wrap}
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
.lp-aznav{display:flex;flex-wrap:wrap;gap:.35rem;margin:1.5rem 0 .5rem;position:sticky;top:64px;background:rgba(12,14,20,.92);backdrop-filter:blur(8px);padding:.5rem 0;z-index:4}
.lp-aznav a{display:inline-block;min-width:1.6rem;text-align:center;background:var(--card);border:1px solid var(--border);border-radius:6px;padding:.25rem .35rem;font-size:.82rem;font-weight:600}
.lp-aznav a:hover{border-color:var(--accent);text-decoration:none}
.lp-muted{color:var(--muted)}
.lp-footer{border-top:1px solid var(--border);padding:1.75rem 1.25rem;text-align:center;color:var(--muted);font-size:.9rem}
.lp-footer a{color:var(--accent)}
@media(max-width:600px){h1{font-size:1.6rem}.lp-main{padding:1rem .9rem 2.5rem}.lp-aznav{top:60px}}
`;

// ---- Sitemap --------------------------------------------------------------
function buildSitemap(list, players) {
  const urls = [];
  const push = (loc, priority, changefreq) =>
    urls.push(`  <url>\n    <loc>${loc}</loc>\n    <lastmod>${TODAY}</lastmod>\n    <changefreq>${changefreq}</changefreq>\n    <priority>${priority}</priority>\n  </url>`);
  push(`${SITE}/`, '1.0', 'daily');
  push(`${SITE}/sets/`, '0.9', 'weekly');
  push(`${SITE}/players/`, '0.9', 'weekly');
  for (const cl of list) push(`${SITE}/sets/${cl.id}/`, '0.7', 'weekly');
  for (const p of players) push(`${SITE}/players/${p.slug}/`, '0.6', 'weekly');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
}

// ---- Wiring ---------------------------------------------------------------
function relatedSets(cl, all) {
  const sameYear = all.filter(x => x.id !== cl.id && x.year === cl.year).slice(0, 6);
  const sameBrand = all.filter(x => x.id !== cl.id && x.brand === cl.brand && x.year !== cl.year).slice(0, 4);
  const seen = new Set([cl.id]); const out = [];
  for (const r of [...sameBrand, ...sameYear]) { if (seen.has(r.id)) continue; seen.add(r.id); out.push(r); if (out.length >= 8) break; }
  return out;
}

function rmDirSafe(dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }

function main() {
  console.log('Building landing pages from', path.relative(ROOT, CHECKLIST_DIR));
  const checklists = loadChecklists();
  const playerIndex = buildPlayerIndex(checklists);

  // Eligible players → assign unique slugs (sorted by card count so the most
  // prominent player wins the cleanest slug on collision).
  const eligible = [...playerIndex.values()]
    .filter(p => p.cards.length >= MIN_CARDS && p.setIds.size >= MIN_SETS && !p.name.includes('/'))
    .sort((a, b) => b.cards.length - a.cards.length);
  const usedSlugs = new Set();
  const playerSlug = new Map(); // name -> slug
  for (const p of eligible) {
    let base = slugify(p.name) || 'player', s = base, i = 2;
    while (usedSlugs.has(s)) s = `${base}-${i++}`;
    usedSlugs.add(s); p.slug = s; playerSlug.set(p.name, s);
  }
  // setId -> eligible players (for related-player suggestions), in popularity order.
  const setPlayers = new Map();
  for (const p of eligible) for (const sid of p.setIds) {
    if (!setPlayers.has(sid)) setPlayers.set(sid, []);
    setPlayers.get(sid).push(p);
  }

  console.log(`  ${checklists.length} sets (${checklists.reduce((n, c) => n + c.cardCount, 0).toLocaleString()} cards)`);
  console.log(`  ${eligible.length} eligible players (>= ${MIN_CARDS} cards in >= ${MIN_SETS} sets)`);

  // Fresh dirs so removed entries don't linger.
  rmDirSafe(SETS_DIR); rmDirSafe(PLAYERS_DIR);
  fs.mkdirSync(SETS_DIR, { recursive: true });
  fs.mkdirSync(PLAYERS_DIR, { recursive: true });
  fs.writeFileSync(path.join(SETS_DIR, 'landing.css'), LANDING_CSS);

  let bytes = 0;
  for (const cl of checklists) {
    const dir = path.join(SETS_DIR, cl.id);
    fs.mkdirSync(dir, { recursive: true });
    const html = buildSetPage(cl, relatedSets(cl, checklists), playerSlug);
    fs.writeFileSync(path.join(dir, 'index.html'), html); bytes += Buffer.byteLength(html);
  }
  for (const p of eligible) {
    const sorted = [...p.cards].sort((a, b) => (b.year || 0) - (a.year || 0));
    const primarySet = sorted[0].setId;
    const related = (setPlayers.get(primarySet) || []).filter(x => x.name !== p.name).slice(0, 10);
    const dir = path.join(PLAYERS_DIR, p.slug);
    fs.mkdirSync(dir, { recursive: true });
    const html = buildPlayerPage(p, related);
    fs.writeFileSync(path.join(dir, 'index.html'), html); bytes += Buffer.byteLength(html);
  }

  fs.writeFileSync(path.join(SETS_DIR, 'index.html'), buildSetsHub(checklists));
  fs.writeFileSync(path.join(PLAYERS_DIR, 'index.html'), buildPlayersHub(eligible));
  fs.writeFileSync(path.join(PUBLIC_DIR, 'sitemap.xml'), buildSitemap(checklists, eligible));

  console.log(`  wrote ${checklists.length} set pages + ${eligible.length} player pages + 2 hubs + sitemap`);
  console.log(`  total generated HTML: ${(bytes / 1024 / 1024).toFixed(1)} MB`);
  console.log('  done.');
}

main();
