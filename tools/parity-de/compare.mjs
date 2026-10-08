// German G2P parity: bridge (JS, espeak-ng WebAssembly) against the Python
// original (misaki de.DEG2P with native espeak-ng 1.52.0).
//   node compare.mjs <espeak dist dir> <texts.json.gz> <ref.json>
// ref.json comes from gen_ref.mjs. The bridge runs in compat mode and the
// reference gets the Thorsten-Voice patch (ʏ -> y) that its inference applies.
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { createPhonemizer } from "../../src/speech-espeak.mjs";
import { g2pDe, loadOverrides } from "../../src/speech-g2p-de.mjs";

const [dist, textsFile, refFile] = process.argv.slice(2);
const wasm = new Uint8Array(readFileSync(join(dist, "espeak-ng.wasm")));
const dataBytes = new Uint8Array(readFileSync(join(dist, "espeak-ng-data-complete.tar")));
let ph = await createPhonemizer({ wasmBinary: wasm, dataBytes });
const overrides = loadOverrides(new URL("../../src/speech-de-overrides.json", import.meta.url));
const espeak = (t) => { const r = ph.phonemizeLikePythonPhonemizer(t, "de"); return r.length ? r[0] : ""; };
const texts = JSON.parse(gunzipSync(readFileSync(textsFile)).toString("utf8"));
const ref = JSON.parse(readFileSync(refFile, "utf8"));
if (texts.length !== ref.length) throw new Error("texts and reference differ in length");

const n = { same: 0, diff: 0, crashBoth: 0, crashOnlyJs: 0, crashOnlyPy: 0 };
const shown = [];
for (let i = 0; i < texts.length; i++) {
  let js;
  try { js = { ok: g2pDe(texts[i], { espeak, overrides, compat: true }) }; }
  catch (e) {
    if (e?.code !== "ESPEAK_CRASH") throw e;
    js = { crash: true };
    ph = await createPhonemizer({ wasmBinary: wasm, dataBytes });
  }
  const r = ref[i].ok !== undefined ? { ok: ref[i].ok.replaceAll("ʏ", "y") } : ref[i];
  if (r.crash && js.crash) n.crashBoth++;
  else if (js.crash) n.crashOnlyJs++;
  else if (r.crash) n.crashOnlyPy++;
  else if (r.ok === js.ok) { n.same++; continue; }
  else n.diff++;
  if (shown.length < 20) shown.push({ i, text: texts[i], py: r, js });
}
console.log(`identical ${n.same}, different ${n.diff}, crash in both ${n.crashBoth}, only js ${n.crashOnlyJs}, only python ${n.crashOnlyPy}, of ${texts.length}`);
for (const s of shown) console.log(JSON.stringify(s).slice(0, 500));
