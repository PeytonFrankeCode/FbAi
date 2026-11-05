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
  return String(list).split(',').map(x => x.trim()).filter(Boolean).map(x => {
    const m = /^(.*?)\s*\/\s*(\d+)$/.exec(x);
    return m ? { name: m[1].trim(), printRun: Number(m[2]) } : { name: x, printRun: null };
  }).filter(p => p.name);
}

const groupName = (s) => {
  const t = s.replace(/\s+/g, ' ').trim();
  if (/^base( set)?$/i.test(t)) return 'Base';
  return t.toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase());
};

// The text of one PDF (pdftotext -layout) -> sets.
function parseChecklistText(text) {
  const sets = [];
  let cur = null;
  const anyCards = () => sets.some(s => s.cards.length);
  for (let raw of String(text).split('\n')) {
    const line = raw.replace(/\f/g, '').replace(/\s+$/, '');
    if (!line.trim()) continue;
    const t = line.trim();
    if (HEADER.test(t)) {
      // A group name before the header opens a set of that name; a section
      // heading right after it (INSERTS, then "Campus Colors") replaces it.
      const pre = t.split(/\s{2,}|CARD\s+(?:NUMBER|NO\b)/i)[0].trim();
      if (pre && !/^no\b/i.test(pre)) { cur = { name: groupName(pre), cards: [] }; sets.push(cur); }
      continue;
    }
    const m = ROW.exec(t);
    if (m && /\d|-/.test(m[1]) && /[A-Za-z]/.test(m[3]) && !/^(19|20)\d\d$/.test(m[1])) {
      if (!cur) { cur = { name: 'Base', cards: [] }; sets.push(cur); }
      if (cur.skip) continue;
      cur.cards.push({ number: m[1], player: nameCase(m[3].replace(/\s{2,}.*$/, '')) });
      continue;
    }
    // The title lines ("ONIT Team Trading Cards Checklist", "2026 Texas Tech
    // Football", "Alabama Football Checklist 2025") come before any card.
    if (/checklist/i.test(t) || (!anyCards() && YEAR.test(t))) continue;
    // "Base Parallels (Teal, Purple, Green /100, ...)": the parallels of a set
    // already read, listed again card by card. Kept as that set's parallels.
    const pm = /^(.*?)\s*Parallels?\s*\((.+)\)\s*$/i.exec(t);
    if (pm) {
      const of = sets.slice().reverse().find(s => s.cards.length && s.name.toLowerCase() === (pm[1] || 'Base').trim().toLowerCase());
      if (of) { of.parallels = (of.parallels || []).concat(readParallels(pm[2])); cur = { skip: true, cards: [] }; continue; }
    }
    // A short line of words with no card number: a section heading. A print
    // run in it ("Green /100") is not a stray number.
    if (t.length <= 140 && /^[A-Za-z]/.test(t) && !/\d{3,}/.test(t.replace(/\/\s*\d+/g, '')) && !/\.com\b|^page\s+\d/i.test(t)) {
      cur = { name: t, cards: [] }; sets.push(cur);
    }
  }
  return sets.filter(s => !s.skip && s.cards.length);
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
      cards: s.cards.map(c => ({ number: c.number, player: c.player, team })),
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
  for (const item of items) {
    const label = `${item.brand} | ${item.school} | ${item.year}${item.suffix ? ' | ' + item.suffix : ''}`;
    try {
      const pdf = path.join(tmp, 'c.pdf');
      fs.writeFileSync(pdf, await get(item.pdf, 'buffer'));
      const text = execFileSync('pdftotext', ['-layout', pdf, '-'], { encoding: 'utf8' });
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

module.exports = { readParallels, parseChecklistText, toProduct, listFromPage, nameCase, firstYear };
