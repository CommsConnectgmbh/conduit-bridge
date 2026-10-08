import json, sys
import spacy
from spacy.attrs import NORM, PREFIX, SUFFIX, SHAPE, SPACY, IS_SPACE
nlp = spacy.load('en_core_web_sm', enable=['tok2vec', 'tagger'])
texts = json.load(open(sys.argv[1]))
out = []
for t in texts:
    d = nlp(t)
    a = d.to_array([NORM, PREFIX, SUFFIX, SHAPE, SPACY, IS_SPACE])
    out.append({'toks': [x.text for x in d], 'feats': [[str(int(v)) for v in row] for row in a],
                'strs': [[x.norm_, x.prefix_, x.suffix_, x.shape_] for x in d]})
json.dump(out, open(sys.argv[2], 'w'), ensure_ascii=False)
