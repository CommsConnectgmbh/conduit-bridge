// English G2P parity: the bridge's misaki en port with live espeak-ng
// WebAssembly against Python Kokoro KPipeline(lang_code='a') references.
//   node compare.mjs <espeak dist dir> <g2p data dir> <corpus.json> <reference.json>
// The g2p data dir holds the files of the English voice package.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createPhonemizer } from "../../src/speech-espeak.mjs";
import { createEnglishG2P, loadEnglishData, createEspeakFallback } from "../../src/speech-en.mjs";

const [dist, dataDir, corpusFile, refFile] = process.argv.slice(2);
const wasm = new Uint8Array(readFileSync(join(dist, "espeak-ng.wasm")));
const dataBytes = new Uint8Array(readFileSync(join(dist, "espeak-ng-data-complete.tar")));
let ph = await createPhonemizer({ wasmBinary: wasm, dataBytes });
const data = loadEnglishData({
  pyunicode: join(dataDir, "spacy-pyunicode.json"), tokenizer: join(dataDir, "spacy-tokenizer.json"),
  taggerConfig: join(dataDir, "spacy-tagger.json"), taggerWeights: join(dataDir, "spacy-tagger.bin"),
  gold: join(dataDir, "misaki-us-gold.json"), silver: join(dataDir, "misaki-us-silver.json"),
});
let crashes = 0;
const textToPhonemes = (line) => {
  try { return ph.phonemizeClauses(line, "en-us", { tie: true }).filter(Boolean).join(" "); }
  catch (e) {
    if (e?.code !== "ESPEAK_CRASH") throw e;
    crashes++;
    throw e;
  }
};
const g2p = createEnglishG2P({ data, fallback: createEspeakFallback({ textToPhonemes, py: data.py }) });
const corpus = JSON.parse(readFileSync(corpusFile, "utf8"));
const ref = JSON.parse(readFileSync(refFile, "utf8"));
let same = 0;
const diffs = [];
for (let i = 0; i < corpus.length; i++) {
  let j;
  try { j = { chunks: g2p(corpus[i]).chunks.map((c) => [c.text, c.phonemes]) }; }
  catch (e) {
    j = { error: `${e.name}: ${e.message}` };
    if (e?.code === "ESPEAK_CRASH") ph = await createPhonemizer({ wasmBinary: wasm, dataBytes });
  }
  const p = ref.results[i];
  if (JSON.stringify(p.error ? { error: true } : p.chunks) === JSON.stringify(j.error ? { error: true } : j.chunks)) same++;
  else if (diffs.length < 10) diffs.push({ i, text: corpus[i], py: p.error || p.chunks, js: j.error || j.chunks });
}
console.log(`identical ${same} of ${corpus.length}, espeak crashes ${crashes}`);
for (const d of diffs) console.log(JSON.stringify(d).slice(0, 600));
