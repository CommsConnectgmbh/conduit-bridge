import { test } from "node:test";
import assert from "node:assert/strict";
import { contentLines, eventsInWindow, eventsText, parseRule, seriesDates } from "../src/ics.mjs";

const TZ = "Europe/Berlin";
const cal = (...evs) => ["BEGIN:VCALENDAR", "VERSION:2.0", ...evs.flatMap((e) => ["BEGIN:VEVENT", ...e, "END:VEVENT"]), "END:VCALENDAR"].join("\r\n");
const win = (text, fromDate = "2026-11-28", toDate = "2026-11-29") => eventsInWindow(text, { tz: TZ, fromDate, toDate });
const lines = (r) => eventsText(r.events, TZ).split("\n").filter(Boolean);

test("folded lines, escapes and quoted parameters", () => {
  const l = contentLines('SUMMARY:Long\r\n  title\r\nDTSTART;TZID="Europe/Berlin":20261128T090000');
  assert.deepEqual(l[0], ["SUMMARY", {}, "Long title"]);
  assert.deepEqual(l[1], ["DTSTART", { TZID: "Europe/Berlin" }, "20261128T090000"]);
  const r = win(cal(["UID:1", "SUMMARY:Call\\, then lunch\\nwith Anna", "DTSTART;TZID=Europe/Berlin:20261128T090000", "DTEND;TZID=Europe/Berlin:20261128T100000", "LOCATION:Room 1"]));
  assert.deepEqual(lines(r), ["2026-11-28 09:00-10:00: Call, then lunch with Anna @ Room 1"]);
});

test("UTC, floating, Windows zone names, all-day and multi-day, cancelled, outside the window", () => {
  const r = win(cal(
    ["UID:a", "SUMMARY:UTC one", "DTSTART:20261128T080000Z", "DTEND:20261128T083000Z"],
    ["UID:b", "SUMMARY:Floating", "DTSTART:20261129T140000", "DURATION:PT45M"],
    ["UID:c", "SUMMARY:Outlook", 'DTSTART;TZID="W. Europe Standard Time":20261129T110000', 'DTEND;TZID="W. Europe Standard Time":20261129T120000'],
    ["UID:d", "SUMMARY:Holiday", "DTSTART;VALUE=DATE:20261127", "DTEND;VALUE=DATE:20261130"],
    ["UID:e", "SUMMARY:Gone", "STATUS:CANCELLED", "DTSTART:20261128T100000Z"],
    ["UID:f", "SUMMARY:Next week", "DTSTART:20261205T100000Z"],
    ["UID:g", "SUMMARY:Yesterday", "DTSTART:20261127T100000Z", "DTEND:20261127T110000Z"],
  ));
  assert.deepEqual(lines(r), [
    "2026-11-28 all day: Holiday",
    "2026-11-28 09:00-09:30: UTC one",
    "2026-11-29 11:00-12:00: Outlook",
    "2026-11-29 14:00-14:45: Floating",
  ]);
});

test("an event running over midnight into the window is listed", () => {
  const r = win(cal(["UID:n", "SUMMARY:Night shift", "DTSTART;TZID=Europe/Berlin:20261127T220000", "DTEND;TZID=Europe/Berlin:20261128T060000"]));
  assert.deepEqual(lines(r), ["2026-11-27 22:00-2026-11-28 06:00: Night shift"]);
});

test("weekly series with BYDAY, EXDATE and a moved instance (RECURRENCE-ID)", () => {
  const r = win(cal(
    ["UID:w", "SUMMARY:Standup", "DTSTART;TZID=Europe/Berlin:20261102T091500", "DTEND;TZID=Europe/Berlin:20261102T093000", "RRULE:FREQ=WEEKLY;BYDAY=MO,SA,SU", "EXDATE;TZID=Europe/Berlin:20261129T091500"],
    ["UID:w", "SUMMARY:Standup (moved)", "RECURRENCE-ID;TZID=Europe/Berlin:20261128T091500", "DTSTART;TZID=Europe/Berlin:20261128T120000", "DTEND;TZID=Europe/Berlin:20261128T121500"],
  ));
  assert.deepEqual(lines(r), ["2026-11-28 12:00-12:15: Standup (moved)"]);
});

test("the wall-clock time survives the switch to winter time", () => {
  // Started in summer time (CEST); on 28.11. still 08:00 local.
  const r = win(cal(["UID:d", "SUMMARY:Gym", "DTSTART;TZID=Europe/Berlin:20260901T080000", "DTEND;TZID=Europe/Berlin:20260901T090000", "RRULE:FREQ=DAILY"]));
  assert.deepEqual(lines(r), ["2026-11-28 08:00-09:00: Gym", "2026-11-29 08:00-09:00: Gym"]);
});

test("COUNT and UNTIL end a series; INTERVAL skips", () => {
  const r = win(cal(
    ["UID:c", "SUMMARY:Five times", "DTSTART;TZID=Europe/Berlin:20261124T100000", "RRULE:FREQ=DAILY;COUNT=5"],
    ["UID:u", "SUMMARY:Until Friday", "DTSTART;TZID=Europe/Berlin:20261120T100000", "RRULE:FREQ=DAILY;UNTIL=20261127T235959Z"],
    ["UID:i", "SUMMARY:Every 2nd day", "DTSTART;TZID=Europe/Berlin:20261126T070000", "RRULE:FREQ=DAILY;INTERVAL=2"],
  ));
  assert.deepEqual(lines(r), ["2026-11-28 07:00: Every 2nd day", "2026-11-28 10:00: Five times"]);
});

test("monthly by ordinal weekday and by month day, yearly, all-day series", () => {
  assert.deepEqual(seriesDates("2026-01-31", parseRule("FREQ=MONTHLY;BYDAY=-1SA"), "2026-12-31").slice(-2), ["2026-11-28", "2026-12-26"]);
  assert.deepEqual(seriesDates("2026-01-15", parseRule("FREQ=MONTHLY;BYMONTHDAY=-1"), "2026-03-31"), ["2026-01-31", "2026-02-28", "2026-03-31"]);
  const r = win(cal(
    ["UID:b", "SUMMARY:Birthday", "DTSTART;VALUE=DATE:19801129", "RRULE:FREQ=YEARLY"],
    ["UID:m", "SUMMARY:Last Saturday", "DTSTART;TZID=Europe/Berlin:20260131T100000", "RRULE:FREQ=MONTHLY;BYDAY=-1SA"],
  ));
  assert.deepEqual(lines(r), ["2026-11-28 10:00: Last Saturday", "2026-11-29 all day: Birthday"]);
});

test("a rule it does not understand is counted, not guessed", () => {
  const r = win(cal(["UID:x", "SUMMARY:Odd", "DTSTART:20261101T100000Z", "RRULE:FREQ=DAILY;BYHOUR=9,17"]));
  assert.equal(r.events.length, 0);
  assert.equal(r.unsupported, 1);
  assert.equal(parseRule("FREQ=SECONDLY"), null);
  assert.equal(parseRule("FREQ=WEEKLY;BYDAY=1MO"), null);
  // Combinations that would be read wrong are refused, not guessed.
  assert.equal(parseRule("FREQ=DAILY;BYMONTHDAY=1"), null);
  assert.equal(parseRule("FREQ=MONTHLY;BYMONTHDAY=1;BYDAY=MO"), null);
  assert.equal(parseRule("FREQ=YEARLY;BYMONTHDAY=1"), null);
  assert.equal(parseRule("FREQ=WEEKLY;INTERVAL=2;WKST=SU;BYDAY=MO,SU"), null);
  assert.ok(parseRule("FREQ=WEEKLY;WKST=SU;BYDAY=MO"), "a week start without an interval changes nothing");
});

test("a long series stays bounded", () => {
  const r = win(cal(["UID:z", "SUMMARY:Daily since 1990", "DTSTART;TZID=Europe/Berlin:19900101T060000", "RRULE:FREQ=DAILY"]));
  assert.deepEqual(lines(r), ["2026-11-28 06:00: Daily since 1990", "2026-11-29 06:00: Daily since 1990"]);
});

test("a weekly series that runs over the weekend still shows on Monday", () => {
  const text = ["BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:wk", "SUMMARY:On call", "DTSTART;TZID=Europe/Berlin:20261106T180000", "DTEND;TZID=Europe/Berlin:20261109T090000", "RRULE:FREQ=WEEKLY", "END:VEVENT", "END:VCALENDAR"].join("\r\n");
  const r = eventsInWindow(text, { tz: "Europe/Berlin", fromDate: "2026-11-30", toDate: "2026-11-30" });
  assert.deepEqual(eventsText(r.events, "Europe/Berlin").split("\n"), ["2026-11-27 18:00-2026-11-30 09:00: On call"]);
});

test("a long yearly all-day series still shows while it lasts", () => {
  const text = ["BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:ab", "SUMMARY:Sabbatical", "DTSTART;VALUE=DATE:20251001", "DTEND;VALUE=DATE:20251201", "RRULE:FREQ=YEARLY", "END:VEVENT", "END:VCALENDAR"].join("\r\n");
  const r = eventsInWindow(text, { tz: "Europe/Berlin", fromDate: "2026-11-28", toDate: "2026-11-28" });
  assert.deepEqual(eventsText(r.events, "Europe/Berlin").split("\n"), ["2026-11-28 all day: Sabbatical"]);
});

test("a long yearly all-day series given by DURATION shows too", () => {
  const text = ["BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:ad", "SUMMARY:Away", "DTSTART;VALUE=DATE:20251001", "DURATION:P61D", "RRULE:FREQ=YEARLY", "END:VEVENT", "END:VCALENDAR"].join("\r\n");
  const r = eventsInWindow(text, { tz: "Europe/Berlin", fromDate: "2026-11-28", toDate: "2026-11-28" });
  assert.deepEqual(eventsText(r.events, "Europe/Berlin").split("\n"), ["2026-11-28 all day: Away"]);
});

test("a duration in days is calendar days across both clock changes", () => {
  const cal = (start, dur) => ["BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:d", "SUMMARY:Trip", `DTSTART;TZID=Europe/Berlin:${start}`, `DURATION:${dur}`, "END:VEVENT", "END:VCALENDAR"].join("\r\n");
  const autumn = eventsInWindow(cal("20261024T090000", "P1D"), { tz: "Europe/Berlin", fromDate: "2026-10-24", toDate: "2026-10-25" });
  assert.deepEqual(eventsText(autumn.events, "Europe/Berlin").split("\n"), ["2026-10-24 09:00-2026-10-25 09:00: Trip"]);
  const spring = eventsInWindow(cal("20260328T090000", "P1DT2H"), { tz: "Europe/Berlin", fromDate: "2026-03-28", toDate: "2026-03-29" });
  assert.deepEqual(eventsText(spring.events, "Europe/Berlin").split("\n"), ["2026-03-28 09:00-2026-03-29 11:00: Trip"]);
  const hours = eventsInWindow(cal("20261024T090000", "PT24H"), { tz: "Europe/Berlin", fromDate: "2026-10-24", toDate: "2026-10-25" });
  assert.deepEqual(eventsText(hours.events, "Europe/Berlin").split("\n"), ["2026-10-24 09:00-2026-10-25 08:00: Trip"], "24 hours stay 24 hours");
});

test("an instance in the gap of the clock change is skipped and not counted (RFC 5545)", () => {
  const text = ["BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:g", "SUMMARY:Early", "DTSTART;TZID=Europe/Berlin:20260328T023000", "RRULE:FREQ=DAILY;COUNT=3", "END:VEVENT", "END:VCALENDAR"].join("\r\n");
  const r = eventsInWindow(text, { tz: "Europe/Berlin", fromDate: "2026-03-28", toDate: "2026-04-01" });
  assert.deepEqual(eventsText(r.events, "Europe/Berlin").split("\n"), ["2026-03-28 02:30: Early", "2026-03-30 02:30: Early", "2026-03-31 02:30: Early"]);
});

test("RDATE adds single instances; RANGE=THISANDFUTURE and periods are reported, not shown wrong", () => {
  const cal = (...lines) => ["BEGIN:VCALENDAR", ...lines, "END:VCALENDAR"].join("\r\n");
  const w = (t) => eventsInWindow(t, { tz: "Europe/Berlin", fromDate: "2026-11-28", toDate: "2026-11-29" });
  const rd = w(cal("BEGIN:VEVENT", "UID:r", "SUMMARY:Extra", "DTSTART;TZID=Europe/Berlin:20261127T090000", "RDATE;TZID=Europe/Berlin:20261128T090000,20261129T090000", "EXDATE;TZID=Europe/Berlin:20261129T090000", "END:VEVENT"));
  assert.deepEqual(eventsText(rd.events, "Europe/Berlin").split("\n"), ["2026-11-28 09:00: Extra"]);
  const tf = w(cal(
    "BEGIN:VEVENT", "UID:t", "SUMMARY:Daily", "DTSTART;TZID=Europe/Berlin:20261126T090000", "RRULE:FREQ=DAILY", "END:VEVENT",
    "BEGIN:VEVENT", "UID:t", "SUMMARY:Daily", "RECURRENCE-ID;RANGE=THISANDFUTURE;TZID=Europe/Berlin:20261127T090000", "DTSTART;TZID=Europe/Berlin:20261127T110000", "END:VEVENT"));
  assert.equal(tf.unsupported, 1);
  assert.ok(!eventsText(tf.events, "Europe/Berlin").includes("09:00"), "never the old time after the change");
  const per = w(cal("BEGIN:VEVENT", "UID:p", "SUMMARY:P", "DTSTART;TZID=Europe/Berlin:20261127T090000", "RDATE;VALUE=PERIOD:20261128T080000Z/PT1H", "END:VEVENT"));
  assert.equal(per.unsupported, 1);
});

test("a zone defined only in the file is reported; rule and RDATE naming the same instance show it once", () => {
  const cal = (...lines) => ["BEGIN:VCALENDAR", ...lines, "END:VCALENDAR"].join("\r\n");
  const w = (t) => eventsInWindow(t, { tz: "Europe/Berlin", fromDate: "2026-11-28", toDate: "2026-11-29" });
  const own = w(cal("BEGIN:VTIMEZONE", "TZID:Custom-Eastern", "BEGIN:STANDARD", "TZOFFSETFROM:-0500", "TZOFFSETTO:-0500", "DTSTART:19700101T000000", "END:STANDARD", "END:VTIMEZONE",
    "BEGIN:VEVENT", "UID:z", "SUMMARY:Call", "DTSTART;TZID=Custom-Eastern:20261128T090000", "DTEND;TZID=Custom-Eastern:20261128T100000", "END:VEVENT"));
  assert.equal(own.events.length, 0, "not placed at a guessed time");
  assert.equal(own.unsupported, 1);
  const dup = w(cal("BEGIN:VEVENT", "UID:d", "SUMMARY:Twice", "DTSTART;TZID=Europe/Berlin:20261128T090000", "RRULE:FREQ=DAILY;COUNT=2", "RDATE;TZID=Europe/Berlin:20261128T090000,20261129T090000", "END:VEVENT"));
  assert.deepEqual(eventsText(dup.events, "Europe/Berlin").split("\n"), ["2026-11-28 09:00: Twice", "2026-11-29 09:00: Twice"]);
});
