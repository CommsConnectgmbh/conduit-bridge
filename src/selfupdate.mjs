// Bridge self-update.
//
// The bridge is shipped as bridge.tar.gz served from the app origin. Older
// installs used to need a manual reinstall to pick up a fix; this module lets a
// running bridge notice a newer package on the origin and update itself in place.
//
// Flow (checkAndStage):
//   1. download the tarball to <installDir>/.selfupdate/bridge.tar.gz
//   2. verify its signature, inspect it, extract it, read the shipped version
//   3. if it's not strictly newer than the running version → clean up, no-op
//   4. if the dependencies changed, install them from the release's lockfile
//      into a separate directory first (`npm ci`, no lifecycle scripts), so a
//      failed install leaves the running bridge untouched
//   5. back up src/ (with subdirectories), package.json and package-lock.json,
//      copy the new files over them, and swap in the new node_modules
//   6. on any failure, restore the backup so the bridge stays on the old version
//
// Release channels: bridges before 3.0 read /bridge.tar.gz. Their updater only
// copies files directly in src/ and finds npm on PATH, which a launchd job
// usually does not have. That URL therefore stays frozen on a stepping-stone
// release (3.0.0: flat src/, the 2.x dependency set, so no npm run), and every
// 3.x bridge reads its own channel, /bridge/v3/bridge.tar.gz.
//
// The caller decides whether to restart: under a process supervisor (launchd /
// systemd) a plain process.exit(0) is enough — the supervisor relaunches with
// the new code. Without a supervisor we leave the new files staged and applied
// on the next manual restart, rather than exiting into a dead bridge.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createPublicKey, verify as ed25519Verify } from "node:crypto";
import { createReadStream } from "node:fs";
import { createGunzip } from "node:zlib";
import {
  existsSync, mkdirSync, rmSync, writeFileSync, readFileSync, copyFileSync, readdirSync,
  chmodSync, statSync, renameSync, realpathSync, rmdirSync,
} from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));   // .../bridge/src
export const DEFAULT_INSTALL_DIR = dirname(HERE);        // .../bridge

// --- Release signing / update authenticity ---------------------------------
// The tarball is served from the app origin. A gzip-magic-bytes check only
// proves it's *a* gzip, not that WE produced it — anyone who can MITM the origin
// (or the origin itself, if compromised) could ship arbitrary code that the
// bridge then runs with bypassPermissions. To close that, we verify a detached
// Ed25519 signature (bridge.tar.gz.sig, base64) against a PINNED public key.
//
// Enforcement is MANDATORY as of 2.12.0 — there is no environment opt-out. Signed releases went live in 2.7.0
// and the pin ships in this file, so every install that can read this line can
// also verify. Leaving it best-effort meant a compromised origin (or anything
// able to answer for it) could still ship code that runs with bypassPermissions
// — the pin protected nobody by default.
//   • default                     → fail-closed: a missing or invalid signature,
//     or a missing pinned key, rejects the update outright.
//   To develop against unsigned builds, disable self-update entirely with
//   CONDUIT_SELFUPDATE=0.
//
// Consequence to respect when releasing: publishing bridge.tar.gz WITHOUT its
// .sig now stops the update chain for everyone. That is the intended failure
// direction — no update beats an unverified update. See RELEASE_SIGNING.md.
//
// The PINNED public key is injected via BRIDGE_UPDATE_PUBKEY (PEM/SPKI) or pasted
// into PINNED_UPDATE_PUBKEY once signing is live. NEVER commit a PRIVATE key, and
// never place the private key on the origin/server. See RELEASE_SIGNING.md.
// Pinned release key (Ed25519, SPKI). Public by nature — safe to commit, and it
// MUST be committed: shipping the pin in the code is what lets an install verify
// the next update without any per-machine configuration. The matching private
// key is offline and never touches this repo or the origin serving the tarball.
// Rotating it means shipping a version with the new pin BEFORE signing releases
// with the new key, otherwise older installs reject the update.
const PINNED_UPDATE_PUBKEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAe332TZjedlQOrMyqFj9TDzTGwvxonbBpglrA5MQf470=
-----END PUBLIC KEY-----`;
// The compiled-in pin WINS. An env override was convenient before a pin
// existed, but leaving it ahead of the pin meant anything that can set the
// service environment could substitute its own signing key — which quietly
// turns the whole verification into a formality.
// The compiled-in pin wins, and if it is ever emptied by a refactor we do NOT
// quietly hand key selection to the environment — that would make anything able
// to set the service env the signing authority.
const UPDATE_PUBKEY_RAW = (() => {
  if (PINNED_UPDATE_PUBKEY) return PINNED_UPDATE_PUBKEY;
  if (process.env.BRIDGE_UPDATE_PUBKEY) {
    console.warn("[conduit] no pinned update key compiled in — refusing the BRIDGE_UPDATE_PUBKEY override; updates stay disabled until a pin is shipped");
  }
  return "";
})();
// No opt-out. An env var that switches verification off is not a hardening
// option, it is a documented way in: the same environment control that sets it
// also picks which `npm` and `tar` run, and npm executes lifecycle scripts from
// the downloaded package before the new bridge ever starts. To develop against
// an unsigned build, disable self-update entirely (CONDUIT_SELFUPDATE=0) rather
// than accepting unverified code.
const REQUIRE_SIG = true;

function loadPubkey(raw) {
  if (!raw) return null;
  // Env vars often carry PEM with literal "\n"; normalise before parsing.
  const pem = raw.includes("BEGIN") ? raw.replace(/\\n/g, "\n") : raw;
  try { return createPublicKey(pem); } catch { return null; }
}
const UPDATE_PUBKEY = loadPubkey(UPDATE_PUBKEY_RAW);

// Fetch the detached base64 signature that sits next to the tarball. Returns the
// raw signature Buffer, or null when it's absent/unreadable (a SPA origin may
// answer 200 + HTML for a missing .sig — that decodes to garbage and simply
// fails verification, which is the safe outcome).
async function fetchSig(url, timeoutMs = 15_000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ac.signal, redirect: "follow" });
    if (!r.ok) return null;
    // An Ed25519 signature is 64 bytes, so ~88 base64 characters. Reading the
    // body unbounded meant a hostile or broken origin could answer the .sig
    // request with gigabytes and take the process out on memory alone.
    const declared = parseInt(r.headers.get("content-length") || "0", 10);
    if (declared && declared > MAX_SIG_BYTES) return null;
    const chunks = [];
    let received = 0;
    for await (const chunk of r.body) {
      received += chunk.length;
      if (received > MAX_SIG_BYTES) { try { ac.abort(); } catch {} return null; }
      chunks.push(Buffer.from(chunk));
    }
    const txt = Buffer.concat(chunks).toString("utf8").trim();
    if (!txt) return null;
    const buf = Buffer.from(txt, "base64");
    return buf.length ? buf : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// Verify the tarball bytes against the pinned Ed25519 key.
// @returns {{ok:boolean, reason:string}}
function verifyTarballSig(data, sig, key = UPDATE_PUBKEY) {
  if (!key) return { ok: false, reason: "no pinned public key configured" };
  if (!sig) return { ok: false, reason: "no signature artifact" };
  try {
    const ok = ed25519Verify(null, data, key, sig);
    return ok ? { ok: true, reason: "" } : { ok: false, reason: "signature did not verify against pinned key" };
  } catch (e) {
    return { ok: false, reason: "verify error: " + String(e?.message || e) };
  }
}

function parseVer(v) {
  // Strip the pre-release/build suffix, and remember that it was there.
  //
  // The previous attempt only stripped it — which changes nothing, because
  // parseInt("0-beta") is already 0. 1.3.0-beta therefore still compared EQUAL
  // to 1.3.0, so a machine that ever ran a pre-release treated the real release
  // as "up-to-date" and silently stopped taking fixes on that line. A release
  // must outrank its own pre-release, so that flag becomes the tie-breaker.
  const raw = String(v || "0");
  const isPre = /[-+]/.test(raw);
  const nums = raw.split(/[-+]/)[0].split(".").map((n) => parseInt(n, 10) || 0);
  return [nums[0] || 0, nums[1] || 0, nums[2] || 0, isPre ? 0 : 1];
}
// strictly-greater semver-ish compare (x.y.z); pre-release tags are ignored.
export function isNewer(a, b) {
  const A = parseVer(a), B = parseVer(b);
  for (let i = 0; i < 4; i++) {   // 4th element: release (1) outranks pre-release (0)
    if ((A[i] || 0) > (B[i] || 0)) return true;
    if ((A[i] || 0) < (B[i] || 0)) return false;
  }
  return false;
}

/**
 * Installed version, or null when it cannot be determined.
 *
 * Returning "0.0.0" on failure — as this used to — turns an unreadable or
 * half-written package.json into a downgrade primitive: every older signed
 * tarball then looks newer, so a replayed release with a known hole installs
 * itself and logs selfupdate_sig_ok on the way in. The signature covers the
 * bytes, not the version, so nothing else would catch it. Callers must treat
 * null as "do not update".
 */
export function readVersion(dir) {
  try {
    const v = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version;
    return typeof v === "string" && v ? v : null;
  } catch { return null; }
}

function depsOf(pkg) {
  return JSON.stringify({
    d: pkg?.dependencies || {},
    o: pkg?.optionalDependencies || {},
  });
}

/** Like run(), but returns stdout (or null on failure). */
function runCapture(cmd, args, opts) {
  return new Promise((resolve) => {
    let p;
    try { p = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"], ...opts }); }
    catch { return resolve(null); }
    // Without this a `tar` that never exits leaves the promise pending forever,
    // and since checkAndStage holds an in-progress flag, the update chain stops
    // permanently — silently, because nothing errors.
    const killer = setTimeout(() => { try { p.kill("SIGKILL"); } catch {} }, 60_000);
    killer.unref?.();
    const done = (v) => { clearTimeout(killer); resolve(v); };
    let out = "";
    let truncated = false;
    p.stdout.on("data", (d) => {
      out += d.toString();
      // Silently dropping the tail turned both archive checks into a check of
      // the archive's FIRST megabyte only — a link member placed after that
      // point was never seen, while extraction still unpacked the whole thing.
      if (out.length > MAX_LISTING_BYTES) { truncated = true; try { p.kill("SIGKILL"); } catch {} }
    });
    p.on("exit", (code) => done(truncated ? null : (code === 0 ? out : null)));
    p.on("error", () => done(null));
  });
}

const MAX_LISTING_BYTES = 4 * 1024 * 1024;
const MAX_SIG_BYTES = 4096;   // a 64-byte Ed25519 signature in base64

/**
 * Bytes a gzip stream expands to, giving up once `cap` is exceeded.
 * Streaming, so a bomb costs bounded work and never touches the disk.
 * @returns {Promise<number|null>} byte count, cap+1 when over, null on error.
 */
function gunzippedSize(path, cap) {
  return new Promise((resolve) => {
    let total = 0;
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    let src, gunzip;
    try {
      src = createReadStream(path);
      gunzip = createGunzip();
    } catch { return done(null); }
    src.on("error", () => done(null));
    gunzip.on("error", () => {
      // pipe() does not tear down the source when the destination errors, so a
      // non-gzip file was still read to EOF for nothing.
      try { src.destroy(); } catch {}
      done(null);
    });
    gunzip.on("data", (chunk) => {
      total += chunk.length;
      if (total > cap) {
        try { src.destroy(); gunzip.destroy(); } catch {}
        done(cap + 1);
      }
    });
    gunzip.on("end", () => done(total));
    src.pipe(gunzip);
  });
}

/**
 * Inspect the archive before unpacking it.
 *
 * The signature proves the tarball is ours; it does not prove the tarball is
 * sane, and `tar xzf` on its own will happily follow a symlink member or an
 * absolute path out of the staging directory. Cheap to check, and it keeps a
 * single bad release from writing outside the install dir.
 *
 * Deliberately avoids parsing the columns of `tar tv` output: BSD and GNU tar
 * lay them out differently and the month name is localised, so a size parsed
 * from there silently comes out as 0 — a check that always passes. Names come
 * from `tar tzf` (one per line, no formatting), the member type from the first
 * character of `tar tvzf` (stable across both), and the unpacked size from a
 * capped gzip stream, which also bounds decompression: the download cap covers
 * compressed bytes only, so a gzip bomb would otherwise fill the disk.
 */
async function inspectTarball(tgz) {
  const names = await runCapture("tar", ["tzf", tgz]);
  if (names === null) return { ok: false, reason: "cannot list archive" };
  for (const raw of names.split("\n")) {
    const name = raw.trim();
    if (!name) continue;
    if (name.startsWith("/") || name.split("/").includes("..")) {
      return { ok: false, reason: `member escapes the staging dir: ${name.slice(0, 80)}` };
    }
    if (name !== "bridge" && name !== "bridge/" && !name.startsWith("bridge/")) {
      return { ok: false, reason: `unexpected member: ${name.slice(0, 80)}` };
    }
  }

  const verbose = await runCapture("tar", ["tvzf", tgz]);
  if (verbose === null) return { ok: false, reason: "cannot list archive" };
  for (const line of verbose.split("\n")) {
    if (!line.trim()) continue;
    const type = line[0];
    // 'l' symlink, 'h' hardlink — both can redirect writes outside the stage.
    if (type === "l" || type === "h") {
      return { ok: false, reason: "archive contains a link member" };
    }
  }

  // Decompressed size, measured in-process. The previous version shelled out to
  // `gzip -dc … | head -c … | wc -c` and quoted the path with JSON.stringify —
  // which is JSON quoting, not shell quoting: inside double quotes `$(...)` and
  // backticks still execute, so an install path containing them would have run
  // whatever it contained. No shell here at all, so there is nothing to quote.
  const unpacked = await gunzippedSize(tgz, MAX_UNPACKED_BYTES);
  if (unpacked === null) return { ok: false, reason: "cannot size archive" };
  if (unpacked > MAX_UNPACKED_BYTES) {
    return { ok: false, reason: `archive unpacks past ${MAX_UNPACKED_BYTES} bytes` };
  }
  return { ok: true, unpacked };
}

function run(cmd, args, opts = {}) {
  const { timeoutMs = 120_000, ...spawnOpts } = opts;
  return new Promise((resolve) => {
    let p;
    try { p = spawn(cmd, args, { stdio: "ignore", ...spawnOpts }); }
    catch { return resolve(false); }
    // A hung child would hold updateInProgress forever and stop the chain.
    const killer = setTimeout(() => { try { p.kill("SIGKILL"); } catch {} }, timeoutMs);
    killer.unref?.();
    p.on("exit", (code) => { clearTimeout(killer); resolve(code === 0); });
    p.on("error", () => { clearTimeout(killer); resolve(false); });
  });
}

/**
 * How to run npm: through the Node binary that runs this bridge and the npm
 * that ships next to it. A launchd or systemd job has a minimal PATH, and on
 * Windows npm is a .cmd file that spawn() cannot start without a shell, so
 * "npm" on PATH failed exactly where updates run unattended.
 * @returns {{cmd:string, pre:string[]}|null}
 */
export function npmCommand(execPath = process.execPath) {
  let real = execPath;
  try { real = realpathSync(execPath); } catch {}
  const dir = dirname(real);
  // Homebrew keeps npm outside the node keg, behind a bin/npm symlink.
  let linked = null;
  try { linked = realpathSync(join(dir, "npm")); } catch {}
  for (const cli of [
    join(dir, "node_modules", "npm", "bin", "npm-cli.js"),             // Windows
    join(dir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"), // nodejs.org, nvm, Linux
    linked && linked.endsWith("npm-cli.js") ? linked : null,            // Homebrew
  ]) {
    if (cli && existsSync(cli)) return { cmd: execPath, pre: [cli] };
  }
  return process.platform === "win32" ? null : { cmd: "npm", pre: [] };
}

/**
 * Install the release's dependencies from its lockfile into `dir`, which holds
 * a copy of the release's package.json and package-lock.json. `npm ci` uses
 * exactly the locked versions and integrity hashes; --ignore-scripts because no
 * dependency of the bridge needs an install script, and an install script is
 * code that would run before the new bridge is ever started.
 */
async function installDeps(dir, log) {
  const npm = npmCommand();
  if (!npm) throw new Error("npm not found next to node");
  const ok = await run(npm.cmd, [...npm.pre, "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: dir, timeoutMs: 10 * 60_000,
  });
  if (!ok) throw new Error("npm ci failed");
  log("info", "selfupdate_deps_installed", {});
}

// Fetch the tarball and validate it's actually a gzip before handing it on.
// A SPA origin (app.tryconduit.de) can answer 200 with an HTML shell for a
// missing/misrouted asset; writing that as bridge.tar.gz only blows up later at
// `tar xzf` ("extract failed") and spams the log every cycle. We detect a
// non-gzip payload up front — primarily by the gzip magic bytes (1f 8b), with
// content-type as a secondary signal — and report it as a soft skip so the
// caller treats it as "nothing to update", not an error.
// @returns {Promise<{ok:true, buf:Buffer} | {ok:false, reason:string}>}
const MAX_TARBALL_BYTES = 8 * 1024 * 1024;   // real package is ~30 KB compressed
const MAX_UNPACKED_BYTES = 64 * 1024 * 1024; // and far less unpacked

async function fetchTarball(url, timeoutMs = 30_000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ac.signal, redirect: "follow" });
    if (!r.ok) return { ok: false, reason: "http " + r.status };
    const ct = (r.headers.get("content-type") || "").toLowerCase();
    const declared = parseInt(r.headers.get("content-length") || "0", 10);
    if (declared && declared > MAX_TARBALL_BYTES) {
      return { ok: false, reason: `tarball too large (${declared}B)` };
    }
    // Stream with a hard byte cap instead of arrayBuffer(). The timeout bounds
    // time, not bytes: an origin serving an endless response would otherwise be
    // buffered into memory until the process dies. Real tarball is ~30 KB.
    const chunks = [];
    let received = 0;
    for await (const chunk of r.body) {
      received += chunk.length;
      if (received > MAX_TARBALL_BYTES) {
        try { ac.abort(); } catch {}
        return { ok: false, reason: `tarball exceeded ${MAX_TARBALL_BYTES}B — aborted` };
      }
      chunks.push(Buffer.from(chunk));
    }
    const buf = Buffer.concat(chunks);
    const isGzip = buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b;
    const htmlish = ct.includes("text/html") || ct.includes("application/xml") || ct.includes("application/json");
    if (!isGzip || htmlish) {
      return { ok: false, reason: `origin served ${ct || "unknown"} (${buf.length}B), not a gzip tarball` };
    }
    return { ok: true, buf };
  } catch (e) {
    return { ok: false, reason: String(e?.message || e) };
  } finally {
    clearTimeout(t);
  }
}

/**
 * Mirror a source directory: copy every file, and remove files the new release
 * no longer ships.
 *
 * Copying only `*.mjs` meant a release that added any other file (a JSON table,
 * a template) installed a half version that crashed on start, and a release
 * that DELETED a module left the old file in place — still importable, still
 * running whatever it contained, while the update reported success.
 */
const MANIFEST_NAME = ".installed-files.json";

function readManifest(installDir) {
  try {
    const v = JSON.parse(readFileSync(join(installDir, MANIFEST_NAME), "utf8"));
    return Array.isArray(v?.src) ? v.src : null;
  } catch { return null; }
}

function writeManifest(installDir, files) {
  try {
    writeFileSync(join(installDir, MANIFEST_NAME), JSON.stringify({ src: [...files].sort() }, null, 2));
  } catch (e) { /* non-fatal: next update just won't prune */ }
}

// src/ files of 2.x releases that 3.x no longer ships (old device pairing).
const RETIRED_FILES = ["pairing.mjs"];

// One path segment of a shipped file: no hidden files, no "..", nothing a
// manifest entry could use to point outside src/.
const SEGMENT_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

function safeRel(rel) {
  return typeof rel === "string" && rel.length > 0 && rel.length < 512 && rel.split("/").every((p) => SEGMENT_RE.test(p));
}

/** Relative paths ("a.mjs", "data/b.json") of every regular file under dir. */
function listFiles(dir, base = "") {
  const out = [];
  for (const f of readdirSync(join(dir, base), { withFileTypes: true })) {
    const rel = base ? `${base}/${f.name}` : f.name;
    if (f.isDirectory()) out.push(...listFiles(dir, rel));
    else if (f.isFile()) out.push(rel);
    // Anything else (a symlink) is skipped; the archive check refuses links.
  }
  return out;
}

function copyFile(from, to) {
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
  // copyFileSync does not carry the mode across, so an executable shipped by
  // a release arrived without its +x bit.
  try { chmodSync(to, statSync(from).mode & 0o777); } catch {}
}

/** Remove directories under root that became empty, deepest first. */
function pruneEmptyDirs(root, base = "") {
  for (const f of readdirSync(join(root, base), { withFileTypes: true })) {
    if (!f.isDirectory()) continue;
    const rel = base ? `${base}/${f.name}` : f.name;
    pruneEmptyDirs(root, rel);
    try { rmdirSync(join(root, rel)); } catch { /* not empty */ }
  }
}

/**
 * Install the release's src/ tree and remove files a PREVIOUS RELEASE installed
 * that this release no longer ships.
 *
 * Pruning is manifest-driven on purpose. Deleting "every file here that isn't in
 * the new release" also deletes anything the operator keeps alongside the code —
 * a local patch module, a fixture, a scratch file — silently and unrecoverably,
 * since the work directory is removed afterwards. With no manifest (first update
 * after this change) only RETIRED_FILES are pruned.
 */
function copyTree(fromSrcDir, toSrcDir, opts = {}) {
  mkdirSync(toSrcDir, { recursive: true });
  const incoming = new Set();
  for (const rel of listFiles(fromSrcDir)) {
    if (!safeRel(rel)) throw new Error(`release ships an unexpected file name: ${rel.slice(0, 80)}`);
    incoming.add(rel);
    copyFile(join(fromSrcDir, rel), join(toSrcDir, rel));
  }
  // Modules that releases from before the manifest shipped and no release
  // ships any more. Without a manifest they would stay behind as dead code.
  const previous = [...(opts.previous || []), ...RETIRED_FILES];
  for (const rel of previous) {
    if (incoming.has(rel) || !safeRel(rel)) continue;
    try { rmSync(join(toSrcDir, rel), { force: true }); } catch {}
  }
  pruneEmptyDirs(toSrcDir);
  return incoming;
}

/** Make dir hold exactly the files of backupDir (both are src/ trees). */
function restoreTree(backupDir, dir) {
  const keep = new Set(listFiles(backupDir));
  // Remove what the failed release added. Copying the old files back while
  // leaving the new ones in place produced a tree no release ever shipped —
  // old code next to new modules, reporting the old version.
  for (const rel of listFiles(dir)) {
    if (!keep.has(rel)) { try { rmSync(join(dir, rel), { force: true }); } catch {} }
  }
  for (const rel of keep) copyFile(join(backupDir, rel), join(dir, rel));
  pruneEmptyDirs(dir);
}

function readOptional(path) {
  try { return readFileSync(path); } catch { return null; }
}

/**
 * Check the origin for a newer bridge and apply it in place.
 * @returns {Promise<{updated:boolean, from:string, to:string, npm?:boolean, reason?:string}>}
 */
// Interval tick and manual trigger share one staging directory, and each one
// rmSync's it on entry — running both at once meant one wiped the other's
// half-applied tree.
let updateInProgress = false;

export async function checkAndStage(opts) {
  if (updateInProgress) {
    return { updated: false, from: "unknown", to: "unknown", reason: "another update is already running" };
  }
  updateInProgress = true;
  try {
    return await checkAndStageInner(opts);
  } finally {
    updateInProgress = false;
  }
}

/**
 * `verifyKey` and `installDepsImpl` exist for the tests only (a test key, no
 * network); the server passes neither, so the compiled-in pin and real npm apply.
 *
 * `apply: false` and `maxVersion` are the operator's update policy
 * (update-policy.mjs). Both act only AFTER the signature check: a release is
 * reported as available only when it is genuinely signed, and holding it back
 * never needs anything but the version it carries.
 */
async function checkAndStageInner({ url, installDir = DEFAULT_INSTALL_DIR, log = () => {}, verifyKey, installDepsImpl = installDeps, apply = true, maxVersion = null }) {
  const from = readVersion(installDir);
  // Unknown installed version → no basis for "is this newer". Skip rather than
  // guess: guessing is how a replayed old release gets installed.
  if (!from) {
    log("error", "selfupdate_version_unreadable", { installDir });
    return { updated: false, from: "unknown", to: "unknown", reason: "installed version unreadable" };
  }
  const work = join(installDir, ".selfupdate");
  // Update path: a stale work dir that won't clear can silently corrupt the
  // staged copy — log instead of swallowing (mkdir below still runs recursive).
  try { rmSync(work, { recursive: true, force: true }); }
  catch (e) { log("warn", "selfupdate_cleanup_failed", { err: String(e?.message || e) }); }
  mkdirSync(work, { recursive: true });

  const tgz = join(work, "bridge.tar.gz");
  const dl = await fetchTarball(url);
  if (!dl.ok) {
    // Origin isn't serving a real tarball right now (SPA fallback, redeploy,
    // transient error). Not our bug to fix here — skip quietly, retry next cycle.
    rmSync(work, { recursive: true, force: true });
    log("info", "selfupdate_skip", { reason: dl.reason });
    return { updated: false, from, to: from, reason: dl.reason };
  }
  writeFileSync(tgz, dl.buf);

  // Authenticity gate: verify the detached Ed25519 signature BEFORE we extract
  // or run any of the shipped code. Fail-closed only when explicitly enforced.
  const sig = await fetchSig(url + ".sig");
  const ver = verifyKey === undefined ? verifyTarballSig(dl.buf, sig) : verifyTarballSig(dl.buf, sig, verifyKey);
  if (!ver.ok) {
    if (REQUIRE_SIG) {
      rmSync(work, { recursive: true, force: true });
      log("error", "selfupdate_sig_rejected", { reason: ver.reason, enforced: true });
      return { updated: false, from, to: from, reason: "signature rejected: " + ver.reason };
    }
    // Signing pipeline not live yet — proceed as before, but make the gap loud
    // so it's visible until BRIDGE_UPDATE_REQUIRE_SIG=1 is switched on.
    log("warn", "selfupdate_sig_unverified", { reason: ver.reason, enforced: false });
  } else {
    log("info", "selfupdate_sig_ok", {});
  }

  const stage = join(work, "stage");
  mkdirSync(stage, { recursive: true });
  const inspected = await inspectTarball(tgz);
  if (!inspected.ok) {
    rmSync(work, { recursive: true, force: true });
    log("error", "selfupdate_archive_rejected", { reason: inspected.reason });
    return { updated: false, from, to: from, reason: "archive rejected: " + inspected.reason };
  }
  if (!(await run("tar", ["xzf", tgz, "-C", stage]))) throw new Error("extract failed");

  const staged = join(stage, "bridge");                 // tarball's top-level dir
  if (!existsSync(join(staged, "package.json"))) throw new Error("bad tarball layout");
  const newPkg = JSON.parse(readFileSync(join(staged, "package.json"), "utf8"));
  const to = newPkg.version || "0.0.0";

  if (!isNewer(to, from)) {
    rmSync(work, { recursive: true, force: true });
    return { updated: false, from, to, reason: "up-to-date" };
  }
  // Pinned: nothing newer than the approved version. A pin below the running
  // version therefore installs nothing at all; there is no downgrade path.
  if (maxVersion && isNewer(to, maxVersion)) {
    rmSync(work, { recursive: true, force: true });
    log("info", "selfupdate_held", { from, to, pin: maxVersion });
    return { updated: false, from, to, available: true, held: true, reason: `held back: newer than the pinned version ${maxVersion}` };
  }
  if (!apply) {
    rmSync(work, { recursive: true, force: true });
    log("info", "selfupdate_available", { from, to });
    return { updated: false, from, to, available: true, reason: "update available, not installed (notify only)" };
  }

  const oldPkg = JSON.parse(readFileSync(join(installDir, "package.json"), "utf8"));
  const newLock = readOptional(join(staged, "package-lock.json"));
  const oldLock = readOptional(join(installDir, "package-lock.json"));
  const depsChanged = depsOf(newPkg) !== depsOf(oldPkg) || (newLock !== null && (oldLock === null || !newLock.equals(oldLock)));

  // Dependencies first, into their own directory: until the swap below, a
  // failed or interrupted install has changed nothing the running bridge uses.
  const deps = join(work, "deps");
  if (depsChanged) {
    // Without the lockfile `npm install` would resolve whatever the registry
    // serves today, unsigned by us. A release with changed dependencies must
    // pin them.
    if (newLock === null) {
      rmSync(work, { recursive: true, force: true });
      log("error", "selfupdate_no_lockfile", { to });
      return { updated: false, from, to: from, reason: "release changes dependencies but ships no package-lock.json" };
    }
    mkdirSync(deps, { recursive: true });
    copyFileSync(join(staged, "package.json"), join(deps, "package.json"));
    copyFileSync(join(staged, "package-lock.json"), join(deps, "package-lock.json"));
    try {
      await installDepsImpl(deps, log);
    } catch (e) {
      rmSync(work, { recursive: true, force: true });
      log("error", "selfupdate_deps_failed", { to, err: String(e?.message || e) });
      return { updated: false, from, to: from, reason: "dependencies failed to install: " + String(e?.message || e) };
    }
  }

  log("info", "selfupdate_apply", { from, to });

  // Back up what we're about to overwrite so a failed apply can roll back.
  const backup = join(work, "backup");
  const src = join(installDir, "src");
  mkdirSync(join(backup, "src"), { recursive: true });
  for (const rel of listFiles(src)) copyFile(join(src, rel), join(backup, "src", rel));
  copyFileSync(join(installDir, "package.json"), join(backup, "package.json"));
  if (oldLock !== null) writeFileSync(join(backup, "package-lock.json"), oldLock);
  const modules = join(installDir, "node_modules");
  const oldModules = join(work, "node_modules.old");
  let swapped = false;

  const restore = () => {
    try {
      restoreTree(join(backup, "src"), src);
      copyFileSync(join(backup, "package.json"), join(installDir, "package.json"));
      if (oldLock !== null) copyFileSync(join(backup, "package-lock.json"), join(installDir, "package-lock.json"));
      else rmSync(join(installDir, "package-lock.json"), { force: true });
      if (swapped) {
        rmSync(modules, { recursive: true, force: true });
        if (existsSync(oldModules)) renameSync(oldModules, modules);
      }
    } catch (e) { log("error", "selfupdate_restore_failed", { err: String(e?.message || e) }); }
  };

  try {
    const installed = copyTree(join(staged, "src"), src, { previous: readManifest(installDir) });
    copyFileSync(join(staged, "package.json"), join(installDir, "package.json"));
    if (newLock !== null) copyFileSync(join(staged, "package-lock.json"), join(installDir, "package-lock.json"));
    if (depsChanged) {
      // Same filesystem (work/ lives inside installDir), so both renames are
      // atomic; the window without a node_modules is two syscalls long.
      if (existsSync(modules)) renameSync(modules, oldModules);
      swapped = true;
      if (existsSync(join(deps, "node_modules"))) renameSync(join(deps, "node_modules"), modules);
    }
    writeManifest(installDir, installed);
  } catch (e) {
    restore();
    rmSync(work, { recursive: true, force: true });
    throw e;
  }

  rmSync(work, { recursive: true, force: true });
  return { updated: true, from, to, npm: depsChanged };
}

/**
 * True when something will restart us after we exit.
 *
 * Deliberately does NOT use `process.ppid === 1`. On macOS every orphaned
 * process is reparented to PID 1, so a bridge started by hand in a terminal
 * looks "supervised" the moment that terminal closes — and then exits for an
 * update that nobody comes back from. XPC_SERVICE_NAME is set by launchd for
 * jobs it actually manages, which is the thing we need to know.
 */
export function isSupervised() {
  if (process.env.CONDUIT_SUPERVISED === "1") return true;
  if (process.env.INVOCATION_ID) return true;                 // systemd
  // A process started by hand in VS Code's or Terminal's shell inherits
  // XPC_SERVICE_NAME from the GUI app that spawned it, so the variable alone
  // still misreads an unsupervised run. A launchd job has no controlling
  // terminal; an interactive start does.
  if (process.stdout.isTTY || process.stdin.isTTY) return false;
  const xpc = process.env.XPC_SERVICE_NAME;                   // launchd
  return !!xpc && xpc !== "0";
}
