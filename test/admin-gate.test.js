// The admin gate.
//
// WHAT THIS EXISTS TO PREVENT. isAdminReq() used to read:
//
//   const adminPass = process.env.ADMIN_PASSWORD || 'cardhuddle-admin';
//
// in a PUBLIC repository. Anyone who opened server.js had the live admin
// password unless the secret happened to be set, and nothing about the running
// site would have looked wrong. Admin is not cosmetic here: it deletes news and
// community posts, runs the scan-lead email drip, reads lead stats, and writes
// set aliases straight into the pricing join.
//
// A missing secret must mean "nobody is an admin", never "everybody is". That
// trade is deliberate — forgetting to set it locks the owner out, which is a
// loud failure, and loud beats silent for this.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

// ---- no password may be baked into the source ----------------------------
// Read as source rather than behaviour, because this is the check that would
// have caught the original bug at the moment it was written.
{
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  const fallbacks = [...code.matchAll(/ADMIN_PASSWORD\s*\|\|\s*(['"`])([^'"`]*)\1/g)];
  check('no admin password is hardcoded as a fallback',
    fallbacks.length === 0,
    fallbacks.length ? `found: ${fallbacks.map(m => JSON.stringify(m[2])).join(', ')}`
                     : 'ADMIN_PASSWORD has no literal default');

  // One gate. A second copy is a place for a fix to miss.
  const copies = (code.match(/process\.env\.ADMIN_PASSWORD/g) || []).length;
  check('  ...and the password is read in exactly one place',
    copies === 1, `${copies} reads of process.env.ADMIN_PASSWORD`);
}

// ---- behaviour, against the real app -------------------------------------
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(':memory:');
db.exec(`CREATE TABLE sales (item_id TEXT, sold_date TEXT, title TEXT, price_cents INTEGER,
  currency TEXT, listing_format TEXT, grader TEXT, grade TEXT, player TEXT, parallel TEXT,
  year TEXT, set_name TEXT, card_number TEXT, confidence REAL, best_offer INTEGER,
  bids INTEGER, image_url TEXT)`);
const d1 = { prepare(sql) { const st = db.prepare(sql); return {
  bind: (...a) => ({ all: async () => ({ results: st.all(...a) }), first: async () => st.get(...a) || null }),
  all: async () => ({ results: st.all() }), first: async () => st.get() || null }; } };
const dbMod = require(path.join(ROOT, 'db.js'));
dbMod.getNflDb = () => d1;
dbMod.archiveGet = async () => null;
dbMod.archivePut = async () => {};
process.env.CF_WORKER = '1';
// Deliberately UNSET, which is the situation the old code failed open in.
delete process.env.ADMIN_PASSWORD;

const { app } = require(path.join(ROOT, 'server.js'));
const PORT = 3215;
const server = app.listen(PORT);
const hit = async (p) => (await fetch(`http://127.0.0.1:${PORT}${p}`)).status;

(async () => {
  // Every route that used to accept the published default.
  const guesses = ['cardhuddle-admin', 'admin', 'anything', 'x', ''];
  const routes = ['/api/review/sets', '/api/feedback', '/api/admin/stats'];
  const opened = [];
  for (const r of routes) {
    for (const g of guesses) {
      const s = await hit(r + (g ? `?key=${encodeURIComponent(g)}` : ''));
      if (s === 200) opened.push(`${r} with ${JSON.stringify(g)}`);
    }
  }
  check('with no ADMIN_PASSWORD set, nothing opens — including the old default',
    opened.length === 0,
    opened.length ? `OPENED: ${opened.join(' | ')}` : `${routes.length} routes x ${guesses.length} guesses all refused`);

  // And with one set, the right key still works — fail-closed must not mean
  // fail-always.
  process.env.ADMIN_PASSWORD = 'a-real-secret';
  check('  ...and the correct key works once a secret is set',
    await hit('/api/review/sets?key=a-real-secret') === 200);
  check('  ...while a wrong one still does not',
    await hit('/api/review/sets?key=a-real-secre') === 403);

  server.close();
  console.log(failures ? `\n${failures} check(s) failed` : '\nall admin-gate checks passed');
  process.exit(failures ? 1 : 0);
})().catch(err => { console.error(err); server.close(); process.exit(1); });
