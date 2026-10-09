#!/usr/bin/env node
// Stand-in for `claude --print --input-format stream-json` in the warm-pool
// test. No network, no model, no tools. It records its argv and answers every
// user message the way claude 2.1.295 does when the permission policy refuses
// a tool call: a tool_use, an error tool_result, a text, and a `result` event
// listing the refused call under permission_denials.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

if (process.env.FAKE_CLAUDE_ARGV) appendFileSync(process.env.FAKE_CLAUDE_ARGV, JSON.stringify(process.argv.slice(2)) + "\n");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const sid = "11111111-2222-3333-4444-555555555555";
out({ type: "system", subtype: "init", session_id: sid, permissionMode: "default" });

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const id = "toolu_fake";
  out({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "Write", input: { file_path: "x.txt", content: "x" } }] } });
  out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error: true, content: "Permission for this tool use was denied." }] } });
  out({ type: "assistant", message: { content: [{ type: "text", text: "I could not write the file." }] } });
  out({
    type: "result", subtype: "success", is_error: false, session_id: sid,
    usage: { input_tokens: 1, output_tokens: 1 },
    permission_denials: [{ tool_name: "Write", tool_use_id: id, tool_input: {} }],
  });
});
