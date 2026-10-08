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
const { execFileSync } = require('child_process');
// The same normalisation the sales join uses. Deliberately shared rather than
// reimplemented: if the builder's idea of "the same name" drifts from the
// join's, the join starts dropping pages again and nothing says why.
const { norm: normName } = require(path.join(__dirname, '..', 'set-key.js'));

const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(PUBLIC_DIR, 'data');
const SITE = 'https://thecardhuddle.com';

// AdSense on the ~8,000 generated pages, off by default.
//
// The tag pulls in the ad auction, which costs LCP and — unless every slot
// has a reserved height — CLS, both of which feed page-experience ranking.
// These pages exist to rank, and Google is still forming its first
// assessment of them, so the trade is bad right now: a few dollars a month
// against the asset the whole build was for. Ownership verification doesn't
// need it either; public/ads.txt covers that.
//
// Set this to the pub id ('ca-pub-…') once the pages have traffic worth
// monetising, and reserve a fixed height on every slot when you do.
// ---- AdSense on the generated pages ---------------------------------------
//
// This was null, which put the ad tag on the app shell and nowhere else. The
// shell renders 207 visible words — a search box and a row of tabs — because
// the checklist, market and inventory panels are display:none until a tab is
// clicked, and their data is fetched on demand rather than served in the HTML.
// Clicking "Checklists" takes the page to 2,128 visible words without changing
// the URL, so none of it is a page anything can crawl or index. The generated
// pages below are where the substance actually has an address.
//
// NOT on every page, though. The build emits roughly 8,200 of these from one
// template, and a thin templated page carrying ads is what Google's policies
// call scaled content.
//
// The rule is the one this file already makes: a page carries ads only if it
// is INDEXABLE. The thin-content thresholds below already decide which pages
// are substantial enough to put in front of Google, and that comment block
// reaches this conclusion on its own — "a monetised site made mostly of thin
// generated pages is a review risk". Reusing that judgement rather than adding
// a second one means the two can never disagree, and never monetises a page we
// have told Google not to index.
//
// Set ADSENSE_CLIENT='' to turn the tag off everywhere again.
const ADSENSE_CLIENT = process.env.ADSENSE_CLIENT !== undefined
  ? process.env.ADSENSE_CLIENT
  : 'ca-pub-3644779384068007';

const _adsStats = { withAds: 0, withoutAds: 0 };

const adsenseTag = (noindex) => {
  const on = !!ADSENSE_CLIENT && !noindex && S.ads;
  if (on) _adsStats.withAds++; else _adsStats.withoutAds++;
  return on
    ? `  <script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${ADSENSE_CLIENT}" crossorigin="anonymous"></script>\n`
    : '';
};
const TODAY = new Date().toISOString().slice(0, 10);

// ---- Sitemap <lastmod> -----------------------------------------------------
// Every URL used to claim it changed today, on every deploy. That is both
// untrue and a signal search engines discount, so each page now inherits the
// date of the last commit that actually touched the checklist behind it.
//
// One `git log` pass over the checklist directory, newest commit first: the
// first time a file appears is its most recent change. Needs full history —
// see fetch-depth in .github/workflows/deploy.yml. Falls back to file mtime,
// then to today, so a shallow clone or a missing git still builds.
function checklistCommitDates(rel = 'public/data/checklists/') {
  const dates = new Map(); // basename -> YYYY-MM-DD
  try {
    const out = execFileSync(
      'git', ['log', '--name-only', '--format=%cI', '--', rel],
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
    );
    let current = null;
    for (const line of out.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      if (/^\d{4}-\d{2}-\d{2}T/.test(t)) { current = t.slice(0, 10); continue; }
      if (!current) continue;
      const base = path.basename(t);
      if (!dates.has(base)) dates.set(base, current); // first hit = newest
    }
  } catch (e) {
    console.warn('  ! git history unavailable, falling back to file mtimes:', e.message);
  }
  return dates;
}

function fileLastmod(fileName) {
  if (!fileName) return TODAY;
  const fromGit = S.commitDates.get(fileName);
  if (fromGit) return fromGit;
  try {
    return fs.statSync(path.join(S.dir, fileName)).mtime.toISOString().slice(0, 10);
  } catch { return TODAY; }
}

// Newest of a set of dates, for pages that aggregate several checklists.
function newestDate(dates) {
  let best = null;
  for (const d of dates) if (d && (!best || d > best)) best = d;
  return best || TODAY;
}

// The 32 current NFL franchises (clean, high-volume team values). Relocated /
// renamed franchises are merged into their current name so e.g. "Oakland
// Raiders" cards roll up under the Raiders page. College / one-off team values
// are intentionally ignored — only these get pages.
const NFL_TEAMS = [
  'Arizona Cardinals', 'Atlanta Falcons', 'Baltimore Ravens', 'Buffalo Bills',
  'Carolina Panthers', 'Chicago Bears', 'Cincinnati Bengals', 'Cleveland Browns',
  'Dallas Cowboys', 'Denver Broncos', 'Detroit Lions', 'Green Bay Packers',
  'Houston Texans', 'Indianapolis Colts', 'Jacksonville Jaguars', 'Kansas City Chiefs',
  'Las Vegas Raiders', 'Los Angeles Chargers', 'Los Angeles Rams', 'Miami Dolphins',
  'Minnesota Vikings', 'New England Patriots', 'New Orleans Saints', 'New York Giants',
  'New York Jets', 'Philadelphia Eagles', 'Pittsburgh Steelers', 'San Francisco 49ers',
  'Seattle Seahawks', 'Tampa Bay Buccaneers', 'Tennessee Titans', 'Washington Commanders',
];
const TEAM_ALIASES = {
  'Oakland Raiders': 'Las Vegas Raiders', 'Los Angeles Raiders': 'Las Vegas Raiders',
  'San Diego Chargers': 'Los Angeles Chargers', 'St. Louis Rams': 'Los Angeles Rams',
  'St Louis Rams': 'Los Angeles Rams',
  'Washington Football Team': 'Washington Commanders', 'Washington Redskins': 'Washington Commanders',
  'Houston Oilers': 'Tennessee Titans', 'Tennessee Oilers': 'Tennessee Titans',
};
function canonicalTeam(t) {
  const name = S.cleanTeam((t || '').trim());
  if (S.teamSet.has(name)) return name;
  if (S.aliases[name]) return S.aliases[name];
  return null; // college / unknown — no page
}

// The 30 NBA franchises. Relocated ones roll up under today's name, as the
// football teams do ("Seattle SuperSonics" cards on the Thunder page).
const NBA_TEAMS = [
  'Atlanta Hawks', 'Boston Celtics', 'Brooklyn Nets', 'Charlotte Hornets', 'Chicago Bulls',
  'Cleveland Cavaliers', 'Dallas Mavericks', 'Denver Nuggets', 'Detroit Pistons', 'Golden State Warriors',
  'Houston Rockets', 'Indiana Pacers', 'Los Angeles Clippers', 'Los Angeles Lakers', 'Memphis Grizzlies',
  'Miami Heat', 'Milwaukee Bucks', 'Minnesota Timberwolves', 'New Orleans Pelicans', 'New York Knicks',
  'Oklahoma City Thunder', 'Orlando Magic', 'Philadelphia 76ers', 'Phoenix Suns', 'Portland Trail Blazers',
  'Sacramento Kings', 'San Antonio Spurs', 'Toronto Raptors', 'Utah Jazz', 'Washington Wizards',
];
const NBA_ALIASES = {
  'Seattle SuperSonics': 'Oklahoma City Thunder', 'Seattle Supersonics': 'Oklahoma City Thunder',
  'New Jersey Nets': 'Brooklyn Nets', 'Charlotte Bobcats': 'Charlotte Hornets', 'New Orleans Hornets': 'New Orleans Pelicans',
  'Vancouver Grizzlies': 'Memphis Grizzlies', 'LA Clippers': 'Los Angeles Clippers', 'San Diego Clippers': 'Los Angeles Clippers',
  'Washington Bullets': 'Washington Wizards', 'Kansas City Kings': 'Sacramento Kings', 'New Orleans Jazz': 'Utah Jazz',
};
// The 30 MLB franchises, under today's names ("Cleveland Indians" cards on the
// Guardians page, the Expos on the Nationals', Oakland's on the Athletics').
const MLB_TEAMS = [
  'Arizona Diamondbacks', 'Athletics', 'Atlanta Braves', 'Baltimore Orioles', 'Boston Red Sox',
  'Chicago Cubs', 'Chicago White Sox', 'Cincinnati Reds', 'Cleveland Guardians', 'Colorado Rockies',
  'Detroit Tigers', 'Houston Astros', 'Kansas City Royals', 'Los Angeles Angels', 'Los Angeles Dodgers',
  'Miami Marlins', 'Milwaukee Brewers', 'Minnesota Twins', 'New York Mets', 'New York Yankees',
  'Philadelphia Phillies', 'Pittsburgh Pirates', 'San Diego Padres', 'San Francisco Giants', 'Seattle Mariners',
  'St. Louis Cardinals', 'Tampa Bay Rays', 'Texas Rangers', 'Toronto Blue Jays', 'Washington Nationals',
];
const MLB_ALIASES = {
  'Oakland Athletics': 'Athletics', "Oakland A's": 'Athletics', 'Oakland A’s': 'Athletics', 'Philadelphia Athletics': 'Athletics',
  'Kansas City Athletics': 'Athletics', 'Cleveland Indians': 'Cleveland Guardians', 'Brooklyn Dodgers': 'Los Angeles Dodgers',
  'New York Giants': 'San Francisco Giants', 'Montreal Expos': 'Washington Nationals', 'Montréal Expos': 'Washington Nationals',
  'California Angels': 'Los Angeles Angels', 'Anaheim Angels': 'Los Angeles Angels', 'Angels': 'Los Angeles Angels',
  'Los Angeles Angels of Anaheim': 'Los Angeles Angels', 'Milwaukee Braves': 'Atlanta Braves', 'Boston Braves': 'Atlanta Braves',
  'Florida Marlins': 'Miami Marlins', 'Tampa Bay Devil Rays': 'Tampa Bay Rays', 'St. Louis Browns': 'Baltimore Orioles',
  'Seattle Pilots': 'Milwaukee Brewers', 'Houston Colt .45s': 'Houston Astros', 'St Louis Cardinals': 'St. Louis Cardinals',
};

// One pass per sport. Football is the site as it always was: its pages at
// /sets/, /players/, /teams/, with the sold-price blocks the Worker fills in,
// and the only sport whose pages carry ads (the ad rule is "indexable AND
// priced", and only football has our sales data behind it). Basketball and
// baseball get the same pages under /basketball/ and /baseball/, built from
// their own checklist folders, with each card linking into the live search.
const yy = (y) => String((Number(y) + 1) % 100).padStart(2, '0');
const SPORT_CONFIGS = [
  { id: 'football', base: '', Word: 'Football', word: 'football', league: 'NFL', emoji: '&#127944;',
    folder: 'checklists', teams: NFL_TEAMS, aliases: TEAM_ALIASES, prices: true, ads: true,
    brandsLine: 'Panini Prizm, Select, Mosaic, Optic, Donruss and more', cleanTeam: (t) => t, yearLabel: (y) => String(y) },
  { id: 'basketball', base: '/basketball', Word: 'Basketball', word: 'basketball', league: 'NBA', emoji: '&#127936;',
    folder: 'checklists-basketball', teams: NBA_TEAMS, aliases: NBA_ALIASES, prices: false, ads: false,
    brandsLine: 'Panini Prizm, Select, Donruss Optic, Topps Chrome and more',
    cleanTeam: (t) => t.replace(/[®™*]+/g, '').replace(/\s+(RC|SP|SSP)\b.*$/, '').trim(),
    // Basketball products run by season: its 2023 products are the 2023-24 season.
    yearLabel: (y) => /^\d{4}$/.test(String(y)) ? `${y}-${yy(y)}` : String(y) },
  { id: 'baseball', base: '/baseball', Word: 'Baseball', word: 'baseball', league: 'MLB', emoji: '&#9918;',
    folder: 'checklists-baseball', teams: MLB_TEAMS, aliases: MLB_ALIASES, prices: false, ads: false,
    brandsLine: 'Topps Series 1, Topps Chrome, Bowman Chrome, Allen & Ginter and more',
    cleanTeam: (t) => t.replace(/[®™*]+/g, '').replace(/\s+(RC|SP|SSP)\b.*$/, '').trim(),
    yearLabel: (y) => String(y) },
].map(c => ({
  ...c,
  dir: path.join(DATA_DIR, c.folder),
  teamSet: new Set(c.teams),
  wordRe: new RegExp(`\\s+${c.Word}$`, 'i'),
  setsDir: path.join(PUBLIC_DIR, c.base.slice(1), 'sets'),
  playersDir: path.join(PUBLIC_DIR, c.base.slice(1), 'players'),
  teamsDir: path.join(PUBLIC_DIR, c.base.slice(1), 'teams'),
}));
// The sport being built. Every page function reads it.
let S = SPORT_CONFIGS[0];

// Bound page weight: render at most this many cards per page; the rest are
// reachable via the "search all in the app" CTA.
const CARD_CAP = 1000;          // set pages
const PLAYER_CARD_CAP = 300;    // player pages
const PARALLEL_CAP = 40;
const JSONLD_ITEM_CAP = 50;

// Quality gate for player pages — keeps thin one-card players out.
const MIN_CARDS = 5;
const MIN_SETS = 2;

// A set inside a product earns its own page once it is substantial enough to
// stand alone. Below this it says little the product page doesn't already,
// and a few dozen near-empty pages are worth less than none.
const MIN_SUBSET_CARDS = 25;

// Thin-content thresholds. Pages below these still get built and stay linked —
// they are useful to someone who navigates to them — but they carry
// "noindex, follow" and are left out of the sitemap. The point is to keep the
// indexed set substantial: a page listing six cards from a template is exactly
// the shape Google's scaled-content policy targets, and a few thousand of them
// drag down the pages that do deserve to rank. "follow" keeps their internal
// links flowing PageRank to the pages that stay indexed.
// Raising these de-indexes more; lowering them re-indexes. Build output prints
// the counts so the effect is visible before deploying.
// Raised from 10/30/50, which indexed 7,347 pages against roughly 1,000 that
// earn any impressions at all — about 0.016 clicks per page per day. That ratio
// is the shape the scaled-content policy describes, and it matters more for
// AdSense than for rankings: a monetised site made mostly of thin generated
// pages is a review risk, not merely a slow earner.
//
// Set pages were 65% of the index on their own (4,283 of them) and are where
// almost all of the cut lands. Measured against the checklists:
//
//   sets    >=30: 4,283    >=60: 1,021    >=100: 563    >=200: 165
//   players >=10: 2,659    >=25: 1,802    >=50: 1,227   >=100: 766
//   products >=50:  360   — already sound, left alone
//
// 100/50 lands near 2,200 indexed, roughly double the pages known to earn
// impressions, so it keeps the earners with headroom rather than cutting to
// the bone. Card count is only a proxy for quality; the precise version of
// this prunes on Search Console impressions instead, and is worth doing once
// there is an export to work from.
const INDEX_MIN_PLAYER_CARDS = 50;
const INDEX_MIN_SUBSET_CARDS = 100;
const INDEX_MIN_PRODUCT_CARDS = 50;

// One index for every sport, capped at what football alone had.
//
// Basketball and baseball brought thousands of indexable pages of their own,
// which would have near doubled the index in one deploy — the scaled-content
// shape the thresholds above exist to avoid. So the thresholds are floors now,
// and the sitemap is a budget, split in two pools:
//
//   football        FOOTBALL_SHARE of the budget. Its pages carry prices, ads
//                   and ranking history the other sports do not have yet.
//   everything else the rest, basketball and baseball competing for it.
//
// A fixed split rather than one open ranking so that adding checklists to one
// sport (2000-2017 basketball and baseball arrived after the budget did) takes
// room from that pool, not from football. Within a pool every hub, year hub
// and team page is in, and the rest goes to the strongest product, set and
// player pages. "Strongest" is card count against the floor for that kind of
// page (a player with 150 cards scores 3, as does a set with 300). That is a
// proxy: the real signal is Search Console clicks, and there is no export to
// rank on yet.
const INDEX_BUDGET = 5756;
const FOOTBALL_SHARE = 2 / 3;
const INDEX_FLOOR = { product: INDEX_MIN_PRODUCT_CARDS, subset: INDEX_MIN_SUBSET_CARDS, player: INDEX_MIN_PLAYER_CARDS };
let INDEXED = new Set();   // `${sport}:${kind}:${key}`, filled by planIndex()
const isIndexed = (kind, key) => INDEXED.has(`${S.id}:${kind}:${key}`);

function planIndex(sports) {
  const footballBudget = Math.floor(INDEX_BUDGET * FOOTBALL_SHARE);
  const pools = {
    football: { budget: footballBudget, fixed: 0, cands: [] },
    other: { budget: INDEX_BUDGET - footballBudget, fixed: 0, cands: [] },
  };
  for (const { cfg, ctx } of sports) {
    const pool = pools[cfg.id === 'football' ? 'football' : 'other'];
    // Hubs (sets, players, teams), year hubs and teams; football also has the
    // home page and about, methodology and contact. Must match buildSitemap.
    pool.fixed += 3 + ctx.years.length + ctx.teams.length + (cfg.id === 'football' ? 4 : 0);
    const add = (kind, key, cards) => {
      if (cards >= INDEX_FLOOR[kind]) pool.cands.push({ id: `${cfg.id}:${kind}:${key}`, sport: cfg.id, kind, score: cards / INDEX_FLOOR[kind] });
    };
    for (const cl of ctx.checklists) {
      add('product', cl.id, cl.cardCount);
      for (const sub of (ctx.subsetIndex.get(cl.id) || [])) add('subset', `${cl.id}/${sub.slug}`, (sub.set.cards || []).length);
    }
    for (const p of ctx.eligible) add('player', p.slug, p.cards.length);
  }
  INDEXED = new Set();
  const tally = {};
  for (const [name, pool] of Object.entries(pools)) {
    // Stable order for equal scores, so a rebuild picks the same pages.
    pool.cands.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const picked = pool.cands.slice(0, Math.max(0, pool.budget - pool.fixed));
    for (const c of picked) { INDEXED.add(c.id); tally[`${c.sport} ${c.kind}`] = (tally[`${c.sport} ${c.kind}`] || 0) + 1; }
    console.log(`index budget, ${name}: ${pool.budget} URLs — ${pool.fixed} hubs and teams, ${picked.length} of ${pool.cands.length} pages over the floors`);
  }
  console.log('  ' + Object.entries(tally).map(([k, n]) => `${k}: ${n}`).join(', '));
}

// ---- Small helpers --------------------------------------------------------
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function jsonText(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }
function prefillHref(q) { return '/?prefill=' + encodeURIComponent(jsonText(q)); }
// Where the Worker injects the sold-price block.
//
// An empty element with the page's own key on it, and nothing else. The prices
// cannot be baked in here: this file runs at build time and the numbers change
// daily, so a static price would be stale the day after a deploy and there
// would be no way to tell by looking.
//
// It is empty rather than a placeholder with dashes in it. If the injection
// never happens — no KV value, a cold isolate that failed to load it, a page
// with too few sales — the reader sees the page exactly as it is today rather
// than an empty table that reads as broken.
// The key that ties a checklist card to a sold row.
//
// It has to be built identically on both sides — here from a checklist entry,
// and in server.js from the sales columns — or every lookup misses and the
// subset pages silently stay empty. normName() is the shared normaliser the
// sales join already uses.
function cardMemberKey(c) {
  return normName(c && c.player) + '|' + normName(c && c.number);
}

function priceSlot(kind, id) {
  // Only football has sold data behind its pages for the Worker to put here.
  if (!S.prices) return '';
  return `    <div class="lp-price-slot" data-price-key="${esc(kind)}:${esc(id)}"></div>`;
}

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
  const files = fs.readdirSync(S.dir).filter(f => f.endsWith('.json') && f !== 'index.json');
  const list = [];
  for (const f of files) {
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(S.dir, f), 'utf8')); }
    catch (e) { console.warn('  ! skip (bad JSON):', f, e.message); continue; }
    const sets = Array.isArray(j.sets) ? j.sets : [];
    const cardCount = sets.reduce((n, s) => n + (Array.isArray(s.cards) ? s.cards.length : 0), 0);
    if (!j.id || cardCount === 0) continue;
    const parallelCount = sets.reduce((n, s) => n + (Array.isArray(s.parallels) ? s.parallels.length : 0), 0);
    list.push({
      file: f,
      id: j.id,
      name: j.name || ([j.year, j.brand].filter(Boolean).join(' ') + ' ' + S.Word),
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
let _landingV = null;
const LANDING_CSS_V_GET = () => (_landingV || (_landingV = landingCssVersion()));

function head({ title, description, canonical, extraJsonLd, noindex }) {
  const LANDING_CSS_V = LANDING_CSS_V_GET();
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(description)}" />
  <meta name="robots" content="${noindex ? 'noindex, follow' : 'index, follow'}" />
  <meta name="theme-color" content="#5ece99" />
  <link rel="canonical" href="${esc(canonical)}" />
${adsenseTag(noindex)}

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
  <link rel="stylesheet" href="/sets/landing.css?v=${LANDING_CSS_V}" />
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
    <p><a href="/">The Card Huddle</a> &mdash; real eBay sold prices for ${S.word} cards, broken down by grade.</p>
    <p class="lp-muted"><a href="${S.base}/sets/">Checklists</a> &bull; <a href="${S.base}/players/">Players</a> &bull; <a href="${S.base}/teams/">Teams</a> &bull; <a href="/news">Guides</a> &bull; <a href="/about.html">About</a> &bull; <a href="/methodology.html">How prices work</a> &bull; <a href="/contact.html">Contact</a> &bull; <a href="/privacy.html">Privacy</a> &bull; <a href="/terms.html">Terms</a> &bull; Data sourced from eBay &bull; Not affiliated with, endorsed by or sponsored by eBay Inc.</p>
    <p class="lp-muted">Prices are historical sale records, not appraisals or financial advice. As an eBay Partner Network affiliate we may earn a commission on qualifying purchases made through links on this site, at no extra cost to you.</p>
  </footer>
  <script>/* The site's own devices never send affiliate clicks (see epnUrl in app.js). */
  document.addEventListener('click',function(e){try{if(localStorage.getItem('chNoAffiliate')!=='1')return;var a=e.target.closest&&e.target.closest('a[href*="campid="]');if(a)a.href=a.href.replace(/([?&])(?:mkcid|mkrid|siteid|campid|toolid|mkevt|customid)=[^&#]*/g,'$1').replace(/[?&]+(?=#|$)/,'').replace(/\?&+/,'?').replace(/&{2,}/g,'&');}catch(_){}},true);</script>
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
function buildSetPage(cl, related, playerSlug, subsets) {
  // name -> slug for the sets of this product that got their own page.
  const subsetSlug = new Map((subsets || []).map(x => [x.set.name, x.slug]));
  const title = `${cl.name} Checklist & Card Prices | The Card Huddle`;
  const canonical = `${SITE}${S.base}/sets/${cl.id}/`;
  const setLabel = cl.name.replace(S.wordRe, '');
  const description =
    `Full ${cl.name} checklist — ${cl.cardCount.toLocaleString()} cards across ` +
    `${cl.sets.length} sets with ${cl.parallelCount} parallels. Check real eBay sold ` +
    `prices by grade (Raw, PSA 10, PSA 9) for every card. Free.`;

  const crumbs = [
    { label: 'Home', href: '/', absUrl: SITE + '/' },
    { label: 'Checklists', href: S.base + '/sets/', absUrl: SITE + S.base + '/sets/' },
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


  let html = head({ title, description, canonical, noindex: !isIndexed('product', cl.id), extraJsonLd: breadcrumbJsonLd(crumbs) + collectionLd });
  html += `
  <main class="lp-main">
    ${breadcrumb(crumbs)}
    <h1>${esc(cl.name)} Checklist &amp; Prices</h1>
    <p class="lp-lede">The complete <strong>${esc(cl.name)}</strong> checklist — ${cl.cardCount.toLocaleString()} cards across ${cl.sets.length} ${cl.sets.length === 1 ? 'set' : 'sets'} with ${cl.parallelCount} parallels. Tap any card to see what it's actually selling for on eBay right now, broken down by grade (Raw, PSA 10, PSA 9 and more).</p>
    <p class="lp-cta-row">
      <a class="lp-btn" href="${prefillHref(((cl.year ? cl.year + ' ' : '') + cl.brand).trim() || cl.name)}">&#128270; Check live prices for this set</a>
    </p>
${priceSlot('set', cl.id)}
`;

  let rendered = 0, truncated = false;
  for (const s of cl.sets) {
    const cards = Array.isArray(s.cards) ? s.cards : [];
    if (!cards.length) continue;
    const parallels = Array.isArray(s.parallels) ? s.parallels : [];
    html += `    <section class="lp-subset">\n`;
    const ownPage = subsetSlug.get(s.name);
    const heading = ownPage
      ? `<a href="${S.base}/sets/${cl.id}/${ownPage}/">${esc(s.name || 'Set')}</a>`
      : esc(s.name || 'Set');
    html += `      <h2>${heading} <span class="lp-count">${cards.length} ${cards.length === 1 ? 'card' : 'cards'}</span></h2>\n`;
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
      const href = slug ? `${S.base}/players/${slug}/` : prefillHref([player, cl.year, cl.brand].filter(Boolean).join(' '));
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
    for (const r of related) html += `        <li><a href="${S.base}/sets/${r.id}/">${esc(r.name)}</a></li>\n`;
    html += `      </ul>\n      <p><a href="${S.base}/sets/">&larr; Browse all ${S.word} card checklists</a></p>\n    </section>\n`;
  }
  html += `  </main>\n` + footer();
  return html;
}

// ---- Sets inside a product ------------------------------------------------
// A product page lists every set it contains, but the searches are for the
// set: "2020 donruss optic rated rookies checklist", not the product. Those
// get their own page — except where a set's card list is identical to one
// already published, which is common because a parallel repeats its parent's
// list verbatim ("Signatures", "Signatures Gold", "Signatures Blue"). Three
// pages of the same names would be near-duplicates competing with each
// other, so only the first is published and the rest stay on the product
// page where they read as what they are: parallels.
function subsetCardKey(cards) {
  return cards.map(c => `${c.number}|${c.player}`).join(',');
}

function eligibleSubsets(cl) {
  const out = [];
  const seenKey = new Map();
  const usedSlug = new Set();
  for (const s of cl.sets) {
    const cards = Array.isArray(s.cards) ? s.cards : [];
    if (cards.length < MIN_SUBSET_CARDS) continue;
    const key = subsetCardKey(cards);
    if (seenKey.has(key)) continue;
    seenKey.set(key, s.name);
    let base = slugify(s.name || 'set') || 'set', slug = base, i = 2;
    while (usedSlug.has(slug)) slug = `${base}-${i++}`;
    usedSlug.add(slug);
    out.push({ set: s, slug });
  }
  return out;
}

function buildSubsetPage(cl, s, slug, siblings, playerSlug) {
  const cards = Array.isArray(s.cards) ? s.cards : [];
  const parallels = Array.isArray(s.parallels) ? s.parallels : [];
  const productLabel = cl.name.replace(S.wordRe, '');
  const setName = (s.name || 'Set').replace(/\s+/g, ' ').trim();
  const fullLabel = `${productLabel} ${setName}`;
  const canonical = `${SITE}${S.base}/sets/${cl.id}/${slug}/`;
  const title = `${fullLabel} Checklist & Card Prices | The Card Huddle`;
  const description =
    `Complete ${fullLabel} checklist — all ${cards.length} cards` +
    (parallels.length ? ` and ${parallels.length} parallels` : '') +
    `. Check real eBay sold prices by grade (Raw, PSA 10, PSA 9) for every card. Free.`;

  const crumbs = [
    { label: 'Home', href: '/', absUrl: SITE + '/' },
    { label: 'Checklists', href: S.base + '/sets/', absUrl: SITE + S.base + '/sets/' },
    { label: productLabel, href: `${S.base}/sets/${cl.id}/`, absUrl: `${SITE}${S.base}/sets/${cl.id}/` },
    { label: setName, absUrl: canonical },
  ];

  const names = cards.map(c => (c.player || '').trim()).filter(Boolean);
  const collectionLd = ldScript({
    '@context': 'https://schema.org', '@type': 'CollectionPage',
    name: jsonText(fullLabel + ' Checklist'), url: canonical, description: jsonText(description),
    isPartOf: { '@type': 'WebSite', name: 'The Card Huddle', url: SITE + '/' },
    mainEntity: {
      '@type': 'ItemList', numberOfItems: cards.length,
      itemListElement: names.slice(0, JSONLD_ITEM_CAP).map((p, i) => ({
        '@type': 'ListItem', position: i + 1, name: jsonText(p + ' — ' + fullLabel) })),
    },
  });

  let html = head({ title, description, canonical, noindex: !isIndexed('subset', `${cl.id}/${slug}`), extraJsonLd: breadcrumbJsonLd(crumbs) + collectionLd });
  html += `
  <main class="lp-main">
    ${breadcrumb(crumbs)}
    <h1>${esc(fullLabel)} Checklist &amp; Prices</h1>
    <p class="lp-lede">All <strong>${cards.length}</strong> cards in <strong>${esc(fullLabel)}</strong>${parallels.length ? `, with ${parallels.length} ${parallels.length === 1 ? 'parallel' : 'parallels'}` : ''}. Tap any card for real eBay sold prices by grade — Raw, PSA 10, PSA 9 and more.</p>
    <p class="lp-cta-row">
      <a class="lp-btn" href="${prefillHref(`${cl.year || ''} ${cl.brand} ${setName}`.replace(/\s+/g, ' ').trim())}">&#128270; Check live prices for ${esc(setName)}</a>
    </p>
${priceSlot('subset', cl.id + '/' + slug)}
`;
  if (parallels.length) {
    const shown = parallels.slice(0, PARALLEL_CAP).map(p => {
      const pr = (p && p.printRun) ? ` /${p.printRun}` : '';
      return esc((p && p.name ? p.name : '').replace(/\s+/g, ' ').trim()) + pr;
    }).filter(Boolean);
    const more = parallels.length > PARALLEL_CAP ? ` <span class="lp-muted">+${parallels.length - PARALLEL_CAP} more</span>` : '';
    html += `    <p class="lp-parallels"><strong>Parallels:</strong> ${shown.join(' &bull; ')}${more}</p>\n`;
  }
  html += `    <ul class="lp-cards">\n`;
  let rendered = 0;
  for (const c of cards) {
    if (rendered >= CARD_CAP) break;
    const player = (c.player || '').toString().trim();
    if (!player) continue;
    const num = c.number != null ? `#${esc(c.number)} ` : '';
    const team = c.team ? ` <span class="lp-team">${esc(c.team)}</span>` : '';
    const pslug = playerSlug.get(player);
    const href = pslug ? `${S.base}/players/${pslug}/` : prefillHref([player, cl.year, cl.brand, setName].filter(Boolean).join(' '));
    html += `      <li><a href="${href}">${num}${esc(player)}${team}</a></li>\n`;
    rendered++;
  }
  html += `    </ul>\n`;
  if (rendered < cards.length) {
    html += `    <p class="lp-truncate">Showing the first ${rendered.toLocaleString()} of ${cards.length.toLocaleString()} cards. <a href="${prefillHref(`${cl.year || ''} ${cl.brand} ${setName}`.replace(/\s+/g, ' ').trim())}">Search the rest in the live tool &rarr;</a></p>\n`;
  }
  if (siblings && siblings.length) {
    html += `    <section class="lp-related">\n      <h2>Other sets in ${esc(productLabel)}</h2>\n      <ul class="lp-related-list">\n`;
    for (const sib of siblings) {
      html += `        <li><a href="${S.base}/sets/${cl.id}/${sib.slug}/">${esc((sib.set.name || '').replace(/\s+/g, ' ').trim())}</a></li>\n`;
    }
    html += `      </ul>\n      <p><a href="${S.base}/sets/${cl.id}/">&larr; Full ${esc(cl.name)} checklist</a></p>\n    </section>\n`;
  }
  html += `  </main>\n` + footer();
  return html;
}

// ---- Per-year hub ---------------------------------------------------------
// The all-years hub competes for every "<year> football card checklist" search
// at once. A page per year answers one of them properly.
function buildYearHub(year, products, subsetIndex) {
  const canonical = `${SITE}${S.base}/sets/${year}/`;
  const cards = products.reduce((n, p) => n + p.cardCount, 0);
  const title = `${S.yearLabel(year)} ${S.Word} Card Checklists — Every Set & Prices | The Card Huddle`;
  const description =
    `Every ${S.yearLabel(year)} ${S.word} card checklist — ${products.length} products, ` +
    `${cards.toLocaleString()} cards. Check real eBay sold prices by grade for any card. Free.`;
  const crumbs = [
    { label: 'Home', href: '/', absUrl: SITE + '/' },
    { label: 'Checklists', href: S.base + '/sets/', absUrl: SITE + S.base + '/sets/' },
    { label: String(year), absUrl: canonical },
  ];
  const listLd = ldScript({
    '@context': 'https://schema.org', '@type': 'CollectionPage',
    name: jsonText(`${S.yearLabel(year)} ${S.Word} Card Checklists`), url: canonical, description: jsonText(description),
    isPartOf: { '@type': 'WebSite', name: 'The Card Huddle', url: SITE + '/' },
    mainEntity: {
      '@type': 'ItemList', numberOfItems: products.length,
      itemListElement: products.slice(0, JSONLD_ITEM_CAP).map((p, i) => ({
        '@type': 'ListItem', position: i + 1, name: jsonText(p.name), url: `${SITE}${S.base}/sets/${p.id}/` })),
    },
  });

  let html = head({ title, description, canonical, extraJsonLd: breadcrumbJsonLd(crumbs) + listLd });
  html += `
  <main class="lp-main">
    ${breadcrumb(crumbs)}
    <h1>${S.yearLabel(year)} ${S.Word} Card Checklists</h1>
    <p class="lp-lede">All <strong>${products.length}</strong> ${S.yearLabel(year)} ${S.word} card products — <strong>${cards.toLocaleString()}</strong> cards in total. Tap any set for the full checklist and real eBay sold prices by grade.</p>
    <ul class="lp-set-list">
`;
  for (const p of products) {
    html += `      <li><a href="${S.base}/sets/${p.id}/"><span class="lp-set-name">${esc(p.name)}</span><span class="lp-set-meta">${p.cardCount.toLocaleString()} cards</span></a></li>\n`;
  }
  html += `    </ul>\n`;
  // Deepest-value internal links: the biggest individual sets of the year.
  const topSubsets = [];
  for (const p of products) {
    for (const sub of (subsetIndex.get(p.id) || [])) {
      topSubsets.push({ product: p, sub, n: (sub.set.cards || []).length });
    }
  }
  topSubsets.sort((a, b) => b.n - a.n);
  if (topSubsets.length) {
    html += `    <section class="lp-related">\n      <h2>Popular ${year} sets</h2>\n      <ul class="lp-related-list">\n`;
    for (const t of topSubsets.slice(0, 24)) {
      const label = `${t.product.brand || t.product.name} ${(t.sub.set.name || '').replace(/\s+/g, ' ').trim()}`;
      html += `        <li><a href="${S.base}/sets/${t.product.id}/${t.sub.slug}/">${esc(label)}</a></li>\n`;
    }
    html += `      </ul>\n    </section>\n`;
  }
  html += `  </main>\n` + footer();
  return html;
}

// ---- Per-player page ------------------------------------------------------
function buildPlayerPage(p, related, teamSlug) {
  const title = `${p.name} ${S.Word} Cards — Values & Checklist | The Card Huddle`;
  const canonical = `${SITE}${S.base}/players/${p.slug}/`;
  const years = [...p.years].sort((a, b) => a - b);
  const yearRange = years.length ? (years[0] === years[years.length - 1] ? `${years[0]}` : `${years[0]}–${years[years.length - 1]}`) : '';
  const teams = [...p.teams].slice(0, 2);
  const teamClause = teams.length ? `, including ${teams.join(' and ')} cards` : '';
  const description =
    `${p.name} ${S.word} card price guide — see real eBay sold prices by grade ` +
    `(Raw, PSA 10, PSA 9) for all ${p.cards.length} of his cards across ${p.setIds.size} sets` +
    `${yearRange ? ` (${yearRange})` : ''}. Rookies, parallels, autos & more. Free.`;

  const crumbs = [
    { label: 'Home', href: '/', absUrl: SITE + '/' },
    { label: 'Players', href: S.base + '/players/', absUrl: SITE + S.base + '/players/' },
    { label: p.name, absUrl: canonical },
  ];
  const collectionLd = ldScript({
    '@context': 'https://schema.org', '@type': 'CollectionPage',
    name: jsonText(p.name + ' ' + S.Word + ' Cards'), url: canonical, description: jsonText(description),
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
  const minYear = years.length ? years[0] : null;
  const teamLinks = [...new Set([...p.teams].map(canonicalTeam).filter(Boolean))].filter(t => teamSlug && teamSlug.has(t));


  let html = head({ title, description, canonical, noindex: !isIndexed('player', p.slug), extraJsonLd: breadcrumbJsonLd(crumbs) + collectionLd });
  html += `
  <main class="lp-main">
    ${breadcrumb(crumbs)}
    <h1>${esc(p.name)} ${S.Word} Card Values</h1>
    <p class="lp-lede"><strong>${esc(p.name)}</strong> appears on ${p.cards.length} cards across ${p.setIds.size} sets${yearRange ? ` (${yearRange})` : ''}${esc(teamClause)}. Tap any card to see real eBay sold prices by grade — Raw, PSA 10, PSA 9 and more.</p>
    <p class="lp-cta-row">
      <a class="lp-btn" href="${prefillHref(p.name)}">&#128270; See all ${esc(p.name)} prices now</a>
    </p>
${priceSlot('player', p.slug)}
${teamLinks.length ? `    <p class="lp-teamline">Teams: ${teamLinks.map(t => `<a href="${S.base}/teams/${teamSlug.get(t)}/">${esc(t)}</a>`).join(' ')}</p>\n` : ''}`;

  let rendered = 0, truncated = false;
  for (const y of sortedYears) {
    if (truncated) break;
    const setsMap = byYear.get(y);
    const setList = [...setsMap.values()].sort((a, b) => a.name.localeCompare(b.name));
    html += `    <section class="lp-subset">\n      <h2>${y ? esc(S.yearLabel(y)) + ' ' : ''}${esc(p.name)} Cards</h2>\n`;
    for (const set of setList) {
      if (truncated) break;
      html += `      <h3 class="lp-setrow"><a href="${S.base}/sets/${set.cards[0].setId}/">${esc(set.name)}</a> <span class="lp-count">${set.cards.length}</span></h3>\n      <ul class="lp-cards">\n`;
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
    for (const r of related) html += `        <li><a href="${S.base}/players/${r.slug}/">${esc(r.name)}</a></li>\n`;
    html += `      </ul>\n      <p><a href="${S.base}/players/">&larr; Browse all player price guides</a></p>\n    </section>\n`;
  }
  html += `  </main>\n` + footer();
  return html;
}

// ---- Hubs -----------------------------------------------------------------
function buildSetsHub(list) {
  const title = `${S.Word} Card Checklists & Price Guides | The Card Huddle`;
  const canonical = `${SITE}${S.base}/sets/`;
  const description =
    `Browse complete ${S.word} card checklists for ${list.length} sets — ${S.brandsLine}. See real eBay sold prices by grade for ` +
    `every card. 100% free.`;
  const crumbs = [{ label: 'Home', href: '/', absUrl: SITE + '/' }, { label: 'Checklists', absUrl: canonical }];
  const byYear = new Map();
  for (const cl of list) { const y = cl.year || 'Other'; if (!byYear.has(y)) byYear.set(y, []); byYear.get(y).push(cl); }
  const years = [...byYear.keys()].sort((a, b) => (a === 'Other' ? 1 : b === 'Other' ? -1 : b - a));
  const itemListLd = ldScript({
    '@context': 'https://schema.org', '@type': 'CollectionPage',
    name: `${S.Word} Card Checklists & Price Guides`, url: canonical, description: jsonText(description),
    isPartOf: { '@type': 'WebSite', name: 'The Card Huddle', url: SITE + '/' },
    mainEntity: {
      '@type': 'ItemList', numberOfItems: list.length,
      itemListElement: list.slice(0, 100).map((cl, i) => ({ '@type': 'ListItem', position: i + 1, name: jsonText(cl.name), url: `${SITE}${S.base}/sets/${cl.id}/` })),
    },
  });
  let html = head({ title, description, canonical, extraJsonLd: breadcrumbJsonLd(crumbs) + itemListLd });
  html += `
  <main class="lp-main">
    ${breadcrumb(crumbs)}
    <h1>${S.Word} Card Checklists &amp; Price Guides</h1>
    <p class="lp-lede">Complete checklists for <strong>${list.length} ${S.word} sets</strong> — every base card, insert and parallel. Tap into any set to see what cards are actually selling for on eBay, broken down by grade. Always free.</p>
    <p class="lp-cta-row"><a class="lp-btn" href="${S.base}/players/">${S.emoji} Browse player price guides &rarr;</a></p>
`;
  for (const y of years) {
    const group = byYear.get(y);
    // The heading links to the year's own hub, so crawlers reach it from
    // here rather than only from the sitemap.
    const yHead = (y === 'Other')
      ? `${esc(S.yearLabel(y))} ${S.Word} Sets`
      : `<a href="${S.base}/sets/${y}/">${esc(S.yearLabel(y))} ${S.Word} Sets</a>`;
    html += `    <section class="lp-year">\n      <h2>${yHead} <span class="lp-count">${group.length}</span></h2>\n      <ul class="lp-set-list">\n`;
    for (const cl of group)
      html += `        <li><a href="${S.base}/sets/${cl.id}/"><span class="lp-set-name">${esc(cl.name.replace(S.wordRe, ''))}</span><span class="lp-set-meta">${cl.cardCount.toLocaleString()} cards</span></a></li>\n`;
    html += `      </ul>\n    </section>\n`;
  }
  html += `  </main>\n` + footer();
  return html;
}

function buildPlayersHub(players) {
  const title = `${S.Word} Card Player Price Guides | The Card Huddle`;
  const canonical = `${SITE}${S.base}/players/`;
  const description =
    `Look up ${S.word} card values by player — ${players.length} price guides covering ` +
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
    name: `${S.Word} Card Player Price Guides`, url: canonical, description: jsonText(description),
    isPartOf: { '@type': 'WebSite', name: 'The Card Huddle', url: SITE + '/' },
    mainEntity: {
      '@type': 'ItemList', numberOfItems: players.length,
      itemListElement: popular.map((p, i) => ({ '@type': 'ListItem', position: i + 1, name: jsonText(p.name), url: `${SITE}${S.base}/players/${p.slug}/` })),
    },
  });
  let html = head({ title, description, canonical, extraJsonLd: breadcrumbJsonLd(crumbs) + itemListLd });
  html += `
  <main class="lp-main">
    ${breadcrumb(crumbs)}
    <h1>${S.Word} Card Player Price Guides</h1>
    <p class="lp-lede">Look up what any player's cards are worth — <strong>${players.length} price guides</strong> covering every card a player appears on, across all sets. Tap a name to see real eBay sold prices by grade.</p>
    <p class="lp-cta-row"><a class="lp-btn" href="${S.base}/sets/">&#128203; Browse by set checklist &rarr;</a></p>
    <section class="lp-subset">
      <h2>Most-searched players</h2>
      <ul class="lp-related-list">
`;
  for (const p of popular) html += `        <li><a href="${S.base}/players/${p.slug}/">${esc(p.name)}</a></li>\n`;
  html += `      </ul>\n    </section>\n`;
  html += `    <nav class="lp-aznav" aria-label="Jump to letter">${letters.map(l => `<a href="#l-${l}">${l}</a>`).join('')}</nav>\n`;
  for (const l of letters) {
    html += `    <section class="lp-year" id="l-${l}">\n      <h2>${l}</h2>\n      <ul class="lp-set-list">\n`;
    for (const p of groups.get(l))
      html += `        <li><a href="${S.base}/players/${p.slug}/"><span class="lp-set-name">${esc(p.name)}</span><span class="lp-set-meta">${p.cards.length} cards</span></a></li>\n`;
    html += `      </ul>\n    </section>\n`;
  }
  html += `  </main>\n` + footer();
  return html;
}

// ---- Team pages -----------------------------------------------------------
function buildTeamIndex(checklists) {
  const teams = new Map();
  for (const cl of checklists) for (const s of cl.sets) for (const c of (s.cards || [])) {
    const ct = canonicalTeam(c.team);
    if (!ct) continue;
    let t = teams.get(ct);
    if (!t) { t = { name: ct, slug: slugify(ct), players: new Map(), cardCount: 0, setIds: new Set() }; teams.set(ct, t); }
    t.cardCount++; t.setIds.add(cl.id);
    const pn = (c.player || '').trim();
    if (pn) t.players.set(pn, (t.players.get(pn) || 0) + 1);
  }
  return teams;
}

const TEAM_PLAYER_CAP = 250;

function buildTeamPage(team, playerSlug, relatedTeams) {
  const title = `${team.name} ${S.Word} Cards — Checklist & Values | The Card Huddle`;
  const canonical = `${SITE}${S.base}/teams/${team.slug}/`;
  const players = [...team.players.entries()].sort((a, b) => b[1] - a[1]); // [name, count]
  const description =
    `${team.name} ${S.word} card price guide — ${team.cardCount.toLocaleString()} cards ` +
    `for ${players.length} players across ${team.setIds.size} sets. Check real eBay sold ` +
    `prices by grade (Raw, PSA 10, PSA 9) for every card. Free.`;
  const crumbs = [
    { label: 'Home', href: '/', absUrl: SITE + '/' },
    { label: 'Teams', href: S.base + '/teams/', absUrl: SITE + S.base + '/teams/' },
    { label: team.name, absUrl: canonical },
  ];
  const collectionLd = ldScript({
    '@context': 'https://schema.org', '@type': 'CollectionPage',
    name: jsonText(team.name + ' ' + S.Word + ' Cards'), url: canonical, description: jsonText(description),
    about: { '@type': 'SportsTeam', name: jsonText(team.name) },
    isPartOf: { '@type': 'WebSite', name: 'The Card Huddle', url: SITE + '/' },
    mainEntity: {
      '@type': 'ItemList', numberOfItems: players.length,
      itemListElement: players.slice(0, JSONLD_ITEM_CAP).map(([n], i) => ({ '@type': 'ListItem', position: i + 1, name: jsonText(n) })),
    },
  });

  let html = head({ title, description, canonical, extraJsonLd: breadcrumbJsonLd(crumbs) + collectionLd });
  html += `
  <main class="lp-main">
    ${breadcrumb(crumbs)}
    <h1>${esc(team.name)} ${S.Word} Cards</h1>
    <p class="lp-lede">Browse <strong>${esc(team.name)}</strong> ${S.word} cards — ${team.cardCount.toLocaleString()} cards for ${players.length} players across ${team.setIds.size} sets. Tap a player to see real eBay sold prices by grade (Raw, PSA 10, PSA 9 and more).</p>
    <p class="lp-cta-row"><a class="lp-btn" href="${prefillHref(team.name)}">&#128270; Search ${esc(team.name)} cards on eBay</a></p>
    <section class="lp-subset">
      <h2>Players <span class="lp-count">${players.length}</span></h2>
      <ul class="lp-cards">
`;
  let shown = 0;
  for (const [name, count] of players) {
    if (shown >= TEAM_PLAYER_CAP) break;
    const slug = playerSlug.get(name);
    const href = slug ? `${S.base}/players/${slug}/` : prefillHref(`${name} ${team.name}`);
    html += `        <li><a href="${href}">${esc(name)} <span class="lp-team">${count}</span></a></li>\n`;
    shown++;
  }
  html += `      </ul>\n`;
  if (players.length > shown) html += `      <p class="lp-truncate">Showing the top ${shown} players. <a href="${prefillHref(team.name)}">Search all ${esc(team.name)} cards in the live tool &rarr;</a></p>\n`;
  html += `    </section>\n`;
  if (relatedTeams && relatedTeams.length) {
    html += `    <section class="lp-related">\n      <h2>Other teams</h2>\n      <ul class="lp-related-list">\n`;
    for (const r of relatedTeams) html += `        <li><a href="${S.base}/teams/${r.slug}/">${esc(r.name)}</a></li>\n`;
    html += `      </ul>\n      <p><a href="${S.base}/teams/">&larr; Browse all ${S.league} team card guides</a></p>\n    </section>\n`;
  }
  html += `  </main>\n` + footer();
  return html;
}

function buildTeamsHub(teams) {
  const title = `${S.league} Team ${S.Word} Card Guides & Prices | The Card Huddle`;
  const canonical = `${SITE}${S.base}/teams/`;
  const description =
    `Browse ${S.word} cards by ${S.league} team — all ${S.teams.length} franchises. See checklists and real ` +
    `eBay sold prices by grade for every team's players. 100% free.`;
  const crumbs = [{ label: 'Home', href: '/', absUrl: SITE + '/' }, { label: 'Teams', absUrl: canonical }];
  const sorted = [...teams].sort((a, b) => a.name.localeCompare(b.name));
  const itemListLd = ldScript({
    '@context': 'https://schema.org', '@type': 'CollectionPage',
    name: `${S.league} Team ${S.Word} Card Guides`, url: canonical, description: jsonText(description),
    isPartOf: { '@type': 'WebSite', name: 'The Card Huddle', url: SITE + '/' },
    mainEntity: {
      '@type': 'ItemList', numberOfItems: sorted.length,
      itemListElement: sorted.map((t, i) => ({ '@type': 'ListItem', position: i + 1, name: jsonText(t.name), url: `${SITE}${S.base}/teams/${t.slug}/` })),
    },
  });
  let html = head({ title, description, canonical, extraJsonLd: breadcrumbJsonLd(crumbs) + itemListLd });
  html += `
  <main class="lp-main">
    ${breadcrumb(crumbs)}
    <h1>${S.league} Team Card Guides</h1>
    <p class="lp-lede">Browse ${S.word} cards by team — all <strong>${sorted.length} ${S.league} franchises</strong>. Tap a team to see its players and check real eBay sold prices by grade.</p>
    <p class="lp-cta-row"><a class="lp-btn" href="${S.base}/players/">${S.emoji} Browse player price guides &rarr;</a></p>
    <ul class="lp-set-list">
`;
  for (const t of sorted)
    html += `      <li><a href="${S.base}/teams/${t.slug}/"><span class="lp-set-name">${esc(t.name)}</span><span class="lp-set-meta">${t.cardCount.toLocaleString()} cards</span></a></li>\n`;
  html += `    </ul>\n  </main>\n` + footer();
  return html;
}

// ---- Stylesheet -----------------------------------------------------------
// The landing stylesheet's cache key, from its own content.
//
// This was a hard-coded ?v=3 and it had already gone stale twice in one day:
// the price-block styles were added to LANDING_CSS without touching it, so
// every returning visitor to a landing page would have been served the old
// stylesheet and seen the new price block completely unstyled.
//
// Same failure as index.html's ?v=159 and sw.js's 'v1' before it. A cache key
// that a person has to remember to change is a cache key that will be wrong.
const landingCssVersion = () => require('crypto')
  .createHash('sha256').update(LANDING_CSS).digest('hex').slice(0, 10);

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
.lp-teamline{margin:-0.75rem 0 1.25rem;font-size:.9rem;color:var(--muted)}
.lp-teamline a{margin-right:.6rem}
/* Sold-price block, injected by the Worker into .lp-price-slot. The slot
   itself gets no styles — an empty div must take up no space on the pages
   that have too little data to fill it. */
.lp-prices{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:1rem 1.1rem;margin:1.25rem 0}
.lp-prices h2{margin:0 0 .5rem;font-size:1.1rem}
.lp-price-lede{margin:0 0 .9rem}
.lp-price-table{width:100%;border-collapse:collapse;font-size:.92rem}
.lp-price-table caption{text-align:left;font-size:.82rem;padding-bottom:.4rem}
.lp-price-table th,.lp-price-table td{text-align:left;padding:.4rem .5rem;border-bottom:1px solid var(--border)}
.lp-price-table th:nth-child(2),.lp-price-table td:nth-child(2),
.lp-price-table th:nth-child(3),.lp-price-table td:nth-child(3){text-align:right;white-space:nowrap}
.lp-price-table tr:last-child td{border-bottom:none}
/* Card photo. The span carries the placeholder so a purged eBay image — the
   <img> removes itself on error — leaves the glyph and the row keeps its
   height, instead of the table reflowing as images fail one at a time. */
.lp-thumb-cell{width:44px;padding-right:0}
.lp-thumb{position:relative;display:flex;align-items:center;justify-content:center;
  width:40px;height:56px;border-radius:3px;overflow:hidden;background:rgba(148,163,184,.10)}
.lp-thumb::after{content:'\\1F0A0';font-size:.85rem;opacity:.35}
.lp-thumb img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block}
.lp-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap}
.lp-price-shop{margin:.9rem 0 0;font-weight:600}
.lp-price-note{font-size:.8rem;margin:.75rem 0 0}
/* A long card label must not push the page sideways on a phone. */
@media (max-width:560px){.lp-prices{overflow-x:auto}.lp-price-table{min-width:100%}}
.lp-muted{color:var(--muted)}
.lp-footer{border-top:1px solid var(--border);padding:1.75rem 1.25rem;text-align:center;color:var(--muted);font-size:.9rem}
.lp-footer a{color:var(--accent)}
@media(max-width:600px){h1{font-size:1.6rem}.lp-main{padding:1rem .9rem 2.5rem}.lp-aznav{top:60px}}
`;

// ---- Sitemap --------------------------------------------------------------
function buildSitemap(list, players, teams, years, subsetIndex) {
  const urls = [];
  const push = (loc, priority, changefreq, lastmod) =>
    urls.push(`  <url>\n    <loc>${loc}</loc>\n    <lastmod>${lastmod}</lastmod>\n    <changefreq>${changefreq}</changefreq>\n    <priority>${priority}</priority>\n  </url>`);

  // Product id -> date of the last commit that touched its checklist.
  const setDate = new Map(list.map(cl => [cl.id, fileLastmod(cl.file)]));
  const siteDate = newestDate(setDate.values());

  // Hubs move whenever anything under them moves.
  if (S.id === 'football') push(`${SITE}/`, '1.0', 'daily', siteDate);
  push(`${SITE}${S.base}/sets/`, '0.9', 'weekly', siteDate);
  push(`${SITE}${S.base}/players/`, '0.9', 'weekly', siteDate);
  push(`${SITE}${S.base}/teams/`, '0.9', 'weekly', siteDate);

  // Hand-written pages: who runs the site, how to reach us, and how the prices
  // are arrived at. They are not generated from the checklists, so nothing else
  // in this function would ever list them — and an unlisted page that is only
  // reachable from a footer is easy for a crawler to under-weight.
  //
  // The methodology page in particular is the site explaining its own data, and
  // the closest thing here to an answer to "what makes this worth indexing".
  //
  // Their lastmod is the site date rather than a per-file commit date: they are
  // checked in rather than built, so fileLastmod() would need a path for each
  // and gain nothing — these change rarely and together.
  if (S.id === 'football') for (const p of ['about.html', 'methodology.html', 'contact.html']) {
    push(`${SITE}/${p}`, '0.5', 'monthly', siteDate);
  }

  for (const y of years) {
    push(`${SITE}${S.base}/sets/${y}/`, '0.8', 'weekly',
      newestDate(list.filter(c => c.year === y).map(c => setDate.get(c.id))));
  }
  // Anything carrying noindex is left out: listing a page in the sitemap while
  // telling crawlers not to index it is a contradictory signal.
  let skipped = 0;
  for (const cl of list) {
    const d = setDate.get(cl.id);
    if (isIndexed('product', cl.id)) push(`${SITE}${S.base}/sets/${cl.id}/`, '0.7', 'weekly', d);
    else skipped++;
    // A set page is carved out of its product's file, so it shares the date.
    for (const sub of (subsetIndex.get(cl.id) || [])) {
      if (isIndexed('subset', `${cl.id}/${sub.slug}`)) {
        push(`${SITE}${S.base}/sets/${cl.id}/${sub.slug}/`, '0.6', 'weekly', d);
      } else skipped++;
    }
  }
  // Player and team pages are assembled from every checklist they appear in.
  for (const p of players) {
    if (!isIndexed('player', p.slug)) { skipped++; continue; }
    push(`${SITE}${S.base}/players/${p.slug}/`, '0.6', 'weekly',
      newestDate([...p.setIds].map(id => setDate.get(id))));
  }
  for (const t of teams) {
    push(`${SITE}${S.base}/teams/${t.slug}/`, '0.7', 'weekly',
      newestDate([...(t.setIds || [])].map(id => setDate.get(id))));
  }
  console.log(`  sitemap: ${urls.length} indexable URLs (${skipped} thin pages built but noindexed)`);
  return urls;
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

// Everything a sport's pages are made from, before a page is written. Split
// from the writing so the index budget can see every sport's candidates first.
function prepareSport() {
  S.commitDates = checklistCommitDates(`public/data/${S.folder}/`);
  console.log(`${S.Word}: building landing pages from`, path.relative(ROOT, S.dir));
  const checklists = loadChecklists();
  const playerIndex = buildPlayerIndex(checklists);

  // One player, one page.
  //
  // buildPlayerIndex keys on the raw checklist string, so a player spelled two
  // ways across two checklists became two players with two pages. Twelve did:
  // "Ja’Marr Chase" (1,215 cards) and "Ja'Marr Chase" (31) differ only by a
  // curly apostrophe; "D.K. Metcalf" and "DK Metcalf" only by the periods.
  //
  // This was found by /api/debug/price-coverage rather than by looking. The
  // sales join reported "cj stroud" as a name two pages answered to, so it
  // refused to guess and dropped 2,006 sales on the floor — and the same for
  // Ja'Marr Chase, J.J. McCarthy and De'Von Achane, all of them star players
  // on pages that get actual traffic.
  //
  // The merge key is punctuation-only — the same norm() the sales join uses.
  // It must NOT strip suffixes: "Marvin Harrison" and "Marvin Harrison Jr."
  // are two people with two pages and merging them would be a worse bug than
  // the one being fixed.
  const canon = new Map();   // norm(name) -> primary player
  const merged = [];         // { from, into } for the redirect map
  for (const p of [...playerIndex.values()].sort((a, b) => b.cards.length - a.cards.length)) {
    const k = normName(p.name);
    const prim = canon.get(k);
    if (!prim) { canon.set(k, p); continue; }
    // Fold the smaller spelling into the larger, which is already the primary
    // because the loop runs in card-count order.
    for (const c of p.cards) prim.cards.push(c);
    for (const id of p.setIds) prim.setIds.add(id);
    for (const y of p.years) prim.years.add(y);
    for (const t of p.teams) prim.teams.add(t);
    // Whether this spelling had a page of its own BEFORE the merge decides
    // whether it needs a redirect. Most folded spellings are a handful of
    // cards and never cleared MIN_CARDS, so no URL ever existed to redirect —
    // and inventing one would fill the map with slugs nobody has requested.
    merged.push({
      from: p.name,
      into: prim.name,
      hadPage: p.cards.length >= MIN_CARDS && p.setIds.size >= MIN_SETS && !p.name.includes('/'),
    });
    playerIndex.delete(p.name);
  }

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

  // The URLs the merge just removed.
  //
  // A folded spelling used to get its own page, and because slugify() drops
  // the punctuation that distinguished it, that page was at <base>-2. Those
  // URLs have been crawled — one of them, /players/cj-stroud-2/, is in the
  // current sitemap — so they redirect rather than falling through to the SPA
  // and returning a 200 for a page that no longer exists.
  //
  // A slug a live player legitimately holds is never redirected: after the
  // merge, a -2 can still be two genuinely different people who happen to
  // slugify the same, and sending one to the other would be the collision bug
  // again wearing a different hat.
  const redirects = {};
  for (const { from, into, hadPage } of merged) {
    if (!hadPage) continue;
    const target = playerSlug.get(into);
    if (!target) continue;                       // primary is not an eligible page
    const base = slugify(from) || 'player';
    for (let i = 2; i <= 9; i++) {
      const legacy = `${base}-${i}`;
      if (usedSlugs.has(legacy)) continue;       // a real page owns it
      if (redirects[legacy]) continue;
      redirects[legacy] = target;
      break;
    }
  }
  // setId -> eligible players (for related-player suggestions), in popularity order.
  const setPlayers = new Map();
  for (const p of eligible) for (const sid of p.setIds) {
    if (!setPlayers.has(sid)) setPlayers.set(sid, []);
    setPlayers.get(sid).push(p);
  }

  // NFL team index + slug lookup (for player↔team cross-links).
  const teamIndex = buildTeamIndex(checklists);
  const teams = [...teamIndex.values()].sort((a, b) => a.name.localeCompare(b.name));
  const teamSlug = new Map(teams.map(t => [t.name, t.slug]));

  // Sets inside each product that earn their own page, and the years present.
  const subsetIndex = new Map(checklists.map(cl => [cl.id, eligibleSubsets(cl)]));
  const subsetTotal = [...subsetIndex.values()].reduce((n, a) => n + a.length, 0);
  const years = [...new Set(checklists.map(c => c.year).filter(Boolean))].sort((a, b) => b - a);
  const byYear = new Map(years.map(y => [y, checklists.filter(c => c.year === y)]));

  console.log(`  ${checklists.length} sets (${checklists.reduce((n, c) => n + c.cardCount, 0).toLocaleString()} cards)`);
  console.log(`  ${subsetTotal} set pages inside them (>= ${MIN_SUBSET_CARDS} cards, duplicates of a sibling skipped)`);
  console.log(`  ${years.length} year hubs`);
  console.log(`  ${eligible.length} eligible players (>= ${MIN_CARDS} cards in >= ${MIN_SETS} sets)`);
  console.log(`  ${teams.length} ${S.league} team pages`);
  return { checklists, eligible, merged, redirects, setPlayers, teams, teamSlug, playerSlug, subsetIndex, subsetTotal, years, byYear };
}

function buildSport({ checklists, eligible, merged, redirects, setPlayers, teams, teamSlug, playerSlug, subsetIndex, subsetTotal, years, byYear }) {
  // Fresh dirs so removed entries don't linger.
  rmDirSafe(S.setsDir); rmDirSafe(S.playersDir); rmDirSafe(S.teamsDir);
  fs.mkdirSync(S.setsDir, { recursive: true });
  fs.mkdirSync(S.playersDir, { recursive: true });
  fs.mkdirSync(S.teamsDir, { recursive: true });
  // One stylesheet for every sport's pages, at /sets/landing.css.
  if (S.id === 'football') fs.writeFileSync(path.join(S.setsDir, 'landing.css'), LANDING_CSS);

  let bytes = 0;
  for (const cl of checklists) {
    const dir = path.join(S.setsDir, cl.id);
    fs.mkdirSync(dir, { recursive: true });
    const subs = subsetIndex.get(cl.id) || [];
    const html = buildSetPage(cl, relatedSets(cl, checklists), playerSlug, subs);
    fs.writeFileSync(path.join(dir, 'index.html'), html); bytes += Buffer.byteLength(html);
    for (const sub of subs) {
      const siblings = subs.filter(x => x.slug !== sub.slug).slice(0, 12);
      const sdir = path.join(dir, sub.slug);
      fs.mkdirSync(sdir, { recursive: true });
      const shtml = buildSubsetPage(cl, sub.set, sub.slug, siblings, playerSlug);
      fs.writeFileSync(path.join(sdir, 'index.html'), shtml); bytes += Buffer.byteLength(shtml);
    }
  }
  for (const y of years) {
    const ydir = path.join(S.setsDir, String(y));
    fs.mkdirSync(ydir, { recursive: true });
    const yhtml = buildYearHub(y, byYear.get(y), subsetIndex);
    fs.writeFileSync(path.join(ydir, 'index.html'), yhtml); bytes += Buffer.byteLength(yhtml);
  }
  for (const p of eligible) {
    const sorted = [...p.cards].sort((a, b) => (b.year || 0) - (a.year || 0));
    const primarySet = sorted[0].setId;
    const related = (setPlayers.get(primarySet) || []).filter(x => x.name !== p.name).slice(0, 10);
    const dir = path.join(S.playersDir, p.slug);
    fs.mkdirSync(dir, { recursive: true });
    const html = buildPlayerPage(p, related, teamSlug);
    fs.writeFileSync(path.join(dir, 'index.html'), html); bytes += Buffer.byteLength(html);
  }
  for (const t of teams) {
    const relatedTeams = teams.filter(x => x.slug !== t.slug).slice(0, 8);
    const dir = path.join(S.teamsDir, t.slug);
    fs.mkdirSync(dir, { recursive: true });
    const html = buildTeamPage(t, playerSlug, relatedTeams);
    fs.writeFileSync(path.join(dir, 'index.html'), html); bytes += Buffer.byteLength(html);
  }

  fs.writeFileSync(path.join(S.setsDir, 'index.html'), buildSetsHub(checklists));
  fs.writeFileSync(path.join(S.playersDir, 'index.html'), buildPlayersHub(eligible));

  // A machine-readable list of the player pages, for the same reason
  // checklists/index.json exists: the Worker needs to know what pages there
  // are without loading 361 checklists to work it out.
  //
  // Player pages are 1,228 of the 2,173 indexable URLs — more than half the
  // site, and far more than the 371 product pages. Whether a price block is
  // worth building is mostly a question about THESE pages, and it could not
  // be asked at all until the Worker could see them.
  //
  // Names only, no card lists. The point is coverage, not content.
  // Which subset a sold card belongs to.
  //
  // The sales table has year, set_name, player, card_number and parallel —
  // and no subset column. A subset page therefore cannot be joined by name;
  // it has to be joined by MEMBERSHIP, because a subset is exactly a list of
  // (player, card number) pairs and a sale carries both.
  //
  // The catch is that inserts reuse the base set's numbering, so within one
  // product 28.5% of (player, number) keys belong to more than one subset.
  // Those are omitted rather than assigned to whichever subset was seen
  // first — the same refusal the sales join makes, for the same reason: a
  // guessed attribution puts one subset's prices on another's page.
  //
  // Dropping them was worth checking for bias, since a median built only from
  // the survivors would be misleading if the excluded cards were the valuable
  // ones. They are not: excluded cards belong to slightly LESS prominent
  // players than included ones (median 313 catalogue appearances against 349).
  //
  // Only subsets big enough to be indexed are listed. The whole map is 1.5 MB
  // — small enough for the daily cron to load, which 27 MB of checklists is
  // not.
  const subsetAttribution = {};
  // The complement of the attribution map: the keys it had to leave out.
  //
  // attribution.json answers "which subset is this card in" and can only do so
  // for keys owned by exactly one set. The keys owned by SEVERAL are the ones
  // where a sale's identity is genuinely uncertain, and until now they were
  // simply dropped — which meant nothing could count them or say how much of
  // the dataset they account for.
  //
  // They are worth naming because they are not a rounding error. Across all 361
  // checklists, 27.0% of (player, number) keys belong to more than one set:
  // 63,182 of 234,071, median product 26.2%, worst 92.5%. Every insert restarts
  // numbering at #1 and `sales` has one set_name column holding the PRODUCT, so
  // those collapse together with nothing to separate them.
  //
  // Emitted from the SAME `owners` tally attribution.json is built from, so the
  // two cannot disagree about what "ambiguous" means.
  // Computed over EVERY set, not just the ones big enough to get a page.
  //
  // That is the one place this must NOT follow attribution.json's filter. A
  // subset page is only built for a set of 25+ cards, so attribution ignores
  // the small ones — but card identity in /api/card-analysis has no such
  // filter, and a ten-card insert collides with the base set there exactly as a
  // three-hundred-card one does. Measuring with the page-building threshold
  // would have quietly undercounted the problem by a fifth (49,693 keys against
  // 63,417) and understated it precisely where the cards are rarest.
  //
  // The two maps are therefore NOT complements and must not be read as such.
  // attribution answers "which page does this card belong to"; this answers "is
  // this card's identity certain at all", which is a broader question with a
  // broader domain.
  // Grouped by WHAT KIND of collision it is, which turned out to matter far
  // more than the total.
  //
  // The first version emitted one flat list, and the flat number was
  // misleading: 30.3% of resolved sales sat on an "ambiguous" key, which read
  // as a third of the dataset being unidentifiable. Reading the examples showed
  // most of them were things like "2025 Prizm Tyler Shough #327 Silver" — a
  // plain base rookie, flagged because the checklist also lists #327 in Base
  // Autographs and Rookie Prizm Choice Auto.
  //
  // Those are different cards, but they are not the same PROBLEM. Across all
  // 63,417 ambiguous keys:
  //
  //   65.5%  base against its own autograph or relic version
  //    6.4%  base against a variation of itself (Etch, Image, Full Set)
  //   28.2%  something involving an insert
  //
  // The first is resolved by one word in the title — sellers never omit "auto"
  // or "patch", because it is most of the price. The last is what reading
  // insert names is for. Lumping them together pointed the effort at the wrong
  // one, so the kind travels with the key.
  // The sales join's files (attribution, ambiguity, player index, redirects)
  // are football's: only football has sold data to join.
  if (S.id === 'football') {
    const AUTOISH = new Set(['autograph', 'memorabilia']);
    const subsetAmbiguous = {};
    for (const cl of checklists) {
      const owners = new Map();
      for (const x of (cl.sets || [])) {
        for (const c of (x.cards || [])) {
          const k = cardMemberKey(c);
          if (!owners.has(k)) owners.set(k, []);
          owners.get(k).push(x.category || '');
        }
      }
      const byKind = { auto: [], insert: [], variation: [] };
      for (const [k, cats] of owners) {
        if (cats.length < 2) continue;
        const set = new Set(cats);
        // An insert in the mix is the hard case and wins the classification: it
        // is the one a title's insert name has to resolve.
        if (set.has('insert')) byKind.insert.push(k);
        else if ([...set].some(c => AUTOISH.has(c))) byKind.auto.push(k);
        else byKind.variation.push(k);
      }
      const out = {};
      for (const [kind, list] of Object.entries(byKind)) if (list.length) out[kind] = list.sort();
      if (Object.keys(out).length) subsetAmbiguous[cl.id] = out;
    }

    for (const cl of checklists) {
      const sets = (cl.sets || []).filter(x => (x.cards || []).length >= MIN_SUBSET_CARDS);
      if (!sets.length) continue;
      const owners = new Map();
      for (const x of sets) {
        for (const c of (x.cards || [])) {
          const k = cardMemberKey(c);
          owners.set(k, (owners.get(k) || 0) + 1);
        }
      }
      // Grouped by subset, { slug: [keys] }, so each slug is written once
      // rather than once per card: keyed per card, the repeated slugs were a
      // third of the file and pushed it past what a Worker should load.
      // server.js inverts it back to key -> slug when it reads it.
      const m = {};
      for (const sub of (subsetIndex.get(cl.id) || [])) {
        if ((sub.set.cards || []).length < INDEX_MIN_SUBSET_CARDS) continue;
        for (const c of (sub.set.cards || [])) {
          const k = cardMemberKey(c);
          if (owners.get(k) === 1) (m[sub.slug] = m[sub.slug] || []).push(k);
        }
      }
      if (Object.keys(m).length) subsetAttribution[cl.id] = m;
    }
    fs.mkdirSync(path.join(DATA_DIR, 'subsets'), { recursive: true });
    // Packed for size. Keys are `player|number`, and the same players recur in
    // hundreds of products, so each player is written once in `players` and a
    // key becomes `<index>|<number>`; a subset's keys are one newline-joined
    // string. { players: [...], products: { id: { slug: "12|4\n97|5" } } }.
    // server.js (_attributionFor) and subset-attribution.test.js unpack it.
    const attrPlayers = [], attrIdx = new Map();
    const packed = {};
    for (const [id, groups] of Object.entries(subsetAttribution)) {
      packed[id] = {};
      for (const [slug, keys] of Object.entries(groups)) {
        packed[id][slug] = keys.map(k => {
          const at = k.lastIndexOf('|');
          const pl = k.slice(0, at);
          if (!attrIdx.has(pl)) { attrIdx.set(pl, attrPlayers.length); attrPlayers.push(pl); }
          return `${attrIdx.get(pl)}|${k.slice(at + 1)}`;
        }).join('\n');
      }
    }
    fs.writeFileSync(path.join(DATA_DIR, 'subsets', 'attribution.json'),
      JSON.stringify({ players: attrPlayers, products: packed }) + '\n');
    fs.writeFileSync(path.join(DATA_DIR, 'subsets', 'ambiguous.json'),
      JSON.stringify(subsetAmbiguous) + '\n');

    fs.mkdirSync(path.join(DATA_DIR, 'players'), { recursive: true });
    fs.writeFileSync(path.join(DATA_DIR, 'players', 'redirects.json'), JSON.stringify(redirects) + '\n');
    fs.writeFileSync(path.join(DATA_DIR, 'players', 'index.json'), JSON.stringify({
      generated: new Date().toISOString().slice(0, 10),
      minCards: MIN_CARDS, minSets: MIN_SETS, indexMinCards: INDEX_MIN_PLAYER_CARDS,
      mergedSpellings: merged.length,
      players: eligible.map(p => ({
        name: p.name, slug: p.slug, cards: p.cards.length, sets: p.setIds.size,
        // Built either way; only these are in the sitemap.
        indexable: isIndexed('player', p.slug),
      })),
    }) + '\n');
  }
  fs.writeFileSync(path.join(S.teamsDir, 'index.html'), buildTeamsHub(teams));
  const urls = buildSitemap(checklists, eligible, teams, years, subsetIndex);

  console.log(`  wrote ${checklists.length} product + ${subsetTotal} set + ${eligible.length} player + ${teams.length} team pages + ${years.length} year hubs + 3 hubs + sitemap`);
  console.log(`  total generated HTML: ${(bytes / 1024 / 1024).toFixed(1)} MB`);
  {
    const { withAds, withoutAds } = _adsStats;
    const total = withAds + withoutAds;
    console.log(ADSENSE_CLIENT
      ? `  AdSense: ${withAds}/${total} pages carry the tag `
        + `(${total ? Math.round((withAds / total) * 100) : 0}%) — `
        + `the indexable ones; ${withoutAds} noindexed pages carry none`
      : '  AdSense: disabled (ADSENSE_CLIENT empty)');
  }
  return urls;
}

function main() {
  const sports = [];
  for (const cfg of SPORT_CONFIGS) {
    if (!fs.existsSync(cfg.dir)) continue;
    S = cfg;
    sports.push({ cfg, ctx: prepareSport() });
  }
  planIndex(sports);
  const urls = [];
  for (const { cfg, ctx } of sports) {
    S = cfg;
    urls.push(...buildSport(ctx));
  }
  if (urls.length > INDEX_BUDGET) throw new Error(`sitemap has ${urls.length} URLs, over the ${INDEX_BUDGET} budget`);
  fs.writeFileSync(path.join(PUBLIC_DIR, 'sitemap.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`);
  console.log(`sitemap: ${urls.length} indexable URLs across every sport`);
  console.log('  done.');
}

main();
