// A warm turn whose prompt was taken but which shows no model activity within
// firstReplyMs is ended as a startup failure (25.11.2026: init printed, prompt
// dequeued, then 14 minutes without a request). Hook and status events do not
// count as activity; an api_retry notice does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const { createWarmPool, isModelActivity } = await import("../src/warm.mjs");
const skipWin = { skip: process.platform === "win32" };
const FAKE = fileURLToPath(new URL("./fixtures/fake-claude-silent.mjs", import.meta.url));

function runOne({ env = {}, firstReplyMs, startupMs = 5000, hookMaxMs }) {
  const dir = mkdtempSync(join(tmpdir(), "warm-first-reply-"));
  const logs = [];
  const noReply = [];
  const pool = createWarmPool({
    claudeBin: FAKE, model: "opus", defaultCwd: dir, env: { ...process.env, ...env },
    log: (lvl, msg, meta) => logs.push({ lvl, msg, meta }), isUuid: () => false,
    startupMs, stallMs: 60_000, firstReplyMs, onNoReply: (x) => noReply.push(x), ...(hookMaxMs ? { hookMaxMs } : {}),
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
  }).then((r) => ({ ...r, logs, noReply }))
    .finally(() => { pool.killAll(); setTimeout(() => rmSync(dir, { recursive: true, force: true }), 500).unref(); });
}

test("isModelActivity: model events count, hook and status events do not", () => {
  for (const ev of [{ type: "stream_event" }, { type: "assistant" }, { type: "user" }, { type: "result" }, { type: "system", subtype: "api_retry" }]) {
    assert.equal(isModelActivity(ev), true, JSON.stringify(ev));
  }
  for (const ev of [{ type: "system", subtype: "init" }, { type: "system", subtype: "hook_started" }, { type: "system", subtype: "hook_response" },
    { type: "system", subtype: "status" }, { type: "rate_limit_event" }, null, "x"]) {
    assert.equal(isModelActivity(ev), false, JSON.stringify(ev));
  }
});

test("warm: init and hook events but no model activity end the turn after firstReplyMs", skipWin, async () => {
  const r = await runOne({ firstReplyMs: 600, env: { FAKE_CLAUDE_INIT_THEN_DELAY_MS: "8000", FAKE_CLAUDE_PRE_EVENTS: "hooks" } });
  assert.match(r.error, /did not start to answer within 1s/);
  assert.equal(r.info?.startup, true);
  assert.equal(r.info?.stall, true, "terminal, so the caller does not retry one-shot");
  assert.equal(r.info?.noReply, true);
  assert.ok(r.ms >= 550 && r.ms < 5000, `ended after ${r.ms} ms`);
  assert.ok(r.logs.some((l) => l.msg === "warm_no_reply" && l.meta?.sawInit === true));
  assert.ok(r.logs.some((l) => l.msg === "warm_kill" && l.meta?.reason === "no_reply"));
  assert.equal(r.noReply.length, 1);
  assert.ok(!r.logs.some((l) => l.msg === "warm_startup_stall"), "the first-byte check is not what fired");
});

test("warm: an api_retry notice keeps a slow turn alive", skipWin, async () => {
  const r = await runOne({ firstReplyMs: 600, env: { FAKE_CLAUDE_INIT_THEN_DELAY_MS: "1500", FAKE_CLAUDE_PRE_EVENTS: "retry" } });
  assert.equal(r.error, undefined, r.error);
  assert.equal(r.done, true);
  assert.equal(r.chunks.join(""), "late but here");
  assert.equal(r.noReply.length, 0);
});

test("warm: an answer within firstReplyMs is untouched", skipWin, async () => {
  const r = await runOne({ firstReplyMs: 3000, env: { FAKE_CLAUDE_INIT_THEN_DELAY_MS: "300", FAKE_CLAUDE_PRE_EVENTS: "hooks" } });
  assert.equal(r.done, true, r.error);
  assert.ok(!r.logs.some((l) => l.msg === "warm_no_reply"));
});

test("warm: firstReplyMs 0 switches the check off", skipWin, async () => {
  const r = await runOne({ firstReplyMs: 0, env: { FAKE_CLAUDE_INIT_THEN_DELAY_MS: "1200", FAKE_CLAUDE_PRE_EVENTS: "hooks" } });
  assert.equal(r.done, true, r.error);
});

test("warm: a hook that runs longer than firstReplyMs pauses the clock", skipWin, async () => {
  const r = await runOne({ firstReplyMs: 600, env: { FAKE_CLAUDE_INIT_THEN_DELAY_MS: "1", FAKE_CLAUDE_PRE_EVENTS: "slowhook", FAKE_CLAUDE_HOOK_MS: "1500" } });
  assert.equal(r.done, true, r.error);
  assert.equal(r.chunks.join(""), "after the hook");
  assert.equal(r.noReply.length, 0);
});

test("warm: a hook that never answers still ends the turn after hookMaxMs", skipWin, async () => {
  const r = await runOne({ firstReplyMs: 300, hookMaxMs: 900, env: { FAKE_CLAUDE_INIT_THEN_DELAY_MS: "1", FAKE_CLAUDE_PRE_EVENTS: "slowhook", FAKE_CLAUDE_HOOK_MS: "60000" } });
  assert.match(r.error, /did not start to answer within 1s/);
  assert.ok(r.ms >= 850 && r.ms < 5000, `ended after ${r.ms} ms`);
  assert.ok(r.logs.some((l) => l.msg === "warm_no_reply" && l.meta?.hooksRunning === 1));
});

test("warm: a queued background result is not this prompt's activity", skipWin, async () => {
  const r = await runOne({ firstReplyMs: 600, env: { FAKE_CLAUDE_INIT_THEN_DELAY_MS: "8000", FAKE_CLAUDE_PRE_EVENTS: "queued" } });
  assert.match(r.error || "", /did not start to answer/);
  assert.equal(r.noReply.length, 1);
});
