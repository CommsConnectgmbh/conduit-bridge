// Crash-tolerant reference: a native espeak segfault kills the worker; the
// item is recorded as a crash and a fresh worker continues with the next one.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import readline from "node:readline";
const [py, worker, inFile, outFile] = process.argv.slice(2);
const texts = JSON.parse((inFile.endsWith(".gz") ? (await import("node:zlib")).gunzipSync(readFileSync(inFile)) : readFileSync(inFile)).toString("utf8"));
const out = new Array(texts.length);
let i = 0;
while (i < texts.length) {
  await new Promise((resolve) => {
    const p = spawn(py, ["-I", worker], { stdio: ["pipe", "pipe", "ignore"] });
    const rl = readline.createInterface({ input: p.stdout });
    let cur = i;
    const feed = () => { if (cur < texts.length) p.stdin.write(JSON.stringify(texts[cur]) + "\n"); else p.stdin.end(); };
    rl.on("line", (l) => { out[cur] = JSON.parse(l); cur++; i = cur; feed(); });
    p.on("exit", (code, sig) => {
      if (i < texts.length && out[i] === undefined) { out[i] = { crash: sig || code }; i++; }
      resolve();
    });
    p.stdin.on("error", () => {});
    feed();
  });
}
writeFileSync(outFile, JSON.stringify(out));
console.log("done", out.length, "crashes", out.filter((o) => o.crash).length, "errors", out.filter((o) => o.err).length);
