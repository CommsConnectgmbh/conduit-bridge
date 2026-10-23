// Separate text blocks of a Claude turn (text, tool call, text; or two text
// blocks in one message) must reach the chat as separate paragraphs, without
// touching the token deltas inside a block. Covers the warm pool (partial
// deltas and the full-message fallback) and the one-shot CLAUDE.readEvent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "conduit-textblocks-"));
let closeDb = () => {};
process.on("exit", () => {
  try { closeDb(); } catch {}
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch {}
});
process.env.DB_DIR = join(dir, "db");
const { getEngine } = await import("../src/engines.mjs");
const { createWarmPool } = await import("../src/warm.mjs");
const { db } = await import("../src/db.mjs");
closeDb = () => db.close();

const se = (event) => ({ type: "stream_event", event });
const start = (index, type = "text") => se({ type: "content_block_start", index, content_block: { type, text: "" } });
const delta = (index, text) => se({ type: "content_block_delta", index, delta: { type: "text_delta", text } });
const tool = (id) => ({ type: "tool_use", id, name: "Bash", input: {} });
const assistant = (...content) => ({ type: "assistant", message: { content } });
const text = (t) => ({ type: "text", text: t });
const toolResult = (id) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id }] } });

// Text -> tool -> text, as in the screenshot: the deltas split mid-word and
// at a space, and the full assistant messages repeat the streamed text.
const screenshot = [
  start(0), delta(0, "Deploys laufen über `roloff-frei"), delta(0, "gabe`"), delta(0, "."),
  start(1, "tool_use"), assistant(text("Deploys laufen über `roloff-freigabe`."), tool("t1")), toolResult("t1"),
  start(0), delta(0, "Ich schau "), delta(0, "nach."),
  start(1, "tool_use"), assistant(text("Ich schau nach."), tool("t2")), toolResult("t2"),
  start(0), delta(0, "Ein Merge rollt aus."), assistant(text("Ein Merge rollt aus.")),
];
const screenshotText = "Deploys laufen über `roloff-freigabe`.\n\nIch schau nach.\n\nEin Merge rollt aus.";

const skipWin = { skip: process.platform === "win32" && "the fake CLI is a script, not an executable, on Windows" };

async function warmTurns(turns) {
  const script = join(dir, `script-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(script, JSON.stringify(turns));
  process.env.FAKE_CLAUDE_SCRIPT = script;
  const pool = createWarmPool({
    claudeBin: fileURLToPath(new URL("./fixtures/fake-claude-script.mjs", import.meta.url)),
    model: "opus", defaultCwd: dir, env: process.env, log: () => {}, isUuid: () => false,
  });
  const results = [];
  try {
    for (let i = 0; i < turns.length; i++) {
      const chunks = [];
      await new Promise((resolve, reject) => {
        const started = pool.runTurn({
          sid: "s1", sess: null, cwd: dir, prompt: `turn ${i}`,
          handlers: { onChunk: (c) => chunks.push(c), onDone: resolve, onError: (m) => reject(new Error(m)) },
        });
        if (!started) reject(new Error("turn not started"));
      });
      results.push(chunks);
    }
  } finally {
    pool.killAll();
  }
  return results;
}

test("warm: text -> tool -> text streams as paragraphs, deltas untouched", skipWin, async () => {
  const [chunks] = await warmTurns([screenshot]);
  assert.equal(chunks.join(""), screenshotText);
  assert.deepEqual(chunks, [
    "Deploys laufen über `roloff-frei", "gabe`", ".", "\n\nIch schau ", "nach.", "\n\nEin Merge rollt aus.",
  ]);
});

test("warm: two text blocks in one message, empty blocks add nothing", skipWin, async () => {
  const [chunks] = await warmTurns([[
    start(0), start(1), delta(1, "Block A."), start(2), start(3), delta(3, "Block B."),
    assistant(text(""), text("Block A."), text(""), text("Block B.")),
  ]]);
  assert.equal(chunks.join(""), "Block A.\n\nBlock B.");
});

test("warm: fallback without deltas separates blocks and skips empty ones", skipWin, async () => {
  const [chunks] = await warmTurns([[
    assistant(text("Erst."), tool("t1")), toolResult("t1"),
    assistant(text(""), text("Dann."), text("Zuletzt.")),
  ]]);
  assert.equal(chunks.join(""), "Erst.\n\nDann.\n\nZuletzt.");
});

test("warm: a new turn starts without a leading paragraph break", skipWin, async () => {
  const [a, b] = await warmTurns([screenshot, [start(0), delta(0, "Zweiter Turn.")]]);
  assert.equal(a.join(""), screenshotText);
  assert.deepEqual(b, ["Zweiter Turn."]);
});

test("one-shot CLAUDE.readEvent: one paragraph per text block, no duplicates", () => {
  const claude = getEngine("claude");
  let content = "";
  const sink = {
    hasContent: () => !!content, onChunk: (t) => { content += t; },
    onToolStart() {}, onToolEnd() {}, onConversationId() {}, onPermissionDenied() {}, onError() {}, onUsage() {},
  };
  // The one-shot stream carries the partial deltas too; readEvent reads only
  // the full messages, so nothing may appear twice.
  for (const ev of [...screenshot, assistant(text(""), text("A."), text("B."))]) claude.readEvent(ev, sink);
  assert.equal(content, `${screenshotText}\n\nA.\n\nB.`);
});
