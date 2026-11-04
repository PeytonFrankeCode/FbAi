// Mobile speed (owner, Nov 2026: PageSpeed mobile 69): the deploy minifies the
// app's script and stylesheets, the fonts do not block the first paint, the
// versioned scripts are cached for good, and the first market photos (the
// largest thing on a phone's first screen) load at once, not lazily.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
let failures = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`); if (!ok) failures++; };

const deploy = read('.github/workflows/deploy.yml');
const test = deploy.indexOf('- name: Test'), min = deploy.indexOf('- name: Minify app.js'), ship = deploy.indexOf('- name: Deploy to Cloudflare Workers');
check('the deploy minifies after the tests and before shipping', test > 0 && min > test && ship > min);
// The minified app must keep its top-level functions: the page's inline
// onclick handlers call them by name.
let ok = false, detail = '';
try {
  const m = require('esbuild').transformSync(read('public/app.js'), { minify: true, target: 'es2020', logLevel: 'error' }).code;
  const html = read('public/index.html');
  const called = [...new Set([...html.matchAll(/on(?:click|change|input|submit|keydown)="([A-Za-z_$][\w$]*)\(/g)].map(x => x[1]))].filter(n => !['if', 'return', 'event', 'this', 'window', 'document', 'history', 'location'].includes(n));
  const missing = called.filter(n => !new RegExp(`function ${n.replace(/\$/g, '\\$')}\\(|\\b${n.replace(/\$/g, '\\$')}\\s*=`).test(m));
  ok = called.length > 20 && missing.length === 0;
  detail = `${called.length} handler names, missing: ${missing.join(', ') || 'none'}; ${fs.statSync(path.join(ROOT, 'public', 'app.js')).size} -> ${m.length} bytes`;
} catch (e) { detail = String(e.message).slice(0, 200); }
check('minifying keeps every function the page\'s buttons call', ok, detail);

const html = read('public/index.html');
check('Google Fonts load without blocking the first paint', /href="https:\/\/fonts\.googleapis\.com\/css2[^"]*" rel="stylesheet" media="print" onload="this\.media='all'"/.test(html) && /<noscript><link href="https:\/\/fonts\.googleapis\.com/.test(html));
const headers = read('public/_headers');
check('the versioned scripts are cached for good', /\/app\.js\n  Cache-Control: public, max-age=31536000, immutable/.test(headers) && /\/bounties\.js\n  Cache-Control: public, max-age=31536000, immutable/.test(headers));
const app = read('public/app.js');
check('the first market photos load at once, the rest lazily, all with a size', /let eager = 3;/.test(app) && /\(eager-- > 0 \? 'fetchpriority="high"' : 'loading="lazy"'\)/.test(app) && /width="120" height="160"/.test(app));

check('the default market boards are asked for from the head, and used once by app.js',
  /window\.__mpEarly=fetch\('\/api\/sold-stats\?days=30'/.test(html) && /if \(period === 30 && sp === 'football' && window\.__mpEarly\)/.test(app) && /window\.__mpEarly = null;/.test(app));
check('eBay\'s image host is connected to early', /<link rel="preconnect" href="https:\/\/i\.ebayimg\.com"/.test(html));

console.log(failures ? `\n${failures} mobile-speed check(s) failed` : '\nall mobile-speed checks passed');
process.exit(failures ? 1 : 0);
