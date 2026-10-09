// Update policy from the environment: modes, pin, maintenance window.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readUpdatePolicy, inUpdateWindow, updateWindowKey } from "../src/update-policy.mjs";

const at = (h, m, day = 10) => new Date(2026, 9, day, h, m);

test("default is today's behaviour: install, no pin, no window", () => {
  assert.deepEqual(readUpdatePolicy({}), { mode: "install", pin: null, window: null, errors: [] });
  assert.equal(readUpdatePolicy({ CONDUIT_SELFUPDATE: "1" }).mode, "install");
  assert.equal(readUpdatePolicy({ CONDUIT_SELFUPDATE: "0" }).mode, "off");
  assert.equal(readUpdatePolicy({ CONDUIT_SELFUPDATE: "notify" }).mode, "notify");
});

test("pin and window are read; anything unreadable falls back to reporting, never installing", () => {
  const p = readUpdatePolicy({ CONDUIT_UPDATE_PIN: "3.0.4", CONDUIT_UPDATE_WINDOW: "02:00-05:30" });
  assert.equal(p.mode, "install");
  assert.equal(p.pin, "3.0.4");
  assert.deepEqual(p.window, { start: 120, end: 330, label: "02:00-05:30" });
  for (const env of [
    { CONDUIT_SELFUPDATE: "sometimes" },
    { CONDUIT_UPDATE_PIN: "latest" },
    { CONDUIT_UPDATE_PIN: "3.0" },
    { CONDUIT_UPDATE_WINDOW: "2am-5am" },
    { CONDUIT_UPDATE_WINDOW: "25:00-03:00" },
    { CONDUIT_UPDATE_WINDOW: "03:00-03:00" },
  ]) {
    const r = readUpdatePolicy(env);
    assert.equal(r.mode, "notify", JSON.stringify(env));
    assert.equal(r.errors.length, 1, JSON.stringify(env));
  }
  // Switched off stays off, whatever else is wrong; the mistake is still reported.
  const off = readUpdatePolicy({ CONDUIT_SELFUPDATE: "0", CONDUIT_UPDATE_PIN: "x" });
  assert.equal(off.mode, "off");
  assert.equal(off.errors.length, 1);
});

test("window membership, also across midnight", () => {
  const day = readUpdatePolicy({ CONDUIT_UPDATE_WINDOW: "02:00-05:00" }).window;
  assert.equal(inUpdateWindow(day, at(1, 59)), false);
  assert.equal(inUpdateWindow(day, at(2, 0)), true);
  assert.equal(inUpdateWindow(day, at(4, 59)), true);
  assert.equal(inUpdateWindow(day, at(5, 0)), false);
  const night = readUpdatePolicy({ CONDUIT_UPDATE_WINDOW: "22:00-04:00" }).window;
  assert.equal(inUpdateWindow(night, at(21, 59)), false);
  assert.equal(inUpdateWindow(night, at(23, 30)), true);
  assert.equal(inUpdateWindow(night, at(3, 0)), true);
  assert.equal(inUpdateWindow(night, at(12, 0)), false);
  assert.equal(inUpdateWindow(null, at(12, 0)), true);
});

test("one key per window occurrence, so the check runs once per window", () => {
  const night = readUpdatePolicy({ CONDUIT_UPDATE_WINDOW: "22:00-04:00" }).window;
  assert.equal(updateWindowKey(night, at(23, 0, 10)), updateWindowKey(night, at(3, 0, 11)));
  assert.notEqual(updateWindowKey(night, at(23, 0, 10)), updateWindowKey(night, at(23, 0, 11)));
  const day = readUpdatePolicy({ CONDUIT_UPDATE_WINDOW: "02:00-05:00" }).window;
  assert.notEqual(updateWindowKey(day, at(3, 0, 10)), updateWindowKey(day, at(3, 0, 11)));
});
