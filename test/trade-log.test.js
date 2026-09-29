// Logging a sale, trade or purchase with several cards on a side.
//
// The pure parts run here (splitting the cash paid across the cards bought,
// and reading old single-card records); the form itself was driven in
// Chromium. Then checks the page and the account deletion cover every card.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

const js = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const fn = (name) => {
  const start = js.indexOf(`function ${name}(`);
  let depth = 0, i = js.indexOf('{', start);
  for (; i < js.length; i++) { if (js[i] === '{') depth++; else if (js[i] === '}' && --depth === 0) break; }
  return new Function(`${js.slice(start, i + 1)}; return ${name};`)();
};
const split = fn('_saleSplitCost');
const cards = fn('_invHistCards');

// ---- splitting the cash paid ------------------------------------------------
const sum = (a) => Math.round(a.reduce((x, y) => x + y, 0) * 100) / 100;
check('cash paid splits by value when every card has one', split(15, [90, 30]).join() === '11.25,3.75');
check('  ...evenly when any card has no value', split(10, [0, 40, 0]).join() === '3.34,3.33,3.33');
check('  ...and the parts always add back to the total', sum(split(100, [1, 1, 1])) === 100 && sum(split(0.07, [5, 9])) === 0.07);
check('  ...no cash paid, no cost', split(0, [50, 50]).join() === '0,0');
check('  ...one card takes it all', split(42.5, [0]).join() === '42.5');

// ---- reading records -----------------------------------------------------------
const old = { gaveName: 'Old card', gavePrintRun: '25', gavePhotoId: 'p1', gotName: 'Got card', gotPhotoId: null };
check('a record from before multi-card reads as one card a side',
  cards(old, 'gave').length === 1 && cards(old, 'gave')[0].photoId === 'p1' && cards(old, 'got')[0].name === 'Got card');
check('  ...a cash-only side reads as no cards', cards({ cashAmount: 20 }, 'got').length === 0);
const multi = { gaveName: 'A + B', gaveCards: [{ name: 'A' }, { name: 'B', photoId: 'p2' }], gotCards: [{ name: 'C' }] };
check('a multi-card record lists every card', cards(multi, 'gave').map(c => c.name).join() === 'A,B' && cards(multi, 'got').length === 1);

// ---- the page ----------------------------------------------------------------
check('each side can add another card', (html.match(/_saleAddRow\('(gave|got)'\)/g) || []).length === 2);
check('the presets are there', ['sale', 'trade', 'buy'].every(k => html.includes(`setSalePreset('${k}')`)));
check('the form shows errors on the page, not in pop-ups',
  /id="inv-sale-error"/.test(html) && !/alert\(/.test(js.slice(js.indexOf('function handleSaleTradeSubmit'), js.indexOf('function _invHistCards'))));
check('history and reset read every card on a side', /_invHistCards\(h, 'gave'\)\.map/.test(js) && /_invHistCards\(h, side\)/.test(js));
check('account deletion removes every card\'s photo',
  /h\.gaveCards/.test(fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8')));

console.log(failures ? `\n${failures} check(s) failed` : '\nall trade-log checks passed');
process.exit(failures ? 1 : 0);
