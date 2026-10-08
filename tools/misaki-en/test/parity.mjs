// Parity test: JS port vs Python Kokoro/misaki reference.
//   node test/parity.mjs corpus.json reference.json [--report out.json]
// The espeak primitive is served from the raw native espeak outputs recorded
// by tools/py_reference.py (plus test/espeak-cache.json for extra lines), so
// both sides see byte-identical espeak-ng 1.52.0 results.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createEnglishG2P, loadEnglishData, createEspeakFallback } from '../src/index.mjs';

const [corpusPath, refPath] = process.argv.slice(2);
const reportIdx = process.argv.indexOf('--report');
const corpus = JSON.parse(readFileSync(corpusPath, 'utf8'));
const ref = JSON.parse(readFileSync(refPath, 'utf8'));
const cachePath = new URL('./espeak-cache.json', import.meta.url);
const cache = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, 'utf8')) : {};
const raw = { ...cache, ...ref.raw };
const PY = process.env.PYTHON || 'python3';

function nativeBatch(lines) {
  const out = execFileSync(PY, [new URL('../tools/espeak_raw.py', import.meta.url).pathname], { input: JSON.stringify(lines), maxBuffer: 1 << 28 });
  return JSON.parse(out.toString('utf8'));
}

const t0 = performance.now();
const data = loadEnglishData();
const loadMs = performance.now() - t0;
let missing = new Set();
let textToPhonemes = (line) => {
  if (Object.hasOwn(raw, line)) return raw[line];
  missing.add(line);
  return '';
};
let engineName = 'recorded native espeak-ng output';
if (process.env.ESPEAK_WASM) {
  const { createEspeakWasmEngine } = await import('../src/espeak-wasm-adapter.mjs');
  const eng = await createEspeakWasmEngine({ modulePath: process.env.ESPEAK_WASM, dataset: 'alphabets' });
  textToPhonemes = eng.textToPhonemes;
  engineName = `espeak-ng ${eng.version} WebAssembly (live)`;
}
console.log('espeak source:', engineName);
const fallback = createEspeakFallback({ textToPhonemes, py: data.py });
const g2p = createEnglishG2P({ fallback, data });

function runAll() {
  const res = [];
  for (const t of corpus) {
    try { res.push({ chunks: g2p(t).chunks.map((c) => [c.text, c.phonemes]) }); } catch (e) { res.push({ error: `${e.name}: ${e.message}` }); }
  }
  return res;
}
let res = runAll();
for (let round = 0; missing.size && round < 3; round++) {
  const add = nativeBatch([...missing]);
  Object.assign(cache, add); Object.assign(raw, add);
  writeFileSync(cachePath, JSON.stringify(cache));
  missing = new Set();
  res = runAll();
}
// timing run (warm)
const t1 = performance.now();
res = runAll();
const runMs = performance.now() - t1;

function lcs(a, b) {
  const m = a.length, n = b.length;
  let prev = new Uint32Array(n + 1), cur = new Uint32Array(n + 1);
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}
let same = 0, words = 0, wordsOk = 0, chunkCount = 0, errSame = 0;
const diffs = [];
corpus.forEach((t, i) => {
  const p = ref.results[i], j = res[i];
  const pj = JSON.stringify(p.error ? { error: true } : p.chunks);
  const jj = JSON.stringify(j.error ? { error: true } : j.chunks);
  if (p.error && j.error) errSame++;
  const pw = p.error ? [] : p.chunks.map((c) => c[1]).join(' ').split(' ');
  const jw = j.error ? [] : j.chunks.map((c) => c[1]).join(' ').split(' ');
  words += pw.length;
  wordsOk += lcs(pw, jw);
  chunkCount += p.error ? 0 : p.chunks.length;
  if (pj === jj) same++; else diffs.push({ i, text: t, py: p.error || p.chunks, js: j.error || j.chunks });
});
console.log(`load ${loadMs.toFixed(0)} ms, run ${runMs.toFixed(0)} ms for ${corpus.length} texts (python ${(ref.seconds * 1000).toFixed(0)} ms)`);
console.log(`texts identical: ${same}/${corpus.length} (${(100 * same / corpus.length).toFixed(2)}%), chunks ${chunkCount}, python errors ${ref.results.filter((r) => r.error).length} (both error: ${errSame})`);
console.log(`phoneme words matched (LCS): ${wordsOk}/${words} (${(100 * wordsOk / words).toFixed(3)}%)`);
for (const d of diffs.slice(0, Number(process.env.SHOW || 15))) {
  console.log('---', d.i, JSON.stringify(d.text).slice(0, 300));
  console.log('  py', JSON.stringify(d.py).slice(0, 600));
  console.log('  js', JSON.stringify(d.js).slice(0, 600));
}
if (reportIdx > 0) writeFileSync(process.argv[reportIdx + 1], JSON.stringify({ same, total: corpus.length, words, wordsOk, diffs }, null, 1));
