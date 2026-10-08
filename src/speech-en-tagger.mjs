// SPDX-License-Identifier: MIT
// Port of en_core_web_sm 3.8.0 tok2vec (MultiHashEmbed + MaxoutWindowEncoder)
// and tagger (linear softmax layer) inference, following thinc 8.3 semantics:
//
//   features  NORM, PREFIX, SUFFIX, SHAPE (spaCy string ids), SPACY, IS_SPACE
//   embed     HashEmbed per feature (4 MurmurHash3 buckets summed), concat
//   reduce    Maxout(96, 576, nP=3) + LayerNorm
//   encode    4 x residual(expand_window(1) >> Maxout(96, 288, 3) >> LayerNorm),
//             run on the sequence padded with 4 zero rows on each side
//             (thinc with_array(pad=4); the pad rows are transformed too)
//   tagger    Softmax(50, 96) -> argmax (softmax is monotonic, not computed)
//
// Two numerically equivalent backends (float32 storage, float32 SIMD or
// float64 scalar accumulation; numpy/BLAS accumulates in float32 in its own
// order, so all of them differ from numpy by rounding noise only):
//   'wasm'  WebAssembly SIMD kernels (kernels/tagger_kernels.c), default
//   'js'    plain JavaScript, used when WebAssembly SIMD is unavailable

import { thincHash } from './speech-en-murmur.mjs';
import kernelsBase64 from './speech-en-kernels.mjs';

export class SpacyTagger {
  constructor(meta, buffer, tokenizer, py, { backend = 'auto' } = {}) {
    this.meta = meta;
    this.tokenizer = tokenizer;
    this.py = py;
    this.W = meta.width;
    this.P = meta.pieces;
    this.labels = meta.labels;
    this.pad = meta.window * meta.depth;
    this.seeds = meta.seeds;
    this.rows = meta.rows;
    this.featCache = new Map();
    const f32 = new Float32Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
    this.params = {};
    for (const l of meta.layout) {
      const n = l.shape.reduce((a, b) => a * b, 1);
      this.params[l.name] = f32.subarray(l.offset / 4, l.offset / 4 + n);
    }
    this.backend = null;
    if (backend === 'wasm' || backend === 'auto') {
      try {
        this.backend = new WasmBackend(meta, f32, this.params);
      } catch (e) {
        if (backend === 'wasm') throw e;
      }
    }
    if (!this.backend) this.backend = new JsBackend(meta, this.params);
    this.backendName = this.backend.name;
  }

  /** Lexical feature ids for a token (BigInt). */
  features(tok) {
    const py = this.py;
    const text = tok.text;
    const norm = tok.norm !== null && tok.norm !== undefined ? tok.norm : this.tokenizer.lexNorm(text);
    const cps = Array.from(text);
    const prefix = cps.length ? cps[0] : '';
    const suffix = cps.slice(-3).join('');
    const shape = wordShape(cps, py);
    const id = (x) => this.tokenizer.stringId(x);
    return [
      id(norm), id(prefix), id(suffix), id(shape),
      tok.spacy ? 1n : 0n, py.isspace(text) ? 1n : 0n,
    ];
  }

  /** Embedding row indices (4 per feature), cached per (text, norm, spacy). */
  buckets(tok) {
    const hasNorm = tok.norm !== null && tok.norm !== undefined;
    const key = (tok.spacy ? '1' : '0') + (hasNorm ? `1${tok.norm.length}:${tok.norm}` : '0') + tok.text;
    let b = this.featCache.get(key);
    if (b) return b;
    const feats = this.features(tok);
    b = new Int32Array(24);
    for (let f = 0; f < 6; f++) {
      const h = thincHash(feats[f], this.seeds[f]);
      const nV = this.rows[f];
      for (let k = 0; k < 4; k++) b[f * 4 + k] = h[k] % nV;
    }
    if (this.featCache.size >= 100000) this.featCache.clear();
    this.featCache.set(key, b);
    return b;
  }

  /** Returns Penn Treebank tags (spaCy tag_) for tokens [{text, norm, spacy}]. */
  tag(tokens) {
    const N = tokens.length;
    if (N === 0) return [];
    const W = this.W;
    const C = 6 * W;
    const X = this.backend.inputBuffer(N, C);
    const p = this.params;
    for (let t = 0; t < N; t++) {
      const b = this.buckets(tokens[t]);
      for (let f = 0; f < 6; f++) {
        const E = p['embed' + f + '.E'];
        const o = t * C + f * W;
        const r0 = b[f * 4] * W, r1 = b[f * 4 + 1] * W, r2 = b[f * 4 + 2] * W, r3 = b[f * 4 + 3] * W;
        for (let d = 0; d < W; d++) {
          // thinc gather_add: sum of the 4 rows in float32
          let s = Math.fround(E[r0 + d] + E[r1 + d]);
          s = Math.fround(s + E[r2 + d]);
          X[o + d] = Math.fround(s + E[r3 + d]);
        }
      }
    }
    const idx = this.backend.forward(N);
    const tags = new Array(N);
    for (let t = 0; t < N; t++) tags[t] = this.labels[idx[t]];
    return tags;
  }
}

// ------------------------------------------------------------------ wasm --
class WasmBackend {
  constructor(meta, f32, params) {
    this.name = 'wasm';
    this.meta = meta;
    const bytes = Uint8Array.from(atob(kernelsBase64), (c) => c.charCodeAt(0));
    const RESERVED = 1 << 20; // first MiB: wasm stack / statics
    this.memory = new WebAssembly.Memory({ initial: Math.ceil((RESERVED + f32.byteLength + (8 << 20)) / 65536) });
    const inst = new WebAssembly.Instance(new WebAssembly.Module(bytes), { env: { memory: this.memory } });
    this.k = inst.exports;
    // copy weights
    this.ptr = {};
    let off = RESERVED;
    new Float32Array(this.memory.buffer, off, f32.length).set(f32);
    for (const l of meta.layout) this.ptr[l.name] = off + l.offset;
    this.arena = off + f32.byteLength;
    this.arena = (this.arena + 15) & ~15;
    this.cap = 0;
  }

  ensure(N) {
    const W = this.meta.width, P = this.meta.pieces;
    const M = N + 2 * this.meta.window * this.meta.depth;
    if (M <= this.cap) return;
    const cap = Math.max(M, 2 * this.cap, 256);
    const sizes = {
      X: cap * 6 * W, H: cap * W, Z: cap * W, Y: cap * W, WIN: cap * 3 * W, OUT: cap,
    };
    let off = this.arena;
    this.buf = {};
    for (const [k, n] of Object.entries(sizes)) { this.buf[k] = off; off += ((n * 4 + 15) & ~15); }
    const need = off - this.memory.buffer.byteLength;
    if (need > 0) this.memory.grow(Math.ceil(need / 65536));
    this.cap = cap;
    void P;
  }

  inputBuffer(N, C) {
    this.ensure(N);
    return new Float32Array(this.memory.buffer, this.buf.X, N * C);
  }

  forward(N) {
    const { width: W, pieces: P, depth } = this.meta;
    const pad = this.meta.window * depth;
    const M = N + 2 * pad;
    const k = this.k, b = this.buf, p = this.ptr;
    k.maxout(b.X, N, 6 * W, p['maxout0.W'], p['maxout0.b'], W, P, b.H);
    k.layernorm(b.H, N, W, p['ln0.G'], p['ln0.b']);
    const mem = this.memory.buffer;
    const Z0 = new Float32Array(mem, b.Z, M * W);
    Z0.fill(0);
    Z0.set(new Float32Array(mem, b.H, N * W), pad * W);
    let Z = b.Z, Y = b.Y;
    for (let layer = 1; layer <= depth; layer++) {
      k.window3(Z, M, W, b.WIN);
      k.maxout(b.WIN, M, 3 * W, p['maxout' + layer + '.W'], p['maxout' + layer + '.b'], W, P, Y);
      k.layernorm(Y, M, W, p['ln' + layer + '.G'], p['ln' + layer + '.b']);
      k.add_inplace(Y, Z, M * W);
      [Z, Y] = [Y, Z];
    }
    k.argmax_linear(Z + pad * W * 4, N, W, p['softmax.W'], p['softmax.b'], this.meta.labels.length, b.OUT);
    return new Int32Array(this.memory.buffer, b.OUT, N);
  }
}

// -------------------------------------------------------------------- js --
class JsBackend {
  constructor(meta, params) {
    this.name = 'js';
    this.meta = meta;
    this.p = params;
  }

  inputBuffer(N, C) {
    this.X = new Float32Array(N * C);
    return this.X;
  }

  forward(N) {
    const { width: W, pieces: P, depth } = this.meta;
    const p = this.p;
    const pad = this.meta.window * depth;
    const M = N + 2 * pad;
    const H = maxoutJs(this.X, N, 6 * W, p['maxout0.W'], p['maxout0.b'], W, P);
    layerNormJs(H, N, W, p['ln0.G'], p['ln0.b']);
    let Z = new Float32Array(M * W);
    Z.set(H, pad * W);
    for (let layer = 1; layer <= depth; layer++) {
      const win = window3Js(Z, M, W);
      const Y = maxoutJs(win, M, 3 * W, p['maxout' + layer + '.W'], p['maxout' + layer + '.b'], W, P);
      layerNormJs(Y, M, W, p['ln' + layer + '.G'], p['ln' + layer + '.b']);
      for (let i = 0; i < Y.length; i++) Y[i] = Math.fround(Y[i] + Z[i]);
      Z = Y;
    }
    const SW = p['softmax.W'], Sb = p['softmax.b'];
    const L = this.meta.labels.length;
    const out = new Int32Array(N);
    for (let t = 0; t < N; t++) {
      const o = (t + pad) * W;
      let best = -Infinity, bi = 0;
      for (let l = 0; l < L; l++) {
        let s = 0;
        const wo = l * W;
        for (let d = 0; d < W; d++) s += Z[o + d] * SW[wo + d];
        s = Math.fround(Math.fround(s) + Sb[l]);
        if (s > best) { best = s; bi = l; }
      }
      out[t] = bi;
    }
    return out;
  }
}

function window3Js(Z, M, W) {
  const out = new Float32Array(M * 3 * W);
  for (let i = 0; i < M; i++) {
    const o = i * 3 * W;
    if (i > 0) out.set(Z.subarray((i - 1) * W, i * W), o);
    out.set(Z.subarray(i * W, (i + 1) * W), o + W);
    if (i + 1 < M) out.set(Z.subarray((i + 1) * W, (i + 2) * W), o + 2 * W);
  }
  return out;
}

function maxoutJs(X, N, K, Wt, b, nO, nP) {
  // Y[n, o] = max_p (X[n] . W[o*nP+p] + b[o*nP+p]); 2 rows x nP weight rows per step
  const Y = new Float32Array(N * nO);
  const R = nO * nP;
  const S = new Float64Array(2 * R);
  for (let n = 0; n < N; n += 2) {
    const two = n + 1 < N;
    const x0 = n * K, x1 = two ? x0 + K : x0;
    for (let r = 0; r < R; r += 3) {
      const w0 = r * K, w1 = w0 + K, w2 = w1 + K;
      let a0 = 0, a1 = 0, a2 = 0, c0 = 0, c1 = 0, c2 = 0;
      for (let i = 0; i < K; i++) {
        const u = X[x0 + i], v = X[x1 + i];
        const p0 = Wt[w0 + i], p1 = Wt[w1 + i], p2 = Wt[w2 + i];
        a0 += u * p0; a1 += u * p1; a2 += u * p2;
        c0 += v * p0; c1 += v * p1; c2 += v * p2;
      }
      S[r] = a0; S[r + 1] = a1; S[r + 2] = a2;
      S[R + r] = c0; S[R + r + 1] = c1; S[R + r + 2] = c2;
    }
    for (let q = 0; q < (two ? 2 : 1); q++) {
      for (let o = 0; o < nO; o++) {
        let best = -Infinity;
        for (let k = 0; k < nP; k++) {
          const s = Math.fround(Math.fround(S[q * R + o * nP + k]) + b[o * nP + k]);
          if (s > best) best = s;
        }
        Y[(n + q) * nO + o] = best;
      }
    }
  }
  if (nP !== 3) throw new Error('maxoutJs expects nP=3');
  return Y;
}

function layerNormJs(Y, N, D, G, lb) {
  for (let n = 0; n < N; n++) {
    const o = n * D;
    let mean = 0;
    for (let d = 0; d < D; d++) mean += Y[o + d];
    mean /= D;
    let v = 0;
    for (let d = 0; d < D; d++) { const t = Y[o + d] - mean; v += t * t; }
    const vf = Math.fround(Math.fround(v / D) + Math.fround(1e-8));
    const inv = Math.fround(1 / Math.fround(Math.sqrt(vf)));
    const m32 = Math.fround(mean);
    for (let d = 0; d < D; d++) {
      const xhat = Math.fround(Math.fround(Y[o + d] - m32) * inv);
      Y[o + d] = Math.fround(Math.fround(xhat * G[d]) + lb[d]);
    }
  }
}

export function wordShape(cps, py) {
  if (cps.length >= 100) return 'LONG';
  let shape = '';
  let last = '';
  let seq = 0;
  for (const ch of cps) {
    const cp = ch.codePointAt(0);
    let sc;
    if (py.isAlphaCp(cp)) sc = py.isUpperCp(cp) ? 'X' : 'x';
    else if (py.isDigitCp(cp)) sc = 'd';
    else sc = ch;
    if (sc === last) seq++;
    else { seq = 0; last = sc; }
    if (seq < 4) shape += sc;
  }
  return shape;
}
