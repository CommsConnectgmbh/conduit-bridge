// SPDX-License-Identifier: Apache-2.0
// Port of the English path of kokoro.pipeline.KPipeline (Apache-2.0, hexgrad):
// line splitting, en_tokenize chunking (<= 510 phoneme chars) and
// waterfall_last, as used by KPipeline(lang_code='a', model=False)(text).

const cpLen = (s) => { let n = 0; for (const _ of s) n++; return n; };

function tokensToPs(py, tokens) {
  return py.strip(tokens.map((t) => t.phonemes + (t.whitespace ? ' ' : '')).join(''));
}

function tokensToText(py, tokens) {
  return py.strip(tokens.map((t) => t.text + t.whitespace).join(''));
}

function waterfallLast(py, tokens, nextCount, waterfall = ['!.?…', ':;', ',—'], bumps = [')', '”']) {
  for (const w of waterfall) {
    const set = new Set(w);
    let z = null;
    for (let i = tokens.length - 1; i >= 0; i--) {
      if (set.has(tokens[i].phonemes)) { z = i; break; }
    }
    if (z === null) continue;
    z += 1;
    if (z < tokens.length && bumps.includes(tokens[z].phonemes)) z += 1;
    if (nextCount - cpLen(tokensToPs(py, tokens.slice(0, z))) <= 510) return z;
  }
  return tokens.length;
}

export function* enTokenize(py, tokens) {
  let tks = [];
  let pcount = 0;
  for (const t of tokens) {
    t.phonemes = t.phonemes === null || t.phonemes === undefined ? '' : t.phonemes;
    let nextPs = t.phonemes + (t.whitespace ? ' ' : '');
    const nextPcount = pcount + cpLen(py.rstrip(nextPs));
    if (nextPcount > 510) {
      const z = waterfallLast(py, tks, nextPcount);
      const text = tokensToText(py, tks.slice(0, z));
      const ps = tokensToPs(py, tks.slice(0, z));
      yield [text, ps, tks.slice(0, z)];
      tks = tks.slice(z);
      pcount = cpLen(tokensToPs(py, tks));
      if (!tks.length) nextPs = py.lstrip(nextPs);
    }
    tks.push(t);
    pcount += cpLen(nextPs);
  }
  if (tks.length) {
    yield [py.strip(tokensToText(py, tks)), py.strip(tokensToPs(py, tks)), tks];
  }
}

/**
 * KPipeline.__call__ for English without a model: yields {text, phonemes}
 * for every non-empty chunk, exactly like (graphemes, phonemes) in Python.
 */
export function kokoroChunks(py, g2pCall, text, splitPattern = /\n+/u) {
  const segments = splitPattern ? py.strip(text).split(splitPattern) : [text];
  const chunks = [];
  for (const graphemes of segments) {
    if (!py.strip(graphemes)) continue;
    const [, tokens] = g2pCall(graphemes);
    for (const [gs, ps0] of enTokenize(py, tokens)) {
      let ps = ps0;
      if (!ps) continue;
      if (cpLen(ps) > 510) ps = Array.from(ps).slice(0, 510).join('');
      chunks.push({ text: gs, phonemes: ps });
    }
  }
  return chunks;
}
