import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAutomations, MAX_ATTEMPTS, RETRY_MS, LATE_AFTER_MS } from "../src/automations.mjs";
import { loadAutomationsConfig } from "../src/automations-config.mjs";
import { zonedTime } from "../src/schedule-time.mjs";

const TZ = "Europe/Berlin";
const OWNER = "owner@example.com";

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "conduit-auto-"));
  chmodSync(dir, 0o700);
  return dir;
}

function script(dir, name, body) {
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o700);
  return p;
}

const SOURCES_OK = JSON.stringify({ version: 1, sources: [
  { id: "calendar", title: "Calendar today", status: "ok", count: 2, newCount: null, fetchedAt: "2026-11-24T06:00:00+01:00", text: "09:00 Dentist" },
  { id: "mail", title: "Unread mail", status: "error", count: null, newCount: null, fetchedAt: "2026-11-24T06:00:01+01:00", text: "" },
] });
const SOURCES_ALL_FAIL = JSON.stringify({ version: 1, sources: [
  { id: "mail", title: "Unread mail", status: "error", count: null, fetchedAt: "2026-11-24T06:00:01+01:00", text: "" },
] });

function setup({ collectBody = `cat <<'EOF'\n${SOURCES_OK}\nEOF`, deliver = true, push = true, extra = {}, summarize, emergency = { active: false }, capacity = () => true, clock } = {}) {
  const dir = sandbox();
  const out = join(dir, "delivered.jsonl");
  const collect = script(dir, "collect", collectBody);
  const deliverCmd = script(dir, "deliver", `cat >> "${out}"; echo >> "${out}"`);
  const cfg = {
    version: 1, owner: OWNER, tz: TZ, push: { contact: "mailto:owner@example.com" },
    automations: [{ id: "briefing", title: "Morning briefing", schedule: { time: "07:00", days: [1, 2, 3, 4, 5, 6, 7] },
      prompt: "Summarise in German.", collect: [collect], ...(deliver ? { deliver: [deliverCmd] } : {}), push, ...extra }],
  };
  const configPath = join(dir, "automations.json");
  writeFileSync(configPath, JSON.stringify(cfg));
  chmodSync(configPath, 0o600);
  const db = new DatabaseSync(":memory:");
  const calls = { summarize: [], push: [] };
  const time = clock || { t: zonedTime("2026-11-24", 7, 0, TZ) };
  const make = () => createAutomations({
    db, configPath, workDir: join(dir, "work"), emergency, now: () => time.t,
    deps: {
      knownOwners: () => [OWNER],
      capacity,
      summarize: summarize || (async (x) => { calls.summarize.push(x); return { ok: true, sessionId: "s1", messageId: "m1", text: "Short summary.\n---\nDetails here.", usage: { in: 100, out: 20 }, durationMs: 1234 }; }),
      push: async (x) => { calls.push.push(x); return "sent"; },
    },
  });
  const auto = make();
  auto.reload();
  auto.sweep();
  const delivered = () => existsSync(out) ? readFileSync(out, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  return { dir, db, auto, make, calls, time, delivered, configPath, emergency };
}

test("config: owner-only file, no unknown fields, argv only, known owner", () => {
  const dir = sandbox();
  const prog = script(dir, "c", "true");
  const p = join(dir, "automations.json");
  const base = { version: 1, owner: OWNER, tz: TZ, automations: [{ id: "a", title: "A", schedule: { time: "07:00", days: [1] }, prompt: "x", collect: [prog] }] };
  const write = (o, mode = 0o600) => { writeFileSync(p, JSON.stringify(o)); chmodSync(p, mode); return loadAutomationsConfig(p, { knownOwners: [OWNER] }); };
  assert.equal(write(base).enabled, true);
  assert.equal(write(base, 0o644).reason, "invalid_config", "readable by others");
  assert.equal(write({ ...base, extra: 1 }).reason, "invalid_config", "unknown top-level field");
  assert.equal(write({ ...base, automations: [{ ...base.automations[0], tools: ["Bash"] }] }).reason, "invalid_config", "no field can add tools");
  assert.equal(write({ ...base, automations: [{ ...base.automations[0], collect: `${prog} --x` }] }).reason, "invalid_config", "shell string refused");
  assert.equal(write({ ...base, automations: [{ ...base.automations[0], collect: ["relative/path"] }] }).reason, "invalid_config");
  assert.equal(write({ ...base, owner: "someone@else.test" }).reason, "no_owner");
  assert.equal(write({ ...base, tz: "Mars/Base" }).reason, "invalid_config");
  assert.equal(write({ ...base, automations: [{ ...base.automations[0], schedule: { time: "7:00", days: [1] } }] }).reason, "invalid_config");
  assert.equal(write({ ...base, automations: [{ ...base.automations[0], schedule: { time: "07:00", days: [0] } }] }).reason, "invalid_config");
  assert.equal(write({ ...base, automations: [{ ...base.automations[0], push: true }] }).reason, "invalid_config", "push needs a contact");
  chmodSync(prog, 0o722);
  assert.equal(write(base).reason, "invalid_config", "group-writable command refused");
  assert.equal(loadAutomationsConfig(join(dir, "missing.json"), { knownOwners: [OWNER] }).reason, "not_configured");
});

test("a scheduled run: collect, summarize, deliver header + summary, push", async () => {
  const s = setup();
  await s.auto.tick();
  const st = s.auto.status();
  const run = st.automations[0].lastRun;
  assert.equal(run.state, "done");
  assert.equal(run.kind, "schedule");
  assert.equal(run.slotDate, "2026-11-24");
  assert.equal(run.summary, "Short summary.");
  assert.deepEqual(run.delivery, { telegram: "sent", push: "sent" });
  assert.deepEqual(run.tokens, { in: 100, out: 20 });
  assert.equal(run.header.sources[1].status, "error");
  assert.equal(s.calls.summarize.length, 1);
  const prompt = s.calls.summarize[0].prompt;
  assert.match(prompt, /You have no tools/);
  assert.match(prompt, /<<<CONDUIT-DATA[\s\S]*09:00 Dentist[\s\S]*CONDUIT-DATA>>>/);
  assert.match(prompt, /Unread mail \[UNAVAILABLE/);
  const [d] = s.delivered();
  assert.equal(d.summary, "Short summary.");
  assert.match(d.header, /Calendar today: ok, 2 items/);
  assert.match(d.header, /Unread mail: UNAVAILABLE/);
  assert.equal(d.full, undefined, "full text only with deliverFull");
  assert.equal(s.calls.push[0].payload.title, "Morning briefing ready");
  assert.equal(JSON.stringify(s.calls.push[0].payload).includes("Short summary"), false, "push carries no content");
});

test("never twice per slot: repeated ticks and a restart", async () => {
  const s = setup();
  await s.auto.tick();
  await s.auto.tick();
  s.time.t += 60_000;
  const again = s.make();
  again.reload(); again.sweep();
  await again.tick();
  const n = s.db.prepare("SELECT COUNT(*) AS n FROM automation_runs WHERE kind = 'schedule'").get().n;
  assert.equal(n, 1);
  assert.equal(s.calls.summarize.length, 1);
  assert.equal(s.delivered().length, 1);
});

test("emergency stop active: nothing runs, no attempt used; after release it runs", async () => {
  const marker = join(tmpdir(), `conduit-collect-ran-${process.pid}-${Date.now()}`);
  const s = setup({ emergency: { active: true }, collectBody: `touch "${marker}"\ncat <<'EOF'\n${SOURCES_OK}\nEOF` });
  await s.auto.tick();
  let run = s.auto.status().automations[0].lastRun;
  assert.equal(run.state, "claimed");
  assert.equal(run.errorClass, "emergency");
  assert.equal(run.attempts, 0);
  assert.equal(existsSync(marker), false, "collect never started");
  s.emergency.active = false;
  s.time.t += 61_000;
  await s.auto.tick();
  run = s.auto.status().automations[0].lastRun;
  assert.equal(run.state, "done");
  assert.equal(run.attempts, 1);
});

test("stopAll during collect kills the process group and never delivers", async () => {
  const s = setup({ collectBody: `sleep 30 & wait` });
  const p = s.auto.tick();
  for (let i = 0; i < 100 && s.auto.activeCount() === 0; i++) await new Promise((r) => setTimeout(r, 20));
  s.emergency.active = true;
  assert.equal(s.auto.stopAll(), 1);
  await p;
  const run = s.auto.status().automations[0].lastRun;
  assert.equal(run.state, "claimed");
  assert.equal(run.errorClass, "emergency");
  assert.equal(run.attempts, 0, "an emergency stop does not use up an attempt");
  assert.equal(s.delivered().length, 0);
  assert.equal(s.calls.summarize.length, 0);
});

test("emergency stop during summarize: no delivery, no push", async () => {
  const em = { active: false };
  let release;
  const s = setup({ emergency: em, summarize: async () => { em.active = true; await new Promise((r) => { release = r; setTimeout(r, 10); }); return { ok: false, errorClass: "stopped", sessionId: "s1", messageId: "m1", text: "" }; } });
  await s.auto.tick();
  void release;
  const run = s.auto.status().automations[0].lastRun;
  assert.equal(run.errorClass, "emergency");
  assert.equal(s.delivered().length, 0);
  assert.equal(s.calls.push.length, 0);
});

test("collect failure: retried with spacing, then failed with one failure notice", async () => {
  const s = setup({ collectBody: "exit 3" });
  for (let i = 0; i < MAX_ATTEMPTS + 2; i++) { await s.auto.tick(); s.time.t += RETRY_MS + 1000; }
  const run = s.auto.status().automations[0].lastRun;
  assert.equal(run.state, "failed");
  assert.equal(run.errorClass, "collect_failed");
  assert.equal(run.attempts, MAX_ATTEMPTS);
  const d = s.delivered();
  assert.equal(d.length, 1, "exactly one failure notice");
  assert.equal(d[0].status, "failed");
  assert.equal(s.calls.summarize.length, 0);
});

test("all sources unavailable: no model run, a failure notice instead", async () => {
  const s = setup({ collectBody: `cat <<'EOF'\n${SOURCES_ALL_FAIL}\nEOF` });
  for (let i = 0; i < MAX_ATTEMPTS + 1; i++) { await s.auto.tick(); s.time.t += RETRY_MS + 1000; }
  assert.equal(s.calls.summarize.length, 0);
  const run = s.auto.status().automations[0].lastRun;
  assert.equal(run.errorClass, "all_sources_failed");
  assert.equal(s.delivered()[0].errorClass, "all_sources_failed");
});

test("invalid or oversized collect output fails without retry", async () => {
  const s = setup({ collectBody: "echo '{\"version\":2}'" });
  await s.auto.tick();
  assert.equal(s.auto.status().automations[0].lastRun.state, "failed");
  assert.equal(s.auto.status().automations[0].lastRun.errorClass, "collect_invalid");
  const big = setup({ collectBody: "head -c 600000 /dev/zero | tr '\\0' 'a'" });
  await big.auto.tick();
  assert.equal(big.auto.status().automations[0].lastRun.errorClass, "collect_too_large");
});

test("no free turn slot: deferred, attempt not used", async () => {
  let free = false;
  const s = setup({ capacity: () => free });
  await s.auto.tick();
  assert.equal(s.auto.status().automations[0].lastRun.errorClass, "capacity");
  assert.equal(s.auto.status().automations[0].lastRun.attempts, 0);
  free = true; s.time.t += 61_000;
  await s.auto.tick();
  assert.equal(s.auto.status().automations[0].lastRun.state, "done");
});

test("restart recovery: delivering becomes done with unknown delivery; collecting is retried", () => {
  const s = setup();
  const ins = s.db.prepare(`INSERT INTO automation_runs (id, automation_id, kind, slot_date, slot_at, tz, state, attempts, delivery, created_at) VALUES (?, 'briefing', ?, ?, ?, ?, ?, 1, ?, ?)`);
  ins.run("r_a", "manual", null, null, TZ, "delivering", JSON.stringify({ telegram: "sent", push: "pending" }), 1);
  ins.run("r_b", "manual", null, null, TZ, "collecting", JSON.stringify({ telegram: "pending", push: "pending" }), 2);
  s.db.prepare("INSERT INTO automation_locks VALUES ('briefing', 'r_b', 1)").run();
  s.auto.sweep();
  const a = s.auto._get("r_a"), b = s.auto._get("r_b");
  assert.equal(a.state, "done");
  assert.deepEqual(a.delivery, { telegram: "sent", push: "unknown" }, "never resent blindly");
  assert.equal(b.state, "claimed");
  assert.equal(b.errorClass, "bridge_restart");
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM automation_locks").get().n, 0, "stale locks cleared");
});

test("window passed while the bridge was off: skipped, nothing runs", async () => {
  const s = setup();
  s.time.t = zonedTime("2026-11-24", 7, 0, TZ) + 7 * 3600000;
  await s.auto.tick();
  const run = s.auto.status().automations[0].lastRun;
  assert.equal(run.state, "skipped");
  assert.equal(s.calls.summarize.length, 0);
});

test("late notice is sent once, never during an emergency stop", async () => {
  let free = false;
  const em = { active: false };
  const s = setup({ capacity: () => free, emergency: em });
  await s.auto.tick();
  s.time.t += LATE_AFTER_MS + 60_000;
  em.active = true;
  await s.auto.tick();
  assert.equal(s.delivered().length, 0, "no notice during an emergency stop");
  em.active = false;
  await s.auto.tick();
  s.time.t += 61_000;
  await s.auto.tick();
  const late = s.delivered().filter((d) => d.status === "failed");
  assert.equal(late.length, 1);
  assert.ok(late[0].summary.includes("late"));
  void free;
});

test("manual run: busy, throttled and emergency are refused", async () => {
  const em = { active: false };
  const s = setup({ emergency: em, collectBody: `sleep 0.3\ncat <<'EOF'\n${SOURCES_OK}\nEOF` });
  const first = s.auto.runNow("briefing");
  assert.equal(first.ok, true);
  assert.equal(s.auto.runNow("briefing").error, "busy");
  for (let i = 0; i < 200 && s.auto._get(first.runId).state !== "done"; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(s.auto._get(first.runId).state, "done");
  assert.equal(s.auto.runNow("briefing").error, "throttled");
  s.time.t += 3 * 60_000;
  em.active = true;
  assert.equal(s.auto.runNow("briefing").error, "emergency");
  assert.equal(s.auto.runNow("nope").error, "disabled");
});

test("resend sends only the stored header and summary", async () => {
  const s = setup();
  await s.auto.tick();
  const id = s.auto.status().automations[0].lastRun.id;
  assert.equal(s.auto.redeliver(id).ok, true);
  for (let i = 0; i < 100 && s.delivered().length < 2; i++) await new Promise((r) => setTimeout(r, 20));
  const [, again] = s.delivered();
  assert.equal(again.summary, "Short summary.");
  assert.equal(s.calls.summarize.length, 1, "no new model run");
  assert.equal(s.auto.redeliver(id).error, "throttled");
});

test("deliverFull adds the full text", async () => {
  const s = setup({ extra: { deliverFull: true } });
  await s.auto.tick();
  assert.equal(s.delivered()[0].full, "Short summary.\n---\nDetails here.");
});
