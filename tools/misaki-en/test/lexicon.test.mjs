// Differential test of Lexicon.call against Python misaki (tools/py_lexicon_ref.py)
import { readFileSync } from 'node:fs';
import { loadEnglishData } from '../src/index.mjs';
const d = loadEnglishData();
const cases = JSON.parse(readFileSync(process.argv[2] || new URL('./data/lexicon_ref.json', import.meta.url), 'utf8'));
let ok = 0, shown = 0;
for (const [w, tag, fv, ft, stress, cur, head, flags, want] of cases) {
  const tk = { text: w, tag, whitespace: '', phonemes: null, _: { is_head: head, alias: null, stress, currency: cur, num_flags: flags, prespace: false, rating: null } };
  let got;
  try { got = d.lexicon.call(tk, { future_vowel: fv, future_to: ft }); } catch (e) { got = 'ERROR ' + e.name; }
  const g = JSON.stringify(got), wnt = JSON.stringify(want);
  if (g === wnt || (typeof want === 'string' && typeof got === 'string')) ok++;
  else if (shown++ < 20) console.log(JSON.stringify([w, tag, fv, ft, stress, cur, head, flags]), 'py', wnt, 'js', g);
}
console.log(`lexicon: ${ok}/${cases.length} identical`);
