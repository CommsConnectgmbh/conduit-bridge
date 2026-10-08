// Encrypted session between a device (initiator) and the bridge (responder).
//
// Wire format over one WebSocket (binary messages only):
//   message 0, device -> bridge:  mode:u8 [codeId:16 bytes if mode=PAIR] | Noise message 0
//   message 1, bridge -> device:  Noise message 1
//   then:                         one Noise transport message per WebSocket message,
//                                 each carrying exactly one frame (frames.mjs)
//
// The mode byte only selects the pattern (IK to reconnect, IKpsk1 to pair) and
// which pairing code's PSK to use. It is not authenticated and does not need
// to be: a wrong mode or code id just makes the handshake fail.
//
// Everything that is sent goes through one promise chain, so Noise nonces are
// used in exactly the order the messages hit the wire. Incoming messages are
// likewise decrypted strictly in arrival order.

import { HandshakeState, NoiseError, utf8, concat } from "./e2e-noise.mjs";
import {
  decodeFrame, encodeOpen, encodeData, encodeClose, encodeWindowUpdate, encodePing, encodePong, encodeRekey, encodeGoaway,
  FrameError, T, MAX_PAYLOAD,
} from "./e2e-frames.mjs";

export const MODE_CONNECT = 0x01;
export const MODE_PAIR = 0x02;
export const CODE_ID_LEN = 16;
export const SUBPROTOCOL = "conduit.e2e.v1";

export const GOAWAY = Object.freeze({ NORMAL: 1000, PROTOCOL: 1002, LIMIT: 1008, REVOKED: 4001, ROTATE: 4002, TOO_MANY: 4003, TIMEOUT: 4004 });
export const CLOSE = Object.freeze({ NORMAL: 0, CANCEL: 1, ERROR: 2, REFUSED: 3 });

export const DEFAULTS = Object.freeze({
  window: 256 * 1024,
  maxChannels: 64,
  handshakeTimeoutMs: 10_000,
  pingIntervalMs: 25_000,
  pingTimeoutMs: 20_000,
  rekeyMessages: 2 ** 20,
  rekeyBytes: 2 ** 30,
  maxAgeMs: 24 * 3600_000,
  bufferedHighWater: 1024 * 1024,
});

/** Prologue binding a session to protocol version and tunnel host. */
export const prologueFor = (host) => concat(utf8("conduit-e2e-v1"), Uint8Array.of(0), utf8(String(host).toLowerCase()));

const jsonBytes = (o) => utf8(JSON.stringify(o));
const parseJson = (b) => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(b));

/**
 * Minimal transport the session runs on. In the browser and in the bridge
 * this wraps a WebSocket; tests use an in-memory pair.
 * @typedef {{
 *   send(bytes: Uint8Array): void,
 *   close(): void,
 *   bufferedAmount?: number,
 *   onMessage(cb: (bytes: Uint8Array) => void): void,
 *   onClose(cb: () => void): void,
 * }} Transport
 */

/** Waits for exactly one message, with a timeout; used during the handshake. */
function nextMessage(queue, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new NoiseError("handshake timeout")), timeoutMs);
    timer.unref?.();
    queue.waiter = (msg) => { clearTimeout(timer); resolve(msg); };
    queue.closed = () => { clearTimeout(timer); reject(new NoiseError("closed during handshake")); };
    if (queue.items.length) queue.waiter(queue.items.shift());
  });
}

function handshakeQueue(transport) {
  const q = { items: [], waiter: null, closed: null, done: false };
  transport.onMessage((m) => {
    if (q.done) return q.after?.(m);
    if (q.waiter) { const w = q.waiter; q.waiter = null; w(m); } else q.items.push(m);
  });
  transport.onClose(() => { if (!q.done) q.closed?.(); else q.afterClose?.(); });
  return q;
}

/**
 * Device side: connect to a known bridge, or pair with a code.
 * @param {{
 *   transport: Transport, host: string, device: import("./e2e-noise.mjs").KeyPair, bridgeKey: Uint8Array,
 *   hello: object, pair?: { codeId: Uint8Array, psk: Uint8Array }, options?: Partial<typeof DEFAULTS>,
 * }} opts
 */
export async function connect({ transport, host, device, bridgeKey, hello, pair, options = {} }) {
  const opt = { ...DEFAULTS, ...options };
  const q = handshakeQueue(transport);
  try {
    const hs = await HandshakeState.create({
      pattern: pair ? "IKpsk1" : "IK", initiator: true, prologue: prologueFor(host), s: device, rs: bridgeKey, psk: pair?.psk,
    });
    const m0 = await hs.writeMessage(jsonBytes(hello));
    const prefix = pair ? concat(Uint8Array.of(MODE_PAIR), pair.codeId) : Uint8Array.of(MODE_CONNECT);
    if (pair && pair.codeId.length !== CODE_ID_LEN) throw new NoiseError("bad code id");
    transport.send(concat(prefix, m0.message));
    const r1 = await hs.readMessage(await nextMessage(q, opt.handshakeTimeoutMs));
    const session = new Session({ transport, q, send: r1.send, recv: r1.recv, initiator: true, opt, handshakeHash: hs.handshakeHash });
    return { session, hello: parseJson(r1.payload) };
  } catch (e) {
    transport.close();
    throw e;
  }
}

/**
 * Bridge side: answer one incoming connection.
 * `authorize` decides after Noise has revealed and authenticated the device
 * key; it returns the hello to send back, or null to refuse silently.
 * @param {{
 *   transport: Transport, host: string, bridge: import("./e2e-noise.mjs").KeyPair,
 *   pskFor: (codeId: Uint8Array) => Uint8Array | null,
 *   authorize: (args: { mode: number, deviceKey: Uint8Array, hello: any, codeId: Uint8Array | null }) => Promise<object | null>,
 *   options?: Partial<typeof DEFAULTS>,
 * }} opts
 */
export async function accept({ transport, host, bridge, pskFor, authorize, options = {} }) {
  const opt = { ...DEFAULTS, ...options };
  const q = handshakeQueue(transport);
  try {
    const first = await nextMessage(q, opt.handshakeTimeoutMs);
    if (!(first instanceof Uint8Array) || first.length < 1) throw new NoiseError("empty first message");
    const mode = first[0];
    let codeId = null, psk, body;
    if (mode === MODE_CONNECT) {
      body = first.subarray(1);
    } else if (mode === MODE_PAIR) {
      if (first.length < 1 + CODE_ID_LEN) throw new NoiseError("short pairing message");
      codeId = Uint8Array.from(first.subarray(1, 1 + CODE_ID_LEN));
      psk = pskFor(codeId);
      if (!psk) throw new NoiseError("unknown pairing code");
      body = first.subarray(1 + CODE_ID_LEN);
    } else {
      throw new NoiseError("unknown mode");
    }
    const hs = await HandshakeState.create({ pattern: mode === MODE_PAIR ? "IKpsk1" : "IK", initiator: false, prologue: prologueFor(host), s: bridge, psk });
    const r0 = await hs.readMessage(body);
    let hello;
    try { hello = parseJson(r0.payload); } catch { throw new NoiseError("hello is not JSON"); }
    const reply = await authorize({ mode, deviceKey: hs.remoteStatic, hello, codeId });
    if (!reply) throw new NoiseError("device not authorized");
    const m1 = await hs.writeMessage(jsonBytes(reply));
    transport.send(m1.message);
    const session = new Session({ transport, q, send: m1.send, recv: m1.recv, initiator: false, opt, handshakeHash: hs.handshakeHash });
    return { session, deviceKey: hs.remoteStatic, hello, mode, codeId };
  } catch (e) {
    // No reply on failure: a refused or broken handshake learns nothing.
    transport.close();
    throw e;
  }
}

// ── session and channels ────────────────────────────────────────────────────

export class Session {
  #t; #send; #recv; #opt;
  #sendChain = Promise.resolve();
  #recvChain = Promise.resolve();
  #channels = new Map();
  #nextId;
  #sentMessages = 0;
  #sentBytes = 0;
  #closed = false;
  #pingTimer = null;
  #pongTimer = null;
  #ageTimer = null;
  #listeners = { channel: [], close: [] };
  handshakeHash;
  closeInfo = null;

  constructor({ transport, q, send, recv, initiator, opt, handshakeHash }) {
    this.#t = transport;
    this.#send = send;
    this.#recv = recv;
    this.#opt = opt;
    this.#nextId = initiator ? 1 : 2;
    this.handshakeHash = handshakeHash;
    q.done = true;
    q.after = (m) => this.#onWire(m);
    // Finish decrypting what already arrived (a GOAWAY is usually the last
    // message before the socket closes), then tear down.
    q.afterClose = () => { this.#recvChain.then(() => this.#teardown({ code: GOAWAY.NORMAL, reason: "transport closed", local: false })); };
    for (const m of q.items.splice(0)) this.#onWire(m);
    this.#armPing();
    this.#ageTimer = setTimeout(() => this.goaway(GOAWAY.ROTATE, "session age"), opt.maxAgeMs);
    this.#ageTimer.unref?.();
  }

  get closed() { return this.#closed; }
  get channelCount() { return this.#channels.size; }

  on(event, cb) { this.#listeners[event].push(cb); return this; }

  // ── sending ──

  /** Encrypt and send one frame, in order. Resolves when it was handed to the transport. */
  #sendFrame(frame) {
    const job = this.#sendChain.then(async () => {
      if (this.#closed) throw new Error("session closed");
      if (this.#t.bufferedAmount !== undefined) {
        while (this.#t.bufferedAmount > this.#opt.bufferedHighWater && !this.#closed) await new Promise((r) => setTimeout(r, 10));
      }
      const ct = await this.#send.encryptWithAd(new Uint8Array(0), frame);
      this.#t.send(ct);
      this.#sentMessages += 1;
      this.#sentBytes += ct.length;
      if (this.#sentMessages >= this.#opt.rekeyMessages || this.#sentBytes >= this.#opt.rekeyBytes) {
        // Announce under the old key, then switch; the peer switches after
        // decrypting the announcement.
        this.#t.send(await this.#send.encryptWithAd(new Uint8Array(0), encodeRekey()));
        await this.#send.rekey();
        this.#sentMessages = 0;
        this.#sentBytes = 0;
      }
    });
    this.#sendChain = job.catch(() => {});
    return job;
  }

  /** Open a channel of the given kind. */
  async open(kind, params = {}) {
    if (this.#closed) throw new Error("session closed");
    if (this.#channels.size >= this.#opt.maxChannels) throw new Error("too many channels");
    const id = this.#nextId;
    this.#nextId += 2;
    const ch = new Channel(this, id, kind, params, this.#opt.window, null);
    this.#channels.set(id, ch);
    await this.#sendFrame(encodeOpen(id, kind, params, this.#opt.window));
    return ch;
  }

  _sendData(id, bytes, end) { return this.#sendFrame(encodeData(id, bytes, end)); }
  _sendWindow(id, credits) { return this.#sendFrame(encodeWindowUpdate(id, credits)); }
  _sendClose(id, code, reason) { return this.#sendFrame(encodeClose(id, code, reason)); }
  _forget(id) { this.#channels.delete(id); }

  /** Tell the peer we are going away, then close. */
  async goaway(code = GOAWAY.NORMAL, reason = "") {
    if (this.#closed) return;
    try { await this.#sendFrame(encodeGoaway(code, reason)); } catch { /* closing anyway */ }
    this.#teardown({ code, reason, local: true });
  }

  /** Close immediately without telling the peer (AEAD failure, abuse). */
  terminate(reason = "terminated") {
    this.#teardown({ code: GOAWAY.PROTOCOL, reason, local: true });
  }

  #teardown(info) {
    if (this.#closed) return;
    this.#closed = true;
    this.closeInfo = info;
    clearTimeout(this.#pingTimer);
    clearTimeout(this.#pongTimer);
    clearTimeout(this.#ageTimer);
    for (const ch of this.#channels.values()) ch._sessionClosed(info);
    this.#channels.clear();
    try { this.#t.close(); } catch { /* already closed */ }
    for (const cb of this.#listeners.close) cb(info);
  }

  // ── keepalive ──

  #armPing() {
    clearTimeout(this.#pingTimer);
    this.#pingTimer = setTimeout(() => {
      const opaque = globalThis.crypto.getRandomValues(new Uint8Array(8));
      this.#sendFrame(encodePing(opaque)).catch(() => {});
      this.#pongTimer = setTimeout(() => this.terminate("ping timeout"), this.#opt.pingTimeoutMs);
      this.#pongTimer.unref?.();
    }, this.#opt.pingIntervalMs);
    this.#pingTimer.unref?.();
  }

  // ── receiving ──

  #onWire(bytes) {
    this.#recvChain = this.#recvChain.then(async () => {
      if (this.#closed) return;
      let plain;
      try {
        plain = await this.#recv.decryptWithAd(new Uint8Array(0), bytes);
      } catch {
        // AEAD failure: drop the session at once, no GOAWAY (spec 5.1, A9).
        return this.terminate("decryption failed");
      }
      let f;
      try {
        f = decodeFrame(plain);
      } catch (e) {
        if (e instanceof FrameError) return this.goaway(GOAWAY.PROTOCOL, e.message);
        throw e;
      }
      await this.#handle(f);
    }).catch((e) => this.goaway(GOAWAY.PROTOCOL, String(e?.message || e)));
  }

  async #handle(f) {
    // Any authenticated frame proves the peer is alive.
    clearTimeout(this.#pongTimer);
    this.#armPing();
    switch (f.type) {
      case T.PING: return this.#sendFrame(encodePong(f.payload)).catch(() => {});
      case T.PONG: return;
      case T.REKEY: return this.#recv.rekey();
      case T.GOAWAY: return this.#teardown({ code: f.code, reason: f.reason, local: false });
      case T.OPEN: {
        // The peer must use its own parity: odd ids from the device, even from the bridge.
        const peerParity = this.#nextId % 2 === 1 ? 0 : 1;
        if (f.channel % 2 !== peerParity || this.#channels.has(f.channel)) return this.goaway(GOAWAY.PROTOCOL, "bad channel id");
        if (this.#channels.size >= this.#opt.maxChannels) return this._sendClose(f.channel, CLOSE.REFUSED, "too many channels");
        const ch = new Channel(this, f.channel, f.kind, f.params, this.#opt.window, f.window);
        this.#channels.set(f.channel, ch);
        // The opener's window is what we may send; acknowledge by granting ours.
        await this._sendWindow(f.channel, this.#opt.window);
        for (const cb of this.#listeners.channel) cb(ch);
        return;
      }
      default: {
        const ch = this.#channels.get(f.channel);
        if (!ch) {
          // Frames for a channel we already closed can still be in flight.
          if (f.type === T.CLOSE || f.type === T.DATA || f.type === T.WINDOW_UPDATE) return;
          return this.goaway(GOAWAY.PROTOCOL, "unknown channel");
        }
        return ch._frame(f);
      }
    }
  }
}

/**
 * One multiplexed stream. Sending respects the peer's credit window; the
 * receiver grants credit back as the application consumes data.
 */
export class Channel {
  #s; #sendCredit; #recvAllowed; #recvConsumed = 0;
  #waiters = [];
  #listeners = { data: [], end: [], close: [] };
  #ended = false;
  #closed = false;
  #remoteOpened;

  constructor(session, id, kind, params, ourWindow, peerWindow) {
    this.#s = session;
    this.id = id;
    this.kind = kind;
    this.params = params;
    this.#recvAllowed = ourWindow;
    this.ourWindow = ourWindow;
    // For channels we opened, the peer grants its window in a WINDOW_UPDATE;
    // for channels the peer opened, its window comes with the OPEN.
    this.#sendCredit = peerWindow ?? 0;
    this.#remoteOpened = peerWindow !== null;
  }

  get closed() { return this.#closed; }

  on(event, cb) { this.#listeners[event].push(cb); return this; }

  async #awaitCredit() {
    while (this.#sendCredit <= 0 && !this.#closed) await new Promise((r) => this.#waiters.push(r));
    if (this.#closed) throw new Error("channel closed");
  }

  /** Send bytes, split into frames and paced by the peer's credit. */
  async write(bytes, { end = false } = {}) {
    if (this.#closed) throw new Error("channel closed");
    let off = 0;
    do {
      await this.#awaitCredit();
      const n = Math.min(bytes.length - off, MAX_PAYLOAD, this.#sendCredit);
      const last = off + n >= bytes.length;
      this.#sendCredit -= n;
      await this.#s._sendData(this.id, bytes.subarray(off, off + n), end && last);
      off += n;
    } while (off < bytes.length);
  }

  /** JSON convenience used by rpc and chat channels. */
  writeJson(obj, opts) { return this.write(utf8(JSON.stringify(obj)), opts); }

  end() { return this.#s._sendData(this.id, new Uint8Array(0), true); }

  /** Close the channel locally and tell the peer. */
  async close(code = CLOSE.NORMAL, reason = "") {
    if (this.#closed) return;
    this.#finish({ code, reason, local: true });
    await this.#s._sendClose(this.id, code, reason).catch(() => {});
  }

  #finish(info) {
    if (this.#closed) return;
    this.#closed = true;
    this.#s._forget(this.id);
    for (const w of this.#waiters.splice(0)) w();
    for (const cb of this.#listeners.close) cb(info);
  }

  _sessionClosed(info) { this.#finish({ ...info, session: true }); }

  async _frame(f) {
    switch (f.type) {
      case T.WINDOW_UPDATE:
        if (this.#sendCredit + f.credits > 0x7fffffff) return this.#s.goaway(GOAWAY.PROTOCOL, "credit overflow");
        this.#sendCredit += f.credits;
        for (const w of this.#waiters.splice(0)) w();
        return;
      case T.DATA: {
        if (this.#ended) return this.#s.goaway(GOAWAY.PROTOCOL, "data after end of stream");
        if (f.payload.length > this.#recvAllowed) return this.#s.goaway(GOAWAY.PROTOCOL, "peer exceeded flow-control window");
        this.#recvAllowed -= f.payload.length;
        if (f.payload.length) for (const cb of this.#listeners.data) cb(f.payload);
        // Grant credit back in halves, so a busy stream is never stalled.
        this.#recvConsumed += f.payload.length;
        if (this.#recvConsumed >= this.ourWindow / 2) {
          const grant = this.#recvConsumed;
          this.#recvConsumed = 0;
          this.#recvAllowed += grant;
          this.#s._sendWindow(this.id, grant).catch(() => {});
        }
        if (f.end) {
          this.#ended = true;
          for (const cb of this.#listeners.end) cb();
        }
        return;
      }
      case T.CLOSE:
        return this.#finish({ code: f.code, reason: f.reason, local: false });
      case T.OPEN:
        return this.#s.goaway(GOAWAY.PROTOCOL, "duplicate OPEN");
      default:
        return this.#s.goaway(GOAWAY.PROTOCOL, "unexpected frame");
    }
  }
}
