#!/usr/bin/env node
/**
 * Clean the parallel names the original parses left notes on.
 *
 * The sources write a parallel's print run and exceptions on the same line —
 * "Gold – /75 (no Anderson, Charbonnet)", "Platinum – 1/1 (select cards only,
 * list below)", "Season Stat Line – print runs vary, list below" — and the
 * parsers kept the whole line as the name, with no print run. A sale saying
 * "Gold /75" then has no "Gold" to match. And a few prose lines rode in as
 * parallels ("Rookie Cuts parallels (#201-240) listed under Autographs tab.").
 *
 *   node scripts/clean-parallel-names.js          report
 *   node scripts/clean-parallel-names.js --fix    rewrite the checklists
 *
 * A name becomes what is before its dash, its print run is read from what is
 * after (/75, 1/1, "/89 or less") when it has none, notes in brackets go,
 * and a line that reads as a sentence is dropped. Two entries that then name
 * the same parallel become one, keeping the first and any print run either had.
 */
const fs = require('fs');
const path = require('path');
const DIR = path.join(__dirname, '..', 'public', 'data', 'checklists');
const FIX = process.argv.includes('--fix');

const PROSE = /\b(listed|see below|specifics|parallels\b|tab\b|quantities|announced|available|copies|each|below|baseball|basketball|hockey|box sets?)\b|\b(of|and|the|for)$/i;
function clean(p) {
  const original = String(p.name || '');
  // "#201-240 — Spectrum" lists a range's own parallel: a shape of its own,
  // left as it is.
  if (/^#/.test(original.trim())) return { ...p };
  // Notes in brackets first — they carry dashes of their own ("Refractor
  // (Hobby – 1:4; Mega – 1:6)") — then stray marks at either end.
  let name = original.replace(/\s*\([^)]*\)/g, '').replace(/^[^A-Za-z0-9#]+/, '').replace(/\s*[–—-]\s*$/, '').trim();
  let run = p.printRun == null ? null : p.printRun;
  // "Name – /75 ...", "Name — 1/1 ...", "Name - print runs vary ..."
  const m = /^(.+?)\s+[–—-]\s+(.*)$/.exec(name);
  if (m && !/^\d/.test(m[1])) {
    name = m[1];
    const rest = m[2].trim();
    const r = /^(?:#?\s*\/\s*(\d{1,5})|1\s*\/\s*1)\b/.exec(rest);
    // One run for the whole parallel only: "/99-/349", "/499 (#1-135), /299
    // (#136-200)" and "/89 or less" vary by card, and stay unstated.
    const varies = /\/\s*\d[\s\S]*\/\s*\d|or less|vary|varies|varied/i.test(rest);
    if (r && run == null && !varies) run = r[1] ? parseInt(r[1], 10) : 1;
  }
  // A run written into the name: "Bronze Surge /375".
  const inl = /^(.*?[A-Za-z].*?)\s+\/\s*(\d{1,5})$/.exec(name);
  if (inl) { name = inl[1]; if (run == null) run = parseInt(inl[2], 10); }
  name = name.replace(/\s*\([^)]*\)/g, '').replace(/\s+/g, ' ').replace(/[.;,]+$/, '').trim();
  if (!name || PROSE.test(name) || name.split(' ').length > 7) return null;
  // A base set's own sections, which some articles list after its parallels
  // ("Veterans/Retired Players", "Rookies", "Pro Bowl").
  if (/^(rookies?|rated rookies|veterans?|retired|pro bowl|nfl debut|hall of fame|mvps?)$/i.test(name)
      || /^veterans?\s*\//i.test(name)) return null;
  // Page furniture: "TAGS2020 PANINI SELECT FOOTBALLSELECT", "Shop for 2025
  // Topps Resurgence Football cards on eBay", "...(in 2021 Playoff Football".
  // "Football" alone is a real patch parallel ("Football Leather", "NFL
  // Shield Football"), so it is the year that marks the junk.
  if (/[A-Za-z](19|20)\d{2}|^shop for\b|\bon ebay\b|\b(19|20)\d{2}\b.*\bfootball\b/i.test(name)) return null;
  // OCR debris ("re 5 xt", "> y S"): a name has a real word in it and is
  // made of the characters names are made of.
  if (!/[A-Za-z]{2}/.test(name) || !/^[A-Za-z0-9\u00C0-\u024F][A-Za-z0-9\u00C0-\u024F ,'’&\/.+!-]*$/.test(name)) return null;
  return { ...p, name, printRun: run };
}

module.exports = { clean };
if (require.main !== module) return;

const key = (n) => String(n || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
let files = 0, renamed = 0, dropped = 0, merged = 0;
const examples = [];
for (const f of fs.readdirSync(DIR).filter(f => f.endsWith('.json') && f !== 'index.json')) {
  const file = path.join(DIR, f);
  const raw = fs.readFileSync(file, 'utf8');
  const doc = JSON.parse(raw);
  let changed = false;
  for (const set of doc.sets || []) {
    if (!Array.isArray(set.parallels)) continue;
    const out = [];
    for (const p of set.parallels) {
      const c = clean(p);
      if (!c) { dropped++; changed = true; if (examples.length < 30) examples.push(`drop  "${p.name}"`); continue; }
      if (c.name !== p.name || c.printRun !== p.printRun) {
        renamed++; changed = true;
        if (examples.length < 30) examples.push(`fix   "${p.name}" -> "${c.name}"${c.printRun ? ' /' + c.printRun : ''}`);
      }
      const twin = out.find(q => key(q.name) === key(c.name) && (q.printRun == null || c.printRun == null || q.printRun === c.printRun));
      if (twin) { if (twin.printRun == null && c.printRun != null) twin.printRun = c.printRun; merged++; changed = true; continue; }
      out.push(c);
    }
    set.parallels = out;
  }
  if (changed) {
    files++;
    if (FIX) fs.writeFileSync(file, JSON.stringify(doc, null, raw.includes('\n  ') ? 2 : 0) + (raw.endsWith('\n') ? '\n' : ''));
  }
}
for (const e of examples) console.log(e);
console.log(`\n${FIX ? '' : '[dry] '}${files} files: ${renamed} names cleaned, ${dropped} prose lines dropped, ${merged} duplicates merged`);
