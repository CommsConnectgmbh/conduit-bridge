"""Large natural-text set for tagger/tokenizer agreement (test only, not shipped):
paragraphs from METADATA long descriptions (README markdown) of all packages in
the venv + all stdlib docstring sentences.
    python tools/gen_natural.py out.json
"""
import json, re, sys, glob, importlib, pkgutil, random
rnd = random.Random(7)
import site as _site
site = _site.getsitepackages()[0]  # package metadata of the venv this runs in
paras = []
for f in glob.glob(site + '/*.dist-info/METADATA'):
    txt = open(f, encoding='utf-8', errors='replace').read()
    body = txt.split('\n\n', 1)[1] if '\n\n' in txt else ''
    for p in re.split(r'\n\s*\n', body):
        p = p.strip()
        if 20 <= len(p) <= 1500 and re.search(r'[a-z]{4}', p):
            paras.append(p)
docs = []
import sys as _s
for name in sorted(_s.stdlib_module_names):
    if name.startswith('_') or name in ('antigravity', 'this', 'idlelib', 'turtledemo', 'tkinter'):
        continue
    try:
        m = importlib.import_module(name)
    except Exception:
        continue
    for o in [m] + [getattr(m, a, None) for a in dir(m) if not a.startswith('_')]:
        d = getattr(o, '__doc__', None)
        if isinstance(d, str):
            docs.append(d)
sents = set()
for d in docs:
    for s in re.split(r'(?<=[.!?])\s+(?=[A-Z])|\n\s*\n', d):
        s = re.sub(r'[ \t]+', ' ', s.strip())
        if 15 <= len(s) <= 600 and re.search(r'[a-z]{3}', s):
            sents.add(s)
allt = sorted(set(paras)) + sorted(sents)
rnd.shuffle(allt)
json.dump(allt, open(sys.argv[1], 'w', encoding='utf-8'), ensure_ascii=False)
print(len(paras), 'paragraphs', len(sents), 'sentences', file=sys.stderr)
