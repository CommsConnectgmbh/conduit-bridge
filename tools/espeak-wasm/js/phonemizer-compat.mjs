// Port of the post-processing that the Python library `phonemizer` (3.3.x)
// applies around espeak_TextToPhonemes for
//
//   EspeakBackend(language, preserve_punctuation=True, with_stress=True,
//                 tie='^', language_switch='remove-flags')
//   .phonemize([text])            # separator=default, strip=False, njobs=1
//
// Source files ported (phonemizer 3.3.2): punctuation.py (Punctuation with
// the default marks: preserve/restore), backend/espeak/wrapper.py
// (text_to_phonemes: join of non-empty clause outputs with ' '),
// backend/espeak/espeak.py (_postprocess_line, _process_tie),
// backend/espeak/language_switch.py (RemoveFlags). Python string semantics
// (str.strip, the re module's \s and '.') are reproduced exactly; see the
// helpers below.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Python's str.isspace() / re's \s for str patterns (identical sets, checked
// against CPython 3.12 for all code points). JS \s differs: it lacks
// U+001C..U+001F and U+0085 and adds U+FEFF.
const PY_WS = '\\t\\n\\u000B\\f\\r\\u001C-\\u001F \\u0085\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000';
const PY_WS_SET = new Set([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0, 0x1680,
  0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a,
  0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]);

/** Python str.strip() without arguments (all PY_WS chars are BMP). */
export function pyStrip(s) {
  let a = 0;
  let b = s.length;
  while (a < b && PY_WS_SET.has(s.charCodeAt(a))) a++;
  while (b > a && PY_WS_SET.has(s.charCodeAt(b - 1))) b--;
  return a === 0 && b === s.length ? s : s.slice(a, b);
}

/** phonemizer.punctuation._DEFAULT_MARKS */
export const DEFAULT_MARKS = ';:,.!?¡¿—…"«»“”(){}[]';

function escapeForClass(ch) {
  return /[\\\]\[^\-]/.test(ch) ? '\\' + ch : ch;
}

// re.compile(fr'(\s*[{re.escape(marks)}]+\s*)+'). Python builds the class
// from ''.join(set(marks)); order inside a character class is irrelevant.
function marksRegex(marks) {
  const cls = [...new Set([...marks])].map(escapeForClass).join('');
  return new RegExp(`(?:[${PY_WS}]*[${cls}]+[${PY_WS}]*)+`, 'gu');
}

const DEFAULT_MARKS_RE = marksRegex(DEFAULT_MARKS);

/** Punctuation._preserve_line(line, num) -> [chunks, marks] */
function preserveLine(line, num, marksRe) {
  marksRe.lastIndex = 0;
  const matches = [...line.matchAll(marksRe)].map((m) => m[0]);
  if (matches.length === 0) return [[line], []];

  // the line is made only of punctuation marks
  if (matches.length === 1 && matches[0] === line) return [[], [{ index: num, mark: line, position: 'A' }]];

  const marks = [];
  matches.forEach((group, i) => {
    // `match == matches[0]` in Python compares match objects by identity
    let position = 'I';
    if (i === 0 && line.startsWith(group)) position = 'B';
    else if (i === matches.length - 1 && line.endsWith(group)) position = 'E';
    marks.push({ index: num, mark: group, position });
  });

  const preserved = [];
  for (const mark of marks) {
    // split = line.split(mark.mark); prefix, suffix = split[0], mark.join(split[1:])
    const at = line.indexOf(mark.mark);
    if (at < 0) {
      preserved.push(line);
      line = '';
    } else {
      preserved.push(line.slice(0, at));
      line = line.slice(at + mark.mark.length);
    }
  }
  preserved.push(line);
  return [preserved, marks];
}

/** Punctuation.preserve(list_of_lines) */
export function preservePunctuation(lines, marksRe = DEFAULT_MARKS_RE) {
  let text = [];
  let marks = [];
  lines.forEach((line, num) => {
    const [t, m] = preserveLine(line, num, marksRe);
    text = text.concat(t);
    marks = marks.concat(m);
  });
  return [text.filter((l) => l), marks];
}

/** Punctuation.restore(text, marks, sep, strip) */
export function restorePunctuation(text, marks, sepWord = ' ', strip = false) {
  text = text.slice();
  marks = marks.slice();
  const out = [];
  let pos = 0;
  const sub = (s) => s.split(' ').join(sepWord); // re.sub(' ', sep.word, s)
  while (text.length || marks.length) {
    if (!marks.length) {
      for (let line of text) {
        if (!strip && sepWord && !line.endsWith(sepWord)) line = line + sepWord;
        out.push(line);
      }
      text = [];
    } else if (!text.length) {
      out.push(sub(marks.map((m) => m.mark).join('')));
      marks = [];
    } else {
      const current = marks[0];
      if (current.index === pos) {
        marks = marks.slice(1);
        const mark = sub(current.mark);
        if (sepWord && text[0].endsWith(sepWord)) text[0] = text[0].slice(0, text[0].length - sepWord.length);
        if (current.position === 'B') {
          text[0] = mark + text[0];
        } else if (current.position === 'E') {
          out.push(text[0] + mark + (strip || mark.endsWith(sepWord) ? '' : sepWord));
          text = text.slice(1);
          pos += 1;
        } else if (current.position === 'A') {
          out.push(mark + (strip || mark.endsWith(sepWord) ? '' : sepWord));
          pos += 1;
        } else if (text.length === 1) {
          text[0] = text[0] + mark;
        } else {
          const first = text[0];
          text = text.slice(1);
          text[0] = first + mark + text[0];
        }
      } else {
        out.push(text[0]);
        text = text.slice(1);
        pos += 1;
      }
    }
  }
  return out;
}

// '.' in Python matches everything except '\n' (JS '.' also excludes \r, U+2028, U+2029)
const FLAGS_RE = /\([^\n]+?\)/gu;

/**
 * EspeakBackend._postprocess_line for with_stress=True, tie='^',
 * language_switch='remove-flags', separator=default (word ' ', phone ''),
 * strip=False. Returns [line, hasSwitch].
 */
export function postprocessLine(line, tieChar = '^', sepWord = ' ') {
  line = pyStrip(line).replaceAll('\n', ' ').replaceAll('  ', ' ');
  line = line.replace(/_+/g, '_');
  line = line.replaceAll('_ ', ' ');
  FLAGS_RE.lastIndex = 0;
  const hasSwitch = FLAGS_RE.test(line);
  if (hasSwitch) line = line.replace(FLAGS_RE, '');
  if (!line) return ['', hasSwitch];
  let out = '';
  for (let word of line.split(' ')) {
    word = pyStrip(word); // _process_stress: with_stress=True keeps stresses
    // strip=False but tie is set: no '_' appended
    word = tieChar !== '͡' ? word.replaceAll('͡', tieChar) : word.replaceAll('_', '');
    out += word + sepWord;
  }
  return [out, hasSwitch];
}

/** EspeakWrapper.text_to_phonemes: join the non-empty clause outputs with ' ' */
export function joinClauses(clauses) {
  return clauses.filter((c) => c).join(' ');
}

/**
 * Full equivalent of
 *   EspeakBackend(lang, preserve_punctuation=True, with_stress=True, tie='^',
 *                 language_switch='remove-flags').phonemize([text])
 * given a function that returns the raw clause outputs of
 * espeak_TextToPhonemes (tie mode U+0361) for one chunk on the same engine.
 */
export function phonemizeLikePythonPhonemizerWith(clausesOf, text) {
  const [chunks, marks] = preservePunctuation([text]);
  const phonemized = chunks.map((chunk) => postprocessLine(joinClauses(clausesOf(chunk)))[0]);
  return restorePunctuation(phonemized, marks, ' ', false);
}
