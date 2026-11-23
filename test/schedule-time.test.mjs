import { test } from "node:test";
import assert from "node:assert/strict";
import { addDays, dayBounds, dueSlot, isoWeekday, isValidZone, localDate, nextSlot, partsIn, slotOn, zonedTime } from "../src/schedule-time.mjs";

const B = "Europe/Berlin";
const iso = (ms, tz = B) => { const p = partsIn(ms, tz); return `${localDate(ms, tz)} ${String(p.h).padStart(2, "0")}:${String(p.mi).padStart(2, "0")}`; };
const H = 3600000;

test("ordinary day: 07:00 Berlin in winter is 06:00 UTC", () => {
  assert.equal(new Date(zonedTime("2026-11-24", 7, 0, B)).toISOString(), "2026-11-24T06:00:00.000Z");
  assert.equal(new Date(zonedTime("2026-07-01", 7, 0, B)).toISOString(), "2026-07-01T05:00:00.000Z");
});

test("spring forward: 02:30 does not exist, runs at 03:00 (first valid minute)", () => {
  // 2027-03-28: 02:00 CET -> 03:00 CEST.
  const t = zonedTime("2027-03-28", 2, 30, B);
  assert.equal(iso(t), "2027-03-28 03:00");
  assert.equal(new Date(t).toISOString(), "2027-03-28T01:00:00.000Z");
  // The minutes around the gap stay exact.
  assert.equal(iso(zonedTime("2027-03-28", 1, 59, B)), "2027-03-28 01:59");
  assert.equal(iso(zonedTime("2027-03-28", 3, 0, B)), "2027-03-28 03:00");
  assert.equal(iso(zonedTime("2027-03-28", 2, 0, B)), "2027-03-28 03:00");
});

test("fall back: 02:30 exists twice, the first occurrence is chosen", () => {
  // 2026-10-25: 03:00 CEST -> 02:00 CET. First 02:30 is CEST = 00:30 UTC.
  const t = zonedTime("2026-10-25", 2, 30, B);
  assert.equal(new Date(t).toISOString(), "2026-10-25T00:30:00.000Z");
  assert.equal(new Date(zonedTime("2026-10-25", 3, 0, B)).toISOString(), "2026-10-25T02:00:00.000Z");
  assert.equal(new Date(zonedTime("2026-10-25", 1, 59, B)).toISOString(), "2026-10-24T23:59:00.000Z");
});

test("other zones: southern hemisphere and a half-hour zone", () => {
  assert.equal(iso(zonedTime("2026-10-04", 2, 30, "Australia/Sydney"), "Australia/Sydney"), "2026-10-04 03:00");
  assert.equal(new Date(zonedTime("2026-11-24", 7, 0, "Asia/Kolkata")).toISOString(), "2026-11-24T01:30:00.000Z");
  assert.equal(new Date(zonedTime("2026-11-24", 7, 0, "UTC")).toISOString(), "2026-11-24T07:00:00.000Z");
});

test("day bounds are 23 and 25 hours on transition days", () => {
  const [a, b] = dayBounds("2027-03-28", B);
  assert.equal(b - a, 23 * H);
  const [c, d] = dayBounds("2026-10-25", B);
  assert.equal(d - c, 25 * H);
  const [e, f] = dayBounds("2026-11-24", B);
  assert.equal(f - e, 24 * H);
});

test("ISO weekdays", () => {
  assert.equal(isoWeekday("2026-11-23"), 1); // Monday
  assert.equal(isoWeekday("2026-11-29"), 7); // Sunday
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addDays("2027-03-01", -1), "2027-02-28");
});

test("slotOn respects the configured weekdays", () => {
  const sched = { time: "07:00", days: [1, 2, 3, 4, 5] };
  assert.ok(slotOn(sched, "2026-11-27", B)); // Friday
  assert.equal(slotOn(sched, "2026-11-28", B), null); // Saturday
});

test("dueSlot: inside the window, before the slot, after the window", () => {
  const sched = { time: "07:00", days: [1, 2, 3, 4, 5, 6, 7] };
  const slot = zonedTime("2026-11-24", 7, 0, B);
  const W = 6 * H;
  assert.equal(dueSlot(sched, B, slot - 60000, W), null);
  assert.equal(dueSlot(sched, B, slot, W).slotDate, "2026-11-24");
  assert.equal(dueSlot(sched, B, slot + W - 1, W).slotDate, "2026-11-24");
  assert.equal(dueSlot(sched, B, slot + W, W), null);
});

test("dueSlot: a late-evening slot whose window passes midnight", () => {
  const sched = { time: "23:30", days: [1, 2, 3, 4, 5, 6, 7] };
  const slot = zonedTime("2026-11-24", 23, 30, B);
  const s = dueSlot(sched, B, slot + 2 * H, 6 * H);
  assert.equal(s.slotDate, "2026-11-24");
});

test("dueSlot on the spring-forward day fires at 03:00, once", () => {
  const sched = { time: "02:30", days: [1, 2, 3, 4, 5, 6, 7] };
  const at = zonedTime("2027-03-28", 3, 0, B);
  assert.equal(dueSlot(sched, B, at - 60000, 6 * H), null, "not before the first valid minute");
  assert.equal(dueSlot(sched, B, at, 6 * H).slotDate, "2027-03-28");
});

test("nextSlot skips days off and finds the next week", () => {
  const sched = { time: "07:00", days: [1] };
  const n = nextSlot(sched, B, zonedTime("2026-11-24", 8, 0, B));
  assert.equal(n.slotDate, "2026-11-30");
  assert.equal(nextSlot({ time: "07:00", days: [] }, B, Date.now()), null);
});

test("zone validation", () => {
  assert.ok(isValidZone("Europe/Berlin"));
  assert.equal(isValidZone("Mars/Base"), false);
  assert.equal(isValidZone(""), false);
});
