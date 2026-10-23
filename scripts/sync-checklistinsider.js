#!/usr/bin/env node
/**
 * Which football, baseball and basketball checklists has checklistinsider.com
 * published or added to since we took ours, and bring them in.
 *
 *   node scripts/sync-checklistinsider.js            # report only
 *   node scripts/sync-checklistinsider.js --write    # and write the files
 *
 * The site's sitemap lists every product page with when it last changed. A
 * page newer than our file (or with no file of ours) is read with
 * import-checklistinsider.js's parser and compared with what we hold:
 *
 *   new product   no file of ours has its year and most of its players: added.
 *   placeholder   our file is an "unreleased" stub and the page now has cards:
 *                 replaced.
 *   same product  added to, never rewritten. Our sets, names, parallels and
 *                 cards all stay. A set of theirs is NEW when under 20% of its
 *                 cards (number + player) are anywhere in ours, and appended;
 *                 it is OURS when over 80% are, and only its missing cards go
 *                 into the set of ours that holds the rest. In between is
 *                 reported and left alone. Names are not compared: the two
 *                 sources name one set differently ("Base Autographs" and
 *                 "Autographs") and matching on names would duplicate sets.
 *
 * Our files came from several sources and other naming habits ("2024 Topps
 * Inception MLB", "Bowman Best University"), so a product is matched to ours
 * by its players within the same year, not by its URL.
 *
 *   parallels     a set of ours with no parallels takes theirs, and so does
 *                 one we built from this site whose list is shorter than
 *                 theirs (the old reader kept only a list's first line).
 *                 Nothing else in the set changes.
 *
 *   node scripts/sync-checklistinsider.js --parallels[=2024] --write
 *                 also re-reads pages that have not changed, for products
 *                 from that year on that hold a set with no parallels, so
 *                 lists the old reader missed are filled.
 *
 * After --write: node scripts/rebuild-checklist-index.js,
 * npm run checklist:validate, npm run build:card-index, then the tests.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { parsePage } = require('./import-checklistinsider');

const ROOT = path.join(__dirname, '..');
const SITE = 'https://www.checklistinsider.com';
const SPORTS = { football: ['checklists', 'Football'], baseball: ['checklists-baseball', 'Baseball'], basketball: ['checklists-basketball', 'Basketball'] };
const WRITE = process.argv.includes('--write');
// --parallels[=YEAR]: re-read unchanged pages of products from YEAR on that
// hold a set with no parallels.
const PAR_ARG = process.argv.find(a => a.startsWith('--parallels'));
const PAR_FROM = PAR_ARG ? Number(PAR_ARG.split('=')[1]) || 2024 : null;
const CACHE = process.env.CI_CACHE || path.join(require('os').tmpdir(), 'checklistinsider-cache');
// Pages that are not card checklists (names with no card numbers), and
// pages whose list contradicts ours too much to merge by machine (2024
// Immaculate: our base set is 30 cards numbered 1, 2, 3, 94...; theirs 1-70).
const SKIP = new Set(['2024-panini-immaculate-collection-football','2024-topps-archives-signature-series-active-baseball', '2024-topps-archives-signature-series-retired-baseball',
  '2025-topps-t205-baseball', '2024-topps-206-baseball']);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function get(url, file) {
  const f = path.join(CACHE, file);
  if (fs.existsSync(f) && Date.now() - fs.statSync(f).mtimeMs < 6 * 3600e3) return fs.readFileSync(f, 'utf8');
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (TheCardHuddle checklist sync)' } });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  const t = await r.text();
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(f, t);
  await sleep(600);
  return t;
}

const npl = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/\b(jr|sr|ii|iii|iv)\b/g, '').replace(/[^a-z]+/g, '');
const nnum = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '').replace(/^0+(?=\d)/, '');
const cardKey = (c) => `${nnum(c.number)}|${npl(c.player)}`;
const count = (sets) => (sets || []).reduce((a, s) => a + (s.cards || []).length, 0);
const lacksParallels = (doc) => (doc.sets || []).some(s => !(s.parallels || []).length);
// Their parallel list for a set of ours: when ours has none, or when we built
// ours from this site and theirs is longer. Returns how many were added.
function fillParallels(ours, theirs, fromHere) {
  const tp = (theirs.parallels || []), op = (ours.parallels || []);
  if (!tp.length || (op.length && !(fromHere && tp.length > op.length))) return 0;
  ours.parallels = tp.map(x => ({ ...x }));
  return tp.length - op.length;
}

// The page's own title names the product, year included where the URL has none.
function productName(html, slug) {
  const t = ((html.match(/<title>([^<]*)/) || [])[1] || '').replace(/&amp;/g, '&').replace(/&#8217;|&#039;|&#39;|&rsquo;/g, "'");
  const name = t.split(/\s+(?:Checklist|Set Checklist|Guide)\b/)[0].trim();
  return name || slug.replace(/-/g, ' ');
}
const brandOf = (name) => name.replace(/^\d{4}(-\d{2})?\s+/, '').replace(/\s+(Football|Baseball|Basketball)$/i, '').trim();
const slugify = (s) => String(s).toLowerCase().replace(/'/g, '').replace(/&/g, ' ').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
// The words that tell one product from another in a URL or file name. Brands,
// sports and filler say nothing ("2026 Topps Flagship" is our "2026 Topps").
const GENERIC = new Set(['topps', 'panini', 'bowman', 'bowmans', 'donruss', 'upper', 'deck', 'leaf', 'football', 'baseball',
  'basketball', 'the', 'of', 'and', 'x', 's', 'series', 'flagship', 'set', 'mlb', 'nba', 'nfl', 'collection', 'edition', 'box']);
const DIGIT_WORD = { 1: 'one', 2: 'two', 3: 'three', 4: 'four', 5: 'five' };
const WORD_ALIAS = { ote: ['overtime', 'elite'], u: ['university'] };
const nameWords = (id) => new Set(String(id).replace(/^\d{4}(-\d{2})?-/, '').split('-')
  .flatMap(w => WORD_ALIAS[w] || [DIGIT_WORD[w] || w.replace(/s$/, '')])
  .filter(w => w && !GENERIC.has(w) && !/^\d+$/.test(w)));
const normId = (s) => s.replace(/-s-/g, 's-').replace(/-and-/g, '-').replace(/-x-/g, '-');
// The site's per-team lists repeat cards already in the sets.
const TEAM_LIST = /\bteam set lists?\b|\bteam checklists?\b/i;

// Some pages list cards with no team ("1 Breanna Stewart" on a one-school
// set). The parser needs " - Team"; read those lines here when it found none.
function parseLoose(html) {
  const sets = parsePage(html.replace(/(<\/h3>[\s\S]*?)(?=<h[23]|$)/g, (blk) => blk.replace(
    /(^|\n|<br\s*\/?>|<p>)\s*((?:NNO|[A-Za-z]{0,4}-?\d+[A-Za-z]?))\s+([A-Z][^<\n-]+?)\s*(?=<br|<\/p>|\n)/g,
    (m, pre, num, who) => `${pre}${num} ${who.trim()} - ` + '—')));
  for (const s of sets) for (const c of s.cards) if (c.team === '—') c.team = '';
  return sets;
}

(async () => {
  const sm = (await get(`${SITE}/post-sitemap.xml`, 'post-sitemap.xml')) + (await get(`${SITE}/post-sitemap2.xml`, 'post-sitemap2.xml'));
  const posts = sm.split('<url>').slice(1).map(b => ({
    slug: ((b.match(/<loc>([^<]*)<\/loc>/) || [])[1] || '').replace(SITE + '/', '').replace(/\/$/, ''),
    mod: (b.match(/<lastmod>([^<]*)<\/lastmod>/) || [])[1] || '',
  })).filter(p => p.slug);
  const summary = [];

  for (const [sport, [dir, sportName]] of Object.entries(SPORTS)) {
    const DIR = path.join(ROOT, 'public', 'data', dir);
    const files = fs.readdirSync(DIR).filter(f => f.endsWith('.json') && f !== 'index.json');
    const ours = new Map(files.map(f => [f.slice(0, -5), null]));
    const byNorm = new Map([...ours.keys()].map(id => [normId(id), id]));
    const load = (id) => ours.get(id) || ours.set(id, JSON.parse(fs.readFileSync(path.join(DIR, id + '.json'), 'utf8'))).get(id);
    const mtime = (id) => { try { return fs.statSync(path.join(DIR, id + '.json')).mtime.toISOString(); } catch (_) { return ''; } };
    let since = '';
    try { since = require('child_process').execSync(`git -C ${ROOT} log -1 --format=%cI -- public/data/${dir}`).toString().trim(); } catch (_) {}

    for (const p of posts.filter(x => x.slug.endsWith('-' + sport) && !SKIP.has(x.slug))) {
      const direct = ours.has(p.slug) ? p.slug : byNorm.get(normId(p.slug)) || null;
      // Only pages that changed since we last touched that sport's files, or
      // that we have no file for.
      const yearOf = Number((p.slug.match(/^(\d{4})/) || [])[1]) || 0;
      const recheck = PAR_FROM && yearOf >= PAR_FROM && (!direct || lacksParallels(load(direct)));
      if (direct && p.mod <= (since || mtime(direct)) && !recheck) continue;
      // Catch-up runs read only recent products' pages.
      if (!direct && PAR_FROM && p.mod <= since && !(yearOf >= PAR_FROM)) continue;
      const html = await get(`${SITE}/${p.slug}`, p.slug + '.html');
      let sets = parsePage(html);
      if (!sets.length) sets = parseLoose(html);
      // A set whose "numbers" are mostly years was a list of other products'
      // cards ("2022 Flawless Collegiate - Player"), not a set.
      const yearly = (st) => st.cards.filter(c => /^(19|20)\d\d$/.test(String(c.number))).length > st.cards.length / 2;
      sets = sets.filter(st => !TEAM_LIST.test(st.name) && !yearly(st));
      if (!sets.length) { summary.push({ sport, slug: p.slug, action: 'not published yet' }); continue; }
      const name = productName(html, p.slug);
      const year = (name.match(/^\d{4}(-\d{2})?/) || [''])[0];
      // Ours: by URL, or the file of that year holding most of its players.
      let id = direct, best = 0;
      const pw = nameWords(p.slug);
      if (!id) {
        const players = new Set(sets.flatMap(s => s.cards.map(c => npl(c.player))).filter(Boolean));
        for (const f of ours.keys()) {
          if (!year || !f.startsWith(year.slice(0, 4))) continue;
          const fw = nameWords(f);
          // Same distinctive words both ways round: "Bowman University Best"
          // is not "Bowman", though most of its players are.
          if (![...pw].some(w => fw.has(w)) || !([...fw].every(w => pw.has(w)) || [...pw].every(w => fw.has(w)))) continue;
          const d = load(f);
          const op = new Set((d.sets || []).flatMap(s => (s.cards || []).map(c => npl(c.player))));
          let hit = 0; for (const x of players) if (op.has(x)) hit++;
          const share = players.size ? hit / players.size : 0;
          // Most of its players, and a product of a like size: two products
          // of one year share their stars.
          const sizeOk = count(d.sets) >= 0.5 * count(sets) && count(d.sets) <= 2.5 * count(sets);
          if (share >= 0.75 && sizeOk && share > best) { best = share; id = f; }
        }
      }
      if (!id) {
        const nid = /^\d{4}/.test(p.slug) ? p.slug : `${slugify(year)}-${p.slug}`;
        if (ours.has(nid)) { summary.push({ sport, slug: p.slug, action: `skipped: ${nid} exists but does not match` }); continue; }
        const doc = { id: nid, name, year: Number(year.slice(0, 4)), brand: brandOf(name), sport: sportName,
          note: 'Built from the published checklist at checklistinsider.com.', sets };
        summary.push({ sport, slug: p.slug, action: 'new', id: nid, sets: sets.length, cards: count(sets) });
        if (WRITE) fs.writeFileSync(path.join(DIR, nid + '.json'), JSON.stringify(doc, null, 2) + '\n');
        ours.set(nid, doc);
        continue;
      }
      const doc = load(id);
      if (doc.unreleased || !count(doc.sets)) {
        const next = { ...doc, sets, note: 'Built from the published checklist at checklistinsider.com.' };
        delete next.unreleased;
        summary.push({ sport, slug: p.slug, action: 'filled placeholder', id, sets: sets.length, cards: count(sets) });
        if (WRITE) fs.writeFileSync(path.join(DIR, id + '.json'), JSON.stringify(next, null, 2) + '\n');
        ours.set(id, next);
        continue;
      }
      // Same product: add what we lack, by cards.
      const where = new Map();
      (doc.sets || []).forEach((s, i) => (s.cards || []).forEach(c => where.set(cardKey(c), i)));
      const addSets = [], addCards = [], unsure = [];
      // Parallels for sets of ours, worked on a copy so a product left for
      // review is not half-changed.
      const fromHere = /checklistinsider/i.test(String(doc.note || ''));
      const parSets = (doc.sets || []).map(s => ({ ...s }));
      let nPar = 0, setsPar = 0;
      const givePar = (i, s) => { const n = fillParallels(parSets[i], s, fromHere); if (n > 0) { nPar += n; setsPar++; } };
      for (const s of sets) {
        const keys = s.cards.map(cardKey);
        const held = keys.filter(k => where.has(k));
        const share = keys.length ? held.length / keys.length : 1;
        if (share < 0.2) addSets.push(s);
        else if (share > 0.8) {
          const votes = {}; for (const k of held) votes[where.get(k)] = (votes[where.get(k)] || 0) + 1;
          const into = Number(Object.entries(votes).sort((a, b) => b[1] - a[1])[0][0]);
          // The set of ours holding nearly all its cards is the same set.
          if (held.length >= 0.8 * (doc.sets[into].cards || []).length || held.length === keys.length) givePar(into, s);
          if (held.length === keys.length) continue;
          const have = new Set((doc.sets[into].cards || []).map(c => nnum(c.number)));
          const extra = s.cards.filter(c => !where.has(cardKey(c)) && !have.has(nnum(c.number)));
          if (extra.length) addCards.push({ into, set: doc.sets[into].name, cards: extra });
        } else {
          // Partly held: only into a set of ours of the same name, and only
          // cards whose number that set does not have.
          const twin = (doc.sets || []).findIndex(o => slugify(o.name) === slugify(s.name));
          if (twin >= 0) {
            givePar(twin, s);
            const have = new Set((doc.sets[twin].cards || []).map(c => nnum(c.number)));
            const extra = s.cards.filter(c => !where.has(cardKey(c)) && !have.has(nnum(c.number)));
            if (extra.length) addCards.push({ into: twin, set: doc.sets[twin].name, cards: extra });
          } else unsure.push(`${s.name} (${Math.round(share * 100)}% held)`);
        }
      }
      // A set name of theirs that is already a set of ours gets a suffix, so
      // ids stay unique.
      const ids = new Set((doc.sets || []).map(s => s.id));
      for (const s of addSets) { let sid = s.id, n = 2; while (ids.has(sid)) sid = `${s.id}-${n++}`; s.id = sid; ids.add(sid); }
      const nAdd = count(addSets) + addCards.reduce((a, x) => a + x.cards.length, 0);
      if (!nAdd && !unsure.length && !nPar) { summary.push({ sport, slug: p.slug, action: `matches ${id}, nothing new` }); continue; }
      // When a quarter of their sets match none of ours either way, the two
      // lists disagree too much to merge by machine.
      if (unsure.length > 0.25 * sets.length || nAdd > 0.45 * count(doc.sets)) {
        summary.push({ sport, slug: p.slug, action: `needs review: ${id} would gain ${nAdd} cards (${unsure.length} of ${sets.length} of their sets only partly match)` });
        continue;
      }
      summary.push({ sport, slug: p.slug, action: 'added to', id, newSets: addSets.length, newCards: nAdd,
        sample: [...addSets.slice(0, 3).map(s => s.name), ...addCards.slice(0, 2).map(x => `+${x.cards.length} in ${x.set}`)],
        unsure, nPar, setsPar });
      if (WRITE && (nAdd || nPar)) {
        doc.sets = parSets;
        for (const x of addCards) {
          const set = doc.sets[x.into];
          set.cards = [...set.cards, ...x.cards];
          if (set.totalCards != null && set.totalCards < set.cards.length) set.totalCards = set.cards.length;
        }
        doc.sets = [...doc.sets, ...addSets];
        fs.writeFileSync(path.join(DIR, id + '.json'), JSON.stringify(doc, null, 2) + '\n');
      }
    }
  }

  for (const s of summary) {
    const what = s.action === 'added to'
      ? `added to ${s.id}: ${s.newSets} new sets, ${s.newCards} cards${s.nPar ? `, ${s.nPar} parallels on ${s.setsPar} sets` : ''}${s.sample.length ? ' (' + s.sample.join('; ') + ')' : ''}${s.unsure.length ? ` | left alone: ${s.unsure.slice(0, 4).join(', ')}${s.unsure.length > 4 ? ` +${s.unsure.length - 4}` : ''}` : ''}`
      : s.id ? `${s.action} ${s.id}: ${s.sets} sets, ${s.cards} cards` : s.action;
    console.log(`${s.sport.padEnd(10)} ${s.slug.padEnd(54)} ${what}`);
  }
  console.log(WRITE ? '\nwritten. Next: node scripts/rebuild-checklist-index.js && npm run checklist:validate && npm run build:card-index'
                    : '\nreport only; --write to apply');
})().catch(e => { console.error(e); process.exit(1); });
