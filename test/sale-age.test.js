// How old a sale is, said from the calendar.
//
// A card's estimate counted days from the newest sale in the dataset, which
// runs a day or two behind the calendar, and "0 or 1 days" read "a day": on
// October 1 a Sept 29 sale was "last sold a day ago". And a bare "2026-09-29"
// parsed as a timestamp is midnight UTC, the evening before in the US.
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const grab = (name) => {
  const i = src.indexOf(`function ${name}(`);
  let depth = 0, j = src.indexOf('{', i);
  for (; j < src.length; j++) { if (src[j] === '{') depth++; else if (src[j] === '}' && --depth === 0) break; }
  return src.slice(i, j + 1);
};
const M = new Function(['_calendarDaysSince', 'timeAgo', '_caDaysWord', '_caSoldAgo'].map(grab).join('\n')
  + '\nreturn { _calendarDaysSince, timeAgo, _caSoldAgo };')();

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};
const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

check('a sale two calendar days ago is two days ago, whatever the hour or time zone',
  M._calendarDaysSince(daysAgo(2)) === 2 && M.timeAgo(daysAgo(2)) === '2 days ago', M.timeAgo(daysAgo(2)));
check('  ...today is today, yesterday is one day', M.timeAgo(daysAgo(0)) === 'today' && M.timeAgo(daysAgo(1)) === '1 day ago');
// The server said 0 days (the dataset's newest day); the date says two.
const e = { newestSaleDays: 0, newestSaleDate: daysAgo(2) };
const said = M._caSoldAgo(e);
check('an estimate\'s "last sold" counts from the date, and shows it', /^2 days ago \([A-Z][a-z]{2} \d{1,2}\)$/.test(said), said);
check('  ...yesterday and today in words', /^yesterday \(/.test(M._caSoldAgo({ newestSaleDate: daysAgo(1) })) && /^today \(/.test(M._caSoldAgo({ newestSaleDate: daysAgo(0) })));
check('  ...and an older payload without the date still reads', M._caSoldAgo({ newestSaleDays: 5 }) === '5 days ago');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
check('every estimate the server builds carries the sale date', (server.match(/newestSaleDate: _mkIso\(/g) || []).length === 4);

console.log(failures ? `\n${failures} check(s) failed` : '\nall sale-age checks passed');
process.exit(failures ? 1 : 0);
