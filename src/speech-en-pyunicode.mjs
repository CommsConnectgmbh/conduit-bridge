// SPDX-License-Identifier: Apache-2.0
// Python (CPython 3.12, Unicode 15.0) string semantics needed by spaCy and
// misaki, built from tables exported by tools/export_spacy.py so that the
// behaviour does not depend on the ICU/Unicode version of the JS engine.
//
// All functions operate on code points, like Python str.

function buildSet(ranges) {
  // Sorted ranges -> fast membership via binary search, plus an ASCII bitmap.
  const starts = new Uint32Array(ranges.length);
  const ends = new Uint32Array(ranges.length);
  ranges.forEach(([a, b], i) => { starts[i] = a; ends[i] = b; });
  const ascii = new Uint8Array(128);
  for (let cp = 0; cp < 128; cp++) {
    let lo = 0, hi = ranges.length - 1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (cp < starts[m]) hi = m - 1; else if (cp > ends[m]) lo = m + 1; else { ascii[cp] = 1; break; }
    }
  }
  return (cp) => {
    if (cp < 128) return ascii[cp] === 1;
    let lo = 0, hi = starts.length - 1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (cp < starts[m]) hi = m - 1; else if (cp > ends[m]) lo = m + 1; else return true;
    }
    return false;
  };
}

function buildMap(obj) {
  const m = new Map();
  for (const k of Object.keys(obj)) m.set(Number(k), obj[k]);
  return m;
}

const CASED = /\p{Cased}/u;
const CASE_IGNORABLE = /\p{Case_Ignorable}/u;
const ASCII_RE = /^[\x00-\x7f]*$/;

export function createPyUnicode(data) {
  const isSpaceCp = buildSet(data.isspace);
  const isAlphaCp = buildSet(data.isalpha);
  const isDigitCp = buildSet(data.isdigit);
  const isUpperCp = buildSet(data.isupper);
  const isLowerCp = buildSet(data.islower);
  const lowerMap = buildMap(data.lower_map);
  const upperMap = buildMap(data.upper_map);
  const titleMap = buildMap(data.title_map);
  const digitValues = buildMap(data.digit_values);

  const all = (s, pred) => {
    if (s.length === 0) return false;
    for (const ch of s) if (!pred(ch.codePointAt(0))) return false;
    return true;
  };

  function isCasedCp(cp) { return CASED.test(String.fromCodePoint(cp)); }
  function isCaseIgnorableCp(cp) { return CASE_IGNORABLE.test(String.fromCodePoint(cp)); }

  function lower(s) {
    if (ASCII_RE.test(s)) return s.toLowerCase();
    const cps = Array.from(s, (c) => c.codePointAt(0));
    let out = '';
    for (let i = 0; i < cps.length; i++) {
      const cp = cps[i];
      if (cp === 0x3a3) {
        // CPython handle_capital_sigma (Final_Sigma context)
        let j = i - 1;
        while (j >= 0 && isCaseIgnorableCp(cps[j])) j--;
        let finalSigma = j >= 0 && isCasedCp(cps[j]);
        if (finalSigma && i + 1 < cps.length) {
          j = i + 1;
          while (j < cps.length && isCaseIgnorableCp(cps[j])) j++;
          finalSigma = j === cps.length || !isCasedCp(cps[j]);
        }
        out += finalSigma ? 'ς' : 'σ';
        continue;
      }
      const m = lowerMap.get(cp);
      out += m === undefined ? String.fromCodePoint(cp) : m;
    }
    return out;
  }

  function upper(s) {
    if (ASCII_RE.test(s)) return s.toUpperCase();
    let out = '';
    for (const ch of s) {
      const m = upperMap.get(ch.codePointAt(0));
      out += m === undefined ? ch : m;
    }
    return out;
  }

  // str.capitalize (Python >= 3.8): first char title-cased, rest lower-cased.
  function capitalize(s) {
    if (s.length === 0) return s;
    const first = String.fromCodePoint(s.codePointAt(0));
    const rest = s.slice(first.length);
    const t = titleMap.get(first.codePointAt(0));
    return (t === undefined ? first : t) + lower(rest);
  }

  // str.isupper / str.islower on whole strings (CPython semantics, using
  // per-char isupper/islower; titlecase chars are neither upper nor lower here,
  // matching CPython for all Lt letters).
  function isUpper(s) {
    let cased = false;
    for (const ch of s) {
      const cp = ch.codePointAt(0);
      if (isLowerCp(cp)) return false;
      if (isUpperCp(cp)) cased = true;
      else if (isCasedCp(cp) && !isLowerCp(cp)) return false; // titlecase
    }
    return cased;
  }

  // Body of a JS `u` character class equal to Python's re \s / \w / \d.
  const classBody = (name) => data[name].map(([a, b]) => (a === b ? `\\u{${a.toString(16)}}` : `\\u{${a.toString(16)}}-\\u{${b.toString(16)}}`)).join('');

  return {
    reS: classBody('re_s'),
    isSpaceCp, isAlphaCp, isDigitCp, isUpperCp, isLowerCp,
    isspace: (s) => all(s, isSpaceCp),
    isalpha: (s) => all(s, isAlphaCp),
    isdigit: (s) => all(s, isDigitCp),
    isUpper,
    lower, upper, capitalize,
    // unicodedata.numeric for isdigit() chars -> str(int(n)) or null
    digitValue: (cp) => (digitValues.has(cp) ? digitValues.get(cp) : undefined),
    // Python str.strip()/split() whitespace helpers
    strip(s, chars) {
      const arr = Array.from(s);
      const test = chars === undefined ? (c) => isSpaceCp(c.codePointAt(0)) : (c) => chars.includes(c);
      let a = 0, b = arr.length;
      while (a < b && test(arr[a])) a++;
      while (b > a && test(arr[b - 1])) b--;
      return arr.slice(a, b).join('');
    },
    lstrip(s) {
      const arr = Array.from(s);
      let a = 0;
      while (a < arr.length && isSpaceCp(arr[a].codePointAt(0))) a++;
      return arr.slice(a).join('');
    },
    rstrip(s) {
      const arr = Array.from(s);
      let b = arr.length;
      while (b > 0 && isSpaceCp(arr[b - 1].codePointAt(0))) b--;
      return arr.slice(0, b).join('');
    },
    split(s) {
      const out = [];
      let cur = '';
      for (const ch of s) {
        if (isSpaceCp(ch.codePointAt(0))) { if (cur) { out.push(cur); cur = ''; } } else cur += ch;
      }
      if (cur) out.push(cur);
      return out;
    },
  };
}
