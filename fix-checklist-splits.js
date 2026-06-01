#!/usr/bin/env node
/**
 * Comprehensive post-processor for already-generated per-product JSONs.
 *
 * Fixes:
 *   1. Cards whose `team` chains the next card ("Cowboys3 DK Metcalf...").
 *      The original parsers' splitter only recognized "<digit> <Cap><low>"
 *      boundaries, so player names starting with two capitals (DK, CJ,
 *      JT, JL, C.J.) or with a dot were never split. Relax the boundary
 *      regex to "<digit> <Cap>[A-Za-z'’.\-]" and rerun the splitter.
 *   2. Cards whose `team` or `player` has an embedded next-product header
 *      ("Miami Dolphins2024 Topps Cosmic Chrome Football Checklist ...").
 *      Trim the YYYY-product-header tail.
 *   3. Fake-card rows where the player field is a single generic section
 *      word (Autographs / Variations / Inserts / Stars / Memorabilia /
 *      Versions). These come from misparsed sub-section headers — drop
 *      them entirely.
 *   4. Bloated set names like "Superfractors – 1/1 (1:17,045 hobby, ...)".
 *      Truncate at the "(odds)" suffix so identical Superfractor parallel
 *      sets dedupe and read cleanly.
 *   5. Duplicate (number, player) rows within a single set. Merge the
 *      `team` values of every duplicate so the surviving card shows every
 *      team that contributed (multi-player chase cards naturally appear
 *      under each contributing team's page).
 *   6. Cards whose `player` starts with a digit (sub-section title that
 *      slipped past upstream).
 */
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, 'public', 'data', 'checklists');
const files = fs.readdirSync(DIR).filter(f => /^\d{4}-.+\.json$/.test(f));

// Embedded "{Team}YYYY X Football Checklist – Master Card List" trim target.
const EMBEDDED_HEADER = /(20\d{2})\s+[A-Za-z][A-Za-z0-9 .'’&-]+?\s+Football\s+Checklist(?:\s*[–-].*)?$/;

// Sub-section header words that get misparsed as player names when stuck
// to a four-digit "card number" (the year of the sub-product).
const FAKE_PLAYER_WORDS = new Set([
  'Autographs', 'Variations', 'Inserts', 'Stars', 'Memorabilia',
  'Versions', 'Materials', 'Signatures', 'Parallels', 'Patches',
  'Jerseys', 'Patch', 'Insert',
]);

// Relaxed: accept names that start with one OR two capitals, with an
// optional dot/apostrophe/dash after the first letter. Covers "DK Metcalf",
// "C.J. Stroud", "L'Jarius Sneed", "JaMarcus" — but not pure all-caps team
// abbreviations because those wouldn't be at a "<digit> " boundary in the
// source layout.
const CARD_BOUNDARY_RE = /(\d+)\s+([A-Z][A-Za-z'’.\-])/g;
const NAME_HEAD_RE = /^[A-Z][A-Za-z'’.\-]/;

function splitNumberedCards(line) {
  let s = line;
  // Non-greedy 1-3 digit print run lets "/5N" unstick the next card number.
  s = s.replace(/\/(\d{1,3}?)(\d+\s+[A-Z][A-Za-z'’.\-])/g, (_, pr, rest) => `/${pr} ${rest}`);
  s = s.replace(/(\d+)\/(\d+?)(\d+\s+[A-Z][A-Za-z'’.\-])/g, (_, n, d, rest) => `${n}/${d} ${rest}`);
  const starts = [];
  CARD_BOUNDARY_RE.lastIndex = 0;
  let m;
  while ((m = CARD_BOUNDARY_RE.exec(s)) !== null) {
    if (m.index > 0 && s[m.index - 1] === '/') continue;
    starts.push(m.index);
  }
  const out = [];
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i];
    const end = i + 1 < starts.length ? starts[i + 1] : s.length;
    const chunk = s.slice(start, end).trim();
    let printRun = null;
    let clean = chunk
      .replace(/\s+\/(\d+)\s*$/, (_, pr) => { printRun = parseInt(pr, 10); return ''; })
      .replace(/\s+(\d+)\/(\d+)\s*$/, (_, n, d) => { if (!printRun) printRun = parseInt(d, 10); return ''; })
      .replace(/\s*–\s*no base version\s*$/i, '')
      .replace(/\s*\(eBay\)\s*$/i, '')
      .replace(/\s+RC\s*$/i, '');
    let cm = clean.match(/^(\d+)\s+(.+?),\s*(.+?)$/);
    if (!cm) cm = clean.match(/^(\d+)\s+(.+?)\s+-\s+(.+?)$/);
    if (cm) {
      const card = { number: cm[1], player: cm[2].trim(), team: cm[3].trim() };
      if (printRun) card.printRun = printRun;
      out.push(card);
    } else {
      // Team-less fallback for collegiate / draft picks formats.
      const tm = clean.match(/^(\d+)\s+(.+?)\s*$/);
      if (tm && /[A-Z][A-Za-z'’.\-]/.test(tm[2])) {
        const card = { number: tm[1], player: tm[2].trim() };
        if (printRun) card.printRun = printRun;
        out.push(card);
      }
    }
  }
  return out;
}

function trimEmbeddedHeader(s) {
  if (!s) return s;
  const m = String(s).match(EMBEDDED_HEADER);
  if (!m) return s;
  return s.slice(0, m.index).trim();
}

function normalizeSetName(name) {
  if (!name) return name;
  // "Superfractors – 1/1 (1:17,045 hobby, ...)" → "Superfractors – 1/1"
  return String(name).replace(/(\s*–\s*1\/1)\s*\(.*\)\s*$/, '$1').trim();
}

let touched = 0;
let cardsAdded = 0;
let teamsTrimmed = 0;
let playersTrimmed = 0;
let fakeCardsDropped = 0;
let setNamesTruncated = 0;
let dupesMerged = 0;
const fileChanges = [];

for (const f of files) {
  const p = path.join(DIR, f);
  const d = JSON.parse(fs.readFileSync(p, 'utf8'));
  let changed = false;
  const stats = { setsTouched: 0, cardsAdded: 0, teamsTrimmed: 0, playersTrimmed: 0, dropped: 0, renamed: 0, deduped: 0 };

  for (const s of (d.sets || [])) {
    // (4) set name truncation
    const newName = normalizeSetName(s.name);
    if (newName !== s.name) {
      s.name = newName;
      stats.renamed++;
      changed = true;
    }

    const cards = s.cards || [];
    const reworked = [];
    let setChanged = false;
    for (const c of cards) {
      let team = String(c.team || '');
      let player = String(c.player || '');

      // (2) trim embedded next-product headers off both fields
      const newTeam = trimEmbeddedHeader(team);
      if (newTeam !== team) { team = newTeam; c.team = team; stats.teamsTrimmed++; setChanged = true; }
      const newPlayer = trimEmbeddedHeader(player);
      if (newPlayer !== player) { player = newPlayer; c.player = player; stats.playersTrimmed++; setChanged = true; }

      // (3) drop fake-card rows where player is a single section-header word
      if (FAKE_PLAYER_WORDS.has(player.trim())) {
        stats.dropped++;
        setChanged = true;
        continue;
      }

      // (6) drop cards whose player starts with a digit (junk header)
      if (/^\d/.test(player)) {
        stats.dropped++;
        setChanged = true;
        continue;
      }

      // (1) team field still chains the next card — re-split. Three trigger
      //     shapes: "/N Player" (print-run-glued), ", Player" (comma chain),
      //     and "Team{digit}Player" / "TeamRC{digit}Player" (no space between
      //     team and next card number). All three usually mean the team value
      //     has absorbed the next card's number+name pair.
      const triggers =
        /(?:\/\d+\s+|,\s*)[A-Z][A-Za-z'’.\-]/.test(team) ||
        /[A-Za-z]\d+\s+[A-Z][A-Za-z'’.\-]/.test(team);
      if (triggers && /\d+\s+[A-Z][A-Za-z'’.\-]/.test(team)) {
        // Insert a space between letter and glued digit so the splitter's
        // `(\d+)\s+([A-Z]...)` regex finds the boundary cleanly.
        const printRunSuffix = (typeof c.printRun === 'number') ? ` /${c.printRun}` : '';
        const spaced = team.replace(/([A-Za-z])(\d+\s+[A-Z][A-Za-z'’.\-])/g, '$1 $2');
        const reconstructed = `${c.number} ${player}, ${spaced}${printRunSuffix}`;
        const split = splitNumberedCards(reconstructed);
        if (split.length > 1) {
          reworked.push(...split);
          stats.cardsAdded += split.length - 1;
          setChanged = true;
          continue;
        }
      }
      reworked.push(c);
    }

    // (5) deduplicate by (number, player) — merge unique team values
    const byKey = new Map();
    const dedupedOut = [];
    for (const c of reworked) {
      const key = `${c.number}|${c.player}`;
      const existing = byKey.get(key);
      if (existing) {
        const existingTeams = new Set(String(existing.team || '').split(/\s*\/\s*|,\s*/).filter(Boolean));
        for (const t of String(c.team || '').split(/\s*\/\s*|,\s*/).filter(Boolean)) {
          existingTeams.add(t);
        }
        existing.team = [...existingTeams].join(' / ');
        // Carry over printRun if previously missing.
        if (existing.printRun == null && c.printRun != null) existing.printRun = c.printRun;
        stats.deduped++;
        setChanged = true;
      } else {
        byKey.set(key, c);
        dedupedOut.push(c);
      }
    }

    if (setChanged) {
      s.cards = dedupedOut;
      s.totalCards = dedupedOut.length;
      stats.setsTouched++;
      changed = true;
    }
  }

  if (changed) {
    fs.writeFileSync(p, JSON.stringify(d));
    touched++;
    cardsAdded += stats.cardsAdded;
    teamsTrimmed += stats.teamsTrimmed;
    playersTrimmed += stats.playersTrimmed;
    fakeCardsDropped += stats.dropped;
    setNamesTruncated += stats.renamed;
    dupesMerged += stats.deduped;
    fileChanges.push({ f, ...stats });
  }
}

console.log(`Touched ${touched} files.`);
console.log(`  +${cardsAdded} cards from re-splits`);
console.log(`  ${teamsTrimmed} team fields trimmed of embedded headers`);
console.log(`  ${playersTrimmed} player fields trimmed of embedded headers`);
console.log(`  ${fakeCardsDropped} fake-card rows dropped`);
console.log(`  ${setNamesTruncated} set names truncated`);
console.log(`  ${dupesMerged} duplicate cards merged`);

console.log('\nTop 15 touched files:');
for (const fc of fileChanges.sort((a, b) =>
    (b.cardsAdded + b.dropped + b.deduped + b.teamsTrimmed + b.playersTrimmed + b.renamed) -
    (a.cardsAdded + a.dropped + a.deduped + a.teamsTrimmed + a.playersTrimmed + a.renamed)).slice(0, 15)) {
  console.log(`  +${fc.cardsAdded} cards, -${fc.dropped} fakes, ~${fc.deduped} dupes, ${fc.teamsTrimmed}+${fc.playersTrimmed} trims, ${fc.renamed} renames — ${fc.f}`);
}
