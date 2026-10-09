// Engine-Registry.
//
// WARUM diese Datei existiert: Die Bridge kann mehr als eine CLI fahren, und
// bis hierher steckte jede davon als eigener Zweig im Turn-Pfad — eine
// if-Kette in spawnInflight, ein zweiter, fast identischer Spawn-Block, ein
// zweiter Zweig im Stream-Parser, ein weiterer accessSync im /api/engines-
// Handler. Jede neue Engine hätte an vier Stellen in einer 3000-Zeilen-Datei
// eingegriffen, und genau dort liegt der Turn-Pfad, der produktiv läuft.
//
// Hier steht deshalb alles, was eine Engine von der anderen unterscheidet:
// Binary, Modelle, Argumente, Fortsetzungs-Id, Ausgabeformat und die Texte,
// die der Nutzer im Fehlerfall liest. server.mjs kennt nur noch die Form
// dieser Einträge, nicht mehr die einzelne Engine.
//
// Was NICHT hierher gehört: der Prozess-Lebenszyklus (Stall-Watchdog,
// Heartbeat, Queue, Abbruch). Der ist für jede Engine gleich und bleibt in
// server.mjs, damit ein Registry-Eintrag reine Beschreibung bleibt.

import { homedir } from "node:os";
import { accessSync, readFileSync, statSync, constants as FS } from "node:fs";
import { listMessages, setClaudeSessionId, setAgyConversationId, setCodexThreadId } from "./db.mjs";
import {
  readAgentPolicy, claudePermissionArgs, codexPermissionArgs, agyPermissionArgs, deniedNotice,
} from "./agent-policy.mjs";

// Rechte-Einstellung der Firma (agent-policy.mjs). Einmal beim Start gelesen,
// wie alle anderen Umgebungsvariablen dieser Datei auch.
export const AGENT_POLICY = readAgentPolicy();

/**
 * Verfügbarkeit heißt hier bewusst nur „das Binary ist ausführbar" — nicht
 * „angemeldet und antwortbereit". Für Claude beantwortet das die separate
 * Auth-Probe in server.mjs; ein X_OK-Test ist billig genug, um ihn bei jedem
 * /healthz und jedem /api/engines zu wiederholen.
 */
function binExecutable(bin) {
  try { accessSync(bin, FS.X_OK); return true; } catch { return false; }
}

// --- Claude -----------------------------------------------------------------
const CLAUDE = {
  id: "claude",
  // Der Name, den der Client in der Engine-Auswahl zeigt.
  name: "Claude Opus 5",
  badge: "⚡ Flagship",
  // Kurzform für Log-Meta und interne Zwecke.
  label: "Claude",
  // Wie der Turn gefahren wird: "spawn" startet das Binary und liest dessen
  // Ausgabe, "http" spricht mit einem laufenden Dienst. Alles danach — Timer,
  // Abbruch, DB, WS-Frames — ist für beide dasselbe.
  transport: "spawn",
  // Was die Engine im Turn tatsächlich tun kann. Claude Code führt Werkzeuge
  // aus (Dateien, Befehle, MCP), und der Client zeigt das an.
  capabilities: { tools: true },
  bin: process.env.CLAUDE_BIN || `${homedir()}/.local/bin/claude`,
  defaultModel: process.env.CLAUDE_MODEL || "claude-opus-5",
  models: [
    { id: "claude-opus-5", name: "Opus 5 (1M Context)", default: true },
    { id: "claude-sonnet-5", name: "Sonnet (Fast)" },
  ],
  // Nur Claude läuft über den Warm-Pool: der hält einen langlebigen
  // `claude --print --input-format stream-json` pro Session, spart den
  // CLI-Boot und den 32k-Cache-Neuaufbau und streamt Token für Token. Eine
  // Engine ohne diese Betriebsart nimmt den Ein-Turn-Prozess-Pfad.
  usesWarmPool: true,

  // Wie die Unterhaltung über Turns hinweg fortgesetzt wird.
  conversation: {
    // Feld im Runtime-Objekt der Session.
    rtField: "claudeSessionId",
    read: (rt) => rt.claudeSessionId || null,
    persist: setClaudeSessionId,
    // Eine neue CLI-Session zählt Usage und Kosten wieder ab 0. Ohne das
    // Zurücksetzen des kumulativen Snapshots würde der nächste Delta-Wert
    // negativ und damit als voller Betrag erneut gebucht.
    resetUsageOnChange: true,
  },

  /**
   * Die CLI kennt nur die Kurznamen. Alles, was nicht als sonnet oder haiku
   * erkennbar ist, landet absichtlich auf opus — das ist das teurere, aber
   * verlässliche Ende, und ein Tippfehler im Modellnamen soll keinen Turn
   * scheitern lassen.
   */
  resolveModel(requested) {
    const req = String(requested || this.defaultModel).toLowerCase();
    if (req.includes("sonnet")) return "sonnet";
    if (req.includes("haiku")) return "haiku";
    return "opus";
  },

  preparePrompt({ prompt }) { return prompt; },

  // Dieselben Rechte für Ein-Turn-Pfad, Warm-Pool und Alexa. Voreinstellung
  // bleibt bypassPermissions; siehe agent-policy.mjs.
  permissionArgs() { return claudePermissionArgs(AGENT_POLICY.claude); },

  buildArgs({ prompt, model, resumeId, sessionId }) {
    const args = [
      "-p", prompt,
      "--model", model,
      "--output-format", "stream-json",
      "--verbose",
      ...this.permissionArgs(),
    ];
    // --resume setzt auf der bestehenden CLI-Session auf; ohne eine solche
    // darf die Session-Id nur vorgegeben werden, wenn unsere sid überhaupt
    // ein UUID ist (die CLI akzeptiert nichts anderes).
    if (resumeId) args.push("--resume", resumeId);
    else if (sessionId) args.push("--session-id", sessionId);
    return args;
  },

  /**
   * Ein NDJSON-Event der CLI auf die Bridge-Begriffe abbilden. Der Sink ist
   * die einzige Verbindung zurück in den Turn — so muss die Registry nichts
   * über Broadcasts, DB-Schreibpfade oder das inflight-Objekt wissen.
   */
  readEvent(ev, sink) {
    if (ev.type === "system" && ev.subtype === "init" && ev.session_id) {
      sink.onConversationId(ev.session_id);
    } else if (ev.type === "assistant" && ev.message?.content) {
      for (const block of ev.message.content) {
        if (block.type === "text" && typeof block.text === "string") sink.onChunk(block.text);
        else if (block.type === "tool_use") sink.onToolStart(block);
      }
    } else if (ev.type === "user" && ev.message?.content) {
      for (const block of ev.message.content) {
        if (block.type === "tool_result") sink.onToolEnd(block);
      }
    } else if (ev.type === "result") {
      // Was die Rechte-Einstellung abgelehnt hat, steht gesammelt im
      // Ergebnis-Event (claude 2.1.295: permission_denials[].tool_name).
      if (Array.isArray(ev.permission_denials) && ev.permission_denials.length) {
        sink.onPermissionDenied(ev.permission_denials.map((d) => d?.tool_name));
      }
      if (ev.is_error) {
        sink.onError(ev.result ? String(ev.result).slice(0, 600) : "Claude reported an error");
      }
      sink.onUsage(ev);
    }
  },

  // Log-Namen bleiben pro Engine eigen, weil die Logdatei danach durchsucht
  // wird und ein umbenanntes Ereignis jede bestehende Suche ins Leere laufen
  // ließe.
  logs: {
    spawn: "spawn_claude",
    done: "claude_done",
    closeAfterWrapup: "claude_close_after_wrapup",
    emptyTurn: "empty_turn_final",
  },
  spawnMeta: ({ resumeId }) => ({ hasResume: !!resumeId }),
  killMeta: {},

  // Was der Nutzer im Fehlerfall liest. Bewusst pro Engine ausformuliert: „Claude
  // antwortet nicht" ist eine andere Auskunft als „Antigravity antwortet nicht",
  // und der Nutzer soll wissen, welche der beiden gerade klemmt.
  messages: {
    spawnFailed: (m) => `Claude could not be started: ${m}`,
    stall: "Claude has not responded for 10 minutes. Stopped.",
    stallIncomplete: "Claude stopped responding. The answer is incomplete.",
    exit: (code, tail) => `claude exit ${code}: ${tail}`,
    procError: (m) => `claude error: ${m}`,
    emptyTurn: "Empty answer: Claude finished without any text. Please send again.",
  },
};

// --- Antigravity / Gemini ---------------------------------------------------
// Die Id bleibt "gemini": unter diesem Wert steht die Engine in der
// sessions-Tabelle und schickt der Client sie im prompt-Frame. "agy" und
// "antigravity" sind die Schreibweisen, die frühere Clients verwendet haben,
// und bleiben als Alias gültig.
const ANTIGRAVITY = {
  id: "gemini",
  aliases: ["agy", "antigravity"],
  name: "Gemini 3.1 Pro (Antigravity)",
  badge: "🔷 Full-Repo 1M",
  label: "Antigravity",
  transport: "spawn",
  capabilities: { tools: true },
  bin: process.env.AGY_BIN || `${homedir()}/.local/bin/agy`,
  defaultModel: process.env.AGY_MODEL || "gemini-3.1-pro-high",
  models: [
    { id: "gemini-3.1-pro-high", name: "Gemini 3.1 Pro (High)", default: true },
    { id: "gemini-3.7-flash-high", name: "Gemini 3.7 Flash (High)" },
  ],
  usesWarmPool: false,

  conversation: {
    rtField: "agyConversationId",
    // Anders als bei Claude auch aus der Session-Zeile: die Conversation-Id
    // überlebt einen Bridge-Neustart nur dort.
    read: (rt, sess) => rt.agyConversationId || sess?.agy_conversation_id || null,
    persist: setAgyConversationId,
    resetUsageOnChange: false,
  },

  // Die CLI nimmt den Modellnamen unverändert entgegen; "default" heißt
  // „nimm, was die CLI selbst eingestellt hat" und wird deshalb gar nicht
  // erst als Argument gesetzt.
  resolveModel(requested) { return requested || this.defaultModel; },

  /**
   * Ohne Conversation-Id fängt die CLI bei null an und weiß nichts vom
   * bisherigen Verlauf. Der wird ihr deshalb einmalig in den Prompt gelegt.
   */
  preparePrompt({ prompt, sid, email, userMessageId, resumeId }) {
    if (resumeId) return prompt;
    try {
      // listMessages ist E-Mail-gebunden. Ohne die Adresse lieferte es null,
      // das .filter warf, und der catch schluckte es — der Verlauf wurde
      // also NIE angehaengt, seit es diese Engine gibt.
      const history = email ? listMessages(sid, email) : null;
      const prior = (history || []).filter((m) => m.id !== userMessageId && m.content && m.content.trim());
      if (prior.length > 0) {
        const transcript = prior
          .slice(-16)
          .map((m) => `${m.role === "user" ? "Nutzer" : "Assistent"}: ${m.content.trim()}`)
          .join("\n\n");
        return `[Bisheriger Verlauf dieser Unterhaltung]:\n${transcript}\n\n[Neue Nutzer-Anfrage]:\n${prompt}`;
      }
    } catch {}
    return prompt;
  },

  buildArgs({ prompt, model, resumeId }) {
    const args = [
      "-p", prompt,
      "--output-format", "stream-json",
      // Voreinstellung --dangerously-skip-permissions; siehe agent-policy.mjs.
      ...agyPermissionArgs(AGENT_POLICY.gemini),
    ];
    if (model && model !== "default") args.push("--model", model);
    if (resumeId) args.push("--conversation", resumeId);
    return args;
  },

  /**
   * Eigenes Stream-Format: die CLI schickt `event`/`step_update` statt der
   * `type`-Events der Claude-CLI. Die beiden Formate sind an ihrem
   * Unterscheidungsfeld sauber auseinanderzuhalten.
   */
  readEvent(ev, sink) {
    if (ev.event === "init" && ev.conversation_id) {
      sink.onConversationId(ev.conversation_id);
    } else if (ev.event === "step_update" && ev.step_update) {
      const su = ev.step_update;
      if (su.step_type === "agent_response" && typeof su.text_delta === "string") {
        sink.onChunk(su.text_delta);
      } else if (su.step_type === "tool" || su.step_type === "tool_call") {
        if (su.state === "ACTIVE" || su.state === "RUNNING") {
          sink.onToolStart({
            id: String(su.step_index ?? Date.now()),
            name: su.tool_name || su.tool_info?.name || "tool",
            input: su.tool_info?.parameters || su.tool_input || {},
          });
        } else if (su.state === "DONE" || su.state === "ERROR" || su.step_type === "tool_result") {
          sink.onToolEnd({
            tool_use_id: String(su.step_index ?? ""),
            is_error: su.state === "ERROR",
            // Ein abgelehnter Aufruf hat keine Ausgabe, nur tool_info.error —
            // ohne den Fallback stünde der Schritt ohne Grund als gescheitert da.
            content: su.tool_info?.output || su.tool_output || su.tool_info?.error?.message || "",
          });
        }
      }
    } else if (ev.event === "result" && ev.result) {
      // Ohne --dangerously-skip-permissions lehnt die CLI im Druckmodus ab, was
      // ihre settings.json nicht erlaubt, und beendet den Turn oft ganz ohne
      // Text. Ohne diesen Satz käme beim Nutzer „leere Antwort" an.
      if (Array.isArray(ev.result.denied_actions) && ev.result.denied_actions.length) {
        sink.onPermissionDenied(ev.result.denied_actions.map((d) => d?.display_name || d?.action));
      }
      if (ev.result.status === "ERROR") {
        sink.onError(ev.result.response || "Antigravity reported an error");
      } else if (ev.result.status === "SUCCESS" && !sink.hasContent() && ev.result.response) {
        // Kam nichts als Delta durch, ist die Gesamtantwort im Ergebnis-Event
        // die einzige Quelle für den Text.
        sink.onChunk(ev.result.response);
      }
      if (ev.result.usage) {
        sink.onUsage({
          usage: {
            input_tokens: ev.result.usage.input_tokens || 0,
            output_tokens: ev.result.usage.output_tokens || 0,
            cache_read_input_tokens: ev.result.usage.cache_read_tokens || 0,
          },
          duration_ms: ev.result.duration_seconds ? Math.round(ev.result.duration_seconds * 1000) : 0,
        });
      }
    }
  },

  logs: {
    spawn: "spawn_agy",
    done: "agy_done",
    closeAfterWrapup: "agy_close_after_wrapup",
    emptyTurn: "empty_turn_final_agy",
  },
  spawnMeta: ({ resumeId, model }) => ({ hasConversation: !!resumeId, model }),
  killMeta: { engine: "gemini" },

  messages: {
    spawnFailed: (m) => `The Antigravity CLI could not be started: ${m}`,
    stall: "Antigravity has not responded for 10 minutes. Stopped.",
    stallIncomplete: "Antigravity stopped responding. The answer is incomplete.",
    exit: (code, tail) => `agy exit ${code}: ${tail}`,
    procError: (m) => `agy error: ${m}`,
    emptyTurn: "Empty answer: Antigravity finished without any text. Please send again.",
  },
};

// --- Codex (OpenAI) ---------------------------------------------------------
// `codex exec --json` fährt einen Turn und schreibt JSONL auf stdout. Die
// Fortsetzung läuft über `codex exec resume <thread_id>`; die Thread-Id kommt
// im ersten Event (`thread.started`) und wird wie bei den anderen CLIs in der
// Session-Zeile gemerkt, damit sie einen Bridge-Neustart überlebt.
//
// Das Binary liegt je nach Installation woanders (Homebrew auf Apple Silicon
// bzw. Intel, npm global, ~/.local/bin). Die Bridge läuft unter launchd mit
// schmalem PATH, deshalb wird die Liste hier abgesucht statt `which` zu fragen.
const CODEX_HOME = process.env.CODEX_HOME || `${homedir()}/.codex`;
const CODEX_BIN_CANDIDATES = [
  process.env.CODEX_BIN,
  "/opt/homebrew/bin/codex",
  "/usr/local/bin/codex",
  `${homedir()}/.local/bin/codex`,
  `${homedir()}/.npm-global/bin/codex`,
].filter(Boolean);

function findCodexBin() {
  for (const b of CODEX_BIN_CANDIDATES) if (binExecutable(b)) return b;
  // Nichts gefunden: der erste Kandidat bleibt stehen, damit die
  // Fehlermeldung beim Start einen konkreten Pfad nennt.
  return CODEX_BIN_CANDIDATES[0];
}

// Welche Modelle ein Codex-Konto hat, steht in der Modell-Liste, die die CLI
// selbst unter ~/.codex/models_cache.json pflegt — je Rechner und je Tarif
// verschieden. Feste Namen im Code wären beim nächsten Modellwechsel von
// OpenAI falsch. Die Vorgabe ist das Modell aus der config.toml des Nutzers.
const CODEX_CACHE_TTL_MS = 60_000;
const codexModelCache = { models: [], checkedAt: 0, mtime: 0 };

function codexConfiguredModel() {
  if (process.env.CODEX_MODEL) return process.env.CODEX_MODEL;
  try {
    const toml = readFileSync(`${CODEX_HOME}/config.toml`, "utf8");
    // Nur der Kopfbereich vor der ersten [Sektion] — `model = ` in einem
    // Profil gilt nicht für den normalen Aufruf.
    const head = toml.split(/^\s*\[/m)[0];
    const m = head.match(/^\s*model\s*=\s*"([^"]+)"/m);
    return m ? m[1] : null;
  } catch { return null; }
}

function codexModels() {
  const now = Date.now();
  if (now - codexModelCache.checkedAt < CODEX_CACHE_TTL_MS) return codexModelCache.models;
  codexModelCache.checkedAt = now;
  const configured = codexConfiguredModel();
  let list = [];
  try {
    const file = `${CODEX_HOME}/models_cache.json`;
    const mtime = statSync(file).mtimeMs;
    if (mtime === codexModelCache.mtime && codexModelCache.models.length) return codexModelCache.models;
    const raw = JSON.parse(readFileSync(file, "utf8"));
    list = (Array.isArray(raw?.models) ? raw.models : [])
      // `hide` sind interne Modelle (Auto-Review, Reserve) — die bietet auch
      // die Codex-Oberfläche selbst nicht an.
      .filter((m) => m && typeof m.slug === "string" && m.visibility !== "hide")
      .sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999))
      .map((m) => ({ id: m.slug, name: m.display_name || m.slug, ...(m.description ? { description: m.description } : {}) }));
    codexModelCache.mtime = mtime;
  } catch { /* keine Liste → nur die Vorgabe anbieten */ }
  if (configured && !list.some((m) => m.id === configured)) list.unshift({ id: configured, name: configured });
  // Ohne jede Auskunft bleibt „Voreinstellung": die CLI nimmt dann, was sie
  // selbst eingestellt hat, und die Auswahl ist nie leer.
  if (list.length === 0) list.push({ id: "default", name: "Codex default" });
  const def = configured || list[0].id;
  codexModelCache.models = list.map((m) => (m.id === def ? { ...m, default: true } : m));
  return codexModelCache.models;
}

// Die Item-Ids der CLI („item_2") zählen je Turn von vorn. Das Audit-Log
// schlüsselt Werkzeug-Schritte über die ganze Session nach dieser Id — ohne
// Präfix würde Schritt 2 aus Turn 5 den aus Turn 1 überschreiben. Der Sink
// lebt genau einen Turn, also hängt das Präfix an ihm.
const codexTurns = new WeakMap();
function codexTurn(sink) {
  let t = codexTurns.get(sink);
  if (!t) {
    t = { prefix: `cx${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, started: new Set() };
    codexTurns.set(sink, t);
  }
  return t;
}

/** Ein Codex-Item als Werkzeug-Schritt, so wie der Client ihn kennt. */
function codexToolBlock(item) {
  switch (item.type) {
    case "command_execution":
      return { name: "Bash", input: { command: item.command || "" } };
    case "file_change": {
      const paths = (item.changes || []).map((c) => c?.path).filter(Boolean);
      return { name: "Edit", input: { file_path: paths.join(", ") } };
    }
    case "mcp_tool_call":
      return { name: [item.server, item.tool].filter(Boolean).join(".") || "mcp", input: item.arguments || {} };
    case "web_search":
      return { name: "WebSearch", input: { query: item.query || "" } };
    default:
      return null;
  }
}

function codexToolOutput(item) {
  if (item.type === "command_execution") return item.aggregated_output || "";
  if (item.type === "file_change") return (item.changes || []).map((c) => `${c?.kind || "update"} ${c?.path || ""}`).join("\n");
  if (item.type === "mcp_tool_call") {
    if (item.error) return String(item.error?.message || item.error);
    const content = item.result?.content;
    return Array.isArray(content) ? content : "";
  }
  return "";
}

function codexToolFailed(item) {
  if (item.status === "failed" || item.status === "declined") return true;
  if (item.type === "command_execution" && typeof item.exit_code === "number") return item.exit_code !== 0;
  if (item.type === "mcp_tool_call" && item.error) return true;
  return false;
}

const CODEX = {
  id: "codex",
  aliases: ["openai"],
  name: "OpenAI Codex",
  badge: "🟢 Codex CLI",
  label: "Codex",
  transport: "spawn",
  // Codex führt Befehle aus und ändert Dateien — dieselbe Klasse Arbeit wie
  // Claude Code.
  capabilities: { tools: true },
  get bin() { return findCodexBin(); },
  get defaultModel() { return codexModels().find((m) => m.default)?.id || "default"; },
  get models() { return codexModels(); },
  usesWarmPool: false,
  // Jeder `codex exec` ist ein eigener Prozess und meldet im turn.completed
  // nur die Zahlen dieses einen Turns — kein Gesamtstand.
  usageCumulative: false,

  conversation: {
    rtField: "codexThreadId",
    read: (rt, sess) => rt.codexThreadId || sess?.codex_thread_id || null,
    persist: setCodexThreadId,
    resetUsageOnChange: false,
  },

  resolveModel(requested) {
    const req = String(requested || "").trim();
    // Ein Modellname einer anderen Engine (die Session stand vorher auf
    // Claude) darf hier nicht als Codex-Modell durchrutschen.
    if (req && codexModels().some((m) => m.id === req)) return req;
    return this.defaultModel;
  },

  // Ohne Thread-Id kennt Codex die bisherige Unterhaltung nicht — das
  // passiert, wenn eine Session mitten im Verlauf auf Codex umgestellt wird.
  // Dann geht der Verlauf einmalig als Text mit, wie bei Antigravity.
  preparePrompt(ctx) { return ANTIGRAVITY.preparePrompt(ctx); },

  buildArgs({ prompt, model, resumeId }) {
    const args = ["exec"];
    if (resumeId) args.push("resume");
    args.push(
      "--json",
      // Die Arbeitsverzeichnisse der Sessions sind nicht zwingend Git-Repos.
      "--skip-git-repo-check",
      // Wie bei Claude (bypassPermissions) und Antigravity: am Handy gibt es
      // niemanden, der eine Rückfrage im Terminal beantworten könnte. Deshalb
      // ohne Einstellung ohne Sandbox; mit CONDUIT_CODEX_SANDBOX läuft Codex in
      // der Sandbox und fragt nie (agent-policy.mjs).
      ...codexPermissionArgs(AGENT_POLICY.codex),
    );
    if (model && model !== "default") args.push("--model", model);
    // `--` trennt die Positionsargumente ab: ein Prompt, der mit „-" beginnt,
    // würde sonst als Option gelesen.
    args.push("--");
    if (resumeId) args.push(resumeId);
    args.push(prompt);
    return args;
  },

  /**
   * Format von `codex exec --json`: thread.started → turn.started →
   * item.started/item.completed je Schritt → turn.completed | turn.failed.
   */
  readEvent(ev, sink) {
    if (ev.type === "thread.started" && ev.thread_id) {
      sink.onConversationId(ev.thread_id);
    } else if ((ev.type === "item.started" || ev.type === "item.completed") && ev.item) {
      const item = ev.item;
      if (item.type === "agent_message") {
        if (ev.type === "item.completed" && typeof item.text === "string" && item.text) {
          // Mehrere Zwischenmeldungen eines Turns („Ich schaue nach …",
          // dann die Antwort) sind eigene Absätze, nicht ein Satz.
          sink.onChunk(sink.hasContent() ? `\n\n${item.text}` : item.text);
        }
        return;
      }
      const block = codexToolBlock(item);
      if (!block) return;
      const turn = codexTurn(sink);
      const id = `${turn.prefix}-${item.id || turn.started.size}`;
      // Dateiänderungen und Websuchen kommen oft nur als item.completed —
      // dann wird der Schritt in einem Zug begonnen und beendet.
      if (!turn.started.has(id)) {
        turn.started.add(id);
        sink.onToolStart({ id, ...block });
      }
      if (ev.type === "item.completed") {
        sink.onToolEnd({ tool_use_id: id, is_error: codexToolFailed(item), content: codexToolOutput(item) });
      }
    } else if (ev.type === "turn.failed") {
      sink.onError(String(ev.error?.message || "Codex reported an error").slice(0, 600));
    } else if (ev.type === "turn.completed" && ev.usage) {
      sink.onUsage({
        usage: {
          input_tokens: Number(ev.usage.input_tokens) || 0,
          output_tokens: (Number(ev.usage.output_tokens) || 0) + (Number(ev.usage.reasoning_output_tokens) || 0),
          cache_read_input_tokens: Number(ev.usage.cached_input_tokens) || 0,
          cache_creation_input_tokens: Number(ev.usage.cache_write_input_tokens) || 0,
        },
      });
    }
  },

  logs: {
    spawn: "spawn_codex",
    done: "codex_done",
    closeAfterWrapup: "codex_close_after_wrapup",
    emptyTurn: "empty_turn_final_codex",
  },
  spawnMeta: ({ resumeId, model }) => ({ hasThread: !!resumeId, model }),
  killMeta: { engine: "codex" },

  messages: {
    spawnFailed: (m) => `The Codex CLI could not be started: ${m}`,
    stall: "Codex has not responded for 10 minutes. Stopped.",
    stallIncomplete: "Codex stopped responding. The answer is incomplete.",
    exit: (code, tail) => `codex exit ${code}: ${tail}`,
    procError: (m) => `codex error: ${m}`,
    emptyTurn: "Empty answer: Codex finished without any text. Please send again.",
  },
};

// --- Ollama / lokale Modelle ------------------------------------------------
// Die erste Engine, die kein Binary startet: Ollama läuft als eigener Dienst
// und wird über HTTP angesprochen. Deshalb trägt jeder Eintrag jetzt ein
// `transport`-Feld — server.mjs entscheidet daran einmal, womit der Turn
// gefahren wird, und der gesamte Lebenszyklus danach bleibt derselbe.
//
// EHRLICH: Diese Engine kann keine Werkzeuge ausführen. /api/chat liefert
// reinen Text; die Bridge hat für Ollama keinen Tool-Executor, führt also
// weder Dateizugriffe noch Befehle aus. Dass die Modelle selbst ein
// Tool-Protokoll beherrschen (Ollama meldet "tools" in /api/show), ändert
// daran nichts — hier ist niemand, der einen Tool-Aufruf ausführen würde.
// Darum capabilities.tools = false, und der Name sagt es auch.
const OLLAMA_HOST = (process.env.OLLAMA_HOST || "http://127.0.0.1:11434").replace(/\/+$/, "");
// Die Probe läuft gegen localhost. Ist der Dienst nicht da, antwortet der
// Kernel sofort mit ECONNREFUSED; das Zeitlimit greift nur, wenn jemand
// OLLAMA_HOST auf eine ferne Adresse zeigen lässt.
const OLLAMA_PROBE_TIMEOUT_MS = 1500;
const OLLAMA_SHOW_TIMEOUT_MS = 3000;
// Wie lange eine Auskunft über Dienst und Modelle gilt. Kurz genug, dass ein
// frisch gezogenes Modell nach einer Minute in der Auswahl steht, lang genug,
// dass /api/engines und /healthz den Dienst nicht bei jedem Aufruf befragen.
const OLLAMA_CACHE_TTL_MS = 60_000;

// Der Zwischenspeicher ist der Grund, warum isAvailable() und models synchron
// bleiben können: engineCatalog() liefert immer das zuletzt Gewusste und stößt
// nur die Auffrischung an. Ein langsamer oder toter Dienst verzögert damit
// keinen einzigen HTTP-Handler der Bridge.
const ollamaCache = { available: false, models: [], checkedAt: 0, refreshing: false };

async function ollamaJson(pathname, { method = "GET", body = null, timeoutMs = OLLAMA_PROBE_TIMEOUT_MS } = {}) {
  const res = await fetch(`${OLLAMA_HOST}${pathname}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Aus "qwen2.5-coder:14b-instruct" wird "qwen2.5-coder · 14b-instruct". */
function prettyOllamaName(id) {
  const [name, tag] = String(id).split(":");
  if (!tag || tag === "latest") return name;
  return `${name} · ${tag}`;
}

/**
 * Dienst und Modell-Liste im Hintergrund nachziehen.
 *
 * Läuft absichtlich ohne await beim Aufrufer: wer die Liste liest, bekommt den
 * alten Stand und löst nur die nächste Aktualisierung aus. Ein zweiter Aufruf
 * währenddessen tut nichts (refreshing), sonst schickte jeder /healthz-Tick
 * eine weitere Runde Anfragen los.
 */
function refreshOllamaCache() {
  if (ollamaCache.refreshing) return;
  if (Date.now() - ollamaCache.checkedAt < OLLAMA_CACHE_TTL_MS) return;
  ollamaCache.refreshing = true;
  (async () => {
    try {
      // Verfügbarkeit heißt hier „der Dienst antwortet", nicht „ein Modell ist
      // geladen". /api/version ist dafür der billigste Beweis.
      await ollamaJson("/api/version");
      const tags = await ollamaJson("/api/tags");
      const names = (tags?.models || []).map((m) => m?.name).filter(Boolean).sort();
      const usable = [];
      for (const id of names) {
        // Ein Embedding-Modell (nomic-embed-text) steht in /api/tags gleich
        // neben den Chat-Modellen, kann aber kein /api/chat. Es in die Auswahl
        // zu stellen hieße, eine Fähigkeit zu behaupten, die es nicht gibt —
        // /api/show sagt, was das Modell wirklich kann.
        try {
          const info = await ollamaJson("/api/show", { method: "POST", body: { model: id }, timeoutMs: OLLAMA_SHOW_TIMEOUT_MS });
          if (Array.isArray(info?.capabilities) && !info.capabilities.includes("completion")) continue;
        } catch { /* keine Auskunft → Modell im Zweifel anbieten */ }
        usable.push(id);
      }
      const preferred = process.env.OLLAMA_MODEL || usable[0] || null;
      ollamaCache.models = usable.map((id) => ({ id, name: prettyOllamaName(id), ...(id === preferred ? { default: true } : {}) }));
      ollamaCache.available = true;
    } catch {
      // Dienst weg → Engine gilt als nicht verfügbar und die Modell-Liste ist
      // leer. Sie stehen zu lassen hieße, dem Nutzer eine Auswahl anzubieten,
      // die beim ersten Prompt scheitert.
      ollamaCache.available = false;
      ollamaCache.models = [];
    } finally {
      ollamaCache.checkedAt = Date.now();
      ollamaCache.refreshing = false;
    }
  })();
}

// Einmal beim Start anstoßen. Ohne das bekäme der erste Aufruf von
// /api/engines nach einem Bridge-Neustart „nicht verfügbar, keine Modelle" zu
// sehen — die Auskunft wäre erst ab dem zweiten Aufruf richtig, und ein Prompt
// direkt nach dem Start fände kein Modell.
refreshOllamaCache();

const OLLAMA = {
  id: "ollama",
  aliases: ["local"],
  name: "Local model",
  badge: "🖥️ Runs locally · no tools",
  label: "Ollama",
  transport: "http",
  endpoint: OLLAMA_HOST,
  // Was diese Engine im Unterschied zu den CLIs NICHT kann. Der Client zeigt
  // es an, damit niemand hier eine Datei-Aufgabe stellt und auf eine Antwort
  // wartet, die ein Werkzeug gebraucht hätte.
  capabilities: { tools: false },
  usesWarmPool: false,
  // Ollama zählt je Anfrage, nicht kumulativ über die Unterhaltung: die Zahlen
  // sind schon der Delta-Wert und dürfen nicht gegen einen Vorstand gerechnet
  // werden (das ergäbe ab Turn 2 zu kleine oder negative Werte).
  usageCumulative: false,

  get defaultModel() { return process.env.OLLAMA_MODEL || ollamaCache.models[0]?.id || ""; },
  // Kein festes Modell im Code: was installiert ist, weiß nur der Dienst.
  get models() { refreshOllamaCache(); return ollamaCache.models; },
  isAvailable() { refreshOllamaCache(); return ollamaCache.available; },

  // /api/chat ist zustandslos — es gibt keine Conversation-Id, die man
  // fortsetzen könnte. Der Verlauf geht stattdessen bei jeder Anfrage als
  // messages-Feld mit (siehe buildRequest). read() liefert deshalb immer null,
  // und damit nimmt der Turn-Pfad nie einen Fortsetzungs-Zweig.
  conversation: {
    rtField: "ollamaConversationId",
    read: () => null,
    persist: () => {},
    resetUsageOnChange: false,
  },

  /**
   * Modellnamen gehen unverändert an den Dienst — sie sind seine eigenen Tags.
   * Ein Name, den der Dienst nicht (mehr) hat, wird auf die Vorgabe
   * zurückgenommen: die Session-Zeile kann ein Modell nennen, das inzwischen
   * gelöscht wurde, und daran soll kein Turn scheitern.
   */
  resolveModel(requested) {
    const req = String(requested || "").trim();
    const known = ollamaCache.models.map((m) => m.id);
    // Solange die Liste noch leer ist (erste Anfrage nach dem Start), gilt der
    // Wunsch: der Dienst weiß besser als der Zwischenspeicher, was er hat.
    if (req && (known.length === 0 || known.includes(req))) return req;
    return this.defaultModel || known[0] || "";
  },

  preparePrompt({ prompt }) { return prompt; },

  /**
   * Das Gegenstück zu buildArgs der Spawn-Engines: was über HTTP rausgeht.
   *
   * Der bisherige Verlauf muss mit, weil der Dienst keinen führt. Er geht als
   * echte Rollen-Nachrichten mit und nicht — wie bei Antigravity — als Text im
   * Prompt: das Chat-Format ist hier vorhanden, also wird es benutzt.
   */
  buildRequest({ prompt, model, sid, email, userMessageId }) {
    // Zwei verschiedene Gründe, aus denen kein Modell feststeht — und der
    // Nutzer soll den richtigen lesen, sonst sucht er an der falschen Stelle.
    if (!model) {
      throw new Error(ollamaCache.available
        ? "No local model installed. Run `ollama pull <model>` first."
        : `No response from the service at ${OLLAMA_HOST}`);
    }
    let prior = [];
    try {
      // listMessages ist E-Mail-gebunden; ohne Adresse liefert es null.
      const history = email ? listMessages(sid, email) : null;
      prior = (history || [])
        .filter((m) => m.id !== userMessageId && m.content && m.content.trim())
        .map((m) => ({ role: m.role === "user" ? "user" : "assistant", content: m.content.trim() }));
    } catch {}
    // Dieselbe Grenze wie bei Antigravity: ein 14B-Modell auf einem Notebook
    // hat ein kleines Kontextfenster, und der volle Verlauf verdrängt sonst die
    // eigentliche Frage.
    const messages = [...prior.slice(-16), { role: "user", content: prompt }];
    return { url: `${OLLAMA_HOST}/api/chat`, body: { model, messages, stream: true } };
  },

  /**
   * Das schlichteste der drei Formate: eine Zeile je Token mit
   * message.content, die letzte mit done:true und den Zählern.
   */
  readEvent(ev, sink) {
    if (typeof ev.error === "string" && ev.error) {
      sink.onError(`Ollama: ${ev.error.slice(0, 600)}`);
      return;
    }
    const text = ev.message?.content;
    if (typeof text === "string" && text) sink.onChunk(text);
    if (ev.done) {
      sink.onUsage({
        usage: {
          input_tokens: Number(ev.prompt_eval_count) || 0,
          output_tokens: Number(ev.eval_count) || 0,
        },
        // Lokal entstehen keine Kosten — total_cost_usd bleibt bewusst weg.
        duration_ms: ev.total_duration ? Math.round(Number(ev.total_duration) / 1e6) : 0,
      });
    }
  },

  logs: {
    spawn: "spawn_ollama",
    done: "ollama_done",
    closeAfterWrapup: "ollama_close_after_wrapup",
    emptyTurn: "empty_turn_final_ollama",
  },
  spawnMeta: ({ model }) => ({ model, endpoint: OLLAMA_HOST }),
  killMeta: { engine: "ollama" },

  messages: {
    spawnFailed: (m) => `Could not reach Ollama: ${m}`,
    stall: "The local model has not responded for 10 minutes. Stopped.",
    stallIncomplete: "The local model stopped responding. The answer is incomplete.",
    exit: (code, tail) => `Ollama answered with ${code}: ${tail}`,
    procError: (m) => `Ollama is not reachable: ${m}`,
    emptyTurn: "Empty answer: the local model finished without any text. Please send again.",
  },
};

// Reihenfolge ist die Reihenfolge im Client-Menü.
export const ENGINES = [CLAUDE, CODEX, ANTIGRAVITY, OLLAMA];

export const DEFAULT_ENGINE_ID = "claude";

const BY_NAME = new Map();
for (const e of ENGINES) {
  // isAvailable hängt an der Engine und nicht am Aufrufer, damit eine Engine
  // mit einer anderen Prüfung (Netzdienst statt lokalem Binary) nichts weiter
  // braucht als eine eigene Implementierung hier. Genau das tut Ollama — die
  // Vorgabe greift deshalb nur, wo der Eintrag nichts Eigenes mitbringt.
  if (typeof e.isAvailable !== "function") e.isAvailable = () => binExecutable(e.bin);
  e.transport = e.transport || "spawn";
  e.capabilities = e.capabilities || { tools: true };
  e.aliases = e.aliases || [];
  BY_NAME.set(e.id, e);
  for (const a of e.aliases) BY_NAME.set(a, e);
}

/**
 * Engine zu einer Kennung aus Client oder DB.
 *
 * Ein unbekannter Wert fällt auf Claude zurück statt den Turn scheitern zu
 * lassen: in der sessions-Tabelle stehen Werte aus älteren Client-Versionen,
 * und eine Session, die sich nicht mehr öffnen lässt, wäre der schlechtere
 * Ausgang als eine Antwort von der Standard-Engine.
 */
export function resolveEngine(name) {
  return BY_NAME.get(String(name || "").toLowerCase()) || BY_NAME.get(DEFAULT_ENGINE_ID);
}

/** Engine zu einer Kennung, die es geben MUSS — für die festen Pfade (Warm-Pool,
 *  Auth-Probe, PTY), die ausdrücklich auf einer bestimmten Engine laufen. */
export function getEngine(id) {
  const e = BY_NAME.get(String(id).toLowerCase());
  if (!e) throw new Error(`unknown engine: ${id}`);
  return e;
}

/** Was der Client für die Engine-Auswahl braucht, inklusive Verfügbarkeit. */
export function engineCatalog() {
  return ENGINES.map((e) => ({
    id: e.id,
    name: e.name,
    badge: e.badge,
    models: e.models,
    // Ohne dieses Feld sähe eine Engine ohne Werkzeuge in der Auswahl aus wie
    // jede andere — der Nutzer soll vor dem ersten Prompt wissen, dass hier
    // niemand eine Datei liest oder einen Befehl ausführt.
    capabilities: e.capabilities,
    // Eine von der Firma abgeschaltete Engine ist nicht verfügbar, auch wenn
    // ihr Binary da ist; `disabled` sagt dem Client, warum.
    available: !AGENT_POLICY.disabled.has(e.id) && e.isAvailable(),
    ...(AGENT_POLICY.disabled.has(e.id) ? { disabled: true } : {}),
  }));
}

/**
 * Warum eine Engine gerade keinen Turn fahren darf, oder null.
 *
 * Abgeschaltet oder falsch eingestellt: beides wird vor dem Start gemeldet,
 * nicht erst als kryptischer Exit-Code der CLI.
 */
export function enginePolicyBlock(engine) {
  if (AGENT_POLICY.disabled.has(engine.id)) {
    return `${engine.label} is turned off on this bridge (CONDUIT_DISABLED_ENGINES). Nothing was run.`;
  }
  const err = AGENT_POLICY.errors[engine.id];
  if (err) return `${engine.label} is blocked by a configuration error on this bridge: ${err}. Nothing was run.`;
  return null;
}

export { deniedNotice };
