// The scheduled profile is trusted only after the CLI's init event has
// positively confirmed it (fail closed). A stand-in CLI plays every way that
// confirmation can be missing, wrong or late; none may yield an answer.
// POSIX only: the stand-in is a shebang script.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runIsolatedClaude, checkInit } from "../src/isolated-claude.mjs";

const POSIX = process.platform !== "win32";
let dir, bin;
const GOOD_INIT = { type: "system", subtype: "init", tools: [], mcp_servers: [], slash_commands: [], permissionMode: "dontAsk" };

before(() => {
  if (!POSIX) return;
  dir = mkdtempSync(join(tmpdir(), "conduit-iso-"));
  bin = join(dir, "fake-claude.mjs");
  writeFileSync(bin, `#!${process.execPath}
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => { input += d; });
process.stdin.on("end", () => {
  const sc = (/SC:([a-z-]+)/.exec(input) || [])[1];
  const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
  const init = ${JSON.stringify(GOOD_INIT)};
  const say = () => out({ type: "assistant", message: { content: [{ type: "text", text: "LEAKED ANSWER" }] } });
  const done = () => out({ type: "result", subtype: "success", is_error: false, result: "", usage: { input_tokens: 5, output_tokens: 2 } });
  if (sc === "ok") { out(init); out({ type: "assistant", message: { content: [{ type: "text", text: "fine" }] } }); done(); }
  else if (sc === "no-init") { say(); done(); }
  else if (sc === "late-init") { say(); out(init); done(); }
  else if (sc === "init-no-tools-field") { const i = { ...init }; delete i.tools; out(i); say(); done(); }
  else if (sc === "init-no-slash-field") { const i = { ...init }; delete i.slash_commands; out(i); say(); done(); }
  else if (sc === "init-wrong-mode") { out({ ...init, permissionMode: "bypassPermissions" }); say(); done(); }
  else if (sc === "result-only") { out({ type: "result", subtype: "success", is_error: false, result: "LEAKED ANSWER", usage: {} }); }
  else if (sc === "silent") { setInterval(() => {}, 1000); return; }
  else if (sc === "exit-empty") { process.exit(0); }
  process.exit(0);
});
`);
  chmodSync(bin, 0o755);
});
after(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

const run = (sc, extra = {}) => {
  const seen = [];
  return runIsolatedClaude({ bin, input: `SC:${sc}`, cwd: dir, onText: (d) => seen.push(d), ...extra }).then((r) => ({ ...r, seen }));
};

test("a confirmed profile yields the answer", { skip: !POSIX }, async () => {
  const r = await run("ok");
  assert.equal(r.errorClass, null);
  assert.equal(r.text, "fine");
});

for (const [sc, why] of [
  ["no-init", "answer without any init"],
  ["late-init", "answer before the init"],
  ["init-no-tools-field", "init without a tools field"],
  ["init-no-slash-field", "init without a slash_commands field"],
  ["init-wrong-mode", "init with another permission mode"],
  ["result-only", "a result carrying text, no init"],
  ["exit-empty", "process ends without saying anything"],
]) {
  test(`fail closed: ${why}`, { skip: !POSIX }, async () => {
    const r = await run(sc);
    assert.equal(r.errorClass, "profile_mismatch", JSON.stringify(r.problems));
    assert.equal(r.text, "", "no text may be kept");
    assert.equal(r.seen.join("").includes("LEAKED"), false, "no text may be streamed");
    assert.ok(r.problems.length > 0);
  });
}

test("fail closed: an init that never comes stops the run", { skip: !POSIX, timeout: 10_000 }, async () => {
  const r = await run("silent", { initTimeoutMs: 300 });
  assert.equal(r.errorClass, "profile_mismatch");
  assert.deepEqual(r.problems, ["init_missing"]);
});

test("checkInit wants every field present and empty", () => {
  assert.deepEqual(checkInit({ tools: [], mcp_servers: [], slash_commands: [], permissionMode: "dontAsk" }), []);
  assert.ok(checkInit({}).length >= 3);
  assert.deepEqual(checkInit(null), ["init_invalid"]);
  assert.ok(checkInit({ tools: ["Read"], mcp_servers: [], slash_commands: [], permissionMode: "dontAsk" }).includes("tools"));
});
