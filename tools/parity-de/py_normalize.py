import json, sys
from misaki.de import normalize_text_de
c = json.load(open(sys.argv[1]))
json.dump([normalize_text_de(s) for s in c], open(sys.argv[2], "w"), ensure_ascii=False)
