#!/usr/bin/env node
// Stand-in for `claude --print --input-format stream-json` that replays a
// scripted stream: FAKE_CLAUDE_SCRIPT is a JSON file holding one array of
// events per turn, emitted in order, one turn per user message on stdin.
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const turns = JSON.parse(readFileSync(process.env.FAKE_CLAUDE_SCRIPT, "utf8"));
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
out({ type: "system", subtype: "init", session_id: "11111111-2222-3333-4444-555555555555" });

let n = 0;
createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  for (const ev of turns[n++] ?? []) out(ev);
  out({ type: "result", subtype: "success", is_error: false, usage: { input_tokens: 1, output_tokens: 1 } });
});
