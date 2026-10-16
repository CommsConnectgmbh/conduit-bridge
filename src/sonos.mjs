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
import { X509Certificate, createPublicKey, randomBytes } from "node:crypto";
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

/** GET a JSON document from a speaker's local API. Settles within `timeoutMs`. */
export function fetchLocalJson(ip, path, { timeoutMs = 3000, port = 1443 } = {}) {
  return new Promise((resolve, reject) => {
    if (!isPrivateIPv4(ip)) return reject(new Error("not a local address"));
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) { req.destroy(); reject(err); } else resolve(value);
    };
    // Only the list of players is read here, and it carries nothing secret.
    // Who gets a clip is decided on the speaker's own connection (playClip).
    const req = https.get({ host: ip, port, path, rejectUnauthorized: false, headers: { "X-Sonos-Api-Key": SONOS_LOCAL_API_KEY } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { body += c; if (body.length > 256 * 1024) finish(new Error("answer too large")); });
      res.on("error", (e) => finish(e));
      res.on("aborted", () => finish(new Error("answer cut off")));
      res.on("close", () => finish(new Error("answer cut off")));
      res.on("end", () => {
        if (res.statusCode !== 200) return finish(new Error(`HTTP ${res.statusCode}`));
        try { finish(null, JSON.parse(body)); } catch { finish(new Error("not JSON")); }
      });
    });
    // One deadline for connect, headers and body together.
    const timer = setTimeout(() => finish(new Error("timeout")), timeoutMs);
    req.on("error", (e) => finish(e));
  });
}

const SONOS_ROOT_CN = "Sonos Device Authentication Root CA";

// Public key of the "Sonos Device Authentication Root CA" (RSA 4096), the
// authority that signs every Sonos player's own certificate. Sonos does not
// publish the CA certificate, and the players send only their own one, so the
// key was recovered from the signatures of five genuine players' certificates
// (tools/sonos-device-ca/): it verifies all of them, which no key but the
// CA's can. Pinned like the update key: a speaker counts only if its
// certificate is signed by this key and names the player.
export const SONOS_DEVICE_CA_PUBKEY = `-----BEGIN PUBLIC KEY-----
MIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEAmD9KTh18STYwKRFtbJda
V2ZrctBwCJwwDu+btcMmswZoLUXkFSvjkq1t55taG4WSGmcu7bM+6BIFSO/aT8BU
nhGvcLKGhuVM34mrErua7H/rOchi+55zeufJzRCFQ2QCXYehQF8yLdk7LwamKex3
TuumQRAW/VCufOPFpW0Jyxcmm+GYobgh5JcVc3jrGpSw4kFnV4ZjPRh2q/4Mva7n
yr5ksJVz4oYVOSoMKCva1vaSG/GwG0097okX0IfEph9ONQk9vGF0gyi7z542vMW4
oCFRtK/BaMPS+xe2s+JVtTmiLrMzW3o1I3fvcsOHwR3oPXBMHK5KpJJSK7aY8gyK
cDfHQX+xX5FAUIR5W0Ml9+z7ApfKW6SrDKxL4w20yVvPd7JZiI539Fy2KgK/iTrC
mQ7PVUERA5iSQFFiis/R9SfxHfqyHezhpgA9Q3lg5x7ILM1Pt/Hkuk3LHHYrqK/k
feFm/pkhoFS+q1lrC01uJW5nGHCmAreSjMnK/G1cOJA8RyiZmVanLoOxn8jKXMvG
pRPTYLMGjEjTKSjy/1wAZr3C5ndztca9eZuVEq5Hb2tVPzvdDy7u9x9VMP6ho8ei
gSo8oEQz5YKy0Rgb/sh3d/ubtM7Qg+QIPUfcU8auT3qf1MAOF0wGW7LjnXR9pYPt
4jGLA7mxKkpinVgwyvltMxsCAwEAAQ==
-----END PUBLIC KEY-----`;
let caKey = null;
const sonosCaKey = () => (caKey ??= createPublicKey(SONOS_DEVICE_CA_PUBKEY));

/** "CN=…\nOU=…" (X509Certificate.subject / .issuer) to { CN, OU, … }. */
function dn(text) {
  const out = {};
  for (const line of String(text || "").split("\n")) {
    const i = line.indexOf("=");
    if (i > 0 && !(line.slice(0, i) in out)) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

/**
 * Is `der` (the certificate a speaker presented) Sonos' certificate for
 * player `playerId`? Signed by the Sonos device CA, issued to the player's
 * MAC address (RINCON_<MAC>01400), and valid now. Returns null or the reason.
 * `ca` exists for the tests only.
 */
export function checkSonosCert(der, playerId, { now = Date.now(), ca } = {}) {
  const m = /^RINCON_([0-9A-F]{12})\d{5}$/.exec(String(playerId || ""));
  if (!m) return "not a Sonos player id";
  if (!Buffer.isBuffer(der) || !der.length) return "no certificate";
  let x;
  try { x = new X509Certificate(der); } catch { return "no certificate"; }
  let signed = false;
  try { signed = x.verify(ca || sonosCaKey()); } catch { signed = false; }
  if (!signed) return "certificate not issued by Sonos";
  const issuer = dn(x.issuer), subject = dn(x.subject);
  if (issuer.CN !== SONOS_ROOT_CN) return "certificate not issued by Sonos";
  if (subject.OU !== "Sonos Devices" || String(subject.CN).toUpperCase() !== m[1]) return "certificate belongs to another device";
  // validFrom/validTo strings: validFromDate exists only from Node 22.10 on.
  const from = Date.parse(x.validFrom), to = Date.parse(x.validTo);
  if (!(from <= now && now <= to)) return "certificate expired or not yet valid";
  return null;
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
 * Serves WAV clips on the local network under random one-time paths, each to
 * the one speaker it is meant for. The listener opens with the first pending
 * clip and closes when none is left.
 */
export function createClipHost({ ttlMs = 5 * 60_000, log = () => {} } = {}) {
  const clips = new Map(); // token -> { wav, allow, timer }
  let server = null;     // set only once it listens
  let boundHost = null;
  let port = 0;
  let starting = null;   // { host, promise } while a listen is under way

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

  function handle(req, res) {
    const m = /^\/clip\/([0-9a-f]{32})\.wav$/.exec(req.url || "");
    const c = m && clips.get(m[1]);
    // Only the speaker the clip was sent to gets it, whoever else learns the URL.
    if (!c || c.allow !== req.socket.remoteAddress || (req.method !== "GET" && req.method !== "HEAD")) {
      return res.writeHead(404).end();
    }
    res.writeHead(200, { "content-type": "audio/wav", "content-length": c.wav.length, "cache-control": "no-store" });
    if (req.method === "HEAD") return res.end();
    // A speaker may fetch twice (probe, then play); the clip stays until
    // its time is up.
    res.end(c.wav);
    log("info", "speaker_clip_fetched", { bytes: c.wav.length });
  }

  async function listen(host) {
    if (server && boundHost === host) return;
    if (starting?.host === host) return starting.promise;
    if (server) {
      // The route to the speaker changed (another network): pending clips on
      // the old address could not be fetched anyway.
      for (const t of [...clips.keys()]) drop(t);
    }
    const candidate = http.createServer(handle);
    const promise = new Promise((resolve, reject) => {
      candidate.once("error", reject);
      candidate.listen(0, host, () => { candidate.off("error", reject); resolve(); });
    });
    starting = { host, promise };
    try {
      await promise;
      server = candidate;
      boundHost = host;
      port = candidate.address().port;
    } catch (e) {
      try { candidate.close(); } catch {}
      throw e;
    } finally {
      if (starting?.promise === promise) starting = null;
    }
  }

  return {
    /** Make `wav` fetchable from `host` (a local address) by `allow` only; resolves with its URL. */
    async publish(wav, host, allow) {
      if (!isPrivateIPv4(host)) throw new Error("clips are only served on a local address");
      if (!isPrivateIPv4(allow)) throw new Error("clips are only served to a speaker in the local network");
      await listen(host);
      const token = randomBytes(16).toString("hex");
      const timer = setTimeout(() => drop(token), ttlMs);
      timer.unref?.();
      clips.set(token, { wav, allow, timer });
      return `http://${host}:${port}/clip/${token}.wav`;
    },
    get open() { return !!server; },
    close() { for (const t of [...clips.keys()]) drop(t); maybeClose(); },
  };
}

// Final clip states; INTERRUPTED: another clip (an alarm, Alexa) cut in.
const CLIP_DONE = new Set(["DONE", "ERROR", "DISMISSED", "INTERRUPTED"]);

/**
 * Play `streamUrl` as an audio clip on a player and wait until it has been
 * played. Rejects only when the clip was certainly not played: the speaker
 * could not be reached, is not the player (checkSonosCert), or refused the
 * clip; trying again is then safe. Once the clip has been sent it resolves
 * with its final status ("DONE", "ERROR", "DISMISSED", "INTERRUPTED"), or
 * "UNKNOWN" when the line dropped or no status came within `playTimeoutMs`:
 * the speaker may be playing it, so it is not sent twice.
 */
export function playClip({ websocketUrl, playerId, streamUrl, volume, timeoutMs = 5000, playTimeoutMs = 60_000, connect }) {
  return new Promise((resolve, reject) => {
    const ws = connect
      ? connect(websocketUrl)
      : new WebSocket(websocketUrl, "v1.api.smartspeaker.audio", {
        headers: { "X-Sonos-Api-Key": SONOS_LOCAL_API_KEY },
        // There is no CA certificate to hand to TLS; the speaker's certificate
        // is checked against the pinned CA key on "upgrade", before anything
        // is sent (checkSonosCert).
        rejectUnauthorized: false,
        handshakeTimeout: timeoutMs,
      });
    const subId = randomBytes(4).toString("hex");
    const cmdId = randomBytes(4).toString("hex");
    let clipId = null;
    let sent = false;
    let verified = !!connect; // stand-in connections in tests are plain
    let settled = false;
    let timer = setTimeout(() => finish(new Error("speaker did not answer")), timeoutMs);
    function finish(err, status) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.terminate ? ws.terminate() : ws.close(); } catch {}
      if (err?.refused || !sent) return reject(err);
      // Sent: an error only ends the wait, the clip may be playing.
      resolve(err ? "UNKNOWN" : status);
    }
    ws.on("upgrade", (res) => {
      if (connect) return;
      let why;
      // An exception in this listener would escape the promise.
      try { why = checkSonosCert(res.socket?.getPeerCertificate?.()?.raw, playerId); } catch (e) { why = String(e?.message || e); }
      if (why) return finish(new Error(`speaker not trusted: ${why}`));
      verified = true;
    });
    ws.on("open", () => {
      if (!verified) return finish(new Error("speaker not trusted: no certificate"));
      // Status events tell when the clip has been played.
      ws.send(JSON.stringify([{ namespace: "audioClip:1", command: "subscribe", playerId, cmdId: subId }, {}]));
      ws.send(JSON.stringify([
        { namespace: "audioClip:1", command: "loadAudioClip", playerId, cmdId },
        { name: "Conduit", appId: "de.tryconduit.bridge", streamUrl, volume, priority: "LOW" },
      ]));
      sent = true;
      // From here on the wait covers acknowledgement and playback.
      clearTimeout(timer);
      timer = setTimeout(() => finish(null, "UNKNOWN"), timeoutMs + playTimeoutMs);
    });
    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      const [header, body] = Array.isArray(msg) ? msg : [];
      if (!header) return;
      if (header.cmdId === cmdId) {
        if (header.success !== true || header.response !== "loadAudioClip") {
          const e = new Error(`speaker refused the clip: ${String(body?.errorCode || body?.reason || "unknown").slice(0, 80)}`);
          e.refused = true;
          return finish(e);
        }
        // Accepted; without an id its status cannot be followed.
        if (typeof body?.id !== "string") return finish(null, "UNKNOWN");
        clipId = body.id;
        clearTimeout(timer);
        timer = setTimeout(() => finish(null, "UNKNOWN"), playTimeoutMs);
        return;
      }
      if (clipId && header.type === "audioClipStatus" && Array.isArray(body?.audioClips)) {
        const mine = body.audioClips.find((c) => c && typeof c === "object" && c.id === clipId);
        if (mine && CLIP_DONE.has(mine.status)) finish(null, mine.status);
      }
    });
    ws.on("error", (e) => finish(e));
    ws.on("close", () => finish(new Error("speaker closed the connection")));
  });
}
