// Bridge side of the end-to-end layer: the /e2e WebSocket.
//
// Everything a device does goes through here once paired. An RPC channel is
// replayed into the existing HTTP handlers through an in-memory request and
// response, a chat channel is handed to the existing chat socket handler as a
// WebSocket look-alike. The handlers themselves do not know whether a request
// came in plain (only the loopback page still does that) or end-to-end.

import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { WebSocketServer } from "ws";
import { accept, SUBPROTOCOL, MODE_PAIR, GOAWAY, CLOSE } from "./e2e-session.mjs";
import { KIND } from "./e2e-frames.mjs";
import { MessageReader, encodeJsonMessage, encodeMessage } from "./e2e-messages.mjs";
import { pskFor, consumePairCode } from "./e2e-pairing.mjs";

export const LIMITS = Object.freeze({
  pendingHandshakes: 16,
  sessionsPerDevice: 8,
  handshakesPerPeerPerMinute: 30,
  rpcHeadBytes: 64 * 1024,
  rpcBodyBytes: 32 * 1024 * 1024,
  chatMessageBytes: 2 * 1024 * 1024,
});

export const deviceIdFor = (pubkey) => createHash("sha256").update(pubkey).digest("hex").slice(0, 16);
const hex = (b) => Buffer.from(b).toString("hex");

/**
 * @param {{
 *   host: () => string,                     tunnel host the session is bound to
 *   identity: import("./e2e-noise.mjs").KeyPair,
 *   version: string,
 *   devices: { get(pubkeyHex): any, add(rec): void, touch(pubkeyHex): void },
 *   handleHttp: (req, res, auth) => Promise<void>,
 *   handleChat: (ws, sid) => boolean,        returns false to refuse the sid
 *   log: (level, msg, meta?) => void,
 *   options?: object,                       session option overrides (tests)
 * }} deps
 */
export function createE2eEndpoint(deps) {
  const wss = new WebSocketServer({
    noServer: true,
    // One Noise transport message per WebSocket message, at most 65535 bytes;
    // the first message carries a 17-byte prefix on top.
    maxPayload: 65535 + 17,
    perMessageDeflate: false,
    handleProtocols: (protocols) => (protocols.has(SUBPROTOCOL) ? SUBPROTOCOL : false),
  });
  const sessionsByDevice = new Map();
  const handshakesByPeer = new Map();
  let pending = 0;

  function peerAllowed(peer) {
    const now = Date.now();
    const list = (handshakesByPeer.get(peer) || []).filter((t) => t > now - 60_000);
    list.push(now);
    handshakesByPeer.set(peer, list);
    if (handshakesByPeer.size > 10_000) handshakesByPeer.clear();
    return list.length <= LIMITS.handshakesPerPeerPerMinute;
  }

  /** Call from the HTTP server's upgrade handler for path /e2e. */
  function handleUpgrade(req, socket, head) {
    const protocols = String(req.headers["sec-websocket-protocol"] || "").split(",").map((s) => s.trim());
    if (!protocols.includes(SUBPROTOCOL)) {
      // Old clients asking for anything else get a plain refusal, never a
      // fallback to an unencrypted path.
      socket.write("HTTP/1.1 426 Upgrade Required\r\n\r\n");
      return socket.destroy();
    }
    const peer = String(req.headers["cf-connecting-ip"] || req.socket.remoteAddress || "unknown").slice(0, 64);
    if (pending >= LIMITS.pendingHandshakes || !peerAllowed(peer)) {
      socket.write("HTTP/1.1 429 Too Many Requests\r\n\r\n");
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => onSocket(ws, peer));
  }

  async function onSocket(ws, peer) {
    pending += 1;
    const transport = wsTransport(ws);
    let result;
    try {
      result = await accept({
        transport, host: deps.host(), bridge: deps.identity, options: deps.options,
        pskFor,
        authorize: async ({ mode, deviceKey, hello, codeId }) => authorize({ mode, deviceKey, hello, codeId }),
      });
    } catch (e) {
      deps.log("warn", "e2e_handshake_failed", { reason: String(e?.message || e).slice(0, 80) });
      return;
    } finally {
      pending -= 1;
    }
    const { session, deviceKey } = result;
    const key = hex(deviceKey);
    const device = deps.devices.get(key);
    const set = sessionsByDevice.get(key) || new Set();
    sessionsByDevice.set(key, set);
    set.add(session);
    if (set.size > LIMITS.sessionsPerDevice) {
      const oldest = set.values().next().value;
      oldest.goaway(GOAWAY.TOO_MANY, "too many sessions");
    }
    const auth = { email: device.email, deviceId: device.device_id, jti: null, sid: null, e2e: true };
    deps.log("info", "e2e_session_open", { device: device.device_id });
    session.on("close", (info) => {
      set.delete(session);
      if (!set.size) sessionsByDevice.delete(key);
      deps.log("info", "e2e_session_close", { device: device.device_id, code: info.code });
    });
    session.on("channel", (ch) => {
      deps.devices.touch(key);
      if (ch.kind === KIND.RPC) return serveRpc(ch, auth).catch((e) => {
        deps.log("error", "e2e_rpc_failed", { device: device.device_id, err: String(e?.message || e).slice(0, 120) });
        ch.close(CLOSE.ERROR, "internal error");
      });
      if (ch.kind === KIND.CHAT) return serveChat(ch, auth);
      ch.close(CLOSE.REFUSED, "unsupported channel kind");
    });
  }

  async function authorize({ mode, deviceKey, hello, codeId }) {
    const key = hex(deviceKey);
    if (mode === MODE_PAIR) {
      // The PSK already proved the device holds this code; consume it now.
      const code = consumePairCode(codeId);
      if (!code) return null;
      const deviceId = deviceIdFor(deviceKey);
      deps.devices.add({
        pubkey: key, deviceId, email: code.email,
        label: String(hello?.label || "Device").slice(0, 80),
        platform: String(hello?.client || "web").slice(0, 20),
        pairedVia: code.issuedBy,
      });
      deps.log("info", "e2e_device_paired", { device: deviceId, via: code.issuedBy });
      return { v: 1, bridge_version: deps.version, device_id: deviceId, email: code.email, paired: true };
    }
    const dev = deps.devices.get(key);
    if (!dev || dev.revoked_at) return null;
    return { v: 1, bridge_version: deps.version, device_id: dev.device_id, email: dev.email, paired: false };
  }

  /** Revoke: end every live session of that device right away. */
  function kickDevice(pubkeyHex) {
    for (const s of sessionsByDevice.get(pubkeyHex) || []) s.goaway(GOAWAY.REVOKED, "revoked");
  }

  // ── RPC: one request per channel ───────────────────────────────────────────

  async function serveRpc(ch, auth) {
    const method = String(ch.params.method || "GET").toUpperCase();
    const path = String(ch.params.path || "");
    if (!/^\/api\/[A-Za-z0-9/_.\-]{1,200}(\?[^#]{0,2000})?$/.test(path) || !["GET", "POST", "DELETE", "PATCH", "PUT"].includes(method)) {
      return respondJson(ch, 400, { ok: false, error: "bad request" });
    }
    const headers = {};
    for (const [k, v] of Object.entries(ch.params.headers || {})) {
      const name = String(k).toLowerCase();
      // Authorization never comes from the device: the session is the identity.
      if (name === "authorization" || name === "host" || name === "cookie") continue;
      if (typeof v === "string" && v.length <= 1024) headers[name] = v;
    }
    const body = new Readable({ read() {} });
    let received = 0;
    ch.on("data", (p) => {
      received += p.length;
      if (received > LIMITS.rpcBodyBytes) { body.destroy(new Error("body too large")); ch.close(CLOSE.ERROR, "body too large"); return; }
      body.push(Buffer.from(p));
    });
    ch.on("end", () => body.push(null));
    ch.on("close", () => { if (!body.readableEnded) body.destroy(); });
    const req = Object.assign(body, {
      method, url: path, headers, httpVersion: "1.1",
      socket: { remoteAddress: "e2e" },
      connection: { remoteAddress: "e2e" },
    });
    const res = new E2eResponse(ch);
    await deps.handleHttp(req, res, auth);
  }

  function respondJson(ch, status, obj) {
    const res = new E2eResponse(ch);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  }

  // ── chat: the existing socket handler on a channel ─────────────────────────

  function serveChat(ch, auth) {
    const sid = String(ch.params.sid || "");
    const ws = new ChannelSocket(ch, { ...auth, sid });
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(sid) || !deps.handleChat(ws, sid)) {
      ch.close(CLOSE.REFUSED, "session refused");
    }
  }

  return { handleUpgrade, kickDevice, close: () => wss.close() };
}

/** `ws` WebSocket as a session transport. Text frames end the connection. */
function wsTransport(ws) {
  return {
    send(bytes) { ws.send(bytes, { binary: true }); },
    close() { try { ws.terminate(); } catch { /* gone */ } },
    get bufferedAmount() { return ws.bufferedAmount; },
    onMessage(cb) {
      ws.on("message", (data, isBinary) => {
        if (!isBinary) { try { ws.terminate(); } catch { /* gone */ } return; }
        cb(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      });
    },
    onClose(cb) { ws.on("close", cb); ws.on("error", () => {}); },
  };
}

/**
 * Enough of http.ServerResponse for the bridge's handlers: status and headers
 * go out first as one JSON message, the body follows as raw bytes, and end()
 * closes the stream.
 */
export class E2eResponse {
  #ch; #headSent = false; #chain = Promise.resolve();
  statusCode = 200;
  headersSent = false;
  writableEnded = false;
  #headers = {};
  #listeners = { close: [], finish: [] };

  constructor(ch) {
    this.#ch = ch;
    ch.on("close", () => { for (const cb of this.#listeners.close) cb(); });
  }

  setHeader(name, value) { this.#headers[String(name).toLowerCase()] = value; }
  getHeader(name) { return this.#headers[String(name).toLowerCase()]; }
  removeHeader(name) { delete this.#headers[String(name).toLowerCase()]; }
  on(ev, cb) { (this.#listeners[ev] ||= []).push(cb); return this; }
  once(ev, cb) { return this.on(ev, cb); }
  flushHeaders() { this.#sendHead(); }

  writeHead(status, headers = {}) {
    this.statusCode = status;
    for (const [k, v] of Object.entries(headers)) this.setHeader(k, v);
    this.#sendHead();
    return this;
  }

  #sendHead() {
    if (this.#headSent) return;
    this.#headSent = true;
    this.headersSent = true;
    // CORS headers mean nothing inside the tunnel; drop them.
    const headers = Object.fromEntries(Object.entries(this.#headers).filter(([k]) => !k.startsWith("access-control-") && k !== "vary"));
    const head = encodeJsonMessage({ status: this.statusCode, headers });
    this.#chain = this.#chain.then(() => this.#ch.write(head)).catch(() => {});
  }

  write(chunk) {
    this.#sendHead();
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    if (bytes?.length) this.#chain = this.#chain.then(() => this.#ch.write(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength))).catch(() => {});
    return true;
  }

  end(chunk) {
    if (this.writableEnded) return this;
    if (chunk) this.write(chunk);
    this.#sendHead();
    this.writableEnded = true;
    this.#chain = this.#chain.then(() => this.#ch.end()).catch(() => {});
    for (const cb of this.#listeners.finish) cb();
    return this;
  }
}

/** A chat channel that looks like a `ws` WebSocket to handleSocket(). */
export class ChannelSocket {
  #ch; #listeners = { message: [], close: [], pong: [] };
  #closed = false;
  isAlive = true;
  lastTrafficAt = Date.now();

  constructor(ch, auth) {
    this.#ch = ch;
    this.auth = auth;
    const reader = new MessageReader({
      maxBytes: LIMITS.chatMessageBytes,
      onMessage: (m) => {
        this.lastTrafficAt = Date.now();
        const buf = Buffer.from(m);
        for (const cb of this.#listeners.message) cb(buf, false);
      },
    });
    ch.on("data", (p) => {
      try { reader.push(p); } catch { this.terminate(); }
    });
    ch.on("close", () => this.#fireClose());
  }

  on(ev, cb) { (this.#listeners[ev] ||= []).push(cb); return this; }
  send(data) {
    if (this.#closed) return;
    const bytes = typeof data === "string" ? Buffer.from(data) : data;
    this.#ch.write(encodeMessage(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength))).catch(() => this.terminate());
  }
  ping() { this.lastTrafficAt = Date.now(); for (const cb of this.#listeners.pong) cb(); }
  close() { this.#ch.close(CLOSE.NORMAL, "").catch?.(() => {}); this.#fireClose(); }
  terminate() { this.#ch.close(CLOSE.ERROR, "terminated").catch?.(() => {}); this.#fireClose(); }
  #fireClose() {
    if (this.#closed) return;
    this.#closed = true;
    for (const cb of this.#listeners.close) cb();
  }
}
