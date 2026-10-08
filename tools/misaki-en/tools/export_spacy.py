"""Export everything the JS port needs from spaCy en_core_web_sm 3.8.0.

Writes into ../data/spacy/:
  tokenizer.json  - prefix/suffix/infix/url regexes translated to JS syntax,
                    special-case rules, norm tables
  tagger.bin      - float32 little-endian weights (tok2vec + tagger)
  tagger.json     - layout of tagger.bin + labels + hash seeds
  pyunicode.json  - Python (3.12, Unicode 15) character property ranges

Run with the venv python:  python -I tools/export_spacy.py
"""
import json
import os
import re
import sys
import unicodedata

import numpy as np
import spacy
import spacy.symbols
from spacy.lang.norm_exceptions import BASE_NORMS

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', 'data', 'spacy')
os.makedirs(OUT, exist_ok=True)

nlp = spacy.load('en_core_web_sm', enable=['tok2vec', 'tagger'])
assert nlp.pipe_names == ['tok2vec', 'tagger'], nlp.pipe_names
assert nlp.meta['version'] == '3.8.0', nlp.meta['version']


# ---------------------------------------------------------------- unicode --
def ranges(pred):
    out = []
    start = None
    for cp in range(0x110000):
        ch = chr(cp)
        ok = pred(ch)
        if ok and start is None:
            start = cp
        elif not ok and start is not None:
            out.append([start, cp - 1])
            start = None
    if start is not None:
        out.append([start, 0x10FFFF])
    return out


def is_surrogate(ch):
    return 0xD800 <= ord(ch) <= 0xDFFF


RE_W = re.compile(r'\w')
RE_D = re.compile(r'\d')
RE_S = re.compile(r'\s')

pyuni = {
    'unidata_version': unicodedata.unidata_version,
    'python': sys.version.split()[0],
    'isspace': ranges(str.isspace),
    'isalpha': ranges(str.isalpha),
    'isdigit': ranges(str.isdigit),
    'isdecimal': ranges(str.isdecimal),
    'isupper': ranges(lambda c: c.isupper()),
    'islower': ranges(lambda c: c.islower()),
    're_w': ranges(lambda c: RE_W.match(c) is not None),
    're_d': ranges(lambda c: RE_D.match(c) is not None),
    're_s': ranges(lambda c: RE_S.match(c) is not None),
}
# Characters for which str.isdigit() holds; misaki maps them through
# unicodedata.numeric -> str(int(n)).
digit_values = {}
for cp in range(0x110000):
    ch = chr(cp)
    if ch.isdigit():
        n = unicodedata.numeric(ch)
        digit_values[cp] = str(int(n)) if n == int(n) else None
pyuni['digit_values'] = digit_values
# Python full case mappings (only entries that differ from identity).
for name, fn in (('lower', str.lower), ('upper', str.upper), ('title', str.title)):
    m = {}
    for cp in range(0x110000):
        ch = chr(cp)
        if is_surrogate(ch):
            continue
        r = fn(ch)
        if r != ch:
            m[cp] = r
    pyuni[name + '_map'] = m


# ------------------------------------------------------------ regex conv --
def cls_body(rs):
    parts = []
    for a, b in rs:
        if a == b:
            parts.append('\\u{%x}' % a)
        else:
            parts.append('\\u{%x}-\\u{%x}' % (a, b))
    return ''.join(parts)


CLASS_BODIES = {
    'w': cls_body(pyuni['re_w']),
    'd': cls_body(pyuni['re_d']),
    's': cls_body(pyuni['re_s']),
}
JS_SYNTAX = set('^$\\.*+?()[]{}|/')


def py2js(pat):
    """Translate a Python `re` pattern (as used by spaCy) into a JS `u` regex.

    Semantics kept: Python's Unicode \\w \\d \\s, `.` (any char but \\n),
    `$` (end or before a final \\n). Raises on anything unexpected.
    """
    out = []
    i = 0
    in_class = False
    class_start = False
    n = len(pat)
    while i < n:
        c = pat[i]
        if c == '\\':
            e = pat[i + 1]
            if e == 'U':
                out.append('\\u{%x}' % int(pat[i + 2:i + 10], 16))
                i += 10
            elif e == 'u':
                out.append('\\u{%x}' % int(pat[i + 2:i + 6], 16))
                i += 6
            elif e == 'x':
                out.append('\\u{%x}' % int(pat[i + 2:i + 4], 16))
                i += 4
            elif e in 'wds':
                body = CLASS_BODIES[e]
                out.append(body if in_class else '[' + body + ']')
                i += 2
            elif e in 'WDS':
                body = CLASS_BODIES[e.lower()]
                if in_class:
                    raise ValueError('negated class escape inside class')
                out.append('[^' + body + ']')
                i += 2
            elif e == 'n':
                out.append('\\n'); i += 2
            elif e == 't':
                out.append('\\t'); i += 2
            elif e.isalnum():
                raise ValueError('unsupported escape \\' + e + ' at %d' % i)
            else:
                if e in JS_SYNTAX or (in_class and e == '-'):
                    out.append('\\' + e)
                else:
                    out.append('\\u{%x}' % ord(e))
                i += 2
            class_start = False
            continue
        if in_class:
            if c == ']' and not class_start:
                in_class = False
                out.append(']')
            elif c == '^' and class_start:
                out.append('^')
                i += 1
                continue  # still at class start for a following ']'
            elif c in '[\\':
                out.append('\\' + c)
            elif c == '-':
                out.append('-')
            elif c == ']':
                out.append('\\]')
            elif ord(c) > 0x7e or c in JS_SYNTAX:
                out.append('\\u{%x}' % ord(c))
            else:
                out.append(c)
            class_start = False
            i += 1
            continue
        if c == '[':
            in_class = True
            class_start = True
            out.append('[')
            i += 1
            continue
        if pat.startswith('(?u)', i):
            i += 4
            continue
        if c == '(' and pat.startswith('(?', i) and not re.match(r'\(\?(?::|=|!|<=|<!)', pat[i:]):
            raise ValueError('unsupported group ' + pat[i:i + 6])
        if c == '$':
            out.append('(?=\\n?$)')
        elif c == '.':
            out.append('[^\\n]')
        elif c == '{':
            m = re.match(r'\{(\d*)(,?)(\d*)\}', pat[i:])
            if m and (m.group(1) or m.group(3)):
                out.append(m.group(0))
                i += len(m.group(0))
                continue
            out.append('\\{')
        elif c == '}':
            out.append('\\}')
        elif ord(c) > 0x7e:
            out.append('\\u{%x}' % ord(c))
        else:
            out.append(c)
        i += 1
    assert not in_class
    return ''.join(out)


tok = nlp.tokenizer
patterns = {}
for name in ['prefix_search', 'suffix_search', 'infix_finditer', 'url_match']:
    f = getattr(tok, name)
    p = f.__self__
    assert p.flags == re.UNICODE, (name, p.flags)
    patterns[name] = py2js(p.pattern)
assert tok.token_match is None
assert tok.faster_heuristics is True

ORTH, NORM = spacy.attrs.ORTH, spacy.attrs.NORM
rules = {}
for chunk, subs in tok.rules.items():
    toks = []
    for d in subs:
        assert set(d) <= {ORTH, NORM}, d
        t = [d[ORTH]]
        if NORM in d:
            t.append(d[NORM])
        toks.append(t)
    rules[chunk] = toks

lexeme_norm = nlp.vocab.lookups.get_table('lexeme_norm')
tokenizer_json = {
    'source': 'spaCy %s en_core_web_sm %s' % (spacy.__version__, nlp.meta['version']),
    'patterns': patterns,
    'rules': rules,
    # lexeme_norm table is keyed by spaCy string ids (hash or symbol id, decimal strings)
    'lexeme_norm': {str(k): v for k, v in lexeme_norm.items()},
    'base_norms': dict(BASE_NORMS),
    # StringStore maps these strings to fixed symbol IDs instead of hashes
    'symbols': dict(spacy.symbols.IDS),
    'max_cache_size': 10000,
}
with open(os.path.join(OUT, 'tokenizer.json'), 'w', encoding='utf-8') as f:
    json.dump(tokenizer_json, f, ensure_ascii=False, separators=(',', ':'))

with open(os.path.join(OUT, 'pyunicode.json'), 'w', encoding='utf-8') as f:
    json.dump(pyuni, f, separators=(',', ':'))

# ---------------------------------------------------------------- weights --
t2v = nlp.get_pipe('tok2vec').model
tagger = nlp.get_pipe('tagger').model

hashembeds = [n for n in t2v.walk() if n.name == 'hashembed']
maxouts = [n for n in t2v.walk() if n.name == 'maxout']
lnorms = [n for n in t2v.walk() if n.name == 'layernorm']
softmax = [n for n in tagger.walk() if n.name == 'softmax']
assert len(hashembeds) == 6 and len(maxouts) == 5 and len(lnorms) == 5 and len(softmax) == 1

extract = [n for n in t2v.walk() if n.name == 'extract_features'][0]
attr_names = [spacy.attrs.NAMES[a] if isinstance(a, int) else a for a in extract.attrs['columns']]

blobs = []
layout = []
offset = 0


def add(name, arr):
    global offset
    a = np.ascontiguousarray(arr, dtype='<f4')
    layout.append({'name': name, 'shape': list(a.shape), 'offset': offset})
    blobs.append(a.tobytes())
    offset += a.nbytes


for i, he in enumerate(hashembeds):
    add('embed%d.E' % i, he.get_param('E'))
for i, (mo, ln) in enumerate(zip(maxouts, lnorms)):
    add('maxout%d.W' % i, mo.get_param('W'))
    add('maxout%d.b' % i, mo.get_param('b'))
    add('ln%d.G' % i, ln.get_param('G'))
    add('ln%d.b' % i, ln.get_param('b'))
add('softmax.W', softmax[0].get_param('W'))
add('softmax.b', softmax[0].get_param('b'))

with open(os.path.join(OUT, 'tagger.bin'), 'wb') as f:
    for b in blobs:
        f.write(b)

meta = {
    'source': 'spaCy en_core_web_sm %s (MIT), tok2vec + tagger' % nlp.meta['version'],
    'attrs': attr_names,
    'seeds': [he.attrs['seed'] for he in hashembeds],
    'rows': [he.get_param('E').shape[0] for he in hashembeds],
    'width': 96,
    'pieces': 3,
    'depth': 4,
    'window': 1,
    'labels': list(nlp.get_pipe('tagger').labels),
    'layout': layout,
    'bytes': offset,
}
with open(os.path.join(OUT, 'tagger.json'), 'w') as f:
    json.dump(meta, f, indent=1)

print('ok', meta['attrs'], meta['seeds'], meta['bytes'])
