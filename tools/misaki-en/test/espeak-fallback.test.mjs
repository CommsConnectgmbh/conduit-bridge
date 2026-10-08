// Differential test of the EspeakFallback port, with the raw espeak output
// recorded from native espeak-ng (tools/py_espeak_ref.py) or a live engine.
import { readFileSync } from 'node:fs';
import { createPyUnicode } from '../src/pyunicode.mjs';
import { createEspeakFallback } from '../src/espeak-fallback.mjs';
const py = createPyUnicode(JSON.parse(readFileSync(new URL('../data/spacy/pyunicode.json', import.meta.url))));
const ref = JSON.parse(readFileSync(process.argv[2] || new URL('./data/espeak_ref.json', import.meta.url), 'utf8'));
let textToPhonemes = (l) => { if (!Object.hasOwn(ref.raw, l)) throw new Error('missing raw ' + JSON.stringify(l)); return ref.raw[l]; };
if (process.env.ESPEAK_WASM) {
  const { createEspeakWasmEngine } = await import('../src/espeak-wasm-adapter.mjs');
  const eng = await createEspeakWasmEngine({ modulePath: process.env.ESPEAK_WASM, dataset: 'alphabets' });
  textToPhonemes = eng.textToPhonemes;
  console.log('live espeak-ng', eng.version, 'WebAssembly');
}
const fb = createEspeakFallback({ textToPhonemes, py });
let ok = 0, shown = 0;
for (const [s, want] of ref.cases) {
  let got;
  try { got = fb(s); } catch (e) { got = 'ERROR ' + e.message; }
  if (got === want) ok++; else if (shown++ < 15) console.log(JSON.stringify(s), 'py', JSON.stringify(want), 'js', JSON.stringify(got));
}
console.log(`espeak fallback: ${ok}/${ref.cases.length} identical`);
