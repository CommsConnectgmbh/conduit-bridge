// Tokenizer + tagger agreement with spaCy en_core_web_sm (tools/py_spacy_dump.py).
//   [BACKEND=js|wasm] node test/spacy.test.mjs test/corpus/en_natural.json test/data/natural_spacy_ref.json
import { readFileSync } from 'node:fs';
import { createPyUnicode } from '../src/pyunicode.mjs';
import { SpacyTokenizer } from '../src/spacy-tokenizer.mjs';
import { SpacyTagger } from '../src/spacy-tagger.mjs';
const D = new URL('../data/spacy/', import.meta.url);
const py = createPyUnicode(JSON.parse(readFileSync(new URL('pyunicode.json', D))));
const tok = new SpacyTokenizer(JSON.parse(readFileSync(new URL('tokenizer.json', D))), py);
const tagger = new SpacyTagger(JSON.parse(readFileSync(new URL('tagger.json', D))), readFileSync(new URL('tagger.bin', D)), tok, py, { backend: process.env.BACKEND || 'auto' }); console.log(tagger.backendName);
const texts = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const ref = JSON.parse(readFileSync(process.argv[3], 'utf8'));
let tokOk = 0, tagOk = 0, ntok = 0, ntag = 0, shown = 0, normBad = 0;
const t0 = performance.now();
for (let i = 0; i < texts.length; i++) {
  const toks = tok.tokenize(texts[i]);
  const js = toks.map((t) => [t.text, t.spacy ? ' ' : '']);
  const r = ref[i];
  const same = JSON.stringify(js) === JSON.stringify(r.map((x) => [x[0], x[1]]));
  if (same) {
    tokOk++;
    const tags = tagger.tag(toks);
    let all = true;
    for (let k = 0; k < r.length; k++) {
      ntag++;
      const n = toks[k].norm ?? tok.lexNorm(toks[k].text);
      if (n !== r[k][3]) { normBad++; if (shown++ < 20) console.log('NORM', JSON.stringify(toks[k].text), n, r[k][3]); }
      if (tags[k] === r[k][2]) tagOk++; else { all = false; if (shown++ < 40) console.log('TAG', i, JSON.stringify(r[k][0]), tags[k], r[k][2]); }
    }
  } else if (shown++ < 40) {
    console.log('TOK', i, JSON.stringify(texts[i]).slice(0, 200), '\n js', JSON.stringify(js.map((x) => x[0] + x[1])).slice(0, 400), '\n py', JSON.stringify(r.map((x) => x[0] + x[1])).slice(0, 400));
  }
}
console.log(`texts ${texts.length} tokOK ${tokOk} tags ${tagOk}/${ntag} normBad ${normBad} ms ${(performance.now() - t0).toFixed(0)}`);
