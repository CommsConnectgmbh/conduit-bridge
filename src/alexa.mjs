// Alexa skill endpoint, served by the bridge itself.
//
// Amazon posts each utterance to https://<tunnel>/alexa. The bridge checks
// Amazon's signature (alexa-verify.mjs) and the skill id, answers the built-in
// intents directly, and runs AskConduitIntent through the fixed Claude session.
// With a speaker configured (speaker.mjs), a question Claude cannot answer
// within Alexa's time keeps running and is answered on the speaker.
// Moved here from the web app so that no server of ours holds a key to the
// bridge any more.

export const PROGRESSIVE_TEXT = "Moment, ich denk kurz nach.";

// Alexa allows eight seconds for the whole answer, signature check and
// network included. After this long the answer goes to the speaker instead.
export const HANDOFF_MS = 5000;
export const HANDOFF_TEXT = "Ich bin dran und melde mich gleich über den Lautsprecher.";
export const BUSY_TEXT = "Ich arbeite noch an deiner letzten Aufgabe und melde mich über den Lautsprecher, sobald ich fertig bin.";
// Said before an answer on the speaker, which otherwise comes out of nowhere.
export const ANNOUNCE_PREFIX = "Hier ist Conduit.";
export const REPLY_HINT = "Antworte mit: Alexa, sag Conduit, und dann deine Antwort.";

export function speak(text, endSession = false, reprompt) {
  return {
    version: "1.0",
    response: {
      outputSpeech: { type: "PlainText", text },
      shouldEndSession: endSession,
      ...(reprompt ? { reprompt: { outputSpeech: { type: "PlainText", text: reprompt } } } : {}),
    },
  };
}

/** Best-effort "one moment" while Claude works; Alexa keeps the turn open. */
async function sendProgressive(payload, fetchImpl) {
  const sys = payload?.context?.System;
  const requestId = payload?.request?.requestId;
  if (!sys?.apiEndpoint || !sys?.apiAccessToken || !requestId) return;
  // Only Amazon's own API hosts; the endpoint comes from a verified request,
  // but there is no reason to post a token anywhere else.
  let host;
  try { host = new URL(sys.apiEndpoint).hostname; } catch { return; }
  if (!/^api(\.[a-z]+)?\.amazonalexa\.com$/.test(host)) return;
  try {
    await fetchImpl(`${sys.apiEndpoint}/v1/directives`, {
      method: "POST",
      headers: { authorization: `Bearer ${sys.apiAccessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ header: { requestId }, directive: { type: "VoicePlayer.Speak", speech: PROGRESSIVE_TEXT } }),
      signal: AbortSignal.timeout(2000),
    });
  } catch { /* best effort */ }
}

/**
 * @param {object} payload verified Alexa request
 * @param {{ skillId: string, userId: string,
 *           ask: (query: string, opts?: { long?: boolean }) => Promise<{ code: number, body: any }>,
 *           speaker?: { ready: () => boolean, announce: (text: string) => Promise<boolean> },
 *           handoffMs?: number, receivedAt?: number, fetchImpl?: typeof fetch, log: Function }} deps
 *   With a speaker, a question that is not answered within `handoffMs` of
 *   `receivedAt` (when the request came in, so the signature check counts)
 *   keeps running and its answer is read aloud on the speaker later.
 * @returns {Promise<{ status: number, body: object }>}
 */
export async function handleAlexaRequest(payload, { skillId, userId, ask, speaker, handoffMs = HANDOFF_MS, receivedAt = Date.now(), fetchImpl = fetch, log }) {
  const incoming = payload?.session?.application?.applicationId || payload?.context?.System?.application?.applicationId;
  if (!skillId) return { status: 503, body: { error: "skill not configured" } };
  if (incoming !== skillId) return { status: 403, body: { error: "wrong skill" } };
  // The skill runs Claude on this computer: only the owner's Alexa account
  // may use it, even if the skill were ever enabled for anyone else.
  const user = payload?.session?.user?.userId || payload?.context?.System?.user?.userId;
  if (!userId) {
    // Not bound yet. Amazon shows the owner this id nowhere, so the first
    // verified request of the own skill writes it to the local log; nothing
    // is run. Binding it (ALEXA_USER_ID) is the owner's step.
    log("warn", "alexa_user_not_configured", { alexaUserId: typeof user === "string" ? user.slice(0, 300) : null });
    return { status: 200, body: speak("Der Skill ist noch nicht mit deiner Bridge verbunden. Deine Alexa-Kennung steht jetzt im Bridge-Protokoll.", true) };
  }
  if (user !== userId) return { status: 200, body: speak("Dieser Skill ist mit einem anderen Konto verbunden.", true) };

  const type = payload?.request?.type;
  if (type === "LaunchRequest") return { status: 200, body: speak("Hi, was kann ich tun?", false, "Stell mir eine Frage.") };
  if (type === "SessionEndedRequest") return { status: 200, body: speak("", true) };
  if (type !== "IntentRequest") return { status: 200, body: speak("Unbekannte Anfrage.", true) };

  const intent = payload.request?.intent?.name;
  if (intent === "AMAZON.HelpIntent") {
    return { status: 200, body: speak("Frag mich einfach was. Ich greife auf dein Conduit-Setup zu.", false, "Was möchtest du wissen?") };
  }
  if (intent === "AMAZON.CancelIntent" || intent === "AMAZON.StopIntent") return { status: 200, body: speak("Bis später.", true) };
  if (intent === "AMAZON.FallbackIntent") {
    return { status: 200, body: speak("Das hab ich nicht verstanden. Sag's nochmal.", false, "Was wolltest du wissen?") };
  }
  const query = questionOf(intent, payload.request?.intent?.slots?.query?.value);
  if (query === "") return { status: 200, body: speak("Ich hab dich nicht verstanden. Sag's nochmal.", false, "Was wolltest du wissen?") };
  if (query) {
    if (speaker?.ready()) return askWithHandoff(query, { ask, speaker, waitMs: Math.max(0, receivedAt + handoffMs - Date.now()), log });
    sendProgressive(payload, fetchImpl).catch(() => {});
    return answer(await ask(query), log);
  }
  return { status: 200, body: speak("Unbekannte Anfrage.", true) };
}

/**
 * The text for Claude, or null for an intent that asks nothing. A "ja" or
 * "nein" (alone or with more, "ja, schick sie ab") answers Claude's last
 * question; Alexa drops the word itself from the slot, so it is put back.
 */
export function questionOf(intent, slot) {
  const rest = String(slot || "").trim().slice(0, 1000);
  if (intent === "AskConduitIntent") return rest;
  if (intent === "AMAZON.YesIntent") return "Ja.";
  if (intent === "AMAZON.NoIntent") return "Nein.";
  if (intent === "ConduitYesIntent") return rest ? `Ja, ${rest}` : "Ja.";
  if (intent === "ConduitNoIntent") return rest ? `Nein, ${rest}` : "Nein.";
  return null;
}

function answer(r, log) {
  if (r.code === 200 && r.body?.ok) return { status: 200, body: speak(r.body.text || "Keine Antwort.", false, "Noch was?") };
  if (r.code === 429) return { status: 200, body: speak("Ich bin noch mit der letzten Frage beschäftigt. Versuch's gleich nochmal.", false) };
  log("warn", "alexa_answer_failed", { code: r.code });
  return { status: 200, body: speak("Da ist gerade was schiefgelaufen. Versuch's gleich nochmal.", true) };
}

/** What the speaker says once a handed-off question is done. */
export function spokenResult(r) {
  if (r?.code === 200 && r.body?.ok) {
    const text = String(r.body.text || "").trim() || "Ich bin fertig, habe aber keine Antwort bekommen.";
    // A question back needs the way to answer it: the Alexa session is over.
    return `${ANNOUNCE_PREFIX} ${text}${/\?\s*$/.test(text) ? ` ${REPLY_HINT}` : ""}`;
  }
  if (r?.code === 504) return `${ANNOUNCE_PREFIX} Die Aufgabe hat zu lange gedauert, ich habe sie abgebrochen.`;
  return `${ANNOUNCE_PREFIX} Das hat leider nicht geklappt. Versuch es bitte noch einmal.`;
}

// Handed-off questions still running, per speaker: a new question meanwhile
// is told that the answer is on its way.
const handedOff = new WeakMap();

/**
 * Answer within the handoff time if Claude is that quick; otherwise let the
 * question run on, end the Alexa turn and read the answer on the speaker.
 */
async function askWithHandoff(query, { ask, speaker, waitMs, log }) {
  const job = Promise.resolve().then(() => ask(query, { long: true }))
    .catch((e) => ({ code: 500, body: { ok: false, error: String(e?.message || e) } }));
  let timer;
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve(null), waitMs); });
  const quick = await Promise.race([job, late]);
  clearTimeout(timer);
  if (quick) {
    if (quick.code === 429 && handedOff.get(speaker)) return { status: 200, body: speak(BUSY_TEXT, true) };
    return answer(quick, log);
  }
  log("info", "alexa_handoff", { waitedMs: waitMs });
  handedOff.set(speaker, (handedOff.get(speaker) || 0) + 1);
  job.finally(() => handedOff.set(speaker, handedOff.get(speaker) - 1)).then((r) => {
    if (r.code !== 200) log("warn", "alexa_answer_failed", { code: r.code, handedOff: true });
    return speaker.announce(spokenResult(r));
  }).catch(() => {});
  return { status: 200, body: speak(HANDOFF_TEXT, true) };
}
