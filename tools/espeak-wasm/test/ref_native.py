#!/usr/bin/env python3
"""Reference outputs from the NATIVE libespeak-ng (Homebrew) via ctypes.

usage: ref_native.py <corpus.json> <out.json> [--lib PATH] [--data DIR]

Uses exactly the call sequence of phonemizer 3.3.x (backend/espeak/api.py,
wrapper.py): a private copy of the shared library per engine instance,
espeak_Initialize(0x02 /*AUDIO_OUTPUT_SYNCHRONOUS*/, 0, data_path, 0),
espeak_ListVoices(NULL) -> first voice per language -> espeak_SetVoiceByName,
then for every text the loop
    while text_ptr.contents.value is not None:
        espeak_TextToPhonemes(text_ptr, 1 /*espeakCHARS_UTF8*/, mode)
Every clause result is recorded verbatim (None for a NULL return).

One engine per (corpus, voice, mode) run; texts are processed in corpus
order, as phonemizer would process them one after another. The engine runs
in a worker process: libespeak-ng 1.52.0 crashes (SIGSEGV) on some inputs.
Such a text is recorded as {"crash": <signal>} and a FRESH engine continues
with the next text (the WASM test replays exactly that).
"""
import argparse
import ctypes
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import time

MODES = {
    "tie": 0x02 | 0x01 << 7 | ord("͡") << 8,  # phonemizer, tie=True (and tie='^')
    "underscore": ord("_") << 8 | 0x02,               # phonemizer, tie=False
}
RUNS = [("de", "de"), ("en", "en-us"), ("en", "en-gb"), ("de", "en-us"), ("en", "de")]


class VoiceStruct(ctypes.Structure):
    _fields_ = [("name", ctypes.c_char_p), ("languages", ctypes.c_char_p), ("identifier", ctypes.c_char_p)]


class Engine:
    def __init__(self, library, data_path):
        self.tmp = tempfile.mkdtemp(prefix="espeak-ref-")
        lib_real = pathlib.Path(library).resolve()
        copy = pathlib.Path(self.tmp) / lib_real.name
        shutil.copy(lib_real, copy, follow_symlinks=False)
        self.lib = ctypes.cdll.LoadLibrary(str(copy))
        dp = data_path.encode() if data_path else None
        if self.lib.espeak_Initialize(0x02, 0, dp, 0) <= 0:
            raise RuntimeError("espeak_Initialize failed")
        self.lib.espeak_ListVoices.argtypes = [ctypes.POINTER(VoiceStruct)]
        self.lib.espeak_ListVoices.restype = ctypes.POINTER(ctypes.POINTER(VoiceStruct))
        self.lib.espeak_SetVoiceByName.argtypes = [ctypes.c_char_p]
        self.lib.espeak_TextToPhonemes.restype = ctypes.c_char_p
        self.lib.espeak_TextToPhonemes.argtypes = [ctypes.POINTER(ctypes.c_char_p), ctypes.c_int, ctypes.c_int]
        self.lib.espeak_Info.restype = ctypes.c_char_p

    def info(self):
        p = ctypes.c_char_p()
        v = self.lib.espeak_Info(ctypes.byref(p))
        return v.decode(), p.value.decode()

    def voices(self):
        out = []
        vs = self.lib.espeak_ListVoices(None)
        i = 0
        while vs[i]:
            v = vs[i].contents
            out.append({"name": os.fsdecode(v.name), "language": os.fsdecode(v.languages)[1:], "identifier": os.fsdecode(v.identifier)})
            i += 1
        return out

    def set_language(self, language):
        available = {}
        for v in self.voices():
            available.setdefault(v["language"], v["identifier"])
        ident = available[language]
        if self.lib.espeak_SetVoiceByName(ident.encode()) != 0:
            raise RuntimeError(f"SetVoiceByName({ident}) failed")
        return ident

    def clauses(self, text, mode):
        text_ptr = ctypes.pointer(ctypes.c_char_p(text.encode("utf8")))
        res = []
        while text_ptr.contents.value is not None:
            ph = self.lib.espeak_TextToPhonemes(text_ptr, 1, mode)
            if ph is None:
                res.append(None)
            else:
                try:
                    res.append(ph.decode("utf-8"))
                except UnicodeDecodeError:
                    res.append({"invalid_utf8_hex": ph.hex()})
        return res

    def close(self):
        self.lib.espeak_Terminate()
        shutil.rmtree(self.tmp, ignore_errors=True)


def worker(a):
    """--worker: process texts[start:] and print one JSON line per text."""
    corpus = json.load(open(a.corpus, encoding="utf-8"))
    texts = corpus[a.corpus_lang]
    eng = Engine(a.lib, a.data)
    ident = eng.set_language(a.language)
    print(json.dumps({"identifier": ident, "info": eng.info()}), flush=True)
    for item in texts[a.start:]:
        print(json.dumps(eng.clauses(item["text"], MODES[a.mode]), ensure_ascii=True), flush=True)  # ASCII: no raw U+2028/U+0085 line breaks
    eng.close()


def run_sequence(a, corpus_lang, language, mode, n):
    results, restarts, start, meta = [], [], 0, None
    while start < n:
        cmd = [sys.executable, "-I", os.path.abspath(__file__), a.corpus, "-", "--worker", "--lib", a.lib,
               "--corpus-lang", corpus_lang, "--language", language, "--mode", mode, "--start", str(start)]
        if a.data:
            cmd += ["--data", a.data]
        p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        lines = [x for x in p.stdout.read().split(b"\n") if x]
        rc = p.wait()
        meta = json.loads(lines[0])
        done = [json.loads(x) for x in lines[1:]]
        results += done
        start += len(done)
        if rc == 0:
            assert start == n, (start, n)
            break
        # the worker died while processing texts[start]
        results.append({"crash": -rc if rc < 0 else rc})
        restarts.append(start)
        start += 1
    return results, restarts, meta


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("corpus")
    ap.add_argument("out")
    ap.add_argument("--lib", default="/opt/homebrew/lib/libespeak-ng.dylib")
    ap.add_argument("--data", default=None, help="espeak-ng-data directory (default: library default, like phonemizer)")
    ap.add_argument("--worker", action="store_true")
    ap.add_argument("--corpus-lang")
    ap.add_argument("--language")
    ap.add_argument("--mode")
    ap.add_argument("--start", type=int, default=0)
    a = ap.parse_args()
    if a.worker:
        return worker(a)
    corpus = json.load(open(a.corpus, encoding="utf-8"))
    out = {"meta": {"lib": str(pathlib.Path(a.lib).resolve()), "data_arg": a.data, "python": sys.version}, "runs": {}}
    for corpus_lang, language in RUNS:
        for mode_name in MODES:
            t0 = time.perf_counter()
            results, restarts, meta = run_sequence(a, corpus_lang, language, mode_name, len(corpus[corpus_lang]))
            dt = time.perf_counter() - t0
            out["meta"]["espeak_info"] = meta["info"]
            key = f"{corpus_lang}|{language}|{mode_name}"
            out["runs"][key] = {"identifier": meta["identifier"], "seconds": dt, "crashes": restarts, "results": results}
            print(f"{key}: {len(results)} texts, voice {meta['identifier']}, {len(restarts)} native crashes, {dt:.2f}s", flush=True)
    json.dump(out, open(a.out, "w", encoding="utf-8"), ensure_ascii=False)


if __name__ == "__main__":
    main()
