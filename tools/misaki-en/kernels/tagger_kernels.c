// WASM SIMD kernels for the spaCy tok2vec/tagger forward pass.
// Build: see kernels/build.sh. All sizes K must be multiples of 4.
#include <wasm_simd128.h>

static inline float hsum(v128_t v) {
  return wasm_f32x4_extract_lane(v, 0) + wasm_f32x4_extract_lane(v, 1) +
         wasm_f32x4_extract_lane(v, 2) + wasm_f32x4_extract_lane(v, 3);
}

// Y[n, o] = max_p ( X[n,:] . W[o*nP+p, :] + b[o*nP+p] )
__attribute__((export_name("maxout")))
void maxout(const float* X, int N, int K, const float* W, const float* b, int nO, int nP, float* Y) {
  const int R = nO * nP;
  int n = 0;
  for (; n + 2 <= N; n += 2) {
    const float* x0 = X + n * K;
    const float* x1 = x0 + K;
    for (int o = 0; o < nO; o++) {
      float best0 = -__builtin_inff(), best1 = -__builtin_inff();
      for (int p = 0; p < nP; p++) {
        const float* w = W + (o * nP + p) * K;
        v128_t a0 = wasm_f32x4_splat(0), a1 = wasm_f32x4_splat(0);
        v128_t c0 = wasm_f32x4_splat(0), c1 = wasm_f32x4_splat(0);
        int i = 0;
        for (; i + 8 <= K; i += 8) {
          v128_t w0 = wasm_v128_load(w + i), w1 = wasm_v128_load(w + i + 4);
          a0 = wasm_f32x4_add(a0, wasm_f32x4_mul(wasm_v128_load(x0 + i), w0));
          a1 = wasm_f32x4_add(a1, wasm_f32x4_mul(wasm_v128_load(x0 + i + 4), w1));
          c0 = wasm_f32x4_add(c0, wasm_f32x4_mul(wasm_v128_load(x1 + i), w0));
          c1 = wasm_f32x4_add(c1, wasm_f32x4_mul(wasm_v128_load(x1 + i + 4), w1));
        }
        for (; i < K; i += 4) {
          v128_t w0 = wasm_v128_load(w + i);
          a0 = wasm_f32x4_add(a0, wasm_f32x4_mul(wasm_v128_load(x0 + i), w0));
          c0 = wasm_f32x4_add(c0, wasm_f32x4_mul(wasm_v128_load(x1 + i), w0));
        }
        float s0 = hsum(wasm_f32x4_add(a0, a1)) + b[o * nP + p];
        float s1 = hsum(wasm_f32x4_add(c0, c1)) + b[o * nP + p];
        if (s0 > best0) best0 = s0;
        if (s1 > best1) best1 = s1;
      }
      Y[n * nO + o] = best0;
      Y[(n + 1) * nO + o] = best1;
    }
  }
  for (; n < N; n++) {
    const float* x0 = X + n * K;
    for (int o = 0; o < nO; o++) {
      float best0 = -__builtin_inff();
      for (int p = 0; p < nP; p++) {
        const float* w = W + (o * nP + p) * K;
        v128_t a0 = wasm_f32x4_splat(0), a1 = wasm_f32x4_splat(0);
        int i = 0;
        for (; i + 8 <= K; i += 8) {
          a0 = wasm_f32x4_add(a0, wasm_f32x4_mul(wasm_v128_load(x0 + i), wasm_v128_load(w + i)));
          a1 = wasm_f32x4_add(a1, wasm_f32x4_mul(wasm_v128_load(x0 + i + 4), wasm_v128_load(w + i + 4)));
        }
        for (; i < K; i += 4) a0 = wasm_f32x4_add(a0, wasm_f32x4_mul(wasm_v128_load(x0 + i), wasm_v128_load(w + i)));
        float s0 = hsum(wasm_f32x4_add(a0, a1)) + b[o * nP + p];
        if (s0 > best0) best0 = s0;
      }
      Y[n * nO + o] = best0;
    }
  }
  (void)R;
}

// thinc LayerNorm: (x - mean) / sqrt(var + 1e-8) * G + b, per row
__attribute__((export_name("layernorm")))
void layernorm(float* Y, int N, int D, const float* G, const float* lb) {
  for (int n = 0; n < N; n++) {
    float* y = Y + n * D;
    double mean = 0;
    for (int d = 0; d < D; d++) mean += y[d];
    mean /= D;
    double var = 0;
    for (int d = 0; d < D; d++) { double t = y[d] - mean; var += t * t; }
    float v = (float)(var / D) + 1e-8f;
    float inv = 1.0f / __builtin_sqrtf(v);
    float m = (float)mean;
    for (int d = 0; d < D; d++) y[d] = ((y[d] - m) * inv) * G[d] + lb[d];
  }
}

// seq2col window 1: out[i] = [Z[i-1], Z[i], Z[i+1]] (zeros outside)
__attribute__((export_name("window3")))
void window3(const float* Z, int M, int D, float* out) {
  for (int i = 0; i < M; i++) {
    float* o = out + i * 3 * D;
    for (int d = 0; d < D; d++) {
      o[d] = i > 0 ? Z[(i - 1) * D + d] : 0.0f;
      o[D + d] = Z[i * D + d];
      o[2 * D + d] = i + 1 < M ? Z[(i + 1) * D + d] : 0.0f;
    }
  }
}

__attribute__((export_name("add_inplace")))
void add_inplace(float* Y, const float* Z, int n) {
  for (int i = 0; i < n; i++) Y[i] += Z[i];
}

// argmax over L classes of X[n,:] . W[l,:] + b[l]
__attribute__((export_name("argmax_linear")))
void argmax_linear(const float* X, int N, int K, const float* W, const float* b, int L, int* out) {
  for (int n = 0; n < N; n++) {
    const float* x = X + n * K;
    float best = -__builtin_inff();
    int bi = 0;
    for (int l = 0; l < L; l++) {
      const float* w = W + l * K;
      v128_t a = wasm_f32x4_splat(0);
      for (int i = 0; i < K; i += 4) a = wasm_f32x4_add(a, wasm_f32x4_mul(wasm_v128_load(x + i), wasm_v128_load(w + i)));
      float s = hsum(a) + b[l];
      if (s > best) { best = s; bi = l; }
    }
    out[n] = bi;
  }
}
