#!/usr/bin/env node
/**
 * Print how checklistinsider.com writes parallels on a few product pages, so
 * the importer's parallel reading can be checked against the real markup.
 *
 *   node scripts/peek-checklistinsider.js inception midnight holiday
 *
 * Each word is matched against the football sitemap's page URLs. For each
 * page found: where the "Checklist" tab starts, then every place the word
 * "parallel" appears, as raw HTML and as the importer's decoded text, and
 * what parsePage made of the first sets.
 */
'use strict';
const { parsePage } = require('./import-checklistinsider');

const SITE = 'https://www.checklistinsider.com';
const get = async (u) => {
  const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0 (TheCardHuddle checklist sync)' } });
  if (!r.ok) throw new Error(`${u}: HTTP ${r.status}`);
  return r.text();
};
const decode = (s) => String(s).replace(/<br\s*\/?>|<\/?(?:div|p|li|ul|ol)[^>]*>/gi, '\n').replace(/<[^>]+>/g, '')
  .replace(/&nbsp;| /g, ' ').replace(/&amp;/g, '&').replace(/&#8211;/g, '-');

(async () => {
  const words = process.argv.slice(2).map(w => w.toLowerCase());
  const index = await get(`${SITE}/sitemap_index.xml`);
  const maps = [...index.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
  const urls = [];
  for (const m of maps) {
    const xml = await get(m);
    for (const [, u] of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) if (/football/.test(u)) urls.push(u);
  }
  for (const w of words) {
    const hits = urls.filter(u => u.toLowerCase().includes(w) && /202[5-6]/.test(u)).slice(0, 2);
    if (!hits.length) { console.log(`\n### ${w}: no football page`); continue; }
    for (const u of hits) {
      const html = await get(u);
      console.log(`\n\n### ${u}  (${html.length} chars)`);
      const tab = html.search(/<h2[^>]*>[^<]*Checklist<\/h2>\s*<\/p>\s*<h2>/i);
      console.log(`Checklist tab regex at: ${tab}; "Base Checklist" at: ${html.indexOf('Base Checklist')}`);
      let n = 0;
      for (const m of html.matchAll(/parallel/gi)) {
        if (n++ >= 6) break;
        const at = m.index;
        console.log(`\n--- "parallel" #${n} at ${at} — raw HTML:`);
        console.log(html.slice(Math.max(0, at - 300), at + 700));
        console.log(`--- decoded:`);
        console.log(decode(html.slice(Math.max(0, at - 300), at + 700)).split('\n').filter(l => l.trim()).slice(0, 25).join('\n'));
      }
      const sets = parsePage(html);
      console.log(`\nparsePage: ${sets.length} sets; with parallels: ${sets.filter(s => s.parallels.length).length}`);
      for (const s of sets.slice(0, 4)) console.log(`  ${s.name}: ${s.cards.length} cards, parallels ${JSON.stringify(s.parallels.slice(0, 5))}`);
    }
  }
})().catch(e => { console.error(e); process.exit(1); });
