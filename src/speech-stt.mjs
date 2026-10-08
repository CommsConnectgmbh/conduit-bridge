// Speech to text with sherpa-onnx (Parakeet TDT v3, 25 European languages).
//
// The recognizer is loaded on first use and dropped again after it has been
// idle for a while: the model takes several hundred MB of RAM on a machine
// that also runs the user's coding agent. Decoding goes through sherpa's
// AsyncWorker, so the event loop stays free; jobs run one at a time because a
// second concurrent decode would only compete for the same cores.

// The sherpa module comes from the on-demand runtime (speech-runtime.mjs).

/**
 * @param {{
 *   files: { encoder: string, decoder: string, joiner: string, tokens: string },
 *   threads: number,
 *   idleMs: number,
 *   sherpa?: any,
 * }} opts
 */
export function createStt({ files, threads, idleMs, sherpa }) {
  let recognizer = null;
  let loading = null;
  let idleTimer = null;
  let queue = Promise.resolve();
  let lastUsed = 0;

  function armIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      // Only unload when nothing ran in the meantime; a job that started after
      // the timer was armed re-arms it when it finishes.
      if (Date.now() - lastUsed >= idleMs) recognizer = null;
    }, idleMs);
    idleTimer.unref?.();
  }

  async function ensureLoaded() {
    if (recognizer) return recognizer;
    if (!loading) {
      loading = sherpa.OfflineRecognizer.createAsync({
        featConfig: { sampleRate: 16000, featureDim: 80 },
        modelConfig: {
          transducer: { encoder: files.encoder, decoder: files.decoder, joiner: files.joiner },
          tokens: files.tokens,
          numThreads: threads,
          modelType: "nemo_transducer",
          debug: 0,
        },
      }).then(
        (r) => { recognizer = r; loading = null; return r; },
        (e) => { loading = null; throw e; },
      );
    }
    return loading;
  }

  /**
   * Transcribe float samples. Resampling to 16 kHz happens inside sherpa.
   * @param {Float32Array} samples
   * @param {number} sampleRate
   * @returns {Promise<{ text: string, ms: number }>}
   */
  function transcribe(samples, sampleRate) {
    const job = queue.then(async () => {
      const started = Date.now();
      const rec = await ensureLoaded();
      const stream = rec.createStream();
      stream.acceptWaveform({ samples, sampleRate });
      const result = await rec.decodeAsync(stream);
      lastUsed = Date.now();
      armIdle();
      return { text: String(result?.text || "").replace(/\s+/g, " ").trim(), ms: Date.now() - started };
    });
    // Keep the chain alive after a failed job.
    queue = job.catch(() => {});
    return job;
  }

  return {
    transcribe,
    warm: () => ensureLoaded().then(() => { lastUsed = Date.now(); armIdle(); }),
    get loaded() { return recognizer !== null; },
    unload() { clearTimeout(idleTimer); recognizer = null; },
  };
}
