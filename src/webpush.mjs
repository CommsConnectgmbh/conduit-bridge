// Web Push for the installed PWA (Conduit 2.0, phase 4): tell the owner's
// phone that a scheduled briefing is ready.
//
// Built on node:crypto only, on purpose. The bridge has a single runtime
// dependency (ws); the `web-push` package would add asn1.js, http_ece, jws and
// https-proxy-agent to every installation for two small, fully specified
// algorithms:
//
//   RFC 8291  Message Encryption for Web Push (aes128gcm, RFC 8188 framing).
//             test/webpush.test.mjs checks the output byte for byte against the
//             worked example in RFC 8291 Appendix A.
//   RFC 8292  VAPID: an ES256 JWT that identifies this bridge to the push
//             service. Signed in IEEE P1363 form (r||s), which is what JWS
//             wants; node's default DER encoding would be rejected.
//
// What a push carries: a title and the automation id. Never the briefing
// text: the push service (Apple, Google, Mozilla, Microsoft) must not see it.
// The app fetches the content over its end-to-end link to the bridge.
//
// The bridge connects to a URL the phone gave it, so the URL is checked like
// untrusted input (no SSRF through the bridge):
//   - https on port 443 only, no user info, no redirects (3xx is an error);
//   - host must be one of the known push services, compared on the parsed
//     hostname with a real label boundary;
//   - the address it resolves to must be public (checked at connect time, so a
//     DNS answer cannot point the request at the LAN or loopback);
//   - 10 s timeout, at most 4 KB of response read.

import { createECDH, createHmac, createCipheriv, createPrivateKey, createPublicKey, randomBytes, sign } from "node:crypto";
import { request } from "node:https";
import { lookup as dnsLookup } from "node:dns";
import { isIP } from "node:net";

export const RECORD_SIZE = 4096;
export const PUSH_TIMEOUT_MS = 10_000;
export const MAX_RESPONSE_BYTES = 4096;
/** JWT lifetime; RFC 8292 allows up to 24 h, Apple is stricter in practice. */
export const VAPID_TTL_SECONDS = 12 * 3600;

const EXACT_HOSTS = new Set(["fcm.googleapis.com", "web.push.apple.com", "updates.push.services.mozilla.com"]);
const SUFFIX_HOSTS = [".notify.windows.com"];

export const b64u = {
  enc: (buf) => Buffer.from(buf).toString("base64url"),
  dec: (s) => {
    if (typeof s !== "string" || !/^[A-Za-z0-9_-]*={0,2}$/.test(s)) throw new Error("not base64url");
    return Buffer.from(s.replace(/=+$/, ""), "base64url");
  },
};

const hmac = (key, data) => createHmac("sha256", key).update(data).digest();
/** HKDF-Expand for a single block (every length here is <= 32). */
const expand = (prk, info, len) => hmac(prk, Buffer.concat([info, Buffer.from([1])])).subarray(0, len);

/**
 * RFC 8291 encryption of one message into one aes128gcm record.
 * `salt` and `asPrivate` are parameters only so the RFC example can be
 * reproduced in tests; production passes neither and gets fresh random ones.
 */
export function encryptPayload({ uaPublic, authSecret, plaintext, salt = randomBytes(16), asPrivate = null }) {
  if (!Buffer.isBuffer(uaPublic) || uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error("p256dh must be a 65-byte uncompressed P-256 key");
  if (!Buffer.isBuffer(authSecret) || authSecret.length !== 16) throw new Error("auth must be 16 bytes");
  const data = Buffer.from(plaintext);
  // One record: content + 0x02 delimiter + 16-byte tag must fit.
  if (data.length + 1 + 16 > RECORD_SIZE) throw new Error("payload too large");
  const ecdh = createECDH("prime256v1");
  if (asPrivate) ecdh.setPrivateKey(asPrivate); else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const ecdhSecret = ecdh.computeSecret(uaPublic);
  const prkKey = hmac(authSecret, ecdhSecret);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]);
  const ikm = expand(prkKey, keyInfo, 32);
  const prk = hmac(salt, ikm);
  const cek = expand(prk, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = expand(prk, Buffer.from("Content-Encoding: nonce\0"), 12);
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([data, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(16 + 4 + 1);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, body]);
}

/** A VAPID key pair from a base64url private scalar (32 bytes). */
export function vapidKeys(privateB64u) {
  const d = b64u.dec(privateB64u);
  if (d.length !== 32) throw new Error("VAPID private key must be 32 bytes");
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(d);
  const pub = ecdh.getPublicKey();
  const jwk = { kty: "EC", crv: "P-256", d: b64u.enc(d), x: b64u.enc(pub.subarray(1, 33)), y: b64u.enc(pub.subarray(33, 65)) };
  return { privateKey: createPrivateKey({ key: jwk, format: "jwk" }), publicKey: createPublicKey({ key: { ...jwk, d: undefined }, format: "jwk" }), publicRaw: pub };
}

export function generateVapidPrivateKey() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  // getPrivateKey can be shorter than 32 bytes when the scalar has leading zeros.
  const d = ecdh.getPrivateKey();
  return b64u.enc(Buffer.concat([Buffer.alloc(32 - d.length), d]));
}

/** RFC 8292 JWT. `subject` is a mailto: or https: contact (Apple requires one). */
export function vapidJwt({ audience, subject, keys, now = Date.now() }) {
  if (!/^(mailto:[^\s@]+@[^\s@]+|https:\/\/[^\s]+)$/.test(subject || "")) throw new Error("VAPID subject must be mailto: or https:");
  const head = b64u.enc(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const claims = b64u.enc(JSON.stringify({ aud: audience, exp: Math.floor(now / 1000) + VAPID_TTL_SECONDS, sub: subject }));
  const sig = sign("sha256", Buffer.from(`${head}.${claims}`), { key: keys.privateKey, dsaEncoding: "ieee-p1363" });
  return `${head}.${claims}.${b64u.enc(sig)}`;
}

/**
 * Check a push subscription the app sent. Returns the normalised subscription
 * or throws with a short reason. Nothing is fetched here.
 */
export function validateSubscription(sub) {
  if (!sub || typeof sub !== "object") throw new Error("subscription missing");
  const endpoint = endpointUrl(sub.endpoint);
  const keys = sub.keys || {};
  const p256dh = b64u.dec(String(keys.p256dh || ""));
  const auth = b64u.dec(String(keys.auth || ""));
  if (p256dh.length !== 65 || p256dh[0] !== 4) throw new Error("p256dh must be 65 bytes");
  if (auth.length !== 16) throw new Error("auth must be 16 bytes");
  return { endpoint: endpoint.href, p256dh: b64u.enc(p256dh), auth: b64u.enc(auth) };
}

export function endpointUrl(raw) {
  if (typeof raw !== "string" || raw.length > 2048) throw new Error("endpoint invalid");
  let u;
  try { u = new URL(raw); } catch { throw new Error("endpoint invalid"); }
  if (u.protocol !== "https:") throw new Error("endpoint must be https");
  if (u.port && u.port !== "443") throw new Error("endpoint port must be 443");
  if (u.username || u.password) throw new Error("endpoint must not carry credentials");
  const host = u.hostname.toLowerCase();
  if (isIP(host)) throw new Error("endpoint host must be a push service");
  if (!EXACT_HOSTS.has(host) && !SUFFIX_HOSTS.some((s) => host.endsWith(s) && host.length > s.length)) {
    throw new Error("endpoint host is not a known push service");
  }
  return u;
}

/** Private, loopback, link-local, multicast, reserved, documentation ranges. */
export function isPublicAddress(ip) {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && (b === 168 || (b === 0 && ip.startsWith("192.0.0.")) || ip.startsWith("192.0.2."))) return false;
    if (a === 198 && (b === 18 || b === 19 || ip.startsWith("198.51.100."))) return false;
    if (ip.startsWith("203.0.113.")) return false;
    return true;
  }
  if (v === 6) {
    const s = ip.toLowerCase();
    if (s === "::" || s === "::1") return false;
    const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPublicAddress(mapped[1]);
    if (/^::ffff:/.test(s) || /^64:ff9b:/.test(s)) return false;
    const first = parseInt(s.split(":")[0] || "0", 16);
    if ((first & 0xfe00) === 0xfc00) return false; // fc00::/7 unique local
    if ((first & 0xffc0) === 0xfe80) return false; // fe80::/10 link local
    if ((first & 0xff00) === 0xff00) return false; // multicast
    if (s.startsWith("2001:db8:") || s.startsWith("2001:db8::")) return false;
    return true;
  }
  return false;
}

function publicOnlyLookup(hostname, opts, cb) {
  dnsLookup(hostname, { ...opts, all: true }, (err, addrs) => {
    if (err) return cb(err);
    const list = Array.isArray(addrs) ? addrs : [{ address: addrs, family: opts.family || 4 }];
    const bad = list.find((a) => !isPublicAddress(a.address));
    if (bad || !list.length) return cb(Object.assign(new Error("push endpoint resolves to a non-public address"), { code: "EPUSHADDR" }));
    if (opts.all) return cb(null, list);
    cb(null, list[0].address, list[0].family);
  });
}

/**
 * Send one push. Resolves { status } with the push service's HTTP status;
 * 404/410 mean the subscription is gone and the caller deletes it.
 * `transport` is injectable for tests.
 */
export function sendPush({ subscription, payload, keys, subject, ttl = 3600, urgency = "high", now = Date.now(), transport = request }) {
  const u = endpointUrl(subscription.endpoint);
  const body = encryptPayload({ uaPublic: b64u.dec(subscription.p256dh), authSecret: b64u.dec(subscription.auth), plaintext: JSON.stringify(payload) });
  const jwt = vapidJwt({ audience: u.origin, subject, keys, now });
  const headers = {
    "Content-Type": "application/octet-stream",
    "Content-Encoding": "aes128gcm",
    "Content-Length": String(body.length),
    TTL: String(Math.max(0, Math.floor(ttl))),
    Urgency: urgency,
    Authorization: `vapid t=${jwt}, k=${b64u.enc(keys.publicRaw)}`,
  };
  return new Promise((resolve, reject) => {
    const req = transport({ method: "POST", hostname: u.hostname, port: 443, path: u.pathname + u.search, headers, lookup: publicOnlyLookup, timeout: PUSH_TIMEOUT_MS }, (res) => {
      let read = 0;
      res.on("data", (c) => { read += c.length; if (read > MAX_RESPONSE_BYTES) res.destroy(); });
      res.on("end", () => resolve({ status: res.statusCode }));
      res.on("close", () => resolve({ status: res.statusCode }));
      res.on("error", () => resolve({ status: res.statusCode }));
    });
    req.on("timeout", () => req.destroy(Object.assign(new Error("push timeout"), { code: "ETIMEDOUT" })));
    req.on("error", reject);
    req.end(body);
  });
}
