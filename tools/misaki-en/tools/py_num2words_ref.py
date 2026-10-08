"""Differential test data for num2words: python tools/py_num2words_ref.py out.json"""
import json, random, sys
from num2words import num2words
rnd = random.Random(5)
cases = []
def add(kind, s):
    try:
        if kind == 'int':
            r = num2words(int(s))
        elif kind == 'ord':
            r = num2words(int(s), to='ordinal')
        elif kind == 'year':
            r = num2words(int(s), to='year')
        else:
            r = num2words(float(s))
        cases.append([kind, s, r])
    except Exception as e:
        cases.append([kind, s, 'ERROR ' + type(e).__name__])
for i in range(3000):
    k = rnd.choice([1, 1, 2, 3, 4, 5, 6, 7, 9, 12, 15, 18, 21, 25, 30, 40, 60, 100, 200, 305, 306, 307, 310])
    s = str(rnd.randint(0, 10 ** k))
    add(rnd.choice(['int', 'ord', 'year']), s)
for y in range(0, 12000, 7):
    add('year', str(y))
for n in list(range(0, 2100)) + [10 ** k for k in range(0, 40)] + [10 ** k - 1 for k in range(1, 40)] + [10 ** k + 1 for k in range(1, 40)]:
    add('int', str(n)); add('ord', str(n))
fl = []
for i in range(4000):
    a = str(rnd.randint(0, 10 ** rnd.choice([0, 1, 2, 3, 5, 8, 12, 16, 17, 20, 25, 300, 310])))
    b = str(rnd.randint(0, 10 ** rnd.choice([1, 2, 3, 4, 6, 9, 12, 17])))
    b = b.zfill(rnd.randint(len(b), len(b) + 6))
    fl.append(rnd.choice([a + '.' + b, a + '.', '0.' + b, a + '.' + b[:2], a + '.0' + b[:1], a + '.5', a + '.25', a + '.125', a + '.995']))
fl += ['0.00001', '0.0001', '0.000123', '1e-05', '0.5', '2.5', '0.125', '0.375', '1.005', '2.675', '0.1', '0.2', '0.3',
       '1.15', '1.25', '1.35', '9.995', '99.995', '0.0000001', '12345678901234567.5', '9007199254740993.5',
       '1.7976931348623157', '123456789012345678901234567890.5', '1' * 309 + '.5', '0.30000000000000004']
for s in fl:
    add('float', s)
json.dump(cases, open(sys.argv[1], 'w'))
print(len(cases), file=sys.stderr)
