import { test } from "node:test";
import assert from "node:assert/strict";
import { createECDH, createDecipheriv, createHmac, verify } from "node:crypto";
import { EventEmitter } from "node:events";
import { b64u, encryptPayload, endpointUrl, generateVapidPrivateKey, isPublicAddress, sendPush, validateSubscription, vapidJwt, vapidKeys } from "../src/webpush.mjs";

// RFC 8291, Appendix A.
const RFC = {
  plaintext: "When I grow up, I want to be a watermelon",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  message: "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

test("RFC 8291 Appendix A: byte-exact encryption", () => {
  const out = encryptPayload({
    uaPublic: b64u.dec(RFC.uaPublic), authSecret: b64u.dec(RFC.auth), plaintext: RFC.plaintext,
    salt: b64u.dec(RFC.salt), asPrivate: b64u.dec(RFC.asPrivate),
  });
  assert.equal(b64u.enc(out), RFC.message);
});

// Independent receiver side (user agent), written from the RFC, to show that a
// fresh random message decrypts — not only the fixed example.
function uaDecrypt(msg, uaPrivate, authSecret) {
  const salt = msg.subarray(0, 16);
  const idlen = msg[20];
  const asPublic = msg.subarray(21, 21 + idlen);
  const ct = msg.subarray(21 + idlen);
  const ua = createECDH("prime256v1"); ua.setPrivateKey(uaPrivate);
  const h = (k, d) => createHmac("sha256", k).update(d).digest();
  const prkKey = h(authSecret, ua.computeSecret(asPublic));
  const ikm = h(prkKey, Buffer.concat([Buffer.from("WebPush: info\0"), ua.getPublicKey(), asPublic, Buffer.from([1])]));
  const prk = h(salt, ikm);
  const cek = h(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01")).subarray(0, 16);
  const nonce = h(prk, Buffer.from("Content-Encoding: nonce\0\x01")).subarray(0, 12);
  const d = createDecipheriv("aes-128-gcm", cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const pt = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  assert.equal(pt[pt.length - 1], 2, "last-record delimiter");
  return pt.subarray(0, pt.length - 1).toString();
}

test("random payload decrypts on the receiving side", () => {
  const ua = createECDH("prime256v1"); ua.generateKeys();
  const auth = Buffer.alloc(16, 7);
  const msg = encryptPayload({ uaPublic: ua.getPublicKey(), authSecret: auth, plaintext: '{"t":"Briefing ready"}' });
  assert.equal(uaDecrypt(msg, ua.getPrivateKey(), auth), '{"t":"Briefing ready"}');
});

test("VAPID JWT verifies with the public key and has the right claims", () => {
  const keys = vapidKeys(generateVapidPrivateKey());
  const now = Date.UTC(2026, 10, 23, 7, 0, 0);
  const jwt = vapidJwt({ audience: "https://web.push.apple.com", subject: "mailto:owner@example.com", keys, now });
  const [h, c, s] = jwt.split(".");
  assert.deepEqual(JSON.parse(b64u.dec(h)), { typ: "JWT", alg: "ES256" });
  const claims = JSON.parse(b64u.dec(c));
  assert.equal(claims.aud, "https://web.push.apple.com");
  assert.equal(claims.sub, "mailto:owner@example.com");
  assert.ok(claims.exp - now / 1000 <= 24 * 3600 && claims.exp > now / 1000);
  assert.equal(b64u.dec(s).length, 64, "IEEE P1363 r||s, not DER");
  assert.ok(verify("sha256", Buffer.from(`${h}.${c}`), { key: keys.publicKey, dsaEncoding: "ieee-p1363" }, b64u.dec(s)));
  assert.throws(() => vapidJwt({ audience: "x", subject: "owner", keys }), /mailto/);
});

test("endpoint allowlist: scheme, port, credentials, host boundary", () => {
  for (const ok of [
    "https://fcm.googleapis.com/fcm/send/abc",
    "https://web.push.apple.com/QH",
    "https://updates.push.services.mozilla.com/wpush/v2/x",
    "https://wns2-par02p.notify.windows.com/w/?token=x",
  ]) assert.ok(endpointUrl(ok));
  for (const bad of [
    "http://fcm.googleapis.com/x",
    "https://fcm.googleapis.com:8443/x",
    "https://user:pw@fcm.googleapis.com/x",
    "https://fcm.googleapis.com.evil.test/x",
    "https://evilnotify.windows.com/x",
    "https://notify.windows.com/x",
    "https://127.0.0.1/x",
    "https://[::1]/x",
    "https://localhost/x",
    "file:///etc/passwd",
    "not a url",
  ]) assert.throws(() => endpointUrl(bad), undefined, bad);
});

test("subscription key sizes are enforced", () => {
  const ua = createECDH("prime256v1"); ua.generateKeys();
  const good = { endpoint: "https://web.push.apple.com/x", keys: { p256dh: b64u.enc(ua.getPublicKey()), auth: b64u.enc(Buffer.alloc(16)) } };
  assert.ok(validateSubscription(good));
  assert.throws(() => validateSubscription({ ...good, keys: { ...good.keys, auth: b64u.enc(Buffer.alloc(15)) } }));
  assert.throws(() => validateSubscription({ ...good, keys: { ...good.keys, p256dh: b64u.enc(Buffer.alloc(65)) } }));
  assert.throws(() => validateSubscription({ ...good, keys: { ...good.keys, p256dh: "%%%" } }));
});

test("only public addresses pass the connect-time check", () => {
  for (const ip of ["142.250.185.74", "17.253.144.10", "2a00:1450:4001:82b::200a"]) assert.ok(isPublicAddress(ip), ip);
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1",
    "0.0.0.0", "224.0.0.1", "::1", "::", "fe80::1", "fd00::1", "fc00::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "2001:db8::1"]) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
});

test("sendPush: headers, no redirect follow, status passed through", async () => {
  const keys = vapidKeys(generateVapidPrivateKey());
  const ua = createECDH("prime256v1"); ua.generateKeys();
  const subscription = { endpoint: "https://web.push.apple.com/abc?x=1", p256dh: b64u.enc(ua.getPublicKey()), auth: b64u.enc(Buffer.alloc(16, 1)) };
  let seen;
  const transport = (opts, cb) => {
    seen = opts;
    const req = new EventEmitter();
    req.end = (body) => {
      seen.body = body;
      const res = new EventEmitter(); res.statusCode = 301;
      cb(res); res.emit("end");
    };
    req.destroy = () => {};
    return req;
  };
  const r = await sendPush({ subscription, payload: { t: "x" }, keys, subject: "mailto:a@b.c", transport });
  assert.equal(r.status, 301, "a redirect is reported, never followed");
  assert.equal(seen.hostname, "web.push.apple.com");
  assert.equal(seen.port, 443);
  assert.equal(seen.path, "/abc?x=1");
  assert.equal(seen.headers["Content-Encoding"], "aes128gcm");
  assert.match(seen.headers.Authorization, /^vapid t=[^.]+\.[^.]+\.[^,]+, k=[A-Za-z0-9_-]{87}$/);
  assert.equal(typeof seen.lookup, "function", "connect-time address check installed");
  assert.equal(uaDecrypt(seen.body, ua.getPrivateKey(), Buffer.alloc(16, 1)), '{"t":"x"}');
});

test("connect-time lookup rejects a host resolving to a private address", async () => {
  const keys = vapidKeys(generateVapidPrivateKey());
  const ua = createECDH("prime256v1"); ua.generateKeys();
  const subscription = { endpoint: "https://web.push.apple.com/abc", p256dh: b64u.enc(ua.getPublicKey()), auth: b64u.enc(Buffer.alloc(16)) };
  let lookupFn;
  const transport = (opts) => { lookupFn = opts.lookup; const req = new EventEmitter(); req.end = () => {}; req.destroy = () => {}; return req; };
  sendPush({ subscription, payload: {}, keys, subject: "mailto:a@b.c", transport }).catch(() => {});
  // The real lookup function, fed a fake DNS answer through node:dns is not
  // injectable, so exercise it on a name that resolves locally.
  await new Promise((resolve) => lookupFn("localhost", {}, (err) => { assert.equal(err?.code, "EPUSHADDR"); resolve(); }));
});
