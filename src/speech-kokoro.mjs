// Kokoro-82M inference with onnxruntime-node.
//
// We run the ONNX graph ourselves instead of going through sherpa-onnx's TTS:
// sherpa phonemises with raw espeak-ng, which is not what the voices were
// trained on (misaki maps espeak's output to Kokoro's symbol set first), and
// its int8 Kokoro builds produce silence on darwin-arm64. Here the caller
// hands us phonemes from our own frontend, built to match the training data,
// and this module only turns them into audio.
//
// The graph takes token ids, a 256-float style vector and a speed scalar, and
// returns 24 kHz float samples. The style vector depends on the phoneme count:
// voices.bin holds 510 rows of 256 floats per voice, and row n-1 is used for n
// phonemes, exactly as in kokoro's KPipeline.infer.

// The onnxruntime module comes from the on-demand runtime (speech-runtime.mjs).

import { readFileSync } from "node:fs";

export const SAMPLE_RATE = 24000;
export const MAX_PHONEMES = 510;
const STYLE_ROWS = 510;
const STYLE_DIM = 256;

/** Kokoro's 114-symbol vocabulary, from the model's config.json "vocab". */
export function loadVocab(path) {
  const vocab = JSON.parse(readFileSync(path, "utf8"));
  const map = new Map();
  for (const [sym, id] of Object.entries(vocab)) {
    if ([...sym].length !== 1 || !Number.isInteger(id)) throw new Error(`bad vocab entry ${sym}`);
    map.set(sym, id);
  }
  return map;
}

/**
 * Voice packs: a concatenation of [510 x 256] float32 blocks, one per voice,
 * named in the same order by `names`.
 */
export function loadVoices(path, names) {
  const buf = readFileSync(path);
  const per = STYLE_ROWS * STYLE_DIM * 4;
  if (buf.length !== per * names.length) throw new Error(`voices file has ${buf.length} bytes, expected ${per * names.length}`);
  const all = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
  const voices = new Map();
  names.forEach((name, i) => voices.set(name, all.subarray(i * STYLE_ROWS * STYLE_DIM, (i + 1) * STYLE_ROWS * STYLE_DIM)));
  return voices;
}

/** Phoneme string to token ids. Unknown symbols are dropped and reported. */
export function tokenize(phonemes, vocab) {
  const ids = [];
  const unknown = new Set();
  for (const ch of phonemes) {
    const id = vocab.get(ch);
    if (id === undefined) unknown.add(ch);
    else ids.push(id);
  }
  return { ids, unknown: [...unknown] };
}

/**
 * @param {{ ort: any, modelPath: string, threads: number }} opts
 */
export async function createKokoro({ ort, modelPath, threads }) {
  const session = await ort.InferenceSession.create(modelPath, {
    intraOpNumThreads: threads,
    interOpNumThreads: 1,
    graphOptimizationLevel: "all",
    executionMode: "sequential",
  });

  /**
   * Synthesize one chunk.
   * @param {number[]} ids token ids, at most MAX_PHONEMES
   * @param {Float32Array} voice [510 x 256] style rows
   * @param {number} speed
   */
  async function synthesize(ids, voice, speed = 1) {
    if (ids.length === 0) return new Float32Array(0);
    if (ids.length > MAX_PHONEMES) throw new Error(`chunk has ${ids.length} phonemes, limit ${MAX_PHONEMES}`);
    const row = ids.length - 1;
    const tokens = new ort.Tensor("int64", BigInt64Array.from([0, ...ids, 0], BigInt), [1, ids.length + 2]);
    const style = new ort.Tensor("float32", voice.slice(row * STYLE_DIM, (row + 1) * STYLE_DIM), [1, STYLE_DIM]);
    const speedT = new ort.Tensor("float32", Float32Array.from([speed]), [1]);
    const out = await session.run({ tokens, style, speed: speedT });
    const audio = out[session.outputNames[0]].data;
    for (const t of Object.values(out)) t.dispose?.();
    return audio;
  }

  return { synthesize, release: () => session.release() };
}
