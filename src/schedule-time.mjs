// Wall-clock arithmetic for scheduled automations, in an explicit IANA zone.
//
// Why not `new Date(y, m, d, h, mi)`: it uses the process zone, and for a time
// that does not exist (spring forward, 02:30 in Berlin) it silently moves
// forward by the gap (03:30), not to the first valid minute (03:00). A
// briefing set for 02:30 would then run an hour late on that one day, and a
// change of the Mac's zone would move every slot without anyone noticing.
//
// Rules:
//   - A slot is a local wall-clock time on a local date in `tz`.
//   - A time that does not exist on that date (gap) runs at the first minute
//     that does.
//   - A time that exists twice (fall back) means its FIRST occurrence; the
//     store's unique index on (automation, date) keeps the second from running.
//   - Weekdays are ISO 8601: 1 = Monday … 7 = Sunday.

const fmtCache = new Map();
function fmt(tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

const WEEKDAYS = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/** The zone this process runs in, as an IANA name. */
export function systemZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function isValidZone(tz) {
  if (typeof tz !== "string" || !tz) return false;
  try { fmt(tz); return true; } catch { return false; }
}

/** Local calendar parts of an instant in `tz`. */
export function partsIn(ms, tz) {
  const o = {};
  for (const p of fmt(tz).formatToParts(new Date(ms))) o[p.type] = p.value;
  return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour, mi: +o.minute, wd: WEEKDAYS[o.weekday] };
}

const pad = (n) => String(n).padStart(2, "0");
export const dateKey = ({ y, m, d }) => `${y}-${pad(m)}-${pad(d)}`;

/** "YYYY-MM-DD" of an instant in `tz`. */
export function localDate(ms, tz) {
  return dateKey(partsIn(ms, tz));
}

export function parseDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s));
  if (!m) throw new Error("date must be YYYY-MM-DD");
  return { y: +m[1], m: +m[2], d: +m[3] };
}

/** ISO weekday (1 = Monday) of a calendar date; independent of any zone. */
export function isoWeekday(dateStr) {
  const { y, m, d } = parseDate(dateStr);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return wd === 0 ? 7 : wd;
}

export function addDays(dateStr, n) {
  const { y, m, d } = parseDate(dateStr);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return dateKey({ y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() });
}

// Minutes of a local wall clock as one comparable number.
const wall = ({ y, m, d, h, mi }) => Date.UTC(y, m - 1, d, h, mi) / 60000;

/**
 * The instant at which the local wall clock in `tz` first shows `date` `hh:mm`,
 * or, if that time does not exist on that date, the first minute after it.
 */
export function zonedTime(dateStr, hh, mm, tz) {
  const { y, m, d } = parseDate(dateStr);
  const W = Date.UTC(y, m - 1, d, hh, mm);
  const wallMs = (t) => wall(partsIn(t, tz)) * 60000;
  const offsetAt = (t) => wallMs(t) - t;
  // The offsets in force a day before and after cover both sides of any
  // transition near the wanted time (zones change at most twice a year).
  const offs = [...new Set([offsetAt(W - 86400000), offsetAt(W), offsetAt(W + 86400000)])];
  const cands = offs.map((o) => W - o);
  const exact = cands.filter((t) => wallMs(t) === W).sort((a, b) => a - b);
  // Exists (once or, in a fold, twice): the earliest instant.
  if (exact.length) return exact[0];
  // Gap: the first minute whose wall clock is at or past the wanted time.
  let lo = Math.min(...cands), hi = Math.max(...cands);
  if (wallMs(lo) >= W) return lo;
  while (hi - lo > 60000) {
    const mid = lo + Math.floor((hi - lo) / 120000) * 60000;
    if (wallMs(mid) >= W) hi = mid; else lo = mid;
  }
  return hi;
}

/** [start, end) of a local calendar day in ms. 23 or 25 hours around DST. */
export function dayBounds(dateStr, tz) {
  return [zonedTime(dateStr, 0, 0, tz), zonedTime(addDays(dateStr, 1), 0, 0, tz)];
}

export function parseTime(s) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(s));
  if (!m) throw new Error("time must be HH:MM");
  return { hh: +m[1], mm: +m[2] };
}

/** The slot of `dateStr` for a schedule, or null when that weekday is off. */
export function slotOn(schedule, dateStr, tz) {
  if (!schedule.days.includes(isoWeekday(dateStr))) return null;
  const { hh, mm } = parseTime(schedule.time);
  return { slotDate: dateStr, slotAt: zonedTime(dateStr, hh, mm, tz) };
}

/**
 * Today's slot if it has started and is still inside its window, else null.
 * "Today" is the local date of `now`; a slot of yesterday whose window reaches
 * past midnight is also considered (a 23:30 job with a 6 h window).
 */
export function dueSlot(schedule, tz, now, windowMs) {
  const today = localDate(now, tz);
  for (const date of [today, addDays(today, -1)]) {
    const s = slotOn(schedule, date, tz);
    if (s && now >= s.slotAt && now < s.slotAt + windowMs) return s;
  }
  return null;
}

/** The next slot strictly after `now`, searching at most 8 days ahead. */
export function nextSlot(schedule, tz, now) {
  const today = localDate(now, tz);
  for (let i = 0; i <= 8; i++) {
    const s = slotOn(schedule, addDays(today, i), tz);
    if (s && s.slotAt > now) return s;
  }
  return null;
}
