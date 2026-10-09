// Lokale Daten aufräumen: Aufbewahrungsfristen für Chats, Audit und Anhänge,
// Rotation der Logdateien.
//
// Voreinstellung ist, was die Bridge bisher tat: Chats und Audit bleiben, bis
// der Nutzer sie löscht; Anhänge 30 Tage; bridge.log rotiert bei 10 MB mit 5
// Dateien; die Dienst-Logs des Installers rotiert niemand. Eine Firma kann das
// über Umgebungsvariablen enger stellen (siehe docs/ENTERPRISE.md).
//
// Die Funktionen hier bekommen alles, was sie brauchen, als Argument (Datenbank,
// Pfade, Uhrzeit). Dadurch lassen sie sich gegen eine Test-Datenbank und ein
// Temp-Verzeichnis prüfen, ohne eine Bridge zu starten.

import {
  existsSync, readdirSync, statSync, unlinkSync, renameSync, copyFileSync, truncateSync,
} from "node:fs";
import { join } from "node:path";

const DAY_MS = 24 * 60 * 60 * 1000;

function intEnv(env, name, def, min, max, errors) {
  const raw = env[name];
  if (raw === undefined || String(raw).trim() === "") return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    errors.push(`${name}="${raw}" is not a whole number between ${min} and ${max}; using ${def}`);
    return def;
  }
  return n;
}

/** Einstellungen aus der Umgebung. 0 Tage heißt immer „keine Frist". */
export function readHousekeepingPolicy(env = process.env, { serviceLogDirDefault = null } = {}) {
  const errors = [];
  const policy = {
    chatDays: intEnv(env, "CONDUIT_RETENTION_DAYS", 0, 0, 36500, errors),
    auditDays: intEnv(env, "CONDUIT_AUDIT_RETENTION_DAYS", 0, 0, 36500, errors),
    pasteDays: intEnv(env, "CONDUIT_PASTE_RETENTION_DAYS", 30, 0, 36500, errors),
    logMaxBytes: intEnv(env, "CONDUIT_LOG_MAX_BYTES", 10 * 1024 * 1024, 64 * 1024, 1024 * 1024 * 1024, errors),
    logFiles: intEnv(env, "CONDUIT_LOG_FILES", 5, 2, 100, errors),
    logStdout: String(env.CONDUIT_LOG_STDOUT ?? "1").trim() !== "0",
    serviceLogMaxBytes: intEnv(env, "CONDUIT_SERVICE_LOG_MAX_BYTES", 0, 0, 1024 * 1024 * 1024, errors),
    serviceLogFiles: intEnv(env, "CONDUIT_SERVICE_LOG_FILES", 3, 1, 100, errors),
    serviceLogDir: String(env.CONDUIT_SERVICE_LOG_DIR || "").trim() || serviceLogDirDefault,
  };
  // Unter 64 KB stünde die Datei bei einem gesprächigen Tunnel ständig in
  // Rotation, und jede Rotation verliert ein paar Zeilen (rotateServiceLogs).
  if (policy.serviceLogMaxBytes > 0 && policy.serviceLogMaxBytes < 64 * 1024) {
    errors.push(`CONDUIT_SERVICE_LOG_MAX_BYTES below 65536 is too small; using 65536`);
    policy.serviceLogMaxBytes = 64 * 1024;
  }
  return { ...policy, errors };
}

/**
 * Chats und Audit-Einträge löschen, die älter sind als die Frist.
 *
 * Ein Chat zählt nach seiner LETZTEN Aktivität (updated_at bzw. jüngste
 * Nachricht), nicht nach seinem Anfang — ein seit Monaten fortgeführter Chat
 * verschwindet nicht mitten in der Arbeit. Nachrichten und Audit gehen per
 * CASCADE mit, wie beim Löschen in der App.
 *
 * `keep`: Session-Ids mit laufendem oder wartendem Turn. Die bleiben, auch wenn
 * sie zu alt sind; der nächste Durchlauf erwischt sie.
 *
 * Gibt zurück, wie viele Chats und Audit-Zeilen entfernt wurden.
 */
export function purgeExpiredHistory(db, { chatDays = 0, auditDays = 0, now = Date.now(), keep = new Set() } = {}) {
  const out = { sessions: 0, audit: 0 };
  if (!(chatDays > 0) && !(auditDays > 0)) return out;
  db.exec("BEGIN IMMEDIATE");
  try {
    if (chatDays > 0) {
      const cutoff = now - chatDays * DAY_MS;
      const rows = db.prepare(`
        SELECT s.id FROM sessions s
        WHERE s.updated_at < ?
          AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.session_id = s.id AND m.ts >= ?)
      `).all(cutoff, cutoff);
      const del = db.prepare("DELETE FROM sessions WHERE id = ?");
      for (const r of rows) {
        if (keep.has(r.id)) continue;
        out.sessions += Number(del.run(r.id).changes) || 0;
      }
    }
    if (auditDays > 0) {
      const cutoff = now - auditDays * DAY_MS;
      const rows = db.prepare("SELECT id, session_id FROM audit_log WHERE ts < ? AND status != 'running'").all(cutoff);
      const del = db.prepare("DELETE FROM audit_log WHERE id = ?");
      for (const r of rows) {
        if (keep.has(r.session_id)) continue;
        out.audit += Number(del.run(r.id).changes) || 0;
      }
    }
    db.exec("COMMIT");
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch {}
    throw e;
  }
  if (out.sessions || out.audit) {
    // Gelöschte Zeilen stünden sonst noch im WAL, bis SQLite von sich aus
    // checkpointet. secure_delete (siehe enableSecureDelete) überschreibt die
    // freigegebenen Seiten in der Datenbank selbst.
    try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch {}
  }
  return out;
}

/**
 * Gelöschter Inhalt soll nicht in freien Seiten der Datei weiterleben. Gilt
 * für diese Verbindung, also auch für das Löschen eines Chats in der App.
 */
export function enableSecureDelete(db) {
  try { db.exec("PRAGMA secure_delete = ON"); return true; } catch { return false; }
}

/** Dateien direkt in `dir`, deren Änderungszeit älter ist als `maxAgeMs`, löschen. */
export function sweepOldFiles(dir, maxAgeMs, now = Date.now()) {
  if (!(maxAgeMs > 0) || !dir || !existsSync(dir)) return 0;
  const cutoff = now - maxAgeMs;
  let n = 0;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    try {
      const st = statSync(p);
      if (st.isFile() && st.mtimeMs < cutoff) { unlinkSync(p); n++; }
    } catch { /* file vanished between readdir and stat */ }
  }
  return n;
}

/** Ältere Stände eine Nummer weiterschieben: .1 → .2 …, der älteste fällt weg. */
function shiftGenerations(file, keep) {
  for (let i = keep - 1; i >= 1; i--) {
    try { renameSync(`${file}.${i}`, `${file}.${i + 1}`); } catch {}
  }
  try { unlinkSync(`${file}.${keep + 1}`); } catch {}
}

/**
 * Rotation für eine Datei, die nur dieser Prozess schreibt (bridge.log):
 * umbenennen genügt, der nächste appendFileSync legt sie neu an.
 * `files` zählt die aktuelle Datei mit, wie bisher MAX_LOG_FILES.
 */
export function rotateOwnLog(file, maxBytes, files) {
  try {
    if (statSync(file).size < maxBytes) return false;
  } catch { return false; }
  shiftGenerations(file, files - 1);
  try { renameSync(file, `${file}.1`); } catch {}
  return true;
}

/**
 * Rotation für Dateien, die ein ANDERER Prozess offen hält (launchd schreibt
 * stdout/stderr von Bridge und Tunnel hinein). Umbenennen hilft dort nicht: der
 * Schreiber behielte die umbenannte Datei. Deshalb kopieren und dann auf 0
 * kürzen; launchd öffnet die Dateien zum Anhängen, also schreibt es danach am
 * neuen Ende weiter. Was genau zwischen Kopie und Kürzen geschrieben wird, geht
 * verloren — ein paar Zeilen, und nur beim Rotieren.
 *
 * `keep` ist die Zahl der aufbewahrten alten Stände (.1 … .keep).
 * Gibt die rotierten Dateinamen zurück.
 */
export function rotateServiceLogs(dir, maxBytes, keep) {
  const done = [];
  if (!(maxBytes > 0) || !dir || !existsSync(dir)) return done;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".log")) continue;
    const file = join(dir, name);
    try {
      const st = statSync(file);
      if (!st.isFile() || st.size < maxBytes) continue;
      shiftGenerations(file, keep);
      copyFileSync(file, `${file}.1`);
      truncateSync(file, 0);
      done.push(name);
    } catch { /* locked or vanished: next round */ }
  }
  return done;
}
