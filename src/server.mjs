import http from "node:http";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, appendFileSync, statSync, renameSync, writeFileSync, realpathSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { createWarmPool } from "./warm.mjs";
import { checkAndStage, isSupervised, readVersion, DEFAULT_INSTALL_DIR } from "./selfupdate.mjs";
import { resolveEngine, getEngine, engineCatalog, DEFAULT_ENGINE_ID } from "./engines.mjs";
import {
  ensureSession, updateSessionEngine, listSessions, deleteSession, getSession,
  listMessages, insertUserMessage, insertAssistantPlaceholder, appendAssistant,
  updateTitle, updateCwd, addUsage, maybeAutoTitle,
  recordAuditStart, recordAuditEnd, listAudit, sweepStaleRunningAudit,
  sessionOwner,
  latestSessionEmail,
  userMessageExists, assistantAfter, setMessageStatus, listSessionAudit, getAuditStep,
  searchHistory,
} from "./db.mjs";
import {
  addE2eDevice, getE2eDevice, listE2eDevices, revokeE2eDevice, touchE2eDevice,
} from "./db.mjs";
import { loadIdentity } from "./e2e-identity.mjs";
import { createE2eEndpoint } from "./e2e-endpoint.mjs";
import { encodeMessage } from "./e2e-messages.mjs";
import { createSpeechService, SpeechError, LIMITS as SPEECH_LIMITS } from "./speech-service.mjs";
import { issuePairCode, pairPayload, CODE_TTL_MS } from "./e2e-pairing.mjs";
import { createAlexaVerifier } from "./alexa-verify.mjs";
import { handleAlexaRequest } from "./alexa.mjs";
import { createAlexaSession } from "./alexa-session.mjs";

/**
 * Integer from the environment, with bounds. A bare parseInt let a typo become
 * NaN — and `n >= NaN` is false, which silently DISABLED the limit it was
 * supposed to enforce. Out-of-range and unparsable values fall back to the
 * default and say so.
 */
function intEnv(name, def, min, max) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return def;
  // Reject partial parses too: parseInt("5foobar") is 5, and silently running
  // with a number the operator did not write is how a typo becomes a mystery.
  const n = /^-?\d+$/.test(raw.trim()) ? parseInt(raw.trim(), 10) : NaN;
  if (!Number.isFinite(n) || n < min || n > max) {
    console.warn(`[conduit] ${name}=${raw} is not an integer in [${min}, ${max}] — using ${def}`);
    return def;
  }
  return n;
}

function isValidCwd(p) {
  if (typeof p !== "string" || !p.startsWith("/") || p.includes("\0")) return false;
  try { return statSync(p).isDirectory(); } catch { return false; }
}

const PORT = intEnv("BRIDGE_PORT", 8787, 1, 65535);
const HOST = process.env.BRIDGE_HOST || "127.0.0.1";
// Die Engine-Registry (src/engines.mjs) ist die einzige Stelle, an der Binary,
// Modelle und Argumente einer Engine stehen. Claude wird hier trotzdem
// namentlich herausgegriffen: Warm-Pool, Auth-Probe und der Alexa-Slot laufen
// ausdrücklich auf dieser einen Engine und nicht auf „der gerade gewählten".
const CLAUDE_ENGINE = getEngine("claude");
const CLAUDE_BIN = CLAUDE_ENGINE.bin;
const CWD = process.env.CLAUDE_CWD || homedir();
const MODEL = CLAUDE_ENGINE.defaultModel;

// --- Claude auth-readiness probe -------------------------------------------
// healthz only knowing the binary exists isn't enough: a fresh machine can have
// `claude` installed but not signed in, which makes the bridge look "connected"
// while every real turn fails. We ask the CLI itself (`claude auth status
// --json`), cache it for 5 min, and surface claudeReady/claudeMsg so the setup
// wizard tells the truth.
//
// Bis 2.21.0 lief hier ein echter Turn (`claude -p ping`), angestossen von
// jedem healthz-Abruf, also bis zu alle 5 Minuten, solange eine App offen war.
// Das ist automatisierte, nicht menschliche Nutzung auf dem Abo des Nutzers,
// und Anthropic legt die Max-/Pro-Limits ausdruecklich fuer „ordinary,
// individual usage" aus. `auth status` liest nur den lokalen Login-Zustand:
// kein Modellaufruf, keine Tokens. Was dabei verloren geht, ist die Erkennung
// „angemeldet, aber kein Guthaben" — die meldet der erste echte Turn selbst.
let claudeReady = null;     // null = not probed yet
let claudeMsg = null;       // hint when not ready
let claudeProbeAt = 0;
let claudeProbing = false;
const CLAUDE_PROBE_TTL_MS = 5 * 60_000;

function probeClaude() {
  if (claudeProbing) return;
  claudeProbing = true;
  // Belt and braces: if neither `close` nor `error` ever fires (child wedged in
  // an uninterruptible state), the probe used to stay "in progress" forever and
  // healthz reported a frozen claudeReady for the rest of the process lifetime.
  const stuckGuard = setTimeout(() => {
    if (!claudeProbing) return;
    claudeProbing = false;
    claudeProbeAt = Date.now();
    // Also stop the process we just gave up on. Clearing the flag alone let the
    // next healthz start a SECOND probe alongside the first, whose late close
    // handlers then overwrite each other's verdict.
    try { child?.kill("SIGKILL"); } catch {}
    log("warn", "claude_probe_stuck", {});
  }, 60_000);
  stuckGuard.unref?.();
  let out = "", err = "", child;
  try {
    child = spawn(CLAUDE_BIN, ["auth", "status", "--json"], {
      cwd: CWD, env: { ...process.env, FORCE_COLOR: "0" }, stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    clearTimeout(stuckGuard);
    claudeReady = false; claudeMsg = "claude not runnable: " + e.message;
    claudeProbing = false; claudeProbeAt = Date.now(); return;
  }
  // SIGTERM first, then SIGKILL: a claude that ignores SIGTERM would otherwise
  // never emit `close`, wedging the probe (and, in the turn paths below, the
  // session) indefinitely.
  const to = setTimeout(() => {
    try { child.kill("SIGTERM"); } catch {}
    setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 2000).unref?.();
  }, 40_000);
  // Same decoder treatment as the turn readers: a split multi-byte character
  // otherwise becomes U+FFFD and can break the auth-detection regex below.
  const outDec = new StringDecoder("utf8"), errDec = new StringDecoder("utf8");
  child.stdout.on("data", (d) => { out += outDec.write(d); if (out.length > 64_000) out = out.slice(-64_000); });
  child.stderr.on("data", (d) => { err += errDec.write(d); if (err.length > 64_000) err = err.slice(-64_000); });
  child.on("error", (e) => { clearTimeout(to); clearTimeout(stuckGuard); claudeReady = false; claudeMsg = e.message; claudeProbing = false; claudeProbeAt = Date.now(); });
  child.on("close", (code) => {
    clearTimeout(to);
    clearTimeout(stuckGuard);
    claudeProbeAt = Date.now();
    claudeProbing = false;
    // Exit-Code nicht auswerten: abgemeldet kann auch mit Code != 0 kommen,
    // massgeblich ist das JSON. Kein JSON heisst: CLI zu alt fuer `auth
    // status` (oder kaputt) — dann ehrlich „unbekannt" statt geraten.
    let st = null;
    try { st = JSON.parse(out.trim()); } catch {}
    if (st && typeof st.loggedIn === "boolean") {
      claudeReady = st.loggedIn;
      claudeMsg = st.loggedIn ? null : "Not signed in to Claude. Run `claude` once in your terminal and log in.";
    } else {
      claudeReady = null;
      claudeMsg = "Couldn't check the Claude sign-in. Update the CLI with `npm install -g @anthropic-ai/claude-code`.";
    }
    log("info", "claude_probe", { ready: claudeReady, code });
  });
}

/** Replace the home directory with ~ so paths in CLI errors carry no username. */
function redactHome(msg) {
  if (!msg) return msg;
  const home = homedir().replace(/\/+$/, "");
  // Boundary-aware: a plain split turned /Users/alice2/x into ~2/x for a home
  // of /Users/alice. Only replace when the next character ends the path
  // component.
  return String(msg).split(home + "/").join("~/").split(home + '"').join('~"').replace(new RegExp(escapeRe(home) + "(?![\\w.-])", "g"), "~");
}
function escapeRe(x) { return x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function maybeProbeClaude() {
  if (!claudeProbing && Date.now() - claudeProbeAt > CLAUDE_PROBE_TTL_MS) probeClaude();
}
const LOG_DIR = process.env.LOG_DIR || join(homedir(), "Library/Logs/conduit-bridge");
const IDLE_TTL_MS = 12 * 60 * 60 * 1000; // 12h in-memory state
// V2.2: mobile WS often dies on backgrounding / network handoff (FRA→MUC etc).
// Keep child alive long enough for the user to come back and re-attach via
// {type:"attach"}. The answer streams into the DB regardless; the grace timer
// is a safety net for truly orphaned runaway tool-runs.
const ORPHAN_CHILD_GRACE_MS = 30 * 60_000; // 30 min
const INFLIGHT_DONE_TTL_MS = 5 * 60_000;   // keep finished inflight around for late attach
const MAX_BUF = 1_000_000;
const LOG_FILE = join(LOG_DIR, "bridge.log");
const MAX_LOG_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_LOG_FILES = 5;
const WS_PONG_TIMEOUT_MS = 75_000;       // terminate WS if no client traffic
const CHILD_STALL_MS = intEnv("CONDUIT_TURN_STALL_MS", 900_000, 1000, 24 * 3600_000); // no stdout for this long → kill claude
const CHILD_HEARTBEAT_MS = 10_000;       // tick interval for the "still working" heartbeat
const CHILD_HEARTBEAT_MIN_SILENCE_MS = 3_000; // only emit once silence exceeds this, so lively chunks aren't drowned in beats
const MAX_PROMPT_QUEUE = 10;             // max prompts queued while a turn is running (further ones are rejected)
// A prompt becomes an argv entry for the one-shot path, where macOS ARG_MAX
// (~1 MB, less once the environment is counted) turns an oversized prompt into
// an opaque E2BIG spawn failure *after* the user message is already in the DB.
// Reject it up front with a message the user can act on.
const MAX_PROMPT_BYTES = 400_000;
// Absolute ceiling on a single turn, regardless of whether it is producing
// output. The stall watchdog only measures SILENCE, so a turn stuck in a loop
// that keeps printing never trips it and holds its session forever.
//
// Default 0 = off, deliberately: long agent runs are legitimate here and a
// silent ceiling would cut real work in half. Set CONDUIT_MAX_TURN_MS to opt in.
const MAX_TURN_MS = intEnv("CONDUIT_MAX_TURN_MS", 0, 0, 24 * 3600_000);
const MAX_RUNTIME_SESSIONS = intEnv("CONDUIT_MAX_RUNTIME_SESSIONS", 200, 1, 100_000);

// --- QR pairing config -----------------------------------------------------
// PAIR_PORT carries the code-minting routes on a SECOND loopback listener.
// That separation is the security boundary: cloudflared forwards only to
// BRIDGE_PORT, so nothing on this port is reachable from the internet. The
// previous implementation gated those routes on the Host header instead —
// which the remote client controls and the tunnel forwards verbatim, so
// `curl -H "Host: localhost" https://<tunnel>/api/pair/new` would have minted
// a pairing code, and a code is one step from a 180-day token. Never gate on
// a header; gate on which socket the request arrived at.
const PAIR_PORT = intEnv("PAIR_PORT", 8788, 1, 65535);
const PAIR_PUBLIC_HOST = process.env.PAIR_PUBLIC_HOST || "";
const PAIR_OWNER_EMAIL = process.env.PAIR_OWNER_EMAIL || "";
// Resolved lazily: APP_BASE is declared further down, and reading it at module
// load would hit the temporal dead zone.
const pairAppBase = () => APP_BASE;

// qrcode renders the loopback pairing page. Optional dependency: without it the
// page falls back to a tappable link, and the bridge still boots either way.
let _qr; let _qrTried = false;
async function getQRCode() {
  if (_qrTried) return _qr;
  _qrTried = true;
  try { _qr = (await import("qrcode")).default; } catch { _qr = null; }
  return _qr;
}

// Self-update: a running bridge pulls a newer bridge.tar.gz from the app origin
// so fixes land without a manual reinstall. Off with CONDUIT_SELFUPDATE=0.
const BRIDGE_VERSION = readVersion(DEFAULT_INSTALL_DIR) || "unknown";

// End-to-end identity. Devices pin its public key when they pair; see
// src/e2e-identity.mjs. Lives next to the history database, outside the
// install directory, so updates and reinstalls keep it.
const IDENTITY_PATH = process.env.CONDUIT_IDENTITY_PATH
  || join(process.env.DB_DIR || join(homedir(), "Library/conduit-bridge"), "identity.key");
const IDENTITY = await loadIdentity(IDENTITY_PATH);
const b64url = (b) => Buffer.from(b).toString("base64url");
const IDENTITY_FINGERPRINT = createHash("sha256").update(IDENTITY.publicKey).digest("hex").slice(0, 16).match(/.{4}/g).join(" ");
const SELFUPDATE = process.env.CONDUIT_SELFUPDATE !== "0";
const APP_BASE = (process.env.PAIR_APP_BASE || process.env.CONDUIT_APP_BASE || "https://app.tryconduit.de").replace(/\/+$/, "");
// The 3.x channel. /bridge.tar.gz stays frozen on the 3.0.0 stepping stone for
// bridges older than 3.0 (see selfupdate.mjs).
const UPDATE_URL = process.env.CONDUIT_UPDATE_URL || `${APP_BASE}/bridge/v3/bridge.tar.gz`;

// CORS: the PWA at APP_BASE is the only cross-origin caller in production. We
// never answer with `*` — that would let ANY site on the internet script the
// authenticated bridge API from a victim's logged-in browser. Extra origins
// (local dev, a preview deploy) can be allowlisted via BRIDGE_ALLOWED_ORIGINS
// (comma-separated). A response echoes the request Origin only when it's in the
// allowlist; otherwise it falls back to the canonical APP_BASE. Computed once per
// request into res._corsOrigin (see the main handler) so every json()/preflight
// answer stays consistent.
const ALLOWED_ORIGINS = new Set([
  APP_BASE,
  ...(process.env.BRIDGE_ALLOWED_ORIGINS || "")
    .split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean),
]);
function corsOrigin(req) {
  const o = String(req?.headers?.origin || "").replace(/\/+$/, "");
  return o && ALLOWED_ORIGINS.has(o) ? o : APP_BASE;
}
const SELFUPDATE_INTERVAL_MS = intEnv("CONDUIT_SELFUPDATE_INTERVAL_MS", 6 * 60 * 60_000, 60_000, 30 * 24 * 3600_000);

// V3.0: warm Claude process pool. Keeps one long-lived `claude` per session so
// follow-up turns skip the CLI boot + 32k cache rebuild and stream token-by-token
// (--include-partial-messages). Disable with CONDUIT_WARM=0 to fall back to the
// one-shot spawn-per-turn path.
const USE_WARM = process.env.CONDUIT_WARM !== "0";
const WARM_MAX = intEnv("CONDUIT_WARM_MAX", 4, 1, 64);
const WARM_IDLE_MS = intEnv("CONDUIT_WARM_IDLE_MS", 8 * 60_000, 10_000, 24 * 3600_000);


// DNS-rebinding protection: optionally restrict to expected Host headers.
const ALLOWED_HOSTS = (process.env.BRIDGE_ALLOWED_HOSTS || "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
function hostAllowed(req) {
  if (ALLOWED_HOSTS.length === 0) return true; // not configured → skip
  // "[::1]:8787".split(":")[0] is "[" — the loopback exemption never matched an
  // IPv6 literal, and an IPv6 entry in the allowlist could never match either.
  const raw = String(req.headers["host"] || "").toLowerCase().trim();
  const host = raw.startsWith("[")
    ? raw.slice(1, raw.indexOf("]") === -1 ? undefined : raw.indexOf("]"))
    : raw.split(":").length > 2 ? raw : raw.split(":")[0];
  // Always permit loopback so local healthchecks/dev still work.
  if (host === "127.0.0.1" || host === "localhost" || host === "::1") return true;
  return ALLOWED_HOSTS.includes(host);
}

if (!process.env.PAIR_PUBLIC_HOST) console.warn("[conduit] PAIR_PUBLIC_HOST is not set: devices cannot connect end to end until it is");
/**
 * True for every spelling of "bind all interfaces". Matching literals missed
 * the expanded IPv6 form 0:0:0:0:0:0:0:0, which binds just as widely.
 */
function isWildcardHost(h) {
  const v = String(h || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (v === "" || v === "*" || v === "0.0.0.0" || v === "::") return true;
  // Any all-zero IPv6 form: 0:0:0:0:0:0:0:0, ::0, 0::0, …
  if (/^[0:]+$/.test(v) && v.includes(":")) return true;
  return false;
}

// "0.0.0.0" is not the only way to bind everything: "::" covers all IPv6
// interfaces (dual-stack on macOS, so IPv4 too) and an empty value makes
// listen() pick the unspecified address. All of them put the bridge on the LAN,
// which is what this guard exists to prevent.
if (isWildcardHost(HOST)) {
  console.error("[security] BRIDGE_HOST=0.0.0.0 exposes the bridge to the LAN — refusing to start. Use 127.0.0.1.");
  process.exit(1);
}
if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });

// Warn (don't refuse — this is a personal-machine tool and a wide root is a
// legitimate choice) when the mention/cwd scope is the whole home directory or
// the filesystem root. FILE_SEARCH_ROOTS pointed at concrete project folders
// keeps the picker useful and stops accidental mentions of unrelated files.
{
  const home = homedir().replace(/\/+$/, "");
  const wide = (process.env.FILE_SEARCH_ROOTS || CWD)
    .split(":").map((x) => x.trim().replace(/\/+$/, "")).filter(Boolean)
    // `x === ""` was unreachable after filter(Boolean); and a root ABOVE home
    // (like /Users) is just as wide as home itself.
    .filter((x) => x === home || x === "/" || home.startsWith(x + "/"));
  if (wide.length) {
    console.warn(`[conduit] FILE_SEARCH_ROOTS covers ${redactHome(wide.join(", "))} — @-mentions and the cwd picker span your whole home directory. Set FILE_SEARCH_ROOTS to concrete project paths to narrow it.`);
  }
}

// In-process event-loop watchdog: if the loop is starved for >5s,
// self-exit so launchd restarts us. KeepAlive on the agent ensures
// the process is back within ThrottleInterval (10s).
{
  let lastTick = Date.now();
  setInterval(() => {
    const now = Date.now();
    const drift = now - lastTick - 1000;
    // A closed lid freezes the loop exactly like starvation does, and this used
    // to restart the bridge — killing warm processes and live turns — every
    // time the Mac woke up. Real starvation does not last minutes, so treat a
    // very large gap as suspend and just resume.
    if (drift > 5000 && drift < 60_000) {
      console.error(`[event-loop-watchdog] drift=${drift}ms — self-exit for restart`);
      process.exit(2);
    } else if (drift >= 60_000) {
      console.warn(`[event-loop-watchdog] drift=${drift}ms — looks like system sleep, continuing`);
    }
    lastTick = now;
  }, 1000).unref();
}


function rotateLogIfNeeded() {
  try {
    const st = statSync(LOG_FILE);
    if (st.size < MAX_LOG_BYTES) return;
    // Start one lower: rotating from MAX_LOG_FILES-1 created a .MAX file on top
    // of the base file, i.e. one more than the configured maximum.
    for (let i = MAX_LOG_FILES - 2; i >= 0; i--) {
      const src = i === 0 ? LOG_FILE : `${LOG_FILE}.${i}`;
      const dst = `${LOG_FILE}.${i + 1}`;
      try { renameSync(src, dst); } catch {}
    }
  } catch {}
}

// Logs never carry who someone is or what they work on: no email, no paths,
// no search terms, no CLI output. This is enforced here, centrally, so a new
// log call cannot reintroduce it by accident. Error strings keep their message
// but lose home-directory paths.
const LOG_DROP = new Set(["email", "q", "cwd", "path", "stderr", "claudeMsg", "db", "claude", "label"]);
function sanitizeLogMeta(meta) {
  const out = {};
  for (const [k, v] of Object.entries(meta || {})) {
    if (LOG_DROP.has(k)) continue;
    out[k] = typeof v === "string" ? redactHome(v).replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "<email>") : v;
  }
  return out;
}

const log = (level, msg, meta = {}) => {
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...sanitizeLogMeta(meta) }) + "\n";
  process.stdout.write(line);
  rotateLogIfNeeded();
  try { appendFileSync(LOG_FILE, line); } catch {}
};

/** sessionRuntime: sid -> { claudeSessionId, lastUsed, child? } */
const runtime = new Map();

// Local speech (speech-service.mjs). Holds nothing until a model is used.
const speech = createSpeechService({ log });
// 125 s of 48 kHz PCM16 mono plus the header; the app sends 16 kHz.
const TRANSCRIBE_MAX_BYTES = SPEECH_LIMITS.sttSeconds * 48000 * 2 + 4096;



// V3.0 warm process pool (one long-lived `claude` per session, token streaming).
const warmPool = USE_WARM
  ? createWarmPool({
      claudeBin: CLAUDE_BIN, model: MODEL, defaultCwd: CWD,
      env: process.env, log, isUuid,
      maxWarm: WARM_MAX, idleMs: WARM_IDLE_MS, stallMs: CHILD_STALL_MS,
    })
  : null;

setInterval(() => {
  const now = Date.now();
  for (const [sid, s] of runtime) {
    // Der laufende Turn hängt an s.inflight.proc; `s.child` war nie belegt, so
    // dass diese Kehrschleife Runtime-Einträge mit laufendem Turn wegräumte.
    // Einmal weg, ist der Turn für activeTurns() unsichtbar und ein
    // Selbst-Update startete mitten in die Arbeit hinein.
    const busy = !!(s.inflight && !s.inflight.done && (s.inflight.proc || s.inflight.warm));
    const pending = !!(s.promptQueue && s.promptQueue.length);
    if (now - s.lastUsed > IDLE_TTL_MS && !busy && !pending) {
      runtime.delete(sid);
    }
  }
}, 5 * 60_000).unref();

function json(res, code, obj) {
  // The web app (app.tryconduit.de) calls these endpoints cross-origin through
  // the tunnel, so every JSON response needs the CORS origin header — without
  // it the browser blocks the response even after a successful preflight. The
  // allowed origin is resolved per request (res._corsOrigin), never `*`.
  res.writeHead(code, {
    "content-type": "application/json",
    "access-control-allow-origin": res._corsOrigin || APP_BASE,
    "vary": "origin",
  });
  res.end(JSON.stringify(obj));
}

async function readJson(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let total = 0;
    req.on("data", (c) => {
      total += c.length;
      if (total > 1_000_000) { req.destroy(); resolve(null); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { resolve(null); }
    });
    // `error` alone is not enough: destroying an IncomingMessage without an
    // error object terminates it via aborted/close, and the awaiting caller
    // would hang forever — which is exactly how the single Alexa slot could be
    // held indefinitely. Promise semantics make the extra resolves harmless.
    req.on("aborted", () => resolve(null));
    req.on("close", () => resolve(null));
    req.on("error", () => resolve(null));
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://localhost");
  // Resolve the allowed CORS origin once for this request; reused by json(),
  // the OPTIONS preflight and /healthz below so they never disagree.
  res._corsOrigin = corsOrigin(req);

  if (!hostAllowed(req)) {
    return json(res, 421, { ok: false, error: "host not allowed" });
  }

  // CORS preflight — the setup wizard polls /healthz cross-origin from the web
  // app, and the composer uploads files to /api/paste with x-conduit-filename
  // (which the browser preflights because it's a non-simple header).
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": res._corsOrigin || APP_BASE,
      "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
      "access-control-allow-headers": "authorization,content-type,x-conduit-filename",
      "vary": "origin",
    });
    return res.end();
  }

  // Reachable through the tunnel without authentication, so it says nothing
  // but "a bridge is listening here". Version, engine state and everything
  // else is only available inside an end-to-end session (/api/status), so
  // nobody on the path can steer the app with a forged answer.
  if (u.pathname === "/healthz") {
    res.writeHead(200, {
      "content-type": "application/json",
      "access-control-allow-origin": res._corsOrigin || APP_BASE,
      "vary": "origin",
      "cache-control": "no-store",
    });
    return res.end(JSON.stringify({ ok: true, e2e: 1 }));
  }

  // Alexa: Amazon calls the bridge directly. Authenticated by Amazon's
  // request signature and the skill id, nothing else (see src/alexa-verify.mjs).
  if (u.pathname === "/alexa" && req.method === "POST") {
    return handleAlexaHttp(req, res);
  }

  // There is no plaintext API through the tunnel any more. Devices talk to the
  // bridge only inside an end-to-end session on /e2e (see src/e2e-*.mjs); old
  // clients get a clear answer instead of a silent fallback.
  if (u.pathname.startsWith("/api/") || u.pathname === "/ws" || u.pathname === "/pty") {
    return json(res, 426, { ok: false, error: "end-to-end session required", upgrade: "/e2e" });
  }

  res.writeHead(404).end();
});

// Roots a session's working directory may be set to. Defaults to CLAUDE_CWD;
// override with FILE_SEARCH_ROOTS as a colon-separated list of absolute paths.
//
// SCOPE — read this before trusting it. SEARCH_ROOTS bounds the session `cwd`
// a client may switch to. It is NOT a sandbox around claude. Every turn runs with
// `--permission-mode bypassPermissions`, so a prompt like "read ~/.ssh/config"
// reaches the real filesystem no matter what is configured here. Treat this as
// a discovery filter that keeps the picker tidy and honest, and treat a valid
// token as equivalent to a shell on this machine — because it is.
//
// A narrow root is still worth setting (see the boot warning below): it keeps
// accidental mentions and the cwd picker inside real project directories.
const SEARCH_ROOTS = (process.env.FILE_SEARCH_ROOTS || CWD)
  .split(":")
  .map((s) => s.trim())
  .filter((s) => s.startsWith("/"))
  // strip trailing slashes for clean prefix comparison
  .map((s) => (s.length > 1 ? s.replace(/\/+$/, "") : s));
// Never surface secret/credential files in search results or mentions, even if
// they live inside an allowed root. Matched case-insensitively against a single
// name (file or directory).
const SECRET_NAME_RE = /(^\.env($|\.)|\.env|secret|credential|password|token|\.pem$|\.key$|\.p8$|\.p12$|\.pfx$|\.jks$|\.keystore$|^id_[a-z0-9]+$|\.keychain|^\.npmrc$|^\.netrc$|^\.pypirc$|^\.pgpass$|^known_hosts$|^authorized_keys$|^cookies$|^login data$)/i;
// Directories whose *entire subtree* is off limits, matched on any path segment.
const SECRET_DIR_RE = /^(\.ssh|\.aws|\.gnupg|\.gpg|\.docker|\.kube|\.config\/gcloud|\.azure|\.password-store|keys?|secrets?|credentials?)$/i;
function isSecretName(name) {
  return SECRET_NAME_RE.test(name) || SECRET_DIR_RE.test(name);
}
/**
 * True if ANY segment of the path is secret-ish — not just the basename.
 * `~/project/credentials/token.txt` and `~/.ssh/config` both have innocuous
 * basenames; checking only the last segment let them straight through.
 */
function pathHasSecretSegment(p) {
  return p.split("/").filter(Boolean).some(isSecretName);
}

// Hard path allowlist: a path is only readable/mentionable if it resolves under
// one of SEARCH_ROOTS (prefix match on a normalized, symlink-resolved path).
function isAllowedPath(p) {
  if (typeof p !== "string" || !p.startsWith("/") || p.includes("\0")) return false;
  let real;
  try { real = realpathSync(p); } catch { return false; }
  for (const root of SEARCH_ROOTS) {
    let realRoot;
    try { realRoot = realpathSync(root); } catch { continue; }
    if (real === realRoot || real.startsWith(realRoot + "/")) {
      // Check the part *below* the root: a root that itself sits in, say,
      // ~/keys would otherwise block everything under it.
      const rel = real.slice(realRoot.length);
      if (pathHasSecretSegment(rel)) return false;
      return true;
    }
  }
  return false;
}

// Persistent across reboots — `/tmp` gets wiped, which silently broke old
// transcripts that referenced a saved image. The dir is per-user (the bridge
// runs under the local account) so the user can also grep their own pastes.
const PASTE_DIR = process.env.PASTE_DIR || join(homedir(), "Library/conduit-bridge/pastes");
const PASTE_MAX_BYTES = 25 * 1024 * 1024; // 25 MB
const PASTE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30d retention — keeps DB references valid for a sane window
const PASTE_ALLOWED_MIME = new Map([
  ["image/png", ".png"],
  ["image/jpeg", ".jpg"],
  ["image/jpg", ".jpg"],
  ["image/gif", ".gif"],
  ["image/webp", ".webp"],
  ["image/heic", ".heic"],
  ["image/heif", ".heif"],
  ["image/svg+xml", ".svg"],
  ["application/pdf", ".pdf"],
  ["text/plain", ".txt"],
  ["text/markdown", ".md"],
  ["text/csv", ".csv"],
  ["text/tab-separated-values", ".tsv"],
  ["text/html", ".html"],
  ["text/xml", ".xml"],
  ["application/xml", ".xml"],
  ["application/json", ".json"],
  ["application/x-yaml", ".yaml"],
  ["text/yaml", ".yaml"],
  ["text/x-log", ".log"],
  ["application/zip", ".zip"],
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".docx"],
  ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".xlsx"],
  ["application/vnd.openxmlformats-officedocument.presentationml.presentation", ".pptx"],
  ["application/msword", ".doc"],
  ["application/vnd.ms-excel", ".xls"],
  ["application/vnd.ms-powerpoint", ".ppt"],
  ["audio/mpeg", ".mp3"],
  ["audio/mp4", ".m4a"],
  ["audio/wav", ".wav"],
  ["audio/webm", ".weba"],
  ["audio/ogg", ".ogg"],
  ["video/mp4", ".mp4"],
  ["video/quicktime", ".mov"],
  ["video/webm", ".webm"],
]);

// Browser-Picker auf Android/iOS schickt für Code/Text-Dateien oft
// application/octet-stream + den echten Dateinamen im X-Conduit-Filename-Header.
// Fall back auf die Extension, wenn der Name eine bekannte Text-Endung trägt —
// sonst wäre jeder Upload von .md/.ts/.json blockiert obwohl claude den Inhalt
// problemlos lesen kann.
const PASTE_FILENAME_FALLBACK_EXT = new Set([
  ".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".yaml", ".yml",
  ".log", ".html", ".htm", ".xml", ".svg",
  ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx",
  ".py", ".rb", ".go", ".rs", ".swift", ".kt", ".java", ".c", ".h",
  ".cpp", ".hpp", ".cs", ".php", ".sh", ".bash", ".zsh", ".sql",
  ".css", ".scss", ".less", ".vue", ".svelte", ".astro",
  ".toml", ".ini", ".cfg", ".conf", ".env",
]);

function gcPasteDir() {
  if (!existsSync(PASTE_DIR)) return;
  const cutoff = Date.now() - PASTE_MAX_AGE_MS;
  for (const name of readdirSync(PASTE_DIR)) {
    const p = join(PASTE_DIR, name);
    try {
      const st = statSync(p);
      if (st.isFile() && st.mtimeMs < cutoff) unlinkSync(p);
    } catch { /* file vanished between readdir and stat — ignore */ }
  }
}

async function handlePasteUpload(req, res, auth) {
  const ct = (req.headers["content-type"] || "").toLowerCase();
  const cl = parseInt(req.headers["content-length"] || "0", 10);
  if (cl && cl > PASTE_MAX_BYTES) {
    return json(res, 413, { ok: false, error: "file too large (max 25 MB)" });
  }

  // Raw upload only — the PWA sends Content-Type: image/* / application/pdf /
  // text/* / application/json etc. The previous binary-string multipart parser
  // was unsafe (latin1 round-trip + boundary collisions in image bytes) and
  // unused — removed.
  const mime = ct.split(";")[0].trim();
  const rawFilename = String(req.headers["x-conduit-filename"] || "").slice(0, 200);
  const filenameExt = (() => {
    const m = rawFilename.toLowerCase().match(/\.[a-z0-9]{1,8}$/);
    return m ? m[0] : "";
  })();

  let ext = PASTE_ALLOWED_MIME.get(mime);
  if (!ext) {
    // application/octet-stream + bekannte Text/Code-Endung → durchlassen.
    // Browser-Picker auf Android/iOS markieren .ts/.md/.json etc. oft generisch.
    if (filenameExt && PASTE_FILENAME_FALLBACK_EXT.has(filenameExt)) {
      ext = filenameExt;
    } else {
      return json(res, 415, {
        ok: false,
        error: `unsupported file type (${mime || "unknown"}${filenameExt ? `, ${filenameExt}` : ""})`,
      });
    }
  }

  try {
    if (!existsSync(PASTE_DIR)) mkdirSync(PASTE_DIR, { recursive: true });

    const chunks = [];
    let received = 0;
    for await (const chunk of req) {
      received += chunk.length;
      if (received > PASTE_MAX_BYTES) throw new Error("file too large");
      chunks.push(chunk);
    }
    if (!received) return json(res, 400, { ok: false, error: "empty body" });
    const fileBuf = Buffer.concat(chunks);

    const name = `${Date.now()}-${randomUUID().slice(0, 8)}${ext}`;
    const filePath = join(PASTE_DIR, name);
    writeFileSync(filePath, fileBuf);

    log("info", "paste_saved", { email: auth.email, path: filePath, bytes: fileBuf.length });
    // Best-effort age sweep so the paste dir doesn't grow unbounded. Cheap (a
    // few readdir+stat per write, in practice <100 entries) and never blocks
    // the response on failure.
    try { gcPasteDir(); } catch { /* noop */ }
    return json(res, 200, { ok: true, path: filePath, bytes: fileBuf.length });
  } catch (e) {
    log("error", "paste_failed", { email: auth.email, err: String(e) });
    // Chunked uploads have no Content-Length, so the size check above cannot
    // fire and oversize arrived here as a generic 500.
    if (/file too large/i.test(String(e?.message || e))) {
      return json(res, 413, { ok: false, error: "file too large (max 25 MB)" });
    }
    return json(res, 500, { ok: false, error: redactHome(String(e?.message || e)).slice(0, 300) });
  }
}

// =============================================================
// Alexa: the signed /alexa endpoint (alexa.mjs checks skill, user and Amazon's
// signature) asks one Claude conversation (alexa-session.mjs).
// =============================================================
const ALEXA_MODEL = process.env.CLAUDE_ALEXA_MODEL || "haiku";
const ALEXA_BODY_TIMEOUT_MS = 10_000;
const ALEXA_SKILL_ID = (process.env.ALEXA_SKILL_ID || "").trim();
// The Alexa account (amzn1.ask.account…) allowed to use the skill. Until it is
// set, verified requests of the own skill only log the caller's id (alexa.mjs).
const ALEXA_USER_ID = (process.env.ALEXA_USER_ID || "").trim();
const ALEXA_MAX_BODY = 64 * 1024;
const verifyAlexa = createAlexaVerifier();

const alexaSession = createAlexaSession({ claudeBin: CLAUDE_BIN, cwd: CWD, stateDir: LOG_DIR, model: ALEXA_MODEL, log });
const askAlexa = (query) => alexaSession.ask(query);

async function handleAlexaHttp(req, res) {
  const reply = (status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (!ALEXA_SKILL_ID) return reply(503, { error: "skill not configured" });
  let raw;
  try {
    raw = await readRawBody(req, ALEXA_MAX_BODY, ALEXA_BODY_TIMEOUT_MS);
  } catch {
    return reply(400, { error: "bad body" });
  }
  let payload;
  try {
    payload = await verifyAlexa({
      certUrl: req.headers["signaturecertchainurl"],
      signature256: req.headers["signature-256"],
      body: raw,
    });
  } catch (e) {
    log("warn", "alexa_verify_failed", { err: String(e?.message || e).slice(0, 120) });
    return reply(400, { error: "signature verification failed" });
  }
  const out = await handleAlexaRequest(payload, { skillId: ALEXA_SKILL_ID, userId: ALEXA_USER_ID, ask: askAlexa, log });
  return reply(out.status, out.body);
}

/** Read a request body up to `max` bytes within `timeoutMs`. */
function readRawBody(req, max, timeoutMs) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    const timer = setTimeout(() => { req.destroy(); reject(new Error("timeout")); }, timeoutMs);
    timer.unref?.();
    req.on("data", (c) => {
      n += c.length;
      if (n > max) { clearTimeout(timer); req.destroy(); reject(new Error("too large")); return; }
      chunks.push(c);
    });
    req.on("end", () => { clearTimeout(timer); resolve(Buffer.concat(chunks)); });
    req.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}


// --- QR pairing handlers ---------------------------------------------------

/** Identity every paired token is minted for. Never taken from the request. */
function resolveOwnerEmail() {
  if (PAIR_OWNER_EMAIL) return PAIR_OWNER_EMAIL;
  try { return latestSessionEmail(); } catch { return ""; }
}

function pairConfigError() {
  if (!PAIR_PUBLIC_HOST) return "PAIR_PUBLIC_HOST ist auf der Bridge nicht gesetzt";
  if (!resolveOwnerEmail()) return "Noch kein Konto auf diesem Rechner — bitte einmal über die Conduit-App anmelden, dann koppeln";
  return null;
}

function escapeHtml(x) {
  return String(x).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

/**
 * Link the QR encodes. Everything secret sits in the fragment, which browsers
 * never send to the server: the app reads it locally and pairs end to end.
 */
function e2ePairLink(issuedBy) {
  const { codeId, psk, exp } = issuePairCode({ email: resolveOwnerEmail(), issuedBy });
  const payload = pairPayload({ host: PAIR_PUBLIC_HOST, bridgeKey: IDENTITY.publicKey, codeId, psk, exp });
  return { url: `${pairAppBase()}/pair#${b64url(JSON.stringify(payload))}`, payload, exp };
}

async function handlePairNew(req, res) {
  const cfgErr = pairConfigError();
  if (cfgErr) return json(res, 500, { ok: false, error: cfgErr });
  const { url, exp } = e2ePairLink("localhost");
  log("info", "pair_code_new", { ttlMs: CODE_TTL_MS });
  return json(res, 200, { ok: true, url, host: PAIR_PUBLIC_HOST, expiresAt: exp, fingerprint: IDENTITY_FINGERPRINT });
}

async function handlePairPage(req, res) {
  const cfgErr = pairConfigError();
  const headers = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" };
  if (cfgErr) {
    res.writeHead(500, headers);
    return res.end(`<!doctype html><meta charset=utf-8><body style="font-family:system-ui;background:#0b0f17;color:#e5e7eb;padding:40px"><h1>Pairing nicht konfiguriert</h1><p>${cfgErr}</p>`);
  }
  const { url } = e2ePairLink("localhost");
  let svg = "";
  const QRCode = await getQRCode();
  if (QRCode) {
    try {
      svg = await QRCode.toString(url, { type: "svg", margin: 1, errorCorrectionLevel: "M", color: { dark: "#0b0f17", light: "#ffffff" } });
    } catch { svg = ""; }
  }
  if (!svg) {
    svg = `<div style="padding:18px 14px"><a href="${escapeHtml(url)}" style="font-family:ui-monospace,monospace;font-size:12px;color:#0b0f17;word-break:break-all">${escapeHtml(url)}</a></div>`;
  }
  const reloadSec = 160; // refresh a little before the 3-minute code expires
  res.writeHead(200, headers);
  res.end(`<!doctype html><html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="${reloadSec}">
<title>Conduit – Gerät koppeln</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
    background:#0b0f17; color:#e5e7eb; min-height:100dvh; display:grid; place-items:center; padding:24px; }
  .card { width:100%; max-width:380px; text-align:center; }
  h1 { font-size:20px; font-weight:650; margin:0 0 6px; }
  p { color:#9aa4b2; font-size:14px; line-height:1.5; margin:0 0 22px; }
  .qr { background:#fff; border-radius:20px; padding:18px; display:inline-block; box-shadow:0 12px 40px rgba(0,0,0,.45); }
  .qr svg { display:block; width:248px; height:248px; }
  .code { margin-top:18px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; letter-spacing:3px;
    font-size:18px; color:#cbd5e1; }
  .host { margin-top:8px; font-size:12px; color:#6b7280; }
  .ttl { margin-top:14px; font-size:12px; color:#6b7280; }
</style></head>
<body><div class="card">
  <h1>Gerät mit Conduit koppeln</h1>
  <p>Richte die Handy-Kamera auf den Code, oder öffne den Link in einem Browser auf diesem Rechner. Conduit koppelt das Gerät Ende-zu-Ende verschlüsselt mit diesem Rechner. Der Fingerabdruck unten erscheint danach auch in der App.</p>
  <div class="qr">${svg}</div>
  <div class="code">${escapeHtml(IDENTITY_FINGERPRINT)}</div>
  <div class="host">${escapeHtml(PAIR_PUBLIC_HOST)}</div>
  <div class="ttl">Code läuft in 3 Minuten ab · Seite aktualisiert sich automatisch</div>
</div></body></html>`);
}

// Second listener, loopback only, NOT forwarded by the tunnel. Everything that
// mints a pairing code lives here and nowhere else. Binding is hard-coded to
// 127.0.0.1 so no environment variable can accidentally expose it.
const pairServer = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, "http://localhost");
    const addr = req.socket.remoteAddress || "";
    // Defence in depth behind the loopback bind: reject anything that somehow
    // arrives from a non-loopback peer.
    if (!(addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1")) {
      res.writeHead(403).end(); return;
    }
    // DNS REBINDING. The peer check above is not enough: a browser tricked into
    // resolving evil.example to 127.0.0.1 connects FROM loopback, and after the
    // rebind the page is same-origin with this port — so it can POST
    // /api/pair/new, read the code out of the response, and redeem it through
    // the public tunnel for a 180-day token. What the attacker cannot forge is
    // the Host header: the browser sends the name it thinks it is talking to.
    const host = String(req.headers["host"] || "").toLowerCase().replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
    if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
      log("warn", "pair_bad_host", { host: host.slice(0, 80) });
      res.writeHead(403).end(); return;
    }
    // A cross-site page always sends Origin on a POST. A local operator opening
    // the page directly never does.
    if (req.headers["origin"]) {
      log("warn", "pair_cross_origin", { origin: String(req.headers["origin"]).slice(0, 80) });
      res.writeHead(403).end(); return;
    }
    if (u.pathname === "/pair" && req.method === "GET") return handlePairPage(req, res);
    if (u.pathname === "/api/pair/new" && req.method === "POST") return handlePairNew(req, res);
    res.writeHead(404).end();
  } catch (e) {
    log("error", "pair_server_failed", { err: String(e) });
    try { res.writeHead(500).end(); } catch {}
  }
});
pairServer.on("error", (e) => log("error", "pair_listen_failed", { err: String(e?.message || e) }));
pairServer.listen(PAIR_PORT, "127.0.0.1", () => {
  log("info", "pair_listening", { port: PAIR_PORT, host: PAIR_PUBLIC_HOST || "(PAIR_PUBLIC_HOST unset)" });
});

async function handleApi(req, res, u, auth) {
  const email = auth.email;
  const path = u.pathname;

  if (path === "/api/paste" && req.method === "POST") {
    return handlePasteUpload(req, res, auth);
  }

  // Everything below is reachable only inside an end-to-end session.

  // Bridge state for the app (moved here from the public /healthz).
  if (path === "/api/status" && req.method === "GET") {
    const claudeOk = CLAUDE_ENGINE.isAvailable();
    if (claudeOk) maybeProbeClaude();
    return json(res, 200, {
      ok: true,
      version: BRIDGE_VERSION,
      fingerprint: IDENTITY_FINGERPRINT,
      sessions: runtime.size,
      uptime: process.uptime(),
      claude: claudeOk,
      claudeReady,
      claudeMsg: redactHome(claudeMsg),
      activeChildren: [...runtime.values()].filter((r) => r.inflight?.proc || r.inflight?.warm).length,
    });
  }

  // Paired devices of this account: list, revoke, and a pairing code for a
  // new device shown as QR on this one.
  if (path === "/api/e2e/devices" && req.method === "GET") {
    return json(res, 200, {
      ok: true,
      devices: listE2eDevices(email).map((r) => ({
        id: r.device_id, label: r.label, platform: r.platform, pairedVia: r.paired_via,
        createdAt: r.created_at, lastSeen: r.last_seen, revoked: !!r.revoked_at,
        current: r.device_id === auth.deviceId,
      })),
    });
  }
  {
    const dm = path.match(/^\/api\/e2e\/devices\/([0-9a-f]{16})$/);
    if (dm && req.method === "DELETE") {
      const target = listE2eDevices(email).find((r) => r.device_id === dm[1]);
      const revoked = revokeE2eDevice(dm[1], email);
      if (target && revoked) e2e.kickDevice(target.pubkey);
      log("info", "e2e_device_revoked", { device: dm[1], by: auth.deviceId, revoked });
      return json(res, 200, { ok: true, revoked: !!revoked });
    }
  }
  if (path === "/api/e2e/pair-code" && req.method === "POST") {
    const { url, payload, exp } = e2ePairLink(`device:${auth.deviceId}`);
    log("info", "pair_code_new", { by: auth.deviceId });
    return json(res, 200, { ok: true, url, payload, expiresAt: exp });
  }

  // Local speech: status, install and remove models, dictate, read aloud.
  if (path.startsWith("/api/speech") || path === "/api/transcribe" || path === "/api/speak") {
    try {
      if (path === "/api/speech" && req.method === "GET") return json(res, 200, { ok: true, ...speech.status() });
      if (path === "/api/speech/install" && req.method === "POST") {
        const body = await readJson(req);
        speech.install(String(body?.id || ""));
        log("info", "speech_install", { id: String(body?.id || "").slice(0, 64), by: auth.deviceId });
        return json(res, 200, { ok: true });
      }
      const mm = path.match(/^\/api\/speech\/models\/([A-Za-z0-9._-]{1,64})$/);
      if (mm && req.method === "DELETE") {
        speech.remove(mm[1]);
        log("info", "speech_remove", { id: mm[1], by: auth.deviceId });
        return json(res, 200, { ok: true });
      }
      if (path === "/api/transcribe" && req.method === "POST") {
        let wav;
        try { wav = await readRawBody(req, TRANSCRIBE_MAX_BYTES, 60_000); }
        catch (e) { return json(res, String(e?.message) === "too large" ? 413 : 400, { ok: false, error: "recording too long or incomplete" }); }
        const r = await speech.transcribe(wav);
        log("info", "speech_transcribed", { seconds: Math.round(r.seconds), ms: r.ms });
        return json(res, 200, { ok: true, text: r.text });
      }
      if (path === "/api/speak" && req.method === "POST") {
        const body = await readJson(req);
        if (!body || typeof body !== "object") return json(res, 400, { ok: false, error: "bad request" });
        const abort = new AbortController();
        res.on("close", () => abort.abort());
        let started = false;
        try {
          await speech.speak(String(body.text ?? ""), {
            lang: body.lang === "en" ? "en" : body.lang === "de" ? "de" : undefined,
            voice: typeof body.voice === "string" ? body.voice.slice(0, 64) : undefined,
            speed: body.speed === undefined ? 1 : Number(body.speed),
            signal: abort.signal,
            onSegment: (wav) => {
              if (!started) { started = true; res.writeHead(200, { "content-type": "application/octet-stream" }); }
              res.write(Buffer.from(encodeMessage(wav)));
            },
          });
        } catch (e) {
          if (!started) throw e;
          log("warn", "speech_speak_failed", { err: String(e?.message || e).slice(0, 200) });
        }
        if (!started) res.writeHead(200, { "content-type": "application/octet-stream" });
        return res.end();
      }
      return json(res, 404, { ok: false, error: "not found" });
    } catch (e) {
      if (e instanceof SpeechError) return json(res, e.status, { ok: false, error: e.message });
      log("error", "speech_error", { err: String(e?.message || e).slice(0, 300) });
      return json(res, 500, { ok: false, error: "speech failed" });
    }
  }

  // Die Liste kommt unverändert aus der Registry — eine weitere Engine taucht
  // hier auf, sobald sie dort eingetragen ist, ohne Eingriff im Handler.
  if (path === "/api/engines" && req.method === "GET") {
    return json(res, 200, {
      ok: true,
      engines: engineCatalog(),
      defaultEngine: DEFAULT_ENGINE_ID,
    });
  }

  if (path === "/api/sessions" && req.method === "GET") {
    const rows = listSessions(email);
    return json(res, 200, {
      ok: true,
      sessions: rows.map((r) => ({
        id: r.id,
        title: r.title,
        updatedAt: r.updated_at,
        cwd: r.cwd || null,
        engine: r.engine || "claude",
        model: r.model || null,
        usage: {
          tokens_in: r.tokens_in || 0,
          tokens_out: r.tokens_out || 0,
          cache_read: r.cache_read || 0,
          cache_create: r.cache_create || 0,
          cost_usd: r.cost_usd || 0,
          turns: r.turns || 0,
        },
      })),
    });
  }

  // Full-history search: chat titles and message bodies, this account's only.
  // The transcripts live here and nowhere else, so this is the only place the
  // question "where did I say that" can be answered — the clients hold just the
  // chats they happen to have opened.
  if (path === "/api/search" && req.method === "GET") {
    const q = u.searchParams.get("q") || "";
    // Clamp: `?limit=99999999` would otherwise walk the whole history into one
    // JSON response for a sidebar that shows a couple of dozen rows.
    const limit = Math.min(100, Math.max(1, Number(u.searchParams.get("limit")) || 40));
    const r = searchHistory(email, q, { limit });
    return json(res, 200, {
      ok: true,
      hits: r.hits,
      sessions: r.sessions,
      steps: r.steps,
      // True when the walk hit its row budget before the result limit — the
      // client says "older chats not searched" rather than implying emptiness.
      truncated: r.truncated,
    });
  }

  // One step in full: the command as it ran and what it printed. Kept off the
  // transcript list on purpose (see the `steps` mapping) — this is fetched only
  // when a reader actually opens a step.
  const stepM = path.match(/^\/api\/steps\/([A-Za-z0-9_-]+)$/);
  if (stepM && req.method === "GET") {
    const row = getAuditStep(stepM[1], email);
    if (!row) return json(res, 404, { ok: false, error: "not found" });
    const stored = row.output ? Buffer.byteLength(row.output, "utf8") : 0;
    return json(res, 200, {
      ok: true,
      step: {
        id: row.id,
        assistantId: row.assistant_id,
        tool: row.tool,
        summary: row.summary || "",
        status: row.status,
        ts: row.ts,
        durationMs: row.duration_ms ?? null,
        input: row.input_full || "",
        output: row.output || "",
        // What the tool actually produced vs. what survived the cap, so the UI
        // can say "gekürzt" instead of quietly showing a truncated log as whole.
        outputBytes: row.output_bytes ?? stored,
        truncated: (row.output_bytes ?? stored) > stored,
      },
    });
  }

  if (path === "/api/audit" && req.method === "GET") {
    const sinceTs = Number(u.searchParams.get("since")) || 0;
    // Clamp: `?limit=99999999` would otherwise pull the whole audit table into
    // memory and JSON on every request.
    const limit = Math.min(2000, Math.max(1, Number(u.searchParams.get("limit")) || 500));
    const rows = listAudit(email, { sinceTs, limit });
    return json(res, 200, {
      ok: true,
      events: rows.map((r) => ({
        id: r.id,
        sessionId: r.session_id,
        sessionTitle: r.session_title || "Chat",
        tool: r.tool,
        summary: r.summary || "",
        status: r.status,
        ts: r.ts,
      })),
    });
  }

  const m = path.match(/^\/api\/sessions\/([0-9a-f-]+)(\/messages|\/inflight)?$/i);
  if (m) {
    const sid = m[1];
    const isMessages = m[2] === "/messages";
    const isInflight = m[2] === "/inflight";
    if (isMessages && req.method === "GET") {
      const msgs = listMessages(sid, email);
      if (msgs === null) return json(res, 404, { ok: false, error: "not found" });
      // Ship the tool steps alongside the transcript. They used to reach the
      // client only as live `activity` frames, so a turn you were not watching
      // lost its trail entirely — and now that tool calls are no longer written
      // into the answer text, that would have meant history showing no sign a
      // turn had done anything at all. One request, no second race.
      const steps = listSessionAudit(sid, email) || [];
      return json(res, 200, {
        ok: true,
        messages: msgs.map((r) => ({ id: r.id, role: r.role, content: r.content, ts: r.ts, model: r.model || null })),
        steps: steps.map((r) => ({
          id: r.id,
          assistantId: r.assistant_id,
          tool: r.tool,
          summary: r.summary || "",
          status: r.status,
          ts: r.ts,
          durationMs: r.duration_ms ?? null,
          // The full command and output are deliberately NOT in this list — a
          // transcript with a hundred steps would drag megabytes of build log
          // along for a view that shows one line each. Fetched per step, on
          // demand, from /api/steps/:id.
          hasDetail: !!r.has_detail,
        })),
      });
    }
    // HTTP mirror of the WS {type:"attach"} reply. A client whose WebSocket went
    // half-open (mobile/cellular: TCP dead, no FIN/RST, no onclose) can recover a
    // finished or still-running answer over a plain short-lived GET — which
    // survives flaky networks far better than a long-lived socket. Same source of
    // truth as attach: the in-memory rt.inflight (kept INFLIGHT_DONE_TTL_MS after
    // done). If it has already aged out, the client falls back to /messages (DB).
    if (isInflight && req.method === "GET") {
      if (!getSession(sid, email)) return json(res, 404, { ok: false, error: "not found" });
      const rt = runtime.get(sid);
      const inf = rt?.inflight;
      if (!inf) return json(res, 200, { ok: true, inflight: false });
      return json(res, 200, {
        ok: true,
        inflight: true,
        assistantMessageId: inf.assistantId,
        content: inf.content,
        done: !!inf.done,
        running: !inf.done,
        error: inf.errorMsg || null,
      });
    }
    if (!isMessages && req.method === "DELETE") {
      const r = deleteSession(sid, email);
      // deleteSession is email-scoped in SQL, so changes === 0 means the session
      // either doesn't exist or belongs to someone else. Tearing down the runtime
      // anyway would let any authenticated caller SIGTERM a foreign session's
      // live child and wipe its reconnect state.
      if (!r.changes) return json(res, 404, { ok: false, error: "not found" });
      const rt = runtime.get(sid);
      if (rt?.inflight && !rt.inflight.done) {
        // Mark BEFORE stopping the warm proc. warmPool.stop() surfaces as
        // onError, and the warm path's error handler retries an unstarted turn
        // through the one-shot spawn — which would resurrect the prompt of a
        // session the user just deleted and run it with bypassPermissions.
        rt.inflight.stopRequested = true;
        rt.inflight.done = true;
      }
      if (rt?.promptQueue?.length) rt.promptQueue = [];
      // Sockets keep the runtime object in their closure. Without closing them,
      // the next prompt on an already-open socket calls ensureSession() and
      // quietly RECREATES the session that was just deleted, running on a
      // runtime object no longer reachable from the map.
      if (rt) {
        rt.deleted = true;
        for (const sub of [...(rt.subscribers || [])]) {
          try { sub.send(JSON.stringify({ type: "error", message: "Session wurde gelöscht." })); } catch {}
          try { sub.close(); } catch {}
        }
        rt.subscribers?.clear?.();
      }
      // Escalating kill, like every other path: a claude wedged in a tool call
      // ignores SIGTERM, and after runtime.delete() below nothing would ever
      // come back to it — an orphaned process with bypassPermissions and no
      // owning session.
      rt?.inflight?.proc?.stop("session_delete");
      if (warmPool) warmPool.stop(sid);
      runtime.delete(sid);
      return json(res, 200, { ok: true, deleted: r.changes });
    }
    if (!isMessages && req.method === "PATCH") {
      const body = await readJson(req) || {};
      const out = { ok: true };
      if (typeof body.title === "string") {
        const title = body.title.trim().slice(0, 120);
        if (!title) return json(res, 400, { ok: false, error: "title empty" });
        out.titleUpdated = updateTitle(sid, email, title).changes;
      }
      if (typeof body.cwd === "string" || body.cwd === null) {
        if (body.cwd === null || body.cwd === "") {
          out.cwdUpdated = updateCwd(sid, email, null).changes;
        } else if (!isValidCwd(body.cwd)) {
          return json(res, 400, { ok: false, error: "cwd invalid or not a directory" });
        } else if (!isAllowedPath(body.cwd)) {
          return json(res, 403, { ok: false, error: "cwd outside allowed roots" });
        } else {
          out.cwdUpdated = updateCwd(sid, email, body.cwd).changes;
        }
      }
      if (out.titleUpdated === undefined && out.cwdUpdated === undefined) {
        return json(res, 400, { ok: false, error: "nothing to update" });
      }
      // Both updates are email-scoped, so zero changes means the session is not
      // this account's. Reporting ok:true there contradicted DELETE, which 404s
      // for exactly the same case.
      if (!out.titleUpdated && !out.cwdUpdated) {
        return json(res, 404, { ok: false, error: "not found" });
      }
      return json(res, 200, out);
    }
  }

  return json(res, 404, { ok: false, error: "route not found" });
}


// The only WebSocket the tunnel can reach: end-to-end sessions. The old /ws
// (chat) and /pty endpoints with bearer tokens are gone; chat runs as a
// channel inside the session.
const e2e = createE2eEndpoint({
  host: () => PAIR_PUBLIC_HOST,
  identity: IDENTITY,
  version: BRIDGE_VERSION,
  devices: {
    get: (pubkey) => getE2eDevice(pubkey),
    add: (rec) => addE2eDevice(rec),
    touch: (pubkey) => touchE2eDevice(pubkey),
  },
  handleHttp: (req, res, auth) => handleApi(req, res, new URL(req.url, "http://localhost"), auth),
  handleChat: (ws, sid) => {
    // Same gates the old upgrade handler applied before handleSocket().
    const owner = sessionOwner(sid);
    if (owner && owner !== ws.auth.email) {
      log("warn", "chat_foreign_sid", { device: ws.auth.deviceId });
      return false;
    }
    if (runtime.size >= MAX_RUNTIME_SESSIONS && !runtime.has(sid)) {
      log("warn", "chat_runtime_full", { size: runtime.size });
      return false;
    }
    handleSocket(ws);
    return true;
  },
  log,
});

server.on("upgrade", (req, socket, head) => {
  try {
    const u = new URL(req.url, "http://localhost");
    if (!hostAllowed(req)) {
      socket.write("HTTP/1.1 421 Misdirected Request\r\n\r\n"); socket.destroy(); return;
    }
    if (u.pathname === "/e2e" && !PAIR_PUBLIC_HOST) {
      // The session is bound to the tunnel host; without it there is nothing
      // to bind to.
      log("error", "e2e_no_public_host", {});
      socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n"); socket.destroy(); return;
    }
    if (u.pathname === "/e2e") return e2e.handleUpgrade(req, socket, head);
    socket.write("HTTP/1.1 426 Upgrade Required\r\n\r\n"); socket.destroy();
  } catch (e) {
    log("error", "upgrade_failed", { err: String(e) });
    try { socket.destroy(); } catch {}
  }
});


// V2.2: subscriber-based session model.
//
// - One in-flight Claude run per sid (rt.inflight), spawned by a `prompt` frame.
// - rt.subscribers is a Set<WebSocket> — every WS that has authenticated for sid
//   receives every chunk/heartbeat/usage/done. WS close just removes the
//   subscriber; the child keeps running.
// - {type:"attach"} from a WS replays the in-flight state (content so far +
//   done flag) so a mobile reconnect can pick up the answer mid-stream without
//   resending the prompt or killing the child.
// - Orphan grace is 30 min (vs 60s in V2.1) so the user can come back after a
//   train tunnel / app backgrounding / network handoff and still see the
//   answer, instead of finding a SIGTERM'd truncation.

function ensureRt(sid) {
  let rt = runtime.get(sid);
  if (!rt) {
    rt = {
      sid,
      claudeSessionId: null,
      agyConversationId: null,
      codexThreadId: null,
      engine: null,
      model: null,
      lastUsed: Date.now(),
      subscribers: new Set(),
      inflight: null,         // { assistantId, content, done, child, ... }
      promptQueue: [],        // pending {content, userMessageId, assistantId, sess, engine, model} while inflight runs
      orphanKillTimer: null,
      inflightClearTimer: null,
      usageSessionId: null,
      lastCumUsage: null,
    };
    runtime.set(sid, rt);
  } else {
    rt.subscribers ||= new Set();
    rt.promptQueue ||= [];
  }
  return rt;
}

// Pull the next queued prompt (if any) and start it as the new inflight. Called
// after a turn wraps up (done or error) so a user who pinged during a running
// turn gets their follow-up answered without having to resend it.
function maybeFlushQueue(rt) {
  if (!rt.promptQueue || rt.promptQueue.length === 0) return;
  // Check capacity BEFORE shifting. Previously the item was removed, announced
  // as started and then dropped on the floor by the capacity check inside
  // spawnInflight — the user's message stayed in history with a permanently
  // empty answer. Leave it queued and try again shortly instead.
  if (activeTurnCount() >= MAX_CONCURRENT_TURNS) {
    if (!rt.queueRetryTimer) {
      rt.queueRetryTimer = setTimeout(() => {
        rt.queueRetryTimer = null;
        maybeFlushQueue(rt);
      }, 2000);
      rt.queueRetryTimer.unref?.();
    }
    log("info", "queue_flush_deferred", { sid: rt.sid, queued: rt.promptQueue.length });
    return;
  }
  const next = rt.promptQueue.shift();
  if (rt.inflightClearTimer) { clearTimeout(rt.inflightClearTimer); rt.inflightClearTimer = null; }
  rt.inflight = null;
  rt.lastUsed = Date.now();
  broadcast(rt, {
    type: "started",
    userMessageId: next.userMessageId,
    assistantMessageId: next.assistantId,
    queueLength: rt.promptQueue.length,
  });
  log("info", "queue_flush_start", { sid: rt.sid, remaining: rt.promptQueue.length });
  spawnInflight(rt, next.sess, next.content, next.assistantId, next.userMessageId, next.engine, next.model);
}

function broadcast(rt, obj) {
  const data = JSON.stringify(obj);
  for (const sub of rt.subscribers || []) {
    try { sub.send(data); } catch {}
  }
}

/**
 * SIGTERM, then SIGKILL if the process is still there. Every kill path used to
 * send SIGTERM only — a claude wedged in an uninterruptible tool call would
 * ignore it, never emit `close`, and keep both the process and the session's
 * inflight record alive forever.
 */
/**
 * SIGTERM, then SIGKILL if the process is still there.
 *
 * MEASURED, because the obvious "kill the whole process group" upgrade is a
 * trap here. claude does not run tool commands in its own process group — each
 * one gets its own (observed: claude pgid 84101, its `sleep` grandchild pgid
 * 84674) — so a group kill would not reach them anyway. And when a turn is
 * stopped, claude tears its foreground tool processes down itself; a
 * long-running `sleep` started by the Bash tool was gone within seconds of a
 * stop, with no help from us. What genuinely survives is a process the user
 * deliberately detached (`nohup … &`, reparented to init) — which is what
 * "nohup" means and not ours to kill.
 *
 * Spawning children `detached` to make a group kill possible would also take
 * them out of the bridge's process group, so a launchd restart would no longer
 * signal them as a group. That trades a real safety net for a theoretical one.
 */
/**
 * Arm the absolute turn ceiling, if one is configured. Independent of the stall
 * watchdog, which only reacts to silence.
 */
function armTurnDeadline(rt, inflight, stop) {
  if (!MAX_TURN_MS) return;
  inflight.deadlineTimer = setTimeout(() => {
    if (rt.inflight !== inflight || inflight.done) return;
    inflight.abortedByStall = true;   // reported as an abort, not a clean done
    inflight.errorMsg = `Turn nach ${Math.round(MAX_TURN_MS / 60000)} min hartem Limit abgebrochen.`;
    log("warn", "turn_deadline_exceeded", { sid: rt.sid, ms: MAX_TURN_MS });
    broadcast(rt, { type: "error", message: inflight.errorMsg, assistantMessageId: inflight.assistantId });
    try { stop(); } catch {}
  }, MAX_TURN_MS);
  inflight.deadlineTimer.unref?.();
}

function killChildHard(child, label) {
  if (!child) return;
  try { child.kill("SIGTERM"); } catch {}
  const t = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      log("warn", "child_sigkill", { label });
      try { child.kill("SIGKILL"); } catch {}
    }
  }, 5000);
  t.unref?.();
}

function killInflight(rt, reason) {
  // User pressed stop → also drop everything they had queued up. A new prompt
  // arriving mid-turn (reason: "stale_on_new_prompt") must NOT clear the queue —
  // that stale kill happens to make room for a fresh turn, not to abandon work.
  if (reason === "client_stop" && rt.promptQueue?.length) {
    log("info", "queue_cleared_on_stop", { sid: rt.sid, count: rt.promptQueue.length });
    rt.promptQueue = [];
    broadcast(rt, { type: "queue_cleared" });
  }
  const inf = rt.inflight;
  if (!inf || inf.done) return;
  if (inf.proc) {
    // Mark it, like the stall path does. Without a flag the close handler maps
    // SIGTERM onto the `done` branch, so a turn the user cancelled came back as
    // a completed answer with whatever text had arrived so far.
    inf.abortedByStop = reason;
    // Kindprozess: eskalierendes Signal. HTTP: AbortController. Welches davon,
    // entscheidet das Transport-Handle — hier steht nur noch „abbrechen".
    inf.proc.stop(`killInflight:${reason}`);
  } else if (inf.warm && warmPool) {
    // Mark BOTH: stopRequested suppresses the one-shot retry, abortedByStop
    // makes the turn report as aborted. The first version of this fix only
    // covered the one-shot path, so on the warm path — the normal one — a
    // cancelled turn still came back as a finished answer.
    inf.stopRequested = true;
    inf.abortedByStop = reason;
    warmPool.stop(rt.sid);
  } else {
    return;
  }
  log("warn", "child_killed", { sid: rt.sid, reason });
}

// A short, privacy-safe one-liner describing what a tool call is doing, for the
// activity panel. We pick the single most descriptive input field and truncate
// hard — never forward whole tool inputs (they can be large or sensitive).
// Full command + output behind each audit row, so an old transcript can show
// what a step actually ran and what came back. Tool output is unbounded by
// nature — a `ls -R`, a build log, a 5000-line file read — so both are capped
// on write and the true size is recorded alongside.
//
// CONDUIT_AUDIT_DETAIL=0 turns the capture off. This is the one part of the
// trail the bridge does not need in order to work, and it is also the part most
// likely to contain whatever a tool happened to print — including secrets.
const AUDIT_DETAIL     = process.env.CONDUIT_AUDIT_DETAIL !== "0";
const AUDIT_INPUT_CAP  = intEnv("CONDUIT_AUDIT_INPUT_CAP", 4_000, 0, 200_000);
const AUDIT_OUTPUT_CAP = intEnv("CONDUIT_AUDIT_OUTPUT_CAP", 6_000, 0, 200_000);

/** The tool's arguments as the user would recognise them: the bare command or
 *  path when there is one obvious argument, the whole object otherwise. */
function toolInputText(input) {
  if (input == null) return "";
  if (typeof input === "string") return input;
  if (typeof input !== "object") return String(input);
  const single = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.query ?? input.url;
  if (typeof single === "string" && Object.keys(input).length <= 2) return single;
  try { return JSON.stringify(input, null, 2); } catch { return ""; }
}

/** A tool_result's content is either a plain string or an array of typed
 *  blocks; only the text ones carry anything a human can read. */
function toolResultText(block) {
  const c = block?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .map((p) => (typeof p === "string" ? p : p?.type === "text" ? String(p.text ?? "") : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/** Cap for storage, but report the size the caller actually produced so the UI
 *  can say how much was left out. */
function capForAudit(s, cap) {
  if (!s) return { text: null, bytes: 0 };
  const bytes = Buffer.byteLength(s, "utf8");
  if (!cap) return { text: null, bytes };
  return { text: s.length > cap ? s.slice(0, cap) : s, bytes };
}

function toolSummary(input) {
  if (!input || typeof input !== "object") return "";
  const s = (v) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  const k = input.command ?? input.file_path ?? input.path ?? input.pattern
    ?? input.query ?? input.url ?? input.description ?? input.prompt;
  return k != null ? s(k) : "";
}

// Structured step for the activity panel. Since tool calls no longer appear in
// the answer text, this is now the ONLY record of what a turn did — the client
// builds its collapsed "what happened" summary from these.
function emitActivityStart(rt, inflight, block) {
  const summary = toolSummary(block?.input);
  const id = block?.id || null;
  if (id) {
    inflight.activeTools = inflight.activeTools || new Map();
    inflight.activeTools.set(id, { name: block?.name || "tool", summary, startedAt: Date.now() });
  }
  const input = AUDIT_DETAIL ? capForAudit(toolInputText(block?.input), AUDIT_INPUT_CAP).text : null;
  // Recorded BEFORE the broadcast: the row id is what a client needs to ask for
  // this step's detail, and a live step should be as inspectable as a stored one.
  const stepId = recordAuditStart(rt.sid, inflight.assistantId, block?.id, block?.name || "tool", summary, input);
  broadcast(rt, {
    type: "activity", phase: "start",
    assistantMessageId: inflight.assistantId,
    id,
    stepId,
    tool: block?.name || "tool",
    summary,
  });
}
function emitActivityEnd(rt, inflight, block) {
  const id = block?.tool_use_id || null;
  const startedAt = id && inflight.activeTools ? inflight.activeTools.get(id)?.startedAt : null;
  const durationMs = startedAt ? Date.now() - startedAt : null;
  if (id && inflight.activeTools) inflight.activeTools.delete(id);
  const out = AUDIT_DETAIL ? capForAudit(toolResultText(block), AUDIT_OUTPUT_CAP) : { text: null, bytes: 0 };
  broadcast(rt, {
    type: "activity", phase: "end",
    assistantMessageId: inflight.assistantId,
    id,
    ok: !block?.is_error,
    durationMs,
  });
  recordAuditEnd(rt.sid, block?.tool_use_id, !block?.is_error, out.text, out.bytes, durationMs);
}

// Delta/snapshot guard: Claude CLI can emit either real deltas or cumulative
// snapshots depending on flags/mode. If the incoming text starts with what we
// already have, treat it as a snapshot and only emit the tail. Also assigns a
// monotonic seq so the client can dedupe replayed frames.
function emitChunk(rt, inflight, text) {
  if (!text) return;
  let delta = text;
  if (inflight.content && delta.startsWith(inflight.content)) {
    delta = delta.slice(inflight.content.length);
  }
  if (!delta) return;
  inflight.content += delta;
  inflight.seq = (inflight.seq || 0) + 1;
  broadcast(rt, {
    type: "chunk",
    text: delta,
    seq: inflight.seq,
    assistantMessageId: inflight.assistantId,
  });
  try { appendAssistant(inflight.assistantId, delta, rt.sid); } catch {}
}

// Tool calls are NOT written into the answer text. A turn that greps its way
// through a repo produces dozens of them, and splicing each one into the
// transcript buried the actual answer under a wall of half-truncated shell
// commands — a third of a typical message was marker lines the reader has to
// scroll past. The `activity` event already carries the same information
// (tool, target, duration, outcome) as structured data, which is what the
// client renders as a collapsed step summary. The answer stays the answer.

// "Stockt seit 3496s" without context is useless. Ship the turn id, the seq
// (so the client can tell whether it is missing frames vs the model is just
// thinking), what tools are currently running and for how long, and whether
// the child is still alive. The client can then say "Bash läuft seit 3 min:
// npm test" instead of a naked stall banner.
function buildHeartbeat(inflight, silentMs, warm) {
  const now = Date.now();
  const tools = [];
  if (inflight.activeTools) {
    for (const [id, t] of inflight.activeTools) {
      tools.push({ id, name: t.name, summary: t.summary, elapsedMs: now - t.startedAt });
    }
  }
  // Ob der Turn noch lebt, weiß der Transport — beim Kindprozess der Exit-Code,
  // beim HTTP-Weg die noch offene Antwort.
  const alive = warm ? true : !!inflight.proc?.isAlive();
  return {
    type: "heartbeat",
    assistantMessageId: inflight.assistantId,
    seq: inflight.seq || 0,
    silentMs,
    turnElapsedMs: now - (inflight.startedAt || now),
    alive,
    phase: tools.length ? "tool_running" : "waiting_for_model",
    activeTools: tools,
    charsStreamed: inflight.content.length,
  };
}

/**
 * Mark a turn that reported an error inside the stream. The CLI can deliver a
 * failure as a `result` event and still exit 0, and the close handler maps exit
 * 0 to `done` — so the client saw the error and then a success frame for the
 * same turn.
 */
function markStreamError(rt, inflight, msg) {
  inflight.errorMsg = inflight.errorMsg || msg || "claude meldete einen Fehler";
  try { setMessageStatus(rt.sid, inflight.assistantId, "error"); } catch {}
}

/**
 * Den Fortsetzungs-Bezeichner der Engine merken.
 *
 * Welches Feld das ist und wohin es geschrieben wird, steht im
 * Registry-Eintrag — hier steht nur noch, dass es passiert.
 */
function rememberConversation(engine, rt, id) {
  const c = engine.conversation;
  // Eine neue CLI-Session zählt Usage und Kosten wieder ab 0. Der alte
  // kumulative Snapshot muss deshalb weg, sonst fällt der nächste Delta-Wert
  // negativ aus und wird als voller Betrag ein zweites Mal gebucht.
  if (c.resetUsageOnChange && rt.usageSessionId !== id) {
    rt.usageSessionId = id;
    rt.lastCumUsage = null;
  }
  rt[c.rtField] = id;
  try { c.persist(rt.sid, id); } catch {}
}

/**
 * Die Gegenstelle zu engine.readEvent: alles, was ein gelesenes Event im Turn
 * auslöst. Die Registry kennt dadurch weder Broadcasts noch das
 * inflight-Objekt und muss für eine weitere Engine nur ihr eigenes
 * Ausgabeformat auf diese Handvoll Aufrufe abbilden.
 */
function makeStreamSink(engine, rt, inflight) {
  return {
    hasContent: () => !!inflight.content,
    onConversationId: (id) => rememberConversation(engine, rt, id),
    onChunk: (text) => emitChunk(rt, inflight, text),
    onToolStart: (block) => emitActivityStart(rt, inflight, block),
    onToolEnd: (block) => emitActivityEnd(rt, inflight, block),
    onError: (msg) => {
      markStreamError(rt, inflight, msg);
      broadcast(rt, { type: "error", message: msg, assistantMessageId: inflight.assistantId });
    },
    onUsage: (ev) => applyResultUsage(rt, ev, engine),
  };
}

function handleStreamLine(line, rt, inflight, engine) {
  let ev;
  try { ev = JSON.parse(line); } catch { return; }
  engine.readEvent(ev, inflight.streamSink);
}

// `result` reports usage/cost CUMULATIVELY for the whole CLI session (kept alive
// via --resume or a warm process), not per-turn. Subtract the last cumulative
// snapshot so addUsage (which does `+= ?`) records only this turn's delta —
// otherwise turn N re-adds the full running total → ~N²/2 over-count.
//
// Nicht jede Engine zählt so. Ein zustandsloser HTTP-Dienst kennt gar keine
// Sitzung und liefert die Zahlen für genau diese eine Anfrage; die wären nach
// der Subtraktion ab Turn 2 zu klein. Welche Zählweise gilt, sagt der
// Registry-Eintrag (usageCumulative).
function applyResultUsage(rt, ev, engine = null) {
  if (!ev.usage) return;
  const cum = {
    tokens_in:    Number(ev.usage.input_tokens)                || 0,
    tokens_out:   Number(ev.usage.output_tokens)               || 0,
    cache_read:   Number(ev.usage.cache_read_input_tokens)     || 0,
    cache_create: Number(ev.usage.cache_creation_input_tokens) || 0,
    cost_usd:     Number(ev.total_cost_usd)                    || 0,
  };
  if (engine && engine.usageCumulative === false) {
    // Schon der Delta-Wert. rt.lastCumUsage bleibt unangetastet: dort steht der
    // Stand der kumulativ zählenden Engine dieser Session, und den darf ein
    // Turn einer anderen Engine nicht überschreiben.
    try { addUsage(rt.sid, cum); } catch {}
    broadcast(rt, { type: "usage", delta: cum, durationMs: ev.duration_ms || 0 });
    return;
  }
  const prev = rt.lastCumUsage || { tokens_in: 0, tokens_out: 0, cache_read: 0, cache_create: 0, cost_usd: 0 };
  // Never emit a negative delta (a fresh CLI session reports smaller totals).
  const sub = (key) => {
    const d = cum[key] - prev[key];
    return d >= 0 ? d : cum[key];
  };
  const delta = {
    tokens_in:    sub("tokens_in"),
    tokens_out:   sub("tokens_out"),
    cache_read:   sub("cache_read"),
    cache_create: sub("cache_create"),
    cost_usd:     sub("cost_usd"),
  };
  rt.lastCumUsage = cum;
  try { addUsage(rt.sid, delta); } catch {}
  broadcast(rt, { type: "usage", delta, durationMs: ev.duration_ms || 0 });
}

// Global ceiling on turns running at once, across every session and both the
// warm and one-shot paths. WARM_MAX alone was not a ceiling: a saturated pool
// falls back to one-shot spawns, so N sessions each holding a long turn open
// meant N concurrent `claude` processes (plus their MCP servers and tool
// subprocesses) with nothing to stop them.
const MAX_CONCURRENT_TURNS = intEnv("CONDUIT_MAX_CONCURRENT_TURNS", Math.max(4, WARM_MAX * 2), 1, 1000);

function activeTurnCount() {
  let n = 0;
  for (const r of runtime.values()) {
    if (r.inflight && !r.inflight.done) n++;
  }
  return n;
}

function spawnInflight(rt, sess, prompt, assistantId, userMessageId = null, engine = null, model = null) {
  // rt.inflight is set by the callers only *inside* the spawn functions, so at
  // this point this turn is not yet counted — hence >= against the ceiling.
  if (activeTurnCount() >= MAX_CONCURRENT_TURNS) {
    log("warn", "turn_rejected_at_capacity", { sid: rt.sid, active: MAX_CONCURRENT_TURNS });
    broadcast(rt, {
      type: "error",
      message: "Zu viele Läufe gleichzeitig — bitte kurz warten und erneut senden.",
      assistantMessageId: assistantId,
    });
    return;
  }
  // Kennung → Registry-Eintrag. Ein unbekannter Wert (alter Client, alte
  // Session-Zeile) landet auf der Standard-Engine, statt den Turn scheitern zu
  // lassen; das war vor der Registry der Sinn des `else`-Zweigs der if-Kette.
  const engineDef = resolveEngine(engine || rt.engine || sess.engine || DEFAULT_ENGINE_ID);
  // Der Warm-Pool ist eine Eigenschaft der Engine, keine Eigenschaft des
  // Turns: nur eine CLI, die einen langlebigen Prozess mit stream-json-Eingabe
  // beherrscht, kann darüber laufen. Ist er abgeschaltet (CONDUIT_WARM=0),
  // nimmt auch sie den Ein-Turn-Prozess-Pfad.
  if (engineDef.usesWarmPool && warmPool) {
    return spawnInflightWarm(rt, sess, prompt, assistantId, userMessageId);
  }
  return runInflightTurn(engineDef, rt, sess, prompt, assistantId, userMessageId, model || rt.model || sess.model);
}

// V3.0: stream the turn through the warm process pool (token-by-token, no boot).
// On an early failure it transparently falls back to a one-shot spawn so the
// user always gets an answer even if the warm path misbehaves.
function spawnInflightWarm(rt, sess, prompt, assistantId, userMessageId = null) {
  const spawnCwd = (sess.cwd && isValidCwd(sess.cwd)) ? sess.cwd : CWD;

  const inflight = {
    assistantId, userMessageId, content: "", done: false, errorMsg: null,
    proc: null,             // warm: the pool owns the long-lived process
    warm: true, stopRequested: false, fellBack: false,
    lastOutputAt: Date.now(),
    startedAt: Date.now(),
    seq: 0,
    activeTools: new Map(),
    stallTimer: null, heartbeatTimer: null,
  };
  rt.inflight = inflight;
  if (rt.inflightClearTimer) { clearTimeout(rt.inflightClearTimer); rt.inflightClearTimer = null; }

  const clearTimers = () => {
    if (inflight.deadlineTimer) { clearTimeout(inflight.deadlineTimer); inflight.deadlineTimer = null; }
    if (inflight.stallTimer) { clearTimeout(inflight.stallTimer); inflight.stallTimer = null; }
    if (inflight.heartbeatTimer) { clearInterval(inflight.heartbeatTimer); inflight.heartbeatTimer = null; }
  };
  const finishTurn = (errorMsg) => {
    if (inflight.done) return;
    // A warm turn that ends cleanly with zero assistant content is NOT a
    // success: the DB row stays empty, the client renders a blank bubble, and
    // subsequent prompts to the same session repeat the pattern. Seen when a
    // WS disconnect races the spawn (mobile handoff) and the warm child exits
    // clean without ever emitting a text block. Retry once through the one-shot
    // path — that gives the user a real answer instead of a silent dead card.
    // `fellBack` guards against a double-fallback loop (the onError path below
    // already sets it for the empty-error case).
    if (!errorMsg && inflight.content === "" && !inflight.fellBack
        && !inflight.stopRequested && rt.inflight === inflight) {
      inflight.fellBack = true;
      clearTimers();
      log("warn", "warm_empty_turn_fallback", { sid: rt.sid });
      rt.inflight = null;
      runInflightTurn(CLAUDE_ENGINE, rt, sess, prompt, assistantId, userMessageId);
      return;
    }
    clearTimers();
    inflight.done = true;
    // If we somehow still end up here with an empty content and no error, do
    // NOT persist 'ok' — that is exactly the leere-Bubble bug. Convert it to
    // a visible error so the client shows a retry state, not a dead card.
    const finalError = errorMsg || (inflight.content === "" && !inflight.stopRequested
      ? CLAUDE_ENGINE.messages.emptyTurn
      : null);
    try { setMessageStatus(rt.sid, inflight.assistantId, finalError ? "error" : "ok"); } catch {}
    // If this inflight was already replaced by a newer turn (it was killed as a
    // dead-on-new-prompt and its warm process only exited afterwards), its late
    // done/error must NOT be broadcast — the client would apply that terminal
    // frame to whatever turn is live now and truncate it mid-answer. Just clean
    // up quietly and leave the current turn (and its queue) untouched.
    if (rt.inflight !== inflight) {
      inflight.errorMsg = finalError || null;
      log("info", "claude_done", { sid: rt.sid, warm: true, err: !!finalError, superseded: true });
      return;
    }
    if (finalError) {
      inflight.errorMsg = finalError;
      broadcast(rt, { type: "error", message: finalError, assistantMessageId: inflight.assistantId });
    } else {
      broadcast(rt, { type: "done", assistantMessageId: inflight.assistantId });
    }
    log("info", "claude_done", { sid: rt.sid, warm: true, err: !!finalError });
    if (rt.inflightClearTimer) clearTimeout(rt.inflightClearTimer);
    rt.inflightClearTimer = setTimeout(() => {
      rt.inflightClearTimer = null;
      if (rt.inflight === inflight) rt.inflight = null;
    }, INFLIGHT_DONE_TTL_MS);
    rt.inflightClearTimer.unref?.();
    maybeFlushQueue(rt);
  };

  armTurnDeadline(rt, inflight, () => warmPool.stop(rt.sid));
  const armStall = () => {
    inflight.lastOutputAt = Date.now();
    if (inflight.stallTimer) clearTimeout(inflight.stallTimer);
    inflight.stallTimer = setTimeout(() => {
      // Superseded turns must NOT act. warmPool.stop() is keyed by sid, so a
      // stale timer belonging to a replaced turn would kill the process the
      // *current* turn is streaming through — cutting a healthy answer in half
      // up to 10 minutes after the fact.
      if (rt.inflight !== inflight) return;
      if (!inflight.done) {
        warmPool.stop(rt.sid);
        log("warn", "child_killed", { sid: rt.sid, reason: "stall", warm: true });
        finishTurn(CLAUDE_ENGINE.messages.stall);
      }
    }, CHILD_STALL_MS);
    inflight.stallTimer.unref?.();
  };
  inflight.heartbeatTimer = setInterval(() => {
    if (inflight.done) return;
    const silentMs = Date.now() - inflight.lastOutputAt;
    if (silentMs >= CHILD_HEARTBEAT_MIN_SILENCE_MS) {
      broadcast(rt, buildHeartbeat(inflight, silentMs, /*warm*/ true));
    }
  }, CHILD_HEARTBEAT_MS);
  inflight.heartbeatTimer.unref?.();
  armStall();

  log("info", "spawn_claude", { sid: rt.sid, hasResume: !!rt.claudeSessionId, len: prompt.length, warm: true });

  warmPool.runTurn({
    sid: rt.sid, sess, cwd: spawnCwd, prompt,
    handlers: {
      onSessionId: (id) => rememberConversation(CLAUDE_ENGINE, rt, id),
      onChunk: (text) => {
        armStall();
        emitChunk(rt, inflight, text);
      },
      onToolUse: (block) => {
        armStall();
        emitActivityStart(rt, inflight, block);
      },
      onToolResult: (block) => { armStall(); emitActivityEnd(rt, inflight, block); },
      onUsageEvent: (ev) => { armStall(); applyResultUsage(rt, ev); },
      onDone: () => finishTurn(null),
      onError: (msg, info) => {
        if (inflight.stopRequested) {
          finishTurn(inflight.abortedByStop === "client_stop"
            ? "Abgebrochen — die Antwort ist unvollständig."
            : null);
          return;
        }
        // A stall is a *terminal* verdict from the pool watchdog, not an early
        // warm failure. Retrying it through the one-shot path re-ran a prompt
        // that had already been executing for 15 minutes — with
        // bypassPermissions, so any side effects happened a second time.
        if (info?.stall || info?.terminal) { finishTurn(msg); return; }
        // Warm turn died before producing any output → transparently retry once
        // via the one-shot path so the user still gets an answer.
        // The supersede guard belongs here too. Without it a late error from a
        // turn that was already replaced set rt.inflight = null — orphaning the
        // LIVE successor (invisible to stop, to the caps, to everything) — and
        // then re-ran the old prompt through the one-shot path, executing its
        // side effects a second time.
        if (rt.inflight !== inflight) { clearTimers(); return; }
        if (inflight.content === "" && !inflight.done && !inflight.fellBack) {
          inflight.fellBack = true;
          clearTimers();
          log("warn", "warm_fallback_oneshot", { sid: rt.sid, reason: String(msg).slice(0, 120) });
          rt.inflight = null;
          runInflightTurn(CLAUDE_ENGINE, rt, sess, prompt, assistantId, userMessageId);
          return;
        }
        finishTurn(msg);
      },
    },
  });
}

/**
 * Transport „spawn": der Turn läuft als eigener Prozess.
 *
 * Was ein Transport zu leisten hat, steht hier und in startHttpTransport —
 * Ausgabe zeilenweise nach oben geben, Ende melden, sich abbrechen lassen. Der
 * Lebenszyklus darunter (Timer, Heartbeat, Supersede-Schutz, DB, WS-Frames)
 * kennt nur noch dieses Handle und nicht mehr die Frage, ob dahinter ein
 * Kindprozess oder eine offene HTTP-Antwort steckt.
 */
function startChildTransport(engine, { cwd, args, hooks }) {
  const child = spawn(engine.bin, args, {
    cwd, env: { ...process.env, FORCE_COLOR: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  // See the Alexa path: decode across chunk boundaries, not per chunk.
  const decoder = new StringDecoder("utf8");
  let buf = "";

  child.stdout.on("data", (chunk) => {
    hooks.onActivity();
    buf += decoder.write(chunk);
    if (buf.length > MAX_BUF) buf = buf.slice(-MAX_BUF);
    let idx;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      hooks.onLine(line);
    }
  });
  child.stderr.on("data", (chunk) => hooks.onStderr(chunk.toString("utf8")));
  child.on("close", (code, signal) => {
    // Flush whatever the decoder still holds (a multi-byte sequence cut by the
    // final chunk) before handing over the trailing line, otherwise those bytes
    // are simply dropped.
    try { buf += decoder.end(); } catch {}
    const tail = buf.trim();
    buf = "";
    hooks.onClose(code, signal, tail);
  });
  child.on("error", (e) => hooks.onFailure(e.message));

  return {
    kind: "child",
    stop: (label) => killChildHard(child, label),
    // `child.killed` only reflects a signal *we* sent, so a crashed or
    // naturally exited child read as alive. exitCode/signalCode cover the real
    // exit.
    isAlive: () => child.exitCode === null && child.signalCode === null && !child.killed,
    isDead: () => child.killed || child.exitCode !== null || child.signalCode !== null,
  };
}

/**
 * Transport „http": der Turn läuft als offene Antwort eines fremden Dienstes.
 *
 * Es gibt hier kein Kind, das man mit einem Signal beenden könnte. Die Stelle,
 * an der sonst `kill` steht, bricht deshalb den AbortController ab — und meldet
 * das Ende als `signal: "SIGTERM"`, weil der Lebenszyklus genau daran einen
 * gewollten Abbruch von einem Absturz unterscheidet. Ohne diese Übersetzung
 * käme ein vom Nutzer gestoppter Turn unten als Fehlschlag an.
 */
function startHttpTransport(engine, { request, hooks }) {
  const ac = new AbortController();
  let finished = false;
  let aborted = false;
  const finish = (code, signal, tail = "") => {
    if (finished) return;
    finished = true;
    hooks.onClose(code, signal, tail);
  };

  (async () => {
    let res;
    try {
      res = await fetch(request.url, {
        method: request.method || "POST",
        headers: { "content-type": "application/json", ...(request.headers || {}) },
        body: JSON.stringify(request.body),
        signal: ac.signal,
      });
    } catch (e) {
      if (aborted) { finish(null, "SIGTERM"); return; }
      // Dienst nicht erreichbar, bevor überhaupt etwas lief — das ist der
      // gleiche Fall wie ein Binary, das sich nicht starten ließ.
      finished = true;
      hooks.onFailure(String(e?.message || e));
      return;
    }
    if (!res.ok) {
      let detail = "";
      try { detail = (await res.text()).slice(0, 600); } catch {}
      hooks.onStderr(detail || res.statusText || "");
      finish(res.status || 1, null);
      return;
    }

    const decoder = new StringDecoder("utf8");
    let buf = "";
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        hooks.onActivity();
        buf += decoder.write(value);
        if (buf.length > MAX_BUF) buf = buf.slice(-MAX_BUF);
        let idx;
        while ((idx = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          hooks.onLine(line);
        }
      }
    } catch (e) {
      try { buf += decoder.end(); } catch {}
      // Ein Abbruch mitten im Lesen ist kein Fehler, sondern das Ergebnis von
      // stop() — und muss als SIGTERM ankommen, sonst meldet der Client einen
      // gestoppten Turn als abgestürzt.
      if (aborted) { finish(null, "SIGTERM", buf.trim()); return; }
      hooks.onStderr(String(e?.message || e));
      finish(1, null, buf.trim());
      return;
    }
    try { buf += decoder.end(); } catch {}
    finish(0, null, buf.trim());
  })();

  return {
    kind: "http",
    stop: (label) => {
      aborted = true;
      log("warn", "http_turn_aborted", { engine: engine.id, label });
      try { ac.abort(); } catch {}
    },
    isAlive: () => !finished,
    isDead: () => finished,
  };
}

/**
 * Ein Turn: starten, Ausgabe lesen, Ende bewerten.
 *
 * Der Ablauf ist für jede Engine derselbe — Stall-Watchdog, Heartbeat,
 * Supersede-Schutz, Weitergabe an die Queue und die Frage, ob ein Turn
 * überhaupt sauber zu Ende ging. Was sich unterscheidet, holt die Funktion aus
 * dem Registry-Eintrag: Binary bzw. Endpunkt, Argumente bzw. Anfragekörper,
 * Modellname, Fortsetzungs-Id, Stream-Format und die Texte, die der Nutzer im
 * Fehlerfall liest. Vorher stand dieser Ablauf zweimal in der Datei, einmal je
 * Engine — mit dem Ergebnis, dass jede Korrektur am Lebenszyklus zweimal
 * gemacht werden musste und beim zweiten Mal gelegentlich vergessen wurde.
 *
 * Die einzige Verzweigung nach Transport steht ganz oben beim Start. Ab dem
 * Handle ist der Rest wieder für alle gleich — auch für eine Engine, die gar
 * keinen Prozess hat.
 */
function runInflightTurn(engine, rt, sess, prompt, assistantId, userMessageId = null, model = null) {
  const targetModel = engine.resolveModel(model || rt.model || sess.model);
  const resumeId = engine.conversation.read(rt, sess) || null;
  // Eine Fortsetzungs-Id, die bisher nur in der Session-Zeile stand, gehört ab
  // jetzt auch ins Runtime-Objekt — sonst sucht der nächste Turn sie dort
  // vergeblich und fängt die Unterhaltung von vorn an.
  if (resumeId) rt[engine.conversation.rtField] = resumeId;
  const finalPrompt = engine.preparePrompt({ prompt, sid: rt.sid, email: sess?.user_email, userMessageId, resumeId });

  // `len` misst den Prompt des Nutzers, nicht den womöglich um den bisherigen
  // Verlauf erweiterten Text: die Zahl im Log soll das sein, was er abgeschickt hat.
  log("info", engine.logs.spawn, { sid: rt.sid, ...engine.spawnMeta({ resumeId, model: targetModel }), len: prompt.length });

  const inflight = {
    assistantId,
    userMessageId,
    content: "",        // full assistant content accumulated for resume
    done: false,
    errorMsg: null,
    // Das Transport-Handle: was den Turn am Leben hält. Hieß früher `child`
    // und war immer ein Kindprozess — seit es Engines ohne Prozess gibt, wäre
    // dieser Name eine Lüge, und ein zweites Feld daneben nur eine zweite
    // Wahrheit, die irgendwann jemand falsch abfragt.
    proc: null,
    stderrBuf: "",
    lastOutputAt: Date.now(),
    startedAt: Date.now(),
    seq: 0,
    activeTools: new Map(),
    stallTimer: null,
    heartbeatTimer: null,
    engine: engine.id,
  };
  // Einmal pro Turn gebaut, nicht pro gelesener Zeile: ein Agent-Lauf schickt
  // tausende Events durch diesen Pfad.
  inflight.streamSink = makeStreamSink(engine, rt, inflight);

  const armStall = () => {
    inflight.lastOutputAt = Date.now();
    if (inflight.stallTimer) clearTimeout(inflight.stallTimer);
    inflight.stallTimer = setTimeout(() => {
      if (inflight.proc && !inflight.done) {
        // Mark it: the close handler maps signal === "SIGTERM" to a clean
        // `done`, so an aborted, truncated turn was reported to the client as a
        // finished answer.
        inflight.abortedByStall = true;
        broadcast(rt, { type: "error", message: engine.messages.stall, assistantMessageId: inflight.assistantId });
        inflight.proc.stop("stall");
        log("warn", "child_killed", { sid: rt.sid, reason: "stall", ...engine.killMeta });
      }
    }, CHILD_STALL_MS);
    inflight.stallTimer.unref?.();
  };

  const hooks = {
    onActivity: () => armStall(),
    onLine: (line) => handleStreamLine(line, rt, inflight, engine),
    onStderr: (text) => {
      inflight.stderrBuf += text;
      if (inflight.stderrBuf.length > 4000) inflight.stderrBuf = inflight.stderrBuf.slice(-4000);
    },
    onClose: (code, signal, tail) => {
      if (inflight.stallTimer) { clearTimeout(inflight.stallTimer); inflight.stallTimer = null; }
      if (inflight.heartbeatTimer) { clearInterval(inflight.heartbeatTimer); inflight.heartbeatTimer = null; }
      // Only flush if this turn is still the live one. Running it first meant a
      // superseded child's last partial line was broadcast into the middle of its
      // successor's answer — the very thing the guard below exists to prevent.
      if (rt.inflight === inflight && tail) handleStreamLine(tail, rt, inflight, engine);
      inflight.done = true;
      inflight.proc = null;
      // Superseded by a newer turn (killed as dead-on-new-prompt, exited late) →
      // swallow the terminal frame so it can't truncate the live turn.
      if (rt.inflight !== inflight) {
        log("info", engine.logs.done, { sid: rt.sid, code, signal, superseded: true });
        return;
      }
      // `error` and `close` both fire for a failed spawn. Whichever gets there
      // first owns the wrap-up; without this the client received an `error`
      // followed by a `done` and displayed the failed turn as successful.
      if (inflight.wrappedUp) {
        log("info", engine.logs.closeAfterWrapup, { sid: rt.sid, code, signal });
        return;
      }
      inflight.wrappedUp = true;
      // Same empty-turn guard as the warm path in finishTurn: a clean exit with
      // zero content is not a success. This is the LAST retry path (we may have
      // arrived here from the warm-fallback), so we don't retry again — we just
      // stop lying about the outcome and surface a visible error.
      const emptyOK = !inflight.abortedByStall && !inflight.abortedByStop
        && !inflight.errorMsg && (code === 0 || signal === "SIGTERM")
        && inflight.content === "";
      // Persist the verdict so a retry after a restart replays the truth rather
      // than reporting every stored answer as a clean success.
      try {
        setMessageStatus(rt.sid, inflight.assistantId,
          (inflight.abortedByStall || inflight.abortedByStop || inflight.errorMsg || (code !== 0 && signal !== "SIGTERM") || emptyOK) ? "error" : "ok");
      } catch {}
      if (inflight.abortedByStop) {
        inflight.errorMsg = inflight.errorMsg || "Abgebrochen — die Antwort ist unvollständig.";
        broadcast(rt, { type: "error", message: inflight.errorMsg, assistantMessageId: inflight.assistantId });
      } else if (inflight.abortedByStall) {
        // Killed by the stall watchdog: the answer is truncated. SIGTERM would
        // otherwise fall into the `done` branch below and the client would show
        // a half-written answer as complete.
        inflight.errorMsg = inflight.errorMsg || engine.messages.stallIncomplete;
        broadcast(rt, { type: "error", message: inflight.errorMsg, assistantMessageId: inflight.assistantId });
      } else if (inflight.errorMsg) {
        broadcast(rt, { type: "error", message: inflight.errorMsg, assistantMessageId: inflight.assistantId });
      } else if (code !== 0 && signal !== "SIGTERM") {
        inflight.errorMsg = engine.messages.exit(code, inflight.stderrBuf.trim().slice(0, 600) || "unbekannt");
        broadcast(rt, { type: "error", message: inflight.errorMsg, assistantMessageId: inflight.assistantId });
      } else if (emptyOK) {
        inflight.errorMsg = engine.messages.emptyTurn;
        log("warn", engine.logs.emptyTurn, { sid: rt.sid, code, signal });
        broadcast(rt, { type: "error", message: inflight.errorMsg, assistantMessageId: inflight.assistantId });
      } else {
        broadcast(rt, { type: "done", assistantMessageId: inflight.assistantId });
      }
      log("info", engine.logs.done, { sid: rt.sid, code, signal });
      // Keep the finished inflight around briefly so a slightly-late reconnect can
      // still attach and read the final content + done flag, instead of seeing
      // "idle" and having to refetch from the DB.
      if (rt.inflightClearTimer) clearTimeout(rt.inflightClearTimer);
      rt.inflightClearTimer = setTimeout(() => {
        rt.inflightClearTimer = null;
        if (rt.inflight === inflight) rt.inflight = null;
      }, INFLIGHT_DONE_TTL_MS);
      rt.inflightClearTimer.unref?.();
      maybeFlushQueue(rt);
    },
    onFailure: (msg) => {
      if (inflight.deadlineTimer) { clearTimeout(inflight.deadlineTimer); inflight.deadlineTimer = null; }
      if (inflight.stallTimer) { clearTimeout(inflight.stallTimer); inflight.stallTimer = null; }
      if (inflight.heartbeatTimer) { clearInterval(inflight.heartbeatTimer); inflight.heartbeatTimer = null; }
      if (inflight.wrappedUp) return;
      inflight.wrappedUp = true;
      inflight.errorMsg = engine.messages.procError(msg);
      try { setMessageStatus(rt.sid, inflight.assistantId, "error"); } catch {}
      broadcast(rt, { type: "error", message: inflight.errorMsg, assistantMessageId: inflight.assistantId });
      inflight.done = true;
      inflight.proc = null;
      if (rt.inflight !== inflight) return;
      // Same wrap-up as the close handler. Without it a spawn error (binary gone
      // mid-flight, EMFILE) leaves rt.inflight pinned forever and every queued
      // prompt stuck: nothing else clears the record or starts the next turn.
      if (rt.inflightClearTimer) clearTimeout(rt.inflightClearTimer);
      rt.inflightClearTimer = setTimeout(() => {
        rt.inflightClearTimer = null;
        if (rt.inflight === inflight) rt.inflight = null;
      }, INFLIGHT_DONE_TTL_MS);
      rt.inflightClearTimer.unref?.();
      maybeFlushQueue(rt);
    },
  };

  // Die eine Verzweigung nach Transport. Was danach kommt, ist für beide Wege
  // derselbe Code — deshalb steht sie hier und nicht in zwei Funktionen.
  const spawnCwd = (sess.cwd && isValidCwd(sess.cwd)) ? sess.cwd : CWD;
  let proc;
  try {
    if (engine.transport === "http") {
      const request = engine.buildRequest({
        prompt: finalPrompt,
        model: targetModel,
        resumeId,
        sid: rt.sid,
        email: sess?.user_email,
        userMessageId,
      });
      proc = startHttpTransport(engine, { request, hooks });
    } else {
      const args = engine.buildArgs({
        prompt: finalPrompt,
        model: targetModel,
        resumeId,
        // Nur eine UUID taugt als vorgegebene Session-Id; der PWA-Fallback erzeugt
        // im unsicheren Kontext ein "id-<ts>-<rand>", das die CLI zurückweist.
        sessionId: isUuid(rt.sid) ? rt.sid : null,
      });
      proc = startChildTransport(engine, { cwd: spawnCwd, args, hooks });
    }
  } catch (e) {
    // Without the wrap-up the queue would sit here forever: no inflight is ever
    // created, so nothing later calls maybeFlushQueue.
    broadcast(rt, { type: "error", message: engine.messages.spawnFailed(e.message), assistantMessageId: assistantId });
    rt.inflight = null;
    maybeFlushQueue(rt);
    return;
  }
  inflight.proc = proc;

  rt.inflight = inflight;
  if (rt.inflightClearTimer) { clearTimeout(rt.inflightClearTimer); rt.inflightClearTimer = null; }

  armTurnDeadline(rt, inflight, () => inflight.proc?.stop("turn_deadline"));
  inflight.heartbeatTimer = setInterval(() => {
    // A replaced turn kept beating, so the client showed "no answer for X
    // minutes" while its successor was streaming happily.
    if (rt.inflight !== inflight) { clearInterval(inflight.heartbeatTimer); inflight.heartbeatTimer = null; return; }
    if (!inflight.proc || inflight.done) return;
    const silentMs = Date.now() - inflight.lastOutputAt;
    if (silentMs >= CHILD_HEARTBEAT_MIN_SILENCE_MS) {
      broadcast(rt, buildHeartbeat(inflight, silentMs, /*warm*/ false));
    }
  }, CHILD_HEARTBEAT_MS);
  inflight.heartbeatTimer.unref?.();
  armStall();
}

/**
 * Ownership can only be *claimed* by the first prompt, so two sockets from
 * different accounts can both connect to a sid that does not exist yet and both
 * end up subscribed to the same runtime. Re-checking here closes the window:
 * once the session exists and belongs to someone else, this socket is done.
 */
function stillOwns(sid, email) {
  let owner = null;
  // Fail CLOSED. Treating a DB error as "sure, go ahead" means attach replays
  // another account's in-flight content and stop kills their turn — a
  // confidentiality decision, not an availability one, and DB errors are
  // exactly what an attacker can provoke with load.
  try { owner = sessionOwner(sid); } catch (e) {
    log("error", "ownership_check_failed", { sid, err: String(e?.message || e) });
    return false;
  }
  return !owner || owner === email;
}

/** Drop any subscriber that does not own the session (see stillOwns). */
function evictForeignSubscribers(rt, ownerEmail) {
  for (const sub of [...(rt.subscribers || [])]) {
    if (sub.auth?.email && sub.auth.email !== ownerEmail) {
      log("warn", "ws_evict_foreign_subscriber", { sid: rt.sid, email: sub.auth.email });
      rt.subscribers.delete(sub);
      try { sub.send(JSON.stringify({ type: "error", message: "Session conflict (belongs to a different account)." })); } catch {}
      try { sub.close(); } catch {}
    }
  }
}

function handleSocket(ws) {
  const sid = ws.auth.sid;
  const email = ws.auth.email;
  ws.isAlive = true;
  ws.lastTrafficAt = Date.now();

  const send = (obj) => { try { ws.send(JSON.stringify(obj)); } catch {} };
  const touchClient = () => { ws.lastTrafficAt = Date.now(); ws.isAlive = true; };

  ws.on("pong", touchClient);

  // Subscribe this WS to the session runtime so all broadcasts reach it.
  const rt = ensureRt(sid);
  rt.subscribers.add(ws);
  rt.lastUsed = Date.now();
  // A new subscriber means someone's back — cancel any pending orphan kill.
  // Only the owner counts: a stranger connecting to an unclaimed sid could
  // otherwise keep a child alive that nothing is watching.
  if (rt.orphanKillTimer && stillOwns(sid, email)) {
    clearTimeout(rt.orphanKillTimer);
    rt.orphanKillTimer = null;
  }

  // Detect client gone: if no ping/pong/message for ~75s, terminate this WS.
  const clientWatch = setInterval(() => {
    if (Date.now() - ws.lastTrafficAt > WS_PONG_TIMEOUT_MS) {
      log("warn", "ws_silent_client_terminate", { sid });
      try { ws.terminate(); } catch {}
    }
  }, 15_000);
  clientWatch.unref();

  // NOTE: the body is wrapped in try/catch (see the end of this handler). This
  // callback is async, so anything that throws inside it becomes an unhandled
  // promise rejection — which Node turns into a process exit by default, i.e.
  // one bad frame would kill the bridge for every session at once.
  ws.on("message", async (raw) => {
   try {
    touchClient();
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === "ping") {
      send({ type: "pong" });
      return;
    }

    if (msg.type === "attach" || msg.type === "stop") {
      if (!stillOwns(sid, email)) {
        log("warn", "ws_frame_foreign_sid", { sid, email, frame: msg.type });
        send({ type: "error", message: "Session conflict (belongs to a different account)." });
        try { ws.close(); } catch {}
        return;
      }
    }

    if (msg.type === "attach") {
      // Mobile reconnect / silent resume: replay current in-flight state.
      // Frontend uses this to pick up a streaming answer after a network drop
      // without resending the prompt. The `seq` lets the client tell whether
      // any `chunk` frames received before/after this replay are already
      // covered by `content` — dedupe by "chunk.seq > lastSeq" and treat
      // `content` as an authoritative replacement, not an append.
      const inf = rt.inflight;
      const queueLength = rt.promptQueue?.length || 0;
      if (inf) {
        send({
          type: "resumed",
          assistantMessageId: inf.assistantId,
          content: inf.content,
          seq: inf.seq || 0,
          done: inf.done,
          queueLength,
        });
        if (inf.done) {
          if (inf.errorMsg) send({ type: "error", message: inf.errorMsg, assistantMessageId: inf.assistantId });
          else send({ type: "done", assistantMessageId: inf.assistantId });
        }
      } else {
        send({ type: "idle", queueLength });
      }
      return;
    }

    if (msg.type === "stop") {
      killInflight(rt, "client_stop");
      return;
    }

    if (msg.type === "prompt" && typeof msg.content === "string") {
      // Measure bytes, not UTF-16 units: the limit exists because the prompt
      // becomes an argv entry and a DB row, and emoji or CJK text is several
      // bytes per unit.
      // Every rejection of a prompt frame carries the assistantMessageId it was
      // rejecting. The client treats an unanswered prompt as lost in transit and
      // resends it; without the id it cannot tell "you never got this" from
      // "you got it and refused it", so a refusal was retried until the attempt
      // budget ran out and the real reason was buried under a generic timeout.
      const promptBytes = Buffer.byteLength(msg.content, "utf8");
      if (promptBytes > MAX_PROMPT_BYTES) {
        send({ type: "error", assistantMessageId: msg.assistantMessageId, message: `Nachricht zu lang (${promptBytes} Bytes, max ${MAX_PROMPT_BYTES}). Bitte als Datei anhängen.` });
        return;
      }
      if (!msg.content.trim()) {
        send({ type: "error", assistantMessageId: msg.assistantMessageId, message: "Leere Nachricht." });
        return;
      }

      if (rt.deleted) {
        send({ type: "error", assistantMessageId: msg.assistantMessageId, message: "Session wurde gelöscht." });
        try { ws.close(); } catch {}
        return;
      }

      // Retry of a prompt we already accepted (mobile reconnect resends the
      // frame with the same ids). Report the outcome; never run it again.
      const replay = retryOutcome(rt, sid, msg.userMessageId);
      if (replay) {
        log("info", "prompt_retry_replayed", { sid, kind: replay.kind });
        if (replay.kind === "queued") {
          send({
            type: "queued",
            userMessageId: msg.userMessageId,
            assistantMessageId: replay.assistantId,
            // The actual slot, not the queue length — a replay in the middle
            // reported everyone else's backlog as its own position.
            queuePosition: rt.promptQueue.findIndex((q) => q.userMessageId === msg.userMessageId) + 1,
          });
        } else {
          send({
            type: "resumed",
            assistantMessageId: replay.assistantId,
            content: replay.content || "",
            done: replay.kind === "finished",
            queueLength: rt.promptQueue?.length || 0,
          });
          if (replay.kind === "finished") {
            if (replay.errored) send({ type: "error", message: "Dieser Turn wurde mit einem Fehler beendet.", assistantMessageId: replay.assistantId });
            else send({ type: "done", assistantMessageId: replay.assistantId });
          }
        }
        return;
      }
      // A response is still streaming. Don't reject and — critically — don't
      // kill it. A long tool call (build, tests, an Agent/Task run) legitimately
      // produces no stdout for minutes; silence is NOT death. The warm pool's
      // own 15-min stall watchdog and the child-exit handler are the authorities
      // on whether a turn is actually dead. So the default is: queue the new
      // prompt, it runs after the current turn finishes (see maybeFlushQueue).
      //
      // The ONLY case where we replace the inflight is when the underlying
      // process is already gone (crashed / evicted / SIGKILLed) but its inflight
      // record wasn't cleaned up yet — then there is genuinely nothing to wait
      // for, and queueing would hang the user forever. We detect that from real
      // process liveness, never from elapsed silence.
      if (rt.inflight && !rt.inflight.done) {
        const warmDead  = rt.inflight.warm  && warmPool && !warmPool.has(rt.sid);
        // `child.killed` only reflects a signal *we* sent, so a crashed or
        // naturally exited child read as alive and the new prompt was queued
        // behind a corpse. exitCode/signalCode cover the real exit — beim
        // HTTP-Transport ist es die beendete Antwort. Beides beantwortet
        // isDead().
        const p = rt.inflight.proc;
        const childDead = !rt.inflight.warm && (!p || p.isDead());
        if (warmDead || childDead) {
          log("warn", "replacing_dead_inflight_on_new_prompt", { sid, warmDead, childDead });
          killInflight(rt, "dead_on_new_prompt");
          // If prompts are already waiting, this one goes behind them. Falling
          // straight through ran the newest message first and left messages
          // that were confirmed as "queued" stuck behind it.
          if (rt.promptQueue?.length) {
            const sess2 = ensureSession(sid, email);
            if (!sess2) { send({ type: "error", assistantMessageId: msg.assistantMessageId, message: "Session conflict (belongs to a different account)." }); return; }
            const targetEngine = String(msg.engine || rt.engine || sess2.engine || "claude").toLowerCase();
            const targetModel = msg.model || rt.model || sess2.model || null;
            rt.engine = targetEngine;
            rt.model = targetModel;
            try { updateSessionEngine(sid, email, targetEngine, targetModel); } catch {}
            const qUser = msg.userMessageId || cryptoRandom();
            try { insertUserMessage(sid, qUser, msg.content); } catch { /* dup id ignored */ }
            const qAsst = newAssistantId(sid, msg.assistantMessageId, qUser, targetModel);
            rt.promptQueue.push({ content: msg.content, userMessageId: qUser, assistantId: qAsst, sess: sess2, engine: targetEngine, model: targetModel });
            broadcast(rt, { type: "queued", userMessageId: qUser, assistantMessageId: qAsst, queuePosition: rt.promptQueue.length });
            rt.inflight = null;
            maybeFlushQueue(rt);
            return;
          }
          // fall through: start the new prompt as a fresh turn below
        } else {
          // Turn is genuinely alive — queue the follow-up.
          if (rt.promptQueue.length >= MAX_PROMPT_QUEUE) {
            send({ type: "error", assistantMessageId: msg.assistantMessageId, message: "Zu viele wartende Nachrichten. Bitte kurz warten." });
            return;
          }
          const sess = ensureSession(sid, email);
          if (!sess) {
            send({ type: "error", assistantMessageId: msg.assistantMessageId, message: "Session conflict (belongs to a different account)." });
            return;
          }
          // This prompt just claimed (or confirmed) ownership. Anyone who subscribed
          // while the sid was still unowned must not keep receiving the stream.
          evictForeignSubscribers(rt, email);
          maybeAutoTitle(sid, email, msg.content);
          const targetEngine = String(msg.engine || rt.engine || sess.engine || "claude").toLowerCase();
          const targetModel = msg.model || rt.model || sess.model || null;
          rt.engine = targetEngine;
          rt.model = targetModel;
          try { updateSessionEngine(sid, email, targetEngine, targetModel); } catch {}
          const qUserMsgId = msg.userMessageId || cryptoRandom();
          try { insertUserMessage(sid, qUserMsgId, msg.content); } catch { /* dup id ignored */ }
          const qAssistantId = newAssistantId(sid, msg.assistantMessageId, qUserMsgId, targetModel);
          rt.promptQueue.push({
            content: msg.content,
            userMessageId: qUserMsgId,
            assistantId: qAssistantId,
            sess,
            engine: targetEngine,
            model: targetModel,
          });
          broadcast(rt, {
            type: "queued",
            userMessageId: qUserMsgId,
            assistantMessageId: qAssistantId,
            queuePosition: rt.promptQueue.length,
          });
          log("info", "prompt_queued", { sid, position: rt.promptQueue.length, engine: targetEngine });
          return;
        }
      }

      const sess = ensureSession(sid, email);
      if (!sess) {
        send({ type: "error", assistantMessageId: msg.assistantMessageId, message: "Session conflict (belongs to a different account)." });
        return;
      }
      // This prompt just claimed (or confirmed) ownership. Anyone who subscribed
      // while the sid was still unowned must not keep receiving the stream.
      evictForeignSubscribers(rt, email);

      maybeAutoTitle(sid, email, msg.content);

      const targetEngine = String(msg.engine || rt.engine || sess.engine || "claude").toLowerCase();
      const targetModel = msg.model || rt.model || sess.model || null;
      rt.engine = targetEngine;
      rt.model = targetModel;
      try { updateSessionEngine(sid, email, targetEngine, targetModel); } catch {}

      const userMsgId = msg.userMessageId || cryptoRandom();
      try { insertUserMessage(sid, userMsgId, msg.content); } catch { /* dup id ignored */ }

      const assistantId = newAssistantId(sid, msg.assistantMessageId, userMsgId, targetModel);

      broadcast(rt, { type: "started", userMessageId: userMsgId, assistantMessageId: assistantId, engine: targetEngine });

      // Prefer the row's value: after a delete + recreate, rt still held the old
      // session's claude id and the new chat resumed inside the deleted one's
      // context.
      rt.claudeSessionId = sess.claude_session_id || rt.claudeSessionId || null;
      rt.lastUsed = Date.now();

      spawnInflight(rt, sess, msg.content, assistantId, userMsgId, targetEngine, targetModel);
    }
   } catch (e) {
     log("error", "ws_message_failed", { sid, err: String(e?.stack || e).slice(0, 500) });
     send({ type: "error", message: "Interner Fehler bei der Verarbeitung." });
   }
  });

  ws.on("close", () => {
    clearInterval(clientWatch);
    rt.subscribers.delete(ws);
    const hasChild = !!(rt.inflight?.proc);
    log("info", "ws_close", {
      sid,
      hasChild,
      subscribers: rt.subscribers.size,
    });
    // If no subscribers left AND there's still a running child, arm the
    // long-grace orphan kill as a safety net. A reconnect (any WS open) will
    // cancel it.
    if (rt.subscribers.size === 0 && hasChild) {
      if (rt.orphanKillTimer) clearTimeout(rt.orphanKillTimer);
      // Capture the child this timer is about. Without it the timer killed
      // whatever was running 30 minutes later — including a healthy turn that
      // the queue had started in the meantime, on a grace period measured from
      // someone else's disconnect.
      const guarded = rt.inflight?.proc;
      rt.orphanKillTimer = setTimeout(() => {
        rt.orphanKillTimer = null;
        if (guarded && rt.inflight?.proc === guarded && !rt.inflight.done) {
          log("warn", "killing_orphan_child_no_reconnect", { sid });
          guarded.stop("orphan");
        }
      }, ORPHAN_CHILD_GRACE_MS);
      rt.orphanKillTimer.unref?.();
    }
  });
}


function isUuid(s) {
  return typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

/**
 * Real retry handling for a repeated user message id.
 *
 * An earlier attempt at this only minted a fresh assistant id and let the turn
 * run — which is not idempotency at all: the prompt executed a second time,
 * tools and all, under bypassPermissions. A repeated id means the client never
 * saw the outcome of a prompt we already accepted, so the correct answer is to
 * report that outcome, never to run it again.
 *
 * @returns {null} when this is a new prompt and the caller should proceed,
 *          or a description of what to replay instead.
 */
function retryOutcome(rt, sid, userMessageId) {
  if (!userMessageId || !userMessageExists(sid, userMessageId)) return null;
  // Check the QUEUE first, and check that a running turn is actually THIS one.
  // Returning rt.inflight just because some turn is running reported a
  // different, unrelated turn as this message's outcome — and, worse, let a new
  // prompt that happened to reuse an old id be swallowed instead of executed.
  const queued = (rt.promptQueue || []).find((q) => q.userMessageId === userMessageId);
  if (queued) return { kind: "queued", assistantId: queued.assistantId };
  const inf = rt.inflight;
  if (inf && !inf.done && inf.userMessageId === userMessageId) {
    return { kind: "running", assistantId: inf.assistantId, content: inf.content };
  }
  const prior = assistantAfter(sid, userMessageId);
  if (prior) {
    return {
      kind: "finished",
      assistantId: prior.id,
      content: prior.content || "",
      // A turn that ended in an error must not be replayed as a clean answer.
      // Rows written before turn_status existed carry null; those are replayed
      // as finished, which is how they behaved before this column.
      errored: prior.turn_status === "error",
    };
  }
  // Accepted before but no answer row survived (crash between insert and
  // placeholder). Let it run — re-executing beats silently answering nothing.
  return null;
}

function newAssistantId(sid, wanted, replyTo = null, model = null) {
  const id = wanted || cryptoRandom();
  try {
    insertAssistantPlaceholder(sid, id, replyTo, model);
    return id;
  } catch {
    const gen = cryptoRandom();
    try {
      insertAssistantPlaceholder(sid, gen, replyTo, model);
      log("info", "assistant_id_regenerated", { sid });
    } catch (e2) {
      // Not a collision — the DB is unhappy (locked, full). Say so instead of
      // logging a successful regeneration that did not happen: the turn will
      // run and its output will have no row to land in.
      log("error", "assistant_placeholder_failed", { sid, err: String(e2?.message || e2) });
    }
    return gen;
  }
}

function cryptoRandom() {
  return [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Number of sessions with a live Claude run in flight (same set healthz reports).
function activeTurns() {
  // Counts everything a restart would destroy, not just running turns: queued
  // prompts live in memory only (their user message is already in the DB, so
  // losing them leaves a question with a permanently empty answer), and an open
  // PTY is an interactive session the user is sitting in front of.
  let n = 0;
  for (const r of runtime.values()) {
    // `done` matters: a finished inflight lingers for INFLIGHT_DONE_TTL_MS so a
    // late reconnect can still read it. Counting those kept the bridge "busy"
    // for five minutes after every turn, so on a normally used machine the
    // self-update never found a quiet moment and security fixes never landed.
    if ((r.inflight?.proc || r.inflight?.warm) && !r.inflight.done) n++;
    n += r.promptQueue?.length || 0;
  }
  // The Alexa slot runs outside `runtime`; a restart mid-turn kills it.
  if (alexaSession.busy) n++;
  return n;
}

// Pull a newer bridge from the origin and, if we got one, restart to apply it.
// Skipped while any turn is in flight so an update never interrupts a live chat;
// the next tick retries. Without a supervisor we leave the new files applied for
// the next manual restart instead of exiting into a stopped bridge.
let selfUpdateRunning = false;
async function maybeSelfUpdate() {
  if (!SELFUPDATE || selfUpdateRunning) return;
  if (activeTurns() > 0) return;
  selfUpdateRunning = true;
  try {
    const r = await checkAndStage({ url: UPDATE_URL, log });
    if (!r.updated) { log("info", "selfupdate_checked", { running: r.from, origin: r.to }); return; }
    log("info", "selfupdate_done", r);
    if (activeTurns() > 0) return;             // a turn started during npm install
    if (isSupervised()) {
      log("info", "selfupdate_restart", { to: r.to });
      shutdown("selfupdate");                  // supervisor relaunches with new code
    } else {
      log("warn", "selfupdate_needs_restart", { to: r.to, hint: "no supervisor — restart to apply" });
    }
  } catch (e) {
    log("warn", "selfupdate_error", { err: String(e?.message || e) });
  } finally {
    selfUpdateRunning = false;
  }
}

function killAllInflightChildren() {
  // warmPool.killAll() only covers pooled procs. One-shot children (the fallback
  // path) were left running on SIGTERM — a launchd restart or self-update thus
  // orphaned claude processes that keep executing tools with bypassPermissions
  // against a bridge that is no longer listening.
  // Ein offener HTTP-Turn hängt genauso in der Luft wie ein Kindprozess: der
  // Dienst rechnet weiter für eine Bridge, die die Antwort nicht mehr annimmt.
  for (const rt of runtime.values()) {
    if (rt.inflight?.proc && !rt.inflight.done) { try { rt.inflight.proc.stop("shutdown"); } catch {} }
  }
}

function shutdown(sig) {
  try { speech.close(); } catch {}
  try { warmPool?.killAll(); } catch {}
  try { killAllInflightChildren(); } catch {}
  log("info", "bridge_shutdown", { sig });
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("exit", () => {
  try { warmPool?.killAll(); } catch {}
  try { killAllInflightChildren(); } catch {}
});

server.listen(PORT, HOST, () => {
  log("info", "bridge_listening", { host: HOST, port: PORT, version: BRIDGE_VERSION, claude: CLAUDE_BIN, cwd: CWD, warm: USE_WARM, db: process.env.DB_DIR || "~/Library/conduit-bridge" });
  // A row left 'running' at boot was orphaned by the previous process dying
  // mid-tool (crash/kill/self-update). Close them so the audit trail has no
  // permanently ambiguous entries.
  try { const swept = sweepStaleRunningAudit(); if (swept) log("info", "audit_swept_stale", { count: swept }); } catch {}
  // Warm the auth-readiness cache so the first healthz already knows the truth.
  setTimeout(() => { try { probeClaude(); } catch {} }, 1500);
  // Self-update: first check shortly after boot (idle), then on a slow interval.
  if (SELFUPDATE) {
    setTimeout(() => { maybeSelfUpdate(); }, 45_000);
    const iv = setInterval(() => { maybeSelfUpdate(); }, SELFUPDATE_INTERVAL_MS);
    iv.unref?.();
  }
});
