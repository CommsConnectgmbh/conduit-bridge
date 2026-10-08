// SPDX-License-Identifier: Apache-2.0
// Port of misaki 0.9.4 en.py (Apache-2.0, Copyright hexgrad) to JavaScript.
// Mirrors en.G2P(trf=False, british=False, fallback=<fallback>, unk='') as used
// by kokoro.KPipeline(lang_code='a'). Python string semantics come from
// pyunicode.mjs; spaCy tokenization/tagging from spacy-*.mjs.

import { num2words } from './speech-en-num2words.mjs';

// ------------------------------------------------------------------ consts --
const DIPHTHONGS = new Set('AIOQWYʤʧ');
const SUBTOKEN_JUNKS = new Set("',-._‘’/");
const PUNCTS = new Set(';:,.!?—…"“”');
const NON_QUOTE_PUNCTS = new Set([...PUNCTS].filter((p) => !'"“”'.includes(p)));
const PUNCT_TAGS = new Set(['.', ',', '-LRB-', '-RRB-', '``', '""', "''", ':', '$', '#', 'NFP']);
const PUNCT_TAG_PHONEMES = { '-LRB-': '(', '-RRB-': ')', '``': '“', '""': '”', "''": '”' };
const LEXICON_ORDS = new Set([39, 45, ...range(65, 91), ...range(97, 123)]);
const CONSONANTS = new Set('bdfhjklmnpstvwzðŋɡɹɾʃʒʤʧθ');
const US_TAUS = new Set('AIOWYiuæɑəɛɪɹʊʌ');
const CURRENCIES = { $: ['dollar', 'cent'], '£': ['pound', 'pence'], '€': ['euro', 'cent'] };
const ORDINALS = new Set(['st', 'nd', 'rd', 'th']);
const ADD_SYMBOLS = { '.': 'dot', '/': 'slash' };
const SYMBOLS = { '%': 'percent', '&': 'and', '+': 'plus', '@': 'at' };
const US_VOCAB = new Set('AIOWYbdfhijklmnpstuvwzæðŋɑɔəɛɜɡɪɹɾʃʊʌʒʤʧˈˌθᵊᵻʔ');
const GB_VOCAB = new Set('AIQWYabdfhijklmnpstuvwzðŋɑɒɔəɛɜɡɪɹʃʊʌʒʤʧˈˌːθᵊ');
const PRIMARY_STRESS = 'ˈ';
const SECONDARY_STRESS = 'ˌ';
const STRESSES = new Set([SECONDARY_STRESS, PRIMARY_STRESS]);
const VOWELS = new Set('AIOQWYaiuæɑɒɔəɛɜɪʊʌᵻ');

const LINK_REGEX = /\[([^\]]+)\]\(([^)]*)\)/gu;
// misaki make_subtokenize_once (python `regex`): \d -> \p{Nd}
const SUBTOKEN_REGEX = /^['‘’]+|\p{Lu}(?=\p{Lu}\p{Ll})|(?:^-)?(?:\p{Nd}?[,.]?\p{Nd})+|[-_]+|['‘’]{2,}|\p{L}*?(?:['‘’]\p{L})*?\p{Ll}(?=\p{Lu})|\p{L}+(?:['‘’]\p{L})*|[^-_\p{L}'‘’\p{Nd}]|['‘’]+$/gu;

function* range(a, b) { for (let i = a; i < b; i++) yield i; }
const has = (obj, k) => k !== null && k !== undefined && Object.hasOwn(obj, k);
const cpLen = (s) => { let n = 0; for (const _ of s) n++; return n; };
const cps = (s) => Array.from(s);
const isDigitStr = (t) => /^[0-9]+$/.test(t); // misaki is_digit: re.match(r'^[0-9]+$')

export function subtokenize(word) {
  return word.match(SUBTOKEN_REGEX) || [];
}

export function applyStress(ps, stress) {
  const restress = (p) => {
    // move every stress mark directly before the next vowel
    const chars = cps(p);
    const items = chars.map((c, i) => [i, c]);
    for (let i = 0; i < chars.length; i++) {
      if (STRESSES.has(chars[i])) {
        let j = i;
        while (j < chars.length && !VOWELS.has(chars[j])) j++;
        if (j === chars.length) throw new Error('StopIteration in restress'); // as Python
        items[i] = [j - 0.5, chars[i]];
      }
    }
    items.sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
    return items.map((x) => x[1]).join('');
  };
  if (stress === null || stress === undefined) return ps;
  if (ps === null || ps === undefined) throw new TypeError("argument of type 'NoneType' is not iterable");
  const hasAny = (s) => [...STRESSES].some((x) => s.includes(x));
  if (stress < -1) return ps.replaceAll(PRIMARY_STRESS, '').replaceAll(SECONDARY_STRESS, '');
  if (stress === -1 || ((stress === 0 || stress === -0.5) && ps.includes(PRIMARY_STRESS))) {
    return ps.replaceAll(SECONDARY_STRESS, '').replaceAll(PRIMARY_STRESS, SECONDARY_STRESS);
  }
  if ((stress === 0 || stress === 0.5 || stress === 1) && !hasAny(ps)) {
    if (![...VOWELS].some((v) => ps.includes(v))) return ps;
    return restress(SECONDARY_STRESS + ps);
  }
  if (stress >= 1 && !ps.includes(PRIMARY_STRESS) && ps.includes(SECONDARY_STRESS)) {
    return ps.replaceAll(SECONDARY_STRESS, PRIMARY_STRESS);
  }
  if (stress > 1 && !hasAny(ps)) {
    if (![...VOWELS].some((v) => ps.includes(v))) return ps;
    return restress(PRIMARY_STRESS + ps);
  }
  return ps;
}

function stressWeight(ps) {
  if (!ps) return 0;
  let n = 0;
  for (const c of ps) n += DIPHTHONGS.has(c) ? 2 : 1;
  return n;
}

// ------------------------------------------------------------------ tokens --
function makeToken(text, tag, whitespace, extra = {}) {
  return {
    text, tag, whitespace, phonemes: null, rating: undefined,
    _: { is_head: true, alias: null, stress: null, currency: null, num_flags: '', prespace: false, rating: null, ...extra },
  };
}
const cloneTok = (tk, over = {}) => ({ ...tk, ...over, _: over._ ? over._ : tk._ });

export class Lexicon {
  constructor({ golds, silvers, py, british = false }) {
    this.py = py;
    this.british = british;
    this.capStresses = [0.5, 2];
    this.golds = Lexicon.growDictionary(golds, py);
    this.silvers = Lexicon.growDictionary(silvers, py);
    const vocab = british ? GB_VOCAB : US_VOCAB;
    for (const vs of this.golds.values()) {
      if (typeof vs === 'string') {
        for (const c of vs) if (!vocab.has(c)) throw new Error('bad phoneme in lexicon: ' + vs);
      } else {
        if (!has(vs, 'DEFAULT')) throw new Error('lexicon entry without DEFAULT');
        for (const v of Object.values(vs)) if (v !== null) for (const c of v) if (!vocab.has(c)) throw new Error('bad phoneme ' + v);
      }
    }
  }

  // misaki Lexicon.grow_dictionary: {**e, **d} where e adds Capitalized
  // variants of lowercase keys and lowercase variants of Capitalized keys.
  static growDictionary(d, py) {
    const e = new Map();
    for (const k in d) {
      if (k.length < 2 && cpLen(k) < 2) continue;
      const kl = py.lower(k);
      if (k === kl) {
        const kc = py.capitalize(k);
        if (k !== kc) e.set(kc, d[k]);
      } else if (k === py.capitalize(kl)) {
        e.set(kl, d[k]);
      }
    }
    for (const k in d) e.set(k, d[k]);
    return e;
  }

  getNNP(word) {
    const py = this.py;
    const parts = [];
    for (const c of word) {
      if (!py.isAlphaCp(c.codePointAt(0))) continue;
      const v = this.golds.get(py.upper(c));
      if (v === undefined || v === null) return [null, null];
      parts.push(v);
    }
    let ps = applyStress(parts.join(''), 0);
    const k = ps.lastIndexOf(SECONDARY_STRESS);
    if (k >= 0) ps = ps.slice(0, k) + PRIMARY_STRESS + ps.slice(k + 1);
    return [ps, 3];
  }

  getSpecialCase(word, tag, stress, ctx) {
    const py = this.py;
    if (tag === 'ADD' && has(ADD_SYMBOLS, word)) return this.lookup(ADD_SYMBOLS[word], null, -0.5, ctx);
    if (has(SYMBOLS, word)) return this.lookup(SYMBOLS[word], null, null, ctx);
    if (py.strip(word, '.').includes('.') && py.isalpha(word.replaceAll('.', ''))) {
      let longest = '';
      let longestLen = -1;
      for (const part of word.split('.')) { const l = cpLen(part); if (l > longestLen) { longest = part; longestLen = l; } }
      if (longestLen < 3) return this.getNNP(word);
    }
    if (word === 'a' || word === 'A') return [tag === 'DT' ? 'ɐ' : 'ˈA', 4];
    if (word === 'am' || word === 'Am' || word === 'AM') {
      if (tag.startsWith('NN')) return this.getNNP(word);
      if (ctx.future_vowel === null || word !== 'am' || (stress && stress > 0)) return [this.golds.get('am'), 4];
      return ['ɐm', 4];
    }
    if (word === 'an' || word === 'An' || word === 'AN') {
      if (word === 'AN' && tag.startsWith('NN')) return this.getNNP(word);
      return ['ɐn', 4];
    }
    if (word === 'I' && tag === 'PRP') return [SECONDARY_STRESS + 'I', 4];
    if ((word === 'by' || word === 'By' || word === 'BY') && Lexicon.getParentTag(tag) === 'ADV') return ['bˈI', 4];
    if (word === 'to' || word === 'To' || (word === 'TO' && (tag === 'TO' || tag === 'IN'))) {
      const fv = ctx.future_vowel;
      return [fv === null ? this.golds.get('to') : fv === false ? 'tə' : 'tʊ', 4];
    }
    if (word === 'in' || word === 'In' || (word === 'IN' && tag !== 'NNP')) {
      const s = ctx.future_vowel === null || tag !== 'IN' ? PRIMARY_STRESS : '';
      return [s + 'ɪn', 4];
    }
    if (word === 'the' || word === 'The' || (word === 'THE' && tag === 'DT')) return [ctx.future_vowel === true ? 'ði' : 'ðə', 4];
    if (tag === 'IN' && /^vs\.?(?=\n?$)/iu.test(word)) return this.lookup('versus', null, null, ctx);
    if (word === 'used' || word === 'Used' || word === 'USED') {
      if ((tag === 'VBD' || tag === 'JJ') && ctx.future_to) return [this.golds.get('used').VBD, 4];
      return [this.golds.get('used').DEFAULT, 4];
    }
    return [null, null];
  }

  static getParentTag(tag) {
    if (tag === null || tag === undefined) return tag;
    if (tag.startsWith('VB')) return 'VERB';
    if (tag.startsWith('NN')) return 'NOUN';
    if (tag.startsWith('ADV') || tag.startsWith('RB')) return 'ADV';
    if (tag.startsWith('ADJ') || tag.startsWith('JJ')) return 'ADJ';
    return tag;
  }

  isKnown(word, tag) {
    const py = this.py;
    if (this.golds.has(word) || has(SYMBOLS, word) || this.silvers.has(word)) return true;
    if (!py.isalpha(word) || ![...word].every((c) => LEXICON_ORDS.has(c.codePointAt(0)))) return false;
    if (cpLen(word) === 1) return true;
    if (word === py.upper(word) && this.golds.has(py.lower(word))) return true;
    const rest = cps(word).slice(1).join('');
    return rest === py.upper(rest);
  }

  lookup(word, tag, stress, ctx) {
    const py = this.py;
    let isNNP = null;
    if (word === py.upper(word) && !this.golds.has(word)) {
      word = py.lower(word);
      isNNP = tag === 'NNP';
    }
    let ps = this.golds.has(word) ? this.golds.get(word) : null;
    let rating = 4;
    if (ps === null && !isNNP) {
      ps = this.silvers.has(word) ? this.silvers.get(word) : null;
      rating = 3;
    }
    if (ps !== null && typeof ps === 'object') {
      if (ctx && ctx.future_vowel === null && has(ps, 'None')) tag = 'None';
      else if (!has(ps, tag)) tag = Lexicon.getParentTag(tag);
      ps = has(ps, tag) ? ps[tag] : ps.DEFAULT;
    }
    if (ps === null || (isNNP && !ps.includes(PRIMARY_STRESS))) {
      const [p2, r2] = this.getNNP(word);
      if (p2 !== null) return [p2, r2];
      // Python: ps, rating = get_NNP(word) -> (None, None) falls through
      return [applyStress(null, stress), null];
    }
    return [applyStress(ps, stress), rating];
  }

  _s(stem) {
    if (!stem) return null;
    const last = stem[stem.length - 1];
    if ('ptkfθ'.includes(last)) return stem + 's';
    if ('szʃʒʧʤ'.includes(last)) return stem + (this.british ? 'ɪ' : 'ᵻ') + 'z';
    return stem + 'z';
  }

  stemS(word, tag, stress, ctx) {
    const n = cpLen(word);
    if (n < 3 || !word.endsWith('s')) return [null, null];
    let stem;
    if (!word.endsWith('ss') && this.isKnown(word.slice(0, -1), tag)) stem = word.slice(0, -1);
    else if ((word.endsWith("'s") || (n > 4 && word.endsWith('es') && !word.endsWith('ies'))) && this.isKnown(word.slice(0, -2), tag)) stem = word.slice(0, -2);
    else if (n > 4 && word.endsWith('ies') && this.isKnown(word.slice(0, -3) + 'y', tag)) stem = word.slice(0, -3) + 'y';
    else return [null, null];
    const [st, rating] = this.lookup(stem, tag, stress, ctx);
    return [this._s(st), rating];
  }

  _ed(stem) {
    if (!stem) return null;
    const last = stem[stem.length - 1];
    if ('pkfθʃsʧ'.includes(last)) return stem + 't';
    if (last === 'd') return stem + (this.british ? 'ɪ' : 'ᵻ') + 'd';
    if (last !== 't') return stem + 'd';
    if (this.british || cpLen(stem) < 2) return stem + 'ɪd';
    if (US_TAUS.has(stem[stem.length - 2])) return stem.slice(0, -1) + 'ɾᵻd';
    return stem + 'ᵻd';
  }

  stemEd(word, tag, stress, ctx) {
    const n = cpLen(word);
    if (n < 4 || !word.endsWith('d')) return [null, null];
    let stem;
    if (!word.endsWith('dd') && this.isKnown(word.slice(0, -1), tag)) stem = word.slice(0, -1);
    else if (n > 4 && word.endsWith('ed') && !word.endsWith('eed') && this.isKnown(word.slice(0, -2), tag)) stem = word.slice(0, -2);
    else return [null, null];
    const [st, rating] = this.lookup(stem, tag, stress, ctx);
    return [this._ed(st), rating];
  }

  _ing(stem) {
    if (!stem) return null;
    if (this.british) {
      if ('əː'.includes(stem[stem.length - 1])) return null;
    } else if (cpLen(stem) > 1 && stem[stem.length - 1] === 't' && US_TAUS.has(stem[stem.length - 2])) {
      return stem.slice(0, -1) + 'ɾɪŋ';
    }
    return stem + 'ɪŋ';
  }

  stemIng(word, tag, stress, ctx) {
    const n = cpLen(word);
    if (n < 5 || !word.endsWith('ing')) return [null, null];
    let stem;
    if (n > 5 && this.isKnown(word.slice(0, -3), tag)) stem = word.slice(0, -3);
    else if (this.isKnown(word.slice(0, -3) + 'e', tag)) stem = word.slice(0, -3) + 'e';
    else if (n > 5 && /([bcdgklmnprstvxz])\1ing$|cking$/u.test(word) && this.isKnown(word.slice(0, -4), tag)) stem = word.slice(0, -4);
    else return [null, null];
    const [st, rating] = this.lookup(stem, tag, stress, ctx);
    return [this._ing(st), rating];
  }

  getWord(word, tag, stress, ctx) {
    const py = this.py;
    const [sps, srating] = this.getSpecialCase(word, tag, stress, ctx);
    if (sps !== null && sps !== undefined) return [sps, srating];
    const wl = py.lower(word);
    if (cpLen(word) > 1 && py.isalpha(word.replaceAll("'", '')) && word !== wl
      && (tag !== 'NNP' || cpLen(word) > 7)
      && !this.golds.has(word) && !this.silvers.has(word)) {
      const rest = cps(word).slice(1).join('');
      if ((word === py.upper(word) || rest === py.lower(rest))
        && (this.golds.has(wl) || this.silvers.has(wl)
          || this.stemS(wl, tag, stress, ctx)[0] || this.stemEd(wl, tag, stress, ctx)[0] || this.stemIng(wl, tag, stress, ctx)[0])) {
        word = wl;
      }
    }
    if (this.isKnown(word, tag)) return this.lookup(word, tag, stress, ctx);
    if (word.endsWith("s'") && this.isKnown(word.slice(0, -2) + "'s", tag)) return this.lookup(word.slice(0, -2) + "'s", tag, stress, ctx);
    if (word.endsWith("'") && this.isKnown(word.slice(0, -1), tag)) return this.lookup(word.slice(0, -1), tag, stress, ctx);
    let r = this.stemS(word, tag, stress, ctx);
    if (r[0] !== null && r[0] !== undefined) return r;
    r = this.stemEd(word, tag, stress, ctx);
    if (r[0] !== null && r[0] !== undefined) return r;
    r = this.stemIng(word, tag, stress === null ? 0.5 : stress, ctx);
    if (r[0] !== null && r[0] !== undefined) return r;
    return [null, null];
  }

  static isCurrency(word) {
    if (!word.includes('.')) return true;
    if (word.split('.').length - 1 > 1) return false;
    const cents = word.split('.')[1];
    return cpLen(cents) < 3; // set(cents) == {0} is never true in misaki
  }

  getNumber(word, currency, isHead, numFlags) {
    const m = /[a-z']+$/u.exec(word);
    const suffix = m ? m[0] : null;
    if (suffix) word = word.slice(0, word.length - suffix.length);
    const result = [];
    if (word.startsWith('-')) {
      result.push(this.lookup('minus', null, null, null));
      word = word.slice(1);
    }
    const extendNum = (num, first = true, escape = false) => {
      const text = escape ? num : num2words(BigInt(num));
      const splits = text.split(/[^a-z]+/u);
      splits.forEach((w, i) => {
        if (w !== 'and' || numFlags.includes('&')) {
          if (first && i === 0 && splits.length > 1 && w === 'one' && numFlags.includes('a')) result.push(['ə', 4]);
          else result.push(this.lookup(w, null, w === 'point' ? -2 : null, null));
        } else if (w === 'and' && numFlags.includes('n') && result.length) {
          const last = result[result.length - 1];
          result[result.length - 1] = [last[0] + 'ən', last[1]];
        }
      });
    };
    const pyInt = (s) => {
      // Python int(str): digits (ASCII here), optional sign, underscores not expected
      if (!/^[+-]?[0-9]+$/.test(s)) throw new Error(`ValueError: invalid literal for int() with base 10: '${s}'`);
      return BigInt(s);
    };
    if (isDigitStr(word) && ORDINALS.has(suffix)) {
      extendNum(num2words(pyInt(word), 'ordinal'), true, true);
    } else if (!result.length && cpLen(word) === 4 && !has(CURRENCIES, currency) && isDigitStr(word)) {
      extendNum(num2words(pyInt(word), 'year'), true, true);
    } else if (!isHead && !word.includes('.')) {
      const num = word.replaceAll(',', '');
      if (num[0] === '0' || cpLen(num) > 3) {
        for (const n of num) extendNum(n, false);
      } else if (cpLen(num) === 3 && !num.endsWith('00')) {
        extendNum(num[0]);
        if (num[1] === '0') {
          result.push(this.lookup('O', null, -2, null));
          extendNum(num[2], false);
        } else {
          extendNum(num.slice(1), false);
        }
      } else {
        extendNum(num);
      }
    } else if (word.split('.').length - 1 > 1 || !isHead) {
      let first = true;
      for (const num of word.replaceAll(',', '').split('.')) {
        if (!num) { /* pass */ } else if (num[0] === '0' || (cpLen(num) !== 2 && [...num.slice(1)].some((n) => n !== '0'))) {
          for (const n of num) extendNum(n, false);
        } else {
          extendNum(num, first);
        }
        first = false;
      }
    } else if (has(CURRENCIES, currency) && Lexicon.isCurrency(word)) {
      const units = CURRENCIES[currency];
      const nums = word.replaceAll(',', '').split('.');
      let pairs = [];
      for (let i = 0; i < Math.min(nums.length, units.length); i++) pairs.push([nums[i] ? pyInt(nums[i]) : 0n, units[i]]);
      if (pairs.length > 1) {
        if (pairs[1][0] === 0n) pairs = pairs.slice(0, 1);
        else if (pairs[0][0] === 0n) pairs = pairs.slice(1);
      }
      pairs.forEach(([num, unit], i) => {
        if (i > 0) result.push(this.lookup('and', null, null, null));
        extendNum(num, i === 0);
        const absn = num < 0n ? -num : num;
        result.push(absn !== 1n && unit !== 'pence' ? this.stemS(unit + 's', null, null, null) : this.lookup(unit, null, null, null));
      });
    } else {
      let w;
      if (isDigitStr(word)) w = num2words(pyInt(word), 'cardinal');
      else if (!word.includes('.')) w = num2words(pyInt(word.replaceAll(',', '')), ORDINALS.has(suffix) ? 'ordinal' : 'cardinal');
      else {
        w = word.replaceAll(',', '');
        if (w[0] === '.') w = 'point ' + [...w.slice(1)].map((n) => num2words(pyInt(n))).join(' ');
        else w = num2words(pyFloat(w));
      }
      word = w;
      extendNum(w, true, true);
    }
    if (!result.length) return [null, null];
    for (const [p] of result) if (p === null || p === undefined) throw new TypeError('sequence item: expected str instance, NoneType found');
    const res = result.map((x) => x[0]).join(' ');
    let rating = Infinity;
    for (const [, r] of result) {
      if (r === null || r === undefined) throw new TypeError("'<' not supported between instances of 'NoneType' and 'int'");
      if (r < rating) rating = r;
    }
    if (suffix === 's' || suffix === "'s") return [this._s(res), rating];
    if (suffix === 'ed' || suffix === "'d") return [this._ed(res), rating];
    if (suffix === 'ing') return [this._ing(res), rating];
    return [res, rating];
  }

  appendCurrency(ps, currency) {
    if (!currency) return ps;
    const c = has(CURRENCIES, currency) ? CURRENCIES[currency] : null;
    const cs = c ? this.stemS(c[0] + 's', null, null, null)[0] : null;
    return cs ? `${ps} ${cs}` : ps;
  }

  numericIfNeeded(c) {
    const cp = c.codePointAt(0);
    if (!this.py.isDigitCp(cp)) return c;
    const v = this.py.digitValue(cp);
    return v === null || v === undefined ? c : v;
  }

  static isNumber(word, isHead) {
    if ([...word].every((c) => !isDigitStr(c))) return false;
    for (const s of ['ing', "'d", 'ed', "'s", 'st', 'nd', 'rd', 'th', 's']) {
      if (word.endsWith(s)) { word = word.slice(0, word.length - s.length); break; }
    }
    return [...word].every((c, i) => isDigitStr(c) || c === ',' || c === '.' || (isHead && i === 0 && c === '-'));
  }

  call(tk, ctx) {
    const py = this.py;
    let word = (tk._.alias === null || tk._.alias === undefined ? tk.text : tk._.alias).replaceAll('‘', "'").replaceAll('’', "'");
    word = word.normalize('NFKC');
    word = [...word].map((c) => this.numericIfNeeded(c)).join('');
    const stress = word === py.lower(word) ? null : this.capStresses[word === py.upper(word) ? 1 : 0];
    let [ps, rating] = this.getWord(word, tk.tag, stress, ctx);
    if (ps !== null && ps !== undefined) return [applyStress(this.appendCurrency(ps, tk._.currency), tk._.stress), rating];
    if (Lexicon.isNumber(word, tk._.is_head)) {
      [ps, rating] = this.getNumber(word, tk._.currency, tk._.is_head, tk._.num_flags || '');
      return [applyStress(ps, tk._.stress), rating];
    }
    return [null, null];
  }
}

function pyFloat(s) {
  // Python float() of a string made of digits and at most one '.'
  if (!/^[0-9]*\.?[0-9]*$/.test(s) || !/[0-9]/.test(s)) throw new Error(`ValueError: could not convert string to float: '${s}'`);
  return Number(s);
}

// ------------------------------------------------------------- merge/G2P --
export function mergeTokens(py, tokens, unk = null) {
  const stress = new Set(tokens.map((t) => t._.stress).filter((s) => s !== null && s !== undefined));
  const currency = tokens.map((t) => t._.currency).filter((c) => c !== null && c !== undefined);
  const ratings = tokens.map((t) => (t._.rating === undefined ? null : t._.rating));
  let phonemes;
  if (unk === null) phonemes = null;
  else {
    phonemes = '';
    for (const tk of tokens) {
      if (tk._.prespace && phonemes && !py.isSpaceCp(phonemes.codePointAt(phonemes.length - 1)) && tk.phonemes) phonemes += ' ';
      phonemes += tk.phonemes === null || tk.phonemes === undefined ? unk : tk.phonemes;
    }
  }
  let text = '';
  for (let i = 0; i < tokens.length - 1; i++) text += tokens[i].text + tokens[i].whitespace;
  text = py.strip(text + tokens[tokens.length - 1].text);
  let bestTag = null, bestScore = -1;
  for (const tk of tokens) {
    let s = 0;
    for (const c of tk.text) s += c === py.lower(c) ? 1 : 2;
    if (s > bestScore) { bestScore = s; bestTag = tk.tag; }
  }
  let cur = null;
  for (const c of currency) if (cur === null || cpCmp(c, cur) > 0) cur = c;
  const flags = [...new Set(tokens.flatMap((t) => [...(t._.num_flags || '')]))].sort(cpCmp).join('');
  return {
    text, tag: bestTag, whitespace: tokens[tokens.length - 1].whitespace, phonemes, rating: undefined,
    _: {
      is_head: tokens[0]._.is_head, alias: null,
      stress: stress.size === 1 ? [...stress][0] : null,
      currency: cur, num_flags: flags, prespace: tokens[0]._.prespace,
      rating: ratings.includes(null) ? null : Math.min(...ratings),
    },
  };
}

function cpCmp(a, b) {
  const x = [...a], y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i].codePointAt(0) - y[i].codePointAt(0);
    if (d) return d;
  }
  return x.length - y.length;
}

// spaCy training.align.get_alignments -> y2x lists
function getAlignmentsY2X(py, A, B) {
  const lowLen = (x) => cpLen(py.lower(x));
  const charToTokA = [], charToTokB = [];
  A.forEach((x, i) => { for (let k = 0; k < lowLen(x); k++) charToTokA.push(i); });
  B.forEach((x, i) => { for (let k = 0; k < lowLen(x); k++) charToTokB.push(i); });
  const strA = cps(py.lower(A.join('')));
  const strB = cps(py.lower(B.join('')));
  const noWs = (arr) => arr.filter((c) => !py.isSpaceCp(c.codePointAt(0))).join('');
  if (noWs(strA) !== noWs(strB) || strA.length !== charToTokA.length || strB.length !== charToTokB.length) {
    throw new Error('[E949] Unable to align tokens for the predicted and reference docs.');
  }
  let ia = 0, ib = 0, prevA = -1, prevB = -1;
  const a2b = [], b2a = [];
  while (ia < strA.length && ib < strB.length) {
    const ta = charToTokA[ia], tb = charToTokB[ib];
    if (prevA !== ta) a2b.push(new Set());
    if (prevB !== tb) b2a.push(new Set());
    if (A[ta] === B[tb] && (ia === 0 || charToTokA[ia - 1] < ta) && (ib === 0 || charToTokB[ib - 1] < tb)) {
      a2b[a2b.length - 1].add(tb);
      b2a[b2a.length - 1].add(ta);
      ia += cpLen(A[ta]);
      ib += cpLen(B[tb]);
    } else if (strA[ia] === strB[ib]) {
      a2b[a2b.length - 1].add(tb);
      b2a[b2a.length - 1].add(ta);
      ia++; ib++;
    } else if (py.isSpaceCp(strA[ia].codePointAt(0))) {
      ia++;
    } else if (py.isSpaceCp(strB[ib].codePointAt(0))) {
      ib++;
    } else {
      throw new Error('[E949] Unable to align tokens for the predicted and reference docs.');
    }
    prevA = ta; prevB = tb;
  }
  const restB = new Set(charToTokB.slice(ib)).size;
  for (let k = 0; k < restB; k++) b2a.push(new Set());
  return b2a.map((s) => [...s].sort((x, y) => x - y));
}

export class G2P {
  constructor({ lexicon, nlp, fallback = null, unk = '', py, version = null }) {
    this.lexicon = lexicon;
    this.nlp = nlp; // { tokenize(text) -> [{text, norm, spacy}], tag(tokens) -> tags }
    this.fallback = fallback;
    this.unk = unk;
    this.py = py;
    this.version = version;
  }

  preprocess(text) {
    const py = this.py;
    let result = '';
    const tokens = [];
    const features = new Map();
    let lastEnd = 0;
    text = py.lstrip(text);
    for (const m of text.matchAll(LINK_REGEX)) {
      result += text.slice(lastEnd, m.index);
      tokens.push(...py.split(text.slice(lastEnd, m.index)));
      let f = m[2];
      const fs = f[0] === '-' || f[0] === '+' ? f.slice(1) : f;
      if (isDigitStr(fs)) f = Number(BigInt(f[0] === '+' ? f.slice(1) : f));
      else if (f === '0.5' || f === '+0.5') f = 0.5;
      else if (f === '-0.5') f = -0.5;
      else if (cpLen(f) > 1 && f[0] === '/' && f[f.length - 1] === '/') f = f[0] + f.slice(1).replace(/\/+$/u, '');
      else if (cpLen(f) > 1 && f[0] === '#' && f[f.length - 1] === '#') f = f[0] + f.slice(1).replace(/#+$/u, '');
      else f = null;
      if (f !== null) features.set(tokens.length, f);
      result += m[1];
      tokens.push(m[1]);
      lastEnd = m.index + m[0].length;
    }
    if (lastEnd < text.length) {
      result += text.slice(lastEnd);
      tokens.push(...py.split(text.slice(lastEnd)));
    }
    return [result, tokens, features];
  }

  tokenize(text, tokens, features) {
    const doc = this.nlp.tokenize(text);
    const tags = this.nlp.tag(doc);
    const mt = doc.map((t, i) => makeToken(t.text, tags[i], t.spacy ? ' ' : ''));
    if (!features.size) return mt;
    const y2x = getAlignmentsY2X(this.py, tokens, mt.map((t) => t.text));
    const data = y2x.flat();
    for (const [k, v] of features) {
      let i = 0;
      for (let j = 0; j < data.length; j++) {
        if (data[j] !== k) continue;
        const ii = i++;
        if (j >= mt.length) continue;
        if (typeof v !== 'string') {
          mt[j]._.stress = v;
        } else if (v.startsWith('/')) {
          mt[j]._.is_head = ii === 0;
          mt[j].phonemes = ii === 0 ? v.replace(/^\/+/u, '') : '';
          mt[j]._.rating = 5;
        } else if (v.startsWith('#')) {
          mt[j]._.num_flags = v.replace(/^#+/u, '');
        }
      }
    }
    return mt;
  }

  foldLeft(tokens) {
    const result = [];
    for (let tk of tokens) {
      if (result.length && !tk._.is_head) tk = mergeTokens(this.py, [result.pop(), tk], this.unk);
      result.push(tk);
    }
    return result;
  }

  retokenize(tokens) {
    const py = this.py;
    const words = [];
    let currency = null;
    tokens.forEach((token, i) => {
      let tks;
      if ((token._.alias === null || token._.alias === undefined) && (token.phonemes === null || token.phonemes === undefined)) {
        tks = subtokenize(token.text).map((t) => ({
          ...token, text: t, whitespace: '',
          _: { is_head: true, alias: null, stress: token._.stress, currency: null, num_flags: token._.num_flags, prespace: false, rating: null },
        }));
      } else {
        tks = [token];
      }
      if (!tks.length) throw new Error('IndexError: list index out of range');
      tks[tks.length - 1].whitespace = token.whitespace;
      tks.forEach((tk, j) => {
        const set = (v) => v !== null && v !== undefined;
        if (set(tk._.alias) || set(tk.phonemes)) {
          // pass
        } else if (tk.tag === '$' && has(CURRENCIES, tk.text)) {
          currency = tk.text;
          tk.phonemes = '';
          tk._.rating = 4;
        } else if (tk.tag === ':' && (tk.text === '-' || tk.text === '–')) {
          tk.phonemes = '—';
          tk._.rating = 3;
        } else if (PUNCT_TAGS.has(tk.tag) && ![...tk.text].every((c) => {
          const l = py.lower(c);
          if (cpLen(l) !== 1) throw new TypeError('ord() expected a character, but string of length ' + cpLen(l) + ' found');
          const o = l.codePointAt(0);
          return o >= 97 && o <= 122;
        })) {
          tk.phonemes = has(PUNCT_TAG_PHONEMES, tk.tag) ? PUNCT_TAG_PHONEMES[tk.tag] : [...tk.text].filter((c) => PUNCTS.has(c)).join('');
          tk._.rating = 4;
        } else if (currency !== null) {
          if (tk.tag !== 'CD') currency = null;
          else if (j + 1 === tks.length && (i + 1 === tokens.length || tokens[i + 1].tag !== 'CD')) tk._.currency = currency;
        } else if (j > 0 && j < tks.length - 1 && tk.text === '2') {
          const a = cps(tks[j - 1].text), b = cps(tks[j + 1].text);
          if (py.isalpha(a[a.length - 1] + b[0])) tk._.alias = 'to';
        }
        if (set(tk._.alias) || set(tk.phonemes)) {
          words.push(tk);
        } else if (words.length && Array.isArray(words[words.length - 1]) && !words[words.length - 1][words[words.length - 1].length - 1].whitespace) {
          tk._.is_head = false;
          words[words.length - 1].push(tk);
        } else {
          words.push(tk.whitespace ? tk : [tk]);
        }
      });
    });
    return words.map((w) => (Array.isArray(w) && w.length === 1 ? w[0] : w));
  }

  static tokenContext(ctx, ps, token) {
    let vowel = ctx.future_vowel;
    if (ps) {
      for (const c of ps) {
        if (VOWELS.has(c) || CONSONANTS.has(c) || NON_QUOTE_PUNCTS.has(c)) {
          vowel = NON_QUOTE_PUNCTS.has(c) ? null : VOWELS.has(c);
          break;
        }
      }
    }
    const futureTo = token.text === 'to' || token.text === 'To' || (token.text === 'TO' && (token.tag === 'TO' || token.tag === 'IN'));
    return { future_vowel: vowel, future_to: futureTo };
  }

  resolveTokens(tokens) {
    const py = this.py;
    let text = '';
    for (let i = 0; i < tokens.length - 1; i++) text += tokens[i].text + tokens[i].whitespace;
    text += tokens[tokens.length - 1].text;
    const classes = new Set();
    for (const c of text) {
      if (SUBTOKEN_JUNKS.has(c)) continue;
      classes.add(py.isAlphaCp(c.codePointAt(0)) ? 0 : isDigitStr(c) ? 1 : 2);
    }
    const prespace = text.includes(' ') || text.includes('/') || classes.size > 1;
    tokens.forEach((tk, i) => {
      if (tk.phonemes === null || tk.phonemes === undefined) {
        if (i === tokens.length - 1 && NON_QUOTE_PUNCTS.has(tk.text)) {
          tk.phonemes = tk.text;
          tk._.rating = 3;
        } else if ([...tk.text].every((c) => SUBTOKEN_JUNKS.has(c))) {
          tk.phonemes = '';
          tk._.rating = 3;
        }
      } else if (i > 0) {
        tk._.prespace = prespace;
      }
    });
    if (prespace) return;
    let indices = [];
    tokens.forEach((tk, i) => { if (tk.phonemes) indices.push([tk.phonemes.includes(PRIMARY_STRESS) ? 1 : 0, stressWeight(tk.phonemes), i]); });
    if (indices.length === 2 && cpLen(tokens[indices[0][2]].text) === 1) {
      const i = indices[1][2];
      tokens[i].phonemes = applyStress(tokens[i].phonemes, -0.5);
      return;
    }
    if (indices.length < 2 || indices.reduce((a, x) => a + x[0], 0) <= Math.floor((indices.length + 1) / 2)) return;
    indices.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
    indices = indices.slice(0, Math.floor(indices.length / 2));
    for (const [, , i] of indices) tokens[i].phonemes = applyStress(tokens[i].phonemes, -0.5);
  }

  /** misaki G2P.__call__(text) -> [phoneme string, tokens] */
  call(text) {
    const py = this.py;
    const [t2, toks0, features] = this.preprocess(text);
    let tokens = this.tokenize(t2, toks0, features);
    tokens = this.foldLeft(tokens);
    tokens = this.retokenize(tokens);
    let ctx = { future_vowel: null, future_to: false };
    for (let i = tokens.length - 1; i >= 0; i--) {
      const w = tokens[i];
      if (!Array.isArray(w)) {
        if (w.phonemes === null || w.phonemes === undefined) {
          [w.phonemes, w.rating] = this.lexicon.call(cloneTok(w), ctx);
        }
        if ((w.phonemes === null || w.phonemes === undefined) && this.fallback !== null) {
          [w.phonemes, w.rating] = this.fallback(cloneTok(w));
        }
        ctx = G2P.tokenContext(ctx, w.phonemes, w);
        continue;
      }
      let left = 0, right = w.length;
      let shouldFallback = false;
      while (left < right) {
        let tk = null;
        if (!w.slice(left, right).some((x) => (x._.alias !== null && x._.alias !== undefined) || (x.phonemes !== null && x.phonemes !== undefined))) {
          tk = mergeTokens(py, w.slice(left, right));
        }
        const [ps, rating] = tk === null ? [null, null] : this.lexicon.call(tk, ctx);
        if (ps !== null && ps !== undefined) {
          w[left].phonemes = ps;
          w[left]._.rating = rating;
          for (const x of w.slice(left + 1, right)) { x.phonemes = ''; x.rating = rating; }
          ctx = G2P.tokenContext(ctx, ps, tk);
          right = left;
          left = 0;
        } else if (left + 1 < right) {
          left++;
        } else {
          right--;
          const t = w[right];
          if (t.phonemes === null || t.phonemes === undefined) {
            if ([...t.text].every((c) => SUBTOKEN_JUNKS.has(c))) {
              t.phonemes = '';
              t._.rating = 3;
            } else if (this.fallback !== null) {
              shouldFallback = true;
              break;
            }
          }
          left = 0;
        }
      }
      if (shouldFallback) {
        const tk = mergeTokens(py, w);
        [w[0].phonemes, w[0]._.rating] = this.fallback(tk);
        for (let j = 1; j < w.length; j++) { w[j].phonemes = ''; w[j]._.rating = w[0]._.rating; }
      } else {
        this.resolveTokens(w);
      }
    }
    tokens = tokens.map((tk) => (Array.isArray(tk) ? mergeTokens(py, tk, this.unk) : tk));
    if (this.version !== '2.0') {
      for (const tk of tokens) if (tk.phonemes) tk.phonemes = tk.phonemes.replaceAll('ɾ', 'T').replaceAll('ʔ', 't');
    }
    const result = tokens.map((tk) => (tk.phonemes === null || tk.phonemes === undefined ? this.unk : tk.phonemes) + tk.whitespace).join('');
    return [result, tokens];
  }
}
