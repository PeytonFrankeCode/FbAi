// The grouping key for a parallel name (parallel-index-core.js parallelKey):
// two spellings of one parallel must share a key, and two parallels must not.
//
// "Silver" on the end (owner, Oct 2026): sellers add it to parallels that are
// silvery by nature, and 2024 Prizm Bo Nix #309 Red White Blue showed as two
// tiles, "Red White Blue" and "Red White Blue Silver". With the vocabulary,
// a trailing Silver goes when the rest is a parallel we know and the whole is
// not; Holo Silver, Mirror Silver and the Silver Prizm itself stay.
'use strict';
const { parallelKey } = require('../parallel-index-core');
const pi = require('../parallel-index');

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};
const known = (n) => pi.isParallelName(n);
const key = (n) => parallelKey(n, known);
const same = (a, b) => key(a) === key(b);

const SAME = [
  ['Red White Blue Silver', 'Red White Blue'],
  ['Red White & Blue Silver Prizm', 'Red White Blue'],
  ['Red White and Blue', 'Red White Blue'],
  ['Orange Ice Silver', 'Orange Ice'],
  ['Pink Pulsar Silver Prizm', 'Pink Pulsar'],
  ['Neon Green Silver', 'Neon Green'],
  ['Silver Prizm', 'Silver'],
  ['Prizm Silver', 'Silver'],
  ['Gold Refractor', 'Gold'],
];
const bad = SAME.filter(([a, b]) => !same(a, b));
check('a parallel with "Silver" (or the product word) on the end groups with the parallel',
  !bad.length, bad.map(([a, b]) => `${a} -> "${key(a)}" vs ${b} -> "${key(b)}"`).join(' | ') || `${SAME.length} pairs`);

const APART = [
  ['Holo Silver', 'Holo'],
  ['Mirror Silver', 'Mirror'],
  ['Press Proof Silver', 'Press Proof'],
  ['Silver', ''],
  ['Red Silver', 'Red'],
];
const merged = APART.filter(([a, b]) => same(a, b));
check('  ...but a parallel whose name really ends in Silver keeps it, and Silver alone is the Silver',
  !merged.length, merged.map(([a, b]) => `${a} merged with ${b || '(base)'}`).join(' | ') || APART.map(([a]) => `${a} -> "${key(a)}"`).join(', '));

check('  ...without the vocabulary, no Silver is dropped',
  parallelKey('Red White Blue Silver') === 'red white blue silver');

check('  ...and a name is never emptied into the base card',
  ['Silver', 'Prizm', 'Refractor', 'Silver Silver'].every(n => key(n) !== ''));

console.log(failures ? `\n${failures} check(s) failed` : '\nall parallel-key checks passed');
process.exit(failures ? 1 : 0);
