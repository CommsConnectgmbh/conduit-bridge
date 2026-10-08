"""Differential data for misaki Lexicon.__call__: python tools/py_lexicon_ref.py out.json"""
import json, random, sys, warnings
warnings.filterwarnings('ignore')
from misaki import en
from misaki.token import MToken
rnd = random.Random(11)
lex = en.Lexicon(british=False)
keys = list(lex.golds) + list(lex.silvers)
rnd.shuffle(keys)
words = []
for w in keys[:40000]:
    words.append(rnd.choice([w, w.lower(), w.upper(), w.capitalize(), w + 's', w + 'ed', w + 'ing', w + "'s", w + "s'"]))
words += ['$', '%', '&', '+', '@', '.', '/', 'a', 'A', 'am', 'Am', 'AM', 'an', 'AN', 'I', 'by', 'BY', 'to', 'TO', 'in',
          'IN', 'the', 'THE', 'vs', 'vs.', 'VS', 'used', 'USED', 'U.S.', 'e.g.', '5', '5th', '1990s', '3.14', '-5',
          'café', 'naïve', 'O’Neil', 'don’t', 'X', 'Xs', 'XYZ', 'iPhone', 'McDonald']
tags = ['NN', 'NNP', 'NNS', 'VBD', 'VBN', 'VB', 'VBP', 'JJ', 'RB', 'IN', 'DT', 'PRP', 'CD', 'ADD', 'TO', 'UH']
out = []
for w in words:
    t = rnd.choice(tags)
    fv = rnd.choice([None, True, False])
    ft = rnd.choice([False, False, True])
    stress = rnd.choice([None, None, None, -2, -1, -0.5, 0, 0.5, 1, 2])
    cur = rnd.choice([None] * 8 + ['$', '£', '€'])
    head = rnd.choice([True, True, False])
    flags = rnd.choice(['', '', 'a', 'n', '&'])
    tk = MToken(text=w, tag=t, whitespace='', _=MToken.Underscore(is_head=head, num_flags=flags, prespace=False, stress=stress, currency=cur))
    try:
        ps, r = lex(tk, en.TokenContext(future_vowel=fv, future_to=ft))
        res = [ps, r]
    except Exception as e:
        res = 'ERROR ' + type(e).__name__
    out.append([w, t, fv, ft, stress, cur, head, flags, res])
json.dump(out, open(sys.argv[1], 'w'), ensure_ascii=False)
print(len(out), file=sys.stderr)
