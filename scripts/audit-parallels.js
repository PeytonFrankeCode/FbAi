#!/usr/bin/env node
/**
 * Audit the checklists' parallel lists against the sources they came from.
 *
 * A set whose parallels were dropped in parsing still loads, still lists its
 * cards, and looks complete — until a sale of a parallel it should have has
 * nothing to match. 2024 Prizm's Rookie Variations is the case that found
 * this: the source lists Green Wave, No Huddle, Pink Wave, Mojo /25, Gold /10
 * and Black Finite 1/1 under "Rookie Variations Prizms Silver Checklist"; the
 * checklist kept Base and Silver, so a Gold /10 variation matched nothing.
 *
 * For every source (the year compilations at the repo root, .txt or .docx),
 * this finds each product's article, each set header in it and the
 * "Parallels:" list under it, and compares that list with the set's in
 * public/data/checklists. It reports every parallel the source names that the
 * checklist lacks.
 *
 *   node scripts/audit-parallels.js            report only
 *   node scripts/audit-parallels.js --fix      also add the missing parallels
 *   node scripts/audit-parallels.js --json F   write the report as JSON to F
 *
 * --fix only ever ADDS parallels, with the source's print run, after the ones
 * already listed. It never removes or renames: a checklist parallel the source
 * does not name may have come from a better source.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const P = require('./parse-checklists.js');
// The same rules the checklists are cleaned with, so a source name and the
// checklist's name for it are read alike.
const { clean: cleanName } = require('./clean-parallel-names.js');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'public', 'data', 'checklists');
const FIX = process.argv.includes('--fix');
const jsonAt = process.argv.indexOf('--json');
const JSON_OUT = jsonAt > 0 ? process.argv[jsonAt + 1] : null;

// Every compilation at the repo root. Word files are read through mammoth,
// as the parsers read them, in a child process because mammoth is async.
function sourceText(file) {
  if (/\.txt$/i.test(file)) return fs.readFileSync(file, 'utf8');
  return execFileSync(process.execPath, ['-e', `
    require(${JSON.stringify(require.resolve('mammoth'))})
      .extractRawText({ path: process.argv[1] })
      .then(r => process.stdout.write(r.value));`, file], { maxBuffer: 256 << 20 }).toString('utf8');
}
const SOURCES = fs.readdirSync(ROOT)
  .filter(f => /\.(txt|docx)$/i.test(f) && /checklist|document/i.test(f))
  .map(f => path.join(ROOT, f));

// Names compared as the card page compares them: no product word at either
// end, no "and", word order ignored ("Red, White and Blue" = "Blue Red White").
const PRODUCT_WORD = new Set(['prizm', 'prizms', 'refractor', 'refractors', 'parallel', 'parallels']);
function key(name) {
  let t = String(name || '').toLowerCase().replace(/&/g, ' and ').replace(/[.,'’`"]/g, '')
    .replace(/[-/]/g, ' ').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  while (t.length > 1 && PRODUCT_WORD.has(t[t.length - 1])) t.pop();
  while (t.length > 1 && PRODUCT_WORD.has(t[0])) t.shift();
  t = t.filter(w => w !== 'and');
  const k = t.sort().join(' ');
  return k === 'prizm' || k === 'prizms' ? 'silver' : k;
}
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const index = JSON.parse(fs.readFileSync(path.join(DIR, 'index.json'), 'utf8')).products || [];
// A product article's title against the catalogue: "2024 Panini Prizm
// Football Checklist – Master Card List" is 2024-panini-prizm-football.
const byName = new Map(index.map(p => [norm(p.name), p]));
//
// An article opens with its title or, where the title was lost in the
// export, with "Here's the full 2024 Donruss Optic Football checklist". Either
// is a product boundary: undefined for a line that is neither, null for an
// article that is not in the catalogue — whose sets must not be read as the
// previous product's (2024 Donruss "gained" Optic's and Score's parallels).
//
// The title can also arrive glued to the end of the previous article's last
// card ("...Terry McLaurin2023 Donruss Optic Football Checklist – Master Card
// List"), so it is looked for anywhere in the line — the last one there.
const TITLE_RE = /((?:19|20)\d{2})\s+((?:[A-Z0-9][\w&'’!.-]*\s+){1,7}?)Football\s+Check\s*list/g;
function productLine(line) {
  let m = null;
  for (const x of String(line).matchAll(TITLE_RE)) m = x;
  if (!m) m = /\bthe (?:full|complete) ((?:19|20)\d{2})\s+(.+?)\s+Football\s+check\s*list/i.exec(line);
  if (!m) return undefined;
  const n = norm(`${m[1]} ${m[2].trim()} Football`);
  return byName.get(n) || byName.get(n.replace(/^(\d{4}) /, '$1 panini ')) || null;
}

// A parallel line under "Parallels:", bullets and OCR'd bullet glyphs off.
function parallelOf(line) {
  // Notes are not part of the name: "(no Alt, Jordan)", "(select cards only,
  // list below)", "– (print runs vary, list below)", odds "(1:6 hobby)".
  const clean = line.replace(/^[•●◦▪*·¢¥°e]\s+/, '').replace(/^[-–—]\s+/, '')
    .replace(/\s*\((?:no |not |select |print runs|list below|\d+\s*:|\d[\d,]*\s*:)[^)]*\)/gi, '')
    .replace(/\s*[–—-]\s*$/, '').trim();
  if (!clean || /^parallels?:?$/i.test(clean)) return null;
  const parsed = P.parseParallel(clean);
  if (!parsed || !parsed.name) return null;
  const p = cleanName(parsed);
  if (!p || !p.name) return null;
  // A trailing note in brackets is not the name: "(1st Off the Line Boxes)".
  p.name = p.name.replace(/\s*\([^)]*\)\s*$/, '').trim();
  // Page furniture scraped in with the list: a year, a URL, "Explore over
  // 130 million...", a tag cloud.
  if (!p.name || p.name.length > 45 || /\bcards?\b\.?$/i.test(p.name)
      || /(19|20)\d{2}|https?:|www\.|explore|buy on|checklist|\bodds\b/i.test(p.name)
      || !/^[A-Z0-9]/.test(p.name) || /:$/.test(p.name)) return null;
  // A base set's own sections, listed after its parallels in some articles
  // (2020 Mosaic: "Veterans/Retired Players", "Rookies", "Pro Bowl", ...).
  if (/^(rookies?|rated rookies|veterans?|retired|legends?|pro bowl|nfl debut|hall of fame|mvps?|base|base set|short prints?|variations?|team cards?)(\b.*players?)?$/i.test(p.name)
      || /^veterans?\s*\//i.test(p.name)) return null;
  return p;
}

const docs = new Map();   // product id -> { doc, path, changed }
function docFor(p) {
  if (!docs.has(p.id)) {
    const file = path.join(DIR, `${p.id}.json`);
    docs.set(p.id, fs.existsSync(file) ? { doc: JSON.parse(fs.readFileSync(file, 'utf8')), file, changed: false } : null);
  }
  return docs.get(p.id);
}

// The checklist set a source header is about: the longest set name the
// header starts with ("Rookie Variations Prizms Silver" is the set "Rookie
// Variations Prizms", written for its Silver parallel).
function setFor(doc, header) {
  const h = norm(header);
  let best = null;
  for (const s of doc.sets || []) {
    const n = norm(s.name);
    if (n && (h === n || h.startsWith(n + ' ')) && (!best || n.length > norm(best.name).length)) best = s;
  }
  return best;
}

const report = [];
for (const file of SOURCES) {
  let text;
  try { text = sourceText(file); } catch (err) { console.error(`skip ${path.basename(file)}: ${err.message}`); continue; }
  const lines = text.split(/\r?\n/).map(l => l.replace(/ /g, ' ').trim());
  let product = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const prod = productLine(line);
    if (prod !== undefined) { product = prod; continue; }
    if (!product || !P.isSetHeader(line, lines, i)) continue;
    const header = P.cleanSetName(line);
    // Its "Parallels:" list: only one that opens right under the header (its
    // card count and a range note may come first), and only up to its first
    // card, the next header, the next "Parallels:", or a subheading — a line
    // that is itself followed by "Parallels:" ("Rated Rookies" inside
    // Donruss's Base Set). Anything looser read one article's lists into
    // another wherever a header went unrecognised.
    const found = [];
    let inList = false, seen = 0;
    const isList = (l) => /^parallels?:?$/i.test(l || '');
    const nextNonEmpty = (j) => { for (let k = j + 1; k < lines.length; k++) if (lines[k]) return lines[k]; return ''; };
    for (let j = i + 1; j < Math.min(lines.length, i + 120); j++) {
      const l = lines[j];
      if (!l) continue;
      if (isList(l)) { if (inList) break; inList = true; continue; }
      if (!inList && ++seen > 3) break;
      // Inside a list, a line is a new set only if it says so: "Green Wave
      // Prizms" between blank lines passes isSetHeader, and ending the list
      // there dropped the rest of 2024 Prizm's Rookie Variations parallels.
      const header = P.isSetHeader(l, lines, j)
        && (!inList || /check\s*list/i.test(l) || /^\d[\d,]*\s+cards?\b/i.test(nextNonEmpty(j)));
      if (P.isCardLine(l) || header || productLine(l) !== undefined) break;
      if (!inList) continue;
      if (isList(nextNonEmpty(j))) break;
      const p = parallelOf(l);
      if (p) found.push(p);
    }
    if (!found.length) continue;
    const d = docFor(product);
    if (!d) continue;
    const set = setFor(d.doc, header);
    if (!set) continue;
    const have = new Set((set.parallels || []).flatMap(p => [p.name, ...(p.aliases || [])]).map(key));
    // The parallel the header itself names ("... Silver Checklist") counts as
    // listed when the set has it.
    // Another set's name is not a parallel of this one: "Field Level" under
    // Select's Club Level is the next tier, not a Club Level parallel.
    const setNames = new Set((d.doc.sets || []).map(x => norm(x.name)));
    const missing = found.filter(p => !have.has(key(p.name)) && !setNames.has(norm(p.name)));
    if (!missing.length) continue;
    report.push({ product: product.id, set: set.name, header, source: path.basename(file),
                  listed: (set.parallels || []).length, missing: missing.map(p => ({ name: p.name, printRun: p.printRun })) });
    if (FIX) {
      set.parallels = set.parallels || [];
      for (const p of missing) {
        if (set.parallels.some(q => key(q.name) === key(p.name))) continue;
        set.parallels.push({ name: p.name, printRun: p.printRun });
      }
      d.changed = true;
    }
  }
}

// One line per set, most missing first; totals at the end.
const merged = new Map();
for (const r of report) {
  const k = `${r.product}|${r.set}`;
  const m = merged.get(k) || { ...r, missing: [] };
  for (const p of r.missing) if (!m.missing.some(q => key(q.name) === key(p.name))) m.missing.push(p);
  merged.set(k, m);
}
const rows = [...merged.values()].sort((a, b) => b.missing.length - a.missing.length);
for (const r of rows) {
  console.log(`${r.product} · ${r.set} (${r.listed} listed): +${r.missing.length} — `
    + r.missing.map(p => p.name + (p.printRun ? ` /${p.printRun}` : '')).join(', '));
}
const total = rows.reduce((n, r) => n + r.missing.length, 0);
console.log(`\n${rows.length} sets in ${new Set(rows.map(r => r.product)).size} products are missing ${total} parallels their sources list.`);
if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(rows, null, 2));
if (FIX) {
  let n = 0;
  for (const d of docs.values()) {
    if (!d || !d.changed) continue;
    const raw = fs.readFileSync(d.file, 'utf8');
    fs.writeFileSync(d.file, JSON.stringify(d.doc, null, raw.includes('\n  ') ? 2 : 0) + (raw.endsWith('\n') ? '\n' : ''));
    n++;
  }
  console.log(`--fix: ${n} checklist files updated.`);
}
