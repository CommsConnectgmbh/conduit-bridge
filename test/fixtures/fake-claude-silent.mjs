#!/usr/bin/env node
// Stand-in for a claude that never starts: it reads stdin and prints nothing,
// like the CLI blocked in openat() while macOS waits for a permission dialog.
// FAKE_CLAUDE_INIT_THEN_DELAY_MS turns it into a claude that did start: it
// prints `system/init` at once and answers each message only after the delay.
import { createInterface } from "node:readline";

const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const delay = Number(process.env.FAKE_CLAUDE_INIT_THEN_DELAY_MS || 0);
const sid = "11111111-2222-3333-4444-555555555555";
if (delay) out({ type: "system", subtype: "init", session_id: sid });
createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim() || !delay) return;
  setTimeout(() => {
    out({ type: "assistant", message: { content: [{ type: "text", text: "late but here" }] } });
    out({ type: "result", subtype: "success", is_error: false, session_id: sid, usage: { input_tokens: 1, output_tokens: 1 } });
  }, delay);
});
setInterval(() => {}, 1 << 30);
