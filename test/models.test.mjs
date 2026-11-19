// Model catalog: Claude family aliases, learned versions, agy model list.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "conduit-models-"));
process.env.DB_DIR = dir;
process.env.AGY_BIN = join(dir, "no-agy");
delete process.env.CLAUDE_MODEL;
delete process.env.AGY_MODEL;

const m = await import("../src/models.mjs");
const { getEngine } = await import("../src/engines.mjs");
test.after(() => rmSync(dir, { recursive: true, force: true }));

test("claudeAlias maps old, new and concrete ids to the CLI family alias", () => {
  assert.equal(m.claudeAlias("claude-opus-5"), "opus");
  assert.equal(m.claudeAlias("claude-sonnet-4"), "sonnet");
  assert.equal(m.claudeAlias("claude-haiku-5-5"), "haiku");
  assert.equal(m.claudeAlias("claude-fable"), "fable");
  assert.equal(m.claudeAlias("FABLE"), "fable");
  assert.equal(m.claudeAlias("tippfehler"), "opus");
  assert.equal(m.claudeAlias(""), "opus");
});

test("Claude engine sends fable as fable instead of falling back to opus", () => {
  const claude = getEngine("claude");
  assert.equal(claude.resolveModel("claude-fable"), "fable");
  assert.equal(claude.resolveModel(null), "opus");
  assert.deepEqual(claude.models.map((x) => x.id), ["claude-opus", "claude-sonnet", "claude-haiku", "claude-fable"]);
  assert.equal(claude.models.find((x) => x.default)?.id, "claude-opus");
});

test("parseClaudeModel reads versions but not date suffixes", () => {
  assert.deepEqual(m.parseClaudeModel("claude-opus-5-5"), { alias: "opus", version: "5.5" });
  assert.deepEqual(m.parseClaudeModel("claude-fable-5-2"), { alias: "fable", version: "5.2" });
  assert.deepEqual(m.parseClaudeModel("claude-sonnet-4-20250514"), { alias: "sonnet", version: "4" });
  assert.deepEqual(m.parseClaudeModel("claude-opus-5-5[1m]"), { alias: "opus", version: "5.5" });
  assert.equal(m.parseClaudeModel("gpt-6.1-sol"), null);
  assert.equal(m.parseClaudeModel(undefined), null);
});

test("names carry no version until a run reported one, then persist it", () => {
  m._resetClaudeSeen();
  assert.equal(m.claudeModels("opus")[0].name, "Opus");
  m.noteClaudeModel("claude-opus-5-5");
  m.noteClaudeModel("claude-fable-5-2");
  const names = m.claudeModels("opus").map((x) => x.name);
  assert.deepEqual(names, ["Opus 5.5", "Sonnet", "Haiku", "Fable 5.2"]);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "claude-models.json"), "utf8")), { opus: "5.5", fable: "5.2" });
});

test("the Claude engine learns the version from the init event", () => {
  m._resetClaudeSeen();
  const sink = { onConversationId() {} };
  getEngine("claude").readEvent({ type: "system", subtype: "init", session_id: "s", model: "claude-haiku-5-5" }, sink);
  assert.equal(m.claudeModels("opus").find((x) => x.id === "claude-haiku").name, "Haiku 5.5");
});

const AGY_OUT = [
  "gemini-4-neon-high\tGemini 4 Neon (High)",
  "gemini-pro-orchestrator-neon\tOrchestrator (Neon)",
  "gemini-3.8-flash-high\tGemini 3.8 Flash (High)",
  "claude-opus-5-5-high\tClaude Opus 5.5 (High)",
  "gpt-oss-120b-medium\tGPT-OSS 120B (Medium)",
  "",
  "gemini-4-neon-high\tduplicate",
].join("\n");

test("parseAgyModels keeps only Gemini models, no orchestrators or duplicates", () => {
  assert.deepEqual(m.parseAgyModels(AGY_OUT), [
    { id: "gemini-4-neon-high", name: "Gemini 4 Neon (High)" },
    { id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
  ]);
  assert.deepEqual(m.parseAgyModels("garbage\n--model\t-x"), []);
});

test("Gemini engine offers agy's list and drops models agy no longer has", () => {
  const agy = getEngine("gemini");
  m._setAgyModels(m.parseAgyModels(AGY_OUT));
  assert.equal(agy.defaultModel, "gemini-4-neon-high");
  assert.equal(agy.resolveModel("gemini-3.8-flash-high"), "gemini-3.8-flash-high");
  // A session row from before: the model is gone, the turn must still run.
  assert.equal(agy.resolveModel("gemini-3.1-pro-high"), "gemini-4-neon-high");
  // A Claude model left over from switching engines does not slip through.
  assert.equal(agy.resolveModel("claude-opus"), "gemini-4-neon-high");

  process.env.AGY_MODEL = "gemini-3.8-flash-high";
  assert.equal(agy.defaultModel, "gemini-3.8-flash-high");
  process.env.AGY_MODEL = "gemini-gone";
  assert.equal(agy.defaultModel, "gemini-4-neon-high");
  delete process.env.AGY_MODEL;
});

test("without a list Gemini keeps a Gemini choice and otherwise uses agy's default", () => {
  const agy = getEngine("gemini");
  m._setAgyModels([]);
  assert.equal(agy.defaultModel, "default");
  // A valid stored choice must not silently lose its model on a cold start.
  assert.equal(agy.resolveModel("gemini-3.8-flash-high"), "gemini-3.8-flash-high");
  assert.equal(agy.resolveModel("claude-opus"), "default");
  assert.equal(agy.resolveModel("gemini-pro-orchestrator-neon"), "default");
  assert.equal(agy.resolveModel(""), "default");
  assert.ok(!agy.buildArgs({ prompt: "hi", model: "default" }).some((a) => a.startsWith("--model")));
});

test("a binary that cannot be started never throws out of the refresh", async () => {
  m._setAgyModels([]);
  assert.doesNotThrow(() => m.refreshAgyModels(join(dir, "missing", "agy")));
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(m.agyModels(), []);
});
