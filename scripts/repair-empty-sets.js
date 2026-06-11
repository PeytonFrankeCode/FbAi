#!/usr/bin/env node
/**
 * Repair pass for per-product checklist JSONs:
 *
 *   1. Refill sets that have 0 cards by re-reading the source DOCX. The
 *      upstream parsers' card-line detector required "<digit> <Cap><low>",
 *      so any set whose FIRST card's player starts with initials
 *      ("5 J.J. McCarthy...", "1 DJ Moore...") was dropped wholesale and
 *      the set kept only its header + card count (0 cards).
 *   2. Merge "parallel-as-set" junk: sets whose name is a bare parallel
 *      tier ("Platinum", "Sapphire (no McLaurin)", "Team Logo – 1/1")
 *      get folded into the nearest preceding real set — name joins the
 *      parent's parallels list, cards union into the parent checklist.
 *      A name only counts as junk when the source block has no
 *      "<Name> Checklist" header of its own (so real sets like
 *      "Black Gold" survive).
 *   3. Dedupe sets with identical names inside one product (merge cards
 *      + parallels into the first occurrence).
 *   4. Drop empty sets that have no card data anywhere in the source
 *      (foreign bleed-through headers, parallels-only galleries) — every
 *      drop is logged.
 *
 * Run: node scripts/repair-empty-sets.js [--dry]
 */
const mammoth = require('mammoth');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'public', 'data', 'checklists');
const DRY = process.argv.includes('--dry');

const SOURCES = {
  2022: 'All 2022 Nfl Checklists.docx',
  2023: 'Document (13).docx',
  2024: 'Peyton Code - Panini+Topps - Checklist 2024.docx',
  2025: '2025 Checklists - Panini-Topps copy.docx',
};

// Bare parallel-tier vocabulary. A set name is *candidate* junk when every
// word of it (after stripping "(no ...)"/print-run suffixes) is in here.
const PARALLEL_VOCAB = new Set([
  'gold', 'silver', 'black', 'white', 'red', 'blue', 'green', 'purple',
  'orange', 'pink', 'bronze', 'platinum', 'emerald', 'sapphire', 'ruby',
  'aqua', 'teal', 'navy', 'yellow', 'holo', 'vinyl', 'tag', 'laundry',
  'prime', 'team', 'logo', 'slogan', 'bowl', 'brand', 'conference',
  'championship', 'shield', 'printing', 'plates', 'superfractors',
  'diamond', 'century', 'nfl', 'royal', 'metallic',
  '1', '2', '3', 'i', 'ii', 'iii',
]);

// Tier words that may trail a set's own header ("Framed White Checklist").
const TIER_SUFFIX_VOCAB = new Set([
  ...PARALLEL_VOCAB, 'prizm', 'prizms', 'mirror', 'holo', 'etch',
  'pulsar', 'neon', 'mojo', 'ballers',
]);

// Doc-structure artifacts that are never real sets. Dropping one also
// resets the merge anchor: anything tier-shaped after it is part of an
// "updates to older products" appendix, not the current product.
const STRUCTURE_NOTES = /^(updates?|same parallels\b.*|\d+\s+cards?)$/i;

// "20XX <Brand> ... " set names are bleed-through from another product's
// section of the doc (e.g. "2016 Panini Flawless Football – Shield
// Signatures" sitting inside the 2024 file). Retro inserts like
// "1992 Elite" or "2014 Contenders Throwback" don't name a brand and
// survive. Sets whose name starts with the product's own name are exempt.
const FOREIGN_SET_RE = /^20\d{2}\s+(Panini|Donruss|Topps|Score|Clearly|Bowman|Leaf)\b/i;

const norm = s => String(s || '')
  .toLowerCase()
  .replace(/[’‘]/g, "'")
  .replace(/[–—]/g, '-')
  .replace(/\s+/g, ' ')
  .replace(/[.\s]+$/, '')
  .trim();

// "39 cards", "39 cards.", and the glued "39 cardsParallel(s)" shape.
const COUNT_RE = /^(\d+)\s+cards?(?:\b|(?=[A-Z]))/i;

// NFL team names (current + legacy) so comma-less rows like
// "1 George Kittle San Francisco 49ers" can still split player/team.
const NFL_TEAMS = [
  'Arizona Cardinals', 'Atlanta Falcons', 'Baltimore Ravens', 'Buffalo Bills',
  'Carolina Panthers', 'Chicago Bears', 'Cincinnati Bengals', 'Cleveland Browns',
  'Dallas Cowboys', 'Denver Broncos', 'Detroit Lions', 'Green Bay Packers',
  'Houston Texans', 'Indianapolis Colts', 'Jacksonville Jaguars', 'Kansas City Chiefs',
  'Las Vegas Raiders', 'Los Angeles Chargers', 'Los Angeles Rams', 'Miami Dolphins',
  'Minnesota Vikings', 'New England Patriots', 'New Orleans Saints', 'New York Giants',
  'New York Jets', 'Philadelphia Eagles', 'Pittsburgh Steelers', 'San Francisco 49ers',
  'Seattle Seahawks', 'Tampa Bay Buccaneers', 'Tennessee Titans', 'Washington Commanders',
  'Washington Redskins', 'Washington Football Team', 'Oakland Raiders',
  'San Diego Chargers', 'St. Louis Rams', 'Houston Oilers', 'Tennessee Oilers',
  'Baltimore Colts', 'Los Angeles Raiders', 'St. Louis Cardinals', 'Phoenix Cardinals',
];

// Split "<player words> <Team Name>" when there's no comma. Returns
// [player, team] or null.
function splitTeamSuffix(text) {
  for (const team of NFL_TEAMS) {
    if (text.endsWith(team)) {
      const player = text.slice(0, -team.length).trim();
      if (player) return [player, team];
    }
  }
  return null;
}

// ---- relaxed card-line parsing ----
// Typical print runs, used to resolve "/NNN<next card number>" ambiguity
// when card numbers aren't ascending.
const TYPICAL_RUNS = new Set([
  1, 2, 3, 4, 5, 7, 8, 9, 10, 11, 13, 15, 20, 22, 23, 24, 25, 30, 35, 39,
  49, 50, 60, 75, 99, 100, 125, 149, 150, 175, 199, 249, 250, 275, 299, 399, 499,
]);

const NAME_HEAD = "[A-Z][A-Za-z'’.\\-]";
const BOUNDARY_RE = new RegExp(`(\\d+)\\s+(?=${NAME_HEAD})`, 'g');

// Glued globs like "...Vikings /56 Michael Penix Jr., Atlanta Falcons /107
// Joe Milton III..." pack the print run and the NEXT card's number into one
// digit string. Card numbers in these lists ascend, so partition the digits
// at the spot that yields the smallest forward step ("/107" after card 6 →
// print run 10, card 7 — not print run 1, card 07).
function splitNumberedCards(line) {
  let s = line;
  const inserts = [];
  let prev = null;
  for (const m of s.matchAll(BOUNDARY_RE)) {
    const D = m[1];
    const pre = m.index > 0 ? s[m.index - 1] : '';
    if (pre === '/') {
      let best = null;
      for (let k = 1; k < D.length; k++) {
        const nn = D.slice(k);
        if (nn[0] === '0') continue;
        const v = parseInt(nn, 10);
        if (prev == null || v > prev) {
          const score = prev == null ? v : v - prev;
          if (!best || score < best.score) best = { k, v, score };
        }
      }
      if (!best) {
        // No ascending partition — accept a typical print run if one fits.
        for (let k = D.length - 1; k >= 1; k--) {
          const nn = D.slice(k);
          if (nn[0] === '0') continue;
          if (TYPICAL_RUNS.has(parseInt(D.slice(0, k), 10))) { best = { k, v: parseInt(nn, 10) }; break; }
        }
      }
      if (best) { inserts.push(m.index + best.k); prev = best.v; }
      // else: the digits are entirely the previous card's print run.
    } else {
      prev = parseInt(D, 10);
    }
  }
  for (let i = inserts.length - 1; i >= 0; i--) {
    s = s.slice(0, inserts[i]) + ' ' + s.slice(inserts[i]);
  }
  // "Conference Logo – 1/1" globs glue the denominator to the next card
  // number the same way: "...Wolverines 1/13 Blake" → "1/1 3 Blake".
  s = s.replace(/(\d+)\/(\d+?)(\d+\s+[A-Z][A-Za-z'’.\-])/g, (_, n, d, rest) => `${n}/${d} ${rest}`);

  const starts = [];
  for (const m of s.matchAll(BOUNDARY_RE)) {
    if (m.index > 0 && s[m.index - 1] === '/') continue;
    starts.push(m.index);
  }
  const out = [];
  for (let i = 0; i < starts.length; i++) {
    const chunk = s.slice(starts[i], i + 1 < starts.length ? starts[i + 1] : s.length).trim();
    let printRun = null;
    const clean = chunk
      .replace(/\s+\/(\d+)\s*$/, (_, pr) => { printRun = parseInt(pr, 10); return ''; })
      .replace(/\s+(\d+)\/(\d+)\s*$/, (_, n, d) => { if (!printRun) printRun = parseInt(d, 10); return ''; })
      .replace(/\s*–\s*no base version\s*$/i, '')
      .replace(/\s*\((?:eBay|no base|only [a-z /]+)\)\s*$/i, '')
      .replace(/\s+RC\s*$/i, '');
    let cm = clean.match(/^(\d+)\s+(.+?),\s*(.+?)$/);
    if (!cm) cm = clean.match(/^(\d+)\s+(.+?)\s+-\s+(.+?)$/);
    if (cm) {
      const card = { number: cm[1], player: cm[2].trim(), team: cm[3].trim() };
      if (printRun) card.printRun = printRun;
      out.push(card);
    } else {
      const tm = clean.match(/^(\d+)\s+(.+?)\s*$/);
      if (tm && /[A-Z][A-Za-z'’.\-]/.test(tm[2])) {
        const split = splitTeamSuffix(tm[2].trim());
        const card = split
          ? { number: tm[1], player: split[0], team: split[1] }
          : { number: tm[1], player: tm[2].trim() };
        if (printRun) card.printRun = printRun;
        out.push(card);
      }
    }
  }
  return out;
}

const PREFIX_HEAD_RE = /^\d{0,4}[A-Z][A-Z0-9]{0,5}-[A-Z0-9]{1,6}\s+\S/;

function splitPrefixedCards(line) {
  // Unstick "/25FBA-AM" so the lookbehind sees a boundary
  const s = line.replace(/\/(\d+)(?=\d{0,4}[A-Z][A-Z0-9]{0,5}-[A-Z0-9])/g, '/$1 ');
  const re = /(?<![A-Z0-9-])(\d{0,4}[A-Z][A-Z0-9]{0,5}-[A-Z0-9]{1,6})\s+(?=[A-Z“"'])/g;
  const starts = [];
  let m;
  while ((m = re.exec(s)) !== null) starts.push(m.index);
  const out = [];
  for (let i = 0; i < starts.length; i++) {
    const chunk = s.slice(starts[i], i + 1 < starts.length ? starts[i + 1] : s.length).trim();
    let printRun = null;
    const clean = chunk
      .replace(/\s+\/(\d+)\s*$/, (_, pr) => { printRun = parseInt(pr, 10); return ''; })
      .replace(/\s+1\/1\s*$/, () => { printRun = 1; return ''; })
      .replace(/\s+RC\s*$/i, '');
    let cm = clean.match(/^(\S+)\s+(.+?),\s*(.+)$/);
    if (cm) {
      const card = { number: cm[1], player: cm[2].trim(), team: cm[3].trim() };
      if (printRun) card.printRun = printRun;
      out.push(card);
    } else {
      cm = clean.match(/^(\S+)\s+(.+)$/);
      if (cm && /[A-Z]/.test(cm[2])) {
        const card = { number: cm[1], player: cm[2].trim() };
        if (printRun) card.printRun = printRun;
        out.push(card);
      }
    }
  }
  return out;
}

function isNumberedCardLine(t) {
  if (COUNT_RE.test(t)) return false;
  return /^\d+\s+[A-Z][A-Za-z'’.\-]/.test(t);
}

// ---- source block handling ----
const PRODUCT_HDR = /(20\d{2}\s+(?:Topps|Panini|Donruss|Score|Clearly|Bowman|Leaf)[A-Za-z &'’+.]*?\s+Football)\s+Checklist/gi;

function loadSource(file) {
  return mammoth.extractRawText({ path: path.join(ROOT, file) })
    .then(r => r.value.split('\n'));
}

// Every line where some product header appears, with the normalized name.
function headerLines(lines) {
  const out = [];
  lines.forEach((line, idx) => {
    const seenHere = new Set();
    for (const m of line.matchAll(PRODUCT_HDR)) {
      const name = norm(m[1]);
      if (!seenHere.has(name)) { seenHere.add(name); out.push({ idx, name }); }
    }
  });
  return out;
}

// All [start, end) line intervals belonging to a product.
function blocksFor(headers, lineCount, productName) {
  const target = norm(productName);
  const blocks = [];
  for (let i = 0; i < headers.length; i++) {
    if (headers[i].name !== target) continue;
    let end = lineCount;
    for (let j = i + 1; j < headers.length; j++) {
      if (headers[j].name !== target) { end = headers[j].idx; break; }
    }
    if (blocks.length && headers[i].idx < blocks[blocks.length - 1][1]) {
      blocks[blocks.length - 1][1] = Math.max(blocks[blocks.length - 1][1], end);
    } else {
      blocks.push([headers[i].idx, end]);
    }
  }
  return blocks;
}

function findSetHeader(lines, blocks, setName) {
  const want = norm(setName);
  const wantCk = `${want} checklist`;
  for (const [s, e] of blocks) {
    for (let i = s; i < e; i++) {
      const t = norm(lines[i]);
      if (t === want || t === wantCk) return { idx: i, blockEnd: e };
    }
  }
  // Fallback for truncated names ("Red, White and" → "Red, White and Blue
  // Checklist") and tier-suffixed headers ("Framed White Checklist",
  // "Jumbo Rookie Swatch Prizm"): a header line that starts with the name.
  // Returns the full name so the caller can decide rename vs parallel.
  for (const [s, e] of blocks) {
    for (let i = s; i < e; i++) {
      const t = norm(lines[i]);
      if (t.length <= want.length || !t.startsWith(want + ' ') || t.length > want.length + 30) continue;
      const isCk = t.endsWith(' checklist');
      if (!isCk && !followedByCount(lines, i, e)) continue;
      const fullName = lines[i].trim().replace(/\s*Checklist\s*$/i, '');
      return { idx: i, blockEnd: e, fullName };
    }
  }
  return null;
}

// Strict section-start confirmation: the very next non-blank line is a
// card count or a Parallels label.
function startsNewSection(lines, i, end) {
  for (let j = i + 1; j < Math.min(i + 6, end); j++) {
    const n = lines[j].trim();
    if (!n) continue;
    return COUNT_RE.test(n) || /^(Parallels?|Versions?)\b/i.test(n);
  }
  return false;
}

// Header confirmation: a count / Parallels label / card line within the
// next few non-blank lines.
function followedByCount(lines, i, end) {
  let seen = 0;
  for (let j = i + 1; j < Math.min(i + 8, end) && seen < 3; j++) {
    const n = lines[j].trim();
    if (!n) continue;
    seen++;
    if (COUNT_RE.test(n)) return true;
    if (/^(Parallels?|Versions?)\b/i.test(n)) return true;
    if (isNumberedCardLine(n) || PREFIX_HEAD_RE.test(n)) return true;
  }
  return false;
}

// "<Name> Checklist" header exists in the product's own blocks → real set.
function hasOwnHeader(lines, blocks, setName) {
  const wantCk = `${norm(setName)} checklist`;
  for (const [s, e] of blocks) {
    for (let i = s; i < e; i++) {
      if (norm(lines[i]) === wantCk) return true;
    }
  }
  return false;
}

// A short titley line that is followed (within the next few non-blank
// lines) by a card count, a Parallels label, or card data is the next
// set's header — the 2025 doc has no "Checklist" suffix on set headers.
function looksLikeNextHeader(lines, i, blockEnd) {
  const t = lines[i].trim();
  if (!t || t.length > 100) return false;
  if (/[:#]/.test(t)) return false;
  if (isNumberedCardLine(t) || PREFIX_HEAD_RE.test(t)) return false;
  if (COUNT_RE.test(t)) return false;
  if (/^(Parallels?|Versions?)\b/i.test(t)) return false;
  if (/\/\d/.test(t) || /1\/1/.test(t) || /print runs vary/i.test(t)) return false;
  if (/^(Base|Rookies|Legends|Veterans|Autographs?|Memorabilia|Inserts?)$/i.test(t)) return false;
  if (junkParallelInfo(t)) return false; // bare tier row inside a Parallels list
  let seen = 0;
  for (let j = i + 1; j < Math.min(i + 14, blockEnd) && seen < 5; j++) {
    const n = lines[j].trim();
    if (!n) continue;
    seen++;
    if (COUNT_RE.test(n)) return true;
    if (/^(Parallels?|Versions?)\b/i.test(n)) return true;
    if (isNumberedCardLine(n) || PREFIX_HEAD_RE.test(n)) return true;
  }
  return false;
}

function parseSection(lines, startIdx, blockEnd, knownNames) {
  const cards = [];
  let declared = null;
  const seen = new Set();
  for (let i = startIdx + 1; i < blockEnd; i++) {
    const t = lines[i].trim();
    if (!t) continue;
    if (/checklist[.\s]*$/i.test(t) && !isNumberedCardLine(t) && !PREFIX_HEAD_RE.test(t)) break;
    // Another set of this product starts here — umbrella sections like
    // "Base Set, 202 cards (Season Ticket: #s 1-58...)" must not swallow
    // their sub-sets' card globs. Only lines confirmed by a following
    // count/Parallels label count as a section start; a bare name followed
    // directly by card data is just a parallel tier row inside this set.
    if (knownNames && knownNames.has(norm(t).replace(/ checklist$/, '')) && startsNewSection(lines, i, blockEnd)) break;
    const cm = t.match(COUNT_RE);
    if (cm) { if (declared == null) declared = parseInt(cm[1], 10); continue; }
    if (/^(Parallels?|Versions?)\b/i.test(t)) continue;
    let parsed = null;
    if (PREFIX_HEAD_RE.test(t)) parsed = splitPrefixedCards(t);
    else if (isNumberedCardLine(t)) parsed = splitNumberedCards(t);
    if (parsed) {
      for (const c of parsed) {
        const key = `${c.number}|${c.player}`;
        if (seen.has(key)) continue;
        seen.add(key);
        cards.push(c);
      }
      continue;
    }
    // Before the first card glob we're still in the set's own preamble
    // (parallel tier rows with arbitrary names) — never break there.
    if (cards.length > 0 && looksLikeNextHeader(lines, i, blockEnd)) break;
    // anything else (parallel rows, notes, sub-labels) is skipped
  }
  return { cards, declared };
}

// ---- junk-parallel classification ----
function junkParallelInfo(name) {
  let n = String(name).trim();
  let printRun = null;
  n = n.replace(/\s*\(no [^)]*\)\s*$/i, '');
  n = n.replace(/\s*[–-]\s*1\/1\s*$/, () => { printRun = 1; return ''; });
  n = n.replace(/\s*[–-]?\s*\/(\d+)\s*(\(.*\))?\s*$/, (_, pr) => { printRun = parseInt(pr, 10); return ''; });
  n = n.trim();
  if (!n) return null;
  if (/^same parallels/i.test(String(name))) return { parallelName: null, printRun: null, note: true };
  const words = n.toLowerCase().split(/[\s,]+/).filter(Boolean);
  if (!words.length || !words.every(w => PARALLEL_VOCAB.has(w))) return null;
  return { parallelName: n, printRun, note: false };
}

function unionCards(target, extra, stripPrintRun) {
  const keys = new Set(target.map(c => `${c.number}|${c.player}`));
  let added = 0;
  for (const c of extra) {
    const key = `${c.number}|${c.player}`;
    if (keys.has(key)) continue;
    keys.add(key);
    const copy = { ...c };
    if (stripPrintRun) delete copy.printRun;
    target.push(copy);
    added++;
  }
  return added;
}

async function main() {
  const sources = {};
  for (const [year, file] of Object.entries(SOURCES)) {
    if (!fs.existsSync(path.join(ROOT, file))) continue;
    const lines = await loadSource(file);
    sources[year] = { lines, headers: headerLines(lines) };
    console.log(`Loaded ${file}: ${lines.length} lines`);
  }

  const files = fs.readdirSync(DIR).filter(f => /^\d{4}-.+\.json$/.test(f));
  const totals = { filled: 0, filledCards: 0, merged: 0, deduped: 0, dropped: 0, files: 0 };
  const unresolved = [];

  for (const f of files) {
    const p = path.join(DIR, f);
    const d = JSON.parse(fs.readFileSync(p, 'utf8'));
    const src = sources[d.year];
    const blocks = src ? blocksFor(src.headers, src.lines.length, d.name) : [];
    const log = [];
    let changed = false;

    // ---- pass 1: fold parallel-as-set junk into the preceding real set ----
    // `anchor` is the last real set seen. Tier-shaped sets merge into it.
    // Structure notes ("Updates", "Same parallels as ...") reset the anchor,
    // so tier chains in an updates appendix get dropped instead of polluting
    // whatever set happened to come before.
    const kept = [];
    let anchor = null;
    for (const s of (d.sets || [])) {
      const sname = String(s.name).trim();
      const foreign = FOREIGN_SET_RE.test(sname) && !norm(sname).startsWith(norm(d.name).replace(/ football$/, ''));
      if (STRUCTURE_NOTES.test(sname) || foreign) {
        log.push(`  dropped ${foreign ? 'foreign-product' : 'structure-note'} set "${s.name}" (${(s.cards || []).length} cards)`);
        totals.dropped++;
        changed = true;
        anchor = null;
        continue;
      }
      const info = junkParallelInfo(s.name);
      const isRealHere = info && !info.note && src && hasOwnHeader(src.lines, blocks, s.name);
      if (info && !isRealHere) {
        if (anchor) {
          if (info.parallelName) {
            anchor.parallels = anchor.parallels || [];
            if (!anchor.parallels.some(x => norm(x.name) === norm(info.parallelName))) {
              anchor.parallels.push({ name: info.parallelName, printRun: info.printRun ?? null });
            }
          }
          // Only union tier cards into an anchor that already has its own
          // checklist. An empty anchor gets refilled from the source in
          // pass 2 — seeding it with tier cards would block that refill
          // (and the doc's leftover old-year tiers would contaminate it).
          if ((anchor.cards || []).length > 0) {
            const added = unionCards(anchor.cards, s.cards || [], true);
            log.push(`  merged parallel-set "${s.name}" (${(s.cards || []).length} cards, +${added} new) into "${anchor.name}"`);
          } else {
            log.push(`  folded parallel-set "${s.name}" into empty "${anchor.name}" (name only; cards come from refill)`);
          }
          totals.merged++;
        } else {
          log.push(`  dropped orphan parallel-set "${s.name}" (${(s.cards || []).length} cards, no anchor set)`);
          totals.dropped++;
        }
        changed = true;
        continue;
      }
      kept.push(s);
      anchor = s;
    }
    d.sets = kept;

    // ---- pass 2: refill empty sets from the source doc ----
    const refilled = [];
    for (const s of d.sets) {
      if ((s.cards || []).length > 0) continue;
      if (!src) { unresolved.push({ f, set: s.name, why: 'no source doc for year' }); continue; }
      const hit = findSetHeader(src.lines, blocks, s.name);
      if (!hit) { unresolved.push({ f, set: s.name, why: 'header not found in product block' }); continue; }
      const knownNames = new Set(d.sets.filter(x => x !== s).map(x => norm(x.name)));
      const { cards, declared } = parseSection(src.lines, hit.idx, hit.blockEnd, knownNames);
      if (!cards.length) { unresolved.push({ f, set: s.name, why: 'no card data under header' }); continue; }
      if (hit.fullName && norm(hit.fullName) !== norm(s.name)) {
        // If the extra words are just a parallel tier ("Framed White",
        // "Jumbo Rookie Swatch Prizm"), keep the set's own name and record
        // the tier as a parallel; otherwise the stored name was truncated
        // ("Red, White and") — adopt the full header name.
        const suffix = hit.fullName.slice(s.name.length).trim();
        const tierish = suffix.toLowerCase().split(/\s+/).every(w => TIER_SUFFIX_VOCAB.has(w));
        if (tierish) {
          s.parallels = s.parallels || [];
          if (!s.parallels.some(x => norm(x.name) === norm(suffix))) {
            s.parallels.push({ name: suffix, printRun: null });
          }
        } else {
          log.push(`  renamed truncated set "${s.name}" -> "${hit.fullName}"`);
          s.name = hit.fullName;
        }
      }
      s.cards = cards;
      s.totalCards = cards.length;
      const note = declared != null && declared !== cards.length ? ` (source says ${declared})` : '';
      log.push(`  refilled "${s.name}" with ${cards.length} cards${note}`);
      totals.filled++;
      totals.filledCards += cards.length;
      refilled.push({ s, declared });
      changed = true;
    }

    // ---- pass 2b: revert redundant umbrella refills ----
    // "Base Set, 202 cards" headers whose cards actually live in sub-sets
    // (Season Ticket / Veterans Class / Common...) sometimes pick up the
    // first sub-set's glob. Telltale: the captured count disagrees with the
    // source's own declared count AND every captured card already exists in
    // another set. (Either signal alone misfires: autograph sets share
    // number+player with their non-auto counterparts, and rookie-numbered
    // inserts collide with base "Rookies" subsections.)
    for (const { s, declared } of refilled) {
      if (declared == null || s.cards.length === declared) continue;
      const others = new Set();
      for (const o of d.sets) {
        if (o === s) continue;
        for (const c of (o.cards || [])) others.add(`${c.number}|${c.player}`);
      }
      if (s.cards.length && s.cards.every(c => others.has(`${c.number}|${c.player}`))) {
        log.push(`  reverted redundant refill of "${s.name}" (${s.cards.length}/${declared} cards, all present in other sets)`);
        totals.filled--;
        totals.filledCards -= s.cards.length;
        s.cards = [];
      }
    }

    // ---- pass 3: dedupe identically-named sets ----
    const byName = new Map();
    const deduped = [];
    for (const s of d.sets) {
      const key = norm(s.name);
      const first = byName.get(key);
      if (first) {
        const added = unionCards(first.cards = first.cards || [], s.cards || [], false);
        for (const pl of (s.parallels || [])) {
          first.parallels = first.parallels || [];
          if (!first.parallels.some(x => norm(x.name) === norm(pl.name))) first.parallels.push(pl);
        }
        log.push(`  deduped repeated set "${s.name}" (+${added} cards into first occurrence)`);
        totals.deduped++;
        changed = true;
        continue;
      }
      byName.set(key, s);
      deduped.push(s);
    }
    d.sets = deduped;

    // ---- pass 4: drop still-empty sets (logged) ----
    const final = [];
    for (const s of d.sets) {
      if ((s.cards || []).length === 0) {
        log.push(`  dropped empty set "${s.name}" (no data in source)`);
        totals.dropped++;
        changed = true;
        continue;
      }
      s.totalCards = s.cards.length;
      final.push(s);
    }
    d.sets = final;

    if (changed) {
      totals.files++;
      console.log(`\n${f}:`);
      for (const l of log) console.log(l);
      if (!DRY) fs.writeFileSync(p, JSON.stringify(d));
    }
  }

  console.log(`\n==== Summary ${DRY ? '(dry run)' : ''}`);
  console.log(`files changed: ${totals.files}`);
  console.log(`sets refilled: ${totals.filled} (+${totals.filledCards} cards)`);
  console.log(`parallel-sets merged: ${totals.merged}`);
  console.log(`duplicate sets merged: ${totals.deduped}`);
  console.log(`empty sets dropped: ${totals.dropped}`);
  if (unresolved.length) {
    console.log(`\nUnresolved empty sets (${unresolved.length}):`);
    for (const u of unresolved) console.log(`  [${u.f}] ${u.set} — ${u.why}`);
  }

  // ---- index.json refresh ----
  if (!DRY) {
    const INDEX = path.join(DIR, 'index.json');
    const idx = JSON.parse(fs.readFileSync(INDEX, 'utf8'));
    for (const pr of idx.products) {
      const file = path.join(DIR, `${pr.id}.json`);
      if (!fs.existsSync(file)) continue;
      const d = JSON.parse(fs.readFileSync(file, 'utf8'));
      pr.setCount = (d.sets || []).length;
      pr.totalCards = (d.sets || []).reduce((s, x) => s + ((x.cards || []).length), 0);
    }
    fs.writeFileSync(INDEX, JSON.stringify(idx));
    console.log('\nindex.json refreshed.');
  }
}

main().catch(err => { console.error(err); process.exit(1); });
