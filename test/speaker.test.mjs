// Reading text aloud on a speaker (src/speaker.mjs) with stand-ins for the
// speech service and the network: which speaker is asked, what it is sent,
// and what happens when a speaker moved or is gone.
//
//   node --test test/speaker.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeWav, parseWav } from "../src/speech-wav.mjs";
import { createSpeaker, findIds, joinWavs } from "../src/speaker.mjs";

const ONE = "RINCON_0000000000A101400";

const tone = (n, v) => encodeWav(new Float32Array(n).fill(v), 24000);

test("joinWavs: one clip with all segments in order", () => {
  const out = parseWav(joinWavs([tone(100, 0.25), tone(50, -0.5)]), { maxSeconds: 10 });
  assert.equal(out.sampleRate, 24000);
  assert.equal(out.samples.length, 150);
  assert.ok(Math.abs(out.samples[0] - 0.25) < 1e-3);
  assert.ok(Math.abs(out.samples[149] + 0.5) < 1e-3);
  assert.throws(() => joinWavs([]), /nothing/);
  assert.throws(() => joinWavs([tone(10, 0), encodeWav(new Float32Array(10), 16000)]), /sample rate/);
});

function rig({ players = [[{ id: ONE, name: "Wohnzimmer", capabilities: ["AUDIO_CLIP", "VOICE"], websocketUrl: "wss://192.168.178.23:1443/websocket/api" }]], voices = ["de"], playFails = 0, endStatus = "DONE", playMs = 0 } = {}) {
  const calls = { discover: 0, fetch: [], play: [], publish: [], spoken: [], timeline: [] };
  const logs = [];
  let round = 0;
  let fails = playFails;
  const speech = {
    status: () => ({ ready: { tts: voices }, voices: voices.map((l) => ({ id: `voice-${l}`, lang: l })) }),
    async speak(text, { lang, onSegment }) {
      calls.spoken.push({ text, lang });
      if (!voices.includes(lang)) throw new Error(`no voice installed for ${lang}`);
      await onSegment(tone(10, 0.1));
      await onSegment(tone(10, 0.2));
    },
  };
  const net = {
    async discover() { calls.discover++; return ["192.168.178.23", "192.168.178.25"]; },
    async fetchJson(ip, path) {
      calls.fetch.push({ ip, path });
      const list = players[Math.min(round, players.length - 1)];
      return { players: list };
    },
    async localAddress(ip) { return ip.startsWith("192.168.178.") ? "192.168.178.30" : Promise.reject(new Error("no route")); },
    async play(o) {
      calls.play.push(o);
      if (fails > 0) { fails--; round++; throw new Error("speaker closed the connection"); }
      calls.timeline.push(`start ${o.streamUrl}`);
      // The real playClip resolves only once the speaker reports the clip played.
      await new Promise((r) => setTimeout(r, playMs));
      calls.timeline.push(`end ${o.streamUrl}`);
      return endStatus;
    },
    clipHost: {
      async publish(wav, host, allow) { calls.publish.push({ bytes: wav.length, host, allow }); return `http://${host}:5000/clip/${calls.publish.length}.wav`; },
      close() {},
    },
  };
  const speaker = createSpeaker({ target: ONE, volume: 40, speech, log: (l, e, d) => logs.push({ l, e, d }), net });
  return { speaker, calls, logs };
}

test("announce: German voice, one joined clip, played on the room's voice speaker at the set volume", async () => {
  const { speaker, calls, logs } = rig();
  assert.equal(speaker.ready(), true);
  assert.equal(await speaker.announce("Hier ist Conduit. Fertig."), true);
  assert.deepEqual(calls.spoken, [{ text: "Hier ist Conduit. Fertig.", lang: "de" }]);
  assert.equal(calls.publish.length, 1);
  assert.equal(calls.publish[0].host, "192.168.178.30");
  assert.equal(calls.publish[0].allow, "192.168.178.23", "only the chosen speaker may fetch the clip");
  assert.equal(calls.publish[0].bytes, 44 + 20 * 2);
  // 20 samples at 24 kHz: the wait for the end of playback is the clip plus a margin.
  assert.deepEqual(calls.play, [{ websocketUrl: "wss://192.168.178.23:1443/websocket/api", playerId: ONE, streamUrl: "http://192.168.178.30:5000/clip/1.wav", volume: 40, playTimeoutMs: 20_001 }]);
  assert.equal(calls.fetch[0].path, "/api/v1/households/local/groups");
  assert.equal(logs.at(-1).e, "speaker_announced");

  // The player is remembered: no second discovery for the next clip.
  await speaker.announce("Noch was.");
  assert.equal(calls.discover, 1);
});

test("announce: a speaker that moved is looked up again once", async () => {
  const moved = [{ id: ONE, name: "Wohnzimmer", capabilities: ["AUDIO_CLIP", "VOICE"], websocketUrl: "wss://192.168.178.99:1443/websocket/api" }];
  const { speaker, calls } = rig({ players: [[{ id: ONE, name: "Wohnzimmer", capabilities: ["AUDIO_CLIP"], websocketUrl: "wss://192.168.178.23:1443/websocket/api" }], moved], playFails: 1 });
  assert.equal(await speaker.announce("Test."), true);
  assert.equal(calls.discover, 2);
  assert.equal(calls.play.length, 2);
  assert.equal(calls.play[1].websocketUrl, "wss://192.168.178.99:1443/websocket/api");
});

test("announce: never rejects; no speaker, no voice or a dead speaker are logged as failures", async () => {
  const none = rig({ players: [[]] });
  assert.equal(await none.speaker.announce("Test."), false);
  assert.match(none.logs.at(-1).d.err, /speaker not found/);

  const mute = rig({ voices: [] });
  assert.equal(mute.speaker.ready(), false);
  assert.equal(await mute.speaker.announce("Test."), false);
  assert.match(mute.logs.at(-1).d.err, /no voice/);
  assert.equal(mute.calls.play.length, 0);

  // Sent but not played to the end (or unknown): reported, never sent a second time.
  const cut = rig({ endStatus: "DISMISSED" });
  assert.equal(await cut.speaker.announce("Test."), false);
  assert.equal(cut.calls.play.length, 1);
  assert.match(cut.logs.at(-1).d.err, /DISMISSED/);
  const unsure = rig({ endStatus: "UNKNOWN" });
  assert.equal(await unsure.speaker.announce("Test."), false);
  assert.equal(unsure.calls.play.length, 1);

  const dead = rig({ playFails: 5 });
  assert.equal(await dead.speaker.announce("Test."), false);
  assert.equal(dead.calls.play.length, 2);
  assert.equal(dead.logs.at(-1).e, "speaker_failed");
});

test("announce: the next clip starts only after the previous one was played", async () => {
  const { speaker, calls } = rig({ playMs: 150 });
  const [a, b] = await Promise.all([speaker.announce("Eins."), speaker.announce("Zwei.")]);
  assert.equal(a, true);
  assert.equal(b, true);
  assert.deepEqual(calls.timeline, [
    "start http://192.168.178.30:5000/clip/1.wav", "end http://192.168.178.30:5000/clip/1.wav",
    "start http://192.168.178.30:5000/clip/2.wav", "end http://192.168.178.30:5000/clip/2.wav",
  ]);
});

test("createSpeaker: a room name is refused, only a player id binds the speaker", () => {
  const speech = { status: () => ({ ready: { tts: ["de"] }, voices: [] }), async speak() {} };
  assert.throws(() => createSpeaker({ target: "Wohnzimmer", volume: 40, speech, log: () => {} }), /player id/);
  assert.throws(() => createSpeaker({ target: "", volume: 40, speech, log: () => {} }), /player id/);
  assert.equal(createSpeaker({ target: ONE, volume: 40, speech, log: () => {}, net: { clipHost: { close() {} } } }).target, ONE);
});

test("findIds: the ids in a room from the first speaker that answers; empty when none does", async () => {
  const players = [{ id: ONE, name: "Wohnzimmer", capabilities: ["AUDIO_CLIP", "VOICE"] }];
  const ids = await findIds("Wohnzimmer", {
    discover: async () => ["192.168.178.5", "192.168.178.23"],
    fetchJson: async (ip) => { if (ip === "192.168.178.5") throw new Error("down"); return { players }; },
  });
  assert.deepEqual(ids, [{ id: ONE, room: "Wohnzimmer", voice: true, audioClip: true }]);
  assert.deepEqual(await findIds("Wohnzimmer", { discover: async () => [], fetchJson: async () => ({}) }), []);
});
