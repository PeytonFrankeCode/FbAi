// Basketball and baseball checklists: their own folders, their own indexes.
//
// They are kept apart from football's public/data/checklists so the
// football-only builds (card index, landing pages, attribution, parallel
// spellings) never read another sport's cards. The browser finds a product's
// file from its id, which always ends in its sport, so an id and its folder
// must agree, and each index must be exactly the files beside it.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'public', 'data');

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

for (const sport of ['basketball', 'baseball']) {
  const dir = path.join(DATA, `checklists-${sport}`);
  if (!fs.existsSync(dir)) { check(`${sport}: folder exists`, false); continue; }
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && f !== 'index.json');
  const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8')).products || [];
  check(`${sport}: has checklists`, files.length > 0, `${files.length} products`);
  check(`${sport}: the index lists exactly the files`, index.length === files.length
    && index.every(p => files.includes(p.id + '.json')));

  const bad = [];
  let cards = 0;
  for (const f of files) {
    const doc = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const id = f.replace(/\.json$/, '');
    const Sport = sport[0].toUpperCase() + sport.slice(1);
    if (!id.endsWith(`-${sport}`)) bad.push(`${id}: id does not end in -${sport}`);
    if (doc.sport !== Sport) bad.push(`${id}: sport is ${doc.sport}`);
    // Basketball from 1948, baseball from the 1880s (pre-2000 files, Oct 2026).
    if (!(doc.year >= 1869 && doc.year <= 2026)) bad.push(`${id}: year ${doc.year}`);
    if (!new RegExp(`^${doc.year}(-\\d\\d)? `).test(doc.name)) bad.push(`${id}: name "${doc.name}" does not start with its year`);
    // An announced product whose checklist is not out yet has no sets, by design.
    if (!Array.isArray(doc.sets) || (!doc.sets.length && !doc.unreleased)) bad.push(`${id}: no sets`);
    for (const s of doc.sets || []) {
      if (!s.cards || !s.cards.length) bad.push(`${id}/${s.id}: empty set`);
      for (const c of s.cards || []) {
        cards++;
        if (!c.number || !c.player) { bad.push(`${id}/${s.id}: a card with no number or name`); break; }
      }
    }
  }
  check(`${sport}: every product is named, dated and filed for its sport, with no empty sets`, bad.length === 0, bad.slice(0, 5).join('; '));
  check(`${sport}: cards on file`, cards > 0, cards.toLocaleString('en-US') + ' cards');
}

// Parallels are what the rainbow is made of. A base set with none reads as a
// one-card rainbow: 2023-24 Prizm's base had none when one source's parallel
// lines ("Prizms Parallels: ...") went unread.
{
  const prizm = JSON.parse(fs.readFileSync(path.join(DATA, 'checklists-basketball', '2023-24-panini-prizm-basketball.json'), 'utf8'));
  const base = prizm.sets.find(s => s.category === 'base');
  check('2023-24 Prizm basketball lists its base parallels', base && base.parallels.length >= 50, base ? `${base.parallels.length} parallels` : 'no base set');
  let bases = 0, bare = 0;
  for (const f of fs.readdirSync(path.join(DATA, 'checklists-basketball')).filter(f => f.endsWith('-basketball.json'))) {
    // Since 2012 every major base set has a parallel rainbow. Many from the
    // 2000s had none at all (MLB Showdown, Heritage, Victory), so counting
    // those years would report a parsing gap that is not there.
    const doc = JSON.parse(fs.readFileSync(path.join(DATA, 'checklists-basketball', f), 'utf8'));
    if (doc.year < 2012) continue;
    for (const st of doc.sets) {
      if (st.category === 'base' && /^base$/i.test(st.name)) { bases++; if (!st.parallels.length) bare++; }
    }
  }
  check('  ...and most basketball base sets since 2012 list theirs', bases > 0 && bare / bases < 0.2, `${bare} of ${bases} base sets without parallels`);
}

// Football's folder holds football only: the football builds read all of it.
const football = JSON.parse(fs.readFileSync(path.join(DATA, 'checklists', 'index.json'), 'utf8')).products;
check('the football index holds no basketball or baseball products', !football.some(p => /-(basketball|baseball)$/.test(p.id) || (p.sport && p.sport !== 'Football')));

// Every index agrees with its files (the script checks all three folders).
let ok = true, out = '';
try { out = execFileSync('node', [path.join(ROOT, 'scripts', 'rebuild-checklist-index.js'), '--check'], { encoding: 'utf8' }); }
catch (e) { ok = false; out = e.stdout || ''; }
check('each sport\'s index is built from its files', ok && /checklists-basketball:/.test(out) && /checklists-baseball:/.test(out), ok ? '' : out.slice(-300));

// The player list search reads a listing's sport by is built from these files.
let pok = true, pout = '';
try { pout = execFileSync('node', [path.join(ROOT, 'scripts', 'build-sport-players.js'), '--check'], { encoding: 'utf8' }); }
catch (e) { pok = false; pout = e.stdout || ''; }
check('sport-players.json is built from the checklists as they are', pok, pok ? '' : pout);
{
  const players = JSON.parse(fs.readFileSync(path.join(DATA, 'sport-players.json'), 'utf8'));
  check('  ...it knows the stars, despite their multi-sport insert cards',
    players.basketball.includes('victor wembanyama') && players.basketball.includes('lebron james') && players.baseball.includes('shohei ohtani')
    && !players.basketball.includes('patrick mahomes') && !players.baseball.includes('patrick mahomes'));
}

// The guide pages (build-landing-pages.js, which CI runs before every deploy):
// each sport gets the three hubs football has, under its own prefix.
{
  const PUB = path.join(ROOT, 'public');
  if (!fs.existsSync(path.join(PUB, 'sets', 'index.html'))) {
    console.log('SKIP  guide pages — run `npm run build:pages` first (CI does)');
  } else {
    // The 4,000-page cap (owner, Oct 2026): each of the other sports keeps
    // its biggest players and their hub, and nothing else.
    const built = JSON.parse(fs.readFileSync(path.join(PUB, 'data', 'built-pages.json'), 'utf8'));
    for (const sport of ['basketball', 'baseball']) {
      const Sport = sport[0].toUpperCase() + sport.slice(1);
      const players = built.filter(p => p.startsWith(`/${sport}/players/`) && p !== `/${sport}/players/`);
      const hubFile = path.join(PUB, sport, 'players', 'index.html');
      check(`${sport}: a few hundred player guides and their hub, and no set or team pages`,
        fs.existsSync(hubFile) && fs.readFileSync(hubFile, 'utf8').includes(`${Sport} Card Player Price Guides`)
        && players.length >= 100 && players.length <= 200
        && !built.some(p => p.startsWith(`/${sport}/sets/`) || p.startsWith(`/${sport}/teams/`)), `${players.length} players`);
      const hub = fs.readFileSync(hubFile, 'utf8');
      const links = [...hub.matchAll(/href="(\/[^"]*)"/g)].map(m => m[1]).filter(h => /^\/(?:basketball|baseball)?\/?(?:sets|players|teams)\//.test(h) && !/\.css/.test(h));
      check(`  ...linking only to pages that exist in its own sport, with no ads or price blocks`,
        links.length > 50 && links.every(h => h.startsWith(`/${sport}/`) && built.includes(h))
        && !hub.includes('adsbygoogle') && !hub.includes('data-price-key'), links.filter(h => !built.includes(h)).slice(0, 3).join(' '));
    }
    check('the whole generated site is 4,000 pages at most', built.length <= 4000 && built.length > 3500, String(built.length));
    const locs = fs.readFileSync(path.join(PUB, 'sitemap.xml'), 'utf8').match(/<loc>[^<]+<\/loc>/g) || [];
    check('  ...and the sitemap lists only built pages', locs.length <= 4000 && locs.every(l => {
      const p = l.replace(/<\/?loc>/g, '').replace('https://thecardhuddle.com', '');
      return !/^(?:\/(?:basketball|baseball))?\/(?:sets|players|teams)\//.test(p) || built.includes(p);
    }), `${locs.length} URLs`);
    const someNba = built.find(p => /^\/basketball\/players\/./.test(p));
    check('  ...and the other sports\' player pages still say noindex', /content="noindex, follow"/.test(fs.readFileSync(path.join(PUB, someNba, 'index.html'), 'utf8')));
    const fb = fs.readFileSync(path.join(PUB, 'sets', 'index.html'), 'utf8');
    check('football\'s guides are unchanged by it', fb.includes('Football Card Checklists &amp; Price Guides') && !/href="\/(basketball|baseball)\//.test(fb));
  }
}

// The browser: a product's folder comes from its id; the list from the sport picked.
const js = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const start = js.indexOf('var CHECKLIST_DIRS');
const dirFor = new Function(`${js.slice(start, js.indexOf('async function fetchSportChecklists'))}; return _checklistDirFor;`)();
check('a product file is fetched from its sport\'s folder', dirFor('2023-24-panini-prizm-basketball') === '/data/checklists-basketball'
  && dirFor('2024-topps-chrome-baseball') === '/data/checklists-baseball' && dirFor('2024-panini-prizm-football') === '/data/checklists');
check('the checklist list loads the picked sport', /const data = await fetchSportChecklists\(sport\);/.test(js)
  && /if \(_checklistListSport !== sport\) return;/.test(js));
check('the football-only features keep reading football', /async function fetchChecklistsList\(\) \{\s*if \(_checklistsIndexCache\) return _checklistsIndexCache;\s*_checklistsIndexCache = await _fetchJson\('\/data\/checklists\/index\.json'/.test(js));

// A checklist fixed on the server shows on the next visit. The service worker
// served checklists stale-while-revalidate, and its VERSION hashes only the
// index, so 2024 Topps Chrome's refilled parallels stayed hidden behind the
// copy each visitor had cached.
{
  const sw = fs.readFileSync(path.join(ROOT, 'public', 'sw.js'), 'utf8');
  check('checklist files are fetched fresh, the cached copy only offline or on a slow line',
    /if \(url\.pathname\.startsWith\('\/data\/'\)\) \{\s*event\.respondWith\(networkFirstData\(req\)\);/.test(sw)
      && /async function networkFirstData\(req\)[\s\S]{0,400}cache\.match\(req\)/.test(sw));
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall sport-checklist checks passed');
process.exit(failures ? 1 : 0);
