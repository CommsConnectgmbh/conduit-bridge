// Permission policy for the AI agents: what the bridge passes to each CLI, how
// a misconfiguration fails closed, and how a refused tool call reaches the
// answer instead of leaving the turn silent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readAgentPolicy, claudePermissionArgs, codexPermissionArgs, agyPermissionArgs, deniedNotice, policySummary,
} from "../src/agent-policy.mjs";

const dir = mkdtempSync(join(tmpdir(), "conduit-policy-"));
// Not after(): with the top-level await below, the runner can finish the tests
// registered so far, and run after(), before the rest are even registered.
// The history database stays open in this process; Windows keeps it locked
// until it is closed.
let closeDb = () => {};
process.on("exit", () => {
  try { closeDb(); } catch {}
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch {}
});

test("without settings every engine keeps today's flags", () => {
  const p = readAgentPolicy({});
  assert.deepEqual(p.errors, {});
  assert.deepEqual(claudePermissionArgs(p.claude), ["--permission-mode", "bypassPermissions"]);
  assert.deepEqual(codexPermissionArgs(p.codex), ["--dangerously-bypass-approvals-and-sandbox"]);
  assert.deepEqual(agyPermissionArgs(p.gemini), ["--dangerously-skip-permissions"]);
  assert.deepEqual(policySummary(p), { claude: "bypassPermissions", codex: "bypass", gemini: "bypass", disabled: [], misconfigured: [] });
});

test("restricted settings map to the CLIs' own options, refusing instead of asking", () => {
  const settings = join(dir, "claude-settings.json");
  writeFileSync(settings, "{}");
  const p = readAgentPolicy({
    CONDUIT_CLAUDE_PERMISSION_MODE: "dontAsk",
    CONDUIT_CLAUDE_ALLOWED_TOOLS: "Read, Grep, Bash(git status *)",
    CONDUIT_CLAUDE_DISALLOWED_TOOLS: "WebFetch",
    CONDUIT_CLAUDE_SETTINGS: settings,
    CONDUIT_CODEX_SANDBOX: "workspace-write",
    CONDUIT_AGY_PERMISSIONS: "settings",
    CONDUIT_AGY_SANDBOX: "1",
  });
  assert.deepEqual(p.errors, {});
  assert.deepEqual(claudePermissionArgs(p.claude), [
    "--permission-mode", "dontAsk", "--permission-prompts", "none",
    "--allowedTools", "Read,Grep,Bash(git status *)",
    "--disallowedTools", "WebFetch",
    "--settings", settings,
  ]);
  assert.deepEqual(codexPermissionArgs(p.codex), ["-c", 'sandbox_mode="workspace-write"', "-c", 'approval_policy="never"']);
  assert.deepEqual(agyPermissionArgs(p.gemini), ["--sandbox"]);
});

test("a wrong value blocks the engine instead of falling back to full rights", () => {
  const p = readAgentPolicy({
    CONDUIT_CLAUDE_PERMISSION_MODE: "readonly",
    CONDUIT_CODEX_SANDBOX: "strict",
    CONDUIT_AGY_PERMISSIONS: "none",
  });
  assert.match(p.errors.claude, /CONDUIT_CLAUDE_PERMISSION_MODE="readonly"/);
  assert.match(p.errors.codex, /CONDUIT_CODEX_SANDBOX="strict"/);
  assert.match(p.errors.gemini, /CONDUIT_AGY_PERMISSIONS="none"/);
  assert.match(readAgentPolicy({ CONDUIT_CLAUDE_SETTINGS: join(dir, "missing.json") }).errors.claude, /does not exist/);
  const typo = readAgentPolicy({ CONDUIT_DISABLED_ENGINES: "codx" });
  assert.deepEqual(Object.keys(typo.errors).sort(), ["claude", "codex", "gemini"]);
  const off = readAgentPolicy({ CONDUIT_DISABLED_ENGINES: "agy, OpenAI" });
  assert.deepEqual([...off.disabled].sort(), ["codex", "gemini"]);
  assert.deepEqual(off.errors, {});
});

test("the notice names each refused tool once and reads as plain text", () => {
  assert.equal(deniedNotice("Claude", []), "");
  const n = deniedNotice("Claude", ["Write", "Bash", "Write", null]);
  assert.match(n, /^Claude was not allowed to use Write, Bash on this computer\./);
  assert.ok(!/[–—]/.test(n), "no dashes in visible text");
});

// The registry reads the policy once at import, like every other setting, so
// the environment is set before the dynamic import below.
process.env.DB_DIR = join(dir, "db");
process.env.OLLAMA_HOST = "http://127.0.0.1:9";
process.env.CONDUIT_CLAUDE_PERMISSION_MODE = "manual";
process.env.CONDUIT_CLAUDE_DISALLOWED_TOOLS = "Bash";
process.env.CONDUIT_CODEX_SANDBOX = "read-only";
process.env.CONDUIT_AGY_PERMISSIONS = "settings";
process.env.CONDUIT_DISABLED_ENGINES = "ollama";
const { getEngine, engineCatalog, enginePolicyBlock } = await import("../src/engines.mjs");
const { createWarmPool } = await import("../src/warm.mjs");
const { db } = await import("../src/db.mjs");
closeDb = () => db.close();

function sink() {
  const s = { chunks: [], denied: [], errors: [], tools: [] };
  return Object.assign(s, {
    hasContent: () => s.chunks.length > 0,
    onConversationId: () => {}, onUsage: () => {},
    onChunk: (t) => s.chunks.push(t),
    onToolStart: (b) => s.tools.push(["start", b.name]),
    onToolEnd: (b) => s.tools.push(["end", b.is_error, b.content]),
    onError: (m) => s.errors.push(m),
    onPermissionDenied: (names) => s.denied.push(...names),
  });
}

test("each engine builds its arguments from the policy, resume included", () => {
  const claude = getEngine("claude").buildArgs({ prompt: "hi", model: "opus", resumeId: "abc" });
  assert.deepEqual(claude.slice(-8), [
    "--permission-mode", "manual", "--permission-prompts", "none", "--disallowedTools", "Bash", "--resume", "abc",
  ]);
  assert.ok(!claude.includes("bypassPermissions"));
  const codex = getEngine("codex").buildArgs({ prompt: "hi", model: "default", resumeId: "t-1" });
  assert.deepEqual(codex.slice(0, 2), ["exec", "resume"]);
  assert.ok(codex.includes('sandbox_mode="read-only"') && codex.includes('approval_policy="never"'));
  assert.ok(!codex.includes("--dangerously-bypass-approvals-and-sandbox"));
  assert.deepEqual(codex.slice(-3), ["--", "t-1", "hi"]);
  const agy = getEngine("gemini").buildArgs({ prompt: "hi", model: "default" });
  assert.ok(!agy.includes("--dangerously-skip-permissions"));
});

test("a disabled engine is unavailable and refuses turns with a reason", () => {
  const ollama = engineCatalog().find((e) => e.id === "ollama");
  assert.equal(ollama.available, false);
  assert.equal(ollama.disabled, true);
  assert.match(enginePolicyBlock(getEngine("ollama")), /turned off on this bridge/);
  assert.equal(enginePolicyBlock(getEngine("claude")), null);
});

test("refusals in the CLIs' streams are reported, Antigravity's error text is kept", () => {
  const c = sink();
  getEngine("claude").readEvent({ type: "result", is_error: false, permission_denials: [{ tool_name: "Write" }] }, c);
  assert.deepEqual(c.denied, ["Write"]);

  // Observed from agy in print mode without --dangerously-skip-permissions.
  const a = sink();
  const agy = getEngine("gemini");
  agy.readEvent({ event: "step_update", step_update: { step_index: 2, state: "ACTIVE", step_type: "tool", tool_name: "write_to_file" } }, a);
  agy.readEvent({ event: "step_update", step_update: { step_index: 2, state: "ERROR", step_type: "tool", tool_name: "write_to_file", tool_info: { error: { message: "permission check failed for write_file" } } } }, a);
  agy.readEvent({ event: "result", result: { status: "SUCCESS", response: "", denied_actions: [{ action: "write_file", display_name: "WriteToFile" }] } }, a);
  assert.deepEqual(a.denied, ["WriteToFile"]);
  assert.deepEqual(a.tools[1], ["end", true, "permission check failed for write_file"]);
  assert.deepEqual(a.errors, []);
});

test("warm pool: policy flags reach the CLI and a refusal is reported before the turn ends",
  { skip: process.platform === "win32" && "the fake CLI is a script, not an executable, on Windows" },
  async () => {
    const argvFile = join(dir, "argv.jsonl");
    process.env.FAKE_CLAUDE_ARGV = argvFile;
    const pool = createWarmPool({
      claudeBin: fileURLToPath(new URL("./fixtures/fake-claude-stream.mjs", import.meta.url)),
      model: "opus", defaultCwd: dir, env: process.env, log: () => {}, isUuid: () => false,
    });
    try {
      const events = [];
      await new Promise((resolve, reject) => {
        const started = pool.runTurn({
          sid: "s1", sess: null, cwd: dir, prompt: "write x.txt",
          handlers: {
            onChunk: (t) => events.push(["chunk", t]),
            onToolUse: (b) => events.push(["tool", b.name]),
            onToolResult: (b) => events.push(["result", b.is_error]),
            onPermissionDenied: (names) => events.push(["denied", ...names]),
            onDone: () => { events.push(["done"]); resolve(); },
            onError: (m) => reject(new Error(m)),
          },
        });
        if (!started) reject(new Error("turn not started"));
      });
      assert.deepEqual(events, [
        ["tool", "Write"], ["result", true], ["chunk", "I could not write the file."], ["denied", "Write"], ["done"],
      ]);
      const argv = JSON.parse(readFileSync(argvFile, "utf8").trim().split("\n")[0]);
      const i = argv.indexOf("--permission-mode");
      assert.deepEqual(argv.slice(i, i + 6), ["--permission-mode", "manual", "--permission-prompts", "none", "--disallowedTools", "Bash"]);
    } finally {
      pool.killAll();
    }
  });
