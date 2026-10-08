#!/usr/bin/env python3
"""Compute the set of dictionaries libespeak-ng 1.52.0 can load while translating
text with the given start languages.

usage: dict_closure.py <espeak-ng source dir> <lang> [<lang> ...]

Edges (all from the 1.52.0 sources):
  * "_^_XX" entries in <lang>_list/_rules/_extra/_emoji (translate.c: SetTranslator2)
  * alphabets[] in tr_languages.c: words/letters of another script switch to that
    alphabet's language (dictionary.c TranslateRules, translateword.c TranslateLetter)
  * langopts.alt_alphabet_lang set in tr_languages.c (e.g. ka -> ru)
  * ESPEAKNG_DEFAULT_VOICE ("en") via SetTranslator3 (numbers.c, translateword.c)
Prints one language per line (sorted).
"""
import re
import sys
from pathlib import Path

src = Path(sys.argv[1])
start = sys.argv[2:]
dictsrc = src / "dictsource"
tr = (src / "src/libespeak-ng/tr_languages.c").read_text(encoding="utf-8", errors="replace")

def L(m):
    return "".join(re.findall(r"'(.)'", m))

alphabet_langs = set()
block = tr[tr.index("static const ALPHABET alphabets[]"):]
block = block[:block.index("};")]
for m in re.finditer(r"L\(([^)]*)\)", block):
    alphabet_langs.add(L(m.group(1)))

alt = {}
for m in re.finditer(r"case (L\([^)]*\)(?:\s*:\s*case\s*L\([^)]*\))*)\s*:(.*?)(?=\n\tcase L|\n\tdefault)", tr, re.S):
    langs = [L(x) for x in re.findall(r"L\(([^)]*)\)", m.group(1))]
    for a in re.finditer(r"alt_alphabet_lang\s*=\s*L\(([^)]*)\)", m.group(2)):
        for lg in langs:
            alt.setdefault(lg, set()).add(L(a.group(1)))

def switches(lang):
    out = set()
    for f in dictsrc.glob(f"{lang}_*"):
        for line in f.read_text(encoding="utf-8", errors="replace").splitlines():
            line = line.split("//")[0]
            for m in re.finditer(r"_\^_([A-Za-z]+)", line):
                out.add(m.group(1).lower())
    return out

todo, seen = list(start), set()
while todo:
    lg = todo.pop()
    if lg in seen:
        continue
    seen.add(lg)
    nxt = switches(lg) | alphabet_langs | alt.get(lg, set()) | {"en"}
    for n in sorted(nxt - seen):
        print(f"# {lg} -> {n}", file=sys.stderr)
        todo.append(n)
print("\n".join(sorted(seen)))
