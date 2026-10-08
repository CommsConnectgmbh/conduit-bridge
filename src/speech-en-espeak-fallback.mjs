// SPDX-License-Identifier: GPL-3.0-or-later
// Port of misaki.espeak.EspeakFallback (Apache-2.0) together with a
// translation of the parts of phonemizer 3.3.2 (Copyright 2015-2021 Mathieu
// Bernard, GPL-3.0-or-later, see licenses/phonemizer-GPL-3.0.txt) it relies on
// (Punctuation.preserve/restore, EspeakBackend._postprocess_line). Because of
// that, and because it only makes sense together with espeak-ng (GPL-3.0),
// this file is GPL-3.0-or-later; the rest of the package is not.
//   EspeakBackend(language='en-us', preserve_punctuation=True,
//                 with_stress=True, tie='^').phonemize([text])
//
// The only engine primitive needed is `textToPhonemes(text)`, which must
// return exactly what phonemizer's EspeakWrapper.text_to_phonemes(text, tie)
// returns: espeak_TextToPhonemes called repeatedly with
//   textmode = espeakCHARS_UTF8 (1)
//   phonememode = 0x02 | (1 << 7) | (0x0361 << 8)   (IPA, tie U+0361)
// and the clause results joined with ' '.

const DEFAULT_MARKS = ';:,.!?¡¿—…"«»“”(){}[]';

const E2M = Object.entries({
  'ʔˌn̩': 'ʔn', 'ʔn̩': 'ʔn',
  'a^ɪ': 'I', 'a^ʊ': 'W',
  'd^ʒ': 'ʤ',
  'e^ɪ': 'A', e: 'A',
  't^ʃ': 'ʧ',
  'ɔ^ɪ': 'Y',
  'ə^l': 'ᵊl',
  'ʲo': 'jo', 'ʲə': 'jə', 'ʲ': '',
  'ɚ': 'əɹ',
  r: 'ɹ',
  x: 'k', 'ç': 'k',
  'ɐ': 'ə',
  'ɬ': 'l',
  '̃': '',
}).sort((a, b) => [...b[0]].length - [...a[0]].length); // stable, like sorted(key=-len)

function escapeClass(s) {
  return [...s].map((c) => '\\u{' + c.codePointAt(0).toString(16) + '}').join('');
}

export function createPhonemizer({ textToPhonemes, py, marks = DEFAULT_MARKS }) {
  const S = py.reS;
  const marksRe = new RegExp(`(?:[${S}]*[${escapeClass(marks)}]+[${S}]*)+`, 'gu');
  const tie = '^';

  function preserveLine(line) {
    const matches = [...line.matchAll(marksRe)];
    if (!matches.length) return [[line], []];
    if (matches.length === 1 && matches[0][0] === line) return [[], [{ mark: line, position: 'A' }]];
    const ms = matches.map((m, k) => {
      let position = 'I';
      if (k === 0 && line.startsWith(m[0])) position = 'B';
      else if (k === matches.length - 1 && line.endsWith(m[0])) position = 'E';
      return { mark: m[0], position };
    });
    const out = [];
    for (const mk of ms) {
      const split = line.split(mk.mark);
      out.push(split[0]);
      line = split.slice(1).join(mk.mark);
    }
    out.push(line);
    return [out, ms];
  }

  function postprocessLine(line) {
    line = py.strip(line).replaceAll('\n', ' ').replaceAll('  ', ' ');
    line = line.replace(/_+/gu, '_').replace(/_ /gu, ' ');
    if (!line) return '';
    let out = '';
    for (let word of line.split(' ')) {
      word = py.strip(word);
      word = word.replaceAll('͡', tie);
      out += word + ' ';
    }
    return out;
  }

  function restore(text, marks) {
    // Punctuation.restore with sep.word=' ', strip=False, all marks on line 0
    text = [...text];
    marks = [...marks];
    const res = [];
    let pos = 0;
    while (text.length || marks.length) {
      if (!marks.length) {
        for (let line of text) {
          if (!line.endsWith(' ')) line += ' ';
          res.push(line);
        }
        text = [];
      } else if (!text.length) {
        res.push(marks.map((m) => m.mark).join(''));
        marks = [];
      } else {
        const cur = marks[0];
        if (pos === 0) {
          marks = marks.slice(1);
          const mark = cur.mark;
          if (text[0].endsWith(' ')) text[0] = text[0].slice(0, -1);
          if (cur.position === 'B') {
            text[0] = mark + text[0];
          } else if (cur.position === 'E') {
            res.push(text[0] + mark + (mark.endsWith(' ') ? '' : ' '));
            text = text.slice(1);
            pos += 1;
          } else if (cur.position === 'A') {
            res.push(mark + (mark.endsWith(' ') ? '' : ' '));
            pos += 1;
          } else if (text.length === 1) {
            text[0] = text[0] + mark;
          } else {
            const first = text[0];
            text = text.slice(1);
            text[0] = first + mark + text[0];
          }
        } else {
          res.push(text[0]);
          text = text.slice(1);
          pos += 1;
        }
      }
    }
    return res;
  }

  /** phonemizer EspeakBackend.phonemize([text]) -> list of str */
  return function phonemize(text) {
    const [lines0, marks] = preserveLine(text);
    const lines = lines0.filter((l) => l);
    const phonemized = lines.map((l) => postprocessLine(textToPhonemes(l)));
    return restore(phonemized, marks);
  };
}

/**
 * misaki EspeakFallback(british=False) as a `fallback(word) -> phonemes|null`.
 */
export function createEspeakFallback({ textToPhonemes, py, british = false, version = null }) {
  if (british) throw new Error('only en-us is implemented');
  const phonemize = createPhonemizer({ textToPhonemes, py });
  const syllabic = new RegExp(`([^${py.reS}])\\u0329`, 'gu');
  return function fallback(word) {
    let out;
    try {
      out = phonemize(word);
    } catch (e) {
      // espeak-ng crash on this input (native espeak segfaults, killing the
      // Python process): treat the word as unpronounceable instead.
      if (e && e.code === 'ESPEAK_CRASH') return null;
      throw e;
    }
    if (!out.length) return null;
    let ps = py.strip(out[0]);
    for (const [o, n] of E2M) ps = ps.replaceAll(o, n);
    ps = ps.replace(syllabic, 'ᵊ$1').replaceAll('̩', '');
    ps = ps.replaceAll('o^ʊ', 'O');
    ps = ps.replaceAll('ɜːɹ', 'ɜɹ');
    ps = ps.replaceAll('ɜː', 'ɜɹ');
    ps = ps.replaceAll('ɪə', 'iə');
    ps = ps.replaceAll('ː', '');
    ps = ps.replaceAll('o', 'ɔ');
    if (version !== '2.0') ps = ps.replaceAll('ɾ', 'T').replaceAll('ʔ', 't');
    return ps.replaceAll('^', '');
  };
}
