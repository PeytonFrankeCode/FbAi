#!/usr/bin/env node
/**
 * Repair cards in already-generated per-product JSONs whose `team` field
 * actually contains an unsplit chain of follow-on cards. Root cause: the
 * upstream parsers' print-run-glued-to-next-card preprocess required 2+
 * digits for the print run, so single-digit runs ("/5") concatenated to
 * the next card number ("/53") were never split. Audit flagged ~150 of
 * these. We can repair in place by re-parsing the offending team string.
 *
 * For each card with team matching /(\/\d+\s+|,\s*)[A-Z][a-z]/ patterns,
 * reconstruct "{number} {player}, {team_text}" and re-run a careful
 * splitter that uses the relaxed 1-3 digit print-run preprocess. Replace
 * the broken card with the resulting cards, preserving set position.
 */
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, 'public', 'data', 'checklists');
const files = fs.readdirSync(DIR).filter(f => /^\d{4}-.+\.json$/.test(f));

// Same splitter logic as parse-2023, with the relaxed PR regex.
function splitNumberedCards(line) {
  let s = line;
  s = s.replace(/\/(\d{1,3}?)(\d+\s+[A-Z][a-z])/g, (_, pr, rest) => `/${pr} ${rest}`);
  s = s.replace(/(\d+)\/(\d+?)(\d+\s+[A-Z][a-z])/g, (_, n, d, rest) => `${n}/${d} ${rest}`);
  const starts = [];
  const re = /(\d+)\s+([A-Z][a-z])/g;
  let m;
  while ((m = re.exec(s)) !== null) {
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
    if (!cm) {
      // Totally Certified et al. use " - " between player and team instead
      // of a comma — try that as a fallback.
      cm = clean.match(/^(\d+)\s+(.+?)\s+-\s+(.+?)$/);
    }
    if (cm) {
      const card = { number: cm[1], player: cm[2].trim(), team: cm[3].trim() };
      if (printRun) card.printRun = printRun;
      out.push(card);
    }
  }
  return out;
}

// Embedded "{Team}YYYY X Football Checklist – Master Card List" — the
// next product's header got concatenated onto the last team string in
// the previous product, so we trim the trailing junk off the team.
const EMBEDDED_HEADER = /(20\d{2})\s+[A-Za-z][A-Za-z0-9 .'’&-]+?\s+Football\s+Checklist(?:\s*[–-].*)?$/;

let totalRepairs = 0;
let totalCardsAdded = 0;
let totalTeamsTrimmed = 0;
const fileChanges = [];

for (const f of files) {
  const p = path.join(DIR, f);
  const d = JSON.parse(fs.readFileSync(p, 'utf8'));
  let changed = false;
  let setsTouched = 0;
  let cardsAdded = 0;
  let teamsTrimmed = 0;
  for (const s of (d.sets || [])) {
    const cards = s.cards || [];
    const out = [];
    let setChanged = false;
    for (const c of cards) {
      let team = String(c.team || '');

      // Strip an embedded next-product header from the team field, e.g.
      // "Miami Dolphins2024 Topps Cosmic Chrome Football Checklist – Master
      //  Card List" → "Miami Dolphins".
      const headerMatch = team.match(EMBEDDED_HEADER);
      if (headerMatch) {
        team = team.slice(0, headerMatch.index).trim();
        c.team = team;
        teamsTrimmed++;
        setChanged = true;
      }

      // Pattern: team field contains an unsplit next card boundary
      // — "Team /Nm Player" or "Team, NextTeam /Nm Player".
      if (/(?:\/\d+\s+|,\s*)[A-Z][a-z]/.test(team) && /\d+\s+[A-Z][a-z]/.test(team)) {
        const printRunSuffix = (typeof c.printRun === 'number') ? ` /${c.printRun}` : '';
        const reconstructed = `${c.number} ${c.player}, ${team}${printRunSuffix}`;
        const split = splitNumberedCards(reconstructed);
        if (split.length > 1) {
          out.push(...split);
          cardsAdded += split.length - 1;
          setChanged = true;
          continue;
        }
      }
      out.push(c);
    }
    if (setChanged) {
      s.cards = out;
      s.totalCards = out.length;
      setsTouched++;
      changed = true;
    }
  }
  if (changed) {
    fs.writeFileSync(p, JSON.stringify(d));
    totalRepairs++;
    totalCardsAdded += cardsAdded;
    totalTeamsTrimmed += teamsTrimmed;
    fileChanges.push({ f, sets: setsTouched, added: cardsAdded, trimmed: teamsTrimmed });
  }
}

console.log(`Repaired ${totalRepairs} files, recovered ${totalCardsAdded} previously-merged cards, trimmed ${totalTeamsTrimmed} embedded-header teams.`);
console.log('\nPer-file:');
for (const fc of fileChanges.sort((a, b) => (b.added + b.trimmed) - (a.added + a.trimmed))) {
  console.log(`  +${String(fc.added).padStart(3)} cards / ${String(fc.trimmed).padStart(2)} team trims across ${fc.sets} sets — ${fc.f}`);
}
