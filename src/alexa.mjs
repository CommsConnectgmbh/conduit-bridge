// Alexa skill endpoint, served by the bridge itself.
//
// Amazon posts each utterance to https://<tunnel>/alexa. The bridge checks
// Amazon's signature (alexa-verify.mjs) and the skill id, answers the built-in
// intents directly, and runs AskConduitIntent through the fixed Claude session.
// Moved here from the web app so that no server of ours holds a key to the
// bridge any more.

export const PROGRESSIVE_TEXT = "Moment, ich denk kurz nach.";

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
 * @param {{ skillId: string, userId: string, ask: (query: string) => Promise<{ code: number, body: any }>, fetchImpl?: typeof fetch, log: Function }} deps
 * @returns {Promise<{ status: number, body: object }>}
 */
export async function handleAlexaRequest(payload, { skillId, userId, ask, fetchImpl = fetch, log }) {
  const incoming = payload?.session?.application?.applicationId || payload?.context?.System?.application?.applicationId;
  if (!skillId || !userId) return { status: 503, body: { error: "skill not configured" } };
  if (incoming !== skillId) return { status: 403, body: { error: "wrong skill" } };
  // The skill runs Claude on this computer: only the owner's Alexa account
  // may use it, even if the skill were ever enabled for anyone else.
  const user = payload?.session?.user?.userId || payload?.context?.System?.user?.userId;
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
  if (intent === "AskConduitIntent") {
    const query = String(payload.request?.intent?.slots?.query?.value || "").trim().slice(0, 1000);
    if (!query) return { status: 200, body: speak("Ich hab dich nicht verstanden. Sag's nochmal.", false, "Was wolltest du wissen?") };
    sendProgressive(payload, fetchImpl).catch(() => {});
    const r = await ask(query);
    if (r.code === 200 && r.body?.ok) return { status: 200, body: speak(r.body.text || "Keine Antwort.", false, "Noch was?") };
    if (r.code === 429) return { status: 200, body: speak("Ich bin noch mit der letzten Frage beschäftigt. Versuch's gleich nochmal.", false) };
    log("warn", "alexa_answer_failed", { code: r.code });
    return { status: 200, body: speak("Da ist gerade was schiefgelaufen. Versuch's gleich nochmal.", true) };
  }
  return { status: 200, body: speak("Unbekannte Anfrage.", true) };
}
