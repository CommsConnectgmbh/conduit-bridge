#!/usr/bin/env python3
"""Timing of the native libespeak-ng (ctypes, phonemizer call sequence) and of
Python phonemizer for the same sentences as test/bench.mjs.

usage: PHONEMIZER_ESPEAK_LIBRARY=/opt/homebrew/lib/libespeak-ng.dylib bench_native.py
"""
import os
import statistics
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ref_native import Engine, MODES  # noqa: E402

DE20 = "Am Montag fährt Herr Müller um 14:30 Uhr mit dem ICE von München nach Hamburg, um seine Großmutter zu besuchen."
EN20 = "On Monday Mr. Miller takes the 2:30 p.m. train from Boston to New York to visit his old grandmother again."


def bench(fn, n=5000, warm=200):
    for _ in range(warm):
        fn()
    t = []
    for _ in range(n):
        t0 = time.perf_counter_ns()
        fn()
        t.append((time.perf_counter_ns() - t0) / 1e3)
    t.sort()
    return f"median {t[n // 2]:.1f} µs, p95 {t[int(n * 0.95)]:.1f} µs, mean {statistics.fmean(t):.1f} µs (n={n})"


for text, lang in ((DE20, "de"), (EN20, "en-us")):
    e = Engine(os.environ.get("PHONEMIZER_ESPEAK_LIBRARY", "/opt/homebrew/lib/libespeak-ng.dylib"), None)
    e.set_language(lang)
    print(f"native ctypes {lang:5} TextToPhonemes loop:", bench(lambda: e.clauses(text, MODES["tie"])))
    from phonemizer.backend import EspeakBackend
    import logging
    lg = logging.getLogger("bench")
    lg.addHandler(logging.NullHandler())
    lg.propagate = False
    b = EspeakBackend(lang, preserve_punctuation=True, with_stress=True, tie="^", language_switch="remove-flags", logger=lg)
    print(f"python phonemizer {lang:5} phonemize([text]):", bench(lambda: b.phonemize([text])))
