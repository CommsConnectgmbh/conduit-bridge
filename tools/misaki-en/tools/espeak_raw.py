"""Query native espeak-ng (via phonemizer, as misaki does) for raw
espeak_TextToPhonemes output.  stdin: JSON list of lines; stdout: JSON dict."""
import json
import sys
import warnings

warnings.filterwarnings('ignore')
from misaki.espeak import EspeakFallback  # noqa: E402  (sets library path)

fb = EspeakFallback(british=False)
w = fb.backend._espeak
lines = json.load(sys.stdin)
json.dump({l: w.text_to_phonemes(l, '^') for l in lines}, sys.stdout, ensure_ascii=False)
