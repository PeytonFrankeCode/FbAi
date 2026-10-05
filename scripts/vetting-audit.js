#!/usr/bin/env node
// The read-only audit from docs/vetting-plan.md: what would the re-sort do?
//
// Reads a LOCAL SQLite copy of the D1 `sales` table (scripts/d1-export.py
// makes one) rather than querying D1, because the audit reads every sale
// several times over and D1 bills by rows read. Nothing is written anywhere
// except the output file.
//
//   python3 scripts/d1-export.py --out /tmp/sales.sqlite
//   node scripts/vetting-audit.js /tmp/sales.sqlite /tmp/vetting-audit.json
//
// Answers the plan's four questions:
//   1. how many sales the re-sort moves, and where, with real examples
//   2. purgatory size per day
//   3. the daily volume a Huddle Verified tier would cover
//   4. which big card-price swings came from mis-filed sales
'use strict';

const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const { resortSale, productParallelsFrom } = require('../vetting-core');
const { gradeBucket } = require('../grade-core');
const pi = require('../parallel-index');
const PP = productParallelsFrom(require('../public/data/parallel-index.json'), pi.norm);

const [dbPath, outPath = 'vetting-audit.json'] = process.argv.slice(2);
if (!dbPath) { console.error('usage: vetting-audit.js <sales.sqlite> [out.json]'); process.exit(2); }
const db = new DatabaseSync(dbPath, { readOnly: true });

// A price this many times off its card's median (either way) is a hint to
// re-read the title. The plan: an outlier is never grounds to reject a sale.
const OUTLIER_X = 4;
const OUTLIER_MIN_GROUP = 5;
const EXAMPLES = 30;
const VERIFIED_GRADES = new Set(['Raw', 'PSA 9', 'PSA 10']);

const med = (xs) => {
  if (!xs.length) return null;
  const a = xs.slice().sort((x, y) => x - y), m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
// Deterministic "random": the examples must not change between runs of the
// same data, or the owner's review cannot be checked against a re-run.
const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
const sportOf = (r) => r.sport || 'football';
const isoWeek = (d) => {
  const t = new Date(d + 'T00:00:00Z'); const day = (t.getUTCDay() + 6) % 7;
  t.setUTCDate(t.getUTCDate() - day + 3);
  const y = t.getUTCFullYear(), jan4 = new Date(Date.UTC(y, 0, 4));
  return `${y}-W${String(1 + Math.round(((t - jan4) / 864e5 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7)).padStart(2, '0')}`;
};

// ---- pass 1: decide every sale -----------------------------------------
const t0 = Date.now();
const rows = db.prepare(`SELECT item_id, sold_date, title, price_cents, best_offer, player, year, brand,
  set_name, parallel, card_number, grader, grade, is_rookie, is_auto, is_relic, print_run, card_key,
  card_name, sport FROM sales WHERE price_cents IS NOT NULL`).all();
console.error(`${rows.length.toLocaleString()} priced sales loaded`);

const byDest = {};               // "dest|confidence" -> count
const centsByDest = {};          // "dest|confidence" -> price_cents
const byDestSport = {};          // dest -> sport -> count
const examples = {};             // dest -> candidate examples
const days = {};                 // date -> { total, low, outlier }
const decided = new Array(rows.length);
for (let i = 0; i < rows.length; i++) {
  const r = rows[i];
  const d = resortSale(r, pi, { productParallels: PP });
  decided[i] = d;
  const k = `${d.dest}|${d.confidence}`;
  byDest[k] = (byDest[k] || 0) + 1;
  centsByDest[k] = (centsByDest[k] || 0) + r.price_cents;
  (byDestSport[d.dest] = byDestSport[d.dest] || {})[sportOf(r)] = ((byDestSport[d.dest] || {})[sportOf(r)] || 0) + 1;
  const day = (days[r.sold_date] = days[r.sold_date] || { total: 0, low: 0, outlier: 0, unplaced: 0 });
  day.total++;
  // Unplaced is an import failure (no player or year), not a doubtful sale,
  // and is counted apart so it does not swamp the review queue.
  if (d.dest === 'unplaced') day.unplaced++;
  else if (d.dest !== 'keep' && d.confidence === 'low') day.low++;
  if (d.dest !== 'keep') {
    (examples[k] = examples[k] || []).push({ i, h: hash(r.item_id) });
  }
  if (i % 200000 === 0 && i) console.error(`  decided ${i.toLocaleString()} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
}
const exampleOf = (i) => {
  const r = rows[i], d = decided[i];
  return { item_id: r.item_id, sold: r.sold_date, price: r.price_cents / 100, title: r.title,
           filed_as: r.card_key || '(no card key)', card_name: r.card_name,
           reason: d.reason, to: d.to };
};
// Per category: the dearest ten (where a mistake costs most) and twenty
// spread across the rest by hash.
const exampleSets = {};
for (const [k, list] of Object.entries(examples)) {
  const dear = list.slice().sort((a, b) => rows[b.i].price_cents - rows[a.i].price_cents).slice(0, 10);
  const seen = new Set(dear.map(x => x.i));
  const spread = list.filter(x => !seen.has(x.i)).sort((a, b) => a.h - b.h).slice(0, EXAMPLES - dear.length);
  exampleSets[k] = [...dear, ...spread].map(x => exampleOf(x.i));
}

// ---- pass 2: price outliers among sales that stay -----------------------
// Grouped by card and grade, kept sales only: a moved sale has already left
// the group it was distorting.
const groups = new Map();
for (let i = 0; i < rows.length; i++) {
  const r = rows[i];
  if (decided[i].dest !== 'keep' || !r.card_key) continue;
  const g = `${r.card_key}|${gradeBucket(r)}`;
  let e = groups.get(g); if (!e) groups.set(g, (e = []));
  e.push(i);
}
const outliers = [];
for (const [g, idx] of groups) {
  if (idx.length < OUTLIER_MIN_GROUP) continue;
  const m = med(idx.map(i => rows[i].price_cents));
  if (!(m > 0)) continue;
  for (const i of idx) {
    const p = rows[i].price_cents;
    if (p > m * OUTLIER_X || p < m / OUTLIER_X) {
      outliers.push({ i, g, median: m });
      days[rows[i].sold_date].outlier++;
    }
  }
}
const outlierExamples = outliers.slice().sort((a, b) => hash(rows[a.i].item_id) - hash(rows[b.i].item_id))
  .slice(0, EXAMPLES).map(o => ({ ...exampleOf(o.i), group: o.g, group_median: o.median / 100,
                                 x: Math.round(rows[o.i].price_cents / o.median * 10) / 10 }));

// ---- 3: Huddle Verified coverage ----------------------------------------
// Top players by kept rookie sales; per player, their K most-traded rookie
// cards (card_key: base and parallels alike); sales of those cards in Raw,
// PSA 9 or PSA 10. That is the daily review load the tier would carry.
const rookieByPlayer = new Map();   // sport|player -> Map(card_key -> count)
for (let i = 0; i < rows.length; i++) {
  const r = rows[i];
  if (decided[i].dest !== 'keep' || !Number(r.is_rookie) || !r.card_key || !r.player) continue;
  const p = `${sportOf(r)}|${r.player}`;
  let m = rookieByPlayer.get(p); if (!m) rookieByPlayer.set(p, (m = new Map()));
  m.set(r.card_key, (m.get(r.card_key) || 0) + 1);
}
const playersRanked = [...rookieByPlayer.entries()]
  .map(([p, m]) => [p, [...m.values()].reduce((a, b) => a + b, 0), m])
  .sort((a, b) => b[1] - a[1]);
const nDays = Object.keys(days).length;
const verified = [];
for (const N of [100, 200]) {
  for (const K of [3, 5, 10]) {
    const cards = new Set();
    for (const [p, , m] of playersRanked.slice(0, N)) {
      const [sport] = p.split('|');
      for (const [ck] of [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, K)) cards.add(`${sport}|${ck}`);
    }
    let n = 0, cents = 0; const perDay = {};
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (decided[i].dest !== 'keep' || !r.card_key || !cards.has(`${sportOf(r)}|${r.card_key}`)) continue;
      if (!VERIFIED_GRADES.has(gradeBucket(r))) continue;
      n++; cents += r.price_cents; perDay[r.sold_date] = (perDay[r.sold_date] || 0) + 1;
    }
    const daily = Object.values(perDay);
    verified.push({ players: N, cards_per_player: K, cards: cards.size, sales: n,
                    per_day_avg: Math.round(n / nDays), per_day_max: Math.max(0, ...daily),
                    dollar_share_pct: 0 });
    verified[verified.length - 1]._cents = cents;
  }
}
const allCents = rows.reduce((a, r) => a + r.price_cents, 0);
for (const v of verified) { v.dollar_share_pct = Math.round(v._cents / allCents * 1000) / 10; delete v._cents; }
const topPlayers = playersRanked.slice(0, 25).map(([p, n]) => ({ player: p.replace('|', ' · '), rookie_sales: n }));

// ---- 4: swings that came from mis-filed sales ---------------------------
// Week-over-week median per card and grade, two ways: every sale as filed,
// and only the sales the re-sort keeps. A swing the filed view shows and the
// kept view does not was made by sales that belong somewhere else.
const weekly = new Map();   // card|grade -> week -> { all: [], kept: [], movedIdx: [] }
for (let i = 0; i < rows.length; i++) {
  const r = rows[i];
  if (!r.card_key) continue;
  const g = `${r.card_key}|${gradeBucket(r)}`, w = isoWeek(r.sold_date);
  let m = weekly.get(g); if (!m) weekly.set(g, (m = new Map()));
  let e = m.get(w); if (!e) m.set(w, (e = { all: [], kept: [], moved: [] }));
  e.all.push(r.price_cents);
  if (decided[i].dest === 'keep') e.kept.push(r.price_cents); else e.moved.push(i);
}
const swings = [];
for (const [g, m] of weekly) {
  const weeks = [...m.keys()].sort();
  for (let j = 1; j < weeks.length; j++) {
    const a = m.get(weeks[j - 1]), b = m.get(weeks[j]);
    if (a.all.length < 3 || b.all.length < 3) continue;
    const filed = med(b.all) / med(a.all) - 1;
    if (Math.abs(filed) < 0.5) continue;
    const kept = (a.kept.length >= 2 && b.kept.length >= 2) ? med(b.kept) / med(a.kept) - 1 : null;
    if (kept !== null && Math.abs(kept) >= 0.25) continue;
    if (!b.moved.length && !a.moved.length) continue;
    swings.push({ card: g, week: weeks[j], sales: a.all.length + b.all.length,
                  filed_move_pct: Math.round(filed * 100), kept_move_pct: kept === null ? null : Math.round(kept * 100),
                  culprits: [...a.moved, ...b.moved].sort((x, y) => rows[y].price_cents - rows[x].price_cents)
                    .slice(0, 4).map(exampleOf) });
  }
}
swings.sort((a, b) => Math.abs(b.filed_move_pct) * Math.log(b.sales) - Math.abs(a.filed_move_pct) * Math.log(a.sales));

// ---- report -------------------------------------------------------------
const total = rows.length;
const allCentsTotal = rows.reduce((a, r) => a + r.price_cents, 0);
const summary = Object.entries(byDest).map(([k, n]) => {
  const [dest, confidence] = k.split('|');
  return { dest, confidence, sales: n, pct: Math.round(n / total * 1000) / 10, per_day: Math.round(n / nDays),
           dollars: Math.round(centsByDest[k] / 100), dollar_pct: Math.round(centsByDest[k] / allCentsTotal * 1000) / 10 };
}).sort((a, b) => b.sales - a.sales);
const purgatoryDays = Object.entries(days).sort().map(([d, v]) => ({ date: d, sales: v.total, low: v.low,
  outliers: v.outlier, purgatory: v.low + v.outlier, unplaced: v.unplaced }));
const out = {
  generated: new Date().toISOString(), source: dbPath, sales: total, days: nDays,
  window: [purgatoryDays[0].date, purgatoryDays[purgatoryDays.length - 1].date],
  settings: { OUTLIER_X, OUTLIER_MIN_GROUP, EXAMPLES },
  moves: summary, moves_by_sport: byDestSport, examples: exampleSets,
  purgatory: { per_day_avg: Math.round(purgatoryDays.reduce((a, d) => a + d.purgatory, 0) / nDays),
               outliers_total: outliers.length, days: purgatoryDays, outlier_examples: outlierExamples },
  verified: { tiers: verified, top_players: topPlayers },
  swings: { total: swings.length, top: swings.slice(0, 40) },
};
fs.writeFileSync(outPath, JSON.stringify(out, null, 1));
console.error(`done in ${((Date.now() - t0) / 1000).toFixed(0)}s -> ${outPath}`);
for (const s of summary) console.log(`${s.dest.padEnd(22)} ${s.confidence.padEnd(5)} ${String(s.sales).padStart(8)}  ${String(s.pct).padStart(5)}%  ${s.per_day}/day  $${s.dollars.toLocaleString()} (${s.dollar_pct}% of $)`);
console.log(`purgatory/day avg ${out.purgatory.per_day_avg}; outliers ${outliers.length}; swings ${swings.length}`);
for (const v of verified) console.log(`verified top ${v.players} x ${v.cards_per_player}: ${v.cards} cards, ${v.per_day_avg}/day (max ${v.per_day_max}), ${v.dollar_share_pct}% of $`);
