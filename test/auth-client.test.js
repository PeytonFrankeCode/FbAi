// What the login screen does when the server says no.
//
// From a bug report: "I can insert random username and password and got an
// error message while I got another success message saying that I have logged
// in successfully."
//
// The server was never the problem. /api/auth/login returns 401 for an unknown
// user and 401 for a wrong password, verifyPassword compares PBKDF2 output in
// constant time, and every route that returns user data requires a session
// token the server only issues on success. There is no authentication bypass
// and there never was one.
//
// The client was the problem, in two ways that were worse than the symptom:
//
//   it stored the PLAIN-TEXT PASSWORD in localStorage, so that a later login
//   could be matched offline;
//
//   and on a 401 it consulted that store and, on a match, signed the person in
//   on this device with no server session — producing an error message and a
//   signed-in state from the same submit, which is exactly what was reported.
//
// Both are gone. These checks exist so neither comes back, because both are
// the kind of thing that reads as a helpful fallback in a diff.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

// ---- the server side, asserted rather than assumed ------------------------
//
// The report claimed a login bypass. It is worth pinning that the server
// refuses both shapes, so a future change cannot quietly make the claim true.
{
  const login = server.slice(server.indexOf("app.post('/api/auth/login'"),
                             server.indexOf("app.post('/api/auth/logout'"));
  check('an unknown user is refused',
    /if \(!user\) return res\.status\(401\)/.test(login), 'login must 401 on a missing user');
  check('a wrong password is refused',
    /const valid = await verifyPassword\(password, user\.passwordHash\);\s*\n\s*if \(!valid\) return res\.status\(401\)/.test(login),
    'login must verify the password and 401 on failure');
  check('  ...and a token is only issued after both checks pass',
    login.indexOf('generateToken()') > login.indexOf('if (!valid)'),
    'the session token must come after verification');

  const verify = server.slice(server.indexOf('async function verifyPassword'),
                              server.indexOf('async function deriveBits'));
  check('the verifier rejects a missing or malformed hash',
    /if \(!stored\) return false;/.test(verify) && /if \(!stored\.startsWith\('pbkdf2:'\)\) return false;/.test(verify),
    'a bad stored hash must not compare equal');
  check('  ...and compares in constant time',
    /diff \|= derived\[i\] \^ expected\[i\]/.test(verify), 'no early-exit comparison');
}

// ---- the client side, where the reported behaviour actually came from -----
{
  check('the password is never written to local storage',
    !/\.password = password/.test(app),
    'storing a usable password client-side is an exposure with no benefit');

  check('  ...and no code compares against a stored one',
    !/localUser\.password === password/.test(app) && !/\.password === password/.test(app),
    'an offline password comparison is what required storing it');

  // The specific symptom: a 401 that still signs someone in.
  const loginFn = app.slice(app.indexOf("await authFetchJson('/api/auth/login'"),
                            app.indexOf("await authFetchJson('/api/auth/login'") + 3000);
  check('a rejected login shows the error and stops',
    /if \(!res\.ok\) \{[\s\S]{0,900}?loginError\.textContent = data\.error \|\| 'Login failed';/.test(loginFn),
    'the 401 branch must end in the error, not in a sign-in');
  check('  ...and never calls setCurrentUser on that branch',
    !/if \(!res\.ok\) \{[\s\S]{0,900}?setCurrentUser\(/.test(loginFn),
    'no path from a 401 may reach a signed-in state');
}

// ---- and the passwords already out there get removed ---------------------
//
// Stopping the write only protects people who have not signed in yet. Everyone
// who already did is carrying a working password in their browser until
// something deletes it.
{
  check('passwords already stored are purged on load',
    /function purgeStoredPasswords\(\)/.test(app) && /purgeStoredPasswords\(\);/.test(app),
    'the cleanup must run, not just exist');
  check('  ...by deleting the field, not by rewriting the record around it',
    /delete users\[k\]\.password;/.test(app), 'the field must actually be removed');

  // Run it, rather than trusting the source. A cleanup that throws on a
  // malformed store would leave the password in place and say nothing.
  const src = app.slice(app.indexOf('function getUsers()'),
                        app.indexOf('purgeStoredPasswords();') + 'purgeStoredPasswords();'.length);
  const store = { cardHuddleUsers: JSON.stringify({
    alice: { username: 'alice', password: 'hunter2', email: 'a@b.c' },
    bob: { username: 'bob' },
  }) };
  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = v; },
  };
  try {
    new Function('localStorage', 'console', src)(localStorage, { warn() {} });
    const after = JSON.parse(store.cardHuddleUsers);
    check('  ...and it actually removes one when run',
      !('password' in after.alice) && after.alice.username === 'alice'
      && after.alice.email === 'a@b.c' && after.bob.username === 'bob',
      JSON.stringify(after));
  } catch (e) {
    check('  ...and it actually removes one when run', false, String(e.message));
  }

  // A browser with storage disabled must not take the page down with it.
  try {
    const hostile = { getItem() { throw new Error('storage disabled'); }, setItem() {} };
    new Function('localStorage', 'console', src)(hostile, { warn() {} });
    check('  ...and survives a browser that refuses storage', true, 'no throw');
  } catch (e) {
    check('  ...and survives a browser that refuses storage', false, String(e.message));
  }
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall auth-client checks passed');
process.exit(failures ? 1 : 0);
