// SPDX-License-Identifier: MIT
// Port of the spaCy 3.8 Tokenizer (spacy/tokenizer.pyx) as configured in
// en_core_web_sm 3.8.0: prefix/suffix/infix rules, url_match, special cases
// (tokenizer exceptions) and the special-case PhraseMatcher pass.
//
// Output tokens: { text, norm, spacy } where `norm` is the token-level NORM
// from a special case (or null) and `spacy` is true when the token is followed
// by a single ' ' that was absorbed as whitespace (token.whitespace_ == ' ').

import { hashString } from './speech-en-murmur.mjs';

function cpCompare(a, b) {
  // Python str ordering (code point order)
  const ai = a[Symbol.iterator](), bi = b[Symbol.iterator]();
  for (;;) {
    const x = ai.next(), y = bi.next();
    if (x.done || y.done) return x.done === y.done ? 0 : (x.done ? -1 : 1);
    const d = x.value.codePointAt(0) - y.value.codePointAt(0);
    if (d) return d;
  }
}

export class SpacyTokenizer {
  constructor(data, py) {
    this.py = py;
    const p = data.patterns;
    this.prefixRe = new RegExp(p.prefix_search, 'u');
    this.suffixRe = new RegExp(p.suffix_search, 'u');
    this.infixRe = new RegExp(p.infix_finditer, 'gu');
    this.urlRe = new RegExp(p.url_match, 'u');
    this.specials = new Map();
    for (const [chunk, toks] of Object.entries(data.rules)) {
      this.specials.set(chunk, toks.map(([orth, norm]) => ({ text: orth, norm: norm === undefined ? null : norm })));
    }
    this.lexemeNorm = new Map(Object.entries(data.lexeme_norm));
    this.baseNorms = new Map(Object.entries(data.base_norms));
    this.symbols = new Map(Object.entries(data.symbols).map(([k, v]) => [k, BigInt(v)]));
    this.normCache = new Map();
    // Special-case PhraseMatcher: patterns are the affix-only tokenizations of
    // special-case strings that contain prefixes/suffixes/infixes or spaces.
    this.trie = new Map();
    const chunks = [...this.specials.keys()].sort(cpCompare);
    for (const chunk of chunks) {
      if (this.findPrefix(chunk) || this.findInfix(chunk).length || this.findSuffix(chunk) || chunk.includes(' ')) {
        const orths = this.tokenizeAffixes(chunk, false).map((t) => t.text);
        let node = this.trie;
        for (const o of orths) {
          if (!node.has(o)) node.set(o, new Map());
          node = node.get(o);
        }
        node.set(TERMINAL, true);
      }
    }
  }

  findPrefix(s) {
    const m = this.prefixRe.exec(s);
    return m ? m[0].length : 0;
  }

  findSuffix(s) {
    const m = this.suffixRe.exec(s);
    return m ? m[0].length : 0;
  }

  findInfix(s) {
    this.infixRe.lastIndex = 0;
    return [...s.matchAll(this.infixRe)];
  }

  /** spaCy StringStore id: fixed symbol id for symbol strings, else hash. */
  stringId(s) {
    const sym = this.symbols.get(s);
    return sym === undefined ? hashString(s) : sym;
  }

  /** NORM of a lexeme (lexeme_norm table, then BASE_NORMS, then lower()). */
  lexNorm(s) {
    let n = this.normCache.get(s);
    if (n !== undefined) return n;
    n = this.lexemeNorm.get(String(this.stringId(s)));
    if (n === undefined) n = this.baseNorms.get(s);
    if (n === undefined) n = this.py.lower(s);
    if (this.normCache.size < 100000) this.normCache.set(s, n);
    return n;
  }

  tokenize(string) {
    const toks = this.tokenizeAffixes(string, true);
    return this.applySpecialCases(toks);
  }

  tokenizeAffixes(string, withSpecial) {
    const doc = [];
    if (string.length === 0) return doc;
    const py = this.py;
    const cps = Array.from(string);
    let inWs = py.isSpaceCp(cps[0].codePointAt(0));
    let start = 0; // UTF-16 offsets
    let i = 0;
    for (const uc of cps) {
      if (py.isSpaceCp(uc.codePointAt(0)) !== inWs) {
        if (start < i) this.tokenizeSpan(doc, string.slice(start, i), withSpecial);
        if (uc === ' ') {
          doc[doc.length - 1].spacy = true;
          start = i + 1;
        } else {
          start = i;
        }
        inWs = !inWs;
      }
      i += uc.length;
    }
    if (start < i) {
      this.tokenizeSpan(doc, string.slice(start), withSpecial);
      doc[doc.length - 1].spacy = string[string.length - 1] === ' ' && !inWs;
    }
    return doc;
  }

  pushSpecial(doc, span) {
    for (const t of this.specials.get(span)) doc.push({ text: t.text, norm: t.norm, spacy: false, special: true });
  }

  tokenizeSpan(doc, span, withSpecial) {
    if (withSpecial && this.specials.has(span)) {
      this.pushSpecial(doc, span);
      return;
    }
    const prefixes = [];
    const suffixes = [];
    let string = span;
    let lastSize = -1;
    // _split_affixes
    while (string && string.length !== lastSize) {
      if (withSpecial && this.specials.has(string)) break;
      lastSize = string.length;
      const preLen = this.findPrefix(string);
      let prefix, minusPre;
      if (preLen !== 0) {
        prefix = string.slice(0, preLen);
        minusPre = string.slice(preLen);
        if (minusPre && withSpecial && this.specials.has(minusPre)) {
          string = minusPre;
          prefixes.push(prefix);
          break;
        }
      }
      const sufLen = this.findSuffix(string.slice(preLen));
      let suffix, minusSuf;
      if (sufLen !== 0) {
        suffix = string.slice(string.length - sufLen);
        minusSuf = string.slice(0, string.length - sufLen);
        if (minusSuf && withSpecial && this.specials.has(minusSuf)) {
          string = minusSuf;
          suffixes.push(suffix);
          break;
        }
      }
      if (preLen && sufLen && preLen + sufLen <= string.length) {
        string = string.slice(preLen, string.length - sufLen);
        prefixes.push(prefix);
        suffixes.push(suffix);
      } else if (preLen) {
        string = minusPre;
        prefixes.push(prefix);
      } else if (sufLen) {
        string = minusSuf;
        suffixes.push(suffix);
      }
    }
    // _attach_tokens
    for (const p of prefixes) doc.push({ text: p, norm: null, spacy: false });
    if (string) {
      if (withSpecial && this.specials.has(string)) {
        this.pushSpecial(doc, string);
      } else if (this.urlRe.test(string)) {
        doc.push({ text: string, norm: null, spacy: false });
      } else {
        const matches = this.findInfix(string);
        if (!matches.length) {
          doc.push({ text: string, norm: null, spacy: false });
        } else {
          let start = 0;
          for (const m of matches) {
            const infixStart = m.index;
            const infixEnd = m.index + m[0].length;
            if (infixStart === 0) continue;
            if (infixStart !== start) doc.push({ text: string.slice(start, infixStart), norm: null, spacy: false });
            if (infixStart !== infixEnd) doc.push({ text: string.slice(infixStart, infixEnd), norm: null, spacy: false });
            start = infixEnd;
          }
          const rest = string.slice(start);
          if (rest) doc.push({ text: rest, norm: null, spacy: false });
        }
      }
    }
    for (let k = suffixes.length - 1; k >= 0; k--) doc.push({ text: suffixes[k], norm: null, spacy: false });
  }

  applySpecialCases(doc) {
    if (this.trie.size === 0) return doc;
    const matches = [];
    for (let idx = 0; idx < doc.length; idx++) {
      let node = this.trie.get(doc[idx].text);
      if (!node) continue;
      let idy = idx + 1;
      for (;;) {
        if (node.has(TERMINAL)) matches.push([idx, idy]);
        if (idy >= doc.length) break;
        const next = node.get(doc[idy].text);
        if (!next) break;
        node = next;
        idy++;
      }
    }
    if (!matches.length) return doc;
    // _filter_special_spans: longest first, then leftmost; no overlaps at
    // the first/last token of an already taken span.
    matches.sort((a, b) => (a[1] - a[0]) - (b[1] - b[0]) || b[0] - a[0]);
    const seen = new Set();
    const filtered = [];
    for (let k = matches.length - 1; k >= 0; k--) {
      const [s, e] = matches[k];
      if (!seen.has(s) && !seen.has(e - 1)) filtered.push([s, e]);
      for (let q = s; q < e; q++) seen.add(q);
    }
    filtered.sort((a, b) => a[0] - b[0]);
    const spanAt = new Map();
    for (const [s, e] of filtered) spanAt.set(s, e);
    const out = [];
    let i = 0;
    while (i < doc.length) {
      const e = spanAt.get(i);
      if (e === undefined) { out.push(doc[i]); i++; continue; }
      let text = '';
      for (let q = i; q < e; q++) text += doc[q].text + (q < e - 1 && doc[q].spacy ? ' ' : '');
      const special = this.specials.get(text);
      if (!special) {
        for (let q = i; q < e; q++) out.push(doc[q]);
      } else {
        const finalSpacy = doc[e - 1].spacy;
        const toks = special.map((t) => ({ text: t.text, norm: t.norm, spacy: false, special: true }));
        toks[toks.length - 1].spacy = finalSpacy;
        out.push(...toks);
      }
      i = e;
    }
    return out;
  }
}

const TERMINAL = Symbol('terminal');
