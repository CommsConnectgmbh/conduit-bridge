// Parity test: WASM phonemizer vs native libespeak-ng (ctypes) and vs Python phonemizer.
//
// usage: node test/parity.mjs [--dist DIR] [--corpus out/corpus.json]
//        [--native out/ref_native.json] [--phonemizer out/ref_phonemizer.json]
//        [--report out/parity-report.json] [--dataset complete|minimal] [--skip-phonemizer]
//
// Every reference run is replayed on a fresh WASM instance, texts in corpus
// order (the references were produced the same way), so state carried by
// espeak from one text to the next is reproduced as well.
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const { values: args } = parseArgs({
  options: {
    dist: { type: 'string', default: path.join(here, '..', 'dist') },
    corpus: { type: 'string', default: path.join(here, 'out', 'corpus.json') },
    native: { type: 'string', default: path.join(here, 'out', 'ref_native.json') },
    phonemizer: { type: 'string', default: path.join(here, 'out', 'ref_phonemizer.json') },
    report: { type: 'string', default: path.join(here, 'out', 'parity-report.json') },
    show: { type: 'string', default: '15' },
    dataset: { type: 'string', default: 'complete' },
    'skip-phonemizer': { type: 'boolean', default: false },
  },
});

const { createPhonemizer, PHONEME_MODE_TIE, PHONEME_MODE_UNDERSCORE } = await import(pathToFileURL(path.join(args.dist, 'index.mjs')).href);
const MODES = { tie: PHONEME_MODE_TIE, underscore: PHONEME_MODE_UNDERSCORE };

const corpus = JSON.parse(readFileSync(args.corpus, 'utf8'));
const refNative = JSON.parse(readFileSync(args.native, 'utf8'));
const refPhon = args['skip-phonemizer'] ? { runs: {} } : JSON.parse(readFileSync(args.phonemizer, 'utf8'));
const dataset = args.dataset;
console.log(`dataset ${dataset}; native reference ${refNative.meta.lib} data=${refNative.meta.data_arg ?? '(library default)'}`);

const report = { dataset, nativeMeta: refNative.meta, native: {}, phonemizer: {}, mismatches: [] };
let failures = 0;
const show = Number(args.show);

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// Replays one reference run on WASM. Where the reference process crashed
// ({crash: signal}), the WASM call must throw EspeakCrashError; afterwards a
// fresh instance continues, exactly like the reference restarted a fresh engine.
async function replay(texts, results, call) {
  let ph = await createPhonemizer({ dataset });
  const out = { got: [], ms: 0, crashMatched: 0, crashUnmatched: [], wasmOnlyCrash: [], instances: 1 };
  for (let i = 0; i < texts.length; i++) {
    const expCrash = results[i] && typeof results[i] === 'object' && !Array.isArray(results[i]) && 'crash' in results[i];
    const t0 = process.hrtime.bigint();
    let got;
    let threw = null;
    try {
      got = call(ph, texts[i].text);
    } catch (e) {
      threw = e;
      got = { error: `${e.name}: ${e.message}` };
    }
    out.ms += Number(process.hrtime.bigint() - t0) / 1e6;
    if (expCrash) {
      if (threw?.name === 'EspeakCrashError') {
        out.crashMatched++;
        got = results[i];
      } else out.crashUnmatched.push(i);
    } else if (threw?.name === 'EspeakCrashError') out.wasmOnlyCrash.push(i);
    out.got.push(got);
    if (expCrash || threw?.name === 'EspeakCrashError') {
      if (!threw) ph.close();
      ph = await createPhonemizer({ dataset });
      out.instances++;
    }
  }
  out.last = ph;
  return out;
}

for (const [key, run] of Object.entries(refNative.runs)) {
  const [corpusLang, language, modeName] = key.split('|');
  const texts = corpus[corpusLang];
  let ok = 0;
  let nullClauses = 0;
  let clauses = 0;
  const r = await replay(texts, run.results, (ph, text) => ph.phonemizeClauses(text, language, { phonemeMode: MODES[modeName] }));
  if (r.last.resolveVoice(language) !== run.identifier) {
    failures++;
    console.log(`${key}: voice ${r.last.resolveVoice(language)} != native ${run.identifier}`);
  }
  r.last.close();
  texts.forEach((item, i) => {
    const res = run.results[i];
    const exp = Array.isArray(res) ? res.map((c) => {
      clauses++;
      if (c === null) { nullClauses++; return ''; }
      return c;
    }) : res;
    if (same(exp, r.got[i])) ok++;
    else {
      failures++;
      report.mismatches.push({ kind: 'native', run: key, id: item.id, cat: item.cat, text: item.text, expected: exp, got: r.got[i] });
    }
  });
  const crashes = (run.crashes ?? []).length;
  report.native[key] = { texts: texts.length, identical: ok, clauses, nullClauses, nativeCrashes: crashes, crashMatched: r.crashMatched,
    crashUnmatched: r.crashUnmatched.length, wasmOnlyCrash: r.wasmOnlyCrash.length, wasmMs: r.ms };
  console.log(`native ${key.padEnd(24)} ${ok}/${texts.length} identical (${clauses} clauses, ${nullClauses} NULL; native crashes ${crashes}, ` +
    `wasm threw on ${r.crashMatched} of them, wasm-only throws ${r.wasmOnlyCrash.length}) wasm ${r.ms.toFixed(0)} ms`);
}

for (const [key, run] of Object.entries(refPhon.runs)) {
  const [corpusLang, language] = key.split('|');
  const texts = corpus[corpusLang];
  let ok = 0;
  const r = await replay(texts, run.results, (ph, text) => ph.phonemizeLikePythonPhonemizer(text, language));
  r.last.close();
  texts.forEach((item, i) => {
    if (same(run.results[i], r.got[i])) ok++;
    else {
      failures++;
      report.mismatches.push({ kind: 'phonemizer', run: key, id: item.id, cat: item.cat, text: item.text, expected: run.results[i], got: r.got[i] });
    }
  });
  const crashes = (run.crashes ?? []).length;
  report.phonemizer[key] = { texts: texts.length, identical: ok, pythonCrashes: crashes, crashMatched: r.crashMatched,
    crashUnmatched: r.crashUnmatched.length, wasmOnlyCrash: r.wasmOnlyCrash.length, wasmMs: r.ms, pythonMs: run.seconds * 1000 };
  console.log(`phonemizer ${key.padEnd(20)} ${ok}/${texts.length} identical (python crashes ${crashes}, wasm threw on ${r.crashMatched} of them, ` +
    `wasm-only throws ${r.wasmOnlyCrash.length}) wasm ${r.ms.toFixed(0)} ms`);
}

writeFileSync(args.report, JSON.stringify(report, null, 1));
for (const m of report.mismatches.slice(0, show)) {
  console.log(`\nMISMATCH ${m.kind} ${m.run} ${m.id} [${m.cat}] ${JSON.stringify(m.text).slice(0, 200)}\n  expected ${JSON.stringify(m.expected).slice(0, 400)}\n  got      ${JSON.stringify(m.got).slice(0, 400)}`);
}
console.log(`\n${failures === 0 ? 'ALL IDENTICAL' : `${failures} mismatches`} (report: ${args.report})`);
process.exitCode = failures === 0 ? 0 : 1;
