#!/usr/bin/env node
// One of One: deal the daily packs (npm run build:game).
//
// Reads every football checklist and the players index, builds the bank of
// prompts (game-bank.js), and writes one file per day to public/data/game/:
// yesterday through the next 60 days, so a quiet stretch with no deploy still
// has packs. Run on every deploy, after build:pages (which writes the players
// index this reads). The files hold the valid answers, so the Worker refuses
// to serve them to browsers (worker.js) and reads them itself.
//
// Unlimited mode's practice rounds are dealt here too, into
// public/data/game/u/<number>.json.
//
//   node scripts/build-daily-game.js            write the files
//   node scripts/build-daily-game.js --stats    also print how the bank looks
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { buildBank, buildPacks, buildRounds, notAPlayer, EPOCH } = require(path.join(ROOT, 'game-bank.js'));
const { gameDate, dayIndex, dateOfDay, startingTiers, nameKey } = require(path.join(ROOT, 'game-core.js'));

const DAYS_AHEAD = 60;
const OUT = path.join(ROOT, 'public', 'data', 'game');

function loadChecklists(dir = path.join(ROOT, 'public', 'data', 'checklists')) {
  const out = [];
  for (const f of fs.readdirSync(dir).sort()) {
    if (!f.endsWith('.json') || f === 'index.json') continue;
    try { out.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))); } catch (_) { /* a broken file is the validator's to report */ }
  }
  return out;
}
const loadPlayers = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'data', 'players', 'index.json'), 'utf8')).players;

// Every player with a page, as the matcher reads a name. The server uses it
// to tell a wrong answer (a real player who does not fit the prompt) from a
// misspelling of a right one, which it corrects.
const nameKeys = (players) => [...new Set((players || []).filter(p => p && p.name && !notAPlayer(p.name)).map(p => nameKey(p.name)).filter(Boolean))].sort();

function build({ today = gameDate(), days = DAYS_AHEAD } = {}) {
  const bank = buildBank({ checklists: loadChecklists(), players: loadPlayers() });
  const from = dateOfDay(Math.max(dayIndex(EPOCH), dayIndex(today) - 1));
  const packs = buildPacks(bank, { from, days: days + 2 });
  return { bank, packs, rounds: buildRounds(bank) };
}

if (require.main === module) {
  const t0 = Date.now();
  const { bank, packs, rounds } = build();
  if (!packs.length) { console.error('build-daily-game: no packs dealt; is the bank empty?'); process.exit(1); }
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(path.join(OUT, 'u'), { recursive: true });
  let bytes = 0, roundBytes = 0;
  for (const p of packs) { const s = JSON.stringify(p); bytes += s.length; fs.writeFileSync(path.join(OUT, `${p.date}.json`), s); }
  for (const r of rounds) { const s = JSON.stringify(r); roundBytes += s.length; fs.writeFileSync(path.join(OUT, 'u', `${r.round}.json`), s); }
  const kinds = {};
  for (const p of bank) kinds[p.type] = (kinds[p.type] || 0) + 1;
  const names = nameKeys(loadPlayers());
  fs.writeFileSync(path.join(OUT, 'names.json'), JSON.stringify(names));
  fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify({ built: new Date().toISOString(), epoch: EPOCH, dates: packs.map(p => p.date), unlimited: rounds.length, bank: kinds }));
  console.log(`One of One: ${bank.length} prompts in the bank (${Object.entries(kinds).map(([k, n]) => `${k} ${n}`).join(', ')})`);
  console.log(`  ${packs.length} packs, ${packs[0].date} (#${packs[0].number}) to ${packs[packs.length - 1].date}, ${(bytes / 1024).toFixed(0)} KB`);
  console.log(`  ${rounds.length} unlimited rounds, ${(roundBytes / 1024).toFixed(0)} KB; ${names.length} player names; ${((Date.now() - t0) / 1000).toFixed(1)}s in all`);
  if (process.argv.includes('--stats')) {
    const sum = { base: 0, green: 0, blue: 0, gold: 0, one: 0 };
    let noBase = 0;
    for (const p of bank) { const t = startingTiers(p); if (!t.base) noBase++; for (const k of Object.keys(sum)) sum[k] += t[k] / p.answers.length; }
    console.log('  average share of a pool starting in each tier:', Object.entries(sum).map(([k, v]) => `${k} ${(100 * v / bank.length).toFixed(1)}%`).join(', '), `| prompts with no Base answer: ${noBase}`);
    const today = packs.find(p => p.date === gameDate()) || packs[0];
    console.log(`  ${today.date}:`);
    for (const p of today.prompts) console.log(`    ${p.text}  [${p.answers.length} valid; ${JSON.stringify(startingTiers(p))}]`);
  }
}

module.exports = { build, loadChecklists, loadPlayers, nameKeys };
