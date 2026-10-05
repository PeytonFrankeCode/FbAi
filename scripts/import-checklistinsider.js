#!/usr/bin/env node
/**
 * Build a checklist from a checklistinsider.com product page.
 *
 *   node scripts/import-checklistinsider.js <page.html | url> --id 2026-topps-inception-football \
 *        --name "2026 Topps Inception Football" --brand "Topps Inception" [--year 2026] [--out file.json]
 *
 * The 2026 Bowman, Flagship and Heritage files were built from the same site
 * by hand-copied text files. This reads the page itself. Its "Checklist" tab is
 * regular: an <h2> per group ("… Autograph Checklist", "… Insert Checklist"),
 * an <h3> per set, then a card count, an optional "Parallels:" block, and one
 * "<number> <player> - <team>" line per card. Dual cards read
 * "A/B - Team/Team"; a rookie carries "RC".
 *
 * Writes the checklist JSON (default: public/data/checklists/<id>.json). Then
 * update index.json, run `npm run checklist:validate` and
 * `npm run build:card-index`.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const decode = (s) => String(s)
  .replace(/<br\s*\/?>|<\/?(?:div|p|li|ul|ol)[^>]*>/gi, '\n')
  .replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#8217;|&rsquo;/g, "'")
  .replace(/&#8211;|&ndash;/g, '-').replace(/&#8220;|&#8221;|&quot;/g, '"').replace(/&#039;|&#39;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));

const slug = (s) => String(s).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// The group heading decides the category; a set name that says what it is
// overrides it ("… Relic Autographs" inside an autograph group is still an
// autograph, a "… Relics" set in an insert group is memorabilia).
function categoryOf(group, set) {
  const g = group.toLowerCase(), s = set.toLowerCase();
  if (/\bbase\b/.test(s) && !/auto|signature|relic|patch/.test(s)) return 'base';
  if (/auto|signature|signings|signed|\bink\b|marks|script|calligraphy|traces/.test(s)) return 'autograph';
  if (/relic|patch|material|swatch|jersey|memorabilia/.test(s)) return 'memorabilia';
  if (/autograph/.test(g)) return 'autograph';
  if (/relic|memorabilia/.test(g)) return 'memorabilia';
  if (/\bbase\b/.test(g)) return 'base';
  return 'insert';
}

// "Gold Refractor /50", "Gold - #/50", "Red 1/1", "Superfractor - 1/1", "Rainbow Foil".
function parseParallels(text) {
  const out = [];
  for (let line of text.split(/\n|,(?![^()]*\))/)) {
    line = line.replace(/^\s*[-•*]\s*/, '').trim();
    if (!line || /^(tba|none|n\/a)$/i.test(line) || /^parallels?:?$/i.test(line)) continue;
    const m = line.match(/^(.*?)\s*[-–]?\s*(?:#\s*)?\/\s*(\d+)\s*$/) || line.match(/^(.*?)\s*[-–]?\s*1\s*\/\s*(1)\s*$/);
    const name = (m ? m[1] : line).replace(/[-–:\s]+$/, '').trim();
    if (!name || name.length > 60) continue;
    out.push({ name, printRun: m ? Number(m[2]) : null });
  }
  return out;
}

const CARD_LINE = /^([A-Za-z0-9&]+(?:-[A-Za-z0-9&]+)*)\s+(.+?)\s+-\s+(.+?)$/;
// A line with a player and team but no number continues the card above it:
// the second (or third) name on a dual card. Stored the way the existing
// files store duals: "A/B", with the team once when both share it.
const CONTINUATION = /^(.+?)\s+-\s+(.+?)$/;
// A card number has a digit in it ("12", "DCC-1") or is an upper-case code
// ("RA-AR", "BOS-A&M"). A first name is neither, hyphenated or not, which is
// what tells "Germie Bernard - Steelers" and "Jaron-Keawe Sagapolutele -
// California" (the second name on a dual card) from a card of their own.
const isNumber = (s) => /\d/.test(s) || (/-/.test(s) && !/[a-z]/.test(s));

function parseCards(text) {
  const cards = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+/g, ' ').trim();
    const m = CARD_LINE.exec(line);
    if (!m || !isNumber(m[1])) {
      const c = CONTINUATION.exec(line);
      const prev = cards[cards.length - 1];
      if (c && prev && !/^(tba|parallels?)/i.test(line)) {
        const team = c[2].replace(/\s*\bRC\b\s*/g, ' ').trim();
        prev.player = `${prev.player}/${c[1].replace(/\s*\bRC\b\s*/g, ' ').trim()}`;
        const teams = prev.team.split('/');
        if (!teams.includes(team) || teams.length > 1) prev.team = `${prev.team}/${team}`;
        if (/\bRC\b/.test(line)) prev.rookie = true;
      }
      continue;
    }
    let [, number, player, team] = m;
    let rookie = false;
    if (/\bRC\b/.test(team)) { rookie = true; team = team.replace(/\s*\bRC\b\s*/g, ' ').trim(); }
    if (/\bRC\b/.test(player)) { rookie = true; player = player.replace(/\s*\bRC\b\s*/g, ' ').trim(); }
    // A note in brackets after the team ("(SSP)", "(Variation)") is kept as a note.
    let note = null;
    const nm = team.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
    if (nm) { team = nm[1].trim(); note = nm[2].trim(); }
    const card = { number, player, team };
    if (rookie) card.rookie = true;
    if (note) card.note = note;
    cards.push(card);
  }
  return cards;
}

function parsePage(html) {
  // Only the "Checklist" tab: it ends where the team lists begin.
  const start = html.search(/<h2[^>]*>[^<]*Checklist<\/h2>\s*<\/p>\s*<h2>/i);
  const from = start >= 0 ? start : html.indexOf('Base Checklist');
  const end = html.indexOf('Team Checklist</h2>', from);
  const body = html.slice(from, end > from ? end : undefined);

  const sets = [];
  let group = '';
  const parts = body.split(/(<h[23][^>]*>[\s\S]*?<\/h[23]>)/i);
  for (let i = 0; i < parts.length; i++) {
    const h = /^<h([23])[^>]*>([\s\S]*?)<\/h\1>$/i.exec(parts[i]);
    if (!h) continue;
    const title = decode(h[2]).trim();
    if (h[1] === '2') { group = title; continue; }
    const name = title.replace(/\s*Checklist\s*$/i, '').trim();
    const text = decode(parts[i + 1] || '');
    const pm = text.match(/Parallels?\s*:?\s*\n([\s\S]*?)(?:\n\s*\n|\n(?=[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*\s+\S.*\s-\s))/i);
    const cards = parseCards(text);
    if (!cards.length) continue;
    const countMatch = text.match(/(\d+)\s+cards?\./i);
    const set = {
      id: slug(name), name, category: categoryOf(group, name),
      totalCards: countMatch ? Number(countMatch[1]) : cards.length,
      parallels: pm ? parseParallels(pm[1]) : [],
      cards,
    };
    // A whole set at one print run ("Print run: 25" / "#/25").
    const run = text.match(/(?:print run|numbered)\s*(?:to|:)?\s*#?\/?\s*(\d+)/i);
    if (run) set.printRun = Number(run[1]);
    sets.push(set);
  }
  return sets;
}

module.exports = { parsePage, parseCards, parseParallels, categoryOf };
if (require.main !== module) return;

(async () => {
  const argv = process.argv.slice(2);
  const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
  const src = argv[0];
  const id = opt('id'), name = opt('name'), brand = opt('brand');
  if (!src || !id || !name || !brand) {
    console.error('usage: import-checklistinsider.js <page.html|url> --id ID --name NAME --brand BRAND [--year Y] [--out FILE]');
    process.exit(2);
  }
  const html = /^https?:/.test(src) ? await (await fetch(src)).text() : fs.readFileSync(src, 'utf8');
  const sets = parsePage(html);
  if (!sets.length) { console.error('no sets found: is the checklist published yet?'); process.exit(1); }
  const doc = {
    id, name, year: Number(opt('year', (name.match(/\b(19|20)\d{2}\b/) || [])[0])), brand, sport: 'Football',
    note: 'Built from the published checklist at checklistinsider.com.',
    sets,
  };
  const out = opt('out', path.join(__dirname, '..', 'public', 'data', 'checklists', `${id}.json`));
  fs.writeFileSync(out, JSON.stringify(doc, null, 2) + '\n');
  const cards = sets.reduce((a, s) => a + s.cards.length, 0);
  console.log(`${id}: ${sets.length} sets, ${cards} cards -> ${out}`);
  for (const s of sets) {
    const short = s.totalCards !== s.cards.length ? `  (page says ${s.totalCards})` : '';
    console.log(`  ${s.category.padEnd(11)} ${s.name} — ${s.cards.length} cards, ${s.parallels.length} parallels${short}`);
  }
})();
