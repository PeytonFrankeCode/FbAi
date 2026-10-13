#!/usr/bin/env node
// Card-title typeahead data, from the checklists (owner, Oct 2026).
//
// The search box should finish whatever has been typed into the closest real
// card title: "elway 84" into "1984 Topps John Elway #63", "mahomes prizm
// silver" into "2017 Panini Prizm Patrick Mahomes II #269 Silver", including
// cards that have not sold lately. The checklists hold every card (2.2 million
// across three sports), which is far too much for a phone to load, so they
// are cut into shards by the first two letters of a player's surname. Typing
// "elway" fetches the "el" shard and nothing else.
//
// sets.json holds every product and set once (about 56,000 sets), and the
// shards refer to them by number. Parallel names, the bulk of a set's data,
// sit in p/<n>.json and are fetched only when a typed word might be one.
// Shards above SPLIT_BYTES are cut again by three letters; sets.json says which.
//
// Output is sorted and stable, so an unchanged checklist produces byte-for-
// byte the same files and the deploy uploads nothing new.
//
// Run: node scripts/build-card-suggest.js [outDir]
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIRS = [['checklists', 'football'], ['checklists-basketball', 'basketball'], ['checklists-baseball', 'baseball']];
const OUT = process.argv[2] || path.join(ROOT, 'public', 'data', 'suggest');
const SPLIT_BYTES = 400 * 1024;
// One letter a sport; basketball and baseball cannot both be "b".
const SPORT_CODE = { football: 'f', basketball: 'b', baseball: 's' };
const PAR_CHUNK = 2000;
const SUFFIX = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v']);

const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
// "C.J. Stroud" and "CJ Stroud" are one player: initials lose their dots
// before the name is split, and so do apostrophes ("Ja'Marr").
const nameTokens = (n) => fold(n).replace(/[.'’]/g, '').replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(t => t && !SUFFIX.has(t));
const SPORT_WORD = /\s+(football|basketball|baseball)$/i;
const productName = (d) => String(d.name || '').replace(/^\d{4}(?:-\d{2,4})?\s+/, '').replace(SPORT_WORD, '').trim();
// Category, one letter: base, insert, autograph, memorabilia.
const CAT = { base: 'b', insert: 'i', autograph: 'a', memorabilia: 'm' };
const isBase = (name) => /^base( set)?$/i.test(String(name || '').trim());

function collect() {
  const products = [];       // [year, name, sport]
  const sets = [];           // [productIdx, setName, category, parallels]
  const players = new Map(); // key -> { n, s, c: [[setIdx, number, flags, printRun]] }
  for (const [dir, sport] of DIRS) {
    const full = path.join(ROOT, 'public', 'data', dir);
    if (!fs.existsSync(full)) continue;
    for (const f of fs.readdirSync(full).filter(x => x.endsWith('.json')).sort()) {
      let d;
      try { d = JSON.parse(fs.readFileSync(path.join(full, f), 'utf8')); } catch { continue; }
      if (!d || !Array.isArray(d.sets)) continue;
      const year = Number(d.year) || Number(String(d.name).slice(0, 4)) || 0;
      const pi = products.push([year, productName(d), sport]) - 1;
      for (const s of d.sets) {
        if (!Array.isArray(s.cards) || !s.cards.length) continue;
        const par = (s.parallels || []).map(p => (typeof p === 'string' ? p : p && p.name) || '').filter(Boolean);
        const idx = sets.push([pi, isBase(s.name) ? '' : String(s.name || ''), CAT[s.category] || '', par]) - 1;
        for (const c of s.cards) {
          if (!c || !c.player) continue;
          // A multi-player card is filed under each player on it.
          for (const who of String(c.player).split(/\s*\/\s*/)) {
            // Some checklists mark a rookie with a trailing "*".
            const starred = /\s*\*+\s*$/.test(who);
            const name = who.replace(/\s*\*+\s*$/, '').trim();
            if (!name || !/[a-z]/i.test(name)) continue;
            const key = nameTokens(name).join(' ');
            if (!key) continue;
            let p = players.get(key + '|' + sport);
            if (!p) players.set(key + '|' + sport, p = { n: name, s: sport, c: [], spell: new Map() });
            // Shown as the spelling most of their cards use.
            p.spell.set(name, (p.spell.get(name) || 0) + 1);
            const row = [idx, String(c.number == null ? '' : c.number), c.rookie || starred ? 1 : 0];
            if (c.printRun) row.push(Number(c.printRun) || String(c.printRun));
            p.c.push(row);
          }
        }
      }
    }
  }
  return { products, sets, players };
}

// Players with this many cards are also filed under their first name, so
// "lebron" or "shohei" alone finds them; everyone else only under the surname,
// the word a search nearly always has.
const FIRST_NAME_CARDS = 30;
function shardKeys(name, len, cards = 0) {
  const t = nameTokens(name).filter(x => x.length >= 2 && /[a-z]/.test(x));
  if (!t.length) return [];
  const keys = [t[t.length - 1].slice(0, len)];
  if (cards >= FIRST_NAME_CARDS && t.length > 1) keys.push(t[0].slice(0, len));
  return [...new Set(keys)];
}

const spelling = (p) => [...p.spell].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0];
function writeShard(dir, key, entries) {
  const players = entries.sort((a, b) => a.k < b.k ? -1 : a.k > b.k ? 1 : 0)
    .map(({ p }) => ({ n: spelling(p), s: SPORT_CODE[p.s] || p.s, c: p.c }));
  const body = JSON.stringify({ v: 2, players });
  fs.writeFileSync(path.join(dir, key + '.json'), body);
  return body.length;
}

function main() {
  const { products, sets, players } = collect();
  const by2 = new Map();
  for (const [k, p] of players) for (const s of shardKeys(p.n, 2, p.c.length)) {
    if (!by2.has(s)) by2.set(s, []);
    by2.get(s).push({ k, p });
  }
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const split = [];
  let files = 0, bytes = 0, biggest = 0;
  for (const s2 of [...by2.keys()].sort()) {
    const entries = by2.get(s2);
    // Estimate before writing: a shard that would be too big is cut by 3 letters.
    const est = entries.reduce((a, e) => a + 24 + e.p.c.length * 14, 0);
    if (est > SPLIT_BYTES) {
      split.push(s2);
      const by3 = new Map();
      for (const e of entries) for (const s3 of shardKeys(e.p.n, 3, e.p.c.length).filter(x => x.startsWith(s2))) {
        if (!by3.has(s3)) by3.set(s3, []);
        by3.get(s3).push(e);
      }
      for (const s3 of [...by3.keys()].sort()) { const b = writeShard(OUT, s3, by3.get(s3)); files++; bytes += b; biggest = Math.max(biggest, b); }
    } else {
      const b = writeShard(OUT, s2, entries); files++; bytes += b; biggest = Math.max(biggest, b);
    }
  }
  // Parallels by global set number, PAR_CHUNK sets a file: fetched only when a
  // typed word might be a parallel ("silver", "holo"), for the sets in play.
  fs.mkdirSync(path.join(OUT, 'p'), { recursive: true });
  for (let i = 0; i < sets.length; i += PAR_CHUNK) {
    const body = JSON.stringify(sets.slice(i, i + PAR_CHUNK).map(x => x[3]));
    fs.writeFileSync(path.join(OUT, 'p', (i / PAR_CHUNK) + '.json'), body);
    files++; bytes += body.length;
  }
  // Every product and set once, loaded the first time the box is used: the
  // shards refer to sets by number.
  const dict = JSON.stringify({ v: 2, split, parChunk: PAR_CHUNK, products, sets: sets.map(([pi, n, c]) => [pi, n, c]) });
  fs.writeFileSync(path.join(OUT, 'sets.json'), dict);
  bytes += dict.length; files++;
  console.log(`card suggest: ${players.size.toLocaleString()} players, ${files} shards, ${(bytes / 1048576).toFixed(1)} MB, biggest ${(biggest / 1024).toFixed(0)} KB, ${split.length} split to 3 letters`);
}

main();
