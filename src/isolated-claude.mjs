// One Claude run in the scheduled profile: no tools, no MCP, no settings, no
// hooks, no session persistence (agent-policy.mjs claudeScheduledArgs). Used
// for scheduled briefings and for follow-up questions in the chats they
// create. Deliberately separate from the warm pool and the normal one-shot
// path: nothing here can be reused by, or reuse, a process that has tools.
//
// Defence in depth: the CLI reports what it actually loaded in its first
// event (`system/init`). If that shows any tool, MCP server, slash command or
// a permission mode other than dontAsk, the run is killed before the model
// answers and fails with `profile_mismatch`. A future CLI that changes what
// `--tools ""` means therefore fails closed instead of running with tools.
//
// The prompt goes in on stdin, never in argv: it carries other people's text
// (mail, calendar) and can be long.

import { spawn } from "node:child_process";
import { claudeScheduledArgs } from "./agent-policy.mjs";

export const SUMMARIZE_DEADLINE_MS = 10 * 60 * 1000;
/** The CLI reports what it loaded within seconds; no report, no run. */
export const INIT_TIMEOUT_MS = 30_000;
export const MAX_ANSWER_CHARS = 16_000;
const MAX_LINE_BYTES = 4 * 1024 * 1024;
const MODEL_RE = /^[A-Za-z0-9._:\[\]-]{1,80}$/;

// What the scheduled process may see from the bridge's environment. Not the
// bridge's secrets (BRIDGE_SECRET, VAPID key, tunnel tokens): the model has no
// tools to read them, but an environment that never had them cannot leak them.
const ENV_ALLOW = ["HOME", "USER", "LOGNAME", "PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR",
  "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR",
  "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy"];

export function scheduledEnv(env = process.env) {
  const out = { FORCE_COLOR: "0", NO_COLOR: "1" };
  for (const k of ENV_ALLOW) if (typeof env[k] === "string") out[k] = env[k];
  return out;
}

/**
 * The init event must POSITIVELY describe a process with nothing it could act
 * with: every field present and empty. A missing or malformed field is a
 * problem, never "probably fine".
 */
export function checkInit(ev) {
  const problems = [];
  if (!ev || typeof ev !== "object") return ["init_invalid"];
  if (!Array.isArray(ev.tools) || ev.tools.length) problems.push("tools");
  if (!Array.isArray(ev.mcp_servers) || ev.mcp_servers.length) problems.push("mcp");
  if (!Array.isArray(ev.slash_commands) || ev.slash_commands.length) problems.push("slash_commands");
  if (ev.permissionMode !== "dontAsk") problems.push("permission_mode");
  return problems;
}

/**
 * Run once. Resolves (never rejects) with
 *   { ok, text, truncated, usage: {in,out}|null, durationMs, errorClass, problems }
 * errorClass ∈ null | "profile_mismatch" | "summarize_timeout" | "summarize_failed" | "stopped" | "spawn".
 *
 * `register(handle)` lets the caller stop the run (emergency stop): handle.stop().
 * `onText(text)` gets the whole answer once, after the run was checked end to end
 * (follow-up chats). Never earlier: nothing unconfirmed reaches a client.
 */
export function runIsolatedClaude({ bin = "claude", input, cwd, model = null, env = process.env,
  deadlineMs = SUMMARIZE_DEADLINE_MS, initTimeoutMs = INIT_TIMEOUT_MS, maxChars = MAX_ANSWER_CHARS, onText = null, register = null, spawnFn = spawn, now = Date.now }) {
  return new Promise((resolve) => {
    const started = now();
    const args = claudeScheduledArgs({ model: model && MODEL_RE.test(model) ? model : null });
    let child;
    try {
      child = spawnFn(bin, args, { cwd, env: scheduledEnv(env), stdio: ["pipe", "pipe", "pipe"], detached: true });
    } catch {
      resolve({ ok: false, text: "", truncated: false, usage: null, durationMs: 0, errorClass: "spawn", problems: [] });
      return;
    }
    let text = "";
    let truncated = false;
    let finished = false;
    let errorClass = null;
    let problems = [];
    let usage = null;
    let resultSeen = false;
    // Nothing the process says counts until its init event has confirmed the
    // profile (fail closed): an answer before init, a missing, malformed or
    // late init all stop the run as profile_mismatch and keep no text.
    let initOk = false;
    let resultIsError = false;
    let buf = "";

    const killGroup = (sig) => {
      try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch { /* gone */ } }
    };
    const stop = (cls) => {
      if (finished) return;
      if (!errorClass) errorClass = cls;
      killGroup("SIGTERM");
      const t = setTimeout(() => killGroup("SIGKILL"), 3000);
      t.unref?.();
    };
    const handle = { stop: () => stop("stopped"), killNow: () => killGroup("SIGKILL"), pid: child.pid };
    register?.(handle, true);

    // Without a confirmed init the run never was this profile: that is the
    // reason, whichever timer fires first.
    const deadline = setTimeout(() => {
      if (!initOk) { problems = ["init_missing"]; stop("profile_mismatch"); } else stop("summarize_timeout");
    }, deadlineMs);
    const initTimer = setTimeout(() => {
      if (!initOk) { problems = ["init_missing"]; stop("profile_mismatch"); }
    }, Math.min(initTimeoutMs, deadlineMs));
    initTimer.unref?.();
    deadline.unref?.();

    const addText = (delta) => {
      if (!delta || truncated || !initOk || errorClass) return;
      const room = maxChars - text.length;
      if (delta.length > room) { delta = delta.slice(0, Math.max(0, room)); truncated = true; }
      text += delta;
    };

    const onEvent = (ev) => {
      // Once stopped, nothing that still arrives (a late init included) can
      // confirm the run again or change why it was stopped.
      if (errorClass) return;
      if (ev.type === "system" && ev.subtype === "init") {
        // Every init is checked, a repeated one too: a later report that
        // contradicts the first means the process is not what was confirmed.
        problems = checkInit(ev);
        if (problems.length) { stop("profile_mismatch"); return; }
        initOk = true;
        clearTimeout(initTimer);
        return;
      }
      if (!initOk) {
        // Anything else before a confirmed init: the run is not trusted.
        if (!problems.length) problems = ["output_before_init"];
        stop("profile_mismatch");
        return;
      }
      if (ev.type === "assistant" && ev.message && Array.isArray(ev.message.content)) {
        for (const c of ev.message.content) if (c.type === "text" && typeof c.text === "string") addText(c.text);
        return;
      }
      if (ev.type === "result") {
        resultSeen = true;
        resultIsError = ev.is_error === true;
        // With stream-json the text came in assistant events already; the
        // result repeats it. Only fall back to it when nothing streamed.
        if (!text && typeof ev.result === "string") addText(ev.result);
        const u = ev.usage || {};
        const tin = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        usage = { in: tin, out: u.output_tokens || 0 };
      }
    };

    child.stdout.setEncoding("utf8");
    const feed = (line) => {
      if (!line.trim()) return;
      // A line that is not a valid event could have been anything, an init
      // included: the run is not trusted (fail closed).
      let ev; try { ev = JSON.parse(line); } catch { problems = problems.length ? problems : ["unreadable_output"]; stop("summarize_failed"); return; }
      try { onEvent(ev); } catch { problems = problems.length ? problems : ["unreadable_output"]; stop("summarize_failed"); }
    };
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      if (buf.length > MAX_LINE_BYTES) { stop("summarize_failed"); buf = ""; return; }
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        feed(line);
      }
    });
    child.stderr.on("data", () => { /* not surfaced: may echo input */ });
    child.stdin.on("error", () => { /* EPIPE: the process died early; close tells why */ });
    child.on("error", () => { if (!errorClass) errorClass = "spawn"; });
    child.on("close", (code) => {
      // A last event without a trailing newline goes through the same gate.
      if (buf) { const rest = buf; buf = ""; feed(rest); }
      finished = true;
      clearTimeout(deadline);
      clearTimeout(initTimer);
      if (!initOk && !errorClass) { errorClass = "profile_mismatch"; if (!problems.length) problems = ["init_missing"]; }

      // Nothing of this run may outlive it (see automation-commands.mjs).
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* group already empty */ }
      register?.(handle, false);
      const durationMs = now() - started;
      if (!errorClass && (!resultSeen || resultIsError || code !== 0)) errorClass = "summarize_failed";
      if (!errorClass && !text.trim()) errorClass = "summarize_failed";
      // A run that did not end cleanly keeps no answer, whatever the reason:
      // it was never confirmed whole.
      if (errorClass) text = "";
      // Published only now, after the whole run was checked: a later event
      // (a contradicting init) could still have withdrawn it.
      if (!errorClass && text) onText?.(text);
      resolve({ ok: !errorClass, text, truncated, usage, durationMs, errorClass, problems });
    });
    child.stdin.end(input);
  });
}
