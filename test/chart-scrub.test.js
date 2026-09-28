// Charts on touch screens, and the card history's loading state.
//
// Tapping an exact point was the only way to read a chart on a phone, and it
// mostly missed. A finger dragged across a chart now scrubs: a dot and guide
// line follow it and the readout updates. Checked in a real browser with
// touch input when this was built: a sideways drag drifting 45px down moved
// neither the page nor a scrolling modal, and a swipe up still scrolled
// whichever held the chart. This holds the wiring.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

const src = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');
const fn = src.slice(src.indexOf('function attachPointReadout('), src.indexOf('function _scrollParent('));

check('a finger drag scrubs the chart, handled here rather than by the browser',
  /addEventListener\('touchmove'/.test(fn) && /passive: false/.test(fn) && /e\.preventDefault\(\)/.test(fn));
check('  ...the page is held still while scrubbing (pan-y let a slightly diagonal drag scroll it)',
  /touchAction = 'none'/.test(fn) && !/pan-y/.test(fn.replace(/\/\/.*$/gm, '')));
check('  ...the first few pixels decide scrub or scroll, and a scroll still scrolls what the chart sits in',
  /g\.mode = dx >= dy \? 'scrub' : 'scroll'/.test(fn) && /_scrollParent\(canvas\)/.test(fn) && /scrollBy\(0, step\)/.test(fn));
check('the scrubbed point gets a dot and guide line on every chart',
  /id: 'scrubLine'/.test(src) && /chart\.\$scrubIndex = i/.test(src) && /Chart\.register\(/.test(src));

check('the card history animates while it loads',
  /class="ca-loading-art"/.test(html) && /\.card-analysis\.ca-loading \.ca-loading-art/.test(css)
  && /wrap\.classList\.add\('ca-loading'\)/.test(src));
check('  ...and stops once the sales are drawn, or the lookup comes back empty',
  (src.match(/classList\.remove\('ca-estimated', 'ca-loading'\)/g) || []).length >= 2);
check('  ...with placeholder rows where the sales list will be', /ca-skel-row/.test(src) && /\.ca-skel-row\s*\{/.test(css));

console.log(failures ? `\n${failures} check(s) failed` : '\nall chart-scrub checks passed');
process.exit(failures ? 1 : 0);
