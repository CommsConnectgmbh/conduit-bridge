# Third-party notices

The Conduit bridge is MIT-licensed (LICENSE). Some files are translations of,
or are generated from, other projects and carry their own licence, marked by an
`SPDX-License-Identifier` line at the top of the file. Where GPL-licensed files
are distributed together with the bridge, the combined package is distributed
under the terms of the GNU GPL, version 3 or later; the MIT licence of the
other files is unaffected. Licence texts are in `licenses/`.

## Files in `src/`

| Files | Derived from | Licence |
|---|---|---|
| `speech-de-normalize.mjs`, `speech-g2p-de.mjs`, `speech-de-overrides.json` | misaki, German frontend (semidark/misaki fork of hexgrad/misaki): `de.py`, `espeak.py`, `data/de_overrides.json` | Apache-2.0 (`licenses/misaki-Apache-2.0.txt`) |
| `speech-en.mjs`, `speech-en-misaki.mjs`, `speech-en-pyunicode.mjs` | misaki 0.9.4 (hexgrad/misaki), `en.py` | Apache-2.0 (`licenses/misaki-Apache-2.0.txt`) |
| `speech-en-pipeline.mjs` | kokoro 0.9.4 (hexgrad/kokoro), `KPipeline` | Apache-2.0 (`licenses/kokoro-Apache-2.0.txt`) |
| `speech-en-tokenizer.mjs` | spaCy 3.8.16 (explosion/spaCy), tokenizer | MIT (`licenses/spaCy-MIT.txt`) |
| `speech-en-tagger.mjs`, `speech-en-murmur.mjs`, `speech-en-kernels.mjs` | thinc 8.3.13 (explosion/thinc), layers and hashing | MIT (`licenses/thinc-MIT.txt`) |
| `speech-en-num2words.mjs` | num2words 0.5.14, © 2003 Taro Ogawa, © 2013 Savoir-faire Linux inc. | LGPL-2.1-or-later (`licenses/num2words-LGPL-2.1.txt`) |
| `speech-en-espeak-fallback.mjs`, `speech-espeak-compat.mjs` | phonemizer 3.3.2, © Mathieu Bernard | GPL-3.0-or-later (`licenses/phonemizer-GPL-3.0.txt`) |
| `speech-espeak.mjs`, `speech-espeak-glue.mjs`, `speech-espeak-build.mjs` | eSpeak NG 1.52.0 (espeak-ng/espeak-ng, tag 1.52.0, commit 4870adfa25b1a32b4361592f1be8a40337c58d6c), built to WebAssembly with Emscripten; sources unmodified | GPL-3.0-or-later (`licenses/espeak-ng-GPL-3.0.txt`) |

The build of the eSpeak NG WebAssembly module and its data archive, and the
export of the English pronunciation data, are reproducible from the scripts in
`tools/` of the public repository.

## npm packages

| Package | Use | Licence |
|---|---|---|
| ws 8.18.0 | WebSocket server | MIT |
| qrcode 1.5.4 | pairing QR code | MIT |
| sherpa-onnx-node 1.13.8 (k2-fsa/sherpa-onnx), installed on demand | speech recognition runtime | Apache-2.0; its native library statically links eSpeak NG (GPL-3.0-or-later) |
| onnxruntime-node 1.30.0 (Microsoft), installed on demand | voice runtime | MIT |

## Speech models (downloaded on demand, pinned by SHA-256 in `src/speech-models.mjs`)

| Model | Source | Licence |
|---|---|---|
| Parakeet TDT 0.6B v3 | NVIDIA, nvidia/parakeet-tdt-0.6b-v3; int8 ONNX conversion by k2-fsa/sherpa-onnx | CC-BY-4.0 (https://creativecommons.org/licenses/by/4.0/) |
| Thorsten (German voice) | Thorsten-Voice/Kokoro by Thorsten Müller, trained on the Thorsten-Voice dataset (CC0); exported to ONNX for Conduit | Apache-2.0 |
| Kokoro v1.0 (American English voices) | hexgrad/Kokoro-82M; ONNX export by thewh1teagle/kokoro-onnx (MIT) via k2-fsa/sherpa-onnx; voice subset af_heart, af_bella, af_nicole, af_sarah, am_michael, am_fenrir, am_puck | Apache-2.0 |
| English pronunciation data | misaki 0.9.4 lexicons (Apache-2.0); spaCy en_core_web_sm 3.8.0 tokenizer rules and tagger weights (MIT; training data sources in `licenses/en_core_web_sm-LICENSES_SOURCES.md`) | Apache-2.0, MIT |
| eSpeak NG 1.52.0 WebAssembly and data | see above | GPL-3.0-or-later |
