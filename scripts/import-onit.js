#!/usr/bin/env node
/**
 * ONIT Athlete checklists (owner, Nov 2026: "do we have the Onit checklists?").
 *
 * ONIT publishes every checklist itself, one PDF per school, sport and season,
 * listed on https://onitathlete.com/pages/checklists in a JSON block the page's
 * search reads ({ checklists: [{ brand, school, sport, year, suffix, pdf }] }).
 * Each PDF is a plain table: a title, a "CARD NUMBER No Name Pos" header, then
 * sections ("Base", ...) of rows like "B-1   35 Abduall Sanders Jr.   LB".
 *
 * Football only (the site's sport): one product per brand, school and season,
 * named the way the cards are sold ("2025 ONIT Athlete Alabama Football",
 * "2025 ONIT Gravity Alabama Football"), with a set per section and the school
 * as every card's team.
 *
 *   node scripts/import-onit.js            # report only
 *   node scripts/import-onit.js --write    # write new products
 *   node scripts/import-onit.js --write --force   # rewrite existing ones too
 *
 * Needs `pdftotext` (poppler-utils). Runs in .github/workflows/import-onit.yml:
 * this sandbox cannot reach onitathlete.com, GitHub's runners can.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'public', 'data', 'checklists');
const PAGE = 'https://onitathlete.com/pages/checklists';
const UA = 'Mozilla/5.0 (TheCardHuddle checklist import)';
const WRITE = process.argv.includes('--write');
const FORCE = process.argv.includes('--force');

const slug = (s) => String(s).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// The product line as the cards are sold.
const LINE = { 'Team Set': 'ONIT Athlete', 'Gravity': 'ONIT Gravity', 'ONIT Black': 'ONIT Black', 'Timeless': 'ONIT Timeless' };

// "2025", "2025-2026", "2025-26" -> 2025.
const firstYear = (y) => Number(String(y || '').match(/(19|20)\d\d/)?.[0]) || null;

// ONIT Black lists names in capitals ("JAYLEN McCLAIN", "C.J. HICKS"): title
// case them, keeping Mc/Mac and suffixes. Mixed-case names are left alone.
function nameCase(s) {
  const t = String(s).replace(/\s+/g, ' ').trim();
  if (/[a-z]/.test(t.replace(/\b(Mc|Mac|De|Le|La)[A-Z]/g, ''))) return t;
  return t.split(' ').map(w => {
    if (/^(II|III|IV|V)$/i.test(w)) return w.toUpperCase();
    if (/^[A-Z]\.[A-Z]\.?$/i.test(w)) return w.toUpperCase();
    if (/^["'(][A-Z]{1,3}["')]$/.test(w)) return w;   // a nickname's initials: "TJ
    return w.toLowerCase()
      .replace(/(^|[-'"(])([a-zà-ÿ])/g, (m, a, b) => a + b.toUpperCase())
      .replace(/^(mc)([a-z])/i, (m, a, b) => 'Mc' + b.toUpperCase());
  }).join(' ');
}

const ROW = /^([A-Z]{0,5}-?\d{1,4}[A-Z]?|[A-Z]{1,3}-[A-Z]{2,3})\s+(?:(\d{1,3})\s+)?(.+?)(?:\s{2,}([A-Z]{1,4}))?(?:\s+\/\d+)?\s*$/;
// The column header. The 2026 PDFs put a group name in front of it
// ("BASE SET   CARD NO.   JERSEY NO.   PLAYER NAME   POS.").
const HEADER = /CARD\s+(?:NUMBER|NO\b)|^\s*No\s+Name/i;
const YEAR = /\b(19|20)\d\d\b/;

function categoryOf(name) {
  const s = name.toLowerCase();
  if (/\bbase\b/.test(s) && !/auto|signature/.test(s)) return 'base';
  if (/auto|signature|signed/.test(s)) return 'autograph';
  if (/relic|patch|material|jersey|memorabilia/.test(s)) return 'memorabilia';
  return 'insert';
}

// "Teal, Purple, Green /100, Gold /1" -> [{ name, printRun }].
function readParallels(list) {
  return String(list).split(/[,;]/).map(x => x.trim()).filter(Boolean).map(x => {
    const m = /^(.*?)\s*\/\s*(\d+)$/.exec(x);
    return m ? { name: m[1].trim(), printRun: Number(m[2]) } : { name: x, printRun: null };
  }).filter(p => p.name);
}

const groupName = (s) => {
  const t = s.replace(/\s+/g, ' ').trim();
  if (/^base( set)?$/i.test(t)) return 'Base';
  return t.toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase());
};

// The 2023 and 2024 team set PDFs embed a font whose codes sit 29 below the
// letters they draw ("%DVH" is "Base", \u0003 a space), so pdftotext reads
// them shifted. Such a document is shifted back, line by line: a line with a
// real lower-case letter ("* Series Cards Look for Parallels") is in a normal
// font and kept; layout spaces are pdftotext's own and kept too.
function unshift(text) {
  const t = String(text);
  if ((t.match(/\u0003/g) || []).length < 5) return t;
  return t.split('\n').map(line => /[a-z]/.test(line) ? line
    : line.replace(/[^ \f\t]/g, ch => { const c = ch.charCodeAt(0) + 29; return c <= 0x7e ? String.fromCharCode(c) : ch; })).join('\n');
}

// The text of one PDF (pdftotext -layout) -> sets. A card may carry its own
// team: the all-schools Gravity checklist has a SCHOOL column.
function parseChecklistText(text) {
  text = unshift(text);
  const sets = [];
  let cur = null, schoolCol = false, open = '';
  const anyCards = () => sets.some(s => s.cards.length);
  const heading = (h) => {
    h = h.replace(/\s{2,}SEQ\.?$/i, '').replace(/\s+/g, ' ').trim();
    // "Galaxy (Parallels: Blue /200, ...)": the set and its parallels.
    const inl = /^(.*?)\s*\(\s*Parallels?\s*:\s*(.+)\)$/i.exec(h);
    if (inl) { cur = { name: groupName(inl[1]) === 'Base' ? 'Base' : inl[1], cards: [], parallels: readParallels(inl[2]) }; sets.push(cur); return; }
    // "Base Parallels (Teal, Purple, Green /100, ...)": the parallels of a set
    // already read, listed again card by card. When the cards are all of
    // that set's cards they become its parallels; when they are some of them
    // (the 2026 team sets list 15 of 71) they are a set of their own, "Base
    // Parallels", carrying the list.
    const pm = /^(.*?)\s*Parallels?\s*\((.+)\)$/i.exec(h);
    if (pm) {
      const want = (pm[1] || 'Base').trim().toLowerCase();
      const of = sets.slice().reverse().find(s => s.cards.length && s.name.toLowerCase() === want);
      if (of) { cur = { name: `${of.name} Parallels`, cards: [], parallelOf: of, parallels: readParallels(pm[2]) }; sets.push(cur); return; }
    }
    cur = { name: h, cards: [] }; sets.push(cur);
  };
  for (let raw of String(text).split('\n')) {
    const line = raw.replace(/\f/g, '').replace(/\s+$/, '');
    if (!line.trim()) continue;
    const t = line.trim();
    // A heading whose parallels run onto the next lines.
    if (open) {
      open += ' ' + t;
      if ((open.match(/\(/g) || []).length <= (open.match(/\)/g) || []).length || open.length > 600) { heading(open); open = ''; }
      continue;
    }
    if (HEADER.test(t)) {
      if (/\bSCHOOL\b/i.test(t)) schoolCol = true;
      // A group name before the header opens a set of that name; a section
      // heading right after it (INSERTS, then "Campus Colors") replaces it.
      const pre = t.split(/\s{2,}|CARD\s+(?:NUMBER|NO\b)/i)[0].trim();
      if (pre && !/^no\b/i.test(pre)) { cur = { name: groupName(pre), cards: [] }; sets.push(cur); }
      continue;
    }
    const m = ROW.exec(t);
    if (m && /\d|-/.test(m[1]) && /[A-Za-z]/.test(m[3]) && !/^(19|20)\d\d$/.test(m[1])) {
      if (!cur) { cur = { name: 'Base', cards: [] }; sets.push(cur); }
      // The columns after the number: [school,] [a note,] [jersey] name.
      const cols = m[3].split(/\s{2,}/).map(c => c.trim()).filter(c => c && !/^\/?\d+$/.test(c) && !/^\/\s*\d+$/.test(c));
      const card = { number: m[1], player: nameCase(cols[cols.length - 1].replace(/^\d{1,3}\s+/, '').replace(/\s+\/\d+$/, '')) };
      if (schoolCol && cols.length >= 2) card.team = cols[0];
      cur.cards.push(card);
      continue;
    }
    // The title lines ("ONIT Team Trading Cards Checklist", "2026 Texas Tech
    // Football", "Alabama Football Checklist 2025") come before any card.
    if (/checklist/i.test(t) || (!anyCards() && YEAR.test(t))) continue;
    // A short line of words with no card number: a section heading. A print
    // run in it ("Green /100") is not a stray number.
    if (/^[A-Za-z]/.test(t) && !/\.com\b|^page\s+\d/i.test(t)) {
      if ((t.match(/\(/g) || []).length > (t.match(/\)/g) || []).length) { open = t; continue; }
      if (t.length <= 160 && !/\d{3,}/.test(t.replace(/\/\s*\d+/g, ''))) heading(t);
    }
  }
  if (open) heading(open);
  for (const s of sets) {
    if (!s.parallelOf) continue;
    const base = new Set(s.parallelOf.cards.map(c => c.number));
    if (s.cards.length === base.size && s.cards.every(c => base.has(c.number))) {
      s.parallelOf.parallels = (s.parallelOf.parallels || []).concat(s.parallels);
      s.merged = true;
    }
  }
  return sets.filter(s => !s.merged && s.cards.length).map(({ parallelOf, ...s }) => s);
}

// One ONIT listing (+ its parsed sets) -> our product document.
function toProduct(item, sets) {
  const line = LINE[item.brand] || `ONIT ${item.brand}`;
  const year = firstYear(item.year);
  const suffix = item.suffix ? ` ${item.suffix}` : '';
  const school = item.school === 'Multi-School' ? '' : `${item.school} `;
  const name = `${year} ${line} ${school}Football${suffix}`.replace(/\s+/g, ' ').trim();
  const team = item.school === 'Multi-School' ? '' : item.school;
  return {
    id: slug(name), name, year, brand: 'ONIT Athlete', sport: 'Football',
    note: 'Built from the published checklist at onitathlete.com.',
    sets: sets.map(s => ({
      id: slug(s.name), name: s.name, category: categoryOf(s.name), totalCards: s.cards.length, parallels: s.parallels || [],
      cards: s.cards.map(c => ({ number: c.number, player: c.player, team: c.team || team })),
    })),
  };
}

// The checklist list embedded in the page.
function listFromPage(html) {
  const out = [];
  for (const m of String(html).matchAll(/<script type="application\/json" data-ca-part>([\s\S]*?)<\/script>/g)) {
    try { out.push(...(JSON.parse(m[1]).checklists || [])); } catch (_) { /* a part we cannot read */ }
  }
  return out;
}

async function get(url, as = 'text') {
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return as === 'buffer' ? Buffer.from(await r.arrayBuffer()) : r.text();
}

if (require.main === module) (async () => {
  const items = listFromPage(await get(PAGE)).filter(i => i.sport === 'Football' && i.pdf);
  if (!items.length) { console.error('no football checklists found on the page'); process.exit(1); }
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'onit-'));
  let added = 0, skipped = 0, failed = 0;
  // One PDF listed under every school (the 2026 Gravity checklist covers all
  // of them, with a SCHOOL column) is one product, not one per school.
  const schoolsOf = new Map();
  for (const i of items) schoolsOf.set(i.pdf, (schoolsOf.get(i.pdf) || 0) + 1);
  const seenPdf = new Set();
  for (let item of items) {
    if (schoolsOf.get(item.pdf) > 1) {
      if (seenPdf.has(item.pdf)) continue;
      seenPdf.add(item.pdf);
      item = { ...item, school: 'Multi-School' };
    }
    const label = `${item.brand} | ${item.school} | ${item.year}${item.suffix ? ' | ' + item.suffix : ''}`;
    try {
      const pdf = path.join(tmp, 'c.pdf');
      fs.writeFileSync(pdf, await get(item.pdf, 'buffer'));
      const text = execFileSync('pdftotext', ['-layout', pdf, '-'], { encoding: 'utf8' });
      if (process.env.ONIT_DUMP && process.env.ONIT_DUMP.split('|').some(d => `${item.year} ${item.brand} ${item.school}`.toLowerCase() === d)) {
        console.log(`----- DUMP ${label}\n${unshift(text).slice(0, 7000)}\n----- SETS`);
        for (const s of parseChecklistText(text)) console.log(`  ${s.name}: ${s.cards.length} [${s.cards.slice(0, 3).map(c => c.number + ' ' + c.player).join(' | ')}]${s.parallels ? ' par ' + s.parallels.length : ''}`);
        console.log('----- END');
      }
      const sets = parseChecklistText(text);
      const doc = toProduct(item, sets);
      const file = path.join(DIR, doc.id + '.json');
      const cards = sets.reduce((n, s) => n + s.cards.length, 0);
      if (!cards) { console.log(`EMPTY  ${label}`); failed++; continue; }
      if (fs.existsSync(file) && !FORCE) { console.log(`have   ${doc.id}`); skipped++; continue; }
      console.log(`new    ${doc.id}: ${sets.length} sets, ${cards} cards`);
      if (WRITE) fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n');
      added++;
      await sleep(300);
    } catch (err) {
      console.log(`FAIL   ${label}: ${err.message}`);
      failed++;
    }
  }
  console.log(`\n${items.length} football checklists: ${added} ${WRITE ? 'written' : 'to write'}, ${skipped} already here, ${failed} failed`);
})();

module.exports = { unshift, readParallels, parseChecklistText, toProduct, listFromPage, nameCase, firstYear };
