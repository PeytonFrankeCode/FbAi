// Checklists label some cards with the player's current team, not the team on
// the card (Oct 2026): 2026 Topps #4 Kyler Murray sits in the Cardinals run
// (#1-6) but read "Minnesota Vikings", so the Vikings guide listed it. A card
// whose four nearest neighbours are three of one team, on both sides of it, is
// that team's card (three, so two mislabels side by side, as with 2026 Topps
// #125 Waddle and #126 Tua in the Dolphins run, are both caught). Only names in `teams` are changed, so a legend's old city or a college
// (real labels) is left alone.
function fixRunTeams(cards, teams = null) {
  const list = (cards || []).filter(c => c && c.team);
  const fixed = [];
  const orig = list.map(c => c.team);
  for (let i = 2; i < list.length - 2; i++) {
    const c = list[i], near = [orig[i - 2], orig[i - 1], orig[i + 1], orig[i + 2]];
    const a = near.find(t => near.filter(x => x === t).length >= 3);
    if (!a || c.team === a || !(near.slice(0, 2).includes(a) && near.slice(2).includes(a))) continue;
    if (teams && !(teams.has(a) && teams.has(c.team))) continue;
    fixed.push({ number: c.number, player: c.player, from: c.team, to: a });
    c.team = a;
  }
  return fixed;
}
module.exports = { fixRunTeams };
