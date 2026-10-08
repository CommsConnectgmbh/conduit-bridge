// /e2e endpoint over a real WebSocket: pair, reconnect, RPC, chat, revoke.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import WebSocket from "ws";
import { createE2eEndpoint, deviceIdFor } from "../../src/e2e-endpoint.mjs";
import { issuePairCode, _resetPairCodes } from "../../src/e2e-pairing.mjs";
import { generateKeyPair } from "../../src/e2e-noise.mjs";
import { connect, KIND, SUBPROTOCOL, GOAWAY } from "../../src/e2e.mjs";
import { encodeMessage, MessageReader } from "../../src/e2e-messages.mjs";

const HOST = "abc.tunnel.example";
const devices = new Map();
const identity = await generateKeyPair();
const logs = [];
const endpoint = createE2eEndpoint({
  host: () => HOST, identity, version: "9.9.9",
  devices: {
    get: (k) => devices.get(k) || null,
    add: (r) => devices.set(r.pubkey, { pubkey: r.pubkey, device_id: r.deviceId, email: r.email, label: r.label, revoked_at: null }),
    touch: () => {},
  },
  handleHttp: async (req, res, auth) => {
    let body = ""; for await (const c of req) body += c;
    res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "x" });
    res.end(JSON.stringify({ ok: true, path: req.url, method: req.method, body, email: auth.email, device: auth.deviceId, hasAuthHeader: "authorization" in req.headers }));
  },
  handleChat: (ws, sid) => {
    if (sid === "refused-sid-123") return false;
    ws.on("message", (raw) => ws.send(JSON.stringify({ echo: JSON.parse(raw.toString()), sid })));
    return true;
  },
  log: (level, msg, meta) => logs.push({ level, msg, meta }),
});
const server = http.createServer((req, res) => res.writeHead(404).end());
server.on("upgrade", (req, socket, head) => endpoint.handleUpgrade(req, socket, head));
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;
after(() => { endpoint.close(); server.close(); });

function wsTransport(protocol = SUBPROTOCOL) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/e2e`, protocol ? [protocol] : []);
  ws.binaryType = "arraybuffer";
  const t = {
    ready: new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); ws.once("unexpected-response", (_q, r) => rej(new Error(`HTTP ${r.statusCode}`))); }),
    send: (b) => ws.send(b), close: () => ws.close(), get bufferedAmount() { return ws.bufferedAmount; },
    onMessage: (cb) => ws.on("message", (d) => cb(new Uint8Array(d))), onClose: (cb) => ws.on("close", cb),
  };
  return t;
}

async function rpc(session, method, path, body = "") {
  const ch = await session.open(KIND.RPC, { method, path, headers: { "content-type": "text/plain", authorization: "Bearer evil" } });
  const chunks = [];
  const done = new Promise((res) => { ch.on("data", (p) => chunks.push(Uint8Array.from(p))); ch.on("end", res); });
  await ch.write(new TextEncoder().encode(body), { end: true });
  await done;
  const all = Buffer.concat(chunks);
  const n = all.readUInt32BE(0);
  return { head: JSON.parse(all.subarray(4, 4 + n)), body: all.subarray(4 + n).toString() };
}

const device = await generateKeyPair();
const email = "owner@example.com";

test("pair with a code, then reconnect with the pinned key", async () => {
  _resetPairCodes();
  const code = issuePairCode({ email, issuedBy: "localhost" });
  const t = wsTransport(); await t.ready;
  const { session, hello } = await connect({ transport: t, host: HOST, device, bridgeKey: identity.publicKey, hello: { v: 1, client: "web", label: "Test" }, pair: { codeId: code.codeId, psk: code.psk } });
  assert.equal(hello.paired, true); assert.equal(hello.email, email); assert.equal(hello.device_id, deviceIdFor(device.publicKey));
  await session.goaway();

  // The code is single-use.
  const t2 = wsTransport(); await t2.ready;
  await assert.rejects(connect({ transport: t2, host: HOST, device: await generateKeyPair(), bridgeKey: identity.publicKey, hello: {}, pair: { codeId: code.codeId, psk: code.psk }, options: { handshakeTimeoutMs: 800 } }));

  const t3 = wsTransport(); await t3.ready;
  const again = await connect({ transport: t3, host: HOST, device, bridgeKey: identity.publicKey, hello: { v: 1 } });
  assert.equal(again.hello.paired, false);
  await again.session.goaway();
});

test("unknown device is refused without a reply", async () => {
  const t = wsTransport(); await t.ready;
  await assert.rejects(connect({ transport: t, host: HOST, device: await generateKeyPair(), bridgeKey: identity.publicKey, hello: {}, options: { handshakeTimeoutMs: 800 } }));
});

test("rpc reaches the handler with session identity, never a client Authorization header", async () => {
  const t = wsTransport(); await t.ready;
  const { session } = await connect({ transport: t, host: HOST, device, bridgeKey: identity.publicKey, hello: {} });
  const r = await rpc(session, "POST", "/api/paste?x=1", "hallo");
  assert.equal(r.head.status, 200);
  assert.equal(r.head.headers["access-control-allow-origin"], undefined);
  const b = JSON.parse(r.body);
  assert.equal(b.path, "/api/paste?x=1"); assert.equal(b.body, "hallo"); assert.equal(b.email, email);
  assert.equal(b.hasAuthHeader, false);
  const bad = await rpc(session, "GET", "/etc/passwd");
  assert.equal(bad.head.status, 400);
  await session.goaway();
});

test("chat channel carries length-prefixed JSON both ways", async () => {
  const t = wsTransport(); await t.ready;
  const { session } = await connect({ transport: t, host: HOST, device, bridgeKey: identity.publicKey, hello: {} });
  const ch = await session.open(KIND.CHAT, { sid: "abcdef12345" });
  const got = new Promise((res) => { const r = new MessageReader({ maxBytes: 1e6, onMessage: (m) => res(JSON.parse(Buffer.from(m))) }); ch.on("data", (p) => r.push(p)); });
  const big = "x".repeat(200_000);
  await ch.write(encodeMessage(new TextEncoder().encode(JSON.stringify({ type: "prompt", content: big }))));
  const msg = await got;
  assert.equal(msg.sid, "abcdef12345"); assert.equal(msg.echo.content.length, 200_000);
  const refused = await session.open(KIND.CHAT, { sid: "refused-sid-123" });
  const info = await new Promise((res) => refused.on("close", res));
  assert.equal(info.reason, "session refused");
  await session.goaway();
});

test("revoking a device ends its live sessions and blocks reconnects", async () => {
  const t = wsTransport(); await t.ready;
  const { session } = await connect({ transport: t, host: HOST, device, bridgeKey: identity.publicKey, hello: {} });
  const closed = new Promise((res) => session.on("close", res));
  const key = Buffer.from(device.publicKey).toString("hex");
  devices.get(key).revoked_at = Date.now();
  endpoint.kickDevice(key);
  assert.equal((await closed).code, GOAWAY.REVOKED);
  const t2 = wsTransport(); await t2.ready;
  await assert.rejects(connect({ transport: t2, host: HOST, device, bridgeKey: identity.publicKey, hello: {}, options: { handshakeTimeoutMs: 800 } }));
});

test("clients without the e2e subprotocol are refused (no downgrade)", async () => {
  await assert.rejects(wsTransport("conduit.v1").ready, /426/);
  await assert.rejects(wsTransport(null).ready, /426/);
});

test("logs never contain email addresses", () => {
  assert.ok(!JSON.stringify(logs).includes("@"), JSON.stringify(logs));
});
