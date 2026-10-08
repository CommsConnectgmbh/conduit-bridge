// espeak-ng 1.52.0 (WebAssembly) text -> IPA phonemizer for Node.js >= 22.
//
//   import { createPhonemizer } from './speech-espeak.mjs';
//   const ph = await createPhonemizer({ wasmBinary, dataPath });
//   ph.phonemizeClauses('Hallo Welt.', 'de');          // ['hˈalo͡ː vˈɛlt']
//   ph.phonemizeLikePythonPhonemizer('Hallo, Welt!', 'de');
//   ph.close();
//
// Every createPhonemizer() call instantiates its own WebAssembly module
// (own linear memory, own espeak globals), so instances never share state.
// Within one instance calls are synchronous and must not be interleaved
// from other threads (there are none in a single JS realm; do not share an
// instance across worker_threads). See README.md.
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import createEspeakModule from './speech-espeak-glue.mjs';
import { BUILD_INFO } from './speech-espeak-build.mjs';
import { phonemizeLikePythonPhonemizerWith } from './speech-espeak-compat.mjs';

export { BUILD_INFO };

const DATA_ROOT = '/espeak-ng-data';

/**
 * Thrown when espeak-ng traps on this input: a NULL-pointer access (checked
 * by -fsanitize=null) or an out-of-bounds memory access. On every such input
 * found so far the native libespeak-ng 1.52.0 crashes with SIGSEGV, killing a
 * Python phonemizer process. The instance is unusable afterwards; create a new one.
 */
export class EspeakCrashError extends Error {
  constructor(text, voice, cause) {
    super(`espeak-ng trapped on this input (${cause?.message ?? cause}); native libespeak-ng 1.52.0 crashes on such inputs, see README "Crashes"`, { cause });
    this.name = 'EspeakCrashError';
    this.code = 'ESPEAK_CRASH';
    this.text = text;
    this.voice = voice;
  }
}

/** phonemizer EspeakWrapper.text_to_phonemes phoneme modes (espeak >= 1.49) */
export const PHONEME_MODE_TIE = 0x02 | (0x01 << 7) | (0x0361 << 8); // IPA, tie U+0361
export const PHONEME_MODE_UNDERSCORE = (0x5f << 8) | 0x02; // IPA, '_' between phonemes

const ERRORS = {
  [-1]: 'espeak is not initialized',
  [-2]: 'voice not found',
  [-3]: 'out of memory',
  [-4]: 'espeak_TextToPhonemes made no progress (text decoding failed)',
  [-5]: 'invalid argument',
};

/** Minimal ustar reader: returns [{ name, data }] for regular files. */
function readTar(buf) {
  const files = [];
  const dec = new TextDecoder('utf-8', { fatal: true });
  const field = (off, len) => {
    const b = buf.subarray(off, off + len);
    const end = b.indexOf(0);
    return dec.decode(end < 0 ? b : b.subarray(0, end));
  };
  let off = 0;
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512);
    if (header.every((x) => x === 0)) break;
    // checksum: sum of header bytes with the checksum field read as spaces
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : header[i];
    const chk = parseInt(field(off + 148, 8).trim(), 8);
    if (chk !== sum) throw new Error(`espeak data: bad tar header checksum at offset ${off}`);
    const name = (field(off + 345, 155) ? field(off + 345, 155) + '/' : '') + field(off, 100);
    const size = parseInt(field(off + 124, 12).trim() || '0', 8);
    const type = String.fromCharCode(header[156] || 0x30);
    off += 512;
    if (type === '0') files.push({ name, data: buf.subarray(off, off + size) });
    off += Math.ceil(size / 512) * 512;
  }
  return files;
}

const compiledModules = new Map();
function compiled(bytes, digest) {
  if (!compiledModules.has(digest)) compiledModules.set(digest, WebAssembly.compile(bytes));
  return compiledModules.get(digest);
}

/**
 * Create an independent phonemizer instance.
 * @param {object} [opts]
 * @param {'complete'|'minimal'} [opts.dataset='complete'] which bundled archive to load:
 *        'complete' = phoneme data, voices de / en-US / en(-GB) and every dictionary
 *                     libespeak-ng 1.52.0 can load while reading de/en text
 *                     (de en pl el hy hi bn pa gu ta te kn ml si ka ko ru).
 *                     Same behaviour as a full native installation for any input.
 *        'minimal'  = de + en dictionaries only. Identical for de/en text; text with
 *                     Polish letters or other scripts is read differently from a full
 *                     installation, and espeak 1.52.0 can run into undefined behaviour
 *                     when a dictionary it switches to is missing (see README).
 * @param {Uint8Array} opts.wasmBinary espeak-ng.wasm of this build; it ships as a
 *        downloadable speech package, not next to this file, and must match the
 *        SHA-256 in speech-espeak-build.mjs
 * @param {string|URL} [opts.dataPath] path of the data archive
 * @param {Uint8Array} [opts.dataBytes] archive bytes instead of a path. Instances created
 *        from the same Uint8Array share the file contents (read-only) in memory.
 * @param {boolean} [opts.verifyData=true] require the archive to be one of the
 *        archives of this build (SHA-256 recorded in build-info.mjs)
 */
export async function createPhonemizer(opts = {}) {
  const { dataset = 'complete', dataPath, dataBytes, verifyData = true, wasmBinary } = opts;
  const info = BUILD_INFO.data[dataset];
  if (!info) throw new Error(`unknown dataset ${JSON.stringify(dataset)}`);
  // The glue code was generated together with exactly one wasm binary.
  if (!(wasmBinary instanceof Uint8Array)) throw new Error('espeak: wasmBinary (Uint8Array) is required');
  const wasmDigest = createHash('sha256').update(wasmBinary).digest('hex');
  if (wasmDigest !== BUILD_INFO.wasm.sha256) throw new Error(`espeak-ng.wasm SHA-256 ${wasmDigest} is not the binary of this build`);
  if (!dataPath && !dataBytes) throw new Error('espeak: dataPath or dataBytes is required');
  let archive;
  if (dataBytes) archive = dataBytes instanceof Uint8Array ? dataBytes : new Uint8Array(dataBytes);
  else archive = new Uint8Array(await readFile(dataPath instanceof URL ? fileURLToPath(dataPath) : dataPath));
  if (verifyData) {
    const digest = createHash('sha256').update(archive).digest('hex');
    const known = (dataPath || dataBytes) && !opts.dataset ? Object.values(BUILD_INFO.data) : [info];
    if (!known.some((k) => k.sha256 === digest)) {
      throw new Error(`espeak data archive SHA-256 ${digest} is not an archive of this build (${known.map((k) => k.sha256).join(', ')}); pass verifyData:false to override`);
    }
  }

  const stderrLines = [];
  let M = await createEspeakModule({
    // The glue only takes the binary through this hook. Compiled once per
    // process; every instance still gets its own memory and globals.
    instantiateWasm(imports, receiveInstance) {
      compiled(wasmBinary, wasmDigest)
        .then((mod) => WebAssembly.instantiate(mod, imports))
        .then((instance) => receiveInstance(instance))
        .catch((e) => { stderrLines.push(String(e?.message || e)); throw e; });
      return {};
    },
    print: () => {},
    printErr: (s) => { stderrLines.push(s); },
  });

  for (const f of readTar(archive)) {
    const rel = f.name.replace(/^espeak-ng-data\//, '');
    if (rel === f.name || rel.includes('..')) throw new Error(`espeak data: unexpected entry ${f.name}`);
    const full = `${DATA_ROOT}/${rel}`;
    M.FS.mkdirTree(full.slice(0, full.lastIndexOf('/')));
    // canOwn: MEMFS keeps a view of the archive instead of copying it; espeak only reads
    M.FS.writeFile(full, f.data, { canOwn: true });
  }

  const withCString = (str, fn) => {
    const n = M.lengthBytesUTF8(str) + 1;
    const p = M._malloc(n);
    if (!p) throw new Error('espeak: out of memory');
    try {
      M.stringToUTF8(str, p, n);
      return fn(p);
    } finally {
      M._free(p);
    }
  };

  const rate = withCString(DATA_ROOT, (p) => M._conduit_init(p));
  if (rate <= 0) {
    throw new Error(`espeak_Initialize failed (${rate}): ${stderrLines.join('\n')}`);
  }

  const utf8 = new TextDecoder('utf-8', { fatal: true });
  const voiceCache = new Map();

  let crashed = false;
  function check() {
    if (!M) throw new Error(crashed ? 'phonemizer instance crashed earlier (EspeakCrashError); create a new one' : 'phonemizer is closed');
  }

  /** phonemizer's language -> voice identifier mapping (first voice of that language in espeak_ListVoices) */
  function resolveVoice(language) {
    check();
    if (voiceCache.has(language)) return voiceCache.get(language);
    const cap = 256;
    const out = M._malloc(cap);
    try {
      const n = withCString(language, (p) => M._conduit_resolve_voice(p, out, cap));
      const id = n >= 0 ? M.UTF8ToString(out, n) : null;
      voiceCache.set(language, id);
      return id;
    } finally {
      M._free(out);
    }
  }

  /** runs conduit_phonemize; returns nothing, results stay in the instance */
  function run(text, voice, o) {
    check();
    if (typeof text !== 'string') throw new TypeError('text must be a string');
    if (!text.isWellFormed()) throw new TypeError('text contains lone surrogates (not encodable as UTF-8)');
    const mode = o.phonemeMode ?? ((o.tie ?? true) ? PHONEME_MODE_TIE : PHONEME_MODE_UNDERSCORE);
    const id = resolveVoice(voice) ?? voice;
    let rc;
    try {
      rc = withCString(id, (pv) => withCString(text, (pt) => M._conduit_phonemize(pt, pv, mode, 0, 0)));
    } catch (e) {
      // A trap inside espeak (see EspeakCrashError) leaves the instance in an
      // undefined state: it is closed, like a crashed process.
      M = null;
      crashed = true;
      throw new EspeakCrashError(text, voice, e);
    }
    if (rc < 0) throw new Error(`espeak phonemize failed: ${ERRORS[rc] ?? rc} (voice ${JSON.stringify(voice)})`);
  }

  /**
   * Raw espeak_TextToPhonemes output for every clause (including empty ones),
   * in order. One call = one phonemizer text_to_phonemes() call.
   * @param {string} text
   * @param {string} voice language code as used by phonemizer ('de', 'en-us', 'en-gb')
   *                       or an espeak voice identifier/name ('gmw/de')
   * @param {{tie?: boolean, phonemeMode?: number}} [o] tie (default true): U+0361 tie mode,
   *        tie:false: '_' separator mode, phonemeMode: any espeak phoneme mode
   * @returns {string[]}
   */
  function phonemizeClauses(text, voice, o = {}) {
    run(text, voice, o);
    const ptr = M._conduit_result_ptr();
    const bytes = M.HEAPU8.subarray(ptr, ptr + M._conduit_result_len());
    const clauses = [];
    let start = 0;
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] === 0) {
        clauses.push(utf8.decode(bytes.subarray(start, i)));
        start = i + 1;
      }
    }
    return clauses;
  }

  /**
   * phonemizer's EspeakWrapper.text_to_phonemes(text, tie): the non-empty clause
   * outputs joined by ' ' (joined in C by conduit_phonemize).
   * @returns {string}
   */
  function phonemize(text, voice, o = {}) {
    run(text, voice, o);
    const ptr = M._conduit_joined_ptr();
    return utf8.decode(M.HEAPU8.subarray(ptr, ptr + M._conduit_joined_len()));
  }

  /**
   * Same result as Python
   *   EspeakBackend(lang, preserve_punctuation=True, with_stress=True, tie='^',
   *                 language_switch='remove-flags').phonemize([text])
   * (a list, usually with one string; [] for empty input).
   */
  function phonemizeLikePythonPhonemizer(text, lang) {
    check();
    if (resolveVoice(lang) == null) throw new Error(`language "${lang}" is not supported by the espeak backend`);
    return phonemizeLikePythonPhonemizerWith((chunk) => phonemizeClauses(chunk, lang, { tie: true }), text);
  }

  function close() {
    if (!M) return;
    M._conduit_terminate();
    M = null;
  }

  return {
    phonemizeClauses,
    phonemize,
    phonemizeLikePythonPhonemizer,
    resolveVoice,
    close,
    get version() { check(); return M.UTF8ToString(M._conduit_version()); },
  };
}
