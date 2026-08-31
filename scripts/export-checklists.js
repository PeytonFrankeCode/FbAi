#!/usr/bin/env node
// Export the whole checklist corpus as one file, for use outside the site.
//
// The data ships as 361 separate product files because that is what the browser
// wants: fetch a small index, then one product on demand. That shape is wrong
// for anything that needs all of it at once — a scraper, a matcher, another
// tool — which would otherwise have to know the index format and make 361
// requests.
//
// Three formats, because "the full checklist" means different things:
//
//   cards     one row per card. 376,978 rows. Parallels ride along as a
//             semicolon-joined column, so a row is a card and the set's
//             parallel list is attached to it.
//
//   variants  one row per card x parallel. 2,012,671 rows. This is the form
//             where every physical card is its own row — a Gold /10 of card 5
//             is a different row from the base card 5. It is what you want if
//             you are matching a listing to a specific card, and it is five
//             times the size for that reason.
//
//   json      the 361 product files concatenated into one document, structure
//             unchanged. Lossless; the other two flatten away set-level fields.
//
// Gzip is on by default. This data is extremely repetitive — the same player
// names and parallel names recur tens of thousands of times — so it compresses
// about 10:1, which is the difference between a file you can attach somewhere
// and one you cannot.
//
// Run: node scripts/export-checklists.js [cards|variants|json] [--raw] [--out PATH]
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const DIR = path.join(__dirname, '..', 'public', 'data', 'checklists');

function products() {
  return fs.readdirSync(DIR)
    .filter(f => f.endsWith('.json') && f !== 'index.json')
    .sort()
    .map(f => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')));
}

// Minimal RFC-4180 quoting. Player names carry commas ("Smith, Jr."), set names
// carry quotes, and a checklist that breaks its own CSV is worse than no export.
function csv(v) {
  const s = v === undefined || v === null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const row = (cells) => cells.map(csv).join(',') + '\n';

function* rowsCards() {
  yield row(['product_id', 'product', 'year', 'brand', 'sport',
    'set_id', 'set', 'category', 'card_number', 'player', 'team', 'rookie',
    'parallels']);
  for (const d of products()) {
    for (const s of d.sets || []) {
      // printRun is kept alongside the name: "Gold" alone is ambiguous across
      // products, "Gold /10" is not.
      const par = (s.parallels || [])
        .map(p => p.printRun ? `${p.name} /${p.printRun}` : p.name)
        .join('; ');
      for (const c of s.cards || []) {
        yield row([d.id, d.name, d.year, d.brand, d.sport,
          s.id, s.name, s.category, c.number, c.player, c.team || '',
          c.rookie ? 'yes' : '', par]);
      }
    }
  }
}

function* rowsVariants() {
  yield row(['product_id', 'product', 'year', 'brand', 'sport',
    'set_id', 'set', 'category', 'card_number', 'player', 'team', 'rookie',
    'parallel', 'print_run']);
  for (const d of products()) {
    for (const s of d.sets || []) {
      // A set with no parallel list still has cards, and they are real cards.
      // Emitting nothing for them would silently drop 359 sets, so they get one
      // row with an empty parallel rather than none.
      const par = (s.parallels || []).length ? s.parallels : [{ name: '', printRun: null }];
      for (const c of s.cards || []) {
        for (const p of par) {
          yield row([d.id, d.name, d.year, d.brand, d.sport,
            s.id, s.name, s.category, c.number, c.player, c.team || '',
            c.rookie ? 'yes' : '', p.name, p.printRun == null ? '' : p.printRun]);
        }
      }
    }
  }
}

function main() {
  const format = process.argv.find(a => ['cards', 'variants', 'json'].includes(a)) || 'cards';
  const raw = process.argv.includes('--raw');
  const outArg = process.argv.indexOf('--out');
  const ext = format === 'json' ? 'json' : 'csv';
  const out = outArg > -1 ? process.argv[outArg + 1]
    : path.join(process.cwd(), `checklists-${format}.${ext}${raw ? '' : '.gz'}`);

  let bytes = 0, lines = 0;
  const sink = raw ? fs.createWriteStream(out) : (() => {
    const gz = zlib.createGzip({ level: 9 });
    gz.pipe(fs.createWriteStream(out));
    return gz;
  })();

  const write = (chunk) => {
    bytes += Buffer.byteLength(chunk);
    if (!sink.write(chunk)) return new Promise(r => sink.once('drain', r));
  };

  (async () => {
    if (format === 'json') {
      const doc = { exportedAt: new Date().toISOString(), products: products() };
      await write(JSON.stringify(doc, null, 2) + '\n');
      lines = doc.products.reduce((n, p) =>
        n + (p.sets || []).reduce((m, s) => m + (s.cards || []).length, 0), 0);
    } else {
      const gen = format === 'variants' ? rowsVariants() : rowsCards();
      for (const r of gen) { lines++; await write(r); }
      lines--; // the header is not a record
    }
    sink.end();
    await new Promise(r => sink.once('finish', r));

    const onDisk = fs.statSync(out).size;
    console.log(`${format}: ${lines.toLocaleString('en-US')} `
      + `${format === 'json' ? 'cards' : 'rows'}`);
    console.log(`  uncompressed  ${(bytes / 1048576).toFixed(1)} MB`);
    if (!raw) {
      console.log(`  gzipped       ${(onDisk / 1048576).toFixed(1)} MB `
        + `(${(bytes / onDisk).toFixed(1)}x)`);
    }
    console.log(`  wrote         ${out}`);
  })();
}

main();
