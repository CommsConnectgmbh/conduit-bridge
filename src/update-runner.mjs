// When the bridge checks for, installs and restarts into a new release.
//
// selfupdate.mjs does the download, verification and the swap on disk. This
// module decides when that may happen and — the part that used to get lost —
// remembers that a restart is still owed once the new files are in place.
//
// A signed release that was applied but not yet restarted into is a pending
// restart. The files on disk are already the new version while this process
// still runs the old one, so a later check reads the new version from disk,
// answers "up-to-date" and would forget the restart for good. Hence: while a
// restart is pending there is no further check, download or install; the
// runner only waits for the bridge to be idle (and, with a maintenance window,
// for the window) and then restarts exactly once. It never interrupts work and
// never exits a bridge without a supervisor that would bring it back.
//
// Kept apart from server.mjs, which cannot be imported without starting a
// bridge, so the rules can be tested with a stub installer and a stub restart.

/**
 * Work a restart would destroy, across all sessions plus the Alexa slot.
 *
 * Every turn that is not finished counts, whatever stage it is in: a turn that
 * was accepted and is still starting, or waiting for a warm process, has
 * neither a process handle nor a warm flag yet and is just as much lost by a
 * restart. Finished turns kept around for a late reconnect (`done`) do not:
 * they linger for minutes after every turn, and counting them meant a normally
 * used bridge never found a quiet moment and security fixes never landed.
 * Queued prompts live in memory only (their user message is already in the
 * DB), so each one counts.
 */
export function countBusyWork(runtime, { alexaBusy = false } = {}) {
  let n = 0;
  for (const r of runtime.values()) {
    if (r.inflight && !r.inflight.done) n++;
    n += r.promptQueue?.length || 0;
  }
  if (alexaBusy) n++;
  return n;
}

const DEFAULT_RETRY_MS = 30_000;

/**
 * @param {object} o
 * @param {{mode: string, pin: string|null, window: object|null}} o.policy
 * @param {(opts: {apply: boolean, maxVersion: string|null}) => Promise<object>} o.check  checkAndStage
 * @param {() => number} o.busy          work in progress (0 = idle); see countBusyWork
 * @param {() => boolean} o.isSupervised
 * @param {(target: string) => void} o.restart  ends the process for the supervisor to relaunch
 * @param {(win: object, now: Date) => boolean} o.inWindow
 * @param {(win: object, now: Date) => string} o.windowKey
 */
export function createUpdateRunner({
  policy, check, busy, isSupervised, restart, log, inWindow, windowKey,
  now = () => new Date(),
  retryMs = DEFAULT_RETRY_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  const enabled = policy.mode !== "off";
  // Reporting changes nothing on this machine, so it needs no window. Only
  // installing waits for it.
  const installing = policy.mode === "install";
  const win = installing ? policy.window : null;

  let running = false;
  // With a maintenance window the timer ticks every few minutes and the check
  // runs once per window; this remembers which window already had its check.
  let lastWindowKey = null;
  let available = null;
  // { from, to, since } once a release was applied and not yet restarted into.
  let pending = null;
  let restarting = false;
  let retryTimer = null;
  let lastDeferral = null;

  function deferred(reason) {
    if (lastDeferral === reason) return;
    lastDeferral = reason;
    log("info", "selfupdate_restart_deferred", { running: pending.from, to: pending.to, reason });
  }

  function armRetry() {
    if (retryTimer || restarting || !pending) return;
    retryTimer = setTimer(() => {
      retryTimer = null;
      tryRestart();
    }, retryMs);
    retryTimer?.unref?.();
  }

  /**
   * Restart into the pending release if that is allowed right now. The busy
   * check and the restart run in the same synchronous step, so no turn can be
   * accepted in between.
   */
  function tryRestart() {
    if (!pending || restarting) return false;
    if (!isSupervised()) {
      // Never exit a bridge nothing would start again. The new files stay on
      // disk and are used by the next manual restart; say so once.
      if (lastDeferral !== "unsupervised") {
        lastDeferral = "unsupervised";
        log("warn", "selfupdate_needs_restart", { running: pending.from, to: pending.to, hint: "no supervisor — restart to apply" });
      }
      return false;
    }
    if (win && !inWindow(win, now())) { deferred("window"); armRetry(); return false; }
    if (busy() > 0) { deferred("busy"); armRetry(); return false; }
    restarting = true;
    if (retryTimer) { clearTimer(retryTimer); retryTimer = null; }
    log("info", "selfupdate_restart", { from: pending.from, to: pending.to });
    try {
      restart(pending.to);
    } catch (e) {
      restarting = false;
      log("error", "selfupdate_restart_failed", { to: pending.to, err: String(e?.message || e) });
      armRetry();
      return false;
    }
    return true;
  }

  async function tick() {
    if (!enabled || running) return;
    // The new files are already in place; checking again would only read them
    // back as "up-to-date". Wait for the restart instead.
    if (pending) { tryRestart(); return; }
    if (win) {
      const t = now();
      if (!inWindow(win, t)) return;
      if (lastWindowKey === windowKey(win, t)) return;
    }
    if (busy() > 0) return;
    running = true;
    try {
      const r = await check({ apply: installing, maxVersion: policy.pin });
      // The window is used up once the origin gave a definite answer (newer
      // release installed or held, or nothing newer). A busy bridge (above), a
      // failed download or a rejected package tries again on the next tick.
      if (win && (r.updated || r.available || r.reason === "up-to-date")) lastWindowKey = windowKey(win, now());
      if (r.available) available = r.to;
      else if (r.reason === "up-to-date") available = null;
      if (!r.updated) {
        log("info", "selfupdate_checked", { running: r.from, origin: r.to, mode: policy.mode, held: !!r.held });
        return;
      }
      available = null;
      log("info", "selfupdate_done", r);
      // Remembered before anything else can return: from here on the restart
      // is owed, even if a turn started while the release was being installed.
      pending = { from: r.from, to: r.to, since: now().toISOString() };
      tryRestart();
    } catch (e) {
      log("warn", "selfupdate_error", { err: String(e?.message || e) });
    } finally {
      running = false;
    }
  }

  return {
    tick,
    status() {
      return {
        available,
        // The version installed on disk and waiting for a restart. The running
        // version stays what this process started with.
        pendingRestart: pending ? pending.to : null,
        restartBlockedBy: pending && !restarting ? lastDeferral : null,
      };
    },
  };
}
