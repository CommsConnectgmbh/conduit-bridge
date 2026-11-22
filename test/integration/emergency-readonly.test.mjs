// Not-Aus and read-only runs against the real bridge with a stand-in claude.
// What must hold:
//   - the emergency stop ends the running turns of EVERY chat, drops their
//     queues, and refuses every new prompt until it is released — also after
//     a restart of the bridge;
//   - every chat that is open hears about it, and the journal records it;
//   - a read-only turn starts claude with only Read/Grep/Glob, no MCP server
//     and without bypassPermissions — on the warm path and the one-shot path —
//     and a warm process never carries a turn of the other kind;
//   - an engine that cannot enforce read-only refuses the turn instead of
//     running it with full rights.
// POSIX only: the stand-in CLI is a shebang script.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import WebSocket from "ws";
import { generateKeyPair } from "../../src/e2e-noise.mjs";
import { connect, KIND, SUBPROTOCOL } from "../../src/e2e.mjs";
import { encodeMessage, MessageReader } from "../../src/e2e-messages.mjs";

const POSIX = process.platform !== "win32";
const HOST = "emergency.tunnel.example";
const SID_A = "abcdabcd-aaaa-4222-8333-444455556666";
const SID_B = "abcdabcd-bbbb-4222-8333-444455556666";
const EMAIL = "owner@example.com";

let dir, fakeLog, journalDir, bridge = null, bridgeKey, device, pairPort, port;
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeRuns() {
  if (!existsSync(fakeLog)) return [];
  return readFileSync(fakeLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
const runsOf = (tag) => fakeRuns().filter((r) => r.tag === tag);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
function killFakes() {
  for (const r of fakeRuns()) { try { process.kill(r.pid, "SIGKILL"); } catch { /* gone */ } }
}

async function startBridge({ warm, env = {} }) {
  const logs = { text: "" };
  const proc = spawn(process.execPath, [fileURLToPath(new URL("../../src/server.mjs", import.meta.url))], {
    env: {
      PATH: process.env.PATH, HOME: join(dir, "home"), BRIDGE_PORT: String(port), PAIR_PORT: String(pairPort),
      PAIR_PUBLIC_HOST: HOST, PAIR_OWNER_EMAIL: EMAIL, DB_DIR: join(dir, "db"), LOG_DIR: join(dir, "logs"),
      PASTE_DIR: join(dir, "paste"), CLAUDE_CWD: join(dir, "home"), CLAUDE_BIN: join(dir, "fake-claude.mjs"),
      CODEX_BIN: join(dir, "fake-claude.mjs"),
      CONDUIT_SELFUPDATE: "0", CONDUIT_WARM: warm ? "1" : "0", BRIDGE_ALLOWED_HOSTS: `127.0.0.1,localhost,${HOST}`,
      CONDUIT_JOURNAL_DIR: journalDir, ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", (d) => { logs.text += d; });
  proc.stderr.on("data", (d) => { logs.text += d; });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return { proc, logs }; } catch { /* starting */ }
    await sleep(100);
  }
  throw new Error("bridge did not start:\n" + logs.text);
}

async function stopBridge(signal = "SIGTERM") {
  if (!bridge) return;
  const { proc } = bridge;
  if (proc.exitCode === null && proc.signalCode === null) {
    const exited = new Promise((r) => proc.once("exit", r));
    proc.kill(signal);
    await exited;
  }
  bridge = null;
}

function openWs() {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/e2e`, [SUBPROTOCOL], { headers: { host: HOST } });
  ws.binaryType = "arraybuffer";
  return { ready: new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); }),
    transport: { send: (b) => ws.send(b), close: () => ws.close(), get bufferedAmount() { return ws.bufferedAmount; },
      onMessage: (cb) => ws.on("message", (d) => cb(new Uint8Array(d))), onClose: (cb) => ws.on("close", cb) } };
}

async function client({ pair = null, sid = SID_A } = {}) {
  const o = openWs(); await o.ready;
  const { session } = await connect({ transport: o.transport, host: HOST, device, bridgeKey, hello: { v: 1, label: "t" }, ...(pair ? { pair } : {}) });
  const call = async (method, path, body) => {
    const ch = await session.open(KIND.RPC, { method, path, headers: body ? { "content-type": "application/json" } : {} });
    const parts = []; const done = new Promise((res) => { ch.on("data", (x) => parts.push(Uint8Array.from(x))); ch.on("end", res); });
    if (body) await ch.write(new TextEncoder().encode(JSON.stringify(body)));
    await ch.end(); await done;
    const all = Buffer.concat(parts); const n = all.readUInt32BE(0);
    return { head: JSON.parse(all.subarray(4, 4 + n)), body: JSON.parse(all.subarray(4 + n)) };
  };
  const chat = sid ? await session.open(KIND.CHAT, { sid }) : null;
  const frames = [];
  const reader = new MessageReader({ maxBytes: 1e6, onMessage: (m) => frames.push(JSON.parse(Buffer.from(m))) });
  chat?.on("data", (x) => reader.push(x));
  const send = (obj) => chat.write(encodeMessage(new TextEncoder().encode(JSON.stringify(obj))));
  const waitFor = async (pred, what, ms = 10_000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const f = frames.find(pred);
      if (f) return f;
      await sleep(25);
    }
    throw new Error(`timed out waiting for ${what}; frames: ${JSON.stringify(frames).slice(0, 2000)}`);
  };
  const prompt = (n, scenario, extra = {}) => send({
    type: "prompt", content: `TAG:${n} SCENARIO:${scenario}`, userMessageId: `u-${n}`, assistantMessageId: `a-${n}`, ...extra,
  });
  return { session, call, send, frames, waitFor, prompt, close: () => session.goaway() };
}

const isTerminal = (aid) => (f) => (f.type === "done" || f.type === "error") && f.assistantMessageId === aid;

before(async () => {
  if (!POSIX) return;
  dir = mkdtempSync(join(tmpdir(), "conduit-emergency-"));
  mkdirSync(join(dir, "home"), { recursive: true });
  journalDir = join(dir, "journal");
  fakeLog = join(dir, "fake-runs.jsonl");
  const fake = join(dir, "fake-claude.mjs");
  // Records the rights it was started with; "hang" keeps running a tool.
  writeFileSync(fake, `#!${process.execPath}
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
if (process.argv[2] === "auth") { process.stdout.write(JSON.stringify({ loggedIn: true }) + "\\n"); process.exit(0); }
const LOG = ${JSON.stringify(fakeLog)};
const warm = process.argv.includes("--input-format");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const argAfter = (k) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : null; };
out({ type: "system", subtype: "init", session_id: "11111111-2222-3333-4444-555555555555" });
function run(raw) {
  const tag = (/TAG:([A-Za-z0-9]+)/.exec(raw) || [])[1] || null;
  const sc = (/SCENARIO:([a-z-]+)/.exec(raw) || [])[1] || "ok";
  appendFileSync(LOG, JSON.stringify({ pid: process.pid, warm, tag, sc,
    mode: argAfter("--permission-mode"), tools: argAfter("--tools"), allowed: argAfter("--allowedTools"),
    strictMcp: process.argv.includes("--strict-mcp-config"), prompts: argAfter("--permission-prompts") }) + "\\n");
  if (sc === "ok") {
    out({ type: "assistant", message: { content: [{ type: "text", text: "answer " + tag }] } });
    out({ type: "result", subtype: "success", is_error: false, usage: { input_tokens: 1, output_tokens: 1 } });
  } else if (sc === "result-on-term") {
    // Finishes its answer while being stopped: the result lands on SIGTERM.
    out({ type: "assistant", message: { content: [{ type: "text", text: "almost done" }] } });
    process.on("SIGTERM", () => {
      out({ type: "result", subtype: "success", is_error: false, usage: { input_tokens: 1, output_tokens: 1 } });
      setTimeout(() => process.exit(0), 50);
    });
    setInterval(() => {}, 1000);
    return "hang";
  } else if (sc === "hang") {
    out({ type: "assistant", message: { content: [{ type: "text", text: "partial" }] } });
    out({ type: "assistant", message: { content: [{ type: "tool_use", id: "t-" + tag, name: "Bash", input: { command: "sleep 999" } }] } });
    setInterval(() => {}, 1000);
    return "hang";
  }
}
if (warm) createInterface({ input: process.stdin }).on("line", (l) => { if (l.trim()) run(l); });
else run(process.argv.slice(2).join(" "));
`);
  chmodSync(fake, 0o755);
  port = await freePort(); pairPort = await freePort();
});

after(async () => {
  if (!dir) return;
  await stopBridge("SIGTERM");
  killFakes();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

test("the emergency stop ends every chat's run, drops queues, blocks until released, and survives a restart", { skip: !POSIX, timeout: 120_000 }, async () => {
  bridge = await startBridge({ warm: true });
  const j = await (await fetch(`http://127.0.0.1:${pairPort}/api/pair/new`, { method: "POST" })).json();
  const p = JSON.parse(Buffer.from(new URL(j.url).hash.slice(1), "base64url").toString());
  bridgeKey = Uint8Array.from(Buffer.from(p.k, "base64url"));
  device = await generateKeyPair();
  const a = await client({ sid: SID_A, pair: { codeId: Uint8Array.from(Buffer.from(p.i, "base64url")), psk: Uint8Array.from(Buffer.from(p.p, "base64url")) } });
  const b = await client({ sid: SID_B });

  let st = await a.call("GET", "/api/status");
  assert.equal(st.body.emergencyStop.active, false);
  assert.equal(st.body.features.emergencyStop, 1);

  // Chat A: a running tool and one queued prompt. Chat B: a running tool.
  await a.prompt("A1", "hang");
  await a.waitFor((f) => f.type === "activity" && f.phase === "start" && f.assistantMessageId === "a-A1", "A1 tool start");
  await a.prompt("A2", "ok");
  await a.waitFor((f) => f.type === "queued" && f.assistantMessageId === "a-A2", "A2 queued");
  await b.prompt("B1", "hang");
  await b.waitFor((f) => f.type === "activity" && f.phase === "start" && f.assistantMessageId === "a-B1", "B1 tool start");
  const pidA = runsOf("A1")[0].pid, pidB = runsOf("B1")[0].pid;

  const r = await b.call("POST", "/api/emergency-stop");
  assert.equal(r.head.status ?? 200, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.emergencyStop.active, true);
  assert.equal(r.body.stopped, 2);
  assert.equal(r.body.dropped, 1);
  assert.equal(r.body.persisted, true);

  // Both chats hear it and both runs end as stopped.
  await a.waitFor((f) => f.type === "emergency" && f.active === true, "A told");
  await b.waitFor((f) => f.type === "emergency" && f.active === true, "B told");
  const tA1 = await a.waitFor(isTerminal("a-A1"), "A1 terminal");
  assert.equal(tA1.type, "error");
  assert.match(tA1.message, /emergency stop/);
  assert.equal((await b.waitFor(isTerminal("a-B1"), "B1 terminal")).type, "error");
  for (let i = 0; i < 80 && (alive(pidA) || alive(pidB)); i++) await sleep(100);
  assert.ok(!alive(pidA) && !alive(pidB), "a stopped claude is still running");
  // The queued prompt never ran.
  await sleep(500);
  assert.equal(runsOf("A2").length, 0);
  let hist = await a.call("GET", `/api/sessions/${SID_A}/messages`);
  const rowA2 = hist.body.messages.find((m) => m.id === "a-A2");
  assert.equal(rowA2.turnStatus, "not_started");
  assert.match(rowA2.turnError, /emergency stop/);

  // New prompts are refused, nothing is started.
  await a.prompt("A3", "ok");
  const tA3 = await a.waitFor(isTerminal("a-A3"), "A3 refused");
  assert.equal(tA3.type, "error");
  assert.match(tA3.message, /Emergency stop is on/);
  assert.equal(runsOf("A3").length, 0);

  // A restart keeps it on.
  await a.close(); await b.close();
  await stopBridge("SIGTERM");
  bridge = await startBridge({ warm: true });
  assert.match(bridge.logs.text, /emergency_stop_active_at_boot/);
  const c = await client({ sid: SID_A });
  st = await c.call("GET", "/api/status");
  assert.equal(st.body.emergencyStop.active, true);
  await c.prompt("A4", "ok");
  assert.equal((await c.waitFor(isTerminal("a-A4"), "A4 refused")).type, "error");
  assert.equal(runsOf("A4").length, 0);

  // Released: runs again, and every open chat is told.
  const rel = await c.call("POST", "/api/emergency-release");
  assert.equal(rel.body.ok, true);
  assert.equal(rel.body.emergencyStop.active, false);
  await c.waitFor((f) => f.type === "emergency" && f.active === false, "release told");
  await c.prompt("A5", "ok");
  const tA5 = await c.waitFor(isTerminal("a-A5"), "A5 done");
  assert.equal(tA5.type, "done", JSON.stringify(tA5));
  assert.equal(runsOf("A5").length, 1);

  // Journal: the stopped and the refused turns carry the emergency reason.
  const overview = readFileSync(join(journalDir, "00-Conduit-Uebersicht.md"), "utf8")
    + readFileSync(join(journalDir, `Conduit-Journal-${SID_A}.md`), "utf8");
  assert.match(overview, /Not-Aus/);
  await c.close();
  await stopBridge("SIGTERM");
  killFakes();
});

for (const warm of [true, false]) {
  test(`a read-only turn runs claude with read tools only (${warm ? "warm" : "one-shot"}), and never shares a process with a normal turn`, { skip: !POSIX, timeout: 60_000 }, async () => {
    bridge = await startBridge({ warm });
    const c = await client({ sid: SID_B });
    const tag = warm ? "W" : "S";
    await c.prompt(`${tag}1`, "ok");
    assert.equal((await c.waitFor(isTerminal(`a-${tag}1`), "normal done")).type, "done");
    await c.prompt(`${tag}2`, "ok", { readOnly: true });
    assert.equal((await c.waitFor(isTerminal(`a-${tag}2`), "read-only done")).type, "done");
    await c.prompt(`${tag}3`, "ok");
    assert.equal((await c.waitFor(isTerminal(`a-${tag}3`), "normal again done")).type, "done");

    const [n1] = runsOf(`${tag}1`), [ro] = runsOf(`${tag}2`), [n3] = runsOf(`${tag}3`);
    assert.equal(n1.mode, "bypassPermissions");
    assert.equal(ro.mode, "dontAsk");
    assert.equal(ro.tools, "Read,Grep,Glob");
    assert.equal(ro.allowed, "Read,Grep,Glob");
    assert.equal(ro.strictMcp, true);
    assert.equal(ro.prompts, "none");
    assert.equal(n3.mode, "bypassPermissions");
    assert.equal(n3.tools, null);
    assert.equal(ro.warm, warm);
    // Each change of rights is a new process.
    assert.notEqual(ro.pid, n1.pid);
    assert.notEqual(n3.pid, ro.pid);
    await c.close();
    await stopBridge("SIGTERM");
    killFakes();
  });
}

test("an engine that cannot enforce read-only refuses the turn instead of running it", { skip: !POSIX, timeout: 60_000 }, async () => {
  bridge = await startBridge({ warm: false });
  const c = await client({ sid: SID_B });
  await c.prompt("X1", "ok", { readOnly: true, engine: "codex" });
  const t = await c.waitFor(isTerminal("a-X1"), "X1 refused");
  assert.equal(t.type, "error");
  assert.match(t.message, /cannot run read-only/);
  assert.equal(runsOf("X1").length, 0);
  await c.close();
  await stopBridge("SIGTERM");
  killFakes();
});

test("an emergency stop that cannot be saved stays visible on every status read, and a full disk cannot lift it on restart", { skip: !POSIX || process.getuid?.() === 0, timeout: 120_000 }, async () => {
  const { chmodSync: chmod, rmSync: rm } = await import("node:fs");
  const logDir = join(dir, "logs");
  bridge = await startBridge({ warm: false });
  let c = await client({ sid: SID_A });
  // Nothing on disk and nothing can be created: held in memory, said on every read.
  rm(join(logDir, ".emergency-stop.json"), { force: true });
  chmod(logDir, 0o500);
  try {
    const on = await c.call("POST", "/api/emergency-stop");
    assert.equal(on.body.persisted, false);
    assert.equal(on.body.emergencyStop.unsaved, true);
    for (let i = 0; i < 2; i++) {   // the app opening Tasks again, twice
      const st = await c.call("GET", "/api/status");
      assert.equal(st.body.emergencyStop.active, true);
      assert.equal(st.body.emergencyStop.unsaved, true);
    }
  } finally { chmod(logDir, 0o700); }
  // Writable again: release, then the full-disk case with an existing file.
  assert.equal((await c.call("POST", "/api/emergency-release")).body.ok, true);
  chmod(logDir, 0o500);
  try {
    const on = await c.call("POST", "/api/emergency-stop");
    assert.equal(on.body.persisted, true);
    assert.equal(on.body.emergencyStop.unsaved, false);
  } finally { chmod(logDir, 0o700); }
  await c.close();
  await stopBridge("SIGTERM");
  bridge = await startBridge({ warm: false });
  c = await client({ sid: SID_A });
  const st = await c.call("GET", "/api/status");
  assert.equal(st.body.emergencyStop.active, true, "a restart lifted the stop");
  await c.prompt("F1", "ok");
  assert.equal((await c.waitFor(isTerminal("a-F1"), "F1 refused")).type, "error");
  assert.equal(runsOf("F1").length, 0);
  assert.equal((await c.call("POST", "/api/emergency-release")).body.emergencyStop.active, false);
  await c.close();
  await stopBridge("SIGTERM");
  killFakes();
});

test("an answer that completes while the emergency stop ends it is recorded as stopped by it", { skip: !POSIX, timeout: 60_000 }, async () => {
  bridge = await startBridge({ warm: true });
  const c = await client({ sid: SID_B });
  await c.prompt("R1", "result-on-term", { engine: "claude" });  // the chat was on codex
  await c.waitFor((f) => f.type === "chunk" && f.assistantMessageId === "a-R1", "R1 running");
  await c.call("POST", "/api/emergency-stop");
  const t = await c.waitFor(isTerminal("a-R1"), "R1 terminal");
  assert.equal(t.type, "error", JSON.stringify(t));
  assert.match(t.message, /emergency stop/);
  const hist = await c.call("GET", `/api/sessions/${SID_B}/messages`);
  const row = hist.body.messages.find((m) => m.id === "a-R1");
  assert.notEqual(row.turnStatus, "ok");
  assert.match(row.content, /almost done/);
  await c.call("POST", "/api/emergency-release");
  await c.close();
  await stopBridge("SIGTERM");
  killFakes();
});

test("an answer that completes while the user's Stop ends it is recorded as stopped, not ok", { skip: !POSIX, timeout: 60_000 }, async () => {
  bridge = await startBridge({ warm: true });
  const c = await client({ sid: SID_B });
  await c.prompt("R2", "result-on-term", { engine: "claude" });
  await c.waitFor((f) => f.type === "chunk" && f.assistantMessageId === "a-R2", "R2 running");
  await c.send({ type: "stop" });
  const t = await c.waitFor(isTerminal("a-R2"), "R2 terminal");
  assert.equal(t.type, "error", JSON.stringify(t));
  const hist = await c.call("GET", `/api/sessions/${SID_B}/messages`);
  const row = hist.body.messages.find((m) => m.id === "a-R2");
  assert.notEqual(row.turnStatus, "ok");
  assert.match(row.content, /almost done/);
  await c.close();
  await stopBridge("SIGTERM");
  killFakes();
});
