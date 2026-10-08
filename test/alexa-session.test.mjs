// Alexa conversation lifecycle against test/fixtures/fake-claude.mjs in place of
// the CLI: real child processes, real state files, a simulated retention
// cleanup. createAlexaSession is what server.mjs runs behind the signed /alexa
// endpoint; a "restart" is a second session object on the same directories.
//
//   node --test test/alexa-session.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAlexaSession, ALEXA_LEGACY_UUID as LEGACY_UUID } from "../src/alexa-session.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE = join(HERE, "fixtures", "fake-claude.mjs");
const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Fresh dirs per test. */
function env() {
  const root = mkdtempSync(join(tmpdir(), "alexa-test-"));
  const dirs = { root, log: join(root, "log"), cwd: join(root, "cwd"), fake: join(root, "fake") };
  for (const [k, d] of Object.entries(dirs)) if (k !== "root") mkdirSync(d);
  return dirs;
}

/** A session as server.mjs builds it; the fake CLI runs through node on every OS. */
function startBridge(dirs) {
  const lines = [];
  const session = createAlexaSession({
    claudeBin: FAKE, cwd: dirs.cwd, stateDir: dirs.log, model: "haiku",
    log: (level, event, data) => lines.push(`${level} ${event} ${JSON.stringify(data)}`),
    spawnClaude: (args, opts) => spawn(process.execPath, [FAKE, ...args], { ...opts, env: { ...opts.env, FAKE_CLAUDE_HOME: dirs.fake } }),
  });
  return { session, log: () => lines.join("\n"), async stop() {} };
}

async function ask(bridge, query) {
  const r = await bridge.session.ask(query);
  return { status: r.code, body: r.body };
}

const calls = (dirs) => existsSync(join(dirs.fake, "calls.jsonl"))
  ? readFileSync(join(dirs.fake, "calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
  : [];
const state = (dirs) => JSON.parse(readFileSync(join(dirs.log, ".alexa-session.json"), "utf8"));
const control = (dirs, c) => writeFileSync(join(dirs.fake, "control.json"), JSON.stringify(c));

async function withBridge(fn, setup) {
  const dirs = env();
  if (setup) await setup(dirs);
  const bridge = await startBridge(dirs);
  try { await fn(bridge, dirs); }
  finally { await bridge.stop(); rmSync(dirs.root, { recursive: true, force: true }); }
}

test("live failure: legacy flag, transcript gone -> same request re-inits, then a real multi-turn conversation", () =>
  withBridge(async (bridge, dirs) => {
    const a = await ask(bridge, "was ist zwei plus zwei");
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal(a.body.text, "Turn 1: was ist zwei plus zwei");

    let c = calls(dirs);
    assert.equal(c.length, 2, "exactly one failed resume plus one init");
    assert.equal(c[0].resume, LEGACY_UUID);
    assert.ok(V4.test(c[1].sessionId), `fresh id is RFC 4122 v4: ${c[1].sessionId}`);
    assert.equal(c[1].cwd, c[0].cwd);
    assert.deepEqual(state(dirs).sessionId, c[1].sessionId);
    assert.ok(!existsSync(join(dirs.log, ".alexa-session-inited")), "legacy flag removed");
    assert.match(bridge.log(), /alexa_session_missing/);

    const b = await ask(bridge, "und mal drei");
    assert.equal(b.status, 200);
    assert.equal(b.body.text, "Turn 2: und mal drei | vorher: was ist zwei plus zwei");
    const d = await ask(bridge, "danke");
    assert.equal(d.body.text, "Turn 3: danke | vorher: was ist zwei plus zwei / und mal drei");
    c = calls(dirs);
    assert.equal(c.length, 4);
    assert.deepEqual(c.slice(2).map((x) => x.resume), [c[1].sessionId, c[1].sessionId]);
  }, (dirs) => {
    writeFileSync(join(dirs.log, ".alexa-session-inited"), "2026-06-19T09:33:12.583Z");
  }));

test("fresh install: init once, resume afterwards, conversation survives a bridge restart", async () => {
  const dirs = env();
  let bridge = await startBridge(dirs);
  try {
    assert.equal((await ask(bridge, "erste frage")).body.text, "Turn 1: erste frage");
    const id = state(dirs).sessionId;
    assert.ok(V4.test(id));
    assert.equal(state(dirs).cwd, dirs.cwd);
    await bridge.stop();
    bridge = await startBridge(dirs);
    assert.equal((await ask(bridge, "zweite frage")).body.text, "Turn 2: zweite frage | vorher: erste frage");
    assert.deepEqual(calls(dirs).map((x) => x.resume || "init"), ["init", id]);
  } finally { await bridge.stop(); rmSync(dirs.root, { recursive: true, force: true }); }
});

for (const [name, stderr] of [
  ["other CLI error (overload)", "API Error: 529 Overloaded\n"],
  ["not-found for a different id", "No conversation found with session ID: 11111111-2222-4333-8444-555555555555\n"],
  ["not-found wording plus extra output", "Warning: something\nNo conversation found with session ID: %ID%\n"],
  ["not-found wording with extra whitespace", "\nNo conversation found with session ID: %ID% \n"],
]) {
  test(`no retry and no reset on ${name}`, () =>
    withBridge(async (bridge, dirs) => {
      assert.equal((await ask(bridge, "eins")).status, 200);
      const id = state(dirs).sessionId;
      control(dirs, { fail: { code: 1, stderr: stderr.replace("%ID%", id) } });
      const r = await ask(bridge, "zwei");
      assert.equal(r.status, 502);
      assert.equal(calls(dirs).length, 2, "the failed turn ran exactly once");
      assert.equal(state(dirs).sessionId, id, "session kept");
      // Slot released, same conversation continues.
      const n = await ask(bridge, "drei");
      assert.equal(n.status, 200);
      assert.equal(n.body.text, "Turn 2: drei | vorher: eins");
      assert.equal(calls(dirs).at(-1).resume, id);
    }));
}

test("failed init is not persisted and the next request starts with a new id", () =>
  withBridge(async (bridge, dirs) => {
    control(dirs, { fail: { code: 1, stderr: "API Error: 500\n" } });
    assert.equal((await ask(bridge, "eins")).status, 502);
    assert.ok(!existsSync(join(dirs.log, ".alexa-session.json")));
    assert.equal((await ask(bridge, "zwei")).body.text, "Turn 1: zwei");
    const c = calls(dirs);
    assert.equal(c.length, 2);
    assert.ok(c[0].sessionId && c[1].sessionId && c[0].sessionId !== c[1].sessionId);
  }));

test("state from another cwd is not resumed", () =>
  withBridge(async (bridge, dirs) => {
    const r = await ask(bridge, "hallo");
    assert.equal(r.body.text, "Turn 1: hallo");
    const c = calls(dirs);
    assert.equal(c.length, 1);
    assert.ok(c[0].sessionId && c[0].sessionId !== "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
    assert.match(bridge.log(), /alexa_session_discarded.*cwd_changed/);
  }, (dirs) => {
    writeFileSync(join(dirs.log, ".alexa-session.json"),
      JSON.stringify({ sessionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", cwd: "/somewhere/else" }));
  }));

test("one turn at a time: concurrent request gets 429, slot is free afterwards", () =>
  withBridge(async (bridge, dirs) => {
    assert.equal((await ask(bridge, "eins")).status, 200);
    control(dirs, { delayMs: 1500 });
    const [x, y] = await Promise.all([ask(bridge, "zwei"), new Promise((r) => setTimeout(r, 300)).then(() => ask(bridge, "parallel"))]);
    assert.equal(x.status, 200);
    assert.equal(y.status, 429);
    control(dirs, {});
    const z = await ask(bridge, "drei");
    assert.equal(z.body.text, "Turn 3: drei | vorher: eins / zwei");
    assert.equal(calls(dirs).length, 3, "the rejected request spawned nothing");
  }));

test("transcript deleted mid-conversation: re-init in the same request, exactly once", () =>
  withBridge(async (bridge, dirs) => {
    assert.equal((await ask(bridge, "eins")).status, 200);
    const id = state(dirs).sessionId;
    rmSync(join(dirs.fake, "projects"), { recursive: true, force: true }); // retention cleanup
    const r = await ask(bridge, "zwei");
    assert.equal(r.status, 200);
    assert.equal(r.body.text, "Turn 1: zwei");
    const c = calls(dirs);
    assert.equal(c.length, 3);
    assert.equal(c[1].resume, id);
    assert.ok(c[2].sessionId && c[2].sessionId !== id);
    assert.equal(state(dirs).sessionId, c[2].sessionId);
  }));

test("re-init after a miss fails: one attempt, 502, nothing persisted, next request inits again", () =>
  withBridge(async (bridge, dirs) => {
    assert.equal((await ask(bridge, "eins")).status, 200);
    rmSync(join(dirs.fake, "projects"), { recursive: true, force: true });
    control(dirs, { fail: { on: "init", code: 1, stderr: "API Error: 529 Overloaded\n" } });
    const r = await ask(bridge, "zwei");
    assert.equal(r.status, 502);
    assert.equal(calls(dirs).length, 3, "resume miss + one init, no further retry");
    assert.ok(!existsSync(join(dirs.log, ".alexa-session.json")), "stale session dropped, failed one not stored");
    const n = await ask(bridge, "drei");
    assert.equal(n.body.text, "Turn 1: drei");
    const c = calls(dirs);
    assert.equal(c.length, 4);
    assert.ok(c[3].sessionId && c[3].sessionId !== c[2].sessionId, "fresh id, no 'already in use'");
  }));
