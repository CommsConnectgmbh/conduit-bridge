// The macOS/Linux uninstaller against a fake home directory laid out the way
// install.sh leaves it. launchctl and systemctl are stand-ins on PATH that only
// record their calls, so the real services of the machine running the tests
// are never touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../src/uninstall.sh", import.meta.url));
const skip = process.platform === "win32" && "uninstall.sh is for macOS and Linux";
const mac = process.platform === "darwin";

function setup() {
  const home = mkdtempSync(join(tmpdir(), "conduit-uninstall-"));
  const dir = join(home, ".conduit");
  const bridge = join(dir, "bridge");
  const files = {
    [join(bridge, "src/server.mjs")]: "//",
    [join(bridge, "node_modules/ws/index.js")]: "//",
    [join(bridge, "package.json")]: "{}",
    [join(bridge, "start.sh")]: "#!/bin/sh",
    [join(bridge, ".env.local")]: `DB_DIR=${bridge}\nPAIR_OWNER_EMAIL=owner@example.com\n`,
    [join(bridge, "db.sqlite")]: "db",
    [join(bridge, "db.sqlite-wal")]: "wal",
    [join(bridge, "identity.key")]: "k",
    [join(dir, "tunnel.sh")]: "#!/bin/sh",
    [join(dir, ".cloudflared-token")]: "token",
    [join(dir, "logs/de.tryconduit.bridge.out.log")]: "log",
    [join(dir, "models/stt/model.onnx")]: "m",
    [join(home, "Library/Logs/conduit-bridge/bridge.log")]: "log",
    [join(home, "Library/Logs/conduit-bridge/bridge.log.1")]: "log",
    [join(home, "Library/conduit-bridge/pastes/a.png")]: "png",
    [join(home, "Library/LaunchAgents/de.tryconduit.bridge.plist")]: "<plist/>",
    [join(home, "Library/LaunchAgents/de.tryconduit.tunnel.plist")]: "<plist/>",
    [join(home, "Library/LaunchAgents/com.other.agent.plist")]: "<plist/>",
    [join(home, ".config/systemd/user/conduit-bridge.service")]: "[Service]",
    [join(home, ".config/systemd/user/conduit-tunnel.service")]: "[Service]",
    [join(home, ".claude/history.jsonl")]: "cli history",
  };
  for (const [p, c] of Object.entries(files)) { mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, c); }
  const bin = join(home, "fakebin");
  mkdirSync(bin);
  for (const tool of ["launchctl", "systemctl"]) {
    writeFileSync(join(bin, tool), `#!/bin/sh\necho "${tool} $*" >> "${join(home, "calls.log")}"\n`);
    chmodSync(join(bin, tool), 0o755);
  }
  return { home, dir, bridge, bin };
}

// detached: a new session without a controlling terminal, so the confirmation
// prompt cannot reach the terminal of whoever runs the tests.
const run = (env, args) => spawnSync("bash", [SCRIPT, ...args], {
  env: { PATH: `${env.bin}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: env.home, USER: "tester" },
  encoding: "utf8", detached: true, stdio: ["ignore", "pipe", "pipe"],
});
const calls = (env) => existsSync(join(env.home, "calls.log")) ? readFileSync(join(env.home, "calls.log"), "utf8") : "";

test("dry run lists services, program and data, and changes nothing", { skip }, () => {
  const env = setup();
  try {
    const r = run(env, ["--dry-run"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, mac ? /launchd agent de\.tryconduit\.bridge/ : /systemd user unit conduit-bridge/);
    assert.match(r.stdout, /Program files to remove:[\s\S]*\.cloudflared-token/);
    assert.match(r.stdout, /Data kept \(run with --purge to delete it\):[\s\S]*db\.sqlite/);
    assert.match(r.stdout, /Dry run: nothing was changed/);
    assert.ok(!r.stdout.includes("com.other.agent"));
    assert.equal(calls(env), "");
    assert.ok(existsSync(join(env.bridge, "src/server.mjs")));
  } finally { rmSync(env.home, { recursive: true, force: true }); }
});

test("without a terminal and without --yes nothing is removed", { skip }, () => {
  const env = setup();
  try {
    const r = run(env, []);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--yes/);
    assert.equal(calls(env), "");
    assert.ok(existsSync(join(env.dir, "tunnel.sh")));
  } finally { rmSync(env.home, { recursive: true, force: true }); }
});

test("default removes services and program, keeps the data", { skip }, () => {
  const env = setup();
  try {
    const r = run(env, ["--yes"]);
    assert.equal(r.status, 0, r.stderr);
    if (mac) {
      assert.match(calls(env), /launchctl bootout gui\/\d+\/de\.tryconduit\.bridge/);
      assert.ok(!existsSync(join(env.home, "Library/LaunchAgents/de.tryconduit.bridge.plist")));
      assert.ok(existsSync(join(env.home, "Library/LaunchAgents/com.other.agent.plist")));
    } else {
      assert.match(calls(env), /systemctl --user disable --now conduit-bridge\.service/);
      assert.ok(!existsSync(join(env.home, ".config/systemd/user/conduit-tunnel.service")));
    }
    for (const gone of ["src", "node_modules", "start.sh"]) assert.ok(!existsSync(join(env.bridge, gone)), gone);
    assert.ok(!existsSync(join(env.dir, ".cloudflared-token")));
    for (const kept of ["db.sqlite", "identity.key", ".env.local"]) assert.ok(existsSync(join(env.bridge, kept)), kept);
    assert.ok(existsSync(join(env.home, "Library/conduit-bridge/pastes/a.png")));
    assert.ok(existsSync(join(env.dir, "models/stt/model.onnx")));
  } finally { rmSync(env.home, { recursive: true, force: true }); }
});

test("--purge deletes the data too, and nothing outside it", { skip }, () => {
  const env = setup();
  try {
    const r = run(env, ["--yes", "--purge"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Data to DELETE/);
    assert.ok(!existsSync(env.dir), "install directory removed");
    assert.ok(!existsSync(join(env.home, "Library/Logs/conduit-bridge")));
    assert.ok(!existsSync(join(env.home, "Library/conduit-bridge")));
    assert.ok(existsSync(join(env.home, ".claude/history.jsonl")), "CLI history is not ours to delete");
    assert.ok(existsSync(join(env.home, "Library/LaunchAgents/com.other.agent.plist")));
  } finally { rmSync(env.home, { recursive: true, force: true }); }
});

// uninstall.ps1 under PowerShell where one is installed (Windows always; pwsh
// elsewhere). The home directory is redirected to the fake one; scheduled
// tasks are looked up by their fixed names and none exist on a test machine.
const PS1 = fileURLToPath(new URL("../src/uninstall.ps1", import.meta.url));
const psExe = ["pwsh", ...(process.platform === "win32" ? ["powershell"] : [])]
  .find((exe) => spawnSync(exe, ["-NoProfile", "-Command", "exit 0"], { stdio: "ignore" }).status === 0);
const runPs = (env, args) => spawnSync(psExe, ["-NoProfile", "-NonInteractive", "-Command",
  `Set-Variable -Name HOME -Value '${env.home.replace(/'/g, "''")}' -Force -Scope Global -ErrorAction SilentlyContinue; & '${PS1.replace(/'/g, "''")}' ${args.join(" ")}; exit $LASTEXITCODE`],
{ encoding: "utf8", env: { ...process.env, CONDUIT_DIR: join(env.home, ".conduit") } });

test("uninstall.ps1: dry run lists, default keeps data, -Purge deletes it", { skip: !psExe && "no PowerShell installed" }, () => {
  const env = setup();
  // install.ps1 writes PowerShell launchers instead of shell scripts.
  renameSync(join(env.bridge, "start.sh"), join(env.bridge, "start.ps1"));
  renameSync(join(env.dir, "tunnel.sh"), join(env.dir, "tunnel.ps1"));
  try {
    let r = runPs(env, ["-DryRun"]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /Data kept \(run with -Purge to delete it\)/);
    assert.ok(existsSync(join(env.bridge, "src/server.mjs")));
    r = runPs(env, ["-Yes"]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.ok(!existsSync(join(env.bridge, "src")));
    assert.ok(!existsSync(join(env.dir, ".cloudflared-token")));
    assert.ok(existsSync(join(env.bridge, "db.sqlite")));
    r = runPs(env, ["-Yes", "-Purge"]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.ok(!existsSync(env.dir));
    assert.ok(!existsSync(join(env.home, "Library/conduit-bridge")));
    assert.ok(existsSync(join(env.home, ".claude/history.jsonl")));
  } finally { rmSync(env.home, { recursive: true, force: true }); }
});
