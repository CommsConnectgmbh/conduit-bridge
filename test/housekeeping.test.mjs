// Retention and log rotation against a throwaway history database (the real
// schema from db.mjs) and a temp directory.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync, utimesSync, statSync, openSync, writeSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readHousekeepingPolicy, purgeExpiredHistory, enableSecureDelete, sweepOldFiles, rotateOwnLog, rotateServiceLogs,
} from "../src/housekeeping.mjs";

const dir = mkdtempSync(join(tmpdir(), "conduit-housekeeping-"));
let closeDb = () => {};
// Not after(): see agent-policy.test.mjs. Windows keeps the database locked
// until it is closed.
process.on("exit", () => {
  try { closeDb(); } catch {}
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch {}
});

process.env.DB_DIR = join(dir, "db");
const { db } = await import("../src/db.mjs");
closeDb = () => db.close();

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 9, 12);

function chat(id, lastActivityDaysAgo, { messages = [], audit = [] } = {}) {
  const t = NOW - lastActivityDaysAgo * DAY;
  db.prepare("INSERT INTO sessions (id, user_email, title, created_at, updated_at) VALUES (?, 'u@example.com', 't', ?, ?)").run(id, t - DAY, t);
  for (const [mid, daysAgo] of messages) {
    db.prepare("INSERT INTO messages (id, session_id, role, content, ts) VALUES (?, ?, 'user', 'x', ?)").run(mid, id, NOW - daysAgo * DAY);
  }
  for (const [aid, daysAgo, status = "done"] of audit) {
    db.prepare("INSERT INTO audit_log (id, session_id, ts, tool, status) VALUES (?, ?, ?, 'Bash', ?)").run(aid, id, NOW - daysAgo * DAY, status);
  }
}
const ids = (table) => db.prepare(`SELECT id FROM ${table} ORDER BY id`).all().map((r) => r.id);

test("defaults keep today's behaviour", () => {
  const p = readHousekeepingPolicy({});
  assert.deepEqual(
    { chat: p.chatDays, audit: p.auditDays, paste: p.pasteDays, logMax: p.logMaxBytes, logFiles: p.logFiles, stdout: p.logStdout, svc: p.serviceLogMaxBytes },
    { chat: 0, audit: 0, paste: 30, logMax: 10 * 1024 * 1024, logFiles: 5, stdout: true, svc: 0 },
  );
  assert.deepEqual(p.errors, []);
  const bad = readHousekeepingPolicy({ CONDUIT_RETENTION_DAYS: "-3", CONDUIT_LOG_FILES: "lots" });
  assert.equal(bad.chatDays, 0);
  assert.equal(bad.logFiles, 5);
  assert.equal(bad.errors.length, 2);
  assert.equal(readHousekeepingPolicy({}, { serviceLogDirDefault: "/x/logs" }).serviceLogDir, "/x/logs");
});

test("no retention set: nothing is deleted", () => {
  chat("keep-old", 400, { messages: [["m0", 400]] });
  assert.deepEqual(purgeExpiredHistory(db, { now: NOW }), { sessions: 0, audit: 0 });
  assert.ok(ids("sessions").includes("keep-old"));
  db.prepare("DELETE FROM sessions").run();
});

test("chats past the retention go with their messages and audit; recent and busy ones stay", () => {
  chat("old", 40, { messages: [["m1", 41], ["m2", 40]], audit: [["a1", 40]] });
  // updated_at is old, but a message is recent: last activity counts.
  chat("revived", 40, { messages: [["m3", 2]] });
  chat("recent", 5, { messages: [["m4", 5]], audit: [["a2", 5]] });
  chat("busy", 60, { messages: [["m5", 60]] });
  assert.equal(enableSecureDelete(db), true);
  const r = purgeExpiredHistory(db, { chatDays: 30, now: NOW, keep: new Set(["busy"]) });
  assert.deepEqual(r, { sessions: 1, audit: 0 });
  assert.deepEqual(ids("sessions"), ["busy", "recent", "revived"]);
  assert.deepEqual(ids("messages"), ["m3", "m4", "m5"]);
  assert.deepEqual(ids("audit_log"), ["a2"]);
  db.prepare("DELETE FROM sessions").run();
});

test("audit retention trims old steps but keeps the chats and running steps", () => {
  chat("c", 1, { messages: [["m6", 1]], audit: [["old-step", 20], ["running-step", 20, "running"], ["new-step", 1]] });
  const r = purgeExpiredHistory(db, { auditDays: 7, now: NOW });
  assert.deepEqual(r, { sessions: 0, audit: 1 });
  assert.deepEqual(ids("audit_log"), ["new-step", "running-step"]);
  assert.deepEqual(ids("messages"), ["m6"]);
  db.prepare("DELETE FROM sessions").run();
});

test("attachments older than the limit are swept, 0 keeps them", () => {
  const p = join(dir, "pastes");
  mkdirSync(p);
  writeFileSync(join(p, "old.png"), "x");
  writeFileSync(join(p, "new.png"), "x");
  const old = (NOW - 31 * DAY) / 1000;
  utimesSync(join(p, "old.png"), old, old);
  assert.equal(sweepOldFiles(p, 0, NOW), 0);
  assert.equal(sweepOldFiles(p, 30 * DAY, NOW + 0), 1);
  assert.deepEqual(readdirSync(p), ["new.png"]);
  assert.equal(sweepOldFiles(join(dir, "missing"), DAY), 0);
});

test("bridge.log rotation keeps the configured number of files", () => {
  const d = join(dir, "own");
  mkdirSync(d);
  const f = join(d, "bridge.log");
  for (let i = 0; i < 5; i++) {
    writeFileSync(f, "x".repeat(200 + i));
    assert.equal(rotateOwnLog(f, 100, 3), true);
  }
  assert.equal(rotateOwnLog(join(d, "none.log"), 100, 3), false);
  assert.deepEqual(readdirSync(d).sort(), ["bridge.log.1", "bridge.log.2"]);
  assert.equal(statSync(f + ".1").size, 204);
});

test("service logs are copied and truncated in place, so an open writer keeps appending", () => {
  const d = join(dir, "svc");
  mkdirSync(d);
  const f = join(d, "de.tryconduit.tunnel.err.log");
  writeFileSync(f, "a".repeat(2000));
  writeFileSync(join(d, "small.log"), "b");
  writeFileSync(join(d, "notes.txt"), "c".repeat(2000));
  assert.deepEqual(rotateServiceLogs(d, 0, 3), [], "off by default");
  assert.deepEqual(rotateServiceLogs(d, 1000, 2), ["de.tryconduit.tunnel.err.log"]);
  assert.equal(statSync(f).size, 0);
  assert.equal(readFileSync(f + ".1", "utf8").length, 2000);
  for (let i = 0; i < 3; i++) { writeFileSync(f, "z".repeat(1500)); rotateServiceLogs(d, 1000, 2); }
  assert.deepEqual(readdirSync(d).sort(), [
    "de.tryconduit.tunnel.err.log", "de.tryconduit.tunnel.err.log.1", "de.tryconduit.tunnel.err.log.2", "notes.txt", "small.log",
  ]);
  assert.ok(!existsSync(f + ".3"));
});

test("a writer holding the file open in append mode (like launchd) continues at the new end",
  { skip: process.platform === "win32" && "only launchd writes service logs; the Windows tasks do not" }, () => {
  const d = join(dir, "append");
  mkdirSync(d);
  const f = join(d, "de.tryconduit.bridge.out.log");
  const fd = openSync(f, "a");
  try {
    writeSync(fd, "o".repeat(3000));
    assert.deepEqual(rotateServiceLogs(d, 1000, 3), ["de.tryconduit.bridge.out.log"]);
    writeSync(fd, "after\n");
  } finally { closeSync(fd); }
  assert.equal(readFileSync(f, "utf8"), "after\n");
  assert.equal(statSync(f + ".1").size, 3000);
});
