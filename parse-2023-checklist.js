#!/usr/bin/env node
/**
 * Parse 2023 NFL checklist DOCX into per-product JSON files.
 *
 * Source: Document (13).docx
 * Output: public/data/checklists/<product-id>.json plus an updated
 *         public/data/checklists/index.json entry per product.
 *
 * The doc mixes two block shapes:
 *
 *   Master Card List (a.k.a. Format A):
 *     "2023 X Football Checklist – Master Card List"
 *     followed by section headers ("Base Set", "Insert", ...) and
 *     cards laid out as "N Player Name, Team Name". The 2024 parser
 *     handles this shape; we reuse a trimmed version of its logic.
 *
 *   Team-split (Format B):
 *     "2023 X Football Checklist – <Team Name>"
 *     repeated 32 times (one per NFL team). Inside each block the
 *     cards are squished into "<SetName><Num> <Player>..." with NO
 *     comma+team because the team is in the header. We collect
 *     every team page for a given product and merge by set name.
 *
 * Collegiate / university products are filtered out (NFL only).
 */

const mammoth = require('mammoth');
const fs = require('fs');
const path = require('path');

const DOCX_PATH = path.join(__dirname, 'Document (13).docx');
const CHECKLISTS_DIR = path.join(__dirname, 'public', 'data', 'checklists');
const INDEX_PATH = path.join(CHECKLISTS_DIR, 'index.json');

// Product names that aren't NFL — skip them.
const NON_NFL = /(Collegiate|University|Alabama)/i;

// Source typos that should canonicalize to the correct spelling so
// duplicate blocks merge into one product.
const PRODUCT_TYPO_FIXES = [
  [/\bLeaf\s+Trintiy\b/g, 'Leaf Trinity'],
];

const PRODUCT_HEADER_RE = /^(2023\s+[A-Za-z][A-Za-z0-9 .'’&-]+?\s+Football)\s+Checklist(?:\s*[–-]\s*(.*))?$/;

function canonicalizeProductName(name) {
  let s = name;
  for (const [pat, rep] of PRODUCT_TYPO_FIXES) s = s.replace(pat, rep);
  return s;
}

async function main() {
  const result = await mammoth.extractRawText({ path: DOCX_PATH });
  const lines = result.value.split('\n');
  console.log(`Loaded ${lines.length} lines from ${path.basename(DOCX_PATH)}`);

  // ---- Pass 1: collect every header occurrence ----
  const headers = []; // { lineIdx, product, suffix }
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t || t.length > 200) continue;
    const m = t.match(PRODUCT_HEADER_RE);
    if (!m) continue;
    const product = canonicalizeProductName(m[1].trim());
    const suffix = (m[2] || '').trim();
    headers.push({ lineIdx: i, product, suffix });
  }
  console.log(`Found ${headers.length} header lines across the doc`);

  // ---- Pass 2: group by product, preserving order of first appearance ----
  const productOrder = [];
  const productBlocks = new Map(); // productName -> [{ start, end, suffix }]
  for (let h = 0; h < headers.length; h++) {
    const head = headers[h];
    if (NON_NFL.test(head.product)) continue;
    const end = (h + 1 < headers.length) ? headers[h + 1].lineIdx : lines.length;
    if (!productBlocks.has(head.product)) {
      productBlocks.set(head.product, []);
      productOrder.push(head.product);
    }
    productBlocks.get(head.product).push({
      start: head.lineIdx + 1,
      end,
      suffix: head.suffix,
    });
  }
  console.log(`Grouped into ${productOrder.length} unique NFL products`);

  // ---- Pass 3: parse each product ----
  const products = [];
  for (const productName of productOrder) {
    const blocks = productBlocks.get(productName);
    const isMaster = blocks.length === 1 && /master card list/i.test(blocks[0].suffix);
    const isTeamSplit = blocks.length > 4 && blocks.every(b => /[A-Z][a-z]+ /.test(b.suffix));

    let product;
    if (isTeamSplit) {
      product = parseTeamSplitProduct(productName, blocks, lines);
    } else if (isMaster) {
      product = parseMasterProduct(productName, blocks[0], lines);
    } else {
      const teamish = blocks.filter(b => /[A-Z][a-z]+ /.test(b.suffix)).length;
      if (teamish === blocks.length && blocks.length >= 2) {
        product = parseTeamSplitProduct(productName, blocks, lines);
      } else {
        // Non-team product with multiple header lines (e.g. "Checklist" plus
        // sub-headers like "Checklist – XLSX File"). Merge into one big
        // block spanning the first start through the last end so the master
        // parser sees the full document body.
        const span = { start: blocks[0].start, end: blocks[blocks.length - 1].end, suffix: blocks[0].suffix };
        product = parseMasterProduct(productName, span, lines);
      }
    }

    if (!product) continue;
    const totalCards = product.sets.reduce((s, x) => s + x.cards.length, 0);
    if (totalCards === 0) {
      console.log(`  skip ${productName} — no cards parsed`);
      continue;
    }
    console.log(`  ${productName}: ${product.sets.length} sets, ${totalCards} cards`);
    products.push(product);
  }

  // ---- Write per-product JSONs ----
  if (!fs.existsSync(CHECKLISTS_DIR)) fs.mkdirSync(CHECKLISTS_DIR, { recursive: true });

  for (const p of products) {
    const outFile = path.join(CHECKLISTS_DIR, `${p.id}.json`);
    fs.writeFileSync(outFile, JSON.stringify(p));
  }
  console.log(`\nWrote ${products.length} product files to ${CHECKLISTS_DIR}`);

  // ---- Update index.json ----
  const index = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
  // Drop any existing 2023 products so re-runs are idempotent.
  index.products = index.products.filter(p => p.year !== 2023);
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
  // Sort: year desc, then name.
  index.products.sort((a, b) => (b.year - a.year) || a.name.localeCompare(b.name));
  fs.writeFileSync(INDEX_PATH, JSON.stringify(index));
  console.log(`Updated ${INDEX_PATH} — ${index.products.length} total products`);
}

// ============================================================
//   Team-split (Format B)
// ============================================================
function parseTeamSplitProduct(productName, blocks, lines) {
  const setsMap = new Map(); // setName -> { name, cards[] }

  for (const block of blocks) {
    const team = block.suffix.trim();
    if (!team || team.length < 3) continue;
    for (let i = block.start; i < block.end; i++) {
      const raw = lines[i];
      if (!raw) continue;
      const line = raw.trim();
      if (!line) continue;
      if (/^Checklist Top$/i.test(line)) continue;
      // Skip any nested 2023 header (shouldn't happen because we already split blocks).
      if (PRODUCT_HEADER_RE.test(line)) continue;

      // Find the boundary where the set name ends and the first card number begins.
      // Pattern: <SetName><digit(s)><space><Capital letter> ...
      const startMatch = line.match(/^([^\d]{1,80}?)(\d+\s+[A-Z])/);
      if (!startMatch) continue;
      const setName = cleanSetName(startMatch[1]);
      if (!setName) continue;
      const cardsText = line.slice(startMatch[1].length);
      const cards = parseTeamSplitCards(cardsText, team);
      if (cards.length === 0) continue;

      if (!setsMap.has(setName)) {
        setsMap.set(setName, { name: setName, cards: [] });
      }
      setsMap.get(setName).cards.push(...cards);
    }
  }

  const sets = Array.from(setsMap.values()).map(s => {
    const set = {
      id: idify(s.name),
      name: s.name,
      category: categoryFor(s.name),
      totalCards: s.cards.length,
      parallels: [{ name: 'Base', printRun: null }],
      cards: s.cards,
    };
    return set;
  });

  // Move variant sets onto their base via the same consolidator the 2024
  // parser uses, so the user doesn't see "Base", "Base Prizm Silver", and
  // "Base Prizm Gold" as separate sets when they're really parallels.
  const consolidated = consolidateSets(sets);

  return wrapProduct(productName, consolidated);
}

function parseTeamSplitCards(text, team) {
  if (!text) return [];
  // Pre-split print runs glued to next card numbers, mirroring 2024 logic.
  let s = text;
  s = s.replace(/\/(\d{2,})(\d+\s+[A-Z][a-z])/g, (_, pr, rest) => `/${pr} ${rest}`);
  s = s.replace(/(\d+)\/(\d+?)(\d+\s+[A-Z][a-z])/g, (_, n, d, rest) => `${n}/${d} ${rest}`);

  // Split positions: digits followed by a single space and a capital letter
  // (start of a player name). Skip positions immediately after "/".
  const starts = [];
  const re = /(\d+)\s+[A-Z][a-z]/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    if (m.index > 0 && s[m.index - 1] === '/') continue;
    starts.push(m.index);
  }
  if (starts.length === 0) return [];

  const out = [];
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i];
    const end = i + 1 < starts.length ? starts[i + 1] : s.length;
    const chunk = s.slice(start, end).trim();
    const card = parseSingleTeamSplitCard(chunk, team);
    if (card) out.push(card);
  }
  return out;
}

function parseSingleTeamSplitCard(text, team) {
  if (!text) return null;
  let printRun = null;
  let clean = text;
  // " /99"
  clean = clean.replace(/\s+\/(\d+)\s*$/, (_, pr) => { printRun = parseInt(pr, 10); return ''; });
  // " 1/1"
  if (!printRun) {
    clean = clean.replace(/\s+(\d+)\/(\d+)\s*$/, (_, n, d) => { printRun = parseInt(d, 10); return ''; });
  }
  // Trailing notes.
  clean = clean
    .replace(/\s*–\s*no base version\s*$/i, '')
    .replace(/\s*–\s*Vertical\s*$/i, '')
    .replace(/\s*–\s*Horizontal\s*$/i, '')
    .replace(/\s*\((no base|eBay)\)\s*$/i, '')
    .replace(/\s+RC\s*$/i, '')
    .trim();
  const m = clean.match(/^(\d+)\s+(.+?)$/);
  if (!m) return null;
  const card = { number: m[1], player: m[2].trim(), team };
  if (printRun) card.printRun = printRun;
  return card;
}

// ============================================================
//   Master Card List (Format A) — trimmed reuse of 2024 logic
// ============================================================
function parseMasterProduct(productName, block, lines) {
  const slice = lines.slice(block.start, block.end);
  // Reuse the 2024 set/card parsing inline.
  const product = wrapProduct(productName, []);
  let i = 0;
  let currentCategory = 'base';
  while (i < slice.length) {
    const line = slice[i].trim();
    if (/^Autograph/i.test(line) && line.length < 80 && !isMasterCardLine(line)) { currentCategory = 'autograph'; i++; continue; }
    if (/^(Memorabilia|Relic|Jersey|Patch)/i.test(line) && line.length < 80 && !isMasterCardLine(line)) { currentCategory = 'memorabilia'; i++; continue; }
    if (/^Insert/i.test(line) && line.length < 80 && !isMasterCardLine(line)) { currentCategory = 'insert'; i++; continue; }
    if (isMasterSetHeader(line, slice, i)) {
      const result = parseMasterSet(slice, i, currentCategory);
      if (result && result.set.cards.length > 0) {
        product.sets.push(result.set);
        i = result.nextLine;
        continue;
      }
    }
    i++;
  }
  product.sets = consolidateSets(product.sets);
  return product;
}

function isMasterCardLine(line) {
  if (!line || line.length < 10) return false;
  if (/^\d+\s+[A-Z][a-z].*,\s*[A-Z]/.test(line)) return true;
  if (/^\d*[A-Z][A-Z0-9]{0,5}-[A-Z0-9]+\s+[A-Z][a-z].*,\s*[A-Z]/.test(line)) return true;
  return false;
}

function isMasterSetHeader(line, slice, idx) {
  if (!line || line.length === 0 || line.length > 120) return false;
  if (/[–\-]\s*(?:1\/1|\/\d+|\()/.test(line)) return false;
  if (/^(Here'?s|Next Article|Cheap Wax|Ryan Cracknell|THE BECKETT|Subscribe|Shop Now|RELATED|LEAVE|Top of|Bottom of|Stay in|LATEST|NEW CHECK|1 COMMENT|Collecting|What does|Copyright|SUBJECT|Please reach|Check out|View |Buy on|Refer to|Highest print|Versions:|Parallels:)/i.test(line)) return false;
  if (/^(Parallels?|Parallel)\b/i.test(line)) return false;
  if (/^\d+\s+cards/i.test(line)) return false;
  if (/^–\s*\/\d+/.test(line)) return false;
  if (/\s+\/\d+\s*$/.test(line) && !/Checklist/i.test(line) && line.length < 60) return false;
  if (/\s+1\/1\s*$/.test(line) && !/Checklist/i.test(line) && line.length < 60) return false;
  if (isMasterCardLine(line)) return false;
  // Must be followed within a few lines by a card-count, parallels block, or card data.
  for (let j = idx + 1; j < Math.min(idx + 10, slice.length); j++) {
    const next = slice[j].trim();
    if (/^\d+\s+cards/i.test(next)) return true;
    if (/^Parallels?:/i.test(next)) return true;
    if (/^Versions?:/i.test(next)) return true;
    if (isMasterCardLine(next)) return true;
  }
  return false;
}

function parseMasterSet(slice, startIdx, category) {
  const setName = cleanSetName(slice[startIdx].trim());
  if (!setName) return null;
  let i = startIdx + 1;
  let totalCards = 0;
  const parallels = [];
  const cards = [];

  while (i < slice.length && (slice[i].trim() === '' || /^(SUBJECT|Please reach|Check out|View |Buy on|Refer to|Highest print)/i.test(slice[i].trim()))) i++;
  if (i < slice.length) {
    const cm = slice[i].trim().match(/^(\d+)\s+cards?/i);
    if (cm) { totalCards = parseInt(cm[1], 10); i++; }
  }
  while (i < slice.length && (slice[i].trim() === '' || /^(SUBJECT|Please reach|Check out|View |Buy on|Refer to|Highest print)/i.test(slice[i].trim()))) i++;

  if (i < slice.length && /^Parallels?:/i.test(slice[i].trim())) {
    i++;
    while (i < slice.length) {
      const pl = slice[i].trim();
      if (pl === '') { i++; continue; }
      if (isMasterCardLine(pl)) break;
      if (isMasterSetHeader(pl, slice, i)) break;
      if (/^(Autograph|Memorabilia|Insert|Relic)/i.test(pl) && pl.length < 80 && !isMasterCardLine(pl)) break;
      const parallel = parseParallel(pl);
      if (parallel) parallels.push(parallel);
      i++;
    }
  }

  while (i < slice.length) {
    const cl = slice[i].trim();
    if (cl === '') { i++; continue; }
    if (isMasterSetHeader(cl, slice, i)) break;
    if (/^Parallels?:/i.test(cl)) break;
    if (/^(Autograph|Memorabilia|Insert|Relic)/i.test(cl) && cl.length < 80 && !isMasterCardLine(cl)) break;
    if (/^2023\s/i.test(cl) && /Football/i.test(cl)) break;
    if (isMasterCardLine(cl)) cards.push(...parseMasterCardLine(cl));
    i++;
  }

  let cat = category;
  if (/auto(graph)?|signature/i.test(setName)) cat = 'autograph';
  else if (/relic|jersey|patch|memorabilia|material|swatch/i.test(setName)) cat = 'memorabilia';

  return {
    set: {
      id: idify(setName),
      name: setName,
      category: cat,
      totalCards: totalCards || cards.length,
      parallels: parallels.length > 0 ? parallels : [{ name: 'Base', printRun: null }],
      cards,
    },
    nextLine: i,
  };
}

function parseMasterCardLine(line) {
  let processed = line.replace(/\/(\d{2,})(\d+\s+[A-Z][a-z])/g, (_, pr, rest) => `/${pr} ${rest}`);
  processed = processed.replace(/(\d+)\/(\d+?)(\d+\s+[A-Z][a-z])/g, (_, n, d, rest) => `${n}/${d} ${rest}`);
  const starts = [];
  const re = /(\d+)\s+([A-Z][a-z])/g;
  let m;
  while ((m = re.exec(processed)) !== null) {
    if (m.index > 0 && processed[m.index - 1] === '/') continue;
    starts.push(m.index);
  }
  const out = [];
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i];
    const end = i + 1 < starts.length ? starts[i + 1] : processed.length;
    const chunk = processed.slice(start, end).trim();
    let printRun = null;
    let clean = chunk
      .replace(/\s+\/(\d+)\s*$/, (_, pr) => { printRun = parseInt(pr, 10); return ''; })
      .replace(/\s+(\d+)\/(\d+)\s*$/, (_, n, d) => { if (!printRun) printRun = parseInt(d, 10); return ''; })
      .replace(/\s*–\s*no base version\s*$/i, '')
      .replace(/\s*\(eBay\)\s*$/i, '')
      .replace(/\s+RC\s*$/i, '');
    const cm = clean.match(/^(\d+)\s+(.+?),\s*(.+?)$/);
    if (cm) {
      const card = { number: cm[1], player: cm[2].trim(), team: cm[3].trim() };
      if (printRun) card.printRun = printRun;
      out.push(card);
    }
  }
  return out;
}

function parseParallel(line) {
  let m = line.match(/^(.+?)\s*–\s*\/(\d+)\s*$/);
  if (m) return { name: m[1].trim(), printRun: parseInt(m[2], 10) };
  m = line.match(/^(.+?)\s*–\s*1\/1\s*$/);
  if (m) return { name: m[1].trim(), printRun: 1 };
  m = line.match(/^(.+?)\s+\/(\d+)\s*$/);
  if (m && !/^\d/.test(m[1])) return { name: m[1].trim(), printRun: parseInt(m[2], 10) };
  m = line.match(/^(.+?)\s+1\/1\s*$/);
  if (m && !/^\d/.test(m[1])) return { name: m[1].trim(), printRun: 1 };
  if (line.length < 80 && !/^\d/.test(line) && /[A-Za-z]/.test(line) && !/^(Here|Check|View|Buy|Refer|Highest|SUBJECT|Please)/i.test(line)) {
    return { name: line.trim(), printRun: null };
  }
  return null;
}

// ============================================================
//   Set / Card helpers shared across both formats
// ============================================================
function cleanSetName(raw) {
  let s = raw
    .replace(/\s*Checklist\s*/gi, '')
    .replace(/\s*–\s*Master Card List\s*/gi, '')
    .replace(/\s*–\s*Autographs?\s*$/gi, '')
    .replace(/\s*–\s*Memorabilia Cards?\s*$/gi, '')
    .replace(/\s*–\s*Inserts?\s*$/gi, '')
    .replace(/\s*–\s*$/g, '')
    .replace(/^2023\s+.*?Football\s*/i, '')
    .replace(/\.\s*Buy on eBay\.?\s*/gi, '')
    .trim();
  // Match the 2024 convention where the base set is named "Base Set" not "Base".
  if (/^Base$/i.test(s)) s = 'Base Set';
  return s || '';
}

function categoryFor(name) {
  if (/auto(graph)?|signature/i.test(name)) return 'autograph';
  if (/relic|jersey|patch|memorabilia|material|swatch/i.test(name)) return 'memorabilia';
  return 'base';
}

function idify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

function wrapProduct(productName, sets) {
  return {
    id: idify(productName),
    name: productName,
    year: 2023,
    brand: deriveBrand(productName),
    sport: 'Football',
    sets,
  };
}

function deriveBrand(productName) {
  // Match the 2024 convention: drop the year, the manufacturer prefix
  // ("Panini "), and the trailing " Football". Donruss/Score/Bowman/Topps
  // products don't have the Panini prefix in their names, so the strip
  // is a no-op there. e.g. "2023 Panini Mosaic Football" -> "Mosaic".
  return productName
    .replace(/^2023\s+/, '')
    .replace(/^Panini\s+/, '')
    .replace(/\s+Football$/, '')
    .trim();
}

// ============================================================
//   Set consolidation — borrowed from the 2024 parser
// ============================================================
const VARIANT_WORDS = 'Red|Blue|Green|Gold|Silver|Purple|Orange|Pink|Black|White|Bronze|Yellow|Aqua|Teal|Platinum|Neon|Holo|Chrome|Shimmer|Sparkle|Ice|Wave|Press Proof|Die-Cut|Canvas|Camo|Finite|Vinyl|Foil|Hyper|Zone|Stars|Pandora|Velocity|Prizm|Mojo|Scope|Fluorescent|Reactive|Cracked Ice|Ruby|Sapphire|Emerald|Diamond|Tiger Stripe|Kaboom|Nebula|Peacock|Knight|Power|Cherry Blossom|Checker|Pulsar|Lazer|Disco|Snakeskin|Mosaic|Color Blast|Lava|Fractor|X-Fractor|Refractor|Stained Glass|Meta|Neon Splatter|Psychedelic|Spectris|Supernova|Interstellar|Universal|Splatter';
const VARIANT_RE = new RegExp(`\\s+(${VARIANT_WORDS})(\\s+(${VARIANT_WORDS}))*\\s*$`, 'i');

function getBaseSetName(name) {
  return name.replace(VARIANT_RE, '').trim();
}

function consolidateSets(sets) {
  const groups = new Map();

  for (const set of sets) {
    const baseName = getBaseSetName(set.name);
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
          id: idify(baseName),
          name: baseName,
          category: set.category,
          totalCards: 0,
          parallels: [{ name: 'Base', printRun: null }],
          cards: [],
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

main().catch(err => { console.error(err); process.exit(1); });
