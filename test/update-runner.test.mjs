// When the bridge installs and restarts into a new release. Stub installer,
// stub restart, manual clock and timers: no network, no process exits, no real
// update. The runtime map is shaped like the one server.mjs keeps.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createUpdateRunner, countBusyWork } from "../src/update-runner.mjs";
import { readUpdatePolicy, inUpdateWindow, updateWindowKey } from "../src/update-policy.mjs";

const at = (hhmm, day = 24) => new Date(2026, 9, day, ...hhmm.split(":").map(Number));

/** A runner with stubs. `work` is the runtime map; `alexa.busy` the slot. */
function rig({ env = {}, results = [], supervised = true, clock = at("12:00") } = {}) {
  const runtime = new Map();
  const alexa = { busy: false };
  const calls = { check: [], restart: [] };
  const logs = [];
  const timers = [];
  const s = {
    runtime, alexa, calls, logs, timers, clock, supervised,
    // One stub install per check; `gate` lets a test act while it is running.
    gate: null,
  };
  const policy = readUpdatePolicy({ CONDUIT_SELFUPDATE: "1", ...env });
  s.runner = createUpdateRunner({
    policy,
    check: async (opts) => {
      calls.check.push(opts);
      if (s.gate) await s.gate;
      const r = results.shift();
      if (r instanceof Error) throw r;
      return r || { updated: false, from: "3.2.0", to: "3.2.0", reason: "up-to-date" };
    },
    busy: () => countBusyWork(runtime, { alexaBusy: alexa.busy }),
    isSupervised: () => s.supervised,
    restart: (to) => calls.restart.push(to),
    log: (level, event, data) => logs.push({ level, event, data }),
    inWindow: inUpdateWindow,
    windowKey: updateWindowKey,
    now: () => s.clock,
    retryMs: 30_000,
    setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clearTimer: (t) => { t.cleared = true; },
  });
  /** Fire every armed, not cleared timer once (one retry round). */
  s.fireTimers = () => {
    const due = timers.splice(0).filter((t) => !t.cleared);
    for (const t of due) t.fn();
    return due.length;
  };
  s.events = (name) => logs.filter((l) => l.event === name);
  return s;
}

const UPDATED = { updated: true, from: "3.2.0", to: "3.2.1", npm: false };
const AVAILABLE = { updated: false, from: "3.2.0", to: "3.2.1", available: true, reason: "update available, not installed (notify only)" };

/** A turn as runInflightTurn/spawnInflightWarm hold it. */
const turn = (fields = {}) => ({ assistantId: "a", content: "", done: false, ...fields });
const rt = (inflight = null, promptQueue = []) => ({ inflight, promptQueue });

test("a turn accepted while the release is installed defers the restart until idle, exactly once, no second install", async () => {
  const s = rig({ results: [UPDATED] });
  let release;
  s.gate = new Promise((r) => { release = r; });
  const ticking = s.runner.tick();
  // Idle when the check starts; a turn is accepted while it applies — still
  // starting, no process handle and no warm flag yet.
  assert.equal(s.calls.check.length, 1);
  s.runtime.set("s1", rt(turn({ proc: null })));
  release();
  await ticking;

  assert.equal(s.calls.restart.length, 0, "no restart while a turn runs");
  assert.equal(s.runner.status().pendingRestart, "3.2.1");
  assert.equal(s.runner.status().restartBlockedBy, "busy");
  assert.equal(s.events("selfupdate_restart_deferred").length, 1);

  // Ticks and retries while busy: neither a restart nor a new check.
  await s.runner.tick();
  assert.equal(s.fireTimers(), 1);
  await s.runner.tick();
  assert.equal(s.calls.restart.length, 0);
  assert.equal(s.calls.check.length, 1, "no second download/install while pending");
  assert.equal(s.events("selfupdate_restart_deferred").length, 1, "deferral logged once, not per retry");

  // The turn finishes; the finished row is kept for late reconnects.
  s.runtime.get("s1").inflight.done = true;
  s.fireTimers();
  assert.deepEqual(s.calls.restart, ["3.2.1"]);

  // Repeated ticks and timers: no second restart, no further check.
  await s.runner.tick();
  await s.runner.tick();
  s.fireTimers();
  assert.deepEqual(s.calls.restart, ["3.2.1"]);
  assert.equal(s.calls.check.length, 1);
  assert.equal(s.events("selfupdate_restart").length, 1);
  assert.deepEqual(s.events("selfupdate_restart")[0].data, { from: "3.2.0", to: "3.2.1" });
});

test("the pending target survives: a tick never re-checks and so never reads 'up-to-date' from disk", async () => {
  // The second result is what the origin would answer now that the new files
  // are on disk. It must never be asked for.
  const s = rig({ results: [UPDATED, { updated: false, from: "3.2.1", to: "3.2.1", reason: "up-to-date" }] });
  // Idle when the check starts; a prompt is queued while it applies.
  let release;
  s.gate = new Promise((r) => { release = r; });
  const t = s.runner.tick();
  s.runtime.set("s1", rt(null, [{ assistantId: "q" }]));
  release();
  await t;
  for (let i = 0; i < 5; i++) await s.runner.tick();
  assert.equal(s.calls.check.length, 1);
  assert.equal(s.runner.status().pendingRestart, "3.2.1");
  s.runtime.clear();
  await s.runner.tick();
  assert.deepEqual(s.calls.restart, ["3.2.1"]);
});

test("idle when the release lands: restart at once, as before", async () => {
  const s = rig({ results: [UPDATED] });
  await s.runner.tick();
  assert.deepEqual(s.calls.check, [{ apply: true, maxVersion: null }]);
  assert.deepEqual(s.calls.restart, ["3.2.1"]);
  assert.equal(s.timers.length, 0);
  assert.equal(s.events("selfupdate_done").length, 1);
});

test("busy before the check: nothing is checked, nothing pending", async () => {
  const s = rig({ results: [UPDATED] });
  s.alexa.busy = true;
  await s.runner.tick();
  assert.equal(s.calls.check.length, 0);
  assert.equal(s.runner.status().pendingRestart, null);
  s.alexa.busy = false;
  await s.runner.tick();
  assert.deepEqual(s.calls.restart, ["3.2.1"]);
});

test("busy work: every unfinished turn, queued prompts and the Alexa slot; finished grace rows are idle", () => {
  const m = new Map();
  assert.equal(countBusyWork(m), 0);
  // Accepted and starting: no process handle, no warm flag, not done.
  m.set("starting", rt(turn()));
  assert.equal(countBusyWork(m), 1);
  m.set("warm", rt(turn({ warm: true })));
  m.set("proc", rt(turn({ proc: {} })));
  assert.equal(countBusyWork(m), 3);
  // Finished turns kept for a late reconnect, with and without handles.
  m.clear();
  m.set("grace1", rt(turn({ done: true, proc: null })));
  m.set("grace2", rt(turn({ done: true, warm: true })));
  m.set("empty", rt(null));
  assert.equal(countBusyWork(m), 0);
  // Queued prompts behind a finished row, each one counts.
  m.set("queued", rt(turn({ done: true }), [{ assistantId: "q1" }, { assistantId: "q2" }]));
  assert.equal(countBusyWork(m), 2);
  assert.equal(countBusyWork(m, { alexaBusy: true }), 3);
  m.clear();
  assert.equal(countBusyWork(m, { alexaBusy: true }), 1);
});

test("queue and Alexa each hold a pending restart back", async () => {
  const s = rig({ results: [UPDATED] });
  s.gate = new Promise((r) => setImmediate(r));
  const t = s.runner.tick();
  s.runtime.set("s1", rt(turn({ done: true }), [{ assistantId: "q" }]));
  await t;
  assert.equal(s.calls.restart.length, 0);
  s.runtime.get("s1").promptQueue = [];
  s.alexa.busy = true;
  s.fireTimers();
  assert.equal(s.calls.restart.length, 0);
  s.alexa.busy = false;
  s.fireTimers();
  assert.deepEqual(s.calls.restart, ["3.2.1"]);
});

test("report mode never installs or restarts and keeps reporting", async () => {
  const s = rig({ env: { CONDUIT_SELFUPDATE: "notify" }, results: [AVAILABLE] });
  await s.runner.tick();
  assert.deepEqual(s.calls.check, [{ apply: false, maxVersion: null }]);
  assert.equal(s.calls.restart.length, 0);
  assert.equal(s.runner.status().available, "3.2.1");
  assert.equal(s.runner.status().pendingRestart, null);
  await s.runner.tick();
  assert.equal(s.calls.check.length, 2, "report mode keeps checking");
});

test("disabled: no check, no restart, no timer", async () => {
  const s = rig({ env: { CONDUIT_SELFUPDATE: "0" }, results: [UPDATED] });
  await s.runner.tick();
  assert.equal(s.calls.check.length, 0);
  assert.equal(s.calls.restart.length, 0);
  assert.equal(s.timers.length, 0);
});

test("unsupervised: the release stays applied, the restart is announced once and never performed", async () => {
  const s = rig({ results: [UPDATED], supervised: false });
  await s.runner.tick();
  await s.runner.tick();
  s.fireTimers();
  assert.equal(s.calls.restart.length, 0);
  assert.equal(s.calls.check.length, 1);
  assert.equal(s.timers.length, 0, "no retry timer for a restart that may not happen");
  const hint = s.events("selfupdate_needs_restart");
  assert.equal(hint.length, 1);
  assert.equal(hint[0].level, "warn");
  assert.equal(hint[0].data.to, "3.2.1");
  assert.equal(s.runner.status().pendingRestart, "3.2.1");
  assert.equal(s.runner.status().restartBlockedBy, "unsupervised");
  // Put under a supervisor later (same process): the owed restart happens.
  s.supervised = true;
  await s.runner.tick();
  assert.deepEqual(s.calls.restart, ["3.2.1"]);
});

test("window: a restart deferred past the window waits for the next one, although the window key is used up", async () => {
  const s = rig({ env: { CONDUIT_UPDATE_WINDOW: "02:00-03:00" }, results: [UPDATED], clock: at("02:10") });
  s.gate = new Promise((r) => setImmediate(r));
  const t = s.runner.tick();
  s.runtime.set("s1", rt(turn({ warm: true })));
  await t;
  assert.equal(s.calls.restart.length, 0);
  // Busy until after the window.
  s.clock = at("02:50");
  s.fireTimers();
  s.runtime.clear();
  s.clock = at("03:30");
  s.fireTimers();
  await s.runner.tick();
  s.clock = at("12:00");
  await s.runner.tick();
  assert.equal(s.calls.restart.length, 0, "never outside the window");
  assert.equal(s.runner.status().restartBlockedBy, "window");
  // Next night, same window: the restart, without a new check, although the
  // window key of the first night is still the last one recorded.
  s.clock = at("02:05", 25);
  await s.runner.tick();
  assert.deepEqual(s.calls.restart, ["3.2.1"]);
  assert.equal(s.calls.check.length, 1);
});

test("window: idle inside the window after the deferral restarts in the same window", async () => {
  const s = rig({ env: { CONDUIT_UPDATE_WINDOW: "02:00-03:00" }, results: [UPDATED], clock: at("02:10") });
  s.gate = new Promise((r) => setImmediate(r));
  const t = s.runner.tick();
  s.runtime.set("s1", rt(turn()));
  await t;
  s.runtime.clear();
  s.clock = at("02:20");
  s.fireTimers();
  assert.deepEqual(s.calls.restart, ["3.2.1"]);
});

test("window semantics without an update are unchanged: one check per window, outside nothing", async () => {
  const s = rig({ env: { CONDUIT_UPDATE_WINDOW: "02:00-03:00" }, clock: at("12:00") });
  await s.runner.tick();
  assert.equal(s.calls.check.length, 0);
  s.clock = at("02:10");
  await s.runner.tick();
  s.clock = at("02:40");
  await s.runner.tick();
  assert.equal(s.calls.check.length, 1, "window used up by an up-to-date answer");
  s.clock = at("02:10", 25);
  await s.runner.tick();
  assert.equal(s.calls.check.length, 2);
});

test("a failed check is not success: no window used, nothing pending, retried next tick", async () => {
  const s = rig({
    env: { CONDUIT_UPDATE_WINDOW: "02:00-03:00" }, clock: at("02:10"),
    results: [new Error("network down"), { updated: false, from: "3.2.0", to: "3.2.0", reason: "signature rejected: bad" }, UPDATED],
  });
  await s.runner.tick();
  assert.equal(s.events("selfupdate_error").length, 1);
  assert.equal(s.runner.status().pendingRestart, null);
  await s.runner.tick();
  assert.equal(s.runner.status().pendingRestart, null);
  assert.equal(s.calls.restart.length, 0);
  await s.runner.tick();
  assert.equal(s.calls.check.length, 3, "neither failure used up the window");
  assert.deepEqual(s.calls.restart, ["3.2.1"]);
});

test("a pin is passed through and a held release is reported, not installed", async () => {
  const held = { updated: false, from: "3.2.0", to: "3.3.0", available: true, held: true, reason: "held back: newer than the pinned version 3.2.0" };
  const s = rig({ env: { CONDUIT_UPDATE_PIN: "3.2.0" }, results: [held] });
  await s.runner.tick();
  assert.deepEqual(s.calls.check, [{ apply: true, maxVersion: "3.2.0" }]);
  assert.equal(s.runner.status().available, "3.3.0");
  assert.equal(s.runner.status().pendingRestart, null);
  assert.equal(s.calls.restart.length, 0);
  assert.equal(s.events("selfupdate_checked")[0].data.held, true);
});

test("a restart that throws is logged as failed and retried, never reported as done", async () => {
  const s = rig({ results: [UPDATED] });
  let fail = true;
  const restarts = [];
  // Swap the restart stub for one that fails the first time.
  const r2 = createUpdateRunner({
    policy: readUpdatePolicy({ CONDUIT_SELFUPDATE: "1" }),
    check: async () => UPDATED,
    busy: () => 0,
    isSupervised: () => true,
    restart: (to) => { restarts.push(to); if (fail) throw new Error("boom"); },
    log: (level, event, data) => s.logs.push({ level, event, data }),
    inWindow: inUpdateWindow, windowKey: updateWindowKey,
    setTimer: (fn, ms) => { const t = { fn, ms }; s.timers.push(t); return t; },
    clearTimer: (t) => { t.cleared = true; },
  });
  await r2.tick();
  assert.equal(s.events("selfupdate_restart_failed").length, 1);
  assert.equal(r2.status().pendingRestart, "3.2.1");
  fail = false;
  s.fireTimers();
  assert.deepEqual(restarts, ["3.2.1", "3.2.1"]);
  s.fireTimers();
  await r2.tick();
  assert.equal(restarts.length, 2);
});

test("a check already running is not started twice", async () => {
  const s = rig({ results: [UPDATED] });
  let release;
  s.gate = new Promise((r) => { release = r; });
  const a = s.runner.tick();
  const b = s.runner.tick();
  release();
  await Promise.all([a, b]);
  assert.equal(s.calls.check.length, 1);
  assert.deepEqual(s.calls.restart, ["3.2.1"]);
});
