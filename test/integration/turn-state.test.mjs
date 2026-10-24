// Turn state across crashes, restarts and reconnects, against the real bridge
// with a stand-in claude. What must hold:
//   - a turn that was running when the bridge died is reported "interrupted",
//     a queued one "not_started" — on WS replay, over HTTP and in history —
//     and neither is ever run a second time;
//   - a resend of a message the bridge has no answer row for is not run again;
//   - a warm turn that already ran tools is never retried through the
//     one-shot path;
//   - the automatic journal records all of it, owner-only, and leaks no
//     prompt, tool input/output, answer text, secret or private path.
// POSIX only: the stand-in CLI is a shebang script.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, chmodSync, existsSync, statSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { DatabaseSync } from "node:sqlite";
import WebSocket from "ws";
import { generateKeyPair } from "../../src/e2e-noise.mjs";
import { connect, KIND, SUBPROTOCOL } from "../../src/e2e.mjs";
import { encodeMessage, MessageReader } from "../../src/e2e-messages.mjs";

const POSIX = process.platform !== "win32";
const HOST = "turns.tunnel.example";
const SID = "abcdabcd-1111-4222-8333-444455556666";
const SECRET = "sk-ant-api03-SYNTHETICSECRET0123456789";
const PRIVATE_PATH = "/Users/test-user/private/project";
const EMAIL = "owner@example.com";

let dir, fakeLog, journalDir, bridge = null, bridgeKey, device, pairPort, port;
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeRuns() {
  if (!existsSync(fakeLog)) return [];
  return readFileSync(fakeLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
const runsOf = (tag) => fakeRuns().filter((r) => r.tag === tag);
function killFakes() {
  for (const r of fakeRuns()) { try { process.kill(r.pid, "SIGKILL"); } catch { /* gone */ } }
}

async function startBridge({ warm }) {
  const logs = { text: "" };
  const proc = spawn(process.execPath, [fileURLToPath(new URL("../../src/server.mjs", import.meta.url))], {
    env: {
      PATH: process.env.PATH, HOME: join(dir, "home"), BRIDGE_PORT: String(port), PAIR_PORT: String(pairPort),
      PAIR_PUBLIC_HOST: HOST, PAIR_OWNER_EMAIL: EMAIL, DB_DIR: join(dir, "db"), LOG_DIR: join(dir, "logs"),
      PASTE_DIR: join(dir, "paste"), CLAUDE_CWD: join(dir, "home"), CLAUDE_BIN: join(dir, "fake-claude.mjs"),
      CONDUIT_SELFUPDATE: "0", CONDUIT_WARM: warm ? "1" : "0", BRIDGE_ALLOWED_HOSTS: `127.0.0.1,localhost,${HOST}`,
      CONDUIT_JOURNAL_DIR: journalDir,
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

/** A connected device: RPC calls plus one chat channel with a frame log. */
async function client({ pair = null } = {}) {
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
  const chat = await session.open(KIND.CHAT, { sid: SID });
  const frames = [];
  const reader = new MessageReader({ maxBytes: 1e6, onMessage: (m) => frames.push(JSON.parse(Buffer.from(m))) });
  chat.on("data", (x) => reader.push(x));
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
  const prompt = (n, scenario, extra = "") => send({
    type: "prompt", content: `TAG:${n} SCENARIO:${scenario} ${extra}`, userMessageId: `u-${n}`, assistantMessageId: `a-${n}`,
  });
  return { session, call, send, frames, waitFor, prompt, close: () => session.goaway() };
}

const isTerminal = (aid) => (f) => (f.type === "done" || f.type === "error") && f.assistantMessageId === aid;
const readJournal = () => readFileSync(join(journalDir, `Conduit-Journal-${SID}.md`), "utf8");
const assistantRow = (messages, id) => messages.find((m) => m.id === id);

before(async () => {
  if (!POSIX) return;
  dir = mkdtempSync(join(tmpdir(), "conduit-turns-"));
  mkdirSync(join(dir, "home"), { recursive: true });
  // Stands in for /Users/Shared/PC-Transfer: an existing, wider folder the
  // bridge must not tighten; the journal gets its own 0700 subfolder.
  mkdirSync(join(dir, "PC-Transfer"), { recursive: true });
  chmodSync(join(dir, "PC-Transfer"), 0o755);
  writeFileSync(join(dir, "PC-Transfer", "Conduit-Arbeitsstand.md"), "owned by someone else\n");
  journalDir = join(dir, "PC-Transfer", "Conduit-Journal");
  fakeLog = join(dir, "fake-runs.jsonl");
  const fake = join(dir, "fake-claude.mjs");
  writeFileSync(fake, `#!${process.execPath}
import { appendFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
if (process.argv[2] === "auth") { process.stdout.write(JSON.stringify({ loggedIn: true }) + "\\n"); process.exit(0); }
const LOG = ${JSON.stringify(fakeLog)};
const SECRET = ${JSON.stringify(SECRET)};
const PRIVATE_PATH = ${JSON.stringify(PRIVATE_PATH)};
const warm = process.argv.includes("--input-format");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const text = (t) => out({ type: "assistant", message: { content: [{ type: "text", text: t }] } });
const toolUse = (id, input) => out({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "Bash", input }] } });
const toolResult = (id, content) => out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content }] } });
const result = () => out({ type: "result", subtype: "success", is_error: false, usage: { input_tokens: 1, output_tokens: 1 } });
out({ type: "system", subtype: "init", session_id: "11111111-2222-3333-4444-555555555555" });
function run(raw) {
  const tag = (/TAG:([A-Za-z0-9]+)/.exec(raw) || [])[1] || null;
  const sc = (/SCENARIO:([a-z-]+)/.exec(raw) || [])[1] || "ok";
  const si = process.argv.indexOf("--append-system-prompt");
  appendFileSync(LOG, JSON.stringify({ pid: process.pid, warm, tag, sc, journal: process.env.CONDUIT_JOURNAL_FILE || null,
    checkpoint: process.env.CONDUIT_CHECKPOINT_FILE || null, sys: si >= 0 ? process.argv[si + 1] : null }) + "\\n");
  if (sc === "ok") { text("answer " + tag); result(); }
  else if (sc === "secret") {
    toolUse("t-secret", { command: "cat " + PRIVATE_PATH + "/.env # " + SECRET });
    toolResult("t-secret", "TOKEN=" + SECRET);
    text("Done with " + SECRET + " at " + PRIVATE_PATH);
    result();
  } else if (sc === "hang") {
    text("partial");
    toolUse("t-hang-" + tag, { command: "deploy --to " + PRIVATE_PATH });
    setInterval(() => {}, 1000);
    return "hang";
  } else if (sc === "tools-no-text") {
    toolUse("t-nt-" + tag, { command: "touch " + PRIVATE_PATH + "/file" });
    toolResult("t-nt-" + tag, "ok");
    result();
  } else if (sc === "partial-hang") {
    text("partial answer");
    setInterval(() => {}, 1000);
    return "hang";
  } else if (sc === "checkpoint") {
    toolUse("t-cp-" + tag, { command: "save checkpoint" });
    writeFileSync(process.env.CONDUIT_CHECKPOINT_FILE, JSON.stringify({
      summary: "Migration step 2 of 3 applied in staging",
      done: ["Schema reviewed", "Applied with token " + SECRET, "Mailed owner@example.com about it"],
      verified: [{ claim: "Unit tests green", evidence: "/tmp/conduit-unit.log" }, { claim: "Login works", evidence: "password=hunter2" }],
      next: "Run step 3 (backfill) after checking row counts",
      blocked: null,
      artifacts: ["/Users/test-user/Projects/demo/migration-002.sql", "IBAN DE89 3704 0044 0532 0130 00"],
      rawOutput: "TOKEN=" + SECRET,
    }));
    toolResult("t-cp-" + tag, "saved");
    text("partial");
    setInterval(() => {}, 1000);
    return "hang";
  } else if (sc === "tools-then-die") {
    toolUse("t-die-" + tag, { command: "rm -rf " + PRIVATE_PATH + "/tmp" });
    process.exit(1);
  }
}
if (warm) createInterface({ input: process.stdin }).on("line", (l) => { if (l.trim()) run(l); });
else { if (run(process.argv.slice(2).join(" ")) !== "hang") process.exitCode = 0; }
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

test("a crash mid-turn is reported as interrupted / not started, never run again, and journaled", { skip: !POSIX }, async () => {
  bridge = await startBridge({ warm: false });
  const j = await (await fetch(`http://127.0.0.1:${pairPort}/api/pair/new`, { method: "POST" })).json();
  const p = JSON.parse(Buffer.from(new URL(j.url).hash.slice(1), "base64url").toString());
  bridgeKey = Uint8Array.from(Buffer.from(p.k, "base64url"));
  device = await generateKeyPair();
  let c = await client({ pair: { codeId: Uint8Array.from(Buffer.from(p.i, "base64url")), psk: Uint8Array.from(Buffer.from(p.p, "base64url")) } });

  // A normal turn whose prompt, tool input, tool output and answer all carry a
  // secret and a private path.
  await c.prompt("P1", "secret", `please read ${PRIVATE_PATH}/.env and use ${SECRET}`);
  const t1 = await c.waitFor(isTerminal("a-P1"), "P1 terminal");
  assert.equal(t1.type, "done", JSON.stringify(t1));

  // A turn that runs a tool and then hangs, and one queued behind it.
  await c.prompt("P2", "hang");
  await c.waitFor((f) => f.type === "activity" && f.phase === "start" && f.assistantMessageId === "a-P2", "P2 tool start");
  await c.prompt("P3", "ok");
  const q = await c.waitFor((f) => f.type === "queued" && f.assistantMessageId === "a-P3", "P3 queued");
  assert.equal(q.queuePosition, 1);

  // HTTP mirror names the turn it describes.
  const inf = await c.call("GET", `/api/sessions/${SID}/inflight`);
  assert.equal(inf.body.assistantMessageId, "a-P2");
  assert.equal(inf.body.userMessageId, "u-P2");
  assert.equal(inf.body.turnStatus, "running");
  // History already shows the states while they are live.
  let hist = await c.call("GET", `/api/sessions/${SID}/messages`);
  assert.equal(assistantRow(hist.body.messages, "a-P1").turnStatus, "ok");
  assert.equal(assistantRow(hist.body.messages, "a-P2").turnStatus, "running");
  assert.equal(assistantRow(hist.body.messages, "a-P3").turnStatus, "queued");

  // Crash: no shutdown handler runs.
  await stopBridge("SIGKILL");
  killFakes();
  // A message the bridge recorded without ever writing an answer row (a failed
  // placeholder insert): a resend must not run it.
  {
    const db = new DatabaseSync(join(dir, "db", "db.sqlite"));
    db.prepare("INSERT INTO messages (id, session_id, role, content, ts) VALUES (?, ?, 'user', ?, ?)").run("u-P4", SID, "TAG:P4 SCENARIO:ok", Date.now());
    db.close();
  }

  bridge = await startBridge({ warm: false });
  assert.match(bridge.logs.text, /turns_closed_after_restart/);
  c = await client();
  await c.send({ type: "attach" });
  await c.waitFor((f) => f.type === "idle", "idle after restart");

  // Resend of the interrupted turn: replayed as interrupted, with the reason,
  // and NOT executed again.
  await c.prompt("P2", "hang");
  const r2 = await c.waitFor((f) => f.type === "resumed" && f.assistantMessageId === "a-P2", "P2 replay");
  assert.equal(r2.done, true);
  assert.equal(r2.turnStatus, "interrupted");
  assert.match(r2.error, /restarted while this answer was running/);
  assert.equal(r2.content, "partial");
  const e2 = await c.waitFor(isTerminal("a-P2"), "P2 terminal");
  assert.equal(e2.type, "error");
  assert.equal(e2.turnStatus, "interrupted");

  // Resend of the queued turn: never started, not executed now either.
  await c.prompt("P3", "ok");
  const r3 = await c.waitFor((f) => f.type === "resumed" && f.assistantMessageId === "a-P3", "P3 replay");
  assert.equal(r3.turnStatus, "not_started");
  assert.equal((await c.waitFor(isTerminal("a-P3"), "P3 terminal")).type, "error");

  // Resend of a message with no answer row: refused, not run.
  await c.prompt("P4", "ok");
  const e4 = await c.waitFor((f) => f.type === "error" && f.assistantMessageId === "a-P4", "P4 refusal");
  assert.equal(e4.turnStatus, "unknown");

  // The finished turn is still replayed as finished.
  await c.prompt("P1", "secret");
  const r1 = await c.waitFor((f) => f.type === "resumed" && f.assistantMessageId === "a-P1", "P1 replay");
  assert.equal(r1.turnStatus, "ok");
  assert.equal((await c.waitFor(isTerminal("a-P1"), "P1 terminal")).type, "done");

  await sleep(300);
  assert.equal(runsOf("P2").length, 1, "interrupted turn ran again");
  assert.equal(runsOf("P3").length, 0, "queued turn ran after the restart");
  assert.equal(runsOf("P4").length, 0, "message without answer row ran");
  assert.equal(runsOf("P1").length, 1, "finished turn ran again");

  hist = await c.call("GET", `/api/sessions/${SID}/messages`);
  const h2 = assistantRow(hist.body.messages, "a-P2");
  assert.equal(h2.turnStatus, "interrupted");
  assert.match(h2.turnError, /not repeated automatically/);
  assert.equal(h2.replyTo, "u-P2");
  assert.equal(assistantRow(hist.body.messages, "a-P3").turnStatus, "not_started");
  assert.equal(assistantRow(hist.body.messages, "a-P1").turnError, null);
  assert.equal(hist.body.messages.find((m) => m.id === "u-P2").turnStatus, null);
  await c.close();
});

test("a graceful shutdown records the running turn as interrupted", { skip: !POSIX }, async () => {
  const c = await client();
  await c.prompt("P5", "hang");
  await c.waitFor((f) => f.type === "activity" && f.phase === "start" && f.assistantMessageId === "a-P5", "P5 tool start");
  await stopBridge("SIGTERM");
  killFakes();
  const db = new DatabaseSync(join(dir, "db", "db.sqlite"));
  const row = db.prepare("SELECT turn_status, turn_error FROM messages WHERE id = 'a-P5'").get();
  db.close();
  assert.equal(row.turn_status, "interrupted");
  assert.match(readJournal(), /Bridge wurde beendet/);
});

test("warm turns that already ran tools are never retried through the one-shot path", { skip: !POSIX }, async () => {
  bridge = await startBridge({ warm: true });
  const c = await client();
  await c.prompt("P6", "tools-no-text");
  const t6 = await c.waitFor(isTerminal("a-P6"), "P6 terminal");
  assert.equal(t6.type, "error", JSON.stringify(t6));
  assert.match(t6.message, /ran tools but sent no text/);

  await c.prompt("P7", "tools-then-die");
  const t7 = await c.waitFor(isTerminal("a-P7"), "P7 terminal");
  assert.equal(t7.type, "error", JSON.stringify(t7));

  await c.prompt("P8", "ok");
  assert.equal((await c.waitFor(isTerminal("a-P8"), "P8 terminal")).type, "done");

  await sleep(500);
  assert.equal(runsOf("P6").length, 1, "P6 was run twice");
  assert.equal(runsOf("P7").length, 1, "P7 was run twice");
  const hist = await c.call("GET", `/api/sessions/${SID}/messages`);
  assert.equal(assistantRow(hist.body.messages, "a-P6").turnStatus, "error");
  assert.equal(assistantRow(hist.body.messages, "a-P7").turnStatus, "error");
  assert.equal(assistantRow(hist.body.messages, "a-P8").turnStatus, "ok");
  await c.close();
});

test("stop ends the running turn as an error and its queue as not started", { skip: !POSIX }, async () => {
  const c = await client();
  await c.prompt("P9", "hang");
  await c.waitFor((f) => f.type === "activity" && f.phase === "start" && f.assistantMessageId === "a-P9", "P9 tool start");
  await c.prompt("P10", "ok");
  await c.waitFor((f) => f.type === "queued" && f.assistantMessageId === "a-P10", "P10 queued");
  await c.send({ type: "stop" });
  const t9 = await c.waitFor(isTerminal("a-P9"), "P9 terminal");
  assert.equal(t9.type, "error");
  assert.match(t9.message, /Stopped/);
  const hist = await c.call("GET", `/api/sessions/${SID}/messages`);
  assert.equal(assistantRow(hist.body.messages, "a-P9").turnStatus, "error");
  assert.equal(assistantRow(hist.body.messages, "a-P10").turnStatus, "not_started");
  await sleep(300);
  assert.equal(runsOf("P10").length, 0, "queued turn ran after stop");
  await c.close();
  await stopBridge("SIGTERM");
  killFakes();
});

test("an agent ended from outside with partial text is interrupted, never ok", { skip: !POSIX }, async () => {
  bridge = await startBridge({ warm: false });
  const c = await client();
  await c.prompt("P11", "partial-hang");
  await c.waitFor((f) => f.type === "chunk" && f.assistantMessageId === "a-P11", "P11 partial text");
  const [run] = runsOf("P11");
  // Not the bridge's stop: a plain external SIGTERM to the agent process.
  process.kill(run.pid, "SIGTERM");
  const t = await c.waitFor(isTerminal("a-P11"), "P11 terminal");
  assert.equal(t.type, "error", JSON.stringify(t));
  assert.equal(t.turnStatus, "interrupted");
  assert.match(t.message, /ended from outside/);
  const hist = await c.call("GET", `/api/sessions/${SID}/messages`);
  const row = assistantRow(hist.body.messages, "a-P11");
  assert.equal(row.turnStatus, "interrupted");
  assert.equal(row.content, "partial answer");
  // The HTTP mirror and a WS attach say the same.
  const inf = await c.call("GET", `/api/sessions/${SID}/inflight`);
  assert.equal(inf.body.assistantMessageId, "a-P11");
  assert.equal(inf.body.turnStatus, "interrupted");
  assert.equal(inf.body.done, true);
  const before = c.frames.length;
  await c.send({ type: "attach" });
  const r = await c.waitFor((f) => f.type === "resumed" && c.frames.indexOf(f) >= before, "attach replay");
  assert.equal(r.turnStatus, "interrupted");
  assert.equal(r.done, true);
  await sleep(200);
  assert.equal(runsOf("P11").length, 1, "P11 was run again");
  await c.close();
});

test("a resend while the turn is still running is replayed, not run twice", { skip: !POSIX }, async () => {
  const c1 = await client();
  await c1.prompt("P12", "hang");
  await c1.waitFor((f) => f.type === "activity" && f.phase === "start" && f.assistantMessageId === "a-P12", "P12 tool start");
  await c1.close();
  // The app lost its connection and sends the same message again.
  const c2 = await client();
  await c2.prompt("P12", "hang");
  const r = await c2.waitFor((f) => f.type === "resumed" && f.assistantMessageId === "a-P12", "P12 replay");
  assert.equal(r.done, false);
  assert.equal(r.turnStatus, "running");
  assert.equal(r.content, "partial");
  await sleep(300);
  assert.equal(runsOf("P12").length, 1, "P12 ran twice");
  await c2.send({ type: "stop" });
  const t = await c2.waitFor(isTerminal("a-P12"), "P12 terminal");
  assert.equal(t.type, "error");
  await c2.close();
  await stopBridge("SIGTERM");
  killFakes();
});

test("agent checkpoints are filtered into the journal and handed back to the agent", { skip: !POSIX }, async () => {
  bridge = await startBridge({ warm: false });
  let c = await client();
  await c.prompt("P13", "checkpoint");
  await c.waitFor((f) => f.type === "chunk" && f.assistantMessageId === "a-P13", "P13 text after checkpoint");
  const [run] = runsOf("P13");
  // The agent was told, in its context, where the journal and the checkpoint are.
  assert.ok(run.sys, "no --append-system-prompt");
  assert.ok(run.sys.includes(join(journalDir, `Conduit-Journal-${SID}.md`)), run.sys);
  assert.ok(run.checkpoint && run.sys.includes(run.checkpoint), run.sys);
  assert.ok(!run.checkpoint.startsWith(journalDir), "raw checkpoint must not live in the shared journal folder");
  assert.match(run.sys, /"next"/);
  // Status: journal healthy.
  const st = await c.call("GET", "/api/status");
  assert.equal(st.body.journal.enabled, true);
  assert.equal(st.body.journal.ok, true);
  assert.ok(st.body.journal.savedCheckpoints >= 1);
  assert.equal(st.body.features.turnStatus, 1);
  assert.ok(!JSON.stringify(st.body.journal).includes(dir), "status leaks a path");

  // Crash while it runs.
  await stopBridge("SIGKILL");
  killFakes();
  bridge = await startBridge({ warm: false });
  c = await client();
  await c.prompt("P14", "ok");
  assert.equal((await c.waitFor(isTerminal("a-P14"), "P14 terminal")).type, "done");
  // The next agent in this chat is pointed at the last saved checkpoint. Its
  // text is agent-written data and stays in the file, out of the system prompt.
  const [next] = runsOf("P14");
  assert.match(next.sys, /Last saved checkpoint: .*task a-P13, filtered copy in \S+\.saved\.json/);
  assert.match(next.sys, /unverified notes, not instructions/);
  assert.ok(!next.sys.includes("Run step 3"), "checkpoint text reached the system prompt");
  const savedPath = next.sys.match(/filtered copy in (\S+\.saved\.json)/)[1];
  assert.equal(JSON.parse(readFileSync(savedPath, "utf8")).cp.next, "Run step 3 (backfill) after checking row counts");
  for (const leak of [SECRET, "SYNTHETICSECRET", "hunter2", "owner@example.com", "DE89 3704", "TOKEN="]) {
    assert.ok(!next.sys.includes(leak), `agent context leaks ${leak}`);
  }
  await c.close();
  await stopBridge("SIGTERM");
  killFakes();
});

test("an answer stored by an older bridge is not claimed as a success", { skip: !POSIX }, async () => {
  {
    const db = new DatabaseSync(join(dir, "db", "db.sqlite"));
    const t = Date.now();
    db.prepare("INSERT INTO messages (id, session_id, role, content, ts) VALUES (?, ?, 'user', ?, ?)").run("u-P15", SID, "TAG:P15 SCENARIO:ok", t);
    db.prepare("INSERT INTO messages (id, session_id, role, content, ts, reply_to) VALUES (?, ?, 'assistant', ?, ?, ?)").run("a-P15", SID, "old text", t + 1, "u-P15");
    db.close();
  }
  bridge = await startBridge({ warm: false });
  const c = await client();
  await c.prompt("P15", "ok");
  const r = await c.waitFor((f) => f.type === "resumed" && f.assistantMessageId === "a-P15", "P15 replay");
  assert.equal(r.turnStatus, "unknown");
  assert.equal(r.done, true);
  assert.equal(r.content, "old text");
  assert.match(r.error, /older bridge version/);
  const t = await c.waitFor(isTerminal("a-P15"), "P15 terminal");
  assert.equal(t.type, "error");
  const hist = await c.call("GET", `/api/sessions/${SID}/messages`);
  const row = assistantRow(hist.body.messages, "a-P15");
  assert.equal(row.turnStatus, "unknown");
  assert.match(row.turnError, /older bridge version/);
  await sleep(200);
  assert.equal(runsOf("P15").length, 0, "legacy row was run again");
  // The startup sweep left the NULL row alone: it is not "interrupted".
  const db = new DatabaseSync(join(dir, "db", "db.sqlite"));
  assert.equal(db.prepare("SELECT turn_status FROM messages WHERE id = 'a-P15'").get().turn_status, null);
  db.close();
  await c.close();
  await stopBridge("SIGTERM");
  killFakes();
});

test("the journal is owner-only, separate, complete and leaks nothing", { skip: !POSIX }, () => {
  const mode = (p) => statSync(p).mode & 0o777;
  assert.equal(mode(journalDir), 0o700);
  assert.equal(mode(join(dir, "PC-Transfer")), 0o755, "shared parent folder was changed");
  assert.equal(readFileSync(join(dir, "PC-Transfer", "Conduit-Arbeitsstand.md"), "utf8"), "owned by someone else\n");
  const files = readdirSync(journalDir);
  assert.deepEqual(files, [`Conduit-Journal-${SID}.md`]);
  assert.equal(mode(join(journalDir, files[0])), 0o600);

  const md = readJournal();
  // Content it must have.
  assert.match(md, /^# Conduit-Journal · Sitzung abcdabcd-1111-4222-8333-444455556666/);
  assert.match(md, /Prompt- und Antworttexte.*stehen bewusst NICHT hier/);
  assert.match(md, /Aufgabe `a-P1` · erfolgreich beendet/);
  assert.match(md, /Aufgabe `a-P2` · unterbrochen[\s\S]*?Bridge-Prozess war beendet[\s\S]*?Werkzeugschritte: 1 \(0 fertig, 0 fehlgeschlagen, 1 unterbrochen\) — Bash ×1[\s\S]*?Letzter bestätigter Schritt: keiner[\s\S]*?NICHT automatisch wiederholt/);
  assert.match(md, /Aufgabe `a-P3` · nicht ausgeführt[\s\S]*?Erneut senden ist gefahrlos/);
  assert.match(md, /Aufgabe `a-P1` · erfolgreich beendet[\s\S]*?Letzter bestätigter Schritt: Bash \(fertig/);
  assert.match(md, /Aufgabe `a-P6` · mit Fehler beendet[\s\S]*?führte Werkzeuge aus, schickte aber keinen Text/);
  assert.match(md, /Aufgabe `a-P9` · mit Fehler beendet[\s\S]*?vom Nutzer gestoppt[\s\S]*?Zuletzt begonnen: Bash \(interrupted/);
  assert.match(md, /Aufgabe `a-P10` · nicht ausgeführt/);
  assert.match(md, /Aufgabe `a-P3` eingereiht \(Platz 1\)/);
  assert.match(md, /Aufgabe `a-P11` · unterbrochen[\s\S]*?von außen beendet/);
  // The checkpoint: labelled as the agent's declaration, filtered, and named
  // in the block of the turn the crash cut off.
  assert.match(md, /Arbeitsstand · Aufgabe `a-P13` \(vom Agenten gemeldet, nicht unabhängig geprüft\)/);
  assert.match(md, /> Stand: Migration step 2 of 3 applied in staging/);
  assert.match(md, /> - Unit tests green \(Beleg: \/tmp\/conduit-unit\.log\)/);
  assert.match(md, /> Nächster Schritt: Run step 3 \(backfill\) after checking row counts/);
  assert.match(md, /> - ~\/Projects\/demo\/migration-002\.sql/);
  assert.match(md, /> Gefiltert: .*Zugangsdaten.*unbekannte\(s\) Feld\(er\) ignoriert/);
  assert.match(md, /Aufgabe `a-P13` · unterbrochen[\s\S]*?Letzter gespeicherter Arbeitsstand: \S+ \(aus dieser Aufgabe\) · nächster Schritt laut Agent: Run step 3/);
  assert.equal((md.match(/Arbeitsstand · Aufgabe `a-P13`/g) || []).length, 1, "checkpoint journaled twice");

  // Content it must never have.
  for (const leak of [SECRET, "SYNTHETICSECRET", "private/project", PRIVATE_PATH, dir, EMAIL, "TOKEN=", "please read", "deploy --to", "answer P", "partial", "SCENARIO", "TAG:",
    "hunter2", "DE89 3704", "/Users/test-user", "rawOutput", "old text"]) {
    assert.ok(!md.includes(leak), `journal leaks ${JSON.stringify(leak)}`);
  }

  // Agents were told where their session's journal is.
  const expected = join(journalDir, `Conduit-Journal-${SID}.md`);
  for (const r of fakeRuns()) {
    assert.equal(r.journal, expected, JSON.stringify(r));
    assert.ok(r.sys && r.sys.includes(expected), `agent context missing for ${r.tag}`);
  }
});
