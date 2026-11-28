// Connections and the briefing, set up from the app (3.9.0). For bridges
// without an automations.json this is the whole setup: the owner connects a
// calendar link, GitHub or a claude.ai connector, sets the time of the
// briefing, and the bridge does the rest. With an automations.json the file's
// briefings stay as they are and the connections are added to them as extra
// sources.
//
// Owner only (PAIR_OWNER_EMAIL), like the sign-in: everything here reaches the
// owner's mail and calendar. Nothing the app sends becomes a command, a path
// or a URL the bridge would fetch other than the calendar link, which is
// checked in collectors.mjs. Secrets (the calendar link) stay in the bridge's
// database and are shown back only as their host.

import { randomUUID } from "node:crypto";
import { CONNECTOR_KINDS, connectorSource, githubSource, icsSource, icsUrl } from "./collectors.mjs";
import { cleanText } from "./todos.mjs";
import { isValidZone, parseTime, systemZone } from "./schedule-time.mjs";
import { DEFAULT_WINDOW_HOURS, MAX_PROMPT_CHARS } from "./automations-config.mjs";

export const KINDS = ["ics", "github", ...CONNECTOR_KINDS];
export const MAX_CONNECTIONS = 12;
const ID_RE = /^c_[0-9a-f-]{36}$/;
const KIND_TITLE = {
  ics: "Calendar", github: "GitHub", gmail: "Gmail", outlook_mail: "Outlook mail", outlook_calendar: "Outlook calendar",
};
export const DEFAULT_BRIEFING = {
  enabled: false,
  time: "07:00",
  days: [1, 2, 3, 4, 5, 6, 7],
  prompt: "Write my morning briefing, short and plain. First the two or three most important things today: appointments with their time, mails that need an answer (with sender), reviews waiting for me. Then the details per source. Do not invent anything; say plainly when a source could not be read.",
};

export function ensureConnectionSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS connections (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      secret TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      last_at INTEGER,
      last_status TEXT,
      last_count INTEGER,
      last_error TEXT
    );
    CREATE TABLE IF NOT EXISTS cockpit_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
}

const sourceIdOf = (id) => `c-${id.slice(2, 14)}`;

function hostOf(secret) {
  try { return icsUrl(secret).hostname; } catch { return null; }
}

function publicConn(r) {
  return {
    id: r.id, kind: r.kind, title: r.title, enabled: !!r.enabled,
    // Never the link itself: it is the key to the calendar.
    hint: r.kind === "ics" ? hostOf(r.secret) : null,
    last: r.last_at ? { at: r.last_at, status: r.last_status, count: r.last_count, error: r.last_error } : null,
  };
}

/** The briefing settings as sent by the app, checked, or a reason. */
export function validateBriefing(b) {
  if (!b || typeof b !== "object" || Array.isArray(b)) return { error: "invalid" };
  for (const k of Object.keys(b)) if (!["enabled", "time", "days", "prompt"].includes(k)) return { error: "invalid" };
  if (typeof b.enabled !== "boolean") return { error: "invalid" };
  try { parseTime(b.time); } catch { return { error: "time" }; }
  if (!Array.isArray(b.days) || !b.days.length || b.days.some((d) => !Number.isInteger(d) || d < 1 || d > 7) || new Set(b.days).size !== b.days.length) return { error: "days" };
  if (typeof b.prompt !== "string" || !b.prompt.trim() || b.prompt.length > MAX_PROMPT_CHARS || /[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(b.prompt)) return { error: "prompt" };
  return { value: { enabled: b.enabled, time: b.time, days: [...b.days].sort(), prompt: b.prompt.trim() } };
}

/**
 * deps: { claudeBin, ghBin, connectorConfigDir, workDir, env, tz(): string|null,
 *         connectorLogin (createClaudeLogin instance for the connector profile) }
 */
export function createConnections({ db, log = () => {}, now = Date.now, deps }) {
  ensureConnectionSchema(db);
  const q = {
    all: db.prepare("SELECT * FROM connections ORDER BY created_at, id"),
    get: db.prepare("SELECT * FROM connections WHERE id = ?"),
    count: db.prepare("SELECT COUNT(*) AS n FROM connections"),
    insert: db.prepare("INSERT INTO connections (id, kind, title, secret, enabled, created_at) VALUES (?, ?, ?, ?, 1, ?)"),
    update: db.prepare("UPDATE connections SET title = ?, enabled = ? WHERE id = ?"),
    remove: db.prepare("DELETE FROM connections WHERE id = ?"),
    last: db.prepare("UPDATE connections SET last_at = ?, last_status = ?, last_count = ?, last_error = ? WHERE id = ?"),
    getSetting: db.prepare("SELECT value FROM cockpit_settings WHERE key = ?"),
    setSetting: db.prepare("INSERT INTO cockpit_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"),
  };
  const tz = () => { const t = deps.tz?.(); return t && isValidZone(t) ? t : systemZone(); };
  // The claude.ai connectors stay behind CONDUIT_CONNECTORS=1 until a run in
  // a real, freshly signed-in connector profile has been proven (3.9.2).
  const connectorsOn = () => deps.connectorsEnabled === true;
  const kindOn = (k) => !CONNECTOR_KINDS.includes(k) || connectorsOn();
  // Every running read (gh, connector, calendar fetch): the emergency stop
  // ends them all, whoever started them (a briefing or "Check").
  const handles = new Set();
  const lastCheck = new Map(); // id -> ms: "Check" at most every 10 s per connection
  const stoppedNow = () => deps.stopped?.() === true;

  function briefing() {
    try { const v = JSON.parse(q.getSetting.get("briefing")?.value || "null"); const c = v && validateBriefing(v); if (c?.value) return c.value; } catch { /* default */ }
    return { ...DEFAULT_BRIEFING };
  }

  async function collectOne(r, { register: outer } = {}) {
    const conn = { ...r, sourceId: sourceIdOf(r.id) };
    const at = now();
    const register = (h, on) => { if (on) handles.add(h); else handles.delete(h); outer?.(h, on); };
    if (stoppedNow()) return null;
    let src;
    try {
      if (r.kind === "ics") src = await icsSource({ ...conn, secret: r.secret }, { tz: tz(), now: at, register });
      else if (r.kind === "github") src = await githubSource(conn, { ghBin: deps.ghBin, env: deps.env, now: at, register });
      else src = await connectorSource(conn, { bin: deps.claudeBin, tz: tz(), configDir: deps.connectorConfigDir, workDir: deps.workDir, env: deps.env, now: at, register, stopped: stoppedNow });
    } catch (e) {
      src = { id: conn.sourceId, title: r.title, status: "error", count: null, newCount: null, fetchedAt: new Date(at).toISOString(), text: "", error: "collect failed" };
      log("error", "connection_collect_crashed", { kind: r.kind, err: String(e?.message || e).slice(0, 120) });
    }
    // Removed or switched off while it was read: its result is dropped, so
    // nothing reopens the to-dos that the removal closed.
    const still = q.get.get(r.id);
    if (!still || !still.enabled || stoppedNow()) return null;
    q.last.run(at, src.status, src.count ?? null, src.error ? String(src.error).slice(0, 160) : null, r.id);
    // Never logged: the text (mail, calendar) and the link.
    log(src.status === "error" ? "warn" : "info", "connection_collected", { kind: r.kind, status: src.status, count: src.count ?? null });
    const { error: _e, signedOut: _s, ...clean } = src;
    return clean;
  }

  return {
    briefing,

    /** For automations.mjs: the app-made briefing, as a config, or null. */
    builtinConfig(owner) {
      const b = briefing();
      // Nothing connected, nothing to brief from.
      if (!b.enabled || !owner || !q.all.all().some((r) => r.enabled && kindOn(r.kind))) return null;
      return {
        owner: String(owner).toLowerCase(), tz: tz(),
        // Push services need a contact; this one carries no personal address.
        push: { contact: "https://tryconduit.de" }, alerts: null,
        automations: [{ id: "briefing", title: "Morning briefing", schedule: { time: b.time, days: b.days }, prompt: b.prompt,
          collect: null, deliver: null, deliverFull: false, push: true, windowMs: DEFAULT_WINDOW_HOURS * 3600000 }],
      };
    },

    /** Sources of every enabled connection, one after the other. */
    async extraSources({ register } = {}) {
      const out = [];
      for (const listed of q.all.all()) {
        if (stoppedNow()) break;
        // Read again right before the fetch: removed or switched off while an
        // earlier one was read means not read at all.
        const r = q.get.get(listed.id);
        if (!r || !r.enabled || !kindOn(r.kind)) continue;
        const src = await collectOne(r, { register });
        if (src) out.push({ connId: r.id, src });
      }
      // Once more at the end: a connection removed or switched off while a
      // later one was read gives nothing (its to-dos were closed by then).
      const live = new Set(q.all.all().filter((r) => r.enabled).map((r) => r.id));
      return stoppedNow() ? [] : out.filter((x) => live.has(x.connId)).map((x) => x.src);
    },

    /** Emergency stop. Returns how many reads were running. */
    stopAll() { const n = handles.size; for (const h of [...handles]) { try { h.stop(); } catch { /* gone */ } } return n; },
    killAllNow() { for (const h of [...handles]) { try { h.killNow(); } catch { /* gone */ } } },

    connectorsEnabled: connectorsOn,

    async status() {
      const conns = q.all.all().map(publicConn);
      let connector = null;
      if (deps.connectorLogin && connectorsOn()) {
        try { const s = deps.connectorLogin.status(); connector = { state: s.state, method: s.method, expiresAt: s.expiresAt, checkedAt: s.checkedAt, login: s.login }; } catch { /* unknown */ }
      }
      return {
        connections: conns,
        kinds: KINDS.filter(kindOn).map((k) => ({ kind: k, title: KIND_TITLE[k], available: k === "github" ? !!deps.ghBin : true, viaClaude: CONNECTOR_KINDS.includes(k) })),
        connector,
        tz: tz(),
      };
    },

    async add({ kind, title, link } = {}) {
      if (!KINDS.includes(kind) || !kindOn(kind)) return { ok: false, error: "kind" };
      if (q.count.get().n >= MAX_CONNECTIONS) return { ok: false, error: "full" };
      let secret = null;
      if (kind === "ics") {
        try { secret = icsUrl(link).toString(); } catch (e) { return { ok: false, error: "link", detail: e.message }; }
      }
      const t = cleanText(title ?? "")?.slice(0, 60) || KIND_TITLE[kind];
      const id = `c_${randomUUID()}`;
      q.insert.run(id, kind, t, secret, now());
      log("info", "connection_added", { kind });
      return { ok: true, connection: publicConn(q.get.get(id)) };
    },

    update(id, { title, enabled } = {}) {
      if (!ID_RE.test(String(id))) return { ok: false, error: "not_found" };
      const r = q.get.get(id);
      if (!r) return { ok: false, error: "not_found" };
      if (enabled !== undefined && typeof enabled !== "boolean") return { ok: false, error: "invalid" };
      const t = title === undefined ? r.title : (cleanText(title)?.slice(0, 60) || null);
      if (!t) return { ok: false, error: "invalid" };
      q.update.run(t, enabled === undefined ? r.enabled : (enabled ? 1 : 0), id);
      return { ok: true, connection: publicConn(q.get.get(id)) };
    },

    remove(id) {
      if (!ID_RE.test(String(id))) return { ok: false, error: "not_found" };
      const n = q.remove.run(id).changes;
      if (n) {
        log("info", "connection_removed", {});
        // Its to-dos would otherwise stay open for ever: nothing lists them again.
        try { deps.onRemoved?.(sourceIdOf(id)); } catch (e) { log("error", "connection_todos_close_failed", { err: String(e?.message || e).slice(0, 120) }); }
      }
      return n ? { ok: true } : { ok: false, error: "not_found" };
    },

    /** Collect one connection now; the app sees status and count, never the text. */
    async check(id) {
      if (!ID_RE.test(String(id))) return { ok: false, error: "not_found" };
      const r = q.get.get(id);
      if (!r) return { ok: false, error: "not_found" };
      // Switched off means not read, also on request (the app's button is only a hint).
      if (!r.enabled || !kindOn(r.kind)) return { ok: false, error: "disabled" };
      // Throttled only after a read that worked: a retry right after fixing a
      // problem (signing in, say) always goes through.
      if (now() - (lastCheck.get(id) || 0) < 10_000) return { ok: false, error: "throttled" };
      const src = await collectOne(r);
      if (src && src.status !== "error") lastCheck.set(id, now());
      if (!src) {
        if (stoppedNow()) return { ok: false, error: "emergency" };
        // Dropped because it changed during the read: still there means it was
        // switched off (or its kind turned off), not removed.
        return q.get.get(id) ? { ok: false, error: "disabled" } : { ok: false, error: "not_found" };
      }
      return { ok: true, connection: publicConn(q.get.get(id)), result: { status: src.status, count: src.count ?? null } };
    },

    setBriefing(b) {
      const v = validateBriefing(b);
      if (v.error) return { ok: false, error: v.error };
      q.setSetting.run("briefing", JSON.stringify(v.value));
      log("info", "briefing_settings_saved", { enabled: v.value.enabled, time: v.value.time, days: v.value.days.length });
      return { ok: true, briefing: v.value };
    },
  };
}
