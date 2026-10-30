// "Did you mean" (owner, Oct 2026): a misspelled search is searched as the
// corrected spelling, with the words as typed one tap away.
'use strict';
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
let failures = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`); if (!ok) failures++; };

process.env.DISABLE_RATE_LIMIT = '1';
const { buildVocab, spellFix, distance } = require(path.join(ROOT, 'spell-core.js'));
const S = require(path.join(ROOT, 'server.js'));

(async () => {
  try {
    check('edit distance counts a swap as one', distance('collegitae', 'collegiate', 2) === 1 && distance('tomilson', 'tomlinson', 2) === 2 && distance('abc', 'xyz', 1) === 2);
    const vocab = await S._spellVocab();
    check('the vocabulary is built from the site\'s players, products, sets and parallels', vocab && vocab.weights.size > 15000, vocab && String(vocab.weights.size));
    const fixes = {
      '2023 collegitae national treasures Ladanilan tomilson': '2023 collegiate national treasures Ladainian tomlinson',
      'Patrick Mahomse prizm silver': 'Patrick Mahomes prizm silver',
      'jayden danials optic': 'jayden daniels optic',
      'lebron jmes prizm': 'lebron james prizm',
      'Shohei Ohtnai bowman chrome': 'Shohei Ohtani bowman chrome',
    };
    for (const [q, want] of Object.entries(fixes)) check(`"${q}" is corrected`, spellFix(q, vocab).corrected === want, spellFix(q, vocab).corrected);
    const keep = ['Bo Nix PSA 10', 'Puka Nacua Prizm', 'Malik Nabers Kaboom', 'Amon-Ra St. Brown', 'Jaxson Dart Emergent', 'Xavier Worthy Fireworks',
      'Bijan Robinson Stained Glass', 'Caitlin Clark Prizm', 'Victor Wembanyama Mosaic', 'Saquon Barkley Eagles', 'Gridiron Kings', 'Zenith Illusions Rated', '2024 Prizm #300 /25'];
    const changed = keep.filter(q => spellFix(q, vocab).changed);
    check('a correct search is left alone, rare names and inserts included', changed.length === 0, changed.join(' | '));
    const tiny = buildVocab({ players: [{ name: 'Bo Nix', cards: 9 }] });
    check('  ...and short words and numbers are never touched', spellFix('Bo Nxi 2024 #12', tiny).corrected === 'Bo Nxi 2024 #12');

    const server = S.app.listen(0);
    const base = `http://127.0.0.1:${server.address().port}`;
    const r = await (await fetch(`${base}/api/direct-search?${new URLSearchParams({ q: 'Patrick Mahomse prizm', mode: 'forsale' })}`)).json();
    check('a search answers with the spelling it used and the words as typed', r.spelling && r.spelling.corrected === 'Patrick Mahomes prizm' && r.spelling.original === 'Patrick Mahomse prizm', JSON.stringify(r.spelling));
    const ex = await (await fetch(`${base}/api/direct-search?${new URLSearchParams({ q: 'Patrick Mahomse prizm', mode: 'forsale', exact: '1' })}`)).json();
    check('  ...and exact=1 searches the words as typed', !ex.spelling);
    server.close();

    const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
    check('the page shows "Showing results for", offers the original, and carries on with the corrected query',
      /Showing results for <b>/.test(app) && /Search instead for/.test(app) && (app.match(/query = _spellApply\(data, query, /g) || []).length === 2 && /params\.set\('exact', '1'\)/.test(app));
  } catch (e) { console.error(e); failures++; }
  console.log(failures ? `\n${failures} check(s) failed` : '\nall spelling checks passed');
  process.exit(failures ? 1 : 0);
})();
