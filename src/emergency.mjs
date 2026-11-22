// Not-Aus (Conduit 2.0, Phase 2): ein Schalter für die ganze Bridge.
//
// Gedrückt stoppt er jeden laufenden Lauf aller Chats, verwirft die
// Warteschlangen und sperrt neue Läufe, bis jemand ihn wieder löst. Das
// Stoppen selbst erledigt server.mjs; hier liegt nur der Zustand.
//
// Der Zustand steht in einer Datei, damit er einen Neustart übersteht: ein
// Not-Aus, den ein Selbst-Update oder ein launchd-Neustart still aufhebt,
// wäre keiner. Lässt sich die Datei nicht lesen oder ist sie kaputt, gilt der
// Not-Aus als gedrückt (schlägt geschlossen fehl). Lösen geht dann wie immer
// über die App und schreibt die Datei neu.

import { readFileSync, writeFileSync, renameSync, existsSync, truncateSync, openSync, closeSync } from "node:fs";
import { join } from "node:path";
import { PRIVATE_FILE_MODE } from "./private-fs.mjs";

export const EMERGENCY_FILE = ".emergency-stop.json";

/**
 * @param {object} o
 * @param {string} o.stateDir   Ordner für die Zustandsdatei (privat, 0700)
 * @param {(level: string, event: string, data: object) => void} [o.log]
 * @param {() => number} [o.now]
 */
export function createEmergencyStop({ stateDir, log = () => {}, now = Date.now }) {
  const file = join(stateDir, EMERGENCY_FILE);
  let state = load();
  // The file always exists from the first start on: a press on a full disk
  // can then fall back to emptying it (markPressedWithoutSpace), which needs
  // no space. Without a file it could only try to create one; if even the
  // first write fails, status says unsaved until a write succeeds.
  if (state.missing) {
    state = { active: false, since: null, by: null };
    try { save(state); }
    catch (e) {
      log("error", "emergency_state_write_failed", { err: String(e?.message || e).slice(0, 120) });
      state = { ...state, unsaved: true };
    }
  }

  function load() {
    let raw;
    try { raw = readFileSync(file, "utf8"); }
    catch (e) {
      // Only a file that is really not there means "never pressed". Any other
      // read error (no permission, I/O) counts as pressed.
      if (e?.code === "ENOENT") return { active: false, since: null, by: null, missing: true };
      log("error", "emergency_state_unreadable", { err: String(e?.code || e?.message || e).slice(0, 120) });
      return { active: true, since: null, by: "unreadable-state" };
    }
    try {
      const j = JSON.parse(raw);
      if (j && j.active === false) return { active: false, since: null, by: null };
      if (j && j.active === true) {
        return { active: true, since: Number.isFinite(j.since) ? j.since : null, by: typeof j.by === "string" ? j.by : null };
      }
      throw new Error("unexpected content");
    } catch (e) {
      log("error", "emergency_state_unreadable", { err: String(e?.message || e).slice(0, 120) });
      return { active: true, since: null, by: "unreadable-state" };
    }
  }

  /**
   * Last resort when the state cannot be written (full disk): an EMPTY state
   * file needs no data blocks — truncating an existing one frees space — and
   * load() reads it as unreadable, i.e. pressed. So a restart cannot lift a
   * stop that was pressed while the disk was full.
   */
  function markPressedWithoutSpace() {
    try {
      if (existsSync(file)) truncateSync(file, 0);
      else closeSync(openSync(file, "w", PRIVATE_FILE_MODE));
      return true;
    } catch (e) {
      log("error", "emergency_state_fallback_failed", { err: String(e?.message || e).slice(0, 120) });
      return false;
    }
  }

  function save(next) {
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(next), { mode: PRIVATE_FILE_MODE });
    renameSync(tmp, file);
  }

  return {
    /** Gedrückt? */
    get active() { return state.active; },
    /** Für /api/status und die App. */
    status() { return { active: state.active, since: state.since, by: state.by, unsaved: state.unsaved === true }; },
    /**
     * Drücken. Gilt sofort im Speicher, auch wenn das Schreiben scheitert;
     * dann sagt `persisted: false`, dass ein Neustart ihn aufheben würde.
     */
    engage(by) {
      const already = state.active;
      if (!already) state = { active: true, since: now(), by: by || null };
      let persisted = true;
      try { save({ active: true, since: state.since, by: state.by }); } catch (e) {
        log("error", "emergency_state_write_failed", { err: String(e?.message || e).slice(0, 120) });
        persisted = markPressedWithoutSpace();
      }
      // Kept in the state, so /api/status keeps saying it until a later
      // press or the release could save — not only the answer to this press.
      state = { ...state, unsaved: !persisted };
      return { ...state, already, persisted };
    },
    /**
     * Lösen. Scheitert das Schreiben, bleibt er gedrückt: sonst stünde nach
     * dem nächsten Neustart wieder „gedrückt" in der Datei, während die App
     * „gelöst" anzeigt.
     */
    release() {
      const next = { active: false, since: null, by: null };
      try { save(next); } catch (e) {
        log("error", "emergency_state_write_failed", { err: String(e?.message || e).slice(0, 120) });
        return { ...state, released: false };
      }
      const was = state.active;
      state = next;
      return { ...state, released: was };
    },
  };
}
