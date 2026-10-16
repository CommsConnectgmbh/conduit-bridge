// The Alexa request handler (src/alexa.mjs) with and without a speaker:
// quick answers stay on Alexa, slow ones are handed to the speaker, and a
// question meanwhile is told the answer is on its way.
//
//   node --test test/alexa.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ANNOUNCE_PREFIX, BUSY_TEXT, HANDOFF_TEXT, REPLY_HINT, handleAlexaRequest, questionOf, spokenResult,
} from "../src/alexa.mjs";

const SKILL = "amzn1.ask.skill.test";
const USER = "amzn1.ask.account.owner";
const req = (intent, query) => ({
  session: { application: { applicationId: SKILL }, user: { userId: USER } },
  request: intent === "LaunchRequest" ? { type: "LaunchRequest" } : { type: "IntentRequest", intent: { name: intent, slots: query === undefined ? {} : { query: { value: query } } } },
});
const said = (out) => out.body.response.outputSpeech.text;
const ends = (out) => out.body.response.shouldEndSession;
const ok = (text) => ({ code: 200, body: { ok: true, text } });
const later = (ms, v) => new Promise((r) => setTimeout(() => r(v), ms));

function speakerRig({ ready = true } = {}) {
  const announced = [];
  let release;
  const done = new Promise((r) => { release = r; });
  return {
    announced, done,
    speaker: { ready: () => ready, async announce(t) { announced.push(t); release(); return true; } },
  };
}

test("without a speaker: Alexa waits for the answer as before", async () => {
  const asked = [];
  const out = await handleAlexaRequest(req("AskConduitIntent", "was ist zwei plus zwei"), {
    skillId: SKILL, userId: USER, log: () => {}, fetchImpl: async () => ({}),
    ask: async (q, o) => { asked.push({ q, o }); return ok("Vier."); },
  });
  assert.equal(said(out), "Vier.");
  assert.equal(ends(out), false);
  assert.deepEqual(asked, [{ q: "was ist zwei plus zwei", o: undefined }]);
});

test("speaker, quick answer: Alexa says it, the speaker stays quiet", async () => {
  const s = speakerRig();
  const out = await handleAlexaRequest(req("AskConduitIntent", "was ist sieben mal sechs"), {
    skillId: SKILL, userId: USER, log: () => {}, speaker: s.speaker, handoffMs: 300,
    ask: async (q, o) => { assert.deepEqual(o, { long: true }); return ok("Zweiundvierzig."); },
  });
  assert.equal(said(out), "Zweiundvierzig.");
  await later(400);
  assert.deepEqual(s.announced, []);
});

test("speaker, slow answer: Alexa hands off at once, the speaker reads the answer later", async () => {
  const s = speakerRig();
  const logs = [];
  const t0 = Date.now();
  const out = await handleAlexaRequest(req("AskConduitIntent", "fass meine Mails von heute zusammen"), {
    skillId: SKILL, userId: USER, log: (l, e) => logs.push(e), speaker: s.speaker, handoffMs: 200,
    ask: () => later(600, ok("Drei neue Mails, eine davon dringend.")),
  });
  assert.ok(Date.now() - t0 < 500, "Alexa got its answer within the handoff time");
  assert.equal(said(out), HANDOFF_TEXT);
  assert.equal(ends(out), true);
  assert.ok(logs.includes("alexa_handoff"));
  await s.done;
  assert.deepEqual(s.announced, [`${ANNOUNCE_PREFIX} Drei neue Mails, eine davon dringend.`]);
});

test("speaker: the handoff time counts from the request's arrival, signature check included", async () => {
  const s = speakerRig();
  const t0 = Date.now();
  // The request came in 4.9 s ago (slow certificate download): hand off at once.
  const out = await handleAlexaRequest(req("AskConduitIntent", "räum mein Postfach auf"), {
    skillId: SKILL, userId: USER, log: () => {}, speaker: s.speaker, handoffMs: 5000, receivedAt: Date.now() - 4900,
    ask: () => later(400, ok("Erledigt.")),
  });
  assert.equal(said(out), HANDOFF_TEXT);
  assert.ok(Date.now() - t0 < 300, `answered after ${Date.now() - t0} ms`);
  await s.done;
  assert.deepEqual(s.announced, [`${ANNOUNCE_PREFIX} Erledigt.`]);
});

test("speaker: a question while a handed-off one runs is told the answer is coming", async () => {
  const s = speakerRig();
  let busy = false;
  const ask = async () => {
    if (busy) return { code: 429, body: { ok: false, error: "alexa-busy" } };
    busy = true;
    await later(500);
    busy = false;
    return ok("Fertig.");
  };
  const deps = { skillId: SKILL, userId: USER, log: () => {}, speaker: s.speaker, handoffMs: 100, ask };
  assert.equal(said(await handleAlexaRequest(req("AskConduitIntent", "räum auf"), deps)), HANDOFF_TEXT);
  const second = await handleAlexaRequest(req("AskConduitIntent", "und noch was"), deps);
  assert.equal(said(second), BUSY_TEXT);
  assert.equal(ends(second), true);
  await s.done;
  assert.deepEqual(s.announced, [`${ANNOUNCE_PREFIX} Fertig.`]);
});

test("speaker: a busy answer without a handed-off question keeps the old wording", async () => {
  const s = speakerRig();
  const out = await handleAlexaRequest(req("AskConduitIntent", "hallo"), {
    skillId: SKILL, userId: USER, log: () => {}, speaker: s.speaker, handoffMs: 200,
    ask: async () => ({ code: 429, body: { ok: false } }),
  });
  assert.notEqual(said(out), BUSY_TEXT);
  assert.match(said(out), /beschäftigt/);
});

test("speaker without a voice: behaves as without a speaker", async () => {
  const s = speakerRig({ ready: false });
  const out = await handleAlexaRequest(req("AskConduitIntent", "hallo"), {
    skillId: SKILL, userId: USER, log: () => {}, speaker: s.speaker, handoffMs: 50, fetchImpl: async () => ({}),
    ask: (q, o) => { assert.equal(o, undefined); return later(150, ok("Hallo.")); },
  });
  assert.equal(said(out), "Hallo.");
  assert.deepEqual(s.announced, []);
});

test("ja / nein answer Claude's last question", async () => {
  const asked = [];
  const deps = { skillId: SKILL, userId: USER, log: () => {}, fetchImpl: async () => ({}), ask: async (q) => { asked.push(q); return ok("Gut."); } };
  await handleAlexaRequest(req("AMAZON.YesIntent"), deps);
  await handleAlexaRequest(req("AMAZON.NoIntent"), deps);
  await handleAlexaRequest(req("ConduitYesIntent", "schick sie ab"), deps);
  await handleAlexaRequest(req("ConduitNoIntent", "lass die zweite weg"), deps);
  assert.deepEqual(asked, ["Ja.", "Nein.", "Ja, schick sie ab", "Nein, lass die zweite weg"]);
  assert.equal(questionOf("ConduitYesIntent", ""), "Ja.");
  assert.equal(questionOf("AMAZON.NavigateHomeIntent", "x"), null);
});

test("empty question, wrong skill and foreign account are still refused before anything runs", async () => {
  const ask = async () => { throw new Error("must not run"); };
  const deps = { skillId: SKILL, userId: USER, log: () => {}, ask, speaker: speakerRig().speaker };
  assert.match(said(await handleAlexaRequest(req("AskConduitIntent", "  "), deps)), /nicht verstanden/);
  const wrong = req("AskConduitIntent", "x");
  wrong.session.application.applicationId = "amzn1.ask.skill.other";
  assert.equal((await handleAlexaRequest(wrong, deps)).status, 403);
  const foreign = req("AskConduitIntent", "x");
  foreign.session.user.userId = "amzn1.ask.account.someone";
  assert.match(said(await handleAlexaRequest(foreign, deps)), /anderen Konto/);
});

test("spokenResult: answer, question back with the reply hint, timeout, failure", () => {
  assert.equal(spokenResult(ok("Erledigt.")), `${ANNOUNCE_PREFIX} Erledigt.`);
  assert.equal(spokenResult(ok("Soll ich die Mail abschicken?")), `${ANNOUNCE_PREFIX} Soll ich die Mail abschicken? ${REPLY_HINT}`);
  assert.match(spokenResult(ok("")), /keine Antwort/);
  assert.match(spokenResult({ code: 504, body: { ok: false } }), /zu lange gedauert/);
  assert.match(spokenResult({ code: 502, body: { ok: false } }), /nicht geklappt/);
  assert.match(spokenResult(undefined), /nicht geklappt/);
});
