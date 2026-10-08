// Noise state machine against the cacophony test vectors
// (github.com/centromere/cacophony, vectors/cacophony.txt, SHA-256
// 3bde7c09a6f349ee11c825c50fcc02649f8f02a47c857a459206b357f9386cae),
// filtered to the IK patterns with AESGCM/SHA256 that Conduit uses.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { HandshakeState, importPrivateKey, PROTOCOL_IK, PROTOCOL_IKPSK1 } from "../../src/e2e-noise.mjs";

const hex = (s) => Uint8Array.from(Buffer.from(s, "hex"));
const toHex = (b) => Buffer.from(b).toString("hex");
const vectors = JSON.parse(readFileSync(new URL("./cacophony-ik.json", import.meta.url), "utf8"))
  .filter((v) => v.protocol_name === PROTOCOL_IK || v.protocol_name === PROTOCOL_IKPSK1);

test("vector file contains both patterns", () => {
  assert.deepEqual(vectors.map((v) => v.protocol_name).sort(), [PROTOCOL_IK, PROTOCOL_IKPSK1].sort());
});

for (const v of vectors) {
  test(v.protocol_name, async () => {
    const pattern = v.protocol_name === PROTOCOL_IK ? "IK" : "IKpsk1";
    const init = await HandshakeState.create({
      pattern, initiator: true, prologue: hex(v.init_prologue),
      s: await importPrivateKey(hex(v.init_static)),
      e: await importPrivateKey(hex(v.init_ephemeral)),
      rs: hex(v.init_remote_static),
      psk: v.init_psks?.[0] ? hex(v.init_psks[0]) : undefined,
    });
    const resp = await HandshakeState.create({
      pattern, initiator: false, prologue: hex(v.resp_prologue),
      s: await importPrivateKey(hex(v.resp_static)),
      e: await importPrivateKey(hex(v.resp_ephemeral)),
      psk: v.resp_psks?.[0] ? hex(v.resp_psks[0]) : undefined,
    });

    // Handshake: message 0 initiator -> responder, message 1 back.
    const m0 = await init.writeMessage(hex(v.messages[0].payload));
    assert.equal(toHex(m0.message), v.messages[0].ciphertext, "message 0 ciphertext");
    const r0 = await resp.readMessage(m0.message);
    assert.equal(toHex(r0.payload), v.messages[0].payload, "message 0 payload");

    const m1 = await resp.writeMessage(hex(v.messages[1].payload));
    assert.equal(toHex(m1.message), v.messages[1].ciphertext, "message 1 ciphertext");
    const r1 = await init.readMessage(m1.message);
    assert.equal(toHex(r1.payload), v.messages[1].payload, "message 1 payload");

    assert.equal(toHex(init.handshakeHash), v.handshake_hash, "initiator handshake hash");
    assert.equal(toHex(resp.handshakeHash), v.handshake_hash, "responder handshake hash");

    // Transport: even messages from the initiator, odd from the responder.
    const ci = { send: r1.send, recv: r1.recv };
    const cr = { send: m1.send, recv: m1.recv };
    for (let i = 2; i < v.messages.length; i++) {
      const fromInit = i % 2 === 0;
      const [tx, rx] = fromInit ? [ci.send, cr.recv] : [cr.send, ci.recv];
      const ct = await tx.encryptWithAd(new Uint8Array(0), hex(v.messages[i].payload));
      assert.equal(toHex(ct), v.messages[i].ciphertext, `transport message ${i}`);
      const pt = await rx.decryptWithAd(new Uint8Array(0), ct);
      assert.equal(toHex(pt), v.messages[i].payload, `transport payload ${i}`);
    }
  });
}
