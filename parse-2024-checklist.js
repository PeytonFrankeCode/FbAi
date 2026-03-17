#!/usr/bin/env node
/**
 * Parse the 2024 checklist DOCX and merge into data/checklists.json
 */
const mammoth = require('mammoth');
const fs = require('fs');
const path = require('path');

const DOCX_PATH = path.join(__dirname, 'Peyton Code - Panini+Topps - Checklist 2024.docx');
const CHECKLISTS_PATH = path.join(__dirname, 'data', 'checklists.json');

// Known product boundaries (line indices where real products start)
const PRODUCT_HEADERS = [
  { line: 0, name: '2024 Panini Prizm Football', brand: 'Prizm' },
  { line: 888, name: '2024 Panini Prizm Deca Football', brand: 'Prizm Deca' },
  { line: 1068, name: '2024 Panini Prizm Draft Picks Football', brand: 'Prizm Draft Picks' },
  { line: 1624, name: '2024 Donruss Football', brand: 'Donruss' },
  { line: 6062, name: '2024 Panini Mosaic Football', brand: 'Mosaic', endOverride: 7000 },
  // Skip 7000-7123 (Bowman Chrome - just web junk, no real data)
  // Skip 7124 (duplicate Mosaic data)
  { line: 8030, name: '2024 Panini Phoenix Football', brand: 'Phoenix' },
  { line: 8960, name: '2024 Panini Prestige Football', brand: 'Prestige' },
  { line: 9696, name: '2024 Panini Contenders Football', brand: 'Contenders' },
  { line: 10334, name: '2024 Panini Contenders Optic Football', brand: 'Contenders Optic' },
  { line: 10848, name: '2024 Panini Certified Football', brand: 'Certified' },
  { line: 11812, name: '2024 Panini Totally Certified Football', brand: 'Totally Certified', dashSep: true },
  { line: 12420, name: '2024 Panini Absolute Football', brand: 'Absolute' },
  { line: 13374, name: '2024 Panini Illusions Football', brand: 'Illusions' },
  { line: 14164, name: '2024 Panini Rookies & Stars Football', brand: 'Rookies & Stars' },
  { line: 14768, name: '2024 Panini Luminance Football', brand: 'Luminance' },
  { line: 15336, name: '2024 Panini Zenith Football', brand: 'Zenith' },
  { line: 15914, name: '2024 Panini Encore Football', brand: 'Encore' },
  { line: 16182, name: '2024 Panini Obsidian Football', brand: 'Obsidian' },
  { line: 16866, name: '2024 Panini Origins Football', brand: 'Origins' },
  { line: 17366, name: '2024 Panini Photogenic Football', brand: 'Photogenic', endOverride: 26036 },
  { line: 26036, name: '2024 Donruss Optic Draft Picks Football', brand: 'Donruss Optic Draft Picks' },
  { line: 28850, name: '2024 Topps Midnight Football', brand: 'Topps Midnight' },
];

async function main() {
  const result = await mammoth.extractRawText({ path: DOCX_PATH });
  const allLines = result.value.split('\n');
  console.log(`Total lines in DOCX: ${allLines.length}`);

  const products = [];

  for (let pi = 0; pi < PRODUCT_HEADERS.length; pi++) {
    const ph = PRODUCT_HEADERS[pi];
    const nextStart = pi + 1 < PRODUCT_HEADERS.length ? PRODUCT_HEADERS[pi + 1].line : allLines.length;
    const endLine = ph.endOverride || nextStart;

    const lines = allLines.slice(ph.line, endLine);
    console.log(`\nParsing: ${ph.name} (lines ${ph.line}-${endLine}, ${lines.length} lines)`);

    const product = parseProduct(lines, ph);
    if (product && product.sets.length > 0) {
      products.push(product);
      const totalCards = product.sets.reduce((sum, s) => sum + s.cards.length, 0);
      console.log(`  -> ${product.sets.length} sets, ${totalCards} total cards`);
    }
  }

  console.log(`\nTotal 2024 products parsed: ${products.length}`);

  // Consolidate color variant sets into parent sets as parallels
  let totalBefore = 0, totalAfter = 0;
  products.forEach(p => {
    totalBefore += p.sets.length;
    p.sets = consolidateSets(p.sets);
    totalAfter += p.sets.length;
  });
  console.log(`\nConsolidated sets: ${totalBefore} -> ${totalAfter} (merged ${totalBefore - totalAfter} color variants)`);

  // Load existing checklists.json and merge
  const existing = JSON.parse(fs.readFileSync(CHECKLISTS_PATH, 'utf8'));

  // Remove any existing 2024 products
  existing.products = existing.products.filter(p => p.year !== 2024);

  // Add new 2024 products
  existing.products.push(...products);

  // Sort by year desc, then name
  existing.products.sort((a, b) => b.year - a.year || a.name.localeCompare(b.name));

  fs.writeFileSync(CHECKLISTS_PATH, JSON.stringify(existing, null, 2));
  console.log(`\nWrote ${existing.products.length} total products to ${CHECKLISTS_PATH}`);
}

function parseProduct(lines, header) {
  const productId = header.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  const useDash = header.dashSep || false;

  const product = {
    id: productId,
    name: header.name,
    year: 2024,
    brand: header.brand,
    sport: 'Football',
    sets: []
  };

  let i = 0;
  let currentCategory = 'base';

  while (i < lines.length) {
    const line = lines[i].trim();

    // Detect category headers
    if (line.match(/^Autograph/i) && line.length < 80 && !isCardDataLine(line, useDash)) {
      currentCategory = 'autograph';
      i++;
      continue;
    }
    if (line.match(/^(Memorabilia|Relic|Jersey|Patch)/i) && line.length < 80 && !isCardDataLine(line, useDash)) {
      currentCategory = 'memorabilia';
      i++;
      continue;
    }
    if (line.match(/^Insert/i) && line.length < 80 && !isCardDataLine(line, useDash)) {
      currentCategory = 'insert';
      i++;
      continue;
    }

    if (isSetHeader(line, lines, i, useDash)) {
      const setData = parseSet(lines, i, currentCategory, product, useDash);
      if (setData) {
        product.sets.push(setData.set);
        i = setData.nextLine;
        continue;
      }
    }

    i++;
  }

  return product;
}

function isSetHeader(line, lines, idx, useDash) {
  if (!line || line.length === 0 || line.length > 120) return false;

  // Skip known non-headers
  if (line.match(/^(Here'?s|Next Article|Cheap Wax|Ryan Cracknell|THE BECKETT|Subscribe|Shop Now|RELATED|LEAVE|Top of|Bottom of|Stay in|LATEST|NEW CHECK|2023|2022|2021|2020|1 COMMENT|Collecting|What does|Copyright|SUBJECT|Please reach|Check out|View |Buy on|Refer to|Highest print|Versions:|Parallels:)/i)) return false;
  if (line.match(/^(Black and|Blue |Choice |Disco|Green |Lazer|Neon|No Huddle|Orange|Pink|Press |Purple|Red |Silver|Snakeskin|Wave|White|Hyper|Navy|Gold |Forest|Stars Black|Pandora|Aqueous|Canvas|Yellow|Color Blast|Kaboom|Mojo|Camo|Fluorescent|Galactic|Genesis|Stained Glass|National Pride|Reactive|Mosaic|Nebula|Peacock|Snow|Tiger|Burst|Shimmer|Cracked Ice|Vinyl|Finite|Sparkle|Scope|Knight|Power|Cherry|Die-Cut|Mirror |Brand Logo|Heel Logo|Interstellar|Meta |Universal|Splatter|Psychedelic|Spectris|Supernova)/i) && !line.match(/Checklist/i)) return false;
  if (line.match(/^(Parallels?|Parallel)\b/i)) return false;
  if (line.match(/^\d+\s+cards/i)) return false;
  if (line.match(/^–\s*\/\d+/)) return false;
  if (line.match(/^\s*$/)) return false;
  // Skip lines that look like parallel entries (contain print run patterns)
  if (line.match(/–\s*\/\d+\s*$/) || line.match(/–\s*1\/1\s*$/) || line.match(/–\s*\(print runs vary/i)) return false;
  // Skip lines that are just parallel names with print runs (no "Checklist" or "Set")
  if (line.match(/\s+\/\d+\s*$/) && !line.match(/Checklist/i) && line.length < 60) return false;
  if (line.match(/\s+1\/1\s*$/) && !line.match(/Checklist/i) && line.length < 60) return false;
  // Skip lines that are clearly card data
  if (isCardDataLine(line, useDash)) return false;

  // Must be followed within a few lines by card count or parallels or card data
  for (let j = idx + 1; j < Math.min(idx + 10, lines.length); j++) {
    const next = lines[j].trim();
    if (next.match(/^\d+\s+cards/i)) return true;
    if (next.match(/^Parallels?:/i)) return true;
    if (next.match(/^Versions?:/i)) return true;
    if (isCardDataLine(next, useDash)) return true;
  }

  return false;
}

function parseSet(lines, startIdx, category, product, useDash) {
  const setName = cleanSetName(lines[startIdx].trim());
  let i = startIdx + 1;
  let totalCards = 0;
  let parallels = [];
  let cards = [];

  // Skip blank lines and junk
  while (i < lines.length && (lines[i].trim() === '' || lines[i].trim().match(/^(SUBJECT|Please reach|Check out|View |Buy on|Refer to|Highest print)/i))) i++;

  // Look for card count
  if (i < lines.length) {
    const countMatch = lines[i].trim().match(/^(\d+)\s+cards?/i);
    if (countMatch) {
      totalCards = parseInt(countMatch[1]);
      i++;
    }
  }

  // Skip blank lines and junk
  while (i < lines.length && (lines[i].trim() === '' || lines[i].trim().match(/^(SUBJECT|Please reach|Check out|View |Buy on|Refer to|Highest print)/i))) i++;

  // Look for parallels section - can be multi-line or inline (separated by semicolons)
  if (i < lines.length && (lines[i].trim().match(/^Parallels?:/i) || lines[i].trim().match(/^Versions?:/i))) {
    const headerLine = lines[i].trim();

    // Check if parallels are inline (semicolon-separated on same line)
    const inlineContent = headerLine.replace(/^(Parallels?|Versions?):?\s*/i, '').trim();
    if (inlineContent && inlineContent.includes(';')) {
      // Inline parallels: "Parallels: Name1; Name2 /123; Name3 1/1"
      const parts = inlineContent.split(';');
      for (const part of parts) {
        const p = parseInlineParallel(part.trim());
        if (p) parallels.push(p);
      }
      i++;
    } else {
      i++;
      // Multi-line parallels
      while (i < lines.length) {
        const pLine = lines[i].trim();
        if (pLine === '' || pLine === ' ') { i++; continue; }
        if (pLine.match(/^(SUBJECT|Please reach|Check out|View |Buy on|Refer to|Highest print)/i)) { i++; continue; }

        if (isCardDataLine(pLine, useDash)) break;
        if (isSetHeader(pLine, lines, i, useDash)) break;
        if (pLine.match(/^(Autograph|Memorabilia|Insert|Relic)/i) && pLine.length < 80 && !isCardDataLine(pLine, useDash)) break;

        const parallel = parseParallel(pLine);
        if (parallel) {
          parallels.push(parallel);
        }
        i++;
      }
    }
  }

  // Skip blank lines and junk
  while (i < lines.length && (lines[i].trim() === '' || lines[i].trim() === ' ' || lines[i].trim().match(/^(SUBJECT|Please reach|Check out|View |Buy on|Refer to|Highest print)/i))) i++;

  // Parse card data
  while (i < lines.length) {
    const cardLine = lines[i].trim();
    if (cardLine === '' || cardLine === ' ') { i++; continue; }

    // Check for end of this set
    if (isSetHeader(cardLine, lines, i, useDash)) break;
    if (cardLine.match(/^Parallels?:/i) || cardLine.match(/^Versions?:/i)) break;
    if (cardLine.match(/^(Autograph|Memorabilia|Insert|Relic)/i) && cardLine.length < 80 && !isCardDataLine(cardLine, useDash)) break;
    if (cardLine.match(/^2024.*(?:Football|Checklist)/i) && cardLine.length < 200) break;
    if (cardLine.match(/^2023\s/i)) break;
    // Skip junk lines
    if (cardLine.match(/^(SUBJECT|Please reach|Check out|View |Buy on|Refer to|Highest print)/i)) { i++; continue; }
    // Skip "Rookies" sub-headers within a card data block (inline, like "Rookies 101 Caleb...")
    // But not standalone "Rookies" set headers

    if (isCardDataLine(cardLine, useDash)) {
      const parsed = parseCardLine(cardLine, useDash);
      cards.push(...parsed);
    }
    i++;
  }

  if (cards.length === 0 && totalCards === 0) return null;

  const setId = setName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');

  let cat = category;
  if (setName.match(/auto(graph)?|signature/i)) cat = 'autograph';
  else if (setName.match(/relic|jersey|patch|memorabilia|material|swatch|baller/i)) cat = 'memorabilia';

  return {
    set: {
      id: setId,
      name: setName,
      category: cat,
      totalCards: totalCards || cards.length,
      parallels: parallels.length > 0 ? parallels : [{ name: 'Base', printRun: null }],
      cards
    },
    nextLine: i
  };
}

function cleanSetName(name) {
  return name
    .replace(/\s*Checklist\s*/gi, '')
    .replace(/\s*–\s*Master Card List\s*/gi, '')
    .replace(/\s*–\s*Autographs?\s*$/gi, '')
    .replace(/\s*–\s*Memorabilia Cards?\s*$/gi, '')
    .replace(/\s*–\s*Inserts?\s*$/gi, '')
    .replace(/\s*–\s*$/g, '')
    .replace(/^2024\s+.*?Football\s*/i, '')
    .replace(/\.\s*Buy on eBay\.?\s*/gi, '')
    .trim() || 'Base Set';
}

function parseParallel(line) {
  // Match "Name – /123"
  let match = line.match(/^(.+?)\s*–\s*\/(\d+)\s*$/);
  if (match) return { name: match[1].trim(), printRun: parseInt(match[2]) };

  // Match "Name – 1/1"
  match = line.match(/^(.+?)\s*–\s*1\/1\s*$/);
  if (match) return { name: match[1].trim(), printRun: 1 };

  // Match "Name – (print runs vary...)"
  match = line.match(/^(.+?)\s*–\s*\(print runs vary.*\)\s*$/i);
  if (match) return { name: match[1].trim(), printRun: null };

  // Match "Name /123" (no dash)
  match = line.match(/^(.+?)\s+\/(\d+)\s*$/);
  if (match && !match[1].match(/^\d/)) return { name: match[1].trim(), printRun: parseInt(match[2]) };

  // Match "Name 1/1" (no dash)
  match = line.match(/^(.+?)\s+1\/1\s*$/);
  if (match && !match[1].match(/^\d/)) return { name: match[1].trim(), printRun: 1 };

  // Just a name
  if (line.length < 80 && !line.match(/^\d/) && line.match(/[A-Za-z]/) && !line.match(/^(Here|Check|View|Buy|Refer|Highest|SUBJECT|Please)/i)) {
    return { name: line.trim(), printRun: null };
  }

  return null;
}

function parseInlineParallel(text) {
  if (!text) return null;
  // "Name /123" or "Name 1/1" or just "Name"
  let match = text.match(/^(.+?)\s+\/(\d+)\s*$/);
  if (match) return { name: match[1].trim(), printRun: parseInt(match[2]) };

  match = text.match(/^(.+?)\s+1\/1\s*$/);
  if (match) return { name: match[1].trim(), printRun: 1 };

  if (text.length > 0 && text.match(/[A-Za-z]/)) {
    return { name: text.trim(), printRun: null };
  }
  return null;
}

function isCardDataLine(line, useDash) {
  if (!line || line.length < 10) return false;
  // Numbered cards with comma: "1 Player Name, Team"
  if (line.match(/^\d+\s+[A-Z][a-z].*,\s*[A-Z]/)) return true;
  // Numbered cards with dash: "1 Player Name - Team"
  if (useDash && line.match(/^\d+\s+[A-Z][a-z].*\s-\s[A-Z]/)) return true;
  // Prefixed cards: "ABC-1 Player Name, Team"
  if (line.match(/^[A-Z]{1,6}-[A-Z0-9]+\s+[A-Z][a-z].*,\s*[A-Z]/)) return true;
  // Prefixed cards with dash separator: "ABC-1 Player Name - Team"
  if (line.match(/^[A-Z]{1,6}-[A-Z0-9]+\s+[A-Z][a-z].*\s-\s[A-Z]/)) return true;
  // Cards starting with "Rookies 101 Caleb..." (inline sub-header)
  if (line.match(/^(?:Rookies|Legends|Veterans)\s+\d+\s+[A-Z]/i)) return true;
  return false;
}

function parseCardLine(line, useDash) {
  const cards = [];

  // Strip inline sub-headers like "Rookies " or "Legends "
  let cleanLine = line.replace(/^(?:Rookies|Legends|Veterans)\s+(?=\d)/i, '');

  // Prefixed cards
  if (cleanLine.match(/^[A-Z]{1,6}-[A-Z0-9]/)) {
    const entries = cleanLine.split(/(?=(?:[A-Z]{1,6}-[A-Za-z0-9]+\s))/);
    for (const entry of entries) {
      const parsed = parseSingleCard(entry.trim(), true, useDash);
      if (parsed) cards.push(parsed);
    }
    return cards;
  }

  // Numbered cards
  const parts = splitNumberedCards(cleanLine, useDash);
  for (const part of parts) {
    const parsed = parseSingleCard(part.trim(), false, useDash);
    if (parsed) cards.push(parsed);
  }

  return cards;
}

function parseSingleCard(text, isPrefixed, useDash) {
  if (!text) return null;

  // Strip trailing print run like " /100", " /49", " 1/1", or " (no base)"
  let printRun = null;
  let cleanText = text;
  // Handle " /100" format
  cleanText = cleanText.replace(/\s+\/(\d+)(\s*\(.*\))?\s*$/, (_, pr) => {
    printRun = parseInt(pr);
    return '';
  });
  // Handle " 1/1" format (exact match)
  if (!printRun) {
    cleanText = cleanText.replace(/\s+(\d+)\/(\d+)\s*$/, (_, num, den) => {
      if (num === den || den === '1') {
        printRun = parseInt(den);
      } else {
        printRun = parseInt(den);
      }
      return '';
    });
  }

  // Strip trailing notes like " (eBay)" or " RC" or " – no base version"
  cleanText = cleanText.replace(/\s*\(eBay\)\s*$/i, '');
  cleanText = cleanText.replace(/\s*–\s*no base version\s*$/i, '');
  cleanText = cleanText.replace(/\s+RC\s*$/i, '');
  cleanText = cleanText.replace(/\s*\(no base\)\s*$/i, '');

  let m;
  if (isPrefixed) {
    m = cleanText.match(/^([A-Z]{1,6}-[A-Za-z0-9]+)\s+(.+?)(?:,\s*|\s+-\s+)(.+?)$/);
  } else {
    // Try comma first, then dash
    m = cleanText.match(/^(\d+)\s+(.+?),\s*(.+?)$/);
    if (!m && useDash) {
      m = cleanText.match(/^(\d+)\s+(.+?)\s+-\s+(.+?)$/);
    }
  }

  if (m) {
    const card = {
      number: m[1].trim(),
      player: m[2].trim(),
      team: m[3].trim()
    };
    if (printRun) card.printRun = printRun;
    return card;
  }

  return null;
}

function splitNumberedCards(line, useDash) {
  const results = [];
  const starts = [];

  // The separator between player and team (comma or dash)
  const sep = useDash ? ' - ' : ',';

  // Pre-process: separate print run from next card number
  // e.g., "/1002 Marcus" should be "/100 2 Marcus" (print run /100, card #2)
  // Also handle "1/13 Marcus" → "1/1 3 Marcus" (print run 1/1, card #3)
  let processedLine = line;

  // Handle "/PRCARD_NUM" → "/PR CARD_NUM" (e.g., "/10025 Marcus" → "/100 25 Marcus")
  processedLine = processedLine.replace(/\/(\d{2,})(\d+\s+[A-Z][a-z])/g, (match, pr, rest) => {
    return `/${pr} ${rest}`;
  });

  // Handle "N/NCARD_NUM" → "N/N CARD_NUM" (e.g., "1/13 Marcus" → "1/1 3 Marcus")
  processedLine = processedLine.replace(/(\d+)\/(\d+?)(\d+\s+[A-Z][a-z])/g, (match, num, den, rest) => {
    return `${num}/${den} ${rest}`;
  });

  // Find all potential card start positions
  // Pattern: digits followed by space and uppercase+lowercase (clearly a name)
  const regex = /(\d+)\s+([A-Z][a-z])/g;
  let m;

  while ((m = regex.exec(processedLine)) !== null) {
    const pos = m.index;
    const num = m[1];

    // Skip if preceded by "/" (part of a print run we couldn't split)
    if (pos > 0 && processedLine[pos - 1] === '/') continue;

    // Skip if the digits are part of a word like "49ers" — check next chars
    // (But our regex already requires space+uppercase after digits, so "49ers" won't match)

    starts.push(pos);
  }

  for (let i = 0; i < starts.length; i++) {
    const start = starts[i];
    const end = i + 1 < starts.length ? starts[i + 1] : processedLine.length;
    results.push(processedLine.substring(start, end).trim());
  }

  return results;
}

// ---- Set Consolidation ----
// Color variant suffixes that indicate a parallel, not a separate set
// All known color/material/finish variant names used across products
const VARIANT_WORDS = 'Red|Blue|Green|Gold|Silver|Purple|Orange|Pink|Black|White|Bronze|Yellow|Aqua|Teal|Platinum|Neon|Holo|Chrome|Shimmer|Sparkle|Ice|Wave|Press Proof|Die-Cut|Canvas|Camo|Finite|Vinyl|Foil|Hyper|Zone|Stars|Pandora|Velocity|Prizm|Mojo|Scope|Fluorescent|Reactive|Cracked Ice|Ruby|Sapphire|Emerald|Diamond|Tiger Stripe|Kaboom|Nebula|Peacock|Knight|Power|Cherry Blossom|Checker|Pulsar|Lazer|Disco|Snakeskin|Mosaic|Color Blast|Lava|Fractor|X-Fractor|Refractor|Stained Glass|Meta|Neon Splatter|Psychedelic|Spectris|Supernova|Interstellar|Universal|Splatter';
const COLOR_VARIANT_PATTERN = new RegExp(`\\s+(${VARIANT_WORDS})(\\s+(${VARIANT_WORDS}))*\\s*$`, 'i');

function getBaseSetName(name) {
  return name.replace(COLOR_VARIANT_PATTERN, '').trim();
}

function getVariantName(name, baseName) {
  if (name === baseName) return null;
  return name.substring(baseName.length).trim();
}

function consolidateSets(sets) {
  const groups = new Map(); // baseName+category -> { baseSet, variants }
  const result = [];

  for (const set of sets) {
    const baseName = getBaseSetName(set.name);
    const variantName = getVariantName(set.name, baseName);
    const key = `${set.category}:${baseName}`;

    if (!variantName) {
      // This is a base set (no color suffix)
      if (groups.has(key)) {
        // Already have a base - merge cards if this one has more
        const existing = groups.get(key);
        if (set.cards.length > existing.baseSet.cards.length) {
          // Keep the one with more cards as the base, add old one's cards as variant
          if (existing.baseSet.cards.length > 0) {
            existing.variants.push({ name: 'Base (alt)', cards: existing.baseSet.cards, printRun: null });
          }
          existing.baseSet.cards = set.cards;
          existing.baseSet.totalCards = Math.max(existing.baseSet.totalCards, set.totalCards);
        } else if (set.cards.length > 0) {
          existing.variants.push({ name: 'Base (alt)', cards: set.cards, printRun: null });
        }
        // Merge parallels
        for (const p of set.parallels) {
          if (!existing.baseSet.parallels.some(ep => ep.name === p.name)) {
            existing.baseSet.parallels.push(p);
          }
        }
      } else {
        groups.set(key, { baseSet: { ...set }, variants: [] });
      }
    } else {
      // This is a color variant
      if (!groups.has(key)) {
        // No base set yet - create a placeholder
        groups.set(key, {
          baseSet: {
            id: baseName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, ''),
            name: baseName,
            category: set.category,
            totalCards: 0,
            parallels: [{ name: 'Base', printRun: null }],
            cards: []
          },
          variants: []
        });
      }

      const group = groups.get(key);
      // Extract print run from the variant's parallels or cards
      let variantPrintRun = null;
      if (set.parallels.length === 1 && set.parallels[0].printRun) {
        variantPrintRun = set.parallels[0].printRun;
      }
      // Check if cards have consistent print runs
      if (!variantPrintRun && set.cards.length > 0 && set.cards[0].printRun) {
        variantPrintRun = set.cards[0].printRun;
      }

      // Add as a parallel to the base set
      if (!group.baseSet.parallels.some(p => p.name === variantName)) {
        group.baseSet.parallels.push({ name: variantName, printRun: variantPrintRun });
      }

      // If the base set has no cards but this variant does, use these cards
      if (group.baseSet.cards.length === 0 && set.cards.length > 0) {
        group.baseSet.cards = set.cards.map(c => {
          const { printRun, ...rest } = c;
          return rest;
        });
        group.baseSet.totalCards = Math.max(group.baseSet.totalCards, set.totalCards || set.cards.length);
      } else if (set.cards.length > group.baseSet.cards.length) {
        // This variant has more cards than current base - use it
        group.baseSet.cards = set.cards.map(c => {
          const { printRun, ...rest } = c;
          return rest;
        });
        group.baseSet.totalCards = Math.max(group.baseSet.totalCards, set.totalCards || set.cards.length);
      }
    }
  }

  // Build the result, maintaining original order
  const seen = new Set();
  for (const set of sets) {
    const baseName = getBaseSetName(set.name);
    const key = `${set.category}:${baseName}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (groups.has(key)) {
      const group = groups.get(key);
      result.push(group.baseSet);
    }
  }

  return result;
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
