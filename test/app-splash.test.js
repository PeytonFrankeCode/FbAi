// The home-screen app opens on a launch screen; the website never does
// (owner, Oct 2026). A visitor from search must not wait on a splash, and an
// installed app must not start on a white screen.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'manifest.json'), 'utf8'));
const head = html.slice(0, html.indexOf('</head>'));

check('the splash is switched on only when opened from the home screen',
  /matchMedia\('\(display-mode: standalone\)'\)\.matches\) \|\| navigator\.standalone === true;\s*if \(!app\) return;/.test(head)
  && /#app-splash \{ display: none; \}/.test(head) && /\.app-launch #app-splash \{/.test(head));
check('  ...decided before anything paints: the script comes before every stylesheet and script tag',
  head.indexOf("display-mode: standalone") < head.indexOf('<link rel="stylesheet"') && head.indexOf("display-mode: standalone") < head.indexOf('adsbygoogle'));
check('  ...and its picture is a CSS background, so the website never downloads it',
  /\.as-tile \{[^}]*background: #fff url\(\/icon-512\.png/.test(head) && !/<img[^>]+app-splash/.test(html));
check('it leaves once app.js has run, never under 0.7 s, never over 2.5 s',
  /Math\.max\(0, 700 - \(Date\.now\(\) - t0\)\)/.test(head) && /setTimeout\(window\.__appSplashDone, 2500\)/.test(head)
  && html.indexOf('window.__appSplashDone && window.__appSplashDone()') > html.search(/<script src="app\.js\?v=/));
check('  ...and is removed from the page, not just hidden', /var el = document\.getElementById\('app-splash'\); if \(el\) el\.remove\(\);/.test(head));
check('the splash background is the manifest\'s, so Android\'s own splash and ours match',
  manifest.background_color === '#0c0e14' && /\.app-launch #app-splash \{[^}]*background: #0c0e14/.test(head));

const links = [...head.matchAll(/<link rel="apple-touch-startup-image" href="\/splash\/(launch-(\d+)x(\d+)\.png)" media="\(device-width: (\d+)px\) and \(device-height: (\d+)px\) and \(-webkit-device-pixel-ratio: (\d)\)/g)];
check('iPhones get launch images, one per screen in use', links.length >= 10, `${links.length} screens`);
const bad = links.filter(m => {
  const f = path.join(ROOT, 'public', 'splash', m[1]);
  return !fs.existsSync(f) || +m[2] !== m[4] * m[6] || +m[3] !== m[5] * m[6];
});
check('  ...each one present and exactly its screen\'s pixels', bad.length === 0, bad.map(m => m[1]).join(', '));
{
  // PNG width and height sit at bytes 16-23.
  const f = links[0] && fs.readFileSync(path.join(ROOT, 'public', 'splash', links[0][1]));
  check('  ...and the file really is that size', f && f.readUInt32BE(16) === +links[0][2] && f.readUInt32BE(20) === +links[0][3]);
}
console.log(failures ? `\n${failures} check(s) failed` : '\nall app-splash checks passed');
process.exit(failures ? 1 : 0);
