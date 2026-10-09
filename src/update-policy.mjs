// Update-Steuerung: wann und bis zu welcher Version die Bridge sich selbst
// aktualisiert.
//
// Ohne Einstellung bleibt alles wie bisher: alle 6 Stunden nachsehen und eine
// neuere, gültig signierte Version sofort installieren. Eine Firma will das
// steuern können:
//   CONDUIT_SELFUPDATE=notify      nur melden (Log, /api/status), nie installieren
//   CONDUIT_UPDATE_PIN=3.0.4       nichts installieren, was neuer ist als 3.0.4
//   CONDUIT_UPDATE_WINDOW=02:00-05:00   nur in diesem Zeitfenster (Ortszeit)
//
// Die Signaturprüfung hängt an nichts davon. Auch im Meldemodus wird erst nach
// gültiger Signatur „verfügbar" gemeldet; eine unsignierte Version gibt es für
// diese Bridge nicht.
//
// Fehlkonfiguration installiert NICHTS: ein unlesbarer Pin oder ein kaputtes
// Fenster schaltet auf Melden, mit einem Fehler im Log. Lieber ein Update zu
// spät als eines, das die Firma ausdrücklich nicht wollte.

const VERSION_RE = /^\d+\.\d+\.\d+$/;
const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

function parseWindow(raw) {
  const m = String(raw).trim().split("-").map((s) => s.trim());
  if (m.length !== 2) return null;
  const toMin = (t) => {
    const x = TIME_RE.exec(t);
    return x ? Number(x[1]) * 60 + Number(x[2]) : null;
  };
  const start = toMin(m[0]);
  const end = toMin(m[1]);
  if (start === null || end === null || start === end) return null;
  return { start, end, label: `${m[0]}-${m[1]}` };
}

/**
 * Einstellungen aus der Umgebung.
 *
 * mode: "install" (Voreinstellung), "notify" oder "off".
 */
export function readUpdatePolicy(env = process.env) {
  const errors = [];
  const raw = String(env.CONDUIT_SELFUPDATE ?? "1").trim().toLowerCase();
  let mode;
  if (raw === "0" || raw === "off" || raw === "false") mode = "off";
  else if (raw === "notify") mode = "notify";
  else if (raw === "1" || raw === "" || raw === "on" || raw === "true" || raw === "install") mode = "install";
  else { mode = "notify"; errors.push(`CONDUIT_SELFUPDATE="${raw}" is not valid (use 1, 0 or notify); only reporting updates`); }

  let pin = null;
  const pinRaw = String(env.CONDUIT_UPDATE_PIN || "").trim();
  if (pinRaw) {
    if (VERSION_RE.test(pinRaw)) pin = pinRaw;
    else {
      errors.push(`CONDUIT_UPDATE_PIN="${pinRaw}" is not a version like 3.0.4; only reporting updates`);
      if (mode === "install") mode = "notify";
    }
  }

  let window = null;
  const winRaw = String(env.CONDUIT_UPDATE_WINDOW || "").trim();
  if (winRaw) {
    window = parseWindow(winRaw);
    if (!window) {
      errors.push(`CONDUIT_UPDATE_WINDOW="${winRaw}" is not a range like 02:00-05:00; only reporting updates`);
      if (mode === "install") mode = "notify";
    }
  }
  return { mode, pin, window, errors };
}

/** Liegt `date` (Ortszeit) im Fenster? Ein Fenster über Mitternacht (22:00-04:00) geht auch. */
export function inUpdateWindow(window, date = new Date()) {
  if (!window) return true;
  const m = date.getHours() * 60 + date.getMinutes();
  return window.start < window.end
    ? m >= window.start && m < window.end
    : m >= window.start || m < window.end;
}

/**
 * Kennung des Fensters, in dem `date` liegt: das Datum, an dem es begonnen hat.
 * Damit läuft die Prüfung höchstens einmal je Fenster, auch wenn der Takt
 * alle paar Minuten nachsieht.
 */
export function updateWindowKey(window, date = new Date()) {
  const d = new Date(date);
  if (window && window.start > window.end && d.getHours() * 60 + d.getMinutes() < window.end) {
    d.setDate(d.getDate() - 1);
  }
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}
