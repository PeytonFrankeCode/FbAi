// The search box finishes a card title from the checklists (owner, Oct 2026):
// "elway 84" into "1984 Topps John Elway #63", in any word order, parallels
// and grades included, for cards that have not sold lately too. The matcher
// lives in public/app.js; the data is cut by scripts/build-card-suggest.js.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};
const ROOT = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const grab = (name) => { const i = app.indexOf(`function ${name}(`); return app.slice(i, app.indexOf('\n}\n', i) + 3); };
const consts = ['_csCardWords', 'CS_GRADERS', 'CS_SKIP', 'CS_CAT_WORDS', 'CS_SPORT']
  .map(n => app.match(new RegExp(`const ${n} = [^\\n]+`))[0]).join('\n');
const ctx = {};
vm.createContext(ctx);
vm.runInContext(consts + '\n' + ['_csFold', '_csWords', '_csQuery', '_csShardKey', '_csMatch'].map(grab).join('\n')
  + '\nthis.f = { _csQuery, _csShardKey, _csMatch };', ctx);
const { _csQuery, _csShardKey, _csMatch } = ctx.f;

// A small world: products, sets (product, name, category), and one shard.
const dict = {
  parChunk: 2000, split: ['ma'],
  products: [[1984, 'Topps', 'football'], [1995, 'Pacific Gridiron', 'football'], [2017, 'Panini Prizm', 'football'], [2001, 'Topps', 'baseball']],
  sets: [[0, '', 'b'], [1, 'Blue', 'b'], [2, '', 'b'], [2, 'Rookie Signatures', 'a'], [3, '', 'b']],
};
const pars = new Map([[0, [[], [], ['Prizm', 'Prizm Gold'], [], []]]]);
const shard = { players: [
  { n: 'John Elway', s: 'f', c: [[0, '63', 1], [1, '84', 0]] },
  { n: 'Patrick Mahomes II', s: 'f', c: [[2, '269', 0], [3, 'RS-PM', 0, 99]] },
  { n: 'Pat Mahomes', s: 's', c: [[4, '615', 0]] },
] };
const titles = (q, opts = {}) => _csMatch(dict, shard, _csQuery(q), { pars, ...opts }).cards.map(c => c.title);

check('"elway 84" finishes into his 1984 Topps rookie first', titles('elway 84')[0] === '1984 Topps John Elway #63', JSON.stringify(titles('elway 84')));
check('  ...in any word order', titles('84 topps elway')[0] === '1984 Topps John Elway #63');
check('  ...and by card number alone', titles('elway 63')[0] === '1984 Topps John Elway #63');
check('  ..."rookie" or "rc" finds the rookie', titles('elway rc')[0] === '1984 Topps John Elway #63' && titles('elway rookie').length === 1);
check('a parallel is named from the set\'s own list, Panini\'s plain "Prizm" as the Silver',
  titles('mahomes prizm silver')[0] === '2017 Panini Prizm Patrick Mahomes II #269 Silver Prizm', JSON.stringify(titles('mahomes prizm silver')));
check('  ...and "gold" picks the Gold', titles('mahomes gold')[0] === '2017 Panini Prizm Patrick Mahomes II #269 Prizm Gold');
{
  const r = _csMatch(dict, shard, _csQuery('mahomes silver'), { pars: new Map() });
  check('  ...the parallels are asked for only when a word is left over', r.cards.length === 0 && r.needPar.includes(0));
}
check('a grade typed is carried onto the title', titles('psa 10 elway rookie')[0] === '1984 Topps John Elway #63 PSA 10');
check('autographs answer to "auto", print runs to their number',
  titles('mahomes auto')[0] === '2017 Panini Prizm Rookie Signatures Patrick Mahomes II #RS-PM' && titles('mahomes 99').length === 1);
check('only the sports turned on', titles('mahomes', { sports: ['football'] }).every(t => !/Pat Mahomes/.test(t))
  && titles('mahomes', { sports: ['baseball'] })[0] === '2001 Topps Pat Mahomes #615');
check('a word the card does not have rules it out', titles('elway fleer').length === 0);
check('a player has to be named: brand words alone suggest nothing', titles('topps 1984').length === 0);
check('  ...with baseball and basketball told apart', /SPORT_CODE = \{ football: 'f', basketball: 'b', baseball: 's' \}/.test(fs.readFileSync(path.join(ROOT, 'scripts', 'build-card-suggest.js'), 'utf8'))
  && /CS_SPORT = \{ f: 'football', b: 'basketball', s: 'baseball' \}/.test(app));
check('the shard is the surname\'s first letters, three where split', _csShardKey('elway', dict.split) === 'el'
  && _csShardKey('mahomes', dict.split) === 'mah' && _csShardKey('ma', dict.split) === null && _csShardKey('84', dict.split) === null);
{
  const sold = new Map([['1995|84|john elway', 500]]);
  check('what actually sells ranks first', titles('elway', { sold })[0] === '1995 Pacific Gridiron Blue John Elway #84');
}

// ---- wiring ----
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const wf = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'deploy.yml'), 'utf8');
const gi = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
check('the deploy builds the shards before stamping and testing',
  wf.indexOf('npm run build:suggest') > 0 && wf.indexOf('npm run build:suggest') < wf.indexOf('npm run build:sw'));
check('  ...and they are not committed', /^public\/data\/suggest\/$/m.test(gi));
check('the search box asks for them as you type', /_csSuggest\(q, seq\)/.test(app) && /id="search-suggest"/.test(html));

console.log(failures ? `\n${failures} check(s) failed` : '\nall card-suggest checks passed');
process.exit(failures ? 1 : 0);
