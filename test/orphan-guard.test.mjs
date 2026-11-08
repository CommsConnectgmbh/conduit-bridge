import { test } from "node:test";
import assert from "node:assert/strict";
import { normaliseOrphanGrace, orphanDecision, ORPHAN_GRACE_MIN_MS, ORPHAN_GRACE_MAX_MS } from "../src/orphan-guard.mjs";

test("normaliseOrphanGrace: 0/negative/NaN disable, others are clamped", () => {
  assert.equal(normaliseOrphanGrace(0), 0);
  assert.equal(normaliseOrphanGrace(-5), 0);
  assert.equal(normaliseOrphanGrace(NaN), 0);
  assert.equal(normaliseOrphanGrace(1), ORPHAN_GRACE_MIN_MS);
  assert.equal(normaliseOrphanGrace(90_000), 90_000);
  assert.equal(normaliseOrphanGrace(ORPHAN_GRACE_MAX_MS * 2), ORPHAN_GRACE_MAX_MS);
});

const base = { graceMs: 1_800_000, now: 10_000_000, turnAlive: true, ownerConnected: false, ownerLastSeenAt: 10_000_000 - 1_800_000 };

test("orphanDecision: off or finished turn does nothing", () => {
  assert.deepEqual(orphanDecision({ ...base, graceMs: 0 }), { action: "ignore" });
  assert.deepEqual(orphanDecision({ ...base, turnAlive: false }), { action: "ignore" });
});

test("orphanDecision: owner connected to any chat re-arms for a full grace", () => {
  assert.deepEqual(orphanDecision({ ...base, ownerConnected: true }), { action: "rearm", delayMs: base.graceMs });
});

test("orphanDecision: owner away for less than grace re-arms for the remainder", () => {
  const d = orphanDecision({ ...base, ownerLastSeenAt: base.now - 60_000 });
  assert.deepEqual(d, { action: "rearm", delayMs: base.graceMs - 60_000 });
});

test("orphanDecision: unknown last-seen counts from now, never kills on a guess", () => {
  assert.deepEqual(orphanDecision({ ...base, ownerLastSeenAt: null }), { action: "rearm", delayMs: base.graceMs });
  assert.deepEqual(orphanDecision({ ...base, ownerLastSeenAt: base.now + 5_000 }), { action: "rearm", delayMs: base.graceMs });
});

test("orphanDecision: kills only after the full grace without any connection", () => {
  assert.deepEqual(orphanDecision(base), { action: "kill" });
  assert.deepEqual(orphanDecision({ ...base, ownerLastSeenAt: base.now - base.graceMs - 1 }), { action: "kill" });
});
