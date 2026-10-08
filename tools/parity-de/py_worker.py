# Reads one JSON string per line, writes the misaki DEG2P phonemes per line.
import sys, json
from misaki import de
g2p = de.DEG2P()
for line in sys.stdin:
    text = json.loads(line)
    try:
        ps, _ = g2p(text)
        out = {"ok": ps}
    except Exception as e:
        out = {"err": type(e).__name__}
    sys.stdout.write(json.dumps(out, ensure_ascii=False) + "\n")
    sys.stdout.flush()
