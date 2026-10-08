# exit 139 if the native lib crashes on the text given in a JSON file (fresh engine)
import json, sys, os
sys.path.insert(0, sys.argv[3])
from ref_native import Engine, MODES
t = json.load(open(sys.argv[1]))
e = Engine('/opt/homebrew/lib/libespeak-ng.dylib', None)
e.set_language(sys.argv[2])
e.clauses(t, MODES['tie'])
