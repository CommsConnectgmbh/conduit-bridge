// SPDX-License-Identifier: Apache-2.0
// Port of misaki (semidark/misaki, Apache-2.0); see THIRD-PARTY-NOTICES.md.
// German text normalisation for the local TTS voice.
//
// Port of normalize_text_de() from misaki's German G2P (semidark/misaki,
// misaki/de.py, Apache-2.0), which is the frontend the Thorsten-Voice Kokoro
// model was trained with. Kept behaviourally identical so the phonemes we feed
// the model match its training distribution; parity is checked against the
// Python original by test/speech/de-normalize.parity.mjs.
//
// Deliberate deviations from the original (each covered by a unit test):
//   - "eine Million/Billion/Trillion" in the singular. The original says
//     "eine Millionen", which is wrong German.
//   - Numbers from 10^15 up use the German long scale (Billiarde, Trillion,
//     Trilliarde). The original calls 10^15 "Trillionen".
//   - Phone numbers are read digit by digit before years and plain numbers
//     are expanded, when they start with 0 or +, or follow a word like
//     "Telefon". The original turned "089 1234 5678" into
//     "neunundachtzig zwölfhundertvierunddreißig ...".
//   - Dotted version and IP numbers (0.12.3, 192.168.0.1) are read with
//     "Punkt"; the original left "null.zwölf.drei" for espeak.
// normalizeTextDe(text, { compat: true }) switches all of these off and is
// what the parity test runs against the Python original.
//
// Python and JavaScript regexes differ in three ways that matter here, so the
// patterns below spell them out instead of relying on \b, \d and \s:
//   - Python's \w, \d and \b are Unicode-aware, JavaScript's are ASCII-only
//     even with the u flag.
//   - Python's \s (str.isspace) includes U+001C..U+001F and U+0085 and
//     excludes U+FEFF; JavaScript's \s is the other way round.
//   - int() and Decimal() accept any Unicode decimal digit.
// One difference is left on purpose: character classes follow the Unicode
// version of the JavaScript engine (17.0 in Node 26), Python 3.12's follow
// 15.0. Characters assigned since then are letters here and unassigned there,
// so a digit right next to one reads differently; the reading here is the
// current standard's.

const W = "[\\p{L}\\p{N}_]"; // Python's Unicode \w (alphanumerics + underscore)
const B_START = `(?<!${W})`; // \b in front of a word character
const B_END = `(?!${W})`; // \b after a word character
const D = "\\p{Nd}"; // Python's Unicode \d
// Python's \s for str patterns, which is str.isspace().
const S_BODY = "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const S = `[${S_BODY}]`;
// Python's str.isspace() set, minus the space and newline that rule 2 keeps.
const OTHER_WS = "[\\t\\v\\f\\r\\x1c-\\x1f\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]";

/** Python's \s and \d, in or outside a character class, in JS syntax. */
function pyClasses(src) {
  let out = "", inClass = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") {
      const n = src[i + 1];
      if (n === "s") out += inClass ? S_BODY : S;
      else if (n === "d") out += D;          // \p{Nd} works in a class as well
      else out += c + n;
      i++;
      continue;
    }
    if (c === "[" && !inClass) inClass = true;
    else if (c === "]" && inClass) inClass = false;
    out += c;
  }
  return out;
}
const re = (src, flags = "") => new RegExp(
  pyClasses(src.replaceAll("\\b<", B_START).replaceAll("\\b>", B_END)),
  "gu" + flags,
);

// Value of one Unicode decimal digit. Nd characters come in contiguous runs
// of ten starting at a code point whose value is 0, which is what int() uses.
const ND = /^\p{Nd}$/u;
function digitValue(ch) {
  const cp = ch.codePointAt(0);
  if (cp >= 0x30 && cp <= 0x39) return cp - 0x30;
  let zero = cp;
  while (zero > cp - 9 && ND.test(String.fromCodePoint(zero - 1))) zero--;
  return (cp - zero) % 10;
}
/** int() of a string of Unicode decimal digits, as a BigInt. */
function toInt(digits) {
  let n = 0n;
  for (const ch of digits) n = n * 10n + BigInt(digitValue(ch));
  return n;
}
/** Unicode digits to ASCII, so the string can be parsed by Number(). */
function asciiDigits(s) {
  return s.replace(/\p{Nd}/gu, (c) => String(digitValue(c)));
}

// ── cardinal numbers ────────────────────────────────────────────────────────

const ONES = ["", "ein", "zwei", "drei", "vier", "fünf", "sechs", "sieben", "acht", "neun", "zehn",
  "elf", "zwölf", "dreizehn", "vierzehn", "fünfzehn", "sechzehn", "siebzehn", "achtzehn", "neunzehn"];
const TENS = ["", "", "zwanzig", "dreißig", "vierzig", "fünfzig", "sechzig", "siebzig", "achtzig", "neunzig"];
// Long scale, as used in German. The original labels 10^15 "Trillionen" and
// has no Billiarde/Trilliarde; we use the correct names.
const LARGE_SCALES_COMPAT = [
  [10n ** 15n, "eine Trillionen", "Trillionen"],
  [10n ** 12n, "eine Billionen", "Billionen"],
  [10n ** 9n, "eine Milliarde", "Milliarden"],
  [10n ** 6n, "eine Millionen", "Millionen"],
];
let scales = null; // set per call; see normalizeTextDe
const LARGE_SCALES = [
  [10n ** 21n, "eine Trilliarde", "Trilliarden"],
  [10n ** 18n, "eine Trillion", "Trillionen"],
  [10n ** 15n, "eine Billiarde", "Billiarden"],
  [10n ** 12n, "eine Billion", "Billionen"],
  [10n ** 9n, "eine Milliarde", "Milliarden"],
  [10n ** 6n, "eine Million", "Millionen"],
];

/** Integer to German words. standalone=false gives "ein" for 1 (einhundert). */
export function intToDe(value, standalone = true) {
  let n = BigInt(value);
  if (n < 0n) return "minus " + intToDe(-n);
  if (n === 0n) return "null";
  if (n === 1n) return standalone ? "eins" : "ein";
  if (n < 20n) return ONES[Number(n)];
  if (n < 100n) {
    const ones = Number(n % 10n), tens = Number(n / 10n);
    return ones ? ONES[ones] + "und" + TENS[tens] : TENS[tens];
  }
  if (n < 1000n) {
    const h = Number(n / 100n), r = n % 100n;
    return ONES[h] + "hundert" + (r ? intToDe(r, false) : "");
  }
  if (n < 1000000n) {
    const t = n / 1000n, r = n % 1000n;
    const prefix = t !== 1n ? intToDe(t, false) : "ein";
    return prefix + "tausend" + (r ? intToDe(r, false) : "");
  }
  for (const [divisor, singular, plural] of scales ?? LARGE_SCALES) {
    if (n >= divisor) {
      const count = n / divisor, r = n % divisor;
      const word = count === 1n ? singular : intToDe(count, false) + " " + plural;
      return word + (r ? " " + intToDe(r, false) : "");
    }
  }
  return intToDe(n);
}

// ── ordinals ────────────────────────────────────────────────────────────────

const ORD_IRREG = new Map([[1n, "erst"], [2n, "zweit"], [3n, "dritt"], [7n, "siebt"], [8n, "acht"]]);

export function ordinalStemDe(value) {
  const n = BigInt(value);
  if (ORD_IRREG.has(n)) return ORD_IRREG.get(n);
  let stem = intToDe(n, false) + (n < 20n ? "t" : "st");
  if (n === 100n || n === 1000n) stem = stem.replace("ein", "");
  return stem;
}

// ── years, months, currency ─────────────────────────────────────────────────

export function yearDe(value) {
  const n = BigInt(value);
  if (n >= 1100n && n <= 1999n) {
    const c = n / 100n, r = n % 100n;
    return intToDe(c, false) + "hundert" + (r ? intToDe(r, false) : "");
  }
  return intToDe(n);
}

const MONTHS = ["", "Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September",
  "Oktober", "November", "Dezember"];
const CURRENCY = { "€": "Euro", $: "Dollar", "£": "Pfund", "¥": "Yen" };

// Decimal(cleaned) accepts "12", "12.5", "12." and ".5"; anything else raises
// InvalidOperation and the original text stays.
const DECIMAL = /^(\d*)(?:\.(\d*))?$/;
function currencyRepl(sym, num) {
  const word = CURRENCY[sym] ?? sym;
  const cleaned = asciiDigits(num.replaceAll(".", "").replaceAll(",", "."));
  const m = DECIMAL.exec(cleaned);
  if (!m || (m[1] === "" && (m[2] ?? "") === "")) return sym + num;
  // Round to cents with ROUND_HALF_UP on the exact decimal value.
  const frac = (m[2] ?? "").padEnd(3, "0");
  let cents = BigInt(m[1] || "0") * 100n + BigInt(frac.slice(0, 2));
  if (Number(frac[2]) >= 5) cents += 1n;
  const euros = cents / 100n, rest = cents % 100n;
  if (rest === 0n) return intToDe(euros, false) + " " + word;
  return intToDe(euros, false) + " " + word + " und " + intToDe(rest, false) + " Cent";
}

function renderFullDate(day, month, year, suffix) {
  if (day < 1n || day > 31n || month < 1n || month > 12n) return null;
  return ordinalStemDe(day) + suffix + " " + MONTHS[Number(month)] + " " + yearDe(year);
}

const digitsToDe = (digits) => [...digits].map((d) => intToDe(digitValue(d))).join(" ");

// ── text normalisation ──────────────────────────────────────────────────────

const ABBREVIATIONS = [
  [re("\\b<Dr\\.(?=\\s)"), "Doktor"],
  [re("\\b<Prof\\.(?=\\s)"), "Professor"],
  [re("\\b<Hr\\.(?=\\s)"), "Herr "],
  [re("\\b<Fr\\.(?=\\s[A-ZÄÖÜ])"), "Frau"],
  [re("\\b<Dipl\\.\\s*-?\\s*Ing\\."), "Diplom-Ingenieur"],
  [re("\\b<Str\\.(?=\\s)"), "Straße"],
  [re("\\b<Nr\\.(?=\\s*\\d)"), "Nummer"],
  [re("\\b<Tel\\.(?=\\s)"), "Telefon"],
  [re("\\b<Abt\\.(?=\\s)"), "Abteilung"],
  [re("\\b<gem\\.(?=\\s)", "i"), "gemäß"],
  [re("\\b<Abs\\.(?=\\s*\\d)"), "Absatz"],
  [re("\\b<GmbH\\b>"), "Gesellschaft mit beschränkter Haftung"],
  [re("\\b<AG\\b>(?=[\\s,.]|$)"), "Aktiengesellschaft"],
  [re("\\b<z\\.\\s*B\\.", "i"), "zum Beispiel"],
  [re("\\b<d\\.\\s*h\\.", "i"), "das heißt"],
  [re("\\b<u\\.\\s*a\\.", "i"), "unter anderem"],
  [re("\\b<bzw\\.", "i"), "beziehungsweise"],
  [re("\\b<usw\\.", "i"), "und so weiter"],
  [re("\\b<etc\\.", "i"), "et cetera"],
  [re("\\b<ca\\.", "i"), "circa"],
  [re("\\b<vgl\\.", "i"), "vergleiche"],
  [re("\\b<inkl\\.", "i"), "inklusive"],
  [re("\\b<exkl\\.", "i"), "exklusive"],
  [re("\\b<ggf\\.", "i"), "gegebenenfalls"],
  [re("\\b<i\\.\\s*d\\.\\s*R\\.", "i"), "in der Regel"],
  [re("\\b<o\\.\\s*ä\\.", "i"), "oder ähnliches"],
  [re("\\b<u\\.\\s*U\\.", "i"), "unter Umständen"],
  ...[["Jan", "Januar"], ["Feb", "Februar"], ["Mär", "März"], ["Apr", "April"], ["Jun", "Juni"], ["Jul", "Juli"],
    ["Aug", "August"], ["Sep", "September"], ["Okt", "Oktober"], ["Nov", "November"], ["Dez", "Dezember"]]
    .map(([abbr, full]) => [re(`\\b<${abbr}\\.(?=\\s)`), full]),
  [re("§§\\s*(?=\\d)"), "Paragrafen "],
  [re("§\\s*(?=\\d)"), "Paragraf "],
];

const CSYM = "[€$£¥]";
const CURRENCY_BEFORE = re(`(${CSYM})\\s*(\\d[\\d.,]*)`);
const CURRENCY_AFTER = re(`(\\d[\\d.,]*)\\s*(${CSYM})`);
const TIME = re("\\b<(\\d{1,2}):(\\d{2})\\b>(?:\\s*Uhr\\b>)?");
const DATE_WITH_PREFIX = re("\\b<(vom|am|im|zum|den|der)\\s+(\\d{1,2})\\.(\\d{1,2})\\.(\\d{4})\\b>", "i");
const DATE = re("\\b<(\\d{1,2})\\.(\\d{1,2})\\.(\\d{4})\\b>");
const VERSION_WORD = new RegExp(`(?:${B_START}Version|${B_START}Release|${B_START}Build)${S}*$`, "iu");
const THOUSANDS = /^\p{Nd}{1,3}(?:\.\p{Nd}{3})+$/u;
const DOTTED = re("(?<![\\p{L}\\p{N}_])([vV])?(\\d+(?:\\.\\d+){2,})\\b>(?!\\.\\d)");
const ORDINAL_AM = re("\\b<([Aa]m)\\s+(\\d+)\\.\\s");
const ORDINAL = re("(?<!\\d)(\\d+)\\.\\s");
const YEAR = re("\\b<(\\d{4})\\b>");
const GROUPED = re("\\b<\\d{1,3}(?:\\.\\d{3})+(?:,\\d+)?\\b>");
const DECIMAL_COMMA = re("\\b<(\\d+),(\\d+)\\b>");
const PHONE = re("(?<![\\d.:])\\d{2,4}(?:[ -]\\d{2,6}){1,}(?![\\d.:])");
// Unambiguous phone numbers: international or trunk prefix, or a keyword in
// front. Separators inside: space, hyphen, slash, dot.
const PHONE_PREFIXED = re("(?<![\\d.:+])(\\+|00|0)(\\d{1,5}(?:[ \\-/.]?\\(?\\d{1,6}\\)?)*\\d)(?![\\d:])");
const PHONE_KEYWORD = re("\\b<(Telefon|Telefonnummer|Rufnummer|Fax|Mobil|Handy|Hotline)(\\s*:?\\s*)(\\d[\\d \\-/.]*\\d)(?![\\d:])", "i");
function readPhone(prefix, digits) {
  const spoken = [...digits.matchAll(/\p{Nd}+/gu)].map((g) => digitsToDe(g[0])).join(" ");
  return (prefix === "+" ? "plus " : prefix === "00" ? "null null " : prefix === "0" ? "null " : "") + spoken;
}
const PERCENT = re("\\s*%");
const PLAIN_INT = re("\\b<(\\d+)\\b>");
const REMAINING_TIME = re("\\b<\\d{1,2}:\\d{2}\\b>(?:\\s*Uhr\\b>)?");

/** Normalise German text for TTS: numbers, dates, times, currency, abbreviations. */
export function normalizeTextDe(input, { compat = false } = {}) {
  if (!input) return input;
  scales = compat ? LARGE_SCALES_COMPAT : LARGE_SCALES;
  try {
    return normalize(input, compat);
  } finally {
    scales = null;
  }
}

function normalize(input, compat) {
  let text = input;

  // 1. Quotes to ASCII.
  text = text.replaceAll("„", '"').replaceAll("“", '"');
  text = text.replaceAll("‘", "'").replaceAll("’", "'");
  text = text.replaceAll("«", '"').replaceAll("»", '"');
  text = text.replaceAll("‹", '"').replaceAll("›", '"');

  // 2. Non-breaking and other whitespace to a plain space (newlines stay).
  text = text.replace(new RegExp(OTHER_WS, "gu"), " ");

  // 3. Abbreviations.
  for (const [pattern, replacement] of ABBREVIATIONS) text = text.replace(pattern, replacement);

  // 4. Currency, symbol before or after the amount.
  text = text.replace(CURRENCY_BEFORE, (_, sym, num) => currencyRepl(sym, num));
  text = text.replace(CURRENCY_AFTER, (_, num, sym) => currencyRepl(sym, num));

  // 4b. Phone numbers (deliberate deviation, see header).
  if (!compat) text = text.replace(PHONE_KEYWORD, (_, word, gap, digits) => word + gap + readPhone("", digits));
  if (!compat) text = text.replace(PHONE_PREFIXED, (whole, prefix, rest) => {
    const groups = rest.match(/\p{Nd}+/gu) || [];
    // A lone short number after a 0 ("0,5", "05") is not a phone number.
    if (groups.join("").length + prefix.replace("+", "").length < 6) return whole;
    return readPhone(prefix, rest);
  });

  // 5. Times (HH:MM).
  text = text.replace(TIME, (whole, hh, mm) => {
    const h = toInt(hh), mi = toInt(mm);
    if (h > 23n || mi > 59n) return whole;
    return intToDe(h) + " Uhr" + (mi ? " " + intToDe(mi) : "");
  });

  // 6. Full dates (DD.MM.YYYY) with simple case-aware ordinal inflection.
  text = text.replace(DATE_WITH_PREFIX, (whole, prefix, d, m, y) => {
    const suffix = ["am", "im", "vom", "zum", "den"].includes(prefix.toLowerCase()) ? "en" : "e";
    const rendered = renderFullDate(toInt(d), toInt(m), toInt(y), suffix);
    return rendered === null ? whole : prefix + " " + rendered;
  });
  text = text.replace(DATE, (whole, d, m, y) => renderFullDate(toInt(d), toInt(m), toInt(y), "er") ?? whole);

  // 6b. Version and IP numbers (deliberate deviation, see header).
  // German thousands grouping (1.234.567) is not a version number.
  // After "Version", "v" or "Release" it is a version number either way.
  if (!compat) {
    text = text.replace(DOTTED, (whole, v, num, offset, all) => {
      const versionContext = !!v || VERSION_WORD.test(all.slice(Math.max(0, offset - 12), offset));
      if (THOUSANDS.test(num) && !versionContext) return whole;
      return (v ? "Version " : "") + num.split(".").map((n) => intToDe(toInt(n))).join(" Punkt ");
    });
  }

  // 7. Ordinals after "am" and in general mid-sentence.
  text = text.replace(ORDINAL_AM, (_, am, n) => am + " " + ordinalStemDe(toInt(n)) + "en ");
  text = text.replace(ORDINAL, (_, n) => ordinalStemDe(toInt(n)) + "e ");

  // 8. Standalone years.
  text = text.replace(YEAR, (_, y) => {
    const n = toInt(y);
    return n >= 1100n && n <= 2099n ? yearDe(n) : intToDe(n);
  });

  // 9. German-format numbers (1.234.567 or 1.234,56). The original goes
  // through float(), so we do too: same IEEE double, same rounding.
  text = text.replace(GROUPED, (whole) => {
    const cleaned = asciiDigits(whole.replaceAll(".", "").replaceAll(",", "."));
    const val = Number(cleaned);
    if (!Number.isFinite(val)) return whole;
    if (Number.isInteger(val)) return intToDe(BigInt(val));
    const [ip, fp] = cleaned.split(".");
    return intToDe(BigInt(ip)) + " Komma " + [...fp].map((d) => intToDe(BigInt(d))).join(" ");
  });

  // Decimal comma (3,14).
  text = text.replace(DECIMAL_COMMA, (_, ip, fp) => intToDe(toInt(ip)) + " Komma " + [...fp].map((d) => intToDe(digitValue(d))).join(" "));

  // Phone-like digit groups are read digit by digit.
  text = text.replace(PHONE, (whole) => [...whole.matchAll(/\p{Nd}+/gu)].map((g) => digitsToDe(g[0])).join(" "));
  text = text.replace(PERCENT, " Prozent");

  // Plain integers, except digits inside an invalid HH:MM that survived step 5.
  const before = text;
  text = text.replace(PLAIN_INT, (whole, digits, offset) => {
    const start = Math.max(0, offset - 3);
    const end = Math.min(before.length, offset + whole.length + ":00 Uhr".length);
    // finditer(text, start, end) treats the string as ending at `end`.
    const window = new RegExp(REMAINING_TIME.source, "gu");
    const head = before.slice(0, end);
    window.lastIndex = start;
    for (let t; (t = window.exec(head));) {
      if (t[0] === "") window.lastIndex++;
      if (t.index <= offset && offset + whole.length <= t.index + t[0].length) return whole;
    }
    return intToDe(toInt(digits));
  });

  // 10. Whitespace cleanup.
  text = text.replace(/[ \t]{2,}/g, " ");
  text = text.replace(/\n{3,}/g, "\n\n");
  return pyStrip(text);
}

// str.strip() without arguments strips Python whitespace, not JS whitespace.
const PY_WS = "[\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]";
const PY_STRIP = new RegExp(`^${PY_WS}+|${PY_WS}+$`, "gu");
export const pyStrip = (s) => s.replace(PY_STRIP, "");
