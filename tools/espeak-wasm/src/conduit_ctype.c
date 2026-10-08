/*
 * conduit_ctype.c - macOS-compatible character classification for the
 * WebAssembly build of libespeak-ng 1.52.0.
 *
 * Inside libespeak-ng the wide functions (iswalpha, iswspace, ...) are
 * already mapped to the bundled ucd-tools library by the compat shim
 * src/include/compat/wctype.h, on every platform. What remains platform
 * dependent are the narrow <ctype.h> functions (isspace, isalpha, isalnum,
 * isdigit, tolower, ...) in translation units that do not map them: macOS
 * libc answers them from the current locale (espeak_ng_Initialize selects
 * "C.UTF-8", where e.g. isspace(0xA0) is true and toupper(0xFF) is 0x178),
 * while Emscripten's musl is ASCII-only. To produce output bit-identical to
 * the native Homebrew libespeak-ng on macOS, those calls are redirected here
 * (see conduit_ctype_override.h) and answered from tables dumped from macOS
 * libc (tools/wctype/dump_ctype.c). On macOS the narrow functions equal the
 * wide ones for c >= -1 and return 0 / identity for -128..-2.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later (part of a work based on espeak-ng).
 */
#include <stdint.h>
#include "conduit_ctype_override.h"

#include "conduit_ctype_tables.h"

#define N(a) ((int)(sizeof(a) / sizeof((a)[0])))
#define TABLE_MAX 0x1FFFFF

/* value of a boolean table: number of toggle points <= c, odd => true */
static int bool_lookup(const int32_t *t, int n, int32_t c)
{
	if (c < -1 || c > TABLE_MAX)
		return 0;
	int lo = 0, hi = n; /* first index with t[i] > c */
	while (lo < hi) {
		int mid = (lo + hi) >> 1;
		if (t[mid] <= c)
			lo = mid + 1;
		else
			hi = mid;
	}
	return lo & 1;
}

static int32_t map_lookup(const int32_t *s, const int32_t *d, int n, int32_t c)
{
	if (c < -1 || c > TABLE_MAX)
		return c;
	int lo = 0, hi = n; /* last index with s[i] <= c */
	while (lo < hi) {
		int mid = (lo + hi) >> 1;
		if (s[mid] <= c)
			lo = mid + 1;
		else
			hi = mid;
	}
	return lo == 0 ? c : c + d[lo - 1];
}

/* on macOS the narrow functions are identical to the wide ones for c >= -1,
 * 0 / identity for the remaining negative (signed char) values */
#define BOOL_N(fn, wfn) int conduit_##fn(int c) { return c < -1 ? 0 : bool_lookup(tbl_##wfn, N(tbl_##wfn), c); }
BOOL_N(isalpha, iswalpha)
BOOL_N(isdigit, iswdigit)
BOOL_N(isspace, iswspace)
BOOL_N(isupper, iswupper)
BOOL_N(islower, iswlower)
BOOL_N(ispunct, iswpunct)
BOOL_N(isalnum, iswalnum)

int conduit_tolower(int c) { return c < -1 ? c : map_lookup(tbl_towlower_start, tbl_towlower_delta, N(tbl_towlower_start), c); }
int conduit_toupper(int c) { return c < -1 ? c : map_lookup(tbl_towupper_start, tbl_towupper_delta, N(tbl_towupper_start), c); }
