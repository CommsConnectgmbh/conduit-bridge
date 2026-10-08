// Native speech runtime: sherpa-onnx (speech to text) and onnxruntime (text to
// speech), installed on demand.
//
// Most bridges never use voice, and the runtime is some 120 MB of native code
// per platform, so it is not a dependency of the bridge. When the user turns
// voice on, it is installed from the pins that ship in the signed bridge
// tarball (speech-runtime.package.json and speech-runtime.lock.json: exact
// versions with integrity hashes) via `npm ci --ignore-scripts`, into a
// directory named after the lockfile's hash. A bridge update with new pins
// therefore installs next to the old runtime and never mixes the two.
//
// Native code that crashes takes the process down with it, so a fresh install
// is first loaded in a child process; the bridge itself only loads a runtime
// that passed that check.

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statfsSync, writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { npmCommand } from "./selfupdate.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = readFileSync(join(HERE, "speech-runtime.package.json"));
const LOCK = readFileSync(join(HERE, "speech-runtime.lock.json"));
const LOCK_HASH = createHash("sha256").update(PKG).update(LOCK).digest("hex").slice(0, 16);

export const RUNTIME_BASE = process.env.CONDUIT_SPEECH_RUNTIME_DIR || join(homedir(), ".conduit", "speech-runtime");
export const RUNTIME_DIR = join(RUNTIME_BASE, LOCK_HASH);
const MARKER = ".verified";

// npm ci moves some 450 MB before the other platforms' binaries are removed.
const INSTALL_BYTES = 600 * 1024 * 1024;
const DISK_RESERVE_BYTES = 1024 * 1024 * 1024;

// Platforms the pinned versions ship binaries for. onnxruntime-node 1.30 has no
// macOS Intel or 32-bit Windows build; sherpa-onnx has no Windows ARM build.
const PLATFORM = `${process.platform}/${process.arch}`;
const STT_PLATFORMS = ["darwin/arm64", "darwin/x64", "linux/x64", "linux/arm64", "win32/x64", "win32/ia32"];
const TTS_PLATFORMS = ["darwin/arm64", "linux/x64", "linux/arm64", "win32/x64", "win32/arm64"];

export const support = Object.freeze({
  platform: PLATFORM,
  stt: STT_PLATFORMS.includes(PLATFORM),
  tts: TTS_PLATFORMS.includes(PLATFORM),
});

export function isRuntimeInstalled() {
  return existsSync(join(RUNTIME_DIR, MARKER));
}

/**
 * The runtime's modules, loaded in this process. Only after an install that
 * passed the child-process check; null for each part that is unavailable.
 */
let loaded = null;
export function loadRuntime() {
  if (loaded) return loaded;
  if (!isRuntimeInstalled()) return { sherpa: null, ort: null, error: "speech runtime not installed" };
  const req = createRequire(join(RUNTIME_DIR, "package.json"));
  const out = { sherpa: null, ort: null, error: null };
  const errors = [];
  if (support.stt) {
    try { out.sherpa = req("sherpa-onnx-node"); } catch (e) { errors.push(`stt: ${e?.message || e}`); }
  }
  if (support.tts) {
    try { out.ort = req("onnxruntime-node"); } catch (e) { errors.push(`tts: ${e?.message || e}`); }
  }
  out.error = errors.length ? errors.join("; ") : null;
  loaded = out;
  return out;
}

function run(cmd, args, { cwd, timeoutMs }) {
  return new Promise((resolve) => {
    let p, err = "";
    try { p = spawn(cmd, args, { cwd, stdio: ["ignore", "ignore", "pipe"] }); }
    catch (e) { return resolve({ ok: false, err: String(e?.message || e) }); }
    p.stderr.on("data", (d) => { if (err.length < 4096) err += d; });
    const killer = setTimeout(() => { try { p.kill("SIGKILL"); } catch {} }, timeoutMs);
    killer.unref?.();
    p.on("exit", (code) => { clearTimeout(killer); resolve({ ok: code === 0, err: err.trim() }); });
    p.on("error", (e) => { clearTimeout(killer); resolve({ ok: false, err: String(e?.message || e) }); });
  });
}

/** Remove onnxruntime binaries for other platforms (roughly 200 MB). */
function pruneForeignBinaries(dir) {
  const root = join(dir, "node_modules", "onnxruntime-node", "bin", "napi-v6");
  if (!existsSync(root)) return;
  for (const os of readdirSync(root)) {
    for (const arch of readdirSync(join(root, os))) {
      if (`${os}/${arch}` !== PLATFORM) rmSync(join(root, os, arch), { recursive: true, force: true });
    }
    if (!readdirSync(join(root, os)).length) rmSync(join(root, os), { recursive: true, force: true });
  }
}

// What the child process checks: both modules load and do a minimal call.
const CHECK = `
const out = {};
if (process.argv[1] === "1") { const s = require("sherpa-onnx-node"); out.stt = typeof s.OfflineRecognizer === "function"; }
if (process.argv[2] === "1") { const o = require("onnxruntime-node"); out.tts = typeof o.InferenceSession?.create === "function"; }
process.stdout.write(JSON.stringify(out));
`;

let installing = null;

/**
 * Install the runtime for this platform. Resolves when it is ready to load;
 * concurrent calls share one install.
 * @param {{ log?: Function }} [opts]
 */
export function installRuntime({ log = () => {} } = {}) {
  if (isRuntimeInstalled()) return Promise.resolve();
  if (!support.stt && !support.tts) return Promise.reject(new Error(`no speech runtime for ${PLATFORM}`));
  installing ??= doInstall(log).finally(() => { installing = null; });
  return installing;
}

async function doInstall(log) {
  mkdirSync(RUNTIME_BASE, { recursive: true });
  const s = statfsSync(RUNTIME_BASE);
  if (s.bavail * s.bsize - INSTALL_BYTES < DISK_RESERVE_BYTES) throw new Error("not enough free disk space for the speech runtime");
  const npm = npmCommand();
  if (!npm) throw new Error("npm not found next to node");

  const tmp = join(RUNTIME_BASE, `.install-${randomBytes(6).toString("hex")}`);
  mkdirSync(tmp);
  try {
    writeFileSync(join(tmp, "package.json"), PKG);
    writeFileSync(join(tmp, "package-lock.json"), LOCK);
    log("info", "speech_runtime_install", { platform: PLATFORM });
    const ci = await run(npm.cmd, [...npm.pre, "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], {
      cwd: tmp, timeoutMs: 15 * 60_000,
    });
    if (!ci.ok) throw new Error(`npm ci failed: ${ci.err.split("\n").slice(-3).join(" ").slice(0, 300)}`);
    pruneForeignBinaries(tmp);

    const check = await new Promise((resolve) => {
      let p, out = "";
      try {
        p = spawn(process.execPath, ["-e", CHECK, support.stt ? "1" : "0", support.tts ? "1" : "0"], { cwd: tmp, stdio: ["ignore", "pipe", "ignore"] });
      } catch { return resolve(null); }
      p.stdout.on("data", (d) => { out += d; });
      const killer = setTimeout(() => { try { p.kill("SIGKILL"); } catch {} }, 60_000);
      p.on("exit", (code) => { clearTimeout(killer); try { resolve(code === 0 ? JSON.parse(out) : null); } catch { resolve(null); } });
      p.on("error", () => { clearTimeout(killer); resolve(null); });
    });
    if (!check || (support.stt && !check.stt) || (support.tts && !check.tts)) {
      throw new Error("the speech runtime does not load on this computer");
    }
    writeFileSync(join(tmp, MARKER), LOCK_HASH);
    rmSync(RUNTIME_DIR, { recursive: true, force: true });
    renameSync(tmp, RUNTIME_DIR);
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    log("error", "speech_runtime_failed", { err: String(e?.message || e) });
    throw e;
  }
  // Runtimes pinned by earlier releases, and installs that were interrupted.
  for (const name of readdirSync(RUNTIME_BASE)) {
    if (name !== LOCK_HASH) rmSync(join(RUNTIME_BASE, name), { recursive: true, force: true });
  }
  log("info", "speech_runtime_ready", { platform: PLATFORM });
}

/** Remove the runtime. A loaded runtime stays in memory until the bridge restarts. */
export function removeRuntime() {
  rmSync(RUNTIME_BASE, { recursive: true, force: true });
}
