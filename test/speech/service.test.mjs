// Speech service without models (status, refusals, segmentation) and, when
// CONDUIT_TEST_SPEECH_MODELS and CONDUIT_TEST_SPEECH_RUNTIME point at
// installed models and runtime, a real round trip: synthesise, then
// recognise the result again.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const realModels = process.env.CONDUIT_TEST_SPEECH_MODELS;
const realRuntime = process.env.CONDUIT_TEST_SPEECH_RUNTIME;
const empty = mkdtempSync(join(tmpdir(), "conduit-speech-"));
process.env.CONDUIT_MODELS_DIR = realModels || join(empty, "models");
process.env.CONDUIT_SPEECH_RUNTIME_DIR = realRuntime || join(empty, "runtime");
const { createSpeechService, segmentPhonemes, SpeechError } = await import("../../src/speech-service.mjs");
const { MAX_PHONEMES } = await import("../../src/speech-kokoro.mjs");
const { encodeWav } = await import("../../src/speech-wav.mjs");

test.after(() => rmSync(empty, { recursive: true, force: true }));

test("segments end at sentences, fragments join the next one, none is too long", () => {
  assert.deepEqual(segmentPhonemes("ja. ɡˈuːtən tˈɑːk! vˈiː ɡˈeːt ɛs?"), ["ja. ɡˈuːtən tˈɑːk!", "vˈiː ɡˈeːt ɛs?"]);
  assert.deepEqual(segmentPhonemes("ˈIns\n\nʦvˈI"), ["ˈIns ʦvˈI"]);
  const long = Array.from({ length: 200 }, (_, i) => (i % 7 === 6 ? "vˈɔɾt," : "vˈɔɾt")).join(" ") + ".";
  const parts = segmentPhonemes(long);
  assert.ok(parts.length > 1);
  for (const p of parts) assert.ok([...p].length <= MAX_PHONEMES, `${[...p].length} phonemes`);
  assert.equal(parts.join(" ").replace(/\s+/g, " "), long);
  assert.ok(parts.slice(0, -1).every((p) => p.endsWith(",")), "cut at clause breaks");
});

test("without models: status lists the catalog, nothing is ready, requests are refused clearly", { skip: !!realModels }, async () => {
  const svc = createSpeechService();
  const st = svc.status();
  assert.deepEqual(st.ready, { stt: [], tts: [] });
  assert.deepEqual(st.voices, []);
  assert.deepEqual(st.models.map((m) => m.id), ["stt-parakeet-tdt-0.6b-v3", "tts-de-thorsten", "tts-en-kokoro-v1.0"]);
  for (const m of st.models) {
    assert.equal(m.installed, false);
    assert.ok(m.sizeBytes > 300e6 && m.license && m.attribution);
  }
  // The voices include espeak-ng in their size until it is installed.
  assert.equal(st.models[1].sizeBytes, 326092180 + 11039419);
  assert.throws(() => svc.install("espeak-ng-1.52.0"), (e) => e instanceof SpeechError && e.status === 404);
  assert.throws(() => svc.install("../etc"), (e) => e instanceof SpeechError && e.status === 404);
  await assert.rejects(svc.transcribe(Buffer.alloc(100)), (e) => e instanceof SpeechError && e.status === 409);
  assert.throws(() => svc.speak("Hallo", { onSegment() {} }), (e) => e instanceof SpeechError && e.status === 409);
  assert.throws(() => svc.speak("", { onSegment() {} }), (e) => e.status === 400);
  assert.throws(() => svc.speak("x".repeat(20_001), { onSegment() {} }), (e) => e.status === 413);
  svc.close();
});

test("round trip: what the voices say is recognised again", { skip: !realModels || !realRuntime, timeout: 300_000 }, async () => {
  const svc = createSpeechService();
  for (const [lang, voice, text, words] of [
    ["de", "thorsten", "Guten Tag! Ich habe die drei Dateien geprüft und alles ist in Ordnung.", ["guten", "tag", "drei", "dateien", "geprüft", "ordnung"]],
    ["en", "af_heart", "Good morning to you! I checked the three files. Everything is fine.", ["morning", "check", "three", "files", "everything", "fine"]],
  ]) {
    const segments = [];
    await svc.speak(text, { lang, voice, onSegment: (w) => segments.push(w) });
    assert.ok(segments.length >= 2, "first sentence comes on its own");
    let heard = "";
    for (const w of segments) heard += " " + (await svc.transcribe(w)).text.toLowerCase();
    for (const w of words) assert.ok(heard.includes(w), `${lang}: "${w}" not in "${heard}"`);
  }
  // A stopped request ends without further segments.
  const ac = new AbortController();
  let n = 0;
  await svc.speak("Erster Satz. Zweiter Satz. Dritter Satz. Vierter Satz.", { lang: "de", signal: ac.signal, onSegment: () => { n++; ac.abort(); } });
  assert.equal(n, 1);
  // Recordings longer than the limit are refused.
  await assert.rejects(svc.transcribe(encodeWav(new Float32Array(16000 * 126), 16000)), (e) => e.status === 400);
  svc.close();
});
