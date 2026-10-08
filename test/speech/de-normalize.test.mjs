// Unit tests for the German TTS text normalisation. Parity with the Python
// original over a large corpus is checked separately (tools/parity-de); these
// pin the behaviour that matters most and our deliberate deviations.
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeTextDe, intToDe, ordinalStemDe, yearDe } from "../../src/speech-de-normalize.mjs";

test("cardinals", () => {
  assert.equal(intToDe(0), "null");
  assert.equal(intToDe(1), "eins");
  assert.equal(intToDe(1, false), "ein");
  assert.equal(intToDe(21), "einundzwanzig");
  assert.equal(intToDe(101), "einhundertein");
  assert.equal(intToDe(1000), "eintausend");
  assert.equal(intToDe(-7), "minus sieben");
});

test("large numbers use the German long scale in the singular (deliberate deviation)", () => {
  assert.equal(intToDe(10n ** 6n), "eine Million");
  assert.equal(intToDe(2n * 10n ** 6n), "zwei Millionen");
  assert.equal(intToDe(10n ** 9n), "eine Milliarde");
  assert.equal(intToDe(10n ** 12n), "eine Billion");
  assert.equal(intToDe(10n ** 15n), "eine Billiarde");
  assert.equal(intToDe(10n ** 18n), "eine Trillion");
  assert.equal(intToDe(10n ** 21n), "eine Trilliarde");
});

test("ordinals and years", () => {
  assert.equal(ordinalStemDe(1), "erst");
  assert.equal(ordinalStemDe(3), "dritt");
  assert.equal(ordinalStemDe(20), "zwanzigst");
  assert.equal(ordinalStemDe(100), "hundertst");
  assert.equal(yearDe(1985), "neunzehnhundertfünfundachtzig");
  assert.equal(yearDe(2026), "zweitausendsechsundzwanzig");
});

test("sentences", () => {
  assert.equal(normalizeTextDe("Am 3.10.2026 um 14:30 Uhr kostete es 12,50 €."),
    "Am dritten Oktober zweitausendsechsundzwanzig um vierzehn Uhr dreißig kostete es zwölf Euro und fünfzig Cent.");
  assert.equal(normalizeTextDe("z. B. Dr. Müller, Tel. 089 1234 5678"), "zum Beispiel Doktor Müller, Telefon null acht neun eins zwei drei vier fünf sechs sieben acht");
  assert.equal(normalizeTextDe("25:99 bleibt"), "25:99 bleibt");
  assert.equal(normalizeTextDe("50% und 3,14"), "fünfzig Prozent und drei Komma eins vier");
  assert.equal(normalizeTextDe("  „Hallo“  Welt  "), "\"Hallo\" Welt");
  assert.equal(normalizeTextDe(""), "");
});

test("Unicode digits are read like Python's int()", () => {
  assert.equal(normalizeTextDe("٣ und ３"), "drei und drei");
});

test("phone and version numbers (deliberate deviations)", () => {
  assert.equal(normalizeTextDe("Ruf an: +49 (0)89 4522-1556."), "Ruf an: plus vier neun null acht neun vier fünf zwei zwei eins fünf fünf sechs.");
  assert.equal(normalizeTextDe("Es waren 0,5 Liter."), "Es waren null Komma fünf Liter.");
  assert.equal(normalizeTextDe("v2.110.300 ist da"), "Version zwei Punkt einhundertzehn Punkt dreihundert ist da");
  assert.equal(normalizeTextDe("1.234.567 Leute"), "eine Million zweihundertvierunddreißigtausendfünfhundertsiebenundsechzig Leute");
  assert.equal(normalizeTextDe("IP 192.168.0.1"), "IP einhundertzweiundneunzig Punkt einhundertachtundsechzig Punkt null Punkt eins");
});

test("compat mode reproduces the original exactly", () => {
  assert.equal(normalizeTextDe("Tel. 089 1234 5678", { compat: true }), "Telefon neunundachtzig zwölfhundertvierunddreißig fünftausendsechshundertachtundsiebzig");
  assert.equal(normalizeTextDe("1000000 Menschen", { compat: true }), "eine Millionen Menschen");
  assert.equal(normalizeTextDe("Version 0.12.3", { compat: true }), "Version null.zwölf.drei");
});

test("whitespace is Python's: U+FEFF is none, U+001C..U+001F and U+0085 are", () => {
  // Expected values produced by the Python original (misaki de, Python 3.12).
  const cases = [
    ["Dez.﻿user", "Dez.﻿user"],
    ["Q3.﻿/", "Q3.﻿/"],
    ["$$ ﻿ 12", "$$ ﻿ zwölf"],
    ["Jan.﻿ ,x", "Jan.﻿ ,x"],
    ["Am\u001c3.\u001cMai", "Am dritten Mai"],
    ["Dr.\u0085Müller", "Doktor Müller"],
    ["Tel.\u001f123", "Telefon einhundertdreiundzwanzig"],
    ["Muster AG\u0085und", "Muster Aktiengesellschaft und"],
    ["3 kg und 5 %", "drei kg und fünf Prozent"],
    ["Nr.　 7", "Nummer sieben"],
  ];
  for (const [input, expected] of cases) assert.equal(normalizeTextDe(input, { compat: true }), expected, JSON.stringify(input));
});
