// Warm Claude process pool (v3.0).
//
// Instead of spawning a fresh `claude -p …` for every prompt (~2.5-3.5s boot +
// a full 32k-token system-prompt cache rebuild each cold turn), we keep ONE
// long-lived `claude --print --input-format stream-json` child per session.
// Each turn is a JSON user-message written to the child's stdin; the answer
// streams back token-by-token (--include-partial-messages → content_block_delta)
// on stdout. The process stays warm between turns, so:
//   • no per-turn CLI boot, MCP servers stay connected,
//   • the prompt cache is reused (cache_creation drops ~32k → <1k),
//   • follow-ups start streaming noticeably faster and at lower cost.
//
// The pool is LRU-capped and idle-evicts. A turn that dies unexpectedly surfaces
// via handlers.onError so the caller can fall back to a one-shot spawn.

import { getEngine } from "./engines.mjs";
const resolveClaudeModel = (m) => getEngine("claude").resolveModel(m);
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

// One NDJSON event may not exceed this; see onStdout.
const MAX_LINE_BYTES = 8 * 1024 * 1024;

export function createWarmPool({
  claudeBin,
  model,
  defaultCwd,
  env,
  log,
  isUuid,
  maxWarm = 4,
  idleMs = 8 * 60_000,
  // A busy proc that emits no stdout for this long is wedged (hung Bash tool,
  // dropped upstream stream). 900s sits well above the CLI's 600s max Bash-tool
  // timeout, so a legit long silent op (incl. a slow Agent/Task run) never trips
  // it — only a genuinely dead turn does. Overridable via CONDUIT_TURN_STALL_MS.
  stallMs = 900_000,
}) {
  /** sid -> proc */
  const procs = new Map();

  function killProc(p, reason) {
    if (!p) return;
    // Remember WHY. The exit handler reports every death as a plain error, and
    // the caller reads an unflagged error on a turn with no output yet as "the
    // warm path misbehaved" and retries the prompt through a one-shot spawn.
    // For a deliberate stop or shutdown that would re-run exactly what was just
    // cancelled — with bypassPermissions.
    p.killReason = reason;
    p.alive = false;
    if (procs.get(p.sid) === p) procs.delete(p.sid);
    try { p.child.stdin.end(); } catch {}
    try { p.child.kill("SIGTERM"); } catch {}
    const t = setTimeout(() => { try { p.child.kill("SIGKILL"); } catch {} }, 2000);
    t.unref?.();
    log("info", "warm_kill", { sid: p.sid, reason });
  }

  /** @returns {boolean} true when there is room for another proc. */
  function evictIfNeeded() {
    if (procs.size < maxWarm) return true;
    let lru = null;
    for (const p of procs.values()) {
      if (p.busy) continue;
      if (!lru || p.lastUsed < lru.lastUsed) lru = p;
    }
    if (lru) { killProc(lru, "evict"); return true; }
    // Every proc is busy — nothing evictable. maxWarm has to be a hard ceiling
    // here, not a hint: spawning anyway let the pool grow without bound (one
    // long-running turn per session, each claude dragging its own MCP servers
    // and tool subprocesses behind it) until the machine gave out.
    return false;
  }

  const idleTimer = setInterval(() => {
    const now = Date.now();
    for (const p of [...procs.values()]) {
      if (!p.busy && now - p.lastUsed > idleMs) { killProc(p, "idle"); continue; }
      // Busy but silent past the stall window → the turn is wedged and will
      // never resolve on its own. Surface a clear error (so the UI stops showing
      // "Stockt seit Xs" forever and the user can retry) and kill the proc; the
      // next turn respawns with --resume, so conversation context survives.
      if (p.busy && p.turn && !p.turn.finished && now - (p.lastOutAt || p.lastUsed) > stallMs) {
        const t = p.turn;
        t.finished = true;
        const secs = Math.round((now - (p.lastOutAt || p.lastUsed)) / 1000);
        // Second argument marks this as a terminal stall verdict. The caller
        // otherwise treats an early onError as "warm path misbehaved" and
        // retries the same prompt through the one-shot spawn — re-running a
        // turn that had already been executing for the whole stall window.
        t.handlers.onError?.(
          `Antwort blieb ${secs}s ohne Lebenszeichen stehen — abgebrochen. Schick die Nachricht einfach nochmal.`,
          { stall: true },
        );
        killProc(p, "stall");
      }
    }
  }, 30_000);
  idleTimer.unref?.();

  function onExit(p, code, signal) {
    // Drain the decoder and any final line the process did not newline-terminate,
    // so a last complete record is not lost on exit.
    try {
      p.stdoutBuf += p.outDecoder.end();
      const tail = p.stdoutBuf.trim();
      p.stdoutBuf = "";
      if (tail) routeEvent(p, tail);
    } catch { /* best effort */ }
    p.alive = false;
    if (procs.get(p.sid) === p) procs.delete(p.sid);
    const t = p.turn;
    p.turn = null;
    p.busy = false;
    if (t && !t.finished) {
      t.finished = true;
      // Pass the reason through: a deliberate stop/shutdown/eviction is
      // terminal, not "the warm path failed early". Without this the caller
      // retries the prompt through a one-shot spawn and the stop button
      // re-runs the very thing it was pressed to cancel.
      const deliberate = p.killReason === "stop" || p.killReason === "shutdown" || p.killReason === "evict";
      t.handlers.onError?.(
        `warm claude exited (code ${code}${signal ? ", " + signal : ""}): ${p.stderrBuf.trim().slice(0, 300) || "unbekannt"}`,
        deliberate ? { terminal: true, reason: p.killReason } : undefined,
      );
    }
    log("info", "warm_exit", { sid: p.sid, code, signal });
  }

  function routeEvent(p, line) {
    let ev;
    try { ev = JSON.parse(line); } catch { return; }
    const t = p.turn;

    if (ev.type === "system" && ev.subtype === "init" && ev.session_id) {
      p.claudeSessionId = ev.session_id;
      t?.handlers.onSessionId?.(ev.session_id);
      return;
    }
    if (!t || t.finished) return;

    // Token-level streaming: incremental text deltas.
    if (ev.type === "stream_event" && ev.event?.type === "content_block_delta") {
      const txt = ev.event.delta?.text;
      if (typeof txt === "string" && txt) {
        t.sawDelta = true;
        t.handlers.onChunk?.(txt);
      }
      return;
    }
    // Full assistant message: tool-use markers, plus a text fallback if the run
    // emitted no partial deltas at all (keeps output correct either way).
    if (ev.type === "assistant" && ev.message?.content) {
      for (const block of ev.message.content) {
        if (block.type === "tool_use") {
          t.handlers.onToolUse?.(block);
        } else if (block.type === "text" && !t.sawDelta && typeof block.text === "string") {
          t.handlers.onChunk?.(block.text);
        }
      }
      return;
    }
    // Tool results come back as a `user` message echoing each tool_use_id — the
    // signal that a step finished. Surface it so the activity panel can flip a
    // running step to done/failed.
    if (ev.type === "user" && ev.message?.content) {
      for (const block of ev.message.content) {
        if (block.type === "tool_result") t.handlers.onToolResult?.(block);
      }
      return;
    }
    if (ev.type === "result") {
      t.finished = true;
      p.busy = false;
      p.lastUsed = Date.now();
      p.turn = null;
      if (ev.is_error) {
        // Terminal: the CLI ran the turn and reported a failure. Without the
        // flag the caller reads this as "warm misbehaved before producing
        // output" and re-runs the prompt through the one-shot path — so a turn
        // that had already executed its tools executes them a second time.
        t.handlers.onError?.(
          ev.result ? String(ev.result).slice(0, 600) : "claude meldete einen Fehler",
          { terminal: true, reason: "cli_error" },
        );
      }
      else {
        t.handlers.onUsageEvent?.(ev);
        t.handlers.onDone?.();
      }
      return;
    }
  }

  function onStdout(p, d) {
    p.lastOutAt = Date.now();
    p.stdoutBuf += p.outDecoder.write(d);
    // A single event larger than the cap used to be sliced from the FRONT, so
    // the line became invalid JSON and routeEvent dropped it without a word. If
    // that was the `result` event, the turn simply hung until the stall
    // watchdog fired 15 minutes later. Drop it deliberately and say so.
    if (p.stdoutBuf.length > MAX_LINE_BYTES && !p.stdoutBuf.includes("\n")) {
      log("warn", "warm_oversized_line_dropped", { sid: p.sid, bytes: p.stdoutBuf.length });
      p.stdoutBuf = "";
      return;
    }
    // (No slice(-N) here any more: keeping the TAIL of an unterminated line
    // produced invalid JSON that routeEvent then discarded silently. The guard
    // above bounds memory; anything under it is a whole, parsable line.)
    let i;
    while ((i = p.stdoutBuf.indexOf("\n")) !== -1) {
      const line = p.stdoutBuf.slice(0, i).trim();
      p.stdoutBuf = p.stdoutBuf.slice(i + 1);
      if (line) routeEvent(p, line);
    }
  }

  function spawnProc(sid, sess, cwdIn, modelIn) {
    // defaultCwd was destructured and never used; an undefined cwd meant the
    // child silently inherited the BRIDGE's working directory.
    const cwd = cwdIn || defaultCwd;
    if (!evictIfNeeded()) {
      log("warn", "warm_pool_full", { sid, pool: procs.size, maxWarm });
      return null;
    }
    let targetModel = modelIn || model;
    // Dieselbe Abbildung wie im Prozess-Pfad. Vorher standen hier exakte
    // Vergleiche und dort ein includes(): ein Modell wie "claude-sonnet-4" ging
    // warm unveraendert an --model und wurde nur im One-Shot zu "sonnet".
    targetModel = resolveClaudeModel(targetModel);

    const args = [
      "--print",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--include-partial-messages",
      "--verbose",
      "--permission-mode", "bypassPermissions",
    ];
    if (targetModel) args.push("--model", targetModel);

    const resumeId = sess?.claude_session_id;
    if (resumeId) args.push("--resume", resumeId);
    else if (isUuid(sid)) args.push("--session-id", sid);

    const child = spawn(claudeBin, args, {
      cwd,
      env: { ...env, FORCE_COLOR: "0" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const p = {
      sid, child, alive: true, busy: false,
      lastUsed: Date.now(), lastOutAt: Date.now(),
      claudeSessionId: resumeId || null,
      model: targetModel,
      stdoutBuf: "", stderrBuf: "", turn: null,
      // Decode across chunk boundaries; a split multi-byte character would
      // otherwise land in the transcript as U+FFFD.
      outDecoder: new StringDecoder("utf8"),
    };
    procs.set(sid, p);
    child.stdout.on("data", (d) => onStdout(p, d));
    child.stderr.on("data", (d) => {
      p.stderrBuf += d.toString("utf8");
      if (p.stderrBuf.length > 4000) p.stderrBuf = p.stderrBuf.slice(-4000);
    });
    child.on("exit", (code, signal) => onExit(p, code, signal));
    child.on("error", (e) => { log("error", "warm_proc_error", { sid, err: e.message }); onExit(p, -1, null); });
    log("info", "warm_spawn", { sid, resume: !!resumeId, model: targetModel, pool: procs.size });
    return p;
  }

  /**
   * Run one turn for `sid`. Reuses the warm proc if present, else spawns one.
   * handlers: { onSessionId, onChunk, onToolUse, onUsageEvent, onDone, onError }
   * Returns true if the turn was started, false if the proc was busy.
   */
  function runTurn({ sid, sess, cwd, prompt, model: modelIn, handlers }) {
    let p = procs.get(sid);
    let targetModel = modelIn || sess?.model || model;
    // Dieselbe Abbildung wie im Prozess-Pfad. Vorher standen hier exakte
    // Vergleiche und dort ein includes(): ein Modell wie "claude-sonnet-4" ging
    // warm unveraendert an --model und wurde nur im One-Shot zu "sonnet".
    targetModel = resolveClaudeModel(targetModel);

    // Busy first: the cwd branch below KILLS the process, and checking busy
    // afterwards meant a concurrent turn with a different cwd silently killed
    // the one already streaming instead of being told the session is busy.
    if (p && p.alive && p.busy) { handlers.onError?.("warm proc busy"); return false; }
    if (!p || !p.alive) p = spawnProc(sid, sess, cwd, targetModel);
    // Compare against effective cwd and model. If changed, respawn.
    else if (p.cwd !== (cwd || defaultCwd) || (p.model && targetModel && p.model !== targetModel)) {
      killProc(p, "config_change");
      p = spawnProc(sid, sess, cwd, targetModel);
    }
    // Pool saturated with busy procs. Caller falls back / surfaces the error;
    // the turn is not started rather than pushed onto an unbounded pool.
    if (!p) { handlers.onError?.("warm pool exhausted — try again shortly"); return false; }
    p.cwd = cwd || defaultCwd;
    p.model = targetModel;
    if (p.busy) { handlers.onError?.("warm proc busy"); return false; }

    p.busy = true;
    p.lastUsed = Date.now();
    p.lastOutAt = Date.now();
    p.turn = { handlers, sawDelta: false, finished: false };
    try {
      p.child.stdin.write(
        JSON.stringify({ type: "user", message: { role: "user", content: prompt } }) + "\n",
      );
    } catch (e) {
      p.turn.finished = true;
      p.busy = false;
      p.turn = null;
      handlers.onError?.("warm stdin write failed: " + e.message);
      return false;
    }
    return true;
  }

  // Interrupting a single turn cleanly isn't supported over stream-json input, so
  // `stop` kills just this session's warm proc (warmth for other sessions stays).
  // The next turn respawns with --resume, preserving conversation context.
  function stop(sid) {
    const p = procs.get(sid);
    if (!p) return false;
    killProc(p, "stop");
    return true;
  }

  function has(sid) {
    const p = procs.get(sid);
    return !!(p && p.alive);
  }

  function killAll() { for (const p of [...procs.values()]) killProc(p, "shutdown"); }
  function stats() {
    return { warm: procs.size, busy: [...procs.values()].filter((p) => p.busy).length };
  }

  return { runTurn, stop, has, killAll, stats };
}
