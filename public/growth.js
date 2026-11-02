// Where this visit came from (owner, Nov 2026): a ?ref= or utm_source= link
// names its source (a creator, a post); otherwise the referring site's kind.
// One count per browser tab session, sent to /api/growth/visit. The named
// source is remembered for 30 days so an account made later can claim it
// (window.chGrowthRef, read by app.js when a sign-in lands).
(function () {
  var KEY = 'chRef', DAYS = 30;
  function norm(s) {
    return String(s || '').toLowerCase().trim().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  }
  function stored() {
    try {
      var v = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (v && v.s && Date.now() - v.t < DAYS * 86400000) return v.s;
    } catch (_) {}
    return '';
  }
  window.chGrowthRef = stored;
  var src = '';
  try {
    var p = new URLSearchParams(location.search);
    src = norm(p.get('ref') || p.get('utm_source') || '');
  } catch (_) {}
  // First named source wins for 30 days: the creator who brought someone in
  // keeps the credit if they come back later through a search.
  if (src && !stored()) { try { localStorage.setItem(KEY, JSON.stringify({ s: src, t: Date.now() })); } catch (_) {} }
  if (!src) {
    var h = '';
    try { h = document.referrer ? new URL(document.referrer).hostname : ''; } catch (_) {}
    if (h === location.hostname) return;   // moving around the site, already counted
    src = !h ? 'org-direct'
      : /(^|\.)(google|bing|duckduckgo|yahoo|ecosia|brave|yandex|baidu)\./.test(h) ? 'org-search'
      : /(facebook|fb\.|instagram|(^|\.)t\.co$|twitter|(^|\.)x\.com$|reddit|tiktok|youtube|threads|pinterest|discord)/.test(h) ? 'org-social'
      : 'org-other';
  }
  try { if (sessionStorage.getItem('chRefSeen')) return; sessionStorage.setItem('chRefSeen', src); } catch (_) {}
  try {
    var d = JSON.stringify({ src: src });
    if (!(navigator.sendBeacon && navigator.sendBeacon('/api/growth/visit', new Blob([d], { type: 'application/json' })))) {
      fetch('/api/growth/visit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: d, keepalive: true }).catch(function () {});
    }
  } catch (_) {}
})();
