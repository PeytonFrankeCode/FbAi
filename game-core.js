// One of One (owner, Nov 2026): the daily game. Seven prompts a day, the same
// for everyone, each asking for a player ("Name a Green Bay Packers player with
// a card from the 2010s"). Any player the checklists say fits is a valid
// answer, and the rarer the answer among that day's players, the more it
// scores: Base, Green, Blue, Gold, and a One of One for an answer nobody else
// has given yet.
//
// This file is the rules: reading a typed name, working out how rare an answer
// is, and one day's play (the clock, the tries, the counts). The prompts are
// made from the checklists in game-bank.js. Pure apart from the store handed
// to GameDay, so the tests run it as is; in the Worker that store is a Durable
// Object's storage (worker.js GameDay), on Node a Map.
'use strict';

const PROMPTS_PER_DAY = 7;
const SECONDS = 20;               // per prompt, on the server's clock
const GRACE_MS = 1500;            // slack for the trip to the server and back
const MAX_TRIES = 8;              // guesses per prompt: a wrong one costs time, and a script gets no more
// Rarity cannot come from real answers alone: the first player of the day
// would make every answer unique. So each prompt starts as if this many
// players had already answered, in proportion to fame, and real answers are
// added on top.
//
// 300, not the 50 first planned: at 50, one real answer outweighed a star's
// whole head start, so the second person to name the same backup lineman
// dropped from a One of One straight to Base. At 300 they get Gold or Blue,
// and it takes several people saying a name before it reads as common. Real
// answers still take over as the day's players pass a few hundred.
const PRIOR_PLAYERS = 300;
const FAME_POWER = 1.5;

// Line every valid answer up from most to least common and walk down the
// line: the answers making up the first half of all answers are Base, the next
// quarter Green, and so on. `upTo` is where each tier ends on that line.
//
// Tuned on the whole bank (2,354 prompts, Nov 2026): with these cut-offs and
// FAME_POWER, a pool starts on average 10% Base, 13% Green, 17% Blue, 32% Gold
// and 28% One of One. The first draft (fame squared, One of One the rarest 2%)
// started half of every pool as a One of One, which made 100 points routine.
const TIERS = [
  { id: 'base', name: 'Base', points: 10, upTo: 0.50 },
  { id: 'green', name: 'Green', points: 25, upTo: 0.75 },
  { id: 'blue', name: 'Blue', points: 50, upTo: 0.90 },
  { id: 'gold', name: 'Gold', points: 75, upTo: 0.99 },
  { id: 'one', name: 'One of One', points: 100, upTo: Infinity },
];
const TIER = Object.fromEntries(TIERS.map(t => [t.id, t]));
const MAX_SCORE = PROMPTS_PER_DAY * TIER.one.points;

// ---- The day ----
// A new pack opens at midnight Eastern. The date is read off the Eastern
// calendar, so daylight saving is the calendar's problem, not ours.
const _dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
function gameDate(now = Date.now()) {
  const p = Object.fromEntries(_dayFmt.formatToParts(new Date(now)).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
// Milliseconds until the next pack: the moment the Eastern date changes.
function msToNextDay(now = Date.now()) {
  const today = gameDate(now);
  let lo = now, hi = now + 26 * 3600000;
  while (hi - lo > 1000) { const mid = Math.floor((lo + hi) / 2); if (gameDate(mid) === today) lo = mid; else hi = mid; }
  return hi - now;
}
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const dayIndex = (date) => { const [y, m, d] = String(date).split('-').map(Number); return Math.round(Date.UTC(y, m - 1, d) / 86400000); };
const dateOfDay = (i) => new Date(i * 86400000).toISOString().slice(0, 10);

// ---- Reading a typed name ----
// Capitals, punctuation, accents and spacing never matter: "D.K. Metcalf",
// "dk metcalf" and "D K Metcalf" are one name, and so are "Amon-Ra St. Brown"
// and "amon ra st brown".
const SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v']);
function nameWords(s) {
  return String(s == null ? '' : s).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/['’‘`.]/g, '').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
}
// "Marvin Harrison Jr." without the "Jr.": a suffix is only dropped off the
// end, and never when it is all there is.
function dropSuffix(words) {
  const w = words.slice();
  while (w.length > 1 && SUFFIXES.has(w[w.length - 1])) w.pop();
  return w;
}

// How many single-letter slips (a wrong, missing, extra or swapped letter)
// separate two words; anything past `max` just reads as max + 1.
function editDistance(a, b, max = 2) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev2 = null, prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let low = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur[j] = v;
      if (v < low) low = v;
    }
    if (low > max) return max + 1;
    prev2 = prev; prev = cur;
  }
  return Math.min(prev[b.length], max + 1);
}

// A prompt's answers are [name, slug, cards]: the player's name, their page,
// and how many cards they have across the site (the fame measure).
const _index = new WeakMap();
function _indexOf(prompt) {
  let ix = _index.get(prompt);
  if (ix) return ix;
  const full = new Map(), bare = new Map(), sur = new Map(), keys = [];
  const add = (m, k, i) => { if (!k) return; const a = m.get(k); if (!a) m.set(k, [i]); else if (!a.includes(i)) a.push(i); };
  prompt.answers.forEach((a, i) => {
    const w = nameWords(a[0]), core = dropSuffix(w);
    add(full, w.join(''), i);
    add(bare, core.join(''), i);
    keys.push(core.join(''));
    // A surname alone counts when only one valid player has it. Two-word
    // surnames too: "St. Brown", "Smith-Schuster".
    if (core.length >= 2) add(sur, core[core.length - 1], i);
    if (core.length >= 3) add(sur, core.slice(-2).join(''), i);
  });
  ix = { full, bare, sur, keys };
  _index.set(prompt, ix);
  return ix;
}

// Which valid answer did they mean? { idx } or { reason }:
//   empty      nothing typed
//   ambiguous  more than one valid player fits what was typed
//   none       no valid player fits
function matchAnswer(prompt, text) {
  const w = nameWords(String(text == null ? '' : text).slice(0, 80));
  if (!w.length) return { reason: 'empty' };
  const ix = _indexOf(prompt);
  const core = dropSuffix(w), bareKey = core.join('');
  let hit = ix.full.get(w.join(''));
  if (hit && hit.length === 1) return { idx: hit[0] };
  hit = ix.bare.get(bareKey);
  if (hit) return hit.length === 1 ? { idx: hit[0] } : { reason: 'ambiguous' };
  hit = ix.sur.get(bareKey);
  if (hit) return hit.length === 1 ? { idx: hit[0], by: 'surname' } : { reason: 'ambiguous' };
  // A small typo, on full names only: one slip in a short name, two in a long
  // one. Never a guess between two players the same distance away.
  if (bareKey.length >= 5) {
    const max = bareKey.length >= 9 ? 2 : 1;
    let best = max + 1, at = -1, tie = false;
    for (let i = 0; i < ix.keys.length; i++) {
      const d = editDistance(bareKey, ix.keys[i], max);
      if (d > max) continue;
      if (d < best) { best = d; at = i; tie = false; }
      else if (d === best && ix.keys[i] !== ix.keys[at]) tie = true;
    }
    if (at >= 0) return tie ? { reason: 'ambiguous' } : { idx: at, by: 'typo' };
  }
  return { reason: 'none' };
}

// ---- How rare is an answer ----
// Fame is the player's card count raised to FAME_POWER, so stars count for
// more than their share of cards, the way real answers bunch up on famous
// names.
const _fame = new WeakMap();
function fameShares(prompt) {
  let f = _fame.get(prompt);
  if (f) return f;
  const raw = prompt.answers.map(a => Math.pow(Math.max(1, Number(a[2]) || 1), FAME_POWER));
  const sum = raw.reduce((x, y) => x + y, 0) || 1;
  f = raw.map(x => x / sum);
  _fame.set(prompt, f);
  return f;
}

// The tier of answer `idx`, given what real players have said so far:
// `counts` is { answer index: players who gave it }, `total` their sum.
// commonness = (300 x fame share + real players who said it) / (300 + real players)
function rarity(prompt, counts, total, idx) {
  const f = fameShares(prompt), denom = PRIOR_PLAYERS + total;
  const mass = (i) => (PRIOR_PLAYERS * f[i] + (counts[i] || 0)) / denom;
  const mine = mass(idx);
  // Everything more common than this answer comes before it on the line; a
  // tie goes to the more famous player, who is listed first.
  let before = 0;
  for (let i = 0; i < f.length; i++) {
    if (i === idx) continue;
    const m = mass(i);
    if (m > mine || (m === mine && i < idx)) before += m;
  }
  let tier = TIERS.find(t => before < t.upTo) || TIER.one;
  // A One of One is the only copy: if somebody already gave it today, Gold.
  if (tier.id === 'one' && (counts[idx] || 0) > 0) tier = TIER.gold;
  return { tier, before, share: mine };
}

// Where every valid answer of a prompt starts, before anyone has played.
function startingTiers(prompt) {
  const out = { base: 0, green: 0, blue: 0, gold: 0, one: 0 };
  for (let i = 0; i < prompt.answers.length; i++) out[rarity(prompt, {}, 0, i).tier.id]++;
  return out;
}

// ---- One day's play ----
const validPid = (pid) => /^(u:[a-z0-9_.@-]{1,64}|d:[a-z0-9-]{16,64})$/.test(String(pid || ''));
const _pubAnswer = (a) => (a ? { name: a.name, slug: a.slug, tier: a.tier, points: a.points, said: a.said, of: a.of } : null);

// The store is { get(key), put(key, value) }, both async. Keys:
//   meta        { date, number, count }
//   p:<slot>    the prompt, with its answers
//   t:<slot>    { n, c: { answer index: players } }: what the day's players said
//   u:<player>  one player's round
//   c           { plays, finished, sum }
class GameDay {
  constructor(store) {
    this.store = store;
    this._q = Promise.resolve();
    this._meta = null;
    this._prompts = [];
  }

  // One thing at a time: a count is read, changed and written back, and two
  // answers arriving together must not both read the old number.
  _lock(fn) {
    const run = this._q.then(() => fn());
    this._q = run.then(() => {}, () => {});
    return run;
  }

  async meta() {
    if (!this._meta) this._meta = (await this.store.get('meta')) || null;
    return this._meta;
  }
  async _prompt(slot) {
    if (!this._prompts[slot]) this._prompts[slot] = await this.store.get('p:' + slot);
    return this._prompts[slot];
  }
  async hasPack() { return !!(await this.meta()); }

  // The day's prompts, set once by whoever plays first and kept for the day,
  // so a deploy at noon cannot change a pack people are halfway through.
  setPack(pack) {
    return this._lock(async () => {
      if (await this.meta()) return false;
      const prompts = ((pack && pack.prompts) || []).slice(0, PROMPTS_PER_DAY)
        .filter(p => p && p.text && Array.isArray(p.answers) && p.answers.length);
      // A daily pack has its date; an unlimited round (below) has its number.
      const round = pack && Number.isInteger(pack.round) && pack.round >= 0 ? pack.round : null;
      if ((round === null && !isDate(pack && pack.date)) || prompts.length !== PROMPTS_PER_DAY) throw new Error('That is not a full pack.');
      for (let i = 0; i < prompts.length; i++) {
        const p = prompts[i];
        await this.store.put('p:' + i, { id: String(p.id || ''), type: String(p.type || ''), text: String(p.text), link: p.link || null, answers: p.answers });
      }
      this._meta = round === null ? { date: pack.date, number: Number(pack.number) || 1, count: prompts.length }
        : { mode: 'unlimited', round, date: null, number: round + 1, count: prompts.length };
      await this.store.put('meta', this._meta);
      return true;
    });
  }

  async _view(play, now) {
    const meta = await this.meta();
    const v = { mode: meta.mode || 'daily', date: meta.date, number: meta.number, count: meta.count, seconds: SECONDS, maxScore: meta.count * TIER.one.points,
      started: !!play, done: !!(play && play.done), slot: play ? play.slot : 0,
      score: play ? play.answers.reduce((s, a) => s + (a ? a.points : 0), 0) : 0,
      answers: play ? play.answers.map(_pubAnswer) : [], active: null };
    if (play && !play.done && play.startedAt) {
      const left = play.startedAt + SECONDS * 1000 - now;
      if (left > -GRACE_MS) {
        v.active = { slot: play.slot, text: (await this._prompt(play.slot)).text, msLeft: Math.max(0, left), triesLeft: MAX_TRIES - play.tries };
      }
    }
    return v;
  }

  // Where this player is today. Changes nothing.
  async state(pid, now = Date.now()) {
    if (!(await this.meta())) return null;
    return this._view(validPid(pid) ? await this.store.get('u:' + pid) : null, now);
  }

  async _bump(what, by = 1) {
    const c = (await this.store.get('c')) || { plays: 0, finished: 0, sum: 0 };
    c[what] = (c[what] || 0) + by;
    await this.store.put('c', c);
  }
  // Out of time, or out of tries: the slot stays empty and the round moves on.
  async _miss(play) {
    play.answers.push(null);
    await this._advance(play);
  }
  async _advance(play) {
    play.slot++; play.startedAt = 0; play.tries = 0;
    if (play.slot >= (await this.meta()).count) {
      play.done = true;
      play.score = play.answers.reduce((s, a) => s + (a ? a.points : 0), 0);
      if (!play.quiet) {
        await this._bump('finished');
        await this._bump('sum', play.score);
      }
    }
  }

  // Show the next prompt and start its clock. Asking again while the clock is
  // running gives the same prompt and what is left of the same clock, so a
  // refresh buys no time.
  //
  // A quiet round (opts.quiet, set when it starts) plays and scores like any
  // other but is left out of the day's counts: it is how a visitor the site
  // takes for a program can play without changing anyone else's rarity.
  //
  // Unlimited mode (owner, Nov 2026): practice rounds of seven, as many as a
  // player likes. A round is a pack like any day's, kept by number instead of
  // date, and everyone who has played that round shares its counts. Only
  // there can a finished round be played again (opts.again), and the replay
  // is quiet: one player going round and round must not make their own
  // answers look common. The daily pack stays one round a day.
  next(pid, now = Date.now(), opts = {}) {
    return this._lock(async () => {
      if (!validPid(pid)) return { error: 'player' };
      const meta = await this.meta();
      if (!meta) return { error: 'no-pack' };
      let play = await this.store.get('u:' + pid);
      if (play && play.done && opts && opts.again && meta.mode === 'unlimited') {
        play = { slot: 0, startedAt: 0, tries: 0, answers: [], done: false, at: now, quiet: true };
      }
      if (!play) {
        play = { slot: 0, startedAt: 0, tries: 0, answers: [], done: false, at: now, quiet: !!(opts && opts.quiet) };
        if (!play.quiet) await this._bump('plays');
      }
      if (!play.done && play.startedAt && now > play.startedAt + SECONDS * 1000 + GRACE_MS) await this._miss(play);
      if (!play.done && !play.startedAt) { play.startedAt = now; play.tries = 0; }
      await this.store.put('u:' + pid, play);
      return { view: await this._view(play, now) };
    });
  }

  // An answer to the prompt on the clock.
  //   { ok: true, answer }        it fits: its tier, points and how many said it
  //   { ok: false, reason }       it does not (empty, ambiguous, none): try again
  //   { timeout: true }           the clock or the tries ran out: the slot stays empty
  // Each comes with `view`, the round as it now stands.
  //
  // opts.final: this is the player's last word on the prompt (the page's clock
  // reached zero with this typed, or they chose to skip). It scores if it
  // fits; if not, the slot stays empty instead of another try.
  answer(pid, text, now = Date.now(), opts = {}) {
    return this._lock(async () => {
      if (!validPid(pid)) return { error: 'player' };
      if (!(await this.meta())) return { error: 'no-pack' };
      const play = await this.store.get('u:' + pid);
      if (!play || play.done || !play.startedAt) return { error: 'no-prompt', view: await this._view(play || null, now) };
      const slot = play.slot;
      const save = async (out) => { await this.store.put('u:' + pid, play); return { ...out, slot, view: await this._view(play, now) }; };
      if (now > play.startedAt + SECONDS * 1000 + GRACE_MS) { await this._miss(play); return save({ timeout: true, reason: 'clock' }); }
      const prompt = await this._prompt(slot);
      const m = matchAnswer(prompt, text);
      if (m.idx == null) {
        if (opts && opts.final) { await this._miss(play); return save({ timeout: true, reason: 'final' }); }
        if (m.reason !== 'empty') play.tries++;
        if (play.tries >= MAX_TRIES) { await this._miss(play); return save({ timeout: true, reason: 'tries' }); }
        return save({ ok: false, reason: m.reason });
      }
      const t = (await this.store.get('t:' + slot)) || { n: 0, c: {} };
      const r = rarity(prompt, t.c, t.n, m.idx);
      t.c[m.idx] = (t.c[m.idx] || 0) + 1;
      t.n++;
      if (!play.quiet) await this.store.put('t:' + slot, t);
      const a = prompt.answers[m.idx];
      const mine = { i: m.idx, name: a[0], slug: a[1], tier: r.tier.id, points: r.tier.points, said: t.c[m.idx], of: t.n };
      play.answers.push(mine);
      await this._advance(play);
      return save({ ok: true, answer: _pubAnswer(mine) });
    });
  }

  async _promptRecap(slot, topN) {
    const p = await this._prompt(slot), t = (await this.store.get('t:' + slot)) || { n: 0, c: {} };
    const said = Object.entries(t.c).map(([i, n]) => ({ name: p.answers[i][0], slug: p.answers[i][1], n }))
      .sort((x, y) => y.n - x.n || (x.name < y.name ? -1 : 1));
    return { id: p.id, type: p.type, text: p.text, link: p.link, pool: p.answers.length, n: t.n,
      top: said.slice(0, topN), rare: said.filter(x => x.n === 1).slice(0, 3) };
  }

  // What everyone said, once this player has finished: before that it would
  // hand them the answers.
  async results(pid, now = Date.now()) {
    const meta = await this.meta();
    if (!meta) return { error: 'no-pack' };
    const play = validPid(pid) ? await this.store.get('u:' + pid) : null;
    const view = await this._view(play, now);
    if (!play || !play.done) return { error: 'not-done', view };
    const prompts = [];
    for (let i = 0; i < meta.count; i++) prompts.push({ ...(await this._promptRecap(i, 3)), yours: _pubAnswer(play.answers[i]) });
    return { view, prompts };
  }

  // For the admin page: how the day is going.
  async summary() {
    const meta = await this.meta();
    if (!meta) return null;
    const c = (await this.store.get('c')) || { plays: 0, finished: 0, sum: 0 };
    const prompts = [];
    for (let i = 0; i < meta.count; i++) prompts.push(await this._promptRecap(i, 5));
    return { ...meta, plays: c.plays, finished: c.finished, average: c.finished ? Math.round(c.sum / c.finished) : 0, prompts };
  }
}

// One call into a day, by name: what the Worker's Durable Object answers, and
// what Node runs straight against memory. Each reply is { view } or the
// method's own result, or { error }.
async function runOp(day, m, now = Date.now()) {
  switch (m && m.op) {
    case 'has': return { has: await day.hasPack() };
    case 'pack': return { set: await day.setPack(m.pack) };
    case 'state': return { view: await day.state(m.pid, now) };
    case 'next': return day.next(m.pid, now, { quiet: !!m.quiet, again: !!m.again });
    case 'answer': return day.answer(m.pid, m.text, now, { final: !!m.final });
    case 'results': return day.results(m.pid, now);
    case 'summary': return { summary: await day.summary() };
    default: return { error: 'op' };
  }
}

// The admin's swaps: { slot: id of the prompt taken out }. A swap puts the
// next spare in that slot, and only while the slot still holds the prompt the
// admin saw: a rebuild may have dealt the day differently since.
function applySwaps(pack, swaps) {
  if (!pack || !swaps) return pack;
  const prompts = pack.prompts.slice(), spares = (pack.spares || []).slice();
  for (const [slot, outId] of Object.entries(swaps)) {
    const i = Number(slot);
    if (!prompts[i] || prompts[i].id !== outId || !spares.length) continue;
    prompts[i] = spares.shift();
  }
  return { ...pack, prompts, spares };
}

// A Map behind the store's two calls: Node, and the tests.
function memoryStore() {
  const m = new Map();
  return {
    get: async (k) => { const v = m.get(k); return v === undefined ? undefined : JSON.parse(v); },
    put: async (k, v) => { m.set(k, JSON.stringify(v)); },
    _map: m,
  };
}

// The share text: tiers only, never an answer, so it spoils nothing.
const SQUARES = { base: '⬜', green: '🟩', blue: '🟦', gold: '🟨', one: '⬛', miss: '✖️' };
function shareText(view, site = 'thecardhuddle.com/play') {
  const row = (view.answers || []).map(a => (a ? SQUARES[a.tier] : SQUARES.miss)).join('');
  return `One of One #${view.number}  ${view.score}/${view.maxScore}\n${row}\n${site}`;
}

// A streak is days played in a row; a missed day starts it again.
function nextStats(stats, date, score) {
  const s = stats && typeof stats === 'object' ? stats : {};
  if (s.last === date) return s;
  const streak = (isDate(s.last) && dayIndex(date) - dayIndex(s.last) === 1) ? (Number(s.streak) || 0) + 1 : 1;
  return { last: date, streak, bestStreak: Math.max(Number(s.bestStreak) || 0, streak), best: Math.max(Number(s.best) || 0, score),
    plays: (Number(s.plays) || 0) + 1, total: (Number(s.total) || 0) + score };
}
// The streak as it stands today: it survives until a whole day is missed.
function liveStreak(stats, today) {
  if (!stats || !isDate(stats.last)) return 0;
  return dayIndex(today) - dayIndex(stats.last) <= 1 ? Number(stats.streak) || 0 : 0;
}

module.exports = {
  PROMPTS_PER_DAY, SECONDS, GRACE_MS, MAX_TRIES, PRIOR_PLAYERS, FAME_POWER, TIERS, TIER, MAX_SCORE, SQUARES,
  gameDate, msToNextDay, isDate, dayIndex, dateOfDay,
  nameWords, dropSuffix, editDistance, matchAnswer, fameShares, rarity, startingTiers,
  validPid, GameDay, runOp, applySwaps, memoryStore, shareText, nextStats, liveStreak,
};
