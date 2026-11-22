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

import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
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

  function load() {
    if (!existsSync(file)) return { active: false, since: null, by: null };
    try {
      const j = JSON.parse(readFileSync(file, "utf8"));
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

  function save(next) {
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(next), { mode: PRIVATE_FILE_MODE });
    renameSync(tmp, file);
  }

  return {
    /** Gedrückt? */
    get active() { return state.active; },
    /** Für /api/status und die App. */
    status() { return { ...state }; },
    /**
     * Drücken. Gilt sofort im Speicher, auch wenn das Schreiben scheitert;
     * dann sagt `persisted: false`, dass ein Neustart ihn aufheben würde.
     */
    engage(by) {
      const already = state.active;
      if (!already) state = { active: true, since: now(), by: by || null };
      let persisted = true;
      try { save(state); } catch (e) {
        persisted = false;
        log("error", "emergency_state_write_failed", { err: String(e?.message || e).slice(0, 120) });
      }
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
