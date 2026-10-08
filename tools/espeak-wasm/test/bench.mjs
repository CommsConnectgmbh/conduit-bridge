// Timing of the WASM phonemizer.
// usage: node test/bench.mjs [dist dir]
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(process.argv[2] ?? path.join(here, '..', 'dist'));
const { createPhonemizer } = await import(pathToFileURL(path.join(dist, 'index.mjs')).href);

const DE20 = 'Am Montag fährt Herr Müller um 14:30 Uhr mit dem ICE von München nach Hamburg, um seine Großmutter zu besuchen.';
const EN20 = 'On Monday Mr. Miller takes the 2:30 p.m. train from Boston to New York to visit his old grandmother again.';
const words = (s) => s.split(/\s+/).filter(Boolean).length;

function stats(fn, n, warm = 200) {
  for (let i = 0; i < warm; i++) fn();
  const t = [];
  for (let i = 0; i < n; i++) {
    const t0 = process.hrtime.bigint();
    fn();
    t.push(Number(process.hrtime.bigint() - t0) / 1e3);
  }
  t.sort((a, b) => a - b);
  const q = (p) => t[Math.min(t.length - 1, Math.floor(p * t.length))];
  return { median: q(0.5), p95: q(0.95), p99: q(0.99), mean: t.reduce((a, b) => a + b, 0) / t.length, n };
}
const fmt = (s) => `median ${s.median.toFixed(1)} µs, p95 ${s.p95.toFixed(1)} µs, p99 ${s.p99.toFixed(1)} µs, mean ${s.mean.toFixed(1)} µs (n=${s.n})`;

console.log(`node ${process.version}, ${dist}`);
console.log(`DE sentence (${words(DE20)} words): ${DE20}`);
console.log(`EN sentence (${words(EN20)} words): ${EN20}`);

for (const dataset of ['complete', 'minimal']) {
  const t = [];
  const archive = readFileSync(path.join(dist, `espeak-ng-data-${dataset}.tar`));
  for (let i = 0; i < 10; i++) {
    const t0 = process.hrtime.bigint();
    const p = await createPhonemizer({ dataset });
    p.phonemizeClauses('Hallo.', 'de'); // first call loads the voice + dictionary
    t.push(Number(process.hrtime.bigint() - t0) / 1e6);
    p.close();
  }
  t.sort((a, b) => a - b);
  const t2 = [];
  for (let i = 0; i < 10; i++) {
    const t0 = process.hrtime.bigint();
    const p = await createPhonemizer({ dataset, dataBytes: archive });
    p.phonemizeClauses('Hallo.', 'de');
    t2.push(Number(process.hrtime.bigint() - t0) / 1e6);
    p.close();
  }
  t2.sort((a, b) => a - b);
  console.log(`init + first call (${dataset}, ${archive.length} bytes): median ${t[5].toFixed(1)} ms from file, ${t2[5].toFixed(1)} ms with shared dataBytes`);
}

const ph = await createPhonemizer();
console.log('de phonemizeClauses              ', fmt(stats(() => ph.phonemizeClauses(DE20, 'de'), 5000)));
console.log('de phonemizeLikePythonPhonemizer ', fmt(stats(() => ph.phonemizeLikePythonPhonemizer(DE20, 'de'), 5000)));
ph.close();
const pe = await createPhonemizer();
console.log('en-us phonemizeClauses           ', fmt(stats(() => pe.phonemizeClauses(EN20, 'en-us'), 5000)));
console.log('en-us phonemizeLikePythonPhonemizer', fmt(stats(() => pe.phonemizeLikePythonPhonemizer(EN20, 'en-us'), 5000)));
pe.close();

// memory: 8 instances
const rss0 = process.memoryUsage().rss;
const archive = readFileSync(path.join(dist, 'espeak-ng-data-complete.tar'));
const many = [];
for (let i = 0; i < 8; i++) {
  const p = await createPhonemizer({ dataBytes: archive, dataset: 'complete' });
  p.phonemizeClauses(DE20, 'de');
  many.push(p);
}
const rss1 = process.memoryUsage().rss;
console.log(`RSS growth for 8 instances (shared dataBytes, after one German sentence each): ${((rss1 - rss0) / 8 / 1048576).toFixed(1)} MiB per instance`);
for (const p of many) p.close();
