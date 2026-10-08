#!/usr/bin/env python3
"""Random (seeded) fuzz corpus in the same format as gen_corpus.py.

usage: gen_fuzz.py <out.json> [n_de] [n_en] [seed]

Mixes real words, digits and punctuation with random code points from many
Unicode blocks (Latin-1, combining marks, symbols, other scripts, CJK,
emoji/astral planes, C0/C1 controls, all Unicode white space) and random
lengths, to look for inputs where the WASM build and native libespeak-ng
diverge. Lone surrogates are excluded (not encodable as UTF-8, rejected by
both Python and the JS wrapper).
"""
import json
import random
import sys

sys.path.insert(0, __import__("os").path.dirname(__file__))
import gen_corpus as gc  # noqa: E402

WORDS = (gc.DE_UMLAUT_WORDS + gc.DE_LOAN + gc.DE_COMPOUNDS + gc.DE_ABBR + gc.DE_MONTHS + gc.EN_ABBR + gc.EN_LOAN
         + gc.URLS + gc.FOREIGN_SCRIPTS + gc.EMOJIS + gc.SYMBOLS
         + [w for s in gc.DE_REAL + gc.EN_REAL for w in s.split()])
BLOCKS = [  # (weight, lo, hi)
    (30, 0x20, 0x7e), (8, 0xa0, 0xff), (6, 0x100, 0x24f), (3, 0x250, 0x2ff), (4, 0x300, 0x36f),
    (3, 0x370, 0x3ff), (3, 0x400, 0x4ff), (1, 0x530, 0x58f), (1, 0x590, 0x5ff), (1, 0x600, 0x6ff),
    (1, 0x900, 0x97f), (1, 0x980, 0xdff), (1, 0xe00, 0xeff), (1, 0x10a0, 0x10ff), (1, 0x1100, 0x11ff),
    (2, 0x1e00, 0x1eff), (4, 0x2000, 0x206f), (3, 0x2070, 0x22ff), (2, 0x2300, 0x2bff), (1, 0x2800, 0x28ff),
    (2, 0x3000, 0x30ff), (2, 0x4e00, 0x9fff), (1, 0xac00, 0xd7a3), (1, 0xe000, 0xf8ff), (1, 0xfb00, 0xfb4f),
    (1, 0xfe00, 0xfe0f), (1, 0xff00, 0xffef), (1, 0xfff0, 0xffff), (3, 0x1f300, 0x1faff), (1, 0x10000, 0x10ffff),
    (3, 0x00, 0x1f), (1, 0x7f, 0x9f),
]
WS = ["\t", "\n", "\x0b", "\x0c", "\r", "\x1c", "\x1d", "\x1e", "\x1f", " ", "\x85", "\xa0", " ", " ",
      " ", " ", " ", " ", " ", " ", "　", "﻿", "​"]
PUNCT = list(';:,.!?¡¿—…"«»“”(){}[]-–\'’‚„/\\*&%$#@+=<>|^~`_')


def rand_cp(r):
    tot = sum(w for w, _, _ in BLOCKS)
    x = r.randrange(tot)
    for w, lo, hi in BLOCKS:
        if x < w:
            while True:
                c = r.randint(lo, hi)
                if not 0xd800 <= c <= 0xdfff:
                    return chr(c)
        x -= w


def token(r):
    k = r.randrange(10)
    if k < 4:
        return r.choice(WORDS)
    if k < 5:
        return str(r.randrange(10 ** r.randrange(1, 13)))
    if k < 6:
        return r.choice(PUNCT) * r.randint(1, 3)
    if k < 7:
        return r.choice(WS)
    return "".join(rand_cp(r) for _ in range(r.randint(1, 8)))


def text(r):
    n = r.choice([0, 1, 2, 3, 5, 8, 13, 21, 34, 60, 120])
    seps = [" ", " ", " ", "", ", ", ". ", "\n", "-", "/"]
    return "".join(token(r) + r.choice(seps) for _ in range(n))


def main():
    out = sys.argv[1]
    n_de = int(sys.argv[2]) if len(sys.argv) > 2 else 10000
    n_en = int(sys.argv[3]) if len(sys.argv) > 3 else 5000
    seed = int(sys.argv[4]) if len(sys.argv) > 4 else 777
    r = random.Random(seed)
    corpus = {"de": [{"id": f"fz-de-{i:05d}", "cat": "fuzz", "text": text(r)} for i in range(n_de)],
              "en": [{"id": f"fz-en-{i:05d}", "cat": "fuzz", "text": text(r)} for i in range(n_en)]}
    json.dump(corpus, open(out, "w", encoding="utf-8"), ensure_ascii=False)
    print({k: len(v) for k, v in corpus.items()}, "chars:", sum(len(x["text"]) for v in corpus.values() for x in v))


if __name__ == "__main__":
    main()
