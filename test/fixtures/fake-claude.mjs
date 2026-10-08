#!/usr/bin/env node
// Stand-in for the `claude` CLI in the Alexa tests. No network, no model, no
// tools. It reproduces only what the Alexa path depends on, observed against
// claude 2.1.294:
//   --resume <id> without a transcript under this cwd -> exit 1, a stream-json
//     `result` event with num_turns 0, stderr exactly
//     "No conversation found with session ID: <id>\n"
//   --session-id <id> that already has a transcript -> exit 1,
//     "Error: Session ID <id> is already in use.\n"
// Transcripts live in $FAKE_CLAUDE_HOME/projects/<cwd>/<id>.jsonl, so a
// conversation is only resumable from the cwd it was created under, as with the
// real CLI. The answer quotes the earlier questions, which makes "the second
// turn saw the first" checkable. $FAKE_CLAUDE_HOME/control.json steers the
// next run: { "fail": { "code", "stderr", "on"? }, "delayMs" } — "fail" is
// consumed by the first run it applies to ("on": "resume" | "init" limits it).
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const HOME = process.env.FAKE_CLAUDE_HOME;
const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i === -1 ? null : argv[i + 1]; };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

if (argv[0] === "auth") {
  process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: "fake" }) + "\n");
  process.exit(0);
}

const prompt = opt("-p");
const resume = opt("--resume");
const sessionId = opt("--session-id");
appendFileSync(join(HOME, "calls.jsonl"), JSON.stringify({ resume, sessionId, cwd: process.cwd(), model: opt("--model") }) + "\n");

const controlFile = join(HOME, "control.json");
let control = {};
try { control = JSON.parse(readFileSync(controlFile, "utf8")); } catch {}
if (control.delayMs) await new Promise((r) => setTimeout(r, control.delayMs));
const mode = resume ? "resume" : "init";
if (control.fail && (!control.fail.on || control.fail.on === mode)) {
  writeFileSync(controlFile, JSON.stringify({ ...control, fail: undefined }));
  process.stderr.write(control.fail.stderr);
  process.exit(control.fail.code);
}

const dir = join(HOME, "projects", process.cwd().replace(/[^a-zA-Z0-9]/g, "-"));
mkdirSync(dir, { recursive: true });
const id = resume || sessionId;
const file = join(dir, `${id}.jsonl`);
const result = (extra) => process.stdout.write(JSON.stringify({ type: "result", session_id: id, ...extra }) + "\n");

if (resume) {
  if (!UUID.test(resume)) {
    process.stderr.write("Error: --resume requires a valid session ID or session title when used with --print.\n");
    process.exit(1);
  }
  if (!existsSync(file)) {
    const msg = `No conversation found with session ID: ${resume}`;
    result({ subtype: "error_during_execution", is_error: true, num_turns: 0, total_cost_usd: 0, errors: [msg] });
    process.stderr.write(msg + "\n");
    process.exit(1);
  }
} else {
  if (!UUID.test(sessionId || "")) {
    process.stderr.write("Error: Invalid session ID. Must be a valid UUID.\n");
    process.exit(1);
  }
  if (existsSync(file)) {
    process.stderr.write(`Error: Session ID ${sessionId} is already in use.\n`);
    process.exit(1);
  }
}

const question = String(prompt).split("Frage: ").pop();
const earlier = existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l).q) : [];
appendFileSync(file, JSON.stringify({ q: question }) + "\n");
const text = `Turn ${earlier.length + 1}: ${question}` + (earlier.length ? ` | vorher: ${earlier.join(" / ")}` : "");
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: id }) + "\n");
process.stdout.write(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } }) + "\n");
result({ subtype: "success", is_error: false, num_turns: 1, result: text });
