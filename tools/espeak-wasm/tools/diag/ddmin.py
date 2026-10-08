# delta-debugging minimiser for native crashes: ddmin.py <in.json(text str)> <voice>
import json, subprocess, sys, os, tempfile
PY = sys.executable
HERE = os.path.dirname(os.path.abspath(__file__))
TEST = os.path.join(HERE, '..', '..', 'test')
def crashes(s):
    with tempfile.NamedTemporaryFile('w', suffix='.json', delete=False, encoding='utf-8') as f:
        json.dump(s, f, ensure_ascii=False)
    r = subprocess.run([PY, '-I', os.path.join(HERE, 'crash_one.py'), f.name, sys.argv[2], TEST], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    os.unlink(f.name)
    return r.returncode < 0 or r.returncode == 139
s = json.load(open(sys.argv[1]))
assert crashes(s)
n = 2
while len(s) >= 2:
    chunk = max(1, len(s) // n)
    reduced = False
    for i in range(0, len(s), chunk):
        cand = s[:i] + s[i + chunk:]
        if cand and crashes(cand):
            s = cand; n = max(n - 1, 2); reduced = True; break
    if not reduced:
        if chunk == 1: break
        n = min(len(s), n * 2)
print(json.dumps(s, ensure_ascii=False)); print(repr(s), len(s))
