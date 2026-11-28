// Calendar subscription (ICS) for the briefing: parse a VCALENDAR and list
// the events that touch a window of local days (3.9.0). No network here; the
// fetch with its address checks is in collectors.mjs.
//
// Supported: VEVENT with DTSTART/DTEND/DURATION (date or date-time, UTC, TZID
// or floating), SUMMARY, LOCATION, STATUS:CANCELLED (dropped), RRULE with FREQ
// DAILY/WEEKLY/MONTHLY/YEARLY, INTERVAL, COUNT, UNTIL, BYDAY (plain weekdays;
// for MONTHLY also an ordinal such as 1MO or -1FR), BYMONTHDAY, EXDATE, and
// RECURRENCE-ID overrides. Anything else in a rule makes that series count as
// "not understood" and it is reported, never silently treated as a single date.

import { addDays, dateKey, dayBounds, isValidZone, isoWeekday, partsIn, zonedTime } from "./schedule-time.mjs";

/** Local date and HH:MM of an instant. */
function lp(ms, tz) {
  const p = partsIn(ms, tz);
  return { date: dateKey(p), time: `${String(p.h).padStart(2, "0")}:${String(p.mi).padStart(2, "0")}` };
}

export const MAX_EVENTS = 100;
const MAX_EXPAND = 2000;

// Windows names Outlook and Exchange put into TZID.
const WINDOWS_ZONES = {
  "W. Europe Standard Time": "Europe/Berlin",
  "Central Europe Standard Time": "Europe/Budapest",
  "Central European Standard Time": "Europe/Warsaw",
  "Romance Standard Time": "Europe/Paris",
  "GMT Standard Time": "Europe/London",
  "Greenwich Standard Time": "Atlantic/Reykjavik",
  "E. Europe Standard Time": "Europe/Chisinau",
  "FLE Standard Time": "Europe/Kiev",
  "GTB Standard Time": "Europe/Bucharest",
  "Russian Standard Time": "Europe/Moscow",
  "Eastern Standard Time": "America/New_York",
  "Central Standard Time": "America/Chicago",
  "Mountain Standard Time": "America/Denver",
  "Pacific Standard Time": "America/Los_Angeles",
  "UTC": "UTC",
  "Coordinated Universal Time": "UTC",
};

/** Unfold lines (RFC 5545 3.1) and split into [name, params, value]. */
export function contentLines(text) {
  const raw = String(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const lines = [];
  for (const l of raw) {
    if ((l.startsWith(" ") || l.startsWith("\t")) && lines.length) lines[lines.length - 1] += l.slice(1);
    else if (l) lines.push(l);
  }
  return lines.map((l) => {
    // The name and parameters end at the first ":" outside quotes.
    let i = 0, q = false;
    for (; i < l.length; i++) { const c = l[i]; if (c === '"') q = !q; else if (c === ":" && !q) break; }
    const head = l.slice(0, i), value = l.slice(i + 1);
    const parts = head.split(";");
    const params = {};
    for (const p of parts.slice(1)) { const k = p.indexOf("="); if (k > 0) params[p.slice(0, k).toUpperCase()] = p.slice(k + 1).replace(/^"|"$/g, ""); }
    return [parts[0].toUpperCase(), params, value];
  });
}

function unescape(v) {
  return String(v).replace(/\\n/gi, " ").replace(/\\([,;\\])/g, "$1").replace(/\s+/g, " ").trim();
}

function zoneOf(params, fallback) {
  const t = params.TZID;
  if (!t) return fallback;
  if (isValidZone(t)) return t;
  if (WINDOWS_ZONES[t]) return WINDOWS_ZONES[t];
  // "/mozilla.org/20050126_1/Europe/Berlin" and similar prefixes.
  const m = t.match(/([A-Za-z]+\/[A-Za-z_+-]+(?:\/[A-Za-z_+-]+)?)$/);
  if (m && isValidZone(m[1])) return m[1];
  // A zone only defined inside the file (VTIMEZONE): not read here. The
  // caller reports the event instead of placing it at a guessed time.
  return null;
}

/** A DATE or DATE-TIME value: { ms, allDay, date } (date: local YYYY-MM-DD for all-day). */
export function parseTimeValue(value, params, fallbackTz) {
  const v = String(value).trim();
  let m = v.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m || params.VALUE === "DATE") {
    m = m || v.match(/^(\d{4})(\d{2})(\d{2})/);
    if (!m) return null;
    const date = `${m[1]}-${m[2]}-${m[3]}`;
    return { allDay: true, date, ms: zonedTime(date, 0, 0, fallbackTz) };
  }
  m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/);
  if (!m) return null;
  const date = `${m[1]}-${m[2]}-${m[3]}`;
  if (m[7]) return { allDay: false, date: null, ms: Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) };
  const z = zoneOf(params, fallbackTz);
  const tz = z || fallbackTz;
  return { allDay: false, date: null, ms: zonedTime(date, +m[4], +m[5], tz) + (+(m[6] || 0)) * 1000, tz, ...(z ? {} : { unknownZone: true }) };
}

/**
 * { days, ms }: weeks and days are calendar days (RFC 5545 3.3.6: across a
 * clock change a day is not 24 hours), the time part is exact.
 */
function parseDuration(v) {
  const m = String(v).match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return null;
  const sign = m[1] === "-" ? -1 : 1;
  return { days: sign * (+(m[2] || 0) * 7 + +(m[3] || 0)), ms: sign * (((+(m[4] || 0)) * 60 + +(m[5] || 0)) * 60000 + +(m[6] || 0) * 1000) };
}

/** End of an occurrence that starts at `startMs` and lasts `d`, in zone `z`. */
function addDuration(startMs, d, z) {
  if (!d.days) return startMs + d.ms;
  const p = partsIn(startMs, z);
  const shifted = zonedTime(addDays(dateKey(p), d.days), p.h, p.mi, z) + (startMs % 60000);
  return shifted + d.ms;
}
/** Rough length for look-back windows only. */
const roughMs = (d) => (d ? d.days * 86400000 + d.ms : 0);

/** VEVENTs as plain objects. */
export function parseEvents(text, tz) {
  const out = [];
  let ev = null;
  let depth = 0;
  for (const [name, params, value] of contentLines(text)) {
    if (name === "BEGIN") {
      if (value.toUpperCase() === "VEVENT" && depth === 0) { ev = { exdates: [], rdates: [], params: {} }; continue; }
      if (ev) depth++;
      continue;
    }
    if (name === "END") {
      if (ev && depth > 0) { depth--; continue; }
      if (ev && value.toUpperCase() === "VEVENT") { out.push(ev); ev = null; }
      continue;
    }
    if (!ev || depth > 0) continue;
    if (name === "SUMMARY") ev.summary = unescape(value);
    else if (name === "LOCATION") ev.location = unescape(value);
    else if (name === "UID") ev.uid = value.trim();
    else if (name === "STATUS") ev.status = value.trim().toUpperCase();
    else if (name === "DTSTART") { ev.start = parseTimeValue(value, params, tz); ev.startParams = params; ev.startRaw = value.trim(); }
    else if (name === "DTEND") ev.end = parseTimeValue(value, params, tz);
    else if (name === "DURATION") ev.duration = parseDuration(value);
    else if (name === "RRULE") ev.rrule = value.trim();
    else if (name === "EXDATE") for (const x of value.split(",")) { const t = parseTimeValue(x, params, tz); if (t) { ev.exdates.push(t.ms); if (t.unknownZone) ev.zoneUnknown = true; } }
    else if (name === "RDATE") {
      // Extra single dates of a series. Periods (VALUE=PERIOD) are not read:
      // the series is then reported instead of shown without them.
      if (params.VALUE === "PERIOD" || value.includes("/")) ev.rdateUnsupported = true;
      else for (const x of value.split(",")) { const t = parseTimeValue(x, params, tz); if (t) { ev.rdates.push(t); if (t.unknownZone) ev.zoneUnknown = true; } }
    }
    else if (name === "RECURRENCE-ID") {
      ev.recurrenceId = parseTimeValue(value, params, tz);
      if (ev.recurrenceId?.unknownZone) ev.zoneUnknown = true;
      // A change "for this and all later instances": not modelled here.
      if (String(params.RANGE || "").toUpperCase() === "THISANDFUTURE") ev.thisAndFuture = true;
    }
  }
  return out;
}

const WD = { MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6, SU: 7 };

/** `untilTz`: the zone of the series' start; a floating UNTIL is read in it. */
export function parseRule(s, untilTz = "UTC") {
  const r = {};
  for (const p of String(s).split(";")) { const [k, v] = p.split("="); if (k) r[k.toUpperCase()] = v ?? ""; }
  const known = new Set(["FREQ", "INTERVAL", "COUNT", "UNTIL", "BYDAY", "BYMONTHDAY", "WKST"]);
  if (Object.keys(r).some((k) => !known.has(k))) return null;
  if (!["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(r.FREQ)) return null;
  const rule = { freq: r.FREQ, interval: Math.max(1, parseInt(r.INTERVAL || "1", 10) || 1), count: r.COUNT ? parseInt(r.COUNT, 10) : null, until: null, byday: null, bymonthday: null };
  if (r.UNTIL) {
    const u = parseTimeValue(r.UNTIL, {}, untilTz);
    if (!u) return null;
    // A date-only UNTIL includes that whole day.
    rule.until = u.allDay ? u.ms + 86400000 - 1 : u.ms;
    // A date-only UNTIL is a calendar date: kept as one, never via UTC.
    rule.untilDate = u.allDay ? u.date : null;
  }
  if (r.BYDAY) {
    rule.byday = [];
    for (const d of r.BYDAY.split(",")) {
      const m = d.match(/^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/);
      if (!m) return null;
      if (m[1] && rule.freq !== "MONTHLY") return null;
      rule.byday.push({ n: m[1] ? parseInt(m[1], 10) : null, wd: WD[m[2]] });
    }
  }
  if (r.BYMONTHDAY) {
    rule.bymonthday = r.BYMONTHDAY.split(",").map((x) => parseInt(x, 10));
    if (rule.bymonthday.some((x) => !Number.isInteger(x) || x === 0 || x < -31 || x > 31)) return null;
  }
  // Combinations this reader would get wrong are refused (reported, never
  // guessed): BYMONTHDAY outside MONTHLY, BYMONTHDAY together with BYDAY,
  // BYDAY or BYMONTHDAY in a yearly rule, and a week start other than Monday
  // where it changes the result (weekly rules with an interval above 1).
  if (rule.bymonthday && (rule.freq !== "MONTHLY" || rule.byday)) return null;
  if (rule.freq === "YEARLY" && (rule.byday || rule.bymonthday)) return null;
  if (r.WKST && r.WKST !== "MO" && rule.freq === "WEEKLY" && rule.interval > 1) return null;
  return rule;
}

function daysInMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
const pad = (n) => String(n).padStart(2, "0");

/**
 * Local start dates (YYYY-MM-DD) of a series, in its own zone, from the first
 * one on, until `toDate` (inclusive) or the rule ends. Ascending.
 */
export function seriesDates(startDate, rule, toDate, { untilDate = null, fromDate = null, valid = null } = {}) {
  const out = [];
  let count = 0, steps = 0;
  // COUNT needs every occurrence from the start; without it the loop may skip
  // ahead to just before `fromDate`, so an old daily series stays cheap.
  const skip = rule.count === null && fromDate && fromDate > startDate;
  const stop = () => (rule.count !== null && count >= rule.count) || out.length > MAX_EXPAND || ++steps > 200000;
  const push = (d) => {
    if (d < startDate) return true;
    if (untilDate && d > untilDate) return false;
    if (d > toDate) return false;
    // RFC 5545 3.3.10: an instance at a local time that does not exist (in
    // the gap of a clock change) is ignored and does not count for COUNT.
    if (valid && !valid(d)) return true;
    count++;
    if (!fromDate || d >= fromDate) out.push(d);
    return true;
  };
  const daysBetween = (a, b) => Math.round((Date.UTC(...b.split("-").map((x, i) => (i === 1 ? x - 1 : +x))) - Date.UTC(...a.split("-").map((x, i) => (i === 1 ? x - 1 : +x)))) / 86400000);
  const [y0, m0] = startDate.split("-").map(Number);
  if (rule.freq === "DAILY") {
    const i0 = skip ? Math.max(0, Math.floor(daysBetween(startDate, fromDate) / rule.interval) - 1) : 0;
    for (let i = i0, d = addDays(startDate, i0 * rule.interval); d <= toDate && !stop(); i++, d = addDays(startDate, i * rule.interval)) {
      if (rule.byday && !rule.byday.some((b) => b.wd === isoWeekday(d))) continue;
      if (!push(d)) break;
    }
  } else if (rule.freq === "WEEKLY") {
    const days = rule.byday ? rule.byday.map((b) => b.wd).sort() : [isoWeekday(startDate)];
    const monday = addDays(startDate, 1 - isoWeekday(startDate));
    const w0 = skip ? Math.max(0, Math.floor(daysBetween(monday, fromDate) / 7 / rule.interval) - 1) * rule.interval : 0;
    for (let w = w0; !stop(); w += rule.interval) {
      const base = addDays(monday, w * 7);
      if (base > toDate) break;
      let go = true;
      for (const wd of days) { if (stop()) break; if (!push(addDays(base, wd - 1))) { go = false; break; } }
      if (!go) break;
    }
  } else if (rule.freq === "MONTHLY" || rule.freq === "YEARLY") {
    const step = rule.freq === "YEARLY" ? 12 * rule.interval : rule.interval;
    const [fy, fm] = (fromDate || startDate).split("-").map(Number);
    const k0 = skip ? Math.max(0, Math.floor(((fy - y0) * 12 + (fm - m0)) / step) - 1) * step : 0;
    for (let k = k0; !stop(); k += step) {
      const yy = y0 + Math.floor((m0 - 1 + k) / 12), mm = ((m0 - 1 + k) % 12) + 1;
      const first = `${yy}-${pad(mm)}-01`;
      if (first > toDate) break;
      const dim = daysInMonth(yy, mm);
      let days = [];
      if (rule.bymonthday) days = rule.bymonthday.map((x) => (x > 0 ? x : dim + 1 + x)).filter((x) => x >= 1 && x <= dim);
      else if (rule.byday) {
        for (const b of rule.byday) {
          const all = [];
          for (let d = 1; d <= dim; d++) if (isoWeekday(`${yy}-${pad(mm)}-${pad(d)}`) === b.wd) all.push(d);
          if (b.n === null) days.push(...all);
          else { const pick = b.n > 0 ? all[b.n - 1] : all[all.length + b.n]; if (pick) days.push(pick); }
        }
      } else {
        // Same day of the month (and, yearly, the same month) as the start.
        if (rule.freq === "YEARLY" && mm !== m0) continue;
        const d0 = +startDate.slice(8, 10);
        if (d0 <= dim) days = [d0];
      }
      let go = true;
      for (const d of [...new Set(days)].sort((a, b) => a - b)) { if (stop()) break; if (!push(`${yy}-${pad(mm)}-${pad(d)}`)) { go = false; break; } }
      if (!go) break;
    }
  }
  return out;
}

/**
 * Events touching the local days [fromDate, toDate] in `tz`, sorted.
 * Returns { events: [{date, allDay, startMs, endMs, summary, location}], unsupported, total }.
 */
export function eventsInWindow(text, { tz, fromDate, toDate }) {
  const evs = parseEvents(text, tz);
  const [winStart] = dayBounds(fromDate, tz);
  const [, winEnd] = dayBounds(toDate, tz);
  const overrides = new Map(); // uid -> Set of original start ms replaced
  const thisAndFuture = new Set(); // uids of series changed "from here on"
  for (const e of evs) if (e.recurrenceId && e.uid) {
    if (!overrides.has(e.uid)) overrides.set(e.uid, new Set());
    overrides.get(e.uid).add(e.recurrenceId.ms);
    // Changed "from here on", or an override this reader cannot place: the
    // whole series is reported rather than shown half right.
    if (e.thisAndFuture || e.zoneUnknown || e.start?.unknownZone) thisAndFuture.add(e.uid);
  }
  const out = [];
  let unsupported = 0;
  const add = (e, startMs, allDay, date) => {
    let endMs;
    if (e.end) endMs = startMs + (e.end.ms - e.start.ms);
    else if (e.duration) endMs = addDuration(startMs, e.duration, allDay ? tz : (e.start.tz || "UTC"));
    else endMs = allDay ? startMs + 86400000 : startMs;
    if (allDay) {
      // All-day events cover whole local days.
      const days = Math.max(1, Math.round((endMs - startMs) / 86400000));
      const last = addDays(date, days - 1);
      if (last < fromDate || date > toDate) return;
      out.push({ date: date < fromDate ? fromDate : date, allDay: true, startMs, endMs, summary: e.summary || "(no title)", location: e.location || null });
      return;
    }
    if (endMs <= winStart && startMs < winStart) return;
    if (startMs >= winEnd) return;
    if (endMs === startMs && startMs < winStart) return;
    out.push({ date: lp(startMs, tz).date, allDay: false, startMs, endMs, summary: e.summary || "(no title)", location: e.location || null });
  };
  for (const e of evs) {
    if (!e.start || e.status === "CANCELLED") continue;
    if (e.start.unknownZone || e.end?.unknownZone || e.zoneUnknown) { unsupported++; continue; }
    // One instance per start time, however many of rule, RDATE and DTSTART name it.
    const seen = new Set();
    const addOnce = (ms, allDay, date) => { if (seen.has(ms)) return; seen.add(ms); add(e, ms, allDay, date); };
    if (e.recurrenceId) { add(e, e.start.ms, e.start.allDay, e.start.date); continue; }
    // A series this reader cannot place correctly is counted, never shown wrong.
    if (e.rdateUnsupported || ((e.rrule || e.rdates.length) && e.uid && thisAndFuture.has(e.uid))) { unsupported++; continue; }
    const replacedHere = overrides.get(e.uid) || new Set();
    const exHere = new Set(e.exdates);
    // RDATE: extra single instances, with or without a rule.
    for (const rd of e.rdates) {
      if (exHere.has(rd.ms) || replacedHere.has(rd.ms)) continue;
      addOnce(rd.ms, rd.allDay, rd.date);
    }
    if (!e.rrule) { if (!exHere.has(e.start.ms) && !replacedHere.has(e.start.ms)) addOnce(e.start.ms, e.start.allDay, e.start.date); continue; }
    const rule = parseRule(e.rrule, e.start.allDay ? tz : (e.start.tz || "UTC"));
    if (!rule) { unsupported++; continue; }
    const ownTz = e.start.allDay ? tz : (e.start.tz || null);
    const replaced = overrides.get(e.uid) || new Set();
    const exd = new Set(e.exdates);
    if (e.start.allDay) {
      const until = rule.untilDate ?? (rule.until !== null ? lp(rule.until, tz).date : null);
      // Look back as far as one occurrence lasts (an absence from October to
      // December still runs in November).
      const lenMs = e.end ? e.end.ms - e.start.ms : (e.duration ? roughMs(e.duration) : 86400000);
      const lenDays = Math.max(1, Math.round(lenMs / 86400000));
      for (const d of seriesDates(e.start.date, rule, toDate, { untilDate: until, fromDate: addDays(fromDate, -Math.min(400, lenDays + 1)) })) {
        const ms = zonedTime(d, 0, 0, tz);
        if (exd.has(ms) || replaced.has(ms)) continue;
        addOnce(ms, true, d);
      }
    } else {
      // Repeat the wall-clock time in the event's zone (UTC events: in UTC).
      const z = ownTz || "UTC";
      const p = lp(e.start.ms, z);
      const [hh, mi] = p.time.split(":").map(Number);
      const toLocal = addDays(toDate, 1);
      // Look back as far as one occurrence lasts: a weekly Friday-to-Monday
      // series still runs on Monday.
      const len = e.end ? e.end.ms - e.start.ms : roughMs(e.duration);
      const back = Math.min(400, Math.max(2, Math.ceil(len / 86400000) + 1));
      const exists = (d) => { const t = zonedTime(d, hh, mi, z); const q = lp(t, z); return q.date === d && q.time === p.time; };
      for (const d of seriesDates(p.date, rule, toLocal, { fromDate: addDays(fromDate, -back), valid: exists })) {
        const ms = zonedTime(d, hh, mi, z) + (e.start.ms % 60000);
        if (rule.until !== null && ms > rule.until) break;
        if (exd.has(ms) || replaced.has(ms)) continue;
        addOnce(ms, false, null);
      }
    }
  }
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (b.allDay - a.allDay) || a.startMs - b.startMs));
  return { events: out.slice(0, MAX_EVENTS), unsupported, total: out.length };
}

/** Plain text lines for the briefing. */
export function eventsText(events, tz) {
  return events.map((e) => {
    const loc = e.location ? ` @ ${e.location}` : "";
    if (e.allDay) return `${e.date} all day: ${e.summary}${loc}`;
    const s = lp(e.startMs, tz), en = lp(e.endMs, tz);
    const end = e.endMs > e.startMs ? `-${en.date === s.date ? en.time : `${en.date} ${en.time}`}` : "";
    return `${s.date} ${s.time}${end}: ${e.summary}${loc}`;
  }).join("\n");
}
