// Raw espeak_TextToPhonemes parity: espeak-wasm vs recorded native espeak-ng.
//   node test/espeak-wasm-raw.test.mjs /abs/path/espeak-wasm/dist/index.mjs test/corpus/*_reference.json test/data/espeak_ref.json
import { readFileSync } from 'node:fs';
import { createEspeakWasmEngine } from '../src/espeak-wasm-adapter.mjs';
const eng = await createEspeakWasmEngine({ modulePath: process.argv[2], dataset: process.env.DATASET || 'alphabets' });
console.log('espeak', eng.version);
const raw = {};
for (const f of process.argv.slice(3)) Object.assign(raw, JSON.parse(readFileSync(f, 'utf8')).raw);
let ok = 0, n = 0, shown = 0; const t0 = performance.now();
for (const [l, want] of Object.entries(raw)) { n++; let got; try { got = eng.textToPhonemes(l); } catch (e) { got = 'ERR ' + e.message; }
  if (got === want) ok++; else if (shown++ < 10) console.log(JSON.stringify(l), JSON.stringify(want), JSON.stringify(got)); }
console.log(`raw espeak lines identical: ${ok}/${n} in ${(performance.now() - t0).toFixed(0)} ms`);
