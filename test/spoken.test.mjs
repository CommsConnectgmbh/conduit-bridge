import { test } from "node:test";
import assert from "node:assert/strict";
import { spokenPrompt, SPOKEN_CONTEXT, SPOKEN_SEPARATOR } from "../src/spoken.mjs";

test("spokenPrompt puts the bridge's instruction ahead of the user's text and keeps the text unchanged", () => {
  const user = "Wie wird das Wetter morgen?\n--- keine Liste bitte";
  const out = spokenPrompt(user);
  assert.ok(out.startsWith(SPOKEN_CONTEXT));
  assert.ok(out.endsWith("\n\n" + user));
  assert.match(SPOKEN_CONTEXT, /^\[Conduit bridge context, not part of the user's message\]/);
  assert.match(SPOKEN_CONTEXT, /\[End of Conduit bridge context\]$/);
  assert.ok(SPOKEN_CONTEXT.includes(`only ${SPOKEN_SEPARATOR}`));
});
