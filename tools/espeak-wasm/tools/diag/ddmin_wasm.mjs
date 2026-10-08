// ddmin over code points: smallest input for which a fresh WASM instance throws EspeakCrashError
// usage: node ddmin_wasm.mjs <dist dir> <dataset> <voice> <text-json-file>
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [dist, dataset, voice, file] = process.argv.slice(2);
const { createPhonemizer } = await import(pathToFileURL(path.resolve(dist, 'index.mjs')).href);
const archive = readFileSync(path.resolve(dist, dataset === 'default' ? 'espeak-ng-data.tar' : 'espeak-ng-data-complete.tar'));
async function crashes(s) {
  const ph = await createPhonemizer({ dataset, dataBytes: archive });
  try { ph.phonemizeClauses(s, voice); ph.close(); return false; } catch (e) { return e.name === 'EspeakCrashError'; }
}
let s = [...JSON.parse(readFileSync(file, 'utf8'))];
if (!(await crashes(s.join('')))) { console.log('does not crash'); process.exit(1); }
let n = 2;
while (s.length >= 2) {
  const chunk = Math.max(1, Math.floor(s.length / n));
  let reduced = false;
  for (let i = 0; i < s.length; i += chunk) {
    const cand = s.slice(0, i).concat(s.slice(i + chunk));
    if (cand.length && await crashes(cand.join(''))) { s = cand; n = Math.max(n - 1, 2); reduced = true; break; }
  }
  if (!reduced) { if (chunk === 1) break; n = Math.min(s.length, n * 2); }
}
console.log(JSON.stringify(s.join('')), s.map((c) => 'U+' + c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')).join(' '));
