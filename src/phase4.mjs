// Conduit 2.0 phase 4, wired into the bridge: automations (scheduled
// briefings), the week overview and Web Push. Everything here is off until the
// owner writes automations.json; without it the routes answer "not
// configured" and nothing is scheduled.
//
// What server.mjs hands in is small on purpose (who the owner can be, how many
// turns run, the emergency stop, the journal); the security-relevant parts
// (no-tools profile, command runner, push policy) live in their own modules
// with their own tests.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  appendAssistant, createScheduleSession, listMessages, insertAssistantPlaceholder, insertUserMessage, kvGet, kvSet, setMessageStatus,
  setTurnEnd, setTurnOrigin, savePushSubscription, deletePushSubscription, deletePushEndpoint, pushSubscriptionsForDevice,
  pushSubscriptionsForOwner, recordPushResult, turnsBetween, turnMetaSince,
} from "./db.mjs";
import { createAutomations } from "./automations.mjs";
import { runIsolatedClaude } from "./isolated-claude.mjs";
import { b64u, generateVapidPrivateKey, sendPush, validateSubscription, vapidKeys } from "./webpush.mjs";
import { addDays, dayBounds, localDate, systemZone } from "./schedule-time.mjs";
import { FAILURE_SUMMARY } from "./automation-text.mjs";

export { VAPID_ENV, takeVapidKeyFromEnv } from "./vapid-env.mjs";
const VAPID_FILE = "vapid-private.key";
const VAPID_FP_KEY = "vapid_public_fp";
const PUSH_TEST_THROTTLE_MS = 60_000;

/**
 * Key resolution, failing closed on a change: a new key would silently
 * invalidate every subscription (push services answer 403 forever).
 *   env key   → use it (owner keeps it in a secret store)
 *   key file  → use it (0600 in the bridge's private folder)
 *   neither, but a fingerprint is on record → "vapid_mismatch", push off
 *   neither, nothing on record → generate the file (first use)
 */
export function resolveVapid({ envKey, dbDir }) {
  let priv = envKey;
  const file = join(dbDir, VAPID_FILE);
  if (!priv && existsSync(file)) priv = readFileSync(file, "utf8").trim();
  const recorded = kvGet(VAPID_FP_KEY);
  if (!priv) {
    if (recorded) return { keys: null, reason: "vapid_mismatch" };
    priv = generateVapidPrivateKey();
    writeFileSync(file, priv + "\n", { mode: 0o600, flag: "wx" });
  }
  let keys;
  try { keys = vapidKeys(priv); } catch { return { keys: null, reason: "vapid_mismatch" }; }
  const fp = createHash("sha256").update(keys.publicRaw).digest("hex").slice(0, 32);
  if (!recorded) kvSet(VAPID_FP_KEY, fp);
  else if (recorded !== fp) return { keys: null, reason: "vapid_mismatch" };
  return { keys, reason: null };
}

export function createPhase4({ dbDir, db, emergency, journal = null, log, claudeBin, claudeModel, knownOwners, activeTurns, maxTurns, vapidEnvKey }) {
  let summarizing = 0;
  const testPushes = new Set(); // AbortControllers of /api/push/test sends
  let vapid = { keys: null, reason: "not_configured" };
  const lastPushTest = new Map();

  const automations = createAutomations({
    db, emergency, log,
    configPath: join(dbDir, "automations.json"),
    workDir: join(dbDir, "automations-work"),
    deps: {
      knownOwners,
      capacity: () => activeTurns() + summarizing < maxTurns,
      summarize,
      push: pushToOwner,
      // The stored answer of a run, for a delivery resumed after a restart.
      fullText: async (run) => {
        const cfg = config();
        if (!cfg || !run.sessionId || !run.messageId) return null;
        const m = (listMessages(run.sessionId, cfg.owner) || []).find((x) => x.id === run.messageId);
        return m?.content || null;
      },
    },
  });

  function config() { return automations.enabled ? automations._config() : null; }

  /** One scheduled run: its own chat (origin schedule), the model without tools. */
  async function summarize({ run, automation, prompt, cwd, register, deadlineMs }) {
    const cfg = config();
    const sid = randomUUID();
    const userId = randomUUID();
    const assistantId = randomUUID();
    const date = run.slotDate || localDate(Date.now(), cfg.tz);
    createScheduleSession(sid, cfg.owner, `${automation.title} · ${date}`, automation.id);
    insertUserMessage(sid, userId, `${automation.title} (${run.kind === "manual" ? "started by hand" : "scheduled"}, ${date})`);
    insertAssistantPlaceholder(sid, assistantId, userId, claudeModel || null, "running", "claude");
    setTurnOrigin(sid, assistantId, "schedule", "scheduled");
    const startedAt = Date.now();
    journal?.enabled && journal.turnAccepted(sid, { state: "running", assistantId, userMessageId: userId, engine: "claude", model: claudeModel || null, ts: startedAt });
    summarizing++;
    let r;
    try {
      r = await runIsolatedClaude({ bin: claudeBin, input: prompt, cwd, model: claudeModel, register, ...(deadlineMs ? { deadlineMs } : {}) });
    } finally { summarizing--; }
    if (r.text) appendAssistant(assistantId, r.text + (r.truncated ? "\n\n[answer cut at the length limit]" : ""), sid);
    const ok = r.ok;
    setMessageStatus(sid, assistantId, ok ? "ok" : "error", ok ? null : (FAILURE_SUMMARY[r.errorClass] || FAILURE_SUMMARY.summarize_failed));
    setTurnEnd(sid, assistantId, ok ? null : "agent_error", 0);
    if (r.errorClass === "profile_mismatch") log("error", "scheduled_profile_mismatch", { automation: automation.id, problems: r.problems });
    journal?.enabled && journal.turnFinished(sid, {
      state: ok ? "ok" : "error", kind: ok ? null : "agent_error", assistantId, userMessageId: userId, engine: "claude",
      model: claudeModel || null, startedAt, chars: (r.text || "").length, steps: [], ts: Date.now(), origin: "schedule", profile: "scheduled",
    });
    return { ok, errorClass: r.errorClass, sessionId: sid, messageId: assistantId, text: r.text, usage: r.usage, durationMs: r.durationMs };
  }

  async function pushOne(sub, payload, signal) {
    if (!vapid.keys) return "off";
    const cfg = config();
    try {
      const { status } = await sendPush({ subscription: sub, payload, keys: vapid.keys, subject: cfg.push.contact, signal });
      if (status >= 200 && status < 300) { recordPushResult(sub.endpoint, "sent"); return "sent"; }
      if (status === 404 || status === 410) { deletePushEndpoint(sub.endpoint); return "failed"; }
      if (status === 401 || status === 403) { recordPushResult(sub.endpoint, "vapid_rejected"); return "vapid_rejected"; }
      recordPushResult(sub.endpoint, "failed");
      return "failed";
    } catch {
      recordPushResult(sub.endpoint, "failed");
      return "failed";
    }
  }

  async function pushToOwner({ payload, signal }) {
    const cfg = config();
    if (!cfg?.push || !vapid.keys) return "off";
    const subs = pushSubscriptionsForOwner(cfg.owner);
    if (!subs.length) return "off";
    const results = await Promise.all(subs.map((s) => pushOne(s, payload, signal)));
    return results.includes("sent") ? "sent" : "failed";
  }

  function isOwner(auth) {
    const cfg = config();
    return !!cfg && auth.email.toLowerCase() === cfg.owner;
  }

  /** 7 local days, oldest first. Counted from stored facts only. */
  function week(email, { withBriefings = true } = {}) {
    const tz = config()?.tz || systemZone();
    const today = localDate(Date.now(), tz);
    const from = addDays(today, -6);
    // Briefing facts only for the automations' owner; turns are per account anyway.
    const runs = automations.enabled && withBriefings ? automations.runsBetween(from, today) : [];
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const date = addDays(today, -i);
      const [s, e] = dayBounds(date, tz);
      const turns = { ok: 0, error: 0, interrupted: 0, not_started: 0, unknown: 0, stalledNoTools: 0 };
      for (const t of turnsBetween(email, s, e)) {
        if (t.turn_status in turns && t.turn_status !== "unknown") turns[t.turn_status]++;
        else if (t.turn_status === "running" || t.turn_status === "queued") { /* still open: not an end */ }
        else turns.unknown++;
        if (t.end_kind === "stall" && t.tool_count === 0) turns.stalledNoTools++;
      }
      const b = runs.find((r) => r.slotDate === date) || null;
      days.push({ date, turns, briefing: b ? { state: b.state, late: b.late, durationMs: b.durationMs, tokens: b.tokens } : null });
    }
    return { tz, days, dataSince: turnMetaSince() };
  }

  /** Returns true when the request was handled. */
  async function handle(req, res, u, auth, { json, readJson }) {
    const path = u.pathname;
    if (path === "/api/week" && req.method === "GET") return json(res, 200, week(auth.email, { withBriefings: isOwner(auth) })), true;

    if (path === "/api/automations" && req.method === "GET") {
      const st = automations.status();
      if (st.enabled && !isOwner(auth)) return json(res, 200, { enabled: false, reason: "no_owner", tz: null, automations: [] }), true;
      return json(res, 200, st), true;
    }
    let m = path.match(/^\/api\/automations\/([a-z0-9-]{1,32})\/run$/);
    if (m && req.method === "POST") {
      if (!isOwner(auth)) return json(res, 409, { error: "disabled" }), true;
      const r = automations.runNow(m[1]);
      log("info", "automation_manual_run", { automation: m[1], ok: r.ok, error: r.error || null, by: auth.deviceId });
      return json(res, r.ok ? 202 : 409, r.ok ? { ok: true, runId: r.runId } : { error: r.error }), true;
    }
    m = path.match(/^\/api\/automations\/runs\/(r_[0-9a-f-]{36})\/redeliver$/);
    if (m && req.method === "POST") {
      if (!isOwner(auth)) return json(res, 409, { error: "not_deliverable" }), true;
      const r = automations.redeliver(m[1]);
      return json(res, r.ok ? 202 : 409, r.ok ? { ok: true } : { error: r.error }), true;
    }

    if (path === "/api/push/key" && req.method === "GET") {
      if (!isOwner(auth) || !config()?.push) return json(res, 200, { enabled: false, reason: "not_configured" }), true;
      if (!vapid.keys) return json(res, 200, { enabled: false, reason: vapid.reason }), true;
      return json(res, 200, { enabled: true, publicKey: b64u.enc(vapid.keys.publicRaw) }), true;
    }
    if (path === "/api/push/subscribe" && req.method === "POST") {
      if (!isOwner(auth) || !vapid.keys) return json(res, 409, { error: "push not enabled" }), true;
      const body = await readJson(req) || {};
      let sub;
      try { sub = validateSubscription(body.subscription); } catch (e) { return json(res, 400, { error: String(e.message).slice(0, 80) }), true; }
      if (!savePushSubscription(auth.deviceId, auth.email.toLowerCase(), sub)) return json(res, 400, { error: "too many subscriptions for this device" }), true;
      log("info", "push_subscribed", { device: auth.deviceId, host: new URL(sub.endpoint).hostname });
      return json(res, 200, { ok: true }), true;
    }
    if (path === "/api/push/unsubscribe" && req.method === "POST") {
      const body = await readJson(req) || {};
      deletePushSubscription(auth.deviceId, String(body.endpoint || ""));
      return json(res, 200, { ok: true }), true;
    }
    if (path === "/api/push/status" && req.method === "GET") {
      const subs = pushSubscriptionsForDevice(auth.deviceId);
      const last = subs.map((s) => ({ r: s.last_result, at: s.last_at || 0 })).sort((a, b) => b.at - a.at)[0];
      return json(res, 200, { subscribed: subs.length > 0, lastResult: last?.r || null, lastAt: last?.at || null }), true;
    }
    if (path === "/api/push/test" && req.method === "POST") {
      if (!isOwner(auth) || !vapid.keys) return json(res, 409, { error: "push not enabled" }), true;
      if (emergency?.active) return json(res, 409, { error: "emergency" }), true;
      const prev = lastPushTest.get(auth.deviceId) || 0;
      if (Date.now() - prev < PUSH_TEST_THROTTLE_MS) return json(res, 429, { error: "throttled" }), true;
      lastPushTest.set(auth.deviceId, Date.now());
      const subs = pushSubscriptionsForDevice(auth.deviceId);
      if (!subs.length) return json(res, 409, { error: "not subscribed" }), true;
      const ac = new AbortController();
      testPushes.add(ac);
      let results;
      try { results = await Promise.all(subs.map((s) => pushOne(s, { t: "test", title: "Conduit", body: "Test notification" }, ac.signal))); }
      finally { testPushes.delete(ac); }
      const result = results.includes("sent") ? "sent" : results.includes("vapid_rejected") ? "vapid_rejected" : "failed";
      return json(res, 200, { ok: true, result }), true;
    }
    return false;
  }

  return {
    automations,
    handle,
    week,
    start() {
      automations.start();
      if (automations.enabled && config().push) {
        try { vapid = resolveVapid({ envKey: vapidEnvKey, dbDir }); } catch (e) { vapid = { keys: null, reason: "vapid_mismatch" }; log("error", "vapid_load_failed", { err: String(e?.message || e).slice(0, 120) }); }
        if (!vapid.keys) log("warn", "push_disabled", { reason: vapid.reason });
      }
    },
    summarizingCount: () => summarizing,
    /** Emergency stop: every automation stage and every test push. */
    stopAll() {
      for (const ac of testPushes) ac.abort();
      return automations.stopAll();
    },
    killAllNow() {
      for (const ac of testPushes) ac.abort();
      automations.killAllNow();
    },
    features() { return { automations: 1, week: 1, push: 1 }; },
  };
}
