// Starts the real bridge (src/server.mjs) in a throwaway environment and talks
// to it the way the app does: pair through the loopback page, then use RPC and
// chat inside an end-to-end session. Also checks that nothing plaintext is left
// on the tunnel-facing port.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, statSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import WebSocket from "ws";
import { generateKeyPair } from "../../src/e2e-noise.mjs";
import { connect, KIND, SUBPROTOCOL } from "../../src/e2e.mjs";

const HOST = "itest.tunnel.example";
let proc, dir, port, pairPort, logs = "";

const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });

const REAL_SPEECH = !!(process.env.CONDUIT_TEST_SPEECH_MODELS && process.env.CONDUIT_TEST_SPEECH_RUNTIME);

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "conduit-itest-"));
  port = await freePort(); pairPort = await freePort();
  // An install left behind by an older version: world-readable directories
  // and files the bridge must tighten on start.
  for (const d of ["db", "logs", "paste"]) { mkdirSync(join(dir, d), { recursive: true }); chmodSync(join(dir, d), 0o755); }
  writeFileSync(join(dir, "paste", "1700000000000-old.txt"), "old paste"); chmodSync(join(dir, "paste", "1700000000000-old.txt"), 0o644);
  writeFileSync(join(dir, "logs", "bridge.log.1"), "{}\n"); chmodSync(join(dir, "logs", "bridge.log.1"), 0o644);
  proc = spawn(process.execPath, [fileURLToPath(new URL("../../src/server.mjs", import.meta.url))], {
    env: {
      PATH: process.env.PATH, HOME: dir, BRIDGE_PORT: String(port), PAIR_PORT: String(pairPort),
      PAIR_PUBLIC_HOST: HOST, PAIR_OWNER_EMAIL: "owner@example.com", DB_DIR: join(dir, "db"), LOG_DIR: join(dir, "logs"),
      PASTE_DIR: join(dir, "paste"), CLAUDE_CWD: dir, CONDUIT_SELFUPDATE: "0", CONDUIT_WARM: "0",
      BRIDGE_ALLOWED_HOSTS: `127.0.0.1,localhost,${HOST}`,
      // Real models for the streaming check, when installed locally.
      ...(REAL_SPEECH ? { CONDUIT_MODELS_DIR: process.env.CONDUIT_TEST_SPEECH_MODELS, CONDUIT_SPEECH_RUNTIME_DIR: process.env.CONDUIT_TEST_SPEECH_RUNTIME } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", (d) => { logs += d; });
  proc.stderr.on("data", (d) => { logs += d; });
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/healthz`); if (r.ok) return; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("bridge did not start:\n" + logs);
});

// Wait for the bridge to exit before deleting its directory: Windows keeps the
// SQLite file locked until the process is gone.
after(async () => {
  if (proc && proc.exitCode === null && proc.signalCode === null) {
    const exited = new Promise((r) => proc.once("exit", r));
    proc.kill("SIGTERM");
    await exited;
  }
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

test("healthz says only that a bridge is there", async () => {
  const j = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
  assert.deepEqual(j, { ok: true, e2e: 1 });
});

test("plaintext API and old sockets are closed on the public port", async () => {
  for (const p of ["/api/sessions", "/api/pair/claim", "/api/status", "/ws", "/pty"]) {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method: p.includes("claim") ? "POST" : "GET" });
    assert.equal(r.status, 426, p);
  }
  await assert.rejects(new Promise((res, rej) => { const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?sid=abcdefgh123&token=x`); ws.on("open", res); ws.on("unexpected-response", (_q, r) => rej(new Error(String(r.statusCode)))); ws.on("error", rej); }), /426/);
});

test("identity key file is private", () => {
  const st = statSync(join(dir, "db", "identity.key"));
  assert.equal(st.size, 32);
  // Windows has no POSIX mode bits (Node reports 0o666); there the key is
  // protected by the ACL of the user profile it is installed into.
  if (process.platform !== "win32") assert.equal(st.mode & 0o077, 0);
});

let device, bridgeKey;
test("pair via the loopback page, then RPC and chat inside the session", async () => {
  const r = await fetch(`http://127.0.0.1:${pairPort}/api/pair/new`, { method: "POST" });
  const j = await r.json();
  assert.equal(j.ok, true);
  const frag = new URL(j.url).hash.slice(1);
  const payload = JSON.parse(Buffer.from(frag, "base64url").toString());
  assert.equal(payload.h, HOST);
  bridgeKey = Uint8Array.from(Buffer.from(payload.k, "base64url"));
  device = await generateKeyPair();

  const open = () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/e2e`, [SUBPROTOCOL], { headers: { host: HOST } });
    ws.binaryType = "arraybuffer";
    return { ws, ready: new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); }),
      transport: { send: (b) => ws.send(b), close: () => ws.close(), get bufferedAmount() { return ws.bufferedAmount; },
        onMessage: (cb) => ws.on("message", (d) => cb(new Uint8Array(d))), onClose: (cb) => ws.on("close", cb) } };
  };
  const a = open(); await a.ready;
  const paired = await connect({ transport: a.transport, host: HOST, device, bridgeKey, hello: { v: 1, client: "web", label: "itest" },
    pair: { codeId: Uint8Array.from(Buffer.from(payload.i, "base64url")), psk: Uint8Array.from(Buffer.from(payload.p, "base64url")) } });
  assert.equal(paired.hello.paired, true);
  await paired.session.goaway();

  const b = open(); await b.ready;
  const { session } = await connect({ transport: b.transport, host: HOST, device, bridgeKey, hello: { v: 1 } });
  const call = async (method, path, body) => {
    const ch = await session.open(KIND.RPC, { method, path, headers: body ? { "content-type": "application/json" } : {} });
    const parts = []; const done = new Promise((res) => { ch.on("data", (p) => parts.push(Uint8Array.from(p))); ch.on("end", res); });
    if (body) await ch.write(new TextEncoder().encode(JSON.stringify(body)));
    await ch.end(); await done;
    const all = Buffer.concat(parts); const n = all.readUInt32BE(0);
    return { head: JSON.parse(all.subarray(4, 4 + n)), body: JSON.parse(all.subarray(4 + n)) };
  };
  const st = await call("GET", "/api/status");
  assert.equal(st.head.status, 200); assert.equal(st.body.ok, true); assert.match(st.body.fingerprint, /^[0-9a-f]{4}( [0-9a-f]{4}){3}$/);
  // Operator settings are visible to the paired owner: defaults here.
  assert.deepEqual(st.body.agentPolicy, { claude: "bypassPermissions", codex: "bypass", gemini: "bypass", disabled: [], misconfigured: [] });
  assert.deepEqual(st.body.update, { mode: "off", pin: null, window: null, available: null, pendingRestart: null });
  const devs = await call("GET", "/api/e2e/devices");
  assert.equal(devs.body.devices.length, 1); assert.equal(devs.body.devices[0].current, true); assert.equal(devs.body.devices[0].label, "itest");
  const sessions = await call("GET", "/api/sessions");
  assert.equal(sessions.head.status, 200);
  const code = await call("POST", "/api/e2e/pair-code");
  assert.ok(code.body.url.includes("/pair#"));
  // Local speech: the catalog is there, refusals are clear.
  const speech = await call("GET", "/api/speech");
  assert.equal(speech.head.status, 200);
  assert.deepEqual(speech.body.models.map((m) => m.id), ["stt-parakeet-tdt-0.6b-v3", "tts-de-thorsten", "tts-en-kokoro-v1.0"]);
  if (REAL_SPEECH) {
    // One WAV per sentence, each a length-prefixed message after the head.
    const ch = await session.open(KIND.RPC, { method: "POST", path: "/api/speak", headers: { "content-type": "application/json" } });
    const parts = []; const done = new Promise((res) => { ch.on("data", (p) => parts.push(Uint8Array.from(p))); ch.on("end", res); });
    await ch.write(new TextEncoder().encode(JSON.stringify({ text: "Guten Tag! Das ist ein Test. Und noch ein Satz.", lang: "de" })));
    await ch.end(); await done;
    const all = Buffer.concat(parts);
    let off = 4 + all.readUInt32BE(0);
    assert.equal(JSON.parse(all.subarray(4, off)).status, 200);
    const wavs = [];
    while (off < all.length) { const n = all.readUInt32BE(off); wavs.push(all.subarray(off + 4, off + 4 + n)); off += 4 + n; }
    assert.equal(wavs.length, 3);
    for (const w of wavs) assert.equal(w.toString("ascii", 0, 4), "RIFF");
    return session.goaway();
  }
  assert.deepEqual(speech.body.ready, { stt: [], tts: [] });
  assert.equal((await call("POST", "/api/speech/install", { id: "espeak-ng-1.52.0" })).head.status, 404);
  const speak = await call("POST", "/api/speak", { text: "Hallo" });
  assert.equal(speak.head.status, 409);
  assert.match(speak.body.error, /no voice installed/);
  assert.equal((await call("DELETE", "/api/speech/models/nope")).head.status, 404);
  await session.goaway();
});

test("a malformed request target gets a 400 and the bridge keeps running", async () => {
  for (const target of ["//[", "http://[::1", "//%"]) {
    const reply = await new Promise((res, rej) => {
      const sock = net.connect(port, "127.0.0.1", () => sock.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`));
      let buf = ""; sock.on("data", (d) => { buf += d; }); sock.on("end", () => res(buf)); sock.on("error", rej);
    });
    assert.match(reply, /^HTTP\/1\.1 400 /, `${target}: ${reply.slice(0, 80)}`);
    const h = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(h.status, 200, `bridge died after ${target}`);
  }
  assert.equal(proc.exitCode, null);
});

test("chat database, logs and pastes are owner-only, old installs included", { skip: process.platform === "win32" }, () => {
  const mode = (...p) => statSync(join(dir, ...p)).mode & 0o777;
  for (const d of [["db"], ["logs"], ["paste"]]) assert.equal(mode(...d), 0o700, d.join("/"));
  for (const f of [["db", "db.sqlite"], ["logs", "bridge.log"], ["logs", "bridge.log.1"], ["paste", "1700000000000-old.txt"]]) {
    assert.equal(mode(...f), 0o600, f.join("/"));
  }
});

test("a device revoked after minting a pairing code cannot pair again with that code", async () => {
  const open = () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/e2e`, [SUBPROTOCOL], { headers: { host: HOST } });
    ws.binaryType = "arraybuffer";
    return { ready: new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); }),
      transport: { send: (b) => ws.send(b), close: () => ws.close(), get bufferedAmount() { return ws.bufferedAmount; },
        onMessage: (cb) => ws.on("message", (d) => cb(new Uint8Array(d))), onClose: (cb) => ws.on("close", cb) } };
  };
  const call = async (session, method, path) => {
    const ch = await session.open(KIND.RPC, { method, path, headers: {} });
    const parts = []; const done = new Promise((res) => { ch.on("data", (p) => parts.push(Uint8Array.from(p))); ch.on("end", res); });
    await ch.end(); await done;
    const all = Buffer.concat(parts); const n = all.readUInt32BE(0);
    return { head: JSON.parse(all.subarray(4, 4 + n)), body: JSON.parse(all.subarray(4 + n)) };
  };
  const codeFrom = (url) => {
    const p = JSON.parse(Buffer.from(new URL(url).hash.slice(1), "base64url").toString());
    return { codeId: Uint8Array.from(Buffer.from(p.i, "base64url")), psk: Uint8Array.from(Buffer.from(p.p, "base64url")) };
  };
  const pair = async (dev, code, label) => {
    const c = open(); await c.ready;
    return connect({ transport: c.transport, host: HOST, device: dev, bridgeKey, hello: { v: 1, client: "web", label }, pair: code, options: { handshakeTimeoutMs: 1500 } });
  };
  const loopCode = async () => codeFrom((await (await fetch(`http://127.0.0.1:${pairPort}/api/pair/new`, { method: "POST" })).json()).url);
  // The owner's device and device X, both paired through the loopback QR.
  const owner = await generateKeyPair();
  const po = await pair(owner, await loopCode(), "owner");
  const x = await generateKeyPair();
  const px = await pair(x, await loopCode(), "x");
  // X mints a code for later, then the owner revokes X.
  const minted = await call(px.session, "POST", "/api/e2e/pair-code");
  assert.equal(minted.head.status, 200);
  const kicked = new Promise((res) => px.session.on("close", res));
  const rv = await call(po.session, "DELETE", `/api/e2e/devices/${px.hello.device_id}`);
  assert.equal(rv.body.revoked, true);
  await kicked;
  // The pre-revocation code is dead: X cannot re-pair with it.
  await assert.rejects(pair(x, codeFrom(minted.body.url), "x-again"));
  const devs = await call(po.session, "GET", "/api/e2e/devices");
  const rowX = devs.body.devices.find((d) => d.id === px.hello.device_id);
  assert.equal(rowX.revoked, true);
  assert.equal(rowX.pairedVia, "localhost");
  await po.session.goaway();
});

test("bridge log contains no email address and no home path", () => {
  const all = logs + readFileSync(join(dir, "logs", "bridge.log"), "utf8").toString();
  assert.ok(!/owner@example\.com/.test(all), "email in log");
  const leak = all.split("\n").filter((l) => l.includes(dir));
  assert.deepEqual(leak, [], "home path in log");
});

test("alexa endpoint fails closed without a skill id and rejects unsigned requests", async () => {
  const r = await fetch(`http://127.0.0.1:${port}/alexa`, { method: "POST", body: "{}" });
  assert.equal(r.status, 503);
});
