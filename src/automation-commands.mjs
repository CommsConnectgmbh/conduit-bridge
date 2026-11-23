// The owner's `collect` and `deliver` commands of an automation: run without a
// shell, in their own process group, with a minimal environment, a time limit
// and an output limit; stoppable as a group by the emergency stop.
//
// The collect output format (version 1) is fixed and checked here. The bridge
// renders the fact header from it itself, so counts in the briefing come from
// the owner's script, never from the model.

import { spawn } from "node:child_process";
import { SAFE_SOURCE_ID } from "./automation-text.mjs";

export const COLLECT_TIMEOUT_MS = 120_000;
export const DELIVER_TIMEOUT_MS = 60_000;
export const MAX_COLLECT_BYTES = 512 * 1024;
export const MAX_SOURCES = 20;
export const MAX_SOURCE_TEXT = 60_000;
const FIXED_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

/** No bridge secrets, no inherited PATH: a fixed, small environment. */
export function commandEnv(env = process.env, tz = null) {
  const out = { PATH: FIXED_PATH, LANG: env.LANG || "en_US.UTF-8" };
  for (const k of ["HOME", "USER", "LOGNAME", "TMPDIR"]) if (typeof env[k] === "string") out[k] = env[k];
  if (tz) out.TZ = tz;
  return out;
}

/**
 * Resolves { code, signal, stdout, tooLarge, timedOut, stopped, spawnError }.
 * `register(handle, active)` is told about the process so a stop can reach it.
 */
export function runCommand({ argv, stdin = "", timeoutMs, maxBytes = 64 * 1024, env, cwd, register = null, spawnFn = spawn }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnFn(argv[0], argv.slice(1), { cwd, env, stdio: ["pipe", "pipe", "ignore"], detached: true, shell: false });
    } catch {
      resolve({ code: null, signal: null, stdout: "", tooLarge: false, timedOut: false, stopped: false, spawnError: true });
      return;
    }
    const chunks = [];
    let size = 0;
    let tooLarge = false, timedOut = false, stopped = false, spawnError = false, done = false;
    const killGroup = (sig) => { try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch { /* gone */ } } };
    const end = () => {
      if (done) return;
      killGroup("SIGTERM");
      const t = setTimeout(() => killGroup("SIGKILL"), 3000); t.unref?.();
    };
    const handle = { stop: () => { stopped = true; end(); }, pid: child.pid };
    register?.(handle, true);
    const timer = setTimeout(() => { timedOut = true; end(); }, timeoutMs); timer.unref?.();
    child.stdout.on("data", (c) => {
      if (tooLarge) return;
      size += c.length;
      if (size > maxBytes) { tooLarge = true; end(); return; }
      chunks.push(c);
    });
    child.stdin.on("error", () => {});
    child.on("error", () => { spawnError = true; });
    child.on("close", (code, signal) => {
      done = true;
      clearTimeout(timer);
      register?.(handle, false);
      resolve({ code, signal, stdout: Buffer.concat(chunks).toString("utf8"), tooLarge, timedOut, stopped, spawnError });
    });
    child.stdin.end(stdin);
  });
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;
const CTRL_RE = /[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
const STATUSES = new Set(["ok", "error", "truncated"]);
const countOk = (v) => v === null || v === undefined || (Number.isInteger(v) && v >= 0 && v < 1e7);

/**
 * Parse and check collect output (format version 1). Returns
 * { ok, errorClass, sources } where every source is clean: id safe, title
 * short and without control characters, counts integers, time ISO.
 */
export function parseCollectOutput(stdout) {
  let j;
  try { j = JSON.parse(stdout); } catch { return { ok: false, errorClass: "collect_invalid", sources: [] }; }
  if (!j || j.version !== 1 || !Array.isArray(j.sources) || !j.sources.length || j.sources.length > MAX_SOURCES) {
    return { ok: false, errorClass: "collect_invalid", sources: [] };
  }
  const ids = new Set();
  const sources = [];
  for (const s of j.sources) {
    if (!s || typeof s !== "object") return { ok: false, errorClass: "collect_invalid", sources: [] };
    const id = String(s.id || "");
    if (!SAFE_SOURCE_ID.test(id) || ids.has(id)) return { ok: false, errorClass: "collect_invalid", sources: [] };
    ids.add(id);
    const title = String(s.title || "").replace(CTRL_RE, "").replace(/\s+/g, " ").trim().slice(0, 80);
    if (!title || !STATUSES.has(s.status) || !countOk(s.count) || !countOk(s.newCount)) {
      return { ok: false, errorClass: "collect_invalid", sources: [] };
    }
    if (typeof s.fetchedAt !== "string" || !ISO_RE.test(s.fetchedAt) || Number.isNaN(Date.parse(s.fetchedAt))) {
      return { ok: false, errorClass: "collect_invalid", sources: [] };
    }
    let text = typeof s.text === "string" ? s.text.replace(CTRL_RE, "") : "";
    let status = s.status;
    if (text.length > MAX_SOURCE_TEXT) { text = text.slice(0, MAX_SOURCE_TEXT); status = "truncated"; }
    sources.push({ id, title, status, count: s.count ?? null, newCount: s.newCount ?? null, fetchedAt: s.fetchedAt, text });
  }
  return { ok: true, errorClass: null, sources };
}
