// Checklist team labels are the team on the card (Oct 2026): 2026 Topps #4
// Kyler Murray in the Cardinals run read "Minnesota Vikings".
const path = require('path');
const { fixRunTeams } = require(path.join(__dirname, '..', 'checklist-teams.js'));
let failures = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`); if (!ok) failures++; };
const T = new Set(['Arizona Cardinals', 'Minnesota Vikings', 'Miami Dolphins', 'Denver Broncos', 'Atlanta Falcons']);
const run = (teams) => teams.map((t, i) => ({ number: String(i + 1), player: 'P' + i, team: t }));
const a = run(['Arizona Cardinals', 'Arizona Cardinals', 'Arizona Cardinals', 'Minnesota Vikings', 'Arizona Cardinals', 'Arizona Cardinals', 'Atlanta Falcons']);
fixRunTeams(a, T);
check('a lone card inside a team run takes the run\'s team', a[3].team === 'Arizona Cardinals');
const b = run(['Miami Dolphins', 'Miami Dolphins', 'Denver Broncos', 'Atlanta Falcons', 'Miami Dolphins', 'Miami Dolphins']);
fixRunTeams(b, T);
check('  ...two side by side are both caught', b[2].team === 'Miami Dolphins' && b[3].team === 'Miami Dolphins');
const c = run(['Arizona Cardinals', 'Arizona Cardinals', 'Arizona Cardinals', 'San Diego Chargers', 'Arizona Cardinals', 'Arizona Cardinals']);
fixRunTeams(c, T);
check('  ...a name outside the team list (an old city, a college) is left as it is', c[3].team === 'San Diego Chargers');
const k = require(path.join(__dirname, '..', 'public', 'data', 'checklists', '2026-topps-football.json')).sets.find(s => s.name === 'Base Set').cards;
const at = (n) => k.find(x => x.number === n).team;
check('2026 Topps: Kyler #4, DJ Moore #36, Tua #126, Sauce #161 carry the team on the card',
  at('4') === 'Arizona Cardinals' && at('36') === 'Chicago Bears' && at('126') === 'Miami Dolphins' && at('161') === 'New York Jets');
const allens = [];
const fs = require('fs');
const dir = path.join(__dirname, '..', 'public', 'data', 'checklists');
for (const f of fs.readdirSync(dir)) {
  const s = fs.readFileSync(path.join(dir, f), 'utf8');
  if (/"player":\s*"Josh Allen",\s*"team":\s*"Jacksonville Jaguars"/.test(s)) allens.push(f);
}
check('no Jaguars card is filed under Josh Allen (they are Josh Hines-Allen\'s)', allens.length === 0, allens.join(', '));
const builder = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'build-landing-pages.js'), 'utf8');
check('player pages lead with the rookie year and list every year; set pages list every subset',
  /a === minYear \? -1/.test(builder) && /class="lp-yearnav"/.test(builder) && /class="lp-subnav"/.test(builder));
check('a folded spelling ("CJ Stroud", "Ja’Kobi Lane") links to its player\'s page', /for \(const \{ from, into \} of merged\)[\s\S]{0,120}playerSlug\.set\(from, target\)/.test(builder));
console.log(failures ? `\n${failures} check(s) failed` : '\nall checklist-teams checks passed');
process.exit(failures ? 1 : 0);
