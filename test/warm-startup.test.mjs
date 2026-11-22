// A warm claude that never prints a byte is ended after startupMs with a
// terminal startup error; one that printed its init is left to the stall
// watchdog, however long its first answer takes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const { createWarmPool } = await import("../src/warm.mjs");
const skipWin = { skip: process.platform === "win32" };
const FAKE = fileURLToPath(new URL("./fixtures/fake-claude-silent.mjs", import.meta.url));

function runOne({ env = {}, startupMs }) {
  const dir = mkdtempSync(join(tmpdir(), "warm-startup-"));
  const logs = [];
  const pool = createWarmPool({
    claudeBin: FAKE, model: "opus", defaultCwd: dir, env: { ...process.env, ...env },
    log: (lvl, msg, meta) => logs.push({ lvl, msg, meta }), isUuid: () => false,
    startupMs, stallMs: 60_000,
  });
  const started = Date.now();
  return new Promise((resolve) => {
    const chunks = [];
    const ok = pool.runTurn({
      sid: "s1", sess: null, cwd: dir, prompt: "hi",
      handlers: {
        onChunk: (c) => chunks.push(c),
        onDone: () => resolve({ done: true, chunks, ms: Date.now() - started }),
        onError: (msg, info) => resolve({ error: msg, info, ms: Date.now() - started }),
      },
    });
    if (!ok) resolve({ error: "not started" });
  }).then((r) => ({ ...r, logs, pool, dir }))
    .finally(() => { pool.killAll(); setTimeout(() => rmSync(dir, { recursive: true, force: true }), 500).unref(); });
}

test("warm: a claude without any output is ended as a startup failure", skipWin, async () => {
  const r = await runOne({ startupMs: 400 });
  assert.match(r.error, /did not start: no output/);
  assert.equal(r.info?.startup, true);
  assert.equal(r.info?.stall, true, "terminal, so the caller does not retry one-shot");
  assert.ok(r.ms >= 350 && r.ms < 5000, `ended after ${r.ms} ms`);
  assert.ok(r.logs.some((l) => l.msg === "warm_startup_stall"));
  assert.ok(r.logs.some((l) => l.msg === "warm_kill" && l.meta?.reason === "startup_stall"));
});

test("warm: a claude that printed its init may answer later than startupMs", skipWin, async () => {
  const r = await runOne({ startupMs: 2000, env: { FAKE_CLAUDE_INIT_THEN_DELAY_MS: "4000" } });
  assert.equal(r.error, undefined, r.error);
  assert.equal(r.done, true);
  assert.equal(r.chunks.join(""), "late but here");
  assert.ok(!r.logs.some((l) => l.msg === "warm_startup_stall"));
});

test("warm: startupMs 0 switches the check off", skipWin, async () => {
  const dir = mkdtempSync(join(tmpdir(), "warm-startup-"));
  const pool = createWarmPool({
    claudeBin: FAKE, model: "opus", defaultCwd: dir, env: process.env,
    log: () => {}, isUuid: () => false, startupMs: 0, stallMs: 60_000,
  });
  let ended = false;
  pool.runTurn({ sid: "s1", sess: null, cwd: dir, prompt: "hi",
    handlers: { onDone: () => { ended = true; }, onError: () => { ended = true; } } });
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(ended, false);
  pool.killAll();
  await new Promise((r) => setTimeout(r, 300));
  rmSync(dir, { recursive: true, force: true });
});
