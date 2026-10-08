// Self-update against a local origin with a test signing key. No network, no
// real npm: dependency installs are replaced by a function that writes a
// marker, or fails.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, symlinkSync, realpathSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkAndStage, npmCommand } from "../src/selfupdate.mjs";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const other = generateKeyPairSync("ed25519");
let root, srv, base;
const served = new Map();

before(async () => {
  // Real path: npmCommand resolves links, and macOS tmpdir() is one.
  root = realpathSync(mkdtempSync(join(tmpdir(), "conduit-selfupdate-")));
  srv = http.createServer((q, r) => {
    const b = served.get(q.url);
    if (!b) { r.writeHead(404); return r.end(); }
    r.writeHead(200, { "content-type": "application/gzip" });
    r.end(b);
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${srv.address().port}`;
});
after(() => { srv.close(); rmSync(root, { recursive: true, force: true }); });

let n = 0;
/** A release tarball from a { "rel/path": content } map, served at a fresh URL. */
function publish(files, { key = privateKey, links = [] } = {}) {
  const dir = join(root, `rel${++n}`);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, "bridge", rel, ".."), { recursive: true });
    writeFileSync(join(dir, "bridge", rel), content);
  }
  for (const [rel, target] of links) symlinkSync(target, join(dir, "bridge", rel));
  const tgz = join(dir, "bridge.tar.gz");
  execFileSync("tar", ["czf", tgz, "-C", dir, "bridge"], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
  const bytes = readFileSync(tgz);
  const url = `/r${n}/bridge.tar.gz`;
  served.set(url, bytes);
  served.set(url + ".sig", Buffer.from(sign(null, bytes, key).toString("base64")));
  return base + url;
}

const pkg = (version, dependencies = { ws: "8.18.0" }) => JSON.stringify({ name: "conduit-bridge", version, dependencies });
const lock = (version) => JSON.stringify({ name: "conduit-bridge", version, lockfileVersion: 3 });

/** An installed bridge: src tree, package files, node_modules marker. */
function install(files) {
  const dir = join(root, `inst${++n}`);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  mkdirSync(join(dir, "node_modules", "old-dep"), { recursive: true });
  return dir;
}

function tree(dir, base = "") {
  if (!existsSync(join(dir, base))) return [];
  return readdirSync(join(dir, base), { withFileTypes: true }).flatMap((f) => {
    const rel = base ? `${base}/${f.name}` : f.name;
    return f.isDirectory() ? [rel + "/", ...tree(dir, rel)] : [rel];
  }).sort();
}

const fakeDeps = async (dir) => { mkdirSync(join(dir, "node_modules", "new-dep"), { recursive: true }); };
const opts = (url, installDir, extra = {}) => ({ url, installDir, log: () => {}, verifyKey: publicKey, installDepsImpl: fakeDeps, ...extra });

const V3 = {
  "package.json": pkg("3.0.0"),
  "src/server.mjs": "// 3.0.0",
  "src/pairing.mjs": "// retired",
};

test("installs nested src directories, swaps node_modules, keeps the lockfile", async () => {
  const dir = install(V3);
  const url = publish({
    "package.json": pkg("3.1.0", { ws: "8.18.0", extra: "1.0.0" }),
    "package-lock.json": lock("3.1.0"),
    "src/server.mjs": "// 3.1.0",
    "src/speech/data/table.json": "{}",
  });
  const r = await checkAndStage(opts(url, dir));
  assert.deepEqual(r, { updated: true, from: "3.0.0", to: "3.1.0", npm: true });
  assert.equal(readFileSync(join(dir, "src/server.mjs"), "utf8"), "// 3.1.0");
  assert.equal(readFileSync(join(dir, "src/speech/data/table.json"), "utf8"), "{}");
  assert.equal(existsSync(join(dir, "src/pairing.mjs")), false, "retired module removed");
  assert.equal(JSON.parse(readFileSync(join(dir, "package-lock.json"), "utf8")).version, "3.1.0");
  assert.deepEqual(readdirSync(join(dir, "node_modules")), ["new-dep"]);
  assert.equal(existsSync(join(dir, ".selfupdate")), false);
  const manifest = JSON.parse(readFileSync(join(dir, ".installed-files.json"), "utf8")).src;
  assert.deepEqual(manifest, ["server.mjs", "speech/data/table.json"]);
});

test("files of the previous release are pruned, empty directories too, operator files stay", async () => {
  const dir = install(V3);
  await checkAndStage(opts(publish({ "package.json": pkg("3.1.0"), "src/server.mjs": "a", "src/speech/x.mjs": "x" }), dir));
  writeFileSync(join(dir, "src/local-patch.mjs"), "mine");
  const r = await checkAndStage(opts(publish({ "package.json": pkg("3.2.0"), "src/server.mjs": "b" }), dir));
  assert.equal(r.updated, true);
  assert.equal(r.npm, false, "same dependencies, no lockfile: no install");
  assert.deepEqual(tree(join(dir, "src")), ["local-patch.mjs", "server.mjs"]);
});

test("changed dependencies without a lockfile are refused, nothing changes", async () => {
  const dir = install(V3);
  const before = tree(dir);
  const r = await checkAndStage(opts(publish({ "package.json": pkg("3.1.0", { ws: "9.0.0" }), "src/server.mjs": "new" }), dir));
  assert.equal(r.updated, false);
  assert.match(r.reason, /no package-lock\.json/);
  assert.deepEqual(tree(dir), before);
  assert.equal(readFileSync(join(dir, "src/server.mjs"), "utf8"), "// 3.0.0");
});

test("a failed dependency install leaves the running bridge untouched", async () => {
  const dir = install(V3);
  const before = tree(dir);
  const url = publish({ "package.json": pkg("3.1.0", { ws: "9.0.0" }), "package-lock.json": lock("3.1.0"), "src/server.mjs": "new" });
  const r = await checkAndStage(opts(url, dir, { installDepsImpl: async () => { throw new Error("npm ci failed"); } }));
  assert.equal(r.updated, false);
  assert.match(r.reason, /npm ci failed/);
  assert.deepEqual(tree(dir), before);
  assert.deepEqual(readdirSync(join(dir, "node_modules")), ["old-dep"]);
});

test("a failure while applying rolls everything back, node_modules included", async () => {
  const dir = install({ ...V3, "package-lock.json": lock("3.0.0"), "src/sub/keep.mjs": "k" });
  const before = tree(dir);
  // A hidden file name is refused by copyTree after some files were copied.
  const url = publish({
    "package.json": pkg("3.1.0", { ws: "9.0.0" }), "package-lock.json": lock("3.1.0"),
    "src/a.mjs": "a", "src/zz/.hidden": "x",
  });
  await assert.rejects(checkAndStage(opts(url, dir)), /unexpected file name/);
  assert.deepEqual(tree(dir), before);
  assert.equal(readFileSync(join(dir, "src/server.mjs"), "utf8"), "// 3.0.0");
  assert.equal(JSON.parse(readFileSync(join(dir, "package-lock.json"), "utf8")).version, "3.0.0");
  assert.deepEqual(readdirSync(join(dir, "node_modules")), ["old-dep"]);
});

test("signature by another key, missing signature, link members and older versions are refused", async () => {
  const dir = install(V3);
  const before = tree(dir);
  const files = { "package.json": pkg("3.1.0"), "src/server.mjs": "evil" };
  let r = await checkAndStage(opts(publish(files, { key: other.privateKey }), dir));
  assert.match(r.reason, /signature rejected/);
  const url = publish(files);
  served.delete(url.slice(base.length) + ".sig");
  r = await checkAndStage(opts(url, dir));
  assert.match(r.reason, /signature rejected/);
  r = await checkAndStage(opts(publish(files, { links: [["src/link.mjs", "/etc/passwd"]] }), dir));
  assert.match(r.reason, /link member/);
  r = await checkAndStage(opts(publish({ "package.json": pkg("2.21.1"), "src/server.mjs": "old" }), dir));
  assert.equal(r.reason, "up-to-date");
  assert.deepEqual(tree(dir), before);
});

test("npm is found next to the node binary, never through a shell", () => {
  const layout = (rel) => {
    const d = mkdtempSync(join(root, "node-"));
    mkdirSync(join(d, rel, ".."), { recursive: true });
    writeFileSync(join(d, rel), "");
    return d;
  };
  let d = layout("bin/node");
  mkdirSync(join(d, "lib/node_modules/npm/bin"), { recursive: true });
  writeFileSync(join(d, "lib/node_modules/npm/bin/npm-cli.js"), "");
  assert.deepEqual(npmCommand(join(d, "bin/node")).pre, [join(d, "lib/node_modules/npm/bin/npm-cli.js")]);

  d = layout("node.exe");
  mkdirSync(join(d, "node_modules/npm/bin"), { recursive: true });
  writeFileSync(join(d, "node_modules/npm/bin/npm-cli.js"), "");
  assert.deepEqual(npmCommand(join(d, "node.exe")).pre, [join(d, "node_modules/npm/bin/npm-cli.js")]);

  // Homebrew: npm lives outside the keg, behind bin/npm.
  d = layout("Cellar/node/1/bin/node");
  mkdirSync(join(d, "lib/node_modules/npm/bin"), { recursive: true });
  writeFileSync(join(d, "lib/node_modules/npm/bin/npm-cli.js"), "");
  symlinkSync(join(d, "lib/node_modules/npm/bin/npm-cli.js"), join(d, "Cellar/node/1/bin/npm"));
  const r = npmCommand(join(d, "Cellar/node/1/bin/node"));
  assert.equal(r.cmd, join(d, "Cellar/node/1/bin/node"));
  assert.match(r.pre[0], /lib[\\/]node_modules[\\/]npm[\\/]bin[\\/]npm-cli\.js$/);
});
