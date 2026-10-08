// SPDX-License-Identifier: MIT
// Hash functions used by spaCy/thinc, bit-exact.
//
// hashString: spaCy StringStore hash = murmurhash MurmurHash64A(utf8, seed=1)
// thincHash:  thinc NumpyOps.hash -> MurmurHash3_x86_128_uint64(key, seed),
//             returning four uint32 values.

const M64 = (1n << 64n) - 1n;
const enc = new TextEncoder();

export function murmurHash64A(bytes, seed) {
  const m = 0xc6a4a7935bd1e995n;
  const r = 47n;
  const len = bytes.length;
  let h = (BigInt(seed) ^ ((BigInt(len) * m) & M64)) & M64;
  const nblocks = len >> 3;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < nblocks; i++) {
    let k = dv.getBigUint64(i * 8, true);
    k = (k * m) & M64;
    k ^= k >> r;
    k = (k * m) & M64;
    h ^= k;
    h = (h * m) & M64;
  }
  const tail = nblocks * 8;
  switch (len & 7) {
    case 7: h ^= BigInt(bytes[tail + 6]) << 48n; // fallthrough
    case 6: h ^= BigInt(bytes[tail + 5]) << 40n; // fallthrough
    case 5: h ^= BigInt(bytes[tail + 4]) << 32n; // fallthrough
    case 4: h ^= BigInt(bytes[tail + 3]) << 24n; // fallthrough
    case 3: h ^= BigInt(bytes[tail + 2]) << 16n; // fallthrough
    case 2: h ^= BigInt(bytes[tail + 1]) << 8n; // fallthrough
    case 1:
      h ^= BigInt(bytes[tail]);
      h = (h * m) & M64;
      break;
    default:
  }
  h ^= h >> r;
  h = (h * m) & M64;
  h ^= h >> r;
  return h;
}

/** spaCy string hash (uint64 as BigInt). Empty string hashes to 0. */
export function hashString(s) {
  if (s.length === 0) return 0n;
  return murmurHash64A(enc.encode(s), 1);
}

const C1 = 0x87c37b91114253d5n;
const C2 = 0x4cf5ad432745937fn;
const F1 = 0xff51afd7ed558ccdn;
const F2 = 0xc4ceb9fe1a85ec53n;

/** thinc MurmurHash3_x86_128_uint64 -> [u32, u32, u32, u32] */
export function thincHash(val, seed) {
  const s = BigInt(seed);
  let h1 = (val * C1) & M64;
  h1 = ((h1 << 31n) | (h1 >> 33n)) & M64;
  h1 = (h1 * C2) & M64;
  h1 ^= s;
  h1 ^= 8n;
  let h2 = s ^ 8n;
  h1 = (h1 + h2) & M64;
  h2 = (h2 + h1) & M64;
  h1 ^= h1 >> 33n;
  h1 = (h1 * F1) & M64;
  h1 ^= h1 >> 33n;
  h1 = (h1 * F2) & M64;
  h1 ^= h1 >> 33n;
  h2 ^= h2 >> 33n;
  h2 = (h2 * F1) & M64;
  h2 ^= h2 >> 33n;
  h2 = (h2 * F2) & M64;
  h2 ^= h2 >> 33n;
  h1 = (h1 + h2) & M64;
  h2 = (h2 + h1) & M64;
  return [
    Number(h1 & 0xffffffffn), Number(h1 >> 32n),
    Number(h2 & 0xffffffffn), Number(h2 >> 32n),
  ];
}
