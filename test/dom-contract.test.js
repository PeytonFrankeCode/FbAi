// Does app.js dereference an element the markup no longer has?
//
// Deleting the retired Floor, Showcase and Pro-tools markup took the site's
// navigation down. switchView held
//
//   const sellerView = document.getElementById('seller-view');
//   ...
//   sellerView.classList.add('hidden');
//
// with no guard, so once seller-view was gone that line threw a TypeError on
// every call — after the nav tab had been highlighted and before the target
// view was shown. Every tab lit up and rendered nothing. `node --check` passes
// on it, the whole test suite passed on it, and it shipped.
//
// A blanket "every id app.js names must exist" rule does not work here: 154 do
// not, nearly all of them predating this and harmless, because they are only
// ever touched behind a guard or inside a function nothing calls. The bug is
// narrower and so is this check — an id absent from the markup AND dereferenced
// without a guard. That is the combination that throws.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));

// Elements app.js writes into the DOM itself are legitimately absent from
// index.html — look for the id being emitted in a template or markup string.
const injects = (id) =>
  app.includes(`id="${id}"`) || app.includes(`id='${id}'`) || app.includes(`id=\\"${id}\\"`);

// Module-level bindings only — declared at column 0, so the name means one
// thing for the whole file and a dereference of it can be attributed with
// certainty.
//
// Function-local bindings are deliberately out of scope. A first version
// included them and reported 1,500 offenders, all false: names like `gate`,
// `content` and `typePanel` are reused in dozens of functions, and without
// tracking scope every use of the name anywhere was blamed on whichever
// binding happened to match. A check that cries wolf 1,500 times is not a
// check — it is noise that the real one hides inside.
const bindings = [...app.matchAll(/^(?:const|let|var)\s+(\w+)\s*=\s*document\.getElementById\('([^']+)'\)/gm)]
  .map(m => ({ name: m[1], id: m[2] }));

const lines = app.split('\n');
const offenders = [];
for (const { name, id } of bindings) {
  if (ids.has(id) || injects(id)) continue;   // present, or created at runtime

  // Every dereference of this binding has to be defensive. Optional chaining
  // counts; so does a same-line truthiness guard, which is the shape the rest
  // of switchView already uses.
  const deref = new RegExp(`(?<![\\w.?])${name}\\.`);
  const guarded = new RegExp(`(?:if\\s*\\(\\s*${name}\\b|${name}\\s*&&|${name}\\?\\.)`);
  lines.forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, '');
    if (!deref.test(code)) return;
    if (guarded.test(code)) return;
    offenders.push({ name, id, line: i + 1, code: code.trim().slice(0, 78) });
  });
}

check('no element missing from index.html is dereferenced unguarded',
  offenders.length === 0,
  offenders.length
    ? `${offenders.length} would throw:\n        `
      + offenders.slice(0, 6).map(o => `app.js:${o.line}  ${o.id} -> ${o.code}`).join('\n        ')
    : `${bindings.length} bindings checked against ${ids.size} ids in the markup`);

// The specific regression, named. switchView is the one function every tab goes
// through, so anything that throws inside it takes the whole navigation with it
// rather than breaking one view.
{
  const start = app.indexOf('function switchView(');
  const body = start === -1 ? '' : app.slice(start, app.indexOf('\n}', start));
  const bare = [...body.matchAll(/^\s*(\w+)\.classList\.(?:add|remove)\(/gm)]
    .map(m => m[1])
    .filter(n => {
      const b = bindings.find(x => x.name === n);
      return b && !ids.has(b.id) && !injects(b.id);
    });
  check('  ...and switchView in particular touches nothing that is gone',
    bare.length === 0,
    bare.length ? `${bare.join(', ')} — every tab would break, not just one` : 'the navigation cannot be taken down this way');
}

// Boot has to route, not assume.
//
// index.html hardcodes which tab is active — <button class="nav-tab active"
// data-view="search"> — so Search looks selected before a line of JS runs. But
// the chrome that selection implies is not in the markup's hands: the Search /
// Grading Advisor / Scan Card strip ships with the `hidden` class and is
// revealed only by switchView('search'). While boot routed conditionally
// (`if (view) switchView(view)`), a first load at '/' matched no route and
// called nothing, so the strip stayed hidden under an active-looking tab. It
// appeared on the first trip to another tab and back, which is why it read as
// a rendering glitch rather than a missing call.
//
// Two sources of truth for what a view looks like is the actual defect, and
// the fix is for switchView to be the only one. So: boot calls it
// unconditionally, with a default.
{
  const start = app.indexOf('function bootFromPath(');
  const body = start === -1 ? '' : app.slice(start, app.indexOf('})();', start));
  check('boot routes a view on every load, not only on a recognised path',
    start !== -1 && /switchView\(/.test(body) && !/if\s*\(\s*view\s*\)\s*switchView/.test(body),
    start === -1
      ? 'bootFromPath is gone — nothing establishes the starting view'
      : (/if\s*\(\s*view\s*\)\s*switchView/.test(body)
        ? "guarded call: '/' falls through and the Search subtab strip stays hidden"
        : 'switchView owns the starting view'));
  check('  ...and names a fallback view for the paths no route matches',
    /\|\|\s*'search'/.test(body),
    /\|\|\s*'search'/.test(body) ? "'/' boots on Search" : 'no default — switchView(undefined) is not a view');
}

// The strip this was about. If it ever stops shipping hidden the checks above
// are no longer load-bearing, and this is the line that will say so.
check('  ...which is what the Search subtab strip depends on',
  /id="search-subtabs"[^>]*class="[^"]*\bhidden\b/.test(html)
    || !/id="search-subtabs"/.test(html),
  /id="search-subtabs"/.test(html)
    ? 'the strip is hidden in the markup and un-hidden by switchView alone'
    : 'the strip is gone from the markup');

console.log(failures ? `\n${failures} check(s) failed` : '\nall dom-contract checks passed');
process.exit(failures ? 1 : 0);
