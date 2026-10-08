#!/usr/bin/env bash
# build an (instrumented) copy of the libespeak-ng sources in $1 to $1/espeak-ng.mjs (+ wasm)
set -euo pipefail
W="$(cd "$(dirname "$0")/../.." && pwd)"
D="$1"; shift
export EM_CACHE="$W/build/emcache"
cd "$D"
SRCS=$(cd "$W/build/native" && sed -n '/^src_libespeak_ng_la_SOURCES/,/^$/p' Makefile | tr ' \\\t' '\n\n\n' | grep '\.c$' | grep -v "sPlayer\|klatt" )
mkdir -p wasmcfg && cp "$W/build/wasm/config.h" wasmcfg/
emcc -O2 -include "$W/src/conduit_ctype_override.h" -DHAVE_CONFIG_H -Iwasmcfg -Isrc/include -Isrc/include/compat -Isrc/ucd-tools/src/include \
  -D_BSD_SOURCE -D_DEFAULT_SOURCE -D_POSIX_C_SOURCE=200112L -DPATH_ESPEAK_DATA='"/x"' -DLIBESPEAK_NG_EXPORT -fwrapv \
  $SRCS "$W/src/conduit_glue.c" "$W/src/conduit_ctype.c" -o espeak-ng.mjs \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=node -sEXPORT_NAME=createEspeakModule -sALLOW_MEMORY_GROWTH=1 -sSTACK_SIZE=1048576 \
  -sFORCE_FILESYSTEM=1 -sINVOKE_RUN=0 -sEXIT_RUNTIME=0 \
  "-sEXPORTED_FUNCTIONS=['_conduit_init','_conduit_resolve_voice','_conduit_phonemize','_conduit_result_ptr','_conduit_result_len','_conduit_result_clauses','_conduit_joined_ptr','_conduit_joined_len','_conduit_version','_conduit_terminate','_malloc','_free']" \
  "-sEXPORTED_RUNTIME_METHODS=['FS','UTF8ToString','stringToUTF8','lengthBytesUTF8','HEAPU8']" "$@"
cp "$W"/dist/{index.mjs,phonemizer-compat.mjs,build-info.mjs,espeak-ng-data-complete.tar,espeak-ng-data-minimal.tar} .
