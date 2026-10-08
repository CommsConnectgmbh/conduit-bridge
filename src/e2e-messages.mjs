// Length-prefixed messages on top of a channel's byte stream.
//
// A channel delivers bytes in frame-sized pieces; chat events and RPC heads
// are whole JSON messages that can be larger than one frame. Each message is
// a u32 big-endian length followed by that many bytes. The reader enforces a
// maximum so a peer cannot make us buffer without bound.

import { utf8 } from "./e2e-noise.mjs";

export function encodeMessage(bytes) {
  const out = new Uint8Array(4 + bytes.length);
  new DataView(out.buffer).setUint32(0, bytes.length, false);
  out.set(bytes, 4);
  return out;
}

export const encodeJsonMessage = (obj) => encodeMessage(utf8(JSON.stringify(obj)));

export class MessageTooLarge extends Error {
  constructor(n, max) {
    super(`message of ${n} bytes exceeds ${max}`);
    this.name = "MessageTooLarge";
  }
}

/**
 * Feeds channel bytes in, emits complete messages. After `raw()` the reader
 * stops framing and passes the remaining bytes through unchanged (used for an
 * RPC body after its head).
 */
export class MessageReader {
  #buf = new Uint8Array(0);
  #max;
  #raw = false;
  #onMessage;
  #onRaw = null;

  constructor({ maxBytes, onMessage }) {
    this.#max = maxBytes;
    this.#onMessage = onMessage;
  }

  /** Switch to pass-through; anything buffered beyond the last message goes out first. */
  raw(onRaw) {
    this.#raw = true;
    this.#onRaw = onRaw;
    if (this.#buf.length) {
      const rest = this.#buf;
      this.#buf = new Uint8Array(0);
      onRaw(rest);
    }
  }

  push(chunk) {
    if (this.#raw) return this.#onRaw(chunk);
    const merged = new Uint8Array(this.#buf.length + chunk.length);
    merged.set(this.#buf);
    merged.set(chunk, this.#buf.length);
    this.#buf = merged;
    while (!this.#raw && this.#buf.length >= 4) {
      const n = new DataView(this.#buf.buffer, this.#buf.byteOffset).getUint32(0, false);
      if (n > this.#max) throw new MessageTooLarge(n, this.#max);
      if (this.#buf.length < 4 + n) break;
      const msg = this.#buf.slice(4, 4 + n);
      this.#buf = this.#buf.slice(4 + n);
      this.#onMessage(msg);
    }
    if (this.#raw && this.#buf.length) {
      const rest = this.#buf;
      this.#buf = new Uint8Array(0);
      this.#onRaw(rest);
    }
  }

  /** Bytes left that never formed a complete message. */
  get pending() { return this.#buf.length; }
}
