// Model lists for Claude and Antigravity (Gemini).
//
// WHY this file exists: both lists used to be fixed in engines.mjs and went
// stale with every model release. The bridge offered "Opus 5" and "Sonnet 5"
// long after the CLI ran 5.5, Fable could not be chosen at all (every unknown
// name fell back to opus), and the Gemini default "gemini-3.1-pro-high" was
// dropped by agy, so every Gemini turn on the default failed.
//
// The rule now: the CLI on this machine is the source of truth.
// - Claude: the CLI's family aliases (opus, sonnet, haiku, fable) always mean
//   the newest model of that family. The bridge sends only the alias and
//   learns the concrete version from the `init` event of each run, so the
//   picker shows "Opus 5.5" without the code naming a version.
// - Antigravity: `agy models` lists what this account can run; the bridge
//   reads it in the background and offers exactly that.

import { execFile } from "node:child_process";
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { DB_DIR } from "./db.mjs";
import { tightenFile } from "./private-fs.mjs";

// --- Claude -----------------------------------------------------------------

/** Families in picker order. `id` is what the client stores and sends; it is
 *  version-free on purpose, so a stored choice survives every model release. */
export const CLAUDE_FAMILIES = [
  { alias: "opus", id: "claude-opus", label: "Opus", description: "Strongest model for code, planning and long tasks" },
  { alias: "sonnet", id: "claude-sonnet", label: "Sonnet", description: "Fast and capable for everyday coding" },
  { alias: "haiku", id: "claude-haiku", label: "Haiku", description: "Fastest, for short questions and quick edits" },
  { alias: "fable", id: "claude-fable", label: "Fable", description: "Most capable model for reviews and hard decisions" },
];

/**
 * The CLI alias for any model name a session or device may hold: the new ids
 * ("claude-fable"), the old fixed ones ("claude-opus-5", "claude-sonnet-4"),
 * concrete ones ("claude-haiku-5-5") or bare aliases. Anything unknown stays
 * on opus, so a typo never fails a turn.
 */
export function claudeAlias(requested, fallback = "opus") {
  const req = String(requested || "").toLowerCase();
  for (const f of CLAUDE_FAMILIES) if (req.includes(f.alias)) return f.alias;
  return req ? "opus" : fallback;
}

/** "claude-opus-5-5" → { alias: "opus", version: "5.5" }; null if unknown.
 *  Version parts are one or two digits, so a date suffix
 *  ("claude-sonnet-4-20250514") is not read as a minor version. */
export function parseClaudeModel(concrete) {
  const m = /^claude-(opus|sonnet|haiku|fable)-(\d{1,2})(?:-(\d{1,2}))?(?=$|[^0-9])/.exec(String(concrete || "").toLowerCase());
  if (!m) return null;
  return { alias: m[1], version: m[3] ? `${m[2]}.${m[3]}` : m[2] };
}

const CLAUDE_SEEN_FILE = join(DB_DIR, "claude-models.json");
let claudeSeen = loadClaudeSeen();

function loadClaudeSeen() {
  try {
    const raw = JSON.parse(readFileSync(CLAUDE_SEEN_FILE, "utf8"));
    const out = {};
    for (const f of CLAUDE_FAMILIES) {
      const v = raw?.[f.alias];
      if (typeof v === "string" && /^\d{1,2}(\.\d{1,2})?$/.test(v)) out[f.alias] = v;
    }
    return out;
  } catch { return {}; }
}

/**
 * Record the concrete model a Claude run reported (`init` event, `model`).
 * Called on every run, written only when a version changes. A failed write
 * costs nothing but the version in the picker after the next restart.
 */
export function noteClaudeModel(concrete) {
  const p = parseClaudeModel(concrete);
  if (!p || claudeSeen[p.alias] === p.version) return;
  claudeSeen = { ...claudeSeen, [p.alias]: p.version };
  try {
    const tmp = `${CLAUDE_SEEN_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(claudeSeen), { mode: 0o600 });
    renameSync(tmp, CLAUDE_SEEN_FILE);
    tightenFile(CLAUDE_SEEN_FILE);
  } catch { /* in-memory value still applies until restart */ }
}

/** Picker entries. Until a family has run once its name has no version —
 *  "Opus" is always true, a guessed "Opus 5.5" might not be. */
export function claudeModels(defaultAlias) {
  return CLAUDE_FAMILIES.map((f) => ({
    id: f.id,
    name: claudeSeen[f.alias] ? `${f.label} ${claudeSeen[f.alias]}` : f.label,
    description: f.description,
    ...(f.alias === defaultAlias ? { default: true } : {}),
  }));
}

/** Test hook: forget learned versions (does not touch the file). */
export function _resetClaudeSeen(value = {}) { claudeSeen = { ...value }; }

// --- Antigravity ------------------------------------------------------------

// The list changes with Google's releases, not by the minute. Ten minutes keeps
// a new model visible the same morning without running agy on every /healthz.
const AGY_CACHE_TTL_MS = 10 * 60_000;
// After a failure (agy missing, offline, signed out) ask again sooner.
const AGY_RETRY_MS = 60_000;
const AGY_LIST_TIMEOUT_MS = 20_000;

const agyCache = { models: [], checkedAt: 0, failedAt: 0, refreshing: false };

/**
 * Parse `agy models`: one model per line, "<id>\t<display name>". agy also
 * offers Claude and GPT models; those belong to their own engines here, and
 * orchestrators are agent modes rather than models. Only Gemini models stay.
 */
export function parseAgyModels(stdout) {
  const out = [];
  const seen = new Set();
  for (const line of String(stdout || "").split(/\r?\n/)) {
    const [id, ...rest] = line.split("\t");
    const slug = (id || "").trim();
    if (!/^gemini-[a-z0-9.-]+$/i.test(slug) || slug.includes("orchestrator") || seen.has(slug)) continue;
    seen.add(slug);
    out.push({ id: slug, name: rest.join("\t").trim() || slug });
  }
  return out;
}

/** Refresh in the background; readers get the last known list. */
export function refreshAgyModels(bin) {
  const now = Date.now();
  if (agyCache.refreshing) return;
  if (agyCache.failedAt ? now - agyCache.failedAt < AGY_RETRY_MS : now - agyCache.checkedAt < AGY_CACHE_TTL_MS) return;
  agyCache.refreshing = true;
  execFile(bin, ["models"], { timeout: AGY_LIST_TIMEOUT_MS, maxBuffer: 1 << 20, env: { ...process.env, NO_COLOR: "1" } }, (err, stdout) => {
    const list = err ? [] : parseAgyModels(stdout);
    if (list.length) {
      agyCache.models = list;
      agyCache.checkedAt = Date.now();
      agyCache.failedAt = 0;
    } else {
      // Keep the last good list: a short outage should not empty the picker.
      agyCache.failedAt = Date.now();
    }
    agyCache.refreshing = false;
  });
}

/** Known Gemini models with the default marked. `preferred` (AGY_MODEL) wins
 *  when agy offers it; otherwise agy's own first entry. */
export function agyModels(preferred) {
  const list = agyCache.models;
  if (!list.length) return [];
  const def = list.some((m) => m.id === preferred) ? preferred : list[0].id;
  return list.map((m) => (m.id === def ? { ...m, default: true } : m));
}

/** Test hook. */
export function _setAgyModels(models) {
  agyCache.models = models;
  agyCache.checkedAt = models.length ? Date.now() : 0;
  agyCache.failedAt = 0;
}
