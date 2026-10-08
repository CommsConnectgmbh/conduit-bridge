/*
 * conduit_glue.c - minimal C entry points for the espeak-ng 1.52.0
 * WebAssembly phonemizer.
 *
 * Mirrors the call sequence of the Python library `phonemizer`
 * (backend/espeak/api.py + wrapper.py, version 3.3.x):
 *   espeak_Initialize(AUDIO_OUTPUT_SYNCHRONOUS, 0, path, options)
 *   espeak_SetVoiceByName(identifier)            (once per voice change)
 *   while (textptr != NULL)
 *       espeak_TextToPhonemes(&textptr, espeakCHARS_UTF8, phonememode)
 *
 * All state lives in the global variables of libespeak-ng, i.e. in the
 * linear memory of one WebAssembly instance. One instance = one espeak
 * engine; calls on an instance must not overlap (they cannot in
 * single-threaded JS anyway; espeak itself is not reentrant).
 *
 * SPDX-License-Identifier: GPL-3.0-or-later (part of a work based on espeak-ng)
 */
#include <stdlib.h>
#include <string.h>

#include <espeak-ng/speak_lib.h>

#define CONDUIT_ERR_NOT_INITIALIZED (-1)
#define CONDUIT_ERR_VOICE (-2)
#define CONDUIT_ERR_NOMEM (-3)
#define CONDUIT_ERR_NO_PROGRESS (-4)
#define CONDUIT_ERR_ARG (-5)

static int initialized = 0;
static char current_voice[128];

/* result of the last conduit_phonemize call: clause outputs, each terminated by '\0' */
static char *result_buf = NULL;
static size_t result_len = 0;
static size_t result_cap = 0;
static int result_clauses = 0;

static int result_append(const char *s)
{
	size_t n = strlen(s) + 1; /* including the terminating NUL */
	if (result_len + n > result_cap) {
		size_t cap = result_cap ? result_cap : 4096;
		while (cap < result_len + n)
			cap *= 2;
		char *nb = (char *)realloc(result_buf, cap);
		if (nb == NULL)
			return 0;
		result_buf = nb;
		result_cap = cap;
	}
	memcpy(result_buf + result_len, s, n);
	result_len += n;
	result_clauses++;
	return 1;
}

/*
 * Initialise espeak. `path` is the espeak-ng-data directory (or its parent).
 * phonemizer passes options=0; we additionally set espeakINITIALIZE_DONT_EXIT
 * so that a broken data directory returns an error instead of calling exit()
 * inside the WebAssembly module. That flag only affects error handling
 * (espeak_api.c: it is not part of option_phoneme_events).
 * Returns the sample rate (> 0) on success, <= 0 on failure.
 */
int conduit_init(const char *path)
{
	if (initialized)
		return CONDUIT_ERR_ARG;
	int rate = espeak_Initialize(AUDIO_OUTPUT_SYNCHRONOUS, 0, path, espeakINITIALIZE_DONT_EXIT);
	if (rate > 0) {
		initialized = 1;
		current_voice[0] = 0;
	}
	return rate;
}

/*
 * Resolve a language code to a voice identifier exactly like
 * phonemizer.backend.espeak.wrapper.EspeakWrapper.set_voice(): walk
 * espeak_ListVoices(NULL) in order, the language of a voice is
 * voice->languages + 1 up to the first NUL (the leading byte is the
 * priority), and the first voice of a given language wins.
 * Writes the identifier into out. Returns its length, or < 0.
 */
int conduit_resolve_voice(const char *language, char *out, int outcap)
{
	if (!initialized)
		return CONDUIT_ERR_NOT_INITIALIZED;
	if (language == NULL || out == NULL || outcap <= 0)
		return CONDUIT_ERR_ARG;
	const espeak_VOICE **voices = espeak_ListVoices(NULL);
	if (voices == NULL)
		return CONDUIT_ERR_VOICE;
	for (int i = 0; voices[i] != NULL; i++) {
		const espeak_VOICE *v = voices[i];
		const char *lang = (v->languages != NULL && v->languages[0] != 0) ? v->languages + 1 : "";
		if (strcmp(lang, language) == 0) {
			size_t n = strlen(v->identifier);
			if ((int)n + 1 > outcap)
				return CONDUIT_ERR_ARG;
			memcpy(out, v->identifier, n + 1);
			return (int)n;
		}
	}
	return CONDUIT_ERR_VOICE;
}

/* Calls espeak_SetVoiceByName only when the voice changes (phonemizer sets the
 * voice once per backend; re-selecting it per call would reset translator
 * state that phonemizer keeps). Returns 0 on success. */
static int select_voice(const char *voice)
{
	if (voice == NULL || voice[0] == 0)
		return 0; /* keep the current voice */
	if (strlen(voice) >= sizeof(current_voice))
		return CONDUIT_ERR_ARG;
	if (strcmp(voice, current_voice) == 0)
		return 0;
	if (espeak_SetVoiceByName(voice) != EE_OK) {
		current_voice[0] = 0;
		return CONDUIT_ERR_VOICE;
	}
	strcpy(current_voice, voice);
	return 0;
}

/*
 * Phonemize a NUL-terminated UTF-8 text.
 *
 * Calls espeak_TextToPhonemes(&p, espeakCHARS_UTF8, phonememode) until p is
 * NULL, exactly like phonemizer's EspeakWrapper.text_to_phonemes(), and
 * writes the result the way phonemizer assembles it - the non-empty clause
 * outputs joined by single spaces - NUL-terminated into out[0..outcap)
 * (truncated if it does not fit). Returns the length of the joined string
 * without the NUL (> outcap - 1 means truncated: read the full result with
 * conduit_joined_ptr() instead of calling again, because espeak state
 * advances with every call), or < 0 on error.
 *
 * The raw output of every clause (a NULL result stored as ""), each followed
 * by '\0', stays available via conduit_result_ptr()/_len()/_clauses() until
 * the next call.
 */
static char *joined_buf = NULL;
static size_t joined_cap = 0;
static size_t joined_len = 0;

static int build_joined(void)
{
	/* the joined string is never longer than the clause buffer */
	size_t need = result_len + 1;
	if (need > joined_cap) {
		char *nb = (char *)realloc(joined_buf, need);
		if (nb == NULL)
			return 0;
		joined_buf = nb;
		joined_cap = need;
	}
	joined_len = 0;
	for (size_t off = 0; off < result_len;) {
		size_t n = strlen(result_buf + off);
		if (n > 0) { /* phonemizer: `if phonemes: result.append(...)`, then ' '.join */
			if (joined_len > 0)
				joined_buf[joined_len++] = ' ';
			memcpy(joined_buf + joined_len, result_buf + off, n);
			joined_len += n;
		}
		off += n + 1;
	}
	joined_buf[joined_len] = 0;
	return 1;
}

int conduit_phonemize(const char *utf8, const char *voice, int phonememode, char *out, int outcap)
{
	if (!initialized)
		return CONDUIT_ERR_NOT_INITIALIZED;
	if (utf8 == NULL || outcap < 0)
		return CONDUIT_ERR_ARG;
	int rc = select_voice(voice);
	if (rc != 0)
		return rc;

	result_len = 0;
	result_clauses = 0;
	joined_len = 0;

	const void *p = utf8;
	while (p != NULL) {
		const void *before = p;
		const char *ph = espeak_TextToPhonemes(&p, espeakCHARS_UTF8, phonememode);
		if (!result_append(ph != NULL ? ph : ""))
			return CONDUIT_ERR_NOMEM;
		/* espeak returns NULL without advancing only if decoding fails; phonemizer
		 * would loop forever there, we stop with an error instead. */
		if (ph == NULL && p == before)
			return CONDUIT_ERR_NO_PROGRESS;
	}
	if (!build_joined())
		return CONDUIT_ERR_NOMEM;

	if (out != NULL && outcap > 0) {
		size_t n = joined_len < (size_t)outcap - 1 ? joined_len : (size_t)outcap - 1;
		memcpy(out, joined_buf, n);
		out[n] = 0;
	}
	return (int)joined_len;
}

const char *conduit_joined_ptr(void) { return joined_buf; }
int conduit_joined_len(void) { return (int)joined_len; }
const char *conduit_result_ptr(void) { return result_buf; }
int conduit_result_len(void) { return (int)result_len; }
int conduit_result_clauses(void) { return result_clauses; }

const char *conduit_version(void)
{
	const char *path = NULL;
	return espeak_Info(&path);
}

void conduit_terminate(void)
{
	if (initialized)
		espeak_Terminate();
	initialized = 0;
	current_voice[0] = 0;
	free(result_buf);
	result_buf = NULL;
	result_len = result_cap = 0;
	free(joined_buf);
	joined_buf = NULL;
	joined_len = joined_cap = 0;
	result_clauses = 0;
}
