// Spoken replies (Conduit conversation mode).
//
// When the device says a turn is part of a spoken conversation, the agent is
// asked to lead with a short answer that reads well aloud and to put anything
// that only works on screen behind a line with just "---". The app reads the
// part before that line and shows the whole reply in the chat.
//
// The text below is the bridge's own; nothing from the device goes into it.
// It goes ahead of the prompt (not into --append-system-prompt), so a warm
// claude process keeps running when a chat switches between typing and
// talking, and every engine gets it the same way.

export const SPOKEN_SEPARATOR = "---";

export const SPOKEN_CONTEXT = [
  "[Conduit bridge context, not part of the user's message]",
  "The user is talking to you by voice and your reply will be read aloud.",
  "Start with a short spoken answer: one to three plain sentences in the user's language,",
  "without markdown, lists, tables, code, links or emoji.",
  `If the user also needs details on screen (code, lists, links, figures to copy), put them after a line that contains only ${SPOKEN_SEPARATOR}.`,
  "That part stays visible in the chat and is not read aloud. Leave it out when the short answer is enough.",
  "[End of Conduit bridge context]",
].join("\n");

/** The prompt an engine gets for a spoken turn. */
export function spokenPrompt(prompt) {
  return `${SPOKEN_CONTEXT}\n\n${prompt}`;
}
