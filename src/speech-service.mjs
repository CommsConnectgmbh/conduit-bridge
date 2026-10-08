// Local speech for the app: speech to text with Parakeet, text to speech with
// Kokoro voices, everything on this computer.
//
// Nothing is installed until the user asks for a model. Installing one brings
// what it needs along: the native runtime (speech-runtime.mjs) and, for a
// voice, espeak-ng. Models load on first use and are dropped again after a
// few idle minutes, since they share the machine with the user's coding agent.
// Synthesis runs one request at a time; a second request waits rather than
// competing for the same cores.

import { availableParallelism } from "node:os";
import { readFileSync } from "node:fs";
import {
  CATALOG, getModel, isInstalled, missingBytes, downloadModel, removeModel, modelPath,
} from "./speech-models.mjs";
import { support, isRuntimeInstalled, installRuntime, loadRuntime, removeRuntime } from "./speech-runtime.mjs";
import { createStt } from "./speech-stt.mjs";
import { createKokoro, loadVocab, loadVoices, tokenize, SAMPLE_RATE, MAX_PHONEMES } from "./speech-kokoro.mjs";
import { parseWav, encodeWav } from "./speech-wav.mjs";
import { createPhonemizer } from "./speech-espeak.mjs";
import { g2pDe, loadOverrides } from "./speech-g2p-de.mjs";
import { createEnglishG2P, loadEnglishData, createEspeakFallback } from "./speech-en.mjs";

export const LIMITS = Object.freeze({
  sttSeconds: 125,
  speakChars: 20_000,
});
const IDLE_MS = 5 * 60_000;
// Fragments like "Ja." or "OK." are merged into the next sentence; anything
// longer is its own segment, so the first one plays as early as possible.
const MIN_SEGMENT = 12;

export class SpeechError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const OVERRIDES = loadOverrides(new URL("./speech-de-overrides.json", import.meta.url));
const cpLen = (s) => { let n = 0; for (const _ of s) n++; return n; };

/**
 * Split a phoneme string into pieces of at most MAX_PHONEMES symbols, at
 * sentence ends first, so the first sentence can play while the rest is
 * still being synthesised. Abbreviations and ordinals are already spelled
 * out by the normaliser, so a full stop here ends a sentence.
 */
export function segmentPhonemes(ps) {
  const sentences = ps.split(/(?<=[.!?…])\s+|\n+/u).map((s) => s.trim()).filter(Boolean);
  const merged = [];
  for (const s of sentences) {
    const last = merged.length - 1;
    if (last >= 0 && cpLen(merged[last]) < MIN_SEGMENT && cpLen(merged[last]) + 1 + cpLen(s) <= MAX_PHONEMES) merged[last] += " " + s;
    else merged.push(s);
  }
  const out = [];
  for (let s of merged) {
    while (cpLen(s) > MAX_PHONEMES) {
      const chars = [...s];
      const head = chars.slice(0, MAX_PHONEMES).join("");
      // Last clause break, else the last space, else a hard cut.
      let cut = Math.max(...[";", ":", ",", "—"].map((c) => head.lastIndexOf(c)));
      cut = cut > MAX_PHONEMES / 3 ? cut + 1 : head.lastIndexOf(" ");
      if (cut <= 0) cut = head.length;
      out.push(s.slice(0, cut).trim());
      s = s.slice(cut).trim();
    }
    if (s) out.push(s);
  }
  return out;
}

/**
 * @param {{ log?: Function, threads?: number }} [opts]
 */
export function createSpeechService({ log = () => {}, threads } = {}) {
  const nThreads = threads ?? Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2)));
  const installs = new Map(); // id -> { done, total, error }
  let espeak = null;          // { ph, data } lazily
  let stt = null;
  const voicesByModel = new Map(); // tts model id -> { kokoro, vocab, voices, timer }
  let enG2p = null;
  let ttsQueue = Promise.resolve();

  const modelsOf = (kind) => CATALOG.filter((m) => m.kind === kind);
  const depsOf = (m) => (m.requires || []).map(getModel).filter(Boolean);
  const usable = (m) => isInstalled(m) && depsOf(m).every(isInstalled);

  function runtimeStatus() {
    const loaded = isRuntimeInstalled() ? loadRuntime() : null;
    const part = (supported, mod, what) => ({
      available: supported && (!loaded || !!mod),
      reason: !supported ? `${what} is not available for ${support.platform}` : loaded && !mod ? loaded.error : null,
    });
    return { stt: part(support.stt, loaded?.sherpa, "speech recognition"), tts: part(support.tts, loaded?.ort, "voice output") };
  }

  function status() {
    const runtime = runtimeStatus();
    const rt = isRuntimeInstalled() ? loadRuntime() : null;
    const models = CATALOG.filter((m) => m.kind !== "engine").map((m) => {
      const pending = [m, ...depsOf(m)].reduce((n, x) => n + missingBytes(x), 0);
      return {
        id: m.id, kind: m.kind, title: m.title, langs: m.langs,
        sizeBytes: m.files.reduce((n, f) => n + f.size, 0) + depsOf(m).reduce((n, d) => n + (isInstalled(d) ? 0 : d.files.reduce((k, f) => k + f.size, 0)), 0),
        pendingBytes: pending,
        installed: usable(m),
        installing: installs.get(m.id) || null,
        license: m.license, attribution: m.attribution,
      };
    });
    const ready = {
      stt: rt?.sherpa ? [...new Set(modelsOf("stt").filter(usable).flatMap((m) => m.langs))] : [],
      tts: rt?.ort ? [...new Set(modelsOf("tts").filter(usable).flatMap((m) => m.langs))] : [],
    };
    const voices = rt?.ort
      ? modelsOf("tts").filter(usable).flatMap((m) => m.voices.map((v) => ({ id: v.id, lang: m.langs[0], name: v.name })))
      : [];
    return { runtime, models, ready, voices };
  }

  /** Start installing a model in the background. */
  function install(id) {
    const m = getModel(id);
    if (!m || m.kind === "engine") throw new SpeechError(404, "unknown model");
    if (!(m.kind === "stt" ? support.stt : support.tts)) throw new SpeechError(409, `not available for ${support.platform}`);
    if (installs.get(id) && !installs.get(id).error) return; // already running
    const parts = [...depsOf(m), m];
    const total = parts.reduce((n, x) => n + missingBytes(x), 0);
    const state = { done: 0, total, error: null };
    installs.set(id, state);
    (async () => {
      await installRuntime({ log });
      let base = 0;
      for (const part of parts) {
        const need = missingBytes(part);
        await downloadModel(part, { onProgress: ({ done, total: t }) => { state.done = base + done - (t - need); } });
        base += need;
      }
      state.done = total;
      installs.delete(id);
      log("info", "speech_model_installed", { id });
    })().catch((e) => {
      state.error = String(e?.message || e).slice(0, 300);
      log("error", "speech_model_failed", { id, err: state.error });
    });
  }

  function remove(id) {
    const m = getModel(id);
    if (!m || m.kind === "engine") throw new SpeechError(404, "unknown model");
    if (installs.get(id) && !installs.get(id).error) throw new SpeechError(409, "installation still running");
    installs.delete(id);
    if (m.kind === "stt") { stt?.unload(); stt = null; }
    const loaded = voicesByModel.get(id);
    if (loaded) { clearTimeout(loaded.timer); loaded.kokoro.release(); voicesByModel.delete(id); }
    removeModel(m);
    // Engines nobody needs any more, and the runtime once nothing is left.
    for (const e of CATALOG.filter((x) => x.kind === "engine")) {
      if (!CATALOG.some((x) => isInstalled(x) && (x.requires || []).includes(e.id))) { removeModel(e); if (e.id.startsWith("espeak")) espeak = null; }
    }
    if (!CATALOG.some((x) => x.kind !== "engine" && isInstalled(x))) removeRuntime();
  }

  // ── speech to text ─────────────────────────────────────────────────────────

  async function transcribe(wav) {
    const rt = loadRuntime();
    const m = modelsOf("stt").find(usable);
    if (!m || !rt.sherpa) throw new SpeechError(409, "speech recognition is not installed");
    let audio;
    try { audio = parseWav(wav, { maxSeconds: LIMITS.sttSeconds }); }
    catch (e) { throw new SpeechError(400, String(e?.message || e)); }
    stt ??= createStt({
      files: {
        encoder: modelPath(m.id, "encoder.int8.onnx"), decoder: modelPath(m.id, "decoder.int8.onnx"),
        joiner: modelPath(m.id, "joiner.int8.onnx"), tokens: modelPath(m.id, "tokens.txt"),
      },
      threads: nThreads, idleMs: IDLE_MS, sherpa: rt.sherpa,
    });
    const r = await stt.transcribe(audio.samples, audio.sampleRate);
    return { text: r.text, ms: r.ms, seconds: audio.seconds };
  }

  // ── text to speech ─────────────────────────────────────────────────────────

  async function phonemizer() {
    if (espeak) return espeak;
    const e = getModel("espeak-ng-1.52.0");
    const wasmBinary = new Uint8Array(readFileSync(modelPath(e.id, "espeak-ng.wasm")));
    const dataBytes = new Uint8Array(readFileSync(modelPath(e.id, "espeak-ng-data.tar")));
    espeak = { ph: await createPhonemizer({ wasmBinary, dataBytes }), wasmBinary, dataBytes };
    return espeak;
  }

  async function voiceModel(m) {
    let v = voicesByModel.get(m.id);
    if (!v) {
      const rt = loadRuntime();
      if (!rt.ort) throw new SpeechError(409, "voice output is not available on this computer");
      v = {
        kokoro: await createKokoro({ ort: rt.ort, modelPath: modelPath(m.id, "model.onnx"), threads: nThreads }),
        vocab: loadVocab(modelPath(m.id, "vocab.json")),
        voices: loadVoices(modelPath(m.id, "voices.bin"), m.voices.map((x) => x.id)),
        timer: null,
      };
      voicesByModel.set(m.id, v);
    }
    clearTimeout(v.timer);
    v.timer = setTimeout(() => { v.kokoro.release(); voicesByModel.delete(m.id); }, IDLE_MS);
    v.timer.unref?.();
    return v;
  }

  /** Phoneme segments for one line of `lang` text, each at most MAX_PHONEMES long. */
  function phonemizeLine(line, lang) {
    const ph = espeak.ph;
    if (lang === "de") {
      const espeakDe = (t) => { const r = ph.phonemizeLikePythonPhonemizer(t, "de"); return r.length ? r[0] : ""; };
      return segmentPhonemes(g2pDe(line, { espeak: espeakDe, overrides: OVERRIDES }));
    }
    if (!enG2p) {
      const p = (name) => modelPath("tts-en-kokoro-v1.0", name);
      const data = loadEnglishData({
        pyunicode: p("spacy-pyunicode.json"), tokenizer: p("spacy-tokenizer.json"), taggerConfig: p("spacy-tagger.json"),
        taggerWeights: p("spacy-tagger.bin"), gold: p("misaki-us-gold.json"), silver: p("misaki-us-silver.json"),
      });
      const textToPhonemes = (l) => espeak.ph.phonemizeClauses(l, "en-us", { tie: true }).filter(Boolean).join(" ");
      enG2p = createEnglishG2P({ data, fallback: createEspeakFallback({ textToPhonemes, py: data.py }) });
    }
    return enG2p(line).chunks.flatMap((c) => segmentPhonemes(c.phonemes));
  }

  /**
   * Like phonemizeLine, but survives espeak-ng trapping on a rare input (the
   * native library would crash there): that instance is gone, a fresh one is
   * started and the line is skipped rather than the whole reply.
   */
  async function safeLine(line, lang) {
    await phonemizer();
    try {
      return phonemizeLine(line, lang);
    } catch (err) {
      if (err?.code !== "ESPEAK_CRASH") throw err;
      log("warn", "speech_espeak_crash", {});
      espeak.ph = await createPhonemizer({ wasmBinary: espeak.wasmBinary, dataBytes: espeak.dataBytes });
      return [];
    }
  }

  /**
   * Read `text` aloud. Calls onSegment with one WAV per segment, in order, as
   * soon as each is ready. Resolves when done or when `signal` aborts.
   * @param {string} text
   * @param {{ lang?: string, voice?: string, speed?: number, signal?: AbortSignal,
   *           onSegment: (wav: Buffer) => void | Promise<void> }} opts
   */
  function speak(text, { lang, voice, speed = 1, signal, onSegment }) {
    if (typeof text !== "string" || !text.trim()) throw new SpeechError(400, "nothing to read");
    if (text.length > LIMITS.speakChars) throw new SpeechError(413, `text longer than ${LIMITS.speakChars} characters`);
    if (!Number.isFinite(speed) || speed < 0.5 || speed > 2) throw new SpeechError(400, "speed must be between 0.5 and 2");
    const candidates = modelsOf("tts").filter(usable);
    const m = voice
      ? candidates.find((x) => x.voices.some((v) => v.id === voice))
      : candidates.find((x) => x.langs.includes(lang || "de"));
    if (!m) throw new SpeechError(409, voice ? `voice ${voice} is not installed` : `no voice installed for ${lang || "de"}`);
    const voiceId = voice || m.voices[0].id;
    const l = m.langs[0];

    const job = ttsQueue.then(async () => {
      if (signal?.aborted) return;
      const v = await voiceModel(m);
      const style = v.voices.get(voiceId);
      // Line by line, as Kokoro's pipeline does; the first sentence plays
      // while the rest is still being phonemised and synthesised.
      for (const line of text.split(/\n+/)) {
        if (!line.trim()) continue;
        for (const ps of await safeLine(line, l)) {
          if (signal?.aborted) return;
          const { ids } = tokenize(ps, v.vocab);
          if (!ids.length) continue;
          const audio = await v.kokoro.synthesize(ids, style, speed);
          if (signal?.aborted) return;
          await onSegment(encodeWav(audio, SAMPLE_RATE));
        }
      }
    });
    ttsQueue = job.catch(() => {});
    return job;
  }

  function close() {
    stt?.unload();
    for (const v of voicesByModel.values()) { clearTimeout(v.timer); v.kokoro.release(); }
    voicesByModel.clear();
    espeak?.ph.close();
    espeak = null;
  }

  return { status, install, remove, transcribe, speak, close };
}
