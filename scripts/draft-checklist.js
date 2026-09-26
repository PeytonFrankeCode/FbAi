#!/usr/bin/env node
/**
 * Draft a checklist for a product we hold none for, from our own sales.
 *
 * A third of sales are filed under products with no checklist (2025 Topps
 * Chrome Black, 2026 Wild Card, 1986 Topps...). This asks the live site which
 * player each card number's sales name (/api/debug/observed-checklist) and
 * writes a DRAFT for a person to check against the real checklist:
 *
 *   ADMIN_KEY=... node scripts/draft-checklist.js --year 1986 --set "topps" \
 *       --name "1986 Topps Football" [--brand "Topps"] [--site https://thecardhuddle.com]
 *
 * Writes checklist-drafts/<id>.json — outside public/, so nothing is served
 * or matched against until a person has checked it and moved it into
 * public/data/checklists/ (then add it to index.json and run
 * `npm run build:card-index`).
 *
 * In the draft, `cards` holds only numbers where 3+ sales agree 80%+ on the
 * player; every other number is under `review.uncertain` with the names the
 * sales disagreed between. Inserts and parallels are not separated — sales
 * of an insert often carry its own number — so the draft is the base set as
 * sales see it, plus `review.parallelsSeen` as hints, not a parallel list.
 */
const fs = require('fs');
const path = require('path');

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// Kept pure for the test: the endpoint's answer in, the draft document out.
function buildDraft(obs, { year, name, brand }) {
  const id = slug(name);
  const sure = (obs.cards || []).filter(c => c.confident);
  return {
    id, name, year: Number(year), brand, sport: 'Football',
    draft: true,
    source: `Drafted ${new Date().toISOString().slice(0, 10)} from sales (${obs.set}), not from the manufacturer. Check every card before moving this into public/data/checklists/.`,
    sets: [{
      id: 'base', name: 'Base', category: 'base', totalCards: sure.length,
      parallels: [],
      cards: sure.map(c => ({ number: c.number, player: c.player })),
    }],
    review: {
      uncertain: (obs.cards || []).filter(c => !c.confident)
        .map(c => ({ number: c.number, player: c.player, sales: c.sales, agreement: c.agreement, alternatives: c.alternatives })),
      parallelsSeen: obs.parallelsSeen || [],
    },
  };
}

module.exports = { buildDraft };
if (require.main !== module) return;

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const year = arg('year');
const set = arg('set');
const name = arg('name', year && set ? `${year} ${set.replace(/\b\w/g, c => c.toUpperCase())} Football` : null);
const brand = arg('brand', set ? set.replace(/\b\w/g, c => c.toUpperCase()) : null);
const site = arg('site', 'https://thecardhuddle.com');
const key = process.env.ADMIN_KEY;

if (!year || !set || !key) {
  console.error('usage: ADMIN_KEY=... node scripts/draft-checklist.js --year 1986 --set "topps" --name "1986 Topps Football"');
  process.exit(1);
}

(async () => {
  const url = `${site}/api/debug/observed-checklist?year=${encodeURIComponent(year)}&set=${encodeURIComponent(set)}`;
  const res = await fetch(url, { headers: { 'x-admin-key': key } });
  const obs = await res.json().catch(() => null);
  if (!res.ok || !obs || !obs.available) {
    console.error('failed:', res.status, obs && (obs.error || obs.reason));
    process.exit(1);
  }
  const draft = buildDraft(obs, { year, name, brand });
  const dir = path.join(__dirname, '..', 'checklist-drafts');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${draft.id}.json`);
  fs.writeFileSync(file, JSON.stringify(draft, null, 2) + '\n');
  console.log(`${file}\n  ${draft.sets[0].cards.length} confident cards, ${draft.review.uncertain.length} to review, ${draft.review.parallelsSeen.length} parallel names seen`);
})().catch(e => { console.error(e); process.exit(1); });
