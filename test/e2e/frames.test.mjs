// Frame codec: round trips, strict rejection, and property-based fuzzing
// (Fable review, condition A11d).
import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import {
  decodeFrame, encodeOpen, encodeData, encodeClose, encodeWindowUpdate, encodePing, encodePong, encodeRekey, encodeGoaway,
  FrameError, T, KIND, MAX_PAYLOAD, HEADER, FLAG_END_STREAM,
} from "../../src/e2e-frames.mjs";

test("round trips", () => {
  const o = decodeFrame(encodeOpen(3, KIND.RPC, { method: "GET", path: "/api/sessions" }, 262144));
  assert.equal(o.name, "OPEN"); assert.equal(o.channel, 3); assert.equal(o.kind, KIND.RPC);
  assert.deepEqual(o.params, { method: "GET", path: "/api/sessions" }); assert.equal(o.window, 262144);
  const d = decodeFrame(encodeData(3, Uint8Array.of(1, 2, 3), true));
  assert.equal(d.end, true); assert.deepEqual([...d.payload], [1, 2, 3]);
  const c = decodeFrame(encodeClose(3, 1000, "fertig"));
  assert.equal(c.code, 1000); assert.equal(c.reason, "fertig");
  assert.equal(decodeFrame(encodeWindowUpdate(3, 65536)).credits, 65536);
  assert.equal(decodeFrame(encodePing(new Uint8Array(8))).name, "PING");
  assert.equal(decodeFrame(encodePong(new Uint8Array(8))).name, "PONG");
  assert.equal(decodeFrame(encodeRekey()).name, "REKEY");
  const g = decodeFrame(encodeGoaway(4001, "revoked"));
  assert.equal(g.code, 4001); assert.equal(g.reason, "revoked");
});

test("reasons are cut to 200 bytes on a code point boundary", () => {
  const c = decodeFrame(encodeClose(1, 1, "ü".repeat(150)));
  assert.ok(new TextEncoder().encode(c.reason).length <= 200);
  assert.ok(!c.reason.includes("�"));
});

test("payload size limit", () => {
  assert.throws(() => encodeData(1, new Uint8Array(MAX_PAYLOAD + 1)), FrameError);
  decodeFrame(encodeData(1, new Uint8Array(MAX_PAYLOAD)));
  assert.throws(() => decodeFrame(new Uint8Array(HEADER + MAX_PAYLOAD + 1)), FrameError);
});

const raw = (type, flags, channel, payload = []) => {
  const b = new Uint8Array(6 + payload.length);
  const dv = new DataView(b.buffer); dv.setUint8(0, type); dv.setUint8(1, flags); dv.setUint32(2, channel);
  b.set(payload, 6); return b;
};

test("strict rejection", () => {
  const bad = [
    new Uint8Array(5),
    raw(0x00, 0, 1), raw(0x09, 0, 1), raw(0xff, 0, 1),
    raw(T.DATA, 0x02, 1), raw(T.OPEN, 0x01, 1, [1, 0x7b, 0x7d]),
    raw(T.PING, 0, 1, new Array(8).fill(0)), raw(T.DATA, 0, 0),
    raw(T.OPEN, 0, 1, [0x09, ...new TextEncoder().encode('{"window":1}')]),
    raw(T.OPEN, 0, 1, [KIND.RPC, ...new TextEncoder().encode("[1]")]),
    raw(T.OPEN, 0, 1, [KIND.RPC, ...new TextEncoder().encode('{"window":0}')]),
    raw(T.OPEN, 0, 1, [KIND.RPC, ...new TextEncoder().encode('{"window":1.5}')]),
    raw(T.OPEN, 0, 1, [KIND.RPC, 0xff, 0xfe]),
    raw(T.CLOSE, 0, 1, [0]), raw(T.CLOSE, 0, 1, [0, 0, 0xc3]),
    raw(T.WINDOW_UPDATE, 0, 1, [0, 0, 0, 0]), raw(T.WINDOW_UPDATE, 0, 1, [0x80, 0, 0, 0]), raw(T.WINDOW_UPDATE, 0, 1, [0, 0, 1]),
    raw(T.PING, 0, 0, [1, 2, 3]), raw(T.REKEY, 0, 0, [1]), raw(T.GOAWAY, 0, 0, [1]),
  ];
  for (const b of bad) assert.throws(() => decodeFrame(b), FrameError, `should reject ${[...b.subarray(0, 8)]}`);
});

test("fuzz: arbitrary bytes either decode or throw FrameError, never anything else", () => {
  fc.assert(fc.property(fc.uint8Array({ minLength: 0, maxLength: 300 }), (bytes) => {
    try {
      const f = decodeFrame(bytes);
      assert.ok(typeof f.name === "string");
    } catch (e) {
      if (!(e instanceof FrameError)) throw e;
    }
  }), { numRuns: 20000 });
});

test("fuzz: structured frames with random header fields", () => {
  fc.assert(fc.property(fc.integer({ min: 0, max: 255 }), fc.integer({ min: 0, max: 255 }), fc.integer({ min: 0, max: 0xffffffff }),
    fc.uint8Array({ maxLength: 64 }), (type, flags, channel, payload) => {
      try { decodeFrame(raw(type, flags, channel, [...payload])); } catch (e) { if (!(e instanceof FrameError)) throw e; }
    }), { numRuns: 20000 });
});

test("fuzz: every encoded DATA frame round-trips", () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 0xffffffff }), fc.uint8Array({ maxLength: 2048 }), fc.boolean(), (ch, p, end) => {
    const d = decodeFrame(encodeData(ch, p, end));
    assert.equal(d.channel, ch); assert.equal(d.end, end); assert.deepEqual(d.payload, p);
    assert.equal(d.flags, end ? FLAG_END_STREAM : 0);
  }), { numRuns: 5000 });
});
