/*
 * Dumps the behaviour of every libc character-classification / case-mapping
 * function that libespeak-ng 1.52.0 calls, after selecting the locale the
 * same way espeak_ng_Initialize() does (speech.c: "C.UTF-8", "UTF-8",
 * "en_US.UTF-8", ""). Output is run-length encoded so that a native (macOS
 * libc) dump and a WebAssembly (Emscripten musl) dump can be diffed.
 *
 * Usage: dump_ctype [--raw]   (--raw keeps the exact non-zero return values
 * of the is* functions instead of normalising them to 0/1)
 */
#include <ctype.h>
#include <locale.h>
#include <stdio.h>
#include <string.h>
#include <wctype.h>
#include <wchar.h>

static int raw = 0;

#define WIDE_MAX 0x1FFFFF

typedef long (*fn_t)(long);

#define WRAP_BOOL(name, call) \
	static long w_##name(long c) { long r = (long)(call); return raw ? r : (r != 0); }
#define WRAP_MAP(name, call) \
	static long w_##name(long c) { return (long)(call); }

WRAP_BOOL(iswalpha, iswalpha((wint_t)c))
WRAP_BOOL(iswdigit, iswdigit((wint_t)c))
WRAP_BOOL(iswspace, iswspace((wint_t)c))
WRAP_BOOL(iswupper, iswupper((wint_t)c))
WRAP_BOOL(iswlower, iswlower((wint_t)c))
WRAP_BOOL(iswpunct, iswpunct((wint_t)c))
WRAP_BOOL(iswalnum, iswalnum((wint_t)c))
WRAP_MAP(towlower, towlower((wint_t)c))
WRAP_MAP(towupper, towupper((wint_t)c))

WRAP_BOOL(isalpha, isalpha((int)c))
WRAP_BOOL(isdigit, isdigit((int)c))
WRAP_BOOL(isspace, isspace((int)c))
WRAP_BOOL(isupper, isupper((int)c))
WRAP_BOOL(islower, islower((int)c))
WRAP_BOOL(ispunct, ispunct((int)c))
WRAP_BOOL(isalnum, isalnum((int)c))
WRAP_MAP(tolower, tolower((int)c))
WRAP_MAP(toupper, toupper((int)c))

static void dump(const char *name, fn_t f, long lo, long hi)
{
	long start = lo;
	long prev = f(lo);
	for (long c = lo + 1; c <= hi + 1; c++) {
		long v = (c <= hi) ? f(c) : 0;
		/* case mappings: encode as delta so long identity runs collapse */
		int is_map = (strncmp(name, "tow", 3) == 0) || (strncmp(name, "to", 2) == 0);
		long pv = is_map ? prev - (c - 1) : prev;
		long cv = is_map ? v - c : v;
		if (c > hi || cv != pv) {
			printf("%s %ld %ld %ld\n", name, start, c - 1, pv);
			start = c;
		}
		prev = v;
	}
}

int main(int argc, char **argv)
{
	if (argc > 1 && strcmp(argv[1], "--raw") == 0)
		raw = 1;

	const char *loc = setlocale(LC_CTYPE, "C.UTF-8");
	const char *which = "C.UTF-8";
	if (loc == NULL) {
		which = "UTF-8";
		if ((loc = setlocale(LC_CTYPE, "UTF-8")) == NULL) {
			which = "en_US.UTF-8";
			if ((loc = setlocale(LC_CTYPE, "en_US.UTF-8")) == NULL) {
				which = "\"\"";
				loc = setlocale(LC_CTYPE, "");
			}
		}
	}
	fprintf(stderr, "locale request accepted: %s -> %s\n", which, loc ? loc : "(null)");

	dump("iswalpha", w_iswalpha, -1, WIDE_MAX);
	dump("iswdigit", w_iswdigit, -1, WIDE_MAX);
	dump("iswspace", w_iswspace, -1, WIDE_MAX);
	dump("iswupper", w_iswupper, -1, WIDE_MAX);
	dump("iswlower", w_iswlower, -1, WIDE_MAX);
	dump("iswpunct", w_iswpunct, -1, WIDE_MAX);
	dump("iswalnum", w_iswalnum, -1, WIDE_MAX);
	dump("towlower", w_towlower, -1, WIDE_MAX);
	dump("towupper", w_towupper, -1, WIDE_MAX);
	/* narrow functions: signed char values, 0..255 and (macOS: rune lookup) beyond */
	dump("isalpha", w_isalpha, -128, WIDE_MAX);
	dump("isdigit", w_isdigit, -128, WIDE_MAX);
	dump("isspace", w_isspace, -128, WIDE_MAX);
	dump("isupper", w_isupper, -128, WIDE_MAX);
	dump("islower", w_islower, -128, WIDE_MAX);
	dump("ispunct", w_ispunct, -128, WIDE_MAX);
	dump("isalnum", w_isalnum, -128, WIDE_MAX);
	dump("tolower", w_tolower, -128, WIDE_MAX);
	dump("toupper", w_toupper, -128, WIDE_MAX);
	return 0;
}
