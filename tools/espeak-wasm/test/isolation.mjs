// Instance isolation test.
// usage: node test/isolation.mjs <dist dir> <corpus.json>
//
// 1. Reference: instance R1 phonemizes the German corpus, instance R2 the
//    English corpus (each sequentially, alone).
// 2. Interleaved: instances A (de) and B (en-us) are used alternately, text by
//    text, and A is additionally poisoned with an input that crashes espeak
//    (EspeakCrashError) halfway through; a replacement A' continues.
//    B's results must equal R2's; A's results up to the crash must equal R1's.
// 3. Determinism: a third instance repeats R1's run and must match exactly.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [dist, corpusPath] = process.argv.slice(2);
const { createPhonemizer } = await import(pathToFileURL(path.resolve(dist, 'index.mjs')).href);
const corpus = JSON.parse(readFileSync(corpusPath, 'utf8'));
const de = corpus.de.map((x) => x.text);
const en = corpus.en.map((x) => x.text);
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
let failures = 0;
const check = (name, ok) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`); if (!ok) failures++; };

const r1 = await createPhonemizer();
const ref1 = de.map((t) => r1.phonemizeClauses(t, 'de'));
r1.close();
const r2 = await createPhonemizer();
const ref2 = en.map((t) => r2.phonemizeClauses(t, 'en-us'));
r2.close();

let a = await createPhonemizer();
const b = await createPhonemizer();
const gotA = [];
const gotB = [];
const crashAt = Math.floor(de.length / 2);
let crashSeen = false;
for (let i = 0; i < Math.max(de.length, en.length); i++) {
  if (i === crashAt) {
    try { a.phonemizeClauses('24🤠', 'de'); } catch (e) { crashSeen = e.name === 'EspeakCrashError'; }
    let closedOk = false;
    try { a.phonemizeClauses('Hallo', 'de'); } catch (e) { closedOk = /crashed earlier/.test(e.message); }
    check('crashed instance refuses further calls', closedOk);
    a = await createPhonemizer();
  }
  if (i < de.length) gotA.push(a.phonemizeClauses(de[i], 'de'));
  if (i < en.length) gotB.push(b.phonemizeClauses(en[i], 'en-us'));
}
a.close();
b.close();
check('"24🤠" (de) raises EspeakCrashError', crashSeen);
check(`interleaved instance B == standalone (${en.length} texts)`, eq(gotB, ref2));
check(`interleaved instance A == standalone before the crash (${crashAt} texts)`, eq(gotA.slice(0, crashAt), ref1.slice(0, crashAt)));

const r3 = await createPhonemizer();
check(`repeat run is deterministic (${de.length} texts)`, eq(de.map((t) => r3.phonemizeClauses(t, 'de')), ref1));
r3.close();

// the C-side join (conduit_phonemize -> out) equals the JS join of the raw clauses
{
  const { joinClauses } = await import(pathToFileURL(path.resolve(dist, 'phonemizer-compat.mjs')).href);
  const p1 = await createPhonemizer();
  const p2 = await createPhonemizer();
  let same = 0;
  for (const t of de) if (p1.phonemize(t, 'de') === joinClauses(p2.phonemizeClauses(t, 'de'))) same++;
  check(`phonemize() == joinClauses(phonemizeClauses()) (${same}/${de.length})`, same === de.length);
  p1.close();
  p2.close();
}

// statefulness of espeak itself (documented, not a failure): fresh instance per text vs. sequential
let differ = 0;
const sample = de.slice(0, 500);
for (let i = 0; i < sample.length; i++) {
  const f = await createPhonemizer();
  if (!eq(f.phonemizeClauses(sample[i], 'de'), ref1[i])) differ++;
  f.close();
}
console.log(`info: ${differ}/${sample.length} German texts phonemize differently on a fresh instance than in sequence (espeak carries state between calls)`);

process.exitCode = failures ? 1 : 0;
