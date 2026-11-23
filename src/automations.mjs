// Scheduled automations (Conduit 2.0, phase 4): the morning briefing and
// anything like it. Off unless the owner writes automations.json.
//
// A run has three stages, and only the middle one involves a model:
//   collecting   the owner's collect command fetches data (no model).
//   summarizing  Claude in the scheduled profile: no tools, no MCP, no hooks,
//                no settings (isolated-claude.mjs). Other people's text can
//                at worst distort the summary; there is nothing it could do.
//   delivering   the owner's deliver command (e.g. Telegram) and Web Push.
//
// States of a run (table automation_runs):
//   claimed → collecting → summarizing → delivering → done
//                                    ↘ failed (final) / back to claimed (retry)
//   skipped: the slot's window passed while the bridge was not running.
// One scheduled run per automation and local date (partial unique index); a
// per-automation lock row keeps scheduled runs, manual runs and resends from
// overlapping. At most MAX_ATTEMPTS attempts, RETRY_MS apart, inside the
// window; an emergency stop or a full bridge does not use up an attempt.
//
// Crash recovery on start (sweep): a run caught in collecting or summarizing
// is retried (its attempt counted); a run caught in delivering is finished
// with every channel still pending marked "unknown" — it may have gone out, so
// it is never sent blindly a second time.
//
// The emergency stop reaches every stage: commands and the model run in their
// own process groups, registered here, and are killed by stopAll(); each stage
// checks the stop before it starts; a run stopped this way never delivers.

import { mkdirSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { checkExecutable, loadAutomationsConfig } from "./automations-config.mjs";
import { COLLECT_TIMEOUT_MS, DELIVER_TIMEOUT_MS, MAX_COLLECT_BYTES, commandEnv, parseCollectOutput, runCommand } from "./automation-commands.mjs";
import { FAILURE_SUMMARY, deliveryPayload, headerFacts, renderHeader, scheduledPrompt, summaryOf } from "./automation-text.mjs";
import { addDays, dueSlot, localDate, nextSlot, slotOn } from "./schedule-time.mjs";

export const MAX_ATTEMPTS = 3;
export const RETRY_MS = 10 * 60 * 1000;
export const DEFER_MS = 60 * 1000;
export const LATE_AFTER_MS = 2 * 3600 * 1000;
export const MANUAL_THROTTLE_MS = 2 * 60 * 1000;
export const TICK_MS = 30 * 1000;
const FINAL = new Set(["done", "failed", "skipped"]);
const NON_RETRYABLE = new Set(["collect_invalid", "collect_too_large", "profile_mismatch"]);
const CHANNEL_STATES = new Set(["sent", "failed", "unknown", "off", "pending", "held"]);

export function ensureAutomationSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS automation_runs (
      id TEXT PRIMARY KEY,
      automation_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      slot_date TEXT,
      slot_at INTEGER,
      tz TEXT NOT NULL,
      state TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER,
      error_class TEXT,
      session_id TEXT,
      msg_id TEXT,
      header TEXT,
      summary TEXT,
      delivery TEXT,
      duration_ms INTEGER,
      tokens_in INTEGER,
      tokens_out INTEGER,
      notice_sent INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      ended_at INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_automation_slot ON automation_runs(automation_id, slot_date) WHERE kind = 'schedule';
    CREATE INDEX IF NOT EXISTS idx_automation_runs_created ON automation_runs(automation_id, created_at DESC);
    -- When an automation was first configured: a slot before that is not
    -- "skipped", it simply did not exist yet.
    CREATE TABLE IF NOT EXISTS automation_meta (
      automation_id TEXT PRIMARY KEY,
      first_seen INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS automation_locks (
      automation_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      locked_at INTEGER NOT NULL
    );
  `);
}

function rowToRun(r) {
  if (!r) return null;
  let header = null, delivery = null;
  try { header = r.header ? JSON.parse(r.header) : null; } catch { /* keep null */ }
  try { delivery = r.delivery ? JSON.parse(r.delivery) : null; } catch { /* keep null */ }
  return {
    id: r.id, kind: r.kind, slotDate: r.slot_date, slotAt: r.slot_at, tz: r.tz, state: r.state, attempts: r.attempts,
    nextAttemptAt: r.next_attempt_at, errorClass: r.error_class, sessionId: r.session_id, messageId: r.msg_id,
    header, summary: r.summary, delivery: delivery || { telegram: "off", push: "off" },
    durationMs: r.duration_ms, tokens: r.tokens_in === null || r.tokens_in === undefined ? null : { in: r.tokens_in, out: r.tokens_out },
    noticeSent: !!r.notice_sent, createdAt: r.created_at, startedAt: r.started_at, endedAt: r.ended_at,
  };
}

/** The API view of a run: no internal fields. */
export function publicRun(run, now = Date.now()) {
  if (!run) return null;
  const late = run.kind === "schedule" && run.slotAt !== null && (
    (run.state === "done" && run.endedAt !== null && run.endedAt - run.slotAt > LATE_AFTER_MS)
    || (!FINAL.has(run.state) && now - run.slotAt > LATE_AFTER_MS));
  return {
    id: run.id, kind: run.kind, slotDate: run.slotDate, state: run.state, attempts: run.attempts,
    errorClass: run.errorClass, startedAt: run.startedAt, endedAt: run.endedAt, late,
    sessionId: run.sessionId, messageId: run.messageId, header: run.header, summary: run.summary,
    delivery: run.delivery, durationMs: run.durationMs, tokens: run.tokens,
  };
}

/**
 * deps:
 *   summarize({ run, automation, prompt, header, register }) → Promise<{ ok, errorClass, sessionId, messageId, text, usage, durationMs }>
 *       creates the chat (origin schedule) and runs the model in the scheduled profile.
 *   push({ automation, run, payload }) → Promise<"sent" | "failed" | "off">
 *   capacity() → boolean   a turn slot is free right now
 *   knownOwners() → string[]
 */
export function createAutomations({ db, configPath, workDir, emergency, log = () => {}, now = Date.now, deps }) {
  ensureAutomationSchema(db);
  mkdirSync(workDir, { recursive: true, mode: 0o700 });
  let loaded = { enabled: false, reason: "not_configured", detail: null, config: null };
  const active = new Set(); // process handles of running stages
  let timer = null;
  let lastTick = now();
  let ticking = false;
  const lastResend = new Map(); // runId -> ms

  const Q = {
    bySlot: db.prepare(`SELECT * FROM automation_runs WHERE automation_id = ? AND slot_date = ? AND kind = 'schedule'`),
    byId: db.prepare(`SELECT * FROM automation_runs WHERE id = ?`),
    insert: db.prepare(`INSERT INTO automation_runs (id, automation_id, kind, slot_date, slot_at, tz, state, attempts, next_attempt_at, delivery, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?) ON CONFLICT DO NOTHING`),
    update: db.prepare(`UPDATE automation_runs SET state = ?, attempts = ?, next_attempt_at = ?, error_class = ?, session_id = ?, msg_id = ?,
      header = ?, summary = ?, delivery = ?, duration_ms = ?, tokens_in = ?, tokens_out = ?, notice_sent = ?, started_at = ?, ended_at = ? WHERE id = ?`),
    latest: db.prepare(`SELECT * FROM automation_runs WHERE automation_id = ? ORDER BY COALESCE(slot_at, created_at) DESC, rowid DESC LIMIT 1`),
    latestOk: db.prepare(`SELECT * FROM automation_runs WHERE automation_id = ? AND state = 'done' AND error_class IS NULL ORDER BY COALESCE(slot_at, created_at) DESC, rowid DESC LIMIT 1`),
    seen: db.prepare(`INSERT INTO automation_meta (automation_id, first_seen) VALUES (?, ?) ON CONFLICT DO NOTHING`),
    firstSeen: db.prepare(`SELECT first_seen FROM automation_meta WHERE automation_id = ?`),
    lastManual: db.prepare(`SELECT created_at FROM automation_runs WHERE automation_id = ? AND kind = 'manual' ORDER BY created_at DESC LIMIT 1`),
    open: db.prepare(`SELECT * FROM automation_runs WHERE state NOT IN ('done', 'failed', 'skipped')`),
    lock: db.prepare(`INSERT INTO automation_locks (automation_id, run_id, locked_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`),
    unlock: db.prepare(`DELETE FROM automation_locks WHERE automation_id = ? AND run_id = ?`),
    clearLocks: db.prepare(`DELETE FROM automation_locks`),
    isLocked: db.prepare(`SELECT 1 FROM automation_locks WHERE automation_id = ?`),
    runsBetween: db.prepare(`SELECT * FROM automation_runs WHERE kind = 'schedule' AND slot_date >= ? AND slot_date <= ? ORDER BY slot_date ASC`),
  };

  const save = (r) => Q.update.run(r.state, r.attempts, r.nextAttemptAt ?? null, r.errorClass ?? null, r.sessionId ?? null, r.messageId ?? null,
    r.header ? JSON.stringify(r.header) : null, r.summary ?? null, JSON.stringify(r.delivery || { telegram: "off", push: "off" }),
    r.durationMs ?? null, r.tokens ? r.tokens.in : null, r.tokens ? r.tokens.out : null, r.noticeSent ? 1 : 0, r.startedAt ?? null, r.endedAt ?? null, r.id);
  const get = (id) => rowToRun(Q.byId.get(id));

  const register = (h, on) => { if (on) active.add(h); else active.delete(h); };
  const stopped = () => emergency?.active === true;

  function reload() {
    loaded = loadAutomationsConfig(configPath, { knownOwners: deps.knownOwners() });
    if (loaded.enabled) for (const a of loaded.config.automations) Q.seen.run(a.id, now());
    if (!loaded.enabled && loaded.reason !== "not_configured") log("warn", "automations_config_rejected", { reason: loaded.reason, detail: loaded.detail });
    return loaded;
  }

  function automationById(id) {
    return loaded.enabled ? loaded.config.automations.find((a) => a.id === id) || null : null;
  }

  function tryLock(automationId, runId) {
    return Q.lock.run(automationId, runId, now()).changes === 1;
  }

  /** Start-up recovery: see the header comment. */
  function sweep() {
    Q.clearLocks.run();
    for (const row of Q.open.all()) {
      const r = rowToRun(row);
      if (r.state === "collecting" || r.state === "summarizing") {
        r.state = "claimed";
        r.errorClass = "bridge_restart";
        r.nextAttemptAt = now();
        save(r);
        log("warn", "automation_run_recovered", { id: r.id, automation: row.automation_id, from: row.state });
      } else if (r.state === "delivering") {
        for (const ch of ["telegram", "push"]) if (r.delivery[ch] === "pending") r.delivery[ch] = "unknown";
        r.state = "done";
        r.endedAt = r.endedAt ?? now();
        save(r);
        log("warn", "automation_delivery_unknown", { id: r.id, automation: row.automation_id });
      }
    }
  }

  async function runCollect(a) {
    if (!a.collect) return { ok: true, sources: [] };
    try { checkExecutable(a.collect[0]); } catch { return { ok: false, errorClass: "collect_failed" }; }
    const out = await runCommand({
      argv: a.collect, timeoutMs: COLLECT_TIMEOUT_MS, maxBytes: MAX_COLLECT_BYTES,
      env: commandEnv(process.env, loaded.config.tz), cwd: workDir, register,
    });
    if (out.stopped) return { ok: false, errorClass: "emergency" };
    if (out.tooLarge) return { ok: false, errorClass: "collect_too_large" };
    if (out.timedOut || out.spawnError || out.code !== 0) return { ok: false, errorClass: "collect_failed" };
    return parseCollectOutput(out.stdout);
  }

  async function deliver(a, r, { header, summary, fullText }) {
    const payload = deliveryPayload({ automation: a, run: r, header, summary, fullText, appHint: "Details in Conduit" });
    if (stopped()) {
      r.delivery = { telegram: a.deliver ? "held" : "off", push: a.push ? "held" : "off" };
      save(r);
      return;
    }
    r.delivery = { telegram: a.deliver ? "pending" : "off", push: a.push ? "pending" : "off" };
    save(r);
    if (a.deliver) {
      let res = "failed";
      try {
        checkExecutable(a.deliver[0]);
        const out = await runCommand({ argv: a.deliver, stdin: JSON.stringify(payload), timeoutMs: DELIVER_TIMEOUT_MS,
          env: commandEnv(process.env, loaded.config.tz), cwd: workDir, register });
        // Killed while sending: it may have gone out.
        res = out.stopped || out.timedOut ? "unknown" : out.code === 0 ? "sent" : "failed";
      } catch { res = "failed"; }
      r.delivery.telegram = res;
      save(r);
    }
    if (a.push) {
      if (stopped()) r.delivery.push = "held";
      else {
        let res = "failed";
        try {
          res = await deps.push({ automation: a, run: r, payload: { t: "briefing", a: a.id, r: r.id, title: r.errorClass ? `${a.title}: failed` : `${a.title} ready`, body: "Tap to open" } });
        } catch { res = "failed"; }
        r.delivery.push = CHANNEL_STATES.has(res) ? res : "failed";
      }
      save(r);
    }
  }

  async function notifyFailure(a, r, cls) {
    if (r.noticeSent || stopped()) return;
    r.noticeSent = true;
    save(r);
    const summary = FAILURE_SUMMARY[cls] || FAILURE_SUMMARY.summarize_failed;
    await deliver(a, r, { header: r.header ? renderHeader(r.header.sources) : "", summary, fullText: null });
  }

  /** Not counted as an attempt; try again shortly. */
  function defer(r, cls) {
    r.state = "claimed";
    r.errorClass = cls;
    r.nextAttemptAt = now() + DEFER_MS;
    save(r);
  }

  async function fail(a, r, cls) {
    const windowEnd = r.slotAt !== null ? r.slotAt + a.windowMs : now();
    const retry = r.kind === "schedule" && !NON_RETRYABLE.has(cls) && r.attempts < MAX_ATTEMPTS && now() + RETRY_MS < windowEnd;
    r.errorClass = cls;
    if (retry) {
      r.state = "claimed";
      r.nextAttemptAt = now() + RETRY_MS;
      save(r);
      log("warn", "automation_attempt_failed", { id: r.id, automation: a.id, cls, attempt: r.attempts });
      return;
    }
    r.state = "failed";
    r.endedAt = now();
    save(r);
    log("warn", "automation_run_failed", { id: r.id, automation: a.id, cls, attempts: r.attempts });
    await notifyFailure(a, r, cls);
  }

  async function execute(a, r) {
    if (!tryLock(a.id, r.id)) return "busy";
    let tmp = null;
    try {
      if (stopped()) { defer(r, "emergency"); return "emergency"; }
      if (!deps.capacity()) { defer(r, "capacity"); return "capacity"; }
      r.attempts += 1;
      r.state = "collecting";
      r.errorClass = null;
      r.startedAt = now();
      save(r);
      const c = await runCollect(a);
      if (c.errorClass === "emergency" || stopped()) { r.attempts -= 1; defer(r, "emergency"); return "emergency"; }
      if (!c.ok) { await fail(a, r, c.errorClass); return "failed"; }
      const sources = c.sources;
      r.header = headerFacts(sources);
      save(r);
      if (sources.length && sources.every((s) => s.status === "error")) { await fail(a, r, "all_sources_failed"); return "failed"; }

      r.state = "summarizing";
      save(r);
      tmp = mkdtempSync(join(workDir, "run-"));
      const date = r.slotDate || localDate(now(), loaded.config.tz);
      const prompt = scheduledPrompt({ title: a.title, date, tz: loaded.config.tz, ownerPrompt: a.prompt, sources });
      const s = await deps.summarize({ run: r, automation: a, prompt, header: renderHeader(sources), cwd: tmp, register });
      r.sessionId = s.sessionId ?? r.sessionId;
      r.messageId = s.messageId ?? r.messageId;
      r.durationMs = s.durationMs ?? null;
      r.tokens = s.usage || null;
      save(r);
      if (s.errorClass === "stopped" || stopped()) { r.attempts -= 1; defer(r, "emergency"); return "emergency"; }
      if (!s.ok) { await fail(a, r, s.errorClass || "summarize_failed"); return "failed"; }
      r.summary = summaryOf(s.text);
      r.state = "delivering";
      save(r);
      await deliver(a, r, { header: renderHeader(sources), summary: r.summary, fullText: s.text });
      r.state = "done";
      r.endedAt = now();
      save(r);
      log("info", "automation_run_done", { id: r.id, automation: a.id, kind: r.kind, telegram: r.delivery.telegram, push: r.delivery.push });
      return "done";
    } catch (e) {
      log("error", "automation_run_crashed", { id: r.id, automation: a.id, err: String(e?.message || e).slice(0, 200) });
      try { await fail(a, r, "summarize_failed"); } catch { /* logged above */ }
      return "failed";
    } finally {
      if (tmp) { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } }
      Q.unlock.run(a.id, r.id);
    }
  }

  function newRun(a, kind, slot) {
    const id = `r_${randomUUID()}`;
    const ch = JSON.stringify({ telegram: a.deliver ? "pending" : "off", push: a.push ? "pending" : "off" });
    const res = Q.insert.run(id, a.id, kind, slot?.slotDate ?? null, slot?.slotAt ?? null, loaded.config.tz, "claimed", now(), ch, now());
    return res.changes === 1 ? get(id) : null;
  }

  async function tickOnce() {
    if (!loaded.enabled) return;
    const t = now();
    const tz = loaded.config.tz;
    for (const a of loaded.config.automations) {
      // Windows that ended without any run: the bridge was off (skipped).
      for (const date of [addDays(localDate(t, tz), -1), localDate(t, tz)]) {
        const s = slotOn(a.schedule, date, tz);
        const since = Q.firstSeen.get(a.id)?.first_seen ?? t;
        if (s && s.slotAt >= since && t >= s.slotAt + a.windowMs && !Q.bySlot.get(a.id, date)) {
          const id = `r_${randomUUID()}`;
          Q.insert.run(id, a.id, "schedule", date, s.slotAt, tz, "skipped", null, JSON.stringify({ telegram: "off", push: "off" }), t);
        }
      }
      const due = dueSlot(a.schedule, tz, t, a.windowMs);
      let r = due ? rowToRun(Q.bySlot.get(a.id, due.slotDate)) || newRun(a, "schedule", due) : null;
      // Open runs whose window is over: expired.
      for (const row of Q.open.all()) {
        const o = rowToRun(row);
        if (row.automation_id !== a.id || o.kind !== "schedule" || Q.isLocked.get(a.id)) continue;
        if (o.slotAt !== null && t >= o.slotAt + a.windowMs) {
          o.state = "failed"; o.errorClass = "expired"; o.endedAt = t; save(o);
          log("warn", "automation_run_expired", { id: o.id, automation: a.id });
          await notifyFailure(a, o, "expired");
        }
      }
      if (!r) continue;
      r = get(r.id);
      if (FINAL.has(r.state)) continue;
      // Late notice once, never during an emergency stop.
      if (t - r.slotAt > LATE_AFTER_MS && !r.noticeSent && !stopped() && !Q.isLocked.get(a.id)) {
        await notifyFailure(a, r, "late");
        r = get(r.id);
      }
      if (r.state === "claimed" && (r.nextAttemptAt ?? 0) <= t) await execute(a, r);
    }
  }

  async function tick() {
    if (ticking) return;
    ticking = true;
    try { await tickOnce(); } catch (e) { log("error", "automation_tick_failed", { err: String(e?.message || e).slice(0, 200) }); } finally { ticking = false; }
  }

  return {
    get enabled() { return loaded.enabled; },
    reload,
    sweep,
    tick,
    /** Start the timer. A jump in wall time (wake from sleep) ticks at once. */
    start() {
      reload();
      sweep();
      const loop = () => {
        const t = now();
        const jumped = Math.abs(t - lastTick - TICK_MS) > 2 * 60 * 1000;
        lastTick = t;
        if (jumped) log("info", "automation_clock_jump", {});
        tick();
      };
      timer = setInterval(loop, TICK_MS);
      timer.unref?.();
      setImmediate(() => tick());
    },
    stop() { if (timer) clearInterval(timer); timer = null; },
    /** Emergency stop: kill every running stage. */
    stopAll() {
      let n = 0;
      for (const h of [...active]) { try { h.stop(); n++; } catch { /* gone */ } }
      return n;
    },
    activeCount() { return active.size; },

    status() {
      const t = now();
      if (!loaded.enabled) return { enabled: false, reason: loaded.reason, tz: null, automations: [] };
      return {
        enabled: true, reason: null, tz: loaded.config.tz,
        automations: loaded.config.automations.map((a) => ({
          id: a.id, title: a.title, schedule: a.schedule,
          nextAt: nextSlot(a.schedule, loaded.config.tz, t)?.slotAt ?? null,
          channels: { telegram: !!a.deliver, push: a.push },
          lastRun: publicRun(rowToRun(Q.latest.get(a.id)), t),
          latestOk: publicRun(rowToRun(Q.latestOk.get(a.id)), t),
        })),
      };
    },

    /** Manual run ("Create now"). Never counts as the day's scheduled run. */
    runNow(id) {
      const a = automationById(id);
      if (!a) return { ok: false, error: "disabled" };
      if (stopped()) return { ok: false, error: "emergency" };
      if (Q.isLocked.get(a.id)) return { ok: false, error: "busy" };
      const last = Q.lastManual.get(a.id);
      if (last && now() - last.created_at < MANUAL_THROTTLE_MS) return { ok: false, error: "throttled" };
      const r = newRun(a, "manual", null);
      execute(a, r).catch(() => {});
      return { ok: true, runId: r.id };
    },

    /** Resend the stored header and summary of a finished run. */
    redeliver(runId) {
      const r = get(runId);
      const a = r ? automationById(Q.byId.get(runId).automation_id) : null;
      if (!r || !a) return { ok: false, error: "not_deliverable" };
      if (r.state !== "done" || !r.summary) return { ok: false, error: "not_deliverable" };
      if (stopped()) return { ok: false, error: "emergency" };
      if (now() - (lastResend.get(r.id) || -Infinity) < MANUAL_THROTTLE_MS) return { ok: false, error: "throttled" };
      if (!tryLock(a.id, r.id)) return { ok: false, error: "busy" };
      lastResend.set(r.id, now());
      (async () => {
        try {
          await deliver(a, r, { header: r.header ? renderHeader(r.header.sources) : "", summary: r.summary, fullText: null });
        } finally { Q.unlock.run(a.id, r.id); }
      })().catch(() => {});
      return { ok: true };
    },

    /** Scheduled runs per local date, for the week view. */
    runsBetween(fromDate, toDate) {
      return Q.runsBetween.all(fromDate, toDate).map((row) => ({ ...publicRun(rowToRun(row), now()), automationId: row.automation_id }));
    },

    _get: get,
  };
}
