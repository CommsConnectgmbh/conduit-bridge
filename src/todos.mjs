// To-dos on Today (Conduit 2.0, 3.8.0). One list per account, kept in the
// bridge's database so phone and computer see the same state.
//
// Three origins:
//   - "manual": typed by the account in the app;
//   - "source": a collect source of an automation lists it with a stable
//     `ref` (an unanswered request, a due reminder). The bridge matches by
//     (automation, source, ref): a new ref adds a to-do, a ticked or deleted
//     one stays so, and one that a complete source (status "ok", list not cut)
//     no longer lists is closed as "resolved". A source without a `tasks`
//     field, or one that failed or was cut short, closes nothing;
//   - "briefing": suggestions the model wrote at the end of a briefing. Each
//     successful run's open suggestions replace the previous run's open ones
//     ("replaced"); ticked ones stay, and a suggestion ticked or deleted in the
//     last 14 days is not suggested again with the same text. The model read
//     other people's mail for them, so the text is plain text only: no link is
//     taken from it.
//
// One state column: open | done | resolved | replaced | deleted.
// Every text here is data for one account's own list. Nothing in this module
// runs anything.

import { randomUUID } from "node:crypto";

export const MAX_TEXT = 300;
export const MAX_OPEN = 500;
export const MAX_SOURCE_TASKS = 50;
export const MAX_BRIEFING_TODOS = 12;
/** Done to-dos the app still shows. */
export const DONE_SHOW_MS = 7 * 24 * 3600 * 1000;
/** Closed and done rows are deleted after this; also the briefing's memory. */
export const KEEP_MS = 14 * 24 * 3600 * 1000;
export const TODOS_MARKER = "[[todos]]";
// Control, line/paragraph separators, bidi overrides and zero-width characters.
const CTRL_RE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g;
const REF_RE = /^[A-Za-z0-9._:@#/+=-]{1,128}$/;
export const ID_RE = /^t_[0-9a-f-]{36}$/;
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

/** One line of plain text, or null. */
export function cleanText(v) {
  if (typeof v !== "string") return null;
  const t = v.replace(CTRL_RE, " ").replace(/\s+/g, " ").trim();
  if (!t) return null;
  return t.length > MAX_TEXT ? t.slice(0, MAX_TEXT - 1).trimEnd() + "…" : t;
}

/** What two suggestions with the same wording share. */
export function textKey(t) {
  return String(t).normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** An https link without credentials, or null. Never fetched by the bridge. */
export function cleanUrl(v) {
  if (typeof v !== "string" || v.length > 2000) return null;
  let u;
  try { u = new URL(v); } catch { return null; }
  if (u.protocol !== "https:" || u.username || u.password) return null;
  return u.toString();
}

/**
 * The `tasks` of one collect source. Returns undefined when the field is
 * absent (the source says nothing about to-dos), { tasks, cut } when valid
 * (`cut`: more than MAX_SOURCE_TASKS were listed, so nothing may be closed),
 * or null when malformed.
 */
export function parseSourceTasks(v) {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length > 1000) return null;
  const seen = new Set();
  const out = [];
  for (const t of v) {
    if (!t || typeof t !== "object" || Array.isArray(t)) return null;
    for (const k of Object.keys(t)) if (!["ref", "text", "url"].includes(k)) return null;
    if (typeof t.ref !== "string" || !REF_RE.test(t.ref) || seen.has(t.ref)) return null;
    const text = cleanText(t.text);
    if (!text) return null;
    if (t.url !== undefined && t.url !== null && typeof t.url !== "string") return null;
    seen.add(t.ref);
    if (out.length < MAX_SOURCE_TASKS) out.push({ ref: t.ref, text, url: t.url ? cleanUrl(t.url) : null });
  }
  return { tasks: out, cut: v.length > MAX_SOURCE_TASKS };
}

/**
 * Split the model's text into the briefing and its to-do block: from the last
 * line that is exactly [[todos]] to the end. Lines starting with "- " or "* "
 * are suggestions; anything else in the block is dropped. `found` says whether
 * there was a block at all (without one, nothing is replaced).
 */
export function splitTodos(text) {
  const s = String(text || "");
  const lines = s.split("\n");
  let i = -1;
  for (let k = lines.length - 1; k >= 0; k--) if (lines[k].trim() === TODOS_MARKER) { i = k; break; }
  if (i < 0) return { text: s, todos: [], found: false };
  const todos = [];
  const seen = new Set();
  for (const l of lines.slice(i + 1)) {
    const m = l.match(/^\s*[-*]\s+(?:\[\s?\]\s+)?(.+)$/);
    if (!m) continue;
    const t = cleanText(m[1].replace(/\*\*|__|`/g, ""));
    if (!t || seen.has(textKey(t))) continue;
    seen.add(textKey(t));
    todos.push(t);
    if (todos.length >= MAX_BRIEFING_TODOS) break;
  }
  return { text: lines.slice(0, i).join("\n").trimEnd(), todos, found: true };
}

export function ensureTodoSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS todos (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      text TEXT NOT NULL,
      text_key TEXT NOT NULL,
      origin TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'open',
      automation_id TEXT,
      source_id TEXT,
      source_title TEXT,
      ref TEXT,
      url TEXT,
      run_id TEXT,
      client_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      done_at INTEGER,
      state_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS todos_email ON todos(email, state);
    CREATE UNIQUE INDEX IF NOT EXISTS todos_source_ref ON todos(email, automation_id, source_id, ref) WHERE origin = 'source';
    CREATE UNIQUE INDEX IF NOT EXISTS todos_client ON todos(email, client_id) WHERE client_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS todo_versions (email TEXT PRIMARY KEY, version INTEGER NOT NULL);
  `);
}

function rowOut(r) {
  return {
    id: r.id, text: r.text, origin: r.origin, done: r.state === "done",
    automationId: r.automation_id || null,
    source: r.origin === "source" ? { id: r.source_id, title: r.source_title } : null,
    url: r.origin === "source" ? (r.url || null) : null,
    createdAt: r.created_at, updatedAt: r.updated_at, doneAt: r.done_at ?? null,
  };
}

export function createTodos({ db, now = Date.now, log = () => {} }) {
  ensureTodoSchema(db);
  const q = {
    bump: db.prepare("INSERT INTO todo_versions (email, version) VALUES (?, 1) ON CONFLICT(email) DO UPDATE SET version = version + 1"),
    version: db.prepare("SELECT version FROM todo_versions WHERE email = ?"),
    list: db.prepare(`SELECT * FROM todos WHERE email = ? AND (state = 'open' OR (state = 'done' AND done_at >= ?))
      ORDER BY state = 'done', created_at DESC, id LIMIT ?`),
    openCount: db.prepare("SELECT COUNT(*) AS n FROM todos WHERE email = ? AND state = 'open'"),
    get: db.prepare("SELECT * FROM todos WHERE id = ? AND email = ?"),
    byClient: db.prepare("SELECT * FROM todos WHERE email = ? AND client_id = ?"),
    insert: db.prepare(`INSERT INTO todos (id, email, text, text_key, origin, state, automation_id, source_id, source_title, ref, url, run_id, client_id, created_at, updated_at, state_at)
      VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    setState: db.prepare("UPDATE todos SET state = ?, done_at = ?, state_at = ?, updated_at = ? WHERE id = ?"),
    setText: db.prepare("UPDATE todos SET text = ?, text_key = ?, updated_at = ? WHERE id = ?"),
    sourceRows: db.prepare("SELECT * FROM todos WHERE email = ? AND origin = 'source' AND automation_id = ? AND source_id = ?"),
    sourceUpdate: db.prepare("UPDATE todos SET text = ?, text_key = ?, url = ?, source_title = ?, run_id = ?, updated_at = ? WHERE id = ?"),
    reopenSource: db.prepare("UPDATE todos SET text = ?, text_key = ?, url = ?, source_title = ?, run_id = ?, state = 'open', done_at = NULL, state_at = ?, updated_at = ? WHERE id = ?"),
    closeSource: db.prepare("UPDATE todos SET state = 'resolved', state_at = ?, updated_at = ? WHERE email = ? AND origin = 'source' AND source_id = ? AND state IN ('open', 'done', 'deleted')"),
    openBriefing: db.prepare("SELECT id FROM todos WHERE email = ? AND origin = 'briefing' AND automation_id = ? AND state = 'open'"),
    // Ticked or removed by the owner: not suggested again for KEEP_MS.
    settledBriefingKeys: db.prepare("SELECT text_key FROM todos WHERE email = ? AND origin = 'briefing' AND automation_id = ? AND state IN ('done', 'deleted') AND state_at >= ?"),
    // Source rows are kept while their source lists them (a ticked or deleted
    // one would otherwise come back as new); everything else goes after KEEP_MS.
    purge: db.prepare(`DELETE FROM todos WHERE state <> 'open' AND state_at < ?
      AND NOT (origin = 'source' AND state IN ('done', 'deleted'))`),
  };
  const key = (email) => String(email || "").toLowerCase();
  const bump = (email) => q.bump.run(email);
  const tx = (fn) => {
    db.exec("BEGIN IMMEDIATE");
    try { const r = fn(); db.exec("COMMIT"); return r; } catch (e) { try { db.exec("ROLLBACK"); } catch {} throw e; }
  };
  const version = (e) => q.version.get(e)?.version || 0;
  const mine = (e, id) => {
    if (!ID_RE.test(String(id))) return null;
    const r = q.get.get(id, e);
    return r && (r.state === "open" || r.state === "done") ? r : null;
  };

  return {
    list(email) {
      const e = key(email);
      const rows = q.list.all(e, now() - DONE_SHOW_MS, MAX_OPEN + 300);
      return { version: version(e), todos: rows.map(rowOut) };
    },
    openCount(email) { return q.openCount.get(key(email)).n; },

    /** `clientId` makes a retried request (bad mobile network) a no-op. */
    add(email, text, { clientId } = {}) {
      const e = key(email);
      const t = cleanText(text);
      if (!t) return { ok: false, error: "empty" };
      if (clientId !== undefined && clientId !== null && !CLIENT_ID_RE.test(String(clientId))) return { ok: false, error: "invalid" };
      return tx(() => {
        if (clientId) {
          const prev = q.byClient.get(e, clientId);
          if (prev) return { ok: true, todo: rowOut(prev), version: version(e) };
        }
        if (q.openCount.get(e).n >= MAX_OPEN) return { ok: false, error: "full" };
        const id = `t_${randomUUID()}`;
        const ts = now();
        q.insert.run(id, e, t, textKey(t), "manual", null, null, null, null, null, null, clientId || null, ts, ts, ts);
        bump(e);
        return { ok: true, todo: rowOut(q.get.get(id, e)), version: version(e) };
      });
    },

    update(email, id, { done, text } = {}) {
      const e = key(email);
      if (done !== undefined && typeof done !== "boolean") return { ok: false, error: "invalid" };
      return tx(() => {
        const row = mine(e, id);
        if (!row) return { ok: false, error: "not_found" };
        let t = null;
        if (text !== undefined) {
          if (row.origin !== "manual") return { ok: false, error: "read_only" };
          t = cleanText(text);
          if (!t) return { ok: false, error: "empty" };
        }
        const ts = now();
        if (t !== null && t !== row.text) q.setText.run(t, textKey(t), ts, id);
        if (done !== undefined && done !== (row.state === "done")) q.setState.run(done ? "done" : "open", done ? ts : null, ts, ts, id);
        bump(e);
        return { ok: true, todo: rowOut(q.get.get(id, e)), version: version(e) };
      });
    },

    remove(email, id) {
      const e = key(email);
      return tx(() => {
        const row = mine(e, id);
        if (!row) return { ok: false, error: "not_found" };
        const ts = now();
        q.setState.run("deleted", row.done_at ?? null, ts, ts, id);
        bump(e);
        return { ok: true, version: version(e) };
      });
    },

    /**
     * Match one collect source's tasks. Only a complete list (status "ok",
     * not cut) may close what it no longer lists.
     */
    syncSource(email, { automationId, sourceId, sourceTitle, status, tasks, cut = false, runId }) {
      const e = key(email);
      const ts = now();
      return tx(() => {
        const rows = q.sourceRows.all(e, automationId, sourceId);
        const byRef = new Map(rows.map((r) => [r.ref, r]));
        let added = 0, closed = 0, changed = false;
        for (const t of tasks) {
          const r = byRef.get(t.ref);
          if (!r) {
            if (q.openCount.get(e).n >= MAX_OPEN) break;
            q.insert.run(`t_${randomUUID()}`, e, t.text, textKey(t.text), "source", automationId, sourceId, sourceTitle, t.ref, t.url, runId, null, ts, ts, ts);
            added++; changed = true;
          } else if (r.state === "resolved" || r.state === "replaced") {
            // Gone and back (a request answered, then a new message): open again.
            q.reopenSource.run(t.text, textKey(t.text), t.url, sourceTitle, runId, ts, ts, r.id);
            changed = true;
          } else if (r.state === "open" || r.state === "done") {
            if (r.text !== t.text || (r.url || null) !== t.url || r.source_title !== sourceTitle) {
              q.sourceUpdate.run(t.text, textKey(t.text), t.url, sourceTitle, runId, ts, r.id);
              changed = true;
            }
          }
          // "deleted" stays deleted while the source lists it.
        }
        if (status === "ok" && !cut) {
          const listed = new Set(tasks.map((t) => t.ref));
          for (const r of rows) {
            if (listed.has(r.ref) || r.state === "resolved") continue;
            // Settled at the source: open, done and deleted rows all end here
            // and are purged later.
            q.setState.run("resolved", r.done_at ?? null, ts, ts, r.id);
            if (r.state === "open") closed++;
            changed = true;
          }
        }
        if (changed) bump(e);
        return { added, closed };
      });
    },

    /** A source that is gone for good (a connection removed in the app): its to-dos end. */
    closeSource(email, sourceId) {
      const e = key(email);
      const ts = now();
      return tx(() => { const n = q.closeSource.run(ts, ts, e, sourceId).changes; if (n) bump(e); return n; });
    },

    /** A briefing's suggestions replace the previous run's open ones. */
    replaceBriefing(email, { automationId, runId, todos }) {
      const e = key(email);
      const ts = now();
      return tx(() => {
        let replaced = 0, added = 0;
        for (const r of q.openBriefing.all(e, automationId)) { q.setState.run("replaced", null, ts, ts, r.id); replaced++; }
        const settled = new Set(q.settledBriefingKeys.all(e, automationId, ts - KEEP_MS).map((r) => r.text_key));
        for (const raw of todos.slice(0, MAX_BRIEFING_TODOS)) {
          const t = cleanText(raw);
          if (!t || settled.has(textKey(t))) continue;
          if (q.openCount.get(e).n >= MAX_OPEN) break;
          q.insert.run(`t_${randomUUID()}`, e, t, textKey(t), "briefing", automationId, null, null, null, null, runId, null, ts, ts, ts);
          settled.add(textKey(t));
          added++;
        }
        bump(e);
        return { added, replaced };
      });
    },

    purge() {
      const n = q.purge.run(now() - KEEP_MS).changes;
      if (n) log("info", "todos_purged", { n });
      return n;
    },
  };
}
