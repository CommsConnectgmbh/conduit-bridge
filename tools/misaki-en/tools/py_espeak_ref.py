"""Differential data for EspeakFallback: python tools/py_espeak_ref.py out.json"""
import json, random, sys, warnings
warnings.filterwarnings('ignore')
from misaki.espeak import EspeakFallback
from misaki.token import MToken
rnd = random.Random(3)
fb = EspeakFallback(british=False)
w = fb.backend._espeak
raw = {}
orig = w.text_to_phonemes
def t2p(text, tie=False):
    r = orig(text, tie); raw[text] = r; return r
w.text_to_phonemes = t2p
syll = ['ka', 'zor', 'blim', 'ptho', 'xy', 'quix', 'sch', 'tsu', 'ngu', 'aar', 'eau', 'ough', 'rr', 'ł', 'ñ', 'é', 'ø', 'ü']
punct = list(';:,.!?¡¿—…"«»“”(){}[]') + ['-', "'", '/', '_', '*', '#', '@', '&', ' ', '  ', '\t', '😀', '™', '°']
words = []
for i in range(5000):
    s = ''.join(rnd.choice(syll) for _ in range(rnd.randint(1, 4)))
    r = rnd.random()
    if r < 0.3:
        s = rnd.choice(punct) + s
    if r > 0.5:
        s = s + rnd.choice(punct) + (''.join(rnd.choice(syll) for _ in range(rnd.randint(0, 3))))
    if r > 0.8:
        s = rnd.choice(punct) + s + rnd.choice(punct)
    words.append(rnd.choice([s, s.upper(), s.capitalize()]))
words += ['', ' ', '...', '!', '(', '()', '"x"', 'x.', '.x', 'a, b', 'a ,b', '“a”', '«a»', '¿qué?', '¡hola!', 'x—y', 'x…y',
          'Ⅻ', '½', '①', '日本', 'Ωmega', 'naïve', 'œuvre', 'Æsir', 'Þór', 'ðe', 'ŋ', 'ʃ', 'Ψ']
out = []
for s in words:
    tk = MToken(text=s, tag='NN', whitespace='')
    try:
        out.append([s, fb(tk)[0]])
    except Exception as e:
        out.append([s, 'ERROR ' + type(e).__name__])
json.dump({'cases': out, 'raw': raw}, open(sys.argv[1], 'w'), ensure_ascii=False)
print(len(out), len(raw), file=sys.stderr)
