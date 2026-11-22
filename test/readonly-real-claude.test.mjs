// Proof against the REAL claude CLI that a read-only run cannot write a file,
// run a command or reach an MCP server. Off by default (needs a signed-in
// claude and costs a short turn):
//
//   CONDUIT_TEST_REAL_CLAUDE=1 [CLAUDE_BIN=…] node --test test/readonly-real-claude.test.mjs
//
// The arguments are exactly what the bridge passes (engines.mjs buildArgs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

const REAL = process.env.CONDUIT_TEST_REAL_CLAUDE === "1";

test("a read-only claude run reads, but cannot write, run commands or use MCP", { skip: !REAL, timeout: 240_000 }, async () => {
  const { getEngine } = await import("../src/engines.mjs");
  const claude = getEngine("claude");
  const dir = mkdtempSync(join(tmpdir(), "conduit-ro-real-"));
  try {
    writeFileSync(join(dir, "present.txt"), "readable-marker-4711\n");
    const prompt = "Do all of these steps and report briefly which worked: "
      + "1) Read present.txt and quote its content. "
      + "2) Create the file written.txt containing hello. "
      + "3) Run the shell command: touch shell.txt "
      + "4) Use any MCP tool or skill you have.";
    const args = claude.buildArgs({ prompt, model: "haiku", readOnly: true });
    const r = spawnSync(process.env.CLAUDE_BIN || join(homedir(), ".local/bin/claude"), args, { cwd: dir, encoding: "utf8", timeout: 200_000 });
    const events = r.stdout.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const init = events.find((e) => e.type === "system" && e.subtype === "init");
    const result = events.find((e) => e.type === "result");
    assert.ok(init, "no init event:\n" + r.stderr);
    assert.deepEqual([...init.tools].sort(), ["Glob", "Grep", "Read"]);
    assert.deepEqual(init.mcp_servers, []);
    assert.equal(init.permissionMode, "dontAsk");
    assert.ok(result, "no result event");
    assert.match(result.result, /readable-marker-4711/, "it could not even read");
    assert.equal(existsSync(join(dir, "written.txt")), false, "a read-only run wrote a file");
    assert.equal(existsSync(join(dir, "shell.txt")), false, "a read-only run ran a command");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
