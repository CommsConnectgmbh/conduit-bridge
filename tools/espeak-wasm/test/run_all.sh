#!/usr/bin/env bash
# Full parity test suite. Requires a finished ./build.sh (dist/), the Homebrew
# libespeak-ng 1.52.0 and a Python with `phonemizer` 3.3.x (PYTHON=...).
#
#   PYTHON=/path/to/venv/bin/python test/run_all.sh
#
# Writes everything to test/out/ and prints a summary; exit code 0 only if every
# required comparison is 100 % identical.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
OUT="$HERE/out"
PY="${PYTHON:-python3}"
LIB="${ESPEAK_LIB:-/opt/homebrew/lib/libespeak-ng.dylib}"
DIST="${DIST:-$ROOT/dist}"
export PHONEMIZER_ESPEAK_LIBRARY="$LIB"
mkdir -p "$OUT"
cd "$HERE"
fail=0
step() { printf '\n######## %s\n' "$*"; }

step "corpus + fuzz corpus"
"$PY" -I gen_corpus.py "$OUT/corpus.json"
"$PY" -I gen_fuzz.py "$OUT/fuzz.json" 10000 5000 777

for ds in complete minimal; do
  rm -rf "$OUT/data-$ds" && mkdir -p "$OUT/data-$ds"
  tar xf "$DIST/espeak-ng-data-$ds.tar" -C "$OUT/data-$ds"
done

step "native references (Homebrew lib, ctypes, phonemizer call sequence)"
for c in corpus fuzz; do
  "$PY" -I ref_native.py "$OUT/$c.json" "$OUT/ref_native_$c.json" --lib "$LIB" </dev/null 2>/dev/null
  "$PY" -I ref_native.py "$OUT/$c.json" "$OUT/ref_native_${c}_minimal.json" --lib "$LIB" --data "$OUT/data-minimal/espeak-ng-data" </dev/null 2>/dev/null
done

step "python phonemizer references"
for c in corpus fuzz; do
  "$PY" -I ref_phonemizer.py "$OUT/$c.json" "$OUT/ref_phonemizer_$c.json" </dev/null 2>/dev/null
done

par() { # name, args...
  local name="$1"; shift
  step "$name"
  node parity.mjs --dist "$DIST" --report "$OUT/report-$name.json" --show 5 "$@" </dev/null 2>/dev/null
  return $?
}
for c in corpus fuzz; do
  par "complete-vs-native-full-$c" --dataset complete --corpus "$OUT/$c.json" --native "$OUT/ref_native_$c.json" --phonemizer "$OUT/ref_phonemizer_$c.json" || fail=1
done
par "minimal-vs-native-minimal-data-corpus" --dataset minimal --corpus "$OUT/corpus.json" --native "$OUT/ref_native_corpus_minimal.json" --skip-phonemizer || fail=1
# informational (not required to be identical):
#  - minimal dataset on the fuzz corpus: with dictionaries missing, libespeak-ng 1.52.0
#    reads through a wild pointer in LookupDict2 (native ASan: SEGV) for some inputs;
#    native returns garbage-dependent output, WASM traps (EspeakCrashError)
#  - minimal dataset vs a full installation: Polish letters / other scripts differ
par "INFO-minimal-vs-native-minimal-data-fuzz" --dataset minimal --corpus "$OUT/fuzz.json" --native "$OUT/ref_native_fuzz_minimal.json" --skip-phonemizer --show 0
par "INFO-minimal-vs-native-full-corpus" --dataset minimal --corpus "$OUT/corpus.json" --native "$OUT/ref_native_corpus.json" --phonemizer "$OUT/ref_phonemizer_corpus.json" --show 0

step "instance isolation"
node isolation.mjs "$DIST" "$OUT/corpus.json" </dev/null || fail=1

step "summary"
if [[ $fail == 0 ]]; then echo "ALL REQUIRED COMPARISONS IDENTICAL"; else echo "FAILURES (see above)"; fi
exit $fail
