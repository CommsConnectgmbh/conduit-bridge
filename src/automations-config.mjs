// automations.json: what the owner of this bridge schedules (Conduit 2.0,
// phase 4). Off unless the file exists. Fails CLOSED: anything unexpected
// disables the whole feature with a class the app can show, never a partial or
// "best effort" configuration.
//
// The file names commands this bridge will run unattended, so it is treated
// like a crontab of a privileged user:
//   - the file is owned by the bridge's user and readable by nobody else
//     (mode 0600 or stricter), its folder is not writable by group or others;
//   - `collect` and `deliver` are argv arrays (never a shell string) whose
//     program is an absolute path to a regular file owned by this user or
//     root and not writable by group or others. Checked on load and again
//     right before every run (checkExecutable), so swapping the file later
//     does not slip through;
//   - unknown fields are refused, so a typo cannot silently turn a protection
//     off and no field can widen what a scheduled run may do (it always runs
//     without tools, see agent-policy.mjs claudeScheduledArgs).
//
// Example:
// {
//   "version": 1,
//   "owner": "me@example.com",
//   "tz": "Europe/Berlin",
//   "push": { "contact": "mailto:me@example.com" },
//   "automations": [{
//     "id": "briefing", "title": "Morning briefing",
//     "schedule": { "time": "07:00", "days": [1,2,3,4,5,6,7] },
//     "prompt": "Summarise …",
//     "collect": ["/Users/me/.local/bin/briefing-collect"],
//     "deliver": ["/Users/me/.local/bin/briefing-deliver"],
//     "push": true
//   }]
// }

import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { isValidZone, parseTime, systemZone } from "./schedule-time.mjs";

export const AUTOMATIONS_FILE = "automations.json";
export const MAX_AUTOMATIONS = 10;
export const MAX_PROMPT_CHARS = 8000;
export const DEFAULT_WINDOW_HOURS = 6;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}$/;

const TOP_KEYS = new Set(["version", "owner", "tz", "push", "automations"]);
const AUTO_KEYS = new Set(["id", "title", "schedule", "prompt", "collect", "deliver", "deliverFull", "push", "windowHours"]);
const SCHED_KEYS = new Set(["time", "days"]);
const PUSH_KEYS = new Set(["contact"]);

class ConfigError extends Error {
  constructor(cls, message) { super(message); this.cls = cls; }
}

function onlyKeys(obj, allowed, where) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new ConfigError("invalid_config", `${where} must be an object`);
  for (const k of Object.keys(obj)) if (!allowed.has(k)) throw new ConfigError("invalid_config", `${where}: unknown field "${k}"`);
}

function uid() {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

/** Owner-only file in a folder nobody else can write to. */
function checkPrivateFile(path) {
  let st;
  try { st = statSync(path); } catch { throw new ConfigError("not_configured", "no automations file"); }
  if (!st.isFile()) throw new ConfigError("invalid_config", "automations file is not a regular file");
  const me = uid();
  if (me !== null && st.uid !== me) throw new ConfigError("invalid_config", "automations file is not owned by the bridge user");
  if (st.mode & 0o077) throw new ConfigError("invalid_config", "automations file must be mode 0600 (readable by its owner only)");
  const dir = statSync(dirname(path));
  if (me !== null && dir.uid !== me) throw new ConfigError("invalid_config", "folder of the automations file is not owned by the bridge user");
  if (dir.mode & 0o022) throw new ConfigError("invalid_config", "folder of the automations file must not be writable by group or others");
}

/**
 * A program the bridge may run unattended. Throws ConfigError. Called at load
 * and again immediately before each run.
 */
export function checkExecutable(path) {
  if (typeof path !== "string" || !isAbsolute(path)) throw new ConfigError("invalid_config", "command must start with an absolute path");
  let st;
  try { st = statSync(path); } catch { throw new ConfigError("invalid_config", "command does not exist"); }
  if (!st.isFile()) throw new ConfigError("invalid_config", "command is not a regular file");
  const me = uid();
  if (me !== null && st.uid !== me && st.uid !== 0) throw new ConfigError("invalid_config", "command is not owned by the bridge user or root");
  if (st.mode & 0o022) throw new ConfigError("invalid_config", "command must not be writable by group or others");
  if (!(st.mode & 0o100)) throw new ConfigError("invalid_config", "command is not executable");
  const dir = statSync(dirname(path));
  if (dir.mode & 0o002 && !(dir.mode & 0o1000)) throw new ConfigError("invalid_config", "folder of the command is writable by everyone");
}

function argv(v, where) {
  if (!Array.isArray(v) || v.length < 1 || v.length > 12) throw new ConfigError("invalid_config", `${where} must be an array of 1 to 12 strings (no shell string)`);
  for (const a of v) {
    if (typeof a !== "string" || !a || a.length > 300 || /[\0\r\n]/.test(a)) throw new ConfigError("invalid_config", `${where}: every entry must be a non-empty single-line string`);
  }
  checkExecutable(v[0]);
  return [...v];
}

function plainText(v, where, max) {
  if (typeof v !== "string" || !v.trim() || v.length > max || /[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(v)) {
    throw new ConfigError("invalid_config", `${where} must be text of 1 to ${max} characters`);
  }
  return v.trim();
}

/** Validate a parsed object. Pure apart from the file checks on commands. */
export function validateConfig(raw, { knownOwners = [] } = {}) {
  onlyKeys(raw, TOP_KEYS, "automations.json");
  if (raw.version !== 1) throw new ConfigError("invalid_config", "version must be 1");
  const owner = String(raw.owner || "").trim().toLowerCase();
  if (!EMAIL_RE.test(owner)) throw new ConfigError("no_owner", "owner must be the e-mail address of this bridge's account");
  if (!knownOwners.map((e) => String(e).toLowerCase()).includes(owner)) {
    throw new ConfigError("no_owner", "owner does not match this bridge's account (PAIR_OWNER_EMAIL or an existing chat owner)");
  }
  const tz = raw.tz === undefined ? systemZone() : raw.tz;
  if (!isValidZone(tz)) throw new ConfigError("invalid_config", "tz must be an IANA time zone such as Europe/Berlin");

  let push = null;
  if (raw.push !== undefined) {
    onlyKeys(raw.push, PUSH_KEYS, "push");
    // Sent to the push services (Apple, Google …) in every request: an https
    // URL keeps a personal address out of it.
    if (!/^(mailto:[^\s@]+@[^\s@]+|https:\/\/[^\s]{3,200})$/.test(String(raw.push.contact || ""))) throw new ConfigError("invalid_config", "push.contact must be a mailto: address or an https: URL (push services require a contact)");
    push = { contact: raw.push.contact };
  }

  if (!Array.isArray(raw.automations) || !raw.automations.length || raw.automations.length > MAX_AUTOMATIONS) {
    throw new ConfigError("invalid_config", `automations must list 1 to ${MAX_AUTOMATIONS} entries`);
  }
  const ids = new Set();
  const automations = raw.automations.map((a, i) => {
    const where = `automations[${i}]`;
    onlyKeys(a, AUTO_KEYS, where);
    if (!ID_RE.test(String(a.id || ""))) throw new ConfigError("invalid_config", `${where}.id must be lowercase letters, digits and dashes`);
    if (ids.has(a.id)) throw new ConfigError("invalid_config", `${where}.id is used twice`);
    ids.add(a.id);
    onlyKeys(a.schedule, SCHED_KEYS, `${where}.schedule`);
    try { parseTime(a.schedule.time); } catch { throw new ConfigError("invalid_config", `${where}.schedule.time must be HH:MM`); }
    const days = a.schedule.days;
    if (!Array.isArray(days) || !days.length || days.some((d) => !Number.isInteger(d) || d < 1 || d > 7) || new Set(days).size !== days.length) {
      throw new ConfigError("invalid_config", `${where}.schedule.days must list ISO weekdays 1 (Monday) to 7 (Sunday) once each`);
    }
    for (const b of ["deliverFull", "push"]) {
      if (a[b] !== undefined && typeof a[b] !== "boolean") throw new ConfigError("invalid_config", `${where}.${b} must be true or false`);
    }
    if (a.push === true && !push) throw new ConfigError("invalid_config", `${where}.push needs push.contact at the top level`);
    const windowHours = a.windowHours === undefined ? DEFAULT_WINDOW_HOURS : a.windowHours;
    if (!Number.isInteger(windowHours) || windowHours < 1 || windowHours > 12) throw new ConfigError("invalid_config", `${where}.windowHours must be 1 to 12`);
    return {
      id: a.id,
      title: plainText(a.title, `${where}.title`, 80),
      schedule: { time: a.schedule.time, days: [...days].sort() },
      prompt: plainText(a.prompt, `${where}.prompt`, MAX_PROMPT_CHARS),
      collect: a.collect === undefined ? null : argv(a.collect, `${where}.collect`),
      deliver: a.deliver === undefined ? null : argv(a.deliver, `${where}.deliver`),
      deliverFull: a.deliverFull === true,
      push: a.push === true,
      windowMs: windowHours * 3600000,
    };
  });
  return { owner, tz, push, automations };
}

/**
 * Read and validate the file. Never throws: returns { enabled, reason, detail,
 * config }. `reason` is a fixed class for the app; `detail` is for the log.
 */
export function loadAutomationsConfig(path, opts = {}) {
  try {
    checkPrivateFile(path);
    let raw;
    try { raw = JSON.parse(readFileSync(path, "utf8")); } catch { throw new ConfigError("invalid_config", "automations file is not valid JSON"); }
    return { enabled: true, reason: null, detail: null, config: validateConfig(raw, opts) };
  } catch (e) {
    return { enabled: false, reason: e.cls || "invalid_config", detail: String(e.message || e).slice(0, 300), config: null };
  }
}

export { ConfigError };
