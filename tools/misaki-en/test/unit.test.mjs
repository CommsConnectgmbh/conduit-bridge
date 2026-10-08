import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createEnglishG2P, loadEnglishData, createEspeakFallback } from '../src/index.mjs';

const ref = JSON.parse(readFileSync(new URL('./corpus/en_reference.json', import.meta.url), 'utf8'));
const corpus = JSON.parse(readFileSync(new URL('./corpus/en_corpus.json', import.meta.url), 'utf8'));
const data = loadEnglishData();
const fallback = createEspeakFallback({ py: data.py, textToPhonemes: (l) => ref.raw[l] ?? '' });
const g2p = createEnglishG2P({ data, fallback });

test('known sentences match Python Kokoro/misaki', () => {
  const pick = (t) => ref.results[corpus.indexOf(t)].chunks.map(([text, phonemes]) => ({ text, phonemes }));
  for (const t of ["I can't believe it's already October.", 'The lead singer was poisoned by lead in the water pipes.',
    'It costs $5.99 plus tax.', 'The meeting is scheduled for Monday, January 15th.', '[Kokoro](/kˈOkəɹO/) is an open-weight TTS model.']) {
    assert.deepEqual(g2p(t).chunks, pick(t), t);
  }
});

test('result shape and chunk limit', () => {
  const long = corpus.reduce((a, t) => (t.length > a.length ? t : a), "");
  const r = g2p(long);
  assert.ok(r.chunks.length > 1);
  for (const c of r.chunks) assert.ok([...c.phonemes].length <= 510 && c.phonemes.length > 0);
  assert.equal(r.phonemes, r.chunks.map((c) => c.phonemes).join(' '));
  assert.deepEqual(g2p('').chunks, []);
  assert.deepEqual(g2p('  \n\n ').chunks, []);
});

test('instances are independent and deterministic', () => {
  const a = createEnglishG2P({ data, fallback });
  const b = createEnglishG2P({ data: loadEnglishData(undefined, { taggerBackend: 'js' }), fallback });
  for (const t of corpus.slice(0, 200)) assert.deepEqual(a(t), b(t));
});

test('without fallback unknown words are dropped, known words kept', () => {
  const g = createEnglishG2P({ data });
  assert.equal(g('Hello xqzzvbn world.').phonemes, 'həlˈO  wˈɜɹld.');
});

test('number overflow raises like Python', () => {
  assert.throws(() => g2p('1'.repeat(310)), { name: 'OverflowError' });
});
