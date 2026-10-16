// Sonos speaker plumbing (src/sonos.mjs): player choice, the local clip
// listener and the audio-clip command, against real local sockets and a
// stand-in speaker (a plain WebSocket server speaking the clip protocol).
//
//   node --test test/sonos.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { WebSocketServer } from "ws";
import WebSocket from "ws";
import { choosePlayer, createClipHost, isPrivateIPv4, localAddressFor, playClip } from "../src/sonos.mjs";

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
  const url = await clips.publish(wav, host);
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

test("clip host: refuses to serve on a non-local address", async () => {
  const clips = createClipHost();
  await assert.rejects(clips.publish(Buffer.from("x"), "127.0.0.1"), /local address/);
  await assert.rejects(clips.publish(Buffer.from("x"), "0.0.0.0"), /local address/);
  assert.equal(clips.open, false);
});

/** A stand-in speaker: answers loadAudioClip like a Sonos player. */
async function fakeSpeaker(answer) {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((r) => wss.once("listening", r));
  const seen = [];
  wss.on("connection", (ws, req) => {
    seen.push({ protocol: ws.protocol, key: req.headers["x-sonos-api-key"] });
    ws.on("message", (raw) => {
      const [header, body] = JSON.parse(raw.toString());
      seen.push({ header, body });
      const reply = answer(header, body);
      if (reply) ws.send(JSON.stringify(reply));
    });
  });
  const url = `ws://127.0.0.1:${wss.address().port}`;
  const connect = () => new WebSocket(url, "v1.api.smartspeaker.audio", { headers: { "X-Sonos-Api-Key": "test" } });
  return { seen, connect, close: () => new Promise((r) => wss.close(r)) };
}

test("playClip: sends loadAudioClip with player, URL and volume; resolves on success", async () => {
  const sp = await fakeSpeaker((h) => [{ namespace: "audioClip:1", response: "loadAudioClip", success: true, cmdId: h.cmdId }, { _objectType: "audioClip", status: "INACTIVE" }]);
  try {
    await playClip({ websocketUrl: "ignored", playerId: "RINCON_ONE", streamUrl: "http://192.168.178.30:5000/clip/a.wav", volume: 40, connect: sp.connect });
    const cmd = sp.seen.find((x) => x.header);
    assert.equal(cmd.header.namespace, "audioClip:1");
    assert.equal(cmd.header.command, "loadAudioClip");
    assert.equal(cmd.header.playerId, "RINCON_ONE");
    assert.equal(cmd.body.streamUrl, "http://192.168.178.30:5000/clip/a.wav");
    assert.equal(cmd.body.volume, 40);
    assert.equal(cmd.body.priority, "LOW");
  } finally { await sp.close(); }
});

test("playClip: a refusal, another command's answer or silence is not success", async () => {
  const refuse = await fakeSpeaker((h) => [{ response: "loadAudioClip", success: false, cmdId: h.cmdId }, { errorCode: "ERROR_DISALLOWED_BY_POLICY" }]);
  try {
    await assert.rejects(playClip({ playerId: "P", streamUrl: "u", volume: 10, connect: refuse.connect }), /refused the clip: ERROR_DISALLOWED_BY_POLICY/);
  } finally { await refuse.close(); }

  const other = await fakeSpeaker(() => [{ response: "loadAudioClip", success: true, cmdId: "not-ours" }, {}]);
  try {
    await assert.rejects(playClip({ playerId: "P", streamUrl: "u", volume: 10, connect: other.connect, timeoutMs: 300 }), /did not answer/);
  } finally { await other.close(); }

  const silent = await fakeSpeaker(() => null);
  try {
    await assert.rejects(playClip({ playerId: "P", streamUrl: "u", volume: 10, connect: silent.connect, timeoutMs: 300 }), /did not answer/);
  } finally { await silent.close(); }
});

test("playClip: an unreachable speaker rejects instead of hanging", async () => {
  const connect = () => new WebSocket("ws://127.0.0.1:1", "v1.api.smartspeaker.audio");
  await assert.rejects(playClip({ playerId: "P", streamUrl: "u", volume: 10, connect, timeoutMs: 2000 }));
});
