// Claude sign-in watch and phone sign-in (bridge 3.7.0) against the real
// bridge with a stand-in CLI. What must hold:
//   - a warm turn that takes the prompt and then never talks to the model is
//     ended after CONDUIT_TURN_FIRST_REPLY_MS with a clear error, and the owner
//     is told once through alerts.deliver;
//   - an expired stored login is reported in /api/status and alerted once;
//   - signing in again from the phone: the link comes back, the code goes to
//     the waiting CLI, and afterwards the login reads as fine;
//   - the stored-login commands never see the bridge's own token.
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
const HOST = "login.tunnel.example";
const SID_A = "abcdabcd-aaaa-4222-8333-444455556666";
const SID_B = "abcdabcd-bbbb-4222-8333-444455556666";
const EMAIL = "owner@example.com";

let dir, fakeLog, journalDir, bridge = null, bridgeKey, device, pairPort, port, statusFile, alertsFile;
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
      CONDUIT_JOURNAL_DIR: journalDir, CONDUIT_TURN_FIRST_REPLY_MS: "800", FAKE_STATUS_FILE: statusFile, TZ: "Europe/Berlin", ...env,
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


const OK_UNTIL = "2027-01-01T00:00:00Z";
const setStored = (o) => writeFileSync(statusFile, JSON.stringify(o));
const alerts = () => (existsSync(alertsFile) ? readFileSync(alertsFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
async function until(pred, what, ms = 10_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = pred(); if (v) return v; await sleep(50); }
  throw new Error("timed out waiting for " + what);
}

before(async () => {
  if (!POSIX) return;
  dir = mkdtempSync(join(tmpdir(), "conduit-login-"));
  mkdirSync(join(dir, "home"), { recursive: true });
  mkdirSync(join(dir, "db"), { recursive: true, mode: 0o700 });
  journalDir = join(dir, "journal");
  fakeLog = join(dir, "fake-runs.jsonl");
  statusFile = join(dir, "stored-status.json");
  alertsFile = join(dir, "alerts.jsonl");
  setStored({ loggedIn: true, authMethod: "claude.ai", loginExpiresAt: OK_UNTIL });
  const fake = join(dir, "fake-claude.mjs");
  writeFileSync(fake, `#!${process.execPath}
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const LOG = ${JSON.stringify(fakeLog)};
const STATUS = process.env.FAKE_STATUS_FILE;
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
if (process.argv[2] === "auth") {
  appendFileSync(LOG, JSON.stringify({ pid: process.pid, auth: process.argv[3], token: !!process.env.CLAUDE_CODE_OAUTH_TOKEN, browser: process.env.BROWSER || null }) + "\\n");
  if (process.argv[3] === "status") {
    // The bridge's own sign-in: its token. Without it: the stored login.
    if (process.env.CLAUDE_CODE_OAUTH_TOKEN) out({ loggedIn: true, authMethod: "oauth_token", loginExpiresAt: null });
    else process.stdout.write(readFileSync(STATUS, "utf8") + "\\n");
    process.exit(0);
  }
  if (process.argv[3] === "login") {
    process.stdout.write("If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&state=s1\\nPaste code here if prompted > ");
    createInterface({ input: process.stdin }).once("line", (l) => {
      if (l.trim() !== "good-code#s1") { process.stdout.write("Login failed: That code wasn't accepted.\\n"); process.exit(1); }
      writeFileSync(STATUS, JSON.stringify({ loggedIn: true, authMethod: "claude.ai", loginExpiresAt: "2027-02-01T00:00:00Z" }));
      process.stdout.write("Login successful.\\n"); process.exit(0);
    });
    setInterval(() => {}, 1000);
  }
} else {
  out({ type: "system", subtype: "init", session_id: "11111111-2222-3333-4444-555555555555" });
  createInterface({ input: process.stdin }).on("line", (raw) => {
    if (!raw.trim()) return;
    const tag = (/TAG:([A-Za-z0-9]+)/.exec(raw) || [])[1] || null;
    const sc = (/SCENARIO:([a-z-]+)/.exec(raw) || [])[1] || "ok";
    appendFileSync(LOG, JSON.stringify({ pid: process.pid, tag, sc }) + "\\n");
    if (sc === "silent") {
      // What the CLI prints before any request, then nothing (25.11.2026).
      out({ type: "system", subtype: "hook_started", hook_name: "UserPromptSubmit" });
      out({ type: "system", subtype: "hook_response", hook_name: "UserPromptSubmit" });
      out({ type: "system", subtype: "status", status: "requesting" });
      return;
    }
    if (sc === "authfail") {
      out({ type: "result", subtype: "error_during_execution", is_error: true, result: "Invalid API key · Please run /login" });
      return;
    }
    out({ type: "assistant", message: { content: [{ type: "text", text: "answer " + tag }] } });
    out({ type: "result", subtype: "success", is_error: false, usage: { input_tokens: 1, output_tokens: 1 } });
  });
  setInterval(() => {}, 1000);
}
`);
  chmodSync(fake, 0o755);
  // The owner's alert channel: a deliver command that records what it got.
  const deliver = join(dir, "alert-deliver.mjs");
  writeFileSync(deliver, `#!${process.execPath}
import { appendFileSync } from "node:fs";
let s = ""; process.stdin.on("data", (d) => { s += d; }); process.stdin.on("end", () => { appendFileSync(${JSON.stringify(alertsFile)}, JSON.stringify(JSON.parse(s)) + "\\n"); });
`);
  chmodSync(deliver, 0o700);
  // A briefing that is never due during the test (not today, early hour).
  const isoToday = ((new Date().getDay() + 6) % 7) + 1;
  const days = [1, 2, 3, 4, 5, 6, 7].filter((d) => d !== isoToday && d !== (isoToday % 7) + 1 && d !== ((isoToday + 5) % 7) + 1);
  const cfg = join(dir, "db", "automations.json");
  writeFileSync(cfg, JSON.stringify({ version: 1, owner: EMAIL, tz: "Europe/Berlin",
    automations: [{ id: "briefing", title: "Briefing", schedule: { time: "03:00", days }, prompt: "x", windowHours: 1 }],
    alerts: { deliver: [deliver] } }));
  chmodSync(cfg, 0o600);
  port = await freePort(); pairPort = await freePort();
});

after(async () => {
  if (!dir) return;
  await stopBridge("SIGTERM");
  killFakes();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

test("sign-in watch: no-reply turn, expired login, phone sign-in", { skip: !POSIX, timeout: 120_000 }, async () => {
  bridge = await startBridge({ warm: true, env: { CLAUDE_CODE_OAUTH_TOKEN: "bridge-token" } });
  const j = await (await fetch(`http://127.0.0.1:${pairPort}/api/pair/new`, { method: "POST" })).json();
  const p = JSON.parse(Buffer.from(new URL(j.url).hash.slice(1), "base64url").toString());
  bridgeKey = Uint8Array.from(Buffer.from(p.k, "base64url"));
  device = await generateKeyPair();
  const a = await client({ sid: SID_A, pair: { codeId: Uint8Array.from(Buffer.from(p.i, "base64url")), psk: Uint8Array.from(Buffer.from(p.p, "base64url")) } });

  // Boot check (after ~5 s): the stored login is fine, nothing is told.
  await until(() => bridge.logs.text.includes('"claude_login_checked"'), "boot check", 15_000);
  let st = await a.call("GET", "/api/status");
  assert.equal(st.body.features.claudeLogin, 1);
  assert.equal(st.body.claudeLogin.state, "ok");
  assert.equal(st.body.claudeLogin.ownToken, true);
  assert.equal(alerts().length, 0);

  // 1. A turn that takes the prompt and never talks to the model.
  await a.prompt("S1", "silent");
  const err = await a.waitFor(isTerminal("a-S1"), "S1 end", 10_000);
  assert.equal(err.type, "error");
  assert.match(err.message, /did not start to answer within 1s/);
  assert.ok(bridge.logs.text.includes('"warm_no_reply"'));
  const told = await until(() => alerts().find((x) => x.kind === "alert" && /did not answer/.test(x.title)), "no-reply alert");
  assert.match(told.summary, /confirmation window/);
  // The next answer clears the problem.
  await a.prompt("S2", "ok");
  const ok = await a.waitFor(isTerminal("a-S2"), "S2 end");
  assert.equal(ok.type, "done");
  st = await a.call("GET", "/api/claude-login");
  assert.equal(st.body.lastTurnProblem, null);

  // 2. The stored login expires: reported and told once.
  setStored({ loggedIn: true, authMethod: "claude.ai", loginExpiresAt: "2026-01-01T00:00:00Z" });
  st = await a.call("POST", "/api/claude-login/check");
  assert.equal(st.body.state, "expired");
  await until(() => alerts().find((x) => /expired/.test(x.title)), "expired alert");
  await a.call("POST", "/api/claude-login/check");
  await sleep(300);
  assert.equal(alerts().filter((x) => /expired/.test(x.title)).length, 1, "told once");

  // 3. Sign in again from the phone.
  const s1 = await a.call("POST", "/api/claude-login/start");
  assert.equal(s1.body.ok, true);
  assert.match(s1.body.url, /^https:\/\/claude\.com\/cai\/oauth\/authorize\?/);
  const bad = await a.call("POST", "/api/claude-login/code", { id: s1.body.id, code: "has spaces" });
  assert.equal(bad.body.error, "bad_code");
  const s2 = await a.call("POST", "/api/claude-login/start");
  assert.equal(s2.body.id, s1.body.id, "still the same attempt");
  const done = await a.call("POST", "/api/claude-login/code", { id: s1.body.id, code: "good-code#s1" });
  assert.equal(done.body.ok, true, JSON.stringify(done.body));
  assert.equal(done.body.state, "ok");
  assert.equal(done.body.login, null);

  // The stored-login commands never got the bridge's token and never a browser.
  const authRuns = fakeRuns().filter((r) => r.auth);
  assert.ok(authRuns.some((r) => r.auth === "login"));
  for (const r of authRuns.filter((x) => x.auth === "login" || x.browser === "/usr/bin/true")) assert.equal(r.token, false, JSON.stringify(r));
  assert.ok(!bridge.logs.text.includes("good-code"), "the code is never logged");
  a.close();
});

test("owner boundary: only the account in PAIR_OWNER_EMAIL, and nothing without it", { skip: !POSIX, timeout: 120_000 }, async () => {
  // Same database and the device paired above (account owner@example.com).
  const checkDenied = async (what) => {
    const c = await client({ sid: SID_A });
    const st = await c.call("GET", "/api/status");
    assert.equal(st.body.claudeLogin, null, what + ": no sign-in state in the status");
    assert.equal(st.body.features.claudeLogin, undefined, what + ": feature not announced");
    for (const [m, p, body] of [["GET", "/api/claude-login"], ["POST", "/api/claude-login/check"], ["POST", "/api/claude-login/start"],
      ["POST", "/api/claude-login/code", { id: "x", code: "good-code#s1" }], ["POST", "/api/claude-login/cancel"]]) {
      const r = await c.call(m, p, body);
      assert.equal(r.head.status, 404, `${what}: ${m} ${p} -> ${r.head.status}`);
      assert.equal(r.body.ok, false);
    }
    c.close();
  };
  const loginRunsBefore = fakeRuns().filter((r) => r.auth === "login").length;

  // 1. Another account is the owner: this device's account is refused.
  await stopBridge("SIGTERM");
  bridge = await startBridge({ warm: true, env: { CLAUDE_CODE_OAUTH_TOKEN: "bridge-token", PAIR_OWNER_EMAIL: "someone-else@example.com" } });
  await checkDenied("other owner");

  // 2. No owner configured: the feature is off altogether (no fallback).
  await stopBridge("SIGTERM");
  bridge = await startBridge({ warm: true, env: { CLAUDE_CODE_OAUTH_TOKEN: "bridge-token", PAIR_OWNER_EMAIL: "" } });
  assert.ok(bridge.logs.text.includes('"claude_login_off"'));
  await checkDenied("no owner");
  await sleep(6000); // past the boot check delay: no check runs either
  assert.ok(!bridge.logs.text.includes('"claude_login_checked"'), "no sign-in check without an owner");

  // Not one sign-in was started by any refused call.
  assert.equal(fakeRuns().filter((r) => r.auth === "login").length, loginRunsBefore);
});
