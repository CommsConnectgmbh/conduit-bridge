/*
 * Diagnostic driver: phonemizer-style espeak_TextToPhonemes loop over texts.
 * usage: ttp_driver <datadir|-> <voice-identifier> <mode:int> <texts-file>
 * texts-file: texts separated by '\0' bytes. Output: per text one line with
 * the clause outputs separated by 0x1f, escaped (\n -> \\n, \\ -> \\\\).
 * Built natively (optionally with -fsanitize=address,undefined) against the
 * same libespeak-ng sources, to localise differences.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <espeak-ng/speak_lib.h>

static void put_escaped(const char *s)
{
	for (; *s; s++) {
		if (*s == '\n') fputs("\\n", stdout);
		else if (*s == '\\') fputs("\\\\", stdout);
		else putchar(*s);
	}
}

int main(int argc, char **argv)
{
	if (argc != 5) return 2;
	const char *data = strcmp(argv[1], "-") == 0 ? NULL : argv[1];
	if (espeak_Initialize(AUDIO_OUTPUT_SYNCHRONOUS, 0, data, 0) <= 0) return 3;
	if (espeak_SetVoiceByName(argv[2]) != EE_OK) return 4;
	int mode = atoi(argv[3]);
	FILE *f = fopen(argv[4], "rb");
	if (!f) return 5;
	fseek(f, 0, SEEK_END);
	long n = ftell(f);
	fseek(f, 0, SEEK_SET);
	char *buf = malloc(n + 1);
	fread(buf, 1, n, f);
	buf[n] = 0;
	fclose(f);
	char *p = buf;
	while (p < buf + n) {
		const void *t = p;
		int first = 1;
		while (t != NULL) {
			const char *ph = espeak_TextToPhonemes(&t, espeakCHARS_UTF8, mode);
			if (!first) putchar(0x1f);
			first = 0;
			put_escaped(ph ? ph : "");
		}
		putchar('\n');
		fflush(stdout);
		p += strlen(p) + 1;
	}
	espeak_Terminate();
	return 0;
}
