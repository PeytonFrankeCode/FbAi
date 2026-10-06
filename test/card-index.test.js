// Does the checklist dictionary actually clean up listing player names?
//
// Two things are being tested, and the second matters more than the first:
//
//   1. Messy spellings of a real player resolve to that player.
//   2. Strings that SHOULD NOT resolve don't. A name resolved to the wrong
//      player silently merges two markets and there is nothing downstream that
//      can notice; a name left unresolved just stays fragmented, which is the
//      status quo. So every ambiguous case here asserts a decline.
const { resolvePlayer, resolveMany, stats } = require('../card-index.js');

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

console.log(`dictionary: ${stats.canonicalPlayers.toLocaleString('en-US')} players, `
          + `${stats.uniqueSurnames.toLocaleString('en-US')} unique surnames, `
          + `${stats.noiseWords.toLocaleString('en-US')} noise words, `
          + `from ${stats.source.cards.toLocaleString('en-US')} catalogued cards\n`);

// A player who is certainly in the checklists, found rather than assumed, so
// this suite doesn't rot when the catalogue changes.
const { norm } = require('../card-index.js');
const SUBJECT = ['Justin Jefferson', 'Kyler Murray', 'Josh Allen', 'Patrick Mahomes']
  .find(p => resolvePlayer(p));
if (!SUBJECT) {
  console.error('FAIL  no known player resolved — the dictionary is empty or broken');
  process.exit(1);
}
const SUR = SUBJECT.split(' ').pop();

// The shapes eBay titles actually arrive in.
const shouldResolve = [
  [SUBJECT,                                  'plain'],
  [SUBJECT.toUpperCase(),                    'shouted'],
  [SUBJECT.toLowerCase(),                    'lowercase'],
  [`  ${SUBJECT}  `,                         'padded'],
  [`${SUBJECT} RC`,                          'rookie flag'],
  [`${SUBJECT} rookie card`,                 'spelled-out rookie'],
  [`2023 Panini Prizm ${SUBJECT}`,           'product prefix'],
  [`${SUBJECT} Prizm Silver`,                'parallel suffix'],
  [`${SUBJECT} #331`,                        'card number'],
  [`${SUBJECT} 331`,                         'bare number'],
  [`${SUBJECT} PSA 10`,                      'grade'],
  [`${SUBJECT} - Minnesota Vikings`,         'team'],
  [`${SUBJECT} auto /25`,                    'auto and print run'],
  [`MINT ${SUBJECT} SHARP CENTERED L@@K`,    'seller prose'],
];

let resolvedOk = 0;
for (const [raw, label] of shouldResolve) {
  const hit = resolvePlayer(raw);
  const ok = hit && hit.canonical === SUBJECT;
  if (ok) resolvedOk++;
  else console.log(`      MISS (${label}): "${raw}" -> ${hit ? hit.canonical : 'null'}`);
}
check(`messy spellings of one player collapse to one name`,
      resolvedOk === shouldResolve.length,
      `${resolvedOk}/${shouldResolve.length} variants resolved to "${SUBJECT}"`);

// The half that protects the data. Each of these would be a silent merge.
const shouldDecline = [
  ['',                          'empty'],
  ['   ',                       'whitespace'],
  ['Prizm Silver',              'parallel with no name'],
  ['2023 Panini Prizm',         'product with no name'],
  ['PSA 10 Gem Mint',           'grade with no name'],
  ['Lot of 25 football cards',  'a lot, not a card'],
  ['Zzzqqx Nobodyson',          'not a real player'],
];
const declined = shouldDecline.filter(([raw]) => {
  const h = resolvePlayer(raw);
  return !h || !h.confident;
});
check(`  ...and strings with no player in them are declined`,
      declined.length === shouldDecline.length,
      declined.length === shouldDecline.length
        ? `all ${shouldDecline.length} declined`
        : `ADMITTED: ${shouldDecline.filter(([r]) => {
            const h = resolvePlayer(r); return h && h.confident;
          }).map(([r]) => `"${r}" -> ${resolvePlayer(r).canonical}`).join(', ')}`);

// Generational suffixes are identity. Merging them merges two real markets, and
// this is the case the SQL-side normalisation was written to protect too.
{
  const jr = resolvePlayer('Marvin Harrison Jr');
  const sr = resolvePlayer('Marvin Harrison');
  const bare = resolvePlayer('Harrison');
  const distinct = !jr || !sr || jr.key !== sr.key;
  check('generational suffixes stay separate',
        distinct && (!bare || !bare.confident),
        `Jr -> ${jr ? jr.canonical : 'null'}, Sr -> ${sr ? sr.canonical : 'null'}, `
        + `bare surname -> ${!bare ? 'declined'
             : bare.confident ? bare.canonical + ' (WRONG: confident)' : 'declined'}`);
}

// A shared surname must never be arbitrated. 1,260 of them are shared.
{
  const bare = resolvePlayer(SUR);
  const ok = !bare || !bare.confident || bare.canonical === SUBJECT;
  check('  ...and a bare surname is never confidently guessed at',
        ok,
        bare ? `"${SUR}" -> ${bare.canonical} (confident=${bare.confident})` : `"${SUR}" -> declined`);
}

// The whole point: many spellings in, few players out.
{
  const raw = [];
  for (const p of [SUBJECT, 'Kyler Murray', 'Budda Baker']) {
    if (!resolvePlayer(p)) continue;
    raw.push(p, p.toUpperCase(), `${p} RC`, `2023 Prizm ${p}`, `${p} #1`, `${p} PSA 10`);
  }
  const out = resolveMany(raw);
  check('many spellings collapse to few players',
        out.resolved === raw.length && out.canonicalPlayers === raw.length / 6,
        `${out.input} raw strings -> ${out.canonicalPlayers} players `
        + `(${out.resolved} resolved, ${out.unresolved.length} declined)`);
}

// ---- a team is never a player (owner, Oct 2026) ------------------------
{
  const { NFL_NICKNAMES } = require('../parallel-index-core');
  const built = require('../public/data/card-index.json');
  const nick = new RegExp(`\\b(?:${NFL_NICKNAMES.join('|')})\\b`);
  const teamy = Object.keys(built.players).filter(k => nick.test(k));
  check('no player in the dictionary carries an NFL team', teamy.length === 0, teamy.slice(0, 5).join(' | '));
  const r = (p) => { const h = resolvePlayer(p); return h ? h.canonical : null; };
  check('  ...so a team resolves to no player',
    r('Steelers') === null && r('Houston Oilers') === null && r('Chicago Bears') === null, `${r('Steelers')}, ${r('Houston Oilers')}`);
  check('  ...and a player with his team glued on resolves to the player',
    r('Earl Campbell / Houston Oilers') === 'Earl Campbell' && r('Aaron Rodgers Green Bay Packers') === 'Aaron Rodgers'
    && r('Houston Oilers / Ken Houston') === 'Ken Houston' && r('Arch Manning Texas Longhorns') === 'Arch Manning');
  check('  ...while names that are also team words stay people',
    r('Jim Brown') === 'Jim Brown' && r('Jerry Rice') === 'Jerry Rice' && r('Desmond Howard') === 'Desmond Howard');
  // A team word left as somebody's last token made "Tigers" a unique surname,
  // and every "... Detroit Tigers" title resolved to Dutch Clark.
  check('  ...and a team\'s last word is never a surname to resolve by',
    !['tigers', 'irish', 'buckeyes', 'gamecocks', 'bulldogs'].some(w => w in built.uniqueSurnames)
    && resolvePlayer('Topps 2021 Chrome Tarik Skubal RC Refractor #103 Detroit Tigers') === null);
  check('  ...and a multi-player card keeps its name exactly',
    r('Aaron Donald / Bobby Wagner / Jalen Ramsey') === 'Aaron Donald / Bobby Wagner / Jalen Ramsey');
}

// Names the market's alias table resolved before teams came out of the
// dictionary are re-resolved once (server.js _reresolveTeamAliases).
(async () => {
  process.env.CF_WORKER = '1';
  const S = require('../server.js');
  const { DatabaseSync } = require('node:sqlite');
  const sq = new DatabaseSync(':memory:');
  sq.exec(`CREATE TABLE player_alias (variant TEXT PRIMARY KEY, canonical TEXT NOT NULL, display TEXT NOT NULL,
           how TEXT, resolved INTEGER NOT NULL DEFAULT 1, n INTEGER, updated_at TEXT)`);
  const put = sq.prepare('INSERT INTO player_alias VALUES (?,?,?,?,?,?,?)');
  put.run('earl campbell houston oilers', 'earl campbell houston oilers', 'Earl Campbell Houston Oilers', 'exact', 1, 148, 'x');
  put.run('steelers', 'steelers', 'Steelers', 'exact', 1, 6, 'x');
  put.run('patrick mahomes ii', 'patrick mahomes ii', 'Patrick Mahomes II', 'exact', 1, 900, 'x');
  const stmt = (sql) => ({ bind: (...b) => ({ all: async () => ({ results: sq.prepare(sql).all(...b) }),
                                              run: async () => sq.prepare(sql).run(...b) }) });
  const db = { prepare: stmt };
  const out = await S._reresolveTeamAliases(db, { resolve: resolvePlayer });
  const row = (v) => sq.prepare('SELECT canonical, resolved FROM player_alias WHERE variant = ?').get(v);
  check('names resolved with a team in them are re-resolved once',
    out.rewritten === 2 && row('earl campbell houston oilers').canonical === 'earl campbell'
    && row('steelers').resolved === 0 && row('patrick mahomes ii').canonical === 'patrick mahomes ii',
    JSON.stringify([out, row('earl campbell houston oilers'), row('steelers')]));
  console.log(failures ? `\n${failures} check(s) failed` : '\nall card-index checks passed');
  process.exit(failures ? 1 : 0);
})();
