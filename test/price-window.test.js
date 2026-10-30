// The price blocks look back 120 days for a page the last 45 cannot price
// (owner, Oct 2026), and such a page prints its own dates. Run through the
// real build and its real SQL over an in-memory SQLite table.
'use strict';
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

let failures = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`); if (!ok) failures++; };

const db = new DatabaseSync(':memory:');
db.exec(`CREATE TABLE sales (item_id TEXT, sold_date TEXT, title TEXT, price_cents INTEGER, currency TEXT,
  listing_format TEXT, grader TEXT, grade TEXT, player TEXT, parallel TEXT, year TEXT, set_name TEXT,
  card_number TEXT, confidence REAL, best_offer INTEGER, bids INTEGER)`);
const DAY = 86400000;
const iso = (d) => new Date(Date.now() + d * DAY).toISOString().slice(0, 10);
const ins = db.prepare(`INSERT INTO sales (item_id, sold_date, title, price_cents, player, year, set_name, card_number, confidence)
  VALUES (?,?,?,?,?,?,?,?,0.9)`);
let n = 0;
// Bo Nix: 26 sales over 13 cards, every one 60 to 110 days ago.
for (let c = 1; c <= 13; c++) for (const d of [-60 - c, -95 - c]) ins.run(`b${n++}`, iso(d), `2024 Prizm Bo Nix #${c}`, 2000 + c * 100, 'Bo Nix', '2024', 'Panini Prizm', String(c));
// Jayden Daniels: 26 sales over 13 cards in the last month.
for (let c = 1; c <= 13; c++) for (const d of [-3 - c, -10 - c]) ins.run(`j${n++}`, iso(d), `2024 Prizm Jayden Daniels #${c}`, 3000 + c * 100, 'Jayden Daniels', '2024', 'Panini Prizm', String(100 + c));
// Caleb Williams: repeated prices, the case the folded query counts rather
// than lists. #1 sells 100, 100, 100, 300, 900 (median 100, the 3rd);
// #2 sells 100, 300, 300, 900 (median 300, the 2nd); the rest twice at 1000.
const cw = { 1: [100, 100, 100, 300, 900], 2: [900, 300, 100, 300] };
for (let c = 1; c <= 13; c++) for (const [i, pr] of (cw[c] || [1000, 1000]).entries()) ins.run(`c${n++}`, iso(-2 - i), `2024 Prizm Caleb Williams #${c}`, pr, 'Caleb Williams', '2024', 'Panini Prizm', String(200 + c));
// Brock Purdy: too few sales in either window.
for (let c = 1; c <= 4; c++) ins.run(`p${n++}`, iso(-20 - c), `2022 Prizm Brock Purdy #${c}`, 5000, 'Brock Purdy', '2022', 'Panini Prizm', String(c));

const d1 = {
  prepare(sql) {
    let b = [];
    const api = {
      bind(...a) { b = a; return api; },
      all() { return { results: db.prepare(sql).all(...b) }; },
      first() { return db.prepare(sql).get(...b) || null; },
      run() { return { success: true, meta: db.prepare(sql).run(...b) }; },
    };
    return api;
  },
  batch(s) { return s.map(x => x.run()); },
};
const dbMod = require(path.join(__dirname, '..', 'db.js'));
dbMod.getNflDb = () => d1;
// KV stubbed: without it cachePut is a no-op and the build's output is lost.
const store = new Map();
dbMod.cacheGet = async (k) => (store.has(k) ? store.get(k) : null);
dbMod.cachePut = async (k, v) => { store.set(k, v); };
process.env.CF_WORKER = '1';
const S = require(path.join(__dirname, '..', 'server.js'));
const core = require(path.join(__dirname, '..', 'price-block-core.js'));

(async () => {
  const r = await S.buildPriceBlocks();
  const blocks = await S.cacheGet(S.PRICE_BLOCKS_KEY);
  const nix = blocks && blocks.pages['player:bo-nix'];
  const jd = blocks && blocks.pages['player:jayden-daniels'];
  check('the build runs and says how many pages the longer window added', r && r.ok && r.widened >= 1, JSON.stringify(r));
  check('a player with only 60-110-day-old sales is priced from the 120-day window, with its own dates',
    nix && nix.sales === 26 && nix.cards === 13 && nix.from && nix.from <= iso(-100) && nix.to === blocks.to, JSON.stringify(nix && { sales: nix.sales, from: nix.from, to: nix.to }));
  check('  ...while a player who clears the bar in 45 days keeps the 45-day numbers and the site-wide dates',
    jd && jd.sales === 26 && !jd.from, JSON.stringify(jd && { sales: jd.sales, from: jd.from }));
  const cwp = blocks && blocks.pages['player:caleb-williams'];
  const med = (no) => { const c = cwp && cwp.top && cwp.top.concat(cwp.rest || []).find(x => / #20[12]$/.test(x.label) && x.label.endsWith('#' + no)); return c && [c.sales, c.median]; };
  check('each card is priced at its middle sale, repeated prices counted one by one',
    cwp && cwp.sales === 31 && JSON.stringify(med(201)) === '[5,100]' && JSON.stringify(med(202)) === '[4,300]', JSON.stringify(cwp && { sales: cwp.sales, a: med(201), b: med(202), keys: Object.keys(cwp) }));
  check('  ...and a page short in both windows still prints nothing', blocks && !blocks.pages['player:brock-purdy']);
  check('  ...and the window the page prints is its own', blocks && blocks.from > nix.from
    && core.render(nix, { noun: nix.noun, from: nix.from || blocks.from, to: nix.to || blocks.to }).includes(`${nix.from} to ${nix.to}`));
  const html = core.render(jd, { noun: 'Jayden Daniels', from: blocks.from, to: blocks.to });
  check('each card in the price table opens its sold prices in the live search',
    /<td><a href="\/\?prefill=Jayden%20Daniels%202024%20/.test(html) && core.cardSearchHref('this set', 'Bo Nix #9') === '/?prefill=Bo%20Nix%20%239', html.slice(html.indexOf('<tbody>'), html.indexOf('<tbody>') + 220));
  {
    const appSrc = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'app.js'), 'utf8');
    check('a card link from a player, set or price list opens that card in For Sale, searched (owner, Oct 2026)',
      /prefill = \(p\.get\('prefill'\) \|\| ''\)/.test(appSrc) && /if \(prefill\) _setMode\('forsale'\);/.test(appSrc) && /fetchDirectSearch\(term\)/.test(appSrc));
  }
  const wk = require('fs').readFileSync(path.join(__dirname, '..', 'worker.js'), 'utf8');
  check('  ...and the Worker hands each page its own dates', /from: summary\.from \|\| this\.blocks\.from, to: summary\.to \|\| this\.blocks\.to/.test(wk));
  console.log(failures ? `\n${failures} check(s) failed` : '\nall price-window checks passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
