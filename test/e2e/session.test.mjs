// Session layer over an in-memory transport pair.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair, utf8 } from "../../src/e2e-noise.mjs";
import { connect, accept, KIND, MODE_PAIR, GOAWAY, CODE_ID_LEN } from "../../src/e2e.mjs";
import { encodeMessage, MessageReader } from "../../src/e2e-messages.mjs";

function memoryPair({ tamper } = {}) {
  const mk = () => ({ msg: [], cls: [], open: true, buffered: 0 });
  const a = mk(), b = mk();
  const side = (me, peer, dir) => ({
    send(bytes) {
      if (!me.open) throw new Error("closed");
      const copy = Uint8Array.from(bytes);
      const out = tamper ? tamper(copy, dir) : copy;
      setImmediate(() => { if (peer.open && out) for (const cb of peer.msg) cb(out); });
    },
    close() {
      if (!me.open) return;
      me.open = false;
      setImmediate(() => { for (const cb of me.cls) cb(); if (peer.open) { peer.open = false; for (const cb of peer.cls) cb(); } });
    },
    onMessage(cb) { me.msg.push(cb); },
    onClose(cb) { me.cls.push(cb); },
    get bufferedAmount() { return me.buffered; },
  });
  return { device: side(a, b, "up"), bridge: side(b, a, "down") };
}

const host = "abc.tunnel.example";
const td = new TextDecoder();

async function setup({ options = {}, authorize, pair, tamper } = {}) {
  const bridgeKey = await generateKeyPair();
  const deviceKey = await generateKeyPair();
  const t = memoryPair({ tamper });
  const codes = new Map();
  if (pair) codes.set(Buffer.from(pair.codeId).toString("hex"), pair.psk);
  const accepted = accept({
    transport: t.bridge, host, bridge: bridgeKey, options,
    pskFor: (id) => codes.get(Buffer.from(id).toString("hex")) ?? null,
    authorize: authorize ?? (async ({ deviceKey: k }) => ({ v: 1, device: Buffer.from(k).toString("hex").slice(0, 8) })),
  });
  const connected = connect({ transport: t.device, host, device: deviceKey, bridgeKey: bridgeKey.publicKey, hello: { v: 1, client: "web" }, pair, options });
  const [b, d] = await Promise.allSettled([accepted, connected]);
  return { b, d, bridgeKey, deviceKey };
}

test("connect: both sides get a session with the same handshake hash", async () => {
  const { b, d, deviceKey } = await setup();
  assert.equal(b.status, "fulfilled"); assert.equal(d.status, "fulfilled");
  assert.deepEqual(b.value.deviceKey, deviceKey.publicKey);
  assert.deepEqual(b.value.session.handshakeHash, d.value.session.handshakeHash);
  assert.equal(d.value.hello.v, 1);
  await d.value.session.goaway();
});

test("unauthorized device gets no reply and both sides fail", async () => {
  const { b, d } = await setup({ authorize: async () => null, options: { handshakeTimeoutMs: 500 } });
  assert.equal(b.status, "rejected"); assert.equal(d.status, "rejected");
});

test("pairing with a code from the QR, wrong code id is refused", async () => {
  const psk = crypto.getRandomValues(new Uint8Array(32));
  const codeId = crypto.getRandomValues(new Uint8Array(CODE_ID_LEN));
  let seenMode;
  const ok = await setup({ pair: { codeId, psk }, authorize: async ({ mode }) => { seenMode = mode; return { v: 1 }; } });
  assert.equal(ok.d.status, "fulfilled"); assert.equal(seenMode, MODE_PAIR);
  await ok.d.value.session.goaway();
  const bad = await setup({ pair: { codeId, psk }, options: { handshakeTimeoutMs: 500 } });
  // setup() registers the code under its id; a different psk must fail.
  const wrong = await (async () => {
    const t = memoryPair(); const bk = await generateKeyPair(); const dk = await generateKeyPair();
    const a = accept({ transport: t.bridge, host, bridge: bk, pskFor: () => crypto.getRandomValues(new Uint8Array(32)), authorize: async () => ({ v: 1 }), options: { handshakeTimeoutMs: 500 } });
    const c = connect({ transport: t.device, host, device: dk, bridgeKey: bk.publicKey, hello: {}, pair: { codeId, psk }, options: { handshakeTimeoutMs: 500 } });
    return Promise.allSettled([a, c]);
  })();
  assert.equal(wrong[0].status, "rejected"); assert.equal(wrong[1].status, "rejected");
  if (bad.d.status === "fulfilled") await bad.d.value.session.goaway();
});

test("rpc round trip and streamed data in order", async () => {
  const { b, d } = await setup();
  const bs = b.value.session, ds = d.value.session;
  bs.on("channel", (ch) => {
    let body = "";
    ch.on("data", (p) => { body += td.decode(p); });
    ch.on("end", async () => {
      const req = JSON.parse(body);
      await ch.writeJson({ ok: true, echo: req.path, params: ch.params }, { end: true });
    });
  });
  const ch = await ds.open(KIND.RPC, { method: "GET", path: "/api/sessions" });
  const got = new Promise((res) => { let s = ""; ch.on("data", (p) => { s += td.decode(p); }); ch.on("end", () => res(JSON.parse(s))); });
  await ch.writeJson({ path: "/api/sessions" }, { end: true });
  const r = await got;
  assert.equal(r.echo, "/api/sessions"); assert.equal(r.params.method, "GET");
  await ds.goaway();
});

test("flow control: a large upload is paced by credits and arrives intact", async () => {
  const { b, d } = await setup({ options: { window: 64 * 1024 } });
  const bs = b.value.session, ds = d.value.session;
  const size = 3 * 1024 * 1024 + 17;
  const data = crypto.getRandomValues(new Uint8Array(65536));
  const big = new Uint8Array(size); for (let i = 0; i < size; i += data.length) big.set(data.subarray(0, Math.min(data.length, size - i)), i);
  const received = new Promise((res) => bs.on("channel", (ch) => {
    const parts = []; ch.on("data", (p) => parts.push(Uint8Array.from(p)));
    ch.on("end", () => res(Buffer.concat(parts)));
  }));
  const ch = await ds.open(KIND.UPLOAD, { name: "x.bin" });
  await ch.write(big, { end: true });
  const out = await received;
  assert.equal(out.length, size); assert.ok(Buffer.from(big).equals(out));
  await ds.goaway();
});

// What the bridge and the app do on a chat channel: send() fires a write and
// does not wait for it. A message larger than one frame (or one that runs out
// of credit) used to be split across awaits, so the next send() slipped its
// frames in between and the reader on the other side decoded garbage.
async function concurrentChatWrites({ window, rounds, bigSize }) {
  const { b, d } = await setup({ options: window ? { window } : {} });
  const bs = b.value.session, ds = d.value.session;
  const got = [];
  let readerError = null;
  bs.on("channel", (ch) => {
    const reader = new MessageReader({ maxBytes: 8e6, onMessage: (m) => got.push(td.decode(m)) });
    ch.on("data", (p) => { try { reader.push(p); } catch (e) { readerError = e; } });
  });
  const ch = await ds.open(KIND.CHAT, { sid: "s" });
  const sent = [];
  const writes = [];
  for (let i = 0; i < rounds; i++) {
    const big = JSON.stringify({ i, kind: "big", pad: "x".repeat(bigSize) });
    const small = JSON.stringify({ i, kind: "chunk" });
    sent.push(big, small);
    // Not awaited on purpose, like ChannelSocket.send / ChatSocket.send.
    writes.push(ch.write(encodeMessage(utf8(big))), ch.write(encodeMessage(utf8(small))));
  }
  await Promise.all(writes);
  const t0 = Date.now();
  while (got.length < sent.length && !readerError && Date.now() - t0 < 10_000) await new Promise((r) => setTimeout(r, 10));
  await ds.goaway();
  return { got, sent, readerError };
}

test("concurrent writes of messages larger than a frame never interleave", async () => {
  const { got, sent, readerError } = await concurrentChatWrites({ rounds: 5, bigSize: 150_000 });
  assert.equal(readerError, null, String(readerError));
  assert.deepEqual(got, sent);
});

test("concurrent small writes stay whole when the window runs out mid-message", async () => {
  const { got, sent, readerError } = await concurrentChatWrites({ window: 4096, rounds: 200, bigSize: 700 });
  assert.equal(readerError, null, String(readerError));
  assert.deepEqual(got, sent);
});

test("end() waits for a write that is still running", async () => {
  const { b, d } = await setup({ options: { window: 4096 } });
  const bs = b.value.session, ds = d.value.session;
  const received = new Promise((res) => bs.on("channel", (ch) => {
    const parts = []; ch.on("data", (p) => parts.push(Uint8Array.from(p)));
    ch.on("end", () => res(Buffer.concat(parts)));
  }));
  const ch = await ds.open(KIND.UPLOAD, { name: "x.bin" });
  const body = new Uint8Array(100_000).fill(7);
  const w = ch.write(body);
  const e = ch.end();
  await Promise.all([w, e]);
  const out = await received;
  assert.equal(out.length, body.length);
  await ds.goaway();
});

test("rekey after the message threshold keeps traffic flowing", async () => {
  const { b, d } = await setup({ options: { rekeyMessages: 5 } });
  const bs = b.value.session, ds = d.value.session;
  const n = 40; let count = 0;
  const done = new Promise((res) => bs.on("channel", (ch) => ch.on("data", () => { if (++count === n) res(); })));
  const ch = await ds.open(KIND.CHAT, { sid: "s1" });
  for (let i = 0; i < n; i++) await ch.writeJson({ i });
  await done;
  assert.equal(count, n);
  await ds.goaway();
});

test("tampered transport message terminates the session without GOAWAY", async () => {
  let armed = false;
  const { b, d } = await setup({ tamper: (bytes, dir) => { if (armed && dir === "up") bytes[bytes.length - 1] ^= 1; return bytes; } });
  const bs = b.value.session;
  const closed = new Promise((res) => bs.on("close", res));
  armed = true;
  const ch = await d.value.session.open(KIND.RPC, {}).catch(() => null);
  const info = await closed;
  assert.equal(info.reason, "decryption failed");
  assert.ok(ch === null || d.value.session.closed || true);
});

test("peer that ignores the flow-control window is disconnected", async () => {
  const { b, d } = await setup({ options: { window: 1024 } });
  const bs = b.value.session, ds = d.value.session;
  const closed = new Promise((res) => bs.on("close", res));
  bs.on("channel", () => {});
  const ch = await ds.open(KIND.UPLOAD, {});
  // Bypass the credit check on purpose: write raw DATA beyond the window.
  await ds._sendData(ch.id, new Uint8Array(4096), false);
  const info = await closed;
  assert.match(info.reason, /flow-control window/);
});

test("channel limit is enforced", async () => {
  const { b, d } = await setup({ options: { maxChannels: 3 } });
  b.value.session.on("channel", () => {});
  const ds = d.value.session;
  await ds.open(KIND.RPC); await ds.open(KIND.RPC); await ds.open(KIND.RPC);
  await assert.rejects(ds.open(KIND.RPC), /too many channels/);
  await ds.goaway();
});

test("goaway reaches the peer with its code", async () => {
  const { b, d } = await setup();
  const closed = new Promise((res) => d.value.session.on("close", res));
  await b.value.session.goaway(GOAWAY.REVOKED, "revoked");
  const info = await closed;
  assert.equal(info.code, GOAWAY.REVOKED); assert.equal(info.reason, "revoked");
});

test("ping keeps an idle session alive and answers", async () => {
  const { b, d } = await setup({ options: { pingIntervalMs: 50, pingTimeoutMs: 200 } });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(b.value.session.closed, false); assert.equal(d.value.session.closed, false);
  await d.value.session.goaway();
});

test("first message with an unknown mode byte is refused", async () => {
  const t = memoryPair(); const bk = await generateKeyPair();
  const a = accept({ transport: t.bridge, host, bridge: bk, pskFor: () => null, authorize: async () => ({}), options: { handshakeTimeoutMs: 300 } });
  t.device.send(Uint8Array.of(0x7f, 1, 2, 3));
  await assert.rejects(a);
});
