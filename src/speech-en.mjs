// SPDX-License-Identifier: Apache-2.0
// Public API: Kokoro-82M v1.0 compatible American-English G2P for Node.
//
//   import { createEnglishG2P, loadEnglishData } from './speech-en.mjs';
//   const g2p = createEnglishG2P({ data: loadEnglishData(files), fallback });
//   const { phonemes, chunks } = g2p('Hello world!');
//
// Equivalent to Python:
//   KPipeline(lang_code='a', model=False)(text)  ->  chunks [(graphemes, phonemes)]
// with en.G2P(trf=False, british=False, fallback=EspeakFallback(False), unk='').

import { readFileSync } from 'node:fs';
import { createPyUnicode } from './speech-en-pyunicode.mjs';
import { SpacyTokenizer } from './speech-en-tokenizer.mjs';
import { SpacyTagger } from './speech-en-tagger.mjs';
import { Lexicon, G2P } from './speech-en-misaki.mjs';
import { kokoroChunks } from './speech-en-pipeline.mjs';

export { createEspeakFallback } from './speech-en-espeak-fallback.mjs';

/**
 * Load all data files once. The returned object is immutable after creation
 * and can be shared by several G2P instances. The files ship with the English
 * voice as a downloadable speech package.
 * @param {{ pyunicode: string, tokenizer: string, taggerConfig: string, taggerWeights: string,
 *           gold: string, silver: string }} files paths
 */
export function loadEnglishData(files, { taggerBackend = 'auto' } = {}) {
  const read = (key) => {
    if (typeof files?.[key] !== 'string') throw new Error(`english data: missing file ${key}`);
    return readFileSync(files[key]);
  };
  const json = (key) => JSON.parse(read(key).toString('utf8'));
  const py = createPyUnicode(json('pyunicode'));
  const tokenizer = new SpacyTokenizer(json('tokenizer'), py);
  const tagger = new SpacyTagger(json('taggerConfig'), read('taggerWeights'), tokenizer, py, { backend: taggerBackend });
  const lexicon = new Lexicon({ golds: json('gold'), silvers: json('silver'), py, british: false });
  return { py, tokenizer, tagger, lexicon };
}

/**
 * @param {object} [opts]
 * @param {(word: string) => (string|null)} [opts.fallback]  phonemes for out-of-vocabulary
 *        words (Kokoro phoneme set), e.g. createEspeakFallback(...). Without a fallback,
 *        unknown words produce no phonemes (as Kokoro does when espeak is missing).
 * @param {object} [opts.data]  result of loadEnglishData() to share data between instances
 */
export function createEnglishG2P({ fallback = null, data } = {}) {
  if (!data) throw new Error('english g2p: data from loadEnglishData() is required');
  const d = data;
  const nlp = {
    tokenize: (text) => d.tokenizer.tokenize(text),
    tag: (tokens) => d.tagger.tag(tokens),
  };
  const fb = fallback
    ? (tk) => {
      const ps = fallback(tk.text);
      return ps === null || ps === undefined ? [null, null] : [ps, 2];
    }
    : null;
  const g2p = new G2P({ lexicon: d.lexicon, nlp, fallback: fb, unk: '', py: d.py });
  const call = (text) => g2p.call(text);
  function run(text) {
    if (typeof text !== 'string') throw new TypeError('text must be a string');
    const chunks = kokoroChunks(d.py, call, text);
    return { phonemes: chunks.map((c) => c.phonemes).join(' '), chunks };
  }
  run.misaki = (text) => g2p.call(text)[0]; // raw misaki G2P output for one segment
  return run;
}
