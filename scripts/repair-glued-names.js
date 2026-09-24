#!/usr/bin/env node
/**
 * Repair card rows whose "player" still carries text that belongs elsewhere.
 *
 * The 2022 source was a Word export with its line breaks gone, and its parser
 * left two shapes behind in about 1,500 rows (the .docx is no longer in the
 * repo, so the files are repaired in place rather than re-parsed):
 *
 *   1. Two cards in one row: "James Conner8 J.J. Watt" is #7 James Conner and
 *      #8 J.J. Watt. With a print run between them the digits are shared —
 *      "Amon-Ra St. Brown /7524 D'Andre Swift" — and are split so the second
 *      number lands between its neighbours in the set.
 *   2. A print run and team left on the name: "Kurt Warner /25 – St. Louis
 *      Rams". The team after the dash is the one printed on the card (a
 *      retired player's old club), so it replaces the franchise the team-split
 *      source filed him under; anything after the dash that is not a team is
 *      kept as the card's note.
 *
 * Only rows that match one of those shapes are touched, and a split that
 * cannot be placed in the set's number order is left alone and reported.
 *
 * Run: node scripts/repair-glued-names.js [--dry] [file-prefix]   (default 2022-)
 *
 * Other years have their own shapes (2025 glues the team on with a slash,
 * "Name/Team RC"), which these patterns only half-read — so they are not
 * touched unless asked for by prefix, and then only after a --dry look.
 */
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'public', 'data', 'checklists');
const DRY = process.argv.includes('--dry');
const PREFIX = process.argv.slice(2).find(a => !a.startsWith('--')) || '2022-';

const NICKNAMES = 'Cardinals|Falcons|Ravens|Bills|Panthers|Bears|Bengals|Browns|Cowboys|Broncos|Lions|Packers|Texans|Colts|Jaguars|Chiefs|Raiders|Chargers|Rams|Dolphins|Vikings|Patriots|Saints|Giants|Jets|Eagles|Steelers|49ers|Seahawks|Buccaneers|Titans|Commanders|Redskins|Oilers|Football Team';
const TEAM_RE = new RegExp(`^[A-Z][A-Za-z.' ]*\\b(${NICKNAMES})$`);

// "<name> /25 – <rest>", "<name> 1/1 – <rest>", "<name> /25 –", "<name> /25".
const TAIL_RE = /^(.*?[A-Za-z.’')])\s+(?:\d+)?\/(\d+)\s*(?:[–—-]\s*(.*))?$/;
// "<name><digits> <Name>" — the digits hold an optional print run and the
// next card's number.
const GLUE_RE = /^(.*?[a-z.’')])\s*(\/?)(\d+)\s+([A-Z].*)$/;

const num = (n) => parseInt(String(n).replace(/\D/g, ''), 10);
const norm = (p) => String(p || '').replace(/\s*\/.*$/, '').replace(/[’']/g, "'").trim().toLowerCase();

const TYPICAL_RUNS = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 20, 22, 23, 24, 25, 30, 35, 39,
  49, 50, 60, 75, 99, 100, 125, 149, 150, 175, 199, 249, 250, 275, 299, 349, 399, 499]);

// `ctx` is the set: the numbers already used and its size. Team-split sets
// list cards by team, not by number, so the neighbours say nothing about the
// order; a number the set does not already hold, within its size, with a
// print run that is a real one, does.
function splitGlued(card, nextNumber, ctx) {
  const m = GLUE_RE.exec(card.player);
  if (!m) return null;
  const [, first, slash, digits, rest] = m;
  const cur = num(card.number);
  // Every way to read the digits as <print run><card number>; without a
  // slash there is no print run and the digits are the number.
  const reads = slash
    ? [...Array(digits.length - 1).keys()].map(k => ({ run: +digits.slice(0, k + 1), n: +digits.slice(k + 1), lead: digits[k + 1] }))
    : [{ run: null, n: +digits, lead: digits[0] }];
  // A number the set already holds is fine when it holds it for this same
  // player: a traded player is listed under both teams in a team-split
  // source, and this glued copy is the second listing.
  const same = (n) => ctx.byNum.get(n) === norm(rest);
  const possible = reads.filter(r => r.lead !== '0' && r.n >= 1 && r.n <= ctx.max && r.n !== cur
    && (!ctx.used.has(r.n) || same(r.n)) && (r.run === null || TYPICAL_RUNS.has(r.run)));
  const between = possible.filter(r => r.n > cur && (!Number.isFinite(nextNumber) || r.n < nextNumber));
  const fits = between.length === 1 ? between : possible;
  if (fits.length !== 1) return null;
  const { run, n } = fits[0];
  ctx.used.add(n);
  // The row's print run was read off its end, so it is the LAST card's. A
  // run between the two ("/75" in "/7524") is the first card's own; without
  // one, the row's run is most likely the whole set's and both keep it.
  const a = { ...card, player: first.trim() };
  if (run) a.printRun = run;
  const b = { number: String(n), player: rest.trim() };
  if (card.printRun != null) b.printRun = card.printRun;
  if (same(n)) b.duplicate = true;
  if (card.team) b.team = card.team;
  return [a, b];
}

// "Snoop Conner – Rated Rookies": a label with no print run in front of it.
const LABEL_RE = /^(.*?[A-Za-z.’')])\s+[–—]\s+(.+)$/;

function stripTail(card) {
  const m = TAIL_RE.exec(card.player) || LABEL_RE.exec(card.player);
  if (!m) return false;
  const [name, run, rest] = m.length === 4 ? [m[1], m[2], m[3]] : [m[1], null, m[2]];
  card.player = name.trim();
  if (run && card.printRun == null) card.printRun = +run;
  const extra = (rest || '').trim().replace(/\s*[–—-]\s*$/, '');
  if (!extra) return true;
  // "Legends – Oakland Raiders": a label, then the team.
  const parts = extra.split(/\s*[–—]\s*/);
  const team = parts.find(p => TEAM_RE.test(p));
  if (team) card.team = team;
  const label = parts.filter(p => p !== team).join(' – ');
  if (label) card.note = card.note ? `${card.note}; ${label}` : label;
  return true;
}

let files = 0, split = 0, stripped = 0, dropped = 0, merged = 0;
const unplaced = [];
for (const f of fs.readdirSync(DIR).filter(f => /^\d{4}-.*\.json$/.test(f) && f.startsWith(PREFIX))) {
  const p = path.join(DIR, f);
  const raw = fs.readFileSync(p, 'utf8');
  const doc = JSON.parse(raw);
  let changed = false;
  for (const set of doc.sets || []) {
    const out = [];
    const queue = [...(set.cards || [])];
    const nums = queue.map(c => num(c.number)).filter(Number.isFinite);
    const byNum = new Map(queue.map(c => [num(c.number), norm(c.player)]));
    const ctx = { used: new Set(nums), byNum, max: Math.max(set.totalCards || 0, ...nums) };
    while (queue.length) {
      const card = queue.shift();
      const next = queue.find(c => Number.isFinite(num(c.number)));
      const parts = /\d/.test(card.player) ? splitGlued(card, next ? num(next.number) : NaN, ctx) : null;
      if (parts) {
        // The second half may itself be glued to a third.
        queue.unshift(parts[1]);
        card.player = parts[0].player;
        if (parts[0].printRun != null) card.printRun = parts[0].printRun;
        split++; changed = true;
      } else if (/\d/.test(card.player) && GLUE_RE.test(card.player) && !TAIL_RE.test(card.player)) {
        unplaced.push(`${f} ${set.name} #${card.number} ${card.player}`);
      }
      if (stripTail(card)) { stripped++; changed = true; }
      if (card.duplicate) { dropped++; continue; }
      out.push(card);
    }
    // A dual card sits under each player's team in a team-split source. With
    // the team gone from the name the two listings are the same row; keep one,
    // carrying both teams.
    const seen = new Map();
    set.cards = out.filter(c => {
      const k = `${c.number}|${norm(c.player)}`;
      const first = seen.get(k);
      if (!first) { seen.set(k, c); return true; }
      if (c.team && first.team && !first.team.split(' / ').includes(c.team)) first.team += ` / ${c.team}`;
      merged++; changed = true;
      return false;
    });
  }
  if (changed) {
    files++;
    if (!DRY) fs.writeFileSync(p, JSON.stringify(doc) + (raw.endsWith('\n') ? '\n' : ''));
  }
}
console.log(`${DRY ? '[dry] ' : ''}${files} files: ${split} glued rows split (${dropped} of them a traded player's second listing, dropped), ${stripped} print runs/teams moved off the name, ${merged} dual-card listings merged`);
if (unplaced.length) {
  console.log(`${unplaced.length} glued rows left alone (no single number fits between their neighbours):`);
  for (const u of unplaced.slice(0, 40)) console.log('  ' + u);
}
