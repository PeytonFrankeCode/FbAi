// One of One, the daily game (owner, Nov 2026): the rules (reading a typed
// name, rarity, the clock, a day's play), the prompt bank built from the real
// checklists, a whole round through the real routes, the admin page's routes,
// and the wiring a deploy needs (the Durable Object, the pack files nobody is
// served, /play).
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const G = require(path.join(ROOT, 'game-core.js'));
const B = require(path.join(ROOT, 'game-bank.js'));

// A small prompt: the most famous first, as the bank lists them.
const NAMES = ['Tom Brady', 'Aaron Rodgers', 'D.K. Metcalf', 'Amon-Ra St. Brown', 'Marvin Harrison', 'Marvin Harrison Jr.', 'Ja\'Marr Chase',
  'JuJu Smith-Schuster', 'Equanimeous St. Brown', 'José Núñez', 'Mike Evans', 'Mike Evens', 'Jordan Love', 'Romeo Doubs', 'Jayden Reed',
  'Christian Watson', 'Dontayvion Wicks', 'Luke Musgrave', 'Tucker Kraft', 'Bo Melton'];
const prompt = (text, names = NAMES) => ({ id: 'test:' + text, type: 'team', text, link: null,
  answers: names.map((n, i) => [n, n.toLowerCase().replace(/[^a-z0-9]+/g, '-'), Math.round(3000 / (i + 1))]) });
const P = prompt('Name a test player');
const who = (m) => (m.idx == null ? m.reason : P.answers[m.idx][0]);

// ---- Reading a typed name ----
check('capitals, punctuation and spacing do not matter', who(G.matchAnswer(P, 'dk metcalf')) === 'D.K. Metcalf' && who(G.matchAnswer(P, 'D K METCALF')) === 'D.K. Metcalf'
  && who(G.matchAnswer(P, 'amon ra st brown')) === 'Amon-Ra St. Brown' && who(G.matchAnswer(P, 'jamarr chase')) === 'Ja\'Marr Chase');
check('...nor accents', who(G.matchAnswer(P, 'Jose Nunez')) === 'José Núñez');
check('a father and son are two answers, and a suffix picks the son', who(G.matchAnswer(P, 'Marvin Harrison')) === 'Marvin Harrison' && who(G.matchAnswer(P, 'marvin harrison jr')) === 'Marvin Harrison Jr.');
check('...and the suffix can be left off when only the son fits', who(G.matchAnswer(prompt('x', ['Marvin Harrison Jr.', 'Tom Brady']), 'Marvin Harrison')) === 'reason' || G.matchAnswer(prompt('x', ['Marvin Harrison Jr.', 'Tom Brady']), 'Marvin Harrison').idx === 0);
check('a surname alone counts when one valid player has it', who(G.matchAnswer(P, 'Brady')) === 'Tom Brady' && who(G.matchAnswer(P, 'smith-schuster')) === 'JuJu Smith-Schuster' && who(G.matchAnswer(P, 'Schuster')) === 'JuJu Smith-Schuster');
check('...and is refused as ambiguous when two do', G.matchAnswer(P, 'Harrison').reason === 'ambiguous' && G.matchAnswer(P, 'St. Brown').reason === 'ambiguous' && G.matchAnswer(P, 'Evans').idx != null);
check('a small typo is corrected', who(G.matchAnswer(P, 'Aaron Rogers')) === 'Aaron Rodgers' && who(G.matchAnswer(P, 'Chrisitan Watsen')) === 'Christian Watson' && who(G.matchAnswer(P, 'Jordn Love')) === 'Jordan Love');
check('...but never a guess between two players as close', G.matchAnswer(P, 'Mike Evxns').reason === 'ambiguous');
check('a short word is not stretched into a name', G.matchAnswer(P, 'Tim').reason === 'none' && G.matchAnswer(P, 'Bradi').reason === 'none');
check('a player who does not fit is no match, and nothing typed is empty', G.matchAnswer(P, 'Patrick Mahomes').reason === 'none' && G.matchAnswer(P, '  ').reason === 'empty' && G.matchAnswer(P, null).reason === 'empty');
check('letter slips are counted, swaps included', G.editDistance('rodgers', 'rogers') === 1 && G.editDistance('watson', 'waston') === 1 && G.editDistance('brady', 'manning', 2) === 3);

// ---- How rare an answer is ----
const big = prompt('big', Array.from({ length: 200 }, (_, i) => `Player Number${i}`));
const start = G.startingTiers(big);
check('before anyone plays, fame sets the ladder: stars are Base and the unknowns a One of One', G.rarity(big, {}, 0, 0).tier.id === 'base' && G.rarity(big, {}, 0, 199).tier.id === 'one'
  && start.base >= 1 && start.green >= 1 && start.blue >= 1 && start.gold >= 1 && start.one >= 1, JSON.stringify(start));
check('the tiers score 10, 25, 50, 75 and 100, for 700 at most', G.TIERS.map(t => t.points).join() === '10,25,50,75,100' && G.MAX_SCORE === 700 && G.PROMPTS_PER_DAY === 7 && G.SECONDS === 20);
check('a One of One is the only copy: once someone has said it, it is Gold at best', G.rarity(big, { 199: 1 }, 1, 199).tier.id !== 'one' && ['gold', 'blue'].includes(G.rarity(big, { 199: 1 }, 1, 199).tier.id), G.rarity(big, { 199: 1 }, 1, 199).tier.id);
check('...and one earlier answer does not make an unknown player common', G.rarity(big, { 0: 3, 1: 2, 199: 1 }, 6, 199).tier.id !== 'base' && G.rarity(big, { 0: 3, 1: 2, 199: 1 }, 6, 199).tier.id !== 'green');
check('enough real players saying a name does', G.rarity(big, { 199: 400 }, 400, 199).tier.id === 'base');
check('real answers take over from fame as the day fills', G.rarity(big, { 150: 2000, 0: 1 }, 2001, 0).tier.id !== 'base' || G.rarity(big, { 150: 2000, 0: 1 }, 2001, 150).tier.id === 'base');

// ---- The day ----
check('a new pack opens at midnight Eastern, summer and winter', G.gameDate(Date.parse('2026-07-04T03:59:00Z')) === '2026-07-03' && G.gameDate(Date.parse('2026-07-04T04:00:00Z')) === '2026-07-04'
  && G.gameDate(Date.parse('2026-12-25T04:59:00Z')) === '2026-12-24' && G.gameDate(Date.parse('2026-12-25T05:00:00Z')) === '2026-12-25');
const toNext = G.msToNextDay(Date.parse('2026-07-04T03:59:00Z'));
check('the countdown runs to that midnight', toNext > 58000 && toNext <= 61000, String(toNext));
check('...including the 25-hour day when the clocks go back', Math.abs(G.msToNextDay(Date.parse('2026-11-01T04:00:00Z')) - 25 * 3600000) <= 1000);
const s1 = G.nextStats(null, '2026-11-12', 300), s2 = G.nextStats(s1, '2026-11-13', 500), s3 = G.nextStats(s2, '2026-11-15', 100);
check('a streak is days in a row, and a missed day starts it again', s1.streak === 1 && s2.streak === 2 && s2.best === 500 && s3.streak === 1 && s3.bestStreak === 2 && s3.plays === 3 && s3.best === 500);
check('...the same day is counted once, and the streak holds until a whole day is missed', G.nextStats(s2, '2026-11-13', 700) === s2 && G.liveStreak(s2, '2026-11-14') === 2 && G.liveStreak(s2, '2026-11-15') === 0);
check('the share text shows tiers and never an answer', G.shareText({ number: 12, score: 410, maxScore: 700, answers: [{ tier: 'one' }, { tier: 'gold' }, { tier: 'blue' }, { tier: 'base' }, { tier: 'green' }, null, { tier: 'one' }] })
  === 'One of One #12  410/700\n⬛🟨🟦⬜🟩✖️⬛\nthecardhuddle.com/play');

const pack = (date, number = 1) => ({ date, number, prompts: Array.from({ length: 7 }, (_, i) => prompt(`Prompt ${i + 1} of ${date}`)), spares: [prompt('Spare A'), prompt('Spare B'), prompt('Spare C')] });
const MS = G.SECONDS * 1000;

(async () => {
  // ---- One day's play, on a clock the test holds ----
  {
    const day = new G.GameDay(G.memoryStore());
    const a = 'd:aaaaaaaaaaaaaaaa', b = 'd:bbbbbbbbbbbbbbbb', q = 'd:cccccccccccccccc';
    check('a day has no pack until it is given one', (await day.hasPack()) === false && (await day.next(a, 0)).error === 'no-pack');
    check('...takes a full pack once, and keeps it', (await day.setPack(pack('2026-11-12', 5))) === true && (await day.setPack(pack('2026-11-12', 9))) === false && (await day.meta()).number === 5);
    let short = null; try { await new G.GameDay(G.memoryStore()).setPack({ date: '2026-11-12', prompts: [P] }); } catch (e) { short = e; }
    check('...and refuses one that is not seven prompts', !!short);
    let t = 1000000;
    let r = await day.next(a, t);
    check('Play shows the first prompt and starts its clock', r.view.active.slot === 0 && r.view.active.msLeft === MS && r.view.active.text === 'Prompt 1 of 2026-11-12' && !('answers' in r.view.active));
    r = await day.next(a, t + 5000);
    check('asking again gives the same prompt and what is left of the same clock: a refresh buys no time', r.view.active.slot === 0 && r.view.active.msLeft === MS - 5000);
    r = await day.answer(a, 'Nobody Atall', t + 6000);
    check('a wrong name costs a try, not the prompt', r.ok === false && r.reason === 'none' && r.view.active.triesLeft === G.MAX_TRIES - 1 && r.view.active.msLeft === MS - 6000);
    r = await day.answer(a, '', t + 6500);
    check('...and nothing typed costs nothing', r.ok === false && r.reason === 'empty' && r.view.active.triesLeft === G.MAX_TRIES - 1);
    r = await day.answer(a, 'Brady', t + 7000);
    check('a right answer scores by tier, and says how many gave it', r.ok === true && r.answer.name === 'Tom Brady' && r.answer.tier === 'base' && r.answer.points === 10 && r.answer.said === 1 && r.answer.of === 1 && r.view.slot === 1 && r.view.active === null);
    check('...with no second go at the same prompt', (await day.answer(a, 'Bo Melton', t + 7500)).error === 'no-prompt');
    r = await day.next(a, t + 10000);
    r = await day.answer(a, 'Bo Melton', t + 10000 + MS + G.GRACE_MS + 1);
    check('an answer after the clock (and its grace) is too late: the slot stays empty', r.timeout === true && r.reason === 'clock' && r.view.answers[1] === null && r.view.slot === 2);
    r = await day.next(a, t + 50000);
    r = await day.answer(a, 'Bo Melton', t + 50000 + MS + G.GRACE_MS - 1);
    check('...but one inside the grace counts, and an unknown name is a One of One', r.ok === true && r.answer.tier === 'one' && r.answer.points === 100);
    r = await day.next(a, t + 100000);
    for (let i = 0; i < G.MAX_TRIES; i++) r = await day.answer(a, 'Wrong Guess', t + 100001 + i);
    check('the tries run out before a script can go through the names', r.timeout === true && r.reason === 'tries' && r.view.answers[3] === null);
    r = await day.next(a, t + 150000);
    r = await day.answer(a, 'no such player', t + 150001, { final: true });
    check('a last word that does not fit, or a skip, leaves the slot empty at once', r.timeout === true && r.reason === 'final' && r.view.slot === 5);
    r = await day.next(a, t + 200000);
    r = await day.next(a, t + 200000 + MS + G.GRACE_MS + 5);   // walked away: the clock ran out, the next prompt is shown
    check('a prompt left to run out is a miss, and the round moves on', r.view.answers[5] === null && r.view.active.slot === 6);
    check('what everyone said is not shown before the round is done', (await day.results(a)).error === 'not-done');
    r = await day.answer(a, 'Tucker Kraft', t + 200000 + MS + G.GRACE_MS + 10, { final: true });
    check('the seventh answer ends the round with its score', r.view.done === true && r.view.score === 10 + 100 + r.answer.points && r.view.answers.length === 7);
    check('...and one round a day: Play again changes nothing', (await day.next(a, t + 900000)).view.done === true && (await day.next(a, t + 900000)).view.active === null);
    const res = await day.results(a);
    check('the results list each prompt, the player\'s answer and what was said', res.prompts.length === 7 && res.prompts[0].yours.name === 'Tom Brady' && res.prompts[0].top[0].name === 'Tom Brady' && res.prompts[1].yours === null && res.prompts[0].pool === NAMES.length);

    // A second player, the same names.
    r = await day.next(b, t);
    r = await day.answer(b, 'Tom Brady', t + 1);
    check('the second player to say a name is told two said it', r.answer.said === 2 && r.answer.of === 2);
    await day.next(b, t + 2); await day.answer(b, 'x', t + 3, { final: true });
    await day.next(b, t + 4);
    r = await day.answer(b, 'Bo Melton', t + 5);
    check('...and the first player\'s One of One is not one for the second', r.answer.tier !== 'one' && r.answer.points < 100, r.answer.tier);

    // A quiet round: plays and scores, counts for nothing.
    const before = await day.summary();
    r = await day.next(q, t, { quiet: true });
    r = await day.answer(q, 'Romeo Doubs', t + 1);
    const after = await day.summary();
    check('a quiet round scores but is left out of the day\'s counts', r.ok === true && after.plays === before.plays && after.prompts[0].n === before.prompts[0].n && !after.prompts[0].top.some(x => x.name === 'Romeo Doubs'));
    check('the day\'s summary counts rounds started and finished', after.plays === 2 && after.finished === 1 && after.average > 0 && after.prompts[0].n === 2);

    // Two answers arriving together.
    const day2 = new G.GameDay(G.memoryStore());
    await day2.setPack(pack('2026-11-12'));
    const pids = Array.from({ length: 12 }, (_, i) => 'd:' + String(i).padStart(16, 'z'));
    await Promise.all(pids.map(p => day2.next(p, t)));
    await Promise.all(pids.map(p => day2.answer(p, 'Jordan Love', t + 1)));
    const sum = await day2.summary();
    check('answers arriving together are all counted', sum.plays === 12 && sum.prompts[0].n === 12 && sum.prompts[0].top[0].n === 12);
    check('a player id is an account or a browser\'s own id, nothing else', G.validPid('u:liam') && G.validPid('d:0123456789abcdef') && !G.validPid('d:short') && !G.validPid('x:0123456789abcdef') && !G.validPid('') && (await day2.next('nope', t)).error === 'player');
  }

  // ---- The Durable Object, on a stand-in for its storage ----
  {
    const w = await import(path.join(ROOT, 'worker.js'));
    const m = new Map();
    const state = { storage: { get: async (k) => m.get(k), put: async (k, v) => { m.set(k, structuredClone(v)); }, setAlarm: async (at) => { m.set('__alarm', at); }, deleteAll: async () => m.clear() } };
    const obj = new w.GameDay(state, {});
    const post = async (body) => (await obj.fetch(new Request('https://game.local/', { method: 'POST', body: JSON.stringify(body) }))).json();
    const set = await post({ op: 'pack', pack: pack('2026-11-12', 3) });
    const nx = await post({ op: 'next', pid: 'd:aaaaaaaaaaaaaaaa' });
    const an = await post({ op: 'answer', pid: 'd:aaaaaaaaaaaaaaaa', text: 'Jordan Love' });
    check('the Worker\'s GameDay object runs the same rules on its own storage', set.set === true && nx.view.active.slot === 0 && an.ok === true && an.answer.name === 'Jordan Love' && (await post({ op: 'summary' })).summary.plays === 1);
    check('...sets itself to clear a month on, and refuses what is not a call', m.get('__alarm') > Date.now() + 29 * 86400000 && (await post({ op: 'nope' })).error === 'op'
      && (await obj.fetch(new Request('https://game.local/', { method: 'POST', body: 'not json' }))).status === 400);
    await obj.alarm();
    check('...and the alarm clears it', m.size === 0);
    check('the pack files are never served to a browser', w.isGamePackPath('/data/game/2026-11-12.json') && w.isGamePackPath('/data/game/index.json') && w.isGamePackPath('/DATA/GAME/x.json') && !w.isGamePackPath('/data/checklists/index.json') && !w.isGamePackPath('/data/gamers.json'));
    check('/play is a real page, with or without a slash', w.isKnownHtmlPath('/play') && w.isKnownHtmlPath('/play/') && !w.isKnownHtmlPath('/plays'));
  }

  // ---- The prompts, from the real checklists ----
  const { loadChecklists, loadPlayers } = require(path.join(ROOT, 'scripts', 'build-daily-game.js'));
  const bank = B.buildBank({ checklists: loadChecklists(), players: loadPlayers() });
  {
    const kinds = {};
    for (const p of bank) kinds[p.type] = (kinds[p.type] || 0) + 1;
    check('the checklists carry a bank of every kind of prompt', bank.length > 1000 && ['product', 'team', 'insert', 'rookie', 'year', 'auto', 'autoyear', 'low', 'count'].every(k => kinds[k] > 0), JSON.stringify(kinds));
    const key = (n) => G.dropSuffix(G.nameWords(n)).join('');
    let dupes = 0, unsorted = 0, small = 0, dominated = 0, noBase = 0;
    for (const p of bank) {
      if (new Set(p.answers.map(a => a[1])).size !== p.answers.length) dupes++;
      if (p.answers.some((a, i) => i && a[2] > p.answers[i - 1][2])) unsorted++;
      if (p.answers.length < 20 || p.answers.length > 900) small++;
      if (G.fameShares(p)[0] > 0.5) dominated++;
      if (!G.startingTiers(p).base) noBase++;
    }
    check('every pool is a sensible size, most famous first, with no player twice', !dupes && !unsorted && !small, `${dupes} ${unsorted} ${small}`);
    check('...no one player is most of a pool, and every pool starts with a Base answer', !dominated && !noBase, `${dominated} ${noBase}`);
    check('every name in a pool can be typed back', bank.slice(0, 400).every(p => p.answers.every((a, i) => { const m = G.matchAnswer(p, a[0]); return m.idx === i || (m.idx != null && key(p.answers[m.idx][0]) === key(a[0])); })));
    // A right answer is never refused: only ask where the checklists know everyone who fits.
    const teamWindows = new Set(bank.filter(p => p.type === 'team').map(p => p.id.split(':')[2]));
    check('team prompts name the years the checklists carry teams for', [...teamWindows].every(wid => B.TEAM_WINDOWS.some(x => x.id === wid)) && bank.filter(p => p.type === 'team').every(p => /with a card from (the 19[567]0s|2014 to 2016|2022 or later)$/.test(p.text)));
    check('thin years (2008 to 2011) are not asked about as a whole', !bank.some(p => /^(year|autoyear|rookie):(2008|2009|2010|2011)$/.test(p.id)));
    check('college and draft products are left out', !bank.some(p => /collegiate|draft picks|university|\bsage\b/i.test(p.text)));
    check('the wording reads right: an Arizona Cardinals player, an Award Winners insert', bank.some(p => p.text.startsWith('Name an Arizona Cardinals player')) && !bank.some(p => /\ba (Arizona|Atlanta|Indianapolis|Oakland)\b/.test(p.text)) && !bank.some(p => /with a (Award|Instant|Inside|Unsung|All-Rookie)/.test(p.text)));

    const packs = B.buildPacks(bank, { from: B.EPOCH, days: 40 });
    const again = B.buildPacks(bank, { from: B.EPOCH, days: 40 });
    check('a date deals the same pack every time', packs.length === 40 && JSON.stringify(packs.map(p => p.prompts.map(q => q.id))) === JSON.stringify(again.map(p => p.prompts.map(q => q.id))));
    check('packs are numbered from day 1', packs[0].date === B.EPOCH && packs[0].number === 1 && packs[39].number === 40 && B.buildPacks(bank, { from: packs[9].date, days: 1 })[0].number === 10);
    const byId = new Map(bank.map(p => [p.id, p]));
    check('each pack is seven prompts on seven subjects, with three spares', packs.every(p => p.prompts.length === 7 && p.spares.length === 3
      && new Set(p.prompts.concat(p.spares).map(q => byId.get(q.id).subject)).size === 10));
    check('...a mix of kinds, never all vintage', packs.every(p => new Set(p.prompts.map(q => q.type)).size >= 3 && p.prompts.filter(q => byId.get(q.id).vintage).length <= 3));
    let repeats = 0;
    for (let i = 0; i < packs.length; i++) for (let j = Math.max(0, i - 7); j < i; j++) if (packs[i].prompts.some(q => packs[j].prompts.some(o => o.id === q.id))) repeats++;
    check('no prompt comes back within a week', repeats === 0, String(repeats));
    check('a dealt pack carries only what play needs', Object.keys(packs[0].prompts[0]).sort().join() === 'answers,id,link,text,type');
    const sw = G.applySwaps(packs[1], { 2: packs[1].prompts[2].id });
    check('a swap puts the next spare in the slot', sw.prompts[2].id === packs[1].spares[0].id && sw.spares.length === 2 && sw.prompts[0].id === packs[1].prompts[0].id);
    check('...unless the slot no longer holds the prompt the admin saw', G.applySwaps(packs[1], { 2: 'some:other:prompt' }).prompts[2].id === packs[1].prompts[2].id);
  }

  // ---- A whole round, through the routes ----
  process.env.CF_WORKER = '1';
  process.env.ADMIN_PASSWORD = 'test-admin';
  const S = require(path.join(ROOT, 'server.js'));
  let now = Date.parse('2026-11-12T17:00:00Z');   // noon Eastern
  S._gameTestHooks({ pack: (date) => pack(date, G.dayIndex(date) - G.dayIndex('2026-11-11')), now: () => now });
  const PORT = 3317;
  const server = S.app.listen(PORT);
  const base = `http://127.0.0.1:${PORT}`;
  let ip = 20;
  const call = async (p, { method = 'GET', body, dev, token, admin, headers } = {}) => {
    const r = await fetch(base + p, { method, body: body ? JSON.stringify(body) : undefined, headers: { 'content-type': 'application/json',
      'cf-connecting-ip': `198.51.100.${ip++ % 250}`, ...(dev ? { 'x-game-device': dev } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(admin ? { 'x-admin-key': 'test-admin' } : {}), ...(headers || {}) } });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const round = async (who, answers) => {
    let last = null;
    for (const text of answers) {
      await call('/api/game/next', { method: 'POST', ...who, body: {} });
      last = await call('/api/game/answer', { method: 'POST', ...who, body: { text, final: true } });
    }
    return last;
  };
  try {
    const d1 = { dev: 'device-one-aaaaaaaa' }, d2 = { dev: 'device-two-bbbbbbbb' };
    let r = await call('/api/game/today');
    check('anyone can see today\'s pack, with no account and no plan', r.status === 200 && r.body.view.number === 1 && r.body.view.count === 7 && r.body.view.started === false && r.body.tiers.length === 5 && r.body.msToNext > 0);
    check('...but playing needs the browser\'s own id', (await call('/api/game/next', { method: 'POST', body: {} })).status === 400);
    r = await call('/api/game/next', { method: 'POST', ...d1, body: {} });
    check('Play starts the first prompt', r.status === 200 && r.body.view.active.slot === 0 && r.body.view.active.msLeft === MS);
    const leaked = JSON.stringify(r.body);
    check('...and sends the prompt without its answers', !NAMES.some(n => leaked.includes(n)) && !('results' in r.body) && !('share' in r.body));
    r = await call('/api/game/answer', { method: 'POST', ...d1, body: { text: 'Not A Player' } });
    check('a wrong name is told so, and can be tried again', r.status === 200 && r.body.ok === false && r.body.reason === 'none' && !NAMES.some(n => JSON.stringify(r.body).includes(n)));
    r = await call('/api/game/answer', { method: 'POST', ...d1, body: { text: 'tom brady' } });
    check('a right one comes back as its card', r.body.ok === true && r.body.answer.name === 'Tom Brady' && r.body.answer.tier === 'base' && !r.body.results);
    r = await round(d1, ['Bo Melton', 'x', 'Tucker Kraft', 'Luke Musgrave', 'Jayden Reed', 'Jordan Love']);
    check('the round ends with the score, the share text and what everyone said', r.body.view.done === true && r.body.view.score > 0 && r.body.results.length === 7
      && r.body.share.startsWith('One of One #1  ') && r.body.share.includes(`${r.body.view.score}/700`) && r.body.results[0].yours.name === 'Tom Brady');
    r = await call('/api/game/today', d1);
    check('coming back shows the finished round, not a new one', r.body.view.done === true && r.body.results.length === 7 && (await call('/api/game/next', { method: 'POST', ...d1, body: {} })).body.view.active === null);
    r = await call('/api/game/today', d2);
    check('another browser has its own round', r.body.view.started === false && !r.body.results);
    r = await round(d2, ['Tom Brady', 'Bo Melton']);
    check('the second to say an unknown name does not get the One of One', r.body.ok === true && r.body.answer.tier !== 'one' && r.body.answer.said === 2);

    // An account: its streak is kept, and shown on My Account.
    const user = 'oo' + Date.now().toString(36);
    const token = (await call('/api/auth/register', { method: 'POST', body: { username: user, password: 'secret123' } })).body.token;
    r = await round({ token }, ['Aaron Rodgers', 'x', 'x', 'x', 'x', 'x', 'x']);
    check('an account plays under its name, and its streak starts', r.body.view.done === true && r.body.stats && r.body.stats.streak === 1 && r.body.stats.best === r.body.view.score && r.body.stats.plays === 1);
    const profile = await call('/api/account/profile', { token });
    check('...and My Account shows it', profile.body.game && profile.body.game.streak === 1 && profile.body.game.plays === 1);

    // A visitor the Worker takes for a program.
    const quietBefore = (await call('/api/admin/game', { admin: true })).body.days[0].plays;
    await call('/api/game/next', { method: 'POST', dev: 'device-bot-cccccccc', body: {}, headers: { 'x-game-uncounted': '1' } });
    r = await call('/api/game/answer', { method: 'POST', dev: 'device-bot-cccccccc', body: { text: 'Mike Evans' } });
    check('a round marked uncounted plays, and is left out of the day\'s numbers', r.body.ok === true && (await call('/api/admin/game', { admin: true })).body.days[0].plays === quietBefore);

    // Admin.
    check('the admin routes need the admin key', (await call('/api/admin/game')).status === 401 && (await call('/api/admin/game/swap', { method: 'POST', body: { date: '2026-11-13', slot: 0 } })).status === 401);
    const adm = (await call('/api/admin/game', { admin: true })).body;
    check('the admin page gets today\'s numbers and prompts', adm.today === '2026-11-12' && adm.days[0].date === '2026-11-12' && adm.days[0].plays === 3 && adm.days[0].finished === 2 && adm.days[0].prompts[0].top[0].name === 'Tom Brady');
    check('...and the next seven days, with where each pool starts', adm.upcoming.length === 7 && adm.upcoming[0].date === '2026-11-13' && adm.upcoming[0].number === 2 && adm.upcoming[0].prompts.length === 7 && adm.upcoming[0].prompts[0].start.base >= 1 && adm.upcoming[0].sparesLeft === 3);
    check('today\'s pack cannot be swapped: people are playing it', (await call('/api/admin/game/swap', { method: 'POST', admin: true, body: { date: '2026-11-12', slot: 0 } })).status === 400);
    await call('/api/admin/game/swap', { method: 'POST', admin: true, body: { date: '2026-11-13', slot: 1 } });
    let up = (await call('/api/admin/game', { admin: true })).body.upcoming[0];
    check('a swap puts a spare in a coming day\'s slot', up.prompts[1].text === 'Spare A' && up.prompts[1].swapped === true && up.sparesLeft === 2 && up.prompts[0].swapped === false);
    await call('/api/admin/game/swap', { method: 'POST', admin: true, body: { date: '2026-11-13', slot: 1, undo: true } });
    up = (await call('/api/admin/game', { admin: true })).body.upcoming[0];
    check('...and can be taken back', up.prompts[1].text === 'Prompt 2 of 2026-11-13' && up.sparesLeft === 3);
    await call('/api/admin/game/swap', { method: 'POST', admin: true, body: { date: '2026-11-13', slot: 6 } });

    // The next day.
    now = Date.parse('2026-11-13T04:59:55Z');   // five seconds to midnight Eastern, still the 12th
    const late = { dev: 'device-late-dddddddd' };
    r = await call('/api/game/next', { method: 'POST', ...late, body: {} });
    const lateDate = r.body.view.date;
    now = Date.parse('2026-11-13T05:00:05Z');   // five past: the 13th, with the prompt's clock still running
    r = await call('/api/game/answer', { method: 'POST', ...late, body: { text: 'Tom Brady', date: lateDate } });
    check('a round begun before midnight is finished on that day\'s pack', lateDate === '2026-11-12' && r.body.ok === true && r.body.view.date === '2026-11-12');
    r = await call('/api/game/today', d1);
    check('after midnight there is a new pack, and yesterday\'s round is over', r.body.view.date === '2026-11-13' && r.body.view.number === 2 && r.body.view.started === false);
    r = await call('/api/game/next', { method: 'POST', ...d1, body: {} });
    const seen = [r.body.view.active.text];
    for (let i = 0; i < 6; i++) { await call('/api/game/answer', { method: 'POST', ...d1, body: { text: '', final: true } }); const n = await call('/api/game/next', { method: 'POST', ...d1, body: {} }); if (n.body.view.active) seen.push(n.body.view.active.text); }
    check('...dealt with the admin\'s swap in it', seen.length === 7 && seen[6] === 'Spare A' && seen[1] === 'Prompt 2 of 2026-11-13', seen.join(' | '));
    r = await round({ token }, ['Jordan Love', 'x', 'x', 'x', 'x', 'x', 'x']);
    check('playing the next day makes the streak two', r.body.stats.streak === 2 && r.body.stats.plays === 2);
    now = Date.parse('2026-11-15T17:00:00Z');
    r = await call('/api/game/today', { token });
    check('...and a missed day ends it', r.body.stats.streak === 0 && r.body.stats.bestStreak === 2);
    const kept = (await call('/api/admin/game', { admin: true })).body.days;
    check('a finished day\'s numbers are kept for the admin page', kept.some(d => d.date === '2026-11-12' && d.plays >= 3) && kept.some(d => d.date === '2026-11-13' && d.finished >= 1));

    S._gameTestHooks({ pack: async () => null, now: () => now });
    check('a day with no pack says so, instead of breaking', (await call('/api/game/today', d1)).status === 503);
    check('the game has its own rate limit, ahead of the general one', S.RL_TIERS.findIndex(t => t.name === 'game') >= 0 && S.RL_TIERS.findIndex(t => t.name === 'game') < S.RL_TIERS.findIndex(t => t.name === 'api'));
  } catch (err) {
    check('the routes ran without throwing', false, err && err.stack);
  } finally {
    S._gameTestHooks();
    server.close();
  }

  // ---- The wiring a deploy needs ----
  const srv = read('server.js'), w = read('worker.js'), html = read('public/index.html'), app = read('public/app.js'), toml = read('wrangler.toml'), yml = read('.github/workflows/deploy.yml');
  const section = srv.slice(srv.indexOf('// ==================== One of One'), srv.indexOf('module.exports = { _gameTestHooks'));
  check('the game is free: its routes ask for no plan and no sign-in', section.length > 2000 && !/requirePlan|_huddleTier|isAdFreeUser|getEffectiveSubscription|stripe/i.test(section));
  check('the Worker never runs the prompt builder', !/require\(\s*['"]\.\/game-bank/.test(srv) && !/game-bank/.test(w) && /nodeRequire\('\.\/game-bank\.js'\)/.test(srv));
  check('wrangler.toml binds the GameDay object and migrates it in', /name = "GAME_DAY"\s+class_name = "GameDay"/.test(toml) && /tag = "v3"\s+new_sqlite_classes = \["GameDay"\]/.test(toml) && /export class GameDay \{/.test(w));
  check('the Worker marks a program\'s round, and drops the mark from anyone else', /h\.delete\('x-game-uncounted'\);\s+if \(NO_TAGS_FOR\.has\(visitorKind\)\) h\.set\('x-game-uncounted', '1'\)/.test(w));
  check('the deploy deals the packs before the tests and minifies play.js', yml.indexOf('npm run build:game') > yml.indexOf('npm run build:pages') && yml.indexOf('npm run build:game') < yml.indexOf('node scripts/run-ci-tests.js')
    && /for f in app\.js bounties\.js play\.js;/.test(yml) && /"build:game": "node scripts\/build-daily-game\.js"/.test(read('package.json')));
  check('the dealt packs are not committed', /^public\/data\/game\/$/m.test(read('.gitignore')));
  check('the app has the tab, the view, the home link and play.js', /data-view="play" onclick="switchView\('play'\)"/.test(html) && /id="play-view" class="collection-view hidden"/.test(html) && /id="oo-root"/.test(html)
    && /class="mm-report-link oo-home-link" href="\/play"/.test(html) && /<script src="play\.js\?v=[a-z0-9]+"><\/script>/.test(html));
  check('...and opens it at /play', /play: '\/play'/.test(app) && /'\/play': 'play'/.test(app) && /if \(playView\) \{ playView\.classList\.remove\('hidden'\); if \(typeof initPlayView === 'function'\) initPlayView\(\); \}/.test(app)
    && /if \(playView\) playView\.classList\.add\('hidden'\);/.test(app));
  check('play.js is stamped and cached with the rest', /'play\.js',/.test(read('scripts/stamp-sw.js')) && /'index\.html': \['style\.css', 'app\.js', 'bounties\.js', 'play\.js'\]/.test(read('scripts/stamp-sw.js')));
  const play = read('public/play.js');
  check('the page never holds the answers: it only shows what the server sends back', !/answers\s*:\s*\[\[/.test(play) && /x-game-device/.test(play) && /final: !!final/.test(play) && /window\.initPlayView = function/.test(play));
  check('there is no Skip button: a prompt is answered or runs out', !/data-act="skip"/.test(play) && !/skip/i.test(play.replace(/There is no Skip button[^\n]*/, '')));
  check('the results screen shows the streak, best score and packs played as tiles, and one line for what was most said',
    /function statTiles\(\)/.test(play) && /'Day streak'/.test(play) && /'Best score'/.test(play) && /Most said: \$\{top\}/.test(play)
    && !/Said by one player/.test(play) && /\.oo-tiles\{display:grid;grid-template-columns:repeat\(3,/.test(read('public/style.css')));
  check('the game\'s buttons keep their colour under the pointer', /\.oo-btn:hover,\.oo-btn:focus-visible\{background:var\(--accent-hover\);color:var\(--accent-on\)\}/.test(read('public/style.css')));
  check('the admin page has the game\'s numbers and the swap', /async function loadGame\(\)/.test(read('public/admin.html')) && /function swapGame\(/.test(read('public/admin.html')) && /loadGame\(\);/.test(read('public/admin.html')));

  console.log(failures ? `\n${failures} One of One check(s) failed` : '\nall One of One checks passed');
  process.exit(failures ? 1 : 0);
})();
