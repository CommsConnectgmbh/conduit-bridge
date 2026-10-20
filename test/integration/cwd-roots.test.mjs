// A session's working directory is checked against FILE_SEARCH_ROOTS when it
// is set, and again at every turn: a symlink retargeted after the PATCH must
// not move the agent outside the roots. Real bridge, a stand-in claude that
// only records where it was started. No network.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, symlinkSync, unlinkSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import WebSocket from "ws";
import { generateKeyPair } from "../../src/e2e-noise.mjs";
import { connect, KIND, SUBPROTOCOL } from "../../src/e2e.mjs";
import { encodeMessage, MessageReader } from "../../src/e2e-messages.mjs";

const HOST = "cwd.tunnel.example";
let proc, dir, port, pairPort, logs = "";
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "conduit-cwd-"));
  for (const d of ["home", "root/real", "outside"]) mkdirSync(join(dir, d), { recursive: true });
  symlinkSync(join(dir, "root/real"), join(dir, "root/link"));
  const fake = join(dir, "fake-claude.mjs");
  writeFileSync(fake, `#!${process.execPath}
import { appendFileSync } from "node:fs";
if (process.argv[2] === "auth") { process.stdout.write(JSON.stringify({ loggedIn: true }) + "\\n"); process.exit(0); }
appendFileSync(${JSON.stringify(join(dir, "cwds.txt"))}, process.cwd() + "\\n");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
out({ type: "system", subtype: "init", session_id: "11111111-2222-3333-4444-555555555555" });
out({ type: "assistant", message: { content: [{ type: "text", text: "ok" }] } });
out({ type: "result", subtype: "success", is_error: false, usage: { input_tokens: 1, output_tokens: 1 } });
`);
  chmodSync(fake, 0o755);
  port = await freePort(); pairPort = await freePort();
  proc = spawn(process.execPath, [fileURLToPath(new URL("../../src/server.mjs", import.meta.url))], {
    env: {
      PATH: process.env.PATH, HOME: join(dir, "home"), BRIDGE_PORT: String(port), PAIR_PORT: String(pairPort),
      PAIR_PUBLIC_HOST: HOST, PAIR_OWNER_EMAIL: "owner@example.com", DB_DIR: join(dir, "db"), LOG_DIR: join(dir, "logs"),
      PASTE_DIR: join(dir, "paste"), CLAUDE_CWD: join(dir, "home"), FILE_SEARCH_ROOTS: join(dir, "root"),
      CLAUDE_BIN: fake, CONDUIT_SELFUPDATE: "0", CONDUIT_WARM: "0", BRIDGE_ALLOWED_HOSTS: `127.0.0.1,localhost,${HOST}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", (d) => { logs += d; });
  proc.stderr.on("data", (d) => { logs += d; });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("bridge did not start:\n" + logs);
});

after(async () => {
  if (proc && proc.exitCode === null && proc.signalCode === null) {
    const exited = new Promise((r) => proc.once("exit", r));
    proc.kill("SIGTERM");
    await exited;
  }
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

test("a cwd whose symlink is retargeted outside the roots is not used for the next turn", async () => {
  const j = await (await fetch(`http://127.0.0.1:${pairPort}/api/pair/new`, { method: "POST" })).json();
  const p = JSON.parse(Buffer.from(new URL(j.url).hash.slice(1), "base64url").toString());
  const bridgeKey = Uint8Array.from(Buffer.from(p.k, "base64url"));
  const device = await generateKeyPair();
  const open = () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/e2e`, [SUBPROTOCOL], { headers: { host: HOST } });
    ws.binaryType = "arraybuffer";
    return { ready: new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); }),
      transport: { send: (b) => ws.send(b), close: () => ws.close(), get bufferedAmount() { return ws.bufferedAmount; },
        onMessage: (cb) => ws.on("message", (d) => cb(new Uint8Array(d))), onClose: (cb) => ws.on("close", cb) } };
  };
  const o = open(); await o.ready;
  const { session } = await connect({ transport: o.transport, host: HOST, device, bridgeKey, hello: { v: 1, label: "t" },
    pair: { codeId: Uint8Array.from(Buffer.from(p.i, "base64url")), psk: Uint8Array.from(Buffer.from(p.p, "base64url")) } });
  const call = async (method, path, body) => {
    const ch = await session.open(KIND.RPC, { method, path, headers: body ? { "content-type": "application/json" } : {} });
    const parts = []; const done = new Promise((res) => { ch.on("data", (x) => parts.push(Uint8Array.from(x))); ch.on("end", res); });
    if (body) await ch.write(new TextEncoder().encode(JSON.stringify(body)));
    await ch.end(); await done;
    const all = Buffer.concat(parts); const n = all.readUInt32BE(0);
    return { head: JSON.parse(all.subarray(4, 4 + n)), body: JSON.parse(all.subarray(4 + n)) };
  };
  const sid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const chat = await session.open(KIND.CHAT, { sid });
  const waiters = [];
  const reader = new MessageReader({ maxBytes: 1e6, onMessage: (m) => { const msg = JSON.parse(Buffer.from(m)); for (const w of waiters.splice(0)) w(msg); } });
  chat.on("data", (x) => reader.push(x));
  const turn = async (n) => {
    const done = new Promise((res) => { const w = (msg) => (msg.type === "done" || msg.type === "error" ? res(msg) : waiters.push(w)); waiters.push(w); });
    await chat.write(encodeMessage(new TextEncoder().encode(JSON.stringify({ type: "prompt", content: `turn ${n}`, assistantMessageId: `a${n}` }))));
    const msg = await done;
    assert.equal(msg.type, "done", JSON.stringify(msg));
    return readFileSync(join(dir, "cwds.txt"), "utf8").trim().split("\n").at(-1);
  };
  await turn(1);
  const patched = await call("PATCH", `/api/sessions/${sid}`, { cwd: join(dir, "root/link") });
  assert.equal(patched.head.status, 200, JSON.stringify(patched.body));
  const inside = await turn(2);
  assert.ok(inside.endsWith("/root/real") || inside.endsWith("/root/link"), inside);
  // Retarget the link outside the roots after the PATCH.
  unlinkSync(join(dir, "root/link"));
  symlinkSync(join(dir, "outside"), join(dir, "root/link"));
  const after = await turn(3);
  assert.ok(!after.endsWith("/outside"), `agent ran in ${after}`);
  assert.ok(after.endsWith("/home"), after);
  assert.ok(existsSync(join(dir, "cwds.txt")));
  await session.goaway();
});
