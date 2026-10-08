"""Adversarial / edge-case corpus (deterministic).

    python tools/gen_fuzz.py test/corpus/en_fuzz.json
"""
import json
import random
import sys

rnd = random.Random(4242)
import os
M = os.environ['MISAKI_DATA'].rstrip('/') + '/'  # directory with us_gold.json and us_silver.json
gold = json.load(open(M + 'us_gold.json'))
silver = json.load(open(M + 'us_silver.json'))
gw = [w for w in gold if w.isalpha()]
sw = [w for w in silver if w.isalpha()]

out = []

# 1. lexicon words in many case variants and inflections (incl. derived forms)
for i in range(700):
    w = rnd.choice(gw if i % 2 else sw)
    v = rnd.choice([w, w.lower(), w.upper(), w.capitalize(), w + 's', w + 'es', w + 'ed', w + 'd', w + 'ing',
                    w[:-1] + 'ies' if w.endswith('y') else w + 'ing', w + "'s", w + "s'", w + "'", w.upper() + 'S',
                    w + 'ly', 'un' + w, w + 'ness', w + '-' + rnd.choice(gw), rnd.choice(gw).capitalize() + w.capitalize()])
    out.append(rnd.choice(['{} ', 'The {} is here.', 'I {} it.', '{}!', 'They were {}.', '"{}"']).format(v))

# 2. number fuzz
def rnum():
    k = rnd.randint(1, 12)
    s = str(rnd.randint(0, 10 ** k))
    r = rnd.random()
    if r < 0.15:
        s = f'{int(s):,}'
    elif r < 0.3:
        s = s + '.' + str(rnd.randint(0, 999)).zfill(rnd.randint(1, 3))
    elif r < 0.35:
        s = '0' + s
    elif r < 0.4:
        s = '.' + s
    elif r < 0.45:
        s = s + '.' + s + '.' + s
    elif r < 0.5:
        s = s + ',' + s[:2]
    return s


for i in range(500):
    n = rnum()
    pre = rnd.choice(['', '', '', '$', '£', '€', '-', '+', '#', '~', '≈', '(', '$-', '-$'])
    suf = rnd.choice(['', '', '', 's', "'s", 'st', 'nd', 'rd', 'th', 'ed', "'d", 'ing', 'k', 'M', 'B', '%', 'x',
                      'km', 'px', 'am', 'pm', ')', '.', ',', '!', '?', '/', '-'])
    out.append(rnd.choice(['{} ', 'It was {}.', 'About {} people came.', 'We paid {} yesterday.',
                           'Version {} works', 'The {} item', '{} and {}']).format(pre + n + suf, rnum()))

# 3. unicode / whitespace / punctuation fuzz
chunks = ['hello', 'world', "don't", 'U.S.', 'e.g.', 'i.e.', 'Mr.', 'NASA', 'iPhone', 'x86', 'C++', 'C#', '.NET',
          'foo_bar', 'fooBar', 'FooBarBaz', 'HTTPServer', 'a/b', 'and/or', 'w/o', '1/2', '½', '¾', '²', '³', '①',
          '٣', '१२', '五', '日本語', 'Ελληνικά', 'Ωmega', 'ΣΑΣ', 'русский', 'עברית', 'العربية', 'café', 'naïve',
          'Zoë', 'ﬁne', 'ﬂow', 'Ⅻ', 'ℌ', '™', '©', '®', '°', '±', '×', '÷', '→', '←', '•', '…', '—', '–', '‑',
          '“', '”', '‘', '’', '«', '»', '„', '‚', '´', '`', '¿', '¡', '§', '¶', '†', '‡', '‰', '′', '″', '‹', '›',
          '😀', '👍🏽', '👨‍👩‍👧', '🇺🇸', '❤️', '✔', '☺', '​', ' ', ' ', '　', '\t', '  ', '   ',
          'é', 'ñ', 'İstanbul', 'ß', 'straße', 'ǅ', 'ǈ', 'ﬀ', 'Ａｂｃ', '１２３', 'ｈｔｔｐ', '%', '&', '+', '@',
          '#', '*', '=', '<', '>', '|', '\\', '^', '~', '_', '[', ']', '{', '}', '(', ')', ';', ':', ',', '.', '!',
          '?', '"', "'", '-', '--', '---', '...', '!!', '?!', ':)', ':(', ';)', ':-)', '<3', '^_^', 'o_O', '¯\\_(ツ)_/¯',
          'http://a.b/c', 'https://www.example.co.uk/path?a=1&b=2#frag', 'ftp://files.example.org', 'user@mail.com',
          'www.test.org', 'example.com', 'v1.2.3', '2.0', '3.', '.5', '1e10', '0x1F', '0b101', '1,000', '1.000,50',
          '$', '£', '€', '¥', '₹', '₿', 'USD', 'a.m.', 'p.m.', 'AM', 'PM', 'am', 'pm', 'vs', 'vs.', 'VS', 'etc.',
          'by', 'BY', 'to', 'TO', 'in', 'IN', 'the', 'THE', 'a', 'A', 'an', 'AN', 'I', 'used', 'USED', 'am', 'AM',
          'read', 'lead', 'live', 'record', '2', 'b2b', 'p2p', 'g2g', 'h2o', 'mp3', '3d', '4x4', 'Q4', 'H1', 'COVID-19',
          "rock'n'roll", "'tis", "'90s", "goin'", "y'know", "o'clock", "''", "'''", '""', 'x', 'X', 'Xs', "X's", 'IOU']
for i in range(900):
    k = rnd.randint(1, 14)
    parts = [rnd.choice(chunks) for _ in range(k)]
    seps = [rnd.choice([' ', ' ', ' ', '', ', ', '. ', '  ', '\t', ' - ', '/']) for _ in range(k)]
    out.append(''.join(p + s for p, s in zip(parts, seps)))

# 4. markdown link features (misaki-specific syntax) incl. odd alignments
feats = ['/hˈɛloʊ/', '/kˈOkəɹO/', '-1', '-2', '+1', '+2', '0', '0.5', '+0.5', '-0.5', '#a#', '#n#', '#&#', '#an#',
         '/ /', '//', '/x', 'x/', '', 'https://example.com', '3', '10', '-0', '/ˈA/']
words = ['hello', 'Kokoro', 'two words', 'U.S.A.', '123', '$5', 'one-two', "don't", 'A', 'read', 'live', '1,000',
         'running fast', 'x', '!', 'self.attr', 'a  b']
for i in range(400):
    a = f'[{rnd.choice(words)}]({rnd.choice(feats)})'
    b = f'[{rnd.choice(words)}]({rnd.choice(feats)})'
    out.append(rnd.choice([f'Say {a} now.', f'{a} and {b}', f'{a}{b}!', f'  {a}  then  {b} ', f'The {a}s are {b}.',
                           f'{a},{b}', f'({a})', f'[x]({rnd.choice(feats)})', f'{a} {rnd.choice(chunks)} {b}']))

# 5. very long inputs and chunking edge cases
base = ['This is a sentence', 'with many words', 'and no end', 'in sight', 'it keeps going', 'forever and ever']
for i in range(60):
    k = rnd.randint(40, 200)
    seps = rnd.choice([[' '], [', '], ['; '], [': '], [' — '], ['. '], ['! '], ['? '], ['… '], [' ('], [') '],
                       [', ', '. ', ' '], ['" ', ' "']])
    out.append(''.join(rnd.choice(base) + rnd.choice(seps) for _ in range(k)))
for i in range(20):
    out.append(' '.join(rnd.choice(gw) for _ in range(rnd.randint(100, 400))))
for i in range(20):
    out.append('\n'.join(' '.join(rnd.choice(gw) for _ in range(rnd.randint(1, 30))) for _ in range(rnd.randint(2, 8))))
out.append('word ' * 600)
out.append('supercalifragilisticexpialidocious ' * 30)
out.append('Antidisestablishmentarianism' * 10)
out.append('a' * 300)
out.append('1' * 400)
out.append(' '.join(['1234567'] * 80))
out.append('1' * 310)  # num2words overflow in Python (OverflowError)
out.append('$' + '9' * 320 + '.99')
out.append('')
out.append('   ')
out.append('\n\n\n')
out.append('.')
out.append('!!!')
out.append('😀')
out.append('​')

seen = set()
final = []
for c in out:
    if c not in seen:
        seen.add(c)
        final.append(c)
json.dump(final, open(sys.argv[1], 'w', encoding='utf-8'), ensure_ascii=False, indent=0)
print(len(final), 'fuzz texts', file=sys.stderr)
