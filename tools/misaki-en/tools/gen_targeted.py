"""Targeted corpus for rarely hit code paths (deterministic).
    python tools/gen_targeted.py out.json
"""
import json, random, sys
rnd = random.Random(99)
import os
M = os.environ['MISAKI_DATA'].rstrip('/') + '/'  # directory with us_gold.json and us_silver.json
gold = json.load(open(M + 'us_gold.json')); silver = json.load(open(M + 'us_silver.json'))
known = set(gold) | set(silver)
lower = [w for w in gold if w.isalpha() and w.islower() and len(w) > 2]
out = []
# derived forms that are NOT in the lexicon -> stem_s / stem_ed / stem_ing
cands = []
for w in lower:
    forms = [w + 's', w + 'es', w + 'ed', w + 'd', w + 'ing', w[:-1] + 'ing', w + w[-1] + 'ing', w + w[-1] + 'ed',
             w[:-1] + 'ies' if w.endswith('y') else None, w + "'s", w + "s'"]
    for f in forms:
        if f and f not in known:
            cands.append(f)
rnd.shuffle(cands)
for f in cands[:1500]:
    out.append(rnd.choice(['They {} it.', 'The {} are here.', '{}', 'I was {} yesterday.', 'It {}.', 'THE {} WAS'])
               .format(rnd.choice([f, f.capitalize(), f.upper()])))
# possessive plurals whose singular possessive is in the lexicon
for w in [k for k in gold if k.endswith("'s")][:200]:
    out.append(f"The {w[:-2]}s' things and {w}.")
# dotted abbreviations incl. non-ASCII letters
for a in ['É.U.', 'A.É.', 'ü.a.', 'Ü.A.', 'z.B.', 'U.S.A.', 'a.k.a.', 'R.I.P.', 'P.S.', 'N.Y.C.', 'Ph.D.', 'B.Sc.',
          'ñ.b.', 'Ø.K.', 'i.e', 'e.g', '.e.g.', 'a..b', 'A.B.C.D.E.F.', 'abc.de', 'ab.cde', 'x.y.z.w']:
    out.append(f'See {a} for this.')
# currency edge cases
for c in ['$.50', '$0.5', '$1.5.5', '$5,00', '$1,000.001', '£.99', '€0.01', '$01', '$00.00', '$1.00.', '$-1',
          '$1 $2 $3', '$5 and £6', '$1,5', '€ 5', '5 €', '$1.', '£1.0', '$1.999', '$12,345,678.90', '€-3.50']:
    out.append(f'Pay {c} now.')
    out.append(f'{c}')
# 'am' / 'in' / 'to' / 'by' / 'the' / 'used' with stress features and tags
for w in ['am', 'Am', 'AM', 'in', 'IN', 'to', 'TO', 'by', 'BY', 'the', 'THE', 'used', 'USED', 'an', 'AN', 'a', 'A', 'I', 'vs', 'VS.']:
    for f in ['+1', '+2', '-1', '-2', '0', '0.5', '-0.5', '/ˈæm/', '#n#']:
        out.append(f'So [{w}]({f}) it goes, used to it.')
    out.append(f'{w} {w} {w} apple {w} banana {w} to {w}.')
# alignment edge cases for link features
for t in ['[İstanbul](/x/) test', 'İ [a](/b/)', '[a](/b/)   ', '[a](/b/) c  d   e', 'x  [two  words](/tˈu/)  y',
          '[a](-1)[b](+1)[c](0)', '  [lead](/lˈɛd/) pipes', '[U.S.](#a#) army', '[1,000](#n#) men', '[100](#&#) years',
          '[one hundred and five](#n#)', '[a b c](/x/)', '[don\'t](/dˈOnt/) go', '[x](/ /)', '[!](/!/)', '[...](/./)',
          '[ ](/x/)', '[$5](/fˈIv/) only', '[5](#a#) apples', '[1](#a#) apple', '[a](https://x.y) z', '[α](/ɑlfə/) β']:
    out.append(t)
# number num_flags and odd numbers
for n in ['1 and 2', '101', '1,001', '2,000,001', '0.0.1', '1.10', '10.01', '3.333', '007', '0.007', '1e3', '12th', '12nd',
          '1st.', '21sts', '2ing', '3ed', "4's", "5'd", '6s', '-7', '-7th', '+8', '9,', '10,000s', '1,000th', '1.5th',
          '99.9th', '3.14159265358979', '0.1', '0.30000000000000004', '1.7976931348623157', '123456789.123456789',
          '9007199254740993', '18446744073709551616', '1.0000001', '2.50', '100.00', '1234.5', '12345.67']:
    out.append(f'Number {n} here.')
    out.append(f'[{n}](#an#) here.')
json.dump(out, open(sys.argv[1], 'w', encoding='utf-8'), ensure_ascii=False, indent=0)
print(len(out), file=sys.stderr)
