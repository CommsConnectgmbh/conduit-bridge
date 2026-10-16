// Speaking on a Sonos speaker in the local network.
//
// Alexa gives a skill eight seconds per answer and no way to speak later on
// its own. For longer tasks the bridge therefore answers Alexa right away
// ("I'm on it") and reads the result aloud on a Sonos speaker once Claude is
// done (alexa.mjs). This module is that last step: find the speaker, put the
// WAV on a short-lived local URL and ask the speaker to play it as an audio
// clip. An audio clip is Sonos' notification mechanism: music that is
// playing gets quieter for the clip and continues afterwards, nothing in the
// queue or the group changes.
//
// Everything stays in the local network. The speaker fetches the clip from
// this computer over the LAN, under a random one-time path, from a listener
// that exists only while a clip is pending. Nothing goes through the tunnel.
import { createSocket } from "node:dgram";
import { randomBytes } from "node:crypto";
import http from "node:http";
import https from "node:https";
import { isIPv4 } from "node:net";
import WebSocket from "ws";

// The local control API on port 1443 answers only with an API key header.
// Sonos' local API accepts this well-known key; it identifies nothing and
// grants nothing beyond what any device in the same network already has.
export const SONOS_LOCAL_API_KEY = "123e4567-e89b-12d3-a456-426655440000";
const SSDP_ADDR = "239.255.255.250";
const SSDP_PORT = 1900;
const ZONE_PLAYER = "urn:schemas-upnp-org:device:ZonePlayer:1";

/** RFC 1918 and link-local IPv4: the only hosts we talk to or serve to. */
export function isPrivateIPv4(ip) {
  if (!isIPv4(ip)) return false;
  const [a, b] = ip.split(".").map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

/**
 * Find Sonos players by SSDP. Resolves with the distinct private IPv4
 * addresses that answered within `timeoutMs`; never rejects.
 */
export function discoverSonos({ timeoutMs = 2500, socketFactory = () => createSocket({ type: "udp4", reuseAddr: true }) } = {}) {
  return new Promise((resolve) => {
    const found = new Set();
    let sock;
    const done = () => {
      try { sock?.close(); } catch {}
      resolve([...found]);
    };
    try {
      sock = socketFactory();
    } catch {
      return resolve([]);
    }
    sock.on("error", done);
    sock.on("message", (msg, rinfo) => {
      // Only Sonos answers carry a port-1400 device description.
      if (isPrivateIPv4(rinfo.address) && /:1400\/xml\/device_description\.xml/i.test(msg.toString("latin1"))) found.add(rinfo.address);
    });
    const query = Buffer.from(
      `M-SEARCH * HTTP/1.1\r\nHOST: ${SSDP_ADDR}:${SSDP_PORT}\r\nMAN: "ssdp:discover"\r\nMX: 1\r\nST: ${ZONE_PLAYER}\r\n\r\n`,
    );
    sock.bind(0, () => {
      try { sock.send(query, SSDP_PORT, SSDP_ADDR); } catch { /* no network: nothing found */ }
    });
    setTimeout(done, timeoutMs).unref?.();
  });
}

/** GET a JSON document from a speaker's local API. */
export function fetchLocalJson(ip, path, { timeoutMs = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!isPrivateIPv4(ip)) return reject(new Error("not a local address"));
    // The speakers present a self-signed certificate; there is no CA to check
    // it against. The address comes from the local network and the request
    // carries nothing secret.
    const req = https.get({ host: ip, port: 1443, path, rejectUnauthorized: false, timeout: timeoutMs, headers: { "X-Sonos-Api-Key": SONOS_LOCAL_API_KEY } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { body += c; if (body.length > 256 * 1024) req.destroy(new Error("answer too large")); });
      res.on("end", () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(body)); } catch { reject(new Error("not JSON")); }
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

/**
 * Pick the player for `target` from a household's player list.
 * `target` is a player id (RINCON_…) or a room name (case-insensitive). A
 * room can hold several players; the one with a voice assistant wins, since
 * that is the speaker the user talked to. Players without audio clips are
 * never chosen.
 * @returns {{ id: string, name: string, host: string, websocketUrl: string } | null}
 */
export function choosePlayer(players, target) {
  const want = String(target || "").trim();
  if (!want || !Array.isArray(players)) return null;
  const usable = players.filter((p) => {
    if (!p || typeof p.id !== "string" || !Array.isArray(p.capabilities) || !p.capabilities.includes("AUDIO_CLIP")) return false;
    try {
      const u = new URL(p.websocketUrl);
      return u.protocol === "wss:" && isPrivateIPv4(u.hostname);
    } catch { return false; }
  });
  const byId = usable.find((p) => p.id === want);
  const inRoom = byId ? [byId] : usable.filter((p) => typeof p.name === "string" && p.name.toLowerCase() === want.toLowerCase());
  if (!inRoom.length) return null;
  const p = inRoom.find((x) => x.capabilities.includes("VOICE")) || inRoom[0];
  return { id: p.id, name: p.name, host: new URL(p.websocketUrl).hostname, websocketUrl: p.websocketUrl };
}

/**
 * The local address this computer uses to reach `ip`: the address the
 * speaker can fetch the clip from. No packet is sent; connect() on UDP only
 * picks the route.
 */
export function localAddressFor(ip) {
  return new Promise((resolve, reject) => {
    const s = createSocket("udp4");
    s.on("error", (e) => { try { s.close(); } catch {} reject(e); });
    s.connect(1400, ip, () => {
      const { address } = s.address();
      s.close();
      if (!isPrivateIPv4(address)) return reject(new Error("no local route to the speaker"));
      resolve(address);
    });
  });
}

/**
 * Serves WAV clips on the local network under random one-time paths. The
 * listener opens with the first pending clip and closes when none is left.
 */
export function createClipHost({ ttlMs = 5 * 60_000, log = () => {} } = {}) {
  const clips = new Map(); // token -> { wav, timer }
  let server = null;
  let boundHost = null;
  let port = 0;

  function maybeClose() {
    if (clips.size || !server) return;
    const s = server;
    server = null;
    boundHost = null;
    s.close();
    s.closeAllConnections?.();
  }

  function drop(token) {
    const c = clips.get(token);
    if (!c) return;
    clearTimeout(c.timer);
    clips.delete(token);
    maybeClose();
  }

  async function listen(host) {
    if (server && boundHost === host) return;
    if (server) {
      // The route to the speaker changed (another network): pending clips on
      // the old address could not be fetched anyway.
      for (const t of [...clips.keys()]) drop(t);
    }
    server = http.createServer((req, res) => {
      const m = /^\/clip\/([0-9a-f]{32})\.wav$/.exec(req.url || "");
      const c = m && clips.get(m[1]);
      if (!c || (req.method !== "GET" && req.method !== "HEAD")) return res.writeHead(404).end();
      res.writeHead(200, { "content-type": "audio/wav", "content-length": c.wav.length, "cache-control": "no-store" });
      if (req.method === "HEAD") return res.end();
      // A speaker may fetch twice (probe, then play); the clip stays until
      // its time is up.
      res.end(c.wav);
      log("info", "speaker_clip_fetched", { bytes: c.wav.length });
    });
    boundHost = host;
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, host, () => { server.off("error", reject); port = server.address().port; resolve(); });
    });
  }

  return {
    /** Make `wav` fetchable from `host` (a local address); resolves with its URL. */
    async publish(wav, host) {
      if (!isPrivateIPv4(host)) throw new Error("clips are only served on a local address");
      await listen(host);
      const token = randomBytes(16).toString("hex");
      const timer = setTimeout(() => drop(token), ttlMs);
      timer.unref?.();
      clips.set(token, { wav, timer });
      return `http://${host}:${port}/clip/${token}.wav`;
    },
    get open() { return !!server; },
    close() { for (const t of [...clips.keys()]) drop(t); maybeClose(); },
  };
}

/**
 * Ask a player to play `streamUrl` as an audio clip. Resolves once the
 * speaker accepted it; rejects when it refuses or does not answer.
 */
export function playClip({ websocketUrl, playerId, streamUrl, volume, timeoutMs = 5000, connect }) {
  return new Promise((resolve, reject) => {
    const ws = connect
      ? connect(websocketUrl)
      : new WebSocket(websocketUrl, "v1.api.smartspeaker.audio", {
        headers: { "X-Sonos-Api-Key": SONOS_LOCAL_API_KEY },
        // Self-signed speaker certificate, see fetchLocalJson.
        rejectUnauthorized: false,
        handshakeTimeout: timeoutMs,
      });
    const cmdId = randomBytes(4).toString("hex");
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      err ? reject(err) : resolve();
    };
    const timer = setTimeout(() => finish(new Error("speaker did not answer")), timeoutMs);
    ws.on("open", () => {
      ws.send(JSON.stringify([
        { namespace: "audioClip:1", command: "loadAudioClip", playerId, cmdId },
        { name: "Conduit", appId: "de.tryconduit.bridge", streamUrl, volume, priority: "LOW", clipType: "CUSTOM" },
      ]));
    });
    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      const [header, body] = Array.isArray(msg) ? msg : [];
      if (header?.cmdId !== cmdId) return;
      if (header.success === true && header.response === "loadAudioClip") return finish();
      finish(new Error(`speaker refused the clip: ${String(body?.errorCode || body?.reason || "unknown").slice(0, 80)}`));
    });
    ws.on("error", (e) => finish(e));
    ws.on("close", () => finish(new Error("speaker closed the connection")));
  });
}
