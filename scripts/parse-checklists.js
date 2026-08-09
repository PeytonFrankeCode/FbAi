#!/usr/bin/env node
/**
 * Parse a year's NFL checklists into per-product JSON files.
 *
 * Source: the "<year> Checklists - Part N" text files at the repo root.
 * Unlike the 2023 DOCX source, these are already one record per line:
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
 * This ADDS to the existing checklists — products already on disk that a
 * source doesn't cover, such as 2017 Panini Certified, are left alone.
 *
 * Each year is parsed on its own, because a compilation carries articles
 * about neighbouring years (updates to an earlier product, stray
 * cross-references) and those are only recognisable as off-year against the
 * year the rest of the file is about.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CHECKLISTS_DIR = path.join(ROOT, 'public', 'data', 'checklists');
const INDEX_PATH = path.join(CHECKLISTS_DIR, 'index.json');

// A .docx source is read through mammoth rather than converted by hand, so
// the file the user uploaded stays the source of truth and no derived copy
// has to be kept in step with it. Word drops the line breaks inside a
// checklist, which splitGluedCardRuns puts back.
function readSource(p) {
  if (!/\.docx$/i.test(p)) return fs.readFileSync(p, 'utf8');
  const { execFileSync } = require('child_process');
  // mammoth is async; this script is otherwise synchronous, so the
  // extraction runs in a child process rather than colouring everything.
  return execFileSync(process.execPath, ['-e', `
    const mammoth = require(${JSON.stringify(require.resolve('mammoth'))});
    mammoth.extractRawText({ path: process.argv[1] })
      .then(r => process.stdout.write(r.value))
      .catch(e => { console.error(e); process.exit(1); });
  `, p], { maxBuffer: 512 * 1024 * 1024, encoding: 'utf8' });
}

// Usage:
//   parse-checklists.js 2018        every "2018 Checklists…" text at the root
//   parse-checklists.js a.txt b.txt those files
//   parse-checklists.js             every year's sources found at the root
//
// Globbing rather than a fixed list so dropping in a later part picks it up
// with no edit here. Uploaded names come back percent-encoded
// ("2018%20Checklists%20-%20Part%201_AI_optimized.txt"), which the pattern
// tolerates. One year at a time — each compilation is parsed on its own so
// its dominant year can be worked out.
const ARGS = process.argv.slice(2);
const YEAR_ARG = ARGS.length === 1 && /^20\d{2}$/.test(ARGS[0]) ? ARGS[0] : null;

// "Checklist" and "Checklists" both turn up — 2021's two parts disagree with
// each other — so the plural is optional.
function sourcesForYear(year) {
  const re = new RegExp(`^${year}(%20|\\s)*Checklists?.*\\.(txt|docx)$`, 'i');
  return fs.readdirSync(ROOT).filter(f => re.test(f)).sort().map(f => path.join(ROOT, f));
}

function allSourceYears() {
  const years = new Set();
  for (const f of fs.readdirSync(ROOT)) {
    const m = f.match(/^(20\d{2})(?:%20|\s)*Checklists?.*\.(?:txt|docx)$/i);
    if (m) years.add(m[1]);
  }
  return [...years].sort();
}

const TEXT_PATHS = YEAR_ARG ? sourcesForYear(YEAR_ARG)
  : ARGS.length ? ARGS
  : null;   // null means "every year", handled in main

// Each article in the source starts with its title on its own line:
//   "2017 Panini Preferred Football Checklist"
//   "2017 Panini Preferred Football Autographs"
//   "2017 Panini Preferred Football Memorabilia Cards"
// i.e. "<year> <product> Football <section>". The section tells us the
// default category for every set in that article.
// The section names are not a closed set — alongside "Autographs" and
// "Memorabilia Cards" the source has "Inserts", "Base Set", "Update", and
// "Rookie Ticket Autograph Parallels" — so the suffix is matched by shape
// (a few words before "Checklists") rather than by enumeration.
// Two title shapes. Up to 2020 the section comes before the word:
//   "2020 Panini Absolute Football Autographs Checklists"
// 2021 puts it after, behind a dash:
//   "2021 Panini Eminence Football Checklist – Autographs"
// Either group can hold the section; whichever matched is the one to read.
const PRODUCT_HEADER_RE = /^(20\d{2}\s+[A-Za-z][A-Za-z0-9 .'’&\/-]*?\s+Football)\s+(?:([A-Z][A-Za-z]*(?:\s+[A-Za-z]+){0,4})\s+)?Checklists?(?:\s*[–—]\s*([A-Z][A-Za-z ]{0,40}?))?\s*$/;

function headerSuffix(m) { return (m[2] || m[3] || '').trim(); }

// The article title is one line in the text sources, but a page render wraps
// it, so OCR puts the trailing "Checklists" on a line of its own:
//
//   2017 Panini Preferred Football Autographs
//   Checklists
//
// Rejoin those before the header matcher runs, or every section article in an
// OCR'd source is invisible and its sets land under the previous product.
// The break lands wherever the render ran out of width, so the tail is not
// always the bare word — "…Football Memorabilia" / "Cards Checklists" splits
// mid-suffix. Rather than enumerate where it can break, join the two halves
// and keep the join only when the result is a title the matcher accepts.
function rejoinWrappedTitles(lines) {
  for (let i = 0; i + 1 < lines.length; i++) {
    const cur = lines[i].trim();
    if (!/^20\d{2}\s/.test(cur) || !/\sFootball\b/.test(cur)) continue;
    if (isProductHeaderLine(cur)) continue;   // already whole
    // Skip blanks the render leaves between the two halves.
    let j = i + 1;
    while (j < lines.length && !lines[j].trim()) j++;
    if (j >= lines.length) continue;
    const joined = `${cur} ${lines[j].trim()}`;
    if (!isProductHeaderLine(joined)) continue;
    lines[i] = joined;
    lines[j] = '';
  }
}

// A long set name wraps in a page render the same way the article title
// does, and only the tail survives as the header:
//
//   Radiant Rookie Patch Signatures Gold Laundry Tags NFL
//   Shield
//   20 cards.
//
// which ships the set as "Shield". A real set header is always followed by
// its card count, parallels, or cards — so a title-shaped line whose only
// follower is another title-shaped line is a wrap fragment, and the two
// belong together.
// Shortest observed wrapped fragment is 46 chars; the shortest false
// positive ("Y.A. Tittle") is 11.
const WRAP_MIN_WIDTH = 35;

function rejoinWrappedSetHeaders(lines) {
  const opensBody = (t) => /^\d+\s+cards?\b/i.test(t) || /^Parallels?\b/i.test(t) || isCardLine(t);
  const nextContent = (from) => {
    for (let j = from; j < lines.length; j++) if (lines[j].trim()) return j;
    return -1;
  };
  for (let i = 0; i < lines.length; i++) {
    const cur = lines[i].trim();
    if (!cur || !looksLikeTitle(cur)) continue;
    if (isProductHeaderLine(cur) || CHROME_RE.test(cur) || FOOTER_RE.test(cur)) continue;
    if (/^Checklists?\s*$/i.test(cur)) continue;
    if (opensBody(cur)) continue;
    const j = nextContent(i + 1);
    if (j === -1) continue;
    // A line only wraps once it has filled the render width, so a short
    // line followed by a set header is two separate things — "Y.A. Tittle"
    // ending a name list, then "Jumbo Rookie Signature Swatches Checklist"
    // starting a set. Without the length floor those get glued together.
    if (cur.length < WRAP_MIN_WIDTH) continue;
    // The tail is judged loosely — it is only the remainder of a name, so
    // it can be a single short word ("Logo", "Shield") that would not stand
    // as a title on its own.
    const tail = lines[j].trim();
    if (!/^[A-Z][A-Za-z0-9’'\- ]*$/.test(tail)) continue;
    if (isProductHeaderLine(tail) || opensBody(tail)) continue;
    if (tail.length > cur.length || cur.length + tail.length > 120) continue;
    // Only a fragment if the tail is the half that actually opens a set.
    const k = nextContent(j + 1);
    if (k === -1 || !opensBody(lines[k].trim())) continue;
    lines[i] = `${cur} ${tail}`;
    lines[j] = '';
  }
}


// A .docx source loses the line breaks inside a checklist, so a whole set
// arrives as one line:
//
//   1 A.J. Green2 Joe Mixon3 Tyler Boyd4 Terry McLaurin…
//   201 Joe Burrow /149202 Tua Tagovailoa /149203 Justin Herbert /149204…
//
// Splitting on "<digits> <capital>" alone cannot tell the print run in
// "/149202" from the card number that follows it. The card numbers run in
// sequence though, so the next one is predictable: look for the number this
// card should be followed by, and the boundary falls where it starts.
const GLUE_LOOKAHEAD = 6;

function splitGluedCardRuns(lines) {
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    // Insert and autograph checklists number their cards by code rather than
    // in sequence — "FA-AJS Aaron Jones Sr., Minnesota VikingsFA-AR Anthony
    // Richardson, …" — so there is no next number to look for. The code
    // itself marks each boundary. Requiring capitals before the hyphen keeps
    // it off hyphenated names like Amon-Ra or Smith-Schuster.
    if (/^[A-Z]{1,5}-[A-Z0-9]{1,8}\s+[A-Z]/.test(t)) {
      const coded = t.split(/(?=[A-Z]{1,5}-[A-Z0-9]{1,8}\s+[A-Z])/).map(x => x.trim()).filter(Boolean);
      if (coded.length > 1) { lines.splice(i, 1, ...coded); i += coded.length - 1; }
      continue;
    }
    if (!/^\d+\s+[A-Z]/.test(t)) continue;
    if (!/\d\s+[A-Z]/.test(t.slice(t.indexOf(' ') + 1))) continue;  // only one card
    const parts = splitGluedCardRun(t);
    if (parts.length < 2) continue;
    lines.splice(i, 1, ...parts);
    i += parts.length - 1;
  }
}

function splitGluedCardRun(line) {
  const out = [];
  let rest = line;
  for (;;) {
    const head = rest.match(/^(\d+)\s+/);
    if (!head) break;
    const num = parseInt(head[1], 10);
    let cut = -1;
    // The next card's number, allowing for a few skipped in the checklist.
    // The nearest candidate wins, not the lowest: when a checklist skips
    // number 5, "5 " still turns up much further along inside "/29915", and
    // taking it would swallow every card in between.
    for (let n = num + 1; n <= num + GLUE_LOOKAHEAD; n++) {
      const at = rest.indexOf(`${n} `, head[0].length);
      if (at === -1 || !/^[A-Z]/.test(rest.slice(at + `${n} `.length))) continue;
      if (cut === -1 || at < cut) cut = at;
    }
    // No sequential match — fall back to any boundary that isn't inside a
    // print run, so an out-of-order or lettered checklist still splits.
    if (cut === -1) {
      const m = rest.slice(head[0].length).match(/(?<![\/\d])\d+\s+[A-Z]/);
      if (m) cut = head[0].length + m.index;
    }
    if (cut === -1) { out.push(rest.trim()); break; }
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut);
  }
  return out.filter(Boolean);
}

// Word also runs the card count into whatever follows it, so a set opens
// with "100 cardsParallels" — neither a count the parser recognises nor a
// parallels block, which cost Topps Finest every card it had.
function splitGluedCountLines(lines) {
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].trim().match(/^(\d+\s+cards?)([A-Z].*)$/);
    if (!m) continue;
    lines.splice(i, 1, `${m[1]}.`, m[2]);
    i++;
  }
}

// A card naming several players, each with a team, is long enough to wrap:
//
//   1 Christian McCaffrey, Stanford Cardinal/Dalvin Cook, Florida State
//   Seminoles/Leonard
//   Fournette, LSU Tigers /25
//
// leaving "Leonard" as a player with no surname. The tell is precise — the
// last slash-segment names a player with no team while earlier segments have
// one — so this cannot fire on an ordinary team-less card and swallow the
// set header that follows it.
function rejoinWrappedCards(lines) {
  for (let i = 0; i + 1 < lines.length; i++) {
    const cur = lines[i].trim();
    if (!cur || !isCardLine(cur)) continue;
    if (/\/\d+\s*$/.test(cur)) continue;              // print run already reached
    const segs = cur.split('/');
    if (segs.length < 2) continue;
    // The wrap can also land just after the comma, leaving "O.J. Howard,"
    // with its team on the next line — so what matters is whether anything
    // follows the comma, not whether one is present.
    if (/,\s*\S/.test(segs[segs.length - 1])) continue;
    if (!segs.slice(0, -1).some(s => s.includes(','))) continue;
    const next = lines[i + 1].trim();
    if (!next || isCardLine(next) || CHROME_RE.test(next) || FOOTER_RE.test(next)) continue;
    if (/^[¢•°¥*]/.test(next) || /^\d+\s+cards?\b/i.test(next)) continue;
    lines[i] = `${cur} ${next}`;
    lines[i + 1] = '';
  }
}

// Ad tiles OCR'd off the page render come through as ALL CAPS, and the
// "previous/next article" rail truncates its titles with an ellipsis.
// Neither is a real article title.
function isProductHeaderLine(line) {
  const m = line.match(PRODUCT_HEADER_RE);
  if (!m) return false;
  if (/\.\.\.\s*$/.test(line)) return false;
  if (line === line.toUpperCase()) return false;
  // "Team Set" articles repeat the same cards broken down by team, in the
  // squashed team-split layout the 2023 parser deals with. The product's
  // master articles already carry every card, so this one only adds a
  // second, worse copy.
  if (/\bTeam Set\b/i.test(headerSuffix(m))) return false;
  // "… Football Checklist – XLSX File" is the spreadsheet download link that
  // sits under every article title, not an article of its own.
  if (/XLSX/i.test(headerSuffix(m))) return false;
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
  if (!TEXT_PATHS) {
    const years = allSourceYears();
    if (!years.length) { console.error('no "<year> Checklists….txt" sources at the repo root'); process.exit(1); }
    for (const y of years) { console.log(`\n===== ${y} =====`); parseSources(sourcesForYear(y)); }
    return;
  }
  parseSources(TEXT_PATHS);
}

function parseSources(paths) {
  let text = '';
  for (const p of paths) {
    if (!fs.existsSync(p)) { console.error(`missing source: ${p}`); process.exit(1); }
    const t = readSource(p);
    console.log(`Loaded ${t.length} chars from ${path.basename(p)}`);
    text += t + '\n';
  }
  const lines = text.split('\n').map(l => l.replace(/\s+$/, ''));
  console.log(`Loaded ${lines.length} lines total`);
  rejoinWrappedTitles(lines);
  rejoinWrappedSetHeaders(lines);
  rejoinWrappedCards(lines);
  splitGluedCountLines(lines);
  splitGluedCardRuns(lines);

  // ---- Pass 1: locate every product header ----
  const headers = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!isProductHeaderLine(t)) continue;
    const m = t.match(PRODUCT_HEADER_RE);
    headers.push({ lineIdx: i, product: normalizeProduct(m[1]), suffix: headerSuffix(m) });
  }
  console.log(`Found ${headers.length} header occurrences`);
  dropOffYearArticles(headers);
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
  // A product this source covers replaces whatever is on disk for the same
  // id. That is intended — a re-run should pick up parser fixes — but it can
  // also quietly overwrite a product that came from somewhere else entirely
  // (Panini Certified predates these files), so any replacement that changes
  // the totals says so.
  for (const p of products) {
    const out = path.join(CHECKLISTS_DIR, `${p.id}.json`);
    if (fs.existsSync(out)) {
      const prev = JSON.parse(fs.readFileSync(out, 'utf8'));
      const before = prev.sets.reduce((s, x) => s + x.cards.length, 0);
      const after = p.sets.reduce((s, x) => s + x.cards.length, 0);
      if (before !== after || prev.sets.length !== p.sets.length) {
        console.log(`  replacing ${p.id}: ${prev.sets.length} sets/${before} cards -> ${p.sets.length} sets/${after} cards`);
      }
    }
    fs.writeFileSync(out, JSON.stringify(p));
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
    let orphan = null;
    while (i < slice.length) {
      const line = slice[i].trim();
      if (!line) { i++; continue; }
      const marker = bareCategoryMarker(line, slice, i);
      if (marker) { category = marker; i++; continue; }
      if (isSetHeader(line, slice, i)) {
        const res = parseSet(slice, i, category);
        if (res && res.set.cards.length > 0) {
          product.sets.push(reclaimStolenName(res.set, orphan));
          orphan = null;
          i = res.nextLine;
          continue;
        }
        // A header that captured nothing is usually the real one, cut off
        // from its cards by page noise sitting between them.
        if (res) orphan = res.set.name;
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

// Some page noise survives the word-shape check because it is shaped like a
// caption — "EST. 1967" off a ticket-stub graphic, "PGA EAS IEE" off a card
// photo. It sits between a set's real header and its cards, so the real
// header parses to nothing and the caption inherits the cards.
//
// Both halves of that signature have to hold before the name is taken back:
// the set that captured the cards is titled in full caps the way a graphic
// is, and the header immediately before it captured nothing while being
// titled like a real set. "PEN PALS" is genuinely printed in caps, and
// keeps its name because no empty header precedes it.
// Graphics on the page are set in capitals, so OCR of one comes back
// shouting. A Title Case set name never does — even an acronym-heavy one
// like "NFL Shields" stays well under the bar, while a stray lowercase
// letter in "KANSAS CITY CHIEFS Ss" no longer buys the caption a pass.
function looksShouted(name) {
  const letters = name.replace(/[^A-Za-z]/g, '');
  if (letters.length < 3) return false;
  const upper = (name.match(/[A-Z]/g) || []).length;
  return upper / letters.length >= 0.7;
}

function reclaimStolenName(set, orphanName) {
  if (!orphanName) return set;
  if (!looksShouted(set.name) || looksShouted(orphanName)) return set;
  set.name = orphanName;
  set.id = idify(orphanName);
  set.category = categoryForSetName(orphanName, set.category);
  return set;
}

// A set's own name overrides the category its article implies — an
// autograph set listed in the base article is still an autograph.
function categoryForSetName(setName, fallback) {
  if (/auto(graph)?|signature|penmanship|scripts|ink\b/i.test(setName)) return 'autograph';
  if (/relic|jersey|patch|memorabilia|material|swatch/i.test(setName)) return 'memorabilia';
  return fallback;
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

// True when the very next thing under a header is its card count.
function declaresCardCount(slice, idx) {
  for (let j = idx + 1; j < slice.length; j++) {
    const n = slice[j].trim();
    if (!n) continue;
    return /^\d+\s+cards?\b/i.test(n);
  }
  return false;
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
    if (isParallelsOpener(cl) || (/:\s*$/.test(cl) && startsBulletList(slice, i + 1))) {
      i++;
      while (i < slice.length) {
        const pl = stripBullet(slice[i].trim());
        if (!pl) { i++; continue; }
        // A parallel list runs until the set's cards start. Asking
        // isSetHeader here ends it early, because a plain parallel name a
        // few lines above the cards looks exactly like a header: 2019's
        // lists carry no bullets, so "Yellow Press Proof" broke out of
        // Donruss's Veterans block and took its 300 cards with it. Only
        // things that cannot be a parallel end the list.
        if (isCardLine(pl)) break;
        if (isParallelsOpener(pl)) break;
        if (/Check[l]?ists?\s*$/i.test(pl)) break;          // an explicit set header
        if (bareCategoryMarker(pl, slice, i)) break;
        if (isProductHeaderLine(pl)) break;
        const par = parseParallel(pl);
        if (par) parallels.push(par);
        i++;
      }
      continue;
    }
    if (isCardLine(cl)) { const c = parseCard(cl); if (c) cards.push(c); }
    i++;
  }

  const cat = categoryForSetName(setName, category);

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
  // A dash annotation is parseCard's business, but it has to get there
  // first: "239 Van Jefferson – no base version" was failing this test on
  // the dash alone and the card was dropped before anything could strip it.
  line = line.replace(/\s+[–—]\s+\S.*$/, '').trim();
  if (/^\d{1,4}\s+[A-Z][^,]{1,80},\s*[A-Z]/.test(line)) return true;
  if (/^[A-Z]{1,5}-[A-Z0-9]{1,6}\s+[A-Z]/.test(line)) return true;
  // Team-less. Capped at 3 digits so a stray year ("2017 Panini …") can't
  // pose as a card number, and the name has to read like a name — mixed
  // case, no bracket/pipe soup from OCR'd ad art.
  const m = line.match(/^\d{1,3}\s+([A-Z][A-Za-z.'’\-\/ ]{2,220}?)(\s+\/?\d+(\/\d+)?)?\s*$/);
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
  // Judge the name the set would actually get. "AKA Checklist" reads as two
  // plausible words, but the set it produces is "AKA" — the trailing word
  // was carrying the line.
  const name = cleanSetName(line);
  if (!looksLikeTitle(line) || !looksLikeTitle(name)) return false;
  // A short one-word name is either a real set ("Ink" in Luminance) or a
  // scrap of page noise ("Pre", "AKA"). What separates them is that the real
  // one declares its size: the source puts "N cards." directly under every
  // genuine set header.
  if (/^\S{1,4}$/.test(name) && !declaresCardCount(slice, idx)) return false;
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
// The lowercase words a real set name is allowed to contain — everything
// else in a title is capitalised, an acronym, or a number.
// No bare "a"/"an": they let photo-caption noise like "OAKLAND RAIDERS a)"
// pass, and no set in the source needs them.
const TITLE_STOPWORDS = new Set(['of', 'the', 'and', 'in', 'for', 'on', 'to', 'at', 'is', 'or', 'with', 'vs']);

// OCR reads the card photos on the page as letter salad that is otherwise
// indistinguishable from a title — "ces Pry et", "ae See", "WNP ay ea erp
// eee", "picasa PEYTON MANNING", "eS) SaaS" — and it lands between a real
// set header and its card count, so the noise wins the set name and the
// real header is left with nothing. Word shape is what separates them:
// titles are made of capitalised words, acronyms, numbers and a handful of
// lowercase connectors, and nothing else.
function wordsLookLikeATitle(line) {
  const words = line.split(/\s+/).filter(Boolean);
  if (!words.length) return false;
  // "NFL MVP" is legitimately all caps; "CHIEFS" and "BO JACKSON DEREK
  // CARR" are photo captions. Length of the longest word tells them apart.
  if (line === line.toUpperCase() && words.some(w => w.length > 5)) return false;
  for (const raw of words) {
    const w = raw.replace(/^[(]|[),.]+$/g, '');
    if (!w) continue;
    if (/^[–—-]+$/.test(w)) continue;                    // "Base – Common"
    if (/^\d+(st|nd|rd|th)?$/i.test(w)) continue;        // "Year 2", "1st Down"
    if (/^[A-Z]{2,5}s?$/.test(w)) continue;              // NFL, MVPs, RPS, XR
    // Two characters minimum: a lone capital is page noise ("L Patriots",
    // "Y Res"), never part of a set name.
    if (/^[A-Z][A-Za-z0-9’'-]+$/.test(w)) continue;      // Rookie, X-Alted, Activ8
    if (TITLE_STOPWORDS.has(w.toLowerCase())) continue;  // Hall of Fame
    return false;
  }
  return true;
}

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
  // En/em dashes belong in set names ("Base – Common"). The characters that
  // actually mark page noise are slashes, brackets and arrows, which the
  // rest of the checks below and above still catch.
  if (/[^A-Za-z0-9 \-–—'’.&(),]/.test(line)) return false;
  if (!wordsLookLikeATitle(line)) return false;
  const letters = (line.match(/[A-Za-z0-9 ]/g) || []).length;
  return letters / line.length >= 0.7;
}

function parseCard(line) {
  let printRun = null;
  // "n/a" is the source's way of saying this card has no print run.
  let clean = line.replace(/\s+n\/a\s*$/i, '').replace(/\s*[–—-]\s*no base version\s*$/i, '').trim();

  // The tail is a stack, not a sequence: "Haason Reddick, Arizona Cardinals
  // /79 RC" puts the rookie marker outside the print run, so stripping the
  // print run first never matches and "/79" survives to be read as a second
  // player. Peel whichever kind of tail is currently outermost, and keep
  // going until nothing more comes off.
  let prev;
  do {
    prev = clean;
    clean = clean
      .replace(/\s+(RC|SP|SSP|VAR|RPS|RR|AUTO|Auto|Mem|Jersey|Patch|Relic|Memorabilia|Dual|Triple|Quad|Jumbo|Rookie)\s*$/i, '')
      // Any trailing dash note — "— Retired", "– Variation", "– no base
      // version" — unless it is a team override, which belongs on the card.
      .replace(/\s+[–—]\s+([A-Za-z][A-Za-z' ]*)$/, (whole, note) => (isKnownTeam(note.trim()) ? whole : ''))
      // "101 Joe Burrow /9 – RPS" runs its marker into the next card's
      // number, so peeling the marker leaves the dash hanging.
      .replace(/\s+[–—]\s*$/, '')
      // "(all Favre Team Variations combined)"
      .replace(/\s*\([^)]*\)\s*$/, '')
      // "103 Sam Darnold SP – 225" writes the print run after a dash rather
      // than a slash, with the short-print marker outside it.
      .replace(/\s+[–—]\s+\/?(\d+)\s*$/, (_, pr) => { if (printRun == null) printRun = parseInt(pr, 10); return ''; })
      .replace(/\s+\/(\d+)\s*$/, (_, pr) => { if (printRun == null) printRun = parseInt(pr, 10); return ''; })
      .replace(/\s+(\d+)\/(\d+)\s*$/, (_, n, d) => { if (printRun == null) printRun = parseInt(d, 10); return ''; })
      .trim();
  } while (clean !== prev);

  // The source drops the slash on a handful of print runs — "32 Louis Lipps
  // 194" sits between "/199" and "/149". Player names never end in digits,
  // so a trailing number here is always the print run.
  if (printRun == null) {
    clean = clean.replace(/^(.*[A-Za-z].*?)\s+(\d{1,4})\s*$/, (_, rest, pr) => {
      printRun = parseInt(pr, 10);
      return rest;
    });
  }

  const m = clean.match(/^(\S+)\s+(.+?)$/);
  if (!m) return null;

  // A card can name one player with a team ("Dan Marino, Miami Dolphins"),
  // several players with none, several players each with their own team
  // ("Richard Sherman, Seattle Seahawks/Michael Crabtree, Oakland Raiders"),
  // or — 2019 only — several players separated by commas rather than
  // slashes ("Mecole Hardman Jr., Patrick Mahomes II, Travis Kelce, Tyreek
  // Hill"). The last shape is why the text after a comma cannot simply be
  // taken for a team: it has to be recognised as one.
  const players = [];
  const teams = [];
  for (const seg of m[2].split('/').map(s => s.trim()).filter(Boolean)) {
    const pair = seg.match(/^(.+?),\s*(.+)$/);
    if (!pair) { players.push(seg); continue; }
    const t = cleanTeam(pair[2]);
    if (printRun == null && t.printRun != null) printRun = t.printRun;
    if (t.team && isKnownTeam(t.team)) {
      players.push(pair[1].trim());
      teams.push(t.team);
    } else {
      // Not a team, so the commas are separating players.
      for (const nm of seg.split(',').map(x => x.trim()).filter(Boolean)) {
        players.push(cleanTeam(nm).team || nm);
      }
    }
  }
  if (!players.length) return null;

  const card = { number: m[1], player: fixOcrSuffix(players.join('/')) };
  // Only a team every player shares belongs on the card.
  if (teams.length === players.length && teams.every(t => t === teams[0])) card.team = teams[0];
  if (printRun) card.printRun = printRun;
  return card;
}

// OCR reads the generational suffix "III" as "Ill" — "John Ross Ill". No
// surname is "Ill", so the correction is unambiguous, and leaving it in
// means the card never matches a search for the real player.
function fixOcrSuffix(player) {
  return player.replace(/\bIll\b/g, 'III');
}

// Whether a comma is followed by a team or by another player can only be
// answered by knowing the teams. The 32 franchises plus the ones that have
// moved or renamed are fixed and worth stating; college programmes are not,
// so they come from the checklists already on disk, whose team fields have
// been through this same validation.
const NFL_TEAMS = new Set([
  'Arizona Cardinals', 'Atlanta Falcons', 'Baltimore Ravens', 'Buffalo Bills',
  'Carolina Panthers', 'Chicago Bears', 'Cincinnati Bengals', 'Cleveland Browns',
  'Dallas Cowboys', 'Denver Broncos', 'Detroit Lions', 'Green Bay Packers',
  'Houston Texans', 'Indianapolis Colts', 'Jacksonville Jaguars', 'Kansas City Chiefs',
  'Las Vegas Raiders', 'Los Angeles Chargers', 'Los Angeles Rams', 'Miami Dolphins',
  'Minnesota Vikings', 'New England Patriots', 'New Orleans Saints', 'New York Giants',
  'New York Jets', 'Oakland Raiders', 'Philadelphia Eagles', 'Pittsburgh Steelers',
  'San Diego Chargers', 'San Francisco 49ers', 'Seattle Seahawks', 'St. Louis Rams',
  'Tampa Bay Buccaneers', 'Tennessee Titans', 'Washington Redskins',
  'Washington Football Team', 'Washington Commanders', 'Baltimore Colts',
  'Houston Oilers', 'Tennessee Oilers', 'Los Angeles Raiders', 'Phoenix Cardinals',
  'St. Louis Cardinals', 'Boston Patriots', 'New York Titans',
]);

let _knownTeams = null;
function isKnownTeam(name) {
  if (NFL_TEAMS.has(name)) return true;
  if (_knownTeams === null) {
    _knownTeams = new Set();
    for (const f of fs.readdirSync(CHECKLISTS_DIR)) {
      if (!/\.json$/.test(f) || f === 'index.json') continue;
      let d;
      try { d = JSON.parse(fs.readFileSync(path.join(CHECKLISTS_DIR, f), 'utf8')); } catch { continue; }
      for (const set of d.sets || []) for (const c of set.cards || []) if (c.team) _knownTeams.add(c.team);
    }
  }
  return _knownTeams.has(name);
}

// Everything a team field picks up after the franchise name. These stack
// freely — "Chicago Bears /49 RC Auto Jersey", "San Francisco 49ers AUTO —
// Redemption", "Philadelphia Eagles VAR AUTO[/column]" — and each new
// combination forks the franchise into another distinct team. Part 1's
// first 1,700 pages produced 561 "teams" before this ran.
const TEAM_ANNOTATION = /\s+(RC|SP|SSP|VAR|RPS|AUTO|Auto|Autographs?|Jersey|Patch|Relic|Memorabilia|Redemption)\s*$/i;

function cleanTeam(raw) {
  let printRun = null;
  let team = raw
    .replace(/\[[^\]]*\]/g, '')                 // "[/column]" left by the page markup
    // "Green Bay Packers (NO BASE, BRONZE OR HOLO SILVER))" — the note holds
    // a comma, so leaving it on stops the team being recognised and the
    // whole thing gets read as a list of players instead.
    .replace(/\s*\([^)]*\)+\s*$/, '')
    // "— Redemption", "– All-Americans", and the OCR'd "—- Legends" where
    // the dash came back doubled.
    .replace(/\s+[–—-]+\s*[A-Za-z][A-Za-z \-]*$/, '')
    .replace(/\s+[–—-]+\s*$/, '')
    .replace(/\s*\/(\d+)\b/, (_, pr) => { printRun = parseInt(pr, 10); return ''; })
    .trim();
  let prev;
  do { prev = team; team = team.replace(TEAM_ANNOTATION, '').trim(); } while (team !== prev);
  return { team, printRun };
}

// OCR renders the source's • bullet as ¢, ¥, e, °, or *.
function stripBullet(s) {
  return s.replace(/^[¢•°¥*e]\s+/, '').trim();
}

// The list is not always introduced by a bare "Parallels:" — Prizm labels
// its by finish ("Prizms Parallels:"), and without matching that the names
// underneath fall through to the card loop, where the last one before the
// cards is taken for a set header.
function isParallelsOpener(line) {
  if (line.length > 60) return false;
  return /(^|\s)(Parallels?|Versions?)\s*:\s*$/i.test(line) || /^(Parallels?|Versions?)\s*$/i.test(line);
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
// Brand names that are acronyms, which the source sometimes title-cases.
// 2017's articles say "Panini XR", 2018's say "Panini Xr" — the same product
// reading two ways across the catalogue.
const ACRONYM_BRANDS = [[/\bXr\b/g, 'XR']];

function normalizeProduct(s) {
  let out = s.replace(/\s+/g, ' ').trim();
  for (const [pat, rep] of ACRONYM_BRANDS) out = out.replace(pat, rep);
  return out;
}

// The source is inconsistent about the manufacturer prefix: Select's base
// article is titled "2017 Panini Select Football" while its autograph and
// memorabilia articles are "2017 Select Football". Left alone that ships as
// two half-products. Group names that differ only by the prefix and keep the
// prefixed form, matching the rest of the catalog (2017 Panini Certified …).
// Also merges year variants. Encased shipped late, so its base article is
// titled "2017 Panini Encased Football" and its autographs article "2018
// Panini Encased Football". Left alone that splits one product across two
// years; the year carrying more articles wins.
// A year's compilation carries articles about other years: updates to an
// earlier product ("2016 Panini Impeccable Football Updates", "2017 Panini
// Majestic Football Updates") and the odd stray cross-reference. They are
// about that other product, not this one, so folding them in files an
// earlier year's cards under this one — and letting them stand alone is
// worse, because the file for that year already exists and would be
// replaced by a fragment of itself. Drop them; whichever year's own
// compilation covers those products carries the cards properly.
function dropOffYearArticles(headers) {
  const counts = new Map();
  for (const h of headers) {
    const y = yearOf(h.product);
    counts.set(y, (counts.get(y) || 0) + 1);
  }
  let dominant = null;
  for (const [y, n] of counts) if (dominant === null || n > counts.get(dominant)) dominant = y;
  if (dominant === null) return;
  const dropped = [];
  for (let i = headers.length - 1; i >= 0; i--) {
    if (yearOf(headers[i].product) === dominant) continue;
    dropped.push(headers[i].product);
    headers.splice(i, 1);
  }
  if (dropped.length) {
    console.log(`  dropped ${dropped.length} off-year article(s): ${[...new Set(dropped)].join(', ')}`);
  }
}

// True when some article titled `name` neighbours an article titled
// `target` in document order.
function isAdjacentTo(headers, name, target) {
  for (let i = 0; i < headers.length; i++) {
    if (headers[i].product !== name) continue;
    if (headers[i - 1] && headers[i - 1].product === target) return true;
    if (headers[i + 1] && headers[i + 1].product === target) return true;
  }
  return false;
}

function canonicalizeProductNames(headers) {
  const byKey = new Map();
  const articleCount = new Map();
  for (const h of headers) {
    const key = h.product.replace(/^20\d{2}\s+/, '').replace(/^Panini\s+/, '');
    if (!byKey.has(key)) byKey.set(key, new Set());
    byKey.get(key).add(h.product);
    articleCount.set(h.product, (articleCount.get(h.product) || 0) + 1);
  }
  const canonical = new Map();
  for (const [, names] of byKey) {
    if (names.size < 2) continue;
    // The manufacturer prefix decides first — Select's base article says
    // "Panini Select" while its other two say plain "Select", and the
    // catalogue spells the rest of the year's Panini products out in full.
    // Article count only breaks ties, which is where the year variants land.
    const hasPanini = (n) => (/^20\d{2}\s+Panini\s/.test(n) ? 1 : 0);
    const ranked = [...names].sort((a, b) =>
      (hasPanini(b) - hasPanini(a)) ||
      (articleCount.get(b) - articleCount.get(a)));
    const pick = ranked[0];
    const merged = [];
    for (const n of names) {
      if (n === pick) continue;
      if (yearOf(n) !== yearOf(pick)) continue;
      canonical.set(n, pick);
      merged.push(n);
    }
    if (merged.length) console.log(`  merged ${merged.join(', ')} -> ${pick}`);
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
  const brand = productName
    .replace(/^20\d{2}\s+/, '')
    .replace(/^Panini\s+/, '')
    .replace(/\s+Football$/, '')
    .trim();
  // The flagship is just "2017 Panini Football", so stripping the
  // manufacturer leaves nothing to name it by.
  if (!brand || /^Football$/i.test(brand)) return 'Panini';
  return brand;
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
const ONE_VARIANT_WORD = new RegExp(`^(${VARIANT_WORDS})$`, 'i');

function consolidateSets(sets) {
  const groups = new Map();
  for (const set of sets) {
    const stripped = set.name.replace(VARIANT_RE, '').trim();
    // "Rookie Class – Chrome" leaves the dash behind once the finish word
    // comes off, so the base would be named "Rookie Class –".
    const trimmed = stripped.replace(/\s*[–—-]\s*$/, '').trim();
    // "White Gold" is a Gold Standard set in its own right, not a gold
    // parallel of some set called "White". When stripping the finish word
    // leaves nothing but another finish word, the name was never a base
    // plus a variant, so it stays whole.
    const baseName = ONE_VARIANT_WORD.test(stripped) ? set.name : trimmed;
    // Measured against the untrimmed prefix so the variant is still "Chrome".
    const variantName = (set.name === baseName) ? null : set.name.substring(stripped.length).trim();
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
