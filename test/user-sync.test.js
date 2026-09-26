// An account's inventory is the same on every device it is signed in on.
//
// Two things stopped that. Sync was only switched on at the moment of signing
// in, so after a reload a device neither sent its changes nor received
// anyone else's. And every push replaced the whole account, so a device that
// had been open a while overwrote whatever another device had added.
//
// Now each stored copy has a revision, a push built on an old one is refused
// with the current copy, and the device merges card by card and pushes again.
// This runs the real sync code from public/app.js as two devices (a phone and
// a laptop, each with its own localStorage) against the real endpoints.
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// ---- D1 (node:sqlite) and KV (a Map) ----
const db = new DatabaseSync(':memory:');
let d1On = true;
const d1 = { prepare(sql) {
  const st = db.prepare(sql);
  const api = { _b: [], bind(...a) { api._b = a; return api; },
    async all() { return { results: st.all(...api._b), meta: {} }; },
    async first() { return st.get(...api._b) || null; },
    async run() { const r = st.run(...api._b); return { success: true, meta: { changes: Number(r.changes) } }; } };
  return api;
} };
const kv = new Map();
const TOKEN = 'tok-peyton', TOKEN2 = 'tok-other';
const sessions = {
  [TOKEN]: { username: 'Peyton', expiresAt: Date.now() + 86400000 },
  [TOKEN2]: { username: 'other', expiresAt: Date.now() + 86400000 },
};
const dbMod = require(path.join(__dirname, '..', 'db.js'));
dbMod.getNflDb = () => (d1On ? d1 : null);
dbMod.loadUserData = async (u) => (kv.has(u) ? JSON.parse(kv.get(u)) : {});
dbMod.saveUserData = async (u, data) => { kv.set(u, JSON.stringify(data)); };
dbMod.deleteUserData = async (u) => { kv.delete(u); };
const origLoad = dbMod.loadData, origSave = dbMod.saveData;
dbMod.loadData = (name, file, def) => (name === 'sessions' ? sessions : origLoad(name, file, def));
dbMod.saveData = (name, file, data) => (name === 'sessions' ? undefined : origSave(name, file, data));
process.env.CF_WORKER = '1';
const { app } = require(path.join(__dirname, '..', 'server.js'));
const PORT = 3251;
const server = app.listen(PORT);
const URL0 = `http://127.0.0.1:${PORT}`;

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};
const api = async (method, url, body, token = TOKEN) => {
  const r = await fetch(URL0 + url, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};

// ---- A device: the sync block of app.js in its own context ----
const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const block = src.slice(src.indexOf('// ---- Global Account Sync ----'), src.indexOf('// ---- Collection & Portfolio (localStorage) ----'));
let getRequests = 0, unchangedReplies = 0;
function device(user, token) {
  const store = new Map();
  const ctx = vm.createContext({
    console, JSON, Math, Date, Number, String, Object, Array, Map, Set, Promise, encodeURIComponent,
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    document: { visibilityState: 'visible', addEventListener() {} },
    window: { addEventListener() {} },
    setTimeout, clearTimeout, setInterval: () => 0,
    getSessionToken: () => token,
    getCurrentUser: () => user.name,
    fetch: async (u, o) => {
      const r = await fetch(URL0 + u, o);
      if (!o || !o.method) {
        getRequests++;
        const body = await r.clone().json().catch(() => ({}));
        if (body.unchanged) unchangedReplies++;
      }
      return r;
    },
  });
  vm.runInContext(block, ctx);
  const run = (code) => vm.runInContext(code, ctx);
  return {
    user, run,
    inv: () => JSON.parse(store.get('cardHuddleInventory') || 'null'),
    setInv: (inv) => store.set('cardHuddleInventory', JSON.stringify(inv)),
    names: () => ((JSON.parse(store.get('cardHuddleInventory') || 'null') || {}).items || []).map(i => i.name).sort().join(','),
  };
}
const card = (id, name, extra = {}) => ({ id, name, qty: 1, location: 'Binder', updatedAt: 1000, ...extra });
const invOf = (items, wallet = 0) => ({ items, locations: ['Binder'], moves: [], wallet, walletLog: [], history: [], netWorthHistory: [] });

(async () => {
  // ---- The endpoints ----
  // An account written before revisions existed: in KV, no revision.
  kv.set('peyton', JSON.stringify({ cardHuddleWatchlist: [{ id: 'w1' }] }));
  let r = await api('GET', '/api/user/data');
  check('an account stored before revisions reads at revision 0', r.status === 200 && r.body.rev === 0
    && r.body.data.cardHuddleWatchlist.length === 1, JSON.stringify(r.body));
  r = await api('PUT', '/api/user/data', { data: { cardHuddleWatchlist: [{ id: 'w1' }, { id: 'w2' }] }, baseRev: 0 });
  check('a push built on the current revision is stored, as the next one', r.status === 200 && r.body.rev === 1, JSON.stringify(r.body));
  check('  ...in D1', db.prepare('SELECT rev FROM user_sync WHERE username = ?').get('peyton')?.rev === 1);
  check('  ...and copied to KV, revision included', JSON.parse(kv.get('peyton'))._syncRev === 1);
  r = await api('PUT', '/api/user/data', { data: { cardHuddleWatchlist: [] }, baseRev: 0 });
  check('a push built on an old revision is refused, with the current copy', r.status === 409 && r.body.rev === 1
    && r.body.data.cardHuddleWatchlist.length === 2, `${r.status} ${JSON.stringify(r.body)}`);
  r = await api('GET', '/api/user/data?since=1');
  check('a check with nothing new is answered without the data', r.body.unchanged === true && !r.body.data, JSON.stringify(r.body));
  r = await api('PUT', '/api/user/data', { data: { cardHuddleWatchlist: [{ id: 'w1' }] } });
  check('a page loaded before revisions (no baseRev) is still stored', r.status === 200 && r.body.rev === 2, JSON.stringify(r.body));
  d1On = false;
  r = await api('PUT', '/api/user/data', { data: { x: 1 }, baseRev: 0 }, TOKEN2);
  const r2 = await api('PUT', '/api/user/data', { data: { x: 2 }, baseRev: 0 }, TOKEN2);
  check('without D1, KV carries the revision and the check still holds', r.status === 200 && r2.status === 409, `${r.status} ${r2.status}`);
  d1On = true;
  db.exec('DELETE FROM user_sync'); kv.clear();

  // ---- Two devices ----
  const peyton = { name: 'Peyton' };
  const phone = device(peyton, TOKEN), laptop = device(peyton, TOKEN);
  // Sync used to stop after a reload, so each device kept its own cards.
  phone.setInv(invOf([card('a', 'Mahomes Silver')], 20));
  laptop.setInv(invOf([card('b', 'Nix Orange /25')], 20));
  await phone.run('enableUserSync()');
  await laptop.run('enableUserSync()');
  await phone.run('pullUserData()');
  check('two devices that grew apart end up with every card either had',
    phone.names() === 'Mahomes Silver,Nix Orange /25' && laptop.names() === 'Mahomes Silver,Nix Orange /25',
    `phone: ${phone.names()} | laptop: ${laptop.names()}`);
  check('  ...and the account\'s wallet, not the two added together', phone.inv().wallet === 20 && laptop.inv().wallet === 20,
    `phone ${phone.inv().wallet}, laptop ${laptop.inv().wallet}`);

  // The laptop adds a card; the phone, not having checked since, deletes one.
  const lInv = laptop.inv(); lInv.items.push(card('c', 'Franklin Gold /10')); laptop.setInv(lInv);
  await laptop.run('pushUserDataNow()');
  const pInv = phone.inv(); pInv.items = pInv.items.filter(i => i.id !== 'a'); phone.setInv(pInv);
  await phone.run('pushUserDataNow()');
  check('a device that had not checked in does not overwrite the other\'s new card',
    phone.names() === 'Franklin Gold /10,Nix Orange /25', `phone: ${phone.names()}`);
  await laptop.run('pullUserData()');
  check('  ...and its deletion reaches the other device', laptop.names() === 'Franklin Gold /10,Nix Orange /25',
    `laptop: ${laptop.names()}`);

  // Both change the wallet and the same card, neither having seen the other.
  const p2 = phone.inv(); p2.wallet += 10; p2.items.find(i => i.id === 'b').value = 50; p2.items.find(i => i.id === 'b').updatedAt = 2000; phone.setInv(p2);
  const l2 = laptop.inv(); l2.wallet += 5; l2.items.find(i => i.id === 'b').value = 65; l2.items.find(i => i.id === 'b').updatedAt = 3000; laptop.setInv(l2);
  await phone.run('pushUserDataNow()');
  await laptop.run('pushUserDataNow()');
  await phone.run('pullUserData()');
  check('wallet changes made on both devices both count', phone.inv().wallet === 35 && laptop.inv().wallet === 35,
    `phone ${phone.inv().wallet}, laptop ${laptop.inv().wallet} (20 + 10 + 5)`);
  const bOn = (d) => d.inv().items.find(i => i.id === 'b').value;
  check('a card edited on both keeps the later edit, everywhere', bOn(phone) === 65 && bOn(laptop) === 65,
    `phone ${bOn(phone)}, laptop ${bOn(laptop)}`);

  const before = unchangedReplies;
  await laptop.run('pullUserData()');
  check('a check with nothing new downloads nothing', unchangedReplies === before + 1);

  // Another account signs in on the phone: the phone's cards are Peyton's.
  peyton.name = 'other';
  const other = device({ name: 'other' }, TOKEN2);
  void other;
  const phoneOther = phone; // same localStorage, new account
  phoneOther.run(`getSessionToken = () => '${TOKEN2}'`);
  await phoneOther.run('enableUserSync()');
  r = await api('GET', '/api/user/data', null, TOKEN2);
  const leaked = JSON.stringify(r.body.data || {}).includes('Franklin');
  check('another account signing in on the same device does not receive the first one\'s cards',
    !leaked && phoneOther.names() === '', `phone now: "${phoneOther.names()}"`);

  // ---- Wiring in app.js ----
  check('a page opened already signed in turns sync on',
    /addEventListener\('DOMContentLoaded',[^]{0,120}getSessionToken\(\)\) enableUserSync\(\)/.test(block));
  check('an open page checks again when it comes back into view',
    /addEventListener\('visibilitychange', _syncMaybePull\)/.test(block));
  check('saving the inventory stamps the cards it changed',
    /function saveInventory\(inv\) \{[^]{0,900}it\.updatedAt = now/.test(src));

  server.close();
  console.log(failures ? `\n${failures} check(s) failed` : '\nall user-sync checks passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); server.close(); process.exit(1); });
