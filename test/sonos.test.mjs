// Sonos speaker plumbing (src/sonos.mjs): player choice, the local clip
// listener and the audio-clip command, against real local sockets and a
// stand-in speaker (a plain WebSocket server speaking the clip protocol).
//
//   node --test test/sonos.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import WebSocket from "ws";
import { checkSonosCert, choosePlayer, createClipHost, fetchLocalJson, isPrivateIPv4, localAddressFor, playClip } from "../src/sonos.mjs";

const player = (id, name, caps, host = "192.168.178.23") => ({
  id, name, capabilities: caps, websocketUrl: `wss://${host}:1443/websocket/api`,
});

test("isPrivateIPv4: RFC 1918 and link-local only", () => {
  for (const ip of ["10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.178.30", "169.254.1.1"]) assert.equal(isPrivateIPv4(ip), true, ip);
  for (const ip of ["8.8.8.8", "172.32.0.1", "172.15.0.1", "127.0.0.1", "0.0.0.0", "::1", "192.168.1", "fe80::1", "example.org"]) assert.equal(isPrivateIPv4(ip), false, ip);
});

test("choosePlayer: room name prefers the speaker with a voice assistant", () => {
  const players = [
    player("RINCON_PLAY1", "Wohnzimmer", ["PLAYBACK", "AUDIO_CLIP"], "192.168.178.25"),
    player("RINCON_ONE", "Wohnzimmer", ["PLAYBACK", "AUDIO_CLIP", "VOICE"], "192.168.178.23"),
    player("RINCON_BUERO", "Büro", ["PLAYBACK", "AUDIO_CLIP"], "192.168.178.132"),
  ];
  assert.deepEqual(choosePlayer(players, "wohnzimmer"), {
    id: "RINCON_ONE", name: "Wohnzimmer", host: "192.168.178.23", websocketUrl: "wss://192.168.178.23:1443/websocket/api",
  });
  assert.equal(choosePlayer(players, "Büro").id, "RINCON_BUERO");
  assert.equal(choosePlayer(players, "RINCON_PLAY1").id, "RINCON_PLAY1");
  assert.equal(choosePlayer(players, "Küche"), null);
  assert.equal(choosePlayer(players, ""), null);
  assert.equal(choosePlayer(null, "Büro"), null);
});

test("choosePlayer: never a player without audio clips or outside the local network", () => {
  assert.equal(choosePlayer([player("RINCON_A", "Bad", ["PLAYBACK"])], "Bad"), null);
  assert.equal(choosePlayer([player("RINCON_B", "Bad", ["AUDIO_CLIP"], "203.0.113.5")], "Bad"), null);
  assert.equal(choosePlayer([{ ...player("RINCON_C", "Bad", ["AUDIO_CLIP"]), websocketUrl: "ws://192.168.178.9:1443/x" }], "Bad"), null);
  assert.equal(choosePlayer([{ ...player("RINCON_D", "Bad", ["AUDIO_CLIP"]), websocketUrl: "nonsense" }], "Bad"), null);
});

/** A local address of this machine, as the speaker would fetch from. */
async function lanAddress(t) {
  try { return await localAddressFor("192.168.178.1"); } catch { t.skip("no private IPv4 route on this machine"); return null; }
}

function get(url, method = "GET") {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, type: res.headers["content-type"], body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("clip host: serves a clip under its random path only, on the local address, then closes", async (t) => {
  const host = await lanAddress(t);
  if (!host) return;
  const clips = createClipHost({ ttlMs: 300 });
  const wav = Buffer.from("RIFF-test-clip");
  const url = await clips.publish(wav, host, host);
  assert.match(url, new RegExp(`^http://${host.replace(/\./g, "\\.")}:\\d+/clip/[0-9a-f]{32}\\.wav$`));
  assert.equal(clips.open, true);

  const ok = await get(url);
  assert.equal(ok.status, 200);
  assert.equal(ok.type, "audio/wav");
  assert.deepEqual(ok.body, wav);
  // A second fetch (speakers probe first) still works; HEAD has no body.
  assert.equal((await get(url)).status, 200);
  const head = await get(url, "HEAD");
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);

  const base = url.slice(0, url.indexOf("/clip/"));
  assert.equal((await get(`${base}/clip/${"0".repeat(32)}.wav`)).status, 404);
  assert.equal((await get(`${base}/`)).status, 404);
  assert.equal((await get(url, "POST")).status, 404);

  // Gone after its time, and the listener with it.
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(clips.open, false);
  await assert.rejects(get(url));
});

test("clip host: refuses to serve on a non-local address or to a non-local speaker", async () => {
  const clips = createClipHost();
  await assert.rejects(clips.publish(Buffer.from("x"), "127.0.0.1", "192.168.178.23"), /local address/);
  await assert.rejects(clips.publish(Buffer.from("x"), "0.0.0.0", "192.168.178.23"), /local address/);
  await assert.rejects(clips.publish(Buffer.from("x"), "192.168.178.30", "8.8.8.8"), /local network/);
  assert.equal(clips.open, false);
});

test("clip host: a clip is served to its speaker only, not to anyone else who has the URL", async (t) => {
  const host = await lanAddress(t);
  if (!host) return;
  const clips = createClipHost();
  try {
    const url = await clips.publish(Buffer.from("RIFF-for-the-speaker"), host, "192.168.178.23");
    // This test fetches from the computer itself, which is not that speaker.
    assert.equal((await get(url)).status, 404);
    const mine = await clips.publish(Buffer.from("RIFF-mine"), host, host);
    assert.equal((await get(mine)).status, 200);
  } finally { clips.close(); }
});

test("clip host: a failed listen leaves nothing behind, the next publish works", async (t) => {
  const host = await lanAddress(t);
  if (!host) return;
  const clips = createClipHost();
  try {
    // An address this machine does not have: listen fails with EADDRNOTAVAIL.
    const absent = host.startsWith("10.") ? "192.168.254.254" : "10.254.254.254";
    await assert.rejects(clips.publish(Buffer.from("x"), absent, host));
    assert.equal(clips.open, false);
    const url = await clips.publish(Buffer.from("RIFF-ok"), host, host);
    assert.equal((await get(url)).status, 200);
    // Two publishes at once share one listener.
    const [a, b] = await Promise.all([clips.publish(Buffer.from("a"), host, host), clips.publish(Buffer.from("b"), host, host)]);
    assert.equal(new URL(a).port, new URL(b).port);
  } finally { clips.close(); }
});

/** A stand-in speaker speaking the audio clip protocol; `script` decides the answers. */
async function fakeSpeaker(script) {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((r) => wss.once("listening", r));
  const seen = [];
  wss.on("connection", (ws) => {
    ws.on("message", (raw) => {
      const [header, body] = JSON.parse(raw.toString());
      seen.push({ header, body });
      script(header, body, (msg, delay = 0) => setTimeout(() => ws.readyState === 1 && ws.send(JSON.stringify(msg)), delay), ws);
    });
  });
  const url = `ws://127.0.0.1:${wss.address().port}`;
  const connect = () => new WebSocket(url, "v1.api.smartspeaker.audio");
  return { seen, connect, close: () => new Promise((r) => { for (const c of wss.clients) c.terminate(); wss.close(r); }) };
}

const accepted = (h) => [{ namespace: "audioClip:1", response: "loadAudioClip", success: true, cmdId: h.cmdId }, { _objectType: "audioClip", id: "clip-1", status: "INACTIVE" }];
const status = (id, st) => [{ namespace: "audioClip:1", name: "audioClipStatus", type: "audioClipStatus" }, { _objectType: "audioClipStatus", audioClips: [{ id, status: st }] }];

test("playClip: subscribes, sends the clip without an output-only clip type, waits until it was played", async () => {
  const sp = await fakeSpeaker((h, b, send) => {
    if (h.command === "subscribe") return send([{ response: "subscribe", success: true, cmdId: h.cmdId }, {}]);
    if (h.command !== "loadAudioClip") return;
    send(accepted(h));
    // Accepted at once, played later; another clip's status is not ours.
    send(status("clip-1", "ACTIVE"), 50);
    send(status("other", "DONE"), 100);
    send(status("clip-1", "DONE"), 400);
  });
  try {
    const t0 = Date.now();
    const st = await playClip({ playerId: "RINCON_ONE", streamUrl: "http://192.168.178.30:5000/clip/a.wav", volume: 40, connect: sp.connect });
    assert.equal(st, "DONE");
    assert.ok(Date.now() - t0 >= 380, "resolved only after the clip was played");
    const cmds = sp.seen.map((x) => x.header.command);
    assert.deepEqual(cmds, ["subscribe", "loadAudioClip"]);
    const load = sp.seen[1];
    assert.equal(load.header.playerId, "RINCON_ONE");
    assert.deepEqual(load.body, { name: "Conduit", appId: "de.tryconduit.bridge", streamUrl: "http://192.168.178.30:5000/clip/a.wav", volume: 40, priority: "LOW" });
  } finally { await sp.close(); }
});

test("playClip: refusal or no connection reject (nothing played, safe to retry)", async () => {
  const refuse = await fakeSpeaker((h, b, send) => {
    if (h.command === "loadAudioClip") send([{ response: "loadAudioClip", success: false, cmdId: h.cmdId }, { errorCode: "ERROR_DISALLOWED_BY_POLICY" }]);
  });
  try {
    await assert.rejects(playClip({ playerId: "P", streamUrl: "u", volume: 10, connect: refuse.connect }), /refused the clip: ERROR_DISALLOWED_BY_POLICY/);
  } finally { await refuse.close(); }

  // A server that never completes the WebSocket handshake: nothing is sent.
  const tcp = (await import("node:net")).createServer(() => {});
  await new Promise((r) => tcp.listen(0, "127.0.0.1", r));
  try {
    const connect = () => new WebSocket(`ws://127.0.0.1:${tcp.address().port}`, "v1.api.smartspeaker.audio");
    await assert.rejects(playClip({ playerId: "P", streamUrl: "u", volume: 10, connect, timeoutMs: 300 }), /did not answer/);
  } finally { tcp.close(); }
});

test("playClip: once sent, no answer, a lost acknowledgement or a foreign answer give UNKNOWN, never a retry", async () => {
  const silent = await fakeSpeaker(() => {});
  try {
    assert.equal(await playClip({ playerId: "P", streamUrl: "u", volume: 10, connect: silent.connect, timeoutMs: 100, playTimeoutMs: 100 }), "UNKNOWN");
  } finally { await silent.close(); }

  // The speaker schedules the clip, then the line drops before its answer.
  const lost = await fakeSpeaker((h, b, send, ws) => { if (h.command === "loadAudioClip") ws.terminate(); });
  try {
    assert.equal(await playClip({ playerId: "P", streamUrl: "u", volume: 10, connect: lost.connect }), "UNKNOWN");
  } finally { await lost.close(); }

  const other = await fakeSpeaker((h, b, send) => { if (h.command === "loadAudioClip") send([{ response: "loadAudioClip", success: true, cmdId: "not-ours" }, { id: "x" }]); });
  try {
    assert.equal(await playClip({ playerId: "P", streamUrl: "u", volume: 10, connect: other.connect, timeoutMs: 100, playTimeoutMs: 100 }), "UNKNOWN");
  } finally { await other.close(); }

  const noId = await fakeSpeaker((h, b, send) => { if (h.command === "loadAudioClip") send([{ response: "loadAudioClip", success: true, cmdId: h.cmdId }, {}]); });
  try {
    assert.equal(await playClip({ playerId: "P", streamUrl: "u", volume: 10, connect: noId.connect }), "UNKNOWN");
  } finally { await noId.close(); }
});

test("playClip: INTERRUPTED ends the wait at once; malformed status frames are ignored, not thrown", async () => {
  const cut = await fakeSpeaker((h, b, send) => {
    if (h.command !== "loadAudioClip") return;
    send(accepted(h));
    send([{ type: "audioClipStatus" }, { audioClips: {} }], 20);
    send([{ type: "audioClipStatus" }, { audioClips: [null, 5, "x", { id: 7 }] }], 40);
    send([{ type: "audioClipStatus" }, null], 60);
    send(status("clip-1", "INTERRUPTED"), 100);
  });
  try {
    const t0 = Date.now();
    assert.equal(await playClip({ playerId: "P", streamUrl: "u", volume: 10, connect: cut.connect, playTimeoutMs: 5000 }), "INTERRUPTED");
    assert.ok(Date.now() - t0 < 1000);
  } finally { await cut.close(); }
});

test("playClip: after acceptance it never rejects; no status in time or a dropped line give UNKNOWN", async () => {
  const quiet = await fakeSpeaker((h, b, send) => { if (h.command === "loadAudioClip") send(accepted(h)); });
  try {
    assert.equal(await playClip({ playerId: "P", streamUrl: "u", volume: 10, connect: quiet.connect, playTimeoutMs: 200 }), "UNKNOWN");
  } finally { await quiet.close(); }

  const drop = await fakeSpeaker((h, b, send, ws) => { if (h.command === "loadAudioClip") { send(accepted(h)); setTimeout(() => ws.terminate(), 100); } });
  try {
    assert.equal(await playClip({ playerId: "P", streamUrl: "u", volume: 10, connect: drop.connect }), "UNKNOWN");
  } finally { await drop.close(); }

  const err = await fakeSpeaker((h, b, send) => { if (h.command === "loadAudioClip") { send(accepted(h)); send(status("clip-1", "ERROR"), 50); } });
  try {
    assert.equal(await playClip({ playerId: "P", streamUrl: "u", volume: 10, connect: err.connect }), "ERROR");
  } finally { await err.close(); }
});

test("playClip: an unreachable speaker rejects instead of hanging", async () => {
  const connect = () => new WebSocket("ws://127.0.0.1:1", "v1.api.smartspeaker.audio");
  await assert.rejects(playClip({ playerId: "P", streamUrl: "u", volume: 10, connect, timeoutMs: 2000 }));
});

test("checkSonosCert: only the player's own Sonos certificate passes", () => {
  const now = Date.parse("2026-10-16T12:00:00Z");
  const good = {
    subject: { CN: "7828CA00CD98", OU: "Sonos Devices", O: "Sonos, Inc" },
    issuer: { CN: "Sonos Device Authentication Root CA", O: "Sonos, Inc", OU: "Sonos Devices" },
    valid_from: "Feb 14 12:10:11 2026 GMT", valid_to: "Mar 14 12:09:11 2027 GMT",
  };
  assert.equal(checkSonosCert(good, "RINCON_7828CA00CD9801400", now), null);
  assert.match(checkSonosCert(good, "RINCON_74CA60A9D77401400", now), /another device/);
  assert.match(checkSonosCert({ ...good, issuer: { CN: "Evil CA", O: "Sonos, Inc" } }, "RINCON_7828CA00CD9801400", now), /not issued by Sonos/);
  assert.match(checkSonosCert({ ...good, subject: { ...good.subject, OU: "Other" } }, "RINCON_7828CA00CD9801400", now), /another device/);
  assert.match(checkSonosCert(good, "RINCON_7828CA00CD9801400", Date.parse("2027-04-01T00:00:00Z")), /expired/);
  assert.match(checkSonosCert({}, "RINCON_7828CA00CD9801400", now), /no certificate/);
  assert.match(checkSonosCert(undefined, "RINCON_7828CA00CD9801400", now), /no certificate/);
  assert.match(checkSonosCert(good, "../../etc", now), /not a Sonos player id/);
});

/** A local HTTPS server with a throwaway certificate; skipped without openssl. */
async function httpsServer(t, handler) {
  const host = await lanAddress(t);
  if (!host) return null;
  const dir = mkdtempSync(join(tmpdir(), "sonos-tls-"));
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=test", "-days", "1",
      "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem")], { stdio: "ignore" });
  } catch { rmSync(dir, { recursive: true, force: true }); t.skip("openssl not available"); return null; }
  const srv = https.createServer({ key: readFileSync(join(dir, "k.pem")), cert: readFileSync(join(dir, "c.pem")) }, handler);
  rmSync(dir, { recursive: true, force: true });
  await new Promise((r) => srv.listen(0, host, r));
  return { host, port: srv.address().port, close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }) };
}

test("fetchLocalJson: a cut-off or stalled answer rejects within the deadline", async (t) => {
  const srv = await httpsServer(t, (req, res) => {
    if (req.url === "/ok") return res.writeHead(200, { "content-type": "application/json" }).end('{"players":[]}');
    if (req.url === "/cut") { res.writeHead(200, { "content-length": "100" }); res.write('{"players":'); return setTimeout(() => res.socket.destroy(), 50); }
    // /stall: headers, then nothing
    res.writeHead(200); res.write("{");
  });
  if (!srv) return;
  try {
    assert.deepEqual(await fetchLocalJson(srv.host, "/ok", { port: srv.port }), { players: [] });
    await assert.rejects(fetchLocalJson(srv.host, "/cut", { port: srv.port }), /cut off|socket hang up|aborted|ECONNRESET/);
    const t0 = Date.now();
    await assert.rejects(fetchLocalJson(srv.host, "/stall", { port: srv.port, timeoutMs: 300 }), /timeout/);
    assert.ok(Date.now() - t0 < 1500);
  } finally { await srv.close(); }
});
