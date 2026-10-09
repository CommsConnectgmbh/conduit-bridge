import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";

const DB_DIR = process.env.DB_DIR || join(homedir(), "Library/conduit-bridge");
mkdirSync(DB_DIR, { recursive: true });
const DB_PATH = join(DB_DIR, "db.sqlite");

export const db = new DatabaseSync(DB_PATH);
// Two bridge processes can briefly overlap (a self-update restart), and WAL
// allows that — but without a busy timeout every concurrent write throws
// SQLITE_BUSY immediately, which surfaces as a wave of failed turns rather than
// a short wait.
try { db.exec("PRAGMA busy_timeout = 5000"); } catch { /* older runtimes */ }

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA synchronous = NORMAL;

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_email TEXT NOT NULL,
    claude_session_id TEXT,
    title TEXT NOT NULL DEFAULT 'Neuer Chat',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_user_updated ON sessions(user_email, updated_at DESC);

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    ts INTEGER NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_messages_session_ts ON messages(session_id, ts);

  -- Audit trail: one row per tool/file/shell action the assistant took, from the
  -- same tool_use/tool_result stream that drives the live activity panel.
  --
  -- SCOPE, deliberately: this is a record FOR THE USER of what the assistant did
  -- in their sessions — not a tamper-evident compliance log. The CASCADE below
  -- is intentional: deleting a chat deletes its trail with it, because delete
  -- has to mean delete. Anyone who needs an audit record that survives the
  -- subject deleting it needs to ship it off this machine as it is written; a
  -- log the audited party can erase proves nothing anyway.
  CREATE TABLE IF NOT EXISTS audit_log (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    assistant_id TEXT,
    tool_use_id TEXT,
    ts INTEGER NOT NULL,
    tool TEXT NOT NULL,
    summary TEXT,
    status TEXT NOT NULL DEFAULT 'running',
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_audit_session_ts ON audit_log(session_id, ts);
  CREATE INDEX IF NOT EXISTS idx_audit_tooluse ON audit_log(session_id, tool_use_id);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS paired_devices (
    jti        TEXT PRIMARY KEY,
    email      TEXT NOT NULL,
    label      TEXT NOT NULL DEFAULT 'Device',
    created_at INTEGER NOT NULL,
    last_seen  INTEGER NOT NULL,
    revoked    INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_devices_email ON paired_devices(email, created_at DESC);
`);

// End-to-end devices: every app installation is identified by its X25519
// public key, authorised here when it pairs (QR on the loopback page, or a
// code issued through an already paired device). Revocation is a timestamp,
// not a delete, so the list keeps showing what was paired and when.
db.exec(`
  CREATE TABLE IF NOT EXISTS e2e_devices (
    pubkey     TEXT PRIMARY KEY,
    device_id  TEXT NOT NULL UNIQUE,
    email      TEXT NOT NULL,
    label      TEXT NOT NULL,
    platform   TEXT NOT NULL,
    paired_via TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_seen  INTEGER NOT NULL,
    revoked_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_e2e_devices_email ON e2e_devices(email, created_at DESC);
`);

// Idempotent column-adds: SQLite ALTER throws if column exists, so wrap each.
for (const ddl of [
  // Which user message an assistant row answers, and how that turn ended.
  // Retry handling used to infer the pairing from timestamp order, which ties
  // when two messages land in the same millisecond and silently reports a
  // failed turn as a finished one.
  "ALTER TABLE messages ADD COLUMN reply_to TEXT",
  // NOT called `status`: that column already exists on this table from an older
  // feature, carrying 'done'/'interrupted' for ~600 rows. Adding it again fails
  // silently, and writing our values into it would overload a column that
  // already means something else.
  "ALTER TABLE messages ADD COLUMN turn_status TEXT",
  "ALTER TABLE sessions ADD COLUMN cwd TEXT",
  "ALTER TABLE sessions ADD COLUMN tokens_in INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE sessions ADD COLUMN tokens_out INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE sessions ADD COLUMN cache_read INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE sessions ADD COLUMN cache_create INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE sessions ADD COLUMN cost_usd REAL NOT NULL DEFAULT 0",
  "ALTER TABLE sessions ADD COLUMN turns INTEGER NOT NULL DEFAULT 0",
  // Full detail behind an audit row, so an old transcript can show what a step
  // actually ran and what came back — `summary` is truncated to 80 chars and
  // was only ever meant for a one-line label. Both are capped on write (see
  // AUDIT_INPUT_CAP / AUDIT_OUTPUT_CAP in server.mjs); `output_bytes` keeps the
  // true size so the UI can say how much was dropped.
  "ALTER TABLE audit_log ADD COLUMN input_full TEXT",
  "ALTER TABLE audit_log ADD COLUMN output TEXT",
  "ALTER TABLE audit_log ADD COLUMN output_bytes INTEGER",
  "ALTER TABLE audit_log ADD COLUMN duration_ms INTEGER",
  "ALTER TABLE sessions ADD COLUMN engine TEXT DEFAULT 'claude'",
  "ALTER TABLE sessions ADD COLUMN model TEXT",
  "ALTER TABLE sessions ADD COLUMN agy_conversation_id TEXT",
  "ALTER TABLE sessions ADD COLUMN codex_thread_id TEXT",
  "ALTER TABLE messages ADD COLUMN model TEXT",
]) {
  try { db.exec(ddl); } catch { /* column already present */ }
}

const Q = {
  upsertSessionGuarded: db.prepare(`
    INSERT INTO sessions (id, user_email, title, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at
      WHERE sessions.user_email = excluded.user_email
  `),
  upsertSession: db.prepare(`
    INSERT INTO sessions (id, user_email, title, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at
  `),
  setClaudeSessionId: db.prepare(`UPDATE sessions SET claude_session_id = ?, updated_at = ? WHERE id = ?`),
  setAgyConversationId: db.prepare(`UPDATE sessions SET agy_conversation_id = ?, updated_at = ? WHERE id = ?`),
  setCodexThreadId: db.prepare(`UPDATE sessions SET codex_thread_id = ?, updated_at = ? WHERE id = ?`),
  setEngine: db.prepare(`UPDATE sessions SET engine = ?, model = ?, updated_at = ? WHERE id = ? AND user_email = ?`),
  setTitle: db.prepare(`UPDATE sessions SET title = ?, updated_at = ? WHERE id = ? AND user_email = ?`),
  setCwd: db.prepare(`UPDATE sessions SET cwd = ?, updated_at = ? WHERE id = ? AND user_email = ?`),
  touchSession: db.prepare(`UPDATE sessions SET updated_at = ? WHERE id = ?`),
  getSession: db.prepare(`SELECT * FROM sessions WHERE id = ? AND user_email = ?`),
  getSessionRaw: db.prepare(`SELECT * FROM sessions WHERE id = ?`),
  listSessions: db.prepare(`
    SELECT id, title, updated_at, cwd, tokens_in, tokens_out, cache_read, cache_create, cost_usd, turns, engine, model, claude_session_id, agy_conversation_id
    FROM sessions WHERE user_email = ? ORDER BY updated_at DESC LIMIT 100
  `),
  deleteSession: db.prepare(`DELETE FROM sessions WHERE id = ? AND user_email = ?`),
  insertMessage: db.prepare(`INSERT INTO messages (id, session_id, role, content, ts) VALUES (?, ?, ?, ?, ?)`),
  insertAssistant: db.prepare(`INSERT INTO messages (id, session_id, role, content, ts, reply_to, model) VALUES (?, ?, 'assistant', '', ?, ?, ?)`),
  setMessageStatus: db.prepare(`UPDATE messages SET turn_status = ? WHERE id = ? AND session_id = ?`),
  assistantFor: db.prepare(`SELECT id, content, turn_status, model FROM messages WHERE session_id = ? AND reply_to = ? ORDER BY ts ASC LIMIT 1`),
  listMessages: db.prepare(`SELECT id, role, content, ts, reply_to, model FROM messages WHERE session_id = ? ORDER BY ts ASC`),
  getMessageInSession: db.prepare(`SELECT id FROM messages WHERE id = ? AND session_id = ?`),
  appendAssistant: db.prepare(`UPDATE messages SET content = content || ? WHERE id = ? AND session_id = ?`),
  insertAudit: db.prepare(`INSERT INTO audit_log (id, session_id, assistant_id, tool_use_id, ts, tool, summary, status, input_full) VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?)`),
  finishAudit: db.prepare(`UPDATE audit_log SET status = ?, output = ?, output_bytes = ?, duration_ms = ? WHERE session_id = ? AND tool_use_id IS ? AND status = 'running'`),
  getAuditStep: db.prepare(`
    SELECT a.id, a.assistant_id, a.tool, a.summary, a.status, a.ts,
           a.input_full, a.output, a.output_bytes, a.duration_ms
    FROM audit_log a JOIN sessions s ON s.id = a.session_id
    WHERE a.id = ? AND s.user_email = ?
  `),
  sweepRunningAudit: db.prepare(`UPDATE audit_log SET status = 'interrupted' WHERE status = 'running'`),
  // Tool steps of one session, oldest first, for rebuilding the per-message
  // "what this turn did" summary when a transcript is loaded from history.
  // Rows predating assistant_id (or written by an interrupted turn) have no
  // message to hang off and are skipped rather than lumped onto the wrong one.
  listSessionAudit: db.prepare(`
    SELECT id, assistant_id, tool, summary, status, ts, duration_ms,
           -- Whether asking for this step's detail is worth a round trip.
           (input_full IS NOT NULL OR output IS NOT NULL) AS has_detail
    FROM audit_log
    WHERE session_id = ? AND assistant_id IS NOT NULL
    ORDER BY ts ASC LIMIT ?
  `),
  listAudit: db.prepare(`
    SELECT a.id, a.session_id, s.title AS session_title, a.tool, a.summary, a.status, a.ts
    FROM audit_log a JOIN sessions s ON s.id = a.session_id
    WHERE s.user_email = ? AND a.ts >= ?
    ORDER BY a.ts DESC LIMIT ?
  `),
  addUsage: db.prepare(`
    UPDATE sessions SET
      tokens_in    = tokens_in    + ?,
      tokens_out   = tokens_out   + ?,
      cache_read   = cache_read   + ?,
      cache_create = cache_create + ?,
      cost_usd     = cost_usd     + ?,
      turns        = turns        + 1,
      updated_at   = ?
    WHERE id = ?
  `),
};


// --- End-to-end devices -----------------------------------------------------
const EQ = {
  insert: db.prepare(`
    INSERT INTO e2e_devices (pubkey, device_id, email, label, platform, paired_via, created_at, last_seen, revoked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
    ON CONFLICT(pubkey) DO UPDATE SET
      email = excluded.email, label = excluded.label, platform = excluded.platform,
      paired_via = excluded.paired_via, last_seen = excluded.last_seen, revoked_at = NULL
  `),
  get: db.prepare(`SELECT * FROM e2e_devices WHERE pubkey = ?`),
  list: db.prepare(`SELECT * FROM e2e_devices WHERE email = ? ORDER BY created_at DESC LIMIT 200`),
  listAll: db.prepare(`SELECT * FROM e2e_devices ORDER BY created_at DESC LIMIT 500`),
  revoke: db.prepare(`UPDATE e2e_devices SET revoked_at = ? WHERE device_id = ? AND email = ? AND revoked_at IS NULL`),
  revokeAny: db.prepare(`UPDATE e2e_devices SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL`),
  touch: db.prepare(`UPDATE e2e_devices SET last_seen = ? WHERE pubkey = ?`),
};

/** Authorise a device key. Re-pairing a revoked key makes it valid again. */
export function addE2eDevice({ pubkey, deviceId, email, label, platform, pairedVia }) {
  const now = Date.now();
  EQ.insert.run(pubkey, deviceId, email, String(label || "Device").slice(0, 80), String(platform || "web").slice(0, 20), pairedVia, now, now);
}

/** The device row for a key, or null. Callers must check revoked_at. */
export function getE2eDevice(pubkey) {
  return EQ.get.get(pubkey) || null;
}

export function listE2eDevices(email) {
  return email ? EQ.list.all(email) : EQ.listAll.all();
}

/** Revoke by device id; scoped to an email unless called from the loopback page. */
export function revokeE2eDevice(deviceId, email) {
  const now = Date.now();
  return (email ? EQ.revoke.run(now, deviceId, email) : EQ.revokeAny.run(now, deviceId)).changes;
}

export function touchE2eDevice(pubkey) {
  try { EQ.touch.run(Date.now(), pubkey); } catch { /* cosmetic */ }
}

// Owner identity for pairing when PAIR_OWNER_EMAIL isn't set: the email of the
// most recently active session, i.e. whoever last used this bridge. Keeps a
// paired phone on the same history without the installer knowing the email.
const DQ_latestEmail = db.prepare(`SELECT user_email FROM sessions ORDER BY updated_at DESC LIMIT 1`);
export function latestSessionEmail() {
  const r = DQ_latestEmail.get();
  return r ? String(r.user_email) : "";
}

export function ensureSession(sid, email, title = "Neuer Chat") {
  const now = Date.now();
  const existing = Q.getSessionRaw.get(sid);
  if (existing) {
    if (existing.user_email !== email) return null;
    Q.touchSession.run(now, sid);
    return existing;
  }
  // Guarded upsert: the plain ON CONFLICT branch bumped updated_at even when
  // the row belonged to someone else, which reorders their session list and
  // shifts "most recently active" — the signal pairing used to resolve an owner.
  Q.upsertSessionGuarded.run(sid, email, title, now, now);
  // Re-read and re-check the owner. The upsert's ON CONFLICT branch only bumps
  // updated_at and does not compare user_email, so if another process created
  // this sid between the check above and here, we would otherwise return THEIR
  // session as if it were ours.
  const row = Q.getSessionRaw.get(sid);
  if (row && row.user_email !== email) return null;
  return row;
}

export function setClaudeSessionId(sid, claudeSid) {
  Q.setClaudeSessionId.run(claudeSid, Date.now(), sid);
}

export function setAgyConversationId(sid, agyConvId) {
  Q.setAgyConversationId.run(agyConvId, Date.now(), sid);
}

export function setCodexThreadId(sid, threadId) {
  Q.setCodexThreadId.run(threadId, Date.now(), sid);
}

export function updateSessionEngine(sid, email, engine, model = null) {
  return Q.setEngine.run(engine, model, Date.now(), sid, email);
}

export function updateTitle(sid, email, title) {
  return Q.setTitle.run(title, Date.now(), sid, email);
}

export function updateCwd(sid, email, cwd) {
  return Q.setCwd.run(cwd, Date.now(), sid, email);
}

export function listSessions(email) {
  return Q.listSessions.all(email);
}

export function getSession(sid, email) {
  return Q.getSession.get(sid, email);
}

/**
 * Owner of an existing session, or null when the session doesn't exist yet.
 *
 * Used by the WS upgrade handler to reject a socket that names someone else's
 * sid *before* it is subscribed to that session's runtime. Deliberately does
 * NOT create a row (unlike ensureSession) — a fresh chat gets its row on the
 * first prompt, and connecting must not litter the session list.
 */
export function sessionOwner(sid) {
  const row = Q.getSessionRaw.get(sid);
  return row ? row.user_email : null;
}

export function deleteSession(sid, email) {
  return Q.deleteSession.run(sid, email);
}

export function listMessages(sid, email) {
  const s = Q.getSession.get(sid, email);
  if (!s) return null;
  return Q.listMessages.all(sid);
}

/** Tool steps for one session. Email-scoped through the session row, same as
 *  listMessages — a session id alone must never be enough to read someone
 *  else's trail. Returns null when the session isn't the caller's. */
export function listSessionAudit(sid, email, limit = 1000) {
  const s = Q.getSession.get(sid, email);
  if (!s) return null;
  return Q.listSessionAudit.all(sid, Math.max(1, Math.min(2000, Number(limit) || 1000)));
}

// --- History search --------------------------------------------------------
// Matching runs in JS rather than in SQL on purpose. SQLite's LIKE and lower()
// only fold case for ASCII, so a search for "ökonomie" would never find
// "Ökonomie" — in a German transcript that is exactly the case people search
// for. FTS5 was the other candidate and is worse here: assistant text is
// appended chunk by chunk (appendAssistant), so an FTS trigger would reindex
// every answer dozens of times per turn to speed up a query that walks a
// personal history in a few milliseconds.
const SQ = {
  // Newest first so the walk can stop at the first `limit` hits — the common
  // search ("what did I call that script last week") never reads the old tail.
  scanMessages: db.prepare(`
    SELECT m.id, m.session_id, m.role, m.content, m.ts, s.title AS session_title
    FROM messages m JOIN sessions s ON s.id = m.session_id
    WHERE s.user_email = ? AND m.content <> ''
    ORDER BY m.ts DESC
  `),
  scanSessions: db.prepare(`
    SELECT id, title, updated_at FROM sessions
    WHERE user_email = ? ORDER BY updated_at DESC LIMIT 500
  `),
  // Tool steps: the command as it ran and what it printed. Rows without an
  // assistant_id are skipped — the transcript hangs steps off their answer, so a
  // step with nothing to hang off could be found here but never opened.
  scanSteps: db.prepare(`
    SELECT a.id, a.session_id, a.assistant_id, a.tool, a.summary, a.status, a.ts,
           a.input_full, a.output, s.title AS session_title
    FROM audit_log a JOIN sessions s ON s.id = a.session_id
    WHERE s.user_email = ? AND a.assistant_id IS NOT NULL
    ORDER BY a.ts DESC
  `),
};

const SNIPPET_BEFORE = 70;
const SNIPPET_AFTER = 190;

/** All positions of `needle` in `hay` (both already lower-cased), capped so a
 *  query that matches hundreds of times in one message can't blow up the JSON. */
function allIndexes(hay, needle, cap = 8) {
  const out = [];
  let i = hay.indexOf(needle);
  while (i >= 0 && out.length < cap) {
    out.push(i);
    i = hay.indexOf(needle, i + needle.length);
  }
  return out;
}

/**
 * One readable line of context around the first match, plus the offsets of every
 * match inside it so the client can mark them without re-implementing the
 * case folding. Newlines collapse to spaces: a snippet is a preview, and a code
 * block's line breaks turn it into a wall in a 288px sidebar.
 */
function buildSnippet(content, lowered, needle, firstAt) {
  const start = Math.max(0, firstAt - SNIPPET_BEFORE);
  const end = Math.min(content.length, firstAt + needle.length + SNIPPET_AFTER);
  const raw = content.slice(start, end);
  // Collapse runs of whitespace, keeping a map from raw offsets to snippet
  // offsets so the marks still point at the match after the rewrite.
  let text = "";
  const map = new Array(raw.length + 1).fill(0);
  let pendingSpace = false;
  for (let i = 0; i < raw.length; i++) {
    map[i] = text.length + (pendingSpace ? 1 : 0);
    const ch = raw[i];
    if (ch === "\n" || ch === "\r" || ch === "\t" || ch === " ") {
      if (text.length > 0) pendingSpace = true;
      continue;
    }
    if (pendingSpace) { text += " "; pendingSpace = false; }
    text += ch;
  }
  map[raw.length] = text.length;
  const marks = allIndexes(lowered.slice(start, end), needle)
    .map((at) => [map[at], Math.max(0, map[Math.min(raw.length, at + needle.length)] - map[at])])
    .filter(([, len]) => len > 0);
  return {
    // Only the tail may be trimmed: a leading cut would shift every mark, and
    // the loop above can never produce leading whitespace anyway.
    snippet: (start > 0 ? "…" : "") + text.replace(/\s+$/, "") + (end < content.length ? "…" : ""),
    // The leading ellipsis shifts every mark by one character.
    marks: start > 0 ? marks.map(([at, len]) => [at + 1, len]) : marks,
  };
}

/** First field of a step that contains the needle, in the order a reader would
 *  expect to be told about: what ran, then what it printed, then the label. */
function stepMatch(row, needle) {
  for (const [field, text] of [
    ["input", row.input_full],
    ["output", row.output],
    ["summary", row.summary],
  ]) {
    const s = text ? String(text) : "";
    if (!s) continue;
    const lowered = s.toLocaleLowerCase("de");
    const at = lowered.indexOf(needle);
    if (at >= 0) return { field, text: s, lowered, at };
  }
  return null;
}

/**
 * Search a user's own history: message bodies, chat titles, and the tool steps
 * behind the answers (the command as it ran and what it printed).
 *
 * Email-scoped through the session join — a search must never surface another
 * account's transcript, the same rule listMessages follows. `maxScan` bounds the
 * work for a history far larger than a laptop's: past it the answer says so
 * (`truncated`) instead of quietly pretending the older chats hold nothing.
 */
export function searchHistory(email, query, { limit = 40, maxScan = 20000 } = {}) {
  const needle = String(query || "").trim().toLocaleLowerCase("de");
  const hits = [];
  const sessions = [];
  const steps = [];
  if (needle.length < 2) return { hits, sessions, steps, scanned: 0, truncated: false };

  for (const r of SQ.scanSessions.all(email)) {
    const title = String(r.title || "");
    const at = title.toLocaleLowerCase("de").indexOf(needle);
    if (at < 0) continue;
    sessions.push({ id: r.id, title, updatedAt: r.updated_at, marks: [[at, needle.length]] });
    if (sessions.length >= 20) break;
  }

  let scanned = 0;
  let truncated = false;
  for (const r of SQ.scanMessages.iterate(email)) {
    if (scanned >= maxScan) { truncated = true; break; }
    scanned++;
    const content = String(r.content || "");
    const lowered = content.toLocaleLowerCase("de");
    const at = lowered.indexOf(needle);
    if (at < 0) continue;
    const { snippet, marks } = buildSnippet(content, lowered, needle, at);
    hits.push({
      messageId: r.id,
      sessionId: r.session_id,
      sessionTitle: r.session_title || "Chat",
      role: r.role,
      ts: r.ts,
      snippet,
      marks,
    });
    if (hits.length >= limit) break;
  }

  // Tool steps get their own walk and their own budget: an agent run writes far
  // more steps than messages, and letting them share a budget would mean a busy
  // week of Bash calls pushing the answers out of the result.
  let stepScanned = 0;
  for (const r of SQ.scanSteps.iterate(email)) {
    if (stepScanned >= maxScan) { truncated = true; break; }
    stepScanned++;
    const m = stepMatch(r, needle);
    if (!m) continue;
    const { snippet, marks } = buildSnippet(m.text, m.lowered, needle, m.at);
    steps.push({
      stepId: r.id,
      sessionId: r.session_id,
      sessionTitle: r.session_title || "Chat",
      assistantId: r.assistant_id,
      tool: r.tool,
      summary: r.summary || "",
      status: r.status,
      ts: r.ts,
      // Which part matched, so the row can say "Befehl" or "Ausgabe" instead of
      // leaving the reader to guess what they are looking at.
      field: m.field,
      snippet,
      marks,
    });
    if (steps.length >= limit) break;
  }
  return { hits, sessions, steps, scanned: scanned + stepScanned, truncated };
}

export function insertUserMessage(sid, msgId, content) {
  const now = Date.now();
  Q.insertMessage.run(msgId, sid, "user", content, now);
  try { Q.touchSession.run(now, sid); } catch {}
}

export function insertAssistantPlaceholder(sid, msgId, replyTo = null, model = null) {
  const now = Date.now();
  Q.insertAssistant.run(msgId, sid, now, replyTo, model);
  try { Q.touchSession.run(now, sid); } catch {}
}

/** Record how a turn ended, so a later retry can replay the truth. */
export function setMessageStatus(sid, msgId, status) {
  try { Q.setMessageStatus.run(status, msgId, sid); } catch { /* row may be gone */ }
  try { Q.touchSession.run(Date.now(), sid); } catch {}
}

/**
 * Append streamed text to an assistant message.
 *
 * Scoped by session on purpose: message ids come from the client, and
 * insertAssistantPlaceholder swallows a primary-key conflict. Without the
 * session in the WHERE clause, a turn could append its output onto an existing
 * row belonging to a different session.
 */
/**
 * Has this exact user message already been recorded in this session?
 *
 * The basis for retry handling: client message ids are stable across a mobile
 * reconnect, so a repeated id means "same prompt sent twice", not "new prompt".
 */
export function userMessageExists(sid, msgId) {
  return !!Q.getMessageInSession.get(msgId, sid);
}

/**
 * The assistant message that answered a given user message, if any.
 *
 * Uses the explicit reply_to link. Rows written before that column existed have
 * no link and are deliberately NOT matched: answering "no record" makes the
 * caller re-run the prompt, which is the safe direction compared with handing
 * back some other turn's answer.
 */
export function assistantAfter(sid, userMsgId) {
  return Q.assistantFor.get(sid, userMsgId) || null;
}

export function appendAssistant(msgId, text, sid) {
  Q.appendAssistant.run(text, msgId, sid);
  try { Q.touchSession.run(Date.now(), sid); } catch {}
}

// --- Audit trail ---------------------------------------------------------
let auditSeq = 0;
function auditRowId() {
  return `${Date.now().toString(36)}-${(auditSeq++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
/** Record a tool call starting. Best-effort: never let auditing break a turn.
 *  Returns the row id so the caller can hand it to the client, which needs it
 *  to ask for this step's detail later. */
export function recordAuditStart(sid, assistantId, toolUseId, tool, summary, inputFull) {
  const id = auditRowId();
  try {
    Q.insertAudit.run(id, sid, assistantId || null, toolUseId || null, Date.now(), String(tool || "tool"), summary || null, inputFull ?? null);
  } catch { /* auditing must never break a turn */ }
  return id;
}
/** Flip a recorded tool call to done/failed when its result comes back, and
 *  store what it produced. `outputBytes` is the size BEFORE capping. */
export function recordAuditEnd(sid, toolUseId, ok, output, outputBytes, durationMs) {
  if (!toolUseId) return;
  try {
    Q.finishAudit.run(
      ok ? "done" : "failed",
      output ?? null,
      Number.isFinite(outputBytes) ? Math.round(outputBytes) : null,
      Number.isFinite(durationMs) ? Math.round(durationMs) : null,
      sid, toolUseId,
    );
  } catch {}
}
/** Everything recorded about one step. Email-scoped through its session — a
 *  step id on its own must not expose another account's command output. */
export function getAuditStep(id, email) {
  try { return Q.getAuditStep.get(String(id), email) || null; } catch { return null; }
}
/** Read the audit trail for a user, newest first. */
export function listAudit(email, { sinceTs = 0, limit = 500 } = {}) {
  const lim = Math.max(1, Math.min(2000, Number(limit) || 500));
  return Q.listAudit.all(email, Number(sinceTs) || 0, lim);
}
/**
 * Any row still 'running' at startup can't actually be running — the process
 * that owned it is gone (crash, kill, or a self-update restart mid-tool). Flip
 * them to a terminal 'interrupted' so the trail never shows a permanently
 * ambiguous row. Returns how many were swept.
 */
export function sweepStaleRunningAudit() {
  try { return Q.sweepRunningAudit.run().changes || 0; }
  catch { return 0; }
}

export function addUsage(sid, usage) {
  // Use Math.trunc (not `| 0`): bitwise ops clamp to 32-bit signed (~2.1B),
  // which cumulative cache-read tokens can exceed over a long session.
  const int = (x) => Math.trunc(Number(x)) || 0;
  Q.addUsage.run(
    int(usage.tokens_in),
    int(usage.tokens_out),
    int(usage.cache_read),
    int(usage.cache_create),
    Number(usage.cost_usd) || 0,
    Date.now(),
    sid,
  );
}

// Function words and conversational filler. German prompts open with a lot of
// scaffolding ("kannst du mal", "sag mal ganz kurz") that carries no topic, so
// stripping it is what turns a truncated sentence into a usable label.
const TITLE_STOPWORDS = new Set(`
ab aber ach alle allem allen aller alles als also am an andere anderen anderes auch auf aus
bei beim bin bis bist bitte brauch brauche brauchst
da dabei dafuer dafür damit dann daran darauf das dass dein deine deinem deinen deiner dem den denn der
des dessen dich die diese diesem diesen dieser dieses dir doch dort du durch
eben ehre eigentlich ein eine einem einen einer eines einfach er erst es etwa etwas euch euer
fuer für
ganz gar geht gemacht gerade gern gerne gibt gleich guck gucken
hab habe haben hallo halt hast hat hatte hatten heute hier hin
ich ihm ihn ihnen ihr ihre ihrem ihren im immer in ins ist
ja jede jedem jeden jeder jetzt
kann kannst kein keine keinen koennen koennte koenntest können könnte könntest kurz
lass lassen leider
mach machen machst macht mal man mehr mein meine meinem meinen meiner mich mir mit moechte
muss müssen möchte
nach nicht nichts noch nun nur
ob oder ohne
sag sage sagen sagst schau schaue schon schnell sehr sein seine sich sie sind so soll sollen sollte
sollten sondern sowie
total
ueber um und uns unser unsere unter
viel viele vielleicht vom von vor
waere war waren warum was weg weil weiss weiter welche wenn wer werden wie wieder will wir wird wirst wo
wohl wollen worden wuerde wuerdest würde würdest wäre weiß
zu zum zur zwar
über
a about after all also am an and any are as at
be because been but by
can could
did do does doing don dont
for from
get got
had has have he her here hers him his how
i if in into is it its
just
me more most my
no not now
of on once only or other our out
please
same she should so some
than that the their them then there these they this those to too
use
very
want was we were what when where which while who why will with would
you your
`.trim().split(/\s+/));

/** Cheap, local chat-title extraction — no model call.
 *  Drops filler and keeps content words in their original order. German noun
 *  capitalisation survives untouched, which is a free topic signal. */
export function keywordTitle(text, maxLen = 48) {
  let s = String(text || "");
  // Strip things that are never a topic: fenced code, inline code, urls,
  // absolute paths, and the @/path attachment refs the client prepends.
  s = s.replace(/```[\s\S]*?```/g, " ")
       .replace(/`[^`]*`/g, " ")
       .replace(/https?:\/\/\S+/g, " ")
       .replace(/@?(?:\/[\w.\-]+){2,}\/?/g, " ")
       .replace(/\s+/g, " ")
       .trim();
  if (!s) return "";

  // Protect email addresses from the tokeniser — a counterparty's address is
  // often the single most identifying thing in a mail-related chat.
  const mails = [];
  s = s.replace(/[\w.+\-]+@[\w\-]+\.[\w.\-]+/g, (m) => {
    mails.push(m);
    return ` \u0000${mails.length - 1}\u0000 `;
  });
  const unmask = (w) => w.replace(/\u0000(\d+)\u0000/g, (_, i) => mails[Number(i)] ?? "");

  const seen = new Set();
  const words = [];
  for (const raw of s.split(/[^\p{L}\p{N}_+#.\-\u0000]+/u)) {
    // Keep the token but judge it without trailing punctuation.
    const w = raw.replace(/^[.\-]+|[.\-]+$/g, "");
    if (w.length < 2) continue;
    const low = w.toLocaleLowerCase("de");
    if (TITLE_STOPWORDS.has(low)) continue;
    if (seen.has(low)) continue;
    seen.add(low);
    words.push(unmask(w));
    if (words.length >= 8) break;
  }
  // Nothing but filler, code or paths — hand back the cleaned text so the
  // caller's fallback never puts a raw attachment path in the sidebar.
  if (!words.length) return unmask(s).replace(/\s+/g, " ").trim().slice(0, maxLen);

  let out = "";
  for (const w of words) {
    const next = out ? `${out} ${w}` : w;
    if (next.length > maxLen) break;
    out = next;
  }
  // A single word longer than maxLen would otherwise yield an empty title.
  if (!out) out = words[0].slice(0, maxLen);
  return out.charAt(0).toLocaleUpperCase("de") + out.slice(1);
}

export function maybeAutoTitle(sid, email, firstUserText) {
  const s = Q.getSession.get(sid, email);
  if (!s) return;
  if (s.title && s.title !== "Neuer Chat") return;
  const t = keywordTitle(firstUserText);
  if (t) Q.setTitle.run(t, Date.now(), sid, email);
}
