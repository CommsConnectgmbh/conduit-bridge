/*
 * Force-included (-include) into every libespeak-ng translation unit of the
 * WebAssembly build. Redirects the narrow libc <ctype.h> functions to the
 * macOS-compatible implementation in conduit_ctype.c (see there for why).
 *
 * The wide functions (iswalpha, ...) are deliberately NOT touched: espeak-ng's
 * compat shim src/include/compat/wctype.h maps them to ucd-tools on every
 * platform, and in translation units that include that shim it also maps
 * tolower/toupper to ucd_tolower/udc_toupper. The shim is included after this
 * header and redefines those two macros, which reproduces exactly the
 * per-translation-unit mapping of the native build.
 */
#ifndef CONDUIT_CTYPE_OVERRIDE_H
#define CONDUIT_CTYPE_OVERRIDE_H

#include <ctype.h>
/* Build fix for musl only: musl's <wchar.h> re-declares iswalnum(wint_t) etc.
 * (under _BSD_SOURCE). If it is first included after the compat wctype.h
 * shim has defined "#define iswalnum ucd_isalnum", that declaration becomes
 * "int ucd_isalnum(wint_t)" and conflicts with ucd.h (dictionary.c fails to
 * compile). Including it here, before the shim's macros exist, only adds
 * declarations and changes no behaviour. */
#include <wchar.h>

int conduit_isalpha(int c);
int conduit_isdigit(int c);
int conduit_isspace(int c);
int conduit_isupper(int c);
int conduit_islower(int c);
int conduit_ispunct(int c);
int conduit_isalnum(int c);
int conduit_tolower(int c);
int conduit_toupper(int c);

#undef isalpha
#undef isdigit
#undef isspace
#undef isupper
#undef islower
#undef ispunct
#undef isalnum
#undef tolower
#undef toupper

#define isalpha(c) conduit_isalpha(c)
#define isdigit(c) conduit_isdigit(c)
#define isspace(c) conduit_isspace(c)
#define isupper(c) conduit_isupper(c)
#define islower(c) conduit_islower(c)
#define ispunct(c) conduit_ispunct(c)
#define isalnum(c) conduit_isalnum(c)
#define tolower(c) conduit_tolower(c)
#define toupper(c) conduit_toupper(c)

#endif
