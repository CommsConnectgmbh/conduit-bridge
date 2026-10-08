// Load time, memory and throughput.  node --expose-gc test/bench.mjs [corpus.json]
import { readFileSync } from 'node:fs';
import { createEnglishG2P, loadEnglishData } from '../src/index.mjs';
const gc = globalThis.gc || (() => {});
gc();
const m0 = process.memoryUsage();
const t0 = performance.now();
const data = loadEnglishData();
const tLoad = performance.now() - t0;
gc();
const m1 = process.memoryUsage();
const g2p = createEnglishG2P({ data, fallback: () => null });
const t1 = performance.now();
g2p('Hello world, this is the first call.');
const tFirst = performance.now() - t1;
const corpus = JSON.parse(readFileSync(process.argv[2] || new URL('./corpus/en_corpus.json', import.meta.url), 'utf8'));
const sentences = corpus.filter((t) => t.length < 200);
const t2 = performance.now();
let chars = 0;
for (const t of sentences) { g2p(t); chars += t.length; }
const tRun = performance.now() - t2;
gc();
const m2 = process.memoryUsage();
const mb = (x) => (x / 1048576).toFixed(1) + ' MB';
console.log(`tagger backend: ${data.tagger.backendName}`);
console.log(`load: ${tLoad.toFixed(0)} ms; first call ${tFirst.toFixed(1)} ms`);
console.log(`memory after load: rss +${mb(m1.rss - m0.rss)}, heapUsed +${mb(m1.heapUsed - m0.heapUsed)}, external+arrayBuffers +${mb(m1.external - m0.external)}`);
console.log(`memory after run: rss ${mb(m2.rss)}, heapUsed ${mb(m2.heapUsed)}`);
console.log(`throughput: ${sentences.length} sentences (${chars} chars) in ${tRun.toFixed(0)} ms = ${(tRun / sentences.length).toFixed(2)} ms/sentence, ${(chars / tRun * 1000).toFixed(0)} chars/s`);
