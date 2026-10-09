// The macOS/Linux uninstaller against a fake home directory laid out the way
// install.sh leaves it. launchctl and systemctl are stand-ins on PATH that only
// record their calls, so the real services of the machine running the tests
// are never touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync, renameSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../src/uninstall.sh", import.meta.url));
const skip = process.platform === "win32" && "uninstall.sh is for macOS and Linux";
const mac = process.platform === "darwin";

function setup() {
  // realpath: the script works with canonical paths (/private/var on macOS).
  const home = realpathSync(mkdtempSync(join(tmpdir(), "conduit-uninstall-")));
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
  // Guard for the test machine: rm and rmdir only act inside the fake home.
  // Anything else is refused and recorded, so a faulty path check in the
  // script can never reach real files (it once tried \`rm -rf //\`).
  for (const tool of ["rm", "rmdir"]) {
    writeFileSync(join(bin, tool), `#!/bin/sh
for a in "$@"; do
  case "$a" in -*) continue ;; esac
  case "$a" in "${home}"/*) ;; *) echo "${tool} $a" >> "${join(home, "outside.log")}"; exit 1 ;; esac
done
exec /bin/${tool} "$@"
`);
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
const outside = (env) => existsSync(join(env.home, "outside.log")) ? readFileSync(join(env.home, "outside.log"), "utf8") : "";

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
const psExes = ["pwsh", ...(process.platform === "win32" ? ["powershell"] : [])]
  .filter((exe) => spawnSync(exe, ["-NoProfile", "-Command", "exit 0"], { stdio: "ignore" }).status === 0);
const psExe = psExes[0];
const runPs = (env, args, exe = psExe) => spawnSync(exe, ["-NoProfile", "-NonInteractive", "-Command",
  `Set-Variable -Name HOME -Value '${env.home.replace(/'/g, "''")}' -Force -Scope Global -ErrorAction SilentlyContinue; & '${PS1.replace(/'/g, "''")}' ${args.join(" ")}; exit $LASTEXITCODE`],
{ encoding: "utf8", env: { ...process.env, CONDUIT_DIR: join(env.home, ".conduit") } });

test("--purge never deletes the home directory or anything above it, however the path is written", { skip }, () => {
  const variants = (home) => [
    `${home}//`, `${home}///`, `${home}/.`, `${home}/./`, `${home}/Library/..`, `${home}/Library/../`,
    `${home}/./Library/../`, "/", "//", join(home, ".."), `${join(home, "..")}/`,
  ];
  const probe = setup();
  const list = variants(probe.home).map((v) => v.replaceAll(probe.home, "<HOME>"));
  rmSync(probe.home, { recursive: true, force: true });
  for (const tpl of list) {
    const env = setup();
    try {
      const v = tpl.replaceAll("<HOME>", env.home);
      // The bridge configuration names the dangerous path for every data directory.
      writeFileSync(join(env.bridge, ".env.local"), `DB_DIR=${env.bridge}\nPASTE_DIR=${v}\nLOG_DIR=${v}\n`);
      const r = run(env, ["--purge", "--yes"]);
      assert.equal(r.status, 0, `${tpl}: ${r.stderr}`);
      assert.match(r.stderr, /Skipping unsafe path/, tpl);
      // The home directory and things in it that are not Conduit's survive.
      assert.ok(existsSync(join(env.home, ".claude/history.jsonl")), `${tpl}: home content deleted`);
      assert.ok(existsSync(join(env.home, "Library/LaunchAgents/com.other.agent.plist")), `${tpl}: other agent deleted`);
      assert.ok(existsSync(env.home), tpl);
      assert.equal(outside(env), "", `${tpl}: tried to remove outside the fake home`);
    } finally { rmSync(env.home, { recursive: true, force: true }); }
  }
});

test("--purge through a symlinked data directory removes only the link", { skip }, () => {
  const env = setup();
  try {
    const link = join(env.home, "Library/conduit-bridge/pastes-link");
    symlinkSync(env.home, link);
    writeFileSync(join(env.bridge, ".env.local"), `DB_DIR=${env.bridge}\nPASTE_DIR=${link}\n`);
    const r = run(env, ["--purge", "--yes"]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!existsSync(link), "the link itself is removed");
    assert.ok(existsSync(join(env.home, ".claude/history.jsonl")), "the link target is untouched");
  } finally { rmSync(env.home, { recursive: true, force: true }); }
});

test("--purge refuses paths that pass through a link and does not follow a linked log directory", { skip }, () => {
  const env = setup();
  try {
    // alias -> parent of home, so alias/<home name> is the home directory.
    const alias = join(env.home, "Library", "alias");
    symlinkSync(join(env.home, ".."), alias);
    const homeViaAlias = join(alias, basename(env.home));
    // A log directory that is a link to a folder with files of the same names.
    const other = join(env.home, "elsewhere");
    mkdirSync(other);
    for (const n of ["bridge.log", "bridge.log.1", "keep.txt"]) writeFileSync(join(other, n), "x");
    const logLink = join(env.home, "Library", "loglink");
    symlinkSync(other, logLink);
    writeFileSync(join(env.bridge, ".env.local"), `DB_DIR=${env.bridge}\nPASTE_DIR=${homeViaAlias}\nLOG_DIR=${logLink}\n`);
    const r = run(env, ["--purge", "--yes"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /Skipping unsafe path/);
    assert.equal(outside(env), "");
    assert.ok(existsSync(join(env.home, ".claude/history.jsonl")), "home content kept");
    for (const n of ["bridge.log", "bridge.log.1", "keep.txt"]) assert.ok(existsSync(join(other, n)), `${n} in the link target kept`);
  } finally { rmSync(env.home, { recursive: true, force: true }); }
});

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

test("uninstall.ps1: the home directory or anything above it is refused, however written (dry run only)", { skip: !psExe && "no PowerShell installed" }, () => {
  const probe = setup();
  const tpls = [`${probe.home}//`, `${probe.home}/.`, `${probe.home}/Library/..`, join(probe.home, ".."), `${join(probe.home, "..")}/`, "/"]
    .map((v) => v.replaceAll(probe.home, "<HOME>"));
  rmSync(probe.home, { recursive: true, force: true });
  for (const tpl of tpls) {
    const env = setup();
    renameSync(join(env.bridge, "start.sh"), join(env.bridge, "start.ps1"));
    try {
      const v = tpl.replaceAll("<HOME>", env.home);
      writeFileSync(join(env.bridge, ".env.local"), `DB_DIR=${env.bridge}\nPASTE_DIR=${v}\nLOG_DIR=${v}\n`);
      const r = runPs(env, ["-DryRun", "-Purge"]);
      assert.equal(r.status, 0, `${tpl}: ${r.stderr}${r.stdout}`);
      assert.match(r.stderr + r.stdout, /Skipping unsafe path/, tpl);
      // In the list of things to delete there is no entry that is the home directory or above it.
      const listed = (r.stdout.split(/Data to DELETE/)[1] || "").split("\n").map((l) => l.trim()).filter(Boolean);
      for (const line of listed) assert.ok(!(env.home + "/").startsWith(line.replace(/\/+$/, "") + "/"), `${tpl}: would delete ${line}`);
      assert.ok(existsSync(join(env.home, ".claude/history.jsonl")));
    } finally { rmSync(env.home, { recursive: true, force: true }); }
  }
});

// A real -Purge with links, under every PowerShell on the machine (on the
// Windows CI: Windows PowerShell 5.1 and pwsh). Links are junctions on
// Windows and symbolic links elsewhere; their targets must survive.
for (const exe of psExes) {
  test(`uninstall.ps1 (${exe}): -Purge removes links as links, their targets stay`, () => {
    const env = setup();
    renameSync(join(env.bridge, "start.sh"), join(env.bridge, "start.ps1"));
    renameSync(join(env.dir, "tunnel.sh"), join(env.dir, "tunnel.ps1"));
    const precious = join(env.home, "precious");
    const precious2 = join(env.home, "precious2");
    mkdirSync(precious); mkdirSync(precious2);
    writeFileSync(join(precious, "keep.txt"), "keep");
    writeFileSync(join(precious2, "keep.txt"), "keep");
    const type = process.platform === "win32" ? "junction" : "dir";
    // A link inside a data directory that -Purge deletes recursively (the
    // speech models), and a data directory that is itself a link.
    symlinkSync(precious, join(env.dir, "models", "linked-inside"), type);
    const pasteLink = join(env.home, "Library/conduit-bridge/pastes-link");
    symlinkSync(precious2, pasteLink, type);
    writeFileSync(join(env.bridge, ".env.local"), `DB_DIR=${env.bridge}\nPASTE_DIR=${pasteLink}\n`);
    try {
      const r = runPs(env, ["-Yes", "-Purge"], exe);
      assert.equal(r.status, 0, r.stderr + r.stdout);
      assert.ok(!existsSync(join(env.dir, "models")), "the data directory with the inner link is removed");
      assert.ok(!existsSync(pasteLink), "the linked data directory is removed as a link");
      assert.equal(readFileSync(join(precious, "keep.txt"), "utf8"), "keep", "target of the inner link untouched");
      assert.equal(readFileSync(join(precious2, "keep.txt"), "utf8"), "keep", "target of the linked data directory untouched");
      assert.ok(existsSync(join(env.home, ".claude/history.jsonl")));
    } finally { rmSync(env.home, { recursive: true, force: true }); }
  });
}

for (const exe of psExes) {
  test(`uninstall.ps1 (${exe}): -Purge refuses a path through a link and a linked log directory`, () => {
    const env = setup();
    renameSync(join(env.bridge, "start.sh"), join(env.bridge, "start.ps1"));
    renameSync(join(env.dir, "tunnel.sh"), join(env.dir, "tunnel.ps1"));
    const type = process.platform === "win32" ? "junction" : "dir";
    const alias = join(env.home, "Library", "alias");
    symlinkSync(join(env.home, ".."), alias, type);
    const homeViaAlias = join(alias, basename(env.home));
    const other = join(env.home, "elsewhere");
    mkdirSync(other);
    for (const n of ["bridge.log", "bridge.log.1", "keep.txt"]) writeFileSync(join(other, n), "x");
    const logLink = join(env.home, "Library", "loglink");
    symlinkSync(other, logLink, type);
    writeFileSync(join(env.bridge, ".env.local"), `DB_DIR=${env.bridge}\nPASTE_DIR=${homeViaAlias}\nLOG_DIR=${logLink}\n`);
    try {
      const r = runPs(env, ["-Yes", "-Purge"], exe);
      assert.equal(r.status, 0, r.stderr + r.stdout);
      assert.match(r.stderr + r.stdout, /Skipping unsafe path/);
      assert.ok(existsSync(join(env.home, ".claude/history.jsonl")), "home content kept");
      for (const n of ["bridge.log", "bridge.log.1", "keep.txt"]) assert.ok(existsSync(join(other, n)), `${n} in the link target kept`);
    } finally { rmSync(env.home, { recursive: true, force: true }); }
  });
}
