# German G2P parity

The bridge's German frontend (`src/speech-de-normalize.mjs`,
`src/speech-g2p-de.mjs`, espeak-ng 1.52.0 as WebAssembly in
`src/speech-espeak*.mjs`) is a port of misaki's `de.DEG2P` (semidark/misaki),
which the Thorsten-Voice Kokoro model was trained with. This directory checks
that both give the same phonemes.

## Inputs

`texts.json.gz`: 16 150 texts.

- 3 000 from `gen_corpus.py`: numbers, dates, times, money, abbreviations,
  quotes, versions, phone numbers, long compounds.
- 3 126 German sentences and 10 000 random texts (mixed scripts, control
  characters, emoji) from the espeak-wasm test suite.
- 24 hand-picked edge cases.

## Running it

```bash
# reference, Python 3.12 venv with misaki de and native espeak-ng 1.52.0
node gen_ref.mjs <venv>/bin/python py_worker.py texts.json.gz ref.json
# the bridge's frontend against it
node compare.mjs <espeak-wasm dist> texts.json.gz ref.json
```

`gen_ref.mjs` survives the native espeak crashes (some random texts make
libespeak-ng 1.52.0 segfault) and records them. The comparison runs the
normaliser in compat mode (see below) and applies the Thorsten-Voice patch
`ʏ → y` to the reference, as the model's own inference does.

## Result (2026-10-08)

| | Texts |
|---|---:|
| identical | 16 143 |
| native espeak crashes, and the WebAssembly build refuses the same input | 4 |
| different | 3 |

The 3 differences are random texts with a digit next to a character that is
unassigned in Unicode 15.0 (Python 3.12) and a letter in Unicode 17.0 (Node
26): U+13800, U+32590, U+1371A. The bridge follows the current standard.

The normaliser alone matches on all 3 000 corpus texts in compat mode
(`py_normalize.py`).

## Deliberate deviations outside compat mode

The bridge's default reading differs from the original where the original is
wrong:

- Large numbers use the German long scale in the singular ("eine Trillion",
  not "Trillionen" for 10^18).
- Phone numbers are read digit by digit, not as years or amounts.
- Dotted version and IP numbers are read with "Punkt".

`test/speech/de-normalize.test.mjs` pins both modes.
