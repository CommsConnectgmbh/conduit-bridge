#!/usr/bin/env bash
# Reproducible build of espeak-ng 1.52.0 as a WebAssembly phonemizer for Node.js.
#
# Output (dist/):
#   espeak-ng.mjs / espeak-ng.wasm   Emscripten module (ES module factory)
#   espeak-ng-data-complete.tar      phoneme data, voices de/en-US/en(-GB), and every
#                                    dictionary libespeak-ng 1.52.0 can load while reading
#                                    de/en text (default dataset)
#   espeak-ng-data-minimal.tar       phoneme data, voices, de + en dictionaries only
#   index.mjs, phonemizer-compat.mjs JS wrapper
#   build-info.mjs                   pinned versions + data hash (checked at runtime)
#   COPYING, NOTICE, README.md, SHA256SUMS
#
# Requirements (macOS, Homebrew): emscripten (emcc 6.0.11 tested), autoconf,
# automake, libtool (glibtoolize), a native C compiler, python3, node >= 22.
#
# Environment:
#   DEBUG_CHECKS=1          link with -sASSERTIONS=2 -sSTACK_OVERFLOW_CHECK=2 -sSAFE_HEAP=1
#                           into dist-debug/ (used by the test suite)
set -euo pipefail

# ---- pinned source ---------------------------------------------------------
ESPEAK_VERSION=1.52.0
ESPEAK_TAG=1.52.0
ESPEAK_COMMIT=4870adfa25b1a32b4361592f1be8a40337c58d6c
ESPEAK_URL="https://github.com/espeak-ng/espeak-ng/archive/refs/tags/${ESPEAK_TAG}.tar.gz"
ESPEAK_SHA256=bb4338102ff3b49a81423da8a1a158b420124b055b60fa76cfb4b18677130a23
EMCC_TESTED=6.0.11

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DL="$ROOT/dl"
BUILD="$ROOT/build"
OUT="$ROOT/dist"
[[ "${DEBUG_CHECKS:-0}" == 1 ]] && OUT="$ROOT/dist-debug"
TARBALL="$DL/espeak-ng-${ESPEAK_VERSION}.tar.gz"
JOBS="$(sysctl -n hw.ncpu 2>/dev/null || nproc 2>/dev/null || echo 4)"
# keep Emscripten's generated system libraries inside the build directory
export EM_CACHE="$BUILD/emcache"

log() { printf '\n==> %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

sha256() { shasum -a 256 "$1" | awk '{print $1}'; }

for tool in emcc emconfigure emmake autoreconf cc python3 node shasum; do
  command -v "$tool" >/dev/null || die "missing tool: $tool"
done
LIBTOOLIZE="$(command -v glibtoolize || command -v libtoolize || true)"
[[ -n "$LIBTOOLIZE" ]] || die "missing GNU libtoolize (brew install libtool)"
export LIBTOOLIZE
EMCC_VERSION="$(emcc --version | head -1 | sed -E 's/.* ([0-9]+\.[0-9]+\.[0-9]+).*/\1/')"
[[ "$EMCC_VERSION" == "$EMCC_TESTED" ]] || echo "WARNING: emcc $EMCC_VERSION (tested with $EMCC_TESTED)"

# ---- 1. source ---------------------------------------------------------------
log "source espeak-ng $ESPEAK_TAG ($ESPEAK_COMMIT)"
mkdir -p "$DL"
if [[ ! -f "$TARBALL" ]]; then
  curl -fsSL -o "$TARBALL.part" "$ESPEAK_URL"
  mv "$TARBALL.part" "$TARBALL"
fi
[[ "$(sha256 "$TARBALL")" == "$ESPEAK_SHA256" ]] || die "SHA-256 mismatch for $TARBALL"
echo "sha256 ok: $ESPEAK_SHA256"
if command -v git >/dev/null; then
  remote_commit="$(git ls-remote https://github.com/espeak-ng/espeak-ng.git "refs/tags/${ESPEAK_TAG}" 2>/dev/null | awk '{print $1}' || true)"
  if [[ -n "$remote_commit" && "$remote_commit" != "$ESPEAK_COMMIT" ]]; then
    die "tag $ESPEAK_TAG now points to $remote_commit, expected $ESPEAK_COMMIT"
  fi
fi

prepare_tree() { # $1 = directory
  rm -rf "$1"
  mkdir -p "$1"
  tar xzf "$TARBALL" -C "$1" --strip-components=1
  # same preparation as the Homebrew formula
  (cd "$1" && touch NEWS AUTHORS ChangeLog && autoreconf --force --install >autoreconf.log 2>&1)
}

# ---- 2. native build: compiles the data with the same sources ----------------
log "native build (data compiler)"
NATIVE="$BUILD/native"
prepare_tree "$NATIVE"
(cd "$NATIVE" && ./configure --disable-silent-rules --with-pcaudiolib=no --prefix=/nonexistent >configure.log 2>&1)
(cd "$NATIVE" && make -j"$JOBS" >make.log 2>&1) || die "native make failed (see $NATIVE/make.log)"

DATA_FILES=(phontab phonindex phondata intonations de_dict en_dict lang/gmw/de lang/gmw/en lang/gmw/en-US)
# Closure of the dictionaries libespeak-ng can load while translating de/en text
# (tools/dict_closure.py): de_rules switches Polish letters to pl; words/letters
# of other scripts switch to the languages of the alphabets table (el hy hi bn
# pa gu ta te kn ml si ka ko); the Georgian translator maps Cyrillic to ru.
EXPECTED_CLOSURE="bn de el en gu hi hy ka kn ko ml pa pl ru si ta te"
CLOSURE="$(python3 "$ROOT/tools/dict_closure.py" "$NATIVE" de en 2>/dev/null | tr '\n' ' ' | sed 's/ $//')"
[[ "$CLOSURE" == "$EXPECTED_CLOSURE" ]] || die "dictionary closure changed: '$CLOSURE'"
EXTRA_DICTS=()
for l in $CLOSURE; do [[ "$l" == de || "$l" == en ]] || EXTRA_DICTS+=("${l}_dict"); done
# bn_dict and ko_dict cannot be reproduced by compiling: compiledict.c's
# rgroup_sorter() breaks ties between rule groups of the same name by the
# truncated difference of two heap pointers, so the rule order depends on the
# allocator (ko_dict even differs from run to run). For identity with the
# Homebrew installation these two files are taken from Homebrew, pinned by hash.
pinned_from_homebrew() { # works with macOS /bin/bash 3.2 (no associative arrays)
  case "$1" in
    bn_dict) echo bc6f82b50a858892f19b72b539c2603b26bd91c39cdd85c0e1b5a5ee625db153 ;;
    ko_dict) echo 5faba3d914de3292ce4660dc3b874e00f96624ebd8e2acae7d698e7a4fa4e9e1 ;;
  esac
}
HB_DATA=/opt/homebrew/share/espeak-ng-data

DATA_SRC="$BUILD/data-staging/espeak-ng-data"
rm -rf "$BUILD/data-staging"
for f in "${DATA_FILES[@]}" "${EXTRA_DICTS[@]}"; do
  [[ -f "$NATIVE/espeak-ng-data/$f" ]] || die "missing compiled data file $f"
  mkdir -p "$(dirname "$DATA_SRC/$f")"
  pin="$(pinned_from_homebrew "$f")"
  if [[ -n "$pin" ]]; then
    if [[ -f "$HB_DATA/$f" && "$(sha256 "$HB_DATA/$f")" == "$pin" ]]; then
      cp "$HB_DATA/$f" "$DATA_SRC/$f"
      echo "from Homebrew (pinned sha256)  $f"
    else
      cp "$NATIVE/espeak-ng-data/$f" "$DATA_SRC/$f"
      echo "WARNING: pinned Homebrew $f not available, using the self-compiled (non-deterministic) file"
    fi
  else
    cp "$NATIVE/espeak-ng-data/$f" "$DATA_SRC/$f"
  fi
done

if [[ -d "$HB_DATA" ]]; then
  log "compare compiled data with Homebrew espeak-ng ($HB_DATA)"
  for f in "${DATA_FILES[@]}" "${EXTRA_DICTS[@]}"; do
    [[ -n "$(pinned_from_homebrew "$f")" ]] && continue
    if cmp -s "$DATA_SRC/$f" "$HB_DATA/$f"; then echo "identical  $f"; else echo "DIFFERENT  $f"; DIFF_DATA=1; fi
  done
  [[ -z "${DIFF_DATA:-}" ]] || die "compiled data differs from the Homebrew installation"
fi

# ---- 3. macOS ctype tables ----------------------------------------------------
log "macOS libc ctype tables"
CT="$BUILD/ctype"
mkdir -p "$CT"
if [[ "$(uname -s)" == Darwin ]]; then
  cc -O1 -o "$CT/dump_native" "$ROOT/tools/wctype/dump_ctype.c"
  "$CT/dump_native" --raw >"$CT/native_raw.txt"
  python3 "$ROOT/tools/wctype/gen_ctype_tables.py" "$CT/native_raw.txt" "$CT/conduit_ctype_tables.h"
  if ! cmp -s "$CT/conduit_ctype_tables.h" "$ROOT/src/conduit_ctype_tables.h"; then
    if [[ "${REGEN_CTYPE:-0}" == 1 ]]; then
      cp "$CT/conduit_ctype_tables.h" "$ROOT/src/conduit_ctype_tables.h"
      echo "src/conduit_ctype_tables.h regenerated"
    else
      die "this macOS libc differs from src/conduit_ctype_tables.h (set REGEN_CTYPE=1 to adopt it)"
    fi
  else
    echo "src/conduit_ctype_tables.h matches this macOS libc"
  fi
  # emulation check: narrow functions of the wasm emulation == macOS libc
  emcc -O2 -include "$ROOT/src/conduit_ctype_override.h" -I"$ROOT/src" -o "$CT/dump_wasm.js" \
    "$ROOT/tools/wctype/dump_ctype.c" "$ROOT/src/conduit_ctype.c"
  node "$CT/dump_wasm.js" --raw 2>/dev/null | awk '$1 !~ /^isw|^tow/' >"$CT/wasm_narrow.txt"
  awk '$1 !~ /^isw|^tow/' "$CT/native_raw.txt" >"$CT/native_narrow.txt"
  cmp -s "$CT/native_narrow.txt" "$CT/wasm_narrow.txt" || die "ctype emulation differs from macOS libc"
  echo "ctype emulation identical to macOS libc for c in [-128, 0x1FFFFF] ($(wc -l <"$CT/native_narrow.txt" | tr -d ' ') runs)"
else
  echo "not on macOS: using committed src/conduit_ctype_tables.h"
fi

# ---- 4. WebAssembly library ---------------------------------------------------
log "emscripten build of libespeak-ng"
# -fsanitize=null -fsanitize-trap=null: every load/store through a NULL pointer
# traps (-> EspeakCrashError in JS) instead of silently reading WebAssembly
# address 0. On macOS such an access is a SIGSEGV of the native library (the
# zero page is unmapped), so the WASM build fails exactly where native crashes.
WASM_CFLAGS="-g -O2 -fsanitize=null -fsanitize-trap=null"
WASM="$BUILD/wasm"
prepare_tree "$WASM"
(cd "$WASM" && emconfigure ./configure --host=wasm32-unknown-emscripten \
  --disable-shared --enable-static --disable-silent-rules \
  --with-pcaudiolib=no --with-sonic=no --with-mbrola=no --with-async=no \
  --with-klatt=no --with-speechplayer=no \
  --with-extdict-ru=no --with-extdict-cmn=no --with-extdict-yue=no \
  --prefix=/espeak CFLAGS="$WASM_CFLAGS" >configure.log 2>&1) || die "emconfigure failed (see $WASM/configure.log)"
grep -q -- "-fsanitize-trap=null" "$WASM/Makefile" || die "WASM_CFLAGS not applied"
(cd "$WASM" && emmake make -j"$JOBS" src/libespeak-ng.la \
  CPPFLAGS="-include $ROOT/src/conduit_ctype_override.h" >make.log 2>&1) || die "emmake failed (see $WASM/make.log)"

# ---- 5. link -----------------------------------------------------------------
log "link -> $OUT"
rm -rf "$OUT"
mkdir -p "$OUT"
EXPORTS="['_conduit_init','_conduit_resolve_voice','_conduit_phonemize','_conduit_result_ptr','_conduit_result_len','_conduit_result_clauses','_conduit_joined_ptr','_conduit_joined_len','_conduit_version','_conduit_terminate','_malloc','_free']"
RUNTIME="['FS','UTF8ToString','stringToUTF8','lengthBytesUTF8','HEAPU8']"
LINK_FLAGS=(-O2 -fwrapv
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=node -sEXPORT_NAME=createEspeakModule
  -sALLOW_MEMORY_GROWTH=1 -sSTACK_SIZE=1048576
  -sFORCE_FILESYSTEM=1 -sINVOKE_RUN=0 -sEXIT_RUNTIME=0
  "-sEXPORTED_FUNCTIONS=$EXPORTS" "-sEXPORTED_RUNTIME_METHODS=$RUNTIME")
if [[ "${DEBUG_CHECKS:-0}" == 1 ]]; then
  LINK_FLAGS+=(-sASSERTIONS=2 -sSTACK_OVERFLOW_CHECK=2 -sSAFE_HEAP=1)
fi
emcc "${LINK_FLAGS[@]}" -I"$WASM/src/include" \
  "$ROOT/src/conduit_glue.c" "$ROOT/src/conduit_ctype.c" "$WASM/src/.libs/libespeak-ng.a" \
  -o "$OUT/espeak-ng.mjs"

# ---- 6. data archive ----------------------------------------------------------
log "data archive"
python3 "$ROOT/tools/pack_data.py" "$DATA_SRC" "$OUT/espeak-ng-data-complete.tar" "${DATA_FILES[@]}" "${EXTRA_DICTS[@]}"
python3 "$ROOT/tools/pack_data.py" "$DATA_SRC" "$OUT/espeak-ng-data-minimal.tar" "${DATA_FILES[@]}"
fsize() { stat -f %z "$1" 2>/dev/null || stat -c %s "$1"; }
jlist() { local s; s="$(printf "'%s'," "$@")"; printf '%s' "${s%,}"; }

# ---- 7. JS wrapper, licence, manifest -----------------------------------------
cp "$ROOT/js/index.mjs" "$ROOT/js/phonemizer-compat.mjs" "$OUT/"
cp "$NATIVE/COPYING" "$OUT/COPYING"
cp "$ROOT/NOTICE" "$ROOT/README.md" "$OUT/"
cat >"$OUT/build-info.mjs" <<EOF
// generated by build.sh
export const BUILD_INFO = Object.freeze({
  espeak: { version: '$ESPEAK_VERSION', tag: '$ESPEAK_TAG', commit: '$ESPEAK_COMMIT', sourceSha256: '$ESPEAK_SHA256' },
  emcc: '$EMCC_VERSION',
  data: {
    complete: { file: 'espeak-ng-data-complete.tar', sha256: '$(sha256 "$OUT/espeak-ng-data-complete.tar")', size: $(fsize "$OUT/espeak-ng-data-complete.tar"), files: [$(jlist "${DATA_FILES[@]}" "${EXTRA_DICTS[@]}")] },
    minimal: { file: 'espeak-ng-data-minimal.tar', sha256: '$(sha256 "$OUT/espeak-ng-data-minimal.tar")', size: $(fsize "$OUT/espeak-ng-data-minimal.tar"), files: [$(jlist "${DATA_FILES[@]}")] },
  },
});
EOF
(cd "$OUT" && shasum -a 256 espeak-ng.mjs espeak-ng.wasm espeak-ng-data-complete.tar espeak-ng-data-minimal.tar index.mjs phonemizer-compat.mjs build-info.mjs >SHA256SUMS)

log "done"
(cd "$OUT" && ls -l && cat SHA256SUMS)
