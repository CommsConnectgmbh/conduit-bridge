// Noise Protocol Framework (revision 34), exactly two patterns:
//   Noise_IK_25519_AESGCM_SHA256      device reconnects to a known bridge
//   Noise_IKpsk1_25519_AESGCM_SHA256  device pairs with a code from a QR
//
// Written against the WebCrypto API only, so the very same file runs in the
// browser (app) and in Node (bridge). No primitive is implemented here: X25519,
// AES-256-GCM, SHA-256 and HMAC all come from crypto.subtle. What this file
// does is the Noise state machine (CipherState, SymmetricState, HandshakeState)
// as specified in sections 5 and 9 of the spec, verified against the
// cacophony test vectors (test/e2e/noise.vectors.test.mjs).
//
// Static private keys may be non-extractable CryptoKeys: the state machine
// only ever calls deriveBits with them and never reads their bytes.

const subtle = globalThis.crypto.subtle;

export const DHLEN = 32;
export const HASHLEN = 32;
export const TAGLEN = 16;
export const MAX_MESSAGE = 65535;
// 2^64 - 1 is reserved by the spec (section 5.1); a CipherState that reaches
// it must not encrypt again.
const NONCE_RESERVED = 0xffffffffffffffffn;

const PATTERNS = {
  IK: {
    pre: { responder: ["s"] },
    messages: [["e", "es", "s", "ss"], ["e", "ee", "se"]],
  },
  IKpsk1: {
    pre: { responder: ["s"] },
    messages: [["e", "es", "s", "ss", "psk"], ["e", "ee", "se"]],
  },
};

export const PROTOCOL_IK = "Noise_IK_25519_AESGCM_SHA256";
export const PROTOCOL_IKPSK1 = "Noise_IKpsk1_25519_AESGCM_SHA256";

export class NoiseError extends Error {
  constructor(message) {
    super(message);
    this.name = "NoiseError";
  }
}

// ── bytes ────────────────────────────────────────────────────────────────────

const enc = new TextEncoder();
export const utf8 = (s) => enc.encode(s);

export function concat(...parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function equalBytes(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

// ── primitives (WebCrypto) ──────────────────────────────────────────────────

const X25519 = { name: "X25519" };
// PKCS#8 wrapper for a raw 32-byte X25519 private key (RFC 8410).
const PKCS8_X25519_PREFIX = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20]);

/**
 * A DH key pair as used by the state machine: the private half is a
 * CryptoKey, the public half raw bytes.
 * @typedef {{ privateKey: CryptoKey, publicKey: Uint8Array }} KeyPair
 */

/** Fresh key pair. `extractable` only affects the private key. */
export async function generateKeyPair(extractable = false) {
  const kp = await subtle.generateKey(X25519, extractable, ["deriveBits"]);
  const publicKey = new Uint8Array(await subtle.exportKey("raw", kp.publicKey));
  return { privateKey: kp.privateKey, publicKey };
}

/** Import a raw private key (tests, bridge identity file). */
export async function importPrivateKey(raw, extractable = false) {
  if (raw.length !== DHLEN) throw new NoiseError("private key must be 32 bytes");
  const privateKey = await subtle.importKey("pkcs8", concat(PKCS8_X25519_PREFIX, raw), X25519, true, ["deriveBits"]);
  const jwk = await subtle.exportKey("jwk", privateKey);
  const pub = await subtle.importKey("jwk", { kty: "OKP", crv: "X25519", x: jwk.x }, X25519, true, []);
  const publicKey = new Uint8Array(await subtle.exportKey("raw", pub));
  const finalKey = extractable ? privateKey : await subtle.importKey("pkcs8", concat(PKCS8_X25519_PREFIX, raw), X25519, false, ["deriveBits"]);
  return { privateKey: finalKey, publicKey };
}

async function dh(keyPair, publicKey) {
  if (publicKey.length !== DHLEN) throw new NoiseError("public key must be 32 bytes");
  const pub = await subtle.importKey("raw", publicKey, X25519, false, []);
  // WebCrypto rejects small-order points (all-zero shared secret), which the
  // spec allows implementations to do (section 12.1).
  return new Uint8Array(await subtle.deriveBits({ name: "X25519", public: pub }, keyPair.privateKey, 256));
}

async function hash(data) {
  return new Uint8Array(await subtle.digest("SHA-256", data));
}

async function hmac(key, data) {
  const k = await subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await subtle.sign("HMAC", k, data));
}

/** Noise HKDF (section 4.3) with two or three outputs. */
async function hkdf(chainingKey, ikm, outputs) {
  const tempKey = await hmac(chainingKey, ikm);
  const out1 = await hmac(tempKey, Uint8Array.of(1));
  const out2 = await hmac(tempKey, concat(out1, Uint8Array.of(2)));
  if (outputs === 2) return [out1, out2];
  const out3 = await hmac(tempKey, concat(out2, Uint8Array.of(3)));
  return [out1, out2, out3];
}

/** AESGCM nonce: 32 zero bits, then the 64-bit counter big-endian (section 12.4). */
function nonceBytes(n) {
  const iv = new Uint8Array(12);
  new DataView(iv.buffer).setBigUint64(4, n, false);
  return iv;
}

async function aesKey(k) {
  return subtle.importKey("raw", k, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

// ── CipherState (section 5.1) ───────────────────────────────────────────────

export class CipherState {
  #k = null; // raw 32 bytes, kept for Rekey()
  #key = null; // imported CryptoKey
  #n = 0n;

  async initializeKey(k) {
    this.#k = k ? Uint8Array.from(k) : null;
    this.#key = k ? await aesKey(k) : null;
    this.#n = 0n;
  }

  hasKey() { return this.#key !== null; }

  /** Test hook only: jump the counter to exercise exhaustion handling. */
  _setNonceForTest(n) { this.#n = BigInt(n); }

  async encryptWithAd(ad, plaintext) {
    if (!this.#key) return Uint8Array.from(plaintext);
    if (this.#n >= NONCE_RESERVED) throw new NoiseError("nonce exhausted");
    const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: nonceBytes(this.#n), additionalData: ad, tagLength: 128 }, this.#key, plaintext));
    this.#n += 1n;
    return ct;
  }

  async decryptWithAd(ad, ciphertext) {
    if (!this.#key) return Uint8Array.from(ciphertext);
    if (this.#n >= NONCE_RESERVED) throw new NoiseError("nonce exhausted");
    let pt;
    try {
      pt = new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: nonceBytes(this.#n), additionalData: ad, tagLength: 128 }, this.#key, ciphertext));
    } catch {
      // The counter only advances on success (section 5.1).
      throw new NoiseError("decryption failed");
    }
    this.#n += 1n;
    return pt;
  }

  /** Rekey() with the AESGCM default: k = ENCRYPT(k, 2^64-1, empty, zeros)[0:32]. */
  async rekey() {
    if (!this.#key) throw new NoiseError("rekey without key");
    const out = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: nonceBytes(NONCE_RESERVED), additionalData: new Uint8Array(0), tagLength: 128 }, this.#key, new Uint8Array(32)));
    const k = out.slice(0, 32);
    this.#k = k;
    this.#key = await aesKey(k);
    // The nonce is deliberately NOT reset: rekeying changes the key, and the
    // counter keeps guarding against reuse across the whole session.
  }
}

// ── SymmetricState (section 5.2) ────────────────────────────────────────────

class SymmetricState {
  cs = new CipherState();
  ck = null;
  h = null;

  async initialize(protocolName) {
    const name = utf8(protocolName);
    if (name.length <= HASHLEN) {
      this.h = new Uint8Array(HASHLEN);
      this.h.set(name);
    } else {
      this.h = await hash(name);
    }
    this.ck = Uint8Array.from(this.h);
    await this.cs.initializeKey(null);
  }

  async mixKey(ikm) {
    const [ck, tempK] = await hkdf(this.ck, ikm, 2);
    this.ck = ck;
    await this.cs.initializeKey(tempK.slice(0, 32));
  }

  async mixHash(data) {
    this.h = await hash(concat(this.h, data));
  }

  async mixKeyAndHash(ikm) {
    const [ck, tempH, tempK] = await hkdf(this.ck, ikm, 3);
    this.ck = ck;
    await this.mixHash(tempH);
    await this.cs.initializeKey(tempK.slice(0, 32));
  }

  async encryptAndHash(plaintext) {
    const ct = await this.cs.encryptWithAd(this.h, plaintext);
    await this.mixHash(ct);
    return ct;
  }

  async decryptAndHash(ciphertext) {
    const pt = await this.cs.decryptWithAd(this.h, ciphertext);
    await this.mixHash(ciphertext);
    return pt;
  }

  async split() {
    const [k1, k2] = await hkdf(this.ck, new Uint8Array(0), 2);
    const c1 = new CipherState();
    const c2 = new CipherState();
    await c1.initializeKey(k1.slice(0, 32));
    await c2.initializeKey(k2.slice(0, 32));
    return [c1, c2];
  }
}

// ── HandshakeState (section 5.3) ────────────────────────────────────────────

/**
 * @typedef {{
 *   pattern: "IK" | "IKpsk1",
 *   initiator: boolean,
 *   prologue: Uint8Array,
 *   s: KeyPair,
 *   rs?: Uint8Array,
 *   psk?: Uint8Array,
 *   e?: KeyPair,          // tests only: fixed ephemeral
 * }} HandshakeOptions
 */
export class HandshakeState {
  #ss = new SymmetricState();
  #pattern;
  #initiator;
  #s; #e; #rs = null; #re = null;
  #psk = null;
  #fixedEphemeral = null;
  #index = 0;
  #done = false;
  #pskMode;

  /** @param {HandshakeOptions} opts */
  static async create(opts) {
    const hs = new HandshakeState();
    await hs.#init(opts);
    return hs;
  }

  async #init({ pattern, initiator, prologue, s, rs, psk, e }) {
    const p = PATTERNS[pattern];
    if (!p) throw new NoiseError(`unsupported pattern ${pattern}`);
    this.#pattern = p;
    this.#pskMode = pattern.includes("psk");
    if (this.#pskMode) {
      if (!(psk instanceof Uint8Array) || psk.length !== 32) throw new NoiseError("psk must be 32 bytes");
      this.#psk = Uint8Array.from(psk);
    }
    if (!s) throw new NoiseError("static key required");
    this.#initiator = initiator;
    this.#s = s;
    this.#fixedEphemeral = e || null;
    if (initiator) {
      if (!(rs instanceof Uint8Array) || rs.length !== DHLEN) throw new NoiseError("initiator needs the responder's static key");
      this.#rs = Uint8Array.from(rs);
    }
    await this.#ss.initialize(pattern === "IK" ? PROTOCOL_IK : PROTOCOL_IKPSK1);
    await this.#ss.mixHash(prologue || new Uint8Array(0));
    // Pre-message "<- s": the responder's static key is known to both sides.
    await this.#ss.mixHash(initiator ? this.#rs : this.#s.publicKey);
  }

  get remoteStatic() { return this.#rs; }
  get handshakeHash() {
    if (!this.#done) throw new NoiseError("handshake not finished");
    return Uint8Array.from(this.#ss.h);
  }
  get isDone() { return this.#done; }

  #myTurn() {
    // Message 0 is sent by the initiator, message 1 by the responder.
    return (this.#index % 2 === 0) === this.#initiator;
  }

  async #dhToken(token) {
    const i = this.#initiator;
    switch (token) {
      case "ee": return dh(this.#e, this.#re);
      case "es": return i ? dh(this.#e, this.#rs) : dh(this.#s, this.#re);
      case "se": return i ? dh(this.#s, this.#re) : dh(this.#e, this.#rs);
      case "ss": return dh(this.#s, this.#rs);
      default: throw new NoiseError(`bad token ${token}`);
    }
  }

  /**
   * WriteMessage: returns the handshake message, and after the last one also
   * the two CipherStates as { send, recv } for this side.
   */
  async writeMessage(payload = new Uint8Array(0)) {
    if (this.#done) throw new NoiseError("handshake already finished");
    if (!this.#myTurn()) throw new NoiseError("not our turn to write");
    const tokens = this.#pattern.messages[this.#index];
    const parts = [];
    for (const t of tokens) {
      if (t === "e") {
        this.#e = this.#fixedEphemeral && this.#index < 2 ? this.#fixedEphemeral : await generateKeyPair(false);
        parts.push(this.#e.publicKey);
        await this.#ss.mixHash(this.#e.publicKey);
        if (this.#pskMode) await this.#ss.mixKey(this.#e.publicKey);
      } else if (t === "s") {
        parts.push(await this.#ss.encryptAndHash(this.#s.publicKey));
      } else if (t === "psk") {
        await this.#ss.mixKeyAndHash(this.#psk);
      } else {
        await this.#ss.mixKey(await this.#dhToken(t));
      }
    }
    parts.push(await this.#ss.encryptAndHash(payload));
    const message = concat(...parts);
    if (message.length > MAX_MESSAGE) throw new NoiseError("handshake message too long");
    return this.#advance(message, null);
  }

  /** ReadMessage: returns the decrypted payload (and CipherStates when done). */
  async readMessage(message) {
    if (this.#done) throw new NoiseError("handshake already finished");
    if (this.#myTurn()) throw new NoiseError("not our turn to read");
    if (!(message instanceof Uint8Array) || message.length > MAX_MESSAGE) throw new NoiseError("bad handshake message");
    const tokens = this.#pattern.messages[this.#index];
    let off = 0;
    const take = (n) => {
      if (off + n > message.length) throw new NoiseError("handshake message too short");
      const b = message.subarray(off, off + n);
      off += n;
      return b;
    };
    for (const t of tokens) {
      if (t === "e") {
        this.#re = Uint8Array.from(take(DHLEN));
        await this.#ss.mixHash(this.#re);
        if (this.#pskMode) await this.#ss.mixKey(this.#re);
      } else if (t === "s") {
        const len = this.#ss.cs.hasKey() ? DHLEN + TAGLEN : DHLEN;
        const rs = await this.#ss.decryptAndHash(take(len));
        if (this.#rs && !equalBytes(this.#rs, rs)) throw new NoiseError("unexpected remote static key");
        this.#rs = Uint8Array.from(rs);
      } else if (t === "psk") {
        await this.#ss.mixKeyAndHash(this.#psk);
      } else {
        await this.#ss.mixKey(await this.#dhToken(t));
      }
    }
    const payload = await this.#ss.decryptAndHash(message.subarray(off));
    return this.#advance(null, payload);
  }

  async #advance(message, payload) {
    this.#index += 1;
    let send = null, recv = null;
    if (this.#index === this.#pattern.messages.length) {
      const [c1, c2] = await this.#ss.split();
      // Initiator sends with c1, responder with c2 (section 5.3, Split()).
      send = this.#initiator ? c1 : c2;
      recv = this.#initiator ? c2 : c1;
      this.#done = true;
      this.#e = null;
      this.#psk = null;
    }
    return { message, payload, send, recv };
  }
}
