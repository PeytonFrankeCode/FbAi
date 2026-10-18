// Nothing asks before the first search (Oct 2026): install, sports, the Monday
// email and the beta survey stacked up on a first visit.
const fs = require('fs');
const path = require('path');
let failures = 0;
const check = (label, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) failures++; };
const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
check('the sports question waits for the first search', /function maybeAskSports\(\) \{\s+if \(_sportsSaved\(\) \|\| !_hasSearched\(\)\) return false;/.test(app));
check('  ...and the first search marks it, then asks once nothing else is', /localStorage\.setItem\('chSearched', '1'\)[\s\S]{0,300}if \(!_askOnScreen\(\)\) maybeAskSports\(\)/.test(app));
check('the install hint waits too, and never over another ask', /!_hasSearched\(\)\) return;\s+const snoozed/.test(app) && /#sports-picker:not\(\.hidden\), #survey-banner:not\(\.hidden\)'\);/.test(app));
check('the survey waits, and one ask on screen at a time', /if \(!_hasSearched\(\) \|\| _askOnScreen\(\)\) return;/.test(app));
check('the Monday email form shows after a search', /f\.dataset\.enabled = '1';\s+if \(_hasSearched\(\)\) f\.classList\.remove\('hidden'\);/.test(app));
console.log(failures ? `\n${failures} check(s) failed` : '\nall home-asks checks passed');
process.exit(failures ? 1 : 0);
