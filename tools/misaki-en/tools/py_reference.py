"""Reference output of the Python Kokoro English frontend.

    python tools/py_reference.py corpus.json out.json

For each text: chunks [(graphemes, phonemes)] of
KPipeline(lang_code='a', model=False)(text), or the exception raised.
Also records every raw espeak call (input line -> espeak_TextToPhonemes output)
and every fallback call (token text -> phonemes), so that the JS port can be
tested against the identical native espeak-ng 1.52.0 output.
"""
import json
import sys
import time
import warnings

warnings.filterwarnings('ignore')
from kokoro import KPipeline  # noqa: E402

pipe = KPipeline(lang_code='a', repo_id='hexgrad/Kokoro-82M', model=False)
fb = pipe.g2p.fallback
raw_calls = {}
fb_calls = {}

wrapper = fb.backend._espeak
orig_t2p = wrapper.text_to_phonemes


def t2p(text, tie=False):
    out = orig_t2p(text, tie)
    raw_calls[text] = out
    return out


wrapper.text_to_phonemes = t2p
orig_fb_call = type(fb).__call__


def fb_call(self, token):
    r = orig_fb_call(self, token)
    fb_calls[token.text] = r[0]
    return r


type(fb).__call__ = fb_call

texts = json.load(open(sys.argv[1], encoding='utf-8'))
out = []
t0 = time.perf_counter()
for t in texts:
    try:
        chunks = [[gs, ps] for gs, ps, _ in pipe(t)]
        out.append({'chunks': chunks})
    except Exception as e:  # noqa: BLE001
        out.append({'error': f'{type(e).__name__}: {e}'})
dt = time.perf_counter() - t0
json.dump({'results': out, 'raw': raw_calls, 'fallback': fb_calls, 'seconds': dt},
          open(sys.argv[2], 'w', encoding='utf-8'), ensure_ascii=False)
print(f'{len(texts)} texts in {dt:.2f}s, {len(raw_calls)} raw espeak calls, '
      f'{sum("error" in o for o in out)} errors', file=sys.stderr)
