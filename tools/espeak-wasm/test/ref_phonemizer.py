#!/usr/bin/env python3
"""Reference outputs of the Python library `phonemizer` (EspeakBackend).

usage: PHONEMIZER_ESPEAK_LIBRARY=/opt/homebrew/lib/libespeak-ng.dylib \
       ref_phonemizer.py <corpus.json> <out.json>

For each (corpus, language) one backend
    EspeakBackend(language, preserve_punctuation=True, with_stress=True,
                  tie='^', language_switch='remove-flags')
is created and every text is phonemized on its own, in corpus order:
    backend.phonemize([text])      -> list of str
The backend runs in a worker process because libespeak-ng 1.52.0 crashes
(SIGSEGV) on some inputs, which kills the Python process. Such a text is
recorded as {"crash": <signal>} and a fresh backend continues with the next
text (the WASM test replays exactly that).
"""
import json
import logging
import os
import subprocess
import sys
import time

RUNS = [("de", "de"), ("en", "en-us"), ("en", "en-gb")]


def worker(corpus_path, corpus_lang, language, start):
    import phonemizer
    from phonemizer.backend import EspeakBackend
    logger = logging.getLogger("ref")
    logger.addHandler(logging.NullHandler())
    logger.propagate = False
    corpus = json.load(open(corpus_path, encoding="utf-8"))
    backend = EspeakBackend(language, preserve_punctuation=True, with_stress=True, tie="^",
                            language_switch="remove-flags", logger=logger)
    print(json.dumps({"identifier": backend._espeak.voice.identifier, "phonemizer": phonemizer.__version__,
                      "library": str(backend._espeak.library_path),
                      "espeak_version": ".".join(map(str, backend.version()))}), flush=True)
    for item in corpus[corpus_lang][start:]:
        try:
            r = backend.phonemize([item["text"]])
        except Exception as e:  # recorded, compared like a value
            r = {"error": f"{type(e).__name__}: {e}"}
        print(json.dumps(r, ensure_ascii=True), flush=True)  # ASCII: no raw U+2028/U+0085 line breaks


def main():
    if sys.argv[1] == "--worker":
        return worker(sys.argv[2], sys.argv[3], sys.argv[4], int(sys.argv[5]))
    corpus = json.load(open(sys.argv[1], encoding="utf-8"))
    out = {"meta": {"python": sys.version}, "runs": {}}
    for corpus_lang, language in RUNS:
        n = len(corpus[corpus_lang])
        results, restarts, start, meta = [], [], 0, None
        if n == 0:
            continue
        t0 = time.perf_counter()
        while start < n:
            p = subprocess.Popen([sys.executable, "-I", os.path.abspath(__file__), "--worker", sys.argv[1], corpus_lang, language, str(start)],
                                 stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            lines = [x for x in p.stdout.read().split(b"\n") if x]
            rc = p.wait()
            if not lines:
                raise RuntimeError(f"phonemizer worker failed to start (rc={rc}); is PHONEMIZER_ESPEAK_LIBRARY set?")
            meta = json.loads(lines[0])
            done = [json.loads(x) for x in lines[1:]]
            results += done
            start += len(done)
            if rc == 0:
                break
            results.append({"crash": -rc if rc < 0 else rc})
            restarts.append(start)
            start += 1
        dt = time.perf_counter() - t0
        out["meta"].update({k: meta[k] for k in ("phonemizer", "library", "espeak_version")})
        key = f"{corpus_lang}|{language}"
        out["runs"][key] = {"identifier": meta["identifier"], "seconds": dt, "crashes": restarts, "results": results}
        print(f"{key}: {len(results)} texts, voice {meta['identifier']}, {len(restarts)} crashes, {dt:.2f}s", flush=True)
    json.dump(out, open(sys.argv[2], "w", encoding="utf-8"), ensure_ascii=False)


if __name__ == "__main__":
    main()
