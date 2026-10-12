#!/usr/bin/env node
/**
 * Basketball and baseball checklists from SportLots listings, for the years
 * before 2000 (the 2000-2011 files were built the same way, #752).
 *
 *   node scripts/build-sportlots-checklists.js <raw-dir> [--write] [--sport Basketball|Baseball]
 *
 * <raw-dir> holds one JSON-lines file per sport and year, "<Sport>-<year>.jsonl",
 * each line a card SportLots has in stock: { s: set id, q: the card's place in
 * the set (steps of 5), set: "1991 Fleer Base Set", card: "#1 John Battle",
 * v: a variation }. They are written by a crawl of SportLots' search, one
 * year at a time.
 *
 * Sets become products by name: "<X> Base Set" makes product <X>, and every
 * other set of that year whose name starts with <X> is one of its sets (an
 * insert, or a parallel when it repeats the base set's numbers under a
 * parallel's name: "1991 Front Row Gold"). A set with no base set of its own
 * is a product with one set. Promos, prototypes, samples and uncut sheets are
 * left out.
 *
 * SportLots lists what dealers have, so a scarce card can be missing. The
 * card's place in the set says so: a gap in the places is a card not listed,
 * and the set's size is its last place. A product with gaps carries the
 * partial note, and totalCards is the real size.
 *
 * Basketball products are named by season ("1991-92 Fleer Basketball"), as
 * the 2000-01 on files are. Products already on file are skipped.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { categoryOf, parsePage } = require('./import-checklistinsider');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const RAW = args[0];
const WRITE = args.includes('--write');
const ONLY = args.includes('--sport') ? args[args.indexOf('--sport') + 1] : null;
// Write somewhere else, to look before writing for real.
const OUT = args.includes('--out') ? args[args.indexOf('--out') + 1] : null;
// Cardboard Connection product pages, saved as "<slug>.html" (slug as the
// site's URL, "1986-87-fleer-basketball-cards"). Where one exists for a
// product its checklist is complete, with teams and rookies, so it leads.
const CC = args.includes('--cc') ? args[args.indexOf('--cc') + 1] : null;
if (!RAW) { console.error('usage: build-sportlots-checklists.js <raw-dir> [--write] [--sport S]'); process.exit(2); }

const DIRS = { Basketball: 'checklists-basketball', Baseball: 'checklists-baseball' };
const JUNK = /\b(promos?|promotional|prototypes?|samples?|sheets?|uncut|panels?|proofs?|test issue|wrappers?|box bottoms?|unopened)\b/i;
// A one-word remainder that names a parallel ("Gold", "Tiffany", "Glossy").
const PARALLEL_WORD = /^(gold|silver|bronze|platinum|black|red|blue|green|purple|orange|tiffany|glossy|refractors?|foil|electric|holo|holographic|emerald|ruby|sapphire|diamond|star|stars|press proofs?|artist'?s proofs?|members only|first day issue|special forces|1st day issue|gold signature|gold medallion|copper|chrome|xfractors?|super ?fractors?|rainbow|prism|prismatic|die ?cut|mirror|parallel|limited|limited edition|collectors choice|desert shield|o-pee-chee|opc)$/i;
const NOTE = 'Partial checklist: some of the rarer cards aren\'t listed yet.';

const slugify = (s) => String(s).toLowerCase().replace(/['’]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const season = (y) => `${y}-${String((Number(y) + 1) % 100).padStart(2, '0')}`;

function parseCard(r) {
  const m = /^#\s*(\S+)\s+(.*)$/.exec(String(r.card || '').trim());
  if (!m) return null;
  let player = m[2].split('|').map(s => s.trim()).filter(Boolean).join('/');
  if (!player) return null;
  const card = { number: m[1], player };
  if (r.v) card.note = String(r.v).trim();
  return card;
}

// One set's cards, from its listings: one card per place, the size from the
// last place (when the places step by 5 as SportLots numbers them).
function buildSet(rows) {
  const byPlace = new Map();
  for (const r of rows) {
    const c = parseCard(r);
    if (!c) continue;
    const k = Number(r.q);
    if (!byPlace.has(k)) byPlace.set(k, c);
  }
  const places = [...byPlace.keys()].sort((a, b) => a - b);
  const cards = places.map(k => byPlace.get(k));
  const stepsOf5 = places.length > 2 && places.every(k => k % 5 === 0);
  const size = stepsOf5 ? Math.max(places[places.length - 1] / 5, cards.length) : cards.length;
  return { cards, size, partial: size > cards.length };
}

function buildYear(sport, year, rows, existing) {
  const bySet = new Map();
  for (const r of rows) {
    const name = String(r.set || '').replace(/\s+/g, ' ').trim();
    // Only this year's sets: the search is by words, and "1986 Fleer" also
    // finds a 2008 retro card that mentions 1986.
    if (!name.startsWith(year + ' ') || JUNK.test(name)) continue;
    if (!bySet.has(name)) bySet.set(name, []);
    bySet.get(name).push(r);
  }
  const names = [...bySet.keys()];
  const bases = names.filter(n => / Base Set$/.test(n)).map(n => n.replace(/ Base Set$/, ''))
    .sort((a, b) => b.length - a.length);
  const products = new Map();
  for (const n of names) {
    const owner = / Base Set$/.test(n) ? n.replace(/ Base Set$/, '')
      : bases.find(b => n.startsWith(b + ' ')) || n;
    if (!products.has(owner)) products.set(owner, []);
    products.get(owner).push(n);
  }
  const docs = [];
  for (const [prod, setNames] of products) {
    const title = prod.slice(year.length + 1).replace(/\s*\|\s*/g, '/');   // "Fleer", "Front Row"
    const yr = sport === 'Basketball' ? season(year) : year;
    const id = `${slugify(yr + ' ' + title)}-${sport.toLowerCase()}`;
    if (existing.has(id)) continue;
    const baseName = setNames.find(n => n === prod + ' Base Set') || (setNames.length === 1 ? setNames[0] : null);
    const sets = [];
    let partial = false;
    const base = baseName ? buildSet(bySet.get(baseName)) : null;
    const baseNums = new Set(base ? base.cards.map(c => c.number) : []);
    const baseSet = base && base.cards.length ? { id: 'base', name: 'Base', category: 'base', totalCards: base.size, parallels: [], cards: base.cards } : null;
    if (baseSet) { sets.push(baseSet); partial = partial || base.partial; }
    for (const n of setNames) {
      if (n === baseName) continue;
      const rest = (n.slice(prod.length + 1).trim() || n.slice(year.length + 1)).replace(/\s*\|\s*/g, '/');
      const s = buildSet(bySet.get(n));
      if (!s.cards.length) continue;
      const repeats = s.cards.filter(c => baseNums.has(c.number)).length;
      if (baseSet && PARALLEL_WORD.test(rest) && repeats >= 0.8 * s.cards.length) {
        baseSet.parallels.push({ name: rest, printRun: null });
        continue;
      }
      sets.push({ id: slugify(rest) || 'set', name: rest, category: categoryOf('', rest), totalCards: s.size, parallels: [], cards: s.cards });
      partial = partial || s.partial;
    }
    if (!sets.length) continue;
    // A product of one card, or of a few cards from a set of hundreds, is a
    // listing, not a checklist.
    const listed = sets.reduce((a, s) => a + s.cards.length, 0);
    if (listed < 3) continue;
    // Unique set ids.
    const seen = new Set();
    for (const s of sets) { let i = s.id, k = 2; while (seen.has(i)) i = `${s.id}-${k++}`; s.id = i; seen.add(i); }
    const doc = { id, name: `${yr} ${title} ${sport}`, year: Number(year), brand: title, sport, sets };
    if (partial) doc.note = NOTE;
    docs.push(doc);
  }
  return docs;
}

// ---- Cardboard Connection ----
const npl = (x) => String(x || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\b(jr|sr|ii|iii|iv)\b/g, '').replace(/[^a-z]+/g, '');
const nnum = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, '').replace(/^0+(?=\d)/, '');
const key = (c) => `${nnum(c.number)}|${npl(c.player)}`;
function ccSets(html) {
  const sets = parsePage(html).filter(st => !/review this product|cancel reply|team checklist/i.test(st.name));
  for (const st of sets) {
    st.name = st.name.replace(/\s+Set$/i, '').replace(/^Base Set$/i, 'Base') || st.name;
    if (/^base$/i.test(st.name)) { st.name = 'Base'; st.id = 'base'; st.category = 'base'; }
    for (const c of st.cards) {
      // "Detroit Pistons DP": a double print, said after the team.
      const m = /^(.*?)\s+(DP|SP|SSP|TP)$/.exec(c.team || '');
      if (m) { c.team = m[1]; c.note = c.note ? `${c.note}, ${m[2]}` : m[2]; }
    }
  }
  return sets;
}
const ccTitle = (html) => (((html.match(/<title>([^<]*)/) || [])[1] || '').replace(/&#8217;|&#039;/g, "'").replace(/&amp;/g, '&')
  .split(/\s+Checklist/)[0]).trim();
const ccPages = CC && fs.existsSync(CC) ? new Set(fs.readdirSync(CC).filter(f => f.endsWith('.html')).map(f => f.slice(0, -5))) : new Set();
const ccUsed = new Set();
// The product's page, by the id it would have there.
function withCC(doc) {
  const slug = `${doc.id}-cards`;
  if (!ccPages.has(slug)) return doc;
  const sets = ccSets(fs.readFileSync(path.join(CC, slug + '.html'), 'utf8'));
  const ccCards = sets.reduce((a, st) => a + st.cards.length, 0);
  if (!sets.length || ccCards < 10) return doc;
  ccUsed.add(slug);
  const held = new Set(sets.flatMap(st => st.cards.map(key)));
  const extra = doc.sets.filter(st => st.cards.filter(c => held.has(key(c))).length < 0.2 * st.cards.length);
  const ids = new Set(sets.map(st => st.id));
  for (const st of extra) { let i = st.id, k = 2; while (ids.has(i)) i = `${st.id}-${k++}`; st.id = i; ids.add(i); }
  // Partial only if a SportLots set it kept is.
  const gaps = extra.some(st => st.totalCards > st.cards.length);
  return { ...doc, sets: [...sets, ...extra],
    note: `Built from the published checklist at cardboardconnection.com${extra.length ? ', with SportLots for the sets it does not list' : ''}.${gaps ? ' ' + NOTE : ''}` };
}
// A page with no SportLots product behind it (vintage basketball, which
// SportLots barely stocks): a product of its own.
function ccOnly(sport, existing) {
  const out = [];
  const re = new RegExp(`^(\\d{4})(-\\d{2})?-(.+)-${sport.toLowerCase()}-cards$`);
  for (const slug of ccPages) {
    const m = re.exec(slug);
    if (!m || ccUsed.has(slug) || Number(m[1]) >= 2000) continue;
    let id = slug.replace(/-cards$/, '');
    // Basketball by season: "1961-fleer" pages are "1961-62".
    if (sport === 'Basketball' && !m[2]) id = `${season(m[1])}-${m[3]}-basketball`;
    if (existing.has(id)) continue;
    const html = fs.readFileSync(path.join(CC, slug + '.html'), 'utf8');
    const sets = ccSets(html);
    if (sets.reduce((a, st) => a + st.cards.length, 0) < 10) continue;
    const title = ccTitle(html);
    const brand = title.replace(/^\d{4}(-\d{2})?\s+/, '').replace(new RegExp(`\\s+${sport}$`, 'i'), '').trim();
    out.push({ id, name: sport === 'Basketball' && !m[2] ? `${season(m[1])} ${brand} ${sport}` : title, year: Number(m[1]), brand, sport,
      note: 'Built from the published checklist at cardboardconnection.com.', sets });
    ccUsed.add(slug); existing.add(id);
  }
  return out;
}

const summary = {};
for (const sport of Object.keys(DIRS)) {
  if (ONLY && ONLY !== sport) continue;
  const dir = path.join(ROOT, 'public', 'data', DIRS[sport]);
  const existing = new Set(fs.readdirSync(dir).map(f => f.replace(/\.json$/, '')));
  const files = fs.readdirSync(RAW).filter(f => f.startsWith(sport + '-') && f.endsWith('.jsonl')).sort();
  let products = 0, cards = 0, partial = 0;
  for (const f of files) {
    const year = f.slice(sport.length + 1, -6);
    if (Number(year) >= 2000) continue;
    const rows = fs.readFileSync(path.join(RAW, f), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    const docs = buildYear(sport, year, rows, existing).map(withCC);
    for (const d of docs) {
      products++; cards += d.sets.reduce((a, s) => a + s.cards.length, 0); if (d.note && d.note.includes(NOTE)) partial++;
      existing.add(d.id);
      if (WRITE || OUT) {
        const to = OUT ? path.join(OUT, DIRS[sport]) : dir;
        fs.mkdirSync(to, { recursive: true });
        fs.writeFileSync(path.join(to, d.id + '.json'), JSON.stringify(d) + '\n');
      }
    }
  }
  let fromCC = 0;
  for (const d of ccOnly(sport, existing)) {
    products++; fromCC++; cards += d.sets.reduce((a, st) => a + st.cards.length, 0);
    if (WRITE || OUT) {
      const to = OUT ? path.join(OUT, DIRS[sport]) : dir;
      fs.mkdirSync(to, { recursive: true });
      fs.writeFileSync(path.join(to, d.id + '.json'), JSON.stringify(d) + '\n');
    }
  }
  summary[sport] = { products, cards, partial, cardboardConnection: ccUsed.size, ccOnly: fromCC };
}
console.log(JSON.stringify(summary));
if (!WRITE) console.log('report only; --write to write the files');
