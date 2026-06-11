#!/usr/bin/env node
/**
 * Repair glued card numbers left behind by the old non-greedy splitter.
 *
 * The source globs pack "<prev card's print run><next card number>" into
 * one digit string ("...Jets /2510 Breece Hall, ... /25..."). The old
 * splitter took the minimal print run, so the leftover digits stuck to the
 * next card's number. Three artifact shapes, all repaired against the
 * set's own number sequence:
 *
 *   1. Year-prefixed numbers in retro/throwback sets: "19924" → 1992
 *      subsection, card 4. Strip the year.
 *   2. Leading-zero numbers: "07" after "/107" was split "/1"+"07" —
 *      move the zeros back onto the previous card's print run
 *      (1 → 10) and keep card 7.
 *   3. Oversized numbers: "510" after print run "2" — the "5" belongs to
 *      the previous card's run (2 → 25), the card is 10. Only applied
 *      when the result restores ascending order AND the rebuilt run is a
 *      typical print run.
 *
 * Also drops junk rows whose "player" is leftover page furniture
 * ("Donruss Football Team Set Checklists").
 *
 * Run: node scripts/fix-glued-numbers.js [--dry]
 */
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'public', 'data', 'checklists');
const DRY = process.argv.includes('--dry');

const TYPICAL_RUNS = new Set([
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 20, 22, 23, 24, 25, 30, 35, 39,
  49, 50, 60, 75, 99, 100, 125, 149, 150, 175, 199, 249, 250, 275, 299, 399, 499,
]);

const JUNK_PLAYER = /checklists?$|team set/i;

// Whole sets that are page furniture, not card sets.
const JUNK_SET = /^(previous article|next article)$|, team (set )?\.{0,3}\s*$|\bhockey\b|\bbasketball\b/i;

const totals = { yearStripped: 0, zerosMoved: 0, runsRebuilt: 0, junkDropped: 0, files: 0 };

const files = fs.readdirSync(DIR).filter(f => /^\d{4}-.+\.json$/.test(f));
for (const f of files) {
  const p = path.join(DIR, f);
  const d = JSON.parse(fs.readFileSync(p, 'utf8'));
  const stats = { yearStripped: 0, zerosMoved: 0, runsRebuilt: 0, junkDropped: 0 };

  const beforeSets = (d.sets || []).length;
  d.sets = (d.sets || []).filter(s => {
    if (JUNK_SET.test(String(s.name).trim())) { stats.junkDropped++; return false; }
    return true;
  });

  for (const s of d.sets) {
    const cards = s.cards || [];
    const out = [];
    let prev = null; // previous kept card
    for (const c of cards) {
      const num = String(c.number);

      if (JUNK_PLAYER.test(String(c.player || ''))) {
        stats.junkDropped++;
        continue;
      }

      if (/^\d+$/.test(num)) {
        // (1) year-glued retro numbers: 5+ digits starting with a year
        const ym = num.match(/^(19[5-9]\d|20[0-2]\d)(\d{1,3})$/);
        if (ym && ym[2][0] !== '0') {
          c.number = ym[2];
          stats.yearStripped++;
          out.push(c);
          prev = c;
          continue;
        }

        // (1b) exact-year number with a glued sub-header in the player
        // field: number "1992", player "Autographs20 T.J. Watt" — the row
        // is really card 20 of the 1992-design autographs subsection.
        if (/^(19[5-9]\d|20[0-2]\d)$/.test(num)) {
          const pm = String(c.player || '').match(/^(?:Autographs?|Inserts?|Variations?)(\d{1,3})\s+(.+)$/);
          if (pm) {
            c.number = pm[1];
            c.player = pm[2].trim();
            stats.yearStripped++;
            out.push(c);
            prev = c;
            continue;
          }
        }

        // (2) leading zeros are always artifacts: strip them, and when the
        // previous card has a print run the zeros are its missing digits
        // ("/107" mis-split as "/1" + "07" → run 10, card 7).
        const zm = num.match(/^(0+)([1-9]\d*)$/);
        if (zm) {
          const fixed = parseInt(zm[2], 10);
          if (prev && typeof prev.printRun === 'number') {
            const newRun = prev.printRun * Math.pow(10, zm[1].length);
            if (newRun <= 1000) prev.printRun = newRun;
          }
          c.number = String(fixed);
          stats.zerosMoved++;
          out.push(c);
          prev = c;
          continue;
        }

        // (3) oversized numbers: leading digits are the tail of the
        // previous card's print run
        const n = parseInt(num, 10);
        const prevNum = prev ? parseInt(String(prev.number), 10) : NaN;
        if (prev && !isNaN(prevNum) && n > Math.max(500, prevNum + 200) && num.length >= 2) {
          let best = null;
          for (let k = 1; k < num.length; k++) {
            const nn = num.slice(k);
            if (nn[0] === '0') continue;
            const v = parseInt(nn, 10);
            if (v <= prevNum || v > prevNum + 60) continue;
            const newRun = parseInt(`${prev.printRun ?? ''}${num.slice(0, k)}`, 10);
            if (!TYPICAL_RUNS.has(newRun)) continue;
            if (!best || v - prevNum < best.v - prevNum) best = { v, nn, newRun };
          }
          if (best) {
            prev.printRun = best.newRun;
            c.number = best.nn;
            stats.runsRebuilt++;
            out.push(c);
            prev = c;
            continue;
          }
        }
      }

      out.push(c);
      prev = c;
    }
    if (out.length !== cards.length) {
      s.cards = out;
      s.totalCards = out.length;
    }
  }

  const changedCount = stats.yearStripped + stats.zerosMoved + stats.runsRebuilt + stats.junkDropped;
  if (changedCount > 0) {
    totals.files++;
    totals.yearStripped += stats.yearStripped;
    totals.zerosMoved += stats.zerosMoved;
    totals.runsRebuilt += stats.runsRebuilt;
    totals.junkDropped += stats.junkDropped;
    console.log(`${f}: year:${stats.yearStripped} zeros:${stats.zerosMoved} runs:${stats.runsRebuilt} junk:${stats.junkDropped}`);
    if (!DRY) fs.writeFileSync(p, JSON.stringify(d));
  }
}

console.log(`\n${DRY ? '(dry) ' : ''}files: ${totals.files}, year-stripped: ${totals.yearStripped}, zero-moved: ${totals.zerosMoved}, runs-rebuilt: ${totals.runsRebuilt}, junk dropped: ${totals.junkDropped}`);
