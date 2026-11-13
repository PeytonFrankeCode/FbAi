// One of One (owner, Nov 2026): where the prompts come from. Every prompt is a
// sports question the checklists can judge: a player is a valid answer when
// they have a matching card. This file reads the checklists into a bank of
// prompts, each with its valid players, and deals a pack of seven for every
// day. The rules of play are in game-core.js.
//
// Build time only (scripts/build-daily-game.js), and Node when no pack file is
// there: the Worker reads the day's finished pack and never runs this.
//
// THE RULE EVERY PROMPT KEEPS: a right answer is never refused. A prompt is
// only asked where the checklists are complete enough to know every player
// who fits, because being told "no" for a true answer, with the clock running,
// is the one thing that makes a game like this feel broken. That is why team
// prompts name the years they cover and thin years are left out (below).
'use strict';

const { norm } = require('./set-key');
const { PROMPTS_PER_DAY, fameShares, dayIndex, dateOfDay, isDate } = require('./game-core');

// Day 1. A pack's number is its date counted from here. To make launch day
// number 1, set this to the day the game goes live before merging.
const EPOCH = '2026-11-12';
const SPARES = 3;                 // stand-ins dealt with each pack, for the admin's swap
const RECENT_DAYS = 30;           // a prompt does not come back sooner than this
// No one player may be most of a pool: the prompt would have one answer.
const MAX_TOP_SHARE = 0.5;

const TEAMS = new Set([
  'Arizona Cardinals', 'Atlanta Falcons', 'Baltimore Ravens', 'Buffalo Bills', 'Carolina Panthers', 'Chicago Bears',
  'Cincinnati Bengals', 'Cleveland Browns', 'Dallas Cowboys', 'Denver Broncos', 'Detroit Lions', 'Green Bay Packers',
  'Houston Texans', 'Indianapolis Colts', 'Jacksonville Jaguars', 'Kansas City Chiefs', 'Las Vegas Raiders',
  'Los Angeles Chargers', 'Los Angeles Rams', 'Miami Dolphins', 'Minnesota Vikings', 'New England Patriots',
  'New Orleans Saints', 'New York Giants', 'New York Jets', 'Philadelphia Eagles', 'Pittsburgh Steelers',
  'San Francisco 49ers', 'Seattle Seahawks', 'Tampa Bay Buccaneers', 'Tennessee Titans', 'Washington Commanders',
  // Names a franchise used to play under: a 1970s card says Baltimore Colts.
  'Washington Redskins', 'Oakland Raiders', 'San Diego Chargers', 'St. Louis Rams', 'Houston Oilers',
  'Baltimore Colts', 'St. Louis Cardinals', 'Boston Patriots',
]);

// The checklists carry the team on the card for these years and not the ones
// between (measured Nov 2026: 89-100% of cards here, 0-25% elsewhere, none at
// all from 1981 to 2013). A team prompt names its years so it is honest about
// which cards count.
const TEAM_WINDOWS = [
  { id: '1950s', from: 1950, to: 1959, words: 'from the 1950s' },
  { id: '1960s', from: 1960, to: 1969, words: 'from the 1960s' },
  { id: '1970s', from: 1970, to: 1979, words: 'from the 1970s' },
  { id: '2014-16', from: 2014, to: 2016, words: 'from 2014 to 2016' },
  { id: '2022-on', from: 2022, to: 9999, words: 'from 2022 or later' },
];

// Insert sets collectors know by name, that came back year after year.
const INSERTS = [
  'Downtown', 'Color Blast', 'Kaboom', 'Gridiron Kings', 'MVP Contenders', 'Legendary Contenders',
  ['Rookie of the Year Contenders', 'ROY Contenders'], 'Stained Glass', 'Fireworks', 'Dominators',
  ['Rated Rookies', 'Rated Rookie'], 'Hall of Fame', 'Living Legends', 'Passing the Torch', 'Star Gazing',
  'Red Hot Rookies', 'Rookie Sensations', 'Instant Impact', 'Touchdown Club', '1000 Yard Club', 'Super Bowl Heroes',
  'Monday Night Heroes', 'Unsung Heroes', 'Legends of the Fall', 'Zoning Commission', 'Hot Rookies', 'Dream Team',
  'League Leaders', 'Award Winners', 'Inside the Numbers', 'Throwbacks', 'Stars of the NFL', 'Great American Heroes',
  'Numbers Game', 'Field Vision', 'Rookie Revolution', 'Playmakers', 'Record Breakers', 'MVPs', 'First Rounders',
  'All-Rookie Team', 'Pro Bowl', 'Captains', 'My House', 'No Huddle',
];
const insertKey = (s) => String(s || '').toLowerCase().replace(/!+$/, '').replace(/\s+/g, ' ').trim();
const INSERT_NAME = new Map();
for (const it of INSERTS) { const names = Array.isArray(it) ? it : [it]; for (const n of names) INSERT_NAME.set(insertKey(n), names[0]); }

const COUNT_STEPS = [500, 1000];
// College and draft-pick products picture players before the NFL, so "a card
// in 2019 National Treasures Collegiate" is a different question from the one
// it reads as. Leaf and Wild Card were NFL brands until about 2010 and draft
// brands after.
const notNfl = (c) => /collegiate|college|universit|draft|prospect|press pass|\bsage\b|\bnil\b|high school|\bonyx\b/i.test(c.name || '')
  || (c.year >= 2010 && /\bleaf\b|wild card/i.test(c.name || ''));
// "Numbered to 10 or fewer" is only asked of the products known for it.
const lowNumbered = (c) => /national treasures|flawless|immaculate|prizm|select|optic|contenders|chrome|finest|exquisite/i.test(c.name || '');
// Before 1980 is vintage: asked, but not every day (buildPacks).
const VINTAGE_BEFORE = 1980;

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const label = (name) => String(name || '').replace(/\s+Football$/i, '').trim();
// "an Arizona Cardinals player", "an MVP Contenders insert".
const an = (word) => (/^([aeiou]|mvp)/i.test(String(word)) ? 'an' : 'a');

// The bank: every prompt the checklists can carry.
//   checklists  the parsed files of public/data/checklists
//   players     public/data/players/index.json's players: only someone with a
//               page counts as an answer, which keeps out team cards, dual
//               cards and names spelled once
function buildBank({ checklists, players }) {
  const byName = new Map();
  for (const p of players || []) if (p && p.name && p.slug) byName.set(norm(p.name), p);
  const lists = (checklists || []).filter(c => c && c.id && Array.isArray(c.sets) && Number.isFinite(c.year));

  // A year the checklists barely cover cannot be asked about as a whole:
  // 2008 to 2011 have one to five products each, so most of those seasons'
  // players have no card here and would be refused.
  const perYear = new Map();
  for (const c of lists) if (!notNfl(c)) perYear.set(c.year, (perYear.get(c.year) || 0) + 1);
  const thin = (year) => year >= 1990 && (perYear.get(year) || 0) < 15;

  const pools = new Map();   // prompt id -> { ...prompt, set }
  // `meta` is a function so a prompt's words are put together once per pool,
  // not once per card.
  const pool = (id, meta) => { let e = pools.get(id); if (!e) { e = { id, ...meta(), set: new Set() }; pools.set(id, e); } return e.set; };

  for (const c of lists) {
    const name = label(c.name), year = c.year;
    const link = { href: `/sets/${c.id}/`, label: name };
    const nfl = !notNfl(c), low = nfl && lowNumbered(c), wholeYear = nfl && !thin(year), vintage = year < VINTAGE_BEFORE;
    const win = TEAM_WINDOWS.find(w => year >= w.from && year <= w.to) || null;
    for (const s of c.sets) {
      const ins = s && s.category === 'insert' ? INSERT_NAME.get(insertKey(s.name)) : null;
      const auto = !!s && s.category === 'autograph';
      for (const k of (s && s.cards) || []) {
        const p = byName.get(norm(k.player));
        if (!p) continue;
        if (nfl) {
          pool(`product:${c.id}`, () => ({ type: 'product', group: year >= 2012 ? 'product-modern' : 'product-classic', subject: c.id, link, vintage,
            text: `Name a player with a card in ${name}`, min: 40, max: 600 })).add(p);
        }
        if (wholeYear) {
          pool(`year:${year}`, () => ({ type: 'year', group: 'year', subject: `y${year}`, vintage,
            text: `Name a player with a card from ${year}`, min: 60, max: 900 })).add(p);
        }
        if (nfl && auto) {
          pool(`auto:${c.id}`, () => ({ type: 'auto', group: 'auto', subject: c.id, link, vintage,
            text: `Name a player with an autograph card in ${name}`, min: 40, max: 600 })).add(p);
          if (wholeYear) {
            pool(`autoyear:${year}`, () => ({ type: 'autoyear', group: 'autoyear', subject: `y${year}`, vintage,
              text: `Name a player with a certified autograph from ${year}`, min: 50, max: 700 })).add(p);
          }
        }
        if (low && k.printRun && k.printRun <= 10) {
          pool(`low:${c.id}`, () => ({ type: 'low', group: 'low', subject: c.id, link, vintage,
            text: `Name a player with a card numbered to 10 or fewer in ${name}`, min: 30, max: 600 })).add(p);
        }
        if (k.rookie && wholeYear) {
          pool(`rookie:${year}`, () => ({ type: 'rookie', group: 'rookie', subject: `y${year}`, vintage,
            text: `Name a player with a rookie card from ${year}`, min: 20, max: 600 })).add(p);
        }
        if (win && k.team && TEAMS.has(k.team)) {
          pool(`team:${slug(k.team)}:${win.id}`, () => ({ type: 'team', group: 'team', subject: k.team, vintage: win.to < VINTAGE_BEFORE,
            text: `Name ${an(k.team)} ${k.team} player with a card ${win.words}`, min: 25, max: 600 })).add(p);
        }
        if (ins) {
          pool(`insert:${slug(ins)}`, () => ({ type: 'insert', group: 'insert', subject: ins, vintage: false,
            text: `Name a player with ${an(ins)} ${ins} insert card`, min: 30, max: 600 })).add(p);
        }
      }
    }
  }
  for (const n of COUNT_STEPS) {
    const set = pool(`count:${n}`, () => ({ type: 'count', group: 'count', subject: `n${n}`, vintage: false,
      text: `Name a player with more than ${n.toLocaleString('en-US')} different cards`, min: 25, max: 600 }));
    for (const p of players || []) if (p && p.cards > n) set.add(p);
  }

  const bank = [];
  for (const e of pools.values()) {
    if (e.set.size < e.min || e.set.size > e.max) continue;
    // Most famous first: a tie in rarity goes to the earlier answer.
    const answers = [...e.set].sort((a, b) => b.cards - a.cards || (a.name < b.name ? -1 : 1)).map(p => [p.name, p.slug, p.cards]);
    const prompt = { id: e.id, type: e.type, group: e.group, subject: e.subject, vintage: !!e.vintage, text: e.text, link: e.link || null, answers };
    if (fameShares(prompt)[0] > MAX_TOP_SHARE) continue;
    bank.push(prompt);
  }
  return bank.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// The same hash everywhere, so a date deals the same pack on every machine.
function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

// What a day's seven slots hold. Where a slot lists more than one kind, the
// date picks between them.
const PLAN = [['product-modern'], ['team'], ['insert'], ['product-classic'], ['rookie', 'autoyear', 'year'], ['team', 'auto', 'low'], ['year', 'count', 'insert', 'team']];

// Packs for `days` days from `from`. Dealt day by day from the epoch, because
// a pack depends on what the days before it used.
function buildPacks(bank, { from, days = 1, epoch = EPOCH } = {}) {
  if (!isDate(from) || !isDate(epoch)) throw new Error('buildPacks needs dates as YYYY-MM-DD');
  const groups = new Map();
  for (const p of bank) { if (!groups.has(p.group)) groups.set(p.group, []); groups.get(p.group).push(p); }
  const first = dayIndex(epoch), start = Math.max(first, dayIndex(from)), last = dayIndex(from) + days - 1;
  const history = [], out = [];
  for (let d = first; d <= last; d++) {
    const date = dateOfDay(d);
    const recent = new Set(history.slice(-RECENT_DAYS).flat());
    const ids = new Set(), subjects = new Set();
    // One subject once a day: not two Vikings prompts, not a product and its
    // own autographs.
    const pick = (cands, seed, strict) => {
      let best = null, bestH = Infinity;
      for (const p of cands) {
        if (ids.has(p.id) || subjects.has(p.subject) || (strict && recent.has(p.id))) continue;
        const h = hash(`${seed}|${p.id}`);
        if (h < bestH) { bestH = h; best = p; }
      }
      if (best) { ids.add(best.id); subjects.add(best.subject); }
      return best;
    };
    const deal = (kinds, seed) => {
      // The date puts the slot's kinds in an order. A kind with nothing fresh
      // (there are only two card-count prompts) passes the slot to the next
      // kind before anything is repeated.
      const order = kinds.map(k => [hash(`${seed}|kind|${k}`), k]).sort((a, b) => a[0] - b[0]).map(x => x[1]);
      // Vintage (before 1980) one time in three: collectors like it, and a
      // pack of 1950s prompts would lose everyone else.
      const vintageToday = hash(`${seed}|vintage`) % 3 === 0;
      const pools = order.map(k => {
        const all = groups.get(k) || [], modern = all.filter(p => !p.vintage);
        return (vintageToday || !modern.length) ? all : modern;
      });
      for (const c of pools) { const p = pick(c, seed, true); if (p) return p; }
      for (const c of pools) { const p = pick(c, seed, false); if (p) return p; }
      return pick(bank, seed, true) || pick(bank, seed, false);
    };
    const prompts = PLAN.map((kinds, i) => deal(kinds, `${date}|${i}`)).filter(Boolean);
    // The kinds come in a different order each day.
    prompts.sort((a, b) => hash(`${date}|order|${a.id}`) - hash(`${date}|order|${b.id}`));
    const spares = [];
    for (let i = 0; i < SPARES; i++) { const s = deal([['product-modern', 'team', 'insert'][i % 3]], `${date}|spare|${i}`); if (s) spares.push(s); }
    history.push(prompts.map(p => p.id));
    if (d >= start && prompts.length === PROMPTS_PER_DAY) {
      const lean = ({ id, type, text, link, answers }) => ({ id, type, text, link, answers });
      out.push({ date, number: d - first + 1, prompts: prompts.map(lean), spares: spares.map(lean) });
    }
  }
  return out;
}

module.exports = { EPOCH, SPARES, RECENT_DAYS, TEAMS, TEAM_WINDOWS, INSERTS, PLAN, buildBank, buildPacks, hash, label };
