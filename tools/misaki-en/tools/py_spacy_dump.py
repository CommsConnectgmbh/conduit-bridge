"""Dump spaCy en_core_web_sm tokenization + tags for a JSON list of texts."""
import json, sys
import spacy
nlp = spacy.load('en_core_web_sm', enable=['tok2vec', 'tagger'])
texts = json.load(open(sys.argv[1], encoding='utf-8'))
out = []
for t in texts:
    d = nlp(t)
    out.append([[tk.text, tk.whitespace_, tk.tag_, tk.norm_] for tk in d])
json.dump(out, open(sys.argv[2], 'w', encoding='utf-8'), ensure_ascii=False)
