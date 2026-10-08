#!/usr/bin/env node
// Build the bridge release tarballs the app origin serves.
//
//   node scripts/build-release.mjs --out <app>/public [--stepping-stone]
//
// Always writes <out>/bridge/v3/bridge.tar.gz: the 3.x channel, built from this
// checkout as it is, with its package-lock.json (installers and the 3.x
// updater run `npm ci` from it).
//
// With --stepping-stone it also writes <out>/bridge.tar.gz, the frozen package
// for bridges older than 3.0. Their updater copies only files directly in src/,
// ignores package-lock.json and, when the dependency list changes, runs "npm"
// from PATH, which a launchd job usually cannot find, and then rolls back. So
// that package is this same code under version 3.0.0 with the 2.x dependency
// list unchanged (no npm run) and must have no subdirectory in src/. Once such
// a bridge runs 3.0.0 it reads the 3.x channel and takes the next release with
// the real dependencies through the new updater.
//
// Sign both afterwards with scripts/sign-release.mjs; see RELEASE_SIGNING.md.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BRIDGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STEPPING_STONE_VERSION = "3.0.0";
// The dependency list of 2.21.1, in its key order: the 2.x updater compares
// JSON.stringify of these two objects, so order is part of "unchanged".
const LEGACY_DEPS = {
  dependencies: { jose: "5.9.6", "node-pty": "^1.0.0", ws: "8.18.0" },
  optionalDependencies: { qrcode: "^1.5.4" },
};
// Limits of every updater in the field (selfupdate.mjs).
const MAX_TARBALL_BYTES = 8 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 64 * 1024 * 1024;
const SHIPPED_TOP_LEVEL = ["LICENSE", "THIRD-PARTY-NOTICES.md", "README.md", "licenses"];

function die(msg) {
  console.error(`[build-release] ${msg}`);
  process.exit(1);
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1] ?? null;
}

function listFiles(dir, base = "") {
  const out = [];
  for (const f of readdirSync(path.join(dir, base), { withFileTypes: true })) {
    if (f.name === ".DS_Store") continue;
    const rel = base ? `${base}/${f.name}` : f.name;
    if (f.isDirectory()) out.push(...listFiles(dir, rel));
    else if (f.isFile()) out.push(rel);
    else die(`not a regular file: src/${rel}`);
  }
  return out.sort();
}

function sameJson(a, b) {
  return JSON.stringify(a ?? {}) === JSON.stringify(b ?? {});
}

/** Commit time of HEAD, so two builds of one commit are byte-identical. */
function sourceDate() {
  if (process.env.SOURCE_DATE_EPOCH) return Number(process.env.SOURCE_DATE_EPOCH);
  const r = spawnSync("git", ["log", "-1", "--format=%ct"], { cwd: BRIDGE, encoding: "utf8" });
  const t = Number(r.stdout?.trim());
  return Number.isFinite(t) && t > 0 ? t : 0;
}

function tarFlavour() {
  const r = spawnSync("tar", ["--version"], { encoding: "utf8" });
  if (r.status !== 0) die("tar not found");
  return /bsdtar/.test(r.stdout) ? "bsd" : "gnu";
}

function build({ outFile, pkg, lock }) {
  const stageRoot = mkdtempSync(path.join(tmpdir(), "conduit-release-"));
  try {
    const stage = path.join(stageRoot, "bridge");
    mkdirSync(stage);
    cpSync(path.join(BRIDGE, "src"), path.join(stage, "src"), {
      recursive: true, filter: (p) => path.basename(p) !== ".DS_Store",
    });
    writeFileSync(path.join(stage, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
    if (lock) writeFileSync(path.join(stage, "package-lock.json"), JSON.stringify(lock, null, 2) + "\n");
    for (const f of SHIPPED_TOP_LEVEL) {
      if (existsSync(path.join(BRIDGE, f))) cpSync(path.join(BRIDGE, f), path.join(stage, f), { recursive: true });
    }

    const files = listFiles(stage);
    const t = sourceDate();
    let unpacked = 0;
    for (const f of files) {
      utimesSync(path.join(stage, f), t, t);
      unpacked += statSync(path.join(stage, f)).size;
    }
    if (unpacked > MAX_UNPACKED_BYTES) die(`unpacks to ${unpacked} bytes, over ${MAX_UNPACKED_BYTES}`);

    // Files only, sorted, fixed owner, no extended attributes or macOS
    // metadata: the archive holds nothing but the code, the same on every build.
    const members = files.map((f) => `bridge/${f}`);
    const args = tarFlavour() === "bsd"
      ? ["--format", "ustar", "--no-xattrs", "--no-mac-metadata", "--no-acls", "--uid", "0", "--gid", "0",
         "--uname", "", "--gname", "", "--options", "gzip:!timestamp", "-czf", outFile, "-C", stageRoot, ...members]
      : ["--format=ustar", "--owner=0", "--group=0", "--numeric-owner", "--mtime=@" + t, "-czf", outFile, "-C", stageRoot, ...members];
    mkdirSync(path.dirname(outFile), { recursive: true });
    const r = spawnSync("tar", args, { env: { ...process.env, COPYFILE_DISABLE: "1", GZIP: "-n" }, stdio: ["ignore", "inherit", "inherit"] });
    if (r.status !== 0) die(`tar failed for ${outFile}`);
    const bytes = readFileSync(outFile);
    if (bytes.length > MAX_TARBALL_BYTES) die(`${outFile} is ${bytes.length} bytes, over ${MAX_TARBALL_BYTES}`);
    console.log(`${outFile}\n  version ${pkg.version}, ${files.length} files, ${bytes.length} bytes, unpacked ${unpacked}\n  sha256 ${createHash("sha256").update(bytes).digest("hex")}`);
    return files;
  } finally {
    rmSync(stageRoot, { recursive: true, force: true });
  }
}

const out = arg("--out");
if (!out) die("usage: node scripts/build-release.mjs --out <app>/public [--stepping-stone]");
const pkg = JSON.parse(readFileSync(path.join(BRIDGE, "package.json"), "utf8"));
const lock = JSON.parse(readFileSync(path.join(BRIDGE, "package-lock.json"), "utf8"));

// The lockfile must describe this package.json, or `npm ci` refuses it on the
// user's machine, after the release went out.
const root = lock.packages?.[""] ?? {};
if (!sameJson(root.dependencies, pkg.dependencies) || !sameJson(root.optionalDependencies, pkg.optionalDependencies)) {
  die("package-lock.json does not match package.json; run `npm install --package-lock-only` first");
}
if (lock.version !== pkg.version || root.version !== pkg.version) {
  die(`package-lock.json is for version ${lock.version}, package.json says ${pkg.version}; run \`npm install --package-lock-only\``);
}
if (pkg.version === STEPPING_STONE_VERSION) die(`version ${STEPPING_STONE_VERSION} is reserved for the stepping stone`);

const { devDependencies: _dev, ...shipped } = pkg;
build({ outFile: path.resolve(out, "bridge/v3/bridge.tar.gz"), pkg: shipped, lock });

if (process.argv.includes("--stepping-stone")) {
  const nested = listFiles(path.join(BRIDGE, "src")).filter((f) => f.includes("/"));
  if (nested.length) die(`the stepping stone must have a flat src/, found: ${nested.join(", ")}`);
  const { dependencies: _d, optionalDependencies: _o, ...rest } = shipped;
  build({
    outFile: path.resolve(out, "bridge.tar.gz"),
    pkg: { ...rest, version: STEPPING_STONE_VERSION, ...LEGACY_DEPS },
    lock: null,
  });
}
