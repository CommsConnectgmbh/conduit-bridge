// Scheduled automations against the real bridge with a stand-in claude.
// What must hold (Conduit 2.0 phase 4, reviewed design v2 + conditions):
//   - a due slot runs collect → model → deliver; the model process gets the
//     no-tools profile (--tools "", strict MCP, no settings, no session),
//     its prompt on stdin (not in argv), and none of the bridge's secrets;
//   - the chat it creates is marked origin "schedule"; a follow-up there runs
//     in the same no-tools profile even when the frame asks for another
//     engine; its folder cannot be changed;
//   - a process that does not report an empty tool set at init is killed and
//     the run fails with profile_mismatch;
//   - the emergency stop kills a running collect (process group) and the run
//     is deferred, not delivered;
//   - the VAPID key given in the environment never reaches a normal turn;
//   - /api/week and the journal carry origin and rights.
// POSIX only: the stand-in CLI and commands are shebang scripts.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, chmodSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import WebSocket from "ws";
import { generateKeyPair } from "../../src/e2e-noise.mjs";
import { connect, KIND, SUBPROTOCOL } from "../../src/e2e.mjs";
import { encodeMessage, MessageReader } from "../../src/e2e-messages.mjs";
import { generateVapidPrivateKey } from "../../src/webpush.mjs";

const POSIX = process.platform !== "win32";
const HOST = "auto.tunnel.example";
const SID_LIVE = "abcdabcd-cccc-4222-8333-444455556666";
const EMAIL = "owner@example.com";
const VAPID = generateVapidPrivateKey();

let dir, fakeLog, deliverLog, journalDir, bridge = null, bridgeKey, device, pairPort, port, collectPidFile;
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lines = (f) => (existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

function utcHHMM(ms) {
  const d = new Date(ms);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

async function startBridge(env = {}) {
  const logs = { text: "" };
  const proc = spawn(process.execPath, [fileURLToPath(new URL("../../src/server.mjs", import.meta.url))], {
    env: {
      PATH: process.env.PATH, HOME: join(dir, "home"), BRIDGE_PORT: String(port), PAIR_PORT: String(pairPort),
      PAIR_PUBLIC_HOST: HOST, PAIR_OWNER_EMAIL: EMAIL, DB_DIR: join(dir, "db"), LOG_DIR: join(dir, "logs"),
      PASTE_DIR: join(dir, "paste"), CLAUDE_CWD: join(dir, "home"), CLAUDE_BIN: join(dir, "fake-claude.mjs"),
      CODEX_BIN: join(dir, "fake-claude.mjs"),
      CONDUIT_SELFUPDATE: "0", CONDUIT_WARM: "0", BRIDGE_ALLOWED_HOSTS: `127.0.0.1,localhost,${HOST}`,
      CONDUIT_JOURNAL_DIR: journalDir, BRIDGE_SECRET: "bridge-secret-value",
      CONDUIT_VAPID_PRIVATE_KEY: VAPID, ...env,
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

async function stopBridge() {
  if (!bridge) return;
  const { proc } = bridge;
  if (proc.exitCode === null && proc.signalCode === null) {
    const exited = new Promise((r) => proc.once("exit", r));
    proc.kill("SIGTERM");
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

async function client({ pair = null, sid = null } = {}) {
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
  const waitFor = async (pred, what, ms = 15_000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { const f = frames.find(pred); if (f) return f; await sleep(25); }
    throw new Error(`timed out waiting for ${what}; frames: ${JSON.stringify(frames).slice(0, 2000)}`);
  };
  return { session, call, send, frames, waitFor, close: () => session.goaway() };
}

let paired = false;
async function pairedClient(sid = null) {
  if (paired) return client({ sid });
  const j = await (await fetch(`http://127.0.0.1:${pairPort}/api/pair/new`, { method: "POST" })).json();
  const p = JSON.parse(Buffer.from(new URL(j.url).hash.slice(1), "base64url").toString());
  bridgeKey = Uint8Array.from(Buffer.from(p.k, "base64url"));
  device = await generateKeyPair();
  const c = await client({ sid, pair: { codeId: Uint8Array.from(Buffer.from(p.i, "base64url")), psk: Uint8Array.from(Buffer.from(p.p, "base64url")) } });
  paired = true;
  return c;
}

const isTerminal = (aid) => (f) => (f.type === "done" || f.type === "error") && f.assistantMessageId === aid;

async function waitRun(c, id, pred, what, ms = 20_000) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < ms) {
    let r;
    try { r = await c.call("GET", "/api/automations"); } catch (e) { throw new Error(`${e.message}; last run: ${JSON.stringify(last)}\n${bridge?.logs.text.slice(-4000)}`); }
    last = r.body.automations?.find((a) => a.id === id)?.lastRun || null;
    if (last && pred(last)) return last;
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${what}; last run: ${JSON.stringify(last)}\n${bridge?.logs.text.slice(-3000)}`);
}

before(async () => {
  if (!POSIX) return;
  dir = mkdtempSync(join(tmpdir(), "conduit-auto-int-"));
  chmodSync(dir, 0o700);
  mkdirSync(join(dir, "home"), { recursive: true });
  mkdirSync(join(dir, "db"), { recursive: true, mode: 0o700 });
  mkdirSync(join(dir, "bin"), { recursive: true, mode: 0o700 });
  journalDir = join(dir, "journal");
  fakeLog = join(dir, "fake-runs.jsonl");
  deliverLog = join(dir, "delivered.jsonl");
  collectPidFile = join(dir, "collect.pid");
  const fake = join(dir, "fake-claude.mjs");
  writeFileSync(fake, `#!${process.execPath}
import { appendFileSync } from "node:fs";
if (process.argv[2] === "auth") { process.stdout.write(JSON.stringify({ loggedIn: true }) + "\\n"); process.exit(0); }
const LOG = ${JSON.stringify(fakeLog)};
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const argv = process.argv.slice(2);
const argAfter = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const scheduled = argv.includes("--no-session-persistence");
const record = (stdin) => appendFileSync(LOG, JSON.stringify({
  pid: process.pid, scheduled, argv, stdin,
  tools: argAfter("--tools"), settingSources: argAfter("--setting-sources"), mode: argAfter("--permission-mode"),
  strictMcp: argv.includes("--strict-mcp-config"), noSlash: argv.includes("--disable-slash-commands"),
  envKeys: Object.keys(process.env),
}) + "\\n");
if (scheduled) {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => { input += d; });
  process.stdin.on("end", () => {
    record(input);
    const mismatch = input.includes("MODE:mismatch");
    out({ type: "system", subtype: "init", tools: mismatch ? ["Bash"] : [], mcp_servers: [], slash_commands: [], permissionMode: "dontAsk" });
    if (mismatch) { setInterval(() => {}, 1000); return; }
    if (input.includes("FAILQ")) { out({ type: "result", subtype: "error_during_execution", is_error: true, result: "" }); process.exit(1); }
    out({ type: "assistant", message: { content: [{ type: "text", text: input.includes("follow-up question") ? "Follow-up answer." : "Two appointments today.\\n---\\nDetails: 09:00 Dentist." }] } });
    out({ type: "result", subtype: "success", is_error: false, result: "", usage: { input_tokens: 900, output_tokens: 70 } });
  });
} else {
  record(argv.join(" "));
  out({ type: "system", subtype: "init", session_id: "11111111-2222-3333-4444-555555555555" });
  out({ type: "assistant", message: { content: [{ type: "text", text: "live answer" }] } });
  out({ type: "result", subtype: "success", is_error: false, usage: { input_tokens: 1, output_tokens: 1 } });
}
`);
  chmodSync(fake, 0o755);
  const collect = join(dir, "bin", "collect");
  writeFileSync(collect, `#!/bin/sh
cat <<'EOF'
${JSON.stringify({ version: 1, sources: [
    { id: "calendar", title: "Calendar today", status: "ok", count: 1, newCount: null, fetchedAt: "2026-11-24T06:00:00+01:00", text: "09:00 Dentist" },
    { id: "mail", title: "Unread mail", status: "error", count: null, newCount: null, fetchedAt: "2026-11-24T06:00:01+01:00", text: "" },
  ] })}
EOF
`);
  const slowCollect = join(dir, "bin", "slow-collect");
  writeFileSync(slowCollect, `#!/bin/sh\necho $$ > "${collectPidFile}"\nsleep 60\n`);
  const deliver = join(dir, "bin", "deliver");
  writeFileSync(deliver, `#!/bin/sh\ncat >> "${deliverLog}"\necho >> "${deliverLog}"\n`);
  for (const f of [collect, slowCollect, deliver]) chmodSync(f, 0o700);
  const now = Date.now();
  const cfg = {
    version: 1, owner: EMAIL, tz: "UTC", push: { contact: "mailto:owner@example.com" },
    automations: [
      { id: "briefing", title: "Morning briefing", schedule: { time: utcHHMM(now - 60_000), days: [1, 2, 3, 4, 5, 6, 7] },
        prompt: "Summarise.", collect: [collect], deliver: [deliver], push: true, windowHours: 1 },
      { id: "check", title: "Profile check", schedule: { time: utcHHMM(now + 6 * 3600_000), days: [1, 2, 3, 4, 5, 6, 7] },
        prompt: "MODE:mismatch", collect: [collect] },
      { id: "slow", title: "Slow one", schedule: { time: utcHHMM(now + 6 * 3600_000), days: [1, 2, 3, 4, 5, 6, 7] },
        prompt: "Summarise.", collect: [slowCollect], deliver: [deliver] },
    ],
  };
  writeFileSync(join(dir, "db", "automations.json"), JSON.stringify(cfg));
  chmodSync(join(dir, "db", "automations.json"), 0o600);
  port = await freePort(); pairPort = await freePort();
});

after(async () => {
  if (!dir) return;
  await stopBridge();
  for (const r of lines(fakeLog)) { try { process.kill(r.pid, "SIGKILL"); } catch { /* gone */ } }
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

test("scheduled briefing end to end, follow-up, profile check, emergency stop, secrets", { skip: !POSIX, timeout: 120_000 }, async () => {
  bridge = await startBridge();
  const c = await pairedClient();
  const st = await c.call("GET", "/api/status");
  assert.equal(st.body.features.automations, 1);
  assert.equal(st.body.features.week, 1);
  assert.equal(st.body.features.push, 1);

  // 1. The due slot runs on its own.
  const run = await waitRun(c, "briefing", (r) => r.state === "done", "scheduled run done");
  assert.equal(run.kind, "schedule");
  assert.equal(run.summary, "Two appointments today.");
  assert.equal(run.delivery.telegram, "sent");
  assert.equal(run.delivery.push, "off", "no device subscribed");
  assert.deepEqual(run.tokens, { in: 900, out: 70 });
  assert.equal(run.header.sources.find((s) => s.id === "mail").status, "error");

  const sched = lines(fakeLog).filter((r) => r.scheduled);
  assert.equal(sched.length, 1);
  const s0 = sched[0];
  assert.equal(s0.tools, "", "no tools at all");
  assert.equal(s0.settingSources, "", "no settings, so no hooks");
  assert.equal(s0.mode, "dontAsk");
  assert.ok(s0.strictMcp && s0.noSlash);
  assert.ok(!s0.argv.includes("--resume"));
  assert.ok(s0.stdin.includes("09:00 Dentist"), "data comes on stdin");
  assert.ok(!s0.argv.join(" ").includes("Dentist"), "never in argv");
  for (const k of ["BRIDGE_SECRET", "CONDUIT_VAPID_PRIVATE_KEY", "PAIR_OWNER_EMAIL", "DB_DIR"]) {
    assert.ok(!s0.envKeys.includes(k), `scheduled run must not see ${k}`);
  }
  const [d] = lines(deliverLog);
  assert.equal(d.summary, "Two appointments today.");
  assert.match(d.header, /Unread mail: UNAVAILABLE/);

  // 2. The chat it made is marked, cannot get a folder, and stays without tools.
  const sessions = await c.call("GET", "/api/sessions");
  const ss = sessions.body.sessions.find((s) => s.id === run.sessionId);
  assert.equal(ss.origin, "schedule");
  assert.equal(ss.automationId, "briefing");
  const patch = await c.call("PATCH", `/api/sessions/${run.sessionId}`, { cwd: join(dir, "home") });
  assert.equal(patch.head.status, 409);

  const f = await client({ sid: run.sessionId });
  await f.send({ type: "prompt", content: "What time is the dentist?", userMessageId: "u-f1", assistantMessageId: "a-f1", engine: "codex", readOnly: false, spoken: true });
  assert.equal((await f.waitFor(isTerminal("a-f1"), "follow-up done")).type, "done");
  const follow = lines(fakeLog).filter((r) => r.scheduled)[1];
  assert.ok(follow, "follow-up ran in the scheduled profile");
  assert.equal(follow.tools, "");
  assert.ok(!follow.argv.includes("exec"), "not codex, whatever the frame said");
  assert.ok(follow.stdin.includes("Two appointments today."), "history of this chat as data");
  assert.ok(follow.stdin.includes("What time is the dentist?"));
  // A failed follow-up must be reported as failed to an app that reconnects.
  await f.send({ type: "prompt", content: "FAILQ please", userMessageId: "u-f2", assistantMessageId: "a-f2" });
  assert.equal((await f.waitFor(isTerminal("a-f2"), "failed follow-up")).type, "error");
  await f.close();
  const f2 = await client({ sid: run.sessionId });
  await f2.send({ type: "attach" });
  const replay = await f2.waitFor((x) => (x.type === "error" || x.type === "done") && x.assistantMessageId === "a-f2", "attach replay");
  assert.equal(replay.type, "error", "reconnect must not report a failed answer as done");
  await f2.close();

  // 3. A normal live turn: full rights as before, but no VAPID key in reach.
  const l = await client({ sid: SID_LIVE });
  await l.send({ type: "prompt", content: "hello", userMessageId: "u-l1", assistantMessageId: "a-l1" });
  assert.equal((await l.waitFor(isTerminal("a-l1"), "live done")).type, "done");
  const live = lines(fakeLog).find((r) => !r.scheduled);
  assert.equal(live.mode, "bypassPermissions");
  assert.ok(!live.envKeys.includes("CONDUIT_VAPID_PRIVATE_KEY"), "VAPID key never reaches an agent");
  await l.close();

  // 4. Push key is served.
  const key = await c.call("GET", "/api/push/key");
  assert.equal(key.body.enabled, true);
  assert.equal(Buffer.from(key.body.publicKey, "base64url").length, 65);
  const badSub = await c.call("POST", "/api/push/subscribe", { subscription: { endpoint: "https://169.254.169.254/x", keys: { p256dh: "x", auth: "y" } } });
  assert.equal(badSub.head.status, 400);

  // 5. A process that reports tools at init is stopped: profile_mismatch.
  const r5 = await c.call("POST", "/api/automations/check/run");
  assert.equal(r5.head.status, 202);
  const mm = await waitRun(c, "check", (r) => r.state === "failed", "profile mismatch");
  assert.equal(mm.errorClass, "profile_mismatch");
  const msgs = await c.call("GET", `/api/sessions/${mm.sessionId}/messages`);
  assert.equal(msgs.body.origin, "schedule", "origin also on the messages route");
  assert.equal(msgs.body.automationId, "check");
  const a = msgs.body.messages.find((m) => m.role === "assistant");
  assert.equal(a.turnStatus ?? a.turn_status, "error");

  // 6. Emergency stop during collect: process group killed, nothing delivered.
  const before = lines(deliverLog).length;
  assert.equal((await c.call("POST", "/api/automations/slow/run")).head.status, 202);
  for (let i = 0; i < 100 && !existsSync(collectPidFile); i++) await sleep(50);
  const pid = Number(readFileSync(collectPidFile, "utf8"));
  assert.ok(alive(pid));
  await c.call("POST", "/api/emergency-stop");
  for (let i = 0; i < 100 && alive(pid); i++) await sleep(50);
  assert.equal(alive(pid), false, "collect process killed");
  const em = await waitRun(c, "slow", (r) => r.errorClass === "emergency", "deferred by emergency");
  assert.equal(em.state, "claimed");
  assert.equal(em.attempts, 0);
  assert.equal(lines(deliverLog).length, before, "nothing delivered");
  assert.equal((await c.call("POST", "/api/automations/briefing/run")).head.status, 409, "manual run refused while stopped");
  const tp = await c.call("POST", "/api/push/test");
  assert.equal(tp.head.status, 409);
  assert.equal(tp.body.error, "emergency", "no test push while stopped");
  await c.call("POST", "/api/emergency-release");

  // 7. Week view and journal carry the facts.
  const wk = await c.call("GET", "/api/week");
  assert.equal(wk.body.days.length, 7);
  const today = wk.body.days[6];
  assert.ok(today.turns.ok >= 2);
  assert.equal(today.briefing.state, "done");
  const files = readdirSync(journalDir).filter((n) => n.startsWith("Conduit-Journal-"));
  const all = files.map((n) => readFileSync(join(journalDir, n), "utf8")).join("\n");
  assert.match(all, /Herkunft: `schedule` · Rechte: `scheduled`/);
  assert.match(all, /Herkunft: `live` · Rechte: `full`/);

  // 8. After the release the deferred manual run is picked up again; stopping
  // the bridge in the middle of its collect kills the detached group too.
  const t0 = Date.now();
  let pid2 = pid;
  while (Date.now() - t0 < 15_000 && (pid2 === pid || !alive(pid2))) {
    await sleep(250);
    try { pid2 = Number(readFileSync(collectPidFile, "utf8")); } catch { /* not yet */ }
  }
  assert.notEqual(pid2, pid, "a run held by the emergency stop continues right after the release");
  assert.ok(alive(pid2));
  await c.close();
  await stopBridge();
  for (let i = 0; i < 40 && alive(pid2); i++) await sleep(50);
  assert.equal(alive(pid2), false, "collect outlived the bridge");
});

// 3.9.0: the briefing set up in the app, on the real path (no automations.json,
// a GitHub connection, the real scheduled summary). Switching it off while it
// collects lets that run finish with the settings it started with; the PR
// becomes a to-do of the owner.
test("app briefing: runs without automations.json, survives being switched off mid-run, GitHub PR becomes a to-do", { skip: !POSIX, timeout: 120_000 }, async () => {
  await stopBridge();
  const { renameSync } = await import("node:fs");
  renameSync(join(dir, "db", "automations.json"), join(dir, "db", "automations.json.off"));
  const ghDir = join(dir, "gh-bin");
  mkdirSync(ghDir, { recursive: true, mode: 0o700 });
  const ghStarted = join(dir, "gh-started");
  writeFileSync(join(ghDir, "gh"), `#!/bin/sh
echo "$@" >> "${ghStarted}"
sleep 2
case "$2" in prs) echo '[{"url":"https://github.com/acme/app/pull/7","title":"Fix login","repository":{"nameWithOwner":"acme/app"},"updatedAt":"2026-11-27T10:00:00Z","number":7}]';; *) echo '[]';; esac
`);
  chmodSync(join(ghDir, "gh"), 0o700);
  bridge = await startBridge({ PATH: `${ghDir}:${process.env.PATH}`, TZ: "UTC" });
  const c = await pairedClient();
  let st = await c.call("GET", "/api/automations");
  assert.equal(st.body.enabled, false, "nothing set up yet");
  const add = await c.call("POST", "/api/connections", { kind: "github" });
  assert.equal(add.head.status, 200);
  const on = await c.call("POST", "/api/connections/briefing", { enabled: true, time: utcHHMM(Date.now() + 6 * 3600_000), days: [1, 2, 3, 4, 5, 6, 7], prompt: "Summarise." });
  assert.equal(on.head.status, 200);
  st = await c.call("GET", "/api/automations");
  assert.equal(st.body.enabled, true);
  assert.equal(st.body.source, "app");
  const run = await c.call("POST", "/api/automations/briefing/run");
  assert.equal(run.head.status, 202);
  for (let i = 0; i < 100 && !existsSync(ghStarted); i++) await sleep(50);
  assert.ok(existsSync(ghStarted), "the connection is being read");
  // Switched off while gh still runs.
  const off = await c.call("POST", "/api/connections/briefing", { enabled: false, time: "07:00", days: [1], prompt: "Summarise." });
  assert.equal(off.head.status, 200);
  // The run ends done, with the GitHub source, written by the real scheduled path.
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < 30_000) {
    const runs = await c.call("GET", "/api/week");
    const todos = await c.call("GET", "/api/todos");
    last = todos.body;
    if (todos.body.todos?.some((t) => t.origin === "source" && /acme\/app#7 Fix login/.test(t.text))) break;
    await sleep(300);
    void runs;
  }
  const todo = last.todos.find((t) => t.origin === "source");
  assert.ok(todo, "the PR is a to-do: " + JSON.stringify(last).slice(0, 400) + "\n" + bridge.logs.text.slice(-2500));
  assert.equal(todo.url, "https://github.com/acme/app/pull/7");
  for (let i = 0; i < 60 && !/automation_run_done/.test(bridge.logs.text); i++) await sleep(250);
  assert.match(bridge.logs.text, /"automation_run_done"/, "the run finished: " + bridge.logs.text.slice(-2500));
  assert.doesNotMatch(bridge.logs.text, /automation_run_crashed/);
  st = await c.call("GET", "/api/automations");
  assert.equal(st.body.enabled, false, "and stays off for the next one");
  await c.close();
  await stopBridge();
  renameSync(join(dir, "db", "automations.json.off"), join(dir, "db", "automations.json"));
});
