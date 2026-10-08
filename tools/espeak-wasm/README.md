# espeak-ng 1.52.0 als WebAssembly-Phonemizer für Node.js

Text → IPA-Phoneme mit **unverändertem** eSpeak NG 1.52.0, kompiliert nach
WebAssembly. Ausgabe bit-identisch zur nativen Homebrew-`libespeak-ng` 1.52.0
(macOS) und zur Python-Bibliothek `phonemizer` 3.3.2, gemessen auf
4 742 Korpus- und 15 000 Fuzz-Texten (Zahlen unten).

Node.js ≥ 22, ESM, synchron nach `await createPhonemizer()`.

```js
import { createPhonemizer } from './dist/index.mjs';

const ph = await createPhonemizer();                  // dataset 'complete' (Standard)
ph.phonemizeClauses('Hallo, Welt!', 'de');            // ['hˈaloː', 'vˈɛlt']   (Roh-Ausgabe je Clause)
ph.phonemize('Hallo, Welt!', 'de');                   // 'hˈaloː vˈɛlt'        (= phonemizer text_to_phonemes)
ph.phonemizeLikePythonPhonemizer('Hallo, Welt!', 'de');
// ['hˈaloː, vˈɛlt! ']  = EspeakBackend('de', preserve_punctuation=True, with_stress=True,
//                        tie='^', language_switch='remove-flags').phonemize([text])
ph.close();
```

## API (`dist/index.mjs`)

| Funktion | Bedeutung |
|---|---|
| `await createPhonemizer({ dataset?, dataPath?, dataBytes?, verifyData? })` | neue, unabhängige Instanz (eigenes WebAssembly-Modul, eigener Speicher). `dataset`: `'complete'` (Standard) oder `'minimal'`. `verifyData` (Standard `true`) prüft den SHA-256 des Archivs gegen `build-info.mjs`. Mehrere Instanzen mit demselben `dataBytes`-Puffer teilen sich die Datei-Inhalte (nur lesend). |
| `phonemizeClauses(text, voice, { tie = true, phonemeMode? })` | Roh-Ausgabe von `espeak_TextToPhonemes` je Clause (auch leere), Reihenfolge wie espeak. `tie:true` = Modus `0x02 \| 0x01<<7 \| 0x0361<<8` (IPA, Tie U+0361), `tie:false` = `'_'<<8 \| 0x02`. |
| `phonemize(text, voice, opts)` | Clauses wie phonemizer zusammengefügt (nicht-leere mit `' '`); die Verknüpfung passiert in C (`conduit_phonemize`). |
| `phonemizeLikePythonPhonemizer(text, lang)` | komplette phonemizer-Nachverarbeitung (siehe unten), Rückgabe `string[]` wie `backend.phonemize([text])`, also meist ein Element, `[]` für leeren Text. |
| `resolveVoice(lang)` | Sprachcode → espeak-Voice wie phonemizer (`de`→`gmw/de`, `en-us`→`gmw/en-US`, `en-gb`→`gmw/en`). |
| `close()` | `espeak_Terminate`, Instanz unbrauchbar. |
| `EspeakCrashError` | wird geworfen, wenn espeak auf einer Eingabe abstürzt (siehe „Abstürze“). Die Instanz ist danach geschlossen. |

`voice` darf ein phonemizer-Sprachcode (`de`, `en-us`, `en-gb`) oder ein
espeak-Voice-Name sein. Text mit einzelnen UTF-16-Surrogaten wird abgelehnt
(TypeError; Python wirft dort `UnicodeEncodeError`). Ein U+0000 im Text
beendet ihn, wie bei Python (`c_char_p`).

## Artefakte (`dist/`)

| Datei | Bytes | SHA-256 |
|---|---:|---|
| `espeak-ng.wasm` | 318 139 | `3e4fca392a3499c0f594b51ae9154723e5c3785f060bdda0f11371162abd01b1` |
| `espeak-ng.mjs` (Emscripten-Lader) | 64 517 | `525df8de94a8091e7c9cc705b7f7fd3c0c5bf6a473f6dc85653ec76121d17d48` |
| `espeak-ng-data-complete.tar` | 10 721 280 | `3b485f254e7cc0df5a700e1a8514cd34cb6210e0101390e6a43ef98ed5692acd` |
| `espeak-ng-data-minimal.tar` | 911 360 | `aa3d24fbfcac78836347c53191cf1072d2b9700671eb03a69502ab7ac22f9589` |
| `index.mjs`, `phonemizer-compat.mjs`, `build-info.mjs` | 10 573 / 7 182 / 970 | siehe `SHA256SUMS` |

Zwei saubere Builds hintereinander (einer mit leerem Emscripten-Cache) ergeben
byte-identische Artefakte.

### Datensätze

Beide enthalten `phontab`, `phonindex`, `phondata`, `intonations` und die Voices
`lang/gmw/de`, `lang/gmw/en-US`, `lang/gmw/en` (en-gb), alles mit dem nativ aus
denselben Quellen gebauten `espeak-ng` kompiliert und byte-identisch zur
Homebrew-Installation (build.sh prüft das).

* **`complete` (Standard):** zusätzlich jedes Wörterbuch, das libespeak-ng 1.52.0
  beim Lesen von de/en-Text laden kann (`tools/dict_closure.py`): `pl` (de_rules
  schaltet ą ć ę ł ń ś ż ź auf Polnisch, z. B. „Gdańsk“), die Sprachen der
  Alphabet-Tabelle `el hy hi bn pa gu ta te kn ml si ka ko` (Wörter und Buchstaben
  anderer Schriften) und `ru` (der georgische Übersetzer liest Kyrillisch als
  Russisch). Damit verhält sich das Modul für jede Eingabe wie eine volle
  Installation. `bn_dict` und `ko_dict` werden aus der Homebrew-Installation
  übernommen (per SHA-256 gepinnt), weil ihre Kompilierung nicht reproduzierbar
  ist: `rgroup_sorter()` in compiledict.c entscheidet Gleichstände über die
  abgeschnittene Differenz zweier Heap-Zeiger, `ko_dict` fällt bei jedem Lauf anders aus.
* **`minimal`:** nur `de_dict` und `en_dict` (wie ursprünglich vorgegeben).
  Identisch zu einer nativen Installation mit denselben Dateien für de/en-Text
  (Korpus 100 %), aber: polnische Buchstaben und fremde Schriften werden anders
  gelesen als von einer vollen Installation (Korpus: 106 von 3 126 deutschen Sätzen),
  und wenn espeak auf ein fehlendes Wörterbuch umschalten will, liest 1.52.0 über
  einen wilden Zeiger (`LookupDict2`, nativ mit AddressSanitizer: SEGV). Nativ kommt
  dann zufallsabhängiger Text heraus, hier eine `EspeakCrashError` (Fuzz: 10 bis 12
  von 10 000 deutschen Texten in drei Läufen; die Zahl schwankt, weil das native
  Verhalten undefiniert ist).
  Deshalb ist `complete` der Standard.

## Wie die Bit-Identität erreicht wird

1. **Quelle unverändert:** Tag `1.52.0`, Commit `4870adfa25b1a32b4361592f1be8a40337c58d6c`,
   Archiv-SHA-256 `bb4338102ff3b49a81423da8a1a158b420124b055b60fa76cfb4b18677130a23`
   (dasselbe Archiv wie die Homebrew-Formel). Gebaut mit `emconfigure`/`emmake`,
   `--with-pcaudiolib=no --with-sonic=no --with-mbrola=no --with-async=no
   --with-klatt=no --with-speechplayer=no`, nur `libespeak-ng.a`. Klatt/MBROLA
   beeinflussen die Phonem-Ausgabe nicht: die einzige Stelle im Übersetzungspfad
   (`synthdata.c`, Bedingungen `KlattSynth`/`MbrolaSynth`) ist für die de/en-Voices
   in beiden Builds `false`.
2. **Gleicher Aufrufablauf wie phonemizer:** `espeak_Initialize(AUDIO_OUTPUT_SYNCHRONOUS, 0, path, …)`,
   `espeak_ListVoices(NULL)` → erste Voice je Sprache → `espeak_SetVoiceByName`
   (nur beim Voice-Wechsel), dann `espeak_TextToPhonemes(&p, espeakCHARS_UTF8, mode)`
   bis `p == NULL`. Einziger Unterschied: Option `espeakINITIALIZE_DONT_EXIT`
   statt `0`, damit kaputte Daten einen Fehler liefern statt `exit()` im Modul;
   die Option wirkt nur auf die Fehlerbehandlung.
3. **libc-Zeichenklassen wie macOS:** Die breiten Funktionen (`iswalpha` …) bildet
   espeaks Kompatibilitäts-Header ohnehin auf die mitgelieferte ucd-tools ab. Übrig
   bleiben die schmalen `<ctype.h>`-Funktionen (`isspace`, `isalpha`, `isalnum`,
   `isdigit`, `tolower` …): macOS beantwortet sie im von espeak gesetzten Locale
   `C.UTF-8` (`isspace(0xA0)` ist wahr, `toupper(0xFF)` = 0x178), musl nur für ASCII.
   `src/conduit_ctype.c` emuliert macOS aus einer Tabelle, die `tools/wctype/dump_ctype.c`
   aus der echten macOS-libc erzeugt; gegengeprüft für alle Werte −128 … 0x1FFFFF
   (8 319 Läufe identisch), und per Präprozessor-Vergleich aller 33 Übersetzungseinheiten
   ist belegt, dass jede Zeichenklassen-Aufrufstelle im WASM-Build dieselbe
   Funktion trifft wie nativ. (Build-Fix nebenbei: musls `<wchar.h>` kollidiert mit
   dem Kompatibilitäts-Header, `dictionary.c` kompiliert sonst nicht.)
4. **Abstürze wie nativ:** `-fsanitize=null -fsanitize-trap=null` lässt jeden Zugriff
   über einen NULL-Zeiger trappen (nativ ist die Nullseite nicht gemappt → SIGSEGV;
   in WebAssembly wäre Adresse 0 lesbar und es käme stiller Unsinn heraus). Auf
   Korpus und Fuzz: 0 Traps, wo nativ kein Absturz war.

## Abstürze der nativen libespeak-ng 1.52.0

Gefunden per Fuzzing, mit AddressSanitizer lokalisiert (`tools/diag/`). Nativ
stürzt der Prozess ab, also auch ein Python-Prozess mit phonemizer. Das
WASM-Modul wirft auf genau diesen Eingaben `EspeakCrashError` (alle 12 Absturzfälle
aus 5 verschiedenen Fuzz-Texten, über alle Läufe), die Instanz ist danach zu.

| Minimale Eingabe | Voice | Ursache |
|---|---|---|
| `24🤠`, `🤠ǆ`, `🚼͟` | de | NULL-`PHONEME_TAB` in `InterpretCondition` (synthdata.c:579) nach Wechsel auf die Phonemtabelle „base“ (Emoji-Einträge) |
| `“-मस` | de, en-us | Lesen vor `ph_list3` in `CountVowelPosition` (synthdata.c:459) |
| `!-ുఓ` | de | dito |

Weitere echte Speicherfehler ohne nativen Absturz (AddressSanitizer, 17 Fuzz-Texte):
`InterpretCondition` synthdata.c:618, `RemoveEnding` dictionary.c:2997,
`IsLetterGroup` dictionary.c:743 (Lesen außerhalb von Stack-Puffern). Auf allen
diesen Texten ist die WASM-Ausgabe trotzdem identisch zur nativen. Upstream hat
nach 1.52.0 mehrere dieser Fehler behoben (u. a. „Avoid underflowing ph_list3“,
„Fix NULL phoneme_tab dereferences …“); die Patches sind hier bewusst nicht
eingespielt, weil sie das Verhalten gegenüber 1.52.0 ändern.

## Was phonemizer zusätzlich macht (nachgebaut in `phonemizer-compat.mjs`)

Für `EspeakBackend(lang, preserve_punctuation=True, with_stress=True, tie='^',
language_switch='remove-flags').phonemize([text])` (Separator Standard: Wort `' '`,
Phon `''`; `strip=False`; `words_mismatch='ignore'` ändert nichts):

1. **Satzzeichen herauslösen** (`Punctuation.preserve`): Regex
   `(\s*[;:,.!?¡¿—…"«»“”(){}[]]+\s*)+`. Jede Fundstelle (mit umgebendem Leerraum)
   wird zur Marke mit Position B (Zeilenanfang), E (Ende), I (Mitte) oder A (nur
   Satzzeichen). B/E werden per String-Vergleich (`startswith`/`endswith`) und über
   die Identität des ersten/letzten Treffers bestimmt; geschnitten wird am ersten
   Vorkommen des Markentexts; leere Stücke fallen weg. Andere Zeichen wie `„ ‚ ' - /`
   gehen an espeak (z. B. verschwindet `„` aus `„Ja“, sagte er.` → `['jˈɑː“, zˈɑːɡtə ɛɾ. ']`).
2. **espeak je Stück:** jedes Stück ist ein eigener `text_to_phonemes`-Aufruf auf
   derselben Engine (Zustand läuft weiter); nicht-leere Clauses mit `' '` verbunden.
3. **Zeile nachbearbeiten** (`_postprocess_line`): `strip()`, `\n`→`' '`, `'  '`→`' '`
   (ein Durchgang), `_+`→`_`, `'_ '`→`' '`, Sprachwechsel-Flags `\(.+?\)` entfernen
   (`(͡e͡n)`, `(͡d͡e)` – espeak setzt Ties auch in die Flags), dann je Wort `strip()`,
   Betonung bleibt, U+0361 → `^`, nach jedem Wort ein `' '` (Zeile endet mit Leerzeichen).
4. **Satzzeichen zurück** (`Punctuation.restore`): B voran, E dahinter plus `' '`
   (außer die Marke endet schon mit Leerzeichen), I verbindet zwei Stücke, A steht
   allein; vor dem Anhängen wird das abschließende `' '` des Stücks entfernt;
   Stücke ohne Marke bekommen ein abschließendes `' '`.
5. Ergebnis: Liste; `''` → `[]`, `'   '` → `[' ']`, `'...'` → `['...']`.

Python-Semantik exakt: `str.strip()` und `\s` nutzen Pythons Unicode-Leerraum
(29 Zeichen; anders als JS-`\s`: zusätzlich U+001C–U+001F und U+0085, ohne U+FEFF),
`.` schließt nur `\n` aus, alle Regexe arbeiten auf Codepoints.

## Zustand, Threads, Reentrancy

* espeak-ng hält seinen gesamten Zustand in globalen Variablen. Hier lebt jede
  Instanz in einem eigenen WebAssembly-Modul mit eigenem linearen Speicher; es gibt
  keinen geteilten Zustand zwischen Instanzen (getestet: zwei Instanzen abwechselnd
  benutzt, eine davon absichtlich zum Absturz gebracht, die andere liefert exakt
  dieselben Ergebnisse wie allein).
* Innerhalb einer Instanz sind Aufrufe synchron und nicht reentrant. Eine Instanz
  nicht über `worker_threads` teilen; pro Worker eine eigene Instanz anlegen.
* espeak trägt Zustand von einem Text zum nächsten. Für exakt phonemizer-gleiche
  Ergebnisse wie phonemizer eine Instanz pro Sprache verwenden (phonemizer nutzt
  pro Backend eine eigene Bibliothekskopie) und die Texte in derselben Reihenfolge
  verarbeiten. Gemessen: 0 von 500 deutschen Korpus-Sätzen ergeben auf einer
  frischen Instanz etwas anderes als in Folge.
* Nach `EspeakCrashError` ist die Instanz geschlossen (wie ein abgestürzter Prozess).

## Messwerte (Apple M4 Pro, Node 26.11, `dataset: 'complete'`)

20-Wort-Satz DE „Am Montag fährt Herr Müller um 14:30 Uhr mit dem ICE von München
nach Hamburg, um seine Großmutter zu besuchen.“, EN „On Monday Mr. Miller takes the
2:30 p.m. train from Boston to New York to visit his old grandmother again.“,
5 000 Wiederholungen nach 200 Aufwärmläufen:

| | Median | p95 |
|---|---:|---:|
| WASM `phonemizeClauses` de | 61,7 µs | 65,9 µs |
| WASM `phonemizeLikePythonPhonemizer` de | 66,5 µs | 70,2 µs |
| nativ (ctypes, gleiche Schleife) de | 56,0 µs | 59,5 µs |
| Python phonemizer de | 78,4 µs | 85,2 µs |
| WASM `phonemizeClauses` en-us | 91,0 µs | 97,6 µs |
| WASM `phonemizeLikePythonPhonemizer` en-us | 95,5 µs | 101,3 µs |
| nativ (ctypes) en-us | 89,7 µs | 94,7 µs |
| Python phonemizer en-us | 120,2 µs | 130,2 µs |

Instanz anlegen + erster Aufruf: 8,7 ms (`complete`, aus Datei inkl. SHA-256),
5,0 ms mit geteiltem `dataBytes`; `minimal` 1,6 ms. RSS-Zuwachs je zusätzlicher
Instanz (geteilte Daten, nach einem Satz): 0,8 MiB. Stack: 1 MiB eingestellt; mit
`-sSTACK_OVERFLOW_CHECK=2` laufen alle 46 094 Test-Texte schon mit 64 KiB, 32 KiB reichen nicht.

## Tests (`test/`)

`PYTHON=<venv mit phonemizer>/bin/python test/run_all.sh` erzeugt Korpus
(`gen_corpus.py`: 3 126 de / 1 616 en; Zahlen, Datum, Uhrzeit, Abkürzungen,
Umlaute/ß, Komposita, Fremdwörter, URLs, Satzzeichen, Emojis, polnische Namen,
fremde Schriften, Steuerzeichen, Unicode-Normalisierung, sehr lange Sätze,
leere Strings) und Fuzz-Korpus (`gen_fuzz.py`: 10 000 de / 5 000 en, 2,08 Mio.
Zeichen), die nativen Referenzen (`ref_native.py`: Homebrew-Bibliothek über ctypes,
Aufrufablauf wie phonemizer, je Lauf eine eigene Bibliothekskopie, Abstürze werden
in einem Unterprozess abgefangen und protokolliert) und die phonemizer-Referenzen
(`ref_phonemizer.py`), und vergleicht (`parity.mjs`). Läufe je Korpus: Korpus de mit
de und en-us, Korpus en mit en-us, en-gb und de, jeweils Tie- und `_`-Modus.

Ergebnis des letzten Laufs (`test/out/run_all.log`):

| Vergleich | Ergebnis |
|---|---|
| `complete` vs. nativ (volle Homebrew-Daten), Korpus | 10 Läufe, 22 200 Text-Aufrufe, 100 % identisch |
| `complete` vs. phonemizer, Korpus | 3 Läufe (de, en-us, en-gb), 6 358 Text-Aufrufe, 100 % identisch |
| `complete` vs. nativ, Fuzz | 10 Läufe, 70 000 Text-Aufrufe, 100 % identisch; 12 native Abstürze (5 verschiedene Texte), alle als `EspeakCrashError` |
| `complete` vs. phonemizer, Fuzz | 3 Läufe, 20 000 Text-Aufrufe, 100 % identisch; 4 Abstürze von Python, alle als `EspeakCrashError` |
| `minimal` vs. nativ mit denselben Daten, Korpus | 10 Läufe, 22 200 Text-Aufrufe, 100 % identisch |
| Instanz-Isolation, Determinismus, C-Join = JS-Join | alle bestanden |
| Debug-Build (`DEBUG_CHECKS=1`: SAFE_HEAP, ASSERTIONS=2, STACK_OVERFLOW_CHECK=2), Korpus + Fuzz | 100 % identisch, keine Abbrüche |

## Build

```sh
./build.sh            # dist/
DEBUG_CHECKS=1 ./build.sh   # dist-debug/ mit Laufzeitprüfungen
```

Braucht macOS mit Homebrew: `emscripten` (getestet 6.0.11), `autoconf`,
`automake`, `libtool`, Python 3, Node ≥ 22. Ablauf: Quellarchiv laden und per
SHA-256 und Tag-Commit prüfen → nativer Build (Datenkompilierung, Vergleich mit
Homebrew) → macOS-ctype-Tabelle neu erzeugen und mit `src/conduit_ctype_tables.h`
vergleichen (`REGEN_CTYPE=1` übernimmt eine neue) → Emscripten-Build → Link →
Datenarchive (deterministisches ustar) → `build-info.mjs`, `SHA256SUMS`. Der
Emscripten-Cache liegt in `build/emcache`.

## Lizenz

GPL-3.0-or-later (eSpeak NG), siehe `COPYING` und `NOTICE`.

## Offene Punkte

* Bit-Identität gilt gegenüber der macOS-Homebrew-Bibliothek. Eine Linux/glibc-
  Bibliothek kann sich bei den schmalen ctype-Funktionen anders verhalten; dafür
  müsste die Tabelle aus glibc erzeugt werden.
* Die macOS-ctype-Tabelle stammt von der libc dieses Rechners (macOS 27); ändert
  Apple sie, meldet build.sh die Abweichung.
* Über die gefundenen 6 Absturz-Eingaben hinaus kann es weitere geben. NULL-Zugriffe
  werden immer abgefangen; andere wilde Lesezugriffe trappen in WebAssembly nur,
  wenn sie außerhalb des Speichers landen.
* `bn_dict`/`ko_dict` im Datensatz `complete` sind aus Homebrew übernommen, weil
  sie sich aus den Quellen nicht reproduzierbar kompilieren lassen.
