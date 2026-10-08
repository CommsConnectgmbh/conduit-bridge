# misaki-en-js

Kokoro-82M-v1.0-konformes amerikanisch-englisches G2P für Node.js 22+ (ESM, keine Python-Laufzeit, keine npm-Abhängigkeiten).
Portiert wird genau der Pfad, den Kokoro nutzt:

```
KPipeline(lang_code='a')  ->  en.G2P(trf=False, british=False,
                                     fallback=espeak.EspeakFallback(british=False), unk='')
                          ->  Zeilen-Split (\n+), en_tokenize/waterfall_last (Chunks <= 510 Phonemzeichen)
```

## API

```js
import { createEnglishG2P, loadEnglishData, createEspeakFallback } from 'misaki-en-js';
import { createEspeakWasmEngine } from 'misaki-en-js/espeak-wasm';

const data = loadEnglishData();                       // einmal laden, beliebig oft teilen
const espeak = await createEspeakWasmEngine({
  modulePath: '/abs/pfad/espeak-wasm/dist/index.mjs', // Schwesterprojekt espeak-wasm
  dataset: 'alphabets',                               // nötig für Wörter in Fremdschriften (wie natives espeak)
});
const fallback = createEspeakFallback({ textToPhonemes: espeak.textToPhonemes, py: data.py });
const g2p = createEnglishG2P({ data, fallback });     // fallback(word) -> phonemes | null

const { phonemes, chunks } = g2p('Hello world! I read the record yesterday.');
// chunks: [{ text, phonemes }]  == Python [(graphemes, phonemes) for KPipeline(...)(text)]
// phonemes: chunks.map(c => c.phonemes).join(' ')
```

- `fallback` ist die schmale Schnittstelle `fallback(word) -> phonemes|null` (Kokoro-Phonemsatz). `createEspeakFallback` baut sie aus dem einzigen Engine-Primitiv `textToPhonemes(line)` (= phonemizer `EspeakWrapper.text_to_phonemes(line, tie)`, Voice `en-us`).
- Ohne `fallback` bekommen unbekannte Wörter keine Phoneme (in Python gibt es diese Konfiguration nicht: `fallback=None` lädt dort ein BART-Netz).
- `loadEnglishData(dir?, { taggerBackend: 'auto'|'wasm'|'js' })`. Keine globalen Seiteneffekte; jede Instanz hat eigenen Zustand (Caches, WASM-Speicher).
- Wie Python wirft die Bibliothek bei Zahlen >= 10^306 bzw. Float-Überlauf `OverflowError` (Python bricht dort ebenfalls ab). Der Aufrufer (Bridge) muss das abfangen.

## Aufbau

| Datei | Inhalt | Lizenz |
|---|---|---|
| `src/index.mjs` | API, Datenladen | Apache-2.0 |
| `src/misaki-en.mjs` | Port von `misaki/en.py`: Lexicon (grow_dictionary, get_NNP, get_special_case, stem_s/ed/ing, get_word, get_number, Währungen, apply_stress), merge_tokens, preprocess (Markdown-Links `[x](/ipa/)`, `[x](+2)`, `[x](#n#)`), spaCy-Alignment, fold_left, retokenize, Subtokenisierung, resolve_tokens, Hauptschleife | Apache-2.0 |
| `src/kokoro-pipeline.mjs` | Port von `KPipeline.__call__`/`en_tokenize`/`waterfall_last` | Apache-2.0 |
| `src/pyunicode.mjs` | Python-3.12-Stringsemantik (isspace/isalpha/isdigit/isupper, lower/upper/capitalize inkl. Final-Sigma, strip/split) aus exportierten Tabellen | Apache-2.0 |
| `src/spacy-tokenizer.mjs` | Port des spaCy-3.8-Tokenizers (Präfix/Suffix/Infix, url_match, 1347 Sonderfälle, PhraseMatcher-Pass, NORM-Tabellen, Symbol-IDs) | MIT |
| `src/spacy-tagger.mjs`, `src/murmur.mjs`, `kernels/tagger_kernels.c`, `src/tagger-kernels.wasm.mjs` | Inferenz von en_core_web_sm 3.8.0 tok2vec+tagger (HashEmbed mit MurmurHash, Maxout/LayerNorm, 4 Residual-CNN-Schichten mit Padding, Softmax-Argmax); WASM-SIMD-Kernel (6,7 KB, eingebettet) plus reines JS als Rückfall | MIT |
| `src/num2words.mjs` | Port von num2words 0.5.14 (EN: cardinal int/float, ordinal, year) mit BigInt und CPython-Float-Semantik | **LGPL-2.1-or-later** |
| `src/espeak-fallback.mjs` | Port von `EspeakFallback` + phonemizer-Logik (Punctuation preserve/restore, postprocess, keep-flags, tie `^`) | **GPL-3.0-or-later** |
| `src/espeak-wasm-adapter.mjs` | Anbindung an `espeak-wasm` (espeak-ng 1.52.0 WebAssembly) | **GPL-3.0-or-later** |
| `data/misaki/us_{gold,silver}.json` | unverändert aus misaki 0.9.4 | Apache-2.0 (misaki-Repo) |
| `data/spacy/*` | exportiert von `tools/export_spacy.py`: Tokenizer-Regeln (Python-Regex nach JS übersetzt, Unicode-Klassen aus Python-Tabellen), Gewichte (6,3 MB float32), Unicode-Tabellen | MIT (spaCy/en_core_web_sm) |
| `tools/*.py` | Export und Referenzerzeugung (Python-venv mit misaki/kokoro/spaCy) | – |
| `test/*` | Paritäts- und Differentialtests, Korpora, Referenzdaten | – |

## POS-Tagger: Bewertung und Entscheidung

| Option | Qualität (Gleichheit mit misaki) | Lizenz | Bewertung |
|---|---|---|---|
| wink-nlp + wink-eng-lite-web-model | eigener Tokenizer und Universal-POS statt Penn-Tags (misaki verzweigt auf NN/NNP/VBD/VBN/DT/IN/…); Abbildung verlustbehaftet, Tokenisierung weicht von spaCy ab | MIT | kann per Konstruktion nicht identisch sein |
| eigenes Averaged Perceptron (Penn-Tags) | bräuchte Trainingsdaten; PTB/OntoNotes sind nicht frei, Destillation aus spaCy-Ausgaben bleibt eine Näherung | eigene | nicht identisch, Trainingsaufwand |
| ONNX-Export eines Taggers | native Abhängigkeit onnxruntime-node; Tokenizer und Feature-Hashing müssten trotzdem portiert werden | MIT | kein Vorteil gegenüber direktem Port |
| **exakter Port von en_core_web_sm (gewählt)** | gleiche Gewichte, Features, Architektur -> gemessen 100 % Tag-Gleichheit | MIT (Modell, spaCy, thinc) | 6,3 MB Gewichte, 0,64 ms/Satz gemessen |

(Die Alternativen wurden nach Architektur bewertet, nicht implementiert und gemessen.)

Gewählt wurde der exakte Port: es ist das einzige Verfahren, das per Konstruktion dieselben Tags liefert. Die verbleibende theoretische Abweichung ist Rundungsrauschen (numpy/BLAS summiert float32 in anderer Reihenfolge); messbar war sie nicht (s. u.).

## Testergebnisse (gemessen, Stand 2026-10-08)

Referenz: Python 3.12, misaki 0.9.4, kokoro 0.9.4, spaCy 3.8.16, en_core_web_sm 3.8.0, phonemizer-fork 3.3.2, espeak-ng 1.52.0 (Homebrew, nativ).
Verglichen wird pro Text die vollständige Chunk-Liste `[(graphemes, phonemes)]` von `KPipeline(lang_code='a', model=False)(text)`.

| Korpus | Texte | identisch (Satzebene) | Phonem-Wörter (LCS) | espeak |
|---|---|---|---|---|
| `en_corpus` (handgeschrieben + Vorlagen + stdlib-Docstrings + Absätze > 510 Phoneme) | 3 608 (4 052 Chunks) | **3 608 / 3 608 (100 %)** | 68 017 / 68 017 | WASM live |
| `en_fuzz` (Groß/Klein-Varianten, Zahlen-Fuzz, Unicode/Leerraum/Satzzeichen-Fuzz, Link-Features, sehr lange Eingaben) | 2 585 | **2 585 / 2 585** (inkl. 3 Fälle, in denen Python `OverflowError` wirft – JS wirft identisch) | 45 863 / 45 863 | WASM live |
| `en_natural` (README-Absätze aller venv-Pakete + stdlib-Docstrings) | 12 237 (27 418 Chunks) | **12 237 / 12 237** | 215 574 / 215 574 | WASM live |
| `en_targeted` (seltene Pfade: abgeleitete Formen nicht im Lexikon, Possessive, Punkt-Abkürzungen, Währungs-Randfälle, Stress-/Alignment-Features) | 2 066 | **2 066 / 2 066** | 7 672 / 7 672 | WASM live |
| **Summe** | **20 496** | **100 %** | **337 126 / 337 126** | |

Komponententests (Differential gegen Python):

| Test | Ergebnis |
|---|---|
| spaCy-Tokenisierung (`en_natural`) | 12 237 / 12 237 Texte identisch |
| POS-Tags, WASM-Backend | 301 604 / 301 604 Tokens identisch |
| POS-Tags, JS-Backend | 301 604 / 301 604 Tokens identisch |
| Lexikon `Lexicon.__call__` (40 044 Wörter × zufällige Tags, Kontext, Stress, Währung, num_flags) | 40 044 / 40 044 |
| num2words (int bis 310 Stellen, ordinal, year, float inkl. Rundungsgrenzen, Overflow) | 13 176 / 13 176 |
| EspeakFallback-Nachverarbeitung (5 030 OOV-/Satzzeichen-/Unicode-Strings) | 5 030 / 5 030 (mit nativen Rohdaten und mit WASM live) |
| espeak-wasm Rohausgabe vs. natives espeak-ng | 15 367 / 15 367 Zeilen (Datensatz `alphabets`; mit `default` 21 Abweichungen bei Fremdschrift) |

Abweichungsklassen: **keine gemessen.** Während der Entwicklung gefundene und behobene Klassen: (1) spaCy-StringStore liefert für 457 Symbol-Strings (`_`, `X`, `NN`, …) feste IDs statt Hashes -> 15 Satzabweichungen durch falsche Tags, behoben; (2) espeak-wasm mit Datensatz `default` kennt Fremdschrift-Wörterbücher nicht -> `dataset: 'alphabets'` verwenden.

Verbleibende theoretische Abweichungsquellen (nicht beobachtet):
- Tagger-Arithmetik: float32-Summationsreihenfolge (WASM-SIMD/JS vs. BLAS). Kann bei extrem knappen Logit-Gleichständen ein anderes Tag ergeben.
- Unicode-Version: Python-Stringprädikate, Groß/Klein und `\s\w\d` kommen aus exportierten Python-15.0-Tabellen (exakt). `NFKC` und `\p{L}/\p{Lu}/\p{Ll}/\p{Nd}` im Subtoken-Regex nutzen Node (ICU 78, Unicode 17); Python nutzt `unicodedata` 15.0 bzw. das `regex`-Paket. Unterschiede nur bei Zeichen, die nach Unicode 15 hinzukamen.
- espeak-Absturz: wo natives espeak-ng 1.52.0 segfaultet (Python-Prozess stirbt), liefert der JS-Fallback `null` und baut die WASM-Instanz neu auf.

## Leistung (Apple-Silicon-Mac, Node 26.11, gemessen mit `npm run bench`)

- Laden aller Daten: ~240 ms (davon Lexika ~190 ms); erster Aufruf 4,6 ms.
- Speicher nach dem Laden: Heap +32,5 MB, ArrayBuffer/WASM +12 MB; RSS-Zuwachs ~138 MB (überwiegend V8-Heap-Reserve aus dem JSON-Parsen der 6 MB Lexika); RSS nach 3 392 Sätzen 164 MB gesamt.
- Durchsatz ohne espeak: 0,64 ms/Satz (≈ 82 000 Zeichen/s). Mit WASM-espeak live: 3 608 Korpus-Texte in 4,0 s (Python-Referenz 6,1 s), 12 237 natürliche Texte in 15,6 s (Python 36,0 s).
- Tagger: WASM-SIMD 2,2 s, reines JS 14,2 s für 81 000 Tokens. espeak-wasm-Instanz: ~16 ms Start, ~12 MB.

## Lizenzen

- misaki (Apache-2.0, kein NOTICE upstream), kokoro (Apache-2.0), spaCy/thinc/en_core_web_sm (MIT): mit MIT-/Apache-Verteilung vereinbar; Texte in `licenses/`, Zuordnung in `NOTICE`.
- Lexika `us_gold.json`/`us_silver.json`: liegen im Apache-2.0-Repo von misaki ohne eigene Datenlizenz; die Herkunft der Einträge ist upstream nicht dokumentiert (offener Punkt).
- en_core_web_sm: Gewichte MIT (ExplosionAI); Trainingsdaten OntoNotes 5 (von Explosion lizenziert), WordNet 3.0 – siehe `licenses/en_core_web_sm-LICENSES_SOURCES.md`.
- **num2words ist LGPL-2.1** -> `src/num2words.mjs` bleibt LGPL (eigene, austauschbare Datei; Quelltext liegt bei). Mit MIT-Verteilung des Rests vereinbar.
- **phonemizer und espeak-ng sind GPL-3.0** -> `src/espeak-fallback.mjs` und `src/espeak-wasm-adapter.mjs` sind GPL-3.0-or-later. Wer den espeak-Fallback mitverteilt, verteilt GPL-Code; das betrifft jede Kokoro-Pipeline mit espeak, auch die Python-Originalpipeline.
- Neue npm-Pakete: keine. Build-Werkzeug für den Kernel: LLVM clang aus Emscripten (nur zum Neubau nötig, nicht verteilt).

## Tests ausführen

```sh
npm test                                   # Unit + num2words + Lexikon + Fallback + Paritätskorpus
npm run test:parity:all                    # fuzz, natural, targeted
ESPEAK_WASM=/abs/espeak-wasm/dist/index.mjs node test/parity.mjs test/corpus/en_natural.json test/corpus/en_natural_reference.json
node test/spacy.test.mjs test/corpus/en_natural.json test/data/natural_spacy_ref.json
```
Ohne `ESPEAK_WASM` liefern die Tests die aufgezeichneten nativen espeak-Rohausgaben (`*_reference.json`, `test/espeak-cache.json`), sodass beide Seiten byte-gleiche espeak-Ergebnisse sehen.
Referenzen neu erzeugen: `python tools/py_reference.py <korpus.json> <out.json>` im venv mit misaki/kokoro/en_core_web_sm.

## Offene Punkte

1. Speicher: Lexika als vorberechnetes Binärformat (sortierte Schlüssel, Binärsuche) würden RSS und Ladezeit deutlich senken; bewusst nicht gemacht, solange 240 ms / ~140 MB akzeptabel sind.
2. Herkunft/Lizenz der misaki-Lexikondaten upstream klären (hexgrad).
3. Lizenzentscheidung für die Bridge: GPL-3.0 durch espeak-ng (Fallback) und LGPL-2.1 durch num2words-Port. Alternative ohne GPL wäre ein anderer OOV-Fallback (z. B. misakis BART-Fallback-Netz), der dann aber nicht mehr trainingskonform zu Kokoros espeak-Pipeline ist.
4. Britisches Englisch (`lang_code='b'`) ist nicht portiert (`british: true` wirft).
5. Die README des espeak-wasm-Projekts war zum Abschluss noch ein Platzhalter; die Anbindung wurde gegen dessen aktuelles `dist/` (espeak-ng 1.52.0) getestet.
