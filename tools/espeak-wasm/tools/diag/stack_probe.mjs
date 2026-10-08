// usage: node stack_probe.mjs <dist dir> <corpus.json> <fuzz.json> <ref_native_fuzz.json>
// Runs every text (corpus + fuzz, all voices) on a build linked with
// -sSTACK_OVERFLOW_CHECK=2 and reports the first failure. Texts on which the
// native library crashes are skipped.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [dist, corpusP, fuzzP, refP] = process.argv.slice(2);
const { createPhonemizer } = await import(pathToFileURL(path.resolve(dist, 'index.mjs')).href);
const corpus = JSON.parse(readFileSync(corpusP, 'utf8'));
const fuzz = JSON.parse(readFileSync(fuzzP, 'utf8'));
const ref = JSON.parse(readFileSync(refP, 'utf8'));
let total = 0;
for (const [lang, voice] of [['de', 'de'], ['en', 'en-us'], ['en', 'en-gb'], ['de', 'en-us'], ['en', 'de']]) {
  const skip = new Set(ref.runs[`${lang}|${voice}|tie`].crashes);
  let ph = await createPhonemizer();
  const texts = corpus[lang].map((x) => x.text).concat(fuzz[lang].map((x, i) => (skip.has(i) ? null : x.text)));
  for (let i = 0; i < texts.length; i++) {
    if (texts[i] === null) { ph.close(); ph = await createPhonemizer(); continue; }
    try { ph.phonemizeClauses(texts[i], voice); total++; } catch (e) {
      console.log(`FAIL ${lang}/${voice} text ${i}: ${e.message.slice(0, 200)}`);
      process.exit(1);
    }
  }
  ph.close();
}
console.log(`ok: ${total} texts without stack overflow`);
