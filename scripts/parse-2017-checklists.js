#!/usr/bin/env node
/**
 * Parse the 2017 NFL checklists into per-product JSON files.
 *
 * Source: the "2017 Checklists - Part N" text files at the repo root. Unlike
 * the 2023 DOCX source, these are already one record per line:
 *
 *   2017 Panini Preferred Football Checklist    <- article title
 *   Base Set Checklist                          <- set header
 *   379 cards.
 *   Parallels:
 *   • Prime – /49
 *   2 Tyler Lockett, Seattle Seahawks /25       <- card
 *
 * so none of the 2023 parser's un-gluing machinery is needed. The work is in
 * telling the four kinds of line apart, because the source is a scrape of
 * Beckett article pages: set headers sit alongside table-of-contents range
 * notes, parallel bullet lists, prose asides, and page furniture.
 *
 * The same shapes come out of scripts/ocr-pdf.sh if a future year only
 * arrives as an image PDF, so the noise tolerance here (bullet glyphs
 * read back as ¢/¥/e/°/*, gibberish scraped off card photos) is kept.
 *
 * This ADDS to the existing checklists — 2017 products already on disk that
 * this source doesn't cover, such as Panini Certified, are left alone.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CHECKLISTS_DIR = path.join(ROOT, 'public', 'data', 'checklists');
const INDEX_PATH = path.join(CHECKLISTS_DIR, 'index.json');

// Every 2017 source text at the repo root, in name order, unless explicit
// paths are passed. Globbing rather than a fixed list so that dropping in a
// later part picks it up with no edit here. The uploaded names are
// percent-encoded ("2017%20Checklists%20-%20Part%202_AI_optimized.txt"),
// which the pattern tolerates.
const TEXT_PATHS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : fs.readdirSync(ROOT)
      .filter(f => /^2017(%20|\s)*Checklists.*\.txt$/i.test(f))
      .sort()
      .map(f => path.join(ROOT, f));

// Each article in the source starts with its title on its own line:
//   "2017 Panini Preferred Football Checklist"
//   "2017 Panini Preferred Football Autographs"
//   "2017 Panini Preferred Football Memorabilia Cards"
// i.e. "<year> <product> Football <section>". The section tells us the
// default category for every set in that article.
const PRODUCT_HEADER_RE = /^(20\d{2}\s+[A-Za-z][A-Za-z0-9 .'’&\/-]*?\s+Football)\s+(?:(Autographs?|Memorabilia Cards?|Relics?|Inserts?|Base Cards?|Base Set|Rookie Cards?|Parallels?)\s+)?Checklists?\s*$/;

// Ad tiles OCR'd off the page render come through as ALL CAPS, and the
// "previous/next article" rail truncates its titles with an ellipsis.
// Neither is a real article title.
function isProductHeaderLine(line) {
  if (!PRODUCT_HEADER_RE.test(line)) return false;
  if (/\.\.\.\s*$/.test(line)) return false;
  if (line === line.toUpperCase()) return false;
  return true;
}

// Everything after this marker is site furniture — comment prompts, the
// share rail, the author bio, and OCR noise scraped off ad images — until
// the next article title. Cutting here keeps that garbage from being
// mistaken for sets and cards.
const FOOTER_RE = /^(Checklist Top|Comments\?|SHARE:|Previous Article|Next Article|Ryan Cracknell\s*$|A collector for much of his life)/i;

// Page furniture that can also appear inline, above the footer cut.
const CHROME_RE = /^(Here'?s|Next Article|Previous Article|Cheap Wax|Ryan Cracknell|THE BECKETT|Beckett|Subscribe|Shop Now|RELATED|LEAVE|Top of|Bottom of|Stay in|LATEST|NEW CHECK|\d+ COMMENTS?|Collecting|What does|Copyright|SUBJECT|Please reach|Check out|View |Buy on|Refer to|Highest print|Want to know|Second Look|Click here|Share|Tweet|Print|Email|Advertisement|When you click|https?:|www\.)/i;

function main() {
  let text = '';
  for (const p of TEXT_PATHS) {
    if (!fs.existsSync(p)) { console.error(`missing source: ${p}`); process.exit(1); }
    const t = fs.readFileSync(p, 'utf8');
    console.log(`Loaded ${t.length} chars from ${path.basename(p)}`);
    text += t + '\n';
  }
  const lines = text.split('\n').map(l => l.replace(/\s+$/, ''));
  console.log(`Loaded ${lines.length} lines total`);

  // ---- Pass 1: locate every product header ----
  const headers = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!isProductHeaderLine(t)) continue;
    const m = t.match(PRODUCT_HEADER_RE);
    headers.push({ lineIdx: i, product: normalizeProduct(m[1]), suffix: (m[2] || '').trim() });
  }
  console.log(`Found ${headers.length} header occurrences`);
  canonicalizeProductNames(headers);

  // ---- Pass 2: group blocks by product ----
  const order = [];
  const blocks = new Map();
  for (let h = 0; h < headers.length; h++) {
    const head = headers[h];
    const end = (h + 1 < headers.length) ? headers[h + 1].lineIdx : lines.length;
    // A header immediately followed by the next header is a repeated page
    // banner, not a block with content.
    if (end - head.lineIdx <= 1) continue;
    if (!blocks.has(head.product)) { blocks.set(head.product, []); order.push(head.product); }
    blocks.get(head.product).push({ start: head.lineIdx + 1, end, suffix: head.suffix });
  }
  console.log(`Grouped into ${order.length} unique products`);

  // ---- Pass 3: parse ----
  const products = [];
  for (const name of order) {
    const product = parseProduct(name, blocks.get(name), lines);
    // Merge, fold variants onto their base, then merge again — folding can
    // produce two entries with the same id under different categories
    // ("Great X-Pectations Gold" as base, "... Purple" as insert).
    product.sets = mergeDuplicateIdSets(consolidateSets(mergeDuplicateIdSets(product.sets)));
    const total = product.sets.reduce((s, x) => s + x.cards.length, 0);
    if (total === 0) { console.log(`  skip ${name} — no cards parsed`); continue; }
    console.log(`  ${name}: ${product.sets.length} sets, ${total} cards`);
    products.push(product);
  }

  // ---- Write ----
  for (const p of products) {
    fs.writeFileSync(path.join(CHECKLISTS_DIR, `${p.id}.json`), JSON.stringify(p));
  }
  console.log(`\nWrote ${products.length} product files`);

  // ---- Index: add/replace only the products this source produced ----
  // Deliberately NOT a year-wide wipe. 2017 products already in the index
  // (e.g. Panini Certified) stay put unless this source also covers them.
  const index = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
  const produced = new Set(products.map(p => p.id));
  index.products = index.products.filter(p => !produced.has(p.id));
  for (const p of products) {
    index.products.push({
      id: p.id,
      name: p.name,
      year: p.year,
      brand: p.brand,
      sport: p.sport,
      setCount: p.sets.length,
      totalCards: p.sets.reduce((s, x) => s + (x.totalCards || x.cards.length), 0),
    });
  }
  index.products.sort((a, b) => (b.year - a.year) || a.name.localeCompare(b.name));
  fs.writeFileSync(INDEX_PATH, JSON.stringify(index));
  console.log(`Updated index — ${index.products.length} total products`);
}

// ============================================================
//   Product / set parsing
// ============================================================
function parseProduct(productName, productBlocks, lines) {
  const product = {
    id: idify(productName),
    name: productName,
    year: yearOf(productName),
    brand: deriveBrand(productName),
    sport: 'Football',
    sets: [],
  };

  for (const block of productBlocks) {
    const slice = openImplicitBaseSet(cutAtFooter(lines.slice(block.start, block.end)));
    // The header suffix ("– Autographs", "– Inserts") sets the default
    // category for every set inside the block.
    let category = categoryForSuffix(block.suffix);
    let i = 0;
    while (i < slice.length) {
      const line = slice[i].trim();
      if (!line) { i++; continue; }
      const marker = bareCategoryMarker(line, slice, i);
      if (marker) { category = marker; i++; continue; }
      if (isSetHeader(line, slice, i)) {
        const res = parseSet(slice, i, category);
        if (res && res.set.cards.length > 0) { product.sets.push(res.set); i = res.nextLine; continue; }
      }
      i++;
    }
  }
  return product;
}

// Most base articles name their set ("Base Set Checklist"), but some go
// straight from the article title to the card count:
//
//   2017 Panini Prestige Football Checklist
//   300 cards.
//   Veterans – #1-200          <- a range note, not a set
//
// leaving the 300 cards with no set to live in. Synthesize the header the
// article left implicit.
function openImplicitBaseSet(slice) {
  const first = slice.findIndex(l => l.trim());
  if (first === -1) return slice;
  if (!/^\d+\s+cards?\b/i.test(slice[first].trim())) return slice;
  const out = slice.slice();
  out.splice(first, 0, 'Base Set');
  return out;
}

function cutAtFooter(slice) {
  const end = slice.findIndex(l => FOOTER_RE.test(l.trim()));
  return end === -1 ? slice : slice.slice(0, end);
}

// A short standalone line that names a section rather than a set. Only
// counts when the following lines are cards/sets, not a card count — a
// real set header is followed by "N cards."
function bareCategoryMarker(line, slice, idx) {
  if (line.length > 40 || isCardLine(line)) return null;
  if (!/^(Autographs?|Memorabilia|Relics?|Inserts?|Base|Parallels?)\s*(Cards?)?$/i.test(line)) return null;
  for (let j = idx + 1; j < Math.min(idx + 4, slice.length); j++) {
    const n = slice[j].trim();
    if (!n) continue;
    if (/^\d+\s+cards?\b/i.test(n)) return null; // it's a set header
    break;
  }
  if (/^Autograph/i.test(line)) return 'autograph';
  if (/^(Memorabilia|Relic)/i.test(line)) return 'memorabilia';
  if (/^Insert/i.test(line)) return 'insert';
  return null;
}

function parseSet(slice, startIdx, category) {
  const setName = cleanSetName(slice[startIdx].trim());
  if (!setName) return null;
  let i = startIdx + 1;
  let totalCards = 0;
  const parallels = [];
  const cards = [];

  // "Parallels listed under Autographs tab." sits exactly where the
  // "Parallels:" block would be. Skipped rather than parsed, or it becomes
  // a set name and steals the real set's cards.
  const isNoise = (l) => !l || CHROME_RE.test(l) || /^Parallels?\b(?!\s*:?\s*$)/i.test(l);
  const skipNoise = () => { while (i < slice.length && isNoise(slice[i].trim())) i++; };

  skipNoise();
  if (i < slice.length) {
    const cm = slice[i].trim().match(/^(\d+)\s+cards?\b/i);
    if (cm) { totalCards = parseInt(cm[1], 10); i++; }
  }

  // One loop for the whole set body. The "Parallels:" block does not always
  // sit right after the card count — base articles list their card ranges
  // first — so it's consumed wherever it turns up rather than treated as the
  // end of the set. Ending there left products whose base article is laid
  // out that way (Prestige, Score) with zero cards.
  while (i < slice.length) {
    const cl = slice[i].trim();
    if (!cl) { i++; continue; }
    if (isSetHeader(cl, slice, i)) break;
    if (bareCategoryMarker(cl, slice, i)) break;
    // "Parallels:" is the usual opener, but some sets introduce the same
    // bullet list with prose ("Each card has four versions:"). Any line
    // ending in a colon that a bullet follows opens the list.
    if (/^Parallels?\s*:?\s*$/i.test(cl) || (/:\s*$/.test(cl) && startsBulletList(slice, i + 1))) {
      i++;
      while (i < slice.length) {
        const pl = stripBullet(slice[i].trim());
        if (!pl) { i++; continue; }
        if (isCardLine(pl) || isSetHeader(pl, slice, i) || /^Parallels?\s*:?\s*$/i.test(pl)) break;
        const par = parseParallel(pl);
        if (par) parallels.push(par);
        i++;
      }
      continue;
    }
    if (isCardLine(cl)) { const c = parseCard(cl); if (c) cards.push(c); }
    i++;
  }

  let cat = category;
  if (/auto(graph)?|signature|penmanship|scripts|ink\b/i.test(setName)) cat = 'autograph';
  else if (/relic|jersey|patch|memorabilia|material|swatch/i.test(setName)) cat = 'memorabilia';

  return {
    set: {
      id: idify(setName),
      name: setName,
      category: cat,
      totalCards: totalCards || cards.length,
      parallels: parallels.length ? parallels : [{ name: 'Base', printRun: null }],
      cards,
    },
    nextLine: i,
  };
}

// ============================================================
//   Line classification
// ============================================================
// Three shapes turn up:
//   "12 Dan Marino, Miami Dolphins /5"   number + player + team
//   "375 Richard Sherman /5"             number + player (parallel lists
//                                        drop the team)
//   "RPS-AL Andrew Luck, Indianapolis Colts"  code-numbered inserts
function isCardLine(line) {
  if (!line || line.length < 6) return false;
  if (/^\d+\s+cards?\b/i.test(line)) return false;
  if (/^\d{1,4}\s+[A-Z][^,]{1,80},\s*[A-Z]/.test(line)) return true;
  if (/^[A-Z]{1,5}-[A-Z0-9]{1,6}\s+[A-Z]/.test(line)) return true;
  // Team-less. Capped at 3 digits so a stray year ("2017 Panini …") can't
  // pose as a card number, and the name has to read like a name — mixed
  // case, no bracket/pipe soup from OCR'd ad art.
  const m = line.match(/^\d{1,3}\s+([A-Z][A-Za-z.'’\-\/ ]{2,80}?)(\s+\/?\d+(\/\d+)?)?\s*$/);
  if (m && /[a-z]/.test(m[1])) return true;
  return false;
}

function isSetHeader(line, slice, idx) {
  if (!line || line.length > 120) return false;
  if (isCardLine(line)) return false;
  if (CHROME_RE.test(line)) return false;
  if (PRODUCT_HEADER_RE.test(line)) return false;
  if (/^\d/.test(line)) return false;             // "379 cards.", "#2-60 — ..."
  if (/^[#•¢°¥*]/.test(line)) return false;       // parallel bullets, range notes
  if (/^Checklists?\s*$/i.test(line)) return false; // the article's own section label
  if (/^Parallels?\b/i.test(line)) return false;
  if (/^Versions?\b/i.test(line)) return false;
  if (!looksLikeTitle(line)) return false;
  // Must be followed within a few lines by a card count, a parallels block,
  // or actual card data — otherwise it's stray prose.
  for (let j = idx + 1; j < Math.min(idx + 8, slice.length); j++) {
    const n = slice[j].trim();
    if (!n) continue;
    if (/^\d+\s+cards?\b/i.test(n)) return true;
    if (/^Parallels?\s*:?\s*$/i.test(n)) return true;
    if (isCardLine(n)) return true;
  }
  return false;
}

// Card images on the page render as gibberish under OCR — ": ‘ =i ; :",
// "in (", "6%", "ey". Those lines sit between a set header and its
// "Parallels:" block, so without a plausibility check the LAST scrap of
// noise wins the set name and the real header ends up with zero cards.
// A genuine set title is mostly letters and has at least one real word.
function looksLikeTitle(line) {
  if (line.length < 3) return false;
  if (!/[A-Za-z]{3}/.test(line)) return false;
  // Range notes are the base article's table of contents, not sets:
  // "#1-200 – Veterans" and the reversed "Concourse – #1-100".
  if (!/^[A-Za-z(]/.test(line)) return false;
  if (/[–—-]\s*#\d/.test(line)) return false;
  // Prose, not a title. Set names never end in a colon or a full stop, but
  // the source's parallel-list preambles ("Each card has four versions:")
  // and its one-off notes ("Kizer has only a Black Prizm … parallels.") do,
  // and both sit exactly where a set header would.
  if (/[:.]\s*$/.test(line)) return false;
  const letters = (line.match(/[A-Za-z0-9 ]/g) || []).length;
  return letters / line.length >= 0.7;
}

function parseCard(line) {
  let printRun = null;
  let clean = line
    // "n/a" is the source's way of saying this card has no print run.
    .replace(/\s+n\/a\s*$/i, '')
    .replace(/\s+\/(\d+)\s*$/, (_, pr) => { printRun = parseInt(pr, 10); return ''; })
    .replace(/\s+(\d+)\/(\d+)\s*$/, (_, n, d) => { if (printRun == null) printRun = parseInt(d, 10); return ''; })
    .replace(/\s*[–—-]\s*no base version\s*$/i, '')
    .trim();
  // The source drops the slash on a handful of print runs — "32 Louis Lipps
  // 194" sits between "/199" and "/149". Player names never end in digits,
  // so a trailing number here is always the print run.
  if (printRun == null) {
    clean = clean.replace(/^(.*[A-Za-z].*?)\s+(\d{1,4})\s*$/, (_, rest, pr) => {
      printRun = parseInt(pr, 10);
      return rest;
    });
  }
  // "RC" (rookie card) and "SP" (short print) are annotations, not part of
  // the team — left on, they fork "Cleveland Browns" into a second team.
  clean = clean.replace(/\s+(RC|SP|RC\s+SP|SP\s+RC)\s*$/i, '').trim();
  const withTeam = clean.match(/^(\S+)\s+([^,]+),\s*(.+?)$/);
  if (withTeam) {
    const card = { number: withTeam[1], player: withTeam[2].trim(), team: withTeam[3].trim() };
    if (printRun) card.printRun = printRun;
    return card;
  }
  // Parallel checklists list the player without a team.
  const noTeam = clean.match(/^(\S+)\s+(.+?)$/);
  if (!noTeam) return null;
  const card = { number: noTeam[1], player: noTeam[2].trim() };
  if (printRun) card.printRun = printRun;
  return card;
}

// OCR renders the source's • bullet as ¢, ¥, e, °, or *.
function stripBullet(s) {
  return s.replace(/^[¢•°¥*e]\s+/, '').trim();
}

function startsBulletList(slice, idx) {
  for (let j = idx; j < Math.min(idx + 3, slice.length); j++) {
    const t = slice[j].trim();
    if (!t) continue;
    return /^[¢•°¥*]\s+/.test(t);
  }
  return false;
}

function parseParallel(line) {
  let m = line.match(/^(.+?)\s*[–—-]\s*\/?(\d+)(?:\s+or less)?\s*(?:\(.*\))?\s*$/);
  if (m && !/^\d/.test(m[1])) return { name: m[1].trim(), printRun: parseInt(m[2], 10) };
  m = line.match(/^(.+?)\s*[–—-]\s*1\/1\s*$/);
  if (m) return { name: m[1].trim(), printRun: 1 };
  if (line.length < 80 && !/^\d/.test(line) && /[A-Za-z]/.test(line) && !CHROME_RE.test(line)) {
    return { name: line.replace(/\s*[–—-]\s*$/, '').trim(), printRun: null };
  }
  return null;
}

// ============================================================
//   Shared helpers (same conventions as the 2023/2024 parsers)
// ============================================================
function normalizeProduct(s) {
  return s.replace(/\s+/g, ' ').trim();
}

// The source is inconsistent about the manufacturer prefix: Select's base
// article is titled "2017 Panini Select Football" while its autograph and
// memorabilia articles are "2017 Select Football". Left alone that ships as
// two half-products. Group names that differ only by the prefix and keep the
// prefixed form, matching the rest of the catalog (2017 Panini Certified …).
function canonicalizeProductNames(headers) {
  const byKey = new Map();
  for (const h of headers) {
    const key = h.product.replace(/^(20\d{2})\s+Panini\s+/, '$1 ');
    if (!byKey.has(key)) byKey.set(key, new Set());
    byKey.get(key).add(h.product);
  }
  const canonical = new Map();
  for (const [key, names] of byKey) {
    if (names.size < 2) continue;
    const prefixed = [...names].find(n => /^20\d{2}\s+Panini\s/.test(n));
    const pick = prefixed || [...names][0];
    for (const n of names) if (n !== pick) canonical.set(n, pick);
    console.log(`  merged ${[...names].filter(n => n !== pick).join(', ')} -> ${pick}`);
  }
  for (const h of headers) {
    if (canonical.has(h.product)) h.product = canonical.get(h.product);
  }
}

function yearOf(productName) {
  const m = productName.match(/^(20\d{2})/);
  return m ? parseInt(m[1], 10) : 2017;
}

function cleanSetName(raw) {
  let s = raw
    .replace(/\s*Check[l]?ists?\s*/gi, '')   // the source misspells it "Checkist" in places
    .replace(/\s*[–—-]\s*Master Card List\s*/gi, '')
    .replace(/\s*[–—-]\s*$/g, '')
    .replace(/^20\d{2}\s+.*?Football\s*/i, '')
    .replace(/\.\s*Buy on eBay\.?\s*/gi, '')
    .trim();
  if (/^Base$/i.test(s)) s = 'Base Set';
  return s;
}

function categoryForSuffix(suffix) {
  if (!suffix) return 'base';
  if (/auto(graph)?|signature/i.test(suffix)) return 'autograph';
  if (/relic|memorabilia|material/i.test(suffix)) return 'memorabilia';
  if (/insert/i.test(suffix)) return 'insert';
  return 'base';
}

function idify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

function deriveBrand(productName) {
  return productName
    .replace(/^20\d{2}\s+/, '')
    .replace(/^Panini\s+/, '')
    .replace(/\s+Football$/, '')
    .trim();
}

function mergeDuplicateIdSets(sets) {
  const byId = new Map();
  for (const set of sets) {
    const existing = byId.get(set.id);
    if (!existing) { byId.set(set.id, set); continue; }
    const [primary, secondary] = set.cards.length > existing.cards.length ? [set, existing] : [existing, set];
    const seen = new Set(primary.cards.map(c => `${c.number}|${c.player}`));
    for (const c of secondary.cards) {
      const k = `${c.number}|${c.player}`;
      if (!seen.has(k)) { primary.cards.push(c); seen.add(k); }
    }
    for (const p of (secondary.parallels || [])) {
      if (!primary.parallels.some(x => x.name === p.name)) primary.parallels.push(p);
    }
    primary.totalCards = Math.max(primary.totalCards || 0, secondary.totalCards || 0, primary.cards.length);
    byId.set(set.id, primary);
  }
  return Array.from(byId.values());
}

// Trailing colour/finish words that mark a set as a parallel of another.
// Deliberately excludes ordinary nouns the 2023 list carried — Zone, Power,
// Stars, Ice, Wave, Knight, Meta, Universal — because they also end real set
// names: "Red Zone" was being folded into a phantom "Red" set with "Zone"
// as its parallel.
const VARIANT_WORDS = 'Red|Blue|Green|Gold|Silver|Purple|Orange|Pink|Black|White|Bronze|Yellow|Aqua|Teal|Platinum|Neon|Holo|Chrome|Shimmer|Sparkle|Press Proof|Die-Cut|Canvas|Camo|Finite|Vinyl|Foil|Hyper|Pandora|Velocity|Prizm|Mojo|Scope|Fluorescent|Reactive|Cracked Ice|Ruby|Sapphire|Emerald|Diamond|Tiger Stripe|Kaboom|Nebula|Peacock|Pulsar|Lazer|Disco|Snakeskin|Mosaic|Color Blast|Lava|Fractor|X-Fractor|Refractor|Stained Glass|Supernova|Interstellar|Splatter';
const VARIANT_RE = new RegExp(`\\s+(${VARIANT_WORDS})(\\s+(${VARIANT_WORDS}))*\\s*$`, 'i');

function consolidateSets(sets) {
  const groups = new Map();
  for (const set of sets) {
    const baseName = set.name.replace(VARIANT_RE, '').trim();
    const variantName = (set.name === baseName) ? null : set.name.substring(baseName.length).trim();
    const key = `${set.category}:${baseName}`;
    if (!variantName) {
      if (groups.has(key)) {
        const existing = groups.get(key);
        if (set.cards.length > existing.cards.length) {
          existing.cards = set.cards;
          existing.totalCards = Math.max(existing.totalCards, set.totalCards);
        }
        for (const p of (set.parallels || [])) {
          if (!existing.parallels.some(ep => ep.name === p.name)) existing.parallels.push(p);
        }
      } else {
        groups.set(key, { ...set, parallels: [...(set.parallels || [])] });
      }
    } else {
      if (!groups.has(key)) {
        groups.set(key, {
          id: idify(baseName), name: baseName, category: set.category,
          totalCards: 0, parallels: [{ name: 'Base', printRun: null }], cards: [],
        });
      }
      const target = groups.get(key);
      if (!target.parallels.some(p => p.name === variantName)) {
        target.parallels.push({ name: variantName, printRun: null });
      }
      if (target.cards.length === 0) {
        target.cards = set.cards;
        target.totalCards = set.totalCards || set.cards.length;
      }
    }
  }
  return Array.from(groups.values());
}

if (require.main === module) main();
module.exports = { isCardLine, isSetHeader, parseCard, parseParallel, cleanSetName, idify };
