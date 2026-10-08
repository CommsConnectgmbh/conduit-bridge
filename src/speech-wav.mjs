// WAV in and out for the speech endpoints.
//
// The app records with an AudioWorklet and sends 16-bit PCM mono WAV, so the
// bridge needs neither ffmpeg nor a codec. Parsing is strict on purpose: the
// body comes over the tunnel from any paired device, and a header that lies
// about its sizes must not make us read past the buffer or allocate based on
// a number the client chose.

export const MIN_RATE = 8000;
export const MAX_RATE = 48000;

export class WavError extends Error {
  constructor(message) {
    super(message);
    this.name = "WavError";
  }
}

/**
 * Parse a PCM16 mono WAV buffer into float samples.
 * @param {Buffer} buf
 * @param {{ maxSeconds: number }} limits
 * @returns {{ samples: Float32Array, sampleRate: number, seconds: number }}
 */
export function parseWav(buf, { maxSeconds }) {
  if (!Buffer.isBuffer(buf) || buf.length < 44) throw new WavError("not a WAV file");
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new WavError("not a WAV file");
  }
  const riffSize = buf.readUInt32LE(4);
  if (riffSize + 8 !== buf.length) throw new WavError("RIFF size does not match the body");

  let fmt = null;
  let data = null;
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const start = off + 8;
    const end = start + size;
    if (end > buf.length) throw new WavError(`chunk ${JSON.stringify(id)} runs past the end`);
    if (id === "fmt ") {
      if (fmt) throw new WavError("duplicate fmt chunk");
      if (size < 16) throw new WavError("fmt chunk too short");
      fmt = {
        format: buf.readUInt16LE(start),
        channels: buf.readUInt16LE(start + 2),
        sampleRate: buf.readUInt32LE(start + 4),
        byteRate: buf.readUInt32LE(start + 8),
        blockAlign: buf.readUInt16LE(start + 12),
        bits: buf.readUInt16LE(start + 14),
      };
    } else if (id === "data") {
      if (data) throw new WavError("duplicate data chunk");
      data = { start, size };
    }
    // Chunks are word-aligned; an odd size is followed by one pad byte.
    off = end + (size & 1);
  }
  if (!fmt) throw new WavError("missing fmt chunk");
  if (!data) throw new WavError("missing data chunk");
  if (fmt.format !== 1) throw new WavError("only PCM is accepted");
  if (fmt.channels !== 1) throw new WavError("only mono is accepted");
  if (fmt.bits !== 16) throw new WavError("only 16-bit samples are accepted");
  if (fmt.sampleRate < MIN_RATE || fmt.sampleRate > MAX_RATE) throw new WavError("unsupported sample rate");
  if (fmt.blockAlign !== 2 || fmt.byteRate !== fmt.sampleRate * 2) throw new WavError("inconsistent fmt chunk");
  if (data.size % 2 !== 0) throw new WavError("odd number of data bytes");

  const n = data.size / 2;
  const seconds = n / fmt.sampleRate;
  if (seconds > maxSeconds) throw new WavError("recording too long");
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i++) samples[i] = buf.readInt16LE(data.start + i * 2) / 32768;
  return { samples, sampleRate: fmt.sampleRate, seconds };
}

/**
 * Encode float samples as a PCM16 mono WAV.
 * @param {Float32Array} samples
 * @param {number} sampleRate
 */
export function encodeWav(samples, sampleRate) {
  const dataBytes = samples.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(s < 0 ? s * 32768 : s * 32767), 44 + i * 2);
  }
  return buf;
}
