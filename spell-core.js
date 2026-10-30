'use strict';
// "Did you mean" for searches (owner, Oct 2026): a misspelled word in a search
// ("Ladanilan Tomilson", "collegitae") is corrected to the nearest word the
// site knows, from player names, products, sets and parallels, the way eBay's
// "Including results for…" does. Pure functions, so the tests run them as is.

// Words every card search uses that no name list holds.
const HOBBY_WORDS = ['rookie', 'rookies', 'autograph', 'autographs', 'auto', 'autos', 'patch', 'patches', 'relic', 'relics',
  'jersey', 'jerseys', 'refractor', 'refractors', 'numbered', 'graded', 'card', 'cards', 'football', 'basketball', 'baseball',
  'hockey', 'insert', 'inserts', 'parallel', 'parallels', 'variation', 'variations', 'signed', 'signature', 'signatures',
  'prizm', 'select', 'optic', 'mosaic', 'chrome', 'topps', 'panini', 'bowman', 'donruss', 'upper', 'deck', 'flawless',
  'immaculate', 'national', 'treasures', 'contenders', 'phoenix', 'origins', 'spectra', 'certified', 'prestige', 'score',
  'absolute', 'chronicles', 'obsidian', 'collegiate', 'draft', 'picks', 'logoman', 'shield', 'booklet', 'silver', 'gold',
  'holo', 'shimmer', 'cracked', 'ice', 'sapphire', 'superfractor', 'downtown', 'kaboom', 'color', 'blast', 'case', 'hit',
  'mint', 'gem', 'raw', 'slab', 'slabbed', 'psa', 'bgs', 'sgc', 'cgc', 'beckett', 'pristine', 'lot', 'box', 'hobby',
  'retail', 'blaster', 'mega', 'cello', 'hanger', 'sealed', 'tremendous', 'platinum', 'emerald', 'ruby', 'purple', 'orange',
  'black', 'white', 'green', 'red', 'blue', 'pink', 'aqua', 'teal', 'bronze', 'copper', 'neon', 'tiedye', 'camo', 'wave',
  'scope', 'disco', 'hyper', 'mojo', 'pulsar', 'genesis', 'nebula', 'stained', 'glass', 'vinyl', 'shattered', 'snakeskin'];

const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
const words = (s) => norm(s).split(/[^a-z0-9]+/).filter(Boolean);

// The vocabulary: word -> weight (how common, for breaking ties).
function buildVocab({ players = [], sportPlayers = [], productNames = [], setNames = [], parallels = [] } = {}) {
  const v = new Map();
  const add = (w, n) => { if (w.length >= 2 && !/^\d+$/.test(w)) v.set(w, (v.get(w) || 0) + n); };
  for (const p of players) for (const w of words(p.name)) add(w, Math.max(1, Number(p.cards) || 1));
  for (const n of sportPlayers) for (const w of words(n)) add(w, 5);
  for (const n of productNames) for (const w of words(n)) add(w, 50);
  for (const n of setNames) for (const w of words(n)) add(w, 20);
  for (const n of parallels) for (const w of words(n)) add(w, 30);
  for (const w of HOBBY_WORDS) add(w, 10000);
  const byLen = new Map();
  for (const w of v.keys()) { const L = w.length; if (!byLen.has(L)) byLen.set(L, []); byLen.get(L).push(w); }
  return { weights: v, byLen };
}

// Edit distance with transpositions (Damerau, optimal string alignment),
// giving up once it passes max.
function distance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const m = a.length, n = b.length;
  let prev2 = null, prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let d = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d = Math.min(d, prev2[j - 2] + 1);
      cur.push(d);
      if (d < best) best = d;
    }
    if (best > max) return max + 1;
    prev2 = prev; prev = cur;
  }
  return prev[n];
}

// The query with each unknown word replaced by its nearest known word, when
// one is close enough. Short words, numbers and words the site knows are left.
function spellFix(query, vocab) {
  const parts = String(query || '').split(/(\s+)/);
  const fixes = [];
  const out = parts.map((tok) => {
    const w = norm(tok);
    if (!/^[a-z]{4,}$/.test(w) || vocab.weights.has(w)) return tok;
    const max = w.length >= 7 ? 2 : 1;
    let best = null, bestD = max + 1, bestW = -1;
    for (let L = w.length - max; L <= w.length + max; L++) {
      for (const c of vocab.byLen.get(L) || []) {
        const d = distance(w, c, Math.min(max, bestD));
        const cw = vocab.weights.get(c);
        if (d < bestD || (d === bestD && d <= max && cw > bestW)) { best = c; bestD = d; bestW = cw; }
      }
    }
    if (!best || bestD > max) return tok;
    fixes.push({ from: tok, to: best });
    return /^[A-Z]/.test(tok) ? best[0].toUpperCase() + best.slice(1) : best;
  });
  const corrected = out.join('');
  return { corrected, changed: fixes.length > 0, fixes };
}

module.exports = { buildVocab, spellFix, distance, HOBBY_WORDS };
