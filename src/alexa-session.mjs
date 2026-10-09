// One Claude conversation for the Alexa skill: every prompt is --resume'd into
// it (warm path, ~3-8 s) or, when there is none yet, a new one is started with
// --session-id (cold path, ~5-12 s). The session id and the cwd it was created
// under persist in the state directory, so the conversation survives a bridge
// restart.
//
// Until 2.21.1 the id was a fixed constant and only an "inited" flag was
// stored. The CLI deletes transcripts after its retention period
// (cleanupPeriodDays, default 30 days); the flag outlived the transcript,
// every --resume then failed with "No conversation found with session ID: …",
// and the reset regex did not know that wording, so Alexa stayed dead for good.
// Now the CLI's exact not-found answer for the id we passed drops the stored
// session and starts a fresh one within the same request. That failure happens
// before any model call (num_turns 0), so the retry repeats no work; every
// other failure is reported as-is and never retried.
//
// The signed /alexa endpoint (alexa.mjs) decides who may ask; this module only
// runs the conversation. It is separate from server.mjs so it can be tested
// against a stand-in CLI (test/alexa-session.test.mjs).
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";

// Pre-2.21.2 state: a bare flag meaning "the fixed id below was initialised".
export const ALEXA_LEGACY_UUID = "00000000-0000-c1a7-0000-000000a1ec00";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_STDOUT = 1024 * 1024;

const SYSTEM_HINT =
  "Du wirst über Alexa-Sprachausgabe vorgelesen. Antworte auf Hochdeutsch in MAXIMAL 2 kurzen Sätzen. " +
  "Kein Markdown, keine Listen, keine URLs, keine Code-Blöcke, keine Klammer-Bemerkungen. " +
  "Wenn unklar: ein Satz Rückfrage.";

/**
 * @param {object} o
 * @param {string} o.claudeBin   the CLI
 * @param {string} o.cwd         where the CLI runs; a transcript is only resumable from the cwd it was created under
 * @param {string} o.stateDir    where the session id is kept
 * @param {string} o.model
 * @param {(level: string, event: string, data: object) => void} o.log
 * @param {number} [o.timeoutMs] budget for the whole request, re-init included, not per spawn
 * @param {(args: string[], opts: object) => import("node:child_process").ChildProcess} [o.spawnClaude]
 */
export function createAlexaSession({
  claudeBin, cwd, stateDir, model, log, timeoutMs = 26_000, spawnClaude,
  // The bridge's permission policy (agent-policy.mjs); the default is the
  // behaviour before the policy existed.
  permissionArgs = ["--permission-mode", "bypassPermissions"],
}) {
  const stateFile = join(stateDir, ".alexa-session.json");
  const legacyFlag = join(stateDir, ".alexa-session-inited");
  const run = spawnClaude || ((args, opts) => spawn(claudeBin, args, opts));

  /**
   * A state file written under another cwd is treated as "no session" instead
   * of being resumed into a guaranteed miss.
   */
  function load() {
    try {
      const s = JSON.parse(readFileSync(stateFile, "utf8"));
      if (UUID.test(s?.sessionId || "") && s.cwd === cwd) return s.sessionId;
      log("warn", "alexa_session_discarded", { reason: s?.cwd !== cwd ? "cwd_changed" : "bad_id" });
      return null;
    } catch { /* no state file yet */ }
    // Legacy installs: try the old fixed id once; if the CLI no longer has it,
    // the not-found path replaces it with a fresh session.
    return existsSync(legacyFlag) ? ALEXA_LEGACY_UUID : null;
  }

  function save(id) {
    const tmp = `${stateFile}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify({ sessionId: id, cwd, createdAt: new Date().toISOString() }), { mode: 0o600 });
      renameSync(tmp, stateFile);
      try { unlinkSync(legacyFlag); } catch {}
    } catch (e) {
      // Not fatal for this answer; the next request just starts another session.
      log("error", "alexa_session_save_failed", { err: String(e?.message || e) });
      try { unlinkSync(tmp); } catch {}
    }
  }

  function clear() {
    try { unlinkSync(stateFile); } catch {}
    try { unlinkSync(legacyFlag); } catch {}
  }

  /**
   * True only for the CLI's own answer to `--resume <id>` when it has no
   * transcript for that id: exit 1, stderr exactly
   * "No conversation found with session ID: <id>\n" (claude 2.1.294), and no
   * assistant output. Anything else (auth, quota, overload, timeout) is not a
   * missing session and must not reset the conversation.
   */
  const isMissing = (r, id) => !r.killedByTimeout && !r.spawnError && r.code === 1 && !r.text &&
    r.stderr === `No conversation found with session ID: ${id}\n`;

  /** One CLI run. Resolves exactly once; never rejects. */
  function runClaude(prompt, sessionArgs, budgetMs) {
    const args = ["-p", prompt, "--model", model, "--output-format", "stream-json", "--verbose",
      ...permissionArgs, ...sessionArgs];
    return new Promise((resolve) => {
      let child;
      try {
        child = run(args, { cwd, env: { ...process.env, FORCE_COLOR: "0" }, stdio: ["ignore", "pipe", "pipe"] });
      } catch (e) {
        return resolve({ spawnError: e.message, code: null, stderr: "", text: "", killedByTimeout: false });
      }
      let stdout = "", stderr = "", collected = "", killedByTimeout = false;
      const killTimer = setTimeout(() => {
        killedByTimeout = true;
        try { child.kill("SIGTERM"); } catch {}
        setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 1500).unref?.();
      }, Math.max(0, budgetMs));
      // A multi-byte character split across two chunks must not become U+FFFD.
      const out = new StringDecoder("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += out.write(chunk);
        if (stdout.length > MAX_STDOUT) stdout = stdout.slice(-MAX_STDOUT);
        let idx;
        while ((idx = stdout.indexOf("\n")) !== -1) {
          const line = stdout.slice(0, idx).trim();
          stdout = stdout.slice(idx + 1);
          if (!line) continue;
          try {
            const ev = JSON.parse(line);
            if (ev.type === "assistant" && ev.message?.content) {
              for (const block of ev.message.content) {
                if (block.type === "text" && typeof block.text === "string" && collected.length < 200_000) collected += block.text;
              }
            }
          } catch { /* non-json line */ }
        }
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString("utf8");
        if (stderr.length > 4000) stderr = stderr.slice(-4000);
      });
      // A failed spawn emits BOTH 'error' and 'close'; the first one wins.
      let done = false;
      const finish = (r) => {
        if (done) return;
        done = true;
        clearTimeout(killTimer);
        resolve({ stderr, text: collected, killedByTimeout, ...r });
      };
      child.on("close", (code) => finish({ code, spawnError: null }));
      child.on("error", (e) => finish({ code: null, spawnError: e.message }));
    });
  }

  let sessionId = load();
  let inFlight = false;

  async function askLocked(query) {
    const prompt = `${SYSTEM_HINT}\n\nFrage: ${query}`;
    const started = Date.now();
    const deadline = started + timeoutMs;
    let r = null;

    const resumeId = sessionId;
    if (resumeId) {
      log("info", "alexa_spawn", { resume: true, qLen: query.length });
      r = await runClaude(prompt, ["--resume", resumeId], deadline - Date.now());
      if (isMissing(r, resumeId)) {
        log("warn", "alexa_session_missing", { ms: Date.now() - started });
        clear();
        if (sessionId === resumeId) sessionId = null;
        r = null;
      }
    }
    if (!r) {
      // A fresh RFC 4122 v4 id per attempt: a run that died after the CLI had
      // already created the transcript can never block the next attempt with
      // "Session ID … is already in use".
      const newId = randomUUID();
      log("info", "alexa_spawn", { resume: false, qLen: query.length });
      r = await runClaude(prompt, ["--session-id", newId], deadline - Date.now());
      if (!r.killedByTimeout && !r.spawnError && r.code === 0) {
        sessionId = newId;
        save(newId);
      }
    }

    const ms = Date.now() - started;
    if (r.spawnError) {
      log("error", "alexa_claude_err", { err: r.spawnError });
      return { code: 502, body: { ok: false, error: "claude failed to start" } };
    }
    if (r.killedByTimeout) {
      log("warn", "alexa_timeout", { ms, codeNote: "killed" });
      return { code: 504, body: { ok: false, error: "claude timeout" } };
    }
    if (r.code !== 0) {
      log("error", "alexa_claude_exit", { code: r.code, ms, stderr: r.stderr.slice(0, 300) });
      return { code: 502, body: { ok: false, error: `claude exit ${r.code}` } };
    }
    const text = r.text.replace(/\s+/g, " ").trim().slice(0, 2000);
    log("info", "alexa_ok", { ms, len: text.length });
    return { code: 200, body: { ok: true, text, ms } };
  }

  return {
    /** Run one question. Resolves with { code, body }; body is { ok, text?, error? }. */
    async ask(query) {
      if (inFlight) return { code: 429, body: { ok: false, error: "alexa-busy" } };
      // Claimed before the first await and released only in the finally:
      // concurrent --resume on one session corrupts its transcript.
      inFlight = true;
      try {
        return await askLocked(query);
      } finally {
        inFlight = false;
      }
    },
    /** A turn is running (a restart now would kill it). */
    get busy() { return inFlight; },
  };
}
