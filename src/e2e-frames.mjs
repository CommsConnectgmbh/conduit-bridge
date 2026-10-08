// Plaintext frames inside one Noise transport message.
//
//   type:u8 | flags:u8 | channel:u32 big-endian | payload
//
// One WebSocket binary message carries exactly one Noise transport message,
// which carries exactly one frame. The decoder is strict: anything outside
// the grammar below is a protocol error and ends the session, because a
// lenient parser on the bridge is an attack surface reachable from any paired
// device.

export const HEADER = 6;
export const MAX_PAYLOAD = 65500; // 65535 - 16 (AEAD tag) - 6 (header), rounded down
export const MAX_REASON = 200;

export const T = Object.freeze({
  OPEN: 0x01,
  DATA: 0x02,
  CLOSE: 0x03,
  WINDOW_UPDATE: 0x04,
  PING: 0x05,
  PONG: 0x06,
  REKEY: 0x07,
  GOAWAY: 0x08,
});
const TYPE_NAMES = Object.fromEntries(Object.entries(T).map(([k, v]) => [v, k]));

export const FLAG_END_STREAM = 0x01;

/** Channel kinds carried in OPEN. */
export const KIND = Object.freeze({
  RPC: 0x01,
  CHAT: 0x02,
  UPLOAD: 0x03,
  AUDIO_IN: 0x04,
  AUDIO_OUT: 0x05,
});
const KINDS = new Set(Object.values(KIND));

export class FrameError extends Error {
  constructor(message) {
    super(message);
    this.name = "FrameError";
  }
}

const dec = new TextDecoder("utf-8", { fatal: true });
const enc = new TextEncoder();

function header(type, flags, channel, payloadLength) {
  const buf = new Uint8Array(HEADER + payloadLength);
  const dv = new DataView(buf.buffer);
  dv.setUint8(0, type);
  dv.setUint8(1, flags);
  dv.setUint32(2, channel, false);
  return buf;
}

function frame(type, flags, channel, payload) {
  if (payload.length > MAX_PAYLOAD) throw new FrameError("payload too large");
  const buf = header(type, flags, channel, payload.length);
  buf.set(payload, HEADER);
  return buf;
}

function reasonBytes(reason) {
  const b = enc.encode(String(reason || ""));
  if (b.length <= MAX_REASON) return b;
  // Cut on a code-point boundary so the receiver's fatal decoder accepts it.
  let n = MAX_REASON;
  while (n > 0 && (b[n] & 0xc0) === 0x80) n--;
  return b.subarray(0, n);
}

// ── encoders ────────────────────────────────────────────────────────────────

export const encodeOpen = (channel, kind, params, window) => {
  const json = enc.encode(JSON.stringify({ ...params, window }));
  const p = new Uint8Array(1 + json.length);
  p[0] = kind;
  p.set(json, 1);
  return frame(T.OPEN, 0, channel, p);
};
export const encodeData = (channel, payload, end = false) => frame(T.DATA, end ? FLAG_END_STREAM : 0, channel, payload);
export const encodeClose = (channel, code, reason) => {
  const r = reasonBytes(reason);
  const p = new Uint8Array(2 + r.length);
  new DataView(p.buffer).setUint16(0, code, false);
  p.set(r, 2);
  return frame(T.CLOSE, 0, channel, p);
};
export const encodeWindowUpdate = (channel, credits) => {
  const p = new Uint8Array(4);
  new DataView(p.buffer).setUint32(0, credits, false);
  return frame(T.WINDOW_UPDATE, 0, channel, p);
};
export const encodePing = (opaque) => frame(T.PING, 0, 0, opaque);
export const encodePong = (opaque) => frame(T.PONG, 0, 0, opaque);
export const encodeRekey = () => frame(T.REKEY, 0, 0, new Uint8Array(0));
export const encodeGoaway = (code, reason) => {
  const r = reasonBytes(reason);
  const p = new Uint8Array(2 + r.length);
  new DataView(p.buffer).setUint16(0, code, false);
  p.set(r, 2);
  return frame(T.GOAWAY, 0, 0, p);
};

// ── decoder ─────────────────────────────────────────────────────────────────

/**
 * @param {Uint8Array} buf one decrypted Noise transport payload
 * @returns {{ type: number, name: string, flags: number, channel: number, payload: Uint8Array,
 *   kind?: number, params?: object, window?: number, code?: number, reason?: string, credits?: number, end?: boolean }}
 */
export function decodeFrame(buf) {
  if (!(buf instanceof Uint8Array) || buf.length < HEADER) throw new FrameError("frame too short");
  if (buf.length - HEADER > MAX_PAYLOAD) throw new FrameError("frame too large");
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const type = dv.getUint8(0);
  const flags = dv.getUint8(1);
  const channel = dv.getUint32(2, false);
  const payload = buf.subarray(HEADER);
  const name = TYPE_NAMES[type];
  if (!name) throw new FrameError(`unknown frame type ${type}`);
  if (type === T.DATA ? (flags & ~FLAG_END_STREAM) !== 0 : flags !== 0) throw new FrameError("invalid flags");

  const control = type === T.PING || type === T.PONG || type === T.REKEY || type === T.GOAWAY;
  if (control !== (channel === 0)) throw new FrameError(control ? "control frame on a stream channel" : "stream frame on channel 0");

  const f = { type, name, flags, channel, payload };
  switch (type) {
    case T.OPEN: {
      if (payload.length < 3) throw new FrameError("OPEN too short");
      const kind = payload[0];
      if (!KINDS.has(kind)) throw new FrameError(`unknown channel kind ${kind}`);
      let params;
      try {
        params = JSON.parse(dec.decode(payload.subarray(1)));
      } catch {
        throw new FrameError("OPEN parameters are not JSON");
      }
      if (params === null || typeof params !== "object" || Array.isArray(params)) throw new FrameError("OPEN parameters must be an object");
      const window = params.window;
      if (!Number.isInteger(window) || window < 1 || window > 0x7fffffff) throw new FrameError("OPEN needs a positive window");
      delete params.window;
      return { ...f, kind, params, window };
    }
    case T.DATA:
      return { ...f, end: (flags & FLAG_END_STREAM) !== 0 };
    case T.CLOSE:
    case T.GOAWAY: {
      if (payload.length < 2 || payload.length > 2 + MAX_REASON) throw new FrameError(`${name} has a bad length`);
      const code = new DataView(payload.buffer, payload.byteOffset).getUint16(0, false);
      let reason;
      try { reason = dec.decode(payload.subarray(2)); } catch { throw new FrameError(`${name} reason is not UTF-8`); }
      return { ...f, code, reason };
    }
    case T.WINDOW_UPDATE: {
      if (payload.length !== 4) throw new FrameError("WINDOW_UPDATE has a bad length");
      const credits = new DataView(payload.buffer, payload.byteOffset).getUint32(0, false);
      if (credits === 0 || credits > 0x7fffffff) throw new FrameError("WINDOW_UPDATE credits out of range");
      return { ...f, credits };
    }
    case T.PING:
    case T.PONG:
      if (payload.length !== 8) throw new FrameError(`${name} must carry 8 bytes`);
      return f;
    case T.REKEY:
      if (payload.length !== 0) throw new FrameError("REKEY carries no payload");
      return f;
    default:
      throw new FrameError("unreachable");
  }
}
