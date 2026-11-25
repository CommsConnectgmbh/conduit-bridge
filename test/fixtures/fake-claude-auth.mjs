#!/usr/bin/env node
// Stand-in for `claude auth status --json` and `claude auth login`.
//   FAKE_AUTH_STATUS   JSON printed by `auth status --json`
//   FAKE_AUTH_ENV_FILE file that gets "token" if CLAUDE_CODE_OAUTH_TOKEN reached us, else "clean"
//   FAKE_GOOD_CODE     the code `auth login` accepts
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const [cmd, sub] = process.argv.slice(2);
if (process.env.FAKE_AUTH_ENV_FILE) {
  appendFileSync(process.env.FAKE_AUTH_ENV_FILE, (process.env.CLAUDE_CODE_OAUTH_TOKEN ? "token" : "clean") + (process.env.BROWSER === "/usr/bin/true" ? "+nobrowser" : "") + "\n");
}
if (cmd === "auth" && sub === "status") {
  process.stdout.write((process.env.FAKE_AUTH_STATUS || '{"loggedIn":false}') + "\n");
  process.exit(0);
}
if (cmd === "auth" && sub === "login") {
  process.stdout.write("Opening browser to sign in…\n");
  process.stdout.write("If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=x&state=abc\n");
  process.stdout.write("Paste code here if prompted > ");
  createInterface({ input: process.stdin }).once("line", (line) => {
    if (line.trim() === process.env.FAKE_GOOD_CODE) { process.stdout.write("Login successful.\n"); process.exit(0); }
    process.stdout.write("Login failed: That code wasn't accepted.\n");
    process.exit(1);
  });
  setInterval(() => {}, 1 << 30);
} else {
  process.exit(2);
}
