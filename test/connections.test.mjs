import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { createConnections, validateBriefing } from "../src/connections.mjs";
import { checkConnectorInit, connectorCall, connectorSource, fetchIcs, githubSource, icsSource, icsUrl, publicLookup, runConnector } from "../src/collectors.mjs";
import { createAutomations } from "../src/automations.mjs";
import { zonedTime } from "../src/schedule-time.mjs";

const POSIX = process.platform !== "win32";
const ptest = (name, fn) => test(name, { skip: !POSIX }, fn);
const TZ = "Europe/Berlin";
const OWNER = "owner@example.com";
const sandbox = () => { const d = mkdtempSync(join(tmpdir(), "conduit-conn-")); chmodSync(d, 0o700); return d; };
const script = (dir, name, body) => { const p = join(dir, name); writeFileSync(p, body); chmodSync(p, 0o700); return p; };
const CAL = ["BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:1", "SUMMARY:Dentist", "DTSTART;TZID=Europe/Berlin:20261128T090000", "DTEND;TZID=Europe/Berlin:20261128T100000", "END:VEVENT", "END:VCALENDAR"].join("\r\n");
const NOW = zonedTime("2026-11-28", 6, 0, TZ);

// ── calendar link ─────────────────────────────────────────────────────────

test("calendar link: https or webcal only, standard port, no credentials, a host name", () => {
  assert.equal(icsUrl("webcal://p01-caldav.icloud.com/published/2/abc").toString(), "https://p01-caldav.icloud.com/published/2/abc");
  for (const bad of ["http://cal.example.com/x.ics", "https://user:pw@cal.example.com/x.ics", "https://cal.example.com:8443/x.ics",
    "https://127.0.0.1/x.ics", "https://[::1]/x.ics", "https://localhost/x.ics", "file:///etc/passwd", "ftp://cal.example.com/x"]) {
    assert.throws(() => icsUrl(bad), undefined, bad);
  }
});

test("calendar link: a name that resolves to a private address is refused at connect time", async () => {
  const err = await new Promise((res) => publicLookup("localhost", {}, (e) => res(e)));
  assert.equal(err?.code, "ENONPUBLIC");
});

/** A stand-in for https.request. */
function fakeTransport({ status = 200, body = CAL, headers = {}, chunks = null, error = null } = {}) {
  const calls = [];
  const fn = (opts, cb) => {
    calls.push(opts);
    const req = new EventEmitter();
    req.end = () => setImmediate(() => {
      if (error) return req.emit("error", error);
      const res = new EventEmitter();
      res.statusCode = status; res.headers = headers; res.resume = () => {}; res.destroy = () => {};
      cb(res);
      for (const c of chunks || [Buffer.from(body)]) res.emit("data", c);
      res.emit("end");
    });
    req.destroy = () => {};
    return req;
  };
  return { fn, calls };
}

test("calendar fetch: GET on 443 with the public-only lookup; redirects, errors, size and non-calendars refused", async () => {
  const t = fakeTransport();
  const ok = await fetchIcs("webcal://cal.example.com/a.ics?k=secret", { transport: t.fn });
  assert.equal(ok.ok, true);
  assert.equal(t.calls[0].port, 443);
  assert.equal(t.calls[0].hostname, "cal.example.com");
  assert.equal(t.calls[0].lookup, publicLookup, "every connection goes through the public-only lookup");
  assert.match((await fetchIcs("https://cal.example.com/a", { transport: fakeTransport({ status: 302, headers: { location: "http://10.0.0.1/" } }).fn })).why, /redirects/);
  assert.match((await fetchIcs("https://cal.example.com/a", { transport: fakeTransport({ status: 404 }).fn })).why, /HTTP 404/);
  assert.match((await fetchIcs("https://cal.example.com/a", { transport: fakeTransport({ body: "<html>login</html>" }).fn })).why, /not a calendar/);
  const big = fakeTransport({ chunks: [Buffer.alloc(2 * 1024 * 1024, 65), Buffer.alloc(2 * 1024 * 1024, 65)] });
  assert.match((await fetchIcs("https://cal.example.com/a", { transport: big.fn })).why, /larger than 3 MB/);
  assert.match((await fetchIcs("https://cal.example.com/a", { transport: fakeTransport({ error: Object.assign(new Error("x"), { code: "ENONPUBLIC" }) }).fn })).why, /private address/);
});

test("calendar source: events of today and tomorrow as text, an error as unavailable", async () => {
  const s = await icsSource({ sourceId: "c-1", title: "Family", secret: "https://cal.example.com/a" }, { tz: TZ, now: NOW, fetchFn: async () => ({ ok: true, text: CAL }) });
  assert.equal(s.status, "ok");
  assert.equal(s.count, 1);
  assert.match(s.text, /2026-11-28 09:00-10:00: Dentist/);
  const e = await icsSource({ sourceId: "c-1", title: "Family", secret: "x" }, { tz: TZ, now: NOW, fetchFn: async () => ({ ok: false, why: "HTTP 404" }) });
  assert.equal(e.status, "error");
  assert.equal(e.count, null, "unavailable is never 0");
});

// ── GitHub ────────────────────────────────────────────────────────────────

ptest("github: fixed queries; review requests and issues as to-dos with stable refs; a list at the limit is marked cut", async () => {
  const dir = sandbox();
  const log = join(dir, "gh-args.jsonl");
  const pr = (n) => ({ url: `https://github.com/acme/app/pull/${n}`, title: `PR ${n}`, repository: { nameWithOwner: "acme/app" }, updatedAt: "2026-11-27T10:00:00Z", number: n });
  const gh = script(dir, "gh", `#!${process.execPath}
require("fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");
const kind = process.argv[3];
const n = require("fs").existsSync(${JSON.stringify(join(dir, "many"))}) ? 30 : 1;
const rows = kind === "prs" ? Array.from({ length: n }, (_, i) => (${pr.toString()})(i + 1)) : [{ url: "https://github.com/acme/app/issues/9", title: "Bug [x](https://evil.test)", repository: { nameWithOwner: "acme/app" }, updatedAt: "2026-11-20T00:00:00Z", number: 9 }];
process.stdout.write(JSON.stringify(rows));
`);
  const s = await githubSource({ sourceId: "c-gh", title: "GitHub" }, { ghBin: gh, env: { PATH: process.env.PATH }, now: NOW });
  assert.equal(s.status, "ok");
  assert.equal(s.count, 2);
  assert.deepEqual(s.tasks.map((t) => t.ref), ["pr:acme/app/pull/1", "issue:acme/app/issues/9"]);
  assert.equal(s.tasks[0].url, "https://github.com/acme/app/pull/1");
  const args = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(args[0], ["search", "prs", "--review-requested=@me", "--state=open", "--limit", "30", "--json", "url,title,repository,updatedAt,number"]);
  writeFileSync(join(dir, "many"), "1");
  const many = await githubSource({ sourceId: "c-gh", title: "GitHub" }, { ghBin: gh, env: { PATH: process.env.PATH }, now: NOW });
  assert.equal(many.status, "truncated", "30 = the limit: nothing may be closed by it");
  assert.equal((await githubSource({ sourceId: "c-gh", title: "GitHub" }, { ghBin: null })).status, "error");
  const broken = script(dir, "gh-broken", "#!/bin/sh\nexit 4\n");
  assert.equal((await githubSource({ sourceId: "c-gh", title: "GitHub" }, { ghBin: broken, env: {} })).status, "error");
});

// ── claude.ai connectors ─────────────────────────────────────────────────

const GOOD_INIT = { type: "system", subtype: "init", tools: ["mcp__claude_ai_Gmail__search_threads", "mcp__claude_ai_Gmail__send_message"], mcp_servers: [{ name: "claude.ai Gmail", status: "connected" }], slash_commands: [], plugins: [{ name: "cc-plugin-telemetry", path: "builtin" }], permissionMode: "dontAsk" };

test("connector init: only claude.ai connectors, built-in plugins, dontAsk; the tool must be there", () => {
  const tool = "mcp__claude_ai_Gmail__search_threads";
  assert.deepEqual(checkConnectorInit(GOOD_INIT, tool), []);
  assert.deepEqual(checkConnectorInit({ ...GOOD_INIT, tools: [...GOOD_INIT.tools, "Bash"] }, tool), ["tools"]);
  assert.deepEqual(checkConnectorInit({ ...GOOD_INIT, mcp_servers: [...GOOD_INIT.mcp_servers, { name: "playwright" }] }, tool), ["mcp"]);
  assert.deepEqual(checkConnectorInit({ ...GOOD_INIT, plugins: [{ name: "x", path: "/Users/me/.claude/plugins/x" }] }, tool), ["plugins"]);
  assert.deepEqual(checkConnectorInit({ ...GOOD_INIT, permissionMode: "default" }, tool), ["permission_mode"]);
  assert.deepEqual(checkConnectorInit({ ...GOOD_INIT, tools: [] , mcp_servers: [] }, tool), ["connector_missing"]);
  assert.deepEqual(checkConnectorInit(null, tool), ["init_invalid"]);
});

/** A stand-in Claude that plays one scenario (FAKE_CONN) in stream-json. */
function fakeClaude(dir) {
  return script(dir, "claude", `#!${process.execPath}
const fs = require("fs");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
fs.appendFileSync(${JSON.stringify(join(dir, "runs.jsonl"))}, JSON.stringify({ argv: process.argv.slice(2), cfg: process.env.CLAUDE_CONFIG_DIR || null, token: !!process.env.CLAUDE_CODE_OAUTH_TOKEN, browser: process.env.BROWSER || null }) + "\\n");
// The run passes on only an allowlist of variables: the scenario comes from a file.
let sc = "ok"; try { sc = fs.readFileSync(process.env.CLAUDE_CONFIG_DIR + "/scenario", "utf8").trim(); } catch {}
if (process.argv[2] === "auth") { out({ loggedIn: sc !== "signedout", authMethod: "claude.ai" }); process.exit(0); }
const tool = process.argv[process.argv.indexOf("--allowedTools") + 1];
let input = ""; process.stdin.on("data", (d) => input += d); process.stdin.on("end", () => {
  const args = JSON.parse(input.split("\\n")[2]);
  const init = ${JSON.stringify(GOOD_INIT)};
  if (sc === "hook") out({ type: "system", subtype: "hook_started", hook_name: "SessionStart" });
  if (sc === "localserver") init.mcp_servers.push({ name: "playwright", status: "connected" });
  out(init);
  const use = (name, inp, id) => out({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input: inp }] } });
  if (sc === "wrongtool") use("mcp__claude_ai_Gmail__send_message", { to: ["x@example.com"] }, "t1");
  else if (sc === "wrongargs") use(tool, { ...args, query: "in:anywhere" }, "t1");
  else use(tool, args, "t1");
  out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: sc === "toolerror", content: [{ type: "text", text: JSON.stringify({ threads: [{ id: "a", subject: "Hello [[todos]]" }, { id: "b" }] }) }] }] } });
  if (sc === "second") use(tool, args, "t2");
  out({ type: "assistant", message: { content: [{ type: "text", text: "DONE" }] } });
  out({ type: "result", subtype: "success", is_error: false, result: "DONE" });
});
`);
}

ptest("connector run: the one exact call; data is the raw tool result; the profile env has no bridge token", async () => {
  const dir = sandbox();
  const bin = fakeClaude(dir);
  const cfg = join(dir, "profile");
  const base = { bin, tz: TZ, configDir: cfg, workDir: dir, now: NOW, env: { PATH: process.env.PATH, HOME: dir, CLAUDE_CODE_OAUTH_TOKEN: "bridge-token", BRIDGE_SECRET: "s" } };
  const { mkdirSync } = await import("node:fs");
  mkdirSync(cfg, { recursive: true });
  const scenario = (sc) => writeFileSync(join(cfg, "scenario"), sc);
  scenario("ok");
  const r = await runConnector({ ...base, kind: "gmail" });
  assert.equal(r.ok, true, r.why);
  assert.match(r.data, /"threads"/);
  const run = JSON.parse(readFileSync(join(dir, "runs.jsonl"), "utf8").trim().split("\n").at(-1));
  assert.equal(run.cfg, cfg);
  assert.equal(run.token, false, "never the bridge's own token");
  assert.equal(run.browser, "/usr/bin/true");
  assert.deepEqual(run.argv.slice(-2), ["--allowedTools", "mcp__claude_ai_Gmail__search_threads"]);
  assert.ok(run.argv.includes("--tools") && run.argv[run.argv.indexOf("--tools") + 1] === "");
  for (const [sc, re] of [["wrongtool", /unexpected tool call/], ["wrongargs", /unexpected tool call/], ["second", /unexpected tool call/], ["hook", /hook ran/],
    ["localserver", /not as expected \(mcp\)/], ["toolerror", /answered with an error/]]) {
    scenario(sc);
    const x = await runConnector({ ...base, kind: "gmail" });
    assert.equal(x.ok, false, sc);
    assert.match(x.why, re, sc);
    assert.equal(x.data, null, `${sc}: nothing kept`);
  }
});

ptest("connector source: count from the result, signed out reported as such, Outlook calls fixed by the bridge", async () => {
  const dir = sandbox();
  const bin = fakeClaude(dir);
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(dir, "p"));
  const opts = { bin, tz: TZ, configDir: join(dir, "p"), workDir: dir, now: NOW, env: { PATH: process.env.PATH, HOME: dir } };
  const s = await connectorSource({ sourceId: "c-g", title: "Gmail", kind: "gmail" }, opts);
  assert.equal(s.status, "ok");
  assert.equal(s.count, 2);
  assert.match(s.text, /^Unread Gmail/);
  writeFileSync(join(dir, "p", "scenario"), "signedout");
  const out = await connectorSource({ sourceId: "c-g", title: "Gmail", kind: "gmail" }, opts);
  assert.equal(out.status, "error");
  assert.equal(out.signedOut, true);
  const cal = connectorCall("outlook_calendar", { tz: TZ, now: NOW });
  assert.equal(cal.tool, "mcp__claude_ai_Microsoft_365__outlook_calendar_search");
  assert.equal(cal.args.afterDateTime, "2026-11-27T23:00:00.000Z");
  assert.equal(cal.args.beforeDateTime, "2026-11-29T23:00:00.000Z");
  assert.equal(connectorCall("gmail_send", { tz: TZ }), null);
});

// ── store, briefing settings, automations ─────────────────────────────────

function store(extra = {}) {
  const db = new DatabaseSync(":memory:");
  const logs = [];
  const c = createConnections({ db, log: (...a) => logs.push(a), now: () => NOW, deps: { claudeBin: "claude", ghBin: null, connectorConfigDir: "/x", workDir: "/x", env: {}, tz: () => TZ, connectorsEnabled: true, ...extra } });
  return { db, c, logs };
}

test("store: the calendar link is kept but only its host is shown or logged", async () => {
  const { c, logs } = store();
  const a = await c.add({ kind: "ics", title: "Family", link: "webcal://cal.example.com/private/SECRETKEY.ics" });
  assert.equal(a.ok, true);
  assert.equal(a.connection.hint, "cal.example.com");
  const st = await c.status();
  assert.ok(!JSON.stringify(st).includes("SECRETKEY"), "the link never goes back to the app");
  assert.ok(!JSON.stringify(logs).includes("SECRETKEY"), "nor into the log");
  assert.equal((await c.add({ kind: "ics", link: "http://cal.example.com/x" })).error, "link");
  assert.equal((await c.add({ kind: "shell" })).error, "kind");
  assert.equal((await c.add({ kind: "github" })).connection.title, "GitHub");
  assert.equal(c.update(a.connection.id, { enabled: false }).connection.enabled, false);
  assert.equal(c.update("c_nope", {}).error, "not_found");
  assert.equal(c.remove(a.connection.id).ok, true);
  for (let i = 0; i < 11; i++) await c.add({ kind: "github" });
  assert.equal((await c.add({ kind: "github" })).error, "full");
});

test("briefing settings: checked strictly; the app briefing exists only when switched on and something is connected", async () => {
  assert.equal(validateBriefing({ enabled: true, time: "7:00", days: [1], prompt: "x" }).error, "time");
  assert.equal(validateBriefing({ enabled: true, time: "07:00", days: [0], prompt: "x" }).error, "days");
  assert.equal(validateBriefing({ enabled: true, time: "07:00", days: [1], prompt: "" }).error, "prompt");
  assert.equal(validateBriefing({ enabled: true, time: "07:00", days: [1], prompt: "x", collect: ["/bin/sh"] }).error, "invalid", "no field can add a command");
  const { c } = store();
  assert.equal(c.builtinConfig(OWNER), null, "off by default");
  assert.equal(c.setBriefing({ enabled: true, time: "06:30", days: [5, 1], prompt: "Kurz auf Deutsch." }).ok, true);
  assert.equal(c.builtinConfig(OWNER), null, "nothing connected yet");
  await c.add({ kind: "github" });
  const cfg = c.builtinConfig(OWNER);
  assert.equal(cfg.owner, OWNER);
  assert.deepEqual(cfg.automations[0].schedule, { time: "06:30", days: [1, 5] });
  assert.equal(cfg.automations[0].collect, null);
  assert.equal(cfg.automations[0].deliver, null, "the app briefing runs no command");
  assert.equal(c.builtinConfig(null), null, "never without an owner");
});

ptest("automations: no file runs the app briefing; a file wins; a rejected file is never replaced", async () => {
  const dir = sandbox();
  const db = new DatabaseSync(":memory:");
  const builtin = { owner: OWNER, tz: TZ, push: null, alerts: null, automations: [{ id: "briefing", title: "Morning briefing", schedule: { time: "07:00", days: [1, 2, 3, 4, 5, 6, 7] }, prompt: "x", collect: null, deliver: null, deliverFull: false, push: false, windowMs: 6 * 3600000 }] };
  const path = join(dir, "automations.json");
  const mk = () => createAutomations({ db, configPath: path, workDir: join(dir, "w"), emergency: { active: false }, now: () => NOW,
    deps: { knownOwners: () => [OWNER], capacity: () => true, summarize: async () => ({ ok: true }), push: async () => "off", builtinConfig: () => builtin } });
  let a = mk(); a.reload();
  assert.equal(a.status().source, "app");
  const prog = script(dir, "c", "#!/bin/sh\ntrue\n");
  writeFileSync(path, JSON.stringify({ version: 1, owner: OWNER, tz: TZ, automations: [{ id: "file", title: "From file", schedule: { time: "07:00", days: [1] }, prompt: "x", collect: [prog] }] }));
  chmodSync(path, 0o600);
  a = mk(); a.reload();
  assert.equal(a.status().source, "file");
  assert.deepEqual(a.status().automations.map((x) => x.id), ["file"]);
  chmodSync(path, 0o644);
  a = mk(); a.reload();
  assert.equal(a.status().enabled, false);
  assert.equal(a.status().reason, "invalid_config", "a broken file is reported, not silently replaced by the app's briefing");
});

ptest("automations: the connections are added to a file briefing's sources", async () => {
  const dir = sandbox();
  const db = new DatabaseSync(":memory:");
  const own = JSON.stringify({ version: 1, sources: [{ id: "mail", title: "Mail", status: "ok", count: 1, newCount: null, fetchedAt: "2026-11-28T06:00:00Z", text: "m" }] });
  const prog = script(dir, "collect", `#!/bin/sh\ncat <<'EOF'\n${own}\nEOF\n`);
  const path = join(dir, "automations.json");
  writeFileSync(path, JSON.stringify({ version: 1, owner: OWNER, tz: TZ, automations: [{ id: "briefing", title: "B", schedule: { time: "06:00", days: [1, 2, 3, 4, 5, 6, 7] }, prompt: "x", collect: [prog] }] }));
  chmodSync(path, 0o600);
  const seen = [];
  const a = createAutomations({ db, configPath: path, workDir: join(dir, "w"), emergency: { active: false }, now: () => NOW,
    deps: { knownOwners: () => [OWNER], capacity: () => true, push: async () => "off", connectionsOwner: () => OWNER,
      extraSources: async () => [{ id: "c-abc", title: "Calendar", status: "ok", count: 1, newCount: null, fetchedAt: "2026-11-28T06:00:00Z", text: "09:00 Dentist" }, { id: "mail", title: "dup", status: "ok", count: 0, newCount: null, fetchedAt: "x", text: "" }],
      summarize: async (x) => { seen.push(x.prompt); return { ok: true, sessionId: "s", messageId: "m", text: "S.\n---\nD.", usage: null, durationMs: 1 }; } } });
  a.reload(); a.sweep();
  await a.tick();
  assert.equal(a.status().automations[0].lastRun.state, "done");
  assert.deepEqual(a.status().automations[0].lastRun.header.sources.map((s) => s.id), ["mail", "c-abc"], "own first, then connections, no duplicate id");
  assert.match(seen[0], /09:00 Dentist/);
  assert.ok(existsSync(dir));
});

test("removing a connection closes its to-dos; other sources keep theirs", async () => {
  const { createTodos } = await import("../src/todos.mjs");
  const db = new DatabaseSync(":memory:");
  const todos = createTodos({ db, now: () => NOW });
  const c = createConnections({ db, now: () => NOW, deps: { tz: () => TZ, onRemoved: (sid) => todos.closeSource(OWNER, sid) } });
  const a = (await c.add({ kind: "github" })).connection;
  const sid = `c-${a.id.slice(2, 14)}`;
  todos.syncSource(OWNER, { automationId: "briefing", sourceId: sid, sourceTitle: "GitHub", status: "ok", tasks: [{ ref: "pr:x/1", text: "Review x#1", url: null }], runId: "r" });
  todos.syncSource(OWNER, { automationId: "briefing", sourceId: "inbound", sourceTitle: "Inputs", status: "ok", tasks: [{ ref: "q1", text: "Answer q1", url: null }], runId: "r" });
  assert.equal(todos.openCount(OWNER), 2);
  c.remove(a.id);
  assert.deepEqual(todos.list(OWNER).todos.map((t) => t.text), ["Answer q1"]);
});

// ── Regressions from the counter-review ───────────────────────────────────

test("calendar fetch: an absolute deadline also ends a host that drips bytes; an abort ends it at once", async () => {
  const drip = (opts, cb) => {
    const req = new EventEmitter();
    req.end = () => setImmediate(() => {
      const res = new EventEmitter();
      res.statusCode = 200; res.resume = () => {}; res.destroy = () => { clearInterval(t); };
      cb(res);
      const t = setInterval(() => res.emit("data", Buffer.from("BEGIN:VCALENDAR\r\n")), 20);
    });
    req.destroy = () => {};
    return req;
  };
  const t0 = Date.now();
  const r = await fetchIcs("https://cal.example.com/a", { transport: drip, timeoutMs: 300 });
  assert.match(r.why, /timed out/);
  assert.ok(Date.now() - t0 < 2000, "ended by the deadline, not by silence");
  const ac = new AbortController();
  const p = fetchIcs("https://cal.example.com/a", { transport: drip, timeoutMs: 60_000, signal: ac.signal });
  setTimeout(() => ac.abort(), 50);
  assert.match((await p).why, /stopped/);
});

ptest("emergency stop: ends a running read, and no further connection is read", async () => {
  const dir = sandbox();
  const started = join(dir, "started");
  const slow = script(dir, "gh", `#!/bin/sh\necho x >> "${started}"\nsleep 30\necho '[]'\n`);
  let stopped = false;
  const db = new DatabaseSync(":memory:");
  const c = createConnections({ db, now: () => NOW, deps: { ghBin: slow, env: { PATH: process.env.PATH }, tz: () => TZ, stopped: () => stopped } });
  await c.add({ kind: "github", title: "One" });
  await c.add({ kind: "github", title: "Two" });
  const t0 = Date.now();
  const run = c.extraSources();
  while (!existsSync(started)) await new Promise((r) => setTimeout(r, 20));
  stopped = true;
  assert.equal(c.stopAll(), 1, "the running gh is known and stopped");
  const out = await run;
  assert.ok(Date.now() - t0 < 10_000, "did not wait for the 30 s sleep");
  assert.deepEqual(out, [], "a stopped read gives no source, and the second is never started");
  assert.equal(readFileSync(started, "utf8").trim().split("\n").length, 1);
});

ptest("a connection removed while it is read leaves no result behind (its closed to-dos stay closed)", async () => {
  const dir = sandbox();
  const started = join(dir, "started");
  const gh = script(dir, "gh", `#!/bin/sh\necho x >> "${started}"\nsleep 1\necho '[{"url":"https://github.com/a/b/pull/1","title":"T","repository":{"nameWithOwner":"a/b"},"number":1}]'\n`);
  const db = new DatabaseSync(":memory:");
  const c = createConnections({ db, now: () => NOW, deps: { ghBin: gh, env: { PATH: process.env.PATH }, tz: () => TZ } });
  const a = (await c.add({ kind: "github" })).connection;
  const run = c.extraSources();
  while (!existsSync(started)) await new Promise((r) => setTimeout(r, 20));
  c.remove(a.id);
  assert.deepEqual(await run, []);
});

ptest("Check on a connection switched off during its read says disabled; removed during its read says not_found", async () => {
  for (const [change, error] of [["off", "disabled"], ["remove", "not_found"]]) {
    const dir = sandbox();
    const started = join(dir, "started");
    const gh = script(dir, "gh", `#!/bin/sh\necho x >> "${started}"\nsleep 1\necho '[]'\n`);
    const db = new DatabaseSync(":memory:");
    const c = createConnections({ db, now: () => NOW, deps: { ghBin: gh, env: { PATH: process.env.PATH }, tz: () => TZ } });
    const a = (await c.add({ kind: "github", title: "Work" })).connection;
    const pending = c.check(a.id);
    while (!existsSync(started)) await new Promise((r) => setTimeout(r, 20));
    if (change === "off") c.update(a.id, { enabled: false }); else c.remove(a.id);
    assert.deepEqual(await pending, { ok: false, error }, change);
    db.close();
  }
});

ptest("switching the app briefing off during its run lets that run finish with the settings it started with", async () => {
  const dir = sandbox();
  const db = new DatabaseSync(":memory:");
  let on = true;
  const cfg = { owner: OWNER, tz: TZ, push: null, alerts: null, automations: [{ id: "briefing", title: "Morning briefing", schedule: { time: "06:00", days: [1, 2, 3, 4, 5, 6, 7] }, prompt: "x", collect: null, deliver: null, deliverFull: false, push: false, windowMs: 6 * 3600000 }] };
  let a;
  a = createAutomations({ db, configPath: join(dir, "none.json"), workDir: join(dir, "w"), emergency: { active: false }, now: () => NOW,
    deps: { knownOwners: () => [OWNER], capacity: () => true, push: async () => "off", builtinConfig: () => (on ? cfg : null), connectionsOwner: () => OWNER,
      extraSources: async () => { on = false; a.reload(); return [{ id: "c-1", title: "Cal", status: "ok", count: 1, newCount: null, fetchedAt: "2026-11-28T05:00:00Z", text: "x" }]; },
      summarize: async () => { assert.equal(a._config()?.tz, TZ, "the running briefing still sees its config"); return { ok: true, sessionId: "s", messageId: "m", text: "S.\n---\nD.", usage: null, durationMs: 1 }; } } });
  a.reload(); a.sweep();
  await a.tick();
  assert.equal(a.status().enabled, false, "switched off for the next run");
  const row = db.prepare("SELECT state, error_class FROM automation_runs").get();
  assert.deepEqual({ ...row }, { state: "done", error_class: null });
  assert.equal(a._config(), null, "and gone once the run ended");
});

test("connector: an emergency stop during the sign-in check starts no Claude", async () => {
  let stopped = false, ran = false;
  const s = await connectorSource({ sourceId: "c-g", title: "Gmail", kind: "gmail" }, {
    tz: TZ, now: NOW, stopped: () => stopped,
    statusFn: async () => { stopped = true; return { loggedIn: true }; },
    runFn: async () => { ran = true; return { ok: true, data: "{}", call: connectorCall("gmail", { tz: TZ }) }; },
  });
  assert.equal(ran, false);
  assert.equal(s.status, "error");
});

ptest("a connection removed while a later one is read gives no result either", async () => {
  const dir = sandbox();
  const count = join(dir, "count");
  // Calls 1 and 2 (first connection) answer at once; call 3 on (second) waits.
  const gh = script(dir, "gh", `#!/bin/sh\necho x >> "${count}"\nn=$(wc -l < "${count}")\nif [ "$n" -ge 3 ]; then sleep 1; fi\necho '[]'\n`);
  const db = new DatabaseSync(":memory:");
  let tick = NOW;
  const c = createConnections({ db, now: () => tick++, deps: { ghBin: gh, env: { PATH: process.env.PATH }, tz: () => TZ } });
  const first = (await c.add({ kind: "github", title: "First" })).connection;
  await c.add({ kind: "github", title: "Second" });
  const run = c.extraSources();
  while (!existsSync(count) || readFileSync(count, "utf8").trim().split("\n").length < 3) await new Promise((r) => setTimeout(r, 20));
  c.remove(first.id);
  const out = await run;
  assert.deepEqual(out.map((s) => s.title), ["Second"], "the first, read before its removal, is not in the result");
});

test("calendar fetch: a refused answer is dropped at once, its body never read", async () => {
  let destroyed = false;
  const t = (opts, cb) => {
    const req = new EventEmitter();
    req.end = () => setImmediate(() => {
      const res = new EventEmitter();
      res.statusCode = 500; res.resume = () => { throw new Error("must not drain"); }; res.destroy = () => { destroyed = true; };
      cb(res);
    });
    req.destroy = () => {};
    return req;
  };
  assert.match((await fetchIcs("https://cal.example.com/a", { transport: t })).why, /HTTP 500/);
  assert.equal(destroyed, true);
});

ptest("a connection removed while an earlier one is read is not read at all", async () => {
  const dir = sandbox();
  const count = join(dir, "count");
  const gh = script(dir, "gh", `#!/bin/sh\necho x >> "${count}"\nsleep 0.5\necho '[]'\n`);
  const db = new DatabaseSync(":memory:");
  let tick = NOW;
  const c = createConnections({ db, now: () => tick++, deps: { ghBin: gh, env: { PATH: process.env.PATH }, tz: () => TZ } });
  await c.add({ kind: "github", title: "First" });
  const second = (await c.add({ kind: "github", title: "Second" })).connection;
  const run = c.extraSources();
  while (!existsSync(count)) await new Promise((r) => setTimeout(r, 20));
  c.remove(second.id);
  const out = await run;
  assert.deepEqual(out.map((s) => s.title), ["First"]);
  assert.equal(readFileSync(count, "utf8").trim().split("\n").length, 2, "only the first connection's two queries ran");
});

ptest("connections never go into a briefing of another account than the bridge owner", async () => {
  const dir = sandbox();
  const db = new DatabaseSync(":memory:");
  const prog = script(dir, "collect", `#!/bin/sh\ncat <<'EOF'\n${JSON.stringify({ version: 1, sources: [{ id: "mail", title: "Mail", status: "ok", count: 1, newCount: null, fetchedAt: "2026-11-28T06:00:00Z", text: "m" }] })}\nEOF\n`);
  const path = join(dir, "automations.json");
  const OTHER = "other@example.com";
  writeFileSync(path, JSON.stringify({ version: 1, owner: OTHER, tz: TZ, automations: [{ id: "briefing", title: "B", schedule: { time: "06:00", days: [1, 2, 3, 4, 5, 6, 7] }, prompt: "x", collect: [prog] }] }));
  chmodSync(path, 0o600);
  let asked = 0;
  const prompts = [];
  const a = createAutomations({ db, configPath: path, workDir: join(dir, "w"), emergency: { active: false }, now: () => NOW,
    deps: { knownOwners: () => [OTHER], capacity: () => true, push: async () => "off", connectionsOwner: () => OWNER,
      extraSources: async () => { asked++; return [{ id: "c-secret", title: "Owner's calendar", status: "ok", count: 1, newCount: null, fetchedAt: "x", text: "PRIVATE" }]; },
      summarize: async (x) => { prompts.push(x.prompt); return { ok: true, sessionId: "s", messageId: "m", text: "S.\n---\nD.", usage: null, durationMs: 1 }; } } });
  a.reload(); a.sweep();
  await a.tick();
  assert.equal(a.status().automations[0].lastRun.state, "done");
  assert.equal(asked, 0, "the owner's connections are not even read");
  assert.ok(!prompts[0].includes("PRIVATE"));
  assert.deepEqual(a.status().automations[0].lastRun.header.sources.map((s) => s.id), ["mail"]);
});

ptest("gh gets no bridge secrets; Check is throttled per connection", async () => {
  const dir = sandbox();
  const envFile = join(dir, "env.json");
  const gh = script(dir, "gh", `#!${process.execPath}\nrequire("fs").writeFileSync(${JSON.stringify(envFile)}, JSON.stringify(Object.keys(process.env)));\nprocess.stdout.write("[]");\n`);
  let t = NOW;
  const db = new DatabaseSync(":memory:");
  const c = createConnections({ db, now: () => t, deps: { ghBin: gh, env: { PATH: process.env.PATH, HOME: dir, BRIDGE_SECRET: "s", CLAUDE_CODE_OAUTH_TOKEN: "tok", CONDUIT_VAPID_PRIVATE_KEY: "k" }, tz: () => TZ } });
  const a = (await c.add({ kind: "github" })).connection;
  assert.equal((await c.check(a.id)).ok, true);
  const keys = JSON.parse(readFileSync(envFile, "utf8"));
  for (const k of ["BRIDGE_SECRET", "CLAUDE_CODE_OAUTH_TOKEN", "CONDUIT_VAPID_PRIVATE_KEY"]) assert.ok(!keys.includes(k), k);
  assert.ok(keys.includes("HOME"));
  assert.equal((await c.check(a.id)).error, "throttled");
  t += 10_001;
  assert.equal((await c.check(a.id)).ok, true);
});

ptest("a switched-off connection is not read on request either: no collector starts", async () => {
  const dir = sandbox();
  const started = join(dir, "started");
  const gh = script(dir, "gh", `#!/bin/sh\necho x >> "${started}"\necho '[]'\n`);
  const db = new DatabaseSync(":memory:");
  const c = createConnections({ db, now: () => NOW, deps: { ghBin: gh, env: { PATH: process.env.PATH }, tz: () => TZ } });
  const a = (await c.add({ kind: "github" })).connection;
  c.update(a.id, { enabled: false });
  assert.equal((await c.check(a.id)).error, "disabled");
  assert.deepEqual(await c.extraSources(), []);
  assert.equal(existsSync(started), false, "gh never ran");
});

test("the claude.ai connectors stay off unless CONDUIT_CONNECTORS=1", async () => {
  const off = store({ connectorsEnabled: false });
  const st = await off.c.status();
  assert.ok(!st.kinds.some((k) => k.viaClaude), "not offered");
  assert.equal(st.connector, null);
  assert.equal((await off.c.add({ kind: "gmail" })).error, "kind");
  assert.ok(st.kinds.some((k) => k.kind === "ics") && st.kinds.some((k) => k.kind === "github"));
  const on = store({ connectorsEnabled: true });
  assert.ok((await on.c.status()).kinds.some((k) => k.kind === "gmail"));
});
