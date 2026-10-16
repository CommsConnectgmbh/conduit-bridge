// Reads a text aloud on the configured Sonos speaker (see sonos.mjs): the
// bridge's own German voice turns it into one WAV, the speaker plays it as an
// audio clip. Used by the Alexa skill to deliver answers that took longer
// than Alexa waits (alexa.mjs).
import { parseWav, encodeWav } from "./speech-wav.mjs";
import {
  choosePlayer, createClipHost, discoverSonos, fetchLocalJson, localAddressFor, playClip,
} from "./sonos.mjs";

const PLAYER_CACHE_MS = 10 * 60_000;

/** Join the per-sentence WAVs of speech.speak() into one clip. */
export function joinWavs(wavs) {
  let rate = 0;
  const parts = [];
  for (const w of wavs) {
    const { samples, sampleRate } = parseWav(w, { maxSeconds: 3600 });
    if (rate && sampleRate !== rate) throw new Error("segments differ in sample rate");
    rate = sampleRate;
    parts.push(samples);
  }
  if (!parts.length) throw new Error("nothing was synthesised");
  const all = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) { all.set(p, off); off += p.length; }
  return encodeWav(all, rate);
}

/**
 * @param {object} o
 * @param {string} o.target   room name or player id (RINCON_…)
 * @param {number} o.volume   clip volume, 1-100
 * @param {{ status: Function, speak: Function }} o.speech the bridge's speech service
 * @param {string} [o.voice]
 * @param {Function} o.log
 * @param {object} [o.net]    stand-ins for the network calls (tests)
 */
export function createSpeaker({ target, volume, speech, voice, log, net = {} }) {
  const discover = net.discover || discoverSonos;
  const fetchJson = net.fetchJson || fetchLocalJson;
  const localAddress = net.localAddress || localAddressFor;
  const play = net.play || playClip;
  const clips = net.clipHost || createClipHost({ log });
  let cached = null; // { player, at }
  let queue = Promise.resolve();

  async function findPlayer(fresh) {
    if (!fresh && cached && Date.now() - cached.at < PLAYER_CACHE_MS) return cached.player;
    cached = null;
    // Any speaker of the household knows all players; ask them in turn until
    // one answers.
    for (const ip of await discover()) {
      try {
        const g = await fetchJson(ip, "/api/v1/households/local/groups");
        const player = choosePlayer(g?.players, target);
        if (player) {
          cached = { player, at: Date.now() };
          return player;
        }
      } catch { /* next speaker */ }
    }
    return null;
  }

  async function synthesize(text) {
    const wavs = [];
    await speech.speak(text, { lang: "de", voice, onSegment: (w) => { wavs.push(w); } });
    return joinWavs(wavs);
  }

  async function announceNow(text) {
    const started = Date.now();
    const wav = await synthesize(text);
    // Data bytes over the header's byte rate: how long the speaker will be busy.
    const seconds = (wav.length - 44) / (wav.readUInt32LE(28) || 48000);
    let player = await findPlayer(false);
    if (!player) throw new Error("speaker not found");
    const send = async (p) => {
      const url = await clips.publish(wav, await localAddress(p.host), p.host);
      return play({ websocketUrl: p.websocketUrl, playerId: p.id, streamUrl: url, volume, playTimeoutMs: Math.ceil(seconds * 1000) + 20_000 });
    };
    let status;
    try {
      status = await send(player);
    } catch (e) {
      // Nothing was played. A cached address can be stale (DHCP, speaker
      // restarted): look again once.
      const again = await findPlayer(true);
      if (!again) throw e;
      player = again;
      status = await send(player);
    }
    if (status !== "DONE") throw new Error(`clip ended as ${status}`);
    log("info", "speaker_announced", { room: player.name, chars: text.length, seconds: Math.round(seconds), ms: Date.now() - started });
  }

  return {
    /** A German voice is installed, so announce() can work. */
    ready() {
      try {
        const s = speech.status();
        return voice ? s.voices.some((v) => v.id === voice) : s.ready.tts.includes("de");
      } catch { return false; }
    },
    /**
     * Read `text` aloud; the next clip starts only after the previous one was
     * played. Resolves true or false, never rejects.
     */
    announce(text) {
      const job = queue.then(() => announceNow(text)).then(() => true, (e) => {
        log("warn", "speaker_failed", { err: String(e?.message || e).slice(0, 200) });
        return false;
      });
      queue = job;
      return job;
    },
    close() { clips.close(); },
  };
}
