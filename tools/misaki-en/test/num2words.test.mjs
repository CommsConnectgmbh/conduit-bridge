// Differential test against Python num2words 0.5.14 (data from tools/py_num2words_ref.py)
import { readFileSync } from 'node:fs';
import { num2words } from '../src/num2words.mjs';
const cases = JSON.parse(readFileSync(process.argv[2] || new URL('./data/num2words_ref.json', import.meta.url), 'utf8'));
let ok = 0;
for (const [kind, s, want] of cases) {
  let got;
  try {
    if (kind === 'int') got = num2words(BigInt(s));
    else if (kind === 'ord') got = num2words(BigInt(s), 'ordinal');
    else if (kind === 'year') got = num2words(BigInt(s), 'year');
    else got = num2words(Number(s));
  } catch (e) { got = 'ERROR ' + e.name; }
  if (got === want) ok++; else if (ok >= 0) console.log(kind, s.slice(0, 60), '\n  py', want.slice(0, 200), '\n  js', String(got).slice(0, 200));
}
console.log(`num2words: ${ok}/${cases.length} identical`);
