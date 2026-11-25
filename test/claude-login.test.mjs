// Sign-in watch and phone sign-in (claude-login.mjs) against a fake CLI.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const { createClaudeLogin, parseAuthStatus, judge, storedLoginEnv, AUTH_ERROR_RE, EXPIRY_WARN_MS } = await import("../src/claude-login.mjs");
const skipWin = { skip: process.platform === "win32" };
const FAKE = fileURLToPath(new URL("./fixtures/fake-claude-auth.mjs", import.meta.url));
const NOW = Date.parse("2026-11-25T12:00:00Z");
// Polls instead of fixed sleeps: under a loaded test run a spawn can take long.
async function until(pred, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (pred()) return true; await new Promise((r) => setTimeout(r, 25)); }
  return false;
}

function make({ status, env = {}, notifyRes = "sent" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "claude-login-"));
  const kv = new Map();
  const alerts = [];
  const logs = [];
  const envFile = join(dir, "env.txt");
  const cl = createClaudeLogin({
    claudeBin: FAKE,
    env: { ...process.env, FAKE_AUTH_STATUS: JSON.stringify(status ?? { loggedIn: true }), FAKE_AUTH_ENV_FILE: envFile, FAKE_GOOD_CODE: "good-code#state1", ...env },
    log: (lvl, msg, meta) => logs.push({ lvl, msg, meta }),
    notify: async (a) => { alerts.push(a); return notifyRes; },
    kvGet: (k) => kv.get(k) ?? null, kvSet: (k, v) => kv.set(k, v), now: () => NOW,
  });
  return { cl, kv, alerts, logs, envFile, dir, done: () => { cl.stop(); rmSync(dir, { recursive: true, force: true }); } };
}

test("parseAuthStatus and judge", () => {
  assert.equal(parseAuthStatus("nope"), null);
  assert.equal(parseAuthStatus('{"x":1}'), null);
  const st = parseAuthStatus('{"loggedIn":true,"authMethod":"claude.ai","loginExpiresAt":"2026-12-25T06:59:10.647Z"}');
  assert.deepEqual(st, { loggedIn: true, method: "claude.ai", expiresAt: Date.parse("2026-12-25T06:59:10.647Z") });
  assert.equal(judge(st, NOW), "ok");
  assert.equal(judge({ ...st, expiresAt: NOW + EXPIRY_WARN_MS - 1 }, NOW), "expiring");
  assert.equal(judge({ ...st, expiresAt: NOW - 1 }, NOW), "expired");
  assert.equal(judge({ loggedIn: false }, NOW), "signed_out");
  assert.equal(judge({ loggedIn: true, expiresAt: null }, NOW), "ok", "a token without end date");
  assert.equal(judge(null, NOW), "unknown");
});

test("storedLoginEnv drops the variables that override the stored login and blocks the browser", () => {
  const e = storedLoginEnv({ CLAUDE_CODE_OAUTH_TOKEN: "t", ANTHROPIC_API_KEY: "k", ANTHROPIC_AUTH_TOKEN: "a", HOME: "/h" });
  assert.equal(e.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(e.ANTHROPIC_API_KEY, undefined);
  assert.equal(e.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(e.HOME, "/h");
  assert.equal(e.BROWSER, "/usr/bin/true");
});

test("AUTH_ERROR_RE matches the CLI's sign-in failures, not ordinary errors", () => {
  for (const s of ["Invalid API key · Please run /login", "OAuth token has expired. Please obtain a new token", "API Error: 401 {\"type\":\"authentication_error\"}", "Not logged in"]) {
    assert.ok(AUTH_ERROR_RE.test(s), s);
  }
  for (const s of ["Stopped. The answer is incomplete.", "API Error: 529 overloaded", "Claude did not start: no output 90s after launch.", "file 4012.txt not found"]) {
    assert.ok(!AUTH_ERROR_RE.test(s), s);
  }
});

test("check: an expired stored login alerts once, a repeat check stays quiet, a recovery clears it", skipWin, async () => {
  const t = make({ status: { loggedIn: true, authMethod: "claude.ai", loginExpiresAt: "2026-11-24T00:00:00Z" } });
  try {
    const st = await t.cl.check("test");
    assert.equal(st.state, "expired");
    assert.equal(t.alerts.length, 1);
    assert.match(t.alerts[0].title, /expired/);
    await t.cl.check("test");
    assert.equal(t.alerts.length, 1, "told once");
    assert.equal(readFileSync(t.envFile, "utf8").trim().split("\n")[0], "clean+nobrowser", "the bridge token never reaches the stored-login check");
  } finally { t.done(); }
  // A recovered login: the next problem is told again.
  const u = make({ status: { loggedIn: true, loginExpiresAt: "2026-12-25T00:00:00Z" } });
  try {
    u.kv.set("claude_login_alert", JSON.stringify({ key: "stored:expired", at: NOW - 1000 }));
    assert.equal((await u.cl.check("test")).state, "ok");
    assert.equal(u.kv.get("claude_login_alert"), "", "cleared");
    assert.equal(u.alerts.length, 0);
  } finally { u.done(); }
});

test("check: a login that expires within three days warns with the date", skipWin, async () => {
  const t = make({ status: { loggedIn: true, loginExpiresAt: "2026-11-27T06:59:00Z" } });
  try {
    assert.equal((await t.cl.check("test")).state, "expiring");
    assert.equal(t.alerts.length, 1);
    assert.match(t.alerts[0].title, /expires soon/);
    assert.match(t.alerts[0].text, /27 Nov/);
  } finally { t.done(); }
});

test("turn failures: no_reply with a good login points at the Mac, auth with an own token points at setup-token", skipWin, async () => {
  const t = make({ status: { loggedIn: true, loginExpiresAt: "2026-12-25T00:00:00Z" }, env: { CLAUDE_CODE_OAUTH_TOKEN: "" } });
  try {
    assert.equal(t.cl.noteTurnFailure({ kind: "stopped", error: "Stopped." }), false, "a stop is not a sign-in problem");
    assert.equal(t.cl.noteTurnFailure({ kind: "startup", error: "x" }), true);
    await until(() => t.alerts.length >= 1);
    assert.equal(t.alerts.length, 1);
    assert.match(t.alerts[0].title, /did not answer/);
    t.cl.noteTurnSuccess();
    assert.equal(t.cl.status().lastTurnProblem, null);
  } finally { t.done(); }
  const u = make({ status: { loggedIn: true, loginExpiresAt: "2026-12-25T00:00:00Z" }, env: { CLAUDE_CODE_OAUTH_TOKEN: "tok" } });
  try {
    u.cl.noteTurnFailure({ kind: "agent_error", error: "Invalid API key · Please run /login" });
    await until(() => u.alerts.length >= 1);
    assert.equal(u.alerts.length, 1);
    assert.match(u.alerts[0].text, /setup-token/);
    assert.equal(readFileSync(u.envFile, "utf8").trim().split("\n")[0], "clean+nobrowser");
  } finally { u.done(); }
});

test("phone sign-in: link, wrong code, then a new attempt with the right code", skipWin, async () => {
  const t = make({ status: { loggedIn: true, loginExpiresAt: "2026-12-25T00:00:00Z" } });
  try {
    const r = await t.cl.startLogin();
    assert.equal(r.ok, true);
    assert.match(r.url, /^https:\/\/claude\.com\/cai\/oauth\/authorize\?/);
    const again = await t.cl.startLogin();
    assert.equal(again.id, r.id, "one sign-in at a time");
    assert.deepEqual(await t.cl.submitCode("other", "good-code#state1"), { ok: false, error: "no_login" });
    assert.deepEqual(await t.cl.submitCode(r.id, "bad code with spaces"), { ok: false, error: "bad_code" });
    const wrong = await t.cl.submitCode(r.id, "wrong-code#state1");
    assert.equal(wrong.ok, false);
    assert.equal(wrong.error, "rejected");
    assert.match(wrong.message, /wasn't accepted/);
    assert.equal(t.cl.status().login, null, "a rejected code ends the attempt");
    const r2 = await t.cl.startLogin();
    assert.notEqual(r2.id, r.id);
    const ok = await t.cl.submitCode(r2.id, "good-code#state1");
    assert.equal(ok.ok, true);
    assert.equal(ok.status.state, "ok");
    assert.ok(t.logs.some((l) => l.msg === "claude_login_finished" && l.meta.ok === true));
    for (const l of t.logs) assert.ok(!JSON.stringify(l).includes("good-code"), "the code is never logged");
    assert.ok(readFileSync(t.envFile, "utf8").split("\n").filter(Boolean).every((x) => x === "clean+nobrowser"));
  } finally { t.done(); }
});

test("phone sign-in: cancel ends the waiting CLI", skipWin, async () => {
  const t = make();
  try {
    const r = await t.cl.startLogin();
    assert.equal(r.ok, true);
    assert.equal(t.cl.cancelLogin(), true);
    assert.equal(t.cl.status().login, null);
    assert.deepEqual(await t.cl.submitCode(r.id, "good-code#state1"), { ok: false, error: "no_login" });
  } finally { t.done(); }
});

import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";

function fakeSpawn({ stdinError = false } = {}) {
  const made = [];
  const fn = (bin, args) => {
    const c = new EventEmitter();
    c.stdout = new PassThrough(); c.stderr = new PassThrough();
    if (args?.[1] === "status") {
      c.stdin = null; c.kill = () => {};
      setImmediate(() => { c.stdout.end('{"loggedIn":true}\n'); setImmediate(() => c.emit("close", 0)); });
      return c;
    }
    c.stdin = new Writable({ write(b, e, cb) { if (stdinError) { const x = new Error("broken pipe"); x.code = "EPIPE"; cb(x); } else cb(); } });
    c.kill = () => { setImmediate(() => c.emit("close", null)); };
    made.push(c);
    return c;
  };
  return { fn, made };
}

test("phone sign-in: a link split over chunks is taken whole", async () => {
  const sp = fakeSpawn();
  const cl = createClaudeLogin({ claudeBin: "fake", spawnFn: sp.fn, now: () => NOW });
  const ready = cl.startLogin();
  const c = sp.made[0];
  c.stdout.write("visit: https://claude.com/cai/oauth/authorize?code=true&client_id=");
  await new Promise((r) => setImmediate(r));
  c.stdout.write("abc&state=complete\nPaste code here > ");
  const r = await ready;
  assert.equal(r.url, "https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=complete");
  cl.stop();
});

test("phone sign-in: an EPIPE on the code does not crash", async () => {
  const sp = fakeSpawn({ stdinError: true });
  const cl = createClaudeLogin({ claudeBin: "fake", spawnFn: sp.fn, now: () => NOW });
  const ready = cl.startLogin();
  sp.made[0].stdout.write("https://claude.com/cai/oauth/authorize?state=complete\n");
  const r = await ready;
  const done = cl.submitCode(r.id, "code#state1");
  await new Promise((res) => setTimeout(res, 50));
  sp.made[0].emit("close", 1);
  const out = await done;
  assert.equal(out.ok, false);
  cl.stop();
});

test("alerts: a failed send is tried again on the next check", skipWin, async () => {
  const t = make({ status: { loggedIn: false }, notifyRes: "failed" });
  try {
    await t.cl.check("a");
    await t.cl.check("b");
    assert.equal(t.alerts.length, 2, "not swallowed after a failed send");
    assert.ok(!t.kv.get("claude_login_alert"));
  } finally { t.done(); }
});

test("stop ends a waiting sign-in", async () => {
  const sp = fakeSpawn();
  let killed = 0;
  const cl = createClaudeLogin({ claudeBin: "fake", spawnFn: (...a) => { const c = sp.fn(...a); const k = c.kill; c.kill = () => { killed++; k(); }; return c; }, now: () => NOW });
  // (only the sign-in process is spawned here; no status check runs)
  const ready = cl.startLogin();
  sp.made[0].stdout.write("https://claude.com/cai/oauth/authorize?state=x1234567\n");
  await ready;
  cl.stop();
  assert.equal(killed, 1);
  assert.equal(cl.status().login, null);
});

test("alerts: a turn that never started is told even after the expiry warning went out", skipWin, async () => {
  const t = make({ status: { loggedIn: true, loginExpiresAt: "2026-11-27T06:59:00Z" } });
  try {
    await t.cl.check("a");
    assert.equal(t.alerts.length, 1);
    t.cl.noteTurnFailure({ kind: "startup", error: "x" });
    await until(() => t.alerts.length >= 2);
    assert.equal(t.alerts.length, 2);
    assert.match(t.alerts[1].title, /did not answer/);
  } finally { t.done(); }
});

test("check: a fresh check never answers with one that started earlier", async () => {
  let n = 0;
  const releases = [];
  const spawnFn = () => {
    const c = new EventEmitter();
    c.stdout = new PassThrough(); c.stderr = new PassThrough(); c.stdin = null; c.kill = () => {};
    const mine = ++n;
    releases.push(() => { c.stdout.end(JSON.stringify(mine === 1 ? { loggedIn: false } : { loggedIn: true }) + "\n"); setImmediate(() => c.emit("close", 0)); });
    return c;
  };
  const cl = createClaudeLogin({ claudeBin: "fake", spawnFn, now: () => NOW });
  const old = cl.check("old");
  const fresh = cl.check("after", { fresh: true });
  await new Promise((r) => setImmediate(r));
  releases[0]();
  assert.equal((await old).state, "signed_out");
  await new Promise((r) => setTimeout(r, 20));
  releases[1]();
  assert.equal((await fresh).state, "ok", "the fresh check ran after the old one");
  cl.stop();
});

test("alerts: a chat rejected for its sign-in is told even after the expiry warning went out", skipWin, async () => {
  const t = make({ status: { loggedIn: true, loginExpiresAt: "2026-11-27T06:59:00Z" }, env: { CLAUDE_CODE_OAUTH_TOKEN: "" } });
  try {
    await t.cl.check("a");
    t.cl.noteTurnFailure({ kind: "agent_error", error: "OAuth token has expired. Please run /login" });
    await until(() => t.alerts.length >= 2);
    assert.deepEqual(t.alerts.map((a) => a.title), ["Claude sign-in expires soon", "Claude rejected the sign-in"]);
  } finally { t.done(); }
});
