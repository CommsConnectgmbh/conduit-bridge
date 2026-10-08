// Failure behaviour of the Noise state machine (Fable review, condition A11c).
import { test } from "node:test";
import assert from "node:assert/strict";
import { HandshakeState, generateKeyPair, NoiseError, utf8, CipherState } from "../../src/e2e-noise.mjs";

const prologue = utf8("conduit-e2e-v1\0bridge.example");
const psk = () => globalThis.crypto.getRandomValues(new Uint8Array(32));

async function pair({ pattern = "IK", initPsk, respPsk, initPrologue = prologue, respPrologue = prologue, rs } = {}) {
  const bridge = await generateKeyPair();
  const device = await generateKeyPair();
  const init = await HandshakeState.create({ pattern, initiator: true, prologue: initPrologue, s: device, rs: rs ?? bridge.publicKey, psk: initPsk });
  const resp = await HandshakeState.create({ pattern, initiator: false, prologue: respPrologue, s: bridge, psk: respPsk });
  return { bridge, device, init, resp };
}

async function handshake(init, resp) {
  const m0 = await init.writeMessage(utf8('{"v":1}'));
  const r0 = await resp.readMessage(m0.message);
  const m1 = await resp.writeMessage(utf8('{"v":1}'));
  const r1 = await init.readMessage(m1.message);
  return { i: r1, r: m1, r0 };
}

test("happy path: both sides agree, responder learns the device key", async () => {
  const { device, init, resp } = await pair();
  const { i, r } = await handshake(init, resp);
  assert.deepEqual(resp.remoteStatic, device.publicKey);
  assert.deepEqual(init.handshakeHash, resp.handshakeHash);
  const ct = await i.send.encryptWithAd(new Uint8Array(0), utf8("hallo"));
  assert.equal(new TextDecoder().decode(await r.recv.decryptWithAd(new Uint8Array(0), ct)), "hallo");
});

test("pairing with the right psk works, a wrong psk fails at the responder", async () => {
  const k = psk();
  const ok = await pair({ pattern: "IKpsk1", initPsk: k, respPsk: k });
  await handshake(ok.init, ok.resp);
  const bad = await pair({ pattern: "IKpsk1", initPsk: k, respPsk: psk() });
  const m0 = await bad.init.writeMessage(utf8("x"));
  await assert.rejects(bad.resp.readMessage(m0.message), NoiseError);
});

test("initiator with a wrong bridge key cannot complete (MITM / DNS redirect)", async () => {
  const other = await generateKeyPair();
  const { init, resp } = await pair({ rs: other.publicKey });
  const m0 = await init.writeMessage(utf8("x"));
  await assert.rejects(resp.readMessage(m0.message), NoiseError);
});

test("prologue mismatch (different tunnel host) fails", async () => {
  const { init, resp } = await pair({ respPrologue: utf8("conduit-e2e-v1\0evil.example") });
  const m0 = await init.writeMessage(utf8("x"));
  await assert.rejects(resp.readMessage(m0.message), NoiseError);
});

test("tampered handshake and transport messages are rejected", async () => {
  const a = await pair();
  const m0 = await a.init.writeMessage(utf8("x"));
  const t = Uint8Array.from(m0.message); t[t.length - 1] ^= 1;
  await assert.rejects(a.resp.readMessage(t), NoiseError);

  const b = await pair();
  const { i, r } = await handshake(b.init, b.resp);
  const ct = await i.send.encryptWithAd(new Uint8Array(0), utf8("hallo"));
  ct[0] ^= 1;
  await assert.rejects(r.recv.decryptWithAd(new Uint8Array(0), ct), NoiseError);
});

test("replayed transport message is rejected (counter moved on)", async () => {
  const { init, resp } = await pair();
  const { i, r } = await handshake(init, resp);
  const ct = await i.send.encryptWithAd(new Uint8Array(0), utf8("eins"));
  await r.recv.decryptWithAd(new Uint8Array(0), ct);
  await assert.rejects(r.recv.decryptWithAd(new Uint8Array(0), ct), NoiseError);
});

test("truncated and oversized handshake messages are rejected", async () => {
  const { init, resp } = await pair();
  const m0 = await init.writeMessage(utf8("x"));
  await assert.rejects(resp.readMessage(m0.message.subarray(0, 40)), NoiseError);
  await assert.rejects(resp.readMessage(new Uint8Array(65536)), NoiseError);
});

test("out-of-turn calls are refused", async () => {
  const { init, resp } = await pair();
  await assert.rejects(resp.writeMessage(), NoiseError);
  await assert.rejects(init.readMessage(new Uint8Array(100)), NoiseError);
});

test("nonce exhaustion stops the cipher, rekey keeps the counter", async () => {
  const k = globalThis.crypto.getRandomValues(new Uint8Array(32));
  const a = new CipherState(); await a.initializeKey(k);
  const b = new CipherState(); await b.initializeKey(k);
  a._setNonceForTest(0xfffffffffffffffen);
  b._setNonceForTest(0xfffffffffffffffen);
  const ct = await a.encryptWithAd(new Uint8Array(0), utf8("last"));
  assert.equal(new TextDecoder().decode(await b.decryptWithAd(new Uint8Array(0), ct)), "last");
  await assert.rejects(a.encryptWithAd(new Uint8Array(0), utf8("x")), /nonce exhausted/);

  const c = new CipherState(); await c.initializeKey(k);
  const d = new CipherState(); await d.initializeKey(k);
  await d.decryptWithAd(new Uint8Array(0), await c.encryptWithAd(new Uint8Array(0), utf8("1")));
  await c.rekey(); await d.rekey();
  const ct2 = await c.encryptWithAd(new Uint8Array(0), utf8("2"));
  assert.equal(new TextDecoder().decode(await d.decryptWithAd(new Uint8Array(0), ct2)), "2");
  // A message encrypted before the rekey under the old key no longer opens.
  const e = new CipherState(); await e.initializeKey(k); e._setNonceForTest(2n);
  await assert.rejects(d.decryptWithAd(new Uint8Array(0), await e.encryptWithAd(new Uint8Array(0), utf8("3"))), NoiseError);
});

test("pairing requires a 32-byte psk", async () => {
  await assert.rejects(pair({ pattern: "IKpsk1", initPsk: new Uint8Array(16), respPsk: new Uint8Array(16) }), /psk must be 32 bytes/);
});

test("device private key can be non-extractable", async () => {
  const kp = await generateKeyPair(false);
  assert.equal(kp.privateKey.extractable, false);
  await assert.rejects(globalThis.crypto.subtle.exportKey("pkcs8", kp.privateKey));
});
