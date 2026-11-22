// Spoken replies (conversation mode) against the real bridge with a stand-in
// claude. What must hold:
//   - a prompt frame with `spoken: true` reaches the engine with the bridge's
//     spoken-reply instruction ahead of the user's text, on the warm and the
//     one-shot path, and also when the turn waited in the queue;
//   - the stored user message is exactly what the user said;
//   - a typed turn right after it carries no such instruction, and on the
//     warm path both run in the same process (the instruction changes the
//     wording, never the rights);
//   - /api/status announces the feature.
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
const HOST = "spoken.tunnel.example";
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
  dir = mkdtempSync(join(tmpdir(), "conduit-spoken-"));
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
    strictMcp: process.argv.includes("--strict-mcp-config"), prompts: argAfter("--permission-prompts"),
    spoken: raw.includes("[Conduit bridge context, not part of the user's message]") && raw.includes("read aloud"),
    contextFirst: raw.indexOf("read aloud") < raw.indexOf("TAG:") }) + "\\n");
  if (sc === "ok") {
    out({ type: "assistant", message: { content: [{ type: "text", text: "answer " + tag }] } });
    out({ type: "result", subtype: "success", is_error: false, usage: { input_tokens: 1, output_tokens: 1 } });
  } else if (sc === "slow") {
    out({ type: "assistant", message: { content: [{ type: "text", text: "thinking" }] } });
    setTimeout(() => {
      out({ type: "assistant", message: { content: [{ type: "text", text: "answer " + tag }] } });
      out({ type: "result", subtype: "success", is_error: false, usage: { input_tokens: 1, output_tokens: 1 } });
    }, 1500);
    return;
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


let paired = false;
async function pairedClient(sid) {
  if (paired) return client({ sid });
  const j = await (await fetch(`http://127.0.0.1:${pairPort}/api/pair/new`, { method: "POST" })).json();
  const p = JSON.parse(Buffer.from(new URL(j.url).hash.slice(1), "base64url").toString());
  bridgeKey = Uint8Array.from(Buffer.from(p.k, "base64url"));
  device = await generateKeyPair();
  const c = await client({ sid, pair: { codeId: Uint8Array.from(Buffer.from(p.i, "base64url")), psk: Uint8Array.from(Buffer.from(p.p, "base64url")) } });
  paired = true;
  return c;
}

for (const warm of [true, false]) {
  test(`a spoken turn asks for a short spoken answer (${warm ? "warm" : "one-shot"}); the stored message and the next typed turn stay untouched`, { skip: !POSIX, timeout: 60_000 }, async () => {
    bridge = await startBridge({ warm });
    const sid = warm ? SID_A : SID_B;
    const c = await pairedClient(sid);
    const st = await c.call("GET", "/api/status");
    assert.equal(st.body.features.spokenReplies, 1);
    const tag = warm ? "W" : "S";

    await c.prompt(`${tag}1`, "ok", { spoken: true });
    assert.equal((await c.waitFor(isTerminal(`a-${tag}1`), "spoken done")).type, "done");
    await c.prompt(`${tag}2`, "ok");
    assert.equal((await c.waitFor(isTerminal(`a-${tag}2`), "typed done")).type, "done");
    // Anything but a literal true is not a spoken turn.
    await c.prompt(`${tag}3`, "ok", { spoken: "yes" });
    assert.equal((await c.waitFor(isTerminal(`a-${tag}3`), "truthy done")).type, "done");

    const [s1] = runsOf(`${tag}1`), [t2] = runsOf(`${tag}2`), [t3] = runsOf(`${tag}3`);
    assert.equal(s1.spoken, true);
    assert.equal(s1.contextFirst, true);
    assert.equal(t2.spoken, false);
    assert.equal(t3.spoken, false);
    // Same rights either way.
    assert.equal(s1.mode, "bypassPermissions");
    assert.equal(t2.mode, "bypassPermissions");
    assert.equal(s1.warm, warm);
    if (warm) assert.equal(t2.pid, s1.pid, "switching between talking and typing restarted the warm claude");

    const hist = await c.call("GET", `/api/sessions/${sid}/messages`);
    const u1 = hist.body.messages.find((m) => m.id === `u-${tag}1`);
    assert.equal(u1.content ?? u1.text, `TAG:${tag}1 SCENARIO:ok`);
    await c.close();
    await stopBridge("SIGTERM");
    killFakes();
  });
}

test("a spoken prompt that waits in the queue keeps asking for a spoken answer", { skip: !POSIX, timeout: 60_000 }, async () => {
  bridge = await startBridge({ warm: true });
  const c = await pairedClient(SID_A);
  await c.prompt("Q1", "slow");
  await c.waitFor((f) => f.type === "chunk" && f.assistantMessageId === "a-Q1", "Q1 running");
  await c.prompt("Q2", "ok", { spoken: true });
  await c.waitFor((f) => f.type === "queued" && f.assistantMessageId === "a-Q2", "Q2 queued");
  assert.equal((await c.waitFor(isTerminal("a-Q1"), "Q1 done")).type, "done");
  assert.equal(runsOf("Q1")[0].spoken, false);
  assert.equal((await c.waitFor(isTerminal("a-Q2"), "Q2 done", 20_000)).type, "done");
  const [q2] = runsOf("Q2");
  assert.equal(q2.spoken, true);
  await c.close();
  await stopBridge("SIGTERM");
  killFakes();
});
