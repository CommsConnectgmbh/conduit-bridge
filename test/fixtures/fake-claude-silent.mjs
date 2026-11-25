#!/usr/bin/env node
// Stand-in for a claude that never starts: it reads stdin and prints nothing,
// like the CLI blocked in openat() while macOS waits for a permission dialog.
// FAKE_CLAUDE_INIT_THEN_DELAY_MS turns it into a claude that did start: it
// prints `system/init` at once and answers each message only after the delay.
// FAKE_CLAUDE_PRE_EVENTS=hooks emits hook and status events for each message
// right away (what the CLI prints before any request); =retry emits the CLI's
// api_retry notice instead.
import { createInterface } from "node:readline";

const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const delay = Number(process.env.FAKE_CLAUDE_INIT_THEN_DELAY_MS || 0);
const sid = "11111111-2222-3333-4444-555555555555";
if (delay) out({ type: "system", subtype: "init", session_id: sid });
createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim() || !delay) return;
  const pre = process.env.FAKE_CLAUDE_PRE_EVENTS || "";
  if (pre === "hooks") {
    out({ type: "system", subtype: "hook_started", hook_name: "UserPromptSubmit" });
    out({ type: "system", subtype: "hook_response", hook_name: "UserPromptSubmit" });
    out({ type: "system", subtype: "status", status: "requesting" });
  } else if (pre === "retry") {
    out({ type: "system", subtype: "api_retry", attempt: 1, retry_delay_ms: 500 });
  }
  setTimeout(() => {
    out({ type: "assistant", message: { content: [{ type: "text", text: "late but here" }] } });
    out({ type: "result", subtype: "success", is_error: false, session_id: sid, usage: { input_tokens: 1, output_tokens: 1 } });
  }, delay);
});
setInterval(() => {}, 1 << 30);
