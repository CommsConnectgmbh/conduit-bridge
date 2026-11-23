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

/** The init event must describe a process with nothing it could act with. */
export function checkInit(ev) {
  const problems = [];
  if (!Array.isArray(ev.tools) || ev.tools.length) problems.push("tools");
  if (!Array.isArray(ev.mcp_servers) || ev.mcp_servers.length) problems.push("mcp");
  if (Array.isArray(ev.slash_commands) && ev.slash_commands.length) problems.push("slash_commands");
  if (ev.permissionMode !== "dontAsk") problems.push("permission_mode");
  return problems;
}

/**
 * Run once. Resolves (never rejects) with
 *   { ok, text, truncated, usage: {in,out}|null, durationMs, errorClass, problems }
 * errorClass ∈ null | "profile_mismatch" | "summarize_timeout" | "summarize_failed" | "stopped" | "spawn".
 *
 * `register(handle)` lets the caller stop the run (emergency stop): handle.stop().
 * `onText(delta)` streams the answer as it arrives (follow-up chats).
 */
export function runIsolatedClaude({ bin = "claude", input, cwd, model = null, env = process.env,
  deadlineMs = SUMMARIZE_DEADLINE_MS, maxChars = MAX_ANSWER_CHARS, onText = null, register = null, spawnFn = spawn, now = Date.now }) {
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
    const handle = { stop: () => stop("stopped"), pid: child.pid };
    register?.(handle, true);

    const deadline = setTimeout(() => stop("summarize_timeout"), deadlineMs);
    deadline.unref?.();

    const addText = (delta) => {
      if (!delta || truncated) return;
      const room = maxChars - text.length;
      if (delta.length > room) { delta = delta.slice(0, Math.max(0, room)); truncated = true; }
      text += delta;
      if (delta) onText?.(delta);
    };

    const onEvent = (ev) => {
      if (ev.type === "system" && ev.subtype === "init") {
        problems = checkInit(ev);
        if (problems.length) stop("profile_mismatch");
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
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      if (buf.length > MAX_LINE_BYTES) { stop("summarize_failed"); buf = ""; return; }
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        try { onEvent(ev); } catch { /* malformed event: ignore */ }
      }
    });
    child.stderr.on("data", () => { /* not surfaced: may echo input */ });
    child.stdin.on("error", () => { /* EPIPE: the process died early; close tells why */ });
    child.on("error", () => { if (!errorClass) errorClass = "spawn"; });
    child.on("close", (code) => {
      finished = true;
      clearTimeout(deadline);
      register?.(handle, false);
      const durationMs = now() - started;
      if (!errorClass && (!resultSeen || resultIsError || code !== 0)) errorClass = "summarize_failed";
      if (!errorClass && !text.trim()) errorClass = "summarize_failed";
      resolve({ ok: !errorClass, text, truncated, usage, durationMs, errorClass, problems });
    });
    child.stdin.end(input);
  });
}
