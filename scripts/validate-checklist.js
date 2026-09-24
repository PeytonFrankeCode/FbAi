#!/usr/bin/env node
// Will this checklist actually sort cards, or just sit there looking complete?
//
// Adding a product is the highest-value work available on this site — 21% of
// sampled sales match no product at all, and no reader, however clever, can
// identify a card that is not in the answer key. But a checklist fails in two
// very different ways and only one of them is visible.
//
// It can be MALFORMED, which something eventually throws on. Or it can be
// well-formed and USELESS: every field present, the product listed in the
// browser, and not one sale ever joining to it because the name does not match
// what sellers write, or the parallels are spelled the way the manufacturer
// spells them rather than the way eBay does. That second kind is the expensive
// one. It looks like finished work.
//
// So this checks both, and the --title mode closes the loop: paste a real
// listing title and see exactly what the search engine will make of it against
// the file you just wrote.
//
// Run:
//   node scripts/validate-checklist.js public/data/checklists/<file>.json
//   node scripts/validate-checklist.js <file>.json --title "2025 Panini ..."
//   node scripts/validate-checklist.js --all
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'public', 'data', 'checklists');
const { norm, buildIndex, matchSale } = require(path.join(ROOT, 'set-key.js'));

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valueOf = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
const files = argv.filter(a => !a.startsWith('--') && a !== valueOf('--title'));

// The four the catalogue actually uses, counted across all 11,843 sets. A fifth
// spelling is not a new idea, it is a typo — the ambiguity map groups by these
// and an unknown one lands in no group at all.
const CATEGORIES = new Set(['base', 'autograph', 'memorabilia', 'insert']);

// Player names that are not names, taken from what is actually in the
// catalogue rather than imagined. A card whose player field is parse debris can
// never match a sale, and it sits there looking like a card.
//
// Deliberately NOT flagged: a long name full of slashes. "Deshaun Watson/
// DeShone Kizer/Mitchell Trubisky/Patrick Mahomes II" is a real quad autograph
// and there are 367 of them — the shape that looks wrong is usually right.
const PLAYER_ARTIFACTS = [
  [/[[\]{}<>]/, 'markup leaked in from the source page'],
  [/~/, 'stray tilde, usually a footnote marker the parser kept'],
  [/\/\d+\/\d+\s*$/, 'a print run glued onto the end of the name'],
  [/^[^(]*\)/, 'an unmatched closing bracket — a fragment of the line above'],
  [/^[^A-Za-z]*$/, 'contains no letters'],
];

let errors = 0, warnings = 0;
const err = (where, msg) => { errors++; console.log(`  ERROR  ${where}  ${msg}`); };
const warn = (where, msg) => { warnings++; console.log(`  WARN   ${where}  ${msg}`); };
const ok = (msg) => console.log(`  ok     ${msg}`);

function validateStructure(doc, file) {
  const base = path.basename(file).replace(/\.json$/, '');

  for (const [k, type] of [['id', 'string'], ['name', 'string'], ['brand', 'string'],
                           ['sport', 'string'], ['year', 'number']]) {
    if (typeof doc[k] !== type) err(k, `must be a ${type}, got ${JSON.stringify(doc[k])}`);
  }
  // The index is keyed by FILENAME and the browser builds its fetch URL from
  // that, so a file whose internal id disagrees with its name produces a row
  // in the product list that 404s when anyone clicks it.
  if (doc.id && doc.id !== base) {
    err('id', `"${doc.id}" does not match the filename "${base}" — the product list would 404`);
  }
  // A product announced but not yet released is listed on purpose with no
  // sets ("Checklist not released yet"), and says so.
  if (doc.unreleased === true && Array.isArray(doc.sets) && doc.sets.length === 0) {
    ok('unreleased placeholder — no sets until the checklist is published');
    return;
  }
  if (!Array.isArray(doc.sets) || doc.sets.length === 0) {
    err('sets', 'must be a non-empty array — a product with no sets holds no cards');
    return;
  }

  const setIds = new Set();
  for (const [i, set] of doc.sets.entries()) {
    const at = `sets[${i}]${set && set.name ? ` "${set.name}"` : ''}`;
    if (!set || typeof set !== 'object') { err(at, 'not an object'); continue; }
    if (!set.id) err(at, 'missing id');
    else if (setIds.has(set.id)) err(at, `duplicate set id "${set.id}"`);
    else setIds.add(set.id);
    if (!set.name) err(at, 'missing name');
    if (!CATEGORIES.has(set.category)) {
      err(at, `category ${JSON.stringify(set.category)} is not one of ${[...CATEGORIES].join(', ')}`);
    }

    // Every one of the 11,843 sets already in the catalogue has cards, and none
    // has a non-string card number. Both are real invariants rather than
    // conventions, and both fail silently: a set with no cards is a set no sale
    // can ever match, and a numeric 1 keys differently from "1".
    if (!Array.isArray(set.cards) || set.cards.length === 0) {
      err(at, 'has no cards — it will appear in the browser and match no sale');
      continue;
    }
    // Card numbers repeat inside a set far more often than they look like they
    // should, and almost always legitimately: a quad autograph is one card with
    // four players, and the catalogue stores it as four rows sharing a number.
    // Measured over the whole catalogue there are 12,198 of those against 461
    // true duplicates, so flagging the shape as an error cries wolf on 116 of
    // 361 files — and a validator you learn to ignore is worth less than none.
    //
    // What IS an error is the same player twice on the same number. That is a
    // duplicated row, and it double-counts the card.
    const byNumber = new Map();
    for (const [j, card] of set.cards.entries()) {
      const cat = `${at} card[${j}]`;
      if (typeof card.number !== 'string') {
        err(cat, `number must be a string, got ${JSON.stringify(card.number)}`);
      } else {
        const players = byNumber.get(card.number) || new Set();
        if (players.has(card.player)) {
          err(cat, `"${card.player}" is listed twice on #${card.number} — a duplicated row`);
        }
        players.add(card.player);
        byNumber.set(card.number, players);
      }
      if (!card.player || typeof card.player !== 'string') {
        err(cat, `missing player, got ${JSON.stringify(card.player)}`);
        continue;
      }
      const artifact = PLAYER_ARTIFACTS.find(([re]) => re.test(card.player));
      if (artifact) warn(cat, `${JSON.stringify(card.player.slice(0, 48))} — ${artifact[1]}`);
    }
    // Three or more players on one number is a legitimate multi-player card.
    // Two different sets merged under one heading looks the same from here, so
    // it is reported once per set rather than per card, without a verdict.
    const shared = [...byNumber.entries()].filter(([, p]) => p.size > 1);
    if (shared.length > 3) {
      warn(at, `${shared.length} card numbers carry more than one player `
             + `(e.g. #${shared[0][0]}: ${[...shared[0][1]].slice(0, 3).join(', ')}) — `
             + `normal for multi-player cards, wrong if two sets were merged`);
    }
    if (set.totalCards != null && set.totalCards !== set.cards.length) {
      warn(at, `totalCards says ${set.totalCards}, the file holds ${set.cards.length}`);
    }

    for (const [j, par] of (set.parallels || []).entries()) {
      const pat = `${at} parallels[${j}]`;
      const name = typeof par === 'string' ? par : (par && par.name);
      if (!name) { err(pat, 'parallel has no name'); continue; }
      // build-card-index drops these on the floor without saying so — a prose
      // footnote in the parallels list is not a parallel.
      if (name.length > 60 || /[.]$/.test(name.trim())) {
        warn(pat, `"${name.slice(0, 50)}" reads as a footnote and will be DROPPED `
                + `(over 60 chars, or ends in a full stop)`);
      }
      if (!norm(name)) warn(pat, `"${name}" normalises to nothing and cannot be matched`);
      // 300+ entries already in the catalogue write this as a string ("25"),
      // and every consumer coerces — the landing-page sort does `a - b`, which
      // works on numeric strings. So it is a wart, not a break, and it is
      // reported as one. An unusable value is still an error.
      if (par && par.printRun != null) {
        const n = typeof par.printRun === 'number' ? par.printRun : Number(par.printRun);
        if (!Number.isFinite(n) || n < 1) {
          err(pat, `printRun must be a positive number or null, got ${JSON.stringify(par.printRun)}`);
        } else if (typeof par.printRun !== 'number') {
          warn(pat, `printRun is the string ${JSON.stringify(par.printRun)}, not a number — `
                  + `it survives on coercion today, but write it as ${n}`);
        }
      }
    }
  }
}

// Will a sale ever FIND this product?
//
// The join runs on (year, set_name) out of the sales table, where set_name is
// the product as the collector read it off a title — "Prizm", not "2025 Panini
// Prizm Football". If the catalogue name does not reduce to something a sale
// reduces to as well, the product is catalogued and unreachable, which looks
// exactly like finished work.
function validateJoin(doc, file) {
  const products = [];
  for (const f of fs.readdirSync(DIR).sort()) {
    if (!f.endsWith('.json') || f === 'index.json') continue;
    const d = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
    products.push({ id: f.replace(/\.json$/, ''), name: d.name, year: d.year });
  }
  const me = path.basename(file).replace(/\.json$/, '');
  if (!products.some(p => p.id === me)) {
    products.push({ id: me, name: doc.name, year: doc.year });
    console.log(`  note   not yet in ${path.relative(ROOT, DIR)} — testing the join as if it were`);
  }
  const { index } = buildIndex(products);

  // The spellings a collector actually produces, commonest first.
  const brand = String(doc.brand || '');
  const nameNoYear = String(doc.name || '').replace(/^\d{4}(-\d{2})?\s*/, '');
  // The full name is the one that must resolve to THIS product. The shorter
  // spellings are shared across a product family on purpose — a 2017 sale
  // saying only "Prizm" means base Prizm, not Prizm Collegiate Draft, and
  // treating that as an error would block every sibling product anyone adds.
  const spellings = [...new Set([nameNoYear, brand,
    nameNoYear.replace(/\s*football\s*$/i, ''),
    nameNoYear.replace(/^(panini|topps|leaf|upper deck|bowman)\s+/i, '')].filter(Boolean))];
  const mustBeMine = (s) => s === nameNoYear;

  let reachable = 0;
  for (const s of spellings) {
    // matchSale hands back the product OBJECT, not its id. Comparing it to a
    // string is always false, which reported every product in the catalogue as
    // unreachable on the first run of this — a validator that fails everything
    // is worth less than no validator, because it trains you to ignore it.
    const hit = matchSale(index, String(doc.year), s);
    const hitId = hit && (typeof hit === 'string' ? hit : hit.id);
    if (hitId === me) { reachable++; ok(`a sale spelled "${doc.year} ${s}" joins to this product`); }
    else if (hitId && mustBeMine(s)) {
      err(`join "${s}"`, `this product's own name resolves to ${hitId} — every sale would be filed under it`);
    } else if (hitId) {
      ok(`"${doc.year} ${s}" goes to ${hitId} — expected when a family shares a brand word`);
    } else {
      warn(`join "${s}"`, 'no product matches this spelling');
    }
  }
  if (!reachable) {
    err('join', 'NO spelling of this product reaches it. Sales will never join, '
      + 'however complete the file is. Check "name" and "brand" against how a listing writes it.');
  }

  // Does adding this file take an EXISTING product off the join?
  //
  // The worst thing a new checklist can do, and it is completely silent. Two
  // products whose names reduce to the same key make that key ambiguous, and
  // buildIndex drops ambiguous keys rather than guess — so BOTH products become
  // unreachable. Measured: adding a second "2017 Panini Prizm Football" takes
  // 2017 "Prizm" from the real product to null, and every 2017 Prizm sale on
  // the site stops joining to anything.
  //
  // Nothing throws. The new product looks broken; the old one looks fine right
  // up until you check it.
  const others = products.filter(p => p.id !== me);
  const { index: without } = buildIndex(others);
  const spellingOf = (p) => String(p.name || '').replace(/^\d{4}(-\d{2})?\s*/, '');
  const idOf = (h) => (h && (typeof h === 'string' ? h : h.id)) || null;
  const broke = [];
  for (const p of others) {
    const s = spellingOf(p);
    if (!s) continue;
    const before = idOf(matchSale(without, String(p.year), s));
    if (before !== p.id) continue;                       // was not reachable anyway
    const after = idOf(matchSale(index, String(p.year), s));
    if (after !== p.id) broke.push(p.id);
  }
  if (broke.length) {
    err('collision', `adding this file makes ${broke.length} EXISTING product(s) unreachable: `
      + `${broke.slice(0, 4).join(', ')}${broke.length > 4 ? ` and ${broke.length - 4} more` : ''}. `
      + `Their names reduce to the same key as this one, so the key becomes ambiguous and every `
      + `sale that used to join to them stops. Rename this product.`);
  } else {
    ok('no existing product loses its join because of this file');
  }
}

// What the engine will actually do with one real listing title.
function explainTitle(title) {
  const piPath = path.join(ROOT, 'public', 'data', 'parallel-index.json');
  if (!fs.existsSync(piPath)) {
    warn('--title', 'public/data/parallel-index.json is missing — run `npm run build:card-index`');
    return;
  }
  const { createParallelIndex } = require(path.join(ROOT, 'parallel-index-core.js'));
  const { cardKind, printRun } = require(path.join(ROOT, 'card-kind.js'));
  const { stripGrade, gradeBucket } = require(path.join(ROOT, 'grade-core.js'));
  const pi = createParallelIndex(JSON.parse(fs.readFileSync(piPath, 'utf8')), () => null);

  const clean = stripGrade(title);
  const hit = pi.resolveParallel(clean, {});
  console.log('\n  This title reads as:');
  console.log(`    parallel    ${hit.parallel ? `"${hit.parallel}" (${hit.how})` : `— (${hit.how})`}`);
  console.log(`    kind        ${cardKind(clean) || 'base'}`);
  console.log(`    print run   ${printRun(clean) == null ? '—' : printRun(clean)}`);
  console.log(`    grade       ${gradeBucket({ title })}`);
  if (!hit.parallel && hit.how === 'no-number') {
    console.log('\n    The reader works on the segment AFTER the card number and this title'
      + '\n    has none, so it fell back to a vocabulary scan at search time.');
  }
  if (!hit.parallel && hit.how === 'unmatched') {
    console.log('\n    The parallel is named but not in the catalogue. If this spelling is'
      + '\n    what sellers use, add it to that parallel\'s "aliases" — that is exactly'
      + '\n    what aliases are for (Panini writes "Prizm"; eBay writes "Silver").');
  }
  console.log('\n  Note: parallel-index.json is a BUILD ARTIFACT. A parallel you just added'
    + '\n  to a checklist is invisible here until `npm run build:card-index` runs.');
}

function run(file) {
  const full = path.isAbsolute(file) ? file
    : fs.existsSync(file) ? path.resolve(file)
    : path.join(DIR, file);
  console.log(`\n${path.relative(ROOT, full)}`);
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(full, 'utf8'));
  } catch (e) {
    err('file', `could not be read as JSON — ${e.message}`);
    return;
  }
  validateStructure(doc, full);
  validateJoin(doc, full);
  const cards = (doc.sets || []).reduce((n, s) => n + ((s.cards || []).length), 0);
  ok(`${(doc.sets || []).length} sets, ${cards.toLocaleString()} cards`);
}

if (has('--all')) {
  for (const f of fs.readdirSync(DIR).sort()) {
    if (f.endsWith('.json') && f !== 'index.json') run(path.join(DIR, f));
  }
} else if (files.length) {
  for (const f of files) run(f);
} else {
  console.log('Usage: node scripts/validate-checklist.js <file.json> [--title "listing title"]');
  console.log('       node scripts/validate-checklist.js --all');
  process.exit(2);
}

const title = valueOf('--title');
if (title) explainTitle(title);

console.log(`\n${errors} error(s), ${warnings} warning(s)`);
if (errors === 0 && warnings === 0) console.log('Clean — add it and run `npm run build:card-index`.');
process.exit(errors ? 1 : 0);
