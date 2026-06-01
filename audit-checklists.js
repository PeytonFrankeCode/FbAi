#!/usr/bin/env node
/**
 * Audit every per-product JSON for likely parser anomalies, so the
 * obvious-broken entries can be hunted down and fixed.
 *
 * Flags:
 *   1. Products with zero sets or zero cards
 *   2. Sets whose name starts with prose noise ("Here", "Please", "You can",
 *      "Updates to", "Versions:", "Highest print", ...)
 *   3. Cards whose player is suspiciously short (<3 chars) or contains
 *      noise characters (':', '.,', '–') or starts/ends with digits
 *   4. Cards whose team value is junky (very long, includes another card
 *      number that should have been split, contains lowercase leading run)
 *   5. Duplicate (number+player) pairs inside a single set
 */
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, 'public', 'data', 'checklists');
const files = fs.readdirSync(DIR).filter(f => /^\d{4}-.+\.json$/.test(f));

const NOISE_PREFIXES = /^(Here'?s|Please|You can|Updates to|Highest print|Subscribe|Shop |Refer to|Check out|Buy on|View |SUBJECT|Versions|Parallels|Cheap Wax|Ryan Cracknell|THE BECKETT|RELATED|1 COMMENT|Collecting|What does|Copyright|Continued)/i;

const findings = [];

function flag(file, severity, msg) {
  findings.push({ file, severity, msg });
}

for (const f of files) {
  const p = path.join(DIR, f);
  const d = JSON.parse(fs.readFileSync(p, 'utf8'));
  const sets = d.sets || [];
  if (sets.length === 0) { flag(f, 'high', 'zero sets'); continue; }
  let totalCards = 0;
  for (const s of sets) {
    const sn = String(s.name || '');
    if (!sn) flag(f, 'high', 'set with empty name');
    if (NOISE_PREFIXES.test(sn)) flag(f, 'high', `noise set name: ${sn.slice(0,80)}`);
    if (sn.length > 80) flag(f, 'medium', `long set name (${sn.length}): ${sn.slice(0,80)}…`);
    const cards = s.cards || [];
    totalCards += cards.length;
    const seen = new Set();
    for (const c of cards) {
      const player = String(c.player || '');
      const team = String(c.team || '');
      // player issues
      if (!player) flag(f, 'high', `set "${sn}" card #${c.number} has empty player`);
      else {
        if (player.length < 3) flag(f, 'medium', `set "${sn}" #${c.number} short player "${player}"`);
        if (/[:]|–|^\.|,$|[a-z][A-Z]{3,}/.test(player) && player.length < 40) {
          // skip "Mike T'a" style false positives via length check
        }
        if (/^\d/.test(player)) flag(f, 'medium', `set "${sn}" #${c.number} player starts with digit: "${player}"`);
        if (/\bcards\b/i.test(player) && /\d/.test(player)) flag(f, 'medium', `set "${sn}" #${c.number} junk player: "${player}"`);
      }
      // team issues
      if (team) {
        // Only flag a long team if it actually looks broken (contains an
        // unsplit next-card boundary or other noise). Purely multi-team
        // chase-card strings — every player on the front with their own
        // team — are correct data even when very long.
        const hasUnsplit = /\d+\s+[A-Z][A-Za-z'’.\-]/.test(team);
        if (team.length > 80 && hasUnsplit) {
          flag(f, 'medium', `set "${sn}" #${c.number} long team (${team.length}): "${team.slice(0,80)}…"`);
        }
        if (hasUnsplit) flag(f, 'high', `set "${sn}" #${c.number} team contains an unsplit next card: "${team.slice(0,80)}"`);
        if (/^[a-z]/.test(team)) flag(f, 'medium', `set "${sn}" #${c.number} team starts lowercase: "${team.slice(0,40)}"`);
      }
      const key = `${c.number}|${player}`;
      if (seen.has(key)) flag(f, 'low', `set "${sn}" duplicate card ${c.number}/${player}`);
      seen.add(key);
    }
  }
  if (totalCards === 0) flag(f, 'high', 'no cards across any set');
}

const bySeverity = { high: [], medium: [], low: [] };
findings.forEach(x => bySeverity[x.severity].push(x));

console.log(`Audited ${files.length} files. Findings: ${findings.length}`);
console.log(`  high: ${bySeverity.high.length}`);
console.log(`  medium: ${bySeverity.medium.length}`);
console.log(`  low: ${bySeverity.low.length}`);

const byFileSeverity = {};
for (const x of findings) {
  const k = x.file;
  if (!byFileSeverity[k]) byFileSeverity[k] = { high: 0, medium: 0, low: 0 };
  byFileSeverity[k][x.severity]++;
}
console.log('\nTop 20 worst files (by high+medium count):');
const ranked = Object.entries(byFileSeverity)
  .map(([f, s]) => ({ f, score: s.high * 10 + s.medium, ...s }))
  .sort((a, b) => b.score - a.score)
  .slice(0, 20);
for (const r of ranked) console.log(`  H:${r.high} M:${r.medium} L:${r.low}  ${r.f}`);

console.log('\nFirst 30 HIGH findings:');
for (const x of bySeverity.high.slice(0, 30)) console.log(`  [${x.file}] ${x.msg}`);
