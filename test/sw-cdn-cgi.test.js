// The service worker must never answer Cloudflare's own paths (/cdn-cgi/):
// a "Verifying you are human" challenge served stale cached scripts never
// completes and the page sits frozen (owner, Nov 2026).
'use strict';
const fs = require('fs');
const path = require('path');
const sw = fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8');
const i = sw.indexOf("addEventListener('fetch'");
const cdn = sw.indexOf("url.pathname.startsWith('/cdn-cgi/')) return;");
const respond = sw.indexOf('event.respondWith', i);
const ok = i > 0 && cdn > i && cdn < respond;
console.log(`${ok ? 'PASS' : 'FAIL'}  the service worker leaves /cdn-cgi/ (Cloudflare's challenge) to the network, before any respondWith`);
console.log(ok ? '\nall sw-cdn-cgi checks passed' : '\n1 sw-cdn-cgi check(s) failed');
process.exit(ok ? 0 : 1);
