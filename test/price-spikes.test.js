// The card chart leaves out spikes: a sale at 3x or more of the sales around
// it (server.js _priceSpikes, owner Oct 2026).
'use strict';
process.env.CF_WORKER = '1';
const { _priceSpikes } = require('../server.js');
let failures = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`); if (!ok) failures++; };
const day = (i) => new Date(Date.UTC(2026, 8, 1) + i * 864e5).toISOString().slice(0, 10);
const run = (prices) => { const rows = prices.map((p, i) => ({ price_cents: Math.round(p * 100), sold_date: day(i) })); const s = _priceSpikes(rows); return rows.map(r => s.has(r)); };

// The screenshot's card: ~$2.50, one day at $10.
const flags = run([3.2, 3.0, 2.6, 2.6, 2.8, 2.0, 10, 2.5, 2.9, 2.2, 1.7, 2.0, 2.3, 2.2, 2.0, 1.27, 1.6]);
check('a $10 sale among ~$2.50 sales is a spike', flags[6] && flags.filter(Boolean).length === 1, JSON.stringify(flags.map((f, i) => f ? i : null).filter(x => x != null)));
check('  ...and 2.9x is not', !run([10, 10, 10, 29, 10, 10, 10])[3]);
check('  ...but exactly 3x is', run([10, 10, 10, 30, 10, 10, 10])[3]);
// A card that really tripled over the months: the latest sales stand.
const rising = Array.from({ length: 60 }, (_, i) => 10 * Math.pow(3, i / 59));
check('a card that tripled over time keeps every sale', !run(rising).some(Boolean));
check('with too few sales to compare, nothing is a spike', !run([1, 10, 1]).some(Boolean));
check('a cheap sale is not a spike (only highs are left out)', !run([10, 10, 10, 1, 10, 10]).some(Boolean));
console.log(failures ? `\n${failures} check(s) failed` : '\nall price-spike checks passed');
process.exit(failures ? 1 : 0);
