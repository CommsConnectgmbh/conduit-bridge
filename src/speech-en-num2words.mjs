// SPDX-License-Identifier: LGPL-2.1-or-later
// Translation of num2words 0.5.14 (Copyright (c) 2003 Taro Ogawa, (c) 2013
// Savoir-faire Linux inc.; LGPL-2.1-or-later, see licenses/num2words-LGPL-2.1.txt).
// This file stays under the LGPL; it is a separate, replaceable module.
//
// Port of num2words 0.5.14, English (lang_EN / lang_EU / base), restricted to
// what misaki uses: cardinal (int and float), ordinal, year.
// Integers are BigInt; Python floats are JS numbers with CPython semantics
// (float divmod, repr-based precision, banker's rounding).

export class OverflowError extends Error {
  constructor(msg) { super(msg); this.name = 'OverflowError'; }
}

const LOW = ['twenty', 'nineteen', 'eighteen', 'seventeen', 'sixteen', 'fifteen', 'fourteen', 'thirteen',
  'twelve', 'eleven', 'ten', 'nine', 'eight', 'seven', 'six', 'five', 'four', 'three', 'two', 'one', 'zero'];
const MID = [[1000n, 'thousand'], [100n, 'hundred'], [90n, 'ninety'], [80n, 'eighty'], [70n, 'seventy'],
  [60n, 'sixty'], [50n, 'fifty'], [40n, 'forty'], [30n, 'thirty']];
const ORDS = {
  one: 'first', two: 'second', three: 'third', four: 'fourth', five: 'fifth', six: 'sixth',
  seven: 'seventh', eight: 'eighth', nine: 'ninth', ten: 'tenth', eleven: 'eleventh', twelve: 'twelfth',
};

// cards: ordered (descending) list of [BigInt value, word]
const CARDS = (() => {
  const lows = ['non', 'oct', 'sept', 'sext', 'quint', 'quadr', 'tr', 'b', 'm'];
  const units = ['', 'un', 'duo', 'tre', 'quattuor', 'quin', 'sex', 'sept', 'octo', 'novem'];
  const tens = ['dec', 'vigint', 'trigint', 'quadragint', 'quinquagint', 'sexagint', 'septuagint', 'octogint', 'nonagint'];
  const out = [];
  for (const t of tens) for (const u of units) out.push(u + t);
  out.reverse();
  const high = ['cent', ...out, ...lows];
  const cards = [];
  let n = 3 + 3 * high.length;
  for (const w of high) {
    if (n <= 3) break;
    cards.push([10n ** BigInt(n), w + 'illion']);
    n -= 3;
  }
  for (const [k, v] of MID) cards.push([k, v]);
  LOW.forEach((w, i) => cards.push([BigInt(LOW.length - 1 - i), w]));
  return cards;
})();
const CARD_WORD = new Map(CARDS.map(([k, v]) => [k, v]));
const MAXVAL = 1000n * CARDS[0][0];

// ---------------------------------------------------------------- floats --
function floatDivmod(vx, wx) {
  // CPython float_divmod
  let mod = vx % wx;
  let div = (vx - mod) / wx;
  if (mod) {
    if ((wx < 0) !== (mod < 0)) { mod += wx; div -= 1.0; }
  } else {
    mod = Object.is(wx, -0) || wx < 0 ? -0 : 0;
  }
  let floordiv;
  if (div) {
    floordiv = Math.floor(div);
    if (div - floordiv > 0.5) floordiv += 1.0;
  } else {
    floordiv = (vx / wx) < 0 || Object.is(vx / wx, -0) ? -0 : 0;
  }
  return [floordiv, mod];
}

function roundHalfEven(x) {
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/** Decimal(repr(x)).as_tuple().exponent for a finite double. */
function reprExponent(x) {
  const s = Math.abs(x).toExponential(); // shortest round-trip digits, like repr
  const m = /^(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(s);
  const ndig = 1 + (m[2] ? m[2].length : 0);
  const e = Number(m[3]);
  // Python repr uses fixed notation for 1e-4 <= |x| < 1e16; trailing ".0"
  // for integral values gives exponent -1 in Decimal.
  if (x !== 0 && Math.abs(x) >= 1e-4 && Math.abs(x) < 1e16) {
    const frac = Math.max(0, ndig - 1 - e);
    return frac === 0 ? -1 : -frac;
  }
  if (x === 0) return -1; // '0.0'
  return e - (ndig - 1);
}

function toBig(v) { return typeof v === 'bigint' ? v : BigInt(v); }

// ---------------------------------------------------------------- core --
function splitnum(value) {
  // value: BigInt or float number (non-negative, integral-valued)
  const isF = typeof value === 'number';
  for (const [elem, word] of CARDS) {
    if (elem > value) continue;
    const out = [];
    let div, mod;
    if (isF ? value === 0 : value === 0n) {
      div = isF ? 1 : 1n; mod = isF ? 0 : 0n;
    } else if (isF) {
      [div, mod] = floatDivmod(value, Number(elem));
    } else {
      div = value / elem; mod = value % elem;
    }
    if (isF ? div === 1 : div === 1n) {
      out.push([CARD_WORD.get(1n), 1n]);
    } else {
      if (isF ? div === value : div === value) {
        return [[word.repeat(Number(div)), toBig(div) * elem]];
      }
      out.push(splitnum(div));
    }
    out.push([word, elem]);
    if (isF ? mod !== 0 : mod !== 0n) out.push(splitnum(mod));
    return out;
  }
  return undefined;
}

function isPair(x) { return Array.isArray(x) && x.length === 2 && typeof x[0] === 'string'; }

function merge(lpair, rpair) {
  const [ltext, lnum] = lpair;
  const [rtext, rnum] = rpair;
  if (lnum === 1n && rnum < 100n) return [rtext, rnum];
  if (100n > lnum && lnum > rnum) return [`${ltext}-${rtext}`, lnum + rnum];
  if (lnum >= 100n && 100n > rnum) return [`${ltext} and ${rtext}`, lnum + rnum];
  if (rnum > lnum) return [`${ltext} ${rtext}`, lnum * rnum];
  return [`${ltext}, ${rtext}`, lnum + rnum];
}

function clean(val) {
  let out = val;
  while (val.length !== 1) {
    out = [];
    const [left, right] = val;
    if (isPair(left) && isPair(right)) {
      out.push(merge(left, right));
      if (val.length > 2) out.push(val.slice(2));
    } else {
      for (const elem of val) {
        if (!isPair(elem)) {
          if (elem.length === 1) out.push(elem[0]);
          else out.push(clean(elem));
        } else {
          out.push(elem);
        }
      }
    }
    val = out;
  }
  return out[0];
}

/** to_cardinal: value is BigInt (int) or number (Python float). */
export function toCardinal(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new OverflowError('cannot convert float infinity to integer');
    if (Math.trunc(value) !== value) return toCardinalFloat(value);
  }
  let out = '';
  if (value < 0) { value = -value; out = 'minus '; }
  if (value >= MAXVAL) throw new OverflowError(`abs(${value}) must be less than ${MAXVAL}.`);
  const val = splitnum(value);
  const [words] = clean(val);
  return out + words;
}

function toCardinalFloat(value) {
  // float2tuple
  const pre = Math.trunc(value);
  const precision = Math.abs(reprExponent(value));
  let post = Math.abs(value - pre) * Number('1e' + precision);
  let postInt;
  if (Math.abs(roundHalfEven(post) - post) < 0.01) postInt = BigInt(roundHalfEven(post));
  else postInt = BigInt(Math.floor(post));
  let postS = String(postInt);
  postS = '0'.repeat(Math.max(0, precision - postS.length)) + postS;
  const out = [toCardinal(BigInt(pre))];
  if (precision) out.push('point');
  for (let i = 0; i < precision; i++) {
    const curr = BigInt(Number(postS[i]));
    if (postS[i] === undefined) throw new RangeError('string index out of range');
    out.push(toCardinal(curr));
  }
  return out.join(' ');
}

export function toOrdinal(value) {
  // verify_ordinal: int, non-negative
  if (value < 0n) throw new TypeError(`Cannot treat negative num ${value} as ordinal.`);
  const outwords = toCardinal(value).split(' ');
  const lastwords = outwords[outwords.length - 1].split('-');
  let lastword = lastwords[lastwords.length - 1].toLowerCase();
  if (Object.hasOwn(ORDS, lastword)) lastword = ORDS[lastword];
  else {
    if (lastword[lastword.length - 1] === 'y') lastword = lastword.slice(0, -1) + 'ie';
    lastword += 'th';
  }
  lastwords[lastwords.length - 1] = lastword;
  outwords[outwords.length - 1] = lastwords.join('-');
  return outwords.join(' ');
}

export function toYear(val) {
  let suffix = null;
  if (val < 0n) { val = -val; suffix = 'BC'; }
  const high = val / 100n, low = val % 100n;
  let valtext;
  if (high === 0n || (high % 10n === 0n && low < 10n) || high >= 100n) {
    valtext = toCardinal(val);
  } else {
    const hightext = toCardinal(high);
    let lowtext;
    if (low === 0n) lowtext = 'hundred';
    else if (low < 10n) lowtext = `oh-${toCardinal(low)}`;
    else lowtext = toCardinal(low);
    valtext = `${hightext} ${lowtext}`;
  }
  return suffix ? `${valtext} ${suffix}` : valtext;
}

/** num2words(number, to=...) for number BigInt (Python int) or number (Python float). */
export function num2words(number, to = 'cardinal') {
  if (to === 'cardinal') return toCardinal(number);
  if (to === 'ordinal') return toOrdinal(number);
  if (to === 'year') return toYear(number);
  throw new Error('unsupported: ' + to);
}
