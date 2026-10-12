// Web Push, sent from the server with nothing but WebCrypto.
//
// Split out of server.js so it can be tested directly, and written against
// globalThis.crypto.subtle rather than Node's crypto module, so the same code
// runs on Node and on the Cloudflare Worker (the `web-push` package is built on
// Node's crypto and does not run on Workers).
//
// Two standards make a push:
//
//   VAPID (RFC 8292) proves to the browser's push service that the message is
//   from the server the subscription was made for. It is a short ES256 JWT,
//   signed with the server's private key, sent with the public key.
//
//   Message encryption (RFC 8291, aes128gcm per RFC 8188) keeps the push
//   service from reading the message. The browser handed us a public key
//   (p256dh) and a secret (auth) when it subscribed; an ECDH exchange with a
//   one-off key of ours, through HKDF, gives the AES-GCM key and nonce.
//
// Every push service (Chrome's FCM, Firefox's autopush, Apple's, Edge's)
// speaks exactly this, so there is one code path for all of them.
'use strict';

const subtle = () => globalThis.crypto.subtle;
const enc = new TextEncoder();

function b64url(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64url(str) {
  const s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// A new VAPID key pair: the public key as the 65-byte uncompressed point the
// browser's subscribe() wants (base64url), the private key as a JWK.
async function generateVapidKeys() {
  const pair = await subtle().generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pub = new Uint8Array(await subtle().exportKey('raw', pair.publicKey));
  const jwk = await subtle().exportKey('jwk', pair.privateKey);
  return { publicKey: b64url(pub), privateJwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d } };
}

// The same keys from the usual web-push env form: public key as base64url of
// the raw point, private key as base64url of the 32-byte scalar.
function vapidFromEnv(publicKey, privateKey) {
  const pub = unb64url(publicKey);
  if (pub.length !== 65 || pub[0] !== 4) throw new Error('VAPID public key must be a 65-byte uncompressed P-256 point');
  return { publicKey: b64url(pub), privateJwk: { kty: 'EC', crv: 'P-256', x: b64url(pub.slice(1, 33)), y: b64url(pub.slice(33, 65)), d: b64url(unb64url(privateKey)) } };
}

// "Authorization: vapid t=<jwt>, k=<public key>" for one push service.
async function vapidAuthorization(endpoint, { publicKey, privateJwk }, subject, now = Date.now()) {
  const aud = new URL(endpoint).origin;
  const header = b64url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  // Services refuse an expiry more than 24 hours out; 12 leaves room for skew.
  const claims = b64url(enc.encode(JSON.stringify({ aud, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })));
  const key = await subtle().importKey('jwk', { ...privateJwk, ext: true }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  // WebCrypto's ECDSA signature is already r||s, the form a JWS wants.
  const sig = new Uint8Array(await subtle().sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${header}.${claims}`)));
  return `vapid t=${header}.${claims}.${b64url(sig)}, k=${publicKey}`;
}

async function hmac(key, data) {
  const k = await subtle().importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await subtle().sign('HMAC', k, data));
}

// RFC 8291 encryption of one message for one subscription. Returns the body
// to POST: salt | record size | key id length | our public key | ciphertext.
// `salt` and `serverKeys` are only passed by tests.
async function encryptPayload(subscription, payload, { salt, serverKeys } = {}) {
  const uaPublic = unb64url(subscription.keys.p256dh);
  const authSecret = unb64url(subscription.keys.auth);
  const ours = serverKeys || await subtle().generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await subtle().exportKey('raw', ours.publicKey));
  const theirs = await subtle().importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await subtle().deriveBits({ name: 'ECDH', public: theirs }, ours.privateKey, 256));

  // IKM = HKDF(auth, ecdh, "WebPush: info" | 0 | ua_public | as_public, 32)
  const prkKey = await hmac(authSecret, ecdh);
  const ikm = await hmac(prkKey, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic, new Uint8Array([1])));
  const s = salt || globalThis.crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(s, ikm);
  const cek = (await hmac(prk, concat(enc.encode('Content-Encoding: aes128gcm\0'), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, concat(enc.encode('Content-Encoding: nonce\0'), new Uint8Array([1])))).slice(0, 12);

  // One record, so it is the last: the plaintext ends with the 0x02 delimiter.
  const plain = concat(typeof payload === 'string' ? enc.encode(payload) : payload, new Uint8Array([2]));
  const aes = await subtle().importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const cipher = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: nonce }, aes, plain));

  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  return concat(s, rs, new Uint8Array([asPublic.length]), asPublic, cipher);
}

// Push services the server will POST to. A subscription is an arbitrary URL
// handed in by a browser, so without this list anyone signed in could have
// the server send requests wherever they liked.
const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/,                 // Chrome, Edge on Android, Samsung
  /^android\.googleapis\.com$/,
  /^updates\.push\.services\.mozilla\.com$/, // Firefox
  /^[a-z0-9-]+\.push\.services\.mozilla\.com$/,
  /^web\.push\.apple\.com$/,                 // Safari, iPhone home-screen apps
  /^[a-z0-9-]+\.push\.apple\.com$/,
  /^[a-z0-9-]+\.notify\.windows\.com$/,      // Edge on Windows
];
function isPushEndpoint(endpoint) {
  try {
    const u = new URL(endpoint);
    return u.protocol === 'https:' && !u.port && PUSH_HOSTS.some(re => re.test(u.hostname));
  } catch (_) { return false; }
}
// A browser subscription as stored: only the fields a push needs.
function cleanSubscription(sub) {
  if (!sub || typeof sub !== 'object' || !isPushEndpoint(sub.endpoint)) return null;
  const k = sub.keys || {};
  try {
    if (unb64url(k.p256dh).length !== 65 || unb64url(k.auth).length !== 16) return null;
  } catch (_) { return null; }
  return { endpoint: String(sub.endpoint), keys: { p256dh: String(k.p256dh), auth: String(k.auth) } };
}

// Send one message. Resolves to { ok, status, gone }: gone means the browser
// unsubscribed or the subscription expired (404/410), and it should be dropped.
async function sendPush(subscription, message, vapid, { subject, ttl = 24 * 3600, urgency = 'normal', fetchFn = fetch, now } = {}) {
  if (!isPushEndpoint(subscription.endpoint)) return { ok: false, status: 0, gone: true };
  const body = await encryptPayload(subscription, typeof message === 'string' ? message : JSON.stringify(message));
  const res = await fetchFn(subscription.endpoint, {
    method: 'POST',
    headers: {
      Authorization: await vapidAuthorization(subscription.endpoint, vapid, subject, now),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(ttl),
      Urgency: urgency,
    },
    body,
  });
  return { ok: res.status >= 200 && res.status < 300, status: res.status, gone: res.status === 404 || res.status === 410 };
}

module.exports = { b64url, unb64url, generateVapidKeys, vapidFromEnv, vapidAuthorization, encryptPayload, sendPush, isPushEndpoint, cleanSubscription, PUSH_HOSTS };
