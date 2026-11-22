// Not-Aus state: survives a restart, fails closed on a broken file, and a
// release that cannot be saved leaves it on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEmergencyStop, EMERGENCY_FILE } from "../src/emergency.mjs";

const fresh = () => mkdtempSync(join(tmpdir(), "conduit-emergency-"));

test("off by default, engaged survives a restart, release survives too", () => {
  const dir = fresh();
  try {
    let e = createEmergencyStop({ stateDir: dir, now: () => 1000 });
    assert.equal(e.active, false);
    const r = e.engage("owner@example.com");
    assert.equal(r.active, true); assert.equal(r.since, 1000); assert.equal(r.persisted, true); assert.equal(r.already, false);
    if (process.platform !== "win32") assert.equal(statSync(join(dir, EMERGENCY_FILE)).mode & 0o777, 0o600);
    // Pressing again keeps the first time.
    assert.equal(e.engage("x").since, 1000);
    e = createEmergencyStop({ stateDir: dir });
    assert.equal(e.active, true);
    assert.equal(e.status().since, 1000);
    assert.equal(e.release().released, true);
    e = createEmergencyStop({ stateDir: dir });
    assert.equal(e.active, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a broken state file reads as engaged (fails closed)", () => {
  const dir = fresh();
  try {
    writeFileSync(join(dir, EMERGENCY_FILE), "{not json");
    const logs = [];
    const e = createEmergencyStop({ stateDir: dir, log: (l, ev) => logs.push(ev) });
    assert.equal(e.active, true);
    assert.ok(logs.includes("emergency_state_unreadable"));
    writeFileSync(join(dir, EMERGENCY_FILE), JSON.stringify({ active: "no" }));
    assert.equal(createEmergencyStop({ stateDir: dir }).active, true);
    // Releasing writes a clean file.
    assert.equal(e.release().active, false);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, EMERGENCY_FILE), "utf8")), { active: false, since: null, by: null });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a release that cannot be saved leaves the stop on", { skip: process.platform === "win32" || process.getuid?.() === 0 }, () => {
  const dir = fresh();
  try {
    const e = createEmergencyStop({ stateDir: dir });
    e.engage("o");
    chmodSync(dir, 0o500);
    const r = e.release();
    assert.equal(r.released, false);
    assert.equal(e.active, true);
    // Engaging still works in memory and says it was not saved.
    const e2 = createEmergencyStop({ stateDir: dir });
    assert.equal(e2.active, true);
  } finally { chmodSync(dir, 0o700); rmSync(dir, { recursive: true, force: true }); }
});

test("a full disk cannot lift the stop on restart: the old file is emptied, which reads as pressed", { skip: process.platform === "win32" || process.getuid?.() === 0 }, () => {
  const dir = fresh();
  try {
    let e = createEmergencyStop({ stateDir: dir });
    e.engage("o"); e.release();          // leaves {"active":false} on disk
    chmodSync(dir, 0o500);               // no new file (the temp file) can be created
    const logs = [];
    e = createEmergencyStop({ stateDir: dir, log: (l, ev) => logs.push(ev) });
    const r = e.engage("o");
    assert.ok(logs.includes("emergency_state_write_failed"));
    assert.equal(r.persisted, true);
    assert.equal(e.status().unsaved, false);
    assert.equal(readFileSync(join(dir, EMERGENCY_FILE), "utf8"), "");
    // Restart: pressed.
    assert.equal(createEmergencyStop({ stateDir: dir }).active, true);
  } finally { chmodSync(dir, 0o700); rmSync(dir, { recursive: true, force: true }); }
});

test("when nothing at all can be written the stop holds in memory and status keeps saying unsaved", { skip: process.platform === "win32" || process.getuid?.() === 0 }, () => {
  const dir = fresh();
  try {
    chmodSync(dir, 0o500);               // no file exists and none can be created
    const e = createEmergencyStop({ stateDir: dir });
    const r = e.engage("o");
    assert.equal(r.persisted, false);
    assert.equal(e.active, true);
    // Every later read (the app opening Tasks again) still sees it.
    assert.equal(e.status().unsaved, true);
    assert.equal(e.status().unsaved, true);
    chmodSync(dir, 0o700);
    // A later press that can save clears the warning.
    e.engage("o");
    assert.equal(e.status().unsaved, false);
    assert.equal(createEmergencyStop({ stateDir: dir }).active, true);
  } finally { chmodSync(dir, 0o700); rmSync(dir, { recursive: true, force: true }); }
});

test("the state file exists from the first start, so even a first press on a full disk survives a restart", { skip: process.platform === "win32" || process.getuid?.() === 0 }, () => {
  const dir = fresh();
  try {
    createEmergencyStop({ stateDir: dir });
    assert.deepEqual(JSON.parse(readFileSync(join(dir, EMERGENCY_FILE), "utf8")), { active: false, since: null, by: null });
    chmodSync(dir, 0o500);
    const e = createEmergencyStop({ stateDir: dir });
    assert.equal(e.engage("o").persisted, true);
    assert.equal(createEmergencyStop({ stateDir: dir }).active, true);
  } finally { chmodSync(dir, 0o700); rmSync(dir, { recursive: true, force: true }); }
});
