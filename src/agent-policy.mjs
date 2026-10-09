// Rechte der KI-Agenten: was Claude Code, Codex und Antigravity auf diesem
// Rechner ohne Rückfrage tun dürfen.
//
// WARUM es das gibt: Ohne Einstellung läuft jede CLI mit vollen Rechten und
// ohne Rückfrage (Claude `bypassPermissions`, Codex ohne Sandbox, Antigravity
// mit `--dangerously-skip-permissions`). Am Handy sitzt niemand am Terminal,
// der eine Rückfrage beantworten könnte, also ist das für den Einzelnutzer die
// einzige brauchbare Voreinstellung — und sie bleibt es. Eine Firma will das
// aber einschränken können, ohne den Code zu ändern. Das geht hier über
// Umgebungsvariablen, und zwar nur mit den Optionen, die die CLIs selbst
// anbieten (geprüft gegen claude 2.1.295, codex-cli 0.160.0 und die Hilfe von
// agy). Die Bridge erfindet keine eigene Sandbox.
//
// Grundsatz: Was eingeschränkt ist, wird ABGELEHNT, nicht erfragt. Eine
// Rückfrage, die niemand beantwortet, wäre ein Turn, der hängt. Alle drei CLIs
// lehnen im Druckmodus ab, was eine Freigabe bräuchte, und melden es im
// Ausgabestrom; die Bridge macht daraus einen Satz in der Antwort.
//
// Fehlkonfiguration schlägt GESCHLOSSEN fehl: ein unbekannter Wert führt nicht
// stillschweigend zurück auf volle Rechte, sondern sperrt die Engine mit einer
// Meldung, die sagt, welche Variable falsch ist.

import { existsSync } from "node:fs";

// Aus `claude --help` (2.1.295), Option --permission-mode.
export const CLAUDE_PERMISSION_MODES = ["acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"];
// Aus `codex exec --help` (0.160.0), Option --sandbox bzw. Konfiguration sandbox_mode.
export const CODEX_SANDBOX_MODES = ["read-only", "workspace-write", "danger-full-access"];
// Antigravity kennt keinen Rechte-Modus wie Claude. Entweder alles ohne
// Rückfrage (--dangerously-skip-permissions) oder die Regeln aus der eigenen
// settings.json der CLI; im Druckmodus lehnt sie alles ab, was dort nicht
// erlaubt ist (beobachtet: Ergebnis-Event mit `denied_actions`).
export const AGY_PERMISSION_MODES = ["bypass", "settings"];

// Kennungen und Schreibweisen wie in der Engine-Registry (engines.mjs).
const ENGINE_ALIASES = new Map([
  ["claude", "claude"],
  ["codex", "codex"], ["openai", "codex"],
  ["gemini", "gemini"], ["agy", "gemini"], ["antigravity", "gemini"],
  ["ollama", "ollama"], ["local", "ollama"],
]);

const list = (v) => String(v || "").split(",").map((s) => s.trim()).filter(Boolean);
const flag = (v) => ["1", "true", "yes", "on"].includes(String(v || "").trim().toLowerCase());

/**
 * Die Einstellungen aus der Umgebung lesen.
 *
 * `errors` ist je Engine-Kennung höchstens ein Satz. Eine Engine mit Eintrag
 * dort führt keinen Turn aus (siehe server.mjs), bis die Variable stimmt.
 */
export function readAgentPolicy(env = process.env) {
  const errors = {};

  const claudeMode = String(env.CONDUIT_CLAUDE_PERMISSION_MODE || "bypassPermissions").trim();
  if (!CLAUDE_PERMISSION_MODES.includes(claudeMode)) {
    errors.claude = `CONDUIT_CLAUDE_PERMISSION_MODE="${claudeMode}" is not valid (use one of: ${CLAUDE_PERMISSION_MODES.join(", ")})`;
  }
  const claudeSettings = String(env.CONDUIT_CLAUDE_SETTINGS || "").trim();
  if (claudeSettings && !errors.claude && !existsSync(claudeSettings)) {
    errors.claude = `CONDUIT_CLAUDE_SETTINGS points to a file that does not exist`;
  }

  const codexSandbox = String(env.CONDUIT_CODEX_SANDBOX || "").trim();
  if (codexSandbox && !CODEX_SANDBOX_MODES.includes(codexSandbox)) {
    errors.codex = `CONDUIT_CODEX_SANDBOX="${codexSandbox}" is not valid (use one of: ${CODEX_SANDBOX_MODES.join(", ")})`;
  }

  const agyPermissions = String(env.CONDUIT_AGY_PERMISSIONS || "bypass").trim();
  if (!AGY_PERMISSION_MODES.includes(agyPermissions)) {
    errors.gemini = `CONDUIT_AGY_PERMISSIONS="${agyPermissions}" is not valid (use one of: ${AGY_PERMISSION_MODES.join(", ")})`;
  }

  const disabled = new Set();
  for (const name of list(env.CONDUIT_DISABLED_ENGINES)) {
    const id = ENGINE_ALIASES.get(name.toLowerCase());
    if (id) disabled.add(id);
    // Ein Tippfehler darf nicht heißen „nichts abgeschaltet": dann lieber
    // alles mit Werkzeugen sperren, bis der Wert stimmt.
    else for (const e of ["claude", "codex", "gemini"]) errors[e] = errors[e] || `CONDUIT_DISABLED_ENGINES names an unknown engine "${name}" (use: claude, codex, gemini, ollama)`;
  }

  return {
    claude: {
      permissionMode: claudeMode,
      allowedTools: list(env.CONDUIT_CLAUDE_ALLOWED_TOOLS),
      disallowedTools: list(env.CONDUIT_CLAUDE_DISALLOWED_TOOLS),
      settings: claudeSettings,
    },
    codex: { sandbox: codexSandbox },
    gemini: { permissions: agyPermissions, sandbox: flag(env.CONDUIT_AGY_SANDBOX) },
    disabled,
    errors,
  };
}

/**
 * Argumente für `claude` (Ein-Turn-Pfad, Warm-Pool und Alexa).
 *
 * Steht immer VOR Optionen wie --resume und nie vor einem Positionsargument:
 * --allowedTools/--disallowedTools nehmen beliebig viele Werte und würden einen
 * folgenden Prompt als Werkzeugnamen schlucken.
 */
export function claudePermissionArgs(p) {
  const args = ["--permission-mode", p.permissionMode];
  // Außerhalb von bypassPermissions darf nichts auf eine Rückfrage warten: im
  // Druckmodus beantwortet sie niemand. "none" lehnt solche Aufrufe sofort ab;
  // der Modus entscheidet weiterhin alles andere.
  if (p.permissionMode !== "bypassPermissions") args.push("--permission-prompts", "none");
  // Ein Wert je Option, durch Kommas getrennt — so nimmt die CLI die Liste an,
  // auch mit Mustern wie "Bash(git *)", die Leerzeichen enthalten.
  if (p.allowedTools.length) args.push("--allowedTools", p.allowedTools.join(","));
  if (p.disallowedTools.length) args.push("--disallowedTools", p.disallowedTools.join(","));
  if (p.settings) args.push("--settings", p.settings);
  return args;
}

/**
 * Argumente für `codex exec` und `codex exec resume`.
 *
 * Über `-c` statt `--sandbox`, weil `exec resume` die Option --sandbox nicht
 * kennt, `-c` aber schon. approval_policy="never": Codex fragt nie nach, ein
 * Befehl, den die Sandbox nicht zulässt, scheitert und geht als Fehler an das
 * Modell zurück.
 */
export function codexPermissionArgs(p) {
  if (!p.sandbox) return ["--dangerously-bypass-approvals-and-sandbox"];
  return ["-c", `sandbox_mode="${p.sandbox}"`, "-c", `approval_policy="never"`];
}

/** Argumente für `agy`. */
export function agyPermissionArgs(p) {
  const args = p.permissions === "bypass" ? ["--dangerously-skip-permissions"] : [];
  if (p.sandbox) args.push("--sandbox");
  return args;
}

/** Kurzfassung für Log und /api/status: nur Modi, keine Pfade. */
export function policySummary(policy) {
  return {
    claude: policy.claude.permissionMode
      + (policy.claude.allowedTools.length ? " +allow" : "")
      + (policy.claude.disallowedTools.length ? " +deny" : "")
      + (policy.claude.settings ? " +settings" : ""),
    codex: policy.codex.sandbox || "bypass",
    gemini: policy.gemini.permissions + (policy.gemini.sandbox ? " +sandbox" : ""),
    disabled: [...policy.disabled],
    misconfigured: Object.keys(policy.errors),
  };
}

/**
 * Der Satz, der in der Antwort steht, wenn die CLI einen Werkzeugaufruf wegen
 * der Rechte-Einstellung abgelehnt hat. Ohne ihn sähe der Nutzer nur einen
 * fehlgeschlagenen Schritt — oder bei Antigravity gar nichts, denn die CLI
 * beendet den Turn dann ohne Text.
 */
export function deniedNotice(label, names) {
  const uniq = [...new Set((names || []).map((n) => String(n || "").trim()).filter(Boolean))];
  if (!uniq.length) return "";
  return `${label} was not allowed to use ${uniq.join(", ")} on this computer. `
    + "The bridge's permission settings block this action. The person who runs this bridge can change them.";
}
