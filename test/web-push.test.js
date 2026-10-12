// Web Push from the server (web-push-core.js). A push that is encrypted or
// signed even slightly wrong is dropped silently by the push service or the
// browser, so the message format is checked three ways: against the worked
// example in RFC 8291 itself, by decrypting with Node's own crypto (written
// separately from the module, as a browser would), and by verifying the VAPID
// signature with Node's crypto.
'use strict';
const nodeCrypto = require('crypto');
const wp = require('../web-push-core');

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};
const buf = (s) => Buffer.from(wp.unb64url(s));
const hmac = (key, data) => nodeCrypto.createHmac('sha256', key).update(data).digest();

// The browser's side of RFC 8291, from the RFC's steps, using Node's crypto.
function decrypt(body, uaPrivate, uaPublic, authSecret) {
  const salt = body.subarray(0, 16);
  const rs = body.readUInt32BE(16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const cipher = body.subarray(21 + idlen);
  const ecdh = nodeCrypto.createECDH('prime256v1');
  ecdh.setPrivateKey(uaPrivate);
  const secret = ecdh.computeSecret(asPublic);
  const ikm = hmac(hmac(authSecret, secret), Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm\0'), Buffer.from([1])])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: nonce\0'), Buffer.from([1])])).subarray(0, 12);
  const d = nodeCrypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(cipher.subarray(cipher.length - 16));
  const plain = Buffer.concat([d.update(cipher.subarray(0, cipher.length - 16)), d.final()]);
  return { rs, idlen, text: plain.subarray(0, plain.length - 1).toString(), delimiter: plain[plain.length - 1] };
}

(async () => {
  // ---- RFC 8291 Appendix A --------------------------------------------
  {
    const asPublic = 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8';
    const asPrivate = 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw';
    const p = wp.unb64url(asPublic);
    const jwk = { kty: 'EC', crv: 'P-256', x: wp.b64url(p.slice(1, 33)), y: wp.b64url(p.slice(33)), d: asPrivate, ext: true };
    const serverKeys = {
      privateKey: await crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']),
      publicKey: await crypto.subtle.importKey('raw', p, { name: 'ECDH', namedCurve: 'P-256' }, true, []),
    };
    const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: {
      p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
      auth: 'BTBZMqHH6r4Tts7J_aSIgg' } };
    const body = await wp.encryptPayload(sub, 'When I grow up, I want to be a watermelon', { salt: wp.unb64url('DGv6ra1nlYgDCS1FRnbzlw'), serverKeys });
    const want = 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN';
    check('encryption matches the RFC 8291 worked example byte for byte', wp.b64url(body) === want, wp.b64url(body) === want ? '' : wp.b64url(body));
    const out = decrypt(Buffer.from(body), buf('q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94'), buf(sub.keys.p256dh), buf(sub.keys.auth));
    check('  ...and the RFC\'s receiver key decrypts it', out.text === 'When I grow up, I want to be a watermelon' && out.delimiter === 2 && out.rs === 4096 && out.idlen === 65);
  }

  // ---- a real round trip, as a browser would receive it ---------------
  {
    const ua = nodeCrypto.createECDH('prime256v1'); ua.generateKeys();
    const auth = nodeCrypto.randomBytes(16);
    const sub = { endpoint: 'https://web.push.apple.com/QH1', keys: { p256dh: wp.b64url(ua.getPublicKey()), auth: wp.b64url(auth) } };
    const msg = JSON.stringify({ title: 'Just listed: 2018 Prizm Josh Allen', body: '1 new listing · $184', url: '/?view=alerts' });
    const vapid = await wp.generateVapidKeys();
    let sent = null;
    const fetchFn = async (url, init) => { sent = { url, init }; return { status: 201 }; };
    const r = await wp.sendPush(sub, msg, vapid, { subject: 'mailto:test@example.com', fetchFn, now: Date.UTC(2026, 9, 12) });
    check('a push is POSTed to the subscription\'s endpoint and reported sent', r.ok && !r.gone && sent && sent.url === sub.endpoint && sent.init.method === 'POST');
    const h = sent.init.headers;
    check('  ...with the aes128gcm headers and a TTL', h['Content-Encoding'] === 'aes128gcm' && h['Content-Type'] === 'application/octet-stream' && h.TTL === '86400' && h.Urgency === 'normal');
    const out = decrypt(Buffer.from(sent.init.body), ua.getPrivateKey(), ua.getPublicKey(), auth);
    check('  ...and the browser\'s keys decrypt the message', out.text === msg);
    const again = await wp.encryptPayload(sub, msg);
    check('  ...with a fresh salt and key every time', wp.b64url(again).slice(0, 22) !== wp.b64url(sent.init.body).slice(0, 22));

    // VAPID: "vapid t=<jwt>, k=<key>", ES256 over header.claims, for the
    // endpoint's origin, expiring inside 24 hours.
    const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(h.Authorization);
    check('the VAPID header carries a JWT and the public key', !!m && m[4] === vapid.publicKey);
    const claims = JSON.parse(Buffer.from(m[2], 'base64url').toString());
    check('  ...for the push service\'s origin, our contact, under 24 hours', claims.aud === 'https://web.push.apple.com' && claims.sub === 'mailto:test@example.com'
      && claims.exp - Date.UTC(2026, 9, 12) / 1000 === 12 * 3600);
    const pub = nodeCrypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: vapid.privateJwk.x, y: vapid.privateJwk.y }, format: 'jwk' });
    const ok = nodeCrypto.verify('sha256', Buffer.from(`${m[1]}.${m[2]}`), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(m[3], 'base64url'));
    check('  ...signed with the private key (ES256, verified by Node)', ok);
    check('  ...and the public key is the 65-byte point subscribe() wants', wp.unb64url(vapid.publicKey).length === 65 && wp.unb64url(vapid.publicKey)[0] === 4);

    const gone = await wp.sendPush(sub, msg, vapid, { subject: 'mailto:x@y.z', fetchFn: async () => ({ status: 410 }) });
    check('a 410 from the push service marks the subscription gone', !gone.ok && gone.gone);
  }

  // ---- env keys ------------------------------------------------------
  {
    const k = await wp.generateVapidKeys();
    const back = wp.vapidFromEnv(k.publicKey, k.privateJwk.d);
    check('keys given in the usual env form round-trip', back.publicKey === k.publicKey && back.privateJwk.x === k.privateJwk.x && back.privateJwk.d === k.privateJwk.d);
  }

  // ---- where the server will send ------------------------------------
  {
    const keys = { p256dh: wp.b64url(Buffer.concat([Buffer.from([4]), nodeCrypto.randomBytes(64)])), auth: wp.b64url(nodeCrypto.randomBytes(16)) };
    const okHosts = ['https://fcm.googleapis.com/fcm/send/abc', 'https://updates.push.services.mozilla.com/wpush/v2/x', 'https://web.push.apple.com/QH', 'https://wns2-par02p.notify.windows.com/w/?token=x'];
    check('subscriptions from Chrome, Firefox, Apple and Edge push services are accepted', okHosts.every(e => wp.cleanSubscription({ endpoint: e, keys })));
    const bad = ['http://fcm.googleapis.com/x', 'https://fcm.googleapis.com:8443/x', 'https://evil.com/fcm.googleapis.com', 'https://fcm.googleapis.com.evil.com/x', 'https://169.254.169.254/latest', 'https://localhost/x', 'javascript:alert(1)'];
    check('  ...anything else is refused, so the server can\'t be aimed elsewhere', bad.every(e => !wp.cleanSubscription({ endpoint: e, keys })));
    check('  ...as are malformed keys', !wp.cleanSubscription({ endpoint: okHosts[0], keys: { p256dh: 'abc', auth: keys.auth } }) && !wp.cleanSubscription({ endpoint: okHosts[0], keys: { p256dh: keys.p256dh } }));
    const c = wp.cleanSubscription({ endpoint: okHosts[0], keys: { ...keys, extra: 'x' }, expirationTime: null, junk: 1 });
    check('  ...and only the endpoint and keys are kept', JSON.stringify(Object.keys(c)) === '["endpoint","keys"]' && JSON.stringify(Object.keys(c.keys)) === '["p256dh","auth"]');
  }

  console.log(failures ? `\n${failures} check(s) failed` : '\nall web-push checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
