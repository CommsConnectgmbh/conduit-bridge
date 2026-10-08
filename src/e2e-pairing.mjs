// Pairing codes for the end-to-end layer.
//
// A code is a 16-byte public id plus a 32-byte pre-shared key. Both travel
// only through an optical channel (QR on the bridge's loopback page or on an
// already paired device) or a link fragment, never through our servers. The
// device then runs Noise IKpsk1 with that PSK: without it nobody, including
// Cloudflare or our cloud, can complete or impersonate the pairing.
//
// Codes are single-use, expire after three minutes, and are bound to the
// account email they were issued for. At most a handful exist at a time.

import { randomBytes } from "node:crypto";

export const CODE_TTL_MS = 3 * 60_000;
const MAX_ACTIVE = 8;

/** @type {Map<string, { psk: Uint8Array, exp: number, email: string, issuedBy: string }>} */
const codes = new Map();

function gc(now = Date.now()) {
  for (const [id, c] of codes) if (c.exp <= now) codes.delete(id);
}

const b64u = (b) => Buffer.from(b).toString("base64url");

/**
 * Issue a code. `issuedBy` is "localhost" or "device:<id>" for the record.
 * @returns {{ codeId: Uint8Array, psk: Uint8Array, exp: number }}
 */
export function issuePairCode({ email, issuedBy }) {
  if (!email) throw new Error("pairing needs an account email");
  gc();
  if (codes.size >= MAX_ACTIVE) {
    // Drop the oldest instead of refusing: the newest QR on screen must work.
    const oldest = [...codes.entries()].sort((a, b) => a[1].exp - b[1].exp)[0];
    codes.delete(oldest[0]);
  }
  const codeId = new Uint8Array(randomBytes(16));
  const psk = new Uint8Array(randomBytes(32));
  const exp = Date.now() + CODE_TTL_MS;
  codes.set(b64u(codeId), { psk, exp, email, issuedBy });
  return { codeId, psk, exp };
}

/** PSK for a code id, without consuming it (the handshake may still fail). */
export function pskFor(codeId) {
  gc();
  return codes.get(b64u(codeId))?.psk ?? null;
}

/** Consume a code after a successful handshake; returns its record once. */
export function consumePairCode(codeId) {
  gc();
  const key = b64u(codeId);
  const c = codes.get(key);
  if (!c) return null;
  codes.delete(key);
  return c;
}

/**
 * What goes into the QR / link fragment. The app parses exactly this.
 * h = tunnel host, k = bridge static key, i = code id, p = PSK, e = expiry (ms).
 */
export function pairPayload({ host, bridgeKey, codeId, psk, exp }) {
  return { v: 1, h: host, k: b64u(bridgeKey), i: b64u(codeId), p: b64u(psk), e: exp };
}

/** Test hook. */
export function _resetPairCodes() { codes.clear(); }
