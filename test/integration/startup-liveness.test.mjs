// Two failures that cut chats off, against the real bridge:
//   - a second bridge started by mistake against the same database must not
//     touch the turns the first one is running; only a real restart (the port
//     is ours) closes what a previous process left open;
//   - an idle chat channel must stay open while the device's end-to-end
//     session is alive. It used to be closed after ~90 s without chat frames
//     (bridge.log 19.10. 18:16–18:30), although the session kept pinging.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { DatabaseSync } from "node:sqlite";
import WebSocket from "ws";
import { generateKeyPair } from "../../src/e2e-noise.mjs";
import { connect, KIND, SUBPROTOCOL } from "../../src/e2e.mjs";
import { encodeMessage, MessageReader } from "../../src/e2e-messages.mjs";

const HOST = "live.tunnel.example";
const SERVER = fileURLToPath(new URL("../../src/server.mjs", import.meta.url));
const SILENT_MS = 1500;
let dir, port, pairPort, bridge = null, bridgeKey, device;
const procs = [];
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function launch(pp = pairPort) {
  const p = spawn(process.execPath, [SERVER], {
    env: {
      PATH: process.env.PATH, HOME: join(dir, "home"), BRIDGE_PORT: String(port), PAIR_PORT: String(pp),
      PAIR_PUBLIC_HOST: HOST, PAIR_OWNER_EMAIL: "owner@example.com", DB_DIR: join(dir, "db"), LOG_DIR: join(dir, "logs"),
      PASTE_DIR: join(dir, "paste"), CLAUDE_CWD: join(dir, "home"), CLAUDE_BIN: "/usr/bin/false",
      CONDUIT_SELFUPDATE: "0", CONDUIT_WARM: "0", CONDUIT_JOURNAL: "0", BRIDGE_ALLOWED_HOSTS: `127.0.0.1,localhost,${HOST}`,
      CONDUIT_CHAT_SILENT_MS: String(SILENT_MS),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  p.out = "";
  p.stdout.on("data", (d) => { p.out += d; });
  p.stderr.on("data", (d) => { p.out += d; });
  procs.push(p);
  return p;
}
async function waitHealthy() {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return; } catch { /* starting */ }
    await sleep(100);
  }
  throw new Error("bridge did not start");
}
async function kill(p, sig = "SIGTERM") {
  if (p.exitCode !== null || p.signalCode !== null) return;
  const gone = new Promise((r) => p.once("exit", r));
  p.kill(sig);
  await gone;
}

async function session(pair = null) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/e2e`, [SUBPROTOCOL], { headers: { host: HOST } });
  ws.binaryType = "arraybuffer";
  await new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); });
  const transport = { send: (b) => ws.send(b), close: () => ws.close(), get bufferedAmount() { return ws.bufferedAmount; },
    onMessage: (cb) => ws.on("message", (d) => cb(new Uint8Array(d))), onClose: (cb) => ws.on("close", cb) };
  const { session: s } = await connect({ transport, host: HOST, device, bridgeKey, hello: { v: 1, label: "t" }, ...(pair ? { pair } : {}) });
  return s;
}
async function rpc(s, path) {
  const ch = await s.open(KIND.RPC, { method: "GET", path, headers: {} });
  const done = new Promise((res) => ch.on("end", res));
  await ch.end();
  await done;
}
async function chat(s, sid) {
  const ch = await s.open(KIND.CHAT, { sid });
  const frames = [];
  let closed = false;
  ch.on("close", () => { closed = true; });
  const reader = new MessageReader({ maxBytes: 1e6, onMessage: (m) => frames.push(JSON.parse(Buffer.from(m))) });
  ch.on("data", (x) => reader.push(x));
  return {
    frames, get closed() { return closed || ch.closed; },
    send: (o) => ch.write(encodeMessage(new TextEncoder().encode(JSON.stringify(o)))),
  };
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "conduit-live-"));
  mkdirSync(join(dir, "home"), { recursive: true });
  port = await freePort(); pairPort = await freePort();
});
after(async () => {
  for (const p of procs) await kill(p, "SIGKILL");
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

test("a second bridge on a busy port leaves the first one's running turn alone", async () => {
  bridge = launch();
  await waitHealthy();
  const db = new DatabaseSync(join(dir, "db", "db.sqlite"));
  const t = Date.now();
  db.prepare("INSERT INTO sessions (id, user_email, created_at, updated_at) VALUES (?, ?, ?, ?)").run("s-live-0001", "owner@example.com", t, t);
  db.prepare("INSERT INTO messages (id, session_id, role, content, ts, turn_status) VALUES (?, ?, 'assistant', 'partial', ?, 'running')").run("a-run", "s-live-0001", t);
  db.prepare("INSERT INTO messages (id, session_id, role, content, ts, turn_status) VALUES (?, ?, 'assistant', '', ?, 'queued')").run("a-q", "s-live-0001", t + 1);

  const second = launch(await freePort());
  await new Promise((r) => second.once("exit", r));
  assert.notEqual(second.exitCode, 0);
  assert.match(second.out, /EADDRINUSE/);
  assert.doesNotMatch(second.out, /turns_closed_after_restart/);
  const st = (id) => db.prepare("SELECT turn_status FROM messages WHERE id = ?").get(id).turn_status;
  assert.equal(st("a-run"), "running");
  assert.equal(st("a-q"), "queued");
  assert.equal(bridge.exitCode, null, "first bridge died");

  // A real restart: the first process is gone, the port is free again.
  await kill(bridge, "SIGKILL");
  bridge = launch();
  await waitHealthy();
  await sleep(100);
  assert.match(bridge.out, /turns_closed_after_restart/);
  assert.equal(st("a-run"), "interrupted");
  assert.equal(st("a-q"), "not_started");
  db.close();
});

test("an idle chat channel stays open while the session is alive", async () => {
  const j = await (await fetch(`http://127.0.0.1:${pairPort}/api/pair/new`, { method: "POST" })).json();
  const p = JSON.parse(Buffer.from(new URL(j.url).hash.slice(1), "base64url").toString());
  bridgeKey = Uint8Array.from(Buffer.from(p.k, "base64url"));
  device = await generateKeyPair();
  const s = await session({ codeId: Uint8Array.from(Buffer.from(p.i, "base64url")), psk: Uint8Array.from(Buffer.from(p.p, "base64url")) });
  const c = await chat(s, "s-live-0002");
  await c.send({ type: "attach" });
  // Only session traffic from here on, never a chat frame — like the app
  // between two messages. Three times the chat timeout.
  const t0 = Date.now();
  while (Date.now() - t0 < SILENT_MS * 3) {
    await rpc(s, "/api/status");
    await sleep(300);
  }
  assert.equal(c.closed, false, "idle chat channel was closed");
  assert.doesNotMatch(bridge.out, /ws_silent_client_terminate/);
  await c.send({ type: "ping" });
  for (let i = 0; i < 40 && !c.frames.some((f) => f.type === "pong"); i++) await sleep(25);
  assert.ok(c.frames.some((f) => f.type === "pong"), "no pong on the idle channel");
  s.goaway();
});

test("the app's chat ping alone keeps a channel open; total silence still closes it", async () => {
  const s = await session();
  const pinged = await chat(s, "s-live-0003");
  const silent = await chat(await session(), "s-live-0004");
  const t0 = Date.now();
  while (Date.now() - t0 < SILENT_MS * 3) {
    await pinged.send({ type: "ping" });
    await sleep(300);
  }
  assert.equal(pinged.closed, false, "pinged channel was closed");
  // The second device sent nothing at all, on any layer: that one is gone.
  for (let i = 0; i < 40 && !silent.closed; i++) await sleep(50);
  assert.equal(silent.closed, true, "a silent channel must still be closed");
  assert.match(bridge.out, /ws_silent_client_terminate/);
  s.goaway();
  await kill(bridge);
});
