// Page titles at 70 characters at most (owner, Nov 2026), as the reader sees
// them: every generated page (when built), the hand-written pages, and the
// news pages' cut.
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
let failures = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`); if (!ok) failures++; };
const decode = (s) => s.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const titleOf = (f) => { const m = fs.readFileSync(f, 'utf8').match(/<title>([\s\S]*?)<\/title>/); return m ? decode(m[1].trim()) : null; };

const files = [];
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name === 'index.html') files.push(p); } };
for (const d of ['sets', 'players', 'teams', 'basketball', 'baseball']) if (fs.existsSync(path.join(ROOT, 'public', d))) walk(path.join(ROOT, 'public', d));
if (files.length) {
  const long = files.map(f => [f, titleOf(f)]).filter(([, t]) => t && t.length > 70);
  check(`every generated page's title fits in 70 characters (${files.length} pages)`, long.length === 0, long.slice(0, 3).map(([f, t]) => `${t.length} ${t}`).join(' | '));
} else console.log('SKIP  generated pages: run npm run build:pages first (CI does)');
const hand = fs.readdirSync(path.join(ROOT, 'public')).filter(f => f.endsWith('.html')).map(f => [f, titleOf(path.join(ROOT, 'public', f))]).filter(([, t]) => t && t.length > 70);
check('every hand-written page\'s title fits in 70 characters', hand.length === 0, hand.map(([f, t]) => `${f}: ${t.length}`).join(', '));

const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const fit = new Function(src.slice(src.indexOf('function _fitTitle('), src.indexOf('function newsShell(')) + '; return _fitTitle;')();
const a = fit('How to tell a real 2024 Prizm Bo Nix Silver from a fake one, step by step · The Card Huddle');
check('a long news title drops the site name, then cuts at a word', a.length <= 70 && !/The Card Huddle/.test(a) && a.endsWith('…'), `${a.length} ${a}`);
check('a short one keeps everything', fit('Market Movers · The Card Huddle') === 'Market Movers · The Card Huddle');

console.log(failures ? `\n${failures} title check(s) failed` : '\nall title checks passed');
process.exit(failures ? 1 : 0);
