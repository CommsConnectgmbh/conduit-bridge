// SPDX-License-Identifier: Apache-2.0
// Port of misaki (semidark/misaki, Apache-2.0); see THIRD-PARTY-NOTICES.md.
// German grapheme-to-phoneme for the Thorsten-Voice Kokoro model.
//
// Port of misaki's DEG2P and EspeakG2P (semidark/misaki, misaki/de.py and
// misaki/espeak.py, Apache-2.0): normalise the text, replace known brand and
// loan words with hand-written phonemes, phonemise the rest with espeak-ng,
// then map espeak's symbols onto Kokoro's (E2M). The espeak call itself is
// injected, so this module stays pure and testable; in the bridge it is the
// WASM build of espeak-ng 1.52.0 wrapped to match the Python phonemizer
// backend that misaki uses.

import { readFileSync } from "node:fs";
import { normalizeTextDe, pyStrip } from "./speech-de-normalize.mjs";

// EspeakG2P.e2m for misaki version None (the Thorsten model's setting),
// applied in sorted key order exactly like the original.
const E2M = Object.entries({
  "a^ɪ": "I", "a^ʊ": "W",
  "d^z": "ʣ", "d^ʒ": "ʤ",
  "e^ɪ": "A",
  "o^ʊ": "O", "ə^ʊ": "Q",
  "s^s": "S",
  "t^s": "ʦ", "t^ʃ": "ʧ",
  "ɔ^ɪ": "Y",
}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

/**
 * EspeakG2P.__call__: espeak phonemes in Kokoro's symbol set.
 * @param {string} text
 * @param {(text: string) => string} espeak phonemizer backend output (tie "^")
 */
export function espeakG2P(text, espeak) {
  // Angles to curly quotes, parentheses to angles (espeak keeps those).
  let t = text.replaceAll("«", "“").replaceAll("»", "”");
  t = t.replaceAll("(", "«").replaceAll(")", "»");
  let ps = espeak(t);
  if (!ps) return "";
  ps = pyStrip(ps);
  for (const [from, to] of E2M) ps = ps.replaceAll(from, to);
  ps = ps.replaceAll("^", "");
  ps = ps.replaceAll("-", "");
  return ps.replaceAll("«", "(").replaceAll("»", ")");
}

// ── pronunciation overrides ─────────────────────────────────────────────────

const LOOKUP_REPLACEMENTS = { "+": "plus", "&": "and", "@": "at" };
const TRAILING_PUNCT = new Set([..."".concat(".,!?;:%)]}»”")]);
// Python: [0-9A-Za-zÀ-ÖØ-öø-ÿß]+(?:['\-][0-9A-Za-zÀ-ÖØ-öø-ÿß]+)*\+?
const WORD = "[0-9A-Za-zÀ-ÖØ-öø-ÿß]";
const OVERRIDE_WORD_RE = new RegExp(`${WORD}+(?:['\\-]${WORD}+)*\\+?`, "gu");
const MAX_OVERRIDE_TOKENS = 4;

// str.isalnum(): Unicode letters and numbers (L*, Nd, Nl, No).
const ALNUM = /^[\p{L}\p{N}]$/u;

/** Collapse a word to its override lookup key (casefold, NFKD, no marks). */
export function normalizeForLookup(text) {
  const folded = caseFold(text).normalize("NFKD");
  let out = "";
  for (const ch of folded) {
    if (/\p{Mn}/u.test(ch)) continue;
    const rep = LOOKUP_REPLACEMENTS[ch];
    if (rep !== undefined) { out += rep; continue; }
    if (ALNUM.test(ch)) out += ch;
  }
  return out;
}

// str.casefold() differs from toLowerCase() mainly for ß and a few others.
function caseFold(s) {
  return s.toLowerCase().replaceAll("ß", "ss").replaceAll("ẞ", "ss").replaceAll("ς", "σ");
}

export function loadOverrides(path) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const lookup = new Map();
  for (const section of ["brand", "en", "de_foreign"]) {
    for (const [key, value] of Object.entries(raw[section] || {})) {
      const k = normalizeForLookup(key);
      if (!lookup.has(k)) lookup.set(k, value);
    }
  }
  const aliases = new Map();
  for (const [k, v] of Object.entries(raw.aliases || {})) aliases.set(normalizeForLookup(k), normalizeForLookup(v));
  return { lookup, aliases };
}

function resolveOverride(text, overrides) {
  let key = normalizeForLookup(text);
  if (!key) return null;
  key = overrides.aliases.get(key) ?? key;
  return overrides.lookup.get(key) ?? null;
}

function render(parts) {
  let out = "";
  for (let part of parts) {
    part = pyStrip(part);
    if (!part) continue;
    if (!out) out = part;
    else if (TRAILING_PUNCT.has(part[0])) out += part;
    else out += " " + part;
  }
  return out;
}

/**
 * DEG2P.__call__ plus the Thorsten-Voice inference patch (short ü "ʏ" is not
 * in Kokoro's vocabulary; the model was trained with it mapped to "y").
 * @param {string} text
 * @param {{ espeak: (text: string) => string, overrides: ReturnType<typeof loadOverrides>,
 *           compat?: boolean }} deps  compat: the original normaliser's readings
 *           of large numbers, phone and version numbers (for parity tests)
 */
export function g2pDe(text, { espeak, overrides, compat = false }) {
  const norm = normalizeTextDe(text, { compat });
  const espeakPart = (t) => (t && pyStrip(t) ? espeakG2P(t, espeak) || "" : "");

  const matches = [...(norm || "").matchAll(OVERRIDE_WORD_RE)];
  const parts = [];
  let cursor = 0;
  for (let i = 0; i < matches.length;) {
    let endIndex = null, phonemes = null;
    const maxEnd = Math.min(matches.length, i + MAX_OVERRIDE_TOKENS);
    for (let end = maxEnd; end > i; end--) {
      const start = matches[i].index;
      const stop = matches[end - 1].index + matches[end - 1][0].length;
      const p = resolveOverride(norm.slice(start, stop), overrides);
      if (p !== null) { endIndex = end - 1; phonemes = p; break; }
    }
    if (phonemes === null) { i++; continue; }
    const preceding = norm.slice(cursor, matches[i].index);
    if (pyStrip(preceding)) parts.push(espeakPart(preceding));
    parts.push(phonemes);
    cursor = matches[endIndex].index + matches[endIndex][0].length;
    i = endIndex + 1;
  }

  let ps;
  if (cursor === 0) ps = espeakG2P(norm, espeak);
  else {
    const trailing = norm.slice(cursor);
    if (pyStrip(trailing)) parts.push(espeakPart(trailing));
    ps = render(parts);
  }
  return ps.replaceAll("ʏ", "y");
}
